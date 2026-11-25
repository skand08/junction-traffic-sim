"""Test set-up. By default the tests use local files and run jobs in the test process.

To run the same tests against Postgres with a separate worker (the deployed layout):
    DATABASE_URL=postgresql://... JUNCTION_EXECUTION=queue JUNCTION_TEST_RESET_DB=1 pytest
JUNCTION_TEST_RESET_DB=1 empties the database's tables first: point it at a test database only.
"""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))
QUEUE = os.environ.get("JUNCTION_EXECUTION") == "queue"


@pytest.fixture(scope="session", autouse=True)
def worker():
    """In queue mode: an empty database and one worker process for the whole session."""
    if not QUEUE:
        yield None
        return
    from trafficsim import db
    db.migrate()
    if os.environ.get("JUNCTION_TEST_RESET_DB") == "1":
        with db.conn() as c:
            c.execute("TRUNCATE documents, log_rows, jobs, live_frames")
    log = open(Path(os.environ["TRAFFICSIM_DATA"]) / "worker.log", "w")
    env = dict(os.environ, JUNCTION_WORKER_POLL_S="0.5", JUNCTION_WORKER_RUNS="4", JUNCTION_WORKER_TRAININGS="2")
    p = subprocess.Popen([sys.executable, "-m", "trafficsim.worker"], cwd=Path(__file__).resolve().parent.parent,
                         env=env, stdout=log, stderr=subprocess.STDOUT)
    time.sleep(2)
    assert p.poll() is None, "the worker did not start; see worker.log"
    yield p
    p.terminate()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    log.close()
