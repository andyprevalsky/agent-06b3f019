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

# Assign ports from a base port. Uses offsets 0-5 (5 services + 1 DB).
assign_ports() {
    local base=$1
    export BACKEND_PORT=$base
    export FRONTEND_PORT=$((base + 1))
    export HEALTH_PORT=$((base + 2))
    export MAC_APP_PORT=$((base + 3))
    export SDK_METRICS_PORT=$((base + 4))
    export LOCAL_DB_PORT=$((base + 5))
    export BACKEND_API_URL=http://localhost:$BACKEND_PORT
    export VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT
    export BACKEND_URL=http://localhost:$BACKEND_PORT
    export ALLOWED_ORIGINS=http://localhost:$FRONTEND_PORT,http://localhost:$MAC_APP_PORT
}

# Check if a port is held by a process from a DIFFERENT worktree (not stale from ours).
port_held_by_other_worktree() {
    local port=$1
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null) || true
    for pid in $pids; do
        local cmd
        cmd=$(ps -p "$pid" -o command= 2>/dev/null) || true
        # Docker daemon is a single process for all containers — check containers separately below
        echo "$cmd" | grep -qi docker && continue
        # Check if it belongs to a different worktree
        if echo "$cmd" | grep -q "conductor/workspaces" && ! echo "$cmd" | grep -q "$PWD"; then
            return 0  # yes, foreign process
        fi
    done
    # Check if a Docker container from a DIFFERENT workspace maps to this port
    local foreign_container
    foreign_container=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
        | grep ":${port}->" \
        | grep -vw "${CONDUCTOR_WORKSPACE_NAME}" \
        | head -1 | cut -f1)
    if [ -n "$foreign_container" ]; then
        return 0  # foreign Docker container on our port
    fi
    return 1  # no foreign process
}

# Try the Conductor-assigned port first
assign_ports "$CONDUCTOR_PORT"

# If any port in our range is held by another worktree, find a safe range
COLLISION=false
for port in $BACKEND_PORT $FRONTEND_PORT $HEALTH_PORT $MAC_APP_PORT $SDK_METRICS_PORT $LOCAL_DB_PORT; do
    if port_held_by_other_worktree "$port"; then
        COLLISION=true
        break
    fi
done

if $COLLISION; then
    echo "⚠️  Port range $CONDUCTOR_PORT collides with another workspace — scanning for free range..."
    # Scan upward in steps of 20 from the assigned port
    CANDIDATE=$((CONDUCTOR_PORT + 20))
    FOUND=false
    while [ $CANDIDATE -lt 65500 ]; do
        RANGE_FREE=true
        for offset in 0 1 2 3 4 5; do
            p=$((CANDIDATE + offset))
            if lsof -ti :"$p" >/dev/null 2>&1; then
                RANGE_FREE=false
                break
            fi
            # Also check Docker containers binding to this port
            if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${p}->"; then
                RANGE_FREE=false
                break
            fi
        done
        if $RANGE_FREE; then
            FOUND=true
            break
        fi
        CANDIDATE=$((CANDIDATE + 20))
    done
    if ! $FOUND; then
        echo "❌ Could not find a free port range. All ranges 55000-65500 occupied."
        exit 1
    fi
    assign_ports "$CANDIDATE"
    echo "✅ Reassigned to port range $CANDIDATE"
fi

export TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME
echo "🔌 Ports: backend=$BACKEND_PORT frontend=$FRONTEND_PORT health=$HEALTH_PORT mac-app=$MAC_APP_PORT metrics=$SDK_METRICS_PORT db=$LOCAL_DB_PORT queue=$TEMPORAL_TASK_QUEUE benchmark_mode=$BENCHMARK_MODE"

# ── Pre-flight: ensure Docker is running (Postgres container) ──
if ! docker ps &>/dev/null 2>&1; then
    if [ -d "/Applications/Docker.app" ]; then
        echo "🐳 Docker not running — starting Docker Desktop..."
        open -a Docker
        for i in $(seq 1 60); do
            if docker ps &>/dev/null 2>&1; then
                echo "🐳 Docker is ready"
                break
            fi
            if [ "$i" -eq 60 ]; then
                echo "⚠️  Docker did not start in 60s — local Postgres may fail"
            fi
            sleep 1
        done
    else
        echo "⚠️  Docker Desktop not installed — local Postgres may fail"
    fi
fi

# ── Pre-flight: start local Postgres for backend ──
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
export DATABASE_URL="$LOCAL_DB_URL"
export DIRECT_URL="$LOCAL_DB_URL"

# Helper: create (or recreate) the Postgres container with the correct port
create_db_container() {
    docker rm -f "$DB_CONTAINER" 2>/dev/null || true
    docker run -d \
        --name "$DB_CONTAINER" \
        -e POSTGRES_PASSWORD=postgres \
        -e POSTGRES_DB=victoria \
        -p "$LOCAL_DB_PORT:5432" \
        -v "$DB_VOLUME:/var/lib/postgresql/data" \
        postgres:16-alpine >/dev/null
}

DB_OWNED_BY_US=false  # Track whether we started/created the DB (cleanup only stops what we own)

if docker ps --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    # Running — check if port mapping matches
    ACTUAL_PORT=$(docker port "$DB_CONTAINER" 5432 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)
    if [ "$ACTUAL_PORT" = "$LOCAL_DB_PORT" ]; then
        echo "🐘 Local Postgres already running ($DB_CONTAINER on port $LOCAL_DB_PORT)"
    else
        echo "🐘 Postgres container on wrong port ($ACTUAL_PORT vs $LOCAL_DB_PORT) — recreating..."
        create_db_container
        DB_OWNED_BY_US=true
    fi
elif docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    # Stopped — check if port mapping matches before starting
    ACTUAL_PORT=$(docker inspect "$DB_CONTAINER" --format='{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' 2>/dev/null || true)
    if [ "$ACTUAL_PORT" = "$LOCAL_DB_PORT" ]; then
        echo "🐘 Starting stopped Postgres container..."
        docker start "$DB_CONTAINER" >/dev/null
        DB_OWNED_BY_US=true
    else
        echo "🐘 Stopped container on wrong port ($ACTUAL_PORT vs $LOCAL_DB_PORT) — recreating..."
        create_db_container
        DB_OWNED_BY_US=true
    fi
else
    echo "🐘 Creating local Postgres container..."
    create_db_container
    DB_OWNED_BY_US=true
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

# Pre-flight: handle processes on our ports from this worktree.
# - Healthy instance (has a live run.sh ancestor) → bail, already running
# - Orphan (parent dead / reparented to PID 1) → kill it, it's leftover from a crash
# - Unknown process (not from any worktree) → error out
KILLED_ANY=false
has_live_runsh_ancestor() {
    local pid=$1
    while true; do
        local ppid
        ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ') || return 1
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ] && return 1
        local pcmd
        pcmd=$(ps -p "$ppid" -o command= 2>/dev/null) || return 1
        echo "$pcmd" | grep -q "scripts/run.sh" && return 0
        pid=$ppid
    done
}
for port in $BACKEND_PORT $FRONTEND_PORT $HEALTH_PORT $MAC_APP_PORT $SDK_METRICS_PORT; do
    for pid in $(lsof -ti :"$port" 2>/dev/null); do
        cmd=$(ps -p "$pid" -o command= 2>/dev/null) || true
        echo "$cmd" | grep -qi docker && continue
        if echo "$cmd" | grep -q "$PWD"; then
            if has_live_runsh_ancestor "$pid"; then
                echo "✅ Services already running for this worktree (PID $pid on port $port). Exiting."
                exit 0
            fi
            echo "⚠️  Killing orphaned process on port $port (PID $pid)"
            kill -9 "$pid" 2>/dev/null || true
            KILLED_ANY=true
            continue
        fi
        echo "❌ Port $port in use by unknown process (PID $pid). Kill it manually or choose a different port range."
        exit 1
    done
done
# Also kill orphaned processes from this worktree on ANY port (covers port-reassignment case)
for pattern in \
    "$PWD/back-end/src/server.ts" \
    "$PWD/front-end.*vite" \
    "$PWD/mac-app/node_modules" \
    "$PWD/agents/scripts/run_local_worker"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        has_live_runsh_ancestor "$pid" && continue
        echo "⚠️  Killing orphaned process (PID $pid)"
        kill -9 "$pid" 2>/dev/null || true
        KILLED_ANY=true
    done
done
if $KILLED_ANY; then
    echo -n "   Waiting for ports to free..."
    sleep 2
    echo " done"
fi

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

# SIGTERM the tree, wait briefly, then SIGKILL any survivors
kill_tree_hard() {
    local pid=$1
    kill_tree "$pid"
    sleep 1
    # Kill any survivors that ignored SIGTERM
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill -9 "$child" 2>/dev/null || true
    done
    kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
    if $SHUTTING_DOWN; then return; fi
    SHUTTING_DOWN=true
    echo "🛑 Stopping all services... (triggered by: $(caller 0 2>/dev/null || echo 'EXIT trap'), DB_OWNED_BY_US=$DB_OWNED_BY_US)"
    # Kill only the process trees we spawned (SIGTERM then SIGKILL)
    for pid in "${PIDS[@]}"; do
        kill_tree_hard "$pid"
    done
    if $DB_OWNED_BY_US; then
        docker stop "$DB_CONTAINER" 2>/dev/null || true
    fi
    [ -n "$FAIL_DIR" ] && rm -rf "$FAIL_DIR"
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
if $BENCHMARK_MODE; then
    # In benchmark mode, use plain tsx (no watch) to prevent file-change restarts from killing the backend mid-run
    run_service "back-end" bash -c 'set -eo pipefail; cd back-end && rm -f backend-logs.log && PORT=$BACKEND_PORT npx tsx src/server.ts 2>&1 | tee backend-logs.log' &
else
    run_service "back-end" bash -c 'set -eo pipefail; cd back-end && rm -f backend-logs.log && PORT=$BACKEND_PORT npx tsx watch src/server.ts 2>&1 | tee backend-logs.log' &
fi
PIDS+=($!); NAMES+=("back-end")

if ! $BENCHMARK_MODE; then
    run_service "front-end" bash -c 'set -eo pipefail; cd front-end && rm -f frontend-logs.log && VITE_DEV_PORT=$FRONTEND_PORT npx vite 2>&1 | tee frontend-logs.log' &
    PIDS+=($!); NAMES+=("front-end")

    run_service "mac-app" bash -c 'set -eo pipefail; cd mac-app && source ~/.nvm/nvm.sh && nvm use 20.10.0 && rm -f mac-app-console-logs.log mac-app-ipc-logs.log && VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT npm run dev 2>&1 | tee mac-app-console-logs.log' &
    PIDS+=($!); NAMES+=("mac-app")
fi

run_service "agents" bash -c 'set -eo pipefail; cd agents && source venv/bin/activate && HEALTH_CHECK_PORT=$HEALTH_PORT SDK_METRICS_PORT=$SDK_METRICS_PORT ./scripts/run_local_worker.sh' &
PIDS+=($!); NAMES+=("agents")

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
                echo "❌ $name (PID $pid) exited with code $code — shutting down all services."
                # Log which services are still alive for traceability
                for j in "${!PIDS[@]}"; do
                    other_pid="${PIDS[$j]}"
                    other_name="${NAMES[$j]}"
                    if [ "$j" != "$i" ] && [ -n "$other_pid" ]; then
                        if kill -0 "$other_pid" 2>/dev/null; then
                            echo "   ├── $other_name (PID $other_pid): still running — will be killed"
                        else
                            wait "$other_pid" 2>/dev/null; other_code=$?
                            echo "   ├── $other_name (PID $other_pid): already dead (code $other_code)"
                        fi
                    fi
                done
                cleanup
                rm -rf "$FAIL_DIR"
                exit $code
            fi
            # Exited with code 0 — log it and remove from tracking
            echo "⚠️  $name (PID $pid) exited with code 0 (unexpected for a long-running service)"
            unset "PIDS[$i]"
            unset "NAMES[$i]"
        fi
    done

    # If all children are gone, exit
    remaining=0
    for pid in "${PIDS[@]}"; do
        if [ -n "$pid" ]; then remaining=1; break; fi
    done
    if [ $remaining -eq 0 ]; then
        echo "⚠️  All services exited (code 0) — nothing left to monitor. Shutting down."
        break
    fi

    sleep 1
done

rm -rf "$FAIL_DIR"
