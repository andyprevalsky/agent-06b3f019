#!/usr/bin/env bash
set -euo pipefail

# Frontend Blackbox Test Runner
# Runs vitest-based blackbox tests for frontend domains.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
cd "$FRONTEND_DIR"

# --list mode: list available test domains
if [[ "${1:-}" == "--list" ]]; then
  echo "Available blackbox test domains:"
  for f in src/tests/blackbox/*.blackbox.ts src/tests/blackbox/*.blackbox.tsx; do
    [ -f "$f" ] || continue
    basename "$f" | sed 's/\.blackbox\.\(ts\|tsx\)$//'
  done
  exit 0
fi

# Direct runner bypasses npm pretest; verify required dependency cleanup first.
node scripts/patch-ui-lifecycle.mjs

# Generate run ID and artifact directory
RUN_ID="$(date +%Y%m%d_%H%M%S)_$$"
ARTIFACT_DIR=".context/test-runs/$RUN_ID"
mkdir -p "$ARTIFACT_DIR"

# Write manifest
cat > "$ARTIFACT_DIR/manifest.json" <<EOF
{
  "run_id": "$RUN_ID",
  "mode": "jsdom-blackbox",
  "artifact_dir": "$ARTIFACT_DIR",
  "test_environment": "jsdom",
  "framework": "react",
  "domain": "${1:-all}",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Determine test target
if [[ -n "${1:-}" ]]; then
  DOMAIN="$1"
  TEST_FILE="src/tests/blackbox/${DOMAIN}.blackbox.tsx"
  if [[ ! -f "$TEST_FILE" ]]; then
    TEST_FILE="src/tests/blackbox/${DOMAIN}.blackbox.ts"
  fi
  if [[ ! -f "$TEST_FILE" ]]; then
    echo "Error: No blackbox test file found for domain '$DOMAIN'"
    exit 1
  fi
  TEST_TARGET="$TEST_FILE"
else
  TEST_TARGET="src/tests/blackbox/"
fi

echo "=== Blackbox Test Run: $RUN_ID ==="
echo "Domain: ${1:-all}"
echo "Artifact dir: $ARTIFACT_DIR"
echo ""

# Run vitest
npx vitest run "$TEST_TARGET" --reporter=verbose 2>&1 | tee "$ARTIFACT_DIR/runner.log"
EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=== Run complete (exit code: $EXIT_CODE) ==="
echo "Logs: $ARTIFACT_DIR/runner.log"

exit $EXIT_CODE
