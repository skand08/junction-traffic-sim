"""Job queue and live-session channel in Postgres, used when the API and the worker are separate
(JUNCTION_EXECUTION=queue).

A job row is created by the API (state "queued"), claimed by one worker with SELECT ... FOR UPDATE SKIP LOCKED
(state "running"), kept alive by the worker's heartbeat, and finished with "done", "failed" or "cancelled".
Requests to a running job (cancel, pause, stop, live controls) are appended to its `commands` and picked up
by the worker that runs it. A job whose worker stops sending heartbeats is marked "interrupted" by any
other worker. Live sessions publish their latest frame to `live_frames`; the API reads it from there.
"""
import json
import os
from typing import Optional

from . import db

EXECUTION = os.environ.get("JUNCTION_EXECUTION", "local")    # local: the API runs jobs itself; queue: a worker does


def remote() -> bool:
    """True in an API process that hands work to workers."""
    return EXECUTION == "queue"


def enqueue(kind: str, jid: str, payload: dict):
    with db.conn() as c:
        c.execute("INSERT INTO jobs (id, kind, payload) VALUES (%s, %s, %s)", (jid, kind, json.dumps(payload)))


def claim(worker: str, kind: str, n: int) -> list:
    if n <= 0:
        return []
    with db.conn() as c:
        rows = c.execute(
            "WITH c AS (UPDATE jobs SET state = 'running', worker = %s, claimed_at = now(), heartbeat_at = now(), "
            "           attempts = attempts + 1 "
            "           WHERE id IN (SELECT id FROM jobs WHERE state = 'queued' AND kind = %s ORDER BY created_at "
            "                        LIMIT %s FOR UPDATE SKIP LOCKED) RETURNING id, payload, created_at) "
            "SELECT id, payload FROM c ORDER BY created_at", (worker, kind, n)).fetchall()
    return [(r[0], r[1]) for r in rows]


def heartbeat(worker: str, ids: list):
    if ids:
        with db.conn() as c:
            c.execute("UPDATE jobs SET heartbeat_at = now() WHERE worker = %s AND id = ANY(%s) AND state = 'running'",
                      (worker, list(ids)))


def command(jid: str, cmd: dict) -> bool:
    """Queue a request for the worker running this job; False if the job is not queued or running."""
    with db.conn() as c:
        r = c.execute("UPDATE jobs SET commands = commands || %s::jsonb WHERE id = %s AND state IN ('queued', 'running') "
                      "RETURNING id", (json.dumps([cmd]), jid)).fetchone()
    return r is not None


def take_commands(worker: str) -> dict:
    with db.conn() as c:
        rows = c.execute("UPDATE jobs j SET commands = '[]' FROM (SELECT id, commands FROM jobs WHERE worker = %s "
                         "AND state = 'running' AND commands <> '[]' FOR UPDATE) old WHERE j.id = old.id "
                         "RETURNING j.id, old.commands", (worker,)).fetchall()
    return {r[0]: r[1] for r in rows}


def cancel_queued(jid: str) -> bool:
    """Cancel a job no worker has started; False if it already started or ended."""
    with db.conn() as c:
        r = c.execute("UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = %s AND state = 'queued' "
                      "RETURNING id", (jid,)).fetchone()
    return r is not None


def finish(jid: str, state: str, error: Optional[str] = None):
    with db.conn() as c:
        c.execute("UPDATE jobs SET state = %s, error = %s, finished_at = now() WHERE id = %s", (state, error, jid))


def requeue(jid: str):
    """Give a job back (a worker shutting down); another worker starts it again from the beginning."""
    with db.conn() as c:
        c.execute("UPDATE jobs SET state = 'queued', worker = NULL, commands = '[]' WHERE id = %s AND state = 'running'", (jid,))


def reap(stale_s: int = 120) -> list:
    """Jobs whose worker went silent: marked interrupted. Returns [(kind, id)]."""
    with db.conn() as c:
        rows = c.execute("UPDATE jobs SET state = 'interrupted', finished_at = now() WHERE state = 'running' "
                         "AND heartbeat_at < now() - make_interval(secs => %s) RETURNING kind, id", (stale_s,)).fetchall()
    return [(r[0], r[1]) for r in rows]


def get(jid: str) -> Optional[dict]:
    with db.conn() as c:
        r = c.execute("SELECT id, kind, state, worker, error, created_at, claimed_at FROM jobs WHERE id = %s", (jid,)).fetchone()
    return dict(zip(("id", "kind", "state", "worker", "error", "created_at", "claimed_at"), r)) if r else None


def active(kind: str) -> list:
    """Ids of queued or running jobs of a kind, oldest first."""
    with db.conn() as c:
        return [r[0] for r in c.execute("SELECT id FROM jobs WHERE kind = %s AND state IN ('queued', 'running') "
                                        "ORDER BY created_at", (kind,)).fetchall()]


def depth() -> dict:
    with db.conn() as c:
        return {f"{k}_{s}": n for k, s, n in c.execute(
            "SELECT kind, state, count(*) FROM jobs WHERE state IN ('queued', 'running') GROUP BY kind, state").fetchall()}


# ---------------------------------------------------------------- live sessions
def live_open(sid: str):
    with db.conn() as c:
        c.execute("INSERT INTO live_frames (session) VALUES (%s) ON CONFLICT (session) DO NOTHING", (sid,))


def live_publish(sid: str, run: int, frame: Optional[dict], error: Optional[str] = None):
    with db.conn() as c:
        c.execute("UPDATE live_frames SET run = %s, seq = %s, frame = %s, error = %s, updated_at = now() WHERE session = %s",
                  (run, (frame or {}).get("seq", 0), json.dumps(frame) if frame is not None else None, error, sid))


def live_peek(sid: str) -> Optional[tuple]:
    """(run, seq, error) of the latest frame, and records that a viewer is watching."""
    with db.conn() as c:
        return c.execute("UPDATE live_frames SET last_seen = now() WHERE session = %s RETURNING run, seq, error",
                         (sid,)).fetchone()


def live_frame(sid: str) -> Optional[tuple]:
    with db.conn() as c:
        return c.execute("SELECT run, frame, error FROM live_frames WHERE session = %s", (sid,)).fetchone()


def live_idle_s(sid: str) -> Optional[float]:
    with db.conn() as c:
        r = c.execute("SELECT extract(epoch FROM now() - last_seen) FROM live_frames WHERE session = %s", (sid,)).fetchone()
    return float(r[0]) if r else None


def live_purge(older_than_s: int) -> list:
    """Remove live sessions that ended and have not been looked at for a while; returns their ids."""
    with db.conn() as c:
        rows = c.execute("DELETE FROM live_frames f WHERE f.last_seen < now() - make_interval(secs => %s) "
                         "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = f.session AND j.state IN ('queued', 'running')) "
                         "RETURNING session", (older_than_s,)).fetchall()
    return [r[0] for r in rows]


def live_close(sid: str):
    with db.conn() as c:
        c.execute("DELETE FROM live_frames WHERE session = %s", (sid,))
