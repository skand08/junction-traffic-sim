"""Where jobs run.

On Vercel the API is a function that stops between requests, so it must never run jobs itself: without an
explicit JUNCTION_EXECUTION it hands them to the worker queue. A run left "running" by a process that no longer
exists (it is in no worker's queue) is reported as failed with the reason, not as running forever.
"""
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from trafficsim import jobqueue, jobs, store  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent


def _mode(**env):
    e = {k: v for k, v in os.environ.items() if k not in ("JUNCTION_EXECUTION", "VERCEL")}
    e.update(env)
    return subprocess.run([sys.executable, "-c", "from trafficsim import jobqueue; print(jobqueue.EXECUTION)"],
                          cwd=BACKEND, env=e, capture_output=True, text=True, check=True).stdout.strip()


def test_vercel_defaults_to_the_queue():
    assert _mode() == "local"                                   # your own machine: run jobs here
    assert _mode(VERCEL="1") == "queue"                         # a Vercel function: a worker runs them
    assert _mode(VERCEL="1", JUNCTION_EXECUTION="local") == "local"   # an explicit setting wins


@pytest.mark.skipif(not jobqueue.remote(), reason="queue mode only (Postgres with a worker)")
def test_run_left_running_without_a_worker_is_reported_failed():
    rid = "t" + uuid.uuid4().hex[:9]
    store.docs.write(f"runs/{rid}/status.json", dict(id=rid, run_id=rid, state="running", done=4, total=10,
                                                     message="4 of 10 simulations done", created=time.time() - 600))
    st = jobs.JobManager().status(rid)
    assert st["state"] == "failed" and "no longer running" in st["error"]
    fresh = "t" + uuid.uuid4().hex[:9]                          # just submitted: the queue row may not be visible yet
    store.docs.write(f"runs/{fresh}/status.json", dict(id=fresh, run_id=fresh, state="queued", done=0, total=10,
                                                       message="Waiting to start", created=time.time()))
    assert jobs.JobManager().status(fresh)["state"] == "queued"
    store.docs.delete_prefix(f"runs/{rid}"); store.docs.delete_prefix(f"runs/{fresh}")
