#!/usr/bin/env bash
# Cement the /RCA prompt-edit abstraction-deepening gate.
#
# Why this exists: prompt edits overfit when the Problem is named at the
# instance (or even the class) and a token is added for that one miss.
# The anti-overfit proof is to try one level of abstraction deeper — a
# more general solution that would eliminate the class (or the class of
# class, or the class of class of class) — and only stop when that more
# general solution fails to be coherent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RCA_COMMAND="$ROOT_DIR/.claude/commands/rca.md"
RCA_METHODOLOGY="$ROOT_DIR/docs/root-cause-analysis.md"
PROCESS_FEEDBACK="$ROOT_DIR/docs/rca/process-feedback.md"
TEST_RUNNER="$ROOT_DIR/scripts/test.sh"

require_text() {
  local file="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq "$expected" "$file"; then
    echo "FAIL: $message" >&2
    echo "  missing from ${file#"$ROOT_DIR"/}: $expected" >&2
    exit 1
  fi
}

require_text \
  "$RCA_METHODOLOGY" \
  '## Step 5b: Abstraction-deepening gate for prompt edits' \
  "methodology must add Step 5b as the prompt-edit abstraction gate"
require_text \
  "$RCA_METHODOLOGY" \
  'one level of abstraction deeper' \
  "methodology must require verifying the Problem by going one abstraction level deeper"
require_text \
  "$RCA_METHODOLOGY" \
  'more general solution' \
  "methodology must define the anti-overfit move as attempting a more general solution"
require_text \
  "$RCA_METHODOLOGY" \
  'fails to be coherent' \
  "methodology must stop the climb only when the more general solution fails to be coherent"
require_text \
  "$RCA_METHODOLOGY" \
  'class of class' \
  "methodology must require eliminating the class, or the class of class, not the instance"
require_text \
  "$RCA_METHODOLOGY" \
  'prompt edit' \
  "methodology must scope the abstraction climb to prompt edits"

require_text \
  "$RCA_COMMAND" \
  '## Prompt-edit abstraction gate' \
  "/RCA must surface the prompt-edit abstraction gate"
require_text \
  "$RCA_COMMAND" \
  'one level of abstraction deeper' \
  "/RCA must require verifying the Problem one abstraction level deeper"
require_text \
  "$RCA_COMMAND" \
  'more general solution' \
  "/RCA must require attempting a more general solution before a prompt edit"
require_text \
  "$RCA_COMMAND" \
  'fails to be coherent' \
  "/RCA must accept a prompt-level Problem only after the deeper solution fails to be coherent"
require_text \
  "$RCA_COMMAND" \
  'class of class' \
  "/RCA must require eliminating the class or class of class, not the instance"
require_text \
  "$RCA_COMMAND" \
  'next-deeper class' \
  "/RCA output must record the deeper class that was tried and why it failed"

require_text \
  "$PROCESS_FEEDBACK" \
  'one level of abstraction deeper' \
  "process-feedback must record the human rule against prompt-edit overfitting"
require_text \
  "$PROCESS_FEEDBACK" \
  'fails to be coherent' \
  "process-feedback must name the coherence-failure stop condition"

require_text \
  "$TEST_RUNNER" \
  'rca-prompt-edit-abstraction.test.sh' \
  "the full test gate must run this RCA contract"

echo "PASS: /RCA prompt-edit gate requires a failed deeper-abstraction attempt before a prompt edit"
