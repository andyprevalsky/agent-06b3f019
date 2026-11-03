#!/usr/bin/env bash
# Cement: when BENCHMARK_SKIP_PUBLIC_TUNNEL pins PUBLIC_BASE_URL to localhost,
# run.sh must NOT export that loopback as FAST_MODE_*_PROXY_URL for E2B.
# RCA: files-in-sub-agents 2026-08-20 — Claude Code ConnectionRefused.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }

grep -q 'not E2B-reachable' "$RUN_SH" \
  || fail "run.sh must refuse Fast Mode proxy when PUBLIC_BASE_URL is not E2B-reachable"
grep -q 'BENCHMARK_SKIP_PUBLIC_TUNNEL:-.*" = "1"' "$RUN_SH" \
  || fail "run.sh must gate Fast Mode proxy on BENCHMARK_SKIP_PUBLIC_TUNNEL"

# The elif that mentions SKIP_PUBLIC_TUNNEL / localhost must clear both URLs
# before the echo. Grep a contiguous window around the E2B-reachable message.
WINDOW="$(
  grep -n 'not E2B-reachable' "$RUN_SH" | head -1 | cut -d: -f1 \
    | xargs -I{} awk -v n={} 'NR>=n-6 && NR<=n {print}' "$RUN_SH"
)"
grep -Fq 'FAST_MODE_ANTHROPIC_PROXY_URL=""' <<<"$WINDOW" \
  || fail "E2B-unreachable branch must clear FAST_MODE_ANTHROPIC_PROXY_URL"
# Codex never routes through a Rose proxy (S30): run.sh must not point it at one.
if grep -Eq 'export FAST_MODE_CODEX_PROXY_URL=.+|/codex-proxy' "$RUN_SH"; then
  fail "run.sh must never export a Codex proxy URL"
fi
grep -q '^unset FAST_MODE_CODEX_PROXY_URL' "$RUN_SH" \
  || fail "run.sh must clear any inherited FAST_MODE_CODEX_PROXY_URL"
grep -Fq 'http://localhost:*' <<<"$WINDOW" \
  || fail "E2B-unreachable branch must match localhost PUBLIC_BASE_URL"

ENV_TS="$ROOT_DIR/back-end/src/providers/codeAgentFastModeEnv.ts"
grep -q 'isE2bReachableProxyBaseUrl' "$ENV_TS" \
  || fail "codeAgentFastModeEnv must export isE2bReachableProxyBaseUrl"
grep -q "host === 'localhost'" "$ENV_TS" \
  || fail "codeAgentFastModeEnv must explicitly reject localhost proxy bases"

echo "fast-mode-e2b-proxy-loopback contract ok"
