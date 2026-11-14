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
  ROSE_STABILITY_UNIT_IDENTITY \
  ROSE_DEPLOY_WORKTREE \
  ROSE_DEPLOY_WORKTREE_PATH \
  ROSE_DEPLOY_SOURCE_WORKSPACE \
  ROSE_USE_SYSTEM_PG \
  TEMPORAL_TASK_QUEUE \
  BOXES_DEVBOX \
  CLOUD_ENV_BOXES_DEVBOX_ID 2>/dev/null || true
# The host's real agent store would otherwise pin every default-path identity.
export CLOUD_ENV_AGENT_STORE_DIR="$TMP_ROOT/no-agent-store"

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

stability_unit_name="$(
  cd "$deploy_child"
  ROSE_STABILITY_UNIT_IDENTITY=1 \
  ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  CONDUCTOR_WORKSPACE_NAME=stab-123-0-abcdef \
  CONDUCTOR_WORKSPACE_PATH="$deploy_child" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env >/dev/null; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$stability_unit_name" "stab-123-0-abcdef" "a stability unit keeps its own identity inside a deploy worktree"
deploy_shell_name="$(
  cd "$deploy_child"
  ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  CONDUCTOR_WORKSPACE_NAME=stab-123-0-abcdef \
  CONDUCTOR_WORKSPACE_PATH="$deploy_child" \
  bash -c ". '$HELPER_SRC'; normalize_conductor_workspace_env >/dev/null; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
expect_eq "$deploy_shell_name" "deploy-child" "without the stability flag a deploy worktree still rehydrates its identity"

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
  bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/$vm/.cloud-env' '' boot-$vm" 2>/dev/null
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
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/vm-a/.cloud-env' '' boot-vm-a"
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
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/legacy/.cloud-env' '' boot-legacy" 2>/dev/null
legacy_name="$(read_cloud_env "$TMP_ROOT/legacy/.cloud-env" CONDUCTOR_WORKSPACE_NAME)"
[ "$legacy_name" != "cloud-44cb5599" ] || { echo "FAIL: a .cloud-env without a boot stamp was trusted as current" >&2; exit 1; }
echo "PASS: a .cloud-env without a boot stamp is re-keyed"

if command -v flock >/dev/null 2>&1; then
  mkdir -p "$TMP_ROOT/race"
  cp "$snapshot_env" "$TMP_ROOT/race/.cloud-env"
  for _ in 1 2 3 4 5 6 7 8; do
    bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$TMP_ROOT/race/.cloud-env' '' boot-race" 2>>"$TMP_ROOT/race/stderr" &
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

# A Cursor agent keeps its store id across reboot and resume, so only a clone
# (new store id) is re-keyed; the DB volume and reserved domain stay attached.
agent_env="$TMP_ROOT/agent/.cloud-env"
mkdir -p "$TMP_ROOT/agent"
bash -c ". '$HELPER_SRC'; write_cloud_env '$agent_env' 3001 cloud-builder /workspace boot-build bc-builder"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$agent_env' bc-clone boot-clone" 2>/dev/null
clone_name="$(read_cloud_env "$agent_env" CONDUCTOR_WORKSPACE_NAME)"
[ "$clone_name" != "cloud-builder" ] || { echo "FAIL: a clone with a new agent store id kept the builder's name" >&2; exit 1; }
echo "PASS: a new agent store id re-keys a snapshot clone"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$agent_env' bc-clone boot-reboot" 2>"$TMP_ROOT/agent/reboot.err"
expect_eq "$(read_cloud_env "$agent_env" CONDUCTOR_WORKSPACE_NAME)" "$clone_name" "a reboot with the same agent store id keeps the workspace name"
expect_eq "$(bash -c ". '$HELPER_SRC'; cloud_env_stamp '$agent_env' boot-id")" "boot-reboot" "a kept identity records the new boot"
expect_eq "$(grep -c '^Re-keyed ' "$TMP_ROOT/agent/reboot.err" || true)" "0" "a reboot with the same agent store id is not reported as a re-key"
cp "$agent_env" "$TMP_ROOT/agent/before"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$agent_env' '' boot-reboot"
cmp -s "$TMP_ROOT/agent/before" "$agent_env" \
  || { echo "FAIL: an agent store restart within one boot rewrote .cloud-env" >&2; exit 1; }
echo "PASS: an unavailable agent store within the minting boot keeps the identity untouched"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$agent_env' '' boot-unknown" 2>/dev/null
[ "$(read_cloud_env "$agent_env" CONDUCTOR_WORKSPACE_NAME)" != "$clone_name" ] \
  || { echo "FAIL: a new boot without an agent store id kept the name" >&2; exit 1; }
echo "PASS: a new boot without an agent store id is re-keyed"

boot_only_env="$TMP_ROOT/agent/boot-only.cloud-env"
bash -c ". '$HELPER_SRC'; write_cloud_env '$boot_only_env' 3001 cloud-bootonly /workspace boot-same"
bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$boot_only_env' bc-late boot-same"
expect_eq "$(read_cloud_env "$boot_only_env" CONDUCTOR_WORKSPACE_NAME)" "cloud-bootonly" "an agent store that starts after minting keeps the name"
expect_eq "$(bash -c ". '$HELPER_SRC'; cloud_env_stamp '$boot_only_env' agent-id")" "bc-late" "a late agent store id is recorded for later reboots"

# /run is on the snapshotted disk: a store id is trusted only while its daemon runs.
(
  store_pid=''
  cleanup_agent_store_fixture() {
    if [ -n "$store_pid" ]; then
      kill "$store_pid" 2>/dev/null || true
      wait "$store_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_agent_store_fixture EXIT
  fake_store="$TMP_ROOT/agent-store"
  mkdir -p "$fake_store"
  printf 'bc-live' >"$fake_store/self-store-id"
  printf 'import signal\nsignal.pause()\n' >"$fake_store/cursor-agent-store-fuse"
  python3 "$fake_store/cursor-agent-store-fuse" &
  store_pid=$!
  # Publish ready after the daemon command is visible on Linux and macOS.
  for _ in $(seq 1 100); do
    ps -p "$store_pid" -o command= 2>/dev/null | grep -q 'cursor-agent-store-fuse' && break
    sleep 0.05
  done
  printf 'pid=%s\n' "$store_pid" >"$fake_store/ready"
  expect_eq "$(CLOUD_ENV_AGENT_STORE_DIR="$fake_store" bash -c ". '$HELPER_SRC'; cloud_env_agent_id")" "bc-live" "a running store daemon's id is the agent id"
  kill "$store_pid" 2>/dev/null || true
  wait "$store_pid" 2>/dev/null || true
  store_pid=''
  expect_eq "$(CLOUD_ENV_AGENT_STORE_DIR="$fake_store" bash -c ". '$HELPER_SRC'; cloud_env_agent_id")" "" "a stale store id without its daemon is ignored"
  printf 'pid=%s\n' "$$" >"$fake_store/ready"
  expect_eq "$(CLOUD_ENV_AGENT_STORE_DIR="$fake_store" bash -c ". '$HELPER_SRC'; cloud_env_agent_id")" "" "a reused pid that is not the store daemon is ignored"
)

# boxes.dev: a snapshot clone shares the snapshot's boot id, so the devbox id is the
# agent id there (BOXES_DEVBOX=1); Cursor's store daemon id keeps precedence.
(
  fixture="$TMP_ROOT/boxes-identity"
  mkdir -p "$fixture/bin"
  printf '#!/bin/sh\necho "{\\"schemaVersion\\":1,\\"ok\\":true,\\"email\\":\\"x@example.com\\",\\"devboxId\\":\\"${STUB_DEVBOX:-}\\"}"\n' >"$fixture/bin/dvb-onbox"
  chmod +x "$fixture/bin/dvb-onbox"
  agent_id() { env "$@" bash -c ". '$HELPER_SRC'; cloud_env_agent_id"; }
  expect_eq "$(agent_id CLOUD_ENV_BOXES_DEVBOX_ID=dvb-test)" "dvb-test" "the boxes devbox id is the agent id (override)"
  expect_eq "$(agent_id BOXES_DEVBOX=1 STUB_DEVBOX=dvb-real PATH="$fixture/bin:$PATH")" "dvb-real" "dvb-onbox whoami supplies the devbox id on boxes"
  expect_eq "$(agent_id STUB_DEVBOX=dvb-real PATH="$fixture/bin:$PATH")" "" "without BOXES_DEVBOX=1 no devbox id is read"
  expect_eq "$(agent_id BOXES_DEVBOX=1 PATH="$fixture/bin:$PATH")" "" "an empty devbox id is no id"
  # clone vs original: the stamp written under one id re-keys under another, keeps its name under the same one.
  ws="$fixture/ws"; mkdir -p "$ws"
  boot=same-boot-id
  CLOUD_ENV_BOXES_DEVBOX_ID=dvb-template bash -c ". '$HELPER_SRC'; write_cloud_env '$ws/.cloud-env' 3001 cloud-template '$ws' $boot dvb-template; echo 'export ROSE_USE_SYSTEM_PG=true' >>'$ws/.cloud-env'"
  rekey() { CLOUD_ENV_BOXES_DEVBOX_ID="$1" bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$ws/.cloud-env' \"\$(cloud_env_agent_id)\" $boot" 2>/dev/null; sed -n 's/^export CONDUCTOR_WORKSPACE_NAME=//p' "$ws/.cloud-env"; }
  expect_eq "$(rekey dvb-template)" "cloud-template" "the same devbox keeps its workspace name across reboot/resume"
  clone_name="$(rekey dvb-clone)"
  case "$clone_name" in cloud-template | "") echo "FAIL: a clone with another devbox id must re-key (got '$clone_name')" >&2; exit 1 ;; esac
  echo "PASS: a clone with a different devbox id re-keys"
  expect_eq "$(grep -c '^export ROSE_USE_SYSTEM_PG=true$' "$ws/.cloud-env")" "1" "re-keying keeps the system-Postgres selection"
  expect_eq "$(rekey dvb-clone)" "$clone_name" "the re-keyed clone keeps its new name"
  # no id (neither store nor devbox): the same boot keeps the name, as before.
  expect_eq "$(CLOUD_ENV_BOXES_DEVBOX_ID= bash -c ". '$HELPER_SRC'; refresh_cloud_env_identity '$ws/.cloud-env' '' $boot" 2>/dev/null; sed -n 's/^export CONDUCTOR_WORKSPACE_NAME=//p' "$ws/.cloud-env")" "$clone_name" "no id keeps the same-boot behaviour"
)

# The system-Postgres selection must be part of the re-keyed file the instant it replaces
# the old one: any other reader (run.sh, startup scripts) sources .cloud-env unlocked, and a
# second append step would let it pick Docker Postgres in between. Capture the file right
# after the atomic mv, before anything else in refresh_cloud_env_identity can touch it.
(
  fixture="$TMP_ROOT/atomic-system-pg"
  mkdir -p "$fixture"
  seen_after_mv="$fixture/seen-after-mv"
  rekey_snapshot() {
    rm -f "$seen_after_mv"
    bash -c ". '$HELPER_SRC'; mv() { command mv \"\$@\" && cp \"\${@: -1}\" '$seen_after_mv'; }; refresh_cloud_env_identity '$1' other-agent boot-atomic" 2>/dev/null
  }
  with_pg="$fixture/with-pg.cloud-env"
  bash -c ". '$HELPER_SRC'; write_cloud_env '$with_pg' 3001 cloud-atomic '$fixture' boot-atomic first-agent; echo 'export ROSE_USE_SYSTEM_PG=true' >>'$with_pg'"
  rekey_snapshot "$with_pg"
  expect_eq "$(grep -c '^export ROSE_USE_SYSTEM_PG=true$' "$seen_after_mv")" "1" "the re-keyed file carries the system-Postgres selection from its first visible byte"
  rekeyed_name="$(sed -n 's/^export CONDUCTOR_WORKSPACE_NAME=//p' "$with_pg")"
  case "$rekeyed_name" in cloud-atomic | "") echo "FAIL: the atomic re-key test must actually re-key (got '$rekeyed_name')" >&2; exit 1 ;; esac
  without_pg="$fixture/without-pg.cloud-env"
  bash -c ". '$HELPER_SRC'; write_cloud_env '$without_pg' 3001 cloud-atomic '$fixture' boot-atomic first-agent"
  rekey_snapshot "$without_pg"
  expect_eq "$(grep -c ROSE_USE_SYSTEM_PG "$seen_after_mv")" "0" "re-keying never adds a system-Postgres selection the file did not have"
  expect_eq "$(grep -c ROSE_USE_SYSTEM_PG "$without_pg")" "0" "a re-keyed file without the selection stays without it"
  with_extra="$fixture/with-extra.cloud-env"
  bash -c ". '$HELPER_SRC'; write_cloud_env '$with_extra' 3001 cloud-atomic '$fixture' boot-atomic first-agent 'export ROSE_USE_SYSTEM_PG=true'"
  expect_eq "$(tail -n 1 "$with_extra")" "export ROSE_USE_SYSTEM_PG=true" "write_cloud_env writes an optional extra line with the identity"
  expect_eq "$(sed -n 's/^export CONDUCTOR_PORT=//p' "$with_extra")" "3001" "the identity lines stay intact beside the extra line"
)

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

# Cloud VMs boot from disk snapshots that carry /etc/machine-id and the
# .cloud-env written while the snapshot was built. Every clone must still get
# its own workspace name, or concurrent agents share one ngrok domain
# (ERR_NGROK_334) and one run.sh Temporal queue. The `# rose-cloud-env` marker
# must be in .cloud-env itself (not only in shell rc files), or
# normalize_conductor_workspace_env rewrites the synthetic name to the checkout
# basename and breaks ngrok domain reuse.
cloud_build_script="$ROOT_DIR/scripts/cloud-build.sh"
fresh_env="$TMP_ROOT/fresh.cloud-env"
bash -c ". '$HELPER_SRC'; write_cloud_env '$fresh_env' 3001 \"\$(new_cloud_workspace_name)\" /workspace boot-fresh"
grep -qx '# rose-cloud-env' "$fresh_env" \
  || { echo "FAIL: write_cloud_env must include the # rose-cloud-env marker" >&2; exit 1; }
if ! grep -q 'ensure_cloud_workspace_env "\$ROOT"' "$cloud_build_script"; then
  echo "FAIL: cloud-build.sh must provision .cloud-env through ensure_cloud_workspace_env" >&2
  exit 1
fi
if grep -q 'machine-id' "$cloud_build_script"; then
  echo "FAIL: cloud-build.sh must not derive the workspace id from /etc/machine-id (shared by every snapshot clone)" >&2
  exit 1
fi
echo "PASS: cloud-build.sh provisions .cloud-env through ensure_cloud_workspace_env"

# These cases exercise the boot-id path, so this VM's real agent store must not
# leak in (a shared agent id would correctly keep one name across "clones").
cloud_identity() {
  local root="$1" boot_id_file="$2"
  HOME="$TMP_ROOT/home" CLOUD_ENV_AGENT_STORE_DIR="$TMP_ROOT/no-agent-store" bash -c \
    ". '$HELPER_SRC'; ensure_cloud_workspace_env \"\$1\" 3001 \"\$2\" >/dev/null && . \"\$1/.cloud-env\" && printf '%s\n' \"\$CONDUCTOR_WORKSPACE_NAME\"" \
    _ "$root" "$boot_id_file"
}
mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/snapshot-a" "$TMP_ROOT/native"
printf 'build-boot\n' > "$TMP_ROOT/boot-build"
printf 'clone-boot-a\n' > "$TMP_ROOT/boot-a"
printf 'clone-boot-b\n' > "$TMP_ROOT/boot-b"
build_name="$(cloud_identity "$TMP_ROOT/snapshot-a" "$TMP_ROOT/boot-build")"
if [[ ! "$build_name" =~ ^cloud-[0-9a-f]{8}$ ]]; then
  echo "FAIL: generated cloud workspace name '$build_name' is not cloud-<8 hex>" >&2
  exit 1
fi
echo "PASS: a fresh instance gets a cloud-<8 hex> workspace name"
expect_eq "$(grep -c '^# rose-cloud-env$' "$TMP_ROOT/snapshot-a/.cloud-env")" "1" \
  "generated .cloud-env carries the # rose-cloud-env marker"
expect_eq "$(cloud_identity "$TMP_ROOT/snapshot-a" "$TMP_ROOT/boot-build")" "$build_name" \
  "the same boot keeps its workspace name across reruns"
cp -p "$TMP_ROOT/snapshot-a/.cloud-env" "$TMP_ROOT/snapshot-a/.cloud-env.baked"
mkdir -p "$TMP_ROOT/snapshot-b"
cp -p "$TMP_ROOT/snapshot-a/.cloud-env.baked" "$TMP_ROOT/snapshot-b/.cloud-env"
clone_a_name="$(CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME="$build_name" \
  cloud_identity "$TMP_ROOT/snapshot-a" "$TMP_ROOT/boot-a")"
clone_b_name="$(CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME="$build_name" \
  cloud_identity "$TMP_ROOT/snapshot-b" "$TMP_ROOT/boot-b")"
if [ "$clone_a_name" = "$build_name" ] || [ "$clone_b_name" = "$build_name" ] || [ "$clone_a_name" = "$clone_b_name" ]; then
  echo "FAIL: snapshot clones share a workspace name: build=$build_name a=$clone_a_name b=$clone_b_name" >&2
  exit 1
fi
echo "PASS: snapshot clones of one baked .cloud-env each mint their own workspace name"
expect_eq "$(cloud_identity "$TMP_ROOT/snapshot-a" "$TMP_ROOT/boot-a")" "$clone_a_name" \
  "a clone keeps its minted name for the rest of its boot"
native_output="$(HOME="$TMP_ROOT/home" CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=lagos-v1 \
  bash -c ". '$HELPER_SRC'; ensure_cloud_workspace_env \"\$1\" 3001 \"\$2\"" _ "$TMP_ROOT/native" "$TMP_ROOT/boot-a")"
if [ -e "$TMP_ROOT/native/.cloud-env" ] || [[ "$native_output" != *"Native Conductor env detected"* ]]; then
  echo "FAIL: a native Conductor workspace must not get a synthetic .cloud-env" >&2
  exit 1
fi
echo "PASS: a native Conductor workspace keeps its own identity"

# .cloud-env files minted by the earlier boot-id-only writer record the boot as
# ROSE_CLOUD_BOOT_ID; the same boot must keep that name instead of re-keying.
mkdir -p "$TMP_ROOT/boot-id-export"
cat >"$TMP_ROOT/boot-id-export/.cloud-env" <<'ENV'
# rose-cloud-env
# Generated by scripts/cloud-build.sh — per-instance, gitignored.
export CONDUCTOR_PORT=3001
export CONDUCTOR_WORKSPACE_NAME=cloud-0badc0de
export CONDUCTOR_ROOT_PATH=/workspace
export ROSE_CLOUD_BOOT_ID=clone-boot-a
ENV
expect_eq "$(cloud_identity "$TMP_ROOT/boot-id-export" "$TMP_ROOT/boot-a")" "cloud-0badc0de" \
  "a ROSE_CLOUD_BOOT_ID .cloud-env from the same boot keeps its workspace name"
expect_eq "$(bash -c ". '$HELPER_SRC'; cloud_env_stamp '$TMP_ROOT/boot-id-export/.cloud-env' boot-id")" "clone-boot-a" \
  "a kept ROSE_CLOUD_BOOT_ID identity is restamped with the boot id"
[ "$(cloud_identity "$TMP_ROOT/boot-id-export" "$TMP_ROOT/boot-b")" != "cloud-0badc0de" ] \
  || { echo "FAIL: a ROSE_CLOUD_BOOT_ID .cloud-env from another boot kept its name" >&2; exit 1; }
echo "PASS: a ROSE_CLOUD_BOOT_ID .cloud-env from another boot is re-keyed"

# Every agents/venv provisioner reinstalls when requirements.txt is no longer
# satisfied. Gating on `import temporalio` alone kept browser-use 0.11 in a
# provisioned Cloud venv after the pin moved to >=0.13.10, and the agents
# coverage gate failed on the stale release.
VENV_CHECKER="$ROOT_DIR/scripts/lib/agents_venv_satisfied.py"
VENV_PYTHON="$ROOT_DIR/agents/venv/bin/python"
[ -x "$VENV_PYTHON" ] || VENV_PYTHON="$(command -v python3)"

expect_venv_check() {
  local expected="$1" label="$2" requirements="$3"
  printf '%s\n' "$requirements" >"$TMP_ROOT/requirements.txt"
  local rc=0
  "$VENV_PYTHON" "$VENV_CHECKER" "$TMP_ROOT/requirements.txt" >"$TMP_ROOT/venv-check.out" 2>&1 || rc=$?
  if [ "$rc" -ne "$expected" ]; then
    echo "FAIL: $label (expected rc=$expected, got rc=$rc)" >&2
    cat "$TMP_ROOT/venv-check.out" >&2
    exit 1
  fi
  echo "PASS: $label"
}

expect_venv_check 0 "venv check: installed requirement within its specifier is satisfied" "pip>=1"
expect_venv_check 0 "venv check: comments and blank lines are ignored" "# header

pip>=1  # pinned for a reason"
expect_venv_check 1 "venv check: installed release older than the pin is unsatisfied" "pip>=9999"
expect_venv_check 1 "venv check: installed release above an upper bound is unsatisfied" "pip<1"
expect_venv_check 1 "venv check: missing distribution is unsatisfied" "rose-not-a-real-distribution>=1"
expect_venv_check 0 "venv check: a marker that excludes this interpreter is skipped" \
  'rose-not-a-real-distribution>=1; python_version < "3"'
expect_venv_check 0 "venv check: a direct URL requirement is satisfied by the installed distribution" \
  "pip @ git+https://example.invalid/pip.git@0000000000000000000000000000000000000000"
expect_venv_check 1 "venv check: pip option lines are never treated as satisfied" "-e ./somewhere"
# A package-location hint names no distribution (#1471 vendors wheels this way);
# flagging it made every provisioner reinstall agents/venv on every start.
expect_venv_check 0 "venv check: a --find-links location hint is skipped" "--find-links ./vendor
pip>=1"
expect_venv_check 1 "venv check: requirements after a location hint are still checked" "--find-links ./vendor
pip>=9999"
expect_venv_check 1 "venv check: an included requirements file is never treated as satisfied" "-r other.txt"

for venv_provisioner in scripts/cloud-build.sh scripts/run.sh scripts/prepare-deploy-worktree.sh; do
  if ! grep -q 'scripts/lib/agents_venv_satisfied.py agents/requirements.txt' "$ROOT_DIR/$venv_provisioner"; then
    echo "FAIL: $venv_provisioner must reinstall agents/venv when requirements.txt is unsatisfied" >&2
    exit 1
  fi
done
echo "PASS: every agents venv provisioner checks requirements.txt satisfaction"

# run.sh builds a missing venv from asdf's pinned python when the lookup works
# and from PATH's python3 otherwise. A failed lookup used to leave "/bin/python3"
# (the system interpreter, 3.12 on Cloud VMs) as the candidate.
run_venv_block="$TMP_ROOT/run-venv-block.sh"
awk '/^# ── Pre-flight: ensure agents venv/{on=1} on{print} on&&/^fi$/{exit}' \
  "$ROOT_DIR/scripts/run.sh" >"$run_venv_block"
grep -q 'agents_venv_satisfied.py' "$run_venv_block" \
  || { echo "FAIL: could not extract run.sh's agents venv preflight" >&2; exit 1; }
asdf_root="$TMP_ROOT/venv-asdf"
mkdir -p "$asdf_root/agents" "$asdf_root/bin" "$asdf_root/asdf-python/bin"
printf '3.11\n' >"$asdf_root/agents/.python-version"
: >"$asdf_root/agents/requirements.txt"
printf '#!/usr/bin/env bash\n[ -n "${ASDF_PYTHON_ROOT:-}" ] || exit 1\nprintf "%%s\\n" "$ASDF_PYTHON_ROOT"\n' \
  >"$asdf_root/bin/asdf"
cat >"$asdf_root/bin/python3" <<'PY'
#!/usr/bin/env bash
printf '%s\n' "$0" >>"$BASE_PYTHON_CALLS"
case "$1" in
  --version) echo "Python 3.11.0" ;;
  -m)
    [ "$2" = venv ] || exit 2
    mkdir -p "$3/bin"
    printf 'PATH="%s/bin:$PATH"\n' "$(cd "$3" && pwd)" >"$3/bin/activate"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$3/bin/pip"
    chmod +x "$3/bin/pip"
    ;;
  *) exit 2 ;;
esac
PY
cp "$asdf_root/bin/python3" "$asdf_root/asdf-python/bin/python3"
chmod +x "$asdf_root/bin/asdf" "$asdf_root/bin/python3" "$asdf_root/asdf-python/bin/python3"
run_venv_preflight() { # run_venv_preflight [asdf python root]
  rm -rf "$asdf_root/agents/venv"
  : >"$asdf_root/base-calls"
  (cd "$asdf_root" && PATH="$asdf_root/bin:$PATH" ASDF_PYTHON_ROOT="${1:-}" \
    BASE_PYTHON_CALLS="$asdf_root/base-calls" bash "$run_venv_block" >/dev/null 2>&1)
}
run_venv_preflight || { echo "FAIL: run.sh venv preflight failed without asdf" >&2; exit 1; }
expect_eq "$(sort -u "$asdf_root/base-calls")" "$asdf_root/bin/python3" \
  "a failed asdf lookup builds the venv with PATH python3"
run_venv_preflight "$asdf_root/asdf-python" || { echo "FAIL: run.sh venv preflight failed with asdf" >&2; exit 1; }
expect_eq "$(sort -u "$asdf_root/base-calls")" "$asdf_root/asdf-python/bin/python3" \
  "a working asdf lookup selects its python"

# A snapshot VM's installed Postgres patch can fall off the archive, so the
# pinned pgvector build fails. Under cloud-build.sh's `set -eu` that used to
# abort before npm/venv provisioning and left an empty agents venv.
pg_fallback_block="$TMP_ROOT/cloud-build-pg-fallback.sh"
awk '/# ── 2b\. Fallback: system Postgres/{on=1} on{print} on&&/^    fi$/{exit}' \
  "$cloud_build_script" >"$pg_fallback_block"
grep -q 'cloudbench-install-pgvector.sh' "$pg_fallback_block" \
  || { echo "FAIL: could not extract cloud-build.sh's system Postgres fallback" >&2; exit 1; }
pg_root="$TMP_ROOT/pg-fallback"
mkdir -p "$pg_root/bin" "$pg_root/scripts"
for tool in pg_isready pg_ctlcluster service su dpkg-query apt-cache; do
  printf '#!/bin/sh\nexit 0\n' >"$pg_root/bin/$tool"
done
cat >"$pg_root/bin/ls" <<'SH'
#!/bin/sh
if [ "$1" = /usr/lib/postgresql ]; then
  # Own the absent-extension precondition independently of installed host majors.
  printf '99999\n'
else
  /bin/ls "$@"
fi
SH
printf '#!/bin/sh\nexit 1\n' >"$pg_root/bin/docker"
printf '#!/bin/sh\nexit 0\n' >"$pg_root/bin/find"
printf '#!/bin/sh\necho "16 main 5432 online postgres /var/lib/postgresql/16/main log"\n' \
  >"$pg_root/bin/pg_lsclusters"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$APT_CALLS"\nexit "${APT_RC:-0}"\n' >"$pg_root/bin/apt-get"
chmod +x "$pg_root/bin"/*
run_pg_fallback() { # run_pg_fallback <pinned-build-rc> <apt-rc>
  printf '#!/bin/sh\nexit %s\n' "$1" >"$pg_root/scripts/cloudbench-install-pgvector.sh"
  : >"$pg_root/apt-calls"
  PATH="$pg_root/bin:$PATH" APT_CALLS="$pg_root/apt-calls" APT_RC="$2" \
    bash -c 'set -eu; ROOT="$1"; SUDO=""; . "$2"; echo PROVISIONING_CONTINUES' \
    _ "$pg_root" "$pg_fallback_block" 2>&1
}
pg_out="$(run_pg_fallback 1 0)" || { echo "FAIL: a failed pinned pgvector build aborted cloud-build.sh" >&2; exit 1; }
[[ "$pg_out" == *PROVISIONING_CONTINUES* && "$pg_out" == *"System Postgres running"* ]] \
  || { echo "FAIL: cloud-build.sh stopped after a failed pinned pgvector build" >&2; exit 1; }
grep -qx 'install -y -qq postgresql-16-pgvector' "$pg_root/apt-calls" \
  || { echo "FAIL: a failed pinned pgvector build did not install postgresql-16-pgvector" >&2; exit 1; }
echo "PASS: a failed pinned pgvector build installs the distro package and keeps provisioning"
pg_out="$(run_pg_fallback 1 1)" || { echo "FAIL: an unavailable pgvector aborted cloud-build.sh" >&2; exit 1; }
[[ "$pg_out" == *"fallback unusable: pgvector unavailable"* && "$pg_out" == *PROVISIONING_CONTINUES* ]] \
  || { echo "FAIL: an unavailable pgvector was not reported while provisioning continued" >&2; exit 1; }
[[ "$pg_out" != *"System Postgres running"* ]] \
  || { echo "FAIL: a fallback without pgvector was reported ready" >&2; exit 1; }
echo "PASS: an unavailable pgvector marks the fallback unusable without aborting provisioning"
pg_out="$(run_pg_fallback 1 1)" \
  || { echo "FAIL: unavailable package metadata aborted dependency provisioning" >&2; exit 1; }
[[ "$pg_out" == *"Could not refresh package metadata"* && "$pg_out" == *"fallback unusable: pgvector unavailable"* && "$pg_out" == *PROVISIONING_CONTINUES* ]] \
  || { echo "FAIL: missing metadata did not preserve the honest database failure through provisioning" >&2; exit 1; }
echo "PASS: missing package metadata preserves provisioning and reports the database failure"

# The npm/venv results print first; only then does the missing extension fail the build.
build_tail="$TMP_ROOT/cloud-build-tail.sh"
awk '/^\[ \$JS_RC -eq 0 \]/{on=1} on{print}' "$cloud_build_script" >"$build_tail"
grep -q 'PG_FALLBACK_ERROR' "$build_tail" \
  || { echo "FAIL: cloud-build.sh's final status ignores the system Postgres fallback" >&2; exit 1; }
tail_out="$(JS_RC=0 PY_RC=0 PG_FALLBACK_ERROR="pgvector unavailable" bash -c 'set -eu; . "$1"' _ "$build_tail" 2>&1)" \
  && { echo "FAIL: cloud-build.sh reported success with an unusable system Postgres" >&2; exit 1; }
[[ "$tail_out" == *"Database setup failed: pgvector unavailable"* && "$tail_out" != *"Cloud build complete"* ]] \
  || { echo "FAIL: cloud-build.sh did not report the unusable system Postgres" >&2; exit 1; }
tail_out="$(JS_RC=0 PY_RC=0 bash -c 'set -eu; . "$1"' _ "$build_tail" 2>&1)" \
  || { echo "FAIL: cloud-build.sh failed without a database error" >&2; exit 1; }
[[ "$tail_out" == *"Cloud build complete"* ]] \
  || { echo "FAIL: cloud-build.sh did not report completion" >&2; exit 1; }
echo "PASS: cloud-build.sh fails after provisioning when the system Postgres fallback is unusable"
run_pg_fallback 0 0 >/dev/null || { echo "FAIL: a successful pinned pgvector build failed the fallback" >&2; exit 1; }
grep -qx 'update -qq' "$pg_root/apt-calls" \
  || { echo "FAIL: the missing-extension fixture did not exercise package metadata refresh" >&2; exit 1; }
! grep -Eq '^install .*postgresql-[0-9]+-pgvector$' "$pg_root/apt-calls" \
  || { echo "FAIL: a successful pinned pgvector build still installed the distro package" >&2; exit 1; }
echo "PASS: a successful pinned pgvector build skips the distro package"

# Sandbox-reachable backend base: tunnel when public, untouched otherwise.
sandbox_base() {
  (
    unset ROSE_UI_PUBLISH_BASE_URL USERCONTENT_BASE_URL
    # shellcheck source=/dev/null
    . "$HELPER_SRC"
    export BACKEND_URL="http://localhost:24740" "$@"
    export_sandbox_backend_base_url || return $?
    printf '%s|%s' "${ROSE_UI_PUBLISH_BASE_URL:-}" "${USERCONTENT_BASE_URL:-}"
  )
}
expect_eq "$(sandbox_base PUBLIC_BASE_URL=https://rose-w4.ngrok.app/)" \
  "https://rose-w4.ngrok.app|http://localhost:24740" "sandboxes reach the backend through the public tunnel"
expect_eq "$(sandbox_base PUBLIC_BASE_URL=http://localhost:24741)" "|" \
  "a loopback PUBLIC_BASE_URL is never handed to sandboxes"
expect_eq "$(sandbox_base PUBLIC_BASE_URL=https://t.example ROSE_UI_PUBLISH_BASE_URL=https://explicit.example)" \
  "https://explicit.example|" "an explicit ROSE_UI_PUBLISH_BASE_URL wins"
grep -qx 'export_sandbox_backend_base_url' "$ROOT_DIR/scripts/run.sh" \
  || { echo "FAIL: run.sh does not export the sandbox backend base after the tunnel" >&2; exit 1; }
for inherited in http://localhost:24740 https://foreign.example https://owned.example/foreign \
 'https://owned.example?query=x' 'https://owned.example/#fragment' 'https://user:password@owned.example' https://owned.example:0; do
 if sandbox_base BENCHMARK_PUBLIC_TUNNEL_RUN_ID=fixture PUBLIC_BASE_URL=https://owned.example ROSE_UI_PUBLISH_BASE_URL="$inherited" >/dev/null 2>&1; then
  echo 'FAIL: scoped mismatching callback origin was accepted' >&2; exit 1
 fi
done
expect_eq "$(sandbox_base BENCHMARK_PUBLIC_TUNNEL_RUN_ID=fixture PUBLIC_BASE_URL=https://owned.example/ ROSE_UI_PUBLISH_BASE_URL=https://owned.example/)" \
 'https://owned.example/|http://localhost:24740' 'matching scoped override preserves trailing slash and local usercontent'
expect_eq "$(sandbox_base BENCHMARK_PUBLIC_TUNNEL_RUN_ID=fixture PUBLIC_BASE_URL=https://owned.example ROSE_UI_PUBLISH_BASE_URL=https://OWNED.example:443)" \
 'https://OWNED.example:443|http://localhost:24740' 'matching normalized origin is accepted unchanged'
echo "PASS: run.sh exports the sandbox backend base"

# cloud-init.sh's injected-secret -> .env sync has no /deploy gate of its own;
# this already-gated environment suite runs it so a regression fails Step 4s.
bash "$ROOT_DIR/scripts/tests/cloud-init-env.test.sh"

echo "All workspace env tests passed."
