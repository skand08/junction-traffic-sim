"""Research mode, end to end: train a real agent, benchmark it against the built-in controllers, export."""
import csv
import io
import json
import os
import tempfile
import time
import zipfile

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from trafficsim.api import app  # noqa: E402

c = TestClient(app)


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


def test_numpy_networks_backpropagate_correctly():
    from trafficsim.rl.nn import MLP
    rng = np.random.default_rng(0)
    m = MLP(6, [8, 5], 3, rng)
    x, y = rng.normal(size=(4, 6)), rng.normal(size=(4, 3))
    out, acts = m.forward(x)
    grads = m.backward(acts, out - y)
    for P, G in zip(m.params(), grads):
        i = tuple(rng.integers(0, s) for s in P.shape)
        v = P[i]
        P[i] = v + 1e-6; a = 0.5 * ((m(x) - y) ** 2).sum()
        P[i] = v - 1e-6; b = 0.5 * ((m(x) - y) ** 2).sum()
        P[i] = v
        assert abs((a - b) / 2e-6 - G[i]) < 1e-6


def test_train_benchmark_export_and_watch():
    sid = _baseline()
    cfg = dict(name="DQN test", scenario_id=sid, algorithm="dqn", sharing="shared",
               training=dict(episodes=4, episode_min=10, demand_scales=[0.8, 1.0], seed=3, checkpoint_every=2),
               hyper=dict(learning_starts=100))
    a = c.post("/api/research/agents", json=cfg)
    assert a.status_code == 200, a.text
    aid = a.json()["id"]
    info = _wait(f"/api/research/agents/{aid}", lambda r: r["status"]["state"] in ("done", "failed"))
    assert info["status"]["state"] == "done", info["status"]
    assert info["checkpoints"] == ["ep_0002.npz", "ep_0004.npz"] and info["has_model"]
    log = c.get(f"/api/research/agents/{aid}/log").json()
    assert [r["episode"] for r in log] == [1, 2, 3, 4]
    assert all(r["decisions"] > 0 and r["arrived"] > 0 for r in log)
    assert log[0]["epsilon"] == 1.0 and log[-1]["epsilon"] < log[0]["epsilon"]
    assert info["manifest"]["episode_seeds"] == [3000, 3001, 3002, 3003]
    z = zipfile.ZipFile(io.BytesIO(c.get(f"/api/research/agents/{aid}/export").content))
    assert {"config.json", "manifest.json", "log.jsonl", "log.csv", "final.npz"} <= set(z.namelist())
    assert log[-1]["eval_travel_time_s"] > 0 and "eval_travel_time_s" not in log[0]   # evaluated every 5 and at the end
    assert "eval_travel_time_s" in z.read("log.csv").decode().splitlines()[0]

    # a held-out scenario: the same network with a road change the agent never trained on
    held = c.post(f"/api/scenarios/{sid}/copy").json()["id"]
    c.put(f"/api/scenarios/{held}", json={"name": "Held out: extra lane", "edits": [{"type": "set_lanes", "edge": "A1B1", "lanes": 3}]})
    b = c.post("/api/research/benchmarks", json=dict(
        name="test", scenario_id=sid, heldout_ids=[held], demand_levels=[0.8, 1.2], seeds=2,
        controllers=[{"kind": "fixed"}, {"kind": "actuated"}, {"kind": "max_pressure"}, {"kind": "rl", "agent_id": aid}]))
    assert b.status_code == 200, b.text
    bid = b.json()["id"]
    assert b.json()["status"]["total"] == 2 * 2 * 4 * 2
    info = _wait(f"/api/research/benchmarks/{bid}", lambda r: r["status"]["state"] in ("done", "failed", "cancelled"), 900)
    assert info["status"]["state"] == "done", info["status"]
    st = c.get(f"/api/research/benchmarks/{bid}/stats").json()
    assert len(st["conditions"]) == 4 and sum(cd["heldout"] for cd in st["conditions"]) == 2
    for cd in st["conditions"]:
        assert [r["label"] for r in cd["rows"]][:3] == ["Fixed timing", "Vehicle-actuated", "Pressure-based"]
        for r in cd["rows"]:
            assert r["runs"] == 2 and not r["errors"]
            m = r["measures"]
            assert m["mean_travel_time_s"]["n"] == 2 and m["co2_g_per_trip"]["mean"] > 0 and m["mean_queue_veh"]["mean"] >= 0
            assert m["throughput_veh_h"]["mean"] > 0
            assert (r["vs_reference"] is None) == (r["controller"] == 0)
    assert {x["label"] for x in st["robustness"]} == {"Vehicle-actuated", "Pressure-based", "RL: DQN test"}
    rows = list(csv.DictReader(io.StringIO(c.get(f"/api/research/benchmarks/{bid}/export.csv").text)))
    assert len(rows) == 32 and {"mean_queue_veh", "co2_g_per_trip", "seed", "demand_level"} <= set(rows[0])
    j = json.loads(c.get(f"/api/research/benchmarks/{bid}/export.json").content)
    assert j["benchmark"]["manifest"]["models"][f"{aid}/final"]["sha"]
    assert j["benchmark"]["manifest"]["seeds"] == [1, 2]

    # watch the agent on the live map: its decisions come with the signal's details
    live = c.post("/api/live", json=dict(scenario_id=sid, controller="rl", rl_agent=aid, duration_min=10))
    assert live.status_code == 200, live.text
    lid = live.json()["id"]
    c.post(f"/api/live/{lid}/control", json={"action": "speed", "speed": 0})
    c.post(f"/api/live/{lid}/control", json={"action": "watch", "watch": {"tls": "B1"}})
    t0, after, agent = time.time(), 0, None
    while time.time() - t0 < 60 and not agent:
        f = c.get(f"/api/live/{lid}/frame", params={"after": after}).json()
        after = f.get("seq", after)
        agent = (f.get("watch") or {}).get("agent")
        time.sleep(0.2)
    assert agent and agent["kind"] == "value" and len(agent["values"]) == len(agent["phases"]) and 0 <= agent["chosen"] < len(agent["values"])
    c.delete(f"/api/live/{lid}")
