. /tmp/deploy-env.sh
rc=0
(cd back-end && bash ../scripts/run-deploy-stage eslint --reuse-passed -- bash -c 'xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt') || rc=1; echo "ESLINT_DONE rc=$rc"
(cd back-end && bash ../scripts/run-deploy-stage typescript --reuse-passed -- npx tsc --noEmit) || rc=2; echo "TSC_DONE rc=$rc"
(cd back-end && bash ../scripts/run-deploy-stage backend-structural --reuse-passed -- npm run test:structural) || rc=3; echo "STRUCT_DONE rc=$rc"
bash scripts/run-deploy-stage deploy-command-structural --reuse-passed -- python3 scripts/run-deploy-structural-gates.py --max-workers 4 || rc=4; echo "DEPLOYSTRUCT_DONE rc=$rc"
bash scripts/run-deploy-stage seed-cache-decision --reuse-passed -- bash scripts/tests/seed-cache-decision.test.sh || rc=5; echo "SEEDCACHE_DONE rc=$rc"
bash scripts/run-deploy-stage canonical-seed-whatsapp-content --reuse-passed -- bash scripts/tests/canonical-seed-whatsapp-content.test.sh || rc=6
echo "STATIC_EXIT=$rc"
