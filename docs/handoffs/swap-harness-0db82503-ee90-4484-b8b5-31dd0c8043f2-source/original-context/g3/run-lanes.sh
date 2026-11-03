#!/usr/bin/env bash
cd /home/boxes/rose
export ROSE_USE_SYSTEM_PG=true; source .cloud-env
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export PATH="$HOME/.fly/bin:/home/boxes/rose/agents/venv/bin:$PATH"
G=.context/g3
( cd back-end && bash ../scripts/run-deploy-stage eslint --reuse-passed -- bash -c 'xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt' > ../$G/eslint.log 2>&1; echo "exit=$?" >> ../$G/eslint.log ) &
( cd back-end && bash ../scripts/run-deploy-stage typescript --reuse-passed -- npx tsc --noEmit > ../$G/tsc.log 2>&1; echo "exit=$?" >> ../$G/tsc.log ) &
( cd back-end && bash ../scripts/run-deploy-stage backend-structural --reuse-passed -- npm run test:structural > ../$G/structural.log 2>&1; echo "exit=$?" >> ../$G/structural.log ) &
( bash scripts/run-deploy-stage deploy-command-structural --reuse-passed -- python3 scripts/run-deploy-structural-gates.py --max-workers 4 > $G/deploy-structural.log 2>&1; echo "exit=$?" >> $G/deploy-structural.log
  bash scripts/run-deploy-stage seed-cache-decision --reuse-passed -- bash scripts/tests/seed-cache-decision.test.sh > $G/seed-cache.log 2>&1; echo "exit=$?" >> $G/seed-cache.log
  bash scripts/run-deploy-stage canonical-seed-whatsapp-content --reuse-passed -- bash scripts/tests/canonical-seed-whatsapp-content.test.sh > $G/whatsapp-seed.log 2>&1; echo "exit=$?" >> $G/whatsapp-seed.log ) &
( cd back-end && bash ../scripts/run-deploy-stage backend-coverage-blackbox --reuse-passed -- env BLACKBOX_TEST_CONCURRENCY=3 CONTRACT_TEST_CONCURRENCY=3 BACKEND_UNIT_CONCURRENCY=2 npm run test:coverage > ../$G/backend-coverage.log 2>&1; echo "exit=$?" >> ../$G/backend-coverage.log ) &
( cd agents && bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- env AGENTS_COVERAGE_CONCURRENCY=3 bash scripts/run-coverage.sh > ../$G/agents-coverage.log 2>&1; echo "exit=$?" >> ../$G/agents-coverage.log ) &
wait
echo ALL_DONE > $G/done
