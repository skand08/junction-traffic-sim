"""Simulations: one reference scenario and one or more alternatives, all run with the same seeds.

A simulation is stored as the document "simulations/<id>.json" (store.py) and points at one run per scenario
(runs are the existing per-scenario jobs). Comparisons are always alternative vs reference. The headline
numbers of a finished simulation are cached in "simulations/summaries/<id>.json".
"""
import time
import uuid

from . import store


def save(sim: dict) -> dict:
    store.docs.write(f"simulations/{sim['id']}.json", sim)
    return sim


def new(name: str, network: str, reference: dict, alternatives: list, seeds: list, depart_jitter_s: float) -> dict:
    return save(dict(id=uuid.uuid4().hex[:10], name=name, network=network, created=time.time(),
                     seeds=seeds, depart_jitter_s=depart_jitter_s, reference=reference, alternatives=alternatives))


def load(sid: str) -> dict:
    d = store.docs.read(f"simulations/{sid}.json") if "/" not in sid else None
    if d is None:
        raise KeyError(f"simulation '{sid}' not found")
    return d


def list_all() -> list:
    out = [d for _, d in store.docs.items("simulations")]      # summaries/ is a subfolder, not matched
    return sorted(out, key=lambda s: s.get("created", 0), reverse=True)


def summary(sid: str):
    return store.docs.read(f"simulations/summaries/{sid}.json")


def save_summary(sid: str, data: dict):
    store.docs.write(f"simulations/summaries/{sid}.json", data)


def delete(sid: str):
    if "/" not in sid:
        store.docs.delete(f"simulations/{sid}.json")
        store.docs.delete(f"simulations/summaries/{sid}.json")
