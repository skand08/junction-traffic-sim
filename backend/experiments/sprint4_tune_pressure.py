"""Sprint 4: tune pressure-based control on Ingolstadt21 using training seeds only (101-103).
The benchmark uses seeds 1-5, so tuning never sees the evaluation traffic.

Grid 1: minimum green x reach (decision 5 s, starvation guard 90 s).
Grid 2: decision interval x starvation guard (minimum green 10 s, reach 60 m).
Run from backend/:  python experiments/sprint4_tune_pressure.py   (about 7 minutes on one core)
Results of the 25 Nov 2026 run: experiments/sprint4_tune_pressure.json
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from trafficsim import build, runner, scenario as sc  # noqa: E402

SEEDS = (101, 102, 103)
GRID = [dict(min_green_s=mg, reach_m=r, decision_s=5, max_wait_s=90) for mg in (5, 10, 15) for r in (30, 60, 100)] + \
       [dict(min_green_s=10, reach_m=60, decision_s=d, max_wait_s=w) for d, w in ((3, 90), (10, 90), (5, 60), (5, 120))]

if __name__ == "__main__":
    out = pathlib.Path("/tmp/sprint4_tune")
    b = build.build(sc.Scenario(base_network="ingolstadt21", name="tune"), out / "build")
    base = dict(net_file=str(b.net_file), demand_file=str(b.demand_file), tls_additional=None, begin=b.begin, end=b.end,
                scale=1.0, controller="max_pressure", depart_jitter_s=300)
    rows = []
    for p in GRID:
        runs = [runner.run_seed(dict(base, seed=s, pressure=p, out_dir=str(out / f"{len(rows)}_{s}"))) for s in SEEDS]
        tt = [r["kpi"]["mean_travel_time_s"] for r in runs]
        rows.append(dict(settings=p, travel_time_s=[round(x, 1) for x in tt], mean=round(sum(tt) / len(tt), 1),
                         teleports=[r["kpi"]["teleports"] for r in runs]))
        print(rows[-1], flush=True)
    pathlib.Path(__file__).with_suffix(".json").write_text(json.dumps(rows, indent=1))
