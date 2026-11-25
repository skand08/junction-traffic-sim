"""FastAPI app for the planner/student traffic simulator.

Run: uvicorn trafficsim.api:app --reload   (from the backend/ directory)
"""
import atexit
import os
import shutil
import csv
import io
import json
import tempfile
import uuid
import threading
import time
import re
from pathlib import Path
from typing import List, Literal, Optional, Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis, auth, build, db, calibrate, catalog, config, envexport, geometry, external, importer, jobqueue, jobs, live, names, runner, simulations, store, scenario as sc
from .scenario import Edit, Scenario

store.ready(strict=False)         # creates the database tables on first start (no-op with local files)
app = FastAPI(title="Traffic Scenario Simulator", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("TRAFFICSIM_CORS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])
auth.install(app)                 # sign-in, when JUNCTION_SECRET is set


@app.exception_handler(Exception)
async def _server_error(request: Request, e: Exception):
    """Unexpected errors answer with what failed (the app shows `detail`), and the traceback goes to the log."""
    import traceback
    traceback.print_exception(e)
    return JSONResponse({"detail": f"Server error: {type(e).__name__}: {str(e)[:500]}"}, status_code=500)


auth.bootstrap()
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
                storage=dict(documents="postgres" if store.SHARED else "files", database=db.describe(),
                             database_error=store.DB_ERROR, files="blob" if store.files.remote else "local",
                             files_error=store.files_problem(),
                             execution=jobqueue.EXECUTION, queue=jobqueue.depth() if jobqueue.remote() and not store.DB_ERROR else None),
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


def _base_scenario(nid: str) -> Scenario:
    try:
        catalog.ensure_network(nid)
    except KeyError as e:
        _nf(e)
    except FileNotFoundError:
        raise HTTPException(503, "This network's files are not installed on the server.")
    return Scenario(id=f"base-{nid}", base_network=nid, name="As it is", baseline=True)


@app.get("/api/networks/{nid}/geometry")
def network_geometry(nid: str):
    s = _base_scenario(nid)
    net = _built_net(s)
    g = geometry.network_geojson(str(net), net.stat().st_mtime)
    g = dict(g, features=[dict(f, properties=dict(f["properties"])) for f in g["features"]])
    names.label_edges(g["features"], nid)
    return dict(g, edited={})


@app.get("/api/networks/{nid}/signals")
def network_signals(nid: str):
    return geometry.signal_programs(str(_built_net(_base_scenario(nid))))


@app.post("/api/networks/{nid}/baseline")
def network_baseline(nid: str):
    """The network's "As it is" scenario (no changes, fixed timing), created on first use."""
    _base_scenario(nid)
    for s in sc.list_all():
        if s.base_network == nid and s.baseline:
            return s
    return sc.save(Scenario(base_network=nid, name="As it is", baseline=True,
                            description="The network as it is today, with no changes."))


def _upload_dir():
    d = config.WORKSPACE_DIR / "uploads" / uuid.uuid4().hex[:8]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _import_errors(fn):
    try:
        return fn()
    except importer.ImportError_ as e:
        raise HTTPException(422, str(e))


@app.post("/api/networks/import/osm")
async def import_osm_file(request: Request, name: str = "Imported area", trips: Optional[int] = None):
    """Body: an .osm / .osm.xml file (optionally gzip or bzip2 compressed)."""
    body = await request.body()
    if len(body) < 100:
        raise HTTPException(422, "The file is empty.")
    if len(body) > 200_000_000:
        raise HTTPException(413, "The file is larger than 200 MB. Import a smaller area.")
    d = _upload_dir()
    f = d / "upload.osm"
    f.write_bytes(body)
    try:
        return _import_errors(lambda: importer.import_osm(f, name, trips, source="an uploaded OpenStreetMap file"))
    finally:
        shutil.rmtree(d, ignore_errors=True)


class AreaImport(BaseModel):
    bbox: List[float] = Field(min_length=4, max_length=4)   # west, south, east, north
    name: str = "Imported area"
    trips: Optional[int] = Field(None, ge=10, le=50000)


@app.post("/api/networks/import/osm-area")
def import_osm_area(body: AreaImport):
    d = _upload_dir()
    try:
        def go():
            f = importer.fetch_osm_bbox(body.bbox, d / "area.osm")
            return importer.import_osm(f, body.name, body.trips, source="OpenStreetMap (Overpass API)")
        return _import_errors(go)
    finally:
        shutil.rmtree(d, ignore_errors=True)


@app.post("/api/networks/import/sumo")
async def import_sumo_file(request: Request, name: str = "Uploaded network", trips: Optional[int] = None):
    """Body: a SUMO .net.xml, or a .zip with one .net.xml and optionally one .rou.xml."""
    body = await request.body()
    d = _upload_dir()
    try:
        routes = None
        if body[:2] == b"PK":
            import zipfile
            zp = d / "upload.zip"
            zp.write_bytes(body)
            with zipfile.ZipFile(zp) as z:
                members = [m for m in z.namelist() if not m.endswith("/") and ".." not in m]
                nets = [m for m in members if m.endswith(".net.xml")]
                rous = [m for m in members if m.endswith(".rou.xml")]
                if len(nets) != 1:
                    raise HTTPException(422, "The zip must contain exactly one .net.xml file.")
                net = d / "net.net.xml"
                net.write_bytes(z.read(nets[0]))
                if rous:
                    routes = d / "routes.rou.xml"
                    routes.write_bytes(z.read(rous[0]))
        else:
            net = d / "net.net.xml"
            net.write_bytes(body)
        return _import_errors(lambda: importer.import_sumo(net, name, routes, trips))
    finally:
        shutil.rmtree(d, ignore_errors=True)


@app.delete("/api/networks/{nid}")
def delete_network(nid: str):
    try:
        _import_errors(lambda: importer.delete_network(nid))
    except KeyError as e:
        _nf(e)
    return dict(ok=True)


# ---------- scenarios ----------
class NewScenario(BaseModel):
    base_network: str
    name: str = "Untitled scenario"


class ScenarioUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
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
    data = {k: v for k, v in s.model_dump().items() if k not in ("id", "created", "parent_id", "baseline")}
    if s.baseline:
        data["description"] = ""             # the baseline's description describes the baseline only
    c = Scenario(**data, parent_id=s.id)      # a copy is never the network's "as it is" scenario
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


@app.get("/api/scenarios/{sid}/flyover-options")
def flyover_options(sid: str, node: str):
    """Roads that can be carried straight over this junction on a flyover."""
    from . import flyover
    s = _get(sid)
    import sumolib
    net = sumolib.net.readNet(str(catalog.ensure_network(s.base_network) / "net.net.xml"))
    if not net.hasNode(node):
        raise HTTPException(404, f"Junction '{node}' is not in this network.")
    existing = [e.model_dump() for e in s.edits if e.type == "add_flyover" and e.node == node]
    return dict(node=node, options=flyover.through_options(net, node), existing=existing)


@app.get("/api/scenarios/{sid}/geometry")
def scenario_geometry(sid: str):
    s = _get(sid)
    net = _built_net(s)
    g = geometry.network_geojson(str(net), net.stat().st_mtime)
    g = dict(g, features=[dict(f, properties=dict(f["properties"])) for f in g["features"]])  # don't touch the cache
    names.label_edges(g["features"], s.base_network)
    edited = {}
    for e in s.edits:
        for key in ("edge", "from_edge", "node"):
            if hasattr(e, key):
                edited.setdefault(getattr(e, key), []).append(e.type)
        if e.type == "add_flyover":
            for k in range(2 if e.both_ways else 1):
                edited.setdefault(f"{e.node}_flyover_{k}", []).append(e.type)
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
    depart_jitter_s: float = Field(0, ge=0, le=1800)   # vary trip start times by up to ± this many seconds


@app.post("/api/scenarios/{sid}/runs")
def start_run(sid: str, body: RunRequest):
    s = _get(sid)
    _check(s)
    seeds = list(range(1, body.seeds + 1)) if isinstance(body.seeds, int) else body.seeds
    if not 1 <= len(seeds) <= 50:
        raise HTTPException(422, "Use between 1 and 50 seeds.")
    return jm().submit(s, seeds, body.depart_jitter_s)


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


# ---------- simulations: reference + alternatives with the same seeds ----------
class SimulationRequest(BaseModel):
    reference: str                                   # scenario id
    alternatives: List[str] = Field(min_length=1, max_length=8)
    seeds: Union[int, List[int]] = config.DEFAULT_SEEDS
    depart_jitter_s: float = Field(0, ge=0, le=1800)
    name: Optional[str] = None


@app.post("/api/simulations")
def create_simulation(body: SimulationRequest):
    ref = _get(body.reference)
    alts = [_get(a) for a in body.alternatives]
    if any(a.base_network != ref.base_network for a in alts):
        raise HTTPException(422, "All scenarios in a simulation must use the same network.")
    if body.reference in body.alternatives:
        raise HTTPException(422, "The reference cannot also be an alternative.")
    if any(a.calibration != ref.calibration for a in alts):
        raise HTTPException(422, "These scenarios use different traffic demand (traffic-count calibration). Give them "
                                 "the same calibration, or none, so the comparison shows only the effect of the changes.")
    seeds = list(range(1, body.seeds + 1)) if isinstance(body.seeds, int) else body.seeds
    if not 1 <= len(seeds) <= 50:
        raise HTTPException(422, "Use between 1 and 50 seeds.")
    for s in [ref, *alts]:
        _check(s)
    jr = jm().submit(ref, seeds, body.depart_jitter_s)
    out = []
    for a in alts:
        j = jm().submit(a, seeds, body.depart_jitter_s)
        out.append(dict(scenario_id=a.id, scenario_name=a.name, run_id=j["run_id"]))
    name = body.name or (alts[0].name if len(alts) == 1 else f"{len(alts)} scenarios") + f" vs {ref.name}"
    return _sim_status(simulations.new(name, ref.base_network, dict(scenario_id=ref.id, scenario_name=ref.name,
                                                                    run_id=jr["run_id"]), out, seeds, body.depart_jitter_s))


def _sim_status(sim: dict) -> dict:
    def st(rid):
        try:
            return jm().status(rid)
        except KeyError:
            return dict(id=rid, run_id=rid, state="missing", done=0, total=len(sim["seeds"]), message="", warnings=[], error="Run not found")
    sim = dict(sim)
    sim["reference"] = dict(sim["reference"], job=st(sim["reference"]["run_id"]))
    sim["alternatives"] = [dict(a, job=st(a["run_id"])) for a in sim["alternatives"]]
    states = [sim["reference"]["job"]["state"]] + [a["job"]["state"] for a in sim["alternatives"]]
    sim["state"] = ("running" if any(x in ("queued", "building", "running") for x in states) else
                    "failed" if "failed" in states else "cancelled" if "cancelled" in states else
                    "missing" if "missing" in states else "done")
    return sim


@app.get("/api/simulations")
def list_simulations(network: Optional[str] = None):
    return [_sim_status(s) for s in simulations.list_all() if not network or s["network"] == network]


def _sim_summary(sim: dict) -> dict:
    """Headline numbers of a finished simulation: per tested scenario, the change in travel time on the
    same trips against the reference. Runs never change once done, so this is computed once and cached."""
    cached = simulations.summary(sim["id"])
    if cached is not None:
        return cached
    ref = jobs.load_run(sim["reference"]["run_id"])
    alts = []
    for a in sim["alternatives"]:
        r = jobs.load_run(a["run_id"])
        c = analysis.compare(ref["seed_results"], r["seed_results"], ref["seeds"], r["seeds"])
        k = c["kpis"].get("matched_travel_time_s") or c["kpis"].get("mean_travel_time_s") or {}
        tele = c["kpis"].get("teleported_trips") or {}
        alts.append(dict(scenario_id=a["scenario_id"], scenario_name=a["scenario_name"], run_id=a["run_id"],
                         controller=r["scenario"].get("controller"), edits=len(r["scenario"].get("edits", [])),
                         before_s=k.get("before"), after_s=k.get("after"), diff_s=k.get("diff"),
                         pct=k.get("pct_change"), verdict=k.get("verdict"), confidence=k.get("confidence"),
                         better=round((k.get("share_seeds_better") or 0) * (k.get("n") or 0)), n=k.get("n"),
                         teleports_before=tele.get("before"), teleports_after=tele.get("after")))
    out = dict(id=sim["id"], alternatives=alts, versions=ref.get("versions"),
               started=ref.get("started"), finished=max([jobs.load_run(a["run_id"]).get("finished") or 0
                                                         for a in sim["alternatives"]] + [ref.get("finished") or 0]))
    simulations.save_summary(sim["id"], out)
    return out


@app.get("/api/results")
def results_library(network: Optional[str] = None):
    """Every finished simulation with its headline result, newest first."""
    out = []
    for s in simulations.list_all():
        if network and s["network"] != network:
            continue
        st = _sim_status(s)
        if st["state"] != "done":
            continue
        try:
            summ = _sim_summary(s)
        except (KeyError, FileNotFoundError):
            continue
        out.append(dict(id=s["id"], name=s["name"], network=s["network"], created=s["created"], seeds=s["seeds"],
                        depart_jitter_s=s.get("depart_jitter_s", 0), rerun_of=s.get("rerun_of"),
                        reference_name=s["reference"]["scenario_name"], **{k: summ[k] for k in ("alternatives", "versions", "started", "finished")}))
    return out


@app.get("/api/simulations/{sid}")
def get_simulation(sid: str):
    try:
        return _sim_status(simulations.load(sid))
    except KeyError as e:
        _nf(e)


@app.post("/api/simulations/{sid}/cancel")
def cancel_simulation(sid: str):
    try:
        sim = simulations.load(sid)
    except KeyError as e:
        _nf(e)
    for rid in [sim["reference"]["run_id"]] + [a["run_id"] for a in sim["alternatives"]]:
        try:
            jm().cancel(rid)
        except KeyError:
            pass
    return _sim_status(sim)


@app.post("/api/simulations/{sid}/rerun")
def rerun_simulation(sid: str):
    """Run the same scenario versions again (from the snapshots stored with each run), same seeds and
    variation, to check that results reproduce. Later edits to the scenarios do not affect it."""
    try:
        sim = simulations.load(sid)
        snaps = [Scenario.model_validate(jobs.load_run(p["run_id"])["scenario"])
                 for p in [sim["reference"], *sim["alternatives"]]]
    except KeyError as e:
        _nf(e)
    jit = sim.get("depart_jitter_s", 0)
    parts = []
    for p, snap in zip([sim["reference"], *sim["alternatives"]], snaps):
        j = jm().submit(snap, sim["seeds"], jit)
        parts.append(dict(scenario_id=p["scenario_id"], scenario_name=p["scenario_name"], run_id=j["run_id"]))
    new = simulations.new(f"{sim['name']} (run again)", sim["network"], parts[0], parts[1:], sim["seeds"], jit)
    new["rerun_of"] = sid
    return _sim_status(simulations.save(new))


@app.delete("/api/simulations/{sid}")
def delete_simulation(sid: str):
    simulations.delete(sid)
    return dict(ok=True)


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
                   depart_jitter_s=b.get("depart_jitter_s", 0),
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


# ---------- live simulation ----------
# Local execution: sessions run in this process (LiveManager). Queue execution: a worker runs them; the session
# is the document "live/<id>.json", frames come from the live_frames table and controls go through the job queue.
LIVE = live.LiveManager()
LIVE_DIR = live.LIVE_DIR


atexit.register(LIVE.stop_all)        # stop SUMO processes with the server


def _live_info(s: "live.Session") -> dict:
    f = s.frame or {}
    meta = {k: v for k, v in s.meta.items() if k not in ("net_file", "net_mtime")}
    return dict(id=s.id, config=s.cfg.model_dump(), **meta, state=("failed" if s.error else f.get("state", "starting")),
                error=s.error, t=f.get("t"), run=s.run)


def _remote_live_info(doc: dict) -> dict:
    row = jobqueue.live_frame(doc["id"])
    run, frame, error = row if row else (0, None, "The live simulation has ended.")
    job = jobqueue.get(doc["id"])
    if job and job["state"] == "interrupted" and not error:
        error = "The live simulation stopped because its worker restarted. Start it again."
    f = frame or {}
    return dict(id=doc["id"], config=doc["cfg"], **doc["meta"], state="failed" if error else f.get("state", "starting"),
                error=error, t=f.get("t"), run=run)


@app.post("/api/live")
def live_start(cfg: live.LiveConfig, request: Request):
    s = _get(cfg.scenario_id)
    rl_model = None
    if cfg.controller == "rl":
        if not cfg.rl_agent:
            raise HTTPException(422, "Choose a trained agent.")
        rl_model = str(_model_path(cfg.rl_agent, cfg.rl_checkpoint))
        s = s.model_copy(update=dict(controller="fixed"))
    elif cfg.controller == "external":
        if not cfg.external:
            raise HTTPException(422, "Give the external controller's address.")
        try:
            external.check_url(cfg.external.url)
        except external.ControllerError as e:
            raise HTTPException(422, str(e))
        s = s.model_copy(update=dict(controller="fixed"))
    elif cfg.controller:
        s = s.model_copy(update=dict(controller=cfg.controller))
    sid = uuid.uuid4().hex[:10]
    sid_dir = LIVE_DIR / sid
    try:
        job, meta = live.prepare(s, cfg, sid_dir, rl_model)
    except (build.EditError, live.LiveError) as e:
        raise HTTPException(422, str(e))
    meta.update(rl_agent=(_agent_info(cfg.rl_agent)["config"]["name"] if rl_model else None),
                external=cfg.external.name if cfg.controller == "external" else None)
    if not jobqueue.remote():
        return _live_info(LIVE.create(cfg, job, meta, sid))
    shutil.rmtree(sid_dir, ignore_errors=True)              # the worker builds its own copy
    owner = (getattr(request.state, "user", None) or {}).get("email")
    mine = [i for i in jobqueue.active("live") if (store.docs.read(f"live/{i}.json") or {}).get("owner") == owner]
    for old in mine[:max(0, len(mine) - live.LiveManager.MAX + 1)]:
        _remote_live_stop(old)                              # starting another stops this person's oldest
    doc = dict(id=sid, cfg=cfg.model_dump(mode="json"), scenario=s.model_dump(mode="json"), created=time.time(),
               owner=owner, meta={k: v for k, v in meta.items() if k not in ("net_file", "net_mtime")})
    store.docs.write(f"live/{sid}.json", doc)
    jobqueue.live_open(sid)
    jobqueue.enqueue("live", sid, {})
    return _remote_live_info(doc)


def _remote_live_stop(sid: str):
    if not jobqueue.cancel_queued(sid):
        jobqueue.command(sid, dict(action="stop"))
    jobqueue.live_close(sid)
    store.docs.delete(f"live/{sid}.json")


def _live(sid: str):
    """The session: a live.Session (local execution) or its document (queue execution)."""
    if jobqueue.remote():
        doc = store.docs.read(f"live/{sid}.json") if "/" not in sid else None
        if doc is None:
            raise HTTPException(404, f"live session '{sid}' not found")
        return doc
    try:
        return LIVE.get(sid)
    except KeyError as e:
        _nf(e)


def _live_net(sess) -> tuple:
    if isinstance(sess, dict):
        net = _built_net(Scenario.model_validate(sess["scenario"]))
        return str(net), net.stat().st_mtime, sess["meta"]["network"], sess["cfg"]["scenario_id"]
    return sess.meta["net_file"], sess.meta["net_mtime"], sess.meta["network"], sess.cfg.scenario_id


@app.get("/api/live/{sid}")
def live_status(sid: str):
    s = _live(sid)
    return _remote_live_info(s) if isinstance(s, dict) else _live_info(s)


@app.get("/api/live/{sid}/static")
def live_static(sid: str):
    net_file, mtime, _, _ = _live_net(_live(sid))
    return geometry.live_static(net_file, mtime)


@app.get("/api/live/{sid}/geometry")
def live_geometry(sid: str):
    net_file, mtime, network, scenario_id = _live_net(_live(sid))
    g = geometry.network_geojson(net_file, mtime)
    g = dict(g, features=[dict(f, properties=dict(f["properties"])) for f in g["features"]])
    names.label_edges(g["features"], network)
    edited = {}
    try:
        for e in sc.load(scenario_id).edits:
            for key in ("edge", "from_edge", "node"):
                if hasattr(e, key):
                    edited.setdefault(getattr(e, key), []).append(e.type)
    except KeyError:
        pass
    return dict(g, edited=edited)


@app.get("/api/live/{sid}/frame")
def live_frame(sid: str, after: int = 0):
    s = _live(sid)
    if isinstance(s, dict):                    # wait up to a second for a newer frame from the worker
        t_end = time.monotonic() + 1.0
        while True:
            peek = jobqueue.live_peek(sid)
            if peek is None:
                raise HTTPException(404, f"live session '{sid}' not found")
            run, seq, error = peek
            if error:
                raise HTTPException(500, error)
            if seq > after or time.monotonic() >= t_end:
                break
            time.sleep(0.1)
        row = jobqueue.live_frame(sid)
        frame = row[1] if row else None
        if frame is None:
            return dict(kind="frame", seq=0, state="starting", run=run)
        return dict(frame, run=run)
    f = s.wait_frame(after)
    if s.error:
        raise HTTPException(500, s.error)
    if f is None:
        return dict(kind="frame", seq=0, state="starting", run=s.run)
    return dict(f, run=s.run)


class LiveControl(BaseModel):
    action: Literal["pause", "resume", "speed", "reset", "watch"]
    speed: Optional[float] = Field(None, ge=0, le=1000)
    watch: Optional[dict] = None


@app.post("/api/live/{sid}/control")
def live_control(sid: str, c: LiveControl):
    s = _live(sid)
    if c.action == "speed" and c.speed is None:
        raise HTTPException(422, "Give a speed.")
    if isinstance(s, dict):
        before = jobqueue.live_peek(sid)
        jobqueue.command(sid, c.model_dump(exclude_none=True))
        if c.action == "reset" and before:          # answer once the worker has restarted it, as in local mode
            t_end = time.monotonic() + 10
            while time.monotonic() < t_end:
                now = jobqueue.live_peek(sid)
                if not now or now[0] != before[0] or now[2]:
                    break
                time.sleep(0.1)
        return _remote_live_info(s)
    if c.action == "reset":
        s.reset()                 # same settings and seed: the run replays identically
        return _live_info(s)
    s.send(c.model_dump(exclude_none=True))
    return _live_info(s)


@app.delete("/api/live/{sid}")
def live_stop(sid: str):
    if jobqueue.remote():
        _remote_live_stop(sid)
    else:
        LIVE.remove(sid)
    return dict(ok=True)


# ---------- research mode ----------
from .rl import train as rl_train            # noqa: E402
from . import research                        # noqa: E402
from fastapi.responses import Response         # noqa: E402

TRAIN = rl_train.TrainingManager()
atexit.register(TRAIN.stop_all)


def _agent_info(aid):
    try:
        return TRAIN.info(aid)
    except KeyError as e:
        _nf(e)


def _model_path(aid, which="final"):
    try:
        return TRAIN.model_path(aid, which)
    except KeyError as e:
        raise HTTPException(404, str(e))


BENCH = research.BenchmarkManager(_model_path, _agent_info)


@app.get("/api/research/defaults")
def research_defaults():
    return dict(agent=rl_train.AgentCfg(scenario_id="").model_dump(), measures=research.MEASURES)


@app.post("/api/research/agents")
def train_agent(cfg: rl_train.AgentCfg):
    _get(cfg.scenario_id)
    try:
        return TRAIN.create(cfg)
    except build.EditError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.get("/api/research/agents")
def list_agents():
    return TRAIN.list()


@app.get("/api/research/agents/{aid}")
def get_agent(aid: str):
    return _agent_info(aid)


@app.get("/api/research/agents/{aid}/log")
def agent_log(aid: str):
    _agent_info(aid)
    return TRAIN.log(aid)


class TrainControl(BaseModel):
    action: Literal["pause", "resume", "stop"]


@app.post("/api/research/agents/{aid}/control")
def agent_control(aid: str, c: TrainControl):
    _agent_info(aid)
    try:
        TRAIN.control(aid, c.action)
    except KeyError as e:
        raise HTTPException(409, str(e))
    return _agent_info(aid)


@app.delete("/api/research/agents/{aid}")
def delete_agent(aid: str):
    _agent_info(aid)
    try:
        TRAIN.delete(aid)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return dict(ok=True)


@app.get("/api/research/agents/{aid}/model")
def agent_model(aid: str, which: str = "final"):
    p = _model_path(aid, which)
    name = _agent_info(aid)["config"]["name"].replace(" ", "_")
    return FileResponse(p, filename=f"{name}_{aid}_{which.replace('.npz', '')}.npz")


@app.get("/api/research/agents/{aid}/export")
def agent_export(aid: str):
    """A zip with everything to reuse or retrain the agent: config, manifest, log (JSONL and CSV), weights."""
    import zipfile, csv as _csv
    info = _agent_info(aid)
    buf = io.BytesIO()
    rows = TRAIN.log(aid)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, key in (("config.json", "config"), ("manifest.json", "manifest"), ("status.json", "status")):
            z.writestr(name, json.dumps(info[key], indent=1))
        if rows:
            z.writestr("log.jsonl", "".join(json.dumps(r) + "\n" for r in rows))
        for which in ("final", "best"):
            try:
                z.write(TRAIN.model_path(aid, which), f"{which}.npz")
            except KeyError:
                pass
        for ck in info["checkpoints"]:
            try:
                z.write(TRAIN.model_path(aid, ck), f"checkpoints/{ck}")
            except KeyError:
                pass
        if rows:
            sio = io.StringIO()
            cols = list(dict.fromkeys(k for r in rows for k in r))   # evaluation columns appear only on evaluated episodes
            w = _csv.DictWriter(sio, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
            z.writestr("log.csv", sio.getvalue())
    name = info["config"]["name"].replace(" ", "_")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}_{aid}.zip"'})


CAL = calibrate.Manager()


@app.get("/api/scenarios/{sid}/counts-template.csv")
def counts_template(sid: str):
    """Every road open to cars, with its readable name and an empty count column to fill in."""
    s = _get(sid)
    net = _built_net(s)
    g = geometry.network_geojson(str(net), net.stat().st_mtime)
    feats = [dict(f, properties=dict(f["properties"])) for f in g["features"] if f["properties"].get("kind") == "edge"]
    names.label_edges(feats, s.base_network)
    import sumolib
    sn = sumolib.net.readNet(str(net))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["road", "name", "lanes", "vehicles"])
    for f in sorted(feats, key=lambda f: f["properties"].get("label", "")):
        p = f["properties"]
        if sn.hasEdge(p["id"]) and sn.getEdge(p["id"]).allows("passenger"):
            w.writerow([p["id"], p.get("label", ""), p.get("lanes", ""), ""])
    fname = re.sub(r"[^A-Za-z0-9_-]+", "_", s.name).strip("_") or "scenario"
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="counts_{fname}.csv"'})


class CalibrateBody(BaseModel):
    csv: str = Field(max_length=2_000_000)
    seed: int = Field(1, ge=1, le=1_000_000)


@app.post("/api/scenarios/{sid}/calibrations")
def start_calibration(sid: str, body: CalibrateBody):
    s = _get(sid)
    import sumolib
    net = sumolib.net.readNet(str(_built_net(s.model_copy(update=dict(calibration=None)))))
    try:
        counts, problems = calibrate.parse_csv(body.csv, net)
    except calibrate.CalibrationError as e:
        raise HTTPException(422, str(e))
    return CAL.start(s, counts, problems, body.seed)


@app.get("/api/scenarios/{sid}/calibrations")
def list_calibrations(sid: str):
    _get(sid)
    return CAL.list(sid)


@app.get("/api/calibrations/{cid}")
def get_calibration(cid: str):
    try:
        return CAL.info(cid)
    except KeyError as e:
        _nf(e)


class UseCalibration(BaseModel):
    calibration: Optional[str] = None      # None: back to the network's own demand


@app.put("/api/scenarios/{sid}/calibration")
def use_calibration(sid: str, body: UseCalibration):
    s = _get(sid)
    if body.calibration:
        try:
            info = CAL.info(body.calibration)
        except KeyError as e:
            _nf(e)
        if info["network"] != s.base_network or info["status"].get("state") != "done":
            raise HTTPException(422, "Use a finished calibration made on this network.")
    return sc.save(s.model_copy(update=dict(calibration=body.calibration)))


@app.post("/api/scenarios/{sid}/rl-env")
def export_rl_env(sid: str, cfg: envexport.EnvCfg):
    """The scenario as a self-contained multi-agent RL environment (zip), for training with your own code."""
    s = _get(sid)
    work = config.WORKSPACE_DIR / "exports" / uuid.uuid4().hex[:10]
    work.mkdir(parents=True, exist_ok=True)
    try:
        data = envexport.export(s, cfg, work)
    except (ValueError, build.EditError) as e:
        raise HTTPException(422, str(e))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    fname = re.sub(r"[^A-Za-z0-9_-]+", "_", s.name).strip("_") or "scenario"
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="junction_env_{fname}.zip"'})


class ControllerTest(BaseModel):
    url: str
    timeout_s: float = Field(2.0, gt=0, le=30)


@app.post("/api/controllers/test")
def test_controller(t: ControllerTest):
    """Send one example request to an external controller and check its answer."""
    try:
        return external.test(t.url, t.timeout_s)
    except external.ControllerError as e:
        raise HTTPException(422, str(e))


@app.get("/api/controllers/example.py")
def controller_example():
    f = config.BACKEND_DIR / "examples" / "external_controller.py"
    return Response(f.read_text(), media_type="text/x-python",
                    headers={"Content-Disposition": 'attachment; filename="external_controller.py"'})


@app.get("/api/controllers/protocol")
def controller_protocol():
    return dict(protocol=external.PROTOCOL, allowed_hosts=sorted(external.allowed_hosts()),
                description=external.__doc__)


@app.post("/api/research/benchmarks")
def create_benchmark(cfg: research.BenchCfg):
    for i in [cfg.scenario_id, *cfg.heldout_ids]:
        _get(i)
    try:
        return BENCH.create(cfg)
    except (ValueError, build.EditError) as e:
        raise HTTPException(422, str(e))


@app.get("/api/research/benchmarks")
def list_benchmarks():
    return BENCH.list()


def _bench(bid):
    try:
        return BENCH.info(bid)
    except KeyError as e:
        _nf(e)


@app.get("/api/research/benchmarks/{bid}")
def get_benchmark(bid: str):
    return _bench(bid)


@app.get("/api/research/benchmarks/{bid}/stats")
def benchmark_stats(bid: str):
    _bench(bid)
    return BENCH.stats(bid)


@app.post("/api/research/benchmarks/{bid}/cancel")
def cancel_benchmark(bid: str):
    _bench(bid)
    BENCH.cancel(bid)
    return _bench(bid)


@app.delete("/api/research/benchmarks/{bid}")
def delete_benchmark(bid: str):
    info = _bench(bid)
    if info["status"].get("state") in ("running", "queued"):
        raise HTTPException(409, "Cancel the benchmark before deleting it.")
    BENCH.delete(bid)
    return dict(ok=True)


@app.get("/api/research/benchmarks/{bid}/export.csv")
def benchmark_csv(bid: str):
    _bench(bid)
    return Response(BENCH.csv(bid), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="benchmark_{bid}.csv"'})


@app.get("/api/research/benchmarks/{bid}/export.json")
def benchmark_json(bid: str):
    info = _bench(bid)
    body = dict(benchmark=info, statistics=BENCH.stats(bid),
                runs=[dict({k: v for k, v in c.items() if k != "seed_results"},
                           seeds=[dict(seed=r["seed"], kpi=r["kpi"], wall_s=r.get("wall_s")) for r in c["seed_results"]])
                      for c in BENCH.results(bid)])
    return Response(json.dumps(body, indent=1), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="benchmark_{bid}.json"'})


# ---------- static frontend (production build) ----------
_dist = Path(os.environ.get("TRAFFICSIM_FRONTEND", config.BACKEND_DIR.parent / "frontend" / "dist"))
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = _dist / path
        return FileResponse(f if path and f.is_file() else _dist / "index.html")
