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
export TMP_ROOT
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
[ "$1" = install ] || exit 0
sleep "${FAKE_NPM_SLEEP:-0}"
[ -z "${FAKE_NPM_FAIL:-}" ] || { echo "npm ERR! fake failure"; exit 7; }
mkdir -p node_modules/.bin && printf '#!/bin/sh\n' >node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx
EOF
  stub "$bin" npx <<'EOF'
echo "npx $* @${PWD#"$REPO"}" >>"$CALLS"
mkdir -p ../node_modules/.prisma/client && : >../node_modules/.prisma/client/index.js
EOF
  stub "$bin" node <<'EOF'
if [ "$1" = --version ]; then echo "${FAKE_NODE_VERSION:-v22.23.4}"; exit 0; fi
# node_ok (>= 22.12): old until the sudo stub saw the tarball extracted.
if [ "$1" = -e ]; then [ -z "${FAKE_NODE_OLD:-}" ] || [ -f "$TMP_ROOT/node-new" ]; exit $?; fi
if [ "$1" = -p ]; then echo 22; exit 0; fi
echo "node $* @${PWD#"$REPO"}" >>"$CALLS"
exit "${FAKE_CHECK_RC:-0}"
EOF
  stub "$bin" sudo <<'EOF'
echo "sudo $* @${PWD#"$REPO"}" >>"$CALLS"
case "$*" in *"tar -xJf"*) : >"$TMP_ROOT/node-new" ;; esac
case "$*" in *cloudbench-install-pgvector.sh*) touch "$ROSE_PG_SHARE_DIR/14/extension/vector.control" ;; esac
case "$*" in *cloudbench-install-ngrok.sh*) cp -n "$TMP_ROOT/bin/ngrok" "$TMP_ROOT/bare-bin/" ;; esac
case "$*" in *"install -m 0755 gh_"*) cp -n "$TMP_ROOT/bin/gh" "$TMP_ROOT/bare-bin/" ;; esac
case "$*" in *"apt-get install"*) for t in lsof sqlite3 ruby rsync psql pg_isready createdb; do cp -n "$TMP_ROOT/bin/$t" "$TMP_ROOT/bare-bin/" 2>/dev/null; done ;; esac
# Run through only what the sync script needs for real: probes and commands that
# must not touch the host (apt, service, tar, ln, install, sed, find) are recorded.
case "$*" in "-n true") exit 0 ;; "-n find /etc/postgresql -name pg_hba.conf") echo "$TMP_ROOT/pg_hba.conf" ;; "-n find /etc/postgresql -name postgresql.conf") echo "$TMP_ROOT/postgresql.conf" ;; esac
EOF
  stub "$bin" pg_ctlcluster <<'EOF'
exit 0
EOF
  stub "$bin" pg_lsclusters <<'EOF'
echo "14 main 5432 online postgres /var/lib/postgresql/14/main"
EOF
  # Postgres client stubs: FAKE_PG_DOWN = server not accepting, FAKE_NO_VICTORIA =
  # server up without the victoria database, FAKE_SEEDED = dev user already present.
  stub "$bin" pg_isready <<'EOF'
[ -z "${FAKE_PG_DOWN:-}" ]
EOF
  stub "$bin" psql <<'EOF'
echo "psql $*" >>"$CALLS"
case " $* " in *" -d victoria "*) [ -z "${FAKE_NO_VICTORIA:-}" ] || exit 2 ;; esac
case "$*" in *'FROM "User"'*) [ -z "${FAKE_SEEDED:-}" ] || echo 1 ;; *datname*) [ -n "${FAKE_VICTORIA_MISSING:-}" ] || echo 1 ;; *) echo 1 ;; esac
EOF
  stub "$bin" createdb <<'EOF'
echo "createdb $*" >>"$CALLS"
EOF
  for tool in lsof sqlite3 ruby rsync gh flyctl ngrok apt-get; do
    stub "$bin" "$tool" <<'EOF'
echo "$(basename "$0") $*" >>"$CALLS"
EOF
  done
  stub "$bin" curl <<'EOF'
# Writes a dummy payload; checksum listings carry its real sha256.
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >>"$CALLS"
h="$(printf x | sha256sum | cut -d' ' -f1)"
case "$url" in
  *SHASUMS256.txt) echo "$h  node-v22.23.4-linux-x64.tar.xz" ;;
  *_checksums.txt) echo "$h  gh_2.94.0_linux_amd64.tar.gz" ;;
  *fly.io/install.sh) echo 'mkdir -p "$HOME/.fly/bin" && : >"$HOME/.fly/bin/flyctl" && chmod +x "$HOME/.fly/bin/flyctl"' ;;
  *) [ -z "$out" ] || printf x >"$out" ;;
esac
EOF
  stub "$bin" tar <<'EOF'
echo "tar $*" >>"$CALLS"
mkdir -p gh_2.94.0_linux_amd64/bin && : >gh_2.94.0_linux_amd64/bin/gh
EOF
  stub "$bin" install <<'EOF'
echo "install $*" >>"$CALLS"
EOF
  # A venv python that satisfies requirements.txt once `uv pip install` ran.
  stub "$TMP_ROOT/templates" python <<'EOF'
venv="$(cd "$(dirname "$0")/.." && pwd)"
case "$1" in
  scripts/ensure-playwright-browsers.py) echo "playwright-ensure $*" >>"$CALLS" ;;
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
  cp "$ROOT_DIR/scripts/lib/agents_venv_satisfied.py" "$ROOT_DIR/scripts/lib/workspace-env.sh" "$REPO/scripts/lib/"
  # Stand-ins for the repo scripts the sync/startup scripts call (their own
  # suites cover them): each records its invocation and, where needed, its effect.
  printf '#!/usr/bin/env bash\necho "pgvector-install" >>"$CALLS"\n' >"$REPO/scripts/cloudbench-install-pgvector.sh"
  printf '#!/usr/bin/env bash\necho "apply-ddl" >>"$CALLS"\n' >"$REPO/back-end/scripts/apply-local-workflow-ddl.sh"
  cat >"$REPO/scripts/sync-reference-repos.sh" <<'REFS'
#!/usr/bin/env bash
echo "sync-reference-repos" >>"$CALLS"
for d in openclaw hermes-agent codex prime-agent kimi-code; do mkdir -p "$d"; echo sha >"$d/.ref-sha"; done
echo "# rewritten tip record" >prompt-review/REF_SHAS.txt
REFS
  mkdir -p "$REPO/prompt-review"
  echo "# committed tip record" >"$REPO/prompt-review/REF_SHAS.txt"
  export REPO
}

STUB_BIN="$TMP_ROOT/bin"
make_stubs "$STUB_BIN"
export CALLS="$TMP_ROOT/calls"
export HOME="$TMP_ROOT/home"
mkdir -p "$HOME"
# Host tools only: the developer's own uv, node, npm, psql or lsof must never be
# found, so PATH holds the stubs plus symlinks to the basic utilities the scripts use.
HOST_BIN="$TMP_ROOT/hostbin"
mkdir -p "$HOST_BIN"
for tool in bash env cat sed awk grep cut tr mktemp mkdir rm date sleep head tail ls sort find od mv cp dirname \
  basename uname id sh sha256sum shasum tac wc ln chmod xargs python3 git printf true false test touch tee; do
  src="$(PATH=/usr/bin:/bin command -v "$tool" 2>/dev/null || true)"
  [ -n "$src" ] && ln -sf "$src" "$HOST_BIN/$tool"
done
BASE_PATH="$STUB_BIN:$HOST_BIN"

# run_startup <path-extra>: runs the script like rose-project-startup does.
run_startup() {
  : >"$CALLS"
  local began
  began="$(now)"
  set +e
  (cd "$REPO" && PATH="$1:${BASE_OVERRIDE:-$BASE_PATH}" bash "$SCRIPT" </dev/null >"$TMP_ROOT/out" 2>&1)
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
expect_count '^npm install' 0 "resume: no npm"
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
expect_count '^npm install' 0 "schema change: no npm"
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
expect_count '^npm install' 0 "linked: no npm"
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
  (cd "$REPO" && PATH="$1:${BASE_OVERRIDE:-$BASE_PATH}" bash "$SYNC_SCRIPT" </dev/null >"$TMP_ROOT/out" 2>&1)
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
expect_count '^playwright-ensure scripts/ensure-playwright-browsers.py --root ' 1 "sync: Playwright browsers ensured through the repo script"
run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "second sync exits 0 (rc=$RC)"
expect_count '^npm install' 0 "second sync: incremental, no npm"
expect_count '^uv ' 0 "second sync: incremental, no uv"
expect_count '^npx prisma generate' 1 "second sync: prisma generate always runs"
# A new session starts from that snapshot: nothing to install.
FAKE_NPM_SLEEP=$STUB_SLEEP FAKE_UV_SLEEP=$STUB_SLEEP run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "session start after sync exits 0 (rc=$RC)"
expect_count '^npm install' 0 "snapshot start: no npm"
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

# 10. A small sandbox (the default 1 GB E2B template) gets a swapfile before the
# install that was OOM-killed there; the sync script removes it before the
# snapshot. A big sandbox, or a start with nothing to install, touches no swap.
printf 'MemTotal:        1008000 kB\nSwapTotal:             0 kB\n' >"$TMP_ROOT/meminfo-small"
printf 'MemTotal:       16000000 kB\nSwapTotal:             0 kB\n' >"$TMP_ROOT/meminfo-big"
make_git_repo "$TMP_ROOT/small"
ROSE_MEMINFO="$TMP_ROOT/meminfo-small" run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "sync on a small sandbox exits 0 (rc=$RC)"
expect_count '^sudo -n fallocate -l 3G /swapfile' 1 "small sync: swapfile allocated"
expect_count '^sudo -n swapon /swapfile' 1 "small sync: swap enabled"
expect_count '^sudo -n swapoff /swapfile' 1 "small sync: swap removed before the snapshot"
expect_count '^sudo -n rm -f /swapfile' 1 "small sync: swapfile deleted"
expect_out 'added 3 GB swap' "small sync"
make_git_repo "$TMP_ROOT/big"
ROSE_MEMINFO="$TMP_ROOT/meminfo-big" run_sync "$TMP_ROOT/uv-bin"
expect_count '^sudo -n fallocate' 0 "big sync: no swap"
make_repo "$TMP_ROOT/small-start"
ROSE_MEMINFO="$TMP_ROOT/meminfo-small" run_startup "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "startup install on a small sandbox exits 0 (rc=$RC)"
expect_count '^sudo -n swapon /swapfile' 1 "small startup: swap before the install"
expect_count '^sudo -n swapoff' 0 "small startup: swap stays for the session"
ROSE_MEMINFO="$TMP_ROOT/meminfo-small" run_startup "$TMP_ROOT/uv-bin"
expect_count '^sudo -n fallocate' 0 "small startup with nothing to install: no swap"
pass "small sandboxes get swap for the install (sync removes it before the snapshot)"

# 11. Sync on a bare sandbox (the E2B template: no lsof, sqlite3, ruby, rsync, gh,
# Postgres, flyctl; Node 20): every tool is installed once, then a second run is
# a no-op for the tools stage.
BARE_BIN="$TMP_ROOT/bare-bin"
mkdir -p "$BARE_BIN"
for t in npm npx node sudo pg_ctlcluster pg_lsclusters apt-get curl tar install; do cp "$STUB_BIN/$t" "$BARE_BIN/$t"; done
mkdir -p "$TMP_ROOT/pglib/14" "$TMP_ROOT/pgshare/14/extension"
export ROSE_PG_LIB_DIR="$TMP_ROOT/pglib" ROSE_PG_SHARE_DIR="$TMP_ROOT/pgshare"
BASE_OVERRIDE="$BARE_BIN:$HOST_BIN"
rm -f "$TMP_ROOT/node-new"
make_git_repo "$TMP_ROOT/bare"
FAKE_VICTORIA_MISSING=1 FAKE_NODE_OLD=1 run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "bare sync exits 0 (rc=$RC)"
expect_count '^sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update' 1 "bare: apt index refreshed once"
expect_count '^sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends lsof sqlite3 ruby rsync postgresql postgresql-client postgresql-contrib @' 1 "bare: tools and Postgres in one apt call"
expect_count '^sudo bash scripts/cloudbench-install-pgvector.sh\|^sudo -n bash scripts/cloudbench-install-pgvector.sh' 1 "bare: pgvector built through the repo installer"
expect_count '^curl https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz' 1 "bare: Node 22 downloaded"
expect_count '^sudo -n tar -xJf node-v22.23.4-linux-x64.tar.xz -C /usr/local --strip-components=1' 1 "bare: Node 22 extracted into /usr/local"
expect_count '^curl https://github.com/cli/cli/releases/download/v2.94.0/gh_2.94.0_linux_amd64.tar.gz' 1 "bare: gh downloaded"
expect_count '^sudo -n install -m 0755 gh_2.94.0_linux_amd64/bin/gh /usr/local/bin/gh' 1 "bare: gh installed on the default PATH"
expect_count '^curl https://fly.io/install.sh' 1 "bare: flyctl installer fetched"
expect_count 'cloudbench-install-ngrok.sh' 1 "bare: ngrok installed (run.sh requires it)"
expect_count '^sudo -n service postgresql start' 1 "bare: Postgres started"
expect_count '^sudo -n service postgresql restart' 1 "bare: Postgres restarted for pg_hba/max_connections"
expect_count '^createdb ' 1 "bare: victoria created when missing"
expect_out 'stage tools' "bare"
grep -q 'export ROSE_USE_SYSTEM_PG=true' "$REPO/.cloud-env" || fail "bare: sync leaves .cloud-env selecting system Postgres"
grep -q '^export CONDUCTOR_WORKSPACE_NAME=cloud-' "$REPO/.cloud-env" || fail "bare: sync creates the workspace identity"
pass "bare sandbox: tools, Node 22, pgvector, Postgres and .cloud-env are provisioned"

run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "second bare sync exits 0 (rc=$RC)"
expect_count 'apt-get' 0 "second bare sync: no apt"
expect_count 'pgvector' 0 "second bare sync: no pgvector build"
expect_count '^curl ' 0 "second bare sync: nothing downloaded"
expect_count 'tar -xJf' 0 "second bare sync: Node kept"
expect_count 'cloudbench-install-ngrok.sh' 0 "second bare sync: ngrok kept"
expect_count '^sudo -n service postgresql restart' 0 "second bare sync: Postgres not reconfigured"
expect_count '^sudo -n service postgresql start' 1 "second bare sync: Postgres only started"
expect_count '^createdb ' 0 "second bare sync: victoria kept"
expect_count '^sync-reference-repos' 0 "second bare sync: reference repos kept"
pass "a second sync leaves every tool alone"

# 12. Reference repos: cloned once, and the tracked tip record is restored.
make_git_repo "$TMP_ROOT/refs"
run_sync "$TMP_ROOT/uv-bin"
expect_count '^sync-reference-repos' 1 "refs: cloned through the repo script"
[ "$(cat "$REPO/prompt-review/REF_SHAS.txt")" = "# committed tip record" ] || fail "refs: REF_SHAS.txt not restored"
[ -z "$(cd "$REPO" && git status --porcelain --untracked-files=no)" ] || fail "refs: tracked files not clean"
for d in openclaw hermes-agent codex prime-agent kimi-code; do [ -f "$REPO/$d/.ref-sha" ] || fail "refs: $d/.ref-sha missing"; done
pass "reference repos are cloned once and tracked files stay clean"

# 13. Database: schema pushed once per schema hash; seeded from prod only with the
# project's env files present, never twice, and deferred (not failed) over budget.
make_git_repo "$TMP_ROOT/db"
run_sync "$TMP_ROOT/uv-bin"
expect_count '^npm run prisma:push:local -- --accept-data-loss --skip-generate @/back-end$' 1 "db: schema pushed through the local-only wrapper"
expect_count '^apply-ddl' 1 "db: local DDL applied"
expect_count 'seed-local.ts' 0 "db: no seed without back-end/.env"
expect_out 'back-end/.env has no DATABASE_URL' "db"
run_sync "$TMP_ROOT/uv-bin"
expect_count '^npm run prisma:push:local' 0 "db: schema unchanged on the second sync"
echo 'DATABASE_URL=postgresql://prod.example/db' >"$REPO/back-end/.env"
run_sync "$TMP_ROOT/uv-bin"
expect_count '^npx --no-install tsx scripts/seed-local.ts @/back-end$' 1 "db: seeded when the env files carry DATABASE_URL"
FAKE_SEEDED=1 run_sync "$TMP_ROOT/uv-bin"
expect_count 'seed-local.ts' 0 "db: an already seeded database is kept"
expect_out 'database already seeded' "db"
rm -rf "$HOME/.cache"
ROSE_SYNC_BUDGET_S=0 run_sync "$TMP_ROOT/uv-bin"
[ "$RC" = 0 ] || fail "over-budget sync still succeeds (rc=$RC)"
expect_count 'seed-local.ts' 0 "budget: seed deferred"
expect_out 'deferred: database seed' "budget"
FAKE_PG_DOWN=1 run_sync "$TMP_ROOT/uv-bin"
expect_out 'Postgres is not running; database stage skipped' "no Postgres"
pass "database stage: push per schema hash, one seed, budget deferral, tolerates no Postgres"

unset BASE_OVERRIDE

# 14. Startup: .cloud-env is re-keyed per session and selects system Postgres; the
# schema push follows main's schema.prisma; no Postgres or database means no push.
if [ "$(uname -s)" = Linux ]; then
  make_repo "$TMP_ROOT/cloudenv"
  run_startup "$TMP_ROOT/uv-bin"
  [ "$RC" = 0 ] || fail "startup without .cloud-env exits 0 (rc=$RC)"
  first="$(sed -n 's/^export CONDUCTOR_WORKSPACE_NAME=//p' "$REPO/.cloud-env")"
  grep -qx 'export ROSE_USE_SYSTEM_PG=true' "$REPO/.cloud-env" || fail "startup: .cloud-env lacks ROSE_USE_SYSTEM_PG"
  [ "$(grep -c ROSE_USE_SYSTEM_PG "$REPO/.cloud-env")" = 1 ] || fail "startup: duplicate ROSE_USE_SYSTEM_PG"
  run_startup "$TMP_ROOT/uv-bin"
  second="$(sed -n 's/^export CONDUCTOR_WORKSPACE_NAME=//p' "$REPO/.cloud-env")"
  [ -n "$first" ] && [ "$first" != "$second" ] || fail "startup: workspace name must change per session ($first vs $second)"
  [ "$(grep -c ROSE_USE_SYSTEM_PG "$REPO/.cloud-env")" = 1 ] || fail "startup: re-key duplicated ROSE_USE_SYSTEM_PG"
  pass ".cloud-env is created, re-keyed per session and selects system Postgres"
fi
make_repo "$TMP_ROOT/dbstart"
FAKE_PG_DOWN=1 run_startup "$TMP_ROOT/uv-bin"
expect_count '^npm run prisma:push:local' 0 "startup without Postgres: no schema push"
expect_out 'Postgres is not accepting connections' "startup without Postgres"
FAKE_NO_VICTORIA=1 run_startup "$TMP_ROOT/uv-bin"
expect_count '^npm run prisma:push:local' 0 "startup without a victoria database: no schema push"
run_startup "$TMP_ROOT/uv-bin"
expect_count '^npm run prisma:push:local -- --accept-data-loss --skip-generate @/back-end$' 1 "startup: schema pushed for a new schema hash"
run_startup "$TMP_ROOT/uv-bin"
expect_out 'db: schema unchanged; skipped' "startup"
pass "startup pushes the local schema only when Postgres and victoria are up and the schema moved"

echo "rose-startup-script: all tests passed"
