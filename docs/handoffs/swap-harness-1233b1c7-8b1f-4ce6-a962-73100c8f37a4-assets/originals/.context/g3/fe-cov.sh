. /home/boxes/rose/.context/g3/env.sh
cd front-end && bash ../scripts/run-deploy-stage frontend-coverage-blackbox --reuse-passed -- npm run test:coverage -- --maxWorkers=3; echo "FE_COV_DONE exit=$?"
