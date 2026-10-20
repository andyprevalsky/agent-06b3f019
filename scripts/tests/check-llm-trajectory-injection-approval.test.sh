#!/usr/bin/env bash
# Unit tests for scripts/check-llm-trajectory-injection-approval.sh — the runtime
# LLM trajectory-injection human-approval guard. Verifies it FIRES on synthetic
# user/tool/context injection changes in the watched harness layer, PASSES on
# comment/logging noise and unwatched files, and honors the approval flag.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD_SRC="$ROOT_DIR/scripts/check-llm-trajectory-injection-approval.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

new_repo() {
  local name="$1"
  local dir="$TMP_ROOT/$name"
  mkdir -p "$dir/scripts"
  cp "$GUARD_SRC" "$dir/scripts/check-llm-trajectory-injection-approval.sh"
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "Trajectory Injection Guard Test"
    git config commit.gpgsign false
    git config tag.gpgsign false
    mkdir -p agents/domains/spawn_browser_agent_v3
    echo "# browser handler" > agents/domains/spawn_browser_agent_v3/handler.py
    echo "base" > README.md
    git add .
    git commit -q -m "base"
  )
  printf "%s" "$dir"
}

expect_fail() {
  local dir="$1" label="$2"
  if (cd "$dir" && bash scripts/check-llm-trajectory-injection-approval.sh >/tmp/trajectory-guard.out 2>&1); then
    echo "FAIL: expected guard to FIRE: $label" >&2
    cat /tmp/trajectory-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_pass() {
  local dir="$1" label="$2"
  if ! (cd "$dir" && bash scripts/check-llm-trajectory-injection-approval.sh >/tmp/trajectory-guard.out 2>&1); then
    echo "FAIL: expected guard to PASS: $label" >&2
    cat /tmp/trajectory-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_flag_pass() {
  local dir="$1" label="$2"
  if ! (cd "$dir" && bash scripts/check-llm-trajectory-injection-approval.sh mandatory-human-approval-retrieved=true >/tmp/trajectory-guard.out 2>&1); then
    echo "FAIL: expected approval-flag PASS: $label" >&2
    cat /tmp/trajectory-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_retired_deferral_rejected() {
  local dir="$1" label="$2" status=0
  (
    cd "$dir" && AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED=true \
      bash scripts/check-llm-trajectory-injection-approval.sh \
        --defer-human-approval-to-exact-head-pr-review=true >/tmp/trajectory-guard.out 2>&1
  ) || status=$?
  if [ "$status" -ne 2 ] || ! grep -Fq 'Unknown flag: --defer-human-approval-to-exact-head-pr-review=true' /tmp/trajectory-guard.out; then
    echo "FAIL: expected the retired exact-head deferral flag to be rejected (exit 2): $label" >&2
    cat /tmp/trajectory-guard.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

# 1. Provider-exit fabricated tool failure injection.
provider_exit_repo="$(new_repo provider-exit-injection)"
cat >>"$provider_exit_repo/agents/domains/spawn_browser_agent_v3/handler.py" <<'PY'
    await _feed_provider_exit_detected_back(browser_turn_messages, rejection)
PY
git -C "$provider_exit_repo" add agents/domains/spawn_browser_agent_v3/handler.py
expect_fail "$provider_exit_repo" "adding provider-exit trajectory injection requires approval"
expect_flag_pass "$provider_exit_repo" "approval flag permits provider-exit injection change"
expect_retired_deferral_rejected "$provider_exit_repo" "no caller can defer trajectory approval to an exact-head review"

# 2. Classifier recovery constraint wording change.
classifier_repo="$(new_repo classifier-injection)"
mkdir -p "$classifier_repo/agents/domains/spawn_browser_agent_v3"
cat >"$classifier_repo/agents/domains/spawn_browser_agent_v3/challenge_llm_classifier.py" <<'PY'
def build_challenge_classifier_messages(context):
    return [{"role": "user", "content": "Agent recovery reason (for context):"}]
PY
git -C "$classifier_repo" add agents/domains/spawn_browser_agent_v3/challenge_llm_classifier.py
expect_fail "$classifier_repo" "classifier message construction change requires approval"

# 3. Comment-only edit in a watched file should pass.
comment_repo="$(new_repo comment-only)"
cat >>"$comment_repo/agents/domains/spawn_browser_agent_v3/handler.py" <<'PY'
    # browser_turn_messages holds synthetic recovery nudges for the planner
PY
git -C "$comment_repo" add agents/domains/spawn_browser_agent_v3/handler.py
expect_pass "$comment_repo" "comment-only edit in watched file passes"

# 4. Same injection site in an unwatched file should pass.
unwatched_repo="$(new_repo unwatched-file)"
mkdir -p "$unwatched_repo/agents/tools"
cat >"$unwatched_repo/agents/tools/example.py" <<'PY'
browser_turn_messages.append({"role": "user", "content": "nudge"})
PY
git -C "$unwatched_repo" add agents/tools/example.py
expect_pass "$unwatched_repo" "injection-like code outside watched files passes"

# 5. Fail closed on missing base ref.
failclosed_repo="$(new_repo fail-closed)"
cat >>"$failclosed_repo/agents/domains/spawn_browser_agent_v3/handler.py" <<'PY'
    browser_turn_messages.extend(extra_user_messages)
PY
git -C "$failclosed_repo" add agents/domains/spawn_browser_agent_v3/handler.py
if (cd "$failclosed_repo" && bash scripts/check-llm-trajectory-injection-approval.sh --base-ref=nonexistent-ref-xyz >/tmp/trajectory-guard.out 2>&1); then
  echo "FAIL: missing base ref must fail closed" >&2
  exit 1
fi
echo "PASS: missing base ref fails closed"

echo "All trajectory-injection guard unit tests passed."
