#!/usr/bin/env bash

configure_deploy_local_env() {
  if [ -z "${CONDUCTOR_PORT:-}" ]; then
    echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
    return 1
  fi
  # run.sh reserves through base + 9 for the ngrok inspector.
  if ! [[ "$CONDUCTOR_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$CONDUCTOR_PORT > 65526 )); then
    echo "CONDUCTOR_PORT must be a decimal integer between 1 and 65526." >&2
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
  # Deploy gates address the stack through these exact URLs. Fail on a
  # collision instead of letting run.sh silently move to a different range.
  export RUN_SH_STRICT_CONDUCTOR_PORT=1
  export SEMANTIC_QUEUE_WORKSPACE="${CONDUCTOR_WORKSPACE_NAME:-local}"
  export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${SEMANTIC_QUEUE_WORKSPACE}-deploy-$(date -u +%Y%m%d%H%M%S)-$$"
  export DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
  export DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME:-local}"
  # Docker stacks publish Postgres on conductor+5. Cloud/system Postgres is
  # always localhost:5432 — advertising +5 there makes semantic take-control
  # seed a port nothing is listening on ("Can't reach database server at
  # localhost:3006") while the backend already reads victoria on 5432.
  if [ "${ROSE_USE_SYSTEM_PG:-false}" = "true" ]; then
    export LOCAL_DB_PORT=5432
  else
    export LOCAL_DB_PORT=$((conductor_port + 5))
  fi
}
