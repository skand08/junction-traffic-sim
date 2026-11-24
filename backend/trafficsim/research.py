"""Benchmarks: controllers compared under identical traffic.

A benchmark runs every combination of scenario (the main one and any held-out ones), demand level and
controller, each on the same seeds and the same start-time variation, so every comparison is paired. All
numbers come from the SUMO runs; nothing is estimated.

Stored in WORKSPACE/research/benchmarks/<id>/: config.json, manifest.json, status.json, results.json.
"""
import csv
import hashlib
import io
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from . import analysis, build, config, scenario as sc
from .external import ExternalCfg, check_url
from .jobs import Cancelled, run_seed_subprocess, versions

BENCH_DIR = config.WORKSPACE_DIR / "research" / "benchmarks"
BENCH_DIR.mkdir(parents=True, exist_ok=True)

# measures reported by benchmarks: key -> (label, unit, lower is better)
MEASURES = {
    "mean_travel_time_s": ("Average travel time", "s", True),
    "mean_waiting_s": ("Average waiting time", "s", True),
    "mean_delay_s": ("Average delay", "s", True),
    "mean_queue_veh": ("Average queue (vehicles stopped)", "veh", True),
    "throughput_veh_h": ("Throughput", "veh/h", False),
    "co2_g_per_trip": ("CO2 per trip", "g", True),
    "mean_stops": ("Stops per trip", "", True),
    "teleports": ("Gridlock removals", "", True),
}


class ControllerSpec(BaseModel):
    kind: Literal["fixed", "actuated", "max_pressure", "rl", "external"]
    agent_id: Optional[str] = None
    external: Optional[ExternalCfg] = None   # with kind "external": your controller's address and settings
    checkpoint: str = "final"             # final | best | ep_NNNN.npz
    label: Optional[str] = None


class BenchCfg(BaseModel):
    name: str = "Benchmark"
    scenario_id: str
    heldout_ids: List[str] = []           # other scenarios to test on (not used in training)
    controllers: List[ControllerSpec]
    reference: int = 0                    # index in controllers
    demand_levels: List[float] = [1.0]
    seeds: int = Field(5, ge=1, le=50)
    first_seed: int = Field(1, ge=1)
    depart_jitter_s: float = Field(300, ge=0, le=1800)


def _label(c: ControllerSpec, names: dict) -> str:
    if c.label:
        return c.label
    base = {"fixed": "Fixed timing", "actuated": "Vehicle-actuated", "max_pressure": "Pressure-based"}.get(c.kind)
    if base:
        return base
    if c.kind == "external":
        return c.external.name if c.external else "External controller"
    return f"RL: {names.get(c.agent_id, c.agent_id)}" + ("" if c.checkpoint == "final" else f" ({c.checkpoint.replace('.npz', '')})")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


class BenchmarkManager:
    def __init__(self, model_path, agent_info, workers: int = config.MAX_WORKERS):
        self.model_path, self.agent_info = model_path, agent_info
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers))
        self.stop: dict = {}
        self.lock = threading.Lock()
        for d in BENCH_DIR.iterdir():
            st = d / "status.json"
            if st.exists() and json.loads(st.read_text()).get("state") in ("running", "queued"):
                self._status(d.name, state="interrupted")

    # ---------- storage ----------
    def _dir(self, bid: str) -> Path:
        d = BENCH_DIR / bid
        if "/" in bid or not (d / "config.json").exists():
            raise KeyError(f"benchmark '{bid}' not found")
        return d

    def _status(self, bid: str, **kw):
        f = BENCH_DIR / bid / "status.json"
        s = json.loads(f.read_text()) if f.exists() else {}
        s.update(kw)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(s))
        tmp.replace(f)

    def info(self, bid: str) -> dict:
        d = self._dir(bid)
        return dict(id=bid, config=json.loads((d / "config.json").read_text()),
                    manifest=json.loads((d / "manifest.json").read_text()), status=json.loads((d / "status.json").read_text()))

    def list(self) -> list:
        out = []
        for d in sorted(BENCH_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                out.append(self.info(d.name))
            except (KeyError, FileNotFoundError, json.JSONDecodeError):
                continue
        return out

    def results(self, bid: str) -> list:
        f = self._dir(bid) / "results.json"
        return json.loads(f.read_text()) if f.exists() else []

    # ---------- running ----------
    def create(self, cfg: BenchCfg) -> dict:
        scen = [sc.load(i) for i in [cfg.scenario_id, *cfg.heldout_ids]]
        if any(s.base_network != scen[0].base_network for s in scen[1:]):
            pass                                   # other networks are allowed; RL agents must fit them (checked per run)
        names = {}
        models = {}
        for c in cfg.controllers:
            if c.kind == "rl":
                if not c.agent_id:
                    raise ValueError("Choose a trained agent for the RL controller.")
                p = self.model_path(c.agent_id, c.checkpoint)
                info = self.agent_info(c.agent_id)
                names[c.agent_id] = info["config"]["name"]
                models[f"{c.agent_id}/{c.checkpoint}"] = dict(file=str(p), sha=_sha(p), config=info["config"],
                                                              manifest=info["manifest"])
            if c.kind == "external":
                if not c.external:
                    raise ValueError("Give the external controller's address.")
                check_url(c.external.url)
        if not 0 <= cfg.reference < len(cfg.controllers):
            raise ValueError("The reference must be one of the controllers.")
        bid = uuid.uuid4().hex[:10]
        d = BENCH_DIR / bid
        d.mkdir(parents=True)
        (d / "config.json").write_text(cfg.model_dump_json(indent=1))
        labels = [_label(c, names) for c in cfg.controllers]
        seeds = list(range(cfg.first_seed, cfg.first_seed + cfg.seeds))
        manifest = dict(id=bid, created=time.time(), versions=versions(), seeds=seeds, labels=labels,
                        scenarios=[dict(id=s.id, name=s.name, network=s.base_network, edits=[e.model_dump() for e in s.edits],
                                        demand_scale=s.demand_scale) for s in scen],
                        models=models, depart_jitter_s=cfg.depart_jitter_s,
                        external=[dict(label=labels[i], **c.external.model_dump()) for i, c in enumerate(cfg.controllers)
                                  if c.kind == "external"])
        (d / "manifest.json").write_text(json.dumps(manifest, indent=1))
        total = len(scen) * len(cfg.demand_levels) * len(cfg.controllers) * len(seeds)
        self._status(bid, state="queued", done=0, total=total, created=time.time())
        self.stop[bid] = threading.Event()
        threading.Thread(target=self._run, args=(bid, cfg, scen, labels, seeds), daemon=True).start()
        return self.info(bid)

    def cancel(self, bid: str):
        if bid in self.stop:
            self.stop[bid].set()

    def _run(self, bid: str, cfg: BenchCfg, scen: list, labels: list, seeds: list):
        d = BENCH_DIR / bid
        stop = self.stop[bid]
        cells, futs = [], {}
        registry, lock = set(), threading.Lock()
        self._status(bid, state="running", started=time.time())
        try:
            for s in scen:
                for level in cfg.demand_levels:
                    for ci, c in enumerate(cfg.controllers):
                        cell = dict(scenario_id=s.id, scenario=s.name, network=s.base_network, demand=level,
                                    controller=ci, label=labels[ci], heldout=s.id != cfg.scenario_id,
                                    seed_results=[], errors=[])
                        cells.append(cell)
                        out = d / "runs" / f"{len(cells):03d}"
                        s2 = s.model_copy(update=dict(controller=c.kind if c.kind not in ("rl", "external") else "fixed"))
                        b = build.build(s2, out)
                        base = dict(net_file=str(b.net_file), demand_file=str(b.demand_file),
                                    tls_additional=str(b.tls_additional) if b.tls_additional else None,
                                    begin=b.begin, end=b.end, scale=round(s.demand_scale * level, 4),
                                    controller=c.kind, depart_jitter_s=cfg.depart_jitter_s, research=True)
                        if c.kind == "external":
                            base["external"] = c.external.model_dump()
                        if c.kind == "rl":
                            base["rl_model"] = str(self.model_path(c.agent_id, c.checkpoint))
                        for k in seeds:
                            f = self.pool.submit(run_seed_subprocess, dict(base, seed=k, out_dir=str(out / f"seed_{k}")),
                                                 stop, registry, lock)
                            futs[f] = cell
            done = 0
            for f in as_completed(futs):
                cell = futs[f]
                try:
                    r = f.result()
                    r.pop("edges", None)
                    cell["seed_results"].append(r)
                except Cancelled:
                    continue
                except Exception as e:  # noqa: BLE001
                    cell["errors"].append(str(e)[-400:])
                done += 1
                self._status(bid, done=done)
                if done % 5 == 0 or done == len(futs):
                    self._save(d, cells)
            self._save(d, cells)
            self._status(bid, state="cancelled" if stop.is_set() else "done", finished=time.time())
        except Exception as e:  # noqa: BLE001
            self._save(d, cells)
            self._status(bid, state="failed", error=f"{type(e).__name__}: {e}")

    def _save(self, d: Path, cells: list):
        for c in cells:
            c["seed_results"].sort(key=lambda r: r["seed"])
        tmp = d / "results.json.tmp"
        tmp.write_text(json.dumps(cells))
        tmp.replace(d / "results.json")

    # ---------- analysis ----------
    def stats(self, bid: str) -> dict:
        info = self.info(bid)
        cfg = BenchCfg(**info["config"])
        cells = self.results(bid)
        groups = {}
        for c in cells:
            groups.setdefault((c["scenario_id"], c["demand"]), []).append(c)
        conditions = []
        for (sid, level), cs in groups.items():
            ref = next((c for c in cs if c["controller"] == cfg.reference), None)
            rows = []
            for c in sorted(cs, key=lambda x: x["controller"]):
                srs = c["seed_results"]
                m = {}
                for k in MEASURES:
                    vals = [r["kpi"].get(k) for r in srs if r["kpi"].get(k) is not None]
                    mean, lo, hi = analysis._ci(vals)
                    m[k] = dict(mean=mean, ci_low=lo, ci_high=hi, n=len(vals), values=vals)
                vs = None
                if ref is not None and c is not ref and srs and ref["seed_results"]:
                    noedge = lambda rs: [dict(r, edges={}) for r in rs]      # benchmarks keep trips, not per-road data
                    cmp = analysis.compare(noedge(ref["seed_results"]), noedge(srs), [r["seed"] for r in ref["seed_results"]],
                                           [r["seed"] for r in srs])
                    vs = {}
                    for k, kk in (("mean_travel_time_s", "matched_travel_time_s"), ("mean_delay_s", "matched_delay_s")):
                        x = cmp["kpis"].get(kk) or cmp["kpis"].get(k)
                        if x:
                            vs[k] = {f: x.get(f) for f in ("diff", "diff_ci_low", "diff_ci_high", "pct_change", "share_seeds_better", "n", "significant", "verdict")}
                    for k, (_, _, lower) in MEASURES.items():
                        if k in vs:
                            continue
                        pa = {r["seed"]: r["kpi"].get(k) for r in ref["seed_results"]}
                        pb = {r["seed"]: r["kpi"].get(k) for r in srs}
                        common = [s for s in pa if s in pb and pa[s] is not None and pb[s] is not None]
                        if not common:
                            continue
                        diffs = [pb[s] - pa[s] for s in common]
                        dm, dlo, dhi = analysis._ci(diffs)
                        base = sum(pa[s] for s in common) / len(common)
                        better = sum((x < 0) if lower else (x > 0) for x in diffs)
                        sig = dlo is not None and (dlo > 0 or dhi < 0)
                        vs[k] = dict(diff=dm, diff_ci_low=dlo, diff_ci_high=dhi, pct_change=(100 * dm / base) if base else None,
                                     share_seeds_better=better / len(common), n=len(common), significant=sig,
                                     verdict=("no change" if not sig else ("better" if (dm < 0) == lower else "worse")))
                rows.append(dict(controller=c["controller"], label=c["label"], measures=m, vs_reference=vs,
                                 runs=len(srs), errors=c["errors"],
                                 teleport_trips=sum(r["kpi"].get("teleported_trips", 0) for r in srs)))
            conditions.append(dict(scenario_id=sid, scenario=cs[0]["scenario"], network=cs[0]["network"], demand=level,
                                   heldout=cs[0]["heldout"], rows=rows))
        # robustness: across all conditions, how often each controller beats the reference on travel time
        summary = []
        for i, lab in enumerate(info["manifest"]["labels"]):
            if i == cfg.reference:
                continue
            res = [r["vs_reference"]["mean_travel_time_s"] for cond in conditions for r in cond["rows"]
                   if r["controller"] == i and r["vs_reference"] and "mean_travel_time_s" in r["vs_reference"]]
            summary.append(dict(controller=i, label=lab, conditions=len(res),
                                better=sum(x["verdict"] == "better" for x in res), worse=sum(x["verdict"] == "worse" for x in res),
                                mean_pct=(sum(x["pct_change"] for x in res if x["pct_change"] is not None) / len(res)) if res else None,
                                worst_pct=max((x["pct_change"] for x in res if x["pct_change"] is not None), default=None)))
        return dict(measures={k: dict(label=v[0], unit=v[1], lower_is_better=v[2]) for k, v in MEASURES.items()},
                    reference=cfg.reference, labels=info["manifest"]["labels"], conditions=conditions, robustness=summary)

    def csv(self, bid: str) -> str:
        cells = self.results(bid)
        buf = io.StringIO()
        w = csv.writer(buf)
        keys = list(MEASURES) + ["completed_trips", "unfinished_trips", "teleported_trips", "not_inserted"]
        w.writerow(["benchmark", "scenario", "scenario_id", "heldout", "demand_level", "controller", "seed", *keys])
        for c in cells:
            for r in c["seed_results"]:
                w.writerow([bid, c["scenario"], c["scenario_id"], c["heldout"], c["demand"], c["label"], r["seed"],
                            *[r["kpi"].get(k) for k in keys]])
        return buf.getvalue()
