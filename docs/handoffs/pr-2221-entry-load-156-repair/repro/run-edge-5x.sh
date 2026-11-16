#!/bin/bash
# Runs the cached-immutable test N times, each through a fresh edge-sim (one real edge 404 per run).
cd /home/boxes/rose/front-end
L=$(grep -n "^test('an entry 404 cached as immutable" tests-e2e/entry-load-recovery.spec.ts | cut -d: -f1)
echo "HEAD $(git rev-parse --short HEAD) test line $L"
for i in $(seq 1 ${N:-5}); do
  node /var/tmp/el156/repro/edge-sim.mjs > /var/tmp/el156/repro/sim-$i.log 2>&1 & sim=$!
  until grep -q listening /var/tmp/el156/repro/sim-$i.log; do sleep 0.2; done
  res=$(FRONTEND_URL=http://127.0.0.1:4517 timeout 200 npx playwright test tests-e2e/entry-load-recovery.spec.ts:$L --reporter=line 2>&1 | grep -E "passed|failed|Received" | tr '\n' ' ')
  kill $sim; wait $sim 2>/dev/null
  echo "run $i: $res| edge-404s=$(grep -c edge-404 /var/tmp/el156/repro/sim-$i.log)"
done
rm -rf test-results
