#!/usr/bin/env bash

configure_deploy_local_env() {
  if [ -z "${CONDUCTOR_PORT:-}" ]; then
    echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
    return 1
  fi
  if ! [[ "$CONDUCTOR_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$CONDUCTOR_PORT > 65530 )); then
    echo "CONDUCTOR_PORT must be a decimal integer between 1 and 65530." >&2
    return 1
  fi
  if ! command -v normalize_conductor_workspace_env >/dev/null 2>&1; then
    echo "workspace-env.sh must be sourced before deploy-local-env.sh." >&2
    return 1
  fi

  normalize_conductor_workspace_env
  local conductor_port=$((10#$CONDUCTOR_PORT))
  export SMOKE_BASE_URL="http://localhost:$conductor_port"
  export SMOKE_HEALTH_URL="http://localhost:$((conductor_port + 2))"
  export SMOKE_FRONTEND_URL="http://localhost:$((conductor_port + 1))"
  export SEMANTIC_QUEUE_WORKSPACE="${CONDUCTOR_WORKSPACE_NAME:-local}"
  export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${SEMANTIC_QUEUE_WORKSPACE}-deploy-$(date -u +%Y%m%d%H%M%S)-$$"
  export DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
  export DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME:-local}"
  export LOCAL_DB_PORT=$((conductor_port + 5))
}
