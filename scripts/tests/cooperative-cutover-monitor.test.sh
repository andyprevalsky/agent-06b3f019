#!/usr/bin/env bash
# Keep /deploy's post-merge proof bound to the managed job and its original bank.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# The cutover lane is executed by `scripts/deploy production` (deploy_prod.py
# lane_fly) and verified by run_deploy_pipeline.py cutover_verify; the concise
# deploy.md carries no inline cutover script, so these are the real anchors.
PROD="$ROOT/scripts/deploy_prod.py"
PIPELINE="$ROOT/scripts/run_deploy_pipeline.py"
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
require_text "$PROD" "ctx.factory('stage-start', 'cooperative-cutover')" 'deploy must record the original cutover start'
require_text "$PROD" "ctx.factory('stage-finish', 'cooperative-cutover')" 'deploy must record actual completion'
# A resumed job keeps the original clock: one start, before the first cutover
# command, and one finish, after the (possibly resumed) job succeeded.
[ "$(grep -Fc "ctx.factory('stage-start', 'cooperative-cutover')" "$PROD")" = 1 ] || fail 'cutover start must be recorded exactly once so a resume keeps the original clock'
[ "$(grep -Fc "ctx.factory('stage-finish', 'cooperative-cutover')" "$PROD")" = 1 ] || fail 'cutover finish must be recorded exactly once'
python3 - "$PROD" <<'PY' || fail 'cutover stage must start before the production command and finish after the resumed job'
import re, sys
body = open(sys.argv[1]).read().split('def lane_fly(', 1)[1].split('\ndef ', 1)[0]
start = body.index("ctx.factory('stage-start', 'cooperative-cutover')")
first_run = body.index("ctx.sh('fly', production_argv(")
resume = body.index("ctx.sh('fly', resume_argv(job)")
finish = body.index("ctx.factory('stage-finish', 'cooperative-cutover')")
assert start < first_run < resume < finish, (start, first_run, resume, finish)
PY
# The exact workflow job is bound: resume re-enters the SAME durable job id, and
# verification reads that job, checks its merged source and workflow attempt,
# then runs the managed monitor --verify on that id.
require_text "$PROD" "'run', '--job-id', job_id, '--'" 'resume must re-enter the exact saved job id'
require_text "$PROD" "resume_argv(job)" 'a failed cutover must resume the job recorded for this run'
require_text "$PIPELINE" '"scripts/worker-deployment-queue.ts", "read", "--job-id", job_id' 'verification must read the exact workflow job'
require_text "$PIPELINE" 'if source_commit != merged_sha or attempt != fly["deployment_token"]' 'verification must bind the merged SHA and workflow attempt'
require_text "$PIPELINE" '"scripts/monitor-cooperative-cutover.ts", "--job-id", job_id,' 'monitor verification must target the exact job'
require_text "$PIPELINE" '"--expected-hash", expected_hash, "--verify"' 'monitor verification must carry the expected surface hash'
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
# This suite cements itself: deploy.md carries no gate list, so the registry that
# `scripts/deploy gates` runs must name it exactly once with this command.
python3 -B - "$ROOT/scripts/run-deploy-structural-gates.py" <<'PY' || fail "cooperative-cutover-monitor must be registered exactly once in the structural-gate registry"
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
pattern = r'Gate\(\s*"cooperative-cutover-monitor",\s*\("bash", "scripts/tests/cooperative-cutover-monitor.test.sh"\)'
raise SystemExit(0 if len(re.findall(pattern, source)) == 1 else 1)
PY
echo 'cooperative cutover monitor structural tests: PASS'
