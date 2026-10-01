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

# VMs booted from one snapshot share /etc/machine-id and any baked .cloud-env,
# so a synthetic cloud identity must be keyed to the running instance: the
# sandbox pod named in the cgroup path when present, plus this boot.
cloud_instance_id() {
  local cgroup_file="${1:-/proc/self/cgroup}"
  local boot_id_file="${2:-/proc/sys/kernel/random/boot_id}"
  local pod boot
  pod="$(grep -oE 'pod-[A-Za-z0-9-]+' "$cgroup_file" 2>/dev/null | head -1 || true)"
  boot="$(cat "$boot_id_file" 2>/dev/null || true)"
  [ -n "$pod$boot" ] || return 1
  printf '%s|%s' "$pod" "$boot" | sha256sum | cut -c1-8
}

cloud_env_is_current() {
  local cloud_env="$1" instance_id="$2"
  [ -f "$cloud_env" ] || return 1
  [ -n "$instance_id" ] || return 0
  grep -qx "export ROSE_CLOUD_INSTANCE_ID=$instance_id" "$cloud_env"
}

resolve_temporal_task_queue() {
  local workspace_name="$1"
  printf '%s\n' "${TEMPORAL_TASK_QUEUE:-navi-agent-tasks-$workspace_name}"
}

# Given the intended local DB container name, its target host port, and the
# output of `docker ps --format '{{.Names}} {{.Ports}}'`, print the name of a
# DIFFERENT running container that already binds that host port (empty if none).
#
# This guards against a foreign CONDUCTOR_PORT (e.g. one leaked into a shell by
# a /descend or benchmark run whose mismatched CONDUCTOR_WORKSPACE_NAME was
# normalized away here) deriving the wrong LOCAL_DB_PORT and clobbering a
# sibling workspace's database. Only running containers actually bind the host
# port, so `docker ps` (not `-a`) is the correct input.
db_port_conflict_owner() {
  local self="$1" port="$2" ps_output="$3"
  printf '%s\n' "$ps_output" | awk -v self="$self" -v pat=":${port}->" '
    index($0, pat) { if ($1 != self) { print $1; exit } }
  '
}
