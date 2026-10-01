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
bash -c ". '$HELPER_SRC'; write_cloud_env '$cloud_workspace/.cloud-env' 3001 cloud-generated '$cloud_workspace' \"\$(cloud_env_boot_id)\""
cloud_name="$(
  cd "$cloud_workspace"
  CONDUCTOR_WORKSPACE_NAME=cloud-generated \
  CONDUCTOR_WORKSPACE_PATH="$cloud_workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$cloud_name" "cloud-generated" "cloud-generated workspace name remains authoritative"

stale_shell_name="$(
  cd "$cloud_workspace"
  CONDUCTOR_WORKSPACE_NAME=cloud-from-before-rekey \
  CONDUCTOR_WORKSPACE_PATH="$cloud_workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$stale_shell_name" "cloud-generated" "a shell opened before a re-key adopts the current .cloud-env name"

pinned_cloud_name="$(
  cd "$cloud_workspace"
  ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  CONDUCTOR_WORKSPACE_NAME=cloud-generated-bench-run-1 \
  CONDUCTOR_WORKSPACE_PATH="$cloud_workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$pinned_cloud_name" "cloud-generated-bench-run-1" "a trusted cloud identity is not replaced by .cloud-env"

isolated_cloud_name="$(
  cd "$cloud_workspace"
  BENCHMARK_ISOLATED_RUN=true \
  CONDUCTOR_WORKSPACE_NAME=cloud-generated-lifecycle \
  CONDUCTOR_WORKSPACE_PATH="$cloud_workspace" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$isolated_cloud_name" "cloud-generated-lifecycle" "an isolated benchmark cloud identity is not replaced by .cloud-env"

# Every VM booted from one prebuilt snapshot inherits the snapshot's .cloud-env.
# Each must mint its own workspace name, or they all publish the same reserved
# ngrok domain and the second stack dies with ERR_NGROK_334.
snapshot_env="$TMP_ROOT/snapshot.cloud-env"
bash -c ". '$HELPER_SRC'; write_cloud_env '$snapshot_env' 3001 cloud-44cb5599 /workspace boot-snapshot"
for vm in vm-a vm-b; do
  mkdir -p "$TMP_ROOT/$vm"
  cp "$snapshot_env" "$TMP_ROOT/$vm/.cloud-env"
  bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/$vm/.cloud-env' boot-$vm" 2>/dev/null
done
read_cloud_env() {
  bash -c ". '$HELPER_SRC'; cloud_env_value '$1' '$2'"
}
vm_a_name="$(read_cloud_env "$TMP_ROOT/vm-a/.cloud-env" CONDUCTOR_WORKSPACE_NAME)"
vm_b_name="$(read_cloud_env "$TMP_ROOT/vm-b/.cloud-env" CONDUCTOR_WORKSPACE_NAME)"
[[ "$vm_a_name" =~ ^cloud-[0-9a-f]{8}$ ]] || { echo "FAIL: re-keyed name is not cloud-<8 hex>: '$vm_a_name'" >&2; exit 1; }
[ "$vm_a_name" != "cloud-44cb5599" ] || { echo "FAIL: snapshot workspace name survived a boot change" >&2; exit 1; }
[ "$vm_a_name" != "$vm_b_name" ] || { echo "FAIL: two VMs from one snapshot share workspace name $vm_a_name" >&2; exit 1; }
echo "PASS: VMs booted from one snapshot mint distinct workspace names"
expect_eq "$(read_cloud_env "$TMP_ROOT/vm-a/.cloud-env" CONDUCTOR_PORT)" "3001" "re-key keeps the snapshot port"
expect_eq "$(read_cloud_env "$TMP_ROOT/vm-a/.cloud-env" CONDUCTOR_ROOT_PATH)" "/workspace" "re-key keeps the snapshot root path"
grep -qx '# rose-cloud-env' "$TMP_ROOT/vm-a/.cloud-env" \
  || { echo "FAIL: re-keyed .cloud-env lost the # rose-cloud-env trust marker" >&2; exit 1; }
echo "PASS: re-keyed .cloud-env keeps the # rose-cloud-env trust marker"

cp "$TMP_ROOT/vm-a/.cloud-env" "$TMP_ROOT/vm-a/before"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/vm-a/.cloud-env' boot-vm-a"
cmp -s "$TMP_ROOT/vm-a/before" "$TMP_ROOT/vm-a/.cloud-env" \
  || { echo "FAIL: refreshing on the same boot rewrote .cloud-env" >&2; exit 1; }
echo "PASS: refreshing on the minting boot keeps the workspace name"

mkdir -p "$TMP_ROOT/legacy"
cat >"$TMP_ROOT/legacy/.cloud-env" <<'ENV'
# rose-cloud-env
export CONDUCTOR_PORT=3001
export CONDUCTOR_WORKSPACE_NAME=cloud-44cb5599
export CONDUCTOR_ROOT_PATH=/workspace
ENV
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/legacy/.cloud-env' boot-legacy" 2>/dev/null
legacy_name="$(read_cloud_env "$TMP_ROOT/legacy/.cloud-env" CONDUCTOR_WORKSPACE_NAME)"
[ "$legacy_name" != "cloud-44cb5599" ] || { echo "FAIL: a .cloud-env without a boot stamp was trusted as current" >&2; exit 1; }
echo "PASS: a .cloud-env without a boot stamp is re-keyed"

if command -v flock >/dev/null 2>&1; then
  mkdir -p "$TMP_ROOT/race"
  cp "$snapshot_env" "$TMP_ROOT/race/.cloud-env"
  for _ in 1 2 3 4 5 6 7 8; do
    bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/race/.cloud-env' boot-race" 2>>"$TMP_ROOT/race/stderr" &
  done
  wait
  expect_eq "$(grep -c '^Re-keyed ' "$TMP_ROOT/race/stderr")" "1" "parallel refreshes on one boot re-key exactly once"
  expect_eq "$(grep -c '^# rose-cloud-boot-id boot-race$' "$TMP_ROOT/race/.cloud-env")" "1" "parallel refreshes leave one boot stamp"
fi

if [ -n "$(bash -c ". '$HELPER_SRC'; cloud_env_boot_id")" ]; then
  mkdir -p "$TMP_ROOT/snapshot-vm"
  cp "$snapshot_env" "$TMP_ROOT/snapshot-vm/.cloud-env"
  booted_name="$(
    cd "$TMP_ROOT/snapshot-vm"
    CONDUCTOR_WORKSPACE_NAME=cloud-44cb5599 \
    CONDUCTOR_WORKSPACE_PATH="$TMP_ROOT/snapshot-vm" \
    bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env 2>/dev/null; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
  )"
  expect_eq "$booted_name" "$(read_cloud_env "$TMP_ROOT/snapshot-vm/.cloud-env" CONDUCTOR_WORKSPACE_NAME)" \
    "normalizing on a snapshot-booted VM adopts the re-keyed name"
  [ "$booted_name" != "cloud-44cb5599" ] || { echo "FAIL: snapshot-booted VM kept the snapshot workspace name" >&2; exit 1; }
  echo "PASS: snapshot-booted VM drops the snapshot workspace name"
fi

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
# domain reuse on Cursor Cloud agents. It must also mint and re-key through the
# shared helpers rather than keeping a snapshot-baked file or /etc/machine-id.
cloud_build_script="$ROOT_DIR/scripts/cloud-build.sh"
fresh_env="$TMP_ROOT/fresh.cloud-env"
bash -c ". '$HELPER_SRC'; write_cloud_env '$fresh_env' 3001 \"\$(new_cloud_workspace_name)\" /workspace boot-fresh"
grep -qx '# rose-cloud-env' "$fresh_env" \
  || { echo "FAIL: write_cloud_env must include the # rose-cloud-env marker" >&2; exit 1; }
for required in 'refresh_cloud_env_identity .cloud-env' 'write_cloud_env .cloud-env'; do
  grep -qF "$required" "$cloud_build_script" \
    || { echo "FAIL: cloud-build.sh must call '$required'" >&2; exit 1; }
done
if grep -q 'machine-id' "$cloud_build_script"; then
  echo "FAIL: cloud-build.sh must not derive the workspace id from /etc/machine-id (shared by every snapshot clone)" >&2
  exit 1
fi
echo "PASS: cloud-build.sh mints and re-keys .cloud-env through the shared helpers"

echo "All workspace env tests passed."
