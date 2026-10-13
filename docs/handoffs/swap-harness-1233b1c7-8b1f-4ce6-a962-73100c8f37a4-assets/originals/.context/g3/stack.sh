. /home/boxes/rose/.context/g3/env.sh
. scripts/lib/workspace-env.sh
. scripts/lib/deploy-local-env.sh
configure_deploy_local_env
BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=8 TRACE_ARCHIVE_ENABLED=0 \
  bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
echo "STACK_EXIT=$?"
