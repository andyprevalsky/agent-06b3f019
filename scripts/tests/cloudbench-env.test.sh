#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_SRC="$ROOT_DIR/scripts/lib/cloudbench-env.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$HELPER_SRC" ] || fail "cloud benchmark env helper is missing"
# shellcheck source=../lib/cloudbench-env.sh
source "$HELPER_SRC"

agents_env="$TMP_ROOT/agents.env"
backend_env="$TMP_ROOT/backend.env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-one\n' > "$agents_env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-two\n' > "$backend_env"

if cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null 2>&1; then
  fail "stale browserbase config must not pass a production kernel contract"
fi

sed -i.bak 's/browserbase/kernel/' "$agents_env" "$backend_env"
rm -f "$agents_env.bak" "$backend_env.bak"
cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null

agents_digest="$(cloudbench_env_sha256 "$agents_env")"
backend_digest="$(cloudbench_env_sha256 "$backend_env")"
[ "${#agents_digest}" -eq 64 ] || fail "agents env digest must be sha256"
[ "${#backend_digest}" -eq 64 ] || fail "backend env digest must be sha256"
cloudbench_verify_env_file "$agents_env" "$agents_digest" agents >/dev/null
if cloudbench_verify_env_file "$agents_env" "$backend_digest" agents >/dev/null 2>&1; then
  fail "a mismatched injected env digest must fail closed"
fi

retry_attempts=0
fail_twice_then_succeed() {
  retry_attempts=$((retry_attempts + 1))
  [ "$retry_attempts" -ge 3 ]
}
cloudbench_retry_command 3 0 fail_twice_then_succeed >/dev/null 2>&1 ||
  fail "a transient command must succeed within its retry budget"
[ "$retry_attempts" -eq 3 ] || fail "a transient command must be retried exactly to success"

retry_attempts=0
always_fail() {
  retry_attempts=$((retry_attempts + 1))
  return 9
}
if cloudbench_retry_command 3 0 always_fail >/dev/null 2>&1; then
  fail "a permanently failing command must fail closed"
fi
[ "$retry_attempts" -eq 3 ] || fail "a permanent failure must exhaust its retry budget"

# A completed child must not leave cleanup waiting on a cancel-resistant timer.
# The old `(sleep 30; kill -KILL ...) &` watchdog blocked for its full duration
# under macOS Bash 3.2 even after the controller tried to cancel it.
termination_ready="$TMP_ROOT/termination-ready"
perl -e '$SIG{TERM}=sub{exit 0}; open my $fh, ">", $ARGV[0] or die $!; close $fh; sleep 30' "$termination_ready" &
terminating_pid=$!
for _ in $(seq 1 100); do
  [ -e "$termination_ready" ] && break
  sleep 0.01
done
[ -e "$termination_ready" ] || fail "the termination test child must become ready"
termination_start="$SECONDS"
cloudbench_terminate_and_wait 5 "$terminating_pid" ""
termination_elapsed=$((SECONDS - termination_start))
[ "$termination_elapsed" -lt 5 ] ||
  fail "a TERM-responsive child must be reaped before the escalation deadline (elapsed=${termination_elapsed}s)"
if kill -0 "$terminating_pid" 2>/dev/null; then
  fail "the terminated child must not survive cleanup"
fi
termination_start="$SECONDS"
cloudbench_terminate_and_wait 5 ""
termination_elapsed=$((SECONDS - termination_start))
[ "$termination_elapsed" -lt 2 ] ||
  fail "an empty PID list must return immediately (elapsed=${termination_elapsed}s)"

machine_states="$TMP_ROOT/machine-states"
printf 'created\ncreated\nstopped\n' > "$machine_states"
read_machine_state() {
  local state
  state="$(head -1 "$machine_states")"
  tail -n +2 "$machine_states" > "$machine_states.next"
  mv "$machine_states.next" "$machine_states"
  printf '%s\n' "$state"
}
cloudbench_wait_machine_startable read_machine_state machine-1 3 0 ||
  fail "a provisioning clone must wait until it becomes stopped/startable"
[ ! -s "$machine_states" ] || fail "the startable-state wait must consume the transition sequence"

printf 'created\ndestroyed\n' > "$machine_states"
if cloudbench_wait_machine_startable read_machine_state machine-2 3 0 >/dev/null 2>&1; then
  fail "a destroyed provisioning clone must fail closed"
fi

cloudbench_validate_fresh_clone_id clone-2 warm-1 clone-1 ||
  fail "a unique non-source clone id must be accepted"
if cloudbench_validate_fresh_clone_id warm-1 warm-1 clone-1; then
  fail "the warm source id must never be accepted as a fresh clone"
fi
if cloudbench_validate_fresh_clone_id clone-1 warm-1 clone-1; then
  fail "a duplicate clone id must never be accepted"
fi

activation_ids="$(printf '%s\n' '[{"id":"warm-1","name":"cloudbench-warm","state":"stopped"},{"id":"lock-1","name":"cloudbench-controller-lock","state":"stopped"},{"id":"clone-1","name":"fleet-1","state":"stopped"},{"id":"provisioning-1","name":"other-controller-clone","state":"created"},{"id":"running-1","name":"other-controller-run","state":"started"}]' | cloudbench_env_activation_machine_ids)"
[ "$activation_ids" = $'warm-1\nclone-1' ] ||
  fail "environment activation must target only stopped non-lock benchmark machines"

node_a="$TMP_ROOT/node-a"
node_b="$TMP_ROOT/node-b"
mkdir -p "$node_a/back-end" "$node_a/front-end" "$node_b/back-end" "$node_b/front-end"
printf '{"lockfileVersion":3,"packages":{"generated":"old"}}\n' > "$node_a/package-lock.json"
printf '{"lockfileVersion":3,"packages":{"generated":"new"}}\n' > "$node_b/package-lock.json"
printf '{"lockfileVersion":3,"packages":{}}\n' > "$node_a/back-end/package-lock.json"
cp "$node_a/back-end/package-lock.json" "$node_b/back-end/package-lock.json"
printf '{"scripts":{"test":"old"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_a/package.json"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_b/package.json"
for relative in back-end/package.json front-end/package.json; do
  printf '{"scripts":{"test":"old"}}\n' > "$node_a/$relative"
  printf '{"scripts":{"test":"new"}}\n' > "$node_b/$relative"
done
node_a_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_a")"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" = "$node_b_fingerprint" ] ||
  fail "scripts and the generated root lock must not invalidate baked dependencies"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"2.0.0"}}\n' > "$node_b/package.json"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" != "$node_b_fingerprint" ] ||
  fail "dependency field changes must invalidate baked dependencies"

lock_file="$TMP_ROOT/controller.lock"
cloudbench_controller_lock_acquire "$lock_file"
if bash -c 'source "$1"; cloudbench_controller_lock_acquire "$2"' _ "$HELPER_SRC" "$lock_file"; then
  fail "a second controller must not acquire an owned lock"
fi
cloudbench_controller_lock_release "$lock_file"
[ ! -e "$lock_file" ] || fail "controller lock must be removed by its owner"

# Concurrent-workstream contract: the RUN path takes only the workspace-local
# controller lock and treats shared app state as READ-ONLY. Cross-host leases
# and per-run env refreshes were removed on purpose — a second workstream must
# never be blocked by (or race) another's run.
if grep -Fq -- 'cloudbench_controller_acquire' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "fleet controllers must not take the cross-host Fly sentinel lease (workspace-local lock only)"
fi
if grep -Fq -- 'cloudbench_cloud_lock_acquire' "$HELPER_SRC"; then
  fail "the removed cross-host sentinel lease must not return to the shared helpers"
fi
if grep -Fq -- 'run-bench-cloud --refresh-secrets;' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "the fleet run path must not refresh (mutate) the shared environment — verify only"
fi
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'bash scripts/run-bench-cloud --verify-secrets' \
  "fleet controller must read-only verify the environment before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_lock_acquire "$LOCK_DIR"' \
  "fleet controllers must hold the workspace-local controller lock"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_VERIFIED=1' \
  "fleet children must receive proof that the controller verified the environment"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'set -C; printf '"'"'%s\n'"'"' "$$" > "$claim_path"' \
  "pool claims must be atomic (noclobber) so concurrent controllers cannot double-claim"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'verify_app_environment' \
  "run-bench-cloud must expose the read-only environment preflight"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets list -a "$APP" --json' \
  "the environment preflight must be a read-only secrets listing"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets set --stage -a "$APP"' \
  "Machines API apps must stage the app-level environment before machine updates"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'transient Fly update failure; retrying machine $machine_id' \
  "machine environment activation must retry transient Fly API failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args=(machine update "$machine_id" -a "$APP")' \
  "every owned benchmark machine must build a scoped Fly update command"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args+=(--skip-start --yes)' \
  "every owned benchmark machine must activate staged secrets without starting"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args+=(--image "$image_ref")' \
  "dependency image refresh must reuse the stopped-machine activation boundary"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activation_targets="$(environment_activation_targets)"' \
  "environment activation must be scoped to the owned warm source and pool"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activate_machine_environment "$machine_id" "$role"' \
  "environment activation must preserve role-specific concurrency checks"
if grep -Fq -- 'cloudbench_wait_machine_startable fleet_machine_state "$cid"' \
  "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "fleet controller must delegate created-clone storage/start lifecycle to run-bench-cloud"
fi
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'if machine_storage_ready "$mid"; then' \
  "cloud child must wait for clone storage before requesting start"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'request_machine_start "$mid"' \
  "cloud child must own the transition from created to started"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '--name "$target_name"' \
  "fresh fleet clones must use an exact unique name for id resolution"
if grep -Fq -- 'FLY secrets deploy' "$ROOT_DIR/scripts/run-bench-cloud"; then
  fail "Machines API apps must not use Fly Launch secrets deploy"
fi
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_verify_env_file' \
  "primary benchmark machines must verify decoded env digests"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'cloudbench_verify_env_file' \
  "autoscaled benchmark workers must refresh and verify their env files"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'umask 077' \
  "decoded benchmark secrets must be owner-only from file creation"
require_text "$ROOT_DIR/scripts/cloudbench-sync-deps.sh" \
  'cloudbench_node_dependency_fingerprint' \
  "cloud dependency sync must ignore package scripts while binding dependency fields"
if grep -Fq -- 'eval "exec ${CLOUDBENCH_CONTROLLER_LOCK_FD}' "$HELPER_SRC"; then
  fail "controller lock fd cleanup must not use eval"
fi
require_text "$HELPER_SRC" \
  'exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"' \
  "flock fallback must open without truncating the current owner"
require_text "$ROOT_DIR/scripts/run-bench-hub-poller" \
  'exit_code" -ne "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE' \
  "hub requests must retry only the typed capacity-busy runner status"

echo "All cloud benchmark environment checks passed."
