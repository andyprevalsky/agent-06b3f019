#!/usr/bin/env bash
# Cement: when BENCHMARK_SKIP_PUBLIC_TUNNEL pins PUBLIC_BASE_URL to localhost,
# run.sh must NOT export that loopback as FAST_MODE_*_PROXY_URL for E2B.
# RCA: files-in-sub-agents 2026-08-20 — Claude Code ConnectionRefused.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }

grep -q 'E2B-reachable' "$RUN_SH" \
  || fail "run.sh must refuse Fast Mode proxy when PUBLIC_BASE_URL is not E2B-reachable"

# The skip-tunnel / loopback branch must clear both proxy URLs (empty string).
# Extract the elif block that mentions E2B-reachable and assert both clears.
BLOCK="$(
  awk '
    /not E2B-reachable/ { print; inblk=1; next }
    inblk && /^elif |^else$|^fi$/ { exit }
    inblk { print }
  ' "$RUN_SH"
)"
printf '%s\n' "$BLOCK" | grep -q 'FAST_MODE_ANTHROPIC_PROXY_URL=""' \
  || fail "E2B-unreachable branch must clear FAST_MODE_ANTHROPIC_PROXY_URL"
printf '%s\n' "$BLOCK" | grep -q 'FAST_MODE_CODEX_PROXY_URL=""' \
  || fail "E2B-unreachable branch must clear FAST_MODE_CODEX_PROXY_URL"
printf '%s\n' "$BLOCK" | grep -q 'localhost' \
  || fail "E2B-unreachable branch must mention localhost PUBLIC_BASE_URL"

# Provider-side defense in depth (E2B inject path).
ENV_TS="$ROOT_DIR/back-end/src/providers/codeAgentFastModeEnv.ts"
grep -q 'isE2bReachableProxyBaseUrl' "$ENV_TS" \
  || fail "codeAgentFastModeEnv must export isE2bReachableProxyBaseUrl"
grep -q "host === 'localhost'" "$ENV_TS" \
  || fail "codeAgentFastModeEnv must explicitly reject localhost proxy bases"

echo "fast-mode-e2b-proxy-loopback contract ok"
