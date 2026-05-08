#!/bin/bash
set -eo pipefail

# Set up local Postgres and sync production data.
# Called once during Conductor workspace setup (conductor.json → setup).
# run.sh handles starting the container + schema push on subsequent runs.

if [ -z "$CONDUCTOR_PORT" ]; then
  echo '❌ CONDUCTOR_PORT not set. Run via Conductor.'
  exit 1
fi

export LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"

# Ensure Docker is running
if ! docker ps &>/dev/null 2>&1; then
    if [ -d "/Applications/Docker.app" ]; then
        echo "🐳 Docker not running — starting Docker Desktop..."
        open -a Docker
        for i in $(seq 1 60); do
            docker ps &>/dev/null 2>&1 && break
            [ "$i" -eq 60 ] && { echo "❌ Docker did not start in 60s"; exit 1; }
            sleep 1
        done
    else
        echo "❌ Docker Desktop not installed"
        exit 1
    fi
fi

# Create Postgres container (recreate if port mapping drifted)
if docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    EXISTING_PORT=$(docker port "$DB_CONTAINER" 5432/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}')
    if [ "$EXISTING_PORT" != "$LOCAL_DB_PORT" ]; then
        echo "🐘 Postgres container port drift ($EXISTING_PORT → $LOCAL_DB_PORT), recreating..."
        docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
        docker run -d \
            --name "$DB_CONTAINER" \
            -e POSTGRES_PASSWORD=postgres \
            -e POSTGRES_DB=victoria \
            -p "$LOCAL_DB_PORT:5432" \
            -v "$DB_VOLUME:/var/lib/postgresql/data" \
            postgres:16-alpine >/dev/null
    else
        echo "🐘 Postgres container exists, starting..."
        docker start "$DB_CONTAINER" >/dev/null 2>&1 || true
    fi
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

# Wait for Postgres
echo -n "   Waiting for Postgres..."
for i in $(seq 1 30); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
        echo " ready (${i}s)"
        break
    fi
    [ "$i" -eq 30 ] && { echo " ❌ timed out"; exit 1; }
    sleep 1
done

# Reset local schema, push schema, then sync data. This must be a true reset,
# not an upsert-only refresh, so removed/disabled remote rows disappear locally.
echo "🧹 Resetting local database..."
docker exec "$DB_CONTAINER" psql -U postgres -d victoria \
    -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
    -c 'GRANT ALL ON SCHEMA public TO postgres;' \
    -c 'GRANT ALL ON SCHEMA public TO public;' >/dev/null

echo "🐘 Syncing Prisma schema..."
(cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3)

echo "🌱 Syncing production data to local database..."
(cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" npx tsx scripts/seed-local.ts)

echo "🐘 Local database setup complete."
