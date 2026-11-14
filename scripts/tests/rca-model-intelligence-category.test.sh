#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RCA_COMMAND="$ROOT_DIR/.claude/commands/rca.md"
TEST_RUNNER="$ROOT_DIR/scripts/test.sh"

require_text() {
  local file="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq "$expected" "$file"; then
    echo "FAIL: $message" >&2
    exit 1
  fi
}

require_text \
  "$RCA_COMMAND" \
  '**Model intelligence limitation**' \
  "RCA problem buckets must include model intelligence"
require_text \
  "$RCA_COMMAND" \
  'all non-model variables held constant' \
  "model-intelligence classification must require a model-only controlled replay"
require_text \
  "$RCA_COMMAND" \
  'report repeated trial counts' \
  "stochastic model comparisons must not rely on one lucky sample"
require_text \
  "$RCA_COMMAND" \
  'model intelligence limitation, or unresolved' \
  "/RCA must list model intelligence limitation as a failure class"
require_text \
  "$RCA_COMMAND" \
  'needs the original model failing and the upgraded model passing with all non-model variables held constant' \
  "/RCA must require the same-call model-only A/B result"
require_text \
  "$TEST_RUNNER" \
  'rca-model-intelligence-category.test.sh' \
  "the full test gate must run this RCA contract"

echo "PASS: /RCA model-intelligence classification requires controlled model-upgrade proof"
