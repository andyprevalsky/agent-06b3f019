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
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'STACK_SEED_DUMP="${CLOUDBENCH_SEED_DUMP_PATH:-/data/cloudbench-cache/victoria-seed.dump}"' \
  "cloud benchmark seed-dump freshness proof must retain its persistent default"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  "export BENCHMARK_SEED_DUMP='\$STACK_SEED_DUMP'" \
  "cloud benchmark process must receive the configured seed-dump freshness proof"
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

# A local bind collision is not a remote/DNS readiness failure. The proxy
# launcher must classify it immediately so its caller can abandon the poisoned
# lease and choose another port instead of retrying that port until the barrier
# timeout. Exercise the production function body, not a test-only copy.
proxy_function_source="$(awk '
  /^start_data_plane_proxy\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$proxy_function_source" ] || fail "could not load the production data-plane proxy function"
eval "$proxy_function_source"
APP="cloudbench-proxy-regression"
CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
flyctl() {
  echo "Error: listen tcp 127.0.0.1:61944: bind: address already in use" >&2
  return 1
}
curl() { return 1; }
proxy_log="$TMP_ROOT/proxy-bind-collision.log"
proxy_pid=""
proxy_started="$SECONDS"
proxy_status=0
start_data_plane_proxy 61944 3001 occupied.local "$proxy_log" proxy_pid backend 3 \
  || proxy_status=$?
proxy_elapsed=$((SECONDS - proxy_started))
[ "$proxy_status" -eq 98 ] ||
  fail "a bind collision must return the reallocate signal (exit=$proxy_status)"
[ "$proxy_elapsed" -lt 2 ] ||
  fail "a bind collision must fail fast enough to reallocate (elapsed=${proxy_elapsed}s)"

production_function() {
  awk -v function_name="$1" '
    $0 ~ "^" function_name "\\(\\)" { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud"
}
PORT_LEASE_HELPER="$ROOT_DIR/scripts/cloudbench-port-lease.py"
[ -f "$PORT_LEASE_HELPER" ] || fail "production port-lease helper is missing"
for function_name in local_port_is_bindable claim_exact_local_port claim_local_port \
    claim_local_archive_ports release_local_port_lease \
    release_local_port_leases publish_status_proxy_port start_leased_data_plane_proxy; do
  function_source="$(production_function "$function_name")"
  [ -n "$function_source" ] || fail "could not load production function $function_name"
  eval "$function_source"
done
PORT_LEASE_ROOT="$TMP_ROOT/proxy-port-leases"
PORT_LEASE_NONCE="proxy-regression-$$"
PORT_LEASES=()
OUT_DIR="$TMP_ROOT/proxy-output"
mkdir -p "$OUT_DIR"
flyctl() {
  case "$2" in
    61944:*)
      echo "Error: listen tcp 127.0.0.1:61944: bind: address already in use" >&2
      return 1
      ;;
    *)
      while :; do command sleep 1; done
      ;;
  esac
}
rotated_port=""
rotated_pid=""
# The replacement tunnel is a background child. On a shared CI host its shell
# can be scheduler-delayed even though the production collision classification
# above remains immediate, so give this observation window enough wall time.
start_leased_data_plane_proxy 61944 rotated_port 3001 occupied.local \
  "$TMP_ROOT/proxy-bind-rotation.log" rotated_pid status 10 ||
  fail "the proxy launcher must recover from a bind collision"
[ "$rotated_port" != "61944" ] || fail "the proxy launcher retried the poisoned port"
[ "$(cat "$OUT_DIR/status-proxy.port" 2>/dev/null || true)" = "$rotated_port" ] ||
  fail "status proxy rotation was not published atomically for the fleet barrier"
[ -n "$rotated_pid" ] && kill -0 "$rotated_pid" 2>/dev/null ||
  fail "the proxy launcher did not preserve the replacement tunnel"
cloudbench_terminate_and_wait 2 "$rotated_pid"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$rotated_port" ] || fail "replacement proxy lease survived cleanup"

# The dashboard allocator must not impose a hidden 100-port capacity ceiling.
# A real 11-bench ecommerce fleet found every port in 61115..61214 occupied by
# concurrent/archive viewers; the 11th child exited before publishing its boot
# config, so the parent waited five minutes for an impossible 11/11 barrier.
# Drive the production allocator with the same 100-collision boundary and prove
# it leases the immediately following free port.
PORT_LEASE_ROOT="$TMP_ROOT/dashboard-port-leases"
PORT_LEASE_NONCE="dashboard-exhaustion-$$"
PORT_LEASES=()
dashboard_preferred=61115
local_port_is_bindable() {
  [ "$1" -ge $((dashboard_preferred + 100)) ]
}
dashboard_port=""
claim_local_port "$dashboard_preferred" dashboard_port ||
  fail "dashboard allocator stopped after 100 occupied ports instead of continuing"
[ "$dashboard_port" = "$((dashboard_preferred + 100))" ] ||
  fail "dashboard allocator did not select the first free port after 100 collisions"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$dashboard_port" ] ||
  fail "exhaustion-regression dashboard lease survived cleanup"

# Shell arithmetic normally interprets a leading zero as octal. Port inputs are
# decimal strings, so a valid zero-padded preference must remain valid.
local_port_is_bindable() { return 0; }
decimal_port=""
claim_local_port 08080 decimal_port ||
  fail "dashboard allocator rejected a zero-padded decimal preference"
[ "$decimal_port" = "8080" ] ||
  fail "dashboard allocator did not normalize a zero-padded preference as decimal"
release_local_port_leases

# A stale lease can be replaced between observation and cleanup. Simulate that
# interleaving after the atomic rename and prove cleanup leaves the replacement.
stale_port=61250
stale_path="$PORT_LEASE_ROOT/$stale_port"
mkdir -p "$stale_path"
printf '%s stale\n' 99999999 > "$stale_path/owner"
mv() {
  command mv "$1" "$2" || return
  mkdir -p "$1"
  printf '%s replacement\n' "$$" > "$1/owner"
}
stale_result=""
claim_local_port "$stale_port" stale_result ||
  fail "allocator did not continue after atomically cleaning a stale lease"
unset -f mv
[ "$stale_result" = "$((stale_port + 1))" ] ||
  fail "allocator did not skip the concurrently replaced lease"
[ -d "$stale_path" ] || fail "stale cleanup removed a concurrently replaced lease"
[ "$(cat "$stale_path/owner")" = "$$ replacement" ] ||
  fail "stale cleanup changed the concurrently replaced lease owner"
rm -rf "$stale_path"

# The post-run archive viewer uses two adjacent leased ports. It must use
# the same full-namespace allocator rather than retaining its former 100-port
# inline scan, or a dense fleet can finish successfully but lose its archive UI.
PORT_LEASE_ROOT="$TMP_ROOT/archive-port-leases"
PORT_LEASE_NONCE="archive-exhaustion-$$"
PORT_LEASES=()
local_port_is_bindable() {
  [ "$1" -ge $((dashboard_preferred + 100)) ]
}
archive_api_port=""
archive_fe_port=""
claim_local_archive_ports "$dashboard_preferred" archive_api_port archive_fe_port ||
  fail "archive allocator stopped after 100 occupied ports instead of continuing"
[ "$archive_api_port" = "$((dashboard_preferred + 100))" ] ||
  fail "archive allocator did not select the first free API port after 100 collisions"
[ "$archive_fe_port" = "$((dashboard_preferred + 101))" ] ||
  fail "archive allocator did not lease the exact adjacent frontend port"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$archive_api_port" ] &&
  [ ! -d "$PORT_LEASE_ROOT/$archive_fe_port" ] ||
  fail "exhaustion-regression archive leases survived cleanup"

# If the preferred API port is free but its exact neighbor is not, release the
# partial lease and continue until a genuinely adjacent pair is available.
PORT_LEASE_ROOT="$TMP_ROOT/archive-adjacency-port-leases"
PORT_LEASE_NONCE="archive-adjacency-$$"
PORT_LEASES=()
archive_preferred=62000
local_port_is_bindable() {
  [ "$1" -ne $((archive_preferred + 1)) ]
}
archive_api_port=""
archive_fe_port=""
claim_local_archive_ports "$archive_preferred" archive_api_port archive_fe_port ||
  fail "archive allocator could not skip a candidate with an occupied neighbor"
[ "$archive_api_port" = "$((archive_preferred + 2))" ] &&
  [ "$archive_fe_port" = "$((archive_preferred + 3))" ] ||
  fail "archive allocator returned non-adjacent ports after an occupied neighbor"
[ ! -d "$PORT_LEASE_ROOT/$archive_preferred" ] ||
  fail "archive allocator retained the partial API lease after adjacency failed"
release_local_port_leases

# Fleet preferred ports advance by 20 per child. At sufficient width that raw
# preference crosses 65535, but the allocator must still wrap through the same
# finite local namespace instead of rejecting an otherwise serviceable fleet.
local_port_is_bindable() { return 0; }
overflow_preferred=$((65535 + 20))
overflow_expected=$((1024 + (overflow_preferred - 1024) % (65535 - 1024 + 1)))
overflow_port=""
claim_local_port "$overflow_preferred" overflow_port ||
  fail "dashboard allocator rejected an overflowed fleet preference instead of wrapping"
[ "$overflow_port" = "$overflow_expected" ] ||
  fail "dashboard allocator normalized an overflowed preference to the wrong port"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$overflow_port" ] ||
  fail "overflow-regression dashboard lease survived cleanup"
unset -f flyctl curl start_data_plane_proxy start_leased_data_plane_proxy \
  local_port_is_bindable claim_exact_local_port claim_local_port \
  claim_local_archive_ports release_local_port_lease \
  release_local_port_leases publish_status_proxy_port production_function
unset CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS

# Production replay for Fly's cpu_overcommit_exceeded governor response. The
# provider rejected the 37th inherited shared-cpu-4x primary when prod already
# held 16 CPU units: 16 + (37 * 4) = 164, beyond the observed 160-unit ceiling.
# Exercise the real clone command builder and require an explicit capacity-safe
# primary shape rather than inheriting the oversized warm maintenance machine.
primary_default_line="$(grep '^FLEET_PRIMARY_VM_SIZE=' "$ROOT_DIR/scripts/run-bench-fleet")"
primary_memory_line="$(grep '^FLEET_PRIMARY_VM_MEMORY=' "$ROOT_DIR/scripts/run-bench-fleet")"
[[ "$primary_default_line" = *"shared-cpu-2x"* && "$primary_memory_line" = *"4096"* ]] ||
  fail "fleet default must fit both Fly's shared-memory matrix and performance-CPU reservation ceiling"
clone_function_source="$(awk '
  /^clone_machine_target\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$clone_function_source" ] || fail "could not load production clone command builder"
eval "$clone_function_source"
WARM_ID="warm-source"
SNAP_ID="snapshot-1"
REGION="iad"
APP="navi-whisper-lux-bench"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
clone_args="$TMP_ROOT/primary-clone.args"
fleet_registry_record_name() { return 0; }
fleet_registry_record_id() { return 0; }
fleet_registry_release_name() { return 0; }
machine_storage_ready() { return 0; }
machine_storage_failed() { return 1; }
fly_with_timeout() {
  shift
  printf '%s\n' "$*" > "$clone_args"
  echo "Machine abcdef12345678 has been created..."
}
primary_id="$(clone_machine_target "$TMP_ROOT/primary.ids")" ||
  fail "production clone command builder failed in the capacity replay"
[ "$primary_id" = "abcdef12345678" ] || fail "capacity replay did not resolve the fake clone"
require_text "$clone_args" "--vm-size shared-cpu-2x" \
  "primary clone must avoid both the running CPU ceiling and performance reservation ceiling"
require_text "$clone_args" "--vm-memory 4096" \
  "primary clone memory must fit Fly's shared-cpu-2x memory ceiling"
primary_cpus="$(sed -nE 's/.*--vm-size ([^ ]+).*/\1/p' "$clone_args" | sed -nE 's/.*-([0-9]+)x$/\1/p')"
[ -n "$primary_cpus" ] || fail "capacity replay could not parse primary CPU allocation"
[ $((16 + 37 * primary_cpus)) -le 160 ] ||
  fail "daily fleet primary shape exceeds the observed Fly CPU governor ceiling"
unset -f clone_machine_target fleet_registry_record_name fleet_registry_record_id \
  fleet_registry_release_name machine_storage_ready machine_storage_failed fly_with_timeout

resize_function_source="$(awk '
  /^resize_pool_machine\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$resize_function_source" ] || fail "could not load production pool resizer"
eval "$resize_function_source"
FLEET_DIR="$TMP_ROOT/bridge-resize"
mkdir -p "$FLEET_DIR"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
APP="navi-whisper-lux-bench"
CLOUDBENCH_POOL_RESIZE_ATTEMPTS=1
resize_calls="$TMP_ROOT/resize.calls"
fly_with_timeout() {
  shift
  printf '%s\n' "$*" >> "$resize_calls"
  return 0
}
sleep() { :; }
resize_pool_machine saturated-shared-machine ||
  fail "pool resizer must execute under nounset and apply the configured target shape"
[ "$(wc -l < "$resize_calls" | tr -d ' ')" = "1" ] ||
  fail "pool resizer must perform one provider update after an immediate success"
require_text "$resize_calls" "--vm-size shared-cpu-2x" \
  "pool resizer must apply the configured capacity-safe target"
unset -f resize_pool_machine fly_with_timeout sleep
unset CLOUDBENCH_POOL_RESIZE_ATTEMPTS

shape_function_source="$(awk '
  /^pool_machine_shape_from_json\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
normalize_function_source="$(awk '
  /^normalize_current_pool_shape\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$shape_function_source" ] && [ -n "$normalize_function_source" ] ||
  fail "could not load production pool shape normalizer"
eval "$shape_function_source"
eval "$normalize_function_source"
POOL_IDS_FILE="$TMP_ROOT/shape-pool.ids"
printf 'old-shape\ncorrect-shape\n' > "$POOL_IDS_FILE"
FLEET_DIR="$TMP_ROOT/shape-run"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
POOL_INVENTORY_JSON='[{"id":"old-shape","state":"stopped","config":{"guest":{"cpu_kind":"performance","cpus":1,"memory_mb":8192}}},{"id":"correct-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}}]'
shape_after='[{"id":"old-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}},{"id":"correct-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}}]'
resize_calls="$TMP_ROOT/shape-resizes"
resize_marker="$TMP_ROOT/shape-resized"
resize_pool_machine() { printf '%s\n' "$1" >> "$resize_calls"; touch "$resize_marker"; }
FLY() { [ -f "$resize_marker" ] && printf '%s\n' "$shape_after" || printf '%s\n' "$POOL_INVENTORY_JSON"; }
normalize_current_pool_shape || fail "existing stopped pool shape did not normalize"
[ "$(cat "$resize_calls")" = "old-shape" ] ||
  fail "pool normalizer must mutate only the mismatched stopped machine"
unset -f pool_machine_shape_from_json normalize_current_pool_shape resize_pool_machine FLY

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

lock_wait_attempts=0
lock_wait_sleeps=0
cloudbench_controller_lock_acquire() {
  lock_wait_attempts=$((lock_wait_attempts + 1))
  [ "$lock_wait_attempts" -ge 3 ]
}
sleep() {
  [ "$1" = "7" ] || fail "controller lock wait used the wrong retry interval"
  lock_wait_sleeps=$((lock_wait_sleeps + 1))
}
cloudbench_controller_lock_acquire_wait "$lock_file" 7 ||
  fail "controller lock wait must continue until its live owner releases"
[ "$lock_wait_attempts" -eq 3 ] ||
  fail "controller lock wait must retry owned lock contention"
[ "$lock_wait_sleeps" -eq 2 ] ||
  fail "controller lock wait must sleep once per owned lock contention result"
unset -f cloudbench_controller_lock_acquire sleep

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
  'bash "$RUN_BENCH_CLOUD_BIN" --verify-secrets' \
  "fleet controller must read-only verify the environment before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_lock_acquire_wait' \
  "fleet controllers must wait for the workspace-local controller lock"
require_text "$ROOT_DIR/scripts/run-predeploy-cloud" \
  'bash "$ROOT_DIR/scripts/tests/cloudbench-multi-workstream.test.sh"' \
  "pre-deploy cloud gate must run the permanent concurrency regression"
require_text "$ROOT_DIR/scripts/run-predeploy-cloud" \
  'bash "$ROOT_DIR/scripts/tests/cloudbench-acceptance-autoscale.test.sh"' \
  "pre-deploy cloud gate must reject every autoscale off-state"
require_text "$ROOT_DIR/.claude/commands/deploy.md" \
  'bash scripts/tests/cloudbench-acceptance-autoscale.test.sh' \
  "deploy must execute the permanent mandatory-autoscale regression"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_VERIFIED=1' \
  "fleet children must receive proof that the controller verified the environment"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'write_pool_claim "$claim_path"' \
  "pool claims must use the atomic host/PID-birth ownership writer"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'printf '"'"'pid_start=%s\n'"'"' "$FLEET_OWNER_PID_START"' \
  "pool and fleet ownership must disambiguate PID reuse"
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
