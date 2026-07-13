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

cloud_lease_state="$TMP_ROOT/cloud-lease"
cloud_lease_calls="$TMP_ROOT/cloud-lease-calls"
cloud_lease_get_failure="$TMP_ROOT/cloud-lease-get-failure"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
cloudbench_machines_api_request() {
  local method="$1" path="$2" body="${3:-}" nonce="${4:-}"
  printf '%s|%s|%s|%s\n' "$method" "$path" "$body" "$nonce" >> "$cloud_lease_calls"
  case "$method|$path" in
    'GET|/v1/apps/bench-app/machines')
      if [ -e "$cloud_lease_get_failure" ]; then
        CLOUDBENCH_API_STATUS=503
        CLOUDBENCH_API_BODY='{"error":"unavailable"}'
        return 1
      fi
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='[{"id":"lock-machine","name":"cloudbench-controller-lock"}]'
      ;;
    'POST|/v1/apps/bench-app/machines/lock-machine/lease')
      if [ -e "$cloud_lease_state" ]; then
        CLOUDBENCH_API_STATUS=409
        CLOUDBENCH_API_BODY='{"error":"lease held"}'
      else
        : > "$cloud_lease_state"
        CLOUDBENCH_API_STATUS=201
        CLOUDBENCH_API_BODY='{"data":{"nonce":"lease-nonce"}}'
      fi
      ;;
    'DELETE|/v1/apps/bench-app/machines/lock-machine/lease')
      [ "$nonce" = "lease-nonce" ] || fail "cloud lock release omitted its lease nonce"
      rm -f "$cloud_lease_state"
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='{"ok":true}'
      ;;
    *) fail "unexpected mocked Machines API request: $method $path" ;;
  esac
}
cloudbench_cloud_lock_acquire bench-app
[ "$CLOUDBENCH_CLOUD_LOCK_MACHINE_ID" = "lock-machine" ] ||
  fail "cloud lock must bind the shared sentinel"
[ "$CLOUDBENCH_CLOUD_LOCK_NONCE" = "lease-nonce" ] ||
  fail "cloud lock must retain the provider nonce"
if (cloudbench_cloud_lock_acquire bench-app >/dev/null 2>&1); then
  fail "a second controller must not acquire an occupied Fly sentinel lease"
fi
cloudbench_cloud_lock_release bench-app
require_text "$cloud_lease_calls" \
  'DELETE|/v1/apps/bench-app/machines/lock-machine/lease||lease-nonce' \
  "cloud lock release must authenticate with its provider nonce"

# Failure typing must come from the current acquisition stage, never a stale
# API status left by an earlier 409. Otherwise a real outage loops as "busy".
stale_status_lock="$TMP_ROOT/stale-status-controller.lock"
: > "$cloud_lease_state"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
if cloudbench_controller_acquire "$stale_status_lock" bench-app >/dev/null 2>&1; then
  fail "an occupied cloud lease must not be acquired"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "cloud_busy" ] ||
  fail "an occupied cloud lease must be typed as cloud_busy"
rm -f "$cloud_lease_state"
: > "$cloud_lease_get_failure"
if cloudbench_controller_acquire "$stale_status_lock" bench-app >/dev/null 2>&1; then
  fail "a sentinel API outage must not acquire the controller"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "cloud_api_error" ] ||
  fail "a sentinel API outage was misclassified using stale 409 state"
[ ! -e "$stale_status_lock" ] || fail "API failure leaked the local controller lock"
rm -f "$cloud_lease_get_failure"

# A local lock setup error is not contention and must fail immediately.
if cloudbench_controller_wait_acquire /dev/null/controller.lock bench-app >/dev/null 2>&1; then
  fail "a local lock filesystem error must not enter the contention queue"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "local_error" ] ||
  fail "a local lock filesystem error must be typed as local_error"

# A legitimate sibling controller holds the app-wide lease while another
# workspace queues its fleet. The queued controller must wait for handoff
# instead of turning the Hub request into seven placeholder failures.
wait_lock_file="$TMP_ROOT/waiting-controller.lock"
: > "$cloud_lease_state"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
( sleep 0.05; rm -f "$cloud_lease_state" ) & lease_releaser_pid=$!
CLOUDBENCH_CONTROLLER_RETRY_INTERVAL=0.01 \
  cloudbench_controller_wait_acquire "$wait_lock_file" bench-app >/dev/null
wait "$lease_releaser_pid"
[ -e "$cloud_lease_state" ] || fail "waiting controller never acquired the released cloud lease"
cloudbench_controller_release "$wait_lock_file" bench-app
[ ! -e "$wait_lock_file" ] || fail "waiting controller did not release its local lock"

# Signals in the startup window (after lease acquisition but before the fleet's
# full cleanup trap) must release both the provider lease and local lock.
signal_lock_file="$TMP_ROOT/signal-controller.lock"
signal_ready_file="$TMP_ROOT/signal-controller.ready"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
(
  cloudbench_controller_install_release_guard "$signal_lock_file" bench-app
  cloudbench_controller_wait_acquire "$signal_lock_file" bench-app >/dev/null
  : > "$signal_ready_file"
  while :; do sleep 1; done
) & signal_controller_pid=$!
for _ in $(seq 1 100); do
  [ -e "$signal_ready_file" ] && break
  sleep 0.01
done
[ -e "$signal_ready_file" ] || fail "signal-guard controller never acquired its lease"
kill -TERM "$signal_controller_pid"
signal_status=0
wait "$signal_controller_pid" || signal_status=$?
[ "$signal_status" -eq 143 ] || fail "signal-guard controller returned $signal_status instead of 143"
[ ! -e "$cloud_lease_state" ] || fail "signal guard leaked the provider lease"
[ ! -e "$signal_lock_file" ] || fail "signal guard leaked the local controller lock"
unset CLOUDBENCH_MACHINES_API_TOKEN

require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'bash scripts/run-bench-cloud --refresh-secrets' \
  "fleet controller must refresh the environment once before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_PARENT_LOCK_HELD=1' \
  "fleet environment refresh must declare the controller lock it already owns"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_REFRESHED=1' \
  "fleet children must receive proof that the controller refreshed the environment"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_wait_acquire "$LOCK_DIR" "$APP"' \
  "fleet controllers must acquire the cross-host Fly sentinel lease"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_install_release_guard "$LOCK_DIR" "$APP"' \
  "fleet startup must guard controller leases before full cleanup is installed"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_release "$LOCK_DIR" "$APP"' \
  "fleet cleanup must release the cross-host Fly sentinel lease"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets set --stage -a "$APP"' \
  "Machines API apps must stage the app-level environment before machine updates"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'transient Fly update failure; retrying machine $machine_id' \
  "machine environment activation must retry transient Fly API failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY machine update "$machine_id" -a "$APP" --skip-start --yes' \
  "every owned benchmark machine must activate staged secrets without starting"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activation_targets="$(environment_activation_targets)"' \
  "environment activation must be scoped to the owned warm source and pool"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activate_machine_environment "$machine_id" "$role"' \
  "environment activation must preserve role-specific concurrency checks"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_wait_machine_startable fleet_machine_state "$cid"' \
  "fleet children must not launch while a fresh clone is still in created state"
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

echo "All cloud benchmark environment checks passed."
