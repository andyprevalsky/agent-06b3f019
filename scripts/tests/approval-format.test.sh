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
require_text "$FORMAT" '**FE link:** [Open agent](<frontend-agent-url>) — <verification status>' \
  "approval requests must include a concrete FE agent link"
require_text "$FORMAT" '**LLM dump:** [Open rendered dump](<rendered-html-url>) — `<call_site>`' \
  "approval requests must include a rendered LLM dump link"
require_text "$FORMAT" "python3 scripts/render_llm_dump.py" \
  "approval requests must render LLM dumps before presenting"
require_text "$FORMAT" "**Local repro (<wall-clock>):**" \
  "approval requests must include local repro steps with measured wall-clock"
require_text "$FORMAT" "- **Evaluators:**" \
  "approval requests must list catalog evaluators"
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
require_text "$DESCEND" "**Local repro (<wall-clock>):**" \
  "/descend Stop 1 must include local repro wall-clock"
require_text "$DESCEND" "**LLM dump:** [Open rendered dump](<rendered-html-url>) — \`<call_site>\`" \
  "/descend Stop 1 must include the rendered LLM dump link"
require_text "$RCA" "FE link, rendered LLM dump link, numbered local-repro steps" \
  "/rca approval output must require the Evidence pack"

if grep -Fq "exact five-part RCA narrative" "$DESCEND"; then
  fail "/descend must not retain its superseded five-part approval narrative"
fi

if grep -Fq "the canonical four-part approval narrative" "$DESCEND"; then
  fail "/descend must not retain the superseded four-part approval narrative"
fi

if grep -Fq "**Exact benchmark task (\`task.prompt\`, verbatim):**" "$DESCEND"; then
  fail "/descend must put task.prompt inside Evidence, not as a standalone lead-in"
fi

echo "All shared approval-format checks passed."
