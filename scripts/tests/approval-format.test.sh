#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORMAT="$ROOT_DIR/.claude/shared/approval-format.md"
DEPLOY="$ROOT_DIR/.claude/commands/deploy.md"
RCA="$ROOT_DIR/.claude/commands/rca.md"
DESCEND="$ROOT_DIR/.claude/commands/descend.md"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1"
  local text="$2"
  local description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$FORMAT" ] || fail "canonical approval format is missing"

for heading in "## Evidence" "## Detail" "## Before Behavior" "## After Behavior" "## Downstream Implications"; do
  require_text "$FORMAT" "$heading" "canonical approval format must include $heading"
done

python3 - "$FORMAT" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
headings = [
    "## TL;DR",
    "## Evidence",
    "## Detail",
    "## Before Behavior",
    "## After Behavior",
    "## Downstream Implications",
]
positions = [text.index(heading) for heading in headings]
if positions != sorted(positions):
    raise SystemExit("FAIL: canonical approval headings are out of order")
PY

require_text "$FORMAT" "name the exact unchanged test or" \
  "Detail must require an exact unchanged test"
require_text "$FORMAT" "reproduction command that failed before the change and now passes" \
  "Detail must name the unchanged failing-then-passing test"
require_text "$FORMAT" "clickable file-and-line links" \
  "approval scope must include clickable file-and-line links"
require_text "$FORMAT" '**What failed:** When <the agent doing the task goal>' \
  "approval requests must frame the failure inside the agent's task"
require_text "$FORMAT" 'the LLM called `<tool>` to <attempt>' \
  "the failure sentence must name the exact tool the LLM called"
require_text "$FORMAT" "without the tool name" \
  "a tool-less attempt description is invalid"
require_text "$FORMAT" "Invalid if deleting the task goal still leaves a grammatical sentence" \
  "approval failure sentences must not stand without the task goal"
require_text "$FORMAT" '**FE link:** [Open agent](<frontend-agent-url>) — <verification status>' \
  "approval requests must include a concrete FE agent link"
require_text "$FORMAT" '**LLM dump:** [Open rendered dump](<rendered-html-url>) — last call `<call_site>` on `<agent_id>`' \
  "approval requests must include a rendered LLM dump of the last call in the trajectory"
require_text "$FORMAT" "last LLM call in the entire trajectory" \
  "approval LLM dumps must be the last call across the whole agent tree"
require_text "$FORMAT" "python3 scripts/render_llm_dump.py" \
  "approval requests must render LLM dumps before presenting"
require_text "$FORMAT" "**Local repro (<wall-clock>):**" \
  "approval requests must include local repro steps with measured wall-clock"
require_text "$FORMAT" "Tests: <one sentence naming the actual assertion" \
  "local repro must say what is actually being tested"
require_text "$FORMAT" "- **Evaluators:**" \
  "approval requests must list catalog evaluators"
require_text "$FORMAT" '`<how checked>` must be one of `semantic`, `exact string`, `regex`, `count`,' \
  "evaluators must name how they are checked"
require_text "$FORMAT" "never stop at the method name" \
  "evaluators must not hide behind catalog method names"
require_text "$FORMAT" "- **Fixtures:**" \
  "approval requests must list data fixtures"
require_text "$FORMAT" "- **Task prompt:**" \
  "approval requests must include the verbatim task prompt"
require_text "$FORMAT" 'verified rendered' \
  "approval requests must report successful FE-link verification"
require_text "$FORMAT" 'verified reachable' \
  "approval requests must distinguish HTTP reachability from visual rendering"
require_text "$FORMAT" 'expired/unreachable' \
  "approval requests must report dead FE links honestly"
require_text "$FORMAT" 'restore an archived viewer without rerunning a' \
  "approval requests must restore archived FE evidence when safe"
require_text "$FORMAT" 'https://www.roselabs.ai/open-agent?agent-id=' \
  "approval FE links must prefer the durable open-agent deep link"
require_text "$FORMAT" 'python3 scripts/publish_evidence_links.py' \
  "approval Evidence must publish FE + LLM dumps via publish_evidence_links"
require_text "$FORMAT" '/opt/cursor/artifacts' \
  "approval LLM dumps must land under Cursor artifacts for multi-day reachability"
require_text "$FORMAT" 'Never link `file://…/.context/rendered-llm-dumps/…`' \
  "approval LLM dumps must not cite workspace-local file:// render paths alone"
require_text "$FORMAT" "Never invent a failing test." \
  "approval requests must distinguish proactive changes from reproduced failures"
require_text "$FORMAT" "Not applicable — <reason>" \
  "approval requests must keep Evidence labels when a field does not apply"

for command in "$DEPLOY" "$RCA" "$DESCEND"; do
  require_text "$command" ".claude/shared/approval-format.md" \
    "$(basename "$command") must reference the shared approval format"
  require_text "$command" "Read it completely immediately before" \
    "$(basename "$command") must reload the shared format at approval time"
done

require_text "$DEPLOY" "bash scripts/tests/approval-format.test.sh" \
  "/deploy must cement the shared approval format in its no-skip structural gate"
require_text "$DESCEND" "the canonical approval narrative" \
  "/descend approval stops must use the canonical approval narrative"
require_text "$DESCEND" "**What failed:** When <the agent doing the task goal>" \
  "/descend Stop 1 must frame the failure inside the agent's task"
require_text "$DESCEND" "the LLM called \`<tool>\` to <attempt>" \
  "/descend What failed must name the exact tool"
require_text "$DESCEND" "**Local repro (<wall-clock>):**" \
  "/descend Stop 1 must include local repro wall-clock"
require_text "$DESCEND" "**LLM dump:** [Open rendered dump](<rendered-html-url>) — last call \`<call_site>\` on \`<agent_id>\`" \
  "/descend Stop 1 must include the last-call rendered LLM dump link"
require_text "$DESCEND" "Tests: <one sentence naming the actual assertion>" \
  "/descend Stop 1 must describe what the local repro tests"
require_text "$DESCEND" "**<how checked>**" \
  "/descend Stop 1 must name how each evaluator is checked"
require_text "$RCA" "task-framed \`What failed:\` sentence, the durable FE link" \
  "/rca approval output must require the Evidence pack"

if grep -Fq "exact five-part RCA narrative" "$DESCEND"; then
  fail "/descend must not retain its superseded five-part approval narrative"
fi

if grep -Fq "the canonical four-part approval narrative" "$DESCEND"; then
  fail "/descend must not retain the superseded four-part approval narrative"
fi

if grep -Fq "primary link is the failing call site" "$FORMAT"; then
  fail "approval LLM dumps must be the last trajectory call, not the failing call"
fi

if grep -Fq "**LLM dump:** [Open rendered dump](<rendered-html-url>) — \`<call_site>\`" "$DESCEND"; then
  fail "/descend must label the LLM dump as the last call, not a bare call_site"
fi

echo "All shared approval-format checks passed."
