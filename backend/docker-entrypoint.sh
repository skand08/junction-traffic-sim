#!/bin/sh
# Make the built-in networks prepared at image build time visible under the writable data folder, then run.
set -e
: "${TRAFFICSIM_DATA:=/tmp/junction}"
mkdir -p "$TRAFFICSIM_DATA/networks"
for d in "${JUNCTION_PREPARED_NETWORKS:-/app/data/networks}"/*/; do
  n=$(basename "$d")
  [ -e "$TRAFFICSIM_DATA/networks/$n" ] || ln -s "${d%/}" "$TRAFFICSIM_DATA/networks/$n"
done
exec "$@"
