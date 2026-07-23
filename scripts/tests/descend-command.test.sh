#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESCEND_COMMAND="$ROOT_DIR/.claude/commands/descend.md"
DESCEND_STEP_LOGGER="$ROOT_DIR/scripts/descend_step_log.py"
DESCEND_STEP_HISTORY="$ROOT_DIR/agents/benchmarks/history/descend_steps.jsonl"
GIT_ATTRIBUTES="$ROOT_DIR/.gitattributes"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local text="$1"
  local description="$2"
  grep -Fq -- "$text" "$DESCEND_COMMAND" || fail "$description"
}

[ -f "$DESCEND_COMMAND" ] || fail "/descend command is missing"
[ -f "$DESCEND_STEP_LOGGER" ] || fail "/descend step logger is missing"
[ -f "$DESCEND_STEP_HISTORY" ] || fail "/descend tracked step history is missing"
grep -Fq 'agents/benchmarks/history/descend_steps.jsonl merge=union' "$GIT_ATTRIBUTES" || \
  fail "/descend step history must merge concurrent workspace records with union"
if git -C "$ROOT_DIR" check-ignore -q "$DESCEND_STEP_HISTORY"; then
  fail "/descend step history must not be gitignored"
fi

require_text "Exactly two planned user-input gates." "/descend must define two planned user gates"
require_text "HARNESS_FIX_DECISION" "/descend must stop for harness-fix approval"
require_text "DEPLOY_ADMIN_APPROVAL" "/descend must stop for required deploy approval"
require_text "every HARNESS failure has a completed RCA; and" "/descend must require every harness RCA to be complete before stopping"
require_text "Never enter HARNESS_FIX_DECISION with an open observability gap." "/descend must keep investigating open observability gaps instead of stopping"
require_text '## `/sync` checkpoints' "/descend must define durable sync checkpoints"
require_text 'including each RCA' "/descend must sync every parallel RCA worker"
require_text 'Run `/sync` before every subset or full-slice rerun.' "/descend must sync before benchmark reruns"
require_text 'Before syncing a dirty controller workspace' "/descend must preserve dirty work across sync checkpoints"
require_text 'before preparing each isolated deploy-unit worktree' "/descend must sync before deploy handoff"
require_text "pause only" "deploy approval must not freeze independent RCA work"
require_text "Prepare a clean" "/descend must use a fix-only isolated deploy worktree"
require_text 'bash scripts/prepare-deploy-worktree.sh' "/descend must provision isolated deploy worktrees before /deploy"
require_text "Bench run:" "/descend header must show benchmark timing"
require_text "Rows with ⏳ Deploy approval first" "deploy approvals must sort first"
require_text "Rows with ✅ Deployed #<PR> last" "deployed rows must sort last"
require_text "**INFRA:**" "/descend must classify infrastructure failures"
require_text "**HARNESS:**" "/descend must classify trustworthy benchmark failures as harness"
require_text "| ID | Kind | Cluster | Issue (≤100 chars) | RCA | Fix | Test | Approval | Real rerun | Deploy |" "/descend must use an issue-oriented lifecycle table with a pinned issue cluster"
require_text "Browser agent failed to start because proxy generation returned HTTP 400" "/descend issue rows must state the concrete observed failure"
require_text "The issue is **<root cause at the first-bad boundary>**" "fix approval must explain the RCA"
require_text "where we measured **<measurement>**" "fix approval must report the repro measurement"
require_text "The unchanged local repro now" "fix approval must report post-fix proof"
require_text "**Is this fix approved?**" "fix approval must ask a clear decision question"
require_text "agents/benchmarks/history/descend_steps.jsonl" "/descend must write step timings to tracked history"
require_text "scripts/descend_step_log.py start" "/descend must start its first timed step"
require_text "scripts/descend_step_log.py transition" "/descend must time every state transition"
require_text "scripts/descend_step_log.py finish" "/descend must close terminal and parallel timing lanes"
require_text "scripts/descend_step_log.py report" "/descend must analyze iteration-speed trends"
require_text 'standard factory telemetry envelope' "/descend timings must use the factory telemetry standard"
require_text '`stage-start` and `stage-finish`' "/descend timings must record paired stage boundaries"
require_text 'terminal `outcome`' "/descend timings must record the terminal outcome"
require_text '`FACTORY_EVENT`' "/descend timing commands must expose factory events"
require_text '`scripts/factory_review.py` consumes' "/descend timing history must feed factory review"

RESPONSE_CONTRACT=$(sed -n '/^## Response contract/,$p' "$DESCEND_COMMAND")
STOP_ONE_CONTRACT=$(sed -n '/^## Stop 1 — HARNESS_FIX_DECISION/,/^## Rerun and parallel deploy/p' "$DESCEND_COMMAND")
SYNC_CONTRACT=$(sed -n '/^## `\/sync` checkpoints/,/^## State machine/p' "$DESCEND_COMMAND")
INFRA_LOOP=$(sed -n '/^The infra loop is strict:/,/^Do not stop for Andy/p' "$DESCEND_COMMAND")
HARNESS_RCA=$(sed -n '/^## HARNESS RCA/,/^## Stop 1/p' "$DESCEND_COMMAND")
grep -Fq 'each distinct `/RCA` invocation' <<<"$SYNC_CONTRACT" || fail "sync checkpoints must run before each distinct RCA"
grep -Fq 'run /sync immediately before each distinct /RCA' <<<"$INFRA_LOOP" || fail "infra RCA loop must sync before every RCA"
grep -Fq 'Run `/sync` immediately before every distinct `/RCA`' <<<"$HARNESS_RCA" || fail "harness RCA loop must sync before every RCA"
grep -Fq 'or an honest open observability gap' <<<"$STOP_ONE_CONTRACT" && fail "open observability gaps must not qualify for the harness-fix decision stop"
grep -Fq '~~~text' <<<"$RESPONSE_CONTRACT" && fail "response examples must not use code blocks"
grep -Fq '━' <<<"$RESPONSE_CONTRACT" && fail "response header must not use an ASCII banner"
grep -Fq '| Andy decision |' <<<"$RESPONSE_CONTRACT" && fail "Andy and Admin must not be separate columns"
grep -Fq '| Admin approval |' <<<"$RESPONSE_CONTRACT" && fail "Andy and Admin must not be separate columns"
grep -Fq '| Benchmark |' <<<"$RESPONSE_CONTRACT" && fail "real rerun must replace the ambiguous Benchmark column"

python3 "$ROOT_DIR/scripts/tests/descend-step-log.test.py"

echo "All /descend command checks passed."
