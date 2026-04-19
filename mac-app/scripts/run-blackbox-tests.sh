#!/bin/bash
# Blackbox test runner for mac-app.
#
# Usage:
#   bash scripts/run-blackbox-tests.sh                # run all blackbox suites
#   bash scripts/run-blackbox-tests.sh <domain>       # run one domain's suite
#   bash scripts/run-blackbox-tests.sh --list         # list available domain suites
#
# Writes artifacts to .context/test-runs/<run-id>/ with manifest.json + runner.log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${1:-}" == "--list" ]]; then
  find tests/blackbox -maxdepth 1 \( -name '*.blackbox.ts' -o -name '*.blackbox.tsx' \) \
    | sed 's|tests/blackbox/||' \
    | sed -E 's|\.blackbox\.tsx?$||' \
    | sort -u
  exit 0
fi

DOMAIN="${1:-}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
ARTIFACT_DIR=".context/test-runs/$RUN_ID"
mkdir -p "$ARTIFACT_DIR"

cat > "$ARTIFACT_DIR/manifest.json" <<EOF
{
  "run_id": "$RUN_ID",
  "mode": "jsdom-blackbox",
  "artifact_dir": "$ARTIFACT_DIR",
  "test_environment": "jsdom",
  "framework": "react",
  "domain": "${DOMAIN:-all}",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

RUNNER_LOG="$ARTIFACT_DIR/runner.log"

if [[ -n "$DOMAIN" ]]; then
  PATTERN="tests/blackbox/${DOMAIN}.blackbox"
  echo "Running blackbox suite for domain: $DOMAIN" | tee "$RUNNER_LOG"
  set +e
  npx vitest run --reporter=verbose "$PATTERN" 2>&1 | tee -a "$RUNNER_LOG"
  STATUS=${PIPESTATUS[0]}
  set -e
else
  echo "Running all blackbox suites" | tee "$RUNNER_LOG"
  set +e
  npx vitest run --reporter=verbose 2>&1 | tee -a "$RUNNER_LOG"
  STATUS=${PIPESTATUS[0]}
  set -e
fi

echo "Artifact: $ARTIFACT_DIR"
exit "$STATUS"
