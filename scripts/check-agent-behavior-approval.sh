#!/usr/bin/env bash
# Agent recovery / terminal-behavior human-approval guard.
#
# The prompt guard (check-prompt-human-approval.sh) only catches changes to
# LLM-VISIBLE TEXT. It cannot catch a change to agent CONTROL-FLOW SEMANTICS —
# e.g. flipping a recoverable failure into a terminal one, deleting a recovery
# fall-through, or inverting a recovery-invariant test. Those are as consequential
# as a prompt change but invisible to a text-only gate, and an automated test
# can't tell you the new BEHAVIOR is the wrong product decision (the author just
# updates the test to match — all green). Regression precedent: commit 500715a5f
# turned every single-planned-task DAG failure into a terminal agent FAILED
# instead of continuing iteration, and shipped green because its blackbox test was
# rewritten to bless the new behavior.
#
# This guard scans the agent control-flow layer (and its behavior tests) for
# hunks that change recovery vs. terminal semantics and requires explicit human
# approval, using the same flag interface as the prompt guard.
set -euo pipefail

APPROVAL_RETRIEVED="false"
BASE_REF="${AGENT_BEHAVIOR_APPROVAL_BASE_REF:-}"

for arg in "$@"; do
  case "$arg" in
    mandatory-human-approval-retrieved=true|--mandatory-human-approval-retrieved=true)
      APPROVAL_RETRIEVED="true"
      ;;
    mandatory-human-approval-retrieved=false|--mandatory-human-approval-retrieved=false)
      APPROVAL_RETRIEVED="false"
      ;;
    --base-ref=*)
      BASE_REF="${arg#--base-ref=}"
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: bash scripts/check-agent-behavior-approval.sh [mandatory-human-approval-retrieved=true] [--base-ref=REF]" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if [ -z "$BASE_REF" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    BASE_REF="origin/main"
  else
    BASE_REF="main"
  fi
fi

# Fail CLOSED: this is an approval gate, so an unresolvable base ref must never be
# silently tolerated. Without this, `git diff "$BASE_REF"...HEAD` below errors into
# `|| true`, omitting all committed changes — a checkout without main/origin/main
# (or an explicit --base-ref=missing) would then "pass" a worktree that actually
# committed a recovery/terminal flip.
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "Agent-behavior human-approval guard: base ref '$BASE_REF' does not resolve to a commit — refusing to run (fail closed)." >&2
  echo "Pass a valid --base-ref=REF or ensure origin/main / main is available." >&2
  exit 2
fi

# Scan added/removed lines for recovery/terminal-transition semantics, restricted
# to the narrow set of files that own agent recovery / terminal control flow (plus
# the blackbox suites that pin those invariants). The whole diff is scanned and the
# watched-file filter lives in awk (matching check-prompt-human-approval.sh) — this
# avoids passing a word-split pathspec list to git. Comment-only edits are stripped
# so documentation/logging tweaks do not trip the guard; only real control-flow
# bytes do.
FLAGGED="$(
  {
    git diff --unified=0 "$BASE_REF"...HEAD 2>/dev/null || true
    git diff --unified=0 HEAD 2>/dev/null || true
    git diff --cached --unified=0 2>/dev/null || true
  } | awk '
    function is_watched(f) {
      return (f == "agents/loop/run_agent.py" ||
              f == "agents/loop/dag_executor.py" ||
              f == "agents/workflows/agent_workflow.py" ||
              f == "agents/tests/blackbox/workflow.blackbox.py" ||
              f == "agents/tests/blackbox/dag_executor.blackbox.py" ||
              f == "agents/tests/blackbox/workflow_determinism.blackbox.py" ||
              # The worker-write layer decides whether a failed lifecycle write
              # is recoverable or terminal for the ACTIVITY. Turning a stale
              # write from "200 + keep going" into "409 -> raise -> die" is the
              # same class this guard exists to catch, but it lives here rather
              # than in agents/loop. Without these entries a deploy that flips
              # an orphaned activity from surviving to self-terminating passes
              # the gate untouched (observed on
              # andyprevalsky/deploy-migration-restarts-subagents).
              f == "agents/helpers/workflow_generation.py" ||
              f == "agents/helpers/messages.py" ||
              f == "agents/domains/spawn_agent/service.py" ||
              f == "agents/domains/spawn_agent/repo.py" ||
              f == "agents/domains/spawn_browser_agent_v3/handler.py" ||
              f == "agents/domains/spawn_browser_agent_v3/repo.py" ||
              f == "agents/domains/spawn_claude_code_agent/repo.py" ||
              f == "agents/domains/call_phone_number/repo.py")
    }
    function is_behavioral(line, fname,    code, sign) {
      sign=substr(line, 1, 1)
      sub(/^[+-]/, "", line)

      code=line
      # Drop full-line and trailing Python comments so comment edits do not fire.
      sub(/^[[:space:]]*#.*$/, "", code)
      sub(/[[:space:]]+#.*$/, "", code)
      if (code ~ /^[[:space:]]*$/) return 0

      # A newly-added test only measures behavior; it does not change runtime
      # semantics or rewrite an existing product decision. Existing test
      # expectations remain protected because edits/deletions emit a '-' line.
      if (fname ~ /\.blackbox\.py$/ && sign == "+") return 0

      # Terminal handoffs / recovery fall-through control.
      if (code ~ /(_handle_incomplete|_mark_failed|_mark_complete|continue_as_new)/) return 1

      # Worker self-termination on a sealed generation. These decide whether an
      # orphaned activity SURVIVES a deploy cutover or kills itself, which is a
      # recovery-vs-terminal decision even though it lives outside agents/loop.
      # A swallow (catching the signal, or downgrading it to a log/sentinel) is
      # just as behavioral as the raise, so both directions must trip the guard.
      if (code ~ /(WorkflowGenerationSealed|raise_if_generation_sealed)/) return 1
      if (code ~ /status_code[[:space:]]*==[[:space:]]*409/) return 1
      if (code ~ /return[[:space:]]*\{[[:space:]]*["'"'"']fenced["'"'"']/) return 1
      if (code ~ /(^|[^A-Za-z0-9_])run_agent[[:space:]]*\(/) return 1

      # Status/reason literals that gate terminal vs. recoverable outcomes.
      # Matches ASSIGNMENT / dict form (status: / status=), SUBSCRIPT comparison
      # (["status"] == / != ), and ATTRIBUTE comparison (.status == / != ). The
      # optional quote+bracket before the operator is what lets a recovery-test
      # inversion like  assert result["status"] == "failed"  trip the guard, not
      # just the assignment  result = {"status": "failed"}.
      if (code ~ /status["'"'"']?[]]?[[:space:]]*(:|==|!=|=)[[:space:]]*["'"'"']?(error|failed|aborted|max_iterations|needs_llm|completed|paused)/) return 1
      if (code ~ /reason["'"'"']?[]]?[[:space:]]*(:|==|!=|=)[[:space:]]*["'"'"']/) return 1

      # Removed/replaced recovery-invariant assertions in behavior tests.
      if (fname ~ /\.blackbox\.py$/) {
        if (code ~ /run_agent_calls/) return 1
        if (code ~ /(must not run|never.*run_agent|falls?_through|recovers?_via)/) return 1
      }

      return 0
    }
    # Track BOTH sides of each file header. A deletion emits "+++ /dev/null" and a
    # rename out of the allowlist changes the +++ path, so keying only on the new
    # side (+++) would let someone delete/rename a watched file to strip recovery
    # logic without tripping the guard. Evaluate old (---) OR new (+++) path.
    /^--- (a\/|\/dev\/null)/ {
      oldfile=substr($0, 5)
      sub(/^a\//, "", oldfile)
      next
    }
    /^\+\+\+ (b\/|\/dev\/null)/ {
      file=substr($0, 5)
      sub(/^b\//, "", file)
      next
    }
    /^[+-][^+-]/ {
      wf=""
      if (is_watched(file)) wf=file
      else if (is_watched(oldfile)) wf=oldfile
      if (wf != "" && is_behavioral($0, wf)) print wf
    }
  ' | sort -u
)"

if [ -z "$FLAGGED" ]; then
  echo "Agent-behavior human-approval guard: no recovery/terminal-semantics changes in the agent control-flow layer."
  exit 0
fi

if [ "$APPROVAL_RETRIEVED" = "true" ]; then
  echo "Agent-behavior human-approval guard: approval flag present for agent-behavior changes:"
  echo "$FLAGGED" | sed 's/^/  - /'
  exit 0
fi

echo "Agent-behavior human-approval guard failed: recovery/terminal-behavior changes require explicit human approval." >&2
echo "" >&2
echo "Detected agent recovery / terminal-semantics changes in:" >&2
echo "$FLAGGED" | sed 's/^/  - /' >&2
echo "" >&2
echo "These hunks change WHEN an agent gives up vs. keeps iterating (status/reason" >&2
echo "literals, _handle_incomplete/_mark_failed/_mark_complete/run_agent fall-through," >&2
echo "continue_as_new, or a recovery-invariant test assertion). A passing test suite" >&2
echo "cannot validate that the new behavior is the correct product decision — route" >&2
echo "it to a human, like a prompt change." >&2
echo "" >&2
echo "After a human approves these behavior modifications, re-run with:" >&2
echo "  bash scripts/check-agent-behavior-approval.sh mandatory-human-approval-retrieved=true" >&2
exit 1
