. /tmp/deploy-env.sh
cd back-end && bash ../scripts/run-deploy-stage backend-coverage-blackbox --reuse-passed -- env BLACKBOX_TEST_CONCURRENCY=4 CONTRACT_TEST_CONCURRENCY=4 BACKEND_UNIT_CONCURRENCY=3 npm run test:coverage
echo "BACKEND_EXIT=$?"
