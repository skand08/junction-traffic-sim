"""Where the app keeps its data.

Three kinds of data, each with a local backend (one machine, files under data/) and a shared backend
(several API instances and workers):

  docs   small JSON documents addressed by a workspace path such as "scenarios/<id>.json" or
         "runs/<id>/run.json". Local: files at that path under data/workspace. Shared: the Postgres
         `documents` table (set DATABASE_URL).
  logs   append-only JSON rows (training logs). Local: a .jsonl file. Shared: the `log_rows` table.
  files  binary or large files (networks, fitted demand, trained models). Always written to local disk
         first; with a Vercel Blob store configured (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with OIDC on
         Vercel) they are also uploaded, and pulled back on another machine when needed.

The job queue and the live-session channel (queue.py) need Postgres.
"""
import json
import os
import shutil
import threading
from pathlib import Path
from typing import Iterable, Optional

from . import config, db

SHARED = db.enabled()          # documents live in Postgres and are shared between processes and machines


def collection(path: str) -> str:
    parts = path.split("/")
    return "/".join(parts[:2]) if parts[0] == "research" and len(parts) > 2 else parts[0]


def _safe(path: str) -> str:
    if not path or path.startswith("/") or ".." in path.split("/") or "\\" in path:
        raise KeyError(f"bad document path '{path}'")
    return path


# ---------------------------------------------------------------- documents
class FileDocs:
    """Documents as JSON files under data/workspace (the layout the app always used)."""

    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()

    def _f(self, path: str) -> Path:
        return self.root / _safe(path)

    def read(self, path: str) -> Optional[dict]:
        f = self._f(path)
        try:
            return json.loads(f.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def write(self, path: str, data: dict):
        f = self._f(path)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(f)

    def merge(self, path: str, **kw) -> dict:
        with self.lock:
            d = self.read(path) or {}
            d.update(kw)
            self.write(path, d)
        return d

    def delete(self, path: str):
        self._f(path).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str):
        p = self._f(prefix.rstrip("/"))
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)

    def items(self, coll: str, name: Optional[str] = None) -> list:
        """[(id, data)] for coll/<id>.json, or coll/<id>/<name> when name is given; newest first."""
        d = self._f(coll)
        if not d.exists():
            return []
        files = d.glob(f"*/{name}") if name else d.glob("*.json")
        out = []
        for f in sorted(files, key=lambda f: f.stat().st_mtime, reverse=True):
            try:
                out.append((f.parent.name if name else f.stem, json.loads(f.read_text())))
            except (json.JSONDecodeError, FileNotFoundError):
                continue
        return out

    def group(self, coll: str) -> dict:
        """{id: {name: data}} for every coll/<id>/<name>.json; ids newest first."""
        d = self._f(coll)
        if not d.exists():
            return {}
        out = {}
        for sub in sorted((p for p in d.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True):
            docs = {}
            for f in sub.glob("*.json"):
                try:
                    docs[f.name] = json.loads(f.read_text())
                except (json.JSONDecodeError, FileNotFoundError):
                    continue
            if docs:
                out[sub.name] = docs
        return out


class PgDocs:
    """Documents in the Postgres `documents` table, keyed by the same paths. Stored as `json` (not jsonb) so
    key order is kept exactly as written."""

    def read(self, path: str) -> Optional[dict]:
        with db.conn() as c:
            r = c.execute("SELECT data FROM documents WHERE path = %s", (_safe(path),)).fetchone()
        return r[0] if r else None

    def write(self, path: str, data: dict):
        with db.conn() as c:
            c.execute("INSERT INTO documents (path, collection, data) VALUES (%s, %s, %s) "
                      "ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
                      (_safe(path), collection(path), json.dumps(data)))

    def merge(self, path: str, **kw) -> dict:
        with db.transaction() as c:
            c.execute("INSERT INTO documents (path, collection, data) VALUES (%s, %s, '{}') ON CONFLICT (path) DO NOTHING",
                      (_safe(path), collection(path)))
            d = c.execute("SELECT data FROM documents WHERE path = %s FOR UPDATE", (path,)).fetchone()[0] or {}
            d.update(kw)
            c.execute("UPDATE documents SET data = %s, updated_at = now() WHERE path = %s", (json.dumps(d), path))
        return d

    def delete(self, path: str):
        with db.conn() as c:
            c.execute("DELETE FROM documents WHERE path = %s", (_safe(path),))

    def delete_prefix(self, prefix: str):
        p = _safe(prefix.rstrip("/"))
        like = p.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        with db.conn() as c:
            c.execute("DELETE FROM documents WHERE path = %s OR path LIKE %s", (p, like + "/%"))

    def _rows(self, coll: str):
        with db.conn() as c:
            return c.execute("SELECT path, data FROM documents WHERE collection = %s ORDER BY created_at DESC",
                             (collection(coll + "/x/y"),)).fetchall()

    def items(self, coll: str, name: Optional[str] = None) -> list:
        n = len(coll.split("/"))
        out = []
        for path, data in self._rows(coll):
            parts = path.split("/")
            if name and len(parts) == n + 2 and parts[-1] == name:
                out.append((parts[n], data))
            elif not name and len(parts) == n + 1 and parts[-1].endswith(".json"):
                out.append((parts[n][:-5], data))
        return out

    def group(self, coll: str) -> dict:
        n = len(coll.split("/"))
        out: dict = {}
        for path, data in self._rows(coll):
            parts = path.split("/")
            if len(parts) == n + 2 and parts[-1].endswith(".json"):
                out.setdefault(parts[n], {})[parts[-1]] = data
        return out


# ---------------------------------------------------------------- logs
class FileLogs:
    def __init__(self, root: Path):
        self.root = root

    def append(self, path: str, row: dict):
        f = self.root / _safe(path)
        f.parent.mkdir(parents=True, exist_ok=True)
        with open(f, "a") as fh:
            fh.write(json.dumps(row) + "\n")

    def rows(self, path: str) -> list:
        f = self.root / _safe(path)
        return [json.loads(x) for x in f.read_text().splitlines() if x.strip()] if f.exists() else []

    def delete(self, path: str):
        (self.root / _safe(path)).unlink(missing_ok=True)


class PgLogs:
    def append(self, path: str, row: dict):
        with db.conn() as c:
            c.execute("INSERT INTO log_rows (path, row) VALUES (%s, %s)", (_safe(path), json.dumps(row)))

    def rows(self, path: str) -> list:
        with db.conn() as c:
            return [r[0] for r in c.execute("SELECT row FROM log_rows WHERE path = %s ORDER BY id", (_safe(path),)).fetchall()]

    def delete(self, path: str):
        with db.conn() as c:
            c.execute("DELETE FROM log_rows WHERE path = %s", (_safe(path),))


# ---------------------------------------------------------------- files
class LocalFiles:
    """Files stay where they are written (one machine, or machines sharing one data volume)."""
    remote = False

    def push(self, path: Path):
        pass

    def pull(self, path: Path, fresh: bool = False) -> bool:
        return Path(path).exists()

    def pull_dir(self, path: Path) -> bool:
        return Path(path).is_dir()

    def remove(self, path: Path):
        p = Path(path)
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


class BlobFiles:
    """Files mirrored to a Vercel Blob store. A file's Blob pathname is its path relative to data/, so the
    same path on every machine maps to the same object. Local copies act as a cache."""
    remote = True

    def __init__(self, root: Path, access: str):
        self.root, self.access = root, access

    def _name(self, path: Path) -> str:
        return "junction/" + Path(path).resolve().relative_to(self.root.resolve()).as_posix()

    def _blob(self):
        from vercel.blob import sync
        return sync

    def push(self, path: Path):
        p = Path(path)
        files: Iterable[Path] = [p] if p.is_file() else (f for f in p.rglob("*") if f.is_file())
        b = self._blob()
        for f in files:
            if f.suffix == ".tmp":
                continue
            b.put_blob(self._name(f), f.read_bytes(), access=self.access, allow_overwrite=True,
                       content_type="application/octet-stream")

    def _download(self, name: str, dest: Path):
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + f".{os.getpid()}.dl.tmp")
        with self._blob().stream_blob(name, access=self.access) as dl, open(tmp, "wb") as fh:
            for chunk in dl:
                fh.write(chunk)
        tmp.replace(dest)

    def pull(self, path: Path, fresh: bool = False) -> bool:
        """Make sure the file is on local disk. fresh=True: also replace a local copy older than the stored one
        (for files that are rewritten, like the latest model of a running training)."""
        p = Path(path)
        if p.exists() and not fresh:
            return True
        b = self._blob()
        try:
            h = b.head_blob(self._name(p))
        except b.BlobNotFoundError:
            return p.exists()
        if not p.exists() or h.uploaded_at.timestamp() > p.stat().st_mtime + 1:
            self._download(self._name(p), p)
        return True

    def pull_dir(self, path: Path) -> bool:
        p = Path(path)
        prefix = self._name(p) + "/"
        found = False
        for item in self._blob().query_blobs(prefix=prefix):
            found = True
            dest = p / item.pathname[len(prefix):]
            if not dest.exists() or item.uploaded_at.timestamp() > dest.stat().st_mtime + 1:
                self._download(item.pathname, dest)
        return found or p.is_dir()

    def remove(self, path: Path):
        p = Path(path)
        b = self._blob()
        names = [i.pathname for i in b.query_blobs(prefix=self._name(p) + "/")] if not p.is_file() else []
        names.append(self._name(p))
        for i in range(0, len(names), 1000):
            try:
                b.delete_blob(names[i:i + 1000])
            except b.BlobNotFoundError:
                pass
        LocalFiles().remove(p)


def _files():
    if os.environ.get("BLOB_READ_WRITE_TOKEN") or os.environ.get("BLOB_STORE_ID"):
        return BlobFiles(config.DATA_DIR, os.environ.get("BLOB_ACCESS", "private"))
    return LocalFiles()


docs = PgDocs() if SHARED else FileDocs(config.WORKSPACE_DIR)
logs = PgLogs() if SHARED else FileLogs(config.WORKSPACE_DIR)
files = _files()


DB_ERROR: Optional[str] = None


def ready(strict: bool = True):
    """Create tables on first use of a database (no-op for local files). strict=False (the API): log a failure
    and keep serving, so /api/health can say what is wrong instead of the server never starting."""
    global DB_ERROR
    if not SHARED:
        return
    print(f"Database: {db.describe()}", flush=True)
    try:
        db.migrate()
        DB_ERROR = None
    except Exception as e:  # noqa: BLE001
        DB_ERROR = f"Cannot reach the database ({db.describe()}): {type(e).__name__}: {str(e).splitlines()[0][:300]}"
        print(DB_ERROR, flush=True)
        if strict:
            raise SystemExit(DB_ERROR)
