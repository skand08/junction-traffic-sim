"""Regression: the agent and benchmark lists read only their small metadata documents.

Listing benchmarks used to fetch every document of every benchmark, including results.json (megabytes per
benchmark). On Postgres each list call held a pool connection for the whole transfer; the Research page
asks for the lists several times at once, so the pool ran out (PoolTimeout after 15 s).
"""
import os
import tempfile
import time
import uuid

import pytest

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim import store  # noqa: E402
from trafficsim.api import app  # noqa: E402

c = TestClient(app)
BIG = [{"seed_results": [{"seed": k, "trips": list(range(2000))} for k in range(10)]}] * 20   # a few MB


@pytest.fixture
def metadata_only(monkeypatch):
    """Fail if a list reads documents other than config, manifest and status."""
    real = store.docs.group

    def group(coll, *a, **kw):
        out = real(coll, *a, **kw)
        extra = {n for docs in out.values() for n in docs} - {"config.json", "manifest.json", "status.json"}
        assert not extra, f"the list of {coll} read {sorted(extra)}"
        return out
    monkeypatch.setattr(store.docs, "group", group)


def _benchmark() -> str:
    bid = "t" + uuid.uuid4().hex[:9]
    d = f"research/benchmarks/{bid}"
    store.docs.write(f"{d}/config.json", {"name": "List test", "scenario_id": "x", "controllers": [{"kind": "fixed"}]})
    store.docs.write(f"{d}/manifest.json", {"id": bid, "labels": ["Fixed timing"], "seeds": [1]})
    store.docs.write(f"{d}/status.json", {"state": "done", "done": 1, "total": 1, "created": time.time()})
    store.docs.write(f"{d}/results.json", BIG)
    return bid


def _agent() -> str:
    aid = "t" + uuid.uuid4().hex[:9]
    d = f"research/agents/{aid}"
    store.docs.write(f"{d}/config.json", {"name": "List test agent", "scenario_id": "x"})
    store.docs.write(f"{d}/manifest.json", {"id": aid, "created": time.time(), "network": "grid3x3"})
    store.docs.write(f"{d}/status.json", {"state": "done", "episodes_done": 2, "checkpoints": ["ep_0002.npz"],
                                          "has_model": True, "has_best": False})
    store.docs.write(f"{d}/notes.json", BIG)            # any other document in the agent's folder
    return aid


def test_benchmark_list_reads_metadata_only(metadata_only):
    bid = _benchmark()
    try:
        r = c.get("/api/research/benchmarks")
        assert r.status_code == 200, r.text
        b = next(x for x in r.json() if x["id"] == bid)
        assert set(b) == {"id", "config", "manifest", "status"}
        assert b["config"]["name"] == "List test" and b["status"]["state"] == "done" and b["manifest"]["seeds"] == [1]
        assert c.get(f"/api/research/benchmarks/{bid}").json()["status"]["done"] == 1
    finally:
        store.docs.delete_prefix(f"research/benchmarks/{bid}")


def test_agent_list_reads_metadata_only(metadata_only):
    aid = _agent()
    try:
        r = c.get("/api/research/agents")
        assert r.status_code == 200, r.text
        a = next(x for x in r.json() if x["id"] == aid)
        assert a["config"]["name"] == "List test agent" and a["status"]["episodes_done"] == 2
        assert a["checkpoints"] == ["ep_0002.npz"] and a["has_model"] is True and a["has_best"] is False
        assert c.get(f"/api/research/agents/{aid}").json()["manifest"]["network"] == "grid3x3"
    finally:
        store.docs.delete_prefix(f"research/agents/{aid}")
