#!/usr/bin/env bash
set -euo pipefail

# Research unit-test runner
# Runs the stub-based Deno unit tests under research/tests/*.test.ts that do
# NOT hit a live server (detected via the testClient helper import). All tests
# must be offline — no network, no running services, no Supabase instance.
#
# Usage:
#   bash research/scripts/test-unit.sh                          # all stub-based unit tests
#   bash research/scripts/test-unit.sh rose-benchmark-production   # single file (by basename)
#   bash research/scripts/test-unit.sh --coverage <path>        # + coverage on <path>
#
# Coverage example (domain-scoped):
#   bash research/scripts/test-unit.sh --coverage domains/benchmark-production

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DENO="${DENO_BIN:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"

cd "$RESEARCH_DIR"

COVERAGE=""
FILTER=""
PREV=""
for arg in "$@"; do
  case "$arg" in
    --coverage)
      PREV="--coverage"
      continue
      ;;
    --coverage=*)
      COVERAGE="${arg#--coverage=}"
      PREV=""
      continue
      ;;
    *)
      if [[ "$PREV" == "--coverage" ]]; then
        COVERAGE="$arg"
        PREV=""
        continue
      fi
      if [[ -z "$FILTER" ]]; then
        FILTER="$arg"
      fi
      PREV=""
      ;;
  esac
done

# A test file is a unit (stub-based) test iff it does NOT import the live
# `testClient` helper. Anything else belongs to the blackbox runner.
is_unit_test() {
  local file="$1"
  ! grep -q "from ['\"]\./utils/test-client" "$file" 2>/dev/null
}

TEST_FILES=()
if [[ -n "$FILTER" ]]; then
  TARGET="$RESEARCH_DIR/tests/${FILTER}.test.ts"
  if [[ ! -f "$TARGET" ]]; then
    echo "Unknown unit-test file: $FILTER" >&2
    echo "Available unit tests:" >&2
    for f in "$RESEARCH_DIR"/tests/*.test.ts; do
      [[ -f "$f" ]] || continue
      is_unit_test "$f" && echo "  $(basename "$f" .test.ts)" >&2
    done
    exit 1
  fi
  if ! is_unit_test "$TARGET"; then
    echo "Not a stub-based unit test: $FILTER" >&2
    echo "It imports a live test client; run via scripts/run-blackbox-tests.sh." >&2
    exit 1
  fi
  TEST_FILES+=("$TARGET")
else
  for f in "$RESEARCH_DIR"/tests/*.test.ts; do
    [[ -f "$f" ]] || continue
    is_unit_test "$f" && TEST_FILES+=("$f")
  done
fi

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "No unit-test files found under $RESEARCH_DIR/tests/"
  exit 1
fi

export DENO_NO_PACKAGE_JSON=1

if [[ -n "$COVERAGE" ]]; then
  COV_DIR="$RESEARCH_DIR/.coverage"
  rm -rf "$COV_DIR"
  "$DENO" test \
    --allow-env --allow-read \
    --no-config \
    --coverage="$COV_DIR" \
    "${TEST_FILES[@]}"
  echo ""
  echo "── Coverage for: $COVERAGE ──"
  "$DENO" coverage "$COV_DIR" --include="$COVERAGE"
else
  "$DENO" test \
    --allow-env --allow-read \
    --no-config \
    "${TEST_FILES[@]}"
fi
