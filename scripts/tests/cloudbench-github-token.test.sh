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
# Reap the mock server before exiting: a TERM without a wait let it outlive the
# test under load, and the controller-gate supervisor then had to reap an orphan.
trap 'kill "${SERVER_PID:-}" 2>/dev/null || true; wait "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT

LIVE_DISPATCH="${GITHUB_DISPATCH_TOKEN:-}"
GOOD_TOKEN="gho_test_dispatch_token_good_for_repo_read"
BAD_TOKEN="github_pat_stale_token_that_must_not_win"
POOL_TOKEN="ghs_test_pool_member_with_most_quota"
POOL_NO_ACCESS_TOKEN="ghs_test_pool_member_without_repo_access"

python3 - "$TMP" "$GOOD_TOKEN" "$POOL_TOKEN" "$POOL_NO_ACCESS_TOKEN" <<'PY' &
import http.server, sys
from pathlib import Path
root, good, pool, no_access = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if auth in (f"Bearer {good}", f"Bearer {pool}"):
            body, code = b'{"ok":true}', 200
        elif auth == f"Bearer {no_access}":
            body, code = b'{"message":"Not Found"}', 404
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

# ── 2b. Drained user identity falls back to the token pool (GitHub App) ──────
mkdir -p "$TMP/repo/scripts"
printf 'print("%s", end="")\n' "$GOOD_TOKEN" >"$TMP/repo/scripts/github_token_pool.py"
RESOLVED="$(
  PATH="$PATH_NO_GH" cloudbench_resolve_github_token "$TMP/repo"
)" || fail "resolver ignored the token pool when every user-token candidate was unusable"
[ "$RESOLVED" = "$GOOD_TOKEN" ] || fail "resolver returned an unexpected token instead of the pool pick"
printf 'print("%s", end="")\n' "$BAD_TOKEN" >"$TMP/repo/scripts/github_token_pool.py"
if PATH="$PATH_NO_GH" cloudbench_resolve_github_token "$TMP/repo" >/dev/null 2>&1; then
  fail "resolver must still validate the pool pick and fail closed when it cannot read the repo"
fi
rm -f "$TMP/repo/scripts/github_token_pool.py"
grep -Fq 'scripts/github_token_pool.py pick' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "run-bench-cloud resolve_github_token must fall back to the token pool pick"
pass "resolver falls back to a validated token-pool pick when the user identity is drained"

# ── 2c. Read-only resolver spends the pool member with the most quota ────────
# Reads (fetch / ls-remote / REST GET) prefer the pool pick over Andy's user
# token; the identity chain keeps its order for identity-bound callers. A pool
# member that cannot read the repo (404) is not authoritative: the identity
# chain still answers. The pool is probed once per resolution.
pool_fake() {  # <token to print>
  printf 'import sys\nopen(%s, "a").write(" ".join(sys.argv[1:]) + "\\n")\nprint("%s", end="")\n' \
    "'$TMP/pool-calls'" "$1" >"$TMP/repo/scripts/github_token_pool.py"
  : >"$TMP/pool-calls"
}
export GITHUB_DISPATCH_TOKEN="$GOOD_TOKEN"
pool_fake "$POOL_TOKEN"
RESOLVED="$(PATH="$PATH_NO_GH" cloudbench_resolve_github_read_token "$TMP/repo")" \
  || fail "read resolver returned no token with a usable pool member"
[ "$RESOLVED" = "$POOL_TOKEN" ] || fail "read resolver must prefer the pool member with the most quota"
grep -qx 'pick --resource core' "$TMP/pool-calls" || fail "read resolver must pick by core (REST) quota"
RESOLVED="$(PATH="$PATH_NO_GH" cloudbench_resolve_github_token "$TMP/repo")" \
  || fail "identity resolver lost its usable DISPATCH token"
[ "$RESOLVED" = "$GOOD_TOKEN" ] || fail "identity resolver must keep the user identity ahead of the pool"
pool_fake "$POOL_NO_ACCESS_TOKEN"
RESOLVED="$(PATH="$PATH_NO_GH" cloudbench_resolve_github_read_token "$TMP/repo")" \
  || fail "a pool 404 must fall back to the identity chain, not fail the read"
[ "$RESOLVED" = "$GOOD_TOKEN" ] || fail "a pool member without repo access must not be returned"
[ "$(wc -l <"$TMP/pool-calls")" -eq 1 ] || fail "read resolver probed the pool more than once"
export CLOUDBENCH_GITHUB_TOKEN="$GOOD_TOKEN"
pool_fake "$POOL_TOKEN"
RESOLVED="$(PATH="$PATH_NO_GH" cloudbench_resolve_github_read_token "$TMP/repo")"
[ "$RESOLVED" = "$GOOD_TOKEN" ] || fail "a usable request-scoped controller injection must still win"
unset CLOUDBENCH_GITHUB_TOKEN
RESOLVED="$(CLOUDBENCH_GITHUB_TOKEN_POOL=0 PATH="$PATH_NO_GH" cloudbench_resolve_github_read_token "$TMP/repo")"
[ "$RESOLVED" = "$GOOD_TOKEN" ] && [ ! -s "$TMP/pool-calls" ] \
  || fail "CLOUDBENCH_GITHUB_TOKEN_POOL=0 must keep reads on the identity chain without probing the pool"
# A disabled or absent pool is empty output, never a failure: an errexit caller reaches the identity chain.
for disabled in CLOUDBENCH_GITHUB_TOKEN_POOL=0 absent; do
  [ "$disabled" = absent ] && mv "$TMP/repo/scripts/github_token_pool.py" "$TMP/pool.py.aside"
  RESOLVED="$(env $([ "$disabled" = absent ] || echo "$disabled") PATH="$PATH_NO_GH" bash -c \
    'set -euo pipefail; shopt -s inherit_errexit; . "$1"; cloudbench_resolve_github_read_token "$2"; echo " ok"' \
    _ "$ROOT_DIR/scripts/lib/cloudbench-github-token.sh" "$TMP/repo")" || true
  [ "$RESOLVED" = "$GOOD_TOKEN ok" ] || fail "an errexit caller with the pool $disabled did not reach the identity chain"
  [ "$disabled" = absent ] && mv "$TMP/pool.py.aside" "$TMP/repo/scripts/github_token_pool.py"
done
unset GITHUB_DISPATCH_TOKEN
pool_fake "$POOL_NO_ACCESS_TOKEN"
if PATH="$PATH_NO_GH" cloudbench_resolve_github_read_token "$TMP/repo" >/dev/null 2>&1; then
  fail "read resolver must fail closed when neither the pool nor the identity chain can read"
fi
[ "$(wc -l <"$TMP/pool-calls")" -eq 1 ] || fail "identity fallback re-probed the pool after the read resolver did"
rm -f "$TMP/repo/scripts/github_token_pool.py" "$TMP/pool-calls"
pass "read resolver prefers the validated pool pick; 404 falls back to the identity chain"

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

# Concurrent controllers must preserve full dotenvs and publish complete reads.
python3 - "$ROOT_DIR/scripts/lib/cloudbench-env.sh" "$TMP/env-upsert" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

library, root = Path(sys.argv[1]), Path(sys.argv[2])
root.mkdir()
hooks = root / "hooks"
hooks.mkdir()
(hooks / "sitecustomize.py").write_text('''
import fcntl
import io
import os
from pathlib import Path
import time

root = Path(os.environ["ENV_RACE_ROOT"])
dest = Path(os.environ["ENV_RACE_DEST"]).resolve()
role = os.environ.get("ENV_RACE_ROLE", "")
read_text, write_text, open_file, flock = Path.read_text, Path.write_text, io.open, fcntl.flock

def mark(name):
    temporary = root / (name + ".tmp")
    temporary.write_text(str(os.getpid()))
    os.replace(temporary, root / name)

def await_file(name):
    deadline = time.monotonic() + 15
    while not (root / name).exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("fixture barrier did not settle")
        time.sleep(0.01)

def controlled_read(path, *args, **kwargs):
    result = read_text(path, *args, **kwargs)
    if path.resolve() == dest and role in {"first", "second", "empty-reader"}:
        mark(role + "-read")
        if role == "first":
            await_file("release-first")
        elif role == "empty-reader":
            await_file("first-done")
    return result

def controlled_open(path, mode="r", *args, **kwargs):
    handle = open_file(path, mode, *args, **kwargs)
    if isinstance(path, (str, Path)) and Path(path).resolve() == dest and "w" in mode and role == "truncate":
        mark("target-truncated")
        await_file("release-truncate")
    return handle

def controlled_flock(fd, operation):
    if role == "second" and operation == fcntl.LOCK_EX:
        mark("second-lock-attempt")
    return flock(fd, operation)

def controlled_write_text(path, text, *args, **kwargs):
    # Hold the marker's write open so exists() cannot stand in for publication.
    if root.name == "canceled-writer" and path.parent == root and role == "first" and path.name in {"first-read", "first-read.tmp"}:
        with open_file(path, "w") as handle:
            write_text(root / "marker-body-open", "ready")
            await_file("release-marker-body")
            return handle.write(text)
    return write_text(path, text, *args, **kwargs)

Path.read_text, Path.write_text, io.open, fcntl.flock = controlled_read, controlled_write_text, controlled_open, controlled_flock
''')
processes = []

def start(case, role="", key="GITHUB_TOKEN", value="fixture-controller-token"):
    env = {**os.environ, "PYTHONPATH": str(hooks), "ENV_RACE_ROOT": str(case),
           "ENV_RACE_DEST": str(case / ".env"), "ENV_RACE_ROLE": role}
    command = 'source "$1"; cloudbench_upsert_env_key "$2" "$3" "$4"'
    process = subprocess.Popen(["bash", "-c", command, "fixture", str(library),
                                str(case / ".env"), key, value], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(process)
    return process

def wait_for(predicate):
    deadline = time.monotonic() + 15
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("controlled env-upsert boundary did not settle")
        time.sleep(0.01)

def joined(process, success=True):
    process.communicate(timeout=15)
    assert (process.returncode == 0) == success, "env-upsert exit status was unexpected"

def case(name):
    path = root / name
    path.mkdir()
    (path / ".env").write_text("FLY_API_TOKEN=fixture-fly\nBACKEND_KEY=fixture-backend\n")
    (path / ".env").chmod(0o600)
    return path

failures = []
try:
    torn = case("atomic-read")
    first = start(torn, "truncate")
    wait_for(lambda: (torn / "target-truncated").exists() or first.poll() is not None)
    complete_read = "FLY_API_TOKEN=" in (torn / ".env").read_text()
    second = start(torn, "empty-reader")
    wait_for(lambda: (torn / "empty-reader-read").exists())
    (torn / "release-truncate").touch()
    joined(first)
    (torn / "first-done").touch()
    joined(second)
    if not complete_read or "BACKEND_KEY=" not in (torn / ".env").read_text():
        failures.append("concurrent export exposed a partial dotenv or discarded unrelated keys")

    sibling = case("serialized-update")
    first = start(sibling, "first", "FIRST_KEY", "fixture-first")
    wait_for(lambda: (sibling / "first-read").exists())
    second = start(sibling, "second", "SECOND_KEY", "fixture-second")
    wait_for(lambda: (sibling / "second-read").exists() or (sibling / "second-lock-attempt").exists())
    if (sibling / "second-read").exists():
        joined(second)
    (sibling / "release-first").touch()
    joined(first)
    joined(second)
    content = (sibling / ".env").read_text()
    if "FIRST_KEY=" not in content or "SECOND_KEY=" not in content:
        failures.append("concurrent env upserts discarded a sibling update")

    canceled = case("canceled-writer")
    first = start(canceled, "first")
    wait_for(lambda: (canceled / "marker-body-open").exists())
    assert not (canceled / "first-read").exists(), "PID marker exposed an incomplete payload"
    (canceled / "release-marker-body").touch()
    wait_for(lambda: (canceled / "first-read").exists())
    # The barrier records only the exact Python child created by this fixture.
    os.kill(int((canceled / "first-read").read_text()), signal.SIGTERM)
    joined(first, success=False)
    joined(start(canceled))
    assert "BACKEND_KEY=" in (canceled / ".env").read_text(), "cancellation damaged the full dotenv"

    stable = case("matching-export")
    env = {**os.environ, "FIXTURE_TOKEN": 'fixture token with "quotes" and \\slashes'}
    command = ('source "$1"; cloudbench_controller_github_token() { printf %s "$FIXTURE_TOKEN"; }; '
               'cloudbench_export_controller_github_token "$2"; '
               '[ "$GITHUB_TOKEN" = "$FIXTURE_TOKEN" ]')
    argv = ["bash", "-c", command, "fixture", str(library), str(stable / ".env")]
    result = subprocess.run(argv, env=env, capture_output=True, timeout=15)
    assert result.returncode == 0, "controller export did not preserve its process token"
    before = (stable / ".env").stat()
    result = subprocess.run(argv, env=env, capture_output=True, timeout=15)
    assert result.returncode == 0, "matching controller export failed"
    after = (stable / ".env").stat()
    if (before.st_ino, before.st_mtime_ns) != (after.st_ino, after.st_mtime_ns):
        failures.append("matching controller token rewrote its dotenv")
    assert after.st_mode & 0o777 == 0o600, "dotenv mode changed"
    alias = stable / "alias.env"
    alias.symlink_to(".env")
    result = subprocess.run(["bash", "-c", command, "fixture", str(library), str(alias)],
                            env=env, capture_output=True, timeout=15)
    assert result.returncode == 0 and alias.is_symlink(), "controller export replaced a dotenv symlink"
finally:
    # Release every fixture barrier before joining, including failed assertions.
    for directory in root.iterdir():
        if directory.is_dir() and directory != hooks:
            for marker in ("release-first", "release-truncate", "first-done"):
                (directory / marker).touch()
    for process in processes:
        process.communicate(timeout=15)
assert not failures, "; ".join(failures)
PY
pass "concurrent controller exports preserve complete dotenvs, sibling updates, token handoff, mode and cancellation"

# ── 3b. Guest token survives devbox credential rotation (PR #1927 round 5) ───
# Observed: smoke/agent-payment-setup-resume guest logged `could not read
# Username for 'https://github.com'` / `FATAL: could not fetch requested ref`
# at 13:06:50Z; the devbox daemon had rotated (and revoked) GITHUB_TOKEN at
# 13:06:49Z. Twelve guests that fetched at 13:06:22Z with the same delivered
# token passed. Repro: resolve the token through the exact function the guest
# delivery code calls, rotate + revoke the devbox credential, then authenticate
# as the guest does. The delivered credential must still be accepted.
ROT="$TMP/rotation"
mkdir -p "$ROT/repo/back-end" "$ROT/repo/agents" "$ROT/repo/scripts"
DEVBOX_OLD="gho_devbox_rotating_credential_before"
DEVBOX_NEW="gho_devbox_rotating_credential_after"
APP_TOKEN="ghs_test_app_installation_token_durable"
printf '%s\n' "$DEVBOX_OLD" "$APP_TOKEN" >"$ROT/live-tokens"
printf '%s' "$DEVBOX_OLD" >"$ROT/rotating"
for envf in "$ROT/repo/back-end/.env" "$ROT/repo/agents/.env"; do
  # On boxes.dev both keys hold the same daemon-managed user credential.
  printf 'GITHUB_TOKEN=%s\nGITHUB_DISPATCH_TOKEN=%s\n' "$DEVBOX_OLD" "$DEVBOX_OLD" >"$envf"
done
python3 - "$ROT" <<'PY2' &
import http.server, sys
from pathlib import Path
root = Path(sys.argv[1])

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        live = {line.strip() for line in (root / "live-tokens").read_text().splitlines() if line.strip()}
        auth = self.headers.get("Authorization", "")
        ok = auth.startswith("Bearer ") and auth[len("Bearer "):] in live
        body, code = (b'{"ok":true}', 200) if ok else (b'{"message":"Bad credentials"}', 401)
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
(root / "port").write_text(str(httpd.server_address[1]))
while True:
    httpd.handle_request()
PY2
ROT_SERVER_PID=$!
trap 'kill "${SERVER_PID:-}" "${ROT_SERVER_PID:-}" 2>/dev/null || true; wait "${SERVER_PID:-}" "${ROT_SERVER_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do
  [ -f "$ROT/port" ] && break
  sleep 0.05
done
[ -f "$ROT/port" ] || fail "rotation mock GitHub API did not start"
ROT_API="http://127.0.0.1:$(cat "$ROT/port")/repos/Rose-Ai-Labs/rose"
# The devbox's repository-scoped Git credential helper hands out the rotating
# token as a complete credential: Git >= 2.46 with credential.interactive=false
# discards a password-only answer instead of prompting for the username.
printf '[credential]\n\thelper = "!f() { [ \\"$1\\" = get ] && printf \\"username=x-access-token\\\\npassword=%%s\\\\n\\" \\"$(cat %s)\\"; }; f"\n' \
  "$ROT/rotating" >"$ROT/gitconfig"
git -C "$ROT/repo" init -q
# The App member: mints a durable installation token; records its arguments.
printf 'import sys\nopen(%s, "a").write(" ".join(sys.argv[1:]) + "\\n")\nif sys.argv[1:2] == ["app-token"]:\n    print(open(%s).read().strip(), end="")\nelse:\n    print(%s, end="")\n' \
  "'$ROT/pool-calls'" "'$ROT/app-token'" "'$DEVBOX_OLD'" >"$ROT/repo/scripts/github_token_pool.py"
printf '%s' "$APP_TOKEN" >"$ROT/app-token"

guest_fetch_authenticates() {  # <delivered-token>
  [ "$(printf 'Authorization: Bearer %s\n' "$1" | curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -H @- "$ROT_API")" = 200 ]
}
rotate_devbox_credential() {
  printf '%s' "$DEVBOX_NEW" >"$ROT/rotating"
  for envf in "$ROT/repo/back-end/.env" "$ROT/repo/agents/.env"; do
    printf 'GITHUB_TOKEN=%s\nGITHUB_DISPATCH_TOKEN=%s\n' "$DEVBOX_NEW" "$DEVBOX_NEW" >"$envf"
  done
  printf '%s\n' "$DEVBOX_NEW" "$APP_TOKEN" >"$ROT/live-tokens"  # the old token is revoked
}
# The resolver each guest-delivery site actually calls, read from the source.
cloud_resolver="$(sed -n 's/.*_ghb64="$(printf .%s. "$(\([a-z_]*\)[ )].*/\1/p' "$ROOT_DIR/scripts/run-bench-cloud" | head -1)"
wrapper_resolver="$(sed -n 's/^CONTROLLER_GITHUB_TOKEN="$(\([a-z_]*\)[ )].*/\1/p' "$ROOT_DIR/scripts/run-bench-cloud" | head -1)"
[ -n "$cloud_resolver" ] && [ -n "$wrapper_resolver" ] \
  || fail "could not locate run-bench-cloud's guest token delivery sites"
fleet_fn="$(sed -n '/^CONTROLLER_GITHUB_TOKEN_B64_CACHE=/p; /^controller_github_token_b64() {/,/^}/p' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$fleet_fn" ] || fail "could not locate run-bench-fleet's worker token delivery function"
# Warm-box git-sync (--setup clone, refresh-deps, warm-source fetch) resolves
# through run-bench-cloud's resolve_github_token; its git ls-remote validator is
# replaced by the mock's live-token list.
warm_fn="$(sed -n '/^resolve_github_token() {/,/^}/p' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$warm_fn" ] || fail "could not locate run-bench-cloud's warm-box token resolver"
deliver() {  # <site> — prints the token that site hands to a guest
  # A clean environment: CI runners inject Git config (GIT_CONFIG_COUNT/KEY/VALUE
  # insteadOf credentials) that would otherwise answer for the devbox helper.
  env -i GITHUB_TOKEN="$DEVBOX_OLD" HOME="$ROT" GIT_CONFIG_GLOBAL="$ROT/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
    CLOUDBENCH_GITHUB_REPO_API="$ROT_API" CLOUDBENCH_FLEET_ROOT="$ROT/repo" PATH="$PATH_NO_GH" \
    SITE="$1" CLOUD_RESOLVER="$cloud_resolver" WRAPPER_RESOLVER="$wrapper_resolver" FLEET_FN="$fleet_fn" \
    WARM_FN="$warm_fn" LIVE_TOKENS="$ROT/live-tokens" \
    bash -c 'set -euo pipefail; . "$1"; cd "$2"; ROOT_DIR="$2"
      case "$SITE" in
        machine-env) "$CLOUD_RESOLVER" ;;
        wrapper) "$WRAPPER_RESOLVER" ;;
        fleet-worker) eval "$FLEET_FN"; controller_github_token_b64 | base64 -d ;;
        warm-sync) eval "$WARM_FN"
          github_token_can_fetch_repo() { grep -Fxq -- "$1" "$LIVE_TOKENS"; }
          resolve_durable_github_token() { :; }
          resolve_github_token ;;
      esac' _ "$ROOT_DIR/scripts/lib/cloudbench-env.sh" "$ROT/repo"
}
for site in machine-env wrapper fleet-worker warm-sync; do
  printf '%s' "$DEVBOX_OLD" >"$ROT/rotating"
  printf '%s\n' "$DEVBOX_OLD" "$APP_TOKEN" >"$ROT/live-tokens"
  : >"$ROT/pool-calls"
  delivered="$(deliver "$site" 2>"$ROT/deliver.err")" || { cat "$ROT/deliver.err" >&2; fail "$site: no guest token was delivered"; }
  guest_fetch_authenticates "$delivered" || fail "$site: delivered token was not valid at delivery"
  rotate_devbox_credential
  guest_fetch_authenticates "$delivered" \
    || fail "$site: guest fetch after the devbox credential rotated was rejected (delivered the rotating devbox token)"
  ! grep -Fq -e "$DEVBOX_OLD" -e "$APP_TOKEN" "$ROT/deliver.err" || fail "$site: delivery printed a token"
  min_ttl="$(sed -n 's/^app-token .*--min-ttl \([0-9]*\).*/\1/p' "$ROT/pool-calls" | head -1)"
  [ "${min_ttl:-0}" -ge 1800 ] || fail "$site: guest App token must be requested with a min TTL covering guest boot (got '${min_ttl:-none}')"
done
pass "guest delivery sites hand guests a credential that survives devbox token rotation"

# Without the App, guests keep the previous live-controller chain (no new failure
# mode), and an explicit request-scoped pin still wins over the App.
printf '' >"$ROT/app-token"
printf '%s' "$DEVBOX_NEW" >"$ROT/rotating"
delivered="$(deliver machine-env 2>"$ROT/deliver.err")" || fail "missing App must fall back to the controller credential"
[ "$delivered" = "$DEVBOX_NEW" ] || fail "missing App must fall back to the live controller credential"
grep -Fq 'rotat' "$ROT/deliver.err" || fail "the rotating fallback must warn that rotation can revoke the guest token"
printf '%s' "$APP_TOKEN" >"$ROT/app-token"
printf '%s\n' "$DEVBOX_NEW" >"$ROT/live-tokens"  # the App token cannot read the repo
delivered="$(deliver machine-env 2>/dev/null)" || fail "an App token without repo access must fall back"
[ "$delivered" = "$DEVBOX_NEW" ] || fail "an App token that fails the Contents read must not be delivered"
pinned="$(env -i HOME="$ROT" CLOUDBENCH_GITHUB_TOKEN_B64="$(printf '%s' 'pinned-request-token' | base64 | tr -d '\n')" \
  CLOUDBENCH_GITHUB_REPO_API="$ROT_API" CLOUDBENCH_FLEET_ROOT="$ROT/repo" PATH="$PATH_NO_GH" \
  bash -c '. "$1"; cloudbench_guest_github_token "$2"' _ "$ROOT_DIR/scripts/lib/cloudbench-env.sh" "$ROT/repo")"
[ "$pinned" = pinned-request-token ] || fail "an explicit CLOUDBENCH_GITHUB_TOKEN_B64 pin must still win"
# The fleet must not pin one resolved token into every later child via export.
python3 - "$ROOT_DIR/scripts/run-bench-fleet" <<'PY2' \
  || fail "run-bench-fleet must scope the refresh-deps token to that command, not export it to every later guest"
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text()
exports = [m.start() for m in re.finditer(r'export CLOUDBENCH_GITHUB_TOKEN_B64=', text)]
for at in exports:
    line = text[text.rfind("\n", 0, at) + 1:text.find("\n", at)]
    # Only a pipeline left-hand group (a subshell) may export the token.
    if not line.lstrip().startswith("if { "):
        raise SystemExit(f"unscoped export: {line.strip()[:80]}")
    end = text.find("; } 2>&1 |", at)
    if end < 0 or "\n    fi" in text[at:end]:
        raise SystemExit("export is not inside the refresh-deps pipeline group")
PY2
pass "guest token falls back to the live controller chain without the App; explicit pins still win"

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
