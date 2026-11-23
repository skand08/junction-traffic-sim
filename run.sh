#!/bin/bash
# One-step setup and start for Junction on macOS or Linux.
# First run: creates a Python environment, installs SUMO and the backend, downloads the
# Ingolstadt networks (RESCO), then starts the app at http://localhost:8000.
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

# Pick a Python that has SUMO wheels (3.10-3.13 preferred)
PY=""
for c in python3.12 python3.13 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$(command -v "$c")"; break; fi
done
if [ -z "$PY" ]; then echo "Python 3.10+ is required. Install it with: brew install python@3.12"; exit 1; fi
"$PY" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ needed"'
echo "Using $PY ($("$PY" --version))"

cd "$ROOT/backend"
if [ ! -d .venv ]; then "$PY" -m venv .venv; fi
source .venv/bin/activate
python -m pip install -q --upgrade pip
echo "Installing SUMO and backend packages (first run takes a few minutes)..."
pip install -q eclipse-sumo==1.28.0 "fastapi>=0.115" "uvicorn>=0.30" "pydantic>=2.7" "pyproj>=3.6" "scipy>=1.11"
# libsumo is only needed for the pressure-based controller
pip install -q libsumo==1.28.0 || echo "Note: libsumo did not install; pressure-based control will be unavailable."

if [ ! -d data/resco ]; then
  echo "Downloading Ingolstadt networks (RESCO)..."
  git clone -q --depth 1 https://github.com/UnivOfAlabama-BittleResearchGroup/RESCO data/resco \
    || echo "Note: could not download RESCO; only the synthetic networks will work."
fi

if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "Building the frontend..."
  (cd "$ROOT/frontend" && npm install --no-audit --no-fund && npm run build)
fi

PORT="${PORT:-8000}"
echo ""
echo "Junction is starting at http://localhost:$PORT  (press Ctrl+C to stop)"
exec python -m uvicorn trafficsim.api:app --host 127.0.0.1 --port "$PORT"
