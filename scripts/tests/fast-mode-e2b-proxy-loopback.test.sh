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
grep -q 'BENCHMARK_SKIP_PUBLIC_TUNNEL' "$RUN_SH" \
  || fail "run.sh must gate Fast Mode proxy on BENCHMARK_SKIP_PUBLIC_TUNNEL"
# The skip-tunnel branch must clear both proxy URLs (empty string), not pin localhost.
awk '
  /BENCHMARK_SKIP_PUBLIC_TUNNEL.*PUBLIC_BASE_URL is not E2B-reachable|Fast-mode proxy off — PUBLIC_BASE_URL/ { hit=1 }
  hit && /FAST_MODE_ANTHROPIC_PROXY_URL=""/ { a=1 }
  hit && /FAST_MODE_CODEX_PROXY_URL=""/ { c=1 }
  END { exit !(a && c) }
' "$RUN_SH" \
  || fail "skip-tunnel / loopback PUBLIC_BASE_URL path must clear FAST_MODE_*_PROXY_URL"

# Provider-side defense in depth (E2B inject path).
ENV_TS="$ROOT_DIR/back-end/src/providers/codeAgentFastModeEnv.ts"
grep -q 'isE2bReachableProxyBaseUrl' "$ENV_TS" \
  || fail "codeAgentFastModeEnv must export isE2bReachableProxyBaseUrl"
grep -q 'localhost' "$ENV_TS" \
  || fail "codeAgentFastModeEnv must explicitly reject localhost proxy bases"

echo "fast-mode-e2b-proxy-loopback contract ok"
