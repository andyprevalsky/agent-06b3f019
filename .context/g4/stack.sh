. /tmp/deploy-env.sh
DEPLOY_ROOT="$(git rev-parse --show-toplevel)"
. "$DEPLOY_ROOT/scripts/lib/workspace-env.sh"
. "$DEPLOY_ROOT/scripts/lib/deploy-local-env.sh"
configure_deploy_local_env || exit 1
env | grep -E '^(SMOKE_|TEMPORAL_TASK_QUEUE|SEMANTIC_QUEUE)' > .context/g4/stack.env
BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=8 TRACE_ARCHIVE_ENABLED=0 \
  bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
echo "STACK_EXIT=$?" >> .context/g4/stack.status
