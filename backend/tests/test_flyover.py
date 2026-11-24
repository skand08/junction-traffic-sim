"""Flyovers: options at a junction, validation, the rebuilt network, rewritten routes and a real comparison."""
import os
import tempfile
import time

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim import flyover  # noqa: E402
from trafficsim.api import app  # noqa: E402

c = TestClient(app)
FLY = {"type": "add_flyover", "node": "C0", "from_edge": "B0C0", "to_edge": "C0D0", "lanes": 2, "speed_kmh": 60, "ramp_m": 100, "both_ways": True}


def _baseline(nid):
    b = [x for x in c.get("/api/scenarios").json() if x["base_network"] == nid and x.get("baseline")]
    return (b[0] if b else c.post(f"/api/networks/{nid}/baseline").json())["id"]


def _copy(sid, name):
    return c.post(f"/api/scenarios/{sid}/copy", params={"name": name}).json()["id"]


def test_options_and_validation():
    sid = _copy(_baseline("corridor5"), "Flyover options")
    r = c.get(f"/api/scenarios/{sid}/flyover-options", params={"node": "C0"}).json()
    main = next(o for o in r["options"] if o["from_edge"] == "B0C0")
    assert main["to_edge"] == "C0D0" and main["reverse"] == {"from_edge": "D0C0", "to_edge": "C0B0"} and main["lanes"] == 2
    # a turn is not "straight on", and a road can carry only one set of ramps
    bad = c.put(f"/api/scenarios/{sid}", json={"edits": [dict(FLY, to_edge="C0top2")]})
    assert bad.status_code == 422 and "straight on" in bad.json()["detail"]
    twice = c.put(f"/api/scenarios/{sid}", json={"edits": [FLY, dict(FLY, node="B0", from_edge="A0B0", to_edge="B0C0")]})
    assert twice.status_code == 422 and "already carries a ramp" in twice.json()["detail"]


def test_flyover_network_map_and_routes():
    sid = _copy(_baseline("corridor5"), "Flyover at C0")
    r = c.put(f"/api/scenarios/{sid}", json={"edits": [FLY]})
    assert r.status_code == 200, r.text
    g = c.get(f"/api/scenarios/{sid}/geometry").json()
    decks = [f["properties"] for f in g["features"] if f["properties"].get("flyover")]
    assert {d["id"] for d in decks} == {"C0_flyover_0", "C0_flyover_1"} and all(d["lanes"] == 2 for d in decks)
    assert decks[0]["label"].startswith("Flyover over junction C0") and "C0_flyover_0" in g["edited"]
    assert not any(f["properties"]["id"].startswith("fly_") for f in g["features"] if f["properties"]["kind"] == "junction")
    # explicit routes: straight through uses the deck, turns use the street-level pieces
    decks = [dict(a="B0C0", b="C0D0", deck="C0_flyover_0", a_at="B0C0_atgrade", b_at="C0D0_atgrade")]
    assert flyover.rewrite_route(["A0B0", "B0C0", "C0D0", "D0E0"], decks) == ["A0B0", "B0C0", "C0_flyover_0", "C0D0", "D0E0"]
    assert flyover.rewrite_route(["A0B0", "B0C0", "C0top2"], decks) == ["A0B0", "B0C0", "B0C0_atgrade", "C0top2"]
    assert flyover.rewrite_route(["bottom2C0", "C0D0", "D0E0"], decks) == ["bottom2C0", "C0D0_atgrade", "C0D0", "D0E0"]
    assert flyover.rewrite_route(["C0D0", "D0E0"], decks) == ["C0D0", "D0E0"]
    # a turn ban at the same junction still applies, to the street-level piece
    r = c.put(f"/api/scenarios/{sid}", json={"edits": [FLY, {"type": "ban_turn", "from_edge": "B0C0", "to_edge": "C0top2"}]})
    assert r.status_code == 200, r.text


def test_flyover_reduces_delay_in_simulation():
    base = _baseline("corridor5")
    sid = _copy(base, "Flyover, measured")
    assert c.put(f"/api/scenarios/{sid}", json={"edits": [FLY]}).status_code == 200
    sim = c.post("/api/simulations", json={"reference": base, "alternatives": [sid], "seeds": [1, 2], "depart_jitter_s": 300}).json()
    t0 = time.time()
    while time.time() - t0 < 600:
        sim = c.get(f"/api/simulations/{sim['id']}").json()
        if sim["state"] in ("done", "failed", "partial"):
            break
        time.sleep(1)
    assert sim["state"] == "done", sim
    ref, alt = c.get(f"/api/runs/{sim['reference']['run_id']}").json(), c.get(f"/api/runs/{sim['alternatives'][0]['run_id']}").json()
    tt = lambda run: run["aggregate"]["kpis"]["mean_travel_time_s"]["mean"]
    assert tt(alt) < 0.9 * tt(ref), (tt(ref), tt(alt))          # through traffic skips the signal
    assert alt["aggregate"]["edges"]["C0_flyover_0"]["volume"] > 300
    assert alt["aggregate"]["kpis"]["teleports"]["mean"] == 0
