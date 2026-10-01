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
CLOUD_ENV_SRC="$ROOT_DIR/scripts/lib/cloud-env.sh"
if ! grep -q 'ensure_cloud_env "$ROOT"' "$cloud_build_script"; then
  echo "FAIL: cloud-build.sh must provision .cloud-env through ensure_cloud_env" >&2
  exit 1
fi
cloud_env_root="$TMP_ROOT/cloud-env-root"
cloud_env_home="$TMP_ROOT/cloud-env-home"
mkdir -p "$cloud_env_root" "$cloud_env_home"
: >"$cloud_env_home/.bashrc"
printf '44cb5599-0000-4000-8000-000000000001\n' >"$TMP_ROOT/boot-builder"
printf '9f3e7a21-1111-4111-8111-000000000002\n' >"$TMP_ROOT/boot-clone"
run_ensure_cloud_env() {
  HOME="$cloud_env_home" ROSE_CLOUD_BOOT_ID_FILE="$1" \
    env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
    bash -c ". '$CLOUD_ENV_SRC'; ensure_cloud_env '$cloud_env_root' >/dev/null" &&
    sed -nE 's/^export CONDUCTOR_WORKSPACE_NAME=(.*)$/\1/p' "$cloud_env_root/.cloud-env"
}
builder_name="$(run_ensure_cloud_env "$TMP_ROOT/boot-builder")"
expect_eq "$builder_name" "cloud-44cb5599" "cloud identity is derived from the instance boot id"
expect_eq "$(grep -c '^# rose-cloud-env$' "$cloud_env_root/.cloud-env")" "1" "generated .cloud-env carries the # rose-cloud-env marker"
expect_eq "$(run_ensure_cloud_env "$TMP_ROOT/boot-builder")" "cloud-44cb5599" "the generating instance keeps its workspace id"
clone_name="$(run_ensure_cloud_env "$TMP_ROOT/boot-clone")"
expect_eq "$clone_name" "cloud-9f3e7a21" "a VM booted from a snapshot of another instance regenerates its workspace id"
expect_eq "$(grep -c '^\[ -f .*/.cloud-env \] && \. .*/.cloud-env$' "$cloud_env_home/.bashrc")" "1" "shell rc sources .cloud-env exactly once"
printf '# rose-cloud-env\nexport CONDUCTOR_PORT=3001\nexport CONDUCTOR_WORKSPACE_NAME=cloud-legacy\n' >"$cloud_env_root/.cloud-env"
expect_eq "$(run_ensure_cloud_env "$TMP_ROOT/boot-clone")" "cloud-9f3e7a21" "a snapshot-baked .cloud-env without an instance stamp is regenerated"
printf '# Generated by cloudbench-entrypoint.sh\nexport CONDUCTOR_WORKSPACE_NAME=cloudbench\n' >"$cloud_env_root/.cloud-env"
expect_eq "$(run_ensure_cloud_env "$TMP_ROOT/boot-clone")" "cloudbench" "cloudbench-pinned .cloud-env identities are never rewritten"
rm -f "$cloud_env_root/.cloud-env"
native_out="$(
  HOME="$cloud_env_home" ROSE_CLOUD_BOOT_ID_FILE="$TMP_ROOT/boot-clone" \
  CONDUCTOR_PORT=55190 CONDUCTOR_WORKSPACE_NAME=lagos \
  bash -c ". '$CLOUD_ENV_SRC'; ensure_cloud_env '$cloud_env_root'"
)"
expect_eq "$([ -e "$cloud_env_root/.cloud-env" ] && echo written || echo absent)" "absent" "native Conductor env writes no .cloud-env"
case "$native_out" in
  *"Native Conductor env detected"*) echo "PASS: native Conductor env is reported" ;;
  *) echo "FAIL: native Conductor env path not taken: $native_out" >&2; exit 1 ;;
esac

spaced_root="$TMP_ROOT/cloud env \$(touch pwned) root"
spaced_home="$TMP_ROOT/spaced-home"
mkdir -p "$spaced_root" "$spaced_home"
: >"$spaced_home/.bashrc"
HOME="$spaced_home" ROSE_CLOUD_BOOT_ID_FILE="$TMP_ROOT/boot-clone" \
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  bash -c '. "$1"; ensure_cloud_env "$2" >/dev/null' _ "$CLOUD_ENV_SRC" "$spaced_root"
spaced_env="$(
  cd "$TMP_ROOT"
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME -u CONDUCTOR_ROOT_PATH \
    bash -c '. "$1"; printf "%s\n" "$CONDUCTOR_ROOT_PATH" "$CONDUCTOR_WORKSPACE_NAME" "$CONDUCTOR_PORT"' _ "$spaced_home/.bashrc"
)"
expect_eq "$(printf '%s\n' "$spaced_env" | sed -n '1p')" "$spaced_root" "a checkout path with spaces and shell syntax round-trips through the rc source line"
expect_eq "$(printf '%s\n' "$spaced_env" | sed -n '2p')" "cloud-9f3e7a21" "the rc source line exports the generated workspace name"
expect_eq "$(printf '%s\n' "$spaced_env" | sed -n '3p')" "3001" "the rc source line exports the default port"
expect_eq "$([ -e "$TMP_ROOT/pwned" ] && echo executed || echo inert)" "inert" "shell syntax in the checkout path is never executed"

moved_root="$TMP_ROOT/cloud-env-moved"
mkdir -p "$moved_root"
HOME="$cloud_env_home" ROSE_CLOUD_BOOT_ID_FILE="$TMP_ROOT/boot-clone" \
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  bash -c ". '$CLOUD_ENV_SRC'; ensure_cloud_env '$moved_root' >/dev/null"
expect_eq "$(grep -cxF "[ -f $moved_root/.cloud-env ] && . $moved_root/.cloud-env" "$cloud_env_home/.bashrc")" "1" "a checkout at a new path gets its own rc source line"

bad_port_root="$TMP_ROOT/cloud-env-bad-port"
mkdir -p "$bad_port_root"
set +e
bad_port_out="$(
  HOME="$cloud_env_home" ROSE_CLOUD_BOOT_ID_FILE="$TMP_ROOT/boot-clone" CONDUCTOR_PORT='30$(id)' \
    env -u CONDUCTOR_WORKSPACE_NAME \
    bash -c ". '$CLOUD_ENV_SRC'; ensure_cloud_env '$bad_port_root'" 2>&1
)"
bad_port_status=$?
set -e
if [ "$bad_port_status" -eq 0 ] || [ -e "$bad_port_root/.cloud-env" ] || [[ "$bad_port_out" != *"CONDUCTOR_PORT must be a decimal integer"* ]]; then
  echo "FAIL: a nonnumeric CONDUCTOR_PORT must be rejected without writing .cloud-env: status=$bad_port_status output='$bad_port_out'" >&2
  exit 1
fi
echo "PASS: a nonnumeric CONDUCTOR_PORT is rejected without writing .cloud-env"

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

for venv_provisioner in scripts/cloud-build.sh scripts/run.sh scripts/prepare-deploy-worktree.sh; do
  if ! grep -q 'scripts/lib/agents_venv_satisfied.py agents/requirements.txt' "$ROOT_DIR/$venv_provisioner"; then
    echo "FAIL: $venv_provisioner must reinstall agents/venv when requirements.txt is unsatisfied" >&2
    exit 1
  fi
done
echo "PASS: every agents venv provisioner checks requirements.txt satisfaction"

echo "All workspace env tests passed."
