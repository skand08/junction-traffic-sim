"""Aggregate seed results and compare two runs (before/after).

Comparison is paired by seed (same seeds for both runs = common random numbers), following the
FHWA approach of comparing alternatives with repeated runs and a confidence interval on the
difference of means.
"""
import math
from statistics import mean, stdev

from scipy import stats

# KPI -> (label, unit, lower_is_better)
KPI_INFO = {
    "mean_travel_time_s": ("Average travel time", "s", True),
    "mean_delay_s": ("Average delay per trip", "s", True),
    "mean_waiting_s": ("Average time stopped", "s", True),
    "mean_stops": ("Average stops per trip", "", True),
    "completed_trips": ("Trips completed", "", False),
    "unfinished_trips": ("Trips not finished", "", True),
    "teleports": ("Gridlock removals (teleports)", "", True),
    "total_delay_veh_h": ("Total delay", "veh·h", True),
    # data-quality counts (reported, not used in the verdict)
    "late_departures": ("Trips starting after the demand window (left out)", "", True),
    "not_inserted": ("Trips that never entered the network", "", True),
    "removed": ("Vehicles removed by the simulator", "", True),
}


def _ci(values, conf=0.95):
    v = [x for x in values if x is not None]
    if not v:
        return None, None, None
    m = mean(v)
    if len(v) < 2:
        return m, None, None
    half = float(stats.t.ppf(0.5 + conf / 2, len(v) - 1)) * stdev(v) / math.sqrt(len(v))
    return float(m), float(m - half), float(m + half)


def aggregate(seed_results: list) -> dict:
    kpis = {}
    for k, (label, unit, lower) in KPI_INFO.items():
        vals = [r["kpi"].get(k) for r in seed_results]
        m, lo, hi = _ci(vals)
        kpis[k] = dict(label=label, unit=unit, lower_is_better=lower, mean=m, ci_low=lo, ci_high=hi,
                       values=vals)
    edges = {}
    ids = set().union(*[r["edges"].keys() for r in seed_results]) if seed_results else set()
    for eid in ids:
        rows = [r["edges"].get(eid) for r in seed_results if r["edges"].get(eid)]
        sp = [x["speed_kmh"] for x in rows if x["speed_kmh"] is not None]
        dl = [x["delay_per_veh_s"] for x in rows if x["delay_per_veh_s"] is not None]
        edges[eid] = dict(speed_kmh=round(mean(sp), 2) if sp else None,
                          delay_per_veh_s=round(mean(dl), 2) if dl else None,
                          volume=round(mean(x["volume"] for x in rows), 1))
    return dict(kpis=kpis, edges=edges, seeds=[r["seed"] for r in seed_results],
                wall_s=round(sum(r["wall_s"] for r in seed_results), 1))


def _confidence(share_better: float, ci_excludes_zero: bool, n: int) -> str:
    if n < 5:
        return "low"
    if ci_excludes_zero and share_better >= 0.9:
        return "high"
    if ci_excludes_zero or share_better >= 0.75:
        return "medium"
    return "low"


def compare(a: dict, b: dict, a_seeds: list, b_seeds: list, edge_limits: dict | None = None) -> dict:
    """a = before, b = after. Both are seed-result lists; only common seeds are paired."""
    ia = {r["seed"]: r for r in a}
    ib = {r["seed"]: r for r in b}
    common = sorted(set(ia) & set(ib))
    out = dict(paired_seeds=common, kpis={}, edges={})
    for k, (label, unit, lower) in KPI_INFO.items():
        pairs = [(ia[s]["kpi"].get(k), ib[s]["kpi"].get(k)) for s in common]
        pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
        if not pairs:
            continue
        diffs = [y - x for x, y in pairs]
        m, lo, hi = _ci(diffs)
        base = mean(x for x, _ in pairs)
        better = [(d < 0) if lower else (d > 0) for d in diffs]
        ties = sum(1 for d in diffs if d == 0)
        share = sum(better) / len(diffs)
        excl = lo is not None and (hi < 0 or lo > 0)
        if all(d == 0 for d in diffs):
            verdict = "no change"
        else:
            improved = (m < 0) if lower else (m > 0)
            verdict = "better" if improved else "worse"
        out["kpis"][k] = dict(
            label=label, unit=unit, lower_is_better=lower, before=base, after=mean(y for _, y in pairs),
            diff=m, diff_ci_low=lo, diff_ci_high=hi, pct_change=(100 * m / base) if base else None,
            share_seeds_better=share, ties=ties, n=len(diffs), significant=excl, verdict=verdict,
            pairs=[[s, ia[s]["kpi"].get(k), ib[s]["kpi"].get(k)] for s in common],
            confidence=_confidence(share if verdict == "better" else 1 - share - ties / len(diffs),
                                   excl, len(diffs)))
    ea, eb = _edge_means(a), _edge_means(b)
    for eid in set(ea) | set(eb):
        x, y = ea.get(eid), eb.get(eid)
        if not x or not y:
            out["edges"][eid] = dict(change="new" if y else "removed")
            continue
        dd = None if x["delay"] is None or y["delay"] is None else round(y["delay"] - x["delay"], 2)
        ds = None if x["speed"] is None or y["speed"] is None else round(y["speed"] - x["speed"], 2)
        change = "unchanged"
        if dd is not None and abs(dd) >= max(3.0, 0.15 * (x["delay"] or 0)):
            change = "worse" if dd > 0 else "better"
        out["edges"][eid] = dict(delay_change_s=dd, speed_change_kmh=ds,
                                 volume_change=round(y["volume"] - x["volume"], 1), change=change)
    return out


def _edge_means(results):
    agg = aggregate(results)["edges"]
    return {k: dict(delay=v["delay_per_veh_s"], speed=v["speed_kmh"], volume=v["volume"]) for k, v in agg.items()}


def headline(cmp: dict) -> str:
    """One plain-language sentence for students and planners."""
    k = cmp["kpis"].get("mean_travel_time_s")
    if not k:
        return "No comparable trips."
    n = k["n"]
    pct = k["pct_change"] or 0
    if k["verdict"] == "no change" or abs(k["diff"]) < 0.05:
        return "Average travel time did not change measurably."
    direction = "shorter" if k["diff"] < 0 else "longer"
    wins = round(k["share_seeds_better"] * n) if k["verdict"] == "better" else round((1 - k["share_seeds_better"]) * n)
    sure = {"high": "a consistent result", "medium": "a fairly consistent result",
            "low": "not a clear result: random variation could explain it"}[k["confidence"]]
    size = abs(pct)
    if size < 2:
        lead = f"Average travel time barely changed: {size:.1f}% {direction} ({abs(k['diff']):.1f} s per trip)."
    else:
        lead = f"Average travel time is {size:.1f}% {direction} ({abs(k['diff']):.1f} s per trip)."
    return f"{lead} It was {direction} in {wins} of {n} repeated runs, {sure}."
