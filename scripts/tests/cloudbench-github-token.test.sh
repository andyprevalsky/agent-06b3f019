#!/usr/bin/env bash
# Owning-boundary repro for fleet refresh-deps git auth (descend I-01):
# stale GITHUB_TOKEN must not block resolution when a usable DISPATCH token
# exists, and refresh-deps must inject a controller token rather than relying
# solely on the warm-box GITHUB_TOKEN secret.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/cloudbench-github-token.sh
source "$ROOT_DIR/scripts/lib/cloudbench-github-token.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; kill "$SERVER_PID" 2>/dev/null || true' EXIT

LIVE_DISPATCH="${GITHUB_DISPATCH_TOKEN:-}"
GOOD_TOKEN="gho_test_dispatch_token_good_for_repo_read"
BAD_TOKEN="github_pat_stale_token_that_must_not_win"

python3 - "$TMP" "$GOOD_TOKEN" <<'PY' &
import http.server, sys
from pathlib import Path
root, good = Path(sys.argv[1]), sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {good}":
            body, code = b'{"ok":true}', 200
        else:
            body, code = b'{"message":"Bad credentials"}', 401
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
Path(root, "port").write_text(str(httpd.server_address[1]))
while True:
    httpd.handle_request()
PY
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -f "$TMP/port" ] && break
  sleep 0.05
done
[ -f "$TMP/port" ] || fail "mock GitHub API did not start"
PORT="$(cat "$TMP/port")"
export CLOUDBENCH_GITHUB_REPO_API="http://127.0.0.1:${PORT}/repos/Rose-Ai-Labs/rose"

mkdir -p "$TMP/repo/back-end" "$TMP/repo/agents" "$TMP/bin"
printf 'GITHUB_TOKEN=%s\n' "$BAD_TOKEN" >"$TMP/repo/back-end/.env"
printf 'GITHUB_TOKEN=%s\n' "$BAD_TOKEN" >"$TMP/repo/agents/.env"
(
  cd "$TMP/repo"
  git init -q
  git remote remove origin 2>/dev/null || true
)
printf '#!/bin/sh\nexit 1\n' >"$TMP/bin/gh"
chmod +x "$TMP/bin/gh"
PATH_NO_GH="$TMP/bin:$PATH"

# ── 1. Prefer usable DISPATCH over stale GITHUB_TOKEN ────────────────────────
export GITHUB_TOKEN="$BAD_TOKEN"
export GITHUB_DISPATCH_TOKEN="$GOOD_TOKEN"
unset CLOUDBENCH_GITHUB_TOKEN_B64 CLOUDBENCH_GITHUB_TOKEN || true

RESOLVED="$(
  PATH="$PATH_NO_GH" cloudbench_resolve_github_token "$TMP/repo"
)" || fail "resolver returned no token when GITHUB_DISPATCH_TOKEN was usable"
[ "$RESOLVED" = "$GOOD_TOKEN" ] \
  || fail "resolver returned unexpected token (wanted DISPATCH)"
pass "resolver prefers usable GITHUB_DISPATCH_TOKEN over stale GITHUB_TOKEN"

# ── 2. Stale-only sources must fail closed ───────────────────────────────────
unset GITHUB_DISPATCH_TOKEN
if PATH="$PATH_NO_GH" cloudbench_resolve_github_token "$TMP/repo" >/dev/null 2>&1; then
  fail "resolver must fail when only stale GITHUB_TOKEN sources exist"
fi
pass "resolver fails closed when every candidate is stale"

# ── 3. refresh-deps injects controller token (static contract) ───────────────
grep -Fq 'resolve_github_token' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "run-bench-cloud must resolve a usable controller token before private-repo git-sync"
grep -Fq 'GIT_CONFIG_GLOBAL' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "run-bench-cloud must authenticate git via GIT_CONFIG_GLOBAL http.extraheader"
grep -Fq 'http.extraheader' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "run-bench-cloud must set http.extraheader for private-repo git-sync"
grep -Fq 'cloudbench-github-token.sh' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "run-bench-cloud must source cloudbench-github-token.sh"
grep -Fq 'cloudbench-github-token.sh' "$ROOT_DIR/scripts/run-bench-fleet" \
  || fail "run-bench-fleet must copy cloudbench-github-token.sh into the script snapshot"

# Old machine-only AUTH_HDR pattern must not remain inside --refresh-deps.
if python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
start = text.find('MODE: --refresh-deps')
if start < 0:
    raise SystemExit('refresh-deps mode missing')
# End at the next MODE banner or EOF
rest = text[start + 1:]
end_rel = rest.find('\n# MODE:')
chunk = rest if end_rel < 0 else rest[:end_rel]
needle = '[ -n \\"${GITHUB_TOKEN:-}\\" ] && AUTH_HDR='
if needle in chunk:
    raise SystemExit(0)  # found = bad
raise SystemExit(1)
PY
then
  fail "refresh-deps still authenticates solely from box-side GITHUB_TOKEN"
fi
pass "refresh-deps no longer depends solely on box-side GITHUB_TOKEN"

# ── 4. Live resolver when the Cloud Agent supplies DISPATCH ──────────────────
unset CLOUDBENCH_GITHUB_REPO_API
if [ -n "$LIVE_DISPATCH" ]; then
  export GITHUB_DISPATCH_TOKEN="$LIVE_DISPATCH"
  export GITHUB_TOKEN="$BAD_TOKEN"
  LIVE="$(cloudbench_resolve_github_token "$ROOT_DIR")" \
    || fail "live cloudbench_resolve_github_token failed with real GITHUB_DISPATCH_TOKEN"
  [ -n "$LIVE" ] || fail "live resolver returned empty token"
  pass "live resolver returns a usable token with real GITHUB_DISPATCH_TOKEN"
else
  pass "live resolver check skipped (no GITHUB_DISPATCH_TOKEN in launcher env)"
fi

echo "ALL CHECKS PASSED"
