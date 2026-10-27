#!/bin/bash
set -eo pipefail

# Set up local Postgres and sync production data.
# Called once during Conductor workspace setup (conductor.json → setup).
# run.sh handles starting the container + schema push on subsequent runs.
#
# Cloud / Linux VMs where Docker overlay mounts fail must set
# ROSE_USE_SYSTEM_PG=true (or rely on the automatic fallback below) so /sync
# and isolated local benchmarks can use system PostgreSQL on localhost:5432.

if [ -z "$CONDUCTOR_PORT" ]; then
  echo '❌ CONDUCTOR_PORT not set. Run via Conductor.'
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/lib/workspace-env.sh"
. "$SCRIPT_DIR/lib/workspace-db-lock.sh"
. "$SCRIPT_DIR/lib/local-pg-image.sh"
normalize_conductor_workspace_env

export LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
USE_SYSTEM_PG=false
SEED_DUMP_SOURCE="$DB_CONTAINER"
# The database this run resets. A Docker workspace owns its whole container, so
# `victoria` inside it is private. System Postgres is one server shared by every
# workspace on the host: resolve this workspace's own database there instead.
LOCAL_DB_NAME=victoria

use_system_postgres() {
    USE_SYSTEM_PG=true
    LOCAL_DB_PORT=5432
    LOCAL_DB_NAME="$(workspace_system_pg_db_name "$REPO_ROOT")" || exit 1
    LOCAL_DB_URL="postgresql://postgres:postgres@localhost:5432/$LOCAL_DB_NAME"
    SEED_DUMP_SOURCE="system"
    DB_CONTAINER=""
    echo "🐘 Using system Postgres database $LOCAL_DB_NAME on localhost:5432 (ROSE_USE_SYSTEM_PG)"
}

start_system_postgres() {
    if pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
        echo "🐘 System Postgres already running on port 5432"
        return 0
    fi
    echo "🐘 Starting system Postgres..."
    if command -v pg_lsclusters >/dev/null 2>&1; then
        PG_VER=$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')
        if [ -n "$PG_VER" ]; then
            sudo pg_ctlcluster "$PG_VER" main start 2>/dev/null || sudo service postgresql start 2>/dev/null || true
        else
            sudo service postgresql start 2>/dev/null || true
        fi
    else
        sudo service postgresql start 2>/dev/null || true
    fi
    echo -n "   Waiting for Postgres..."
    for i in $(seq 1 30); do
        if pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
            echo " ready (${i}s)"
            return 0
        fi
        [ "$i" -eq 30 ] && { echo " ❌ timed out"; return 1; }
        sleep 1
    done
}

create_docker_postgres() {
    # Ensure Docker is running
    if ! docker ps &>/dev/null 2>&1; then
        if [ -d "/Applications/Docker.app" ]; then
            echo "🐳 Docker not running — starting Docker Desktop..."
            open -a Docker
            for i in $(seq 1 60); do
                docker ps &>/dev/null 2>&1 && break
                [ "$i" -eq 60 ] && { echo "❌ Docker did not start in 60s"; return 1; }
                sleep 1
            done
        else
            echo "❌ Docker Desktop not installed"
            return 1
        fi
    fi

    # A port owned by another workspace is a configuration error. Detect it
    # before stale-image migration removes this workspace's existing container
    # and volume; a system-Postgres fallback must never hide this collision.
    CONFLICT_OWNER="$(db_port_conflict_owner "$DB_CONTAINER" "$LOCAL_DB_PORT" "$(docker ps --format '{{.Names}} {{.Ports}}')")"
    if [ -n "$CONFLICT_OWNER" ]; then
        echo "❌ Target DB port $LOCAL_DB_PORT is already bound by container '$CONFLICT_OWNER' (a different workspace)." >&2
        echo "   Refusing to change '$DB_CONTAINER' or fall back to shared system Postgres." >&2
        echo "   Re-run from this workspace's own Conductor shell, or export its correct CONDUCTOR_PORT." >&2
        return 42
    fi

    # Create Postgres container (recreate if port mapping drifted)
    recreate_if_stale_pg_image "$DB_CONTAINER" "$DB_VOLUME"
    if docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
        EXISTING_PORT=$(docker port "$DB_CONTAINER" 5432/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true)
        if [ "$EXISTING_PORT" != "$LOCAL_DB_PORT" ]; then
            # Never destroy the working container to bind a port another workspace's
            # container already owns. A foreign CONDUCTOR_PORT (leaked from a
            # /descend or benchmark shell whose CONDUCTOR_WORKSPACE_NAME was
            # normalized away above) derives the wrong LOCAL_DB_PORT; recreating
            # would clobber a sibling workspace's DB and then fail to bind, leaving
            # THIS workspace with no database. Abort loudly instead.
            CONFLICT_OWNER="$(db_port_conflict_owner "$DB_CONTAINER" "$LOCAL_DB_PORT" "$(docker ps --format '{{.Names}} {{.Ports}}')")"
            if [ -n "$CONFLICT_OWNER" ]; then
                echo "❌ Target DB port $LOCAL_DB_PORT is already bound by container '$CONFLICT_OWNER' (a different workspace)." >&2
                echo "   Refusing to recreate '$DB_CONTAINER': that would clobber another workspace's DB and leave this one without one." >&2
                echo "   Likely cause: a foreign CONDUCTOR_PORT ($CONDUCTOR_PORT) leaked into this shell. Re-run from this workspace's own Conductor shell, or export its correct CONDUCTOR_PORT." >&2
                return 1
            fi
            echo "🐘 Postgres container port drift ($EXISTING_PORT → $LOCAL_DB_PORT), recreating..."
            docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
            if ! docker run -d \
                --name "$DB_CONTAINER" \
                -e POSTGRES_PASSWORD=postgres \
                -e POSTGRES_DB=victoria \
                -p "$LOCAL_DB_PORT:5432" \
                -v "$DB_VOLUME:/var/lib/postgresql/data" \
                "$LOCAL_PG_IMAGE" >/dev/null; then
                return 1
            fi
        else
            echo "🐘 Postgres container exists, starting..."
            docker start "$DB_CONTAINER" >/dev/null 2>&1 || true
        fi
    else
        # Same conflict check as the recreate path above. On a fresh workspace whose
        # derived LOCAL_DB_PORT is already bound by a sibling workspace's container,
        # `docker run` otherwise fails with a raw "port is already allocated" daemon
        # error naming neither the owner nor the fix.
        CONFLICT_OWNER="$(db_port_conflict_owner "$DB_CONTAINER" "$LOCAL_DB_PORT" "$(docker ps --format '{{.Names}} {{.Ports}}')")"
        if [ -n "$CONFLICT_OWNER" ]; then
            echo "❌ Target DB port $LOCAL_DB_PORT is already bound by container '$CONFLICT_OWNER' (a different workspace)." >&2
            echo "   Cannot create '$DB_CONTAINER' on a port another workspace already owns." >&2
            echo "   Likely cause: a foreign CONDUCTOR_PORT ($CONDUCTOR_PORT) leaked into this shell, or two workspaces derived colliding ports." >&2
            echo "   Fix: re-run from this workspace's own Conductor shell, or export a CONDUCTOR_PORT whose +5 is free." >&2
            return 1
        fi
        echo "🐘 Creating local Postgres container..."
        if ! docker run -d \
            --name "$DB_CONTAINER" \
            -e POSTGRES_PASSWORD=postgres \
            -e POSTGRES_DB=victoria \
            -p "$LOCAL_DB_PORT:5432" \
            -v "$DB_VOLUME:/var/lib/postgresql/data" \
            "$LOCAL_PG_IMAGE" >/dev/null; then
            return 1
        fi
    fi

    # Wait for Postgres
    echo -n "   Waiting for Postgres..."
    for i in $(seq 1 30); do
        if docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
            echo " ready (${i}s)"
            break
        fi
        [ "$i" -eq 30 ] && { echo " ❌ timed out"; return 1; }
        sleep 1
    done

    # A retained workspace volume may predate POSTGRES_DB=victoria. The image only
    # applies POSTGRES_DB when initializing an empty volume, so ensure the database
    # exists before resetting its schema.
    if ! docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = 'victoria'" | grep -q '^1$'; then
        echo "🐘 Creating missing victoria database..."
        docker exec "$DB_CONTAINER" createdb -U postgres victoria
    fi
    return 0
}

if [ "${ROSE_USE_SYSTEM_PG:-false}" = "true" ]; then
    use_system_postgres
    start_system_postgres
elif create_docker_postgres; then
    :
else
    DOCKER_SETUP_STATUS=$?
    if [ "$DOCKER_SETUP_STATUS" -eq 42 ]; then
        exit "$DOCKER_SETUP_STATUS"
    fi
    if [ "$(uname -s)" != Linux ]; then
        echo "❌ Owned Docker Postgres is unavailable; refusing automatic shared-system-Postgres setup on this platform." >&2
        exit 1
    fi
    # Cloud VMs often have a Docker daemon that cannot overlay-mount images.
    # Fall back to the same system Postgres path run.sh already uses.
    echo "⚠️  Docker Postgres unavailable — falling back to system Postgres (set ROSE_USE_SYSTEM_PG=true to skip Docker)."
    # Clean up a half-created container name so a later Docker-capable host can retry.
    docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
    use_system_postgres
    start_system_postgres
fi

# Everything below rebuilds ONE database from scratch: it drops the public
# schema, re-pushes it, and streams prod data in. Two invocations against the
# same database are not rare — a fresh Conductor workspace runs this script as
# the tail of its `setup` hook while the first `/sync` runs it too — and
# unserialized they destroy each other's work mid-seed. Wait for the peer.
#
# The key must be the DATABASE actually being reset, not the workspace:
#   - Docker mode: each workspace owns its own container, so $DB_CONTAINER is
#     both the workspace identity and the database identity.
#   - System-PG mode: every workspace shares one server, so the key is the
#     resolved database (workspace_system_pg_db_name), never the container
#     name. Runs resolving the same database (e.g. the cloud identity's shared
#     `victoria`) contend on one key; distinct workspaces reset distinct
#     databases and need not wait for each other.
#
# Acquired after provisioning because that is where the mode is decided;
# provisioning itself only creates/starts a server, it does not touch data.
if $USE_SYSTEM_PG; then
    acquire_workspace_db_lock "system-pg:localhost:5432/$LOCAL_DB_NAME"
else
    acquire_workspace_db_lock "$DB_CONTAINER"
fi

# Releasing the lock is not enough on a signal: the destructive critical section
# below spawns long-lived children (`prisma db push`, `seed-local.ts`). Bash only
# signals the script, so a TERM'd setup-db released its lock and exited while its
# seed child kept writing prod rows into a database another process had just
# claimed — a "stopped" reset that silently corrupts a concurrent blackbox run.
# Stop every child before releasing the lock so stopping this script actually
# stops the destructive section. A child may handle/ignore TERM, so teardown has
# a bounded grace period followed by KILL. INT and TERM stay ignored throughout
# cleanup: a second Ctrl-C must not strand the lock or let a surviving child
# overlap the next reset.
setup_db_child_records() {
    local group="$1"
    if [ -n "$group" ] && [ "$group" = "$$" ]; then
        ps -axo pid=,ppid=,pgid=,stat=,lstart= 2>/dev/null | awk -v self="$$" -v group="$group" '
            $3 == group && $1 != self && $4 !~ /^Z/ {
                print $1 "|" $2 "|" $3 "|" $5 " " $6 " " $7 " " $8 " " $9
            }
        '
        return
    fi

    # setup-db normally shares its caller's process group, which must never be
    # signalled wholesale. Resolve the full descendant tree from one ps snapshot
    # instead; this includes wrappers such as npx plus the seed process beneath.
    ps -axo pid=,ppid=,pgid=,stat=,lstart= 2>/dev/null | awk -v root="$$" '
        {
            order[NR] = $1
            parent[$1] = $2
            group[$1] = $3
            state[$1] = $4
            started[$1] = $5 " " $6 " " $7 " " $8 " " $9
        }
        END {
            for (i = 1; i <= NR; i++) {
                candidate = order[i]
                if (candidate == root || state[candidate] ~ /^Z/) continue
                ancestor = parent[candidate]
                for (hops = 0; ancestor != "" && ancestor != 1 && hops < NR; hops++) {
                    if (ancestor == root) {
                        print candidate "|" parent[candidate] "|" group[candidate] "|" started[candidate]
                        break
                    }
                    ancestor = parent[ancestor]
                }
            }
        }
    '
}

setup_db_pid_matches_record() {
    local record="$1"
    local pid expected_parent expected_group expected_started
    local current current_state current_started
    IFS='|' read -r pid expected_parent expected_group expected_started <<< "$record"
    [ -n "$pid" ] && [ -n "$expected_parent" ] && [ -n "$expected_group" ] \
        && [ -n "$expected_started" ] || return 1
    current="$(ps -o stat=,lstart= -p "$pid" 2>/dev/null | awk '
        NR == 1 { print $1 "|" $2 " " $3 " " $4 " " $5 " " $6 }
    ')"
    [ -n "$current" ] || return 1
    IFS='|' read -r current_state current_started <<< "$current"
    [[ "$current_state" != Z* ]] || return 1
    # Parent and process-group IDs prove ownership when the descendant record is
    # first discovered, but neither remains stable: a retained child can call
    # setsid and then be reparented after its wrapper exits. PID plus start time
    # identifies the captured process incarnation across both transitions while
    # still refusing a recycled PID before TERM or KILL.
    [ "$current_started" = "$expected_started" ]
}

setup_db_pid_is_running() {
    local state
    state="$(ps -o stat= -p "$1" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    [ -n "$state" ] && [[ "$state" != Z* ]]
}

setup_db_remember_records() {
    local records="$1"
    local record remembered_pid
    while IFS= read -r record; do
        [ -n "$record" ] || continue
        case $'\n'"$targets"$'\n' in
            *$'\n'"$record"$'\n'*) ;;
            *) targets="${targets}${targets:+$'\n'}${record}" ;;
        esac
        remembered_pid="${record%%|*}"
        case " $reap_pids " in
            *" $remembered_pid "*) ;;
            *) reap_pids="$reap_pids $remembered_pid" ;;
        esac
    done <<< "$records"
}

setup_db_term_records() {
    local records="$1"
    local record pid
    while IFS= read -r record; do
        [ -n "$record" ] || continue
        setup_db_pid_matches_record "$record" || continue
        pid="${record%%|*}"
        kill -TERM "$pid" 2>/dev/null || true
    done <<< "$records"
}

SETUP_DB_TEARDOWN_SIGNAL=""

setup_db_signal_teardown() {
    # First signal wins once masked. Callers register traps as
    # `trap 'trap "" INT TERM; setup_db_signal_teardown N' SIG` so a second
    # signal cannot overwrite TERM→143 with INT→130 mid-handler.
    if [ -z "$SETUP_DB_TEARDOWN_SIGNAL" ]; then
        SETUP_DB_TEARDOWN_SIGNAL="$1"
    fi
    setup_db_teardown
}

setup_db_teardown() {
    local exit_code=$?
    local group targets current record pid reap_pids any_running
    local grace="${SETUP_DB_TEARDOWN_GRACE_SECONDS:-10}"
    local grace_started force_started

    # Remove the recursive EXIT handler, but keep both interactive termination
    # signals masked until descendants are gone and the lock is released.
    trap '' INT TERM
    trap - EXIT
    if [ -n "$SETUP_DB_TEARDOWN_SIGNAL" ]; then
        exit_code=$((128 + SETUP_DB_TEARDOWN_SIGNAL))
    fi
    case "$grace" in
        ''|*[!0-9]*) grace=10 ;;
    esac

    group="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
    targets=""
    reap_pids=""
    # Prefer the known interruptible child — process-group scans can miss a
    # just-orphaned TERM-resistant seed while the shell is mid-signal teardown.
    if [ -n "$SETUP_DB_INTERRUPTIBLE_PID" ]; then
        setup_db_remember_records "$(setup_db_child_records "$group")"
        if setup_db_pid_is_running "$SETUP_DB_INTERRUPTIBLE_PID"; then
            case " $reap_pids " in
                *" $SETUP_DB_INTERRUPTIBLE_PID "*) ;;
                *) reap_pids="$reap_pids $SETUP_DB_INTERRUPTIBLE_PID" ;;
            esac
        fi
    fi
    current="$(setup_db_child_records "$group")"
    setup_db_remember_records "$current"
    if [ -n "$group" ] && [ "$group" = "$$" ]; then
        # This shell ignores TERM above, so signalling its private group safely
        # reaches every current descendant and any child spawned during cleanup.
        kill -TERM -"$group" 2>/dev/null || true
    else
        setup_db_term_records "$targets"
    fi

    grace_started=$SECONDS
    while [ $((SECONDS - grace_started)) -lt "$grace" ]; do
        current="$(setup_db_child_records "$group")"
        setup_db_remember_records "$current"
        if [ -n "$group" ] && [ "$group" = "$$" ]; then
            # Re-signal the private group so children spawned during teardown get
            # the same graceful window as the descendants found initially.
            kill -TERM -"$group" 2>/dev/null || true
        else
            # A TERM-resistant wrapper can fork after the initial snapshot. Give
            # each newly discovered descendant TERM now instead of remembering it
            # only to jump straight to KILL after the grace window.
            setup_db_term_records "$current"
        fi
        any_running=false
        while IFS= read -r record; do
            [ -n "$record" ] || continue
            if setup_db_pid_matches_record "$record"; then
                any_running=true
                break
            fi
        done <<< "$targets"
        $any_running || break
        sleep 0.1
    done

    # Re-scan immediately before escalation so late descendants are included.
    current="$(setup_db_child_records "$group")"
    setup_db_remember_records "$current"
    while IFS= read -r record; do
        [ -n "$record" ] || continue
        setup_db_pid_matches_record "$record" || continue
        pid="${record%%|*}"
        kill -KILL "$pid" 2>/dev/null || true
    done <<< "$targets"

    # Give KILL a short bounded window to take effect. Zombies do not write and
    # are excluded by setup_db_pid_is_running; reap direct children below.
    force_started=$SECONDS
    while [ $((SECONDS - force_started)) -lt 2 ]; do
        # A TERM-resistant wrapper can fork after the first escalation scan. Keep
        # discovering and force-stopping late descendants until the whole tree is
        # gone, otherwise the lock can be released while that new child still
        # writes into the database.
        current="$(setup_db_child_records "$group")"
        setup_db_remember_records "$current"
        any_running=false
        while IFS= read -r record; do
            [ -n "$record" ] || continue
            if setup_db_pid_matches_record "$record"; then
                any_running=true
                pid="${record%%|*}"
                kill -KILL "$pid" 2>/dev/null || true
            fi
        done <<< "$targets"
        $any_running || break
        sleep 0.1
    done
    for pid in $reap_pids; do
        setup_db_pid_is_running "$pid" || wait "$pid" 2>/dev/null || true
    done

    # Keep the bounded teardown guarantee, but never release the destructive DB
    # lock silently if an uninterruptible descendant survives SIGKILL.
    current="$(setup_db_child_records "$group")"
    setup_db_remember_records "$current"
    while IFS= read -r record; do
        [ -n "$record" ] || continue
        setup_db_pid_matches_record "$record" || continue
        pid="${record%%|*}"
        echo "⚠️  setup-db descendant PID $pid survived SIGKILL; releasing DB lock" >&2
    done <<< "$targets"

    release_workspace_db_lock
    # Keep INT/TERM ignored through exit. Restoring the default disposition here
    # lets a queued second Ctrl-C (case 6 sends INT 100ms after TERM) fire with
    # the default handler and overwrite cooperative 143 with 130.
    exit "$exit_code"
}
trap setup_db_teardown EXIT
trap 'trap "" INT TERM; setup_db_signal_teardown 2' INT
trap 'trap "" INT TERM; setup_db_signal_teardown 15' TERM

# Reset local schema, push schema, then sync data. This must be a true reset,
# not an upsert-only refresh, so removed/disabled remote rows disappear locally.
echo "🧹 Resetting local database..."
if $USE_SYSTEM_PG; then
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '$LOCAL_DB_NAME'" | grep -q '^1$' \
        || PGPASSWORD=postgres createdb -h localhost -p 5432 -U postgres "$LOCAL_DB_NAME"
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d "$LOCAL_DB_NAME" \
        -v ON_ERROR_STOP=1 \
        -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
        -c 'GRANT ALL ON SCHEMA public TO postgres;' \
        -c 'GRANT ALL ON SCHEMA public TO public;' >/dev/null
else
    docker exec "$DB_CONTAINER" psql -U postgres -d victoria \
        -v ON_ERROR_STOP=1 \
        -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
        -c 'GRANT ALL ON SCHEMA public TO postgres;' \
        -c 'GRANT ALL ON SCHEMA public TO public;' >/dev/null
fi

# Run a long critical-section command so INT/TERM traps can fire mid-flight.
# A foreground child keeps bash from delivering TERM until that child exits, so a
# TERM'd setup-db never tore down an in-flight seed — only a later INT interrupted
# (exit 130). `wait` also defers traps until the job completes on some bash builds,
# which returned 143 via set -e without running teardown (orphaning TERM-resistant
# seed children). Poll with sleep so traps run, then reap descendants before exit.
SETUP_DB_INTERRUPTIBLE_PID=""
setup_db_run_interruptible() {
    "$@" &
    SETUP_DB_INTERRUPTIBLE_PID=$!
    local pid="$SETUP_DB_INTERRUPTIBLE_PID"
    while kill -0 "$pid" 2>/dev/null; do
        sleep 0.05
    done
    wait "$pid" 2>/dev/null || return $?
    SETUP_DB_INTERRUPTIBLE_PID=""
    return 0
}

echo "🐘 Syncing Prisma schema..."
# Duplicate or blank User.phone rows (a restored DB can carry a later-merged
# account) would make push refuse the unique User.phone index.
setup_db_run_interruptible bash -c \
    'cd back-end && bash scripts/normalize-local-user-phones.sh "$0" >/dev/null' \
    "$LOCAL_DB_URL"
setup_db_run_interruptible bash -c \
    'cd back-end && DATABASE_URL="$0" DIRECT_URL="$0" PRISMA_CLI_DATABASE_URL="$0" npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3' \
    "$LOCAL_DB_URL"
if $USE_SYSTEM_PG; then
    setup_db_run_interruptible bash -c \
        'cd back-end && DATABASE_URL="$0" DIRECT_URL="$0" LOCAL_DB_NAME="$1" bash scripts/apply-local-workflow-ddl.sh' \
        "$LOCAL_DB_URL" "$LOCAL_DB_NAME"
else
    setup_db_run_interruptible bash -c \
        'cd back-end && DATABASE_URL="$0" DIRECT_URL="$0" DB_CONTAINER="$1" LOCAL_DB_NAME=victoria bash scripts/apply-local-workflow-ddl.sh' \
        "$LOCAL_DB_URL" "$DB_CONTAINER"
fi
setup_db_run_interruptible bash -c \
    'cd back-end && DATABASE_URL="$0" DIRECT_URL="$0" npx tsx scripts/ensure-agent-network-grep-indexes.ts' \
    "$LOCAL_DB_URL"

echo "🌱 Syncing production data to local database..."
setup_db_run_interruptible bash -c \
    'cd back-end && DATABASE_URL="$0" DIRECT_URL="$0" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=96" npx tsx scripts/seed-local.ts' \
    "$LOCAL_DB_URL"

echo "🗜️  Publishing synchronized DB for isolated local benchmarks..."
BENCHMARK_SEED_PATH="$(
    bash "$SCRIPT_DIR/benchmark-seed-cache" materialize \
        "$REPO_ROOT/back-end/prisma/schema.prisma" \
        "$REPO_ROOT/.context/benchmarks/seed-cache" \
        "$SEED_DUMP_SOURCE" \
        "" \
        "$LOCAL_DB_NAME"
)"
echo "   ✅ Local benchmark seed dump: $BENCHMARK_SEED_PATH"

echo "🐘 Local database setup complete."
