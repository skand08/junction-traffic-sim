"""Regression: a run's result and its list entry become visible together.

The API treats a run as finished once runs/<id>/run.json exists, and the run list reads runs/<id>/row.json. The
worker used to write run.json first, so for a moment a finished run was missing from the list (seen as a
KeyError in test_experiment_bundle_and_history on Postgres with a separate worker).
"""
import os
import tempfile

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from trafficsim import jobqueue, jobs, store  # noqa: E402
from trafficsim.scenario import Scenario  # noqa: E402


def test_result_is_never_readable_before_its_list_entry(monkeypatch):
    monkeypatch.setattr(jobqueue, "remote", lambda: False)          # run it in this process
    seen = []
    real_write, real_many = store.docs.write, getattr(store.docs, "write_many", None)

    def check(path):
        if path.endswith("/run.json"):
            rid = path.split("/")[1]
            seen.append(store.docs.read(f"runs/{rid}/row.json") is not None)

    def write(path, data):
        check(path)
        return real_write(path, data)
    monkeypatch.setattr(store.docs, "write", write)
    if real_many:
        def write_many(items):
            items = list(items)
            for path, _ in items:
                check(path) if path.endswith("/row.json") else None
            return real_many(items)
        monkeypatch.setattr(store.docs, "write_many", write_many)
    m = jobs.JobManager(workers=1)
    j = m.submit(Scenario(base_network="grid3x3", name="Order check"), [1])
    m._orch.shutdown(wait=True)                                      # the run has finished
    assert m.status(j["id"])["state"] == "done"
    assert seen == [] or all(seen), "run.json was written while its row.json was missing"
    assert any(r["id"] == j["id"] for r in jobs.list_runs())
