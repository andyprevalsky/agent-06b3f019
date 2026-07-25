#!/usr/bin/env bash

normalize_conductor_workspace_env() {
  local pwd_physical workspace_physical actual_name deploy_worktree_env

  # Cloud builds intentionally generate a stable synthetic workspace name in
  # .cloud-env; do not replace it with the checkout directory basename.
  if [ -f ".cloud-env" ] && grep -q '^# rose-cloud-env$' ".cloud-env" 2>/dev/null; then
    return 0
  fi

  pwd_physical="$(cd "$PWD" && pwd -P)"
  deploy_worktree_env="$pwd_physical/.context/deploy-worktree.env"
  if [ -f "$deploy_worktree_env" ] && [ "${BENCHMARK_ISOLATED_RUN:-false}" != "true" ]; then
    # /descend-created deploy worktrees are not registered with Conductor and
    # otherwise inherit their controller's identity and port range. Rehydrate
    # the durable child identity on every new shell before resolving resources.
    # A nested benchmark run already owns a separately reserved identity and
    # port range; rehydrating the parent here would collapse both stacks onto
    # the deploy database.
    . "$deploy_worktree_env"
    if [ "${ROSE_DEPLOY_WORKTREE_PATH:-}" != "$pwd_physical" ]; then
      echo "Deploy worktree config belongs to ${ROSE_DEPLOY_WORKTREE_PATH:-unknown}, not $pwd_physical." >&2
      return 1
    fi
    export CONDUCTOR_WORKSPACE_PATH="$pwd_physical"
    export CONDUCTOR_WORKSPACE_NAME
    export CONDUCTOR_PORT
  fi

  if [ -n "${CONDUCTOR_WORKSPACE_PATH:-}" ] && [ -d "$CONDUCTOR_WORKSPACE_PATH" ]; then
    workspace_physical="$(cd "$CONDUCTOR_WORKSPACE_PATH" && pwd -P)"
  else
    workspace_physical="$pwd_physical"
  fi

  if [ "$workspace_physical" != "$pwd_physical" ]; then
    if [ -z "${CONDUCTOR_WORKSPACE_NAME:-}" ]; then
      export CONDUCTOR_WORKSPACE_NAME
      CONDUCTOR_WORKSPACE_NAME="$(basename "$pwd_physical")"
    fi
    return 0
  fi

  actual_name="$(basename "$workspace_physical")"
  if [ -z "${CONDUCTOR_WORKSPACE_NAME:-}" ]; then
    export CONDUCTOR_WORKSPACE_NAME="$actual_name"
    export CONDUCTOR_WORKSPACE_PATH="$workspace_physical"
    return 0
  fi

  if [ "$CONDUCTOR_WORKSPACE_NAME" != "$actual_name" ] && [ "${ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME:-}" != "1" ]; then
    echo "Warning: CONDUCTOR_WORKSPACE_NAME=$CONDUCTOR_WORKSPACE_NAME does not match workspace path $workspace_physical; using $actual_name for local resources."
    export CONDUCTOR_WORKSPACE_NAME="$actual_name"
  fi
  export CONDUCTOR_WORKSPACE_PATH="$workspace_physical"
}

resolve_temporal_task_queue() {
  local workspace_name="$1"
  printf '%s\n' "${TEMPORAL_TASK_QUEUE:-navi-agent-tasks-$workspace_name}"
}
