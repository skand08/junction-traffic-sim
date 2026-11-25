# One image for the API (a Vercel container service) and the worker (a Vercel daemon).
# Build context: backend/.   Local: docker build -t junction backend/
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# Shared libraries the SUMO binaries and libsumo link against; git fetches the Ingolstadt networks
RUN apt-get update \
 && apt-get install -y --no-install-recommends libx11-6 libxext6 libxrender1 libgl1 libexpat1 libatomic1 git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# RESCO Ingolstadt scenarios (CC BY-NC-SA 4.0), pinned; prepared into networks at build time so start-up is fast
ARG RESCO_COMMIT=101b0b725c21809097b2b1414da6fbec3c0b9e0a
RUN git init -q /opt/resco && cd /opt/resco \
 && git remote add origin https://github.com/UnivOfAlabama-BittleResearchGroup/RESCO \
 && git fetch -q --depth 1 origin "$RESCO_COMMIT" && git checkout -q FETCH_HEAD && rm -rf .git

COPY trafficsim ./trafficsim
COPY examples ./examples
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
 && TRAFFICSIM_DATA=/app/data TRAFFICSIM_RESCO_DIR=/opt/resco/resco_benchmark/environments \
    python -c "from trafficsim import catalog; [catalog.ensure_network(n) for n in catalog.SPECS]" \
 && rm -rf /app/data/workspace

# Writable data lives in /tmp (built networks, working files); everything lasting is in Postgres and Blob
ENV TRAFFICSIM_DATA=/tmp/junction PORT=80
EXPOSE 80
ENTRYPOINT ["/app/docker-entrypoint.sh"]
# The API. The worker runs the same image with: python -m trafficsim.worker
CMD ["sh", "-c", "exec uvicorn trafficsim.api:app --host 0.0.0.0 --port ${PORT:-80} --proxy-headers --forwarded-allow-ips='*'"]
