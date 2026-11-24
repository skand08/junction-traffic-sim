"""Simulations: one reference scenario and one or more alternatives, all run with the same seeds.

A simulation is stored as WORKSPACE_DIR/simulations/<id>.json and points at one run per scenario
(runs are the existing per-scenario jobs). Comparisons are always alternative vs reference.
"""
import json
import time
import uuid

from . import config

SIM_DIR = config.WORKSPACE_DIR / "simulations"
SIM_DIR.mkdir(parents=True, exist_ok=True)


def save(sim: dict) -> dict:
    tmp = SIM_DIR / f"{sim['id']}.json.tmp"
    tmp.write_text(json.dumps(sim, indent=1))
    tmp.replace(SIM_DIR / f"{sim['id']}.json")
    return sim


def new(name: str, network: str, reference: dict, alternatives: list, seeds: list, depart_jitter_s: float) -> dict:
    return save(dict(id=uuid.uuid4().hex[:10], name=name, network=network, created=time.time(),
                     seeds=seeds, depart_jitter_s=depart_jitter_s, reference=reference, alternatives=alternatives))


def load(sid: str) -> dict:
    f = SIM_DIR / f"{sid}.json"
    if "/" in sid or not f.exists():
        raise KeyError(f"simulation '{sid}' not found")
    return json.loads(f.read_text())


def list_all() -> list:
    out = [json.loads(f.read_text()) for f in SIM_DIR.glob("*.json")]   # summaries/ is a subfolder, not matched
    return sorted(out, key=lambda s: s.get("created", 0), reverse=True)


def delete(sid: str):
    for f in (SIM_DIR / f"{sid}.json", SIM_DIR / "summaries" / f"{sid}.json"):
        if f.exists():
            f.unlink()
