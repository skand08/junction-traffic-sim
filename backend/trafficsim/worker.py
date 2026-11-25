"""The worker: runs the jobs the API queues when JUNCTION_EXECUTION=queue.

    python -m trafficsim.worker          (from backend/; needs DATABASE_URL)

It claims queued jobs from Postgres (jobqueue.py) up to its capacity per kind, runs them with the same code
the API uses in local mode (simulation runs, trainings, benchmarks, calibrations, live sessions), keeps them
alive with heartbeats, forwards requests (cancel, pause, live controls) and marks jobs of workers that went
silent as interrupted. Any number of workers can run against one database; each job runs on exactly one.

On SIGTERM (a new deployment, scaling down) it stops claiming, lets running work finish for up to
JUNCTION_WORKER_DRAIN_S seconds, then hands unfinished runs, benchmarks and calibrations back to the queue
(another worker starts them again), asks trainings to stop after saving their model, and ends live sessions.
"""
import os

os.environ["JUNCTION_EXECUTION"] = "local"       # this process runs jobs itself (set before the app modules load)

import signal                                     # noqa: E402
import socket                                     # noqa: E402
import threading                                  # noqa: E402
import time                                       # noqa: E402
import traceback                                  # noqa: E402
import uuid                                       # noqa: E402

from . import calibrate, db, jobqueue, jobs, live, research, store   # noqa: E402
from .rl import train as rl_train                 # noqa: E402
from .scenario import Scenario                    # noqa: E402

CAPACITY = dict(run=int(os.environ.get("JUNCTION_WORKER_RUNS", "2")),
                train=int(os.environ.get("JUNCTION_WORKER_TRAININGS", "1")),
                bench=int(os.environ.get("JUNCTION_WORKER_BENCHMARKS", "1")),
                calibrate=int(os.environ.get("JUNCTION_WORKER_CALIBRATIONS", "1")),
                live=int(os.environ.get("JUNCTION_WORKER_LIVE", "2")))
POLL_S = float(os.environ.get("JUNCTION_WORKER_POLL_S", "2"))          # looking for new jobs
IDLE_POLL_S = float(os.environ.get("JUNCTION_WORKER_IDLE_POLL_S", "10"))  # after 10 minutes without work
DRAIN_S = float(os.environ.get("JUNCTION_WORKER_DRAIN_S", "240"))
HEARTBEAT_S, STALE_S, REAP_S = 15, 120, 60
LIVE_IDLE_S = float(os.environ.get("JUNCTION_LIVE_IDLE_S", "300"))     # end a live session nobody watches
LIVE_KEEP_S = 86400                     # an ended session nobody closed stays readable this long


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class LiveRunner:
    """Live sessions on this worker: a live.Session each, plus a thread that publishes its frames."""

    def __init__(self, train: rl_train.TrainingManager):
        self.train = train
        self.sessions: dict = {}
        self.ended: set = set()

    def launch(self, sid: str, payload: dict):
        doc = store.docs.read(f"live/{sid}.json")
        if doc is None:
            raise RuntimeError("The live session was closed before it started.")
        cfg = live.LiveConfig(**doc["cfg"])
        s = Scenario.model_validate(doc["scenario"])
        rl_model = str(self.train.model_path(cfg.rl_agent, cfg.rl_checkpoint)) if cfg.controller == "rl" else None
        job, meta = live.prepare(s, cfg, live.LIVE_DIR / sid, rl_model)
        sess = live.Session(sid, cfg, job, meta)
        self.sessions[sid] = sess
        sess.start()
        threading.Thread(target=self._bridge, args=(sid, sess), daemon=True).start()

    def _bridge(self, sid: str, sess: "live.Session"):
        last, last_key, checked = None, None, time.monotonic()
        while sid in self.sessions:
            with sess.cond:
                if sess.frame is last and not sess.error:
                    sess.cond.wait(1.0)
                frame, error, run = sess.frame, sess.error, sess.run
            key = (run, (frame or {}).get("seq"), error)
            if key != last_key:
                try:
                    jobqueue.live_publish(sid, run, frame, error)
                except Exception as e:  # noqa: BLE001
                    log("live publish failed", sid, e)
                last, last_key = frame, key
            if error:
                break
            if time.monotonic() - checked > 10:
                checked = time.monotonic()
                idle = jobqueue.live_idle_s(sid)
                if idle is None:                            # ended by the user: the API removed it
                    break
                if idle > LIVE_IDLE_S:                      # nobody watching: say so where the app looks
                    log("live session idle, stopping", sid)
                    jobqueue.live_publish(sid, run, frame, f"The live view stopped because nobody watched it for "
                                          f"{round(LIVE_IDLE_S / 60)} minutes. Start it again.")
                    break
        self.stop(sid)

    def command(self, sid: str, cmd: dict):
        sess = self.sessions.get(sid)
        if not sess:
            return
        a = cmd.get("action")
        if a == "stop":
            self.stop(sid)
        elif a == "reset":
            sess.reset()
        else:
            sess.send(cmd)

    def stop(self, sid: str):
        sess = self.sessions.pop(sid, None)
        if sess:
            sess.stop()
            self.ended.add(sid)

    def running(self, sid: str) -> bool:
        return sid in self.sessions


class Worker:
    def __init__(self):
        self.name = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:4]}"
        self.runs = jobs.JobManager()
        self.train = rl_train.TrainingManager(max_jobs=10 ** 6)     # limits come from CAPACITY
        self.bench = research.BenchmarkManager(self.train.model_path, self.train.info)
        self.cal = calibrate.Manager()
        self.live = LiveRunner(self.train)
        self.mine: dict = {}                      # job id -> kind, running here
        self.stopping = threading.Event()

    # ---------- per kind ----------
    def _start(self, kind: str, jid: str, payload: dict):
        if kind == "run":
            self.runs.submit(Scenario.model_validate(payload["scenario"]), payload["seeds"],
                             payload.get("depart_jitter_s", 0), rid=jid)
        elif kind == "train":
            self.train.launch(jid, payload)
        elif kind == "bench":
            self.bench.launch(jid, payload)
        elif kind == "calibrate":
            self.cal.launch(jid, payload)
        elif kind == "live":
            self.live.launch(jid, payload)
        else:
            raise RuntimeError(f"unknown job kind {kind}")

    def _running(self, kind: str, jid: str) -> bool:
        return {"run": self.runs.running, "train": self.train.running, "bench": self.bench.running,
                "calibrate": self.cal.running, "live": self.live.running}[kind](jid)

    @staticmethod
    def _final_state(kind: str, jid: str) -> str:
        if kind == "live":
            return "done"
        doc = {"run": f"runs/{jid}/status.json", "train": f"{rl_train.DOCS}/{jid}/status.json",
               "bench": f"{research.DOCS}/{jid}/status.json", "calibrate": f"{calibrate.DOCS}/{jid}/status.json"}[kind]
        st = (store.docs.read(doc) or {}).get("state")
        return st if st in ("done", "failed", "cancelled") else "done" if st in ("stopped",) else (st or "done")

    def _command(self, kind: str, jid: str, cmd: dict):
        a = cmd.get("action")
        if kind == "run" and a == "cancel":
            self.runs.cancel(jid)
        elif kind == "train" and a in ("pause", "resume", "stop"):
            self.train.control(jid, a)
        elif kind == "bench" and a == "cancel":
            self.bench.cancel(jid)
        elif kind == "live":
            self.live.command(jid, cmd)

    @staticmethod
    def _fail(kind: str, jid: str, error: str):
        """Record a job that could not start or whose worker stopped, in the place the API reads it."""
        now = time.time()
        if kind == "run":
            store.docs.merge(f"runs/{jid}/status.json", state="failed", message="Failed", error=error)
        elif kind == "train":
            store.docs.merge(f"{rl_train.DOCS}/{jid}/status.json", state="interrupted", error=error, finished=now)
        elif kind == "bench":
            store.docs.merge(f"{research.DOCS}/{jid}/status.json", state="interrupted", error=error, finished=now)
        elif kind == "calibrate":
            store.docs.merge(f"{calibrate.DOCS}/{jid}/status.json", state="failed", error=error, finished=now)
        elif kind == "live":
            jobqueue.live_publish(jid, 0, None, error)

    # ---------- loop ----------
    def claim(self):
        for kind, cap in CAPACITY.items():
            free = cap - sum(1 for k in self.mine.values() if k == kind)
            for jid, payload in jobqueue.claim(self.name, kind, free):
                log("start", kind, jid)
                self.mine[jid] = kind
                try:
                    self._start(kind, jid, payload or {})
                except Exception as e:  # noqa: BLE001
                    msg = str(e) if isinstance(e, (ValueError, KeyError)) else f"{type(e).__name__}: {e}"
                    log("could not start", kind, jid, msg, traceback.format_exc()[-800:])
                    self._fail(kind, jid, f"Could not start: {msg}")
                    jobqueue.finish(jid, "failed", msg)
                    self.mine.pop(jid, None)

    def check(self):
        for jid, kind in list(self.mine.items()):
            if not self._running(kind, jid):
                state = self._final_state(kind, jid)
                log("end", kind, jid, state)
                jobqueue.finish(jid, state)
                self.mine.pop(jid, None)
                # a live session's row is kept: it holds why it ended, and the API removes it when the user ends it

    def commands(self):
        for jid, cmds in jobqueue.take_commands(self.name).items():
            kind = self.mine.get(jid)
            for cmd in cmds:
                if kind:
                    try:
                        self._command(kind, jid, cmd)
                    except Exception as e:  # noqa: BLE001
                        log("command failed", kind, jid, cmd, e)

    def reap(self):
        for kind, jid in jobqueue.reap(STALE_S):
            log("interrupted (worker went silent)", kind, jid)
            self._fail(kind, jid, "The worker running this stopped. Start it again.")
        for sid in jobqueue.live_purge(LIVE_KEEP_S):        # ended sessions nobody closed
            store.docs.delete(f"live/{sid}.json")

    def run(self):
        store.ready()
        log(f"worker {self.name} ready; capacity {CAPACITY}")
        last_hb = last_reap = last_claim = 0.0
        last_work = time.monotonic()
        while not self.stopping.is_set():
            now = time.monotonic()
            try:
                if self.mine:
                    last_work = now
                    self.commands()
                    self.check()
                if now - last_hb > HEARTBEAT_S:
                    jobqueue.heartbeat(self.name, list(self.mine))
                    last_hb = now
                if now - last_reap > REAP_S:
                    self.reap()
                    last_reap = now
                poll = POLL_S if now - last_work < 600 else IDLE_POLL_S
                if now - last_claim > poll:
                    self.claim()
                    last_claim = now
            except Exception as e:  # noqa: BLE001 - a database hiccup must not end the worker
                log("loop error:", type(e).__name__, e)
                time.sleep(2)
            self.stopping.wait(0.5)
        self.drain()

    def drain(self):
        log(f"stopping; {len(self.mine)} job(s) running")
        for jid, kind in list(self.mine.items()):
            if kind == "train":
                self.train.control(jid, "stop")      # saves the model and ends as "stopped"
            elif kind == "live":
                self.live.stop(jid)
        t_end = time.monotonic() + DRAIN_S
        while self.mine and time.monotonic() < t_end:
            jobqueue.heartbeat(self.name, list(self.mine))
            self.check()
            time.sleep(1)
        for jid, kind in list(self.mine.items()):
            if kind in ("run", "bench", "calibrate"):
                log("handing back", kind, jid)
                if kind == "run":
                    self.runs.detach(jid)
                elif kind == "bench":
                    self.bench.detach(jid)
                jobqueue.requeue(jid)
                st = {"run": f"runs/{jid}/status.json", "bench": f"{research.DOCS}/{jid}/status.json",
                      "calibrate": f"{calibrate.DOCS}/{jid}/status.json"}[kind]
                store.docs.merge(st, state="queued", message="Waiting to start", done=0)
            else:
                self._fail(kind, jid, "The worker running this restarted. Start it again.")
                jobqueue.finish(jid, "interrupted")
        self.train.stop_all()
        log("stopped")
        os._exit(0)          # do not wait for threads of work that was handed back


def main():
    if not db.enabled():
        raise SystemExit("The worker needs DATABASE_URL (Postgres).")
    w = Worker()
    signal.signal(signal.SIGTERM, lambda *_: w.stopping.set())
    signal.signal(signal.SIGINT, lambda *_: w.stopping.set())
    w.run()


if __name__ == "__main__":
    main()
