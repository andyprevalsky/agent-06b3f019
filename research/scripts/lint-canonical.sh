#!/usr/bin/env bash
# Canonical utility enforcement for the research repo.
#
# Deno has no equivalent of ESLint's `no-restricted-syntax` / `no-restricted-imports`,
# so we use grep to ban hand-rolled alternatives to canonical providers/config.
#
# Rules:
#   1. Deno.env.get: only allowed in domains/**/config.ts and providers/**
#   2. console.(log|error|warn|info|debug): only allowed in providers/**,
#      CLI/benchmark domains (benchmark-runner, benchmark-production),
#      benchmarks/, scripts/, tests/
#   3. crypto.(randomUUID|getRandomValues): only allowed in providers/**
#
# Each violation points the author at the canonical provider to use instead.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  local allowed_pattern="$3"
  local remediation="$4"
  shift 4
  local search_paths=("$@")

  # grep with -E for regex, -r recursive, -n line numbers, --include for TS only
  local hits
  # shellcheck disable=SC2086
  hits=$(grep -rn -E "$pattern" \
    --include='*.ts' --include='*.tsx' \
    "${search_paths[@]}" 2>/dev/null \
    | grep -E -v "$allowed_pattern" || true)

  if [[ -n "$hits" ]]; then
    echo "❌ $label"
    echo "$hits"
    echo "   → $remediation"
    echo ""
    FAIL=1
  fi
}

# Rule 1: Deno.env.get must live in config.ts or providers/
check "Deno.env.get outside config.ts" \
  '\bDeno\.env\.get\b' \
  '(^|/)(config\.ts|providers/)' \
  "Add an env getter to domains/<domain>/config.ts and import it. Example: getOpenRouterApiKey() in domains/completions/config.ts." \
  domains/

# Rule 2: console.* must go through providers/logger.ts slog()
# Exempt: providers/ itself (canonical sink), CLI benchmark domains, benchmarks/,
# scripts/, tests/. Everything else must use slog().
check "console.* outside canonical logger" \
  '\bconsole\.(log|error|warn|info|debug)\b' \
  '(^|/)(providers/|domains/benchmark-runner/|domains/benchmark-production/|benchmarks/|scripts/|tests/)' \
  "Use slog() from providers/logger.ts instead of console.*." \
  domains/

# Rule 3: crypto.randomUUID / crypto.getRandomValues must go through providers/crypto.ts
check "crypto.* outside providers/crypto.ts" \
  '\bcrypto\.(randomUUID|getRandomValues)\b' \
  '(^|/)providers/' \
  "Use randomUUID() / randomBytes() from providers/crypto.ts instead of the raw Web Crypto API." \
  domains/

if (( FAIL == 0 )); then
  echo "✅ Canonical utility enforcement: 0 violations"
fi

exit $FAIL
