# Junction — traffic scenario lab

A web app where planners and students change a road network (lanes, speed limits, closures,
turn bans, signal timing, signal control type), run a microscopic traffic simulation (Eclipse SUMO),
and compare the proposal with the current situation, including how consistent the result is
across repeated runs.

## Quick start (local)

Requirements: Python 3.11+ (tested on 3.13), Node 20+ (tested on 22), git.

```bash
# 1. Backend
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt                         # installs SUMO 1.28 via the eclipse-sumo wheel

# 2. Real-world networks (Ingolstadt) come from the RESCO benchmark
git clone --depth 1 https://github.com/UnivOfAlabama-BittleResearchGroup/RESCO data/resco

# 3. Frontend
cd ../frontend
npm install
npm run build            # output in frontend/dist, served by the backend

# 4. Run
cd ../backend
uvicorn trafficsim.api:app --port 8000
# open http://localhost:8000
```

For frontend development with hot reload, run `npm run dev` in `frontend/`
(it proxies `/api` to port 8000) and open http://localhost:5173.

Synthetic networks are generated on first use. Ingolstadt networks need step 2.

## How it works

| Part | What it does |
| --- | --- |
| `backend/trafficsim/catalog.py` | Base networks: synthetic grid and corridor (netgenerate + randomTrips), RESCO Ingolstadt 7 and 21 |
| `scenario.py` | Scenario model (base network, edits, demand scale, controller) and export/import bundles |
| `build.py` | Applies edits as netconvert plain-XML patches; signal timing and controller via an additional file; checks that trips can still reach their destinations |
| `runner.py` | Runs one seed: fixed and actuated control natively in SUMO, pressure-based control through libsumo; extracts KPIs and per-road statistics |
| `jobs.py` | Background jobs: seeds in parallel worker processes, with progress |
| `analysis.py` | Means with 95% confidence intervals; paired before/after comparison by seed; plain-language headline |
| `api.py` | FastAPI endpoints; also serves the built frontend |
| `frontend/src` | React + MapLibre + deck.gl map (click roads and signals), edit panels, run progress, results |

Comparisons use the same seeds for both options (common random numbers), so differences come
from the change, not from luck. A result is "consistent" when the proposal wins in at least 9 of
10 runs and the 95% interval of the difference excludes zero.

### How results are measured

- A trip belongs to the demand hour if its **planned** start time falls in the hour. Cars that
  queue before they can enter the network are still counted.
- **Travel time and delay run from the planned start**, so time spent queuing to enter counts.
  (Before measurement version 2 this time was invisible, and trips that could only enter after
  the hour were silently dropped, which made congested options look better.)
- Trips whose car **teleported** (stuck for 5 minutes and moved ahead by SUMO; read from SUMO's log)
  are left out of travel time and counted separately. Unfinished and removed trips are counted
  separately too. The results page shows all of these before the verdict.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRAFFICSIM_DATA` | `backend/data` | Networks, scenarios, builds and runs |
| `TRAFFICSIM_RESCO_DIR` | `$TRAFFICSIM_DATA/resco/resco_benchmark/environments` | RESCO checkout |
| `TRAFFICSIM_WORKERS` | CPU count − 1 | Parallel simulations |
| `TRAFFICSIM_CORS` | `*` | Allowed origins for the API |

Run the tests with `cd backend && pytest -q`.

## Known limitations (sprint 1 of the app)

- Pressure-based control is experimental: on closely spaced, clustered junctions
  (Ingolstadt21) it causes jams and teleports. The results panel warns when this happens.
- Changing lanes or banning a turn at a signal regenerates that signal's plan with default timings
  (the app shows a warning).
- Adding a lane widens the whole road; the extra lane is reachable by lane changing.
- One simulated hour of demand plus 30 minutes to let trips finish; traffic follows SUMO's
  lane-based car-following model, not lane-less mixed traffic.
- Ingolstadt networks: RESCO/InTAS, CC BY-NC-SA 4.0 (non-commercial). Basemap © OpenStreetMap
  contributors, tiles by OpenFreeMap.
