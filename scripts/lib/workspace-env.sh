#!/usr/bin/env bash

normalize_conductor_workspace_env() {
  local pwd_physical workspace_physical actual_name

  # Cloud builds intentionally generate a stable synthetic workspace name in
  # .cloud-env; do not replace it with the checkout directory basename.
  if [ -f ".cloud-env" ] && grep -q '^# rose-cloud-env$' ".cloud-env" 2>/dev/null; then
    return 0
  fi

  pwd_physical="$(cd "$PWD" && pwd -P)"
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
