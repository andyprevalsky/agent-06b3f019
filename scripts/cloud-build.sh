#!/usr/bin/env bash
# Cord / cloud-Linux build-phase entry point. This is the ONE script Cord's
# build command runs per fresh instance. It provisions everything the repo
# needs so subsequent `bash scripts/run.sh` calls just work:
#
#   1. Env vars — generates a unique CONDUCTOR_WORKSPACE_NAME (so Temporal
#      queues / Postgres containers don't collide with other cloud instances),
#      writes CONDUCTOR_PORT / CONDUCTOR_ROOT_PATH to .cloud-env, and appends a
#      source line to ~/.bashrc etc. so future shells inherit them.
#   2. Docker — installs Docker Engine (Linux only) via get.docker.com and
#      starts the daemon; adds $USER to the docker group so run.sh can spin up
#      the per-workspace Postgres container without sudo.
#   3. JS deps — npm install at repo root (covers back-end / front-end /
#      agents via workspaces).
#   4. agents Python venv + pip install.
#
# Idempotent — safe to re-run. Each step checks its own marker (file exists,
# CLI on PATH, daemon reachable) and skips if already done.
#
# Cord's build command: bash scripts/cloud-build.sh

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IS_MAC=false
[ "$(uname)" = "Darwin" ] && IS_MAC=true

echo "═══ Rose cloud build ═══"
echo "Root: $ROOT"
echo "OS:   $(uname) $(uname -m)"
echo ""

# ── 0. Git identity (required for Vercel deploy — must match a GitHub account) ─
git config user.name  "Andy Prevalsky"
git config user.email "andyprevalsky@yahoo.com"
echo "✅ Git identity: Andy Prevalsky <andyprevalsky@yahoo.com>"

# ── 1. Conductor-compatible env vars ─────────────────────────────────────
. "$ROOT/scripts/lib/workspace-env.sh"
ensure_cloud_workspace_env "$ROOT" "${CONDUCTOR_PORT:-3001}"

# Load env vars into THIS shell too, so subsequent steps in this script see them.
[ -f .cloud-env ] && . ./.cloud-env

# ── 2. Docker (Linux only — macOS uses Docker Desktop) ───────────────────
# Backend needs Docker for the per-workspace Postgres container (see run.sh).
# Cord's build phase runs as root (no sudo binary); interactive Conductor/dev
# shells have passwordless sudo. Pick a privilege wrapper that works in both.
if ! $IS_MAC; then
    if [ "$(id -u)" = "0" ]; then
        SUDO=""                                     # already root (Cord build)
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        SUDO="sudo"                                 # passwordless sudo
    else
        SUDO=""                                     # no privilege — best-effort, will fail loudly
        echo "⚠️  No root or passwordless sudo — Docker setup may fail."
    fi

    if docker info >/dev/null 2>&1; then
        echo "✅ Docker daemon reachable"
    elif command -v docker >/dev/null 2>&1; then
        echo "🐳 Docker installed — starting daemon..."
        $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
        [ -n "$SUDO" ] && [ "$USER" != "root" ] && $SUDO usermod -aG docker "$USER" 2>/dev/null || true
        $SUDO docker info >/dev/null 2>&1 && echo "   ✅ Daemon running"
    else
        echo "🐳 Installing Docker..."
        curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
        [ -n "$SUDO" ] && [ "$USER" != "root" ] && $SUDO usermod -aG docker "$USER" 2>/dev/null || true
        $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
        echo "   Installed: $($SUDO docker --version 2>/dev/null || echo docker)"
    fi

    # ── 2b. Fallback: system Postgres when Docker daemon can't run ──────
    # Some sandboxed environments (containers, CI without --privileged) can
    # install Docker but can't start the daemon. Install system Postgres as
    # a fallback so run.sh / blackbox tests still have a database.
    if ! docker info >/dev/null 2>&1; then
        echo "⚠️  Docker daemon unavailable — installing system Postgres as fallback..."
        if ! command -v pg_isready >/dev/null 2>&1; then
            $SUDO apt-get update -qq && $SUDO apt-get install -y -qq postgresql postgresql-client
        fi
        # The pgvector installer builds against headers pinned to the installed
        # server. A reused VM snapshot can carry a server minor the archive no
        # longer offers headers for; move that server to the archive candidate first.
        PG_MAJOR=$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)
        if [ -n "$PG_MAJOR" ] && [ ! -f "/usr/share/postgresql/$PG_MAJOR/extension/vector.control" ]; then
            PG_INSTALLED=$(dpkg-query -W -f='${Version}' "postgresql-$PG_MAJOR" 2>/dev/null || true)
            $SUDO apt-get update -qq \
                || echo "   ⚠️  Could not refresh package metadata; trying the pinned pgvector build"
            if [ -n "$PG_INSTALLED" ] && ! apt-cache madison "postgresql-server-dev-$PG_MAJOR" \
                | awk -F'|' '{gsub(/ /, "", $2); print $2}' | grep -qxF "$PG_INSTALLED"; then
                echo "   Refreshing postgresql-$PG_MAJOR $PG_INSTALLED (no matching headers in the archive)"
                $SUDO apt-get install -y -qq --only-upgrade "postgresql-$PG_MAJOR" "postgresql-client-$PG_MAJOR" \
                    || echo "   ⚠️  Could not refresh postgresql-$PG_MAJOR; pgvector install may fail"
            fi
        fi
        PG_VER=$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')
        # pgvector for the installed major (planner-memory vector columns). If the
        # pinned build still cannot find matching headers, that must never abort
        # the npm/venv provisioning below.
        PG_FALLBACK_ERROR=""
        if ! $SUDO bash "$ROOT/scripts/cloudbench-install-pgvector.sh"; then
            echo "⚠️  Pinned pgvector build failed — installing postgresql-$PG_VER-pgvector"
            $SUDO apt-get install -y -qq "postgresql-$PG_VER-pgvector" \
                || PG_FALLBACK_ERROR="pgvector unavailable — prisma db push needs the vector extension"
        fi
        # Start the cluster
        $SUDO pg_ctlcluster "$PG_VER" main start 2>/dev/null || $SUDO service postgresql start 2>/dev/null || true
        # Set password + create DB to match the Docker container convention
        $SUDO su - postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" 2>/dev/null || true
        $SUDO su - postgres -c "createdb victoria" 2>/dev/null || true
        # Enable md5 auth so localhost TCP connections work with password
        PG_HBA=$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)
        if [ -n "$PG_HBA" ]; then
            # pg_hba.conf is root-owned; always edit via $SUDO (plain sed fails
            # under set -e in passwordless-sudo cloud agents and aborts before
            # npm/venv provisioning).
            $SUDO sed -i 's/^local\s\+all\s\+all\s\+peer/local   all             all                                     md5/' "$PG_HBA"
            $SUDO sed -i 's/^\(host\s\+all\s\+all\s\+127\.0\.0\.1\/32\s\+\)scram-sha-256/\1md5/' "$PG_HBA"
            $SUDO pg_ctlcluster "$PG_VER" main reload 2>/dev/null || true
        fi
        # Parallel deploy coverage (backend unit + blackbox + agents) opens many
        # Prisma pools. Default max_connections=100 OOMs the gate with
        # "sorry, too many clients already" — raise before restart.
        PG_CONF=$(find /etc/postgresql -name postgresql.conf 2>/dev/null | head -1)
        if [ -n "$PG_CONF" ]; then
            $SUDO sed -i 's/^#*max_connections.*/max_connections = 300/' "$PG_CONF"
            $SUDO pg_ctlcluster "$PG_VER" main restart 2>/dev/null \
              || $SUDO service postgresql restart 2>/dev/null \
              || true
        fi
        if [ -n "$PG_FALLBACK_ERROR" ]; then
            echo "❌ System Postgres fallback unusable: $PG_FALLBACK_ERROR"
        elif pg_isready -U postgres -q 2>/dev/null; then
            echo "✅ System Postgres running (fallback — no Docker)"
        else
            echo "❌ Failed to start system Postgres"
        fi
    fi
fi

# ── 3 & 4: JS (npm + prisma generate) || Python (venv + pip) in parallel ─
# JS branch: npm install at root covers back-end/front-end/agents (workspaces),
# then `prisma generate` populates back-end/node_modules/.prisma/client.
# Python branch: agents venv + pip install. No cross-dependency, run together.
JS_LOG="$(mktemp)"; PY_LOG="$(mktemp)"
trap 'rm -f "$JS_LOG" "$PY_LOG"' EXIT

(
    # cloud-init seeds the DB through `npx --no-install tsx`, so a tree without
    # the back-end devDependency tsx counts as unprovisioned.
    if [ -f package.json ] && { [ ! -d node_modules ] \
        || { [ ! -x node_modules/.bin/tsx ] && [ ! -x back-end/node_modules/.bin/tsx ]; }; }; then
        echo "📦 npm install (root + workspaces)..."
        # Arborist on npm 10.9 + this workspace tree throws
        # `Cannot read properties of null (reading 'edgesOut')` while
        # resolving vitest peers. --legacy-peer-deps skips that path.
        npm install --include=dev --no-audit --no-fund --legacy-peer-deps
    else
        echo "✅ Root node_modules already present"
    fi
    echo "🔧 prisma generate..."
    (cd back-end && npx prisma generate)
) >"$JS_LOG" 2>&1 &
JS_PID=$!

(
    # Snapshot VMs reuse an old venv; reinstall whenever an installed release no
    # longer satisfies requirements.txt so pin bumps on main are applied.
    if [ ! -f agents/venv/bin/activate ] \
        || ! agents/venv/bin/python scripts/lib/agents_venv_satisfied.py agents/requirements.txt; then
        echo "🐍 Setting up agents venv..."
        PYTHON_BIN="$(command -v python3)"
        [ -f agents/venv/bin/activate ] || (cd agents && "$PYTHON_BIN" -m venv venv)
        (cd agents && . venv/bin/activate && pip install -q -r requirements.txt)
    else
        echo "✅ agents venv already provisioned"
    fi
    # scripts/setup-world-model.sh builds the native WMH env with uv.
    command -v uv >/dev/null || [ -x agents/venv/bin/uv ] || agents/venv/bin/python -m pip install -q uv
) >"$PY_LOG" 2>&1 &
PY_PID=$!

set +e
wait "$JS_PID"; JS_RC=$?
wait "$PY_PID"; PY_RC=$?
set -e

echo "─── JS branch (rc=$JS_RC) ───"
cat "$JS_LOG"
echo "─── Python branch (rc=$PY_RC) ───"
cat "$PY_LOG"

[ $JS_RC -eq 0 ] || { echo "❌ JS setup failed"; exit $JS_RC; }
[ $PY_RC -eq 0 ] || { echo "❌ Python setup failed"; exit $PY_RC; }
[ -z "${PG_FALLBACK_ERROR:-}" ] || { echo "❌ Database setup failed: $PG_FALLBACK_ERROR"; exit 1; }

echo ""
echo "✅ Cloud build complete"
