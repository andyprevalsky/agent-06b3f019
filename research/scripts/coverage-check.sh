#!/usr/bin/env bash
# Enforce minimum coverage for the research repo.
#
# TS domains  → Deno coverage, threshold enforced here (line %).
# gepa (py)   → pytest-cov threshold, baked into pyproject.toml.
#
# Ratchet only — increase thresholds as new tests land; never decrease.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Current baselines (2026-04-18): TS domains 96.6% line / 92.2% branch / 98.3% func.
# Python gepa 99.66% line. Rounded DOWN to nearest 5% per enforce-code-coverage skill.
TS_MIN_LINE_PCT=${TS_MIN_LINE_PCT:-95}

echo "=== TS unit tests + coverage (domains) ==="
OUTPUT="$(bash "$SCRIPT_DIR/test-unit.sh" --coverage domains 2>&1)"
echo "$OUTPUT"

# Extract the "All files" summary line from the domain-scoped section.
# deno coverage prints rows like: `| All files ... | 92.2 | 98.3 | 96.6 |`.
ALL_LINE="$(echo "$OUTPUT" | tr -d '\r' | awk '/── Coverage for: domains ──/{f=1} f && /All files/{print; exit}')"
if [[ -z "$ALL_LINE" ]]; then
  echo "coverage-check: could not parse 'All files' summary from test-unit.sh output" >&2
  exit 2
fi

# Strip ANSI color codes, then extract the last numeric column (line %).
LINE_PCT="$(echo "$ALL_LINE" | sed 's/\x1b\[[0-9;]*m//g' | awk -F'|' '{gsub(/ /,"",$5); print $5}')"
if [[ -z "$LINE_PCT" ]]; then
  echo "coverage-check: failed to extract line % from: $ALL_LINE" >&2
  exit 2
fi

echo ""
echo "TS domains line coverage: ${LINE_PCT}% (threshold: ${TS_MIN_LINE_PCT}%)"

# Float compare via awk (avoids bash integer-only arithmetic).
if awk -v got="$LINE_PCT" -v min="$TS_MIN_LINE_PCT" 'BEGIN{exit !(got+0 < min+0)}'; then
  echo "❌ TS coverage ${LINE_PCT}% is below threshold ${TS_MIN_LINE_PCT}%" >&2
  exit 1
fi
echo "✅ TS coverage threshold met."

echo ""
echo "=== Python gepa unit tests + coverage ==="
bash "$SCRIPT_DIR/test-gepa.sh"

echo ""
echo "✅ All coverage thresholds met."
