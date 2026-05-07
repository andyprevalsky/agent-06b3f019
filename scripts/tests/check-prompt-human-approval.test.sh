#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD_SRC="$ROOT_DIR/scripts/check-prompt-human-approval.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

new_repo() {
  local name="$1"
  local dir="$TMP_ROOT/$name"
  mkdir -p "$dir/scripts"
  cp "$GUARD_SRC" "$dir/scripts/check-prompt-human-approval.sh"
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "Prompt Guard Test"
    echo "base" > README.md
    git add .
    git commit -q -m "base"
  )
  printf "%s" "$dir"
}

expect_pass() {
  local dir="$1"
  local label="$2"
  if ! (cd "$dir" && bash scripts/check-prompt-human-approval.sh >/tmp/prompt-guard-test.out 2>&1); then
    echo "FAIL: expected pass: $label" >&2
    cat /tmp/prompt-guard-test.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_fail() {
  local dir="$1"
  local label="$2"
  if (cd "$dir" && bash scripts/check-prompt-human-approval.sh >/tmp/prompt-guard-test.out 2>&1); then
    echo "FAIL: expected fail: $label" >&2
    cat /tmp/prompt-guard-test.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_flag_pass() {
  local dir="$1"
  local label="$2"
  if ! (
    cd "$dir" &&
      bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true >/tmp/prompt-guard-test.out 2>&1
  ); then
    echo "FAIL: expected approval-flag pass: $label" >&2
    cat /tmp/prompt-guard-test.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

false_positive_repo="$(new_repo false-positive-code)"
mkdir -p "$false_positive_repo/agents/tests/blackbox" "$false_positive_repo/agents/workflows"
cat >"$false_positive_repo/agents/tests/blackbox/workflow.blackbox.py" <<'PY'
fake_activity_returns = {
    "get_user_custom_system_prompt": "Prefer concise answers.",
    "prompt_tokens": 10,
    "completion_tokens": 5,
}
PY
cat >"$false_positive_repo/agents/workflows/agent_workflow.py" <<'PY'
from tools.prompts import TOOL_PROMPTS
from utils.prompts import build_system_prompt


async def build_system_prompt_wrapper():
    return build_system_prompt()
PY
git -C "$false_positive_repo" add agents/tests/blackbox/workflow.blackbox.py agents/workflows/agent_workflow.py
expect_pass "$false_positive_repo" "prompt helper imports and token accounting are not prompt edits"

prompt_path_repo="$(new_repo prompt-path)"
mkdir -p "$prompt_path_repo/.claude/commands"
cat >"$prompt_path_repo/.claude/commands/deploy.md" <<'MD'
New deploy instruction.
MD
git -C "$prompt_path_repo" add .claude/commands/deploy.md
expect_fail "$prompt_path_repo" "prompt artifact path requires approval"
expect_flag_pass "$prompt_path_repo" "approval flag permits prompt artifact path"

prompt_constant_repo="$(new_repo prompt-constant)"
mkdir -p "$prompt_constant_repo/src"
cat >"$prompt_constant_repo/src/agent.ts" <<'TS'
export const SYSTEM_PROMPT = "You are Codex. Follow the deployment instructions.";
TS
git -C "$prompt_constant_repo" add src/agent.ts
expect_fail "$prompt_constant_repo" "system prompt constant requires approval"

instructions_repo="$(new_repo prompt-instructions)"
mkdir -p "$instructions_repo/src"
cat >"$instructions_repo/src/agent.ts" <<'TS'
export const instructions = "Always answer in JSON.";
TS
git -C "$instructions_repo" add src/agent.ts
expect_fail "$instructions_repo" "instruction string assignment requires approval"

ordinary_code_repo="$(new_repo ordinary-code)"
mkdir -p "$ordinary_code_repo/src"
cat >"$ordinary_code_repo/src/usage.ts" <<'TS'
export const usage = {
  prompt_tokens: 100,
  completion_tokens: 25,
  total_tokens: 125,
};
TS
git -C "$ordinary_code_repo" add src/usage.ts
expect_pass "$ordinary_code_repo" "ordinary token usage fields are not prompt edits"

echo "All prompt guard tests passed."
