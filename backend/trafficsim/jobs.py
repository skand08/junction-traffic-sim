"""Background run jobs: build the scenario, run seeds in parallel subprocesses, aggregate.

Each seed runs as its own Python subprocess (python -m trafficsim.runner job.json), managed by a
thread pool. This avoids multiprocessing pools, which fail on some platforms (e.g. Python 3.14 on
macOS raises PermissionError in ProcessPoolExecutor), and keeps libsumo runs isolated.

A run is stored as the document "runs/<run_id>/run.json" (store.py) and keeps a snapshot of the scenario,
so later edits to the scenario never change past results. While it runs, "runs/<run_id>/status.json" holds
its progress, and "runs/<run_id>/row.json" is the short summary shown in run lists.

With JUNCTION_EXECUTION=queue the API only records and queues a run; a worker (worker.py) runs it with the
same code and writes the same documents.
"""
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import analysis, build, config, jobqueue, runner, store
from .scenario import Scenario

RUNS_DIR = config.WORKSPACE_DIR / "runs"           # working files of runs (built network, per-seed outputs)
FINAL = ("done", "failed", "cancelled")
APP_VERSION = "0.4.0"


def versions() -> dict:
    try:
        from importlib.metadata import version
        sumo_v = version("eclipse-sumo")
    except Exception:  # noqa: BLE001
        sumo_v = "unknown"
    return dict(app=APP_VERSION, sumo=sumo_v, python=sys.version.split()[0])


class SeedFailed(Exception):
    """A worker process for one seed exited with an error. The message is the error itself (the last
    line of the worker's traceback, e.g. SUMO's own message), not a cut-off slice of the traceback."""

    def __init__(self, seed, output: str):
        self.seed, self.output = seed, output
        lines = [ln.strip() for ln in output.splitlines() if ln.strip()]
        last = lines[-1] if lines else "the worker stopped without a message"
        for prefix in ("RuntimeError: ", "Exception: "):
            if last.startswith(prefix):
                last = last[len(prefix):]
        super().__init__(f"Run with seed {seed} failed: {last[:400]}")


class Cancelled(Exception):
    pass
RUNS_DIR.mkdir(parents=True, exist_ok=True)


class JobManager:
    def __init__(self, workers: int = config.MAX_WORKERS):
        self._procs = ThreadPoolExecutor(max_workers=workers)   # each task drives one subprocess
        self._orch = ThreadPoolExecutor(max_workers=2)
        self._lock = threading.Lock()
        self.jobs: dict = {}
        self._cancel: dict = {}      # job id -> Event set only when the user cancels
        self._halt: dict = {}        # job id -> Event that stops remaining seeds (cancel or a failed seed)
        self._procs_of: dict = {}    # job id -> set of running subprocess.Popen
        self.detached: set = set()   # jobs handed back to the queue by a stopping worker: write nothing more

    def submit(self, s: Scenario, seeds: list, depart_jitter_s: float = 0, rid: str | None = None) -> dict:
        rid = rid or uuid.uuid4().hex[:10]
        job = dict(id=rid, run_id=rid, scenario_id=s.id, state="queued", done=0, total=len(seeds),
                   message="Waiting to start", warnings=[], error=None, stage=None, trace=None,
                   created=time.time(), seeds=list(seeds), done_seeds=[])
        store.docs.write(f"runs/{rid}/status.json", job)
        if jobqueue.remote():                            # a worker runs it
            jobqueue.enqueue("run", rid, dict(scenario=s.model_dump(mode="json"), seeds=list(seeds),
                                              depart_jitter_s=depart_jitter_s))
            return dict(job)
        with self._lock:
            self.jobs[rid] = job
            self._cancel[rid] = threading.Event()
            self._halt[rid] = threading.Event()
            self._procs_of[rid] = set()
        self._orch.submit(self._run, rid, s.model_copy(deep=True), seeds, depart_jitter_s)
        return dict(job)

    def status(self, jid: str) -> dict:
        with self._lock:
            if jid in self.jobs:
                return dict(self.jobs[jid])
        try:
            run = load_run(jid)        # a finished job, or one from an earlier server session
        except KeyError:
            st = store.docs.read(f"runs/{jid}/status.json") if "/" not in jid else None
            if st is None:
                raise
            if st.get("state") not in FINAL and not jobqueue.remote():
                # recorded as running, but no process here runs it: the server stopped while it ran
                st.update(state="failed", message="Failed", error="The server stopped while this ran. Run it again.")
            return st
        return dict(id=jid, run_id=jid, scenario_id=run["scenario"]["id"], state=run["state"],
                    done=len(run.get("seed_results", [])), total=len(run["seeds"]),
                    message="", warnings=run.get("warnings", []), error=run.get("error"),
                    stage=run.get("stage"), trace=_tail(run.get("trace")), seeds=run["seeds"],
                    done_seeds=[r["seed"] for r in run.get("seed_results", [])], created=run.get("started"))

    def cancel(self, jid: str) -> dict:
        """Stop a queued or running job: no new seeds start and running SUMO processes are terminated."""
        if jid not in self.jobs and jobqueue.remote():
            st = self.status(jid)
            if st["state"] in FINAL:
                return st
            if jobqueue.cancel_queued(jid):
                store.docs.merge(f"runs/{jid}/status.json", state="cancelled", message="Cancelled")
            elif jobqueue.command(jid, dict(action="cancel")):
                store.docs.merge(f"runs/{jid}/status.json", message="Cancelling")
            return self.status(jid)
        with self._lock:
            if jid not in self.jobs:
                raise KeyError(f"job '{jid}' is not running in this server session")
            if self.jobs[jid]["state"] in ("done", "failed", "cancelled"):
                return dict(self.jobs[jid])
            self._cancel[jid].set()
            self._halt[jid].set()
            self.jobs[jid]["message"] = "Cancelling"
            procs = list(self._procs_of[jid])
        for p in procs:
            _terminate(p)
        return self.status(jid)

    def _set(self, rid, **kw):
        with self._lock:
            self.jobs[rid].update(kw)
            snap = dict(self.jobs[rid])
        if rid not in self.detached:
            store.docs.write(f"runs/{rid}/status.json", snap)

    def detach(self, rid: str):
        """Stop a run without recording an outcome (a stopping worker gives it back to the queue)."""
        self.detached.add(rid)
        self._halt.get(rid, threading.Event()).set()
        with self._lock:
            procs = list(self._procs_of.get(rid, ()))
        for p in procs:
            _terminate(p)

    def running(self, jid: str) -> bool:
        with self._lock:
            return jid in self.jobs and self.jobs[jid]["state"] not in FINAL

    def _run(self, rid: str, s: Scenario, seeds: list, depart_jitter_s: float = 0):
        out = RUNS_DIR / rid
        out.mkdir(parents=True, exist_ok=True)
        record = dict(id=rid, scenario=s.model_dump(), seeds=seeds, state="building",
                      started=time.time(), warnings=[], seed_results=[], versions=versions(),
                      depart_jitter_s=depart_jitter_s)
        stop, halt = self._cancel[rid], self._halt[rid]
        stage = "build"
        try:
            self._set(rid, state="building", message="Building network", stage="build")
            b = build.build(s, out)
            record["warnings"] = b.warnings
            record["build"] = dict(unroutable_trips=b.unroutable_trips, total_trips=b.total_trips)
            if stop.is_set():
                raise Cancelled()
            stage = "simulation"
            self._set(rid, state="running", message=f"Running {len(seeds)} simulations", warnings=b.warnings,
                      stage="simulation")
            base = dict(net_file=str(b.net_file), demand_file=str(b.demand_file),
                        tls_additional=str(b.tls_additional) if b.tls_additional else None,
                        begin=b.begin, end=b.end, scale=s.demand_scale, controller=s.controller,
                        depart_jitter_s=depart_jitter_s)
            futs = [self._procs.submit(run_seed_subprocess, dict(base, seed=k, out_dir=str(out / f"seed_{k}")),
                                       halt, self._procs_of[rid], self._lock)
                    for k in seeds]
            results = []
            try:
                for f in as_completed(futs):
                    results.append(f.result())
                    record["seed_results"] = results
                    self._set(rid, done=len(results), done_seeds=sorted(r["seed"] for r in results),
                              message=f"{len(results)} of {len(seeds)} simulations done")
            except BaseException:
                halt.set()                       # stop the other seeds of this job too
                for f in futs:
                    f.cancel()
                with self._lock:
                    procs = list(self._procs_of[rid])
                for p in procs:
                    _terminate(p)
                raise
            results.sort(key=lambda r: r["seed"])
            record.update(seed_results=results, aggregate=analysis.aggregate(results), state="done",
                          finished=time.time())
            final = dict(state="done", message="Finished")
        except Cancelled:
            record.update(state="cancelled", stage=stage, seed_results=[])
            final = dict(state="cancelled", message="Cancelled", stage=stage)
        except build.EditError as e:
            record.update(state="failed", error=str(e), stage=stage)
            final = dict(state="failed", error=str(e), message="Cannot run these changes", stage=stage)
        except SeedFailed as e:
            if stop.is_set():
                record.update(state="cancelled", stage=stage, seed_results=[])
                final = dict(state="cancelled", message="Cancelled", stage=stage)
            else:
                record.update(state="failed", error=str(e), trace=e.output, stage=stage)
                final = dict(state="failed", error=str(e), message="Failed", stage=stage, trace=_tail(e.output))
        except Exception as e:  # noqa: BLE001
            if stop.is_set():
                record.update(state="cancelled", stage=stage, seed_results=[])
                final = dict(state="cancelled", message="Cancelled", stage=stage)
            else:
                tb = traceback.format_exc()
                record.update(state="failed", error=f"{type(e).__name__}: {e}", trace=tb, stage=stage)
                final = dict(state="failed", error=f"Simulation error: {e}", message="Failed", stage=stage,
                             trace=_tail(tb))
        # write results before announcing the final state, so a client that sees "done" can read them
        if rid in self.detached:
            return
        # together, list entry first: a run counts as finished once run.json exists, and must be in the list by then
        store.docs.write_many([(f"runs/{rid}/row.json", run_row(record)), (f"runs/{rid}/run.json", record)])
        self._set(rid, **final)


def _tail(text, lines=12):
    return "\n".join(text.strip().splitlines()[-lines:]) if text else None


def _terminate(p: subprocess.Popen):
    try:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
    except Exception:  # noqa: BLE001
        pass


def run_seed_subprocess(job: dict, stop: "threading.Event | None" = None, registry: "set | None" = None,
                        lock: "threading.Lock | None" = None) -> dict:
    """Run one seed in a fresh Python process and return its result dict.

    If `stop` is set before or while the seed runs, the process is terminated and Cancelled is raised.
    """
    if stop is not None and stop.is_set():
        raise Cancelled()
    out = os.path.abspath(job["out_dir"])
    os.makedirs(out, exist_ok=True)
    job_f = os.path.join(out, "job.json")
    res_f = os.path.join(out, "result.json")
    with open(job_f, "w") as f:
        json.dump(job, f)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(config.BACKEND_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    p = subprocess.Popen([sys.executable, "-m", "trafficsim.runner", job_f, res_f],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                         cwd=str(config.BACKEND_DIR))
    if registry is not None:
        with lock:
            registry.add(p)
    try:
        so, se = p.communicate()
    finally:
        if registry is not None:
            with lock:
                registry.discard(p)
    if stop is not None and stop.is_set():
        raise Cancelled()
    if p.returncode != 0 or not os.path.exists(res_f):
        raise SeedFailed(job["seed"], (se or so or "").strip())
    with open(res_f) as f:
        return json.load(f)


def load_run(rid: str) -> dict:
    r = store.docs.read(f"runs/{rid}/run.json") if "/" not in rid else None
    if r is None:
        raise KeyError(f"run '{rid}' not found or still running")
    return r


def run_row(r: dict) -> dict:
    """The short form of a finished run shown in lists."""
    agg = r.get("aggregate", {}).get("kpis", {})
    return dict(id=r["id"], scenario_id=r["scenario"]["id"], scenario_name=r["scenario"]["name"],
                base_network=r["scenario"]["base_network"], controller=r["scenario"]["controller"],
                parent_id=r["scenario"].get("parent_id"), error=r.get("error"), stage=r.get("stage"),
                demand_scale=r["scenario"]["demand_scale"], edits=len(r["scenario"]["edits"]),
                state=r["state"], seeds=r["seeds"], started=r.get("started"),
                depart_jitter_s=r.get("depart_jitter_s", 0),
                finished=r.get("finished"), versions=r.get("versions"),
                teleports=agg.get("teleports", {}).get("mean"),
                mean_travel_time_s=agg.get("mean_travel_time_s", {}).get("mean"))


def list_runs(scenario_id: str | None = None) -> list:
    rows = {rid: row for rid, row in store.docs.items("runs", "row.json")}
    if not store.SHARED:                     # runs finished before row.json existed
        for rid, r in store.docs.items("runs", "run.json"):
            if rid not in rows:
                rows[rid] = run_row(r)
                store.docs.write(f"runs/{rid}/row.json", rows[rid])
    out = [r for r in rows.values() if not scenario_id or r["scenario_id"] == scenario_id]
    return sorted(out, key=lambda r: r.get("started") or 0, reverse=True)
