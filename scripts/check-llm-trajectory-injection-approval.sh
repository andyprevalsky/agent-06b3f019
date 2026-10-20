#!/usr/bin/env bash
# LLM trajectory-injection human-approval guard.
#
# Step 0p (check-prompt-human-approval.sh) catches compile-time prompt strings and
# some runtime prompt construction, but harness code can inject synthetic user/
# tool turns into the planning LLM's message history without touching a *_PROMPT
# constant — e.g. provider-exit fabricated tool failures, supervisor recovery
# user messages, OTP/handoﬀ nudges, or classifier recovery constraints wired into
# build_challenge_classifier_messages. Those are as consequential as a prompt edit
# but often evade the text-only gate because the strings live inside control flow.
#
# This guard scans the narrow harness layers that own runtime trajectory injection
# and requires explicit human approval when those injection sites change.
set -euo pipefail

APPROVAL_RETRIEVED="false"
BASE_REF="${LLM_TRAJECTORY_INJECTION_APPROVAL_BASE_REF:-}"

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
      echo "Usage: bash scripts/check-llm-trajectory-injection-approval.sh [mandatory-human-approval-retrieved=true] [--base-ref=REF]" >&2
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

if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "LLM trajectory-injection guard: base ref '$BASE_REF' does not resolve to a commit — refusing to run (fail closed)." >&2
  exit 2
fi

FLAGGED="$(
  {
    git diff --unified=0 "$BASE_REF"...HEAD 2>/dev/null || true
    git diff --unified=0 HEAD 2>/dev/null || true
    git diff --cached --unified=0 2>/dev/null || true
  } | awk '
    function is_watched(f) {
      return (f == "agents/domains/spawn_browser_agent_v3/handler.py" ||
              f == "agents/domains/spawn_browser_agent_v3/service.py" ||
              f == "agents/domains/spawn_browser_agent_v3/challenge_llm_classifier.py" ||
              f == "back-end/src/providers/browser/challengeLlmClassifier.ts" ||
              f == "agents/providers/rose/browser_use.py" ||
              f == "agents/loop/run_agent.py" ||
              f == "agents/domains/spawn_claude_code_agent/service.py")
    }
    function is_trajectory_injection(line, fname, code, sign) {
      sign=substr(line, 1, 1)
      sub(/^[+-]/, "", line)

      code=line
      sub(/^[[:space:]]*#.*$/, "", code)
      sub(/[[:space:]]+#.*$/, "", code)
      if (code ~ /^[[:space:]]*$/) return 0

      # Named browser-harness injection helpers / buffers.
      if (code ~ /(_append_browser_turn_messages|browser_turn_messages\.(append|extend)|_feed_provider_exit_detected_back|_feed_browser_tool_validation_error_back|_run_browser_supervisor_recovery|_format_browser_supervisor_message|build_auth_assistance_resume_user_message|otp_user_messages|resume_user_messages|build_challenge_classifier_messages|recovery_lines|provider_exit_monitoring_enabled|pop_provider_exit_rejection|live_tab_looks_challenged)/) return 1

      # Extra user messages merged into browser-use planning context.
      if (code ~ /(extra_user_messages|_extra_user_messages)/) return 1

      # Mid-run system prompt/context mutations that alter what the planner reads.
      if (code ~ /dynamic_system_context[[:space:]]*=[[:space:]]*build_browser_dynamic/) return 1

      # Main agent loop synthetic completion nudge.
      if (fname == "agents/loop/run_agent.py" && code ~ /completion_instruction/) return 1

      # Harness-authored trajectory strings (add/change/remove all matter).
      if (code ~ /(Browser network monitor detected|Browser supervisor detected|Cross-origin handoff page|Current page does not look challenged|Call `recover_from_challenge`|CRITICAL recovery constraint|Agent recovery reason \(for context\)|Generic browser supervisor recovery ran|Recent email\/SMS OTP arrived)/) return 1

      # Synthetic tool-result narration fed back instead of real tool output.
      if (code ~ /(skip_message|verifier_feedback_thinking|challenge_guard_reason|recovery_message|validation_message)[[:space:]]*=[[:space:]]*(f?"|"'"'"'|`)/) return 1

      return 0
    }
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
      if (wf != "" && is_trajectory_injection($0, wf)) print wf
    }
  ' | sort -u
)"

if [ -z "$FLAGGED" ]; then
  echo "LLM trajectory-injection guard: no runtime trajectory injection changes detected."
  exit 0
fi

if [ "$APPROVAL_RETRIEVED" = "true" ]; then
  echo "LLM trajectory-injection guard: approval flag present for trajectory-injection changes:"
  echo "$FLAGGED" | sed 's/^/  - /'
  exit 0
fi

echo "LLM trajectory-injection guard failed: runtime LLM trajectory injection changes require explicit human approval." >&2
echo "" >&2
echo "Detected harness trajectory-injection edits in:" >&2
echo "$FLAGGED" | sed 's/^/  - /' >&2
echo "" >&2
echo "These hunks add, remove, or rewrite synthetic user/tool/context the planning LLM" >&2
echo "sees at runtime (browser_turn_messages, extra_user_messages, supervisor nudges," >&2
echo "recovery skip/force messages, classifier recovery constraints, etc.). They are" >&2
echo "not covered by the prompt-string gate alone — route them to a human like a prompt" >&2
echo "change." >&2
echo "" >&2
echo "After a human approves these trajectory-injection modifications, re-run with:" >&2
echo "  bash scripts/check-llm-trajectory-injection-approval.sh mandatory-human-approval-retrieved=true" >&2
exit 1
