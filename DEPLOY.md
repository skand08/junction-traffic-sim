# Deploying Junction on Vercel with Postgres

This guide puts Junction online for a team of about 10–20 people, with room to grow. Everything runs in one
Vercel project. Data lives in Postgres (Neon) and Vercel Blob.

## What runs where

| Part | Vercel product | What it does |
| --- | --- | --- |
| `web` | Services (beta): Vite static build from `frontend/` | The app in the browser |
| `api` | Services: container from `backend/Dockerfile`, serves `/api/*` | FastAPI. Reads and writes data, checks edits, queues work. Stateless; scales with traffic, to zero when idle |
| `worker` | Daemons (beta): the same image, `python -m trafficsim.worker` | Always on. Runs simulations, trainings, benchmarks, calibrations and live views that the API queued |
| Database | Neon Postgres (Vercel Marketplace) | Scenarios, runs, simulations, agents, benchmarks, calibrations, accounts, training logs, the job queue and live-view frames |
| Files | Vercel Blob, private store | Imported networks, demand fitted to traffic counts, trained models |

**How the parts talk.** The browser only talks to `/api`. The API writes a job row to Postgres. A worker claims
it with `SELECT … FOR UPDATE SKIP LOCKED`, runs it, and writes progress back. Cancel, pause and live controls
go into the job row, and the worker picks them up within half a second. Live frames travel through the
`live_frames` table. Nothing needs to be held in memory between requests, so API instances can come and go.

**Locally** nothing changes. Without `DATABASE_URL` the app uses JSON files under `backend/data/workspace`
and runs jobs in its own process, exactly as before. `./run.sh` still works.

## Before you start

- A Vercel account. Pro is recommended. Hobby can be used for a trial, with these limits:
  - The worker is limited to 1–2 GiB.
  - Daemons have monthly CPU and memory quotas. When they run out, the worker stops until the next month.
  - Requests are capped at 300 s.
- Vercel CLI 65.8 or later: `npm i -g vercel`, then `vercel login`.
- The GitHub repository connected to Vercel. Previews are built for pull requests and production for `main`.
- Locally: Python 3.13 with `pip install -r backend/requirements.txt`. You need this to manage accounts and to
  copy existing data.

## One-time setup

All commands run from the repository root unless noted.

### 1. Create and link the project

```bash
vercel link            # create the project; keep the Root Directory as the repository root
```

The Root Directory must stay at the repository root. Daemons do not work in projects whose root is a subfolder,
and `vercel.json` already points each part at its folder.

### 2. Add the database (Neon)

```bash
vercel install neon    # choose region AWS us-east-1 (next to iad1, where the worker runs)
```

This creates the database and adds `DATABASE_URL` (the pooled connection, which is the one to use) and related
variables to the project. If the integration was installed with a prefix, the app also reads
`TRAFFIC_DATABASE_URL`; for another prefix, set `JUNCTION_DB_ENV_PREFIX` to it (for example `MYAPP_`). The tables are created automatically on the first start; see [Database changes](#database-changes).

Previews should not write into production data. In the Neon integration settings, turn on a **database branch
for each preview deployment**. Alternatively, set a separate `DATABASE_URL` for the Preview environment.

### 3. Add file storage (Blob)

```bash
vercel blob create-store junction-files --access private
```

Connect the store to the project when the CLI asks, or later under **Storage → junction-files → Connect
Project**. On Vercel, the app then signs in with the project's OIDC token and `BLOB_STORE_ID`. To use the store
from your own machine (a local worker, copying data), also copy the store's read-write token into
`BLOB_READ_WRITE_TOKEN` in your local `.env` file.

### 4. Set the environment variables

`.env.example` lists every variable with its meaning. The ones to set by hand:

```bash
vercel env add JUNCTION_EXECUTION production       # value: queue
vercel env add JUNCTION_EXECUTION preview          # value: queue
vercel env add JUNCTION_SECRET production          # value: output of `openssl rand -hex 32`
vercel env add JUNCTION_SECRET preview             # a different random value
vercel env add JUNCTION_ADMIN_EMAIL production     # your email: the first account
vercel env add JUNCTION_ADMIN_PASSWORD production  # its password (change it after signing in)
```

- `JUNCTION_SECRET` turns sign-in on. Without it, anyone with the URL can use the app and run simulations at
  your cost.
- Changing `JUNCTION_SECRET` signs everyone out.

### 5. Deploy

Push a branch and open a pull request: Vercel builds a preview. Merging into `main` deploys production. To
deploy by hand instead, run `vercel deploy --prod`.

The first build takes several minutes. It installs SUMO and prepares the Ingolstadt networks in the image. Later
builds reuse the cached layers.

### 6. Check it

1. Open `https://<your-domain>/api/health`. Under `storage` it should show `postgres`, `blob` and `queue`.
2. In the dashboard, open **Daemons → worker**. One instance should be running. From the CLI:
   `vercel daemons ls` and `vercel daemons inspect worker`.
3. Sign in with the admin account. Run a small simulation (Ingolstadt 7, 2 runs). It should finish within a
   minute.

### 7. Add your team

Accounts are managed from your machine against the production database:

```bash
vercel env pull .env.production.local --environment=production
cd backend
set -a; . ../.env.production.local; set +a
python -m trafficsim.auth add alice@example.org --name "Alice"      # prints a generated password
python -m trafficsim.auth add bob@example.org --admin
python -m trafficsim.auth list
python -m trafficsim.auth passwd alice@example.org                  # new password; her sessions end
python -m trafficsim.auth remove bob@example.org                    # his sessions end at once
```

Send each person their password. They can change it later through `POST /api/auth/password`; there is no
screen for this yet.

Everyone signed in shares one workspace and can see and change all scenarios, runs and agents.

### 8. Bring existing local data (optional)

To bring over scenarios, runs, agents and benchmarks made on a laptop:

```bash
cd backend
set -a; . ../.env.production.local; set +a      # DATABASE_URL, plus BLOB_READ_WRITE_TOKEN for model files
python -m trafficsim.db import-workspace        # reads backend/data/workspace; safe to run twice
```

## Environment variables

These are the main variables. `.env.example` has the full list with defaults.

| Variable | Set by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Neon integration | Postgres. Unset: local JSON files |
| `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN` | Blob store connection / you | File storage. Unset: local disk |
| `JUNCTION_EXECUTION` | you: `queue` | The API queues work and the worker runs it. `local`: the API runs jobs itself (one machine only) |
| `JUNCTION_SECRET` | you | Turns sign-in on and signs session cookies |
| `JUNCTION_ADMIN_EMAIL`, `JUNCTION_ADMIN_PASSWORD` | you | First account, created on start if none exists |
| `JUNCTION_WORKER_RUNS`, `…_TRAININGS`, `…_BENCHMARKS`, `…_CALIBRATIONS`, `…_LIVE` | optional | Jobs at once per worker instance |
| `TRAFFICSIM_WORKERS` | optional | SUMO processes at once per job. Default: CPU count − 1 |
| `JUNCTION_WORKER_IDLE_POLL_S` | optional | How often an idle worker checks for work (see costs below) |
| `JUNCTION_CONTROLLER_HOSTS` | optional | Hosts that external signal controllers may run on. Only these can be called |

## Workflows

- **`.github/workflows/ci.yml`** runs on every pull request and every push to `main`:
  - The backend tests, twice: once on local files, and once on Postgres with a real worker process (the
    deployed layout).
  - The frontend type check and build.
  - A container build check: the image starts and answers `/api/health`.
- **Vercel's Git integration** deploys:
  - A preview for each pull request.
  - Production when a pull request merges into `main`.

  Branch protection on `main` with the CI checks required keeps a failing build from reaching production.
- **`.github/workflows/db-migrate.yml`** applies database changes by hand (Actions → Database migrate). It needs
  the repository secret `PRODUCTION_DATABASE_URL`, set to Neon's direct (unpooled) connection string. You
  rarely need it, because the API and the worker apply missing migrations on start.

### Database changes

`backend/trafficsim/db.py` holds the schema as a numbered list. To change it, add a new entry at the end; never
edit an entry that has shipped. On start, each process applies the missing entries under a Postgres advisory
lock, so concurrent starts are safe.

During a deploy, the old and new worker run side by side for a moment. Keep each change backward compatible:
add columns and tables, and drop old ones in a later release.

### Previews

Daemons run only for production, so a preview has no worker. In a preview you can:

- browse;
- edit scenarios;
- see geometry and checks.

Simulations stay at "Waiting to start". To run them, start a worker on your machine against the preview's
database:

```bash
vercel env pull .env.preview.local --environment=preview
cd backend && set -a; . ../.env.preview.local; set +a
python -m trafficsim.worker
```

## Running the deployed layout locally

`docker compose up --build` starts Postgres, the API (on port 8000) and a worker. They share a data volume
instead of Blob. Then run `cd frontend && npm run dev` and open http://localhost:5173. To test sign-in, set
`JUNCTION_SECRET`, `JUNCTION_ADMIN_EMAIL` and `JUNCTION_ADMIN_PASSWORD` in your shell first.

To run the test suite against Postgres with a worker:

```bash
cd backend
DATABASE_URL=postgresql://junction:junction@localhost:5432/junction_test \
JUNCTION_EXECUTION=queue JUNCTION_TEST_RESET_DB=1 python -m pytest -q   # empties that database first
```

## Scaling

Twenty people mostly editing scenarios and reading results is a light load. The limit is simulation CPU, which
sits in the worker.

- **More simulations at once.** Raise `instances` in `vercel.json` (for example `"iad1": 2`). Or give the worker
  `"memory": "4Gi"` (2 vCPU) and set `TRAFFICSIM_WORKERS=2` and `JUNCTION_WORKER_RUNS=3`.
  - Workers share the queue safely, and each job runs on exactly one worker.
  - Scaling overrides from the dashboard (`vercel daemons scale worker iad1=3`) take precedence over
    `vercel.json` until you clear them.
- **API.** Vercel adds API instances as traffic grows; nothing to configure.
- **Database.** Neon scales compute automatically. Each API instance and worker opens at most
  `DATABASE_POOL_MAX` connections (default 5) through Neon's pooler. Lists read whole JSON documents from one
  table; that is fine into the thousands of runs. Beyond that, add indexed columns for list filters in a new
  migration.
- **Files.** Blob needs nothing.

## Costs and limits to know

- **Beta products.** Services and Daemons are in beta. The worker runs only for production deployments.
- **Database wake-ups.** The worker checks the queue every 2 s, and every 10 s after 10 idle minutes. This
  keeps the Neon database awake around the clock, so plan for always-on compute rather than the free tier's
  hours. Setting `JUNCTION_WORKER_IDLE_POLL_S=360` lets Neon sleep when nobody works. The cost: the first job
  after a quiet spell can wait up to 6 minutes to start.
- **Uploads are limited to 4.5 MB** on Vercel functions. Bigger OpenStreetMap or SUMO files fail to upload.
  Use **Import an area** (fetched by the server) or a smaller extract.
- **Requests are capped at 300 s** (800 s on Pro if raised). The following run inside the request itself:
  - large area imports;
  - RL environment exports with many runs;
  - the network check on very large networks.
- **Live views send about 4 frames a second each through Postgres.** Each person can have 2 live views open;
  starting a third stops their oldest. A live view nobody watches for 5 minutes is stopped.
- **When the worker restarts** (a deploy or scaling down), it has up to 4 minutes to finish.
  - Unfinished runs, benchmarks and calibrations go back to the queue and start again on the next worker.
  - Trainings stop after saving their model.
  - Live views end.
- **Built-in networks.** The image bundles the RESCO Ingolstadt scenarios, which are licensed CC BY-NC-SA 4.0
  (non-commercial use).

## Troubleshooting

| You see | Check |
| --- | --- |
| Simulations stay at "Waiting to start" | Is the worker running? Look in the dashboard under Daemons, or run `vercel daemons ls`. Check its logs (filter by source `daemon`). Previews have no worker |
| Every page asks to sign in again | `JUNCTION_SECRET` changed, or the account was removed or got a new password |
| `/api/health` shows `files: local` on Vercel | The Blob store is not connected to this environment. Connect it, then redeploy |
| Blob errors mentioning credentials | Add the store's `BLOB_READ_WRITE_TOKEN` as an environment variable and redeploy |
| "too many connections" from Postgres | `DATABASE_URL` must be Neon's pooled (`-pooler`) string. Lower `DATABASE_POOL_MAX` if needed |
| A trained agent's model is "not found" on another page | The Blob store was missing while it trained; the model stayed on that worker's disk. Train it again with Blob connected |
