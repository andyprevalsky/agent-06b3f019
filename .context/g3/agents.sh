. /tmp/deploy-env.sh
cd agents && bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- env AGENTS_COVERAGE_CONCURRENCY=4 bash scripts/run-coverage.sh
echo "AGENTS_EXIT=$?"
