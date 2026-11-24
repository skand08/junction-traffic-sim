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


def test_depart_jitter_is_seeded_sorted_and_in_window(tmp_path):
    from trafficsim import runner
    import xml.etree.ElementTree as ET
    src = tmp_path / "d.rou.xml"
    src.write_text('<routes><vType id="t"/>' + "".join(
        f'<trip id="v{i}" depart="{i * 10}" from="a" to="b"/>' for i in range(100)) + "</routes>")

    calls = [0]

    def departs(seed, j):
        calls[0] += 1
        out = tmp_path / f"s{seed}_{j}_{calls[0]}"
        out.mkdir()
        f = runner._demand_for_seed(dict(demand_file=str(src), depart_jitter_s=j, seed=seed, begin=0, end=990), out)
        root = ET.parse(f).getroot()
        assert root[0].tag == "vType"
        return [float(t.get("depart")) for t in root.iter("trip")]
    a, a_again, other = departs(1, 120), departs(1, 120), departs(2, 120)
    assert a == sorted(a) and min(a) >= 0 and max(a) <= 990
    assert a == a_again                      # same seed, same shifts: both options see the same traffic
    assert a != [i * 10 for i in range(100)] and a != other
    assert departs(4, 0) == [i * 10 for i in range(100)]


def test_run_records_depart_jitter():
    base = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="Base")).json()
    j = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=[1, 2], depart_jitter_s=120)).json()
    assert wait(j["id"])["state"] == "done"
    r = c.get(f"/api/runs/{j['id']}").json()
    assert r["depart_jitter_s"] == 120
    j2 = c.post(f"/api/scenarios/{base['id']}/runs", json=dict(seeds=[1, 2], depart_jitter_s=120)).json()
    wait(j2["id"])
    r2 = c.get(f"/api/runs/{j2['id']}").json()
    assert r2["aggregate"]["kpis"]["mean_travel_time_s"]["values"] == r["aggregate"]["kpis"]["mean_travel_time_s"]["values"]
def test_retime_keeps_decimals_and_offset(tmp_path):
    from trafficsim import build
    assert build._num(31.5) == "31.5" and build._num(30.0) == "30" and build._num(12.345) == "12.3"
    base = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="Base")).json()
    progs = c.get(f"/api/scenarios/{base['id']}/signals").json()
    tid, prog = next(iter(progs.items()))
    durs = [p["duration"] + 0.5 for p in prog["phases"]]
    r = c.put(f"/api/scenarios/{base['id']}", json=dict(edits=[dict(type="retime_signal", tls=tid, durations=durs)]))
    assert r.status_code == 200
    from trafficsim import scenario as sc
    b = build.build(sc.load(base["id"]), tmp_path)
    xml = b.tls_additional.read_text()
    assert f'duration="{build._num(durs[0])}"' in xml and 'offset="0"' in xml


DATA = os.path.join(os.path.dirname(__file__), "data")


def test_network_library_import_scenarios_and_simulation():
    # import an OpenStreetMap file into the library
    body = open(os.path.join(DATA, "west-oakland.osm.bz2"), "rb").read()
    r = c.post("/api/networks/import/osm?name=West%20Oakland&trips=300", content=body)
    assert r.status_code == 200, r.text
    net = r.json()
    assert net["kind"] == "imported" and net["edges"] > 10 and net["trips"] == 300 and net["geo"]
    assert any(n["id"] == net["id"] for n in c.get("/api/networks").json())
    g = c.get(f"/api/networks/{net['id']}/geometry").json()
    named = [f["properties"]["name"] for f in g["features"] if f["properties"]["kind"] == "edge" and f["properties"]["name"]]
    assert named, "OSM street names should be kept"

    # the baseline scenario is created once and reused
    b1 = c.post(f"/api/networks/{net['id']}/baseline").json()
    b2 = c.post(f"/api/networks/{net['id']}/baseline").json()
    assert b1["id"] == b2["id"] and b1["baseline"] and b1["edits"] == []

    # two alternatives, simulated together against the baseline with the same seeds
    alt1 = c.post(f"/api/scenarios/{b1['id']}/copy?name=Actuated").json()
    assert alt1["baseline"] is False and alt1["description"] == "" and alt1["parent_id"] == b1["id"]
    c.put(f"/api/scenarios/{alt1['id']}", json=dict(controller="actuated", description="Actuated signals"))
    alt2 = c.post(f"/api/scenarios/{b1['id']}/copy?name=Busier").json()
    c.put(f"/api/scenarios/{alt2['id']}", json=dict(demand_scale=1.2))
    sim = c.post("/api/simulations", json=dict(reference=b1["id"], alternatives=[alt1["id"], alt2["id"]],
                                               seeds=2, depart_jitter_s=60)).json()
    assert len(sim["alternatives"]) == 2 and sim["network"] == net["id"]
    for _ in range(600):
        st = c.get(f"/api/simulations/{sim['id']}").json()
        if st["state"] != "running":
            break
        time.sleep(0.5)
    assert st["state"] == "done", st
    cmp = c.get(f"/api/compare?before={st['reference']['run_id']}&after={st['alternatives'][1]['run_id']}").json()
    assert cmp["kpis"]["matched_travel_time_s"]["n"] == 2
    assert any(s["id"] == sim["id"] for s in c.get(f"/api/simulations?network={net['id']}").json())

    # mixing networks is refused; imported networks can be deleted, built-in ones cannot
    other = c.post("/api/scenarios", json=dict(base_network="grid3x3", name="x")).json()
    assert c.post("/api/simulations", json=dict(reference=b1["id"], alternatives=[other["id"]], seeds=1)).status_code == 422
    assert c.delete("/api/networks/grid3x3").status_code == 422
    assert c.delete(f"/api/networks/{net['id']}").status_code == 200
    assert not any(n["id"] == net["id"] for n in c.get("/api/networks").json())


def test_sumo_network_upload():
    from trafficsim import catalog
    grid = catalog.ensure_network("grid3x3") / "net.net.xml"
    r = c.post("/api/networks/import/sumo?name=My%20grid&trips=200", content=grid.read_bytes())
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["edges"] == 48 and m["trips"] == 200 and m["geo"] is False
    assert c.post("/api/networks/import/sumo?name=bad", content=b"not a network").status_code == 422
    c.delete(f"/api/networks/{m['id']}")


def test_simulation_rerun_reproduces():
    b = c.post("/api/networks/grid3x3/baseline").json()
    alt = c.post(f"/api/scenarios/{b['id']}/copy?name=Actuated").json()
    c.put(f"/api/scenarios/{alt['id']}", json=dict(controller="actuated"))
    sim = c.post("/api/simulations", json=dict(reference=b["id"], alternatives=[alt["id"]], seeds=[5, 6], depart_jitter_s=60)).json()

    def done(sid):
        for _ in range(600):
            st = c.get(f"/api/simulations/{sid}").json()
            if st["state"] != "running":
                return st
            time.sleep(0.5)
    first = done(sim["id"])
    c.put(f"/api/scenarios/{alt['id']}", json=dict(controller="fixed"))      # later edit must not leak in
    again = done(c.post(f"/api/simulations/{sim['id']}/rerun").json()["id"])
    assert again["rerun_of"] == sim["id"] and again["state"] == "done"
    v = lambda st: c.get(f"/api/runs/{st['alternatives'][0]['run_id']}").json()["aggregate"]["kpis"]["mean_travel_time_s"]["values"]
    assert v(first) == v(again)


def test_every_signal_marker_has_an_editable_plan():
    """Junctions typed as traffic lights but without any signal-controlled lane (3 in RESCO
    Ingolstadt21) run as priority junctions, so they must not be drawn as signals."""
    import pytest
    for nid in ("grid3x3", "ingolstadt21"):
        r = c.get(f"/api/networks/{nid}/geometry")
        if r.status_code != 200:
            pytest.skip(f"{nid} not available")
        sigs = [f["properties"] for f in r.json()["features"] if f["properties"]["kind"] == "signal"]
        plans = c.get(f"/api/networks/{nid}/signals").json()
        assert sigs and all(any(t in plans for t in s["tls"]) for s in sigs), nid
        assert len(sigs) == len(plans), nid


def test_failed_seed_reports_the_error_not_a_cut_traceback():
    from trafficsim.jobs import SeedFailed
    tb = ('Traceback (most recent call last):\n  File "<frozen runpy>", line 88, in _run_code\n'
          '  File "runner.py", line 87, in run_seed\n'
          "RuntimeError: SUMO stopped with an error. Error: Vehicle 'v1' has no valid route.\n")
    e = SeedFailed(7, tb)
    assert str(e) == "Run with seed 7 failed: SUMO stopped with an error. Error: Vehicle 'v1' has no valid route."
    assert "Traceback" in e.output


def test_overpass_busy_server_is_retried_then_the_next_one_is_used(tmp_path, monkeypatch):
    """Overpass answers 429/504 when at capacity: back off, then fall back to the next server."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from trafficsim import importer

    hits = {"busy": 0, "ok": 0}
    osm = b'<?xml version="1.0"?><osm version="0.6">' + b'<node id="1" lat="0" lon="0"/>' * 10 + b'<way id="1"/></osm>'

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            if self.path.startswith("/busy"):
                hits["busy"] += 1
                self.send_response(504); self.end_headers(); self.wfile.write(b"at capacity")
            else:
                hits["ok"] += 1
                self.send_response(200); self.end_headers(); self.wfile.write(osm)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    monkeypatch.setattr(importer.time, "sleep", lambda s: None)
    bbox = [73.85, 18.53, 73.854, 18.533]

    monkeypatch.setattr(importer, "OVERPASS_URLS", [f"{base}/busy", f"{base}/ok"])
    out = importer.fetch_osm_bbox(bbox, tmp_path / "a.osm")
    assert out.read_bytes() == osm and hits == {"busy": 3, "ok": 1}

    monkeypatch.setattr(importer, "OVERPASS_URLS", [f"{base}/busy"])
    import pytest
    with pytest.raises(importer.ImportError_, match="busy right now"):
        importer.fetch_osm_bbox(bbox, tmp_path / "b.osm")
    srv.shutdown()


def test_signal_lane_width_and_road_type_edits():
    """Add and remove signals, change lane width and road class; the built network reflects them."""
    import pytest
    import sumolib
    from trafficsim import build as b
    from trafficsim.scenario import Scenario
    import tempfile
    from pathlib import Path
    geo = c.get("/api/networks/grid3x3/geometry").json()
    assert not [f for f in geo["features"] if f["properties"]["kind"] == "junction"]   # grid: only signals
    s = Scenario(base_network="grid3x3", edits=[
        {"type": "remove_signal", "node": "B1"},
        {"type": "set_lane_width", "edge": "A0A1", "width_m": 3.5},
        {"type": "set_road_type", "edge": "A1B1", "road_type": "local"}])
    with tempfile.TemporaryDirectory() as d:
        out = b.build(s, Path(d))
        net = sumolib.net.readNet(str(out.net_file), withPrograms=True)
        assert net.getNode("B1").getType() == "priority"
        assert "B1" not in net._id2tls and len(net.getTrafficLights()) == 8
        assert [ln.getWidth() for ln in net.getEdge("A0A1").getLanes()] == [3.5] * len(net.getEdge("A0A1").getLanes())
        e = net.getEdge("A1B1")
        assert abs(e.getSpeed() * 3.6 - 30) < 0.1 and e.getPriority() == 3
        assert not any("B1" in w and "removed" in w for w in out.warnings)        # an intended removal is not a warning
    # the removed signal's junction can get its signal back
    s2 = Scenario(base_network="grid3x3", edits=[{"type": "remove_signal", "node": "B1"}, {"type": "add_signal", "node": "B1"}])
    with tempfile.TemporaryDirectory() as d:
        net = sumolib.net.readNet(str(b.build(s2, Path(d)).net_file), withPrograms=True)
        assert net.getNode("B1").getType() == "traffic_light"
    # invalid: no signal to remove at a dead end; a signal needs two roads in
    for bad, msg in (({"type": "remove_signal", "node": "bottom0"}, "no signal"),
                     ({"type": "add_signal", "node": "bottom0"}, "at least two roads"),
                     ({"type": "add_signal", "node": "A0"}, "already has")):
        with tempfile.TemporaryDirectory() as d, pytest.raises(b.EditError, match=msg):
            b.build(Scenario(base_network="grid3x3", edits=[bad]), Path(d))
    # through the API: a scenario with a removed signal shows a junction there, and runs
    base = [x for x in c.get("/api/scenarios").json() if x["base_network"] == "grid3x3" and x.get("baseline")]
    sid = (base[0] if base else c.post("/api/networks/grid3x3/baseline").json())["id"]
    alt = c.post(f"/api/scenarios/{sid}/copy").json()
    r = c.put(f"/api/scenarios/{alt['id']}", json={"edits": [{"type": "remove_signal", "node": "B1"}]})
    assert r.status_code == 200, r.text
    g = c.get(f"/api/scenarios/{alt['id']}/geometry").json()
    kinds = {f["properties"]["id"]: f["properties"]["kind"] for f in g["features"] if f["properties"]["kind"] != "edge"}
    assert kinds["B1"] == "junction" and g["edited"].get("B1") == ["remove_signal"]


def test_results_library_lists_finished_simulations_with_headlines():
    base = [x for x in c.get("/api/scenarios").json() if x["base_network"] == "grid3x3" and x.get("baseline")]
    ref = (base[0] if base else c.post("/api/networks/grid3x3/baseline").json())["id"]
    alt = c.post(f"/api/scenarios/{ref}/copy").json()["id"]
    c.put(f"/api/scenarios/{alt}", json={"controller": "actuated"})
    sim = c.post("/api/simulations", json={"reference": ref, "alternatives": [alt], "seeds": [1, 2]}).json()
    for _ in range(600):
        st = c.get(f"/api/simulations/{sim['id']}").json()
        if st["state"] != "running":
            break
        time.sleep(0.5)
    assert st["state"] == "done"
    rows = {r["id"]: r for r in c.get("/api/results").json()}
    r = rows[sim["id"]]
    a = r["alternatives"][0]
    assert a["scenario_id"] == alt and a["controller"] == "actuated" and a["n"] == 2
    assert a["after_s"] < a["before_s"] and a["verdict"] == "better"        # actuated beats fixed on the grid
    assert c.get("/api/results", params={"network": "corridor5"}).json() == [] or sim["id"] not in {
        x["id"] for x in c.get("/api/results", params={"network": "corridor5"}).json()}
    # cached: a second call reads the stored summary; removing the simulation removes it
    assert c.get("/api/results").json()[0]["alternatives"]
    c.delete(f"/api/simulations/{sim['id']}")
    assert sim["id"] not in {x["id"] for x in c.get("/api/results").json()}
def test_pressure_looks_past_short_lane_pieces():
    """The lane right after a signal is often a 0-3 m piece inside a junction cluster. Pressure must
    count the queue on the road beyond it, or the controller feeds traffic into full roads."""
    import glob
    import pytest
    from trafficsim import runner
    c.get("/api/networks/ingolstadt21/geometry")            # builds the network if RESCO is available
    nets = glob.glob(os.path.join(os.environ["TRAFFICSIM_DATA"], "networks", "ingolstadt21", "net.net.xml"))
    if not nets:
        pytest.skip("ingolstadt21 not available")
    fwd, back = runner._lane_reach(nets[0])
    short = "-315358251#1_1"                                  # 0.2 m piece after signal 30624898 (car lane)
    assert short in fwd and len(fwd[short]) > 1
    import sumolib
    net = sumolib.net.readNet(nets[0])
    reach = sum(net.getLane(x).getLength() for x in fwd[short])
    assert reach >= runner.MP_REACH_M


def _live_frames(lid, until, timeout=120):
    """Long-poll frames until `until(frame)` is true; return that frame."""
    t0, after = time.time(), 0
    while time.time() - t0 < timeout:
        f = c.get(f"/api/live/{lid}/frame", params={"after": after}).json()
        if f.get("seq"):
            after = f["seq"]
            if until(f):
                return f
        time.sleep(0.2)
    raise TimeoutError(lid)


def test_live_session_streams_real_sumo_state():
    base = [x for x in c.get("/api/scenarios").json() if x["base_network"] == "grid3x3" and x.get("baseline")]
    sid = (base[0] if base else c.post("/api/networks/grid3x3/baseline").json())["id"]
    # an impossible route is refused before anything starts
    r = c.post("/api/live", json={"scenario_id": sid, "routes": [{"from_edge": "A0A1", "to_edge": "nope", "per_hour": 100}]})
    assert r.status_code == 422
    r = c.post("/api/live", json={"scenario_id": sid, "controller": "actuated", "intensity": "high", "profile": "morning",
                                  "mix": "mixed", "duration_min": 10,
                                  "routes": [{"from_edge": "left0A0", "to_edge": "C2right2", "per_hour": 600}]})
    assert r.status_code == 200, r.text
    info = r.json()
    lid = info["id"]
    assert info["controller"] == "actuated" and info["window_end"] - info["begin"] == 600
    c.post(f"/api/live/{lid}/control", json={"action": "speed", "speed": 20})
    f = _live_frames(lid, lambda f: f["kpi"]["running"] > 20)
    k = f["kpi"]
    v = f["veh"][0]
    assert len(f["veh"]) == k["running"] and len(v) == 7 and abs(v[2]) < 1         # [id, lon, lat, ...]; grid sits at a fake origin
    assert sum(e[0] for e in f["edges"].values()) <= k["running"]                    # vehicles on edges (not inside junctions)
    assert set(f["tls"]) and all(len(s[0]) > 0 for s in f["tls"].values())
    assert {t for *_, t, _w in f["veh"]} <= {0, 1, 2, 3}
    assert any(x[0].startswith("user0") for x in _live_frames(lid, lambda f: any(x[0].startswith("user0") for x in f["veh"]))["veh"])
    # inspection: per-lane numbers for a road, state and approaches for a signal
    edge = next(iter(f["edges"]))
    c.post(f"/api/live/{lid}/control", json={"action": "watch", "watch": {"edge": edge}})
    w = _live_frames(lid, lambda f: bool(f.get("watch")) and f["watch"].get("edge") == edge)["watch"]
    assert w["lanes"] and {"vehicles", "halting", "speed_kmh", "width_m"} <= set(w["lanes"][0])
    c.post(f"/api/live/{lid}/control", json={"action": "watch", "watch": {"tls": "B1"}})
    w = _live_frames(lid, lambda f: bool(f.get("watch")) and f["watch"].get("tls") == "B1")["watch"]
    assert w["state"] and w["approaches"] and w["phases"]
    # pause holds the clock; resume and reset work (back to real time first, so the run can't finish before the pause lands)
    c.post(f"/api/live/{lid}/control", json={"action": "speed", "speed": 1})
    assert _live_frames(lid, lambda f: f["speed"] == 1)["state"] == "running"
    c.post(f"/api/live/{lid}/control", json={"action": "pause"})
    t1 = _live_frames(lid, lambda f: f["state"] == "paused")["t"]
    time.sleep(1)
    assert c.get(f"/api/live/{lid}/frame", params={"after": 0}).json()["t"] == t1
    info = c.post(f"/api/live/{lid}/control", json={"action": "reset"}).json()
    assert info["run"] == 2
    f = _live_frames(lid, lambda f: f["run"] == 2 and f["seq"] >= 1)
    assert f["t"] < t1
    st = c.get(f"/api/live/{lid}/static").json()
    assert st["lanes"] and st["signal_marks"]
    c.delete(f"/api/live/{lid}")
    assert c.get(f"/api/live/{lid}").status_code == 404


def test_live_demand_profiles_keep_count_and_shape():
    from trafficsim.live import profile_times
    for prof in ("normal", "morning", "evening"):
        ts = profile_times(1000, 0, 3600, prof)
        assert len(ts) == 1000 and ts == sorted(ts) and 0 <= ts[0] and ts[-1] <= 3600
    early = sum(t < 1800 for t in profile_times(1000, 0, 3600, "morning"))
    late = sum(t < 1800 for t in profile_times(1000, 0, 3600, "evening"))
    assert early > 600 and late < 400
