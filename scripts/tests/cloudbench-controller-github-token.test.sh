#!/usr/bin/env bash
# Owning-boundary regression for warm refresh-deps git-sync auth.
#
# Observed fleet abort (descend browser-event-ticket, 2026-08-20):
#   🔄 git-syncing /data/repo → <ref> ...
#      fatal: could not read Username for 'https://github.com': No such device or address
#   ❌ exact remote checkout failed
#   ❌ central dep refresh failed; refusing to provision task machines
#
# First-bad boundary: refresh-deps SSH snippet built AUTH_HDR only from the
# on-box GITHUB_TOKEN Fly secret. When that secret was absent, AUTH_HDR was
# empty and git asked for a username on a non-TTY. The controller already had
# a working credential in the git remote / insteadOf URL, but never passed it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/cloudbench-env.sh
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# ── 1. Legacy AUTH_HDR construction (the buggy boundary) ─────────────────────
legacy_auth_hdr() {
  local github_token="${1:-}"
  local AUTH_HDR=''
  [ -n "${github_token:-}" ] && AUTH_HDR="Authorization: Basic $(printf 'x-access-token:%s' "$github_token" | base64 | tr -d '\n')"
  printf '%s' "$AUTH_HDR"
}

empty_hdr="$(legacy_auth_hdr '')"
[ -z "$empty_hdr" ] || fail "legacy AUTH_HDR must be empty when GITHUB_TOKEN is unset (got: ${empty_hdr:0:32}…)"
pass "legacy empty-GITHUB_TOKEN path produces empty AUTH_HDR (the observed failure)"

# ── 2. Shared helper refuses empty credentials ───────────────────────────────
if cloudbench_git_auth_header_from_tokens '' '' 2>/dev/null; then
  fail "cloudbench_git_auth_header_from_tokens must fail closed with no tokens"
fi
pass "git auth helper fails closed with no controller or machine token"

# ── 3. Controller token wins over a stale machine secret ─────────────────────
controller_b64="$(printf '%s' 'controller-live-token' | base64 | tr -d '\n')"
hdr="$(cloudbench_git_auth_header_from_tokens "$controller_b64" 'stale-machine-token')"
expected="Authorization: Basic $(printf 'x-access-token:%s' 'controller-live-token' | base64 | tr -d '\n')"
[ "$hdr" = "$expected" ] || fail "controller token must win over machine secret (got ${hdr:0:48}…)"
pass "controller B64 token wins over stale machine GITHUB_TOKEN"

# ── 4. Resolver prefers live git remote over injected dead GITHUB_TOKEN ──────
# Reproduce the Cursor Cloud shape: env GITHUB_TOKEN is present but unusable,
# while origin carries a working x-access-token (as observed on this workspace).
export GITHUB_TOKEN='github_pat_DEAD_TOKEN_FOR_REPRO_ONLY'
resolved="$(cloudbench_resolve_controller_github_token "$ROOT_DIR")" \
  || fail "resolver must find the controller git credential despite a dead GITHUB_TOKEN"
[ "$resolved" != "$GITHUB_TOKEN" ] || fail "resolver must not return the dead injected GITHUB_TOKEN"
case "$resolved" in
  ghs_*|gho_*|github_pat_*|ghp_*) ;;
  *) fail "resolver returned an unexpected token shape: ${resolved:0:8}…" ;;
esac
# Prove the resolved token authenticates to the private repo (the missing
# measurement that empty AUTH_HDR failed to produce).
http_code="$(curl -s -o /tmp/cloudbench-token-check.json -w '%{http_code}' \
  -H "Authorization: Bearer $resolved" \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: cloudbench-controller-github-token-test' \
  https://api.github.com/repos/rose-ai-labs/rose)"
[ "$http_code" = "200" ] || fail "resolved controller token must auth to rose-ai-labs/rose (HTTP $http_code)"
pass "resolver prefers live git credential over dead GITHUB_TOKEN (API 200)"

# ── 5. refresh-deps / fleet source wiring (cemented in the consistently-run path)
require_text() {
  local file="$1" needle="$2" msg="$3"
  grep -Fq "$needle" "$file" || fail "$msg"
}

require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_controller_github_token_b64' \
  "run-bench-cloud must resolve a controller token for warm git-sync"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'CONTROLLER_B64=' \
  "refresh-deps SYNC_CMD must embed CONTROLLER_B64 from the controller"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FATAL: controller GitHub token unavailable for warm git-sync' \
  "warm git-sync must fail closed when no controller token is available"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_github_token_b64' \
  "fleet worker token resolution must use the shared controller resolver"
# Stronger: the refresh-deps block must mention CONTROLLER_B64 before fetch.
python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY' || fail "refresh-deps must stage CONTROLLER_B64 before git fetch"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
start = text.find('if [ "$MODE" = "refresh-deps" ]')
end = text.find('if [ "$MODE" = "refresh-wmh"', start)
block = text[start:end]
if "CONTROLLER_B64=" not in block:
    raise SystemExit("missing CONTROLLER_B64 in refresh-deps")
if "cloudbench_controller_github_token_b64" not in block:
    raise SystemExit("missing controller token resolve in refresh-deps")
fetch_at = block.find("git -c safe.directory")
ctrl_at = block.find("CONTROLLER_B64=")
if ctrl_at < 0 or fetch_at < 0 or ctrl_at > fetch_at:
    raise SystemExit("CONTROLLER_B64 must be set before git fetch in refresh-deps")
PY
pass "refresh-deps and fleet source wiring pass the controller token into warm git-sync"

echo "ALL CHECKS PASSED"