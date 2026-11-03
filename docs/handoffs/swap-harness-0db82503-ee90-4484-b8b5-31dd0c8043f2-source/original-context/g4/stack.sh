#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
. scripts/lib/workspace-env.sh
. scripts/lib/deploy-local-env.sh
configure_deploy_local_env
env | grep -E "^(SMOKE_|TEMPORAL_TASK_QUEUE|LOCAL_DB_PORT)" > .context/g4/stack.env
BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=8 TRACE_ARCHIVE_ENABLED=0 \
  bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
echo "exit=$?" > .context/g4/stack.exit
