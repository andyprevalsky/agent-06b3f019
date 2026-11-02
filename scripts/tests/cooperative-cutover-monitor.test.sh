#!/usr/bin/env bash
# Keep /deploy's post-merge proof bound to the managed job and its original bank.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEPLOY="$ROOT/.claude/commands/deploy.md"
MONITOR="$ROOT/back-end/scripts/monitor-cooperative-cutover.ts"
DRIVER="$ROOT/scripts/worker_pool_cutover.py"
WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
fail() { echo "FAIL: $*" >&2; exit 1; }
require_text() { grep -Fq -- "$2" "$1" || fail "$3"; }
require_text "$MONITOR" '--job-id' 'monitor must select the exact durable deployment'
require_text "$MONITOR" '--verify' 'monitor must provide an explicit verification gate'
require_text "$MONITOR" 'readWorkerDeployment(jobId)' 'monitor must use the persisted job identity'
require_text "$MONITOR" 'job.stage === '\''SUCCEEDED'\''' 'a pending job cannot pass verification'
require_text "$MONITOR" 'job.candidateMachineIds.length === 8' 'verification requires the complete reserved bank'
require_text "$MONITOR" 'gate?.phase === '\''RETIRED'\''' 'a managed predecessor needs a retirement certificate'
require_text "$MONITOR" 'retained_legacy_generation' 'legacy retention must remain a distinct reported outcome'
require_text "$DEPLOY" 'stage-start cooperative-cutover' 'deploy must record the original cutover start'
require_text "$DEPLOY" 'stage-finish cooperative-cutover' 'deploy must record actual completion'
require_text "$DEPLOY" 'AGENT_DEPLOYMENT_JOB_ID' 'deploy verification must bind the exact workflow job'
require_text "$DRIVER" 'except subprocess.CalledProcessError:' 'failed retirement cannot become a zero count'
require_text "$DRIVER" 'raise PoolCapacityPending("Old bank remains served' 'drain timeout must retain unfinished work'
if grep -Eq 'force-clear-generation-queue|migrate-open-agent-workflows|machines destroy' "$DRIVER"; then
  fail 'routine cutover must not force-stop workflows or destroy capacity'
fi
require_text "$WORKFLOW" 'cron: "*/10 * * * *"' 'interrupted jobs need bounded scheduled recovery'
require_text "$WORKFLOW" '--if-idle -- python3 ../scripts/worker_pool_cutover.py' 'recovery must use the shared lease without competing with a healthy owner'
require_text "$WORKFLOW" 'timeout-minutes: 90' 'normal runner must allow time for readiness and cooperative drain'
# A full checkout spent ~4 min fetching 2.8 GB of agents/benchmarks history.
[ "$(grep -Fc 'filter: blob:none' "$WORKFLOW")" = 2 ] || fail 'deploy and recover jobs must use the blob-filtered checkout'
[ "$(grep -Fc '!/agents/benchmarks/' "$WORKFLOW")" = 2 ] || fail 'deploy and recover checkouts must skip agents/benchmarks'
require_text "$DRIVER" 'for_each_machine(' 'independent bank Machines must be prepared and retired concurrently'
echo 'cooperative cutover monitor structural tests: PASS'
