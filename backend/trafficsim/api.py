"""FastAPI app for the planner/student traffic simulator.

Run: uvicorn trafficsim.api:app --reload   (from the backend/ directory)
"""
import os
import tempfile
import threading
from pathlib import Path
from typing import List, Optional, Union

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis, build, catalog, config, geometry, jobs, names, runner, scenario as sc
from .scenario import Edit, Scenario

app = FastAPI(title="Traffic Scenario Simulator", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("TRAFFICSIM_CORS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])
_jobs: jobs.JobManager | None = None
_jobs_lock = threading.Lock()


def jm() -> jobs.JobManager:
    """One job manager per server process (sync endpoints run in parallel threads)."""
    global _jobs
    with _jobs_lock:
        if _jobs is None:
            _jobs = jobs.JobManager()
    return _jobs


def _nf(e: Exception):
    raise HTTPException(404, str(e).strip("'\""))


# ---------- networks ----------
@app.get("/api/health")
def health():
    return dict(ok=True, workers=config.MAX_WORKERS, versions=jobs.versions(),
                settings=dict(time_to_teleport_s=runner.TELEPORT_S, ignore_junction_blocker_s=runner.JUNCTION_BLOCKER_S, step_length_s=config.STEP_LENGTH,
                              drain_s=config.DRAIN_S, default_seeds=config.DEFAULT_SEEDS))


@app.get("/api/networks")
def networks():
    return catalog.list_networks()


@app.get("/api/networks/{nid}")
def network(nid: str):
    try:
        return catalog.meta(nid)
    except KeyError as e:
        _nf(e)


# ---------- scenarios ----------
class NewScenario(BaseModel):
    base_network: str
    name: str = "Untitled scenario"


class ScenarioUpdate(BaseModel):
    name: Optional[str] = None
    demand_scale: Optional[float] = Field(None, ge=0.1, le=3.0)
    controller: Optional[str] = None
    edits: Optional[List[Edit]] = None


def _get(sid) -> Scenario:
    try:
        return sc.load(sid)
    except KeyError as e:
        _nf(e)


def _check(s: Scenario) -> list:
    """Dry-run build; raises 422 with a readable message for invalid edits."""
    try:
        with tempfile.TemporaryDirectory() as d:
            return build.build(s, Path(d)).warnings
    except build.EditError as e:
        raise HTTPException(422, str(e))


@app.post("/api/scenarios")
def create_scenario(body: NewScenario):
    try:
        catalog.ensure_network(body.base_network)
    except KeyError as e:
        _nf(e)
    except FileNotFoundError:
        raise HTTPException(503, "This network's files are not installed on the server. "
                                 "See the README: clone the RESCO repository into backend/data/resco.")
    return sc.save(Scenario(base_network=body.base_network, name=body.name))


@app.get("/api/scenarios")
def list_scenarios():
    return sc.list_all()


@app.get("/api/scenarios/{sid}")
def get_scenario(sid: str):
    s = _get(sid)
    return dict(scenario=s, warnings=_check(s))


@app.put("/api/scenarios/{sid}")
def update_scenario(sid: str, body: ScenarioUpdate):
    s = _get(sid)
    data = s.model_dump()
    for k, v in body.model_dump(exclude_unset=True).items():
        data[k] = v
    try:
        new = Scenario.model_validate(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, str(e))
    warnings = _check(new)
    sc.save(new)
    return dict(scenario=new, warnings=warnings)


@app.post("/api/scenarios/{sid}/copy")
def copy_scenario(sid: str, name: Optional[str] = None):
    s = _get(sid)
    c = Scenario(**{k: v for k, v in s.model_dump().items() if k not in ("id", "created", "parent_id")},
                 parent_id=s.id)
    c.name = name or f"{s.name} (changed)"
    return sc.save(c)


@app.delete("/api/scenarios/{sid}")
def delete_scenario(sid: str):
    sc.delete(sid)
    return dict(ok=True)


def _built_net(s: Scenario) -> Path:
    with tempfile.TemporaryDirectory() as d:
        try:
            return build.build(s, Path(d)).net_file
        except build.EditError as e:
            raise HTTPException(422, str(e))


@app.get("/api/scenarios/{sid}/geometry")
def scenario_geometry(sid: str):
    s = _get(sid)
    net = _built_net(s)
    g = geometry.network_geojson(str(net), net.stat().st_mtime)
    g = dict(g, features=[dict(f, properties=dict(f["properties"])) for f in g["features"]])  # don't touch the cache
    names.label_edges(g["features"], s.base_network)
    edited = {}
    for e in s.edits:
        for key in ("edge", "from_edge"):
            if hasattr(e, key):
                edited.setdefault(getattr(e, key), []).append(e.type)
    return dict(g, edited=edited)


@app.get("/api/scenarios/{sid}/signals")
def scenario_signals(sid: str):
    s = _get(sid)
    progs = geometry.signal_programs(str(_built_net(s)))
    retimed = {e.tls: e.durations for e in s.edits if e.type == "retime_signal"}
    street = names.street_names(s.base_network)

    def road(eid):
        return street.get(names.osm_way(eid)) or eid
    for tid, p in progs.items():
        p["retimed_durations"] = retimed.get(tid)
        for li in p.get("link_info", []):
            li["from_label"], li["to_label"] = road(li["from_edge"]), road(li["to_edge"])
    return progs


# ---------- runs ----------
class RunRequest(BaseModel):
    seeds: Union[int, List[int]] = config.DEFAULT_SEEDS


@app.post("/api/scenarios/{sid}/runs")
def start_run(sid: str, body: RunRequest):
    s = _get(sid)
    _check(s)
    seeds = list(range(1, body.seeds + 1)) if isinstance(body.seeds, int) else body.seeds
    if not 1 <= len(seeds) <= 50:
        raise HTTPException(422, "Use between 1 and 50 seeds.")
    return jm().submit(s, seeds)


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    try:
        return jm().status(jid)
    except KeyError as e:
        _nf(e)


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str):
    try:
        return jm().cancel(jid)
    except KeyError as e:
        _nf(e)


@app.get("/api/runs")
def runs(scenario_id: Optional[str] = None):
    return jobs.list_runs(scenario_id)


@app.get("/api/runs/{rid}")
def run(rid: str):
    try:
        r = jobs.load_run(rid)
    except KeyError as e:
        _nf(e)
    r.pop("trace", None)
    r.pop("seed_results", None)
    return r


@app.get("/api/compare")
def compare(before: str, after: str):
    try:
        a, b = jobs.load_run(before), jobs.load_run(after)
    except KeyError as e:
        _nf(e)
    if a["state"] != "done" or b["state"] != "done":
        raise HTTPException(409, "Both runs must be finished.")
    c = analysis.compare(a["seed_results"], b["seed_results"], a["seeds"], b["seeds"])
    if not c["paired_seeds"]:
        raise HTTPException(422, "The two runs share no seeds, so they cannot be paired.")
    if a["scenario"]["base_network"] != b["scenario"]["base_network"]:
        raise HTTPException(422, "Runs are on different base networks.")
    c.update(headline=analysis.headline(c), before=dict(run=before, scenario=a["scenario"]),
             after=dict(run=after, scenario=b["scenario"]))
    return c


# ---------- bundles ----------
@app.get("/api/scenarios/{sid}/bundle")
def export_bundle(sid: str, seeds: int = config.DEFAULT_SEEDS, first_seed: int = 1,
                  before: Optional[str] = None, after: Optional[str] = None):
    """Scenario bundle. With `before`/`after` run ids it is a full experiment record: both scenario
    snapshots as run, the exact seeds, app and SUMO versions, and per-seed KPI values to check a
    reproduction against."""
    s = _get(sid)
    seed_list = list(range(first_seed, first_seed + seeds))
    exp = None
    if before and after:
        try:
            a, b = jobs.load_run(before), jobs.load_run(after)
        except KeyError as e:
            _nf(e)
        s = Scenario.model_validate(b["scenario"])          # the proposal exactly as it was run
        seed_list = b["seeds"]
        keep = ("mean_travel_time_s", "mean_delay_s", "completed_trips", "teleports")
        exp = dict(before_run=before, after_run=after, baseline=a["scenario"], seeds=b["seeds"],
                   versions=b.get("versions"),
                   values={k: dict(before=a["aggregate"]["kpis"][k]["values"], after=b["aggregate"]["kpis"][k]["values"])
                           for k in keep if k in a.get("aggregate", {}).get("kpis", {})})
    bundle = sc.to_bundle(s, seed_list)
    bundle["app"] = dict(version=jobs.APP_VERSION)
    if exp:
        bundle["experiment"] = exp
    return JSONResponse(bundle, headers={"Content-Disposition": f'attachment; filename="experiment_{after or sid}.json"'})


@app.post("/api/bundles")
def import_bundle(bundle: dict):
    try:
        s = sc.from_bundle(bundle)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"Not a valid scenario bundle: {e}")
    try:
        catalog.ensure_network(s.base_network)
    except KeyError as e:
        _nf(e)
    _check(s)
    return sc.save(s)


# ---------- static frontend (production build) ----------
_dist = Path(os.environ.get("TRAFFICSIM_FRONTEND", config.BACKEND_DIR.parent / "frontend" / "dist"))
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = _dist / path
        return FileResponse(f if path and f.is_file() else _dist / "index.html")
