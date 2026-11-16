#!/usr/bin/env bash
# unitpass.sh <port> <label> [files]: gate-parameter unit pass (concurrency 6, pool 16) against the throwaway cluster
set -u
cd /home/boxes/rose/back-end
OUT=/var/tmp/rca-restart/$2; mkdir -p "$OUT"
/var/tmp/rca-restart/bin/sampler.sh "$1" "$OUT/conns.txt" & S=$!
env -u NODE_V8_COVERAGE BACKEND_UNIT_DATABASE_URL="postgresql://postgres:postgres@localhost:$1/victoria?connection_limit=16&pool_timeout=30&connect_timeout=15" \
  BACKEND_UNIT_CONCURRENCY=6 BACKEND_UNIT_EXCLUDE_FILES=rose-ui-cli-browser.test.ts \
  ${3:+BACKEND_UNIT_TEST_FILES=$3} BACKEND_UNIT_RESULTS_FILE="$OUT/results.json" \
  node --import tsx scripts/run-unit-tests.ts > "$OUT/units.log" 2>&1
echo "exit $?" > "$OUT/exit"
kill $S
# copy only the logs of the files this run selected (coverage/unit-run keeps older runs' logs)
mkdir -p "$OUT/unit-run"
for f in ${3//,/ }; do cp "coverage/unit-run/${f%.test.ts}.log" "$OUT/unit-run/" 2>/dev/null; done
