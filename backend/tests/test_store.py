"""The storage layer: documents and logs on the configured backend (files, or Postgres with DATABASE_URL),
Blob file mirroring against a stand-in for the Vercel Blob SDK, and the Postgres job queue."""
import contextlib
import datetime as dt
import os
import tempfile
import time
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from trafficsim import config, jobqueue, store  # noqa: E402


def test_documents_and_logs():
    k = uuid.uuid4().hex[:8]
    d = store.docs
    assert d.read(f"tst_{k}/a.json") is None
    d.write(f"tst_{k}/a.json", {"z": 1, "a": 2})
    assert list(d.read(f"tst_{k}/a.json")) == ["z", "a"]                       # key order is kept
    assert d.merge(f"tst_{k}/a.json", a=3, b=4) == {"z": 1, "a": 3, "b": 4}
    assert d.merge(f"tst_{k}/new.json", x=1) == {"x": 1}
    d.write(f"tst_{k}/one/status.json", {"s": 1})
    d.write(f"tst_{k}/one/config.json", {"c": 1})
    d.write(f"tst_{k}/two/status.json", {"s": 2})
    d.write(f"tst_{k}/two/sub/deep.json", {"no": 1})                          # not a direct child
    assert {i for i, _ in d.items(f"tst_{k}")} == {"a", "new"}
    assert dict(d.items(f"tst_{k}", "status.json")) == {"one": {"s": 1}, "two": {"s": 2}}
    g = d.group(f"tst_{k}")
    assert g["one"] == {"status.json": {"s": 1}, "config.json": {"c": 1}} and "deep.json" not in g.get("two", {})
    d.write(f"tst_{k}/list.json", [1, 2, 3])
    assert d.read(f"tst_{k}/list.json") == [1, 2, 3]
    d.delete_prefix(f"tst_{k}/one")
    assert d.read(f"tst_{k}/one/status.json") is None and d.read(f"tst_{k}/two/status.json") == {"s": 2}
    with pytest.raises(KeyError):
        d.read("../etc/passwd")
    store.logs.append(f"tst_{k}/log.jsonl", {"e": 1})
    store.logs.append(f"tst_{k}/log.jsonl", {"e": 2})
    assert store.logs.rows(f"tst_{k}/log.jsonl") == [{"e": 1}, {"e": 2}]
    store.logs.delete(f"tst_{k}/log.jsonl")
    assert store.logs.rows(f"tst_{k}/log.jsonl") == []
    d.delete_prefix(f"tst_{k}")
    assert d.items(f"tst_{k}") == []


class FakeBlob:
    """In-memory stand-in for vercel.blob.sync, with the calls BlobFiles uses."""

    class BlobNotFoundError(Exception):
        pass

    class _Item:
        def __init__(self, pathname, size, uploaded_at):
            self.pathname, self.size, self.uploaded_at = pathname, size, uploaded_at

    def __init__(self):
        self.objects = {}

    def put_blob(self, name, body, *, access, allow_overwrite=False, content_type=None):
        assert access == "private"
        if name in self.objects and not allow_overwrite:
            raise RuntimeError("exists")
        self.objects[name] = (bytes(body), dt.datetime.now(dt.timezone.utc))

    def head_blob(self, name):
        if name not in self.objects:
            raise self.BlobNotFoundError(name)
        body, t = self.objects[name]
        return self._Item(name, len(body), t)

    @contextlib.contextmanager
    def stream_blob(self, name, *, access):
        yield iter([self.objects[name][0]])

    def query_blobs(self, *, prefix=None):
        return [self._Item(n, len(b), t) for n, (b, t) in sorted(self.objects.items()) if n.startswith(prefix or "")]

    def delete_blob(self, names):
        for n in [names] if isinstance(names, str) else names:
            self.objects.pop(n, None)


def test_blob_files_mirror_and_fetch(monkeypatch):
    fake = FakeBlob()
    files = store.BlobFiles(config.DATA_DIR, "private")
    monkeypatch.setattr(files, "_blob", lambda: fake)
    d = config.DATA_DIR / "workspace" / "blobtest" / uuid.uuid4().hex[:6]
    (d / "ckpt").mkdir(parents=True)
    (d / "final.npz").write_bytes(b"v1")
    (d / "ckpt" / "ep_0001.npz").write_bytes(b"c1")
    files.push(d)
    rel = d.relative_to(config.DATA_DIR).as_posix()
    assert set(fake.objects) == {f"junction/{rel}/final.npz", f"junction/{rel}/ckpt/ep_0001.npz"}
    # another machine: nothing on disk, files come from the store
    import shutil
    shutil.rmtree(d)
    assert files.pull(d / "final.npz") and (d / "final.npz").read_bytes() == b"v1"
    assert not files.pull(d / "missing.npz")
    assert files.pull_dir(d) and (d / "ckpt" / "ep_0001.npz").read_bytes() == b"c1"
    # a newer upload replaces an old local copy only when asked for a fresh file
    old = time.time() - 3600
    os.utime(d / "final.npz", (old, old))
    fake.objects[f"junction/{rel}/final.npz"] = (b"v2", dt.datetime.now(dt.timezone.utc))
    assert files.pull(d / "final.npz") and (d / "final.npz").read_bytes() == b"v1"
    assert files.pull(d / "final.npz", fresh=True) and (d / "final.npz").read_bytes() == b"v2"
    files.remove(d)
    assert not fake.objects and not d.exists()


@pytest.mark.skipif(not store.SHARED, reason="the job queue needs Postgres (DATABASE_URL)")
def test_job_queue_claims_once_and_carries_commands():
    k = uuid.uuid4().hex[:8]
    kind = f"t_{k}"
    for i in range(3):
        jobqueue.enqueue(kind, f"{k}_{i}", {"i": i})
    a = jobqueue.claim("wa", kind, 2)
    b = jobqueue.claim("wb", kind, 2)
    assert [p["i"] for _, p in a] == [0, 1] and [p["i"] for _, p in b] == [2]   # each job goes to one worker, oldest first
    assert jobqueue.claim("wc", kind, 5) == []
    assert jobqueue.command(f"{k}_0", {"action": "cancel"})
    assert jobqueue.take_commands("wb") == {}
    assert jobqueue.take_commands("wa") == {f"{k}_0": [{"action": "cancel"}]}
    assert jobqueue.take_commands("wa") == {}
    jobqueue.enqueue(kind, f"{k}_q", {})
    assert jobqueue.cancel_queued(f"{k}_q") and not jobqueue.cancel_queued(f"{k}_0")
    jobqueue.finish(f"{k}_0", "done")
    assert not jobqueue.command(f"{k}_0", {"action": "cancel"})
    from trafficsim import db
    with db.conn() as c:                                     # wb went silent two minutes ago
        c.execute("UPDATE jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = %s", (f"{k}_2",))
    assert (kind, f"{k}_2") in jobqueue.reap(120)
    jobqueue.requeue(f"{k}_1")
    assert [j for j, _ in jobqueue.claim("wc", kind, 5)] == [f"{k}_1"]
    with db.conn() as c:
        c.execute("DELETE FROM jobs WHERE kind = %s", (kind,))
