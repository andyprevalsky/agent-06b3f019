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
normalize_conductor_workspace_env

export LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
USE_SYSTEM_PG=false
SEED_DUMP_SOURCE="$DB_CONTAINER"

use_system_postgres() {
    USE_SYSTEM_PG=true
    LOCAL_DB_PORT=5432
    LOCAL_DB_URL="postgresql://postgres:postgres@localhost:5432/victoria"
    SEED_DUMP_SOURCE="system"
    DB_CONTAINER=""
    echo "🐘 Using system Postgres on localhost:5432 (ROSE_USE_SYSTEM_PG)"
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

    # Create Postgres container (recreate if port mapping drifted)
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
                postgres:16-alpine >/dev/null; then
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
            postgres:16-alpine >/dev/null; then
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
elif ! create_docker_postgres; then
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
#   - System-PG mode: EVERY workspace targets the one shared
#     localhost:5432/victoria. Keying on the per-workspace container name there
#     would give each concurrent run a different lock and serialize nothing,
#     which is precisely the wipe-each-other's-seed race this lock exists to
#     stop. They must contend on one shared key.
#
# Acquired after provisioning because that is where the mode is decided;
# provisioning itself only creates/starts a server, it does not touch data.
if $USE_SYSTEM_PG; then
    acquire_workspace_db_lock "system-pg:localhost:5432/victoria"
else
    acquire_workspace_db_lock "$DB_CONTAINER"
fi
trap release_workspace_db_lock EXIT

# Reset local schema, push schema, then sync data. This must be a true reset,
# not an upsert-only refresh, so removed/disabled remote rows disappear locally.
echo "🧹 Resetting local database..."
if $USE_SYSTEM_PG; then
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = 'victoria'" | grep -q '^1$' \
        || PGPASSWORD=postgres createdb -h localhost -p 5432 -U postgres victoria
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d victoria \
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

echo "🐘 Syncing Prisma schema..."
(cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3)
if $USE_SYSTEM_PG; then
    (cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        LOCAL_DB_NAME=victoria \
        bash scripts/apply-local-workflow-ddl.sh)
else
    (cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        DB_CONTAINER="$DB_CONTAINER" LOCAL_DB_NAME=victoria \
        bash scripts/apply-local-workflow-ddl.sh)
fi
(cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" npx tsx scripts/ensure-agent-network-grep-indexes.ts)

echo "🌱 Syncing production data to local database..."
(cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" npx tsx scripts/seed-local.ts)

echo "🗜️  Publishing synchronized DB for isolated local benchmarks..."
BENCHMARK_SEED_PATH="$(
    bash "$SCRIPT_DIR/benchmark-seed-cache" materialize \
        "$REPO_ROOT/back-end/prisma/schema.prisma" \
        "$REPO_ROOT/.context/benchmarks/seed-cache" \
        "$SEED_DUMP_SOURCE"
)"
echo "   ✅ Local benchmark seed dump: $BENCHMARK_SEED_PATH"

echo "🐘 Local database setup complete."
