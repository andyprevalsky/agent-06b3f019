#!/usr/bin/env bash
# Unit tests for scripts/check-agent-behavior-approval.sh — the agent recovery /
# terminal-behavior human-approval guard. Verifies it FIRES on recovery/terminal
# semantic changes in the watched control-flow layer, PASSES on comment/logging
# noise and on unwatched files, and honors the approval flag.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD_SRC="$ROOT_DIR/scripts/check-agent-behavior-approval.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

new_repo() {
  local name="$1"
  local dir="$TMP_ROOT/$name"
  mkdir -p "$dir/scripts"
  cp "$GUARD_SRC" "$dir/scripts/check-agent-behavior-approval.sh"
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "Agent Behavior Guard Test"
    mkdir -p agents/loop agents/workflows agents/tests/blackbox
    # Seed the watched files so later edits are MODIFICATIONS (hunks), matching
    # how a real regression flips existing control flow.
    echo "# run_agent loop" > agents/loop/run_agent.py
    echo "# dag executor" > agents/loop/dag_executor.py
    echo "# agent workflow" > agents/workflows/agent_workflow.py
    echo "# workflow tests" > agents/tests/blackbox/workflow.blackbox.py
    echo "base" > README.md
    git add .
    git commit -q -m "base"
  )
  printf "%s" "$dir"
}

expect_fail() {
  local dir="$1" label="$2"
  if (cd "$dir" && bash scripts/check-agent-behavior-approval.sh >/tmp/agent-behavior-guard.out 2>&1); then
    echo "FAIL: expected guard to FIRE: $label" >&2
    cat /tmp/agent-behavior-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_pass() {
  local dir="$1" label="$2"
  if ! (cd "$dir" && bash scripts/check-agent-behavior-approval.sh >/tmp/agent-behavior-guard.out 2>&1); then
    echo "FAIL: expected guard to PASS: $label" >&2
    cat /tmp/agent-behavior-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_flag_pass() {
  local dir="$1" label="$2"
  if ! (cd "$dir" && bash scripts/check-agent-behavior-approval.sh mandatory-human-approval-retrieved=true >/tmp/agent-behavior-guard.out 2>&1); then
    echo "FAIL: expected approval-flag PASS: $label" >&2
    cat /tmp/agent-behavior-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_deferred_pass() {
  local dir="$1" label="$2"
  if ! (
    cd "$dir" && AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED=true \
      bash scripts/check-agent-behavior-approval.sh \
        --defer-human-approval-to-exact-head-pr-review=true >/tmp/agent-behavior-guard.out 2>&1
  ); then
    echo "FAIL: expected trusted exact-head deferral PASS: $label" >&2
    cat /tmp/agent-behavior-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

# 1. Terminal handoff added to the workflow (the exact 500715a5f regression shape).
terminal_repo="$(new_repo terminal-handoff)"
cat >>"$terminal_repo/agents/workflows/agent_workflow.py" <<'PY'
    else:
        return await self._handle_incomplete(dag_result, "EXECUTE")
PY
git -C "$terminal_repo" add agents/workflows/agent_workflow.py
expect_fail "$terminal_repo" "adding a terminal _handle_incomplete handoff requires approval"
expect_flag_pass "$terminal_repo" "approval flag permits the terminal-handoff change"
if (cd "$terminal_repo" && env -u AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED \
  bash scripts/check-agent-behavior-approval.sh \
  --defer-human-approval-to-exact-head-pr-review=true >/tmp/agent-behavior-guard.out 2>&1); then
  echo "FAIL: untrusted caller deferred agent-behavior approval" >&2
  exit 1
fi
echo "PASS: agent-behavior exact-head deferral is restricted to trusted Auto RCA"
expect_deferred_pass "$terminal_repo" "trusted Auto RCA may defer behavior approval to the exact-head review"

# 2. Flipping a returned status literal between recoverable and terminal.
status_repo="$(new_repo status-literal)"
cat >>"$status_repo/agents/loop/dag_executor.py" <<'PY'
    return {"status": "error", "message": "Planned task failed during DAG execution."}
PY
git -C "$status_repo" add agents/loop/dag_executor.py
expect_fail "$status_repo" "a terminal status literal in dag_executor requires approval"

# 3. Inverting a recovery-invariant test assertion.
test_repo="$(new_repo test-invariant)"
cat >>"$test_repo/agents/tests/blackbox/workflow.blackbox.py" <<'PY'
    assert run_agent_calls == []  # regressed: run_agent must not run
PY
git -C "$test_repo" add agents/tests/blackbox/workflow.blackbox.py
expect_fail "$test_repo" "inverting a run_agent recovery-invariant assertion requires approval"

# 4. Comment-only + logging-only edits to a watched file must NOT fire.
noise_repo="$(new_repo comment-logging-noise)"
cat >>"$noise_repo/agents/workflows/agent_workflow.py" <<'PY'
    # This comment mentions _handle_incomplete and status: error but is only a comment.
    workflow.logger.info("execution incomplete — falling through for recovery")
    total = compute_tokens(a, b)
PY
git -C "$noise_repo" add agents/workflows/agent_workflow.py
expect_pass "$noise_repo" "comment/logging-only edits to a watched file do not fire"

# 5. Terminal semantics in an UNWATCHED file must NOT fire (scope is narrow).
unwatched_repo="$(new_repo unwatched-file)"
mkdir -p "$unwatched_repo/agents/tools"
cat >"$unwatched_repo/agents/tools/some_tool.py" <<'PY'
def handle():
    return {"status": "error"}
PY
git -C "$unwatched_repo" add agents/tools/some_tool.py
expect_pass "$unwatched_repo" "terminal literals outside the control-flow layer do not fire"

# 6. Inverting a recovery invariant via a subscript COMPARISON (not an assignment)
#    must fire. `assert result["status"] == "failed"` is the natural test-inversion
#    shape; a guard that only matched `status: "failed"` assignments would miss it.
compare_repo="$(new_repo compare-assertion)"
cat >>"$compare_repo/agents/tests/blackbox/workflow.blackbox.py" <<'PY'
    assert result["status"] == "failed"  # regressed: expect terminal, not recovery
PY
git -C "$compare_repo" add agents/tests/blackbox/workflow.blackbox.py
expect_fail "$compare_repo" 'inverting a status invariant via ["status"] == comparison requires approval'

# 7. DELETING a watched file that carries recovery logic must fire. A deletion
#    emits "+++ /dev/null", so keying only on the new-side (+++) path would let
#    someone strip recovery control flow — or rename the file out of the
#    allowlist — without tripping the guard. The old-side (---) path must be read.
delete_repo="$(new_repo delete-watched)"
cat >>"$delete_repo/agents/loop/dag_executor.py" <<'PY'
    return {"status": "needs_llm", "context": context}
PY
git -C "$delete_repo" add agents/loop/dag_executor.py
git -C "$delete_repo" commit -q -m "add recovery return"
git -C "$delete_repo" rm -q agents/loop/dag_executor.py
expect_fail "$delete_repo" "deleting a watched file's recovery logic requires approval"

# 8. Fail CLOSED on an unresolvable base ref. An approval gate must never treat a
#    missing/typo'd base as "no changes" and silently pass — a clean worktree with
#    a bad --base-ref must exit nonzero rather than approve.
failclosed_repo="$(new_repo fail-closed-base-ref)"
if (cd "$failclosed_repo" && bash scripts/check-agent-behavior-approval.sh --base-ref=nonexistent-ref-xyz >/tmp/agent-behavior-guard.out 2>&1); then
  echo "FAIL: expected guard to FAIL CLOSED on an unresolvable base ref" >&2
  cat /tmp/agent-behavior-guard.out >&2
  exit 1
fi
echo "PASS: an unresolvable base ref fails closed"

echo "All agent-behavior guard tests passed."
