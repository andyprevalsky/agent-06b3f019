#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_SRC="$ROOT_DIR/scripts/lib/workspace-env.sh"
DEPLOY_HELPER_SRC="$ROOT_DIR/scripts/lib/deploy-local-env.sh"
RUN_CONTEXT_SRC="$ROOT_DIR/scripts/lib/run-context.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Hermeticity: this suite sets the exact identity/trust inputs it asserts on
# inside each subshell. A deploy shell (or a /descend deploy worktree that has
# sourced .context/deploy-worktree.env) legitimately exports these same vars —
# most notably ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 — which would otherwise leak
# in and make normalize_conductor_workspace_env preserve a stale name that the
# untrusted-normalization assertions expect to be overridden. Clear them here so
# the test result never depends on the caller's ambient identity environment.
unset ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME \
  CONDUCTOR_WORKSPACE_NAME \
  CONDUCTOR_WORKSPACE_PATH \
  CONDUCTOR_PORT \
  BENCHMARK_ISOLATED_RUN \
  ROSE_DEPLOY_WORKTREE \
  ROSE_DEPLOY_WORKTREE_PATH \
  ROSE_DEPLOY_SOURCE_WORKSPACE \
  ROSE_USE_SYSTEM_PG \
  TEMPORAL_TASK_QUEUE 2>/dev/null || true

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label: got '$actual', expected '$expected'" >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_deploy_port_rejected() {
  local port="$1"
  local label="$2"
  local output
  local status
  set +e
  output="$(
    CONDUCTOR_PORT="$port" \
    CONDUCTOR_WORKSPACE_PATH="$workspace" \
    bash -c ". '$HELPER_SRC'; . '$DEPLOY_HELPER_SRC'; configure_deploy_local_env" 2>&1
  )"
  status=$?
  set -e
  if [ "$status" -eq 0 ] || [[ "$output" != *"CONDUCTOR_PORT must be a decimal integer between 1 and 65526."* ]]; then
    echo "FAIL: $label: status=$status output='$output'" >&2
    exit 1
  fi
  echo "PASS: $label"
}

workspace="$TMP_ROOT/salvador-v1"
mkdir -p "$workspace"

stale_name="$(
  cd "$workspace"
  CONDUCTOR_WORKSPACE_NAME=fast-mode-cache-layer \
  CONDUCTOR_WORKSPACE_PATH="$workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env >/dev/null; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$stale_name" "salvador-v1" "stale Conductor workspace name is normalized from current workspace path"

trusted_name="$(
  cd "$workspace"
  ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  CONDUCTOR_WORKSPACE_NAME=custom-name \
  CONDUCTOR_WORKSPACE_PATH="$workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env >/dev/null; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$trusted_name" "custom-name" "explicit trust flag preserves custom workspace name"

deploy_child="$TMP_ROOT/deploy-child"
mkdir -p "$deploy_child/.context"
cat >"$deploy_child/.context/deploy-worktree.env" <<ENV
export ROSE_DEPLOY_WORKTREE=1
export ROSE_DEPLOY_WORKTREE_PATH=$deploy_child
export CONDUCTOR_WORKSPACE_PATH=$deploy_child
export CONDUCTOR_WORKSPACE_NAME=deploy-child
export CONDUCTOR_PORT=56020
ENV
isolated_benchmark_env="$(
  cd "$deploy_child"
  BENCHMARK_ISOLATED_RUN=true \
  ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  CONDUCTOR_WORKSPACE_NAME=deploy-child-bench-run-123 \
  CONDUCTOR_WORKSPACE_PATH="$deploy_child" \
  CONDUCTOR_PORT=56220 \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env >/dev/null; printf '%s\\n' \"\$CONDUCTOR_WORKSPACE_NAME\" \"\$CONDUCTOR_PORT\""
)"
isolated_benchmark_name=$(printf '%s\n' "$isolated_benchmark_env" | sed -n '1p')
isolated_benchmark_port=$(printf '%s\n' "$isolated_benchmark_env" | sed -n '2p')
expect_eq "$isolated_benchmark_name" "deploy-child-bench-run-123" "isolated benchmark preserves its child identity"
expect_eq "$isolated_benchmark_port" "56220" "isolated benchmark preserves its reserved port range"

cloud_workspace="$TMP_ROOT/cloud-checkout"
mkdir -p "$cloud_workspace"
cat >"$cloud_workspace/.cloud-env" <<'ENV'
# rose-cloud-env
export CONDUCTOR_WORKSPACE_NAME=cloud-generated
ENV
cloud_name="$(
  cd "$cloud_workspace"
  CONDUCTOR_WORKSPACE_NAME=cloud-generated \
  CONDUCTOR_WORKSPACE_PATH="$cloud_workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$cloud_name" "cloud-generated" "cloud-generated workspace name remains authoritative"

explicit_queue="$(
  TEMPORAL_TASK_QUEUE=semantic-sentinel \
  bash -c ". '$HELPER_SRC'; resolve_temporal_task_queue yamoussoukro"
)"
expect_eq "$explicit_queue" "semantic-sentinel" "explicit Temporal queue survives stack derivation"

default_queue="$(
  env -u TEMPORAL_TASK_QUEUE \
  bash -c ". '$HELPER_SRC'; resolve_temporal_task_queue yamoussoukro"
)"
expect_eq "$default_queue" "navi-agent-tasks-yamoussoukro" "workspace queue remains the default"

deploy_env="$(
  cd "$workspace"
  CONDUCTOR_PORT=55190 \
  CONDUCTOR_WORKSPACE_NAME=stale-branch-title \
  CONDUCTOR_WORKSPACE_PATH="$workspace" \
  bash -c ". '$HELPER_SRC'; . '$DEPLOY_HELPER_SRC'; configure_deploy_local_env >/dev/null; printf '%s\\n' \"\$CONDUCTOR_WORKSPACE_NAME\" \"\$DB_CONTAINER\" \"\$DB_VOLUME\" \"\$TEMPORAL_TASK_QUEUE\" \"\$SMOKE_BASE_URL\" \"\$LOCAL_DB_PORT\" \"\$RUN_SH_STRICT_CONDUCTOR_PORT\""
)"
deploy_workspace=$(printf '%s\n' "$deploy_env" | sed -n '1p')
deploy_container=$(printf '%s\n' "$deploy_env" | sed -n '2p')
deploy_volume=$(printf '%s\n' "$deploy_env" | sed -n '3p')
deploy_queue=$(printf '%s\n' "$deploy_env" | sed -n '4p')
deploy_backend_url=$(printf '%s\n' "$deploy_env" | sed -n '5p')
deploy_db_port=$(printf '%s\n' "$deploy_env" | sed -n '6p')
deploy_strict_port=$(printf '%s\n' "$deploy_env" | sed -n '7p')
expect_eq "$deploy_workspace" "salvador-v1" "deploy env normalizes stale workspace identity"
expect_eq "$deploy_container" "victoria-db-salvador-v1" "deploy DB container uses normalized identity"
expect_eq "$deploy_volume" "victoria-pgdata-salvador-v1" "deploy DB volume uses normalized identity"
case "$deploy_queue" in
  navi-agent-tasks-salvador-v1-deploy-*) echo "PASS: deploy queue uses normalized identity" ;;
  *) echo "FAIL: deploy queue used stale identity: $deploy_queue" >&2; exit 1 ;;
esac
expect_eq "$deploy_backend_url" "http://localhost:55190" "deploy backend URL uses assigned port"
expect_eq "$deploy_db_port" "55195" "deploy DB port uses assigned range"
expect_eq "$deploy_strict_port" "1" "deploy stack forbids silent port reassignment"

system_pg_db_port="$(
  cd "$workspace"
  CONDUCTOR_PORT=55190 \
  CONDUCTOR_WORKSPACE_PATH="$workspace" \
  ROSE_USE_SYSTEM_PG=true \
  bash -c ". '$HELPER_SRC'; . '$DEPLOY_HELPER_SRC'; configure_deploy_local_env >/dev/null; printf '%s' \"\$LOCAL_DB_PORT\""
)"
expect_eq "$system_pg_db_port" "5432" "system Postgres deploy env advertises localhost:5432, not conductor+5"

expect_deploy_port_rejected "abc" "deploy env rejects a nonnumeric assigned port"
expect_deploy_port_rejected "055190" "deploy env rejects a leading-zero assigned port"
expect_deploy_port_rejected "65527" "deploy env rejects a port range whose +9 reservation would overflow"

max_port_db="$(
  cd "$workspace"
  CONDUCTOR_PORT=65526 \
  CONDUCTOR_WORKSPACE_PATH="$workspace" \
  bash -c ". '$HELPER_SRC'; . '$DEPLOY_HELPER_SRC'; configure_deploy_local_env >/dev/null; printf '%s' \"\$LOCAL_DB_PORT\""
)"
expect_eq "$max_port_db" "65531" "deploy env accepts the highest safe assigned port"

run_context="$workspace/.context/benchmarks/example-run"
mkdir -p "$workspace/agents" "$run_context"
resolved_wmh_log="$(
  cd "$workspace"
  bash -c ". '$RUN_CONTEXT_SRC'; resolve_run_context_file '$workspace' '.context/benchmarks/example-run' 'wmh-serve-log.txt'"
)"
(
  cd "$workspace/agents"
  printf 'wmh build output\n' >>"$resolved_wmh_log"
)
expect_eq "$resolved_wmh_log" "$run_context/wmh-serve-log.txt" "run-context files remain absolute after service subshell cd"
expect_eq "$(cat "$resolved_wmh_log")" "wmh build output" "service subshell writes to the workspace run context"

resolved_absolute_wmh_log="$(
  bash -c ". '$RUN_CONTEXT_SRC'; resolve_run_context_file '$workspace' '$run_context' 'absolute-wmh-serve-log.txt'"
)"
expect_eq "$resolved_absolute_wmh_log" "$run_context/absolute-wmh-serve-log.txt" "absolute run-context paths remain unchanged"

# db_port_conflict_owner guards setup-db.sh from clobbering a sibling
# workspace's DB when a foreign CONDUCTOR_PORT derives a colliding LOCAL_DB_PORT.
ps_output="victoria-db-cape-town 0.0.0.0:55005->5432/tcp, [::]:55005->5432/tcp
victoria-db-canberra 0.0.0.0:55015->5432/tcp, [::]:55015->5432/tcp"

conflict_owner="$(
  bash -c ". '$HELPER_SRC'; db_port_conflict_owner victoria-db-lagos 55005 \"\$1\"" _ "$ps_output"
)"
expect_eq "$conflict_owner" "victoria-db-cape-town" "db port conflict names the sibling container binding the target port"

no_conflict="$(
  bash -c ". '$HELPER_SRC'; db_port_conflict_owner victoria-db-lagos 55060 \"\$1\"" _ "$ps_output"
)"
expect_eq "$no_conflict" "" "db port with no running binder reports no conflict"

self_only="victoria-db-lagos 0.0.0.0:55005->5432/tcp, [::]:55005->5432/tcp"
self_conflict="$(
  bash -c ". '$HELPER_SRC'; db_port_conflict_owner victoria-db-lagos 55005 \"\$1\"" _ "$self_only"
)"
expect_eq "$self_conflict" "" "the workspace's own container is never treated as a conflict"

# cloud-build.sh must write `# rose-cloud-env` into .cloud-env itself (not only
# into shell rc files). Without that marker, normalize_conductor_workspace_env
# rewrites the synthetic cloud name to the checkout basename and breaks ngrok
# domain reuse on Cursor Cloud agents.
cloud_build_script="$ROOT_DIR/scripts/cloud-build.sh"
if ! grep -q '^# rose-cloud-env$' <(sed -n '/cat > \.cloud-env <<EOF/,/^EOF$/p' "$cloud_build_script"); then
  echo "FAIL: cloud-build.sh .cloud-env template must include # rose-cloud-env marker" >&2
  exit 1
fi
echo "PASS: cloud-build.sh writes # rose-cloud-env into .cloud-env"

# Cloud VMs booted from one snapshot share /etc/machine-id and the baked
# .cloud-env. Two such instances once both claimed cloud-44cb5599, so the second
# deploy stack died on ERR_NGROK_334 (its reserved domain was already online).
instance_dir="$TMP_ROOT/instances"
mkdir -p "$instance_dir"
printf '0::/system.slice/pod-aaa111-x1/cursor-agent/workload\n' >"$instance_dir/cgroup-a"
printf '0::/system.slice/pod-bbb222-x2/cursor-agent/workload\n' >"$instance_dir/cgroup-b"
printf '0::/init.scope\n' >"$instance_dir/cgroup-none"
printf 'boot-1\n' >"$instance_dir/boot-1"
printf 'boot-2\n' >"$instance_dir/boot-2"
instance_id() {
  bash -c ". '$HELPER_SRC'; cloud_instance_id \"\$1\" \"\$2\"" _ "$1" "$2"
}
id_a="$(instance_id "$instance_dir/cgroup-a" "$instance_dir/boot-1")"
id_b="$(instance_id "$instance_dir/cgroup-b" "$instance_dir/boot-1")"
id_a_again="$(instance_id "$instance_dir/cgroup-a" "$instance_dir/boot-1")"
id_no_pod_1="$(instance_id "$instance_dir/cgroup-none" "$instance_dir/boot-1")"
id_no_pod_2="$(instance_id "$instance_dir/cgroup-none" "$instance_dir/boot-2")"
[[ "$id_a" =~ ^[0-9a-f]{8}$ ]] || { echo "FAIL: cloud instance id is not 8 hex chars: $id_a" >&2; exit 1; }
[ "$id_a" != "$id_b" ] || { echo "FAIL: sibling pods on one image share a cloud identity" >&2; exit 1; }
[ "$id_no_pod_1" != "$id_no_pod_2" ] || { echo "FAIL: separate boots share a cloud identity" >&2; exit 1; }
expect_eq "$id_a_again" "$id_a" "cloud identity is stable within one instance"
if instance_id "$instance_dir/missing" "$instance_dir/missing" >/dev/null; then
  echo "FAIL: cloud instance id must fail without any instance signal" >&2
  exit 1
fi
echo "PASS: cloud instance id fails closed without an instance signal"

cloud_env_state() {
  if bash -c ". '$HELPER_SRC'; cloud_env_is_current \"\$1\" \"\$2\"" _ "$1" "$2"; then
    echo current
  else
    echo stale
  fi
}
baked_env="$instance_dir/baked.cloud-env"
printf '# rose-cloud-env\nexport CONDUCTOR_WORKSPACE_NAME=cloud-%s\nexport ROSE_CLOUD_INSTANCE_ID=%s\n' \
  "$id_a" "$id_a" >"$baked_env"
legacy_env="$instance_dir/legacy.cloud-env"
printf '# rose-cloud-env\nexport CONDUCTOR_WORKSPACE_NAME=cloud-44cb5599\n' >"$legacy_env"
expect_eq "$(cloud_env_state "$baked_env" "$id_a")" "current" "the instance that wrote .cloud-env keeps it"
expect_eq "$(cloud_env_state "$baked_env" "$id_b")" "stale" "a snapshot sibling replaces the baked .cloud-env"
expect_eq "$(cloud_env_state "$legacy_env" "$id_a")" "stale" "a legacy machine-id .cloud-env is replaced"
expect_eq "$(cloud_env_state "$instance_dir/absent" "$id_a")" "stale" "a missing .cloud-env is written"
expect_eq "$(cloud_env_state "$legacy_env" "")" "current" "without an instance signal the existing .cloud-env stays"
if grep -q '/etc/machine-id' "$cloud_build_script"; then
  echo "FAIL: cloud-build.sh must not derive the workspace id from the image-wide machine-id" >&2
  exit 1
fi
if ! grep -q '^export ROSE_CLOUD_INSTANCE_ID=\${INSTANCE_ID}$' \
  <(sed -n '/cat > \.cloud-env <<EOF/,/^EOF$/p' "$cloud_build_script"); then
  echo "FAIL: cloud-build.sh must record the instance that owns .cloud-env" >&2
  exit 1
fi
echo "PASS: cloud-build.sh keys .cloud-env to the running instance"

echo "All workspace env tests passed."
