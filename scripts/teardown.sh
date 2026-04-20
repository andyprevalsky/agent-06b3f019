#!/bin/bash
# Tear down all resources for a worktree/workspace.
# Usage: scripts/teardown.sh [WORKSPACE_NAME]
# If no name given, derives from CONDUCTOR_WORKSPACE_NAME or directory basename.

set -eo pipefail

WORKSPACE="${1:-${CONDUCTOR_WORKSPACE_NAME:-$(basename "$PWD")}}"
WORKTREE_DIR="$PWD"

echo "🧹 Tearing down workspace: $WORKSPACE (dir: $WORKTREE_DIR)"

# 1. Kill host processes from this worktree
echo "   Killing processes..."
KILLED=false
for pattern in \
    "$WORKTREE_DIR/back-end/src/server.ts" \
    "$WORKTREE_DIR/front-end.*vite" \
    "$WORKTREE_DIR/mac-app/node_modules" \
    "$WORKTREE_DIR/agents/scripts/run_local_worker" \
    "scripts/run.sh.*$WORKTREE_DIR"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        echo "     PID $pid"
        kill -9 "$pid" 2>/dev/null || true
        KILLED=true
    done
done
$KILLED && echo "   Done" || echo "   None found"

# 2. Stop and remove Postgres container
DB_CONTAINER="victoria-db-${WORKSPACE}"
DB_VOLUME="victoria-pgdata-${WORKSPACE}"

if docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    echo "   Removing Postgres container ($DB_CONTAINER)..."
    docker rm -f "$DB_CONTAINER" 2>/dev/null || true
fi

# 3. Remove Postgres volume
if docker volume ls --filter "name=^${DB_VOLUME}$" --format '{{.Name}}' 2>/dev/null | grep -q .; then
    echo "   Removing Postgres volume ($DB_VOLUME)..."
    docker volume rm "$DB_VOLUME" 2>/dev/null || true
fi

# 4. Clean log files
echo "   Cleaning log files..."
rm -f "$WORKTREE_DIR/back-end/backend-logs.log"
rm -f "$WORKTREE_DIR/front-end/frontend-logs.log"
rm -f "$WORKTREE_DIR/mac-app/mac-app-console-logs.log"
rm -f "$WORKTREE_DIR/mac-app/mac-app-ipc-logs.log"
rm -f "$WORKTREE_DIR/agents/navi-worker-log.txt"
rm -f "$WORKTREE_DIR/docs/docs-logs.log"

echo "✅ Workspace $WORKSPACE fully torn down"
