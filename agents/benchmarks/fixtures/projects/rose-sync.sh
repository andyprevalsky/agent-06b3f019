# Rose project sync script (Template sync, the equivalent of a boxes.dev Template
# box's maintenance script). Rose runs it on the project's ONE template sandbox
# on triggers (nightly, GitHub default-branch change, Run now); when it succeeds
# Rose snapshots the sandbox and new code sessions start from that snapshot with
# dependencies already installed (see rose-startup.sh for the per-session part).
#
# Incremental: a run starts from the previous snapshot, so only what changed is
# installed. Runs in the checkout (ROSE_PROJECT_DIR) with a token-bearing origin;
# Rose scrubs credentials before it snapshots. Exit non-zero = no snapshot.
#
# Parity with the boxes.dev Template devbox: a session must come up with the same
# tools (lsof sqlite3 uv uvx psql pg_isready gh ruby rsync node>=22.12 flyctl) on
# the NON-interactive PATH, system Postgres + pgvector with a seeded `victoria`
# database, the reference repos and a .cloud-env that selects system Postgres.
# Every stage is idempotent and stamp-guarded, ordered cheapest first, so a cold
# start from the base template converges over successive successful runs: the
# optional DB seed is deferred (not failed) once ROSE_SYNC_BUDGET_S seconds are
# spent, so the run still publishes a snapshot. The reference-repo clone and the
# Python venv install run in the background while npm installs.
set -euo pipefail
cd "${ROSE_PROJECT_DIR:-.}"
BRANCH="${ROSE_DEFAULT_BRANCH:-main}"

git fetch --quiet origin "$BRANCH" && git checkout --quiet "$BRANCH" && git merge --ff-only --quiet "origin/$BRANCH"

# Stamps shared with rose-startup.sh (same hash definitions): a session that starts
# from this snapshot sees them and skips every install.
SWAP_ADDED=0
# The default E2B sandbox has ~1 GB RAM and an npm install of this repo is OOM-killed
# there (measured 2026-10-28). Add a swapfile when memory is small and none exists.
ensure_swap() {
  local meminfo="${ROSE_MEMINFO:-/proc/meminfo}" mem swap
  mem=$(awk '/^MemTotal:/ {print int($2/1024)}' "$meminfo" 2>/dev/null || true)
  swap=$(awk '/^SwapTotal:/ {print $2}' "$meminfo" 2>/dev/null || true)
  [ -n "$mem" ] && [ "$mem" -lt 3500 ] && [ "${swap:-0}" = 0 ] || return 0
  if sudo -n fallocate -l 3G /swapfile && sudo -n chmod 600 /swapfile \
    && sudo -n mkswap /swapfile >/dev/null && sudo -n swapon /swapfile; then
    SWAP_ADDED=1
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=900"
    echo "[rose-sync] added 3 GB swap (this sandbox has ${mem} MB RAM)"
  else
    echo "[rose-sync] warning: could not add swap; a dependency install may be OOM-killed"
  fi
}
# The snapshot every session starts from must not carry the swapfile, and Postgres
# is stopped cleanly so the snapshot never holds a running cluster mid-write.
PG_STARTED=0
trap '[ "$PG_STARTED" = 1 ] && sudo -n service postgresql stop >/dev/null 2>&1; [ "$SWAP_ADDED" = 1 ] && { sudo -n swapoff /swapfile; sudo -n rm -f /swapfile; }; true' EXIT

STAMP="$HOME/.cache/rose-maintenance"; mkdir -p "$STAMP"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

SYNC_BEGIN=$SECONDS
# The DB seed takes ~160 s and the script has a 480 s cap (a cold start from the base
# template reaches the DB stage at ~270 s, measured 2026-11-06): never start it past
# this, so a cold start defers it to the next, incremental, run instead of timing out.
BUDGET_S="${ROSE_SYNC_BUDGET_S:-250}"
say() { printf '[rose-sync] %s\n' "$*"; }
stage() { say "stage $1 ($((SECONDS - SYNC_BEGIN))s into the run)"; }
over_budget() { [ $((SECONDS - SYNC_BEGIN)) -ge "$BUDGET_S" ]; }
OS="$(uname -s)"
SUDO=""
if [ "$(id -u)" != 0 ]; then SUDO="sudo -n"; fi
CAN_ROOT=0
if [ "$OS" = Linux ] && { [ -z "$SUDO" ] || $SUDO true 2>/dev/null; }; then CAN_ROOT=1; fi
NODE_WANT=22.23.4
GH_WANT=2.94.0
PGVECTOR_SCRIPT=scripts/cloudbench-install-pgvector.sh
DEV_USER_ID=1f85ff25-6e29-4c1b-8739-f917bd101a30
LOCAL_DB=postgresql://postgres:postgres@localhost:5432/victoria
node_ok() { node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null; }

# Stage 1: system tools. The E2B template has no lsof, sqlite3, ruby, rsync, gh,
# Postgres or flyctl and ships Node 20 (the repo needs >= 22.12).
tools() {
  [ "$CAN_ROOT" = 1 ] || { say "warning: no root/sudo (or not Linux); system tools skipped"; return 0; }
  local pkgs="" c
  for c in lsof sqlite3 ruby rsync; do command -v "$c" >/dev/null 2>&1 || pkgs="$pkgs $c"; done
  command -v pg_isready >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 || pkgs="$pkgs postgresql postgresql-client postgresql-contrib"
  if [ -n "$pkgs" ]; then
    say "apt: installing$pkgs"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    # shellcheck disable=SC2086
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pkgs >/dev/null
  fi
  # pgvector (planner-memory vector columns) built against the installed server.
  local major
  major="$(ls "${ROSE_PG_LIB_DIR:-/usr/lib/postgresql}" 2>/dev/null | sort -n | tail -1)"
  if [ -n "$major" ] && [ ! -f "${ROSE_PG_SHARE_DIR:-/usr/share/postgresql}/$major/extension/vector.control" ]; then
    say "pgvector: building for PostgreSQL $major"
    $SUDO bash "$PGVECTOR_SCRIPT" >/dev/null
  fi
  if ! node_ok; then
    say "node: installing v$NODE_WANT (found $(node -v 2>/dev/null || echo none))"
    local t tar="node-v$NODE_WANT-linux-x64.tar.xz"
    t="$(mktemp -d)"
    ( cd "$t" && curl -fsSL "https://nodejs.org/dist/v$NODE_WANT/$tar" -o "$tar" \
      && curl -fsSL "https://nodejs.org/dist/v$NODE_WANT/SHASUMS256.txt" | grep " $tar\$" | sha256sum -c - >/dev/null \
      && $SUDO tar -xJf "$tar" -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude=LICENSE )
    rm -rf "$t"; hash -r
    node_ok || { say "node: install did not yield >= 22.12"; return 1; }
  fi
  if ! command -v gh >/dev/null 2>&1; then
    say "gh: installing v$GH_WANT"
    local t tgz="gh_${GH_WANT}_linux_amd64.tar.gz"
    t="$(mktemp -d)"
    ( cd "$t" && curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_WANT/$tgz" -o "$tgz" \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_WANT/gh_${GH_WANT}_checksums.txt" | grep " $tgz\$" | sha256sum -c - >/dev/null \
      && tar -xzf "$tgz" && $SUDO install -m 0755 "gh_${GH_WANT}_linux_amd64/bin/gh" /usr/local/bin/gh )
    rm -rf "$t"
  fi
  if ! command -v flyctl >/dev/null 2>&1 && [ ! -x "$HOME/.fly/bin/flyctl" ]; then
    say "flyctl: installing"
    curl -fsSL https://fly.io/install.sh | sh >/dev/null 2>&1 || say "warning: flyctl install failed"
  fi
  # scripts/run.sh refuses to start without ngrok (the authtoken comes from the env files).
  if ! command -v ngrok >/dev/null 2>&1; then
    say "ngrok: installing"
    $SUDO bash scripts/cloudbench-install-ngrok.sh >/dev/null 2>&1 || say "warning: ngrok install failed"
  fi
  # Tool shells are non-interactive, so ~/.bashrc never adds these dirs: link them.
  local b
  for b in "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx" "$HOME/.fly/bin/flyctl"; do
    [ -x "$b" ] && [ ! -e "/usr/local/bin/$(basename "$b")" ] && $SUDO ln -sf "$b" "/usr/local/bin/$(basename "$b")"
  done
  return 0
}

# Postgres on localhost:5432 with password auth and the connection headroom the
# parallel gates need (same settings as scripts/cloud-build.sh's system-PG path).
pg_configure() {
  [ "$CAN_ROOT" = 1 ] && command -v pg_lsclusters >/dev/null 2>&1 || return 0
  local hba conf i=0
  if [ -f "$STAMP/pgconf" ]; then
    # Already configured in the snapshot: only bring the cluster up.
    $SUDO service postgresql start >/dev/null 2>&1 || true
    PG_STARTED=1
    until pg_isready -q -h localhost; do i=$((i + 1)); [ "$i" -lt 30 ] || { say "warning: Postgres did not come up"; return 1; }; sleep 1; done
    return 0
  fi
  hba="$($SUDO find /etc/postgresql -name pg_hba.conf | head -1)"
  conf="$($SUDO find /etc/postgresql -name postgresql.conf | head -1)"
  [ -n "$hba" ] && [ -n "$conf" ] || return 0
  $SUDO sed -i 's/^local\s\+all\s\+all\s\+peer/local   all             all                                     md5/' "$hba"
  $SUDO sed -i 's/^\(host\s\+all\s\+all\s\+127\.0\.0\.1\/32\s\+\)scram-sha-256/\1md5/' "$hba"
  $SUDO sed -i 's/^#*max_connections.*/max_connections = 300/' "$conf"
  $SUDO service postgresql start >/dev/null 2>&1 || true
  PG_STARTED=1
  while ! $SUDO -u postgres psql -tAc 'select 1' >/dev/null 2>&1 && ! pg_isready -q -h localhost; do
    i=$((i + 1)); [ "$i" -lt 20 ] || { say "warning: Postgres did not come up"; return 1; }
    sleep 1
  done
  ( cd / && $SUDO -u postgres psql -qc "ALTER USER postgres PASSWORD 'postgres'" >/dev/null ) || true
  $SUDO service postgresql restart >/dev/null 2>&1 || true
  i=0
  until pg_isready -q -h localhost; do i=$((i + 1)); [ "$i" -lt 20 ] || { say "warning: Postgres did not restart"; return 1; }; sleep 1; done
  PGPASSWORD=postgres psql -h localhost -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='victoria'" | grep -q 1 \
    || PGPASSWORD=postgres createdb -h localhost -U postgres victoria
  : >"$STAMP/pgconf"
}

# Same workspace identity file the startup script re-keys per session.
cloud_env() {
  [ -f scripts/lib/workspace-env.sh ] || return 0
  bash -s <<'CLOUDENV'
set -eu
. scripts/lib/workspace-env.sh
f=.cloud-env
[ -f "$f" ] || write_cloud_env "$f" 3001 "$(new_cloud_workspace_name)" "$PWD" "$(cloud_env_boot_id)" "$(cloud_env_agent_id)"
grep -qx 'export ROSE_USE_SYSTEM_PG=true' "$f" || echo 'export ROSE_USE_SYSTEM_PG=true' >>"$f"
CLOUDENV
}

stage tools
ensure_swap
tools
pg_configure || say "warning: Postgres setup incomplete; the DB stage is skipped"
cloud_env

# Background stages (independent of npm): the venv install and the reference clones.
py_deps() {
  if ! { [ -x agents/venv/bin/python ] && agents/venv/bin/python scripts/lib/agents_venv_satisfied.py agents/requirements.txt; }; then
    local uv
    uv="$(command -v uv || true)"
    if [ -z "$uv" ]; then
      python3 -m pip install --user --quiet --disable-pip-version-check "uv==0.12.24"
      uv="$HOME/.local/bin/uv"
    fi
    [ -x agents/venv/bin/python ] || "$uv" venv --quiet --seed --python 3.11.9 agents/venv
    (cd agents && "$uv" pip install --quiet --python venv/bin/python -r requirements.txt)
  fi
}
refs_present() { local d; for d in openclaw hermes-agent codex prime-agent kimi-code; do [ -f "$d/.ref-sha" ] && [ -e "$d/.git" ] || return 1; done; }
refs_clone() {
  bash scripts/sync-reference-repos.sh >/dev/null 2>&1 || { say "warning: reference repos incomplete"; return 0; }
  # sync-reference-repos.sh rewrites the tracked tip record; sessions start clean.
  git checkout -- prompt-review/REF_SHAS.txt 2>/dev/null || true
}
wait_bg() { # <pid> <label> <log>: print a background stage's output, fail with its status
  [ -n "$1" ] || return 0
  local rc=0
  wait "$1" || rc=$?
  cat "$3"
  [ "$rc" = 0 ] || { say "$2 failed (exit $rc)"; return "$rc"; }
}
LOGS="$(mktemp -d)"
stage venv+refs
py_deps >"$LOGS/py" 2>&1 &
PY_PID=$!
REFS_PID=""
if refs_present; then
  say "reference repos present"
else
  refs_clone >"$LOGS/refs" 2>&1 &
  REFS_PID=$!
fi

stage js
# Native addons are built per Node ABI: a different Node major reinstalls them.
node_major="$(node -p 'process.versions.node.split(".")[0]')"
js_hash=$(cat package.json {back-end,front-end}/package.json {back-end,front-end}/package-lock.json | sha)
js_hash=$(printf '%s\nnode%s\n' "$js_hash" "$node_major" | sha)
if [ "$js_hash" != "$(cat "$STAMP/js" 2>/dev/null || true)" ]; then
  npm install --include=dev --no-audit --no-fund --legacy-peer-deps
  [ -f "$STAMP/js" ] && npm rebuild --no-audit --no-fund --legacy-peer-deps >/dev/null 2>&1 || true
  echo "$js_hash" > "$STAMP/js"
fi
(cd back-end && npx prisma generate)
sha < back-end/prisma/schema.prisma > "$STAMP/prisma"

stage join
wait_bg "$PY_PID" "python venv" "$LOGS/py"
wait_bg "$REFS_PID" "reference repos" "$LOGS/refs"
rm -rf "$LOGS"
# Chromium for the python and node Playwright (browser blackboxes, run.sh); a no-op once present.
agents/venv/bin/python scripts/ensure-playwright-browsers.py --root "$PWD" >/dev/null 2>&1 || say "warning: Playwright browsers not installed"
(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts')")

# Stage: database schema + prod seed (stamped by schema hash; seed once per snapshot).
stage db
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost; then
  want="$(sha < back-end/prisma/schema.prisma)"
  if [ "$want" != "$(cat "$STAMP/dbschema" 2>/dev/null || true)" ]; then
    (cd back-end && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" npm run prisma:push:local -- --accept-data-loss --skip-generate >/dev/null \
      && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" LOCAL_DB_NAME=victoria bash scripts/apply-local-workflow-ddl.sh >/dev/null \
      && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" npx --no-install tsx scripts/ensure-agent-network-grep-indexes.ts >/dev/null) \
      && echo "$want" > "$STAMP/dbschema" || say "warning: schema push failed"
  else
    say "database schema unchanged"
  fi
  seeded="$(PGPASSWORD=postgres psql -h localhost -U postgres -d victoria -tAc "SELECT 1 FROM \"User\" WHERE \"userId\"='$DEV_USER_ID' LIMIT 1" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$seeded" = 1 ]; then
    say "database already seeded"
  elif ! grep -q '^DATABASE_URL=' back-end/.env 2>/dev/null; then
    say "warning: back-end/.env has no DATABASE_URL; the database keeps its schema only (push the project's env files first)"
  elif over_budget; then
    say "deferred: database seed (run budget spent; the next run completes it)"
  else
    # Read-only pull of the dev user's rows from production into the local copy.
    if (cd back-end && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=96" npx --no-install tsx scripts/seed-local.ts >/dev/null); then
      say "database seeded"
    else
      say "warning: seed failed; the database keeps its schema only"
    fi
  fi
else
  say "warning: Postgres is not running; database stage skipped"
fi
say "ready at $(git rev-parse --short HEAD) in $((SECONDS - SYNC_BEGIN))s"
