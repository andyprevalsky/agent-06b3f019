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

for heading in "## Detail" "## Before Behavior" "## After Behavior" "## Downstream Implications"; do
  require_text "$FORMAT" "$heading" "canonical approval format must include $heading"
done

python3 - "$FORMAT" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
headings = [
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

for command in "$DEPLOY" "$RCA" "$DESCEND"; do
  require_text "$command" ".claude/shared/approval-format.md" \
    "$(basename "$command") must reference the shared approval format"
  require_text "$command" "Read it completely immediately before" \
    "$(basename "$command") must reload the shared format at approval time"
done

require_text "$DEPLOY" "bash scripts/tests/approval-format.test.sh" \
  "/deploy must cement the shared approval format in its no-skip structural gate"
require_text "$DESCEND" "the canonical four-part approval narrative" \
  "/descend approval stops must use the canonical four-part narrative"

if grep -Fq "exact five-part RCA narrative" "$DESCEND"; then
  fail "/descend must not retain its superseded five-part approval narrative"
fi

echo "All shared approval-format checks passed."
