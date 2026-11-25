"""Postgres connection pool and schema migrations.

Used only when DATABASE_URL is set (see store.py). Every process opens its own small pool on first use,
so spawned worker processes are fine. Migrations run once per database: the API and the worker both call
migrate() at start-up, and an advisory lock makes concurrent starts safe.

Command line (from backend/):
  python -m trafficsim.db migrate                 create or update the tables
  python -m trafficsim.db import-workspace        copy a local data/workspace folder into the database
"""
import atexit
import os
import sys
import threading
from contextlib import contextmanager

# The pooled connection string. A Marketplace integration installed with an environment-variable prefix (for example
# TRAFFIC_) names it <PREFIX>DATABASE_URL; set JUNCTION_DB_ENV_PREFIX to that prefix, or "TRAFFIC_" is tried too.
_PREFIXES = [os.environ.get("JUNCTION_DB_ENV_PREFIX", ""), "", "TRAFFIC_"]
SOURCE, URL = next(((p + n, os.environ[p + n]) for p in _PREFIXES for n in ("DATABASE_URL", "POSTGRES_URL")
                    if os.environ.get(p + n)), ("", ""))


def describe() -> str:
    """Which variable and host the app uses (no password), for start-up logs and /api/health."""
    if not URL:
        return "none (local files)"
    from urllib.parse import urlsplit
    try:
        u = urlsplit(URL)
        return f"{SOURCE} -> {u.hostname}:{u.port or 5432}/{u.path.lstrip('/')}"
    except ValueError:
        return f"{SOURCE} -> (unreadable URL)"
POOL_MAX = int(os.environ.get("DATABASE_POOL_MAX", "5"))

_pool = None
_pool_pid = None
_lock = threading.Lock()

# Each entry runs once, in order. Never edit a released entry: add a new one.
MIGRATIONS = [
    # 1: documents (scenarios, runs, simulations, agents, benchmarks, calibrations, networks, users ...),
    # append-only logs, the job queue, and the live-session channel
    """
    CREATE TABLE IF NOT EXISTS documents (
        path        text PRIMARY KEY,
        collection  text NOT NULL,
        data        json NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS documents_collection ON documents (collection, updated_at DESC);

    CREATE TABLE IF NOT EXISTS log_rows (
        id          bigserial PRIMARY KEY,
        path        text NOT NULL,
        row         json NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS log_rows_path ON log_rows (path, id);

    CREATE TABLE IF NOT EXISTS jobs (
        id            text PRIMARY KEY,
        kind          text NOT NULL,
        payload       jsonb NOT NULL DEFAULT '{}',
        state         text NOT NULL DEFAULT 'queued',
        commands      jsonb NOT NULL DEFAULT '[]',
        worker        text,
        attempts      int NOT NULL DEFAULT 0,
        error         text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        claimed_at    timestamptz,
        heartbeat_at  timestamptz,
        finished_at   timestamptz
    );
    CREATE INDEX IF NOT EXISTS jobs_queued ON jobs (kind, created_at) WHERE state = 'queued';
    CREATE INDEX IF NOT EXISTS jobs_running ON jobs (worker) WHERE state = 'running';

    CREATE TABLE IF NOT EXISTS live_frames (
        session     text PRIMARY KEY,
        run         int NOT NULL DEFAULT 0,
        seq         bigint NOT NULL DEFAULT 0,
        frame       json,
        error       text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        last_seen   timestamptz NOT NULL DEFAULT now()
    );
    """,
]


def enabled() -> bool:
    return bool(URL)


def pool():
    """The process's connection pool (created on first use; a forked or spawned child makes its own)."""
    global _pool, _pool_pid
    with _lock:
        if _pool is None or _pool_pid != os.getpid():
            from psycopg_pool import ConnectionPool
            # prepare_threshold=None: no server-side prepared statements, so a transaction-mode pooler
            # (Neon's -pooler endpoint, PgBouncer) works
            _pool = ConnectionPool(URL, min_size=1, max_size=POOL_MAX, open=True, timeout=15,
                                   kwargs=dict(autocommit=True, prepare_threshold=None, connect_timeout=10),
                                   check=ConnectionPool.check_connection)
            _pool_pid = os.getpid()
            atexit.register(_close)
    return _pool


def _close():
    if _pool is not None and _pool_pid == os.getpid():
        try:
            _pool.close(timeout=1)
        except Exception:  # noqa: BLE001
            pass


@contextmanager
def conn():
    with pool().connection() as c:
        yield c


@contextmanager
def transaction():
    with pool().connection() as c:
        with c.transaction():
            yield c


def migrate() -> int:
    """Apply missing migrations; returns the schema version."""
    with transaction() as c:
        c.execute("SELECT pg_advisory_xact_lock(727274)")        # one migrator at a time
        c.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        done = {r[0] for r in c.execute("SELECT version FROM schema_migrations").fetchall()}
        for v, sql in enumerate(MIGRATIONS, start=1):
            if v not in done:
                c.execute(sql)
                c.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (v,))
    return len(MIGRATIONS)


def import_workspace():
    """Copy an existing local workspace (data/workspace) into the database and the file store, so data made
    before switching to Postgres stays available. Safe to run twice: documents are overwritten."""
    import json
    from . import config, store
    if not store.SHARED:
        sys.exit("Set DATABASE_URL first.")
    root = config.WORKSPACE_DIR
    n_docs = n_logs = n_files = 0
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()
        parts = rel.split("/")
        if parts[0] in ("builds", "exports", "uploads", "live") or rel.endswith(".tmp") \
                or any(p in ("build", "work") or p.startswith("seed_") or (p == "runs" and i > 0) for i, p in enumerate(parts[:-1])):
            continue                                   # caches and working files that are made again when needed
        if rel.endswith(".jsonl"):
            for line in f.read_text().splitlines():
                if line.strip():
                    store.logs.append(rel, json.loads(line))
                    n_logs += 1
        elif rel.endswith(".json"):
            try:
                data = json.loads(f.read_text())
            except json.JSONDecodeError:
                continue
            store.docs.write(rel, data)
            n_docs += 1
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "run.json":
                from .jobs import run_row
                store.docs.write(f"runs/{parts[1]}/row.json", run_row(data))     # the run list reads these
        else:
            store.files.push(f)
            n_files += 1
    for m in config.NETWORKS_DIR.glob("*/meta.json"):    # imported networks
        from . import catalog
        if m.parent.name not in catalog.SPECS:
            store.docs.write(f"networks/{m.parent.name}.json", json.loads(m.read_text()))
            store.files.push(m.parent)
            n_docs += 1
    print(f"Imported {n_docs} documents, {n_logs} log rows and {n_files} files.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "migrate"
    if not URL:
        sys.exit("DATABASE_URL is not set.")
    if cmd == "migrate":
        print(f"Database schema at version {migrate()}.")
    elif cmd == "import-workspace":
        migrate()
        import_workspace()
    else:
        sys.exit(__doc__)
