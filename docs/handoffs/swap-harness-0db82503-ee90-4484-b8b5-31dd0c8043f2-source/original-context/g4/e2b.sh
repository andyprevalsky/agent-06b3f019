#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
. scripts/lib/workspace-env.sh
normalize_conductor_workspace_env
STACK_PORTS=$(bash scripts/resolve-deploy-stack-db.sh) || { echo "exit=1 resolve-failed" > .context/g4/e2b.log; exit 1; }
read -r CONDUCTOR_PORT SMOKE_DB_PORT <<< "$STACK_PORTS"
export CONDUCTOR_PORT
E2B_DB_NAME="victoria_$CONDUCTOR_WORKSPACE_NAME"
psql "postgresql://postgres:postgres@localhost:$SMOKE_DB_PORT/$E2B_DB_NAME" -At -c 'SELECT 1' >/dev/null 2>&1 || PGPASSWORD=postgres createdb -h localhost -p "$SMOKE_DB_PORT" -U postgres "$E2B_DB_NAME"
cd back-end && BLACKBOX_SMOKE=1 BLACKBOX_TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:$SMOKE_DB_PORT/$E2B_DB_NAME" \
  bash ../scripts/run-deploy-stage claude-code-e2b-smoke -- bash scripts/run-blackbox-tests.sh claude-code > ../.context/g4/e2b.log 2>&1; echo "exit=$?" >> ../.context/g4/e2b.log
