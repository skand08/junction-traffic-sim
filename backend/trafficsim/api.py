"""FastAPI app for the planner/student traffic simulator.

Run: uvicorn trafficsim.api:app --reload   (from the backend/ directory)
"""
import atexit
import os
import shutil
import json
import tempfile
import uuid
import threading
from pathlib import Path
from typing import List, Literal, Optional, Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis, build, catalog, config, geometry, importer, jobs, live, names, runner, simulations, scenario as sc
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


SUMMARY_DIR = simulations.SIM_DIR / "summaries"     # one cached headline per finished simulation


def _sim_summary(sim: dict) -> dict:
    """Headline numbers of a finished simulation: per tested scenario, the change in travel time on the
    same trips against the reference. Runs never change once done, so this is computed once and cached."""
    SUMMARY_DIR.mkdir(parents=True, exist_ok=True)
    f = SUMMARY_DIR / f"{sim['id']}.json"
    if f.exists():
        return json.loads(f.read_text())
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
    f.write_text(json.dumps(out))
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
LIVE = live.LiveManager()
LIVE_DIR = config.WORKSPACE_DIR / "live"
LIVE_DRAIN_S = 900          # simulated time after the demand window for trips to finish


atexit.register(LIVE.stop_all)        # stop SUMO processes with the server


def _live_info(s: "live.Session") -> dict:
    f = s.frame or {}
    meta = {k: v for k, v in s.meta.items() if k not in ("net_file", "net_mtime")}
    return dict(id=s.id, config=s.cfg.model_dump(), **meta, state=("failed" if s.error else f.get("state", "starting")),
                error=s.error, t=f.get("t"), run=s.run)


@app.post("/api/live")
def live_start(cfg: live.LiveConfig):
    s = _get(cfg.scenario_id)
    if cfg.controller:
        s = s.model_copy(update=dict(controller=cfg.controller))
    sid_dir = LIVE_DIR / uuid.uuid4().hex[:10]
    sid_dir.mkdir(parents=True, exist_ok=True)
    try:
        b = build.build(s, sid_dir)
    except build.EditError as e:
        raise HTTPException(422, str(e))
    import sumolib
    net = sumolib.net.readNet(str(b.net_file))
    for r in cfg.routes:
        for e in (r.from_edge, r.to_edge):
            if not net.hasEdge(e) or not net.getEdge(e).allows("passenger"):
                raise HTTPException(422, f"Road {e} is not open to cars in this scenario.")
        path, _ = net.getShortestPath(net.getEdge(r.from_edge), net.getEdge(r.to_edge), vClass="passenger")
        if path is None:
            raise HTTPException(422, "There is no route for cars between the chosen entry and destination.")
    window_end = b.begin + cfg.duration_min * 60
    routes = live.live_demand(b.demand_file, sid_dir, cfg, b.begin, b.end, net)
    job = dict(net_file=str(b.net_file), routes=str(routes), tls_additional=str(b.tls_additional) if b.tls_additional else None,
               begin=b.begin, window_end=window_end, stop=window_end + LIVE_DRAIN_S,
               scale=round(live.INTENSITY[cfg.intensity] * s.demand_scale, 3), seed=cfg.seed,
               controller=s.controller, speed=1.0)
    meta = dict(scenario_name=s.name, network=s.base_network, controller=s.controller, begin=b.begin,
                window_end=window_end, stop=window_end + LIVE_DRAIN_S, warnings=b.warnings,
                net_mtime=b.net_file.stat().st_mtime, net_file=str(b.net_file))
    sess = LIVE.create(cfg, job, meta)
    return _live_info(sess)


def _live(sid: str) -> "live.Session":
    try:
        return LIVE.get(sid)
    except KeyError as e:
        _nf(e)


@app.get("/api/live/{sid}")
def live_status(sid: str):
    return _live_info(_live(sid))


@app.get("/api/live/{sid}/static")
def live_static(sid: str):
    s = _live(sid)
    return geometry.live_static(s.meta["net_file"], s.meta["net_mtime"])


@app.get("/api/live/{sid}/geometry")
def live_geometry(sid: str):
    s = _live(sid)
    g = geometry.network_geojson(s.meta["net_file"], s.meta["net_mtime"])
    g = dict(g, features=[dict(f, properties=dict(f["properties"])) for f in g["features"]])
    names.label_edges(g["features"], s.meta["network"])
    sc_ = sc.load(s.cfg.scenario_id)
    edited = {}
    for e in sc_.edits:
        for key in ("edge", "from_edge", "node"):
            if hasattr(e, key):
                edited.setdefault(getattr(e, key), []).append(e.type)
    return dict(g, edited=edited)


@app.get("/api/live/{sid}/frame")
def live_frame(sid: str, after: int = 0):
    s = _live(sid)
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
    if c.action == "reset":
        s.reset()                 # same settings and seed: the run replays identically
        return _live_info(s)
    if c.action == "speed" and c.speed is None:
        raise HTTPException(422, "Give a speed.")
    s.send(c.model_dump(exclude_none=True))
    return _live_info(s)


@app.delete("/api/live/{sid}")
def live_stop(sid: str):
    LIVE.remove(sid)
    return dict(ok=True)


# ---------- static frontend (production build) ----------
_dist = Path(os.environ.get("TRAFFICSIM_FRONTEND", config.BACKEND_DIR.parent / "frontend" / "dist"))
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = _dist / path
        return FileResponse(f if path and f.is_file() else _dist / "index.html")
