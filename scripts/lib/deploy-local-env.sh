#!/usr/bin/env bash

configure_deploy_local_env() {
  if [ -z "${CONDUCTOR_PORT:-}" ]; then
    echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
    return 1
  fi
  if ! command -v normalize_conductor_workspace_env >/dev/null 2>&1; then
    echo "workspace-env.sh must be sourced before deploy-local-env.sh." >&2
    return 1
  fi

  normalize_conductor_workspace_env
  export SMOKE_BASE_URL="http://localhost:$CONDUCTOR_PORT"
  export SMOKE_HEALTH_URL="http://localhost:$((CONDUCTOR_PORT + 2))"
  export SMOKE_FRONTEND_URL="http://localhost:$((CONDUCTOR_PORT + 1))"
  export SEMANTIC_QUEUE_WORKSPACE="${CONDUCTOR_WORKSPACE_NAME:-local}"
  export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${SEMANTIC_QUEUE_WORKSPACE}-deploy-$(date -u +%Y%m%d%H%M%S)-$$"
  export DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
  export DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME:-local}"
  export LOCAL_DB_PORT=$((CONDUCTOR_PORT + 5))
}
