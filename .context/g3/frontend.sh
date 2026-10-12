. /tmp/deploy-env.sh
cd front-end && bash ../scripts/run-deploy-stage frontend-coverage-blackbox --reuse-passed -- npm run test:coverage -- --maxWorkers=3
echo "FRONTEND_EXIT=$?"
