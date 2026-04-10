#!/bin/bash
set -eo pipefail

# Parse flags
BENCHMARK_MODE=false
for arg in "$@"; do
    case "$arg" in
        --benchmark) BENCHMARK_MODE=true ;;
    esac
done

if [ -z "$CONDUCTOR_PORT" ]; then
  echo '❌ CONDUCTOR_PORT not set. Run via Conductor.'
  exit 1
fi

export BACKEND_PORT=$CONDUCTOR_PORT
export FRONTEND_PORT=$(($BACKEND_PORT + 1))
export HEALTH_PORT=$(($BACKEND_PORT + 2))
export RESEARCH_PORT=$(($BACKEND_PORT + 3))
export SDK_METRICS_PORT=$(($BACKEND_PORT + 5))
export BACKEND_API_URL=http://localhost:$BACKEND_PORT
export VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT
export BACKEND_URL=http://localhost:$BACKEND_PORT
export MAC_APP_PORT=$(($BACKEND_PORT + 4))
export ALLOWED_ORIGINS=http://localhost:$FRONTEND_PORT,http://localhost:$MAC_APP_PORT
export TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME

export LOCAL_DB_PORT=$(($BACKEND_PORT + 10))
echo "🔌 Ports: backend=$BACKEND_PORT frontend=$FRONTEND_PORT health=$HEALTH_PORT research=$RESEARCH_PORT mac-app=$MAC_APP_PORT metrics=$SDK_METRICS_PORT db=$LOCAL_DB_PORT queue=$TEMPORAL_TASK_QUEUE benchmark_mode=$BENCHMARK_MODE"

# ── Pre-flight: ensure Docker is running ──
if ! docker ps &>/dev/null 2>&1; then
    if [ -d "/Applications/Docker.app" ]; then
        echo "🐳 Docker not running — starting Docker Desktop..."
        open -a Docker
        # Wait up to 60s for Docker to be ready
        for i in $(seq 1 60); do
            if docker ps &>/dev/null 2>&1; then
                echo "🐳 Docker is ready"
                break
            fi
            if [ "$i" -eq 60 ]; then
                echo "⚠️  Docker did not start in 60s — research service may fail"
            fi
            sleep 1
        done
    else
        echo "⚠️  Docker Desktop not installed — research service may fail"
    fi
fi

# ── Pre-flight: start local Postgres for backend ──
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
export DATABASE_URL="$LOCAL_DB_URL"
export DIRECT_URL="$LOCAL_DB_URL"

if docker ps --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    echo "🐘 Local Postgres already running ($DB_CONTAINER)"
elif docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    echo "🐘 Starting stopped Postgres container..."
    docker start "$DB_CONTAINER" >/dev/null
else
    echo "🐘 Creating local Postgres container..."
    docker run -d \
        --name "$DB_CONTAINER" \
        -e POSTGRES_PASSWORD=postgres \
        -e POSTGRES_DB=victoria \
        -p "$LOCAL_DB_PORT:5432" \
        -v "$DB_VOLUME:/var/lib/postgresql/data" \
        postgres:16-alpine >/dev/null
fi

# Wait for Postgres to accept connections
echo -n "   Waiting for Postgres..."
for i in $(seq 1 30); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
        echo " ready (${i}s)"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo " ❌ timed out"
        exit 1
    fi
    sleep 1
done

# Sync Prisma schema to local DB (idempotent, dev-only)
echo "🐘 Syncing Prisma schema..."
(cd back-end && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3)

# Seed local DB if dev user doesn't exist yet (full prod sync in scripts/setup-db.sh)
USER_EXISTS=$(docker exec "$DB_CONTAINER" psql -U postgres -d victoria -tAc \
  "SELECT COUNT(*) FROM \"User\" WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$USER_EXISTS" = "0" ]; then
    echo "🌱 Syncing production data to local database (first run)..."
    (cd back-end && npx tsx scripts/seed-local.ts)
else
    echo "🌱 Local database already seeded (skipping sync)"
fi

# ── Pre-flight: ensure node_modules exist for all JS services ──
for svc_dir in back-end front-end mac-app; do
    if [ -f "$svc_dir/package.json" ] && [ ! -d "$svc_dir/node_modules" ]; then
        echo "📦 Installing $svc_dir dependencies..."
        (cd "$svc_dir" && npm install)
        echo "📦 $svc_dir deps ready"
    fi
done

# ── Pre-flight: ensure agents venv exists with deps installed ──
if [ ! -f agents/venv/bin/activate ] || ! agents/venv/bin/python -c "import temporalio" 2>/dev/null; then
    echo "🐍 Setting up agents virtualenv..."
    PYTHON_VERSION=$(cat agents/.python-version 2>/dev/null || echo "3.11")
    # Try asdf python first, then system python3
    PYTHON_BIN="$(asdf where python "$PYTHON_VERSION" 2>/dev/null)/bin/python3" || true
    if [ ! -x "$PYTHON_BIN" ]; then
        PYTHON_BIN=$(command -v python3)
    fi
    echo "   Using: $PYTHON_BIN ($($PYTHON_BIN --version 2>&1))"
    if [ ! -f agents/venv/bin/activate ]; then
        (cd agents && "$PYTHON_BIN" -m venv venv)
    fi
    (cd agents && source venv/bin/activate && pip install -r requirements.txt)
    echo "🐍 Agents venv ready"
fi

# Pre-flight: stop stale Supabase containers from a previous run of THIS workspace.
# config.toml is gitignored and generated by run-local.sh with workspace-specific ports/project_id,
# so this only targets containers belonging to this workspace.
if [ -f research/supabase/config.toml ] && command -v supabase &>/dev/null && docker ps &>/dev/null 2>&1; then
    (cd research/supabase && supabase stop 2>/dev/null) || true
fi

# Pre-flight: kill anything holding our ports from a previous run (skip Docker processes)
for port in $BACKEND_PORT $FRONTEND_PORT $HEALTH_PORT $RESEARCH_PORT $MAC_APP_PORT $SDK_METRICS_PORT $LOCAL_DB_PORT; do
    pids=$(lsof -ti :"$port" 2>/dev/null) || true
    if [ -n "$pids" ]; then
        # Filter out Docker processes to avoid killing the Docker engine
        safe_pids=""
        for pid in $pids; do
            cmd=$(ps -p "$pid" -o command= 2>/dev/null) || true
            if ! echo "$cmd" | grep -qi docker; then
                safe_pids="$safe_pids $pid"
            fi
        done
        if [ -n "$safe_pids" ]; then
            echo "⚠️  Port $port in use — killing stale processes"
            echo "$safe_pids" | xargs kill -9 2>/dev/null || true
        fi
    fi
done
pkill -f "$PWD/mac-app/node_modules" 2>/dev/null || true

PIDS=()
NAMES=()
SHUTTING_DOWN=false

kill_tree() {
    local pid=$1
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

cleanup() {
    if $SHUTTING_DOWN; then return; fi
    SHUTTING_DOWN=true
    echo "🛑 Stopping all services..."
    # Kill tracked PID trees first
    for pid in "${PIDS[@]}"; do
        kill_tree "$pid"
    done
    # Stop local Postgres container (data persists in named volume)
    docker stop "$DB_CONTAINER" 2>/dev/null || true
    # Stop Supabase containers gracefully
    if command -v supabase &>/dev/null && docker ps &>/dev/null 2>&1; then
        (cd research/supabase && supabase stop 2>/dev/null) || true
    fi
    # Kill anything still holding our ports (skip Docker processes)
    for port in $BACKEND_PORT $FRONTEND_PORT $HEALTH_PORT $RESEARCH_PORT $MAC_APP_PORT $SDK_METRICS_PORT; do
        for pid in $(lsof -ti :"$port" 2>/dev/null); do
            cmd=$(ps -p "$pid" -o command= 2>/dev/null) || true
            echo "$cmd" | grep -qi docker || kill "$pid" 2>/dev/null || true
        done
    done
    # Electron spawns GPU/renderer helpers that don't bind tracked ports
    pkill -f "$PWD/mac-app/node_modules" 2>/dev/null || true
    wait 2>/dev/null
}
trap cleanup EXIT

# Wrapper: run a service and write its exit code to a temp file on failure
FAIL_DIR=$(mktemp -d)
run_service() {
    local name="$1"
    shift
    "$@"
    local code=$?
    if [ $code -ne 0 ]; then
        echo "$name" > "$FAIL_DIR/failed"
        echo "$code" > "$FAIL_DIR/exit_code"
    fi
    return $code
}

# Launch each service
run_service "back-end" bash -c 'set -eo pipefail; cd back-end && rm -f backend-logs.log && PORT=$BACKEND_PORT npx tsx watch src/server.ts 2>&1 | tee backend-logs.log' &
PIDS+=($!); NAMES+=("back-end")

if ! $BENCHMARK_MODE; then
    run_service "front-end" bash -c 'set -eo pipefail; cd front-end && rm -f frontend-logs.log && VITE_DEV_PORT=$FRONTEND_PORT npx vite 2>&1 | tee frontend-logs.log' &
    PIDS+=($!); NAMES+=("front-end")

    run_service "mac-app" bash -c 'set -eo pipefail; cd mac-app && source ~/.nvm/nvm.sh && nvm use 20.10.0 && rm -f mac-app-console-logs.log mac-app-ipc-logs.log && VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT npm run dev 2>&1 | tee mac-app-console-logs.log' &
    PIDS+=($!); NAMES+=("mac-app")
fi

run_service "agents" bash -c 'set -eo pipefail; cd agents && source venv/bin/activate && HEALTH_CHECK_PORT=$HEALTH_PORT SDK_METRICS_PORT=$SDK_METRICS_PORT ./scripts/run_local_worker.sh' &
PIDS+=($!); NAMES+=("agents")

run_service "research" bash -c 'set -eo pipefail; cd research && rm -f research-logs.log && ./run-local.sh 2>&1 | tee research-logs.log' &
PIDS+=($!); NAMES+=("research")

# Poll for failed children every second
while true; do
    if $SHUTTING_DOWN; then break; fi

    # Check if any process has died
    for i in "${!PIDS[@]}"; do
        pid="${PIDS[$i]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            # Process is gone — get its exit code
            wait "$pid" 2>/dev/null
            code=$?
            name="${NAMES[$i]}"
            if [ $code -ne 0 ]; then
                echo ""
                echo "❌ $name exited with code $code — shutting down all services."
                cleanup
                rm -rf "$FAIL_DIR"
                exit $code
            fi
            # Exited cleanly — remove from tracking
            unset "PIDS[$i]"
            unset "NAMES[$i]"
        fi
    done

    # If all children are gone, exit
    remaining=0
    for pid in "${PIDS[@]}"; do
        if [ -n "$pid" ]; then remaining=1; break; fi
    done
    if [ $remaining -eq 0 ]; then break; fi

    sleep 1
done

rm -rf "$FAIL_DIR"
