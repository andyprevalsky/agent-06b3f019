import fs from 'fs';
import path from 'path';

export function writeStubRunner(
  dir: string,
  mode: 'pass' | 'fail' | 'capacity-busy-then-pass'
): string {
  const stub = path.join(dir, 'stub-run-bench');
  const script = `#!/usr/bin/env bash
# Stub runner for the pipeline blackbox — emits the REAL artifact layout the
# poller discovers (report-card.json + run.json in the request-owned context),
# then exits.
set -euo pipefail
${
  mode === 'capacity-busy-then-pass'
    ? `ATTEMPT_FILE="\${HUB_PIPELINE_BUSY_ATTEMPT_FILE:?}"
ATTEMPT="$(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0)"
ATTEMPT=$((ATTEMPT + 1))
printf '%s\\n' "$ATTEMPT" > "$ATTEMPT_FILE"
if [ "$ATTEMPT" -eq 1 ]; then
  echo "CLOUDBENCH_RETRYABLE_CAPACITY=lease_busy" >&2
  echo "Cloud benchmark app is leased by another controller (HTTP 409); waiting is safe." >&2
  exit 75
fi`
    : ''
}
shift || true  # --local
TASK="\${1:-chat-mode}"
STAMP="stub-$(date +%s)-$$"
ARTIFACT_ROOT="\${BENCHMARK_CONTEXT_DIR:-agents/.context/benchmarks}"
CARD_DIR="$ARTIFACT_ROOT"
mkdir -p "$CARD_DIR"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$CARD_DIR/report-card.json" <<CARD
{"run_id":"$STAMP","timestamp":"$NOW","elapsed_s":7.5,
 "cost":{"agents_llm_usd":0.02,"wmh_grounding_usd":0.0,"infra_usd":0.01,"total_usd":0.03,"fast_cache_hit_rate":97},
 "metadata":{"tokens_in":1200,"tokens_out":300},
 "per_task":[{"name":"$TASK","status":"running","duration_s":null,"cost_usd":null,
   "agent_url":"http://localhost/?agent-id=stub-agent-1","world_model_mode":"real","fast_mode":true}]}
CARD
sleep 0.6  # long enough for the injected 0.1s snapshot cadence to observe "running"
${
  mode === 'fail'
    ? `echo "stub runner exploding on purpose" >&2
exit 1`
    : `cat > "$CARD_DIR/report-card.json" <<CARD
{"run_id":"$STAMP","timestamp":"$NOW","elapsed_s":19.0,
 "cost":{"agents_llm_usd":0.02,"wmh_grounding_usd":0.0,"infra_usd":0.01,"total_usd":0.03,"fast_cache_hit_rate":97},
 "metadata":{"tokens_in":1200,"tokens_out":300},
 "per_task":[{"name":"$TASK","status":"passed","duration_s":18.0,"cost_usd":0.03,
   "agent_url":"http://localhost/?agent-id=stub-agent-1","world_model_mode":"real","fast_mode":true}]}
CARD
cat > "$ARTIFACT_ROOT/run.json" <<RUN
{"run_id":"$STAMP","timestamp":"$NOW","suite":"stub",
 "tasks":[{"name":"$TASK","passed":true,"status":"COMPLETED","agent_id":"stub-agent-1",
   "duration_seconds":18.0,"cost_cents":3,"tokens_in":1200,"tokens_out":300,
   "fast_mode_cache_enabled":true,"world_model_mode":"real","tree_agent_count":1,
   "logs":{"messages":[{"role":"USER","message":"stub goal","created_at":"$NOW"},
                        {"role":"ASSISTANT","message":"stub result","created_at":"$NOW"}]}}]}
RUN
exit 0`
}
`;
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return stub;
}

export function writeForeignArtifactRunner(
  dir: string,
  repoRoot: string
): { stub: string; cardDir: string; runFile: string } {
  const foreignId = `foreign-${process.pid}-${Date.now()}`;
  const cardDir = path.join(repoRoot, 'agents', '.context', 'benchmarks', foreignId);
  const runFile = path.join(repoRoot, 'agents', 'benchmarks', 'runs', `${foreignId}.json`);
  const stub = path.join(dir, 'stub-run-bench-foreign');
  const script = `#!/usr/bin/env bash
set -euo pipefail
shift || true
TASK="\${1:-chat-mode}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${cardDir}" "$(dirname "${runFile}")"
cat > "${cardDir}/report-card.json" <<CARD
{"run_id":"${foreignId}","timestamp":"$NOW","elapsed_s":1,
 "per_task":[{"name":"$TASK","status":"passed"}]}
CARD
cat > "${runFile}" <<RUN
{"run_id":"${foreignId}","timestamp":"$NOW","suite":"foreign",
 "tasks":[{"name":"$TASK","passed":true,"status":"COMPLETED"}]}
RUN
echo "foreign artifact emitted; owned runner failed" >&2
exit 7
`;
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return { stub, cardDir, runFile };
}
