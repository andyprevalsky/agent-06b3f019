#!/usr/bin/env bash
set -euo pipefail

# Research blackbox test runner
# Runs Deno-based blackbox tests against Supabase edge functions.
#
# Usage:
#   bash research/scripts/run-blackbox-tests.sh                    # all domains
#   bash research/scripts/run-blackbox-tests.sh delete-api-key     # single domain
#   bash research/scripts/run-blackbox-tests.sh --list             # list domains

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$RESEARCH_DIR/.." && pwd)"
DENO="${DENO_BIN:-$HOME/.deno/bin/deno}"

cd "$RESEARCH_DIR"

# Load .env if present
if [[ -f "$RESEARCH_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$RESEARCH_DIR/.env"
  set +a
fi

# When RESEARCH_PORT is set (Conductor workspace), always use local endpoint
# and local Supabase credentials (overrides .env which may point to prod).
# This ensures test JWT creation/validation happens against the same local
# Supabase instance that edge functions use.
if [[ -n "${RESEARCH_PORT:-}" ]]; then
  export BASE_URL="http://localhost:${RESEARCH_PORT}/functions/v1"

  # Fetch local Supabase keys so helpers.ts creates test users locally
  LOCAL_SB_ENV=$(cd "$RESEARCH_DIR/supabase" && supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)=' || true)
  if [[ -n "$LOCAL_SB_ENV" ]]; then
    eval "$LOCAL_SB_ENV"
    export SUPABASE_URL="${API_URL:-http://127.0.0.1:${RESEARCH_PORT}}"
    export SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
    export SUPABASE_ANON_KEY="${ANON_KEY}"
  fi
fi

TESTS_DIR="$RESEARCH_DIR/tests/blackbox"

# ── List mode (skip artifact creation) ──
if [[ "${1:-}" == "--list" ]]; then
  echo "Available research blackbox test domains:"
  if [[ -d "$TESTS_DIR" ]]; then
    for f in "$TESTS_DIR"/*.blackbox.ts; do
      [[ -f "$f" ]] || continue
      basename "$f" | sed 's/\.blackbox\.ts$//' | sed 's/^/  /'
    done
  else
    echo "  (no blackbox tests found)"
  fi
  exit 0
fi

RUN_ID="${BLACKBOX_TEST_RUN_ID:-$(date +%s)-$$-$RANDOM}"
export BLACKBOX_TEST_RUN_ID="$RUN_ID"
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}"
ARTIFACT_DIR="${BLACKBOX_TEST_ARTIFACT_DIR:-$ARTIFACT_ROOT/$RUN_ID}"
mkdir -p "$ARTIFACT_DIR"
export BLACKBOX_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"

RUNNER_LOG="$ARTIFACT_DIR/runner.log"
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"

# ── Domain filter ──
DOMAIN="${1:-}"

# ── Write manifest ──
cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"deno-blackbox","base_url":"${BASE_URL:-http://localhost:${RESEARCH_PORT:-54321}/functions/v1}","artifact_dir":"$ARTIFACT_DIR","runner_log":"$RUNNER_LOG","test_environment":"deno"}
EOF

echo "Research blackbox tests"
echo "Artifacts: $ARTIFACT_DIR"
echo "Base URL: ${BASE_URL:-https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1}"

# ── Build test file list ──
TEST_FILES=()
if [[ -n "$DOMAIN" ]]; then
  TARGET="$TESTS_DIR/$DOMAIN.blackbox.ts"
  if [[ ! -f "$TARGET" ]]; then
    echo "Unknown domain: $DOMAIN"
    echo "Available:"
    bash "$0" --list
    exit 1
  fi
  TEST_FILES+=("$TARGET")
else
  for f in "$TESTS_DIR"/*.blackbox.ts; do
    [[ -f "$f" ]] || continue
    TEST_FILES+=("$f")
  done
fi

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "No blackbox test files found in $TESTS_DIR"
  exit 1
fi

echo "Running ${#TEST_FILES[@]} test file(s)..."

# ── Run tests ──
# --parallel runs test cases concurrently within each file
# DENO_NO_PACKAGE_JSON prevents Deno from resolving the root npm workspace
export DENO_NO_PACKAGE_JSON=1
if ! "$DENO" test \
  --allow-net --allow-env --allow-read --allow-run=security \
  --config "$RESEARCH_DIR/deno.json" \
  --parallel \
  "${TEST_FILES[@]}" 2>&1 | tee "$RUNNER_LOG"; then
  echo ""
  echo "Blackbox tests failed. Artifacts: $ARTIFACT_DIR"
  exit 1
fi

echo ""
echo "All blackbox tests passed. Artifacts: $ARTIFACT_DIR"
