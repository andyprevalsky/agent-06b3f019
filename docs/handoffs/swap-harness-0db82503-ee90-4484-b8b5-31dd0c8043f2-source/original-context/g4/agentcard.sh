#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
BENCHMARK_SKIP_WMH_BUILD=1 BENCHMARK_ATTEMPT_SUITE=predeploy BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY=0 BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=1 \
  bash scripts/run-deploy-stage agentcard-lifecycle -- \
  bash scripts/run-bench --local agent-payment-test-shop agent-payment-setup-resume agent-payment-idempotent-abandonment agent-payment-abandonment --bootstrap --max-concurrency 1 --no-dashboard > .context/g4/agentcard-2.log 2>&1; echo "exit=$?" >> .context/g4/agentcard-2.log
