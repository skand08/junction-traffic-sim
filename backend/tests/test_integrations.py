"""Integrations, end to end with real SUMO runs: an external controller over HTTP, the RL environment export,
and demand calibration to traffic counts."""
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from trafficsim.api import app  # noqa: E402

c = TestClient(app)
EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "external_controller.py"


def _baseline(nid="grid3x3"):
    b = [x for x in c.get("/api/scenarios").json() if x["base_network"] == nid and x.get("baseline")]
    return (b[0] if b else c.post(f"/api/networks/{nid}/baseline").json())["id"]


def _wait(url, done, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = c.get(url).json()
        if done(r):
            return r
        time.sleep(0.5)
    raise TimeoutError(url)


@pytest.fixture(scope="module")
def controller():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    p = subprocess.Popen([sys.executable, str(EXAMPLE), "--port", str(port)], stdout=subprocess.PIPE, text=True)
    p.stdout.readline()                                  # "... controller on http://localhost:PORT/"
    yield f"http://localhost:{port}/"
    p.terminate()
    p.wait(5)


def test_external_controller_check_and_host_rules(controller):
    r = c.post("/api/controllers/test", json={"url": controller}).json()
    assert r["ok"] and r["reply"]["actions"]["example"] == 1          # the busier green (9 queued vs 2)
    assert c.post("/api/controllers/test", json={"url": "http://example.com/"}).status_code == 422
    assert c.post("/api/controllers/test", json={"url": "file:///etc/passwd"}).status_code == 422
    dead = c.post("/api/controllers/test", json={"url": "http://localhost:1/"})
    assert dead.status_code == 422 and "No answer" in dead.json()["detail"]


def test_external_controller_in_a_benchmark_and_live(controller):
    sid = _baseline()
    ext = {"url": controller, "name": "Longest queue (example)"}
    b = c.post("/api/research/benchmarks", json={
        "name": "ext", "scenario_id": sid, "controllers": [{"kind": "fixed"}, {"kind": "external", "external": ext}],
        "demand_levels": [1.0], "seeds": 2, "depart_jitter_s": 300}).json()
    assert b["manifest"]["labels"] == ["Fixed timing", "Longest queue (example)"]
    assert b["manifest"]["external"][0]["url"] == controller
    b = _wait(f"/api/research/benchmarks/{b['id']}", lambda r: r["status"]["state"] not in ("queued", "running"))
    assert b["status"]["state"] == "done", b["status"]
    st = c.get(f"/api/research/benchmarks/{b['id']}/stats").json()
    row = st["conditions"][0]["rows"][1]
    assert not row["errors"] and row["runs"] == 2
    assert row["measures"]["mean_travel_time_s"]["mean"] > 0
    res = json.loads((Path(os.environ["TRAFFICSIM_DATA"]) / "workspace" / "research" / "benchmarks" / b["id"] / "results.json").read_text())
    stats = res[1]["seed_results"][0]["controller_stats"]
    assert stats["calls"] > 100 and stats["failures"] == 0 and stats["changes"] > 0
    # a controller on a host that is not allowed is refused before anything runs
    bad = c.post("/api/research/benchmarks", json={"scenario_id": sid, "controllers": [
        {"kind": "fixed"}, {"kind": "external", "external": {"url": "http://10.0.0.1/"}}]})
    assert bad.status_code == 422

    lv = c.post("/api/live", json={"scenario_id": sid, "controller": "external", "external": ext, "duration_min": 10}).json()
    assert lv["controller"] == "external" and lv["external"] == ext["name"]
    c.post(f"/api/live/{lv['id']}/control", json={"action": "speed", "speed": 20})
    c.post(f"/api/live/{lv['id']}/control", json={"action": "watch", "watch": {"tls": "B1"}})
    t0, w = time.time(), None
    while time.time() - t0 < 120 and not (w and w.get("agent")):
        f = c.get(f"/api/live/{lv['id']}/frame", params={"after": 0}).json()
        w = f.get("watch")
        time.sleep(0.3)
    assert w["agent"]["kind"] == "queue" and len(w["agent"]["values"]) == len(w["agent"]["phases"])
    c.delete(f"/api/live/{lv['id']}")


def test_rl_environment_export_runs_standalone(tmp_path):
    sid = _baseline()
    r = c.post(f"/api/scenarios/{sid}/rl-env", json={"episode_min": 5, "reward": "queue"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    zipfile.ZipFile(io.BytesIO(r.content)).extractall(tmp_path)
    conf = json.loads((tmp_path / "config.json").read_text())
    assert conf["format"] == "junction-env/1" and len(conf["agents"]) == 9 and conf["signal"]["reward"] == "queue"
    # the signal logic is Junction's own, copied at export time
    src = (tmp_path / "junction_env" / "signal_env.py").read_text()
    assert "class SignalEnv" in src and "from ._core import _is_green, _lane_reach" in src
    out = subprocess.run([sys.executable, "example_random.py"], cwd=tmp_path, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr[-500:]
    assert out.stdout.startswith("9 agents, 60 steps")                 # 5 min / 5 s steps


def test_calibration_to_traffic_counts():
    base = _baseline()
    sid = c.post(f"/api/scenarios/{base}/copy", params={"name": "Calibrated"}).json()["id"]
    tpl = c.get(f"/api/scenarios/{sid}/counts-template.csv")
    lines = tpl.text.strip().splitlines()
    assert lines[0] == "road,name,lanes,vehicles" and len(lines) > 20
    counts = {"A0A1": 420, "B1B2": 300, "B0B1": 150, "A1B1": 380, "C1B1": 90, "B2A2": 260}
    body = "road,vehicles\n" + "\n".join(f"{k},{v}" for k, v in counts.items()) + "\nnot_a_road,5\n"
    bad = c.post(f"/api/scenarios/{sid}/calibrations", json={"csv": "x,y\n1,2"})
    assert bad.status_code == 422 and "header" in bad.json()["detail"]
    cal = c.post(f"/api/scenarios/{sid}/calibrations", json={"csv": body}).json()
    assert cal["problems"] == ["Row 8: road 'not_a_road' is not in this network."]
    cal = _wait(f"/api/calibrations/{cal['id']}", lambda r: r["status"]["state"] in ("done", "failed"))
    assert cal["status"]["state"] == "done", cal["status"]
    rep = cal["report"]
    assert {r["edge"]: r["in_demand"] for r in rep["rows"]} == counts         # routes carry exactly the counts
    assert rep["summary"]["share_geh_under_5"] >= 0.85                       # and the simulation reproduces them
    # use it; comparisons need the same demand on both sides
    s = c.put(f"/api/scenarios/{sid}/calibration", json={"calibration": cal["id"]}).json()
    assert s["calibration"] == cal["id"]
    mixed = c.post("/api/simulations", json={"reference": base, "alternatives": [sid], "seeds": 1})
    assert mixed.status_code == 422 and "different traffic demand" in mixed.json()["detail"]
    copy = c.post(f"/api/scenarios/{sid}/copy").json()
    assert copy["calibration"] == cal["id"]                                  # copies keep the demand
    sim = c.post("/api/simulations", json={"reference": sid, "alternatives": [copy["id"]], "seeds": 1}).json()
    sim = _wait(f"/api/simulations/{sim['id']}", lambda r: r["state"] in ("done", "failed", "partial"))
    assert sim["state"] == "done", sim
    s = c.put(f"/api/scenarios/{sid}/calibration", json={"calibration": None}).json()
    assert s["calibration"] is None
