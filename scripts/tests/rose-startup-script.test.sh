#!/usr/bin/env bash
# Rose project startup script (agents/benchmarks/fixtures/projects/rose-startup.sh)
# and sync script (rose-sync.sh) end to end in a checkout with no node_modules
# and no agents/venv, with npm, npx, uv, node and sudo stubbed. Asserts which
# installs run, that the JS and Python branches overlap, that a resumed session
# skips every install, and that a session started from the sync script's
# snapshot (its stamps) skips them too.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/agents/benchmarks/fixtures/projects/rose-startup.sh"
SYNC_SCRIPT="$ROOT_DIR/agents/benchmarks/fixtures/projects/rose-sync.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rose-startup-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
STUB_SLEEP=3

fail() {
  echo "FAIL: $*" >&2
  [ -f "$TMP_ROOT/out" ] && sed 's/^/  | /' "$TMP_ROOT/out" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

now() { python3 -c 'import time; print(time.time())'; }

stub() {
  local dir="$1" name="$2"
  shift 2
  mkdir -p "$dir"
  { printf '#!/usr/bin/env bash\n'; cat; } >"$dir/$name"
  chmod +x "$dir/$name"
}

# Stubs record "<name> <args> @<cwd relative to the checkout>" in $CALLS.
make_stubs() {
  local bin="$1"
  stub "$bin" npm <<'EOF'
echo "npm $* @${PWD#"$REPO"}" >>"$CALLS"
sleep "${FAKE_NPM_SLEEP:-0}"
[ -z "${FAKE_NPM_FAIL:-}" ] || { echo "npm ERR! fake failure"; exit 7; }
mkdir -p node_modules/.bin && printf '#!/bin/sh\n' >node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx
EOF
  stub "$bin" npx <<'EOF'
echo "npx $* @${PWD#"$REPO"}" >>"$CALLS"
mkdir -p ../node_modules/.prisma/client && : >../node_modules/.prisma/client/index.js
EOF
  stub "$bin" node <<'EOF'
if [ "$1" = --version ]; then echo "${FAKE_NODE_VERSION:-v20.19.0}"; exit 0; fi
echo "node $* @${PWD#"$REPO"}" >>"$CALLS"
exit "${FAKE_CHECK_RC:-0}"
EOF
  stub "$bin" sudo <<'EOF'
echo "sudo $* @${PWD#"$REPO"}" >>"$CALLS"
EOF
  stub "$bin" pg_ctlcluster <<'EOF'
exit 0
EOF
  # A venv python that satisfies requirements.txt once `uv pip install` ran.
  stub "$TMP_ROOT/templates" python <<'EOF'
venv="$(cd "$(dirname "$0")/.." && pwd)"
case "$1" in
  scripts/lib/agents_venv_satisfied.py)
    [ -f "$venv/.installed" ] || { echo "agents venv: fake-pkg: not installed" >&2; exit 1; } ;;
esac
EOF
  stub "$TMP_ROOT/uv-bin" uv <<EOF
echo "uv \$* @\${PWD#"\$REPO"}" >>"\$CALLS"
case "\$1" in
  venv) mkdir -p "\${@: -1}/bin" && cp "$TMP_ROOT/templates/python" "\${@: -1}/bin/python" ;;
  pip) sleep "\${FAKE_UV_SLEEP:-0}"; : >venv/.installed ;;
esac
EOF
}

make_repo() {
  REPO="$1"
  rm -rf "$REPO" "$HOME/.cache"
  mkdir -p "$REPO"/{back-end/prisma,back-end/scripts,front-end,agents,scripts/lib}
  echo '{"name":"root","workspaces":["back-end","front-end","agents"]}' >"$REPO/package.json"
  echo '{"name":"back-end"}' >"$REPO/back-end/package.json"
  echo '{"name":"front-end"}' >"$REPO/front-end/package.json"
  echo '{"lockfileVersion":3}' >"$REPO/back-end/package-lock.json"
  echo '{"lockfileVersion":3}' >"$REPO/front-end/package-lock.json"
  echo 'model A { id Int @id }' >"$REPO/back-end/prisma/schema.prisma"
  echo 'fake-pkg==1.0' >"$REPO/agents/requirements.txt"
  cp "$ROOT_DIR/scripts/lib/agents_venv_satisfied.py" "$REPO/scripts/lib/"
  export REPO
}

STUB_BIN="$TMP_ROOT/bin"
make_stubs "$STUB_BIN"
export CALLS="$TMP_ROOT/calls"
export HOME="$TMP_ROOT/home"
mkdir -p "$HOME"
# Host tools only: the developer's own uv, node or npm must never be found.
BASE_PATH="$STUB_BIN:/usr/bin:/bin"

# run_startup <path-extra>: runs the script like rose-project-startup does.
run_startup() {
  : >"$CALLS"
  local began
  began="$(now)"
  set +e
  (cd "$REPO" && PATH="$1:$BASE_PATH" bash "$SCRIPT" </dev/null >"$TMP_ROOT/out" 2>&1)
  RC=$?
  set -e
  ELAPSED="$(python3 -c "import time; print(round(time.time() - $began, 2))")"
}

count() { grep -c -- "$1" "$CALLS" || true; }
expect_count() {
  local got
  got="$(count "$1")"
  [ "$got" = "$2" ] || fail "$3: expected $2 call(s) matching '$1', got $got"
}
expect_out() { grep -q -- "$1" "$TMP_ROOT/out" || fail "$2: output lacks '$1'"; }
faster_than() {
  python3 -c "import sys; sys.exit(0 if $ELAPSED < $1 else 1)" || fail "$2: took ${ELAPSED}s (limit $1s)"
}

# 1. Fresh checkout: every install runs once, JS and Python in parallel.
make_repo "$TMP_ROOT/fresh"
FAKE_NPM_SLEEP=$STUB_SLEEP FAKE_UV_SLEEP=$STUB_SLEEP run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "fresh checkout exits 0 (rc=$RC)"
expect_count '^npm install --include=dev --no-audit --no-fund --legacy-peer-deps @$' 1 "fresh: root npm install"
expect_count '^npx --no-install prisma generate @/back-end$' 1 "fresh: prisma generate in back-end"
expect_count '^uv venv --quiet --seed --python 3.11.9 agents/venv @$' 1 "fresh: venv on Python 3.11.9"
expect_count '^uv pip install --quiet --python venv/bin/python -r requirements.txt @/agents$' 1 "fresh: requirements"
expect_count "^node --import tsx -e require('./scripts/seed-dump-cache.ts') @/back-end$" 1 "fresh: import check"
expect_count '^sudo -n service postgresql start' 1 "fresh: Postgres started without a password prompt"
expect_out '\[rose-startup\] check: backend seed-cache imports ready' "fresh"
expect_out '\[rose-startup\] ready in ' "fresh"
# Serial installs would take 2 x STUB_SLEEP.
faster_than "$((STUB_SLEEP * 2 - 1)).5" "fresh: JS and Python installs overlap"
pass "fresh checkout installs JS deps, Prisma client and venv in parallel (${ELAPSED}s)"

# 2. Resumed session: nothing to install, seconds not minutes.
FAKE_NPM_SLEEP=$STUB_SLEEP FAKE_UV_SLEEP=$STUB_SLEEP run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "resume exits 0 (rc=$RC)"
expect_count '^npm ' 0 "resume: no npm"
expect_count '^npx ' 0 "resume: no prisma generate"
expect_count '^uv ' 0 "resume: no uv"
expect_count '^node --import tsx' 1 "resume: import check still runs"
expect_out 'js: dependencies unchanged; skipped' "resume"
expect_out 'prisma: client up to date; skipped' "resume"
expect_out 'py: agents/venv satisfies requirements.txt; skipped' "resume"
faster_than 2 "resume: skips are fast"
pass "resumed session skips every install (${ELAPSED}s)"

# 3. schema.prisma changed: only the Prisma client is regenerated.
echo 'model B { id Int @id }' >>"$REPO/back-end/prisma/schema.prisma"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "schema change exits 0 (rc=$RC)"
expect_count '^npm ' 0 "schema change: no npm"
expect_count '^npx --no-install prisma generate' 1 "schema change: prisma generate"
expect_count '^uv ' 0 "schema change: no uv"
pass "schema change regenerates only the Prisma client"

# 4. A package manifest changed: npm install + prisma generate, venv untouched.
echo '{"name":"back-end","dependencies":{"x":"1"}}' >"$REPO/back-end/package.json"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "manifest change exits 0 (rc=$RC)"
expect_count '^npm install' 1 "manifest change: npm install"
expect_count '^npx --no-install prisma generate' 1 "manifest change: prisma generate"
expect_count '^uv ' 0 "manifest change: no uv"
pass "a manifest change reinstalls JS deps only"

# 5. npm fails: reported, Python still installed, no stamp, next run retries.
make_repo "$TMP_ROOT/npm-fail"
FAKE_NPM_FAIL=1 run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 1 ] || fail "npm failure exits 1 (rc=$RC)"
expect_out '\[js\] npm ERR! fake failure' "npm failure output reaches the report"
expect_out '\[rose-startup\] FAILED: js' "npm failure"
expect_out 'check: skipped (JS dependencies are not ready)' "npm failure"
expect_count '^uv pip install' 1 "npm failure: Python branch still completes"
expect_count '^node --import' 0 "npm failure: no import check"
expect_count '^npx ' 0 "npm failure: no prisma generate"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "retry after npm failure exits 0 (rc=$RC)"
expect_count '^npm install' 1 "retry: npm install runs again"
expect_count '^uv ' 0 "retry: venv kept"
pass "npm failure is reported and retried on the next start"

# 6. Import check fails: reported as a failure.
FAKE_CHECK_RC=1 run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 1 ] || fail "failed import check exits 1 (rc=$RC)"
expect_out '\[rose-startup\] FAILED: check' "failed import check"
pass "failed import check fails the startup"

# 7. Shared installs (symlinks, as in a boxes worktree) are checked, never modified.
make_repo "$TMP_ROOT/shared-src"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "shared source install exits 0 (rc=$RC)"
SHARED="$REPO"
make_repo "$TMP_ROOT/linked"
ln -s "$SHARED/node_modules" "$REPO/node_modules"
ln -s "$SHARED/agents/venv" "$REPO/agents/venv"
before="$(cd "$SHARED" && find node_modules agents/venv -exec ls -ld {} + | md5sum)"
echo 'model C { id Int @id }' >>"$REPO/back-end/prisma/schema.prisma"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "linked installs exit 0 (rc=$RC)"
expect_count '^npm ' 0 "linked: no npm"
expect_count '^npx ' 0 "linked: no prisma generate into the shared tree"
expect_count '^uv ' 0 "linked: no uv"
after="$(cd "$SHARED" && find node_modules agents/venv -exec ls -ld {} + | md5sum)"
[ "$before" = "$after" ] || fail "linked: shared install was modified"
rm "$SHARED/agents/venv/.installed"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 1 ] || fail "unsatisfied shared venv exits 1 (rc=$RC)"
expect_out 'links to a shared venv that is not satisfied; not modifying it' "unsatisfied shared venv"
expect_count '^uv ' 0 "unsatisfied shared venv: no uv"
pass "symlinked shared installs are checked, never modified"

# 8. No uv on PATH (the E2B template): pinned uv is installed for the user.
stub "$TMP_ROOT/no-uv-bin" python3 <<EOF
echo "python3 \$* @\${PWD#"\$REPO"}" >>"\$CALLS"
mkdir -p "\$HOME/.local/bin" && cp "$TMP_ROOT/uv-bin/uv" "\$HOME/.local/bin/uv"
EOF
make_repo "$TMP_ROOT/no-uv"
rm -rf "$HOME/.local"
run_startup "$TMP_ROOT/no-uv-bin"
[ "$RC" = 0 ] || fail "no uv exits 0 (rc=$RC)"
expect_count '^python3 -m pip install --user --quiet --disable-pip-version-check uv==' 1 "no uv: pinned uv installed"
expect_count '^uv venv --quiet --seed --python 3.11.9' 1 "no uv: venv created with installed uv"
pass "missing uv is installed for the user and used"

# 9. The sync script (template sandbox) followed by a session start: the snapshot's
# stamps make the session skip every install; a later lockfile change reinstalls.
make_git_repo() {
  make_repo "$1"
  git init -q -b main --bare "$1.remote.git"
  (cd "$REPO" && git init -q -b main && git remote add origin "$1.remote.git" \
    && git add -A && git -c user.name=t -c user.email=t@example.com commit -qm init \
    && git push -q origin main)
}
run_sync() {
  : >"$CALLS"
  set +e
  (cd "$REPO" && PATH="$1:$BASE_PATH" bash "$SYNC_SCRIPT" </dev/null >"$TMP_ROOT/out" 2>&1)
  RC=$?
  set -e
}
make_git_repo "$TMP_ROOT/snap"
run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "sync exits 0 (rc=$RC)"
expect_count '^npm install --include=dev --no-audit --no-fund --legacy-peer-deps @$' 1 "sync: npm install"
expect_count '^npx --no-install prisma generate @/back-end$' 0 "sync: prisma generate uses npx without --no-install"
expect_count '^npx prisma generate @/back-end$' 1 "sync: prisma generate"
expect_count '^uv venv --quiet --seed --python 3.11.9 agents/venv @$' 1 "sync: venv on Python 3.11.9"
expect_count "^node --import tsx -e require('./scripts/seed-dump-cache.ts') @/back-end$" 1 "sync: import check"
expect_out '\[rose-sync\] ready at ' "sync"
run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "second sync exits 0 (rc=$RC)"
expect_count '^npm ' 0 "second sync: incremental, no npm"
expect_count '^uv ' 0 "second sync: incremental, no uv"
expect_count '^npx prisma generate' 1 "second sync: prisma generate always runs"
# A new session starts from that snapshot: nothing to install.
FAKE_NPM_SLEEP=$STUB_SLEEP FAKE_UV_SLEEP=$STUB_SLEEP run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "session start after sync exits 0 (rc=$RC)"
expect_count '^npm ' 0 "snapshot start: no npm"
expect_count '^npx ' 0 "snapshot start: no prisma generate"
expect_count '^uv ' 0 "snapshot start: no uv"
expect_out 'js: dependencies unchanged; skipped' "snapshot start"
expect_out 'prisma: client up to date; skipped' "snapshot start"
expect_out 'py: agents/venv satisfies requirements.txt; skipped' "snapshot start"
faster_than 2 "snapshot start is fast"
pass "a session started from the sync snapshot skips every install (${ELAPSED}s)"
# main moved a lockfile since the snapshot: the startup falls back to installing.
echo '{"lockfileVersion":3,"changed":true}' >"$REPO/back-end/package-lock.json"
run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "stale snapshot start exits 0 (rc=$RC)"
expect_count '^npm install' 1 "stale snapshot: npm install fallback"
expect_count '^npx --no-install prisma generate' 1 "stale snapshot: prisma regenerated after an install"
expect_count '^uv ' 0 "stale snapshot: venv kept"
pass "a stale snapshot falls back to the stamp-guarded install"

echo "rose-startup-script: all tests passed"
