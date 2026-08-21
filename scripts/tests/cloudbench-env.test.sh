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
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  "export BENCHMARK_REQUIRE_SEED_DUMP=1" \
  "cloud benchmarks must fail closed instead of replacing the canonical base"
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

# Stale BACKEND_ENV_B64 without AgentCard Organization OAuth must fail closed
# before guests burn a full stack on 502 Missing AGENTCARD_ORG_OAUTH_CLIENT_ID.
if cloudbench_require_agentcard_org_oauth "$backend_env" >/dev/null 2>&1; then
  fail "backend env without AgentCard org OAuth must fail closed"
fi
printf 'AGENTCARD_ORG_OAUTH_CLIENT_ID=01234567890123456789\nAGENTCARD_ORG_OAUTH_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz012345\n' >> "$backend_env"
cloudbench_require_agentcard_org_oauth "$backend_env" >/dev/null
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_require_agentcard_org_oauth "$REPO_DIR/back-end/.env"' \
  "cloudbench-run must require AgentCard org OAuth after decoding BACKEND_ENV_B64"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_require_agentcard_org_oauth back-end/.env' \
  "run-bench-cloud must refuse to stage a BACKEND_ENV_B64 without AgentCard org OAuth"

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
[ "$termination_elapsed" -lt 20 ] ||
  fail "a TERM-responsive child waited like the removed 30s watchdog (elapsed=${termination_elapsed}s)"
if kill -0 "$terminating_pid" 2>/dev/null; then
  fail "the terminated child must not survive cleanup"
fi
termination_start="$SECONDS"
cloudbench_terminate_and_wait 5 ""
termination_elapsed=$((SECONDS - termination_start))
[ "$termination_elapsed" -lt 2 ] ||
  fail "an empty PID list must return immediately (elapsed=${termination_elapsed}s)"

# A durable supervisor waits on an identity-fenced detached process rather than
# pulling that process back into its vulnerable launcher session. Preserve exact
# nonzero status (including the poller's typed capacity-busy code), forward
# cooperative cancellation, and fail promptly when a wrapper exits without the
# promised status marker.
tracked_owner="$TMP_ROOT/tracked.owner"
tracked_status="$TMP_ROOT/tracked.status"
tracked_log="$TMP_ROOT/tracked.log"
cloudbench_detach_reexec_tracked "$tracked_owner" "$tracked_log" \
  bash -c 'printf "75\n" > "$1"; exit 75' tracked-exit "$tracked_status"
tracked_rc=0
cloudbench_wait_tracked_detached "$tracked_owner" "$tracked_status" || tracked_rc=$?
[ "$tracked_rc" -eq "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE" ] ||
  fail "detached rendezvous changed capacity-busy exit 75 to $tracked_rc"

missing_owner="$TMP_ROOT/missing.owner"
missing_status="$TMP_ROOT/missing.status"
missing_recovered="$TMP_ROOT/missing.recovered"
cloudbench_detach_reexec_tracked "$missing_owner" "$TMP_ROOT/missing.log" \
  bash -c 'exit 0'
missing_started="$SECONDS"
missing_rc=0
cloudbench_wait_tracked_detached "$missing_owner" "$missing_status" \
  bash -c ': > "$1"' tracked-recovery "$missing_recovered" \
  >/dev/null 2>&1 || missing_rc=$?
[ "$missing_rc" -eq 1 ] ||
  fail "a detached wrapper without status must fail closed (exit=$missing_rc)"
[ -e "$missing_recovered" ] ||
  fail "a dead detached wrapper must invoke durable ownership recovery"
[ $((SECONDS - missing_started)) -lt 10 ] ||
  fail "a detached wrapper without status caused an unbounded wait"

cancel_owner="$TMP_ROOT/cancel.owner"
cancel_status="$TMP_ROOT/cancel.status"
cancel_recovered="$TMP_ROOT/cancel.recovered"
cloudbench_detach_reexec_tracked "$cancel_owner" "$TMP_ROOT/cancel.log" \
  bash -c '
    status_file="$1"
    status=1
    trap '"'"'printf "%s\n" "$status" > "$status_file"'"'"' EXIT
    trap '"'"'status=143; exit 143'"'"' TERM
    sleep 30
    status=0
  ' tracked-cancel "$cancel_status"
( sleep 1; kill -TERM "$$" ) &
cancel_signal_pid=$!
cancel_started="$SECONDS"
cancel_rc=0
cloudbench_wait_tracked_detached "$cancel_owner" "$cancel_status" \
  bash -c ': > "$1"' tracked-recovery "$cancel_recovered" \
  >/dev/null 2>&1 || cancel_rc=$?
wait "$cancel_signal_pid" 2>/dev/null || true
[ "$cancel_rc" -eq 143 ] ||
  fail "detached rendezvous did not preserve forwarded TERM status (exit=$cancel_rc)"
[ -e "$cancel_recovered" ] ||
  fail "forwarded detached cancellation must invoke durable ownership recovery"
[ $((SECONDS - cancel_started)) -lt 10 ] ||
  fail "forwarded TERM did not stop the detached process group promptly"

# A wrapper may publish its cooperative 143 while a TERM-resistant descendant
# remains in the owned group. The marker must not let the waiter return early:
# escalation and group drain remain part of the cancellation contract.
lingering_owner="$TMP_ROOT/lingering.owner"
lingering_status="$TMP_ROOT/lingering.status"
lingering_child_pid_file="$TMP_ROOT/lingering-child.pid"
cloudbench_detach_reexec_tracked "$lingering_owner" "$TMP_ROOT/lingering.log" \
  bash -c '
    status_file="$1"
    child_pid_file="$2"
    status=1
    trap '"'"'printf "%s\n" "$status" > "$status_file"'"'"' EXIT
    trap '"'"'status=143; exit 143'"'"' TERM
    (
      trap "" TERM
      printf "%s\n" "${BASHPID:-$$}" > "$child_pid_file"
      sleep 30
    ) &
    wait
  ' tracked-lingering "$lingering_status" "$lingering_child_pid_file"
for _ in $(seq 1 100); do
  [ -s "$lingering_child_pid_file" ] && break
  sleep 0.01
done
[ -s "$lingering_child_pid_file" ] ||
  fail "the TERM-resistant detached descendant must become ready"
lingering_child_pid="$(head -1 "$lingering_child_pid_file")"
( sleep 1; kill -TERM "$$" ) &
lingering_signal_pid=$!
lingering_started="$SECONDS"
lingering_rc=0
CLOUDBENCH_DETACHED_RECOVERY_SECONDS=2 \
  cloudbench_wait_tracked_detached "$lingering_owner" "$lingering_status" \
  bash -c 'exit 0' \
  >/dev/null 2>&1 || lingering_rc=$?
wait "$lingering_signal_pid" 2>/dev/null || true
[ "$lingering_rc" -eq 143 ] ||
  fail "group-drained cancellation changed the wrapper's 143 status (exit=$lingering_rc)"
[ $((SECONDS - lingering_started)) -ge 2 ] ||
  fail "the waiter accepted status 143 before the detached group drained"
[ $((SECONDS - lingering_started)) -lt 10 ] ||
  fail "a lingering TERM-resistant descendant caused an unbounded wait"
if kill -0 "$lingering_child_pid" 2>/dev/null; then
  fail "the TERM-resistant detached descendant survived KILL escalation"
fi

# Cooperative cancellation must also be bounded when every process in the
# detached group ignores TERM. A status marker must not be required for KILL
# escalation, and the waiter must not return until the owned group is drained.
resistant_owner="$TMP_ROOT/resistant.owner"
resistant_status="$TMP_ROOT/resistant.status"
cloudbench_detach_reexec_tracked "$resistant_owner" "$TMP_ROOT/resistant.log" \
  bash -c 'trap "" TERM; sleep 30'
resistant_pgid="$(cloudbench_tracked_owner_value "$resistant_owner" pgid)"
( sleep 1; kill -TERM "$$" ) &
resistant_signal_pid=$!
resistant_started="$SECONDS"
resistant_rc=0
CLOUDBENCH_DETACHED_RECOVERY_SECONDS=2 \
  cloudbench_wait_tracked_detached "$resistant_owner" "$resistant_status" \
  bash -c 'exit 0' \
  >/dev/null 2>&1 || resistant_rc=$?
wait "$resistant_signal_pid" 2>/dev/null || true
[ "$resistant_rc" -eq 1 ] ||
  fail "a TERM-resistant detached group without status must fail closed (exit=$resistant_rc)"
[ $((SECONDS - resistant_started)) -lt 10 ] ||
  fail "a TERM-resistant detached process group caused an unbounded wait"
if cloudbench_process_group_exists "$resistant_pgid"; then
  fail "the TERM-resistant detached process group survived KILL escalation"
fi

# A tracked autoscaler can be blocked inside a nested provider command. Killing
# only its direct shell reparents that descendant, allowing it to mutate durable
# ownership after controller cleanup returns. Tree teardown must kill the full
# captured process forest, including a TERM-resistant leaf.
tree_ready="$TMP_ROOT/tree-ready"
tree_leaf_pid="$TMP_ROOT/tree-leaf.pid"
tree_leaked="$TMP_ROOT/tree-leaked"
bash -c '
  trap "exit 0" TERM
  (
    trap "" TERM
    printf "%s\n" "${BASHPID:-$$}" > "$1"
    : > "$2"
    sleep 30
    : > "$3"
  ) &
  wait
' tree-test "$tree_leaf_pid" "$tree_ready" "$tree_leaked" &
tree_root_pid=$!
for _ in $(seq 1 100); do
  [ -e "$tree_ready" ] && break
  sleep 0.01
done
[ -e "$tree_ready" ] || fail "the descendant-tree test child must become ready"
tree_leaf="$(cat "$tree_leaf_pid")"
cloudbench_terminate_tree_and_wait 1 "$tree_root_pid"
if kill -0 "$tree_root_pid" 2>/dev/null || kill -0 "$tree_leaf" 2>/dev/null; then
  fail "tracked controller descendants must not survive tree cleanup"
fi
[ ! -e "$tree_leaked" ] ||
  fail "an orphaned descendant mutated state after controller cleanup"

# A completed job's numeric PID is stale ownership, even if another process now
# has that PID. The helper must intersect roots with this shell's live job table
# before it ever calls kill.
stale_signal_log="$TMP_ROOT/stale-signals.log"
(
  kill() {
    printf '%s\n' "$*" >> "$stale_signal_log"
  }
  cloudbench_terminate_tree_and_wait 0 999999
)
[ ! -e "$stale_signal_log" ] ||
  fail "tree cleanup signaled a stale root that is not a live shell job"

# A descendant may exit after TERM while a resistant sibling holds the grace
# period open. Deterministically model PID reuse at that boundary: the initial
# snapshot and first identity read name the owned process, then every later read
# reports a different birth time. Escalation must not SIGKILL the replacement.
identity_signal_log="$TMP_ROOT/identity-signals.log"
identity_ps_count="$TMP_ROOT/identity-ps-count"
printf '0\n' > "$identity_ps_count"
(
  jobs() {
    printf '4242\n'
  }
  ps() {
    if [ "${1:-}" = "-axo" ]; then
      printf '4242 1 Mon Jan  1 00:00:00 2001\n'
      return
    fi
    count="$(cat "$identity_ps_count")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$identity_ps_count"
    if [ "$count" -eq 1 ]; then
      printf 'Mon Jan  1 00:00:00 2001\n'
    else
      printf 'Tue Jan  2 00:00:00 2001\n'
    fi
  }
  kill() {
    printf '%s\n' "$*" >> "$identity_signal_log"
  }
  wait() {
    return 0
  }
  cloudbench_terminate_tree_and_wait 0 4242
)
[ "$(wc -l < "$identity_signal_log" | tr -d ' ')" = "1" ] ||
  fail "tree cleanup signaled a PID after its birth identity changed"
if grep -q -- '-KILL' "$identity_signal_log"; then
  fail "tree cleanup SIGKILLed a reused PID"
fi

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
fleet_production_function() {
  awk -v function_name="$1" '
    $0 ~ "^" function_name "\\(\\)" { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-fleet"
}
for function_name in worker_ledger_lock_acquire worker_ledger_lock_release; do
  function_source="$(fleet_production_function "$function_name")"
  [ -n "$function_source" ] || fail "could not load production function $function_name"
  eval "$function_source"
done
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
machine_volume_id() { printf 'vol-primary-owned'; }
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
  fleet_registry_release_name machine_volume_id machine_storage_ready machine_storage_failed fly_with_timeout \
  worker_ledger_lock_acquire worker_ledger_lock_release fleet_production_function

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

# Warm-source fleet gate: transitional donor states must wait for stopped, not
# abort (observed: state=started / replacing → immediate fleet INFRA fail).
printf 'replacing\nstopping\nstopped\n' > "$machine_states"
cloudbench_wait_machine_stopped read_machine_state warm-1 5 0 ||
  fail "warm source wait must tolerate replacing→stopping→stopped"
[ ! -s "$machine_states" ] || fail "the stopped-state wait must consume the transition sequence"

printf 'creating\nupdating\nrestarting\nstopped\n' > "$machine_states"
cloudbench_wait_machine_stopped read_machine_state warm-2 5 0 ||
  fail "warm source wait must tolerate creating/updating/restarting as transitional"
[ ! -s "$machine_states" ] || fail "creating/updating/restarting wait must consume the sequence"

printf 'started\nstarted\nstarted\n' > "$machine_states"
if cloudbench_wait_machine_stopped read_machine_state warm-stuck 3 0 >/dev/null 2>&1; then
  fail "warm source wait must fail closed when the donor never stops"
fi

printf 'started\ndestroyed\n' > "$machine_states"
if cloudbench_wait_machine_stopped read_machine_state warm-gone 3 0 >/dev/null 2>&1; then
  fail "warm source wait must fail closed when the donor is destroyed"
fi

require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_wait_machine_stopped pool_machine_state "$WARM_ID"' \
  "fleet must wait for the shared warm source to stop before cloning"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'stopping|replacing|starting)' \
  "machine start must wait out Fly stopping/replacing before request_machine_start"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'build_controller_authenticated_git_sync_cmd' \
  "controller authenticated git-sync helper must remain available for stdin/SFTP delivery"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'ssh_exec_controller_git_sync' \
  "controller git-sync must deliver the auth header via stdin, not argv"


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
  'REQUIRED_APP_SECRETS="AGENTS_ENV_B64 BACKEND_ENV_B64 AGENTS_ENV_SHA256 BACKEND_ENV_SHA256 CLOUDBENCH_BROWSER_PROVIDER GITHUB_TOKEN"' \
  "environment preflight must require GITHUB_TOKEN for on-box private-repo git-sync"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_durable_github_token' \
  "Fly secret injection must use a durable GitHub token, not an ephemeral gh auth token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'GITHUB_DISPATCH_TOKEN' \
  "token resolution must fall back to GITHUB_DISPATCH_TOKEN when GITHUB_TOKEN is stale"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'warm_source_fetch_ref' \
  "refresh-deps/wmh must sync via warm_source_fetch_ref (controller token + fetch-ref.sh)"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  't="${GITHUB_TOKEN:-${GH_TOKEN:-}}"' \
  "resolve_github_token must honor exported GITHUB_TOKEN/GH_TOKEN before durable dotenv fallback"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_github_token' \
  "warm-source git-sync must Contents-validate via resolve_github_token"

# Owning-boundary regression: a stale/empty warm-box GITHUB_TOKEN must not be
# the only auth path for refresh-deps. warm_source_fetch_ref uses the controller
# token + cloudbench-fetch-ref.sh (same as guest drivers).
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench-fetch-ref.sh' \
  "refresh-deps SSH sync must use cloudbench-fetch-ref.sh with a controller token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'warm_source_fetch_ref "$mid" "$EXPECTED_REF"' \
  "refresh-deps must call warm_source_fetch_ref for the exact expected ref"
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

# ── Ledger-only unpushed HEAD must not abort a fleet launch ──────────────────
# RCA (2026-07-27): /descend commits its append-only timing ledger before every
# sync, so a descent starting from a clean branch has exactly one unpushed
# commit touching only agents/benchmarks/history/*.jsonl. run-bench-fleet gated
# patch creation on "local HEAD != fetchable base", but create-worktree-patch.sh
# deliberately EXCLUDES those union-merge ledgers, so it emitted an empty patch
# and the controller treated empty as fatal:
#   "❌ could not create the fleet local workspace patch" → exit 1, zero benches.
# The gate and the patch content must share one definition of "shippable delta",
# and "nothing to ship" must run the base ref instead of aborting.
patch_repo="$TMP_ROOT/ledger-only-repo"
mkdir -p "$patch_repo/agents/benchmarks/history"
git -C "$patch_repo" init -q
git -C "$patch_repo" config user.email "bench@example.com"
git -C "$patch_repo" config user.name "Bench"
printf 'print("under test")\n' > "$patch_repo/service.py"
printf '{"run":"a"}\n' > "$patch_repo/agents/benchmarks/history/descend_steps.jsonl"
git -C "$patch_repo" add -A
git -C "$patch_repo" commit -qm "base"
ledger_base="$(git -C "$patch_repo" rev-parse HEAD)"

# The one unpushed commit a /descend run always makes before syncing.
printf '{"run":"b"}\n' >> "$patch_repo/agents/benchmarks/history/descend_steps.jsonl"
git -C "$patch_repo" add -A
git -C "$patch_repo" commit -qm "chore(descend): timing ledger rows"

# Pre-condition: the patch generator itself succeeds but has nothing to ship.
ledger_patch="$TMP_ROOT/ledger-only.patch"
bash "$ROOT_DIR/scripts/create-worktree-patch.sh" "$patch_repo" "$ledger_base" > "$ledger_patch" \
  || fail "create-worktree-patch.sh must succeed for a ledger-only delta"
if [ -s "$ledger_patch" ]; then
  fail "ledger-only delta must produce an empty patch (the excluded-ledger contract)"
fi

# A ledger-only delta must be reported as "no shippable delta", not as failure.
prepared_patch="$TMP_ROOT/prepared.patch"
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "$ledger_base" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" || prepare_rc=$?
if [ "$prepare_rc" -ne "$CLOUDBENCH_PATCH_NO_DELTA" ]; then
  fail "ledger-only unpushed HEAD must report no-shippable-delta (rc=$CLOUDBENCH_PATCH_NO_DELTA), got rc=$prepare_rc"
fi
if [ -s "$prepared_patch" ]; then
  fail "no-shippable-delta must not leave a declared patch payload behind"
fi

# A real source change on top of the same ledger commit must still ship.
printf 'print("changed")\n' > "$patch_repo/service.py"
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "$ledger_base" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" || prepare_rc=$?
[ "$prepare_rc" -eq 0 ] \
  || fail "a real worktree change must still produce a shippable patch (rc=$prepare_rc)"
[ -s "$prepared_patch" ] \
  || fail "a real worktree change must produce a non-empty patch payload"
grep -Fq 'service.py' "$prepared_patch" \
  || fail "the shippable patch must carry the changed source file"
if grep -Fq 'descend_steps.jsonl' "$prepared_patch"; then
  fail "the shippable patch must still exclude append-only history ledgers"
fi

# A commit that exists only on a pushed feature branch is NOT guest-fetchable.
# Fly guests authenticate through the controller token helper; treating any
# origin/* containment as "already fetchable" made --refresh-deps fetch a
# feature SHA over unauthenticated HTTPS and abort the fleet
# (could not read Username for 'https://github.com').
feature_repo="$TMP_ROOT/fetchable-ref"
git init -q "$feature_repo"
git -C "$feature_repo" config user.email cloudbench-test@example.com
git -C "$feature_repo" config user.name cloudbench-test
printf 'main\n' > "$feature_repo/payload.txt"
git -C "$feature_repo" add payload.txt
git -C "$feature_repo" commit -qm main
git -C "$feature_repo" branch -M main
git init -q --bare "$TMP_ROOT/fetchable-origin.git"
git -C "$feature_repo" remote add origin "$TMP_ROOT/fetchable-origin.git"
git -C "$feature_repo" push -q origin HEAD:main
main_sha="$(git -C "$feature_repo" rev-parse HEAD)"
git -C "$feature_repo" checkout -q -b cursor/example-53b6
printf 'feature\n' >> "$feature_repo/payload.txt"
git -C "$feature_repo" commit -qam feature
git -C "$feature_repo" push -q origin HEAD:cursor/example-53b6
feature_sha="$(git -C "$feature_repo" rev-parse HEAD)"
git -C "$feature_repo" fetch -q origin
resolved="$(cloudbench_fetchable_ref "$feature_repo" "$feature_sha" 1)"
[ "$resolved" = "$main_sha" ] \
  || fail "fetchable_ref must use origin/main for a feature-only SHA (got $resolved, want $main_sha)"
if ! cloudbench_fetchable_ref "$feature_repo" "$feature_sha" 1 >/dev/null 2>"$TMP_ROOT/fetchable.err"; then
  fail "allow-local-patch must succeed by falling back to origin/main"
fi
grep -Fq 'not on origin' "$TMP_ROOT/fetchable.err" \
  || fail "fetchable_ref must explain that a feature-only SHA is not guest-fetchable"

# A genuinely broken generation (unresolvable base ref) stays a hard failure.
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "definitely-not-a-ref" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" >/dev/null 2>&1 || prepare_rc=$?
if [ "$prepare_rc" -ne 1 ]; then
  fail "an unresolvable base ref must stay a hard patch-generation failure (rc=$prepare_rc)"
fi

# Both cloud controllers must route through the shared helper so the launch gate
# can never again disagree with what the patch generator actually emits.
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_prepare_workspace_patch' \
  "fleet controller must prepare its patch through the shared helper"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_prepare_workspace_patch' \
  "cloud controller must prepare its patch through the shared helper"


# ── Machine readiness must fail closed (descend antibot, epoch 4) ────────────
# A whole 7-bench fleet run aborted before provisioning ANY task machine:
#   ▶️  Starting machine 683e47df5094d8 ...
#   ✅ Machine started
#   ⚠️  SSH did not become reachable on 683e47df5094d8 — proceeding (...)
#   🔄 git-syncing /data/repo → f56705fec ...
#      Error: app navi-whisper-lux-bench has no started VMs.
#   ❌ exact remote checkout failed
#   ❌ central dep refresh failed; refusing to provision task machines
# Both readiness gates returned SUCCESS after exhausting their budgets, so the
# controller exec'd into a machine that was not up and the real constraint
# surfaced as an unrelated-looking checkout error. Readiness must fail closed.
readiness_function() {
  awk -v function_name="$1" '
    $0 ~ "^" function_name "\\(\\)" { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud"
}

readiness_failures=0

# The shared warm source is durable provider state and can retain a stale or
# malformed init command across workstreams. Every maintenance resize must
# restore the known keepalive before start; otherwise Fly reports "started" and
# the VM exits cleanly seconds later.
(
  function_body="$(readiness_function resize_stopped_warm_source)"
  [ -n "$function_body" ] || fail "could not load production resize_stopped_warm_source"
  eval "$function_body"
  APP="cloudbench-readiness-regression"
  resize_args="$TMP_ROOT/warm-resize.args"
  machine_state() { echo stopped; }
  FLY() { printf '%s\n' "$*" > "$resize_args"; }
  resize_stopped_warm_source warm-1 shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "warm-source maintenance resize must succeed"
  grep -Fq -- '--command sleep infinity' "$resize_args" ||
    fail "warm-source resize must normalize the durable keepalive command"
) || readiness_failures=$((readiness_failures + 1))

(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  APP="cloudbench-readiness-regression"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=2
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  CLOUDBENCH_SSH_PROBE_TIMEOUT_SECONDS=1
  probe_calls=0
  raw_fly_calls=0
  ssh_ready() {
    probe_calls=$((probe_calls + 1))
    return 1
  }
  FLY() {
    raw_fly_calls=$((raw_fly_calls + 1))
    return 1
  }
  machine_state() { echo started; }
  sleep() { :; }               # keep the pre-fix reproduction fast
  rc=0
  wait_for_ssh mach-never-ssh >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "wait_for_ssh must fail closed when SSH never answers (rc=$rc)"
  [ "$probe_calls" -eq 2 ] ||
    fail "wait_for_ssh must use the bounded ssh_ready probe exactly once per attempt"
  [ "$raw_fly_calls" -eq 0 ] ||
    fail "wait_for_ssh must not bypass the bounded SSH timeout path"
) || readiness_failures=$((readiness_failures + 1))

(
  function_body="$(readiness_function start_machine)"
  [ -n "$function_body" ] || fail "could not load production start_machine"
  eval "$function_body"
  CLOUDBENCH_MACHINE_START_ATTEMPTS=2
  CLOUDBENCH_MACHINE_START_SLEEP_SECONDS=0
  machine_state() { echo stopped; }        # never reaches started
  machine_storage_ready() { return 0; }
  request_machine_start() { return 0; }
  sleep() { :; }               # keep the pre-fix reproduction fast
  rc=0
  start_machine mach-never-starts >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "start_machine must fail closed when the machine never reaches started (rc=$rc)"
) || readiness_failures=$((readiness_failures + 1))

# A recoverable started→stopped race must re-assert start (after waiting out
# Fly stopping/replacing), then accept the bounded readiness proof.
(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=2
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  current_state=stopped
  restart_calls=0
  ssh_ready() { [ "$current_state" = "started" ]; }
  machine_state() { echo "$current_state"; }
  request_machine_start() {
    restart_calls=$((restart_calls + 1))
    current_state=started
  }
  date() { echo 1000; }
  sleep() { :; }
  wait_for_ssh mach-recovers >/dev/null 2>&1 ||
    fail "wait_for_ssh must recover one stopped→started transition"
  [ "$restart_calls" -eq 1 ] ||
    fail "wait_for_ssh must re-assert a regressed machine start (calls=$restart_calls)"
) || readiness_failures=$((readiness_failures + 1))

# If the machine is still stopping when SSH probes, wait — do not fire a bare
# start into Fly's failed_precondition window (files-in-sub-agents fleet log).
(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=5
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  # machine_state runs in $(...), so the cursor must live on disk — a shell
  # variable would reset every probe and never leave "stopping".
  # Timeline: stopping → stopping → stopped → (start issued) → started
  idx_file="$TMP_ROOT/wait-ssh-stopping-idx"
  echo 0 > "$idx_file"
  states_file="$TMP_ROOT/wait-ssh-stopping-states"
  printf '%s\n' stopping stopping stopped started started > "$states_file"
  restart_file="$TMP_ROOT/wait-ssh-stopping-restarts"
  echo 0 > "$restart_file"
  current_state() {
    local idx
    idx="$(cat "$idx_file")"
    sed -n "$((idx + 1))p" "$states_file"
  }
  advance_state() {
    local idx
    idx="$(cat "$idx_file")"
    if [ "$idx" -lt 4 ]; then
      echo $((idx + 1)) > "$idx_file"
    fi
  }
  ssh_ready() {
    [ "$(current_state)" = "started" ]
  }
  machine_state() {
    local s
    s="$(current_state)"
    advance_state
    echo "$s"
  }
  request_machine_start() {
    echo $(( $(cat "$restart_file") + 1 )) > "$restart_file"
  }
  date() { echo 1000; }
  sleep() { :; }
  wait_for_ssh mach-stopping-race >/dev/null 2>&1 ||
    fail "wait_for_ssh must survive stopping→stopped→started before SSH ready"
  [ "$(cat "$restart_file")" -eq 1 ] ||
    fail "wait_for_ssh must start exactly once after stopping clears (calls=$(cat "$restart_file"))"
) || readiness_failures=$((readiness_failures + 1))

# Exercise the maintenance gate itself: a failed start cannot reach the SSH
# probe, and a failed SSH proof cannot let the caller execute remote work.
(
  function_body="$(readiness_function require_machine_ready)"
  [ -n "$function_body" ] || fail "could not load production require_machine_ready"
  eval "$function_body"
  start_calls=0
  wait_calls=0
  start_machine() {
    start_calls=$((start_calls + 1))
    return 1
  }
  wait_for_ssh() {
    wait_calls=$((wait_calls + 1))
    return 0
  }
  rc=0
  require_machine_ready mach-never-starts >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "maintenance readiness must propagate start failure"
  [ "$start_calls" -eq 1 ] && [ "$wait_calls" -eq 0 ] ||
    fail "maintenance readiness must not probe SSH after start failure"

  start_machine() {
    start_calls=$((start_calls + 1))
    return 0
  }
  wait_for_ssh() {
    wait_calls=$((wait_calls + 1))
    return 1
  }
  remote_exec_marker="$TMP_ROOT/readiness-remote-exec"
  if require_machine_ready mach-never-ssh >/dev/null 2>&1; then
    : > "$remote_exec_marker"
  fi
  [ ! -e "$remote_exec_marker" ] ||
    fail "maintenance work executed after readiness failure"
) || readiness_failures=$((readiness_failures + 1))

# A readiness helper that fails closed is useless if a caller bypasses it. All
# three maintenance paths must use the combined gate, leaving the component
# start and SSH calls reachable only inside that gate.
readiness_call_sites="$(grep -c '^[[:space:]]*require_machine_ready "\$mid" || exit 1$' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
[ "$readiness_call_sites" = "3" ] ||
  fail "all 3 maintenance paths must propagate the combined readiness gate (found=$readiness_call_sites)"
start_call_sites="$(grep -c '^[[:space:]]*start_machine "' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
wait_call_sites="$(grep -c '^[[:space:]]*wait_for_ssh "' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
[ "$start_call_sites" = "1" ] && [ "$wait_call_sites" = "1" ] ||
  fail "start/SSH component calls must remain encapsulated by the readiness gate"

[ "$readiness_failures" -eq 0 ] ||
  fail "$readiness_failures machine-readiness regression case(s) failed"

# ── warm-source resize must retry Fly rate limits (descend I-02) ─────────────
# Epoch-2 fleet abort during --refresh-deps:
#   🧮 sizing warm source for maintenance: shared-cpu-4x/8192MB
#   Error: could not get machine … resource_exhausted: rate limit exceeded
#   ❌ central dep refresh failed; refusing to provision task machines
# Relative of 2026-07-15 clone rate-limit RCAs: resize_stopped_warm_source was
# single-shot, so a transient org limiter abort killed the whole slice before
# any task machine existed.
(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  [ -n "$function_body" ] || fail "could not load resize_stopped_warm_source"
  eval "$function_body"
  APP="cloudbench-resize-rate-limit"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=3
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  # FLY runs inside $(...), so a shell variable counter cannot cross attempts.
  call_file="$TMP_ROOT/warm-resize-calls"
  echo 0 > "$call_file"
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    local c
    c="$(cat "$call_file")"
    c=$((c + 1))
    echo "$c" > "$call_file"
    if [ "$c" -lt 3 ]; then
      echo "Error: could not get machine $3: resource_exhausted: rate limit exceeded" >&2
      return 1
    fi
    return 0
  }
  resize_stopped_warm_source mid-rl shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "resize_stopped_warm_source must succeed after rate-limit retries"
  [ "$(cat "$call_file")" -eq 3 ] ||
    fail "resize_stopped_warm_source must retry rate limits until success (calls=$(cat "$call_file"))"
) || fail "warm-source resize rate-limit retry regression failed"

(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  eval "$function_body"
  APP="cloudbench-resize-rate-limit"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=2
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    echo "Error: could not get machine $3: resource_exhausted: rate limit exceeded" >&2
    return 1
  }
  rc=0
  resize_stopped_warm_source mid-rl shared-cpu-4x 8192 maintenance >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "resize_stopped_warm_source must fail closed after exhausting rate-limit retries"
) || fail "warm-source resize rate-limit exhaustion regression failed"

(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  eval "$function_body"
  APP="cloudbench-resize-concurrent"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=3
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  call_file="$TMP_ROOT/warm-resize-concurrent-calls"
  echo 0 > "$call_file"
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    local c
    c="$(cat "$call_file")"
    c=$((c + 1))
    echo "$c" > "$call_file"
    if [ "$c" -lt 3 ]; then
      echo "Error: aborted: machine version changed: concurrent update in progress" >&2
      return 1
    fi
    return 0
  }
  resize_stopped_warm_source mid-cu shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "resize_stopped_warm_source must retry concurrent-update aborts"
  [ "$(cat "$call_file")" -eq 3 ] ||
    fail "concurrent-update retries must reach success (calls=$(cat "$call_file"))"
) || fail "warm-source resize concurrent-update retry regression failed"

# ── refresh-deps / refresh-wmh git-sync must use controller token (descend I-01) ──
# Observed fleet abort before any task machine was provisioned:
#   🔄 git-syncing /data/repo → <sha> ...
#      fatal: could not read Username for 'https://github.com': No such device or address
#      Error: ssh shell: Process exited with status 128
#   ❌ exact remote checkout failed
#   ❌ central dep refresh failed; refusing to provision task machines
# Root cause: --refresh-deps built AUTH_HDR from optional box-side GITHUB_TOKEN
# (`[ -n "${GITHUB_TOKEN:-}" ] && AUTH_HDR=...`). When the warm machine secret was
# missing, AUTH_HDR stayed empty and git prompted for a Username on a non-TTY.
# Boot-launch already injects CLOUDBENCH_GITHUB_TOKEN_B64 from the controller;
# maintenance git-sync must fail closed the same way and never allow empty auth.
python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY' || fail "refresh-deps/wmh controller-token git-sync contract failed"
import pathlib, re, subprocess, sys, textwrap

src_path = pathlib.Path(sys.argv[1])
src = src_path.read_text()

def mode_block(mode: str) -> str:
    marker = f'if [ "$MODE" = "{mode}" ]; then'
    start = src.find(marker)
    if start < 0:
        raise SystemExit(f"missing {mode} mode block")
    # Take until the matching top-level fi after the mode banner — stop at next MODE block or EOF.
    rest = src[start:]
    next_mode = re.search(r'\nif \[ "\$MODE" = "', rest[1:])
    end = (next_mode.start() + 1) if next_mode else len(rest)
    return rest[:end]

deps = mode_block("refresh-deps")
wmh = mode_block("refresh-wmh")
# refresh-deps + refresh-wmh: shared SHA-pinned warm_source_fetch_ref (fail-closed).
for name, block in (("refresh-deps", deps), ("refresh-wmh", wmh)):
    if "warm_source_fetch_ref" not in block:
        raise SystemExit(f"{name} must call warm_source_fetch_ref")
    for line in block.splitlines():
        if "warm_source_fetch_ref" in line and "|| true" in line:
            raise SystemExit(f"{name} must not mask warm_source_fetch_ref failures")
    if "GITHUB_TOKEN:-" in block and "build_controller_authenticated_git_sync_cmd" in block:
        raise SystemExit(f"{name} must not optionally skip AUTH_HDR when box GITHUB_TOKEN is empty")

def extract_bash_function(source: str, name: str) -> str:
    marker = f"{name}() {{"
    start = source.find(marker)
    if start < 0:
        # Allow a comment between ) and {
        import re as _re
        m = _re.search(rf"^{name}\(\)[^\n]*\n\{{", source, flags=_re.M)
        if not m:
            raise SystemExit(f"{name} helper is missing")
        start = m.start()
        brace_at = source.find("{", m.start())
    else:
        brace_at = source.find("{", start)
    depth = 0
    for idx in range(brace_at, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise SystemExit(f"{name} helper is missing closing brace")

# warm_source_fetch_ref must Contents-validate via resolve_github_token (not
# unvalidated cloudbench_controller_github_token).
warm_fn = extract_bash_function(src, "warm_source_fetch_ref")
if "resolve_github_token" not in warm_fn:
    raise SystemExit("warm_source_fetch_ref must use resolve_github_token")
if "cloudbench_controller_github_token" in warm_fn:
    raise SystemExit("warm_source_fetch_ref must not use unvalidated cloudbench_controller_github_token")

# --setup clone: keep AUTH_HDR off git argv; use GIT_CONFIG_GLOBAL; wipe remotes
# on partial SFTP failure so a lone token file cannot linger.
clone_start = src.find("SETUP_GITHUB_TOKEN=")
clone_end = src.find("park_warm_source", clone_start)
if clone_start < 0 or clone_end < 0:
    raise SystemExit("--setup clone block missing")
clone = src[clone_start:clone_end]
if "GIT_CONFIG_GLOBAL" not in clone:
    raise SystemExit("--setup clone must use GIT_CONFIG_GLOBAL for http.extraheader")
if "-c http.extraheader=" in clone:
    raise SystemExit("--setup clone must not put AUTH_HDR on git -c argv")
if "rm -f '$remote_setup_token' '$remote_setup_cmd'" not in clone:
    raise SystemExit("--setup must rm remote token/cmd on SFTP failure")
# Existing-repo fetch must reset origin to the trusted URL BEFORE git_auth so a
# retained/altered remote cannot receive the controller token.
fetch_idx = clone.find("repo already present")
if fetch_idx < 0:
    raise SystemExit("--setup existing-repo fetch branch missing")
fetch_branch = clone[fetch_idx : clone.find("else", fetch_idx)]
set_url_at = fetch_branch.find("remote set-url origin")
fetch_at = fetch_branch.find("fetch --quiet origin")
if set_url_at < 0 or fetch_at < 0 or set_url_at > fetch_at:
    raise SystemExit("--setup must set trusted origin before authenticated fetch")

helper = extract_bash_function(src, "build_controller_authenticated_git_sync_cmd")

auth_bits = [
    extract_bash_function(src, name)
    for name in (
        "token_to_git_auth_header",
        "resolve_durable_github_token",
        "resolve_github_token",
        "resolve_controller_git_auth_header",
    )
]
auth_helper = "\n".join(auth_bits)

deliver = extract_bash_function(src, "ssh_exec_controller_git_sync")
if "AUTH_HDR_DURABLE" not in deliver:
    raise SystemExit("stdin delivery must support durable AUTH_HDR_DURABLE retry")
if "resolve_durable_github_token" not in deliver:
    raise SystemExit("stdin delivery must resolve a durable fallback token")
if "sftp put" not in deliver:
    raise SystemExit("git-sync delivery must SFTP credentials (fly ssh -C does not forward stdin)")
if "Authorization: Basic" in deliver.split("-C", 1)[-1]:
    raise SystemExit("AUTH_HDR must not appear in the fly ssh -C argument")
if "remote_auth" not in deliver and "cloudbench-git-sync-auth" not in deliver:
    raise SystemExit("git-sync delivery must stage a remote auth file path")

# Fail closed with no token.
script = auth_helper + "\n" + helper + textwrap.dedent(
    """
    resolve_github_token() { echo ""; }
    resolve_durable_github_token() { echo ""; }
    gh() { return 1; }
    build_controller_authenticated_git_sync_cmd /data/repo abcdef
    """
)
# Run via a tempfile — bash -c mangles the nested quotes inside the multi-line
# helper body (syntax error EOF). File execution preserves the source exactly.
import tempfile, os
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    fail_path = fh.name
try:
    proc = subprocess.run(["bash", fail_path], capture_output=True, text=True)
finally:
    os.unlink(fail_path)
if proc.returncode == 0:
    raise SystemExit("helper must fail closed when no controller GitHub token is available")
if "No controller GitHub token" not in (proc.stderr + proc.stdout):
    raise SystemExit("helper must name the missing controller GitHub token")

# With a token, emit a script that consumes AUTH_HDR via GIT_CONFIG_* — never
# embed the Basic auth header in the returned command (argv leak via fly -C).
script = auth_helper + "\n" + helper + textwrap.dedent(
    """
    resolve_github_token() { echo "ghp_test_token_for_sync_cmd"; }
    resolve_durable_github_token() { echo "ghp_durable_token_for_sync_cmd"; }
    gh() { return 1; }
    build_controller_authenticated_git_sync_cmd /data/repo abcdef0123456789
    """
)
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    ok_path = fh.name
try:
    proc = subprocess.run(["bash", ok_path], capture_output=True, text=True)
finally:
    os.unlink(ok_path)
if proc.returncode != 0:
    raise SystemExit(f"helper must succeed with a controller token: {proc.stderr}")
cmd = proc.stdout
if "_try_fetch" not in cmd:
    raise SystemExit("authenticated sync cmd must use _try_fetch for primary→durable retry")
if "GIT_CONFIG_KEY_0=http.extraheader" not in cmd:
    raise SystemExit("authenticated sync cmd must set http.extraheader via GIT_CONFIG_*")
if "primary GitHub token auth failed; retrying with durable fallback" not in cmd:
    raise SystemExit("authenticated sync cmd must retry with durable AUTH_HDR_DURABLE")
if "GITHUB_TOKEN:-" in cmd:
    raise SystemExit("authenticated sync cmd must not optionally clear AUTH_HDR")
if "Authorization: Basic" in cmd or "x-access-token:" in cmd or "ghp_test_token" in cmd:
    raise SystemExit("authenticated sync cmd must not embed the controller token/header")
if "AUTH_HDR" not in cmd:
    raise SystemExit("authenticated sync cmd must require AUTH_HDR from the delivery path")
if "rev-parse FETCH_HEAD" not in cmd or 'checkout -f "$FETCHED_REF"' not in cmd:
    raise SystemExit("authenticated sync cmd must check out FETCH_HEAD, not a stale local ref")
if "checkout -f $ref_q" in cmd or "checkout -f \"$ref_q\"" in cmd:
    raise SystemExit("authenticated sync cmd must not check out the possibly-stale local ref name")

# Auth header resolver must produce x-access-token Basic payload separately.
script = auth_helper + textwrap.dedent(
    """
    resolve_github_token() { echo "ghp_test_token_for_sync_cmd"; }
    resolve_durable_github_token() { echo "ghp_durable_token_for_sync_cmd"; }
    gh() { return 1; }
    resolve_controller_git_auth_header
    """
)
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    hdr_path = fh.name
try:
    proc = subprocess.run(["bash", hdr_path], capture_output=True, text=True)
finally:
    os.unlink(hdr_path)
if proc.returncode != 0:
    raise SystemExit(f"auth header helper must succeed with a controller token: {proc.stderr}")
hdr = proc.stdout.strip()
if not hdr.startswith("Authorization: Basic "):
    raise SystemExit(f"auth header must be Authorization: Basic …, got {hdr!r}")
import base64
payload = base64.b64decode(hdr.split(" ", 2)[2]).decode()
if payload != "x-access-token:ghp_test_token_for_sync_cmd":
    raise SystemExit(f"AUTH_HDR payload must be x-access-token:…, got {payload!r}")
print("controller-token git-sync contract ok")
PY

# An unprovisioned worktree (plain `git worktree add`, no credentials copied)
# used to burn a full fleet launch and then die on a bare "BACKEND_API_KEY is
# required" line that named neither the file it read nor the provisioning step.
hub_key_guard="$(sed -n '/^require_in_app_hub_visibility()/,/^}/p' "$ROOT_DIR/scripts/run-bench-fleet")"
printf '%s' "$hub_key_guard" | grep -q 'looked in:' ||
  fail "the in-app Hub key failure must name every source it searched"
printf '%s' "$hub_key_guard" | grep -q 'back-end/.env does not exist' ||
  fail "the in-app Hub key failure must distinguish a missing .env from an empty key"
printf '%s' "$hub_key_guard" | grep -q 'prepare-deploy-worktree.sh' ||
  fail "the in-app Hub key failure must name the provisioning command that fixes it"

# ── Validated GitHub token for private-repo git-sync (descend I-01 + #1034) ──
# Fleet run 20260820-202356-7298 aborted before any task machine on a stale
# ambient GITHUB_TOKEN. Merged with #1034 durable/ephemeral split: ephemeral
# resolve_github_token validates Contents access; Fly secrets use durable tokens;
# refresh-deps retries durable fallback after primary auth failure.
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'github_token_can_fetch_repo()' \
  "cloudbench must validate GitHub tokens against the private rose repo"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'api.github.com/repos/Rose-Ai-Labs/rose/contents' \
  "token validation must require Contents access (not metadata-only GET /repos)"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_durable_github_token' \
  "Fly secret injection must use a durable GitHub token, not an ephemeral gh auth token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'set_args+=("GITHUB_TOKEN=$gh_token")' \
  "Fly secret staging must always set GITHUB_TOKEN (empty clears a stale staged credential)"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'env -u GITHUB_TOKEN -u GH_TOKEN -u GH_HOST gh auth token --hostname github.com' \
  "token resolver must ignore ambient GH_TOKEN/GITHUB_TOKEN/GH_HOST when reading gh auth"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  't="${GITHUB_TOKEN:-${GH_TOKEN:-}}"' \
  "resolve_github_token must honor exported GITHUB_TOKEN/GH_TOKEN before durable dotenv fallback"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'build_controller_authenticated_git_sync_cmd' \
  "controller authenticated git-sync helper must remain for stdin/SFTP delivery paths"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'primary GitHub token auth failed; retrying with durable fallback' \
  "authenticated git-sync must retry git fetch with the durable token after primary auth failure"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  '_try_fetch' \
  "authenticated git-sync must try controller primary token then durable fallback via _try_fetch"
# Prove the live resolver rejects the ambient stale GITHUB_TOKEN and still
# returns a credential with Contents access (requires network).
resolve_snippet="$(mktemp)"
awk '
  /^github_token_can_fetch_repo\(\)/ { capture = 1 }
  capture { print }
  capture && /^resolve_render_env_value\(\)/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud" | sed '$d' > "$resolve_snippet"
sed -i '/^resolve_render_env_value()/,$d' "$resolve_snippet"
(
  set -euo pipefail
  # shellcheck disable=SC1090
  source "$resolve_snippet"
  tok="$(resolve_github_token)"
  [ -n "$tok" ] || fail "resolve_github_token returned empty despite available controller credentials"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
    -H "Authorization: Bearer ${tok}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: cloudbench-env-test' \
    'https://api.github.com/repos/Rose-Ai-Labs/rose/contents')"
  [ "$code" = "200" ] || fail "resolve_github_token returned a token without Contents access to rose (HTTP $code)"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    stale_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: cloudbench-env-test' \
      'https://api.github.com/repos/Rose-Ai-Labs/rose/contents' || true)"
    if [ "$stale_code" != "200" ] && [ "$tok" = "$GITHUB_TOKEN" ]; then
      fail "resolve_github_token returned the ambient stale GITHUB_TOKEN"
    fi
  fi
) || fail "validated GitHub token resolver regression failed"
rm -f "$resolve_snippet"


require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'CLOUDBENCH_SSH_EXEC_TIMEOUT' \
  "ssh_exec must honor an optional timeout so hung refresh-deps sessions fail closed"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'ssh_exec timed out after' \
  "ssh_exec must report timeout distinctly from auth/checkout failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'CLOUDBENCH_SSH_EXEC_TIMEOUT="$SYNC_SSH_TIMEOUT"' \
  "refresh-deps must bound warm_source_fetch_ref via CLOUDBENCH_SSH_EXEC_TIMEOUT"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'return "$sync_rc"' \
  "warm_source_fetch_ref must preserve ssh_exec status including timeout 124"

# --single-box must reject at arg-parse time BEFORE cd/catalog work. The
# production-only classifier was inserted above this guard and, in the
# cloudbench-multi sandbox (no tasks.json), exited 2 before the parallel-safe
# message — failing scenario 14. Cement the order + catalog-free rejection.
single_box_guard="$(awk '/^if \[\[ "\$\{1:-\}" == "--single-box" \]\]/,/^fi$/' \
  "$ROOT_DIR/scripts/run-bench" | head -20)"
printf '%s\n' "$single_box_guard" | grep -qiF 'parallel-safe' ||
  fail "run-bench --single-box guard must explain the parallel-safety hazard"
# Guard must appear before the production-only classifier invocation.
python3 - "$ROOT_DIR/scripts/run-bench" <<'PY' || fail "run-bench --single-box must precede production-only classifier"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
sb = text.find('[[ "${1:-}" == "--single-box" ]]')
prod = text.find("cloudbench-production-only-tasks.py")
if sb < 0 or prod < 0 or not (sb < prod):
    raise SystemExit(f"single-box at {sb}, production-only at {prod}")
PY
sandbox_rb="$(mktemp -d)"
mkdir -p "$sandbox_rb/scripts" "$sandbox_rb/agents/benchmarks"
cp "$ROOT_DIR/scripts/run-bench" "$sandbox_rb/scripts/run-bench"
# No tasks.json — mirrors cloudbench-multi's synthetic worktree.
sb_out="$(mktemp)"
set +e
bash "$sandbox_rb/scripts/run-bench" --single-box some-bench >"$sb_out" 2>&1
sb_ec=$?
set -e
grep -qiF 'parallel-safe' "$sb_out" || {
  echo "--- run-bench --single-box output ---" >&2
  cat "$sb_out" >&2
  fail "catalog-free --single-box rejection must still explain parallel-safety"
}
[ "$sb_ec" -ne 0 ] || fail "catalog-free --single-box must exit nonzero"
rm -rf "$sandbox_rb" "$sb_out"

echo "All cloud benchmark environment checks passed."
