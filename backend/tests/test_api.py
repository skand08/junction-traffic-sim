"""End-to-end API test of the planner flow: build, edit, run, compare, export/import."""
import os
import tempfile
import time

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim.api import app  # noqa: E402

c = TestClient(app)
SEEDS = 4


def wait(job_id, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(f"/api/jobs/{job_id}").json()
        if j["state"] in ("done", "failed", "cancelled"):
            return j
        time.sleep(0.5)
    raise TimeoutError(job_id)


def test_planner_flow():
    nets = c.get("/api/networks").json()
    assert {n["id"] for n in nets} >= {"grid3x3", "ingolstadt7", "ingolstadt21"}

    base = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="Base")).json()
    g = c.get(f"/api/scenarios/{base['id']}/geometry").json()
    edges = [f for f in g["features"] if f["properties"]["kind"] == "edge"]
    sigs = [f for f in g["features"] if f["properties"]["kind"] == "signal"]
    assert edges and sigs and g["geo"] is False

    after = c.post(f"/api/scenarios/{base['id']}/copy").json()
    assert after["parent_id"] == base["id"]
    progs = c.get(f"/api/scenarios/{after['id']}/signals").json()
    tid, prog = next(iter(progs.items()))
    target = edges[0]["properties"]["id"]
    r = c.put(f"/api/scenarios/{after['id']}", json=dict(
        controller="actuated",
        edits=[dict(type="set_lanes", edge=target, lanes=3),
               dict(type="retime_signal", tls=tid, durations=[p["duration"] for p in prog["phases"]])]))
    assert r.status_code == 200, r.text

    bad = c.put(f"/api/scenarios/{after['id']}", json=dict(edits=[dict(type="set_lanes", edge="nope", lanes=2)]))
    assert bad.status_code == 422 and "does not exist" in bad.json()["detail"]

    j1 = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=SEEDS)).json()
    j2 = c.post(f"/api/scenarios/{after['id']}/runs", json=dict(seeds=SEEDS)).json()
    s1, s2 = wait(j1["id"]), wait(j2["id"])
    assert s1["state"] == "done" and s2["state"] == "done", (s1, s2)

    run1 = c.get(f"/api/runs/{j1['id']}").json()
    assert run1["aggregate"]["kpis"]["mean_travel_time_s"]["mean"] > 0
    assert len(run1["aggregate"]["edges"]) > 0

    cmp = c.get(f"/api/compare?before={j1['id']}&after={j2['id']}").json()
    assert cmp["paired_seeds"] == list(range(1, SEEDS + 1))
    assert "travel time" in cmp["headline"]
    assert cmp["kpis"]["mean_travel_time_s"]["confidence"] in ("high", "medium", "low")

    # reproducibility: same scenario + seeds -> identical KPIs
    j3 = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=SEEDS)).json()
    wait(j3["id"])
    run3 = c.get(f"/api/runs/{j3['id']}").json()
    assert run3["aggregate"]["kpis"]["mean_travel_time_s"]["values"] == \
        run1["aggregate"]["kpis"]["mean_travel_time_s"]["values"]

    # bundle round trip
    bundle = c.get(f"/api/scenarios/{after['id']}/bundle").json()
    imp = c.post("/api/bundles", json=bundle).json()
    assert imp["edits"] == c.get(f"/api/scenarios/{after['id']}").json()["scenario"]["edits"]


def test_ui_backend_additions():
    h = c.get("/api/health").json()
    assert h["versions"]["sumo"] and h["versions"]["app"] and h["settings"]["time_to_teleport_s"] > 0

    base = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="Base")).json()
    g = c.get(f"/api/scenarios/{base['id']}/geometry").json()
    e = next(f["properties"] for f in g["features"] if f["properties"]["kind"] == "edge")
    assert e["label"] and e["heading"]
    progs = c.get(f"/api/scenarios/{base['id']}/signals").json()
    p = next(iter(progs.values()))
    assert len(p["link_info"]) == p["links"] and p["link_info"][0]["turn"] in ("ahead", "left", "right", "u-turn")

    # cancel: a long run is stopped, its processes end and the job reports "cancelled"
    j = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=30)).json()
    time.sleep(1.5)
    r = c.post(f"/api/jobs/{j['id']}/cancel")
    assert r.status_code == 200
    s = wait(j["id"], timeout=120)
    assert s["state"] == "cancelled" and s["done"] < 30
    assert c.get(f"/api/runs/{j['id']}").json()["state"] == "cancelled"
    assert c.post("/api/jobs/nope/cancel").status_code == 404

    # finished run records versions, build counts and data-quality fields
    j2 = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=2)).json()
    assert wait(j2["id"])["state"] == "done"
    run = c.get(f"/api/runs/{j2['id']}").json()
    assert run["versions"]["sumo"] and run["build"]["total_trips"] > 0
    assert {"late_departures", "removed", "not_inserted"} <= set(run["aggregate"]["kpis"])


def test_experiment_bundle_and_history():
    base = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="Base")).json()
    prop = c.post(f"/api/scenarios/{base['id']}/copy?name=Proposal").json()
    c.put(f"/api/scenarios/{prop['id']}", json=dict(controller="actuated"))
    ja = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=[3, 4])).json()
    jb = c.post(f"/api/scenarios/{prop['id']}/runs", json=dict(seeds=[3, 4])).json()
    assert wait(ja["id"])["state"] == "done" and wait(jb["id"])["state"] == "done"
    runs = {r["id"]: r for r in c.get("/api/runs").json()}
    assert runs[jb["id"]]["parent_id"] == base["id"] and runs[jb["id"]]["versions"]["sumo"]
    b = c.get(f"/api/scenarios/{prop['id']}/bundle?before={ja['id']}&after={jb['id']}").json()
    assert b["experiment"]["seeds"] == [3, 4] and b["run"]["seeds"] == [3, 4]
    assert b["scenario"]["controller"] == "actuated" and b["app"]["version"]
    assert len(b["experiment"]["values"]["mean_travel_time_s"]["after"]) == 2
    # importing the bundle and re-running the same seeds reproduces the values exactly
    imp = c.post("/api/bundles", json=b).json()
    jr = c.post(f"/api/scenarios/{imp['id']}/runs", json=dict(seeds=b["experiment"]["seeds"])).json()
    assert wait(jr["id"])["state"] == "done"
    rr = c.get(f"/api/runs/{jr['id']}").json()
    assert rr["aggregate"]["kpis"]["mean_travel_time_s"]["values"] == b["experiment"]["values"]["mean_travel_time_s"]["after"]


def test_measurement_counts_queue_to_enter_and_flags_teleports(tmp_path):
    """Travel time runs from the planned start (depart - departDelay); teleported trips leave the average."""
    from trafficsim import runner
    out = tmp_path
    (out / "tripinfo.xml").write_text("""<tripinfos>
      <tripinfo id="a" depart="10" departDelay="0" arrival="110" duration="100" timeLoss="20" waitingTime="5" waitingCount="1" vaporized=""/>
      <tripinfo id="b" depart="3700" departDelay="200" arrival="3800" duration="100" timeLoss="20" waitingTime="5" waitingCount="1" vaporized=""/>
      <tripinfo id="c" depart="20" departDelay="0" arrival="400" duration="380" timeLoss="300" waitingTime="290" waitingCount="3" vaporized=""/>
      <tripinfo id="d" depart="30" departDelay="0" arrival="-1" duration="-1" timeLoss="50" waitingTime="0" waitingCount="0" vaporized="end"/>
      <tripinfo id="e" depart="3700" departDelay="10" arrival="3800" duration="100" timeLoss="0" waitingTime="0" waitingCount="0" vaporized=""/>
    </tripinfos>""")
    (out / "sumo.log").write_text("Warning: Teleporting vehicle 'c'; waited too long (jam), lane='x_0', time=300.00.\n")
    (out / "stats.xml").write_text('<statistics><vehicles loaded="5" inserted="5" running="0" waiting="0"/><teleports total="1"/></statistics>')
    (out / "edges.xml").write_text("<meandata/>")
    r = runner._parse(dict(begin=0, end=3600), out)
    k = r["kpi"]
    # a (100 s) and b (planned 3500, so in the hour; 100 + 200 s queue) count; c teleported; d unfinished;
    # e is planned at 3690, after the hour, so it is not part of the demand hour at all
    assert k["completed_trips"] == 2 and k["mean_travel_time_s"] == 200 and k["mean_delay_s"] == 120
    assert k["teleported_trips"] == 1 and k["unfinished_trips"] == 1 and k["late_departures"] == 1
    assert r["trips"]["c"][2] == runner.TELEPORTED and "e" not in r["trips"]


def test_matched_trips_compare_like_for_like():
    """Trips missing or not normal in either option are left out of both averages."""
    from trafficsim import analysis

    def seed(s, trips, kpi_tt):
        return dict(seed=s, wall_s=1, edges={}, trips=trips,
                    kpi=dict(mean_travel_time_s=kpi_tt, mean_delay_s=0, completed_trips=len(trips)))
    a = [seed(1, {"x": [100, 10, 0], "y": [200, 20, 0], "z": [300, 30, 0]}, 200)]
    # proposal: x faster, y teleported (status 1), z dropped by a closure (absent)
    b = [seed(1, {"x": [90, 5, 0], "y": [50, 5, 1]}, 90)]
    c = analysis.compare(a, b, [1], [1])
    k = c["kpis"]["matched_travel_time_s"]
    assert (k["before"], k["after"]) == (100, 90)          # only trip x is in both and normal
    assert c["matched"]["trips"] == 1 and abs(c["matched"]["share"] - 1 / 3) < 1e-9
    assert c["kpis"]["mean_travel_time_s"]["after"] == 90   # per-option average still reported
