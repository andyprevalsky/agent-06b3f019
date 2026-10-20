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
    git config commit.gpgsign false
    git config tag.gpgsign false
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

expect_deferred_pass() {
  local dir="$1"
  local label="$2"
  if ! (
    cd "$dir" &&
      AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED=true \
        bash scripts/check-prompt-human-approval.sh \
          --defer-human-approval-to-exact-head-pr-review=true >/tmp/prompt-guard-test.out 2>&1
  ); then
    echo "FAIL: expected trusted exact-head deferral pass: $label" >&2
    cat /tmp/prompt-guard-test.out >&2
    exit 1
  fi
  echo "PASS: $label"
}

false_positive_repo="$(new_repo false-positive-code)"
mkdir -p "$false_positive_repo/agents/helpers" "$false_positive_repo/agents/tests/blackbox" "$false_positive_repo/agents/workflows"
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
cat >"$false_positive_repo/agents/helpers/llm.py" <<'PY'
async def call_llm_activity(system_prompt):
    if system_prompt is None:
        raise ValueError(f"No pending LLM context for agent abc and no system_prompt provided")

    return {
        "codex_reasoning_items": [],
    }
PY
git -C "$false_positive_repo" add \
  agents/helpers/llm.py \
  agents/tests/blackbox/workflow.blackbox.py \
  agents/workflows/agent_workflow.py
expect_pass "$false_positive_repo" "prompt helper imports, token accounting, and LLM plumbing are not prompt edits"

test_prompt_repo="$(new_repo test-prompt-files)"
mkdir -p "$test_prompt_repo/agents/tests/blackbox" "$test_prompt_repo/front-end/src/tests"
cat >"$test_prompt_repo/agents/tests/blackbox/prompt_invariants.blackbox.py" <<'PY'
PROMPT_ASSERTION = "You are Codex. This is fixture text, not a production prompt."
PY
cat >"$test_prompt_repo/front-end/src/tests/system-prompt.spec.ts" <<'TS'
export const instructions = "Fixture instruction text for a test.";
TS
git -C "$test_prompt_repo" add agents/tests/blackbox/prompt_invariants.blackbox.py front-end/src/tests/system-prompt.spec.ts
expect_pass "$test_prompt_repo" "prompt-looking test files do not require prompt approval"

prompt_path_repo="$(new_repo prompt-path)"
mkdir -p "$prompt_path_repo/.claude/commands"
cat >"$prompt_path_repo/.claude/commands/deploy.md" <<'MD'
New deploy instruction.
MD
git -C "$prompt_path_repo" add .claude/commands/deploy.md
expect_fail "$prompt_path_repo" "prompt artifact path requires approval"
expect_flag_pass "$prompt_path_repo" "approval flag permits prompt artifact path"
if (cd "$prompt_path_repo" && env -u AUTO_RCA_EXACT_HEAD_APPROVAL_DEFERRED \
  bash scripts/check-prompt-human-approval.sh \
  --defer-human-approval-to-exact-head-pr-review=true >/tmp/prompt-guard-test.out 2>&1); then
  echo "FAIL: untrusted caller deferred prompt approval" >&2
  exit 1
fi
echo "PASS: exact-head deferral is restricted to trusted Auto RCA"
expect_deferred_pass "$prompt_path_repo" "trusted Auto RCA may defer prompt approval to the exact-head review"

shared_instruction_repo="$(new_repo shared-instruction-path)"
mkdir -p "$shared_instruction_repo/.claude/shared"
cat >"$shared_instruction_repo/.claude/shared/approval-format.md" <<'MD'
Shared instructions consumed by multiple commands.
MD
git -C "$shared_instruction_repo" add .claude/shared/approval-format.md
expect_fail "$shared_instruction_repo" "shared Claude instruction artifact requires approval"
expect_flag_pass "$shared_instruction_repo" "approval flag permits shared Claude instruction artifact"

prompt_text_repo="$(new_repo prompt-text-path)"
mkdir -p "$prompt_text_repo/.github"
cat >"$prompt_text_repo/.github/auto-rca-prompt.txt" <<'TXT'
New automated RCA instruction.
TXT
git -C "$prompt_text_repo" add .github/auto-rca-prompt.txt
expect_fail "$prompt_text_repo" "prompt text artifact requires approval"
expect_flag_pass "$prompt_text_repo" "approval flag permits prompt text artifact"

runtime_prompt_repo="$(new_repo runtime-prompt-workflow)"
mkdir -p "$runtime_prompt_repo/.github/workflows"
cat >"$runtime_prompt_repo/.github/workflows/auto-rca.yml" <<'YAML'
name: Auto RCA
jobs:
  rca:
    runs-on: ubuntu-latest
    steps:
      - run: echo "prompt=/RCA on production agent <agent-id>"
YAML
git -C "$runtime_prompt_repo" add .github/workflows/auto-rca.yml
expect_fail "$runtime_prompt_repo" "runtime prompt workflow requires approval"
expect_flag_pass "$runtime_prompt_repo" "approval flag permits runtime prompt workflow"

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

tool_description_repo="$(new_repo tool-description)"
mkdir -p "$tool_description_repo/agents/providers/rose"
cat >"$tool_description_repo/agents/providers/rose/browser_use.py" <<'PY'
BROWSER_USE_TOOLS = {
    "read_network_requests": {
        "description": (
            "Inspect the page's network traffic, like the DevTools Network panel."
        ),
        "params": {},
    },
}
PY
git -C "$tool_description_repo" add agents/providers/rose/browser_use.py
expect_fail "$tool_description_repo" "tool description text requires approval"
expect_flag_pass "$tool_description_repo" "approval flag permits a tool description edit"

browser_tool_continuation_repo="$(new_repo browser-tool-continuation)"
mkdir -p "$browser_tool_continuation_repo/agents/providers/rose"
cat >"$browser_tool_continuation_repo/agents/providers/rose/browser_use.py" <<'PY'
BROWSER_USE_TOOLS = {
    "recover_from_challenge": {
        "description": (
            "Recover from a verified challenge. "
            "Never use for an ordinary load failure."
        ),
    },
}
PY
git -C "$browser_tool_continuation_repo" add agents/providers/rose/browser_use.py
git -C "$browser_tool_continuation_repo" commit -q -m "seed browser tool"
sed -i.bak 's/ordinary load failure/uncited load failure/' \
  "$browser_tool_continuation_repo/agents/providers/rose/browser_use.py"
rm "$browser_tool_continuation_repo/agents/providers/rose/browser_use.py.bak"
expect_fail "$browser_tool_continuation_repo" "browser tool description continuation requires approval"
expect_flag_pass "$browser_tool_continuation_repo" "approval flag permits a browser tool continuation edit"

# Auth-option rendering is model-facing even when only a continuation changes.
auth_options_continuation_repo="$(new_repo auth-options-continuation)"
mkdir -p "$auth_options_continuation_repo/agents/domains/spawn_browser_agent_v3"
cat >"$auth_options_continuation_repo/agents/domains/spawn_browser_agent_v3/service_crypto.py" <<'PYTHON'
def build_auth_options_prompt_section(minted):
    minted_phone = minted.get("phone")
    phone_clause = f" | Phone -> {minted_phone}" if minted_phone else ""
    return phone_clause
PYTHON
git -C "$auth_options_continuation_repo" add agents/domains/spawn_browser_agent_v3/service_crypto.py
git -C "$auth_options_continuation_repo" commit -q -m "seed auth option renderer"
cat >"$auth_options_continuation_repo/agents/domains/spawn_browser_agent_v3/service_crypto.py" <<'PYTHON'
def build_auth_options_prompt_section(minted):
    minted_phone = minted.get("phone")
    phone_clause = f" | Phone -> {minted_phone}" if minted_phone else ""
    if minted_phone and minted.get("phoneProvider") == "agentphone" and not minted.get("disabled"):
        phone_clause += " (SMS codes sent here are read automatically)"
    return phone_clause
PYTHON
expect_fail "$auth_options_continuation_repo" "auth option phone continuation requires approval"
expect_flag_pass "$auth_options_continuation_repo" "fixture approval flag permits an auth option continuation edit"

# Regression: 2026-08-04 Blue Bottle — SMS Tools.schemas.ts puts the description
# string on the line AFTER `description:`, so assignment-line matching misses.
multiline_tool_schema_repo="$(new_repo multiline-tools-schemas)"
mkdir -p "$multiline_tool_schema_repo/back-end/src/providers/smsSupervisor"
cat >"$multiline_tool_schema_repo/back-end/src/providers/smsSupervisor/supervisorTools.schemas.ts" <<'TS'
export const TOOL_SCHEMAS = [
  {
    name: 'start_new_agent',
    description:
      'Spawn an autonomous agent that decomposes a goal and runs sub-agents in parallel. Use for work that cannot finish inside this SMS round-trip.',
    parameters: { type: 'object' as const, properties: {} },
  },
];
TS
git -C "$multiline_tool_schema_repo" add back-end/src/providers/smsSupervisor/supervisorTools.schemas.ts
git -C "$multiline_tool_schema_repo" commit -q -m "seed schemas"
cat >"$multiline_tool_schema_repo/back-end/src/providers/smsSupervisor/supervisorTools.schemas.ts" <<'TS'
export const TOOL_SCHEMAS = [
  {
    name: 'start_new_agent',
    description:
      "Spawn an autonomous agent that decomposes a goal and runs sub-agents in parallel. Use for work that cannot finish inside this SMS round-trip — purchases/orders. This is the SMS-surface equivalent of spawn_agent — call start_new_agent here; do not invent progress in send_user_message without calling it.",
    parameters: { type: 'object' as const, properties: {} },
  },
];
TS
git -C "$multiline_tool_schema_repo" add back-end/src/providers/smsSupervisor/supervisorTools.schemas.ts
expect_fail "$multiline_tool_schema_repo" "multi-line Tools.schemas.ts description requires approval"
expect_flag_pass "$multiline_tool_schema_repo" "approval flag permits multi-line Tools.schemas.ts edit"

# Same incident: SMS_SURFACE_OVERLAY bullet edited far below the const assignment.
sms_overlay_repo="$(new_repo sms-overlay-continuation)"
mkdir -p "$sms_overlay_repo/back-end/src/providers/smsSupervisor"
cat >"$sms_overlay_repo/back-end/src/providers/smsSupervisor/contextBuilder.ts" <<'TS'
export const SMS_SURFACE_OVERLAY = `# SMS Surface
- Be conversational but concise, this is texting, not email
- Do not send a placeholder such as "I'll check now" and then stop. If you send a progress message, keep working in the same run and send the substantive result before attempt_completion.`;
TS
git -C "$sms_overlay_repo" add back-end/src/providers/smsSupervisor/contextBuilder.ts
git -C "$sms_overlay_repo" commit -q -m "seed overlay"
cat >"$sms_overlay_repo/back-end/src/providers/smsSupervisor/contextBuilder.ts" <<'TS'
export const SMS_SURFACE_OVERLAY = `# SMS Surface
- Be conversational but concise, this is texting, not email
- Do not send a placeholder such as "I'll check now" and then stop. If you send a progress message, keep working in the same run and send the substantive result before attempt_completion.
- Agent lifecycle tools on THIS surface are start_new_agent and kill_agent only. There is no spawn_agent tool here (that name belongs to the main agent harness). Never claim you killed, started, placed, or submitted anything unless this run's tool results just confirmed it — texting progress without the matching tool call is a failure.`;
TS
git -C "$sms_overlay_repo" add back-end/src/providers/smsSupervisor/contextBuilder.ts
expect_fail "$sms_overlay_repo" "SMS surface overlay bullet continuation requires approval"
expect_flag_pass "$sms_overlay_repo" "approval flag permits SMS surface overlay edit"

pydantic_field_repo="$(new_repo pydantic-tool-field)"
mkdir -p "$pydantic_field_repo/agents/browser_tools"
cat >"$pydantic_field_repo/agents/browser_tools/schemas.py" <<'PY'
class ReadNetworkRequestsBrowserTool(BaseModel):
    tool: Literal["read_network_requests"]
    include_bodies: Optional[bool] = Field(
        default=None, description="When true, include captured response bodies."
    )
PY
git -C "$pydantic_field_repo" add agents/browser_tools/schemas.py
expect_fail "$pydantic_field_repo" "Pydantic tool Field description requires approval"

zod_description_repo="$(new_repo zod-description)"
mkdir -p "$zod_description_repo/back-end/src/providers/smsSupervisor"
cat >"$zod_description_repo/back-end/src/providers/smsSupervisor/schema.ts" <<'TS'
import { z } from 'zod';

const budgetDollars = z
  .number()
  .nullable()
  .describe(
    'Agent-run budget for LLM and metered tool calls only. Never include purchase cost.'
  );
TS
git -C "$zod_description_repo" add back-end/src/providers/smsSupervisor/schema.ts
expect_fail "$zod_description_repo" "Zod schema description requires approval"
expect_flag_pass "$zod_description_repo" "approval flag permits a Zod schema description"

# A guard that only matches the bare `zod` specifier is bypassed by the
# versioned entrypoint, and one that only scans .ts/.js is bypassed by .mjs.
zod_subpath_repo="$(new_repo zod-subpath)"
mkdir -p "$zod_subpath_repo/back-end/src/providers/tools"
cat >"$zod_subpath_repo/back-end/src/providers/tools/schema.mjs" <<'MJS'
import { z } from 'zod/v4';

export const query = z
  .string()
  .describe('Search the user local data. Prefer this over the public web.');
MJS
git -C "$zod_subpath_repo" add back-end/src/providers/tools/schema.mjs
expect_fail "$zod_subpath_repo" "Zod subpath import in .mjs requires approval"
expect_flag_pass "$zod_subpath_repo" "approval flag permits a zod subpath .mjs description"

zod_description_edit_repo="$(new_repo zod-description-edit)"
mkdir -p "$zod_description_edit_repo/src"
cat >"$zod_description_edit_repo/src/schema.ts" <<'TS'
import { z } from 'zod';

export const BudgetSchema = z.number().nullable().describe(
  'Old model-visible budget guidance.'
);
TS
git -C "$zod_description_edit_repo" add src/schema.ts
git -C "$zod_description_edit_repo" commit -q -m "seed Zod description"
sed -i.bak 's/Old model-visible/New model-visible/' "$zod_description_edit_repo/src/schema.ts"
rm "$zod_description_edit_repo/src/schema.ts.bak"
git -C "$zod_description_edit_repo" add src/schema.ts
expect_fail "$zod_description_edit_repo" "editing existing multiline Zod description requires approval"
expect_flag_pass "$zod_description_edit_repo" "approval flag permits a Zod description text edit"

unrelated_describe_repo="$(new_repo unrelated-describe)"
mkdir -p "$unrelated_describe_repo/src"
cat >"$unrelated_describe_repo/src/workflow.ts" <<'TS'
export async function inspectWorkflow(handle: WorkflowHandle) {
  return handle.describe();
}
TS
git -C "$unrelated_describe_repo" add src/workflow.ts
expect_pass "$unrelated_describe_repo" "unrelated describe API call is not prompt text"

description_passthrough_repo="$(new_repo description-passthrough)"
mkdir -p "$description_passthrough_repo/src"
cat >"$description_passthrough_repo/src/registry.ts" <<'TS'
export function toTool(entry: CatalogEntry) {
  return { name: entry.name, description: entry.description };
}
TS
git -C "$description_passthrough_repo" add src/registry.ts
expect_pass "$description_passthrough_repo" "passing an existing description through is not a prompt edit"

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

bench_add_repo="$(new_repo bench-task-add)"
mkdir -p "$bench_add_repo/agents/benchmarks"
cat >"$bench_add_repo/agents/benchmarks/tasks.json" <<'JSON'
[
  { "name": "existing-task", "prompt": "Do the existing thing." }
]
JSON
git -C "$bench_add_repo" add agents/benchmarks/tasks.json
git -C "$bench_add_repo" commit -q -m "seed catalog"
cat >"$bench_add_repo/agents/benchmarks/tasks.json" <<'JSON'
[
  { "name": "existing-task", "prompt": "Do the existing thing." },
  { "name": "brand-new-task", "prompt": "You are a new benchmark eval. Do a new thing." }
]
JSON
git -C "$bench_add_repo" add agents/benchmarks/tasks.json
expect_pass "$bench_add_repo" "adding a benchmark task (a strict ADD) does not require approval"

bench_delete_repo="$(new_repo bench-task-delete)"
mkdir -p "$bench_delete_repo/agents/benchmarks"
cat >"$bench_delete_repo/agents/benchmarks/tasks.json" <<'JSON'
[
  { "name": "keep-task", "prompt": "Keep me." },
  { "name": "doomed-task", "prompt": "Delete me." }
]
JSON
git -C "$bench_delete_repo" add agents/benchmarks/tasks.json
git -C "$bench_delete_repo" commit -q -m "seed catalog"
cat >"$bench_delete_repo/agents/benchmarks/tasks.json" <<'JSON'
[
  { "name": "keep-task", "prompt": "Keep me." }
]
JSON
git -C "$bench_delete_repo" add agents/benchmarks/tasks.json
expect_fail "$bench_delete_repo" "deleting a benchmark task requires approval"
expect_flag_pass "$bench_delete_repo" "approval flag permits a benchmark task deletion"

test_delete_repo="$(new_repo test-file-delete)"
mkdir -p "$test_delete_repo/back-end/src/tests/blackbox"
cat >"$test_delete_repo/back-end/src/tests/blackbox/widget.blackbox.ts" <<'TS'
export const test = "covers the widget route";
TS
git -C "$test_delete_repo" add back-end/src/tests/blackbox/widget.blackbox.ts
git -C "$test_delete_repo" commit -q -m "seed test"
git -C "$test_delete_repo" rm -q back-end/src/tests/blackbox/widget.blackbox.ts
expect_fail "$test_delete_repo" "deleting a blackbox test file requires approval"
expect_flag_pass "$test_delete_repo" "approval flag permits a test-file deletion"

embedded_test_delete_repo="$(new_repo embedded-test-file-delete)"
mkdir -p "$embedded_test_delete_repo/src"
cat >"$embedded_test_delete_repo/src/mytest_helpers.ts" <<'TS'
export const helper = "covers a prompt-adjacent path";
TS
git -C "$embedded_test_delete_repo" add src/mytest_helpers.ts
git -C "$embedded_test_delete_repo" commit -q -m "seed embedded-name test"
git -C "$embedded_test_delete_repo" rm -q src/mytest_helpers.ts
expect_fail "$embedded_test_delete_repo" "deleting a filename containing test requires approval"
expect_flag_pass "$embedded_test_delete_repo" "approval flag permits an embedded-name test deletion"

semantic_delete_repo="$(new_repo semantic-spec-delete)"
mkdir -p "$semantic_delete_repo/front-end/tests-e2e"
cat >"$semantic_delete_repo/front-end/tests-e2e/login.spec.ts" <<'TS'
export const spec = "login lifecycle";
TS
git -C "$semantic_delete_repo" add front-end/tests-e2e/login.spec.ts
git -C "$semantic_delete_repo" commit -q -m "seed semantic spec"
git -C "$semantic_delete_repo" rm -q front-end/tests-e2e/login.spec.ts
expect_fail "$semantic_delete_repo" "deleting a semantic (e2e) spec requires approval"

echo "All prompt guard tests passed."
