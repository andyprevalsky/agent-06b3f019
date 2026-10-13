. /home/boxes/rose/.context/g3/env.sh
cd back-end
bash ../scripts/run-deploy-stage eslint --reuse-passed -- bash -c 'xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt'; e1=$?
bash ../scripts/run-deploy-stage typescript --reuse-passed -- npx tsc --noEmit; e2=$?
bash ../scripts/run-deploy-stage backend-structural --reuse-passed -- npm run test:structural; e3=$?
echo "STATIC_DONE eslint=$e1 tsc=$e2 structural=$e3"
