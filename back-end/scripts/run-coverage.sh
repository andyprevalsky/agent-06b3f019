#!/usr/bin/env bash
set -euo pipefail

# Run backend tests with code coverage collection.
#
# How it works:
#   1. Starts the backend server with NODE_V8_COVERAGE to collect raw V8 coverage data
#   2. Runs the blackbox test suite against it
#   3. Stops the server and uses c8 to generate the coverage report
#
# Usage:
#   bash scripts/run-coverage.sh              # Run with threshold enforcement
#   bash scripts/run-coverage.sh --report-only # Just report (no threshold check)
#   bash scripts/run-coverage.sh --print-coverage-port # Reserve, print, and release a port
#   bash scripts/run-coverage.sh --hold-coverage-lock # Test-only run-lock probe
#   bash scripts/run-coverage.sh --hold-coverage-lock-with-child # Test-only orphan cleanup probe

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/blackbox-phone-env.sh"
# Validated up front: the c8 report step's heap ceiling (coverage_report_node).
source "$SCRIPT_DIR/coverage-report-heap.sh"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

# Match run.sh and run-blackbox-tests.sh resource naming when Conductor still
# exposes a branch-derived workspace name. Coverage needs the worktree's
# isolated Postgres container, not a shared system-Postgres fallback.
cd "$ROOT_DIR"
source scripts/lib/workspace-env.sh
normalize_conductor_workspace_env
source "$SCRIPT_DIR/local-db-container.sh"
source "$SCRIPT_DIR/coverage-failure-evidence.sh"
cd "$BACKEND_DIR"

# This gate starts its own backend and signs its own benchmark-share fixtures.
# Give both the server and blackbox runner the same local-only signing key when
# no key was supplied; a production secret is not needed to verify the contract.
export BENCHMARK_SHARE_SECRET="${BENCHMARK_SHARE_SECRET:-blackbox-local-benchmark-share-secret}"

# Cursor Cloud (and similar) may inject BROWSER_PROVIDER into the process
# environment. Node dotenv does not override existing vars, so a stale value
# like "browserbase" wins over back-end/.env ("kernel") and the live
# browser-provider blackbox 500s on /init. Force a supported provider here.
case "${BROWSER_PROVIDER:-}" in
  tilion|kernel|steel) ;;
  *)
    echo "⚠️  BROWSER_PROVIDER='${BROWSER_PROVIDER:-}' is unsupported; forcing kernel for coverage."
    export BROWSER_PROVIDER=kernel
    ;;
esac

# Cursor Cloud injects TRACE_ARCHIVE_BACKEND=r2 from prod secrets. Node dotenv
# does not override it, so agent-trajectories / archive blackboxes write local
# fixtures in the test process while the backend reads R2 and returns 0 hits.
case "${TRACE_ARCHIVE_BACKEND:-}" in
  local|fake-r2) ;;
  *)
    echo "⚠️  TRACE_ARCHIVE_BACKEND='${TRACE_ARCHIVE_BACKEND:-}' is not a local blackbox backend; forcing local."
    export TRACE_ARCHIVE_BACKEND=local
    ;;
esac

# rose_user_ui versions are stored hermetically on local disk for tests (the
# user-ui blackbox reads back published bytes); prod uses Supabase Storage.
export USER_UI_STORAGE_BACKEND=local
# display-tool media (domains/display) uses the same hermetic local store.
export DISPLAY_STORAGE_BACKEND=local
# User-tool handlers (POST /api/user-ui/tools/run) run in a local code-session
# HOME instead of E2B; the backend refuses this mode in production.
export USER_TOOLS_SESSION_SANDBOX=local

# Read the effective value of KEY from back-end/.env using dotenv last-in-wins
# semantics (quoted values keep '#'; unquoted values drop inline comments).
dotenv_effective_value() {
  local env_name="$1"
  local value
  [[ -f "$BACKEND_DIR/.env" ]] || return 1
  value="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${env_name}=" "$BACKEND_DIR/.env" | tail -1 || true)"
  [[ -z "$value" ]] && return 1
  value="${value#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *)   value="${value%%#*}"
         value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# Cursor Cloud injects AGENTCARD_ORG_OAUTH_* / GITHUB_* as secrets. Those copies
# drift from Render (and from back-end/.env after operators rotate sandbox
# OAuth clients). Node dotenv will not override the injected values, so
# treasury-rails / test-payment / external-http blackboxes fail with 502/401
# even when .env is correct. Prefer .env for coverage so the gate tracks the
# credentials maintained in this worktree.
for _coverage_env_key in \
  AGENTCARD_ORG_OAUTH_CLIENT_ID \
  AGENTCARD_ORG_OAUTH_CLIENT_SECRET \
  GITHUB_DISPATCH_TOKEN \
  GITHUB_TOKEN
do
  if _coverage_env_val="$(dotenv_effective_value "$_coverage_env_key")"; then
    export "${_coverage_env_key}=${_coverage_env_val}"
  fi
done
unset _coverage_env_key _coverage_env_val

REPORT_ONLY=0
PRINT_COVERAGE_PORT=0
HOLD_COVERAGE_LOCK=0
HOLD_COVERAGE_LOCK_WITH_CHILD=0
for arg in "$@"; do
  [[ "$arg" == "--report-only" ]] && REPORT_ONLY=1
  [[ "$arg" == "--print-coverage-port" ]] && PRINT_COVERAGE_PORT=1
  [[ "$arg" == "--hold-coverage-lock" ]] && HOLD_COVERAGE_LOCK=1
  [[ "$arg" == "--hold-coverage-lock-with-child" ]] && HOLD_COVERAGE_LOCK_WITH_CHILD=1
done

# Optional shard / subset selection. A shard (BACKEND_COVERAGE_SHARD=i/N, run
# by scripts/run-coverage-sharded.sh) owns its own lock, raw V8 directory,
# artifacts and local database, and hands its raw coverage to the coordinator's
# merged threshold check. A subset (explicit BACKEND_COVERAGE_BLACKBOX_DOMAINS
# or BACKEND_UNIT_TEST_FILES, used by scripts/coverage-rerun-failed.sh) only
# re-proves failed tests: it cannot enforce thresholds, so a full run remains
# mandatory before merge.
COVERAGE_SHARD="${BACKEND_COVERAGE_SHARD:-}"
SHARD_SUFFIX=""
SHARD_DB_SUFFIX=""
if [[ -n "$COVERAGE_SHARD" ]]; then
  if ! [[ "$COVERAGE_SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] ||
    ((BASH_REMATCH[1] > BASH_REMATCH[2])); then
    echo "❌ BACKEND_COVERAGE_SHARD must be <index>/<count> with 1 <= index <= count." >&2
    exit 2
  fi
  SHARD_SUFFIX="-shard${BASH_REMATCH[1]}"
  SHARD_DB_SUFFIX="_s${BASH_REMATCH[1]}"
  export BACKEND_UNIT_SHARD="$COVERAGE_SHARD"
fi
# The dedicated unit pass of a sharded run (BACKEND_COVERAGE_UNIT_PASS=1,
# launched by run-coverage-sharded.sh beside the blackbox shards): the unit
# suite with its own lock, artifacts and database (`<workspace>_s0`; blackbox
# shards are numbered from 1), handing its raw coverage to the coordinator's
# merge directory like a shard. The unit suite's headless-browser perf probe
# (rose-ui-cli-browser `check --examples`, fps-p50 >= 55) is host-load
# dependent: beside two blackbox streams it failed 4/4 sharded runs and passed
# unsharded on the same box (2026-10-30). The coordinator therefore excludes
# that file from the concurrent pass (BACKEND_UNIT_EXCLUDE_FILES) and runs it
# alone afterwards as a second, labelled unit pass
# (BACKEND_COVERAGE_UNIT_PASS_LABEL=probe, BACKEND_UNIT_TEST_FILES=<probe>):
# same `_s0` database (serial reuse), its own `-units-<label>` lock, raw
# directory, logs and `results-<label>.json`.
UNIT_PASS="${BACKEND_COVERAGE_UNIT_PASS:-0}"
UNIT_PASS_LABEL="${BACKEND_COVERAGE_UNIT_PASS_LABEL:-}"
if [[ "$UNIT_PASS" == "1" ]]; then
  if [[ -n "$COVERAGE_SHARD" ]]; then
    echo "❌ BACKEND_COVERAGE_UNIT_PASS runs the unit suite; it cannot also be blackbox shard $COVERAGE_SHARD." >&2
    exit 2
  fi
  if [[ "${BACKEND_COVERAGE_SKIP_UNITS:-0}" == "1" ]]; then
    echo "❌ BACKEND_COVERAGE_UNIT_PASS and BACKEND_COVERAGE_SKIP_UNITS contradict each other." >&2
    exit 2
  fi
  if [[ -n "$UNIT_PASS_LABEL" ]] && ! [[ "$UNIT_PASS_LABEL" =~ ^[a-z0-9-]+$ ]]; then
    echo "❌ BACKEND_COVERAGE_UNIT_PASS_LABEL must match [a-z0-9-]+ (got '$UNIT_PASS_LABEL')." >&2
    exit 2
  fi
  export BACKEND_COVERAGE_SKIP_BLACKBOX=1
  SHARD_SUFFIX="-units${UNIT_PASS_LABEL:+-$UNIT_PASS_LABEL}"
  SHARD_DB_SUFFIX="_s0"
elif [[ -n "$UNIT_PASS_LABEL" ]]; then
  echo "❌ BACKEND_COVERAGE_UNIT_PASS_LABEL requires BACKEND_COVERAGE_UNIT_PASS=1." >&2
  exit 2
fi
# The unlabelled unit pass runs every unit file except the coordinator's
# exclusions, so it owns the unsuffixed coverage/unit-run/results.json that
# coverage-rerun-failed.sh reads; a labelled pass owns results-<label>.json.
UNIT_RESULTS_SUFFIX="$SHARD_SUFFIX"
# The shard token the prepared-URL resolver derives a per-run database from.
COVERAGE_DB_TOKEN="$COVERAGE_SHARD"
if [[ "$UNIT_PASS" == "1" ]]; then
  UNIT_RESULTS_SUFFIX="${UNIT_PASS_LABEL:+-$UNIT_PASS_LABEL}"
  COVERAGE_DB_TOKEN="units"
fi
COVERAGE_PARTIAL=0
# Exit status of a partial (subset) run whose selected tests all passed. Non-zero
# on purpose: thresholds were not enforced, so it can never be a passing gate.
COVERAGE_PARTIAL_EXIT=3
if [[ -n "$COVERAGE_SHARD" || -n "${BACKEND_COVERAGE_BLACKBOX_DOMAINS:-}" ||
  -n "${BACKEND_UNIT_TEST_FILES:-}" || "${BACKEND_COVERAGE_SKIP_UNITS:-0}" == "1" ||
  "${BACKEND_COVERAGE_SKIP_BLACKBOX:-0}" == "1" ]]; then
  COVERAGE_PARTIAL=1
fi

# Hermetic per-shard local stores (set after SHARD_SUFFIX is known).
export USER_UI_STORAGE_LOCAL_DIR="${USER_UI_STORAGE_LOCAL_DIR:-$ROOT_DIR/.context/user-ui-storage$SHARD_SUFFIX}"
export DISPLAY_STORAGE_LOCAL_DIR="${DISPLAY_STORAGE_LOCAL_DIR:-$ROOT_DIR/.context/display-storage$SHARD_SUFFIX}"
# Benchmark Hub's index lock is a per-database advisory lock; concurrent shards
# with separate databases must not share one local index.json.
export BENCHMARK_HUB_LOCAL_DIR="${BENCHMARK_HUB_LOCAL_DIR:-$ROOT_DIR/.context/benchmark-hub$SHARD_SUFFIX}"

# All coverage runs in one worktree share coverage/tmp, coverage/blackbox-run,
# coverage/server.log, and the workspace database. Hold OS advisory locks in a
# child that watches this shell. Unlike mkdir locks, a separately-sessioned
# guardian reaps registered test groups after SIGKILL/OOM before unlocking.
COVERAGE_RUN_LOCK_FILE="${BACKEND_COVERAGE_RUN_LOCK_FILE:-${BACKEND_COVERAGE_RUN_LOCK_DIR:-$BACKEND_DIR/coverage/.run-lock$SHARD_SUFFIX}}"
COVERAGE_RUN_LOCK_KEEPER_PID=""
COV_PORT_LOCK_KEEPER_PID=""
# Linux mktemp -t requires ≥3 trailing X's in the template; macOS is looser.
COVERAGE_PROCESS_GROUPS_FILE="${BACKEND_COVERAGE_PROCESS_GROUPS_FILE:-$(mktemp -t navi-backend-coverage-groups.XXXXXX)}"
: >"$COVERAGE_PROCESS_GROUPS_FILE"

acquire_process_lock() {
  local lock_file="$1"
  local process_groups_file="${2:-}"
  local status_file lock_keeper_pid lock_status
  status_file="$(mktemp -t navi-backend-coverage-lock.XXXXXX)"
  if [[ -n "$process_groups_file" ]]; then
    python3 "$SCRIPT_DIR/coverage-process-lock.py" \
      "$lock_file" "$status_file" "$$" "$process_groups_file" &
  else
    python3 "$SCRIPT_DIR/coverage-process-lock.py" "$lock_file" "$status_file" "$$" &
  fi
  lock_keeper_pid=$!

  for _attempt in $(seq 1 250); do
    if [[ -s "$status_file" ]]; then
      break
    fi
    if ! kill -0 "$lock_keeper_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.02
  done

  lock_status="$(cat "$status_file" 2>/dev/null || printf 'failed')"
  rm -f "$status_file"
  if [[ "$lock_status" == "acquired" ]]; then
    ACQUIRED_LOCK_KEEPER_PID="$lock_keeper_pid"
    ACQUIRED_LOCK_OWNER=""
    return 0
  fi

  wait "$lock_keeper_pid" >/dev/null 2>&1 || true
  ACQUIRED_LOCK_KEEPER_PID=""
  ACQUIRED_LOCK_OWNER="${lock_status#blocked:}"
  return 1
}

launch_coverage_process_group() {
  python3 "$SCRIPT_DIR/coverage-process-group.py" "$COVERAGE_PROCESS_GROUPS_FILE" "$@" &
  LAUNCHED_COVERAGE_PID=$!
}

release_process_lock() {
  local lock_keeper_pid="$1"
  [[ -n "$lock_keeper_pid" ]] || return 0
  kill "$lock_keeper_pid" >/dev/null 2>&1 || true
  wait "$lock_keeper_pid" >/dev/null 2>&1 || true
}

if ! acquire_process_lock "$COVERAGE_RUN_LOCK_FILE" "$COVERAGE_PROCESS_GROUPS_FILE"; then
  echo "❌ Another backend coverage run is already active (pid=$ACQUIRED_LOCK_OWNER)." >&2
  rm -f "$COVERAGE_PROCESS_GROUPS_FILE"
  exit 1
fi
COVERAGE_RUN_LOCK_KEEPER_PID="$ACQUIRED_LOCK_KEEPER_PID"

release_coverage_reservations() {
  release_process_lock "$COV_PORT_LOCK_KEEPER_PID"
  release_process_lock "$COVERAGE_RUN_LOCK_KEEPER_PID"
  rm -f "$COVERAGE_PROCESS_GROUPS_FILE"
}
trap release_coverage_reservations EXIT
trap 'exit 130' INT TERM

if [[ "$HOLD_COVERAGE_LOCK" == "1" ]]; then
  printf 'coverage lock acquired by %s\n' "$$"
  sleep "${BACKEND_COVERAGE_HOLD_SECONDS:-30}"
  exit 0
fi

if [[ "$HOLD_COVERAGE_LOCK_WITH_CHILD" == "1" ]]; then
  launch_coverage_process_group python3 -c 'import time; time.sleep(30)'
  printf 'coverage child process group %s\n' "$LAUNCHED_COVERAGE_PID"
  sleep "${BACKEND_COVERAGE_HOLD_SECONDS:-30}"
  exit 0
fi

# Prints the effective value of NAME for the test backend: the exported shell
# value, else the LAST assignment in back-end/.env with the backend's dotenv
# semantics (last-in-wins; quoted values keep '#' literally; unquoted values drop
# an inline "# comment"; surrounding whitespace is trimmed). Empty when absent.
backend_env_value() {
  local env_name="$1" value
  if [[ -n "${!env_name:-}" ]]; then
    printf '%s' "${!env_name}"
    return 0
  fi
  [[ -f "$BACKEND_DIR/.env" ]] || return 0
  value="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${env_name}=" "$BACKEND_DIR/.env" | tail -1 || true)"
  [[ -z "$value" ]] && return 0
  value="${value#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *)   value="${value%%#*}" ;;
  esac
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Returns 0 when the funded Azure Codex deployment is configured for the test
# backend: an https AZURE_FOUNDRY_ENDPOINT[_n] with its AZURE_FOUNDRY_API_KEY[_n]
# whose AZURE_FOUNDRY_DEPLOYMENTS[_n] lists CODEX_AZURE_DEPLOYMENT (default
# gpt-6.1-sol, the codexAzure column of src/providers/codeAgentModels.ts), or
# whose host is CODEX_AZURE_FOUNDRY_HOST when that pins the resource. Mirrors
# resolveCodexAzureFunding (src/providers/claudeCodeSandboxAuth.ts):
# resolveCodexCodeAuthEnvs serves a Codex session from that deployment when no
# gpt_code login is leasable, so the codex-code smoke can still run (and
# self-SKIP when it is out of quota). GPT_API_KEY never reaches a Codex
# sandbox, so it is not a Codex fallback.
codex_funded_fallback_configured() {
  local host deployment slot endpoint key name
  local -a names
  host="$(backend_env_value CODEX_AZURE_FOUNDRY_HOST)"
  deployment="$(backend_env_value CODEX_AZURE_DEPLOYMENT)"
  deployment="${deployment:-gpt-6.1-sol}"
  for slot in "" _2 _3 _4 _5 _6 _7 _8 _9; do
    endpoint="$(backend_env_value "AZURE_FOUNDRY_ENDPOINT$slot")"
    key="$(backend_env_value "AZURE_FOUNDRY_API_KEY$slot")"
    [[ -n "$endpoint" && -n "$key" && "$endpoint" == https://* ]] || continue
    endpoint="${endpoint#https://}"
    if [[ -n "$host" ]]; then
      [[ "${endpoint%%/*}" == "$host" ]] && return 0
      continue
    fi
    IFS=',' read -r -a names <<< "$(backend_env_value "AZURE_FOUNDRY_DEPLOYMENTS$slot")"
    for name in ${names[@]+"${names[@]}"}; do
      name="${name#"${name%%[![:space:]]*}"}"
      name="${name%"${name##*[![:space:]]}"}"
      [[ "$name" == "$deployment" ]] && return 0
    done
  done
  return 1
}

# Coverage data directory (NODE_V8_COVERAGE tells Node to dump raw coverage here)
COV_TMP="$BACKEND_DIR/coverage/tmp$SHARD_SUFFIX"

# Reserve one of the two currently-unused ports inside Conductor's ten-port
# workspace allocation. Port arithmetic outside that allocation is only a
# preference and can collide with a sibling workspace whose valid service has
# not started yet. A process-bound advisory lock closes the check/start race
# between cooperating processes without leaving stale reservations, while a
# listener probe protects against an ordinary listener already using an owned
# port. That probe must never silently degrade: when lsof is absent its
# "command not found" exit is indistinguishable from "port is free", which
# handed out occupied ports on Linux images without it.
BASE_PORT="${CONDUCTOR_PORT:-55000}"
COV_PORT_START="${BACKEND_COVERAGE_START_PORT:-$((BASE_PORT + 7))}"
COV_PORT_END="${BACKEND_COVERAGE_END_PORT:-$((BASE_PORT + 8))}"
COV_PORT_LOCK_ROOT="${BACKEND_COVERAGE_PORT_LOCK_ROOT:-$ROOT_DIR/.context/test-runs/.port-locks}"
mkdir -p "$COV_PORT_LOCK_ROOT"

# A listener scan alone misses a port the kernel autobound to an outbound
# connection (ESTABLISHED, or a client's TIME_WAIT; never LISTEN): Node's
# dual-stack listen() on it still fails with EADDRINUSE (coverage shard 1,
# 2026-10-28). Probe with the same bind Node/libuv performs — wildcard
# dual-stack with SO_REUSEADDR — so such a port is skipped, while a port our
# own previous server left in TIME_WAIT (which that listen() can reuse) is not
# burned from the two-port shard range.
port_rejects_bind() {
  local port="$1"
  # python3 already backs the reservation lock keeper; without it the probe
  # must not silently degrade to the LISTEN-only scan that missed 56022.
  command -v python3 >/dev/null 2>&1 || {
    echo "❌ python3 is required to probe coverage ports with Node's bind semantics." >&2
    exit 1
  }
  ! python3 - "$port" <<'PYEOF'
import socket, sys
port = int(sys.argv[1])
try:
    sock = socket.socket(socket.AF_INET6)
    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    target = ("::", port)
except OSError:
    sock = socket.socket(socket.AF_INET)
    target = ("0.0.0.0", port)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(target)
except OSError:
    sys.exit(1)
finally:
    sock.close()
PYEOF
}

port_in_use() {
  local port="$1"
  if port_rejects_bind "$port"; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
    return $?
  fi
  # No socket-inspection tool available (common on slim Linux CI/sandbox
  # images). A bash /dev/tcp connect needs no external binary.
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 0
  fi
  return 1
}

reserve_coverage_port() {
  local candidate="$1"
  while ((candidate <= COV_PORT_END)); do
    local lock_file="$COV_PORT_LOCK_ROOT/$candidate.lock"
    if acquire_process_lock "$lock_file"; then
      if port_in_use "$candidate"; then
        release_process_lock "$ACQUIRED_LOCK_KEEPER_PID"
      else
        COV_PORT="$candidate"
        COV_PORT_LOCK_KEEPER_PID="$ACQUIRED_LOCK_KEEPER_PID"
        return 0
      fi
    fi
    candidate=$((candidate + 1))
  done
  echo "❌ No available coverage port in this workspace's owned range $1-$COV_PORT_END." >&2
  return 1
}

COV_PORT=""
reserve_coverage_port "$COV_PORT_START"

if [[ "$PRINT_COVERAGE_PORT" == "1" ]]; then
  printf '%s\n' "$COV_PORT"
  exit 0
fi

if [[ -d "$COV_TMP" ]] && [[ -n "$(find "$COV_TMP" -mindepth 1 -print -quit)" ]]; then
  echo "❌ Unrecovered raw coverage remains at $COV_TMP; archive it before starting a new collection." >&2
  exit 1
fi
mkdir -p "$COV_TMP"

export TEST_BASE_URL="http://localhost:$COV_PORT"
export_blackbox_phone_upstream_env "$COV_PORT"
COV_LOG="$BACKEND_DIR/coverage/server$SHARD_SUFFIX.log"

# Keep local blackbox coverage deterministic. back-end/.env points trace
# archives at R2 for development/prod, but blackbox tests assert local archive
# artifacts and fake provider boundaries.
export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"
export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$ROOT_DIR/.context}"
export BLACKBOX_TEST_FAKE_SURGE="${BLACKBOX_TEST_FAKE_SURGE:-1}"
export BLACKBOX_TEST_FAKE_WHATSAPP="${BLACKBOX_TEST_FAKE_WHATSAPP:-1}"
export BLACKBOX_TEST_FAKE_TWILIO="${BLACKBOX_TEST_FAKE_TWILIO:-1}"
export BLACKBOX_TEST_FAKE_TEMPORAL="${BLACKBOX_TEST_FAKE_TEMPORAL:-1}"
export BLACKBOX_TEST_CAPTURE_OUTBOUND=1
export BLACKBOX_TEST_REPLAY_OUTBOUND=1
# The benchmark-share blackbox signs a temporary bearer link against the
# instrumented backend. Give both processes one throwaway key when the shell
# has no share secret exported.
if [[ -z "${BENCHMARK_SHARE_SECRET:-}" ]]; then
  export BENCHMARK_SHARE_SECRET="$(openssl rand -hex 32)"
fi
# The instrumented backend starts independently of run-blackbox-tests.sh.
# Full-suite phone fixtures explicitly opt in; never a product default or shared env write.
# Preserve an explicit caller0 for rollout-denial coverage.
export CLOUD_IPHONE_ENABLED="${CLOUD_IPHONE_ENABLED-1}"
# OAuth URL cases need the same synthetic local client, never the production one.
export GOOGLE_CLIENT_ID="${BLACKBOX_GOOGLE_CLIENT_ID:-rose-local-blackbox.apps.googleusercontent.com}"
source "$SCRIPT_DIR/blackbox-auto-rca-env.sh"
# Only the weekly admin-health case asserts real Amplitude counts. Keep that
# strict live probe enabled while preventing non-asserting shape cases from
# spending the provider's shared query budget.
export BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES="${BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES:-weekly}"
# Coverage remains deterministic and still exercises the unavailable path.
# The deploy workflow runs one focused live weekly probe afterward, so a
# provider quota failure can be retried without rerunning every deterministic domain.
export AMPLITUDE_API_KEY=""
export AMPLITUDE_SECRET_KEY=""
# Credential health is a mandatory focused deploy stage, not deterministic code
# coverage. Keep its real provider calls out of this deterministic batch so a TLS or
# provider outage can be retried without rerunning every instrumented test.
export BLACKBOX_TEST_SKIP_DOMAINS="${BLACKBOX_TEST_SKIP_DOMAINS:+$BLACKBOX_TEST_SKIP_DOMAINS,}integration-health"
export CONTRACT_TEST_SKIP_DOMAINS="$BLACKBOX_TEST_SKIP_DOMAINS"

# Coverage is a deterministic local-code gate, not an external analytics probe.
# A full admin-health run can spend most of Amplitude's five-minute chart-query
# budget, starving the mandatory live blackbox gate that follows coverage during
# /deploy. Keep coverage offline; the later live suite still requires real
# Amplitude funnel counts when credentials are configured.
export AMPLITUDE_API_KEY=""
export AMPLITUDE_SECRET_KEY=""

# Coverage is also not the deploy credential-health gate. The integration-health
# blackbox intentionally performs live provider billing/credential probes, which
# are required later as their own /deploy stage. Exclude only that operational
# probe here so code coverage remains a deterministic local-code gate.
append_blackbox_skip_domain() {
  local current="$1"
  local domain="$2"
  case ",$current," in
    *",$domain,"*) printf '%s\n' "$current" ;;
    "") printf '%s\n' "$domain" ;;
    *) printf '%s,%s\n' "$current" "$domain" ;;
  esac
}

export BLACKBOX_TEST_SKIP_DOMAINS="$(
  append_blackbox_skip_domain "${BLACKBOX_TEST_SKIP_DOMAINS:-}" "integration-health"
)"
export CONTRACT_TEST_SKIP_DOMAINS="$(
  append_blackbox_skip_domain "${CONTRACT_TEST_SKIP_DOMAINS:-}" "integration-health"
)"

# Coverage starts only a local backend. E2B smoke sandboxes cannot reach stale
# developer ngrok URLs from .env, so keep those smoke sessions on direct provider
# calls unless the caller explicitly opts into a known-live tunnel.
if [[ "${BACKEND_COVERAGE_USE_FAST_MODE_PROXY:-0}" != "1" ]]; then
  export FAST_MODE_ANTHROPIC_PROXY_URL=""
fi

# Pin the blackbox artifact dir so failures leave a known log path. Without this
# the blackbox runner mints a random RUN_ID dir, which gets lost if the caller
# tails output — forcing a full rerun just to find failures.
BLACKBOX_ARTIFACT_DIR="$BACKEND_DIR/coverage/blackbox-run$SHARD_SUFFIX"
rm -rf "$BLACKBOX_ARTIFACT_DIR"
mkdir -p "$BLACKBOX_ARTIFACT_DIR"
export BLACKBOX_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"

# ── Use local Postgres for coverage blackbox tests ──
# Keep this in sync with run-blackbox-tests.sh so the instrumented backend and
# test processes read/write the same database even when Conductor env vars are
# not exported in the shell.
WORKTREE_HINT="$(basename "$ROOT_DIR")"
WORKSPACE_HINT="${CONDUCTOR_WORKSPACE_NAME:-$WORKTREE_HINT}"
LOCAL_DB_PORT=""
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
fi
DB_CONTAINER="victoria-db-${WORKSPACE_HINT}"
DB_FOUND=false
ISOLATED_DB_RESOLVED=false
STACK_MANIFEST="$ROOT_DIR/.context/services.json"

if [[ -f "$STACK_MANIFEST" ]] && ! jq -e . "$STACK_MANIFEST" >/dev/null 2>&1; then
  echo "❌ Workspace service manifest is invalid; refusing to guess a coverage database." >&2
  exit 1
fi

# The workspace container's `victoria` is the dev stack's seeded database
# (run.sh); coverage gets this workspace's own database there, as on system
# Postgres. Created after the Prisma freshness check, like the system path.
use_workspace_container_db() {
  if ! ENSURE_SYSTEM_DB_NAME="$(workspace_system_db_name "$WORKSPACE_HINT$SHARD_DB_SUFFIX")"; then
    echo "❌ Workspace name '$WORKSPACE_HINT' cannot name a test database (letters, digits, - and _ only)." >&2
    exit 1
  fi
  LOCAL_PSQL_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/$ENSURE_SYSTEM_DB_NAME"
  DB_FOUND=true
  echo "Using local Postgres (Docker container=$DB_CONTAINER) at localhost:$LOCAL_DB_PORT, database $ENSURE_SYSTEM_DB_NAME"
}

if [[ "${ROSE_DEPLOY_WORKTREE:-0}" == "1" && "${ROSE_USE_SYSTEM_PG:-false}" == "true" && -z "${BACKEND_COVERAGE_DATABASE_URL:-}" ]]; then
  echo "❌ Isolated deploy coverage requires an explicit prepared BACKEND_COVERAGE_DATABASE_URL; refusing shared database fallback." >&2
  exit 1
fi
if [[ -n "${BACKEND_COVERAGE_DATABASE_URL:-}" ]]; then
  # The prepared URL names this workspace's own database (the exact deploy
  # marker on an isolated worktree). A shard i/N of a sharded run owns the
  # derived `<prepared>_s<i>` database on the same server, created below by
  # ensure_workspace_system_db like every other per-shard database, so the
  # sharded coordinator (test:coverage:sharded) also runs on the system-PG
  # deploy path instead of falling back to one unsharded sweep.
  if ! COVERAGE_DB_RESOLUTION="$(node "$SCRIPT_DIR/coverage-database-url.mjs" "$WORKSPACE_HINT" "$ROOT_DIR" "$COVERAGE_DB_TOKEN")"; then
    echo "❌ BACKEND_COVERAGE_DATABASE_URL must name this workspace's local database (the exact prepared marker for an isolated deploy worktree)." >&2
    exit 1
  fi
  LOCAL_PSQL_URL="$(printf '%s\n' "$COVERAGE_DB_RESOLUTION" | sed -n '1p')"
  COVERAGE_SHARD_DB_NAME="$(printf '%s\n' "$COVERAGE_DB_RESOLUTION" | sed -n '2p')"
  # Reachability is proven on the prepared database; a shard's derived
  # database is created from that same server on demand.
  if ! psql "$BACKEND_COVERAGE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
    echo "❌ Isolated coverage database is not reachable." >&2
    exit 1
  fi
  if [[ -n "$COVERAGE_SHARD_DB_NAME" ]]; then
    LOCAL_DB_PORT="$(node -e 'process.stdout.write(new URL(process.argv[1]).port || "5432")' "$BACKEND_COVERAGE_DATABASE_URL")"
    ENSURE_SYSTEM_DB_NAME="$COVERAGE_SHARD_DB_NAME"
    echo "Coverage ${COVERAGE_SHARD:+shard $COVERAGE_SHARD}${COVERAGE_SHARD:-unit pass} database: $COVERAGE_SHARD_DB_NAME (derived from the prepared workspace database)"
  fi
  DB_FOUND=true
  echo "Using explicitly validated workspace system Postgres database"
elif [[ -f "$STACK_MANIFEST" ]] &&
  [[ "$(jq -r '.database.container // empty' "$STACK_MANIFEST")" == "$DB_CONTAINER" ]] &&
  [[ "$(jq -r '.database.use_system_postgres // false' "$STACK_MANIFEST")" == "false" ]]; then
  # The worktree manifest declares a Docker database. Verify that exact
  # container even when Docker's broad info probe stalls under host load;
  # falling through to shared system Postgres could target another workspace.
  ACTUAL_PORT=$(docker_quick port "$DB_CONTAINER" 5432 | head -1 | sed 's/.*://') || true
  if [[ -z "$ACTUAL_PORT" ]] || ! docker_quick exec "$DB_CONTAINER" pg_isready -U postgres -q >/dev/null; then
    echo "❌ Expected workspace Postgres container $DB_CONTAINER is unavailable; refusing system Postgres fallback." >&2
    exit 1
  fi
  LOCAL_DB_PORT="$ACTUAL_PORT"
  use_workspace_container_db
elif docker_info_quick; then
  if RESOLVED_CONTAINER="$(resolve_local_db_container "$WORKSPACE_HINT" "$WORKTREE_HINT")"; then
    DB_CONTAINER="$RESOLVED_CONTAINER"
    ISOLATED_DB_RESOLVED=true
  else
    if ! system_db_fallback_is_safe; then
      echo "❌ No ready Postgres container owned by this worktree." >&2
      echo "   Tried: victoria-db-$WORKSPACE_HINT and victoria-db-$WORKTREE_HINT" >&2
      echo "   Refusing shared system Postgres while other workspace DBs are active." >&2
      exit 1
    fi
  fi

  ACTUAL_PORT=$(docker_quick port "$DB_CONTAINER" 5432 | head -1 | sed 's/.*://') || true
  if [[ -n "$ACTUAL_PORT" ]]; then
    LOCAL_DB_PORT="$ACTUAL_PORT"
  fi
  if [[ -n "$LOCAL_DB_PORT" ]] && docker_quick exec "$DB_CONTAINER" pg_isready -U postgres -q >/dev/null; then
    use_workspace_container_db
  fi
  if $ISOLATED_DB_RESOLVED && ! $DB_FOUND; then
    echo "❌ Owned Postgres container $DB_CONTAINER is not reachable on a mapped port." >&2
    exit 1
  fi
fi

if ! $DB_FOUND; then
  SYSTEM_PG_PORT=5432
  if pg_isready -h localhost -p "$SYSTEM_PG_PORT" -U postgres -q 2>/dev/null; then
    # Never the shared `victoria`: this workspace's own database only.
    # Created after the Prisma freshness check: stale deps touch no DB.
    if ! SYSTEM_DB_NAME="$(workspace_system_db_name "$WORKSPACE_HINT$SHARD_DB_SUFFIX")"; then
      echo "❌ Workspace name '$WORKSPACE_HINT' cannot name a test database (letters, digits, - and _ only)." >&2
      exit 1
    fi
    ENSURE_SYSTEM_DB_NAME="$SYSTEM_DB_NAME"
    LOCAL_DB_PORT="$SYSTEM_PG_PORT"
    LOCAL_PSQL_URL="postgresql://postgres:postgres@localhost:$SYSTEM_PG_PORT/$SYSTEM_DB_NAME"
    DB_FOUND=true
    echo "Using local Postgres (system) at localhost:$SYSTEM_PG_PORT, database $SYSTEM_DB_NAME"
  fi
fi

if $DB_FOUND; then
  # Every blackbox/unit child creates its own Prisma pool. Bound each pool so
  # the prescribed parallel coverage workers cannot exceed Postgres's shared
  # max_connections ceiling before the test assertions even run.
  # Default 16 (was 4): concurrency 3–4 domains share one backend pool, and a
  # 4-slot pool timed out data-google-sources grep while data-real-user and
  # download-telemetry were still holding connections. Isolated concurrency=1
  # passed in ~5s; system max_connections is 300.
  TEST_DB_CONNECTION_LIMIT="${BACKEND_TEST_DB_CONNECTION_LIMIT:-16}"
  if ! [[ "$TEST_DB_CONNECTION_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
    echo "❌ BACKEND_TEST_DB_CONNECTION_LIMIT must be a positive integer." >&2
    exit 1
  fi
  if [[ -z "${LOCAL_PSQL_URL:-}" ]]; then
    # Workspace Docker container: never its shared `victoria`, which the local
    # stack (Step 5 run.sh, semantic tests) serves from. The destructive
    # blackbox cases get this workspace's own database inside the container,
    # the same name the standalone runner and the E2B smoke use.
    if ! COVERAGE_DB_NAME="$(workspace_system_db_name "$WORKSPACE_HINT$SHARD_DB_SUFFIX")"; then
      echo "❌ Workspace name '$WORKSPACE_HINT' cannot name a test database (letters, digits, - and _ only)." >&2
      exit 1
    fi
    ENSURE_SYSTEM_DB_NAME="$COVERAGE_DB_NAME"
    LOCAL_PSQL_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/$COVERAGE_DB_NAME"
    echo "Coverage database: $COVERAGE_DB_NAME (workspace container, not the stack's victoria)"
  fi
  # Docker Desktop can briefly stop accepting new TCP connections while the
  # parallel coverage lanes saturate the shared host. Prisma's five-second
  # default connect timeout made every first query fail even when Postgres
  # recovered immediately after, so keep the gate bounded but give the local
  # database the same contention-safe startup window.
  LOCAL_DB_URL="$LOCAL_PSQL_URL?connection_limit=$TEST_DB_CONNECTION_LIMIT&pool_timeout=30&connect_timeout=15"
  export DATABASE_URL="$LOCAL_DB_URL"
  export DIRECT_URL="$LOCAL_DB_URL"
  # Hold this database for the whole run: a concurrent runner's schema sync
  # deadlocks the suite's live cases (40P01).
  source "$SCRIPT_DIR/test-db-run-lock.sh"
  acquire_test_db_run_lock "$LOCAL_PSQL_URL" "run-coverage.sh" || exit 1
  node "$SCRIPT_DIR/assert-prisma-client-current.mjs"
  if [[ -n "${ENSURE_SYSTEM_DB_NAME:-}" ]] &&
    ! ensure_workspace_system_db "$LOCAL_DB_PORT" "$ENSURE_SYSTEM_DB_NAME"; then
    echo "❌ Could not create the test database $ENSURE_SYSTEM_DB_NAME on localhost:$LOCAL_DB_PORT." >&2
    exit 1
  fi
  # run-unit-tests.ts resolves `victoria-db-<basename>` on its own, which misses
  # a hash-suffixed worktree container and falls back to the shared :5432 DB
  # with a stale schema. Hand the unit tests the database synced below.
  export BACKEND_UNIT_DATABASE_URL="$LOCAL_DB_URL"
  if command -v psql >/dev/null 2>&1; then
    psql "$LOCAL_PSQL_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
DO $$
BEGIN
  IF to_regclass('"UserAuthAssistanceRequest"') IS NOT NULL
     AND to_regclass('"AgentAttentionRequest"') IS NOT NULL THEN
    DELETE FROM "UserAuthAssistanceRequest" request
    WHERE NOT EXISTS (
      SELECT 1
      FROM "AgentAttentionRequest" attention
      WHERE attention.id = request.id
    );
  END IF;
  -- On system Postgres this database is shared with the local stack, whose
  -- real provider quota failures persist process-global funded-key cooldowns.
  -- Tests that exercise the funded routes assume no backoff is active.
  IF to_regclass('"Integration"') IS NOT NULL THEN
    DELETE FROM "Integration"
    WHERE "userId" = '00000000-0000-0000-0000-000000000000'
      AND name IN ('gpt_api_key_cooldown', 'anthropic_api_key_cooldown', 'codex_funded_cooldown');
  END IF;
END $$;
SQL
  fi
  echo "Syncing Prisma schema to local test database..."
  bash "$SCRIPT_DIR/normalize-local-user-phones.sh" "$LOCAL_PSQL_URL" >/dev/null
  bash "$SCRIPT_DIR/backfill-local-message-record-owner.sh" "$LOCAL_PSQL_URL" >/dev/null
  PRISMA_CLI_DATABASE_URL="$DIRECT_URL" npx prisma db push --skip-generate --accept-data-loss >/dev/null
  DATABASE_URL="$LOCAL_PSQL_URL" DIRECT_URL="$LOCAL_PSQL_URL" \
    bash "$SCRIPT_DIR/apply-local-runtime-sql-hooks.sh" >/dev/null
  bash "$SCRIPT_DIR/apply-local-message-record-trgm-index.sh" "$LOCAL_PSQL_URL" >/dev/null
  # Credential seeding and smoke execution are separate controls. A caller may
  # pre-seed a valid production credential without disabling the real Codex
  # black-box test that consumes it.
  if [[ "${BACKEND_CODEX_TOKEN_SYNC_SKIP:-0}" != "1" ]]; then
    CODEX_AUTH_FILE="${CODEX_AUTH_PATH:-$HOME/.codex/auth.json}"
    CODEX_AUTH_MODE="$(jq -r '.auth_mode // empty' "$CODEX_AUTH_FILE" 2>/dev/null || true)"
    if [[ "$CODEX_AUTH_MODE" == "chatgpt" ]]; then
      echo "Syncing local Codex credentials to local test database..."
      npx tsx scripts/sync-codex-token.ts >/dev/null
    else
      SEEDED_CODEX_COUNT="$(psql "$LOCAL_PSQL_URL" -At -v ON_ERROR_STOP=1 -c \
        "SELECT count(*) FROM \"Integration\" WHERE name='gpt_code' AND status='CONNECTED' AND \"isActive\"=true AND coalesce(config->>'encryptedCredentials','') <> '';" 2>/dev/null || printf 0)"
      if [[ "$SEEDED_CODEX_COUNT" =~ ^[1-9][0-9]*$ ]]; then
        echo "Using the connected gpt_code credential already seeded in the isolated test database."
      elif codex_funded_fallback_configured; then
        # No seeded gpt_code login, but resolveCodexCodeAuthEnvs serves the
        # Codex session from the funded Azure deployment (src/providers/e2b.ts),
        # so the codex-code E2B smoke still runs end-to-end (and emits the
        # deploy-approved out-of-funds SKIP if it is out of quota): a missing
        # seeded credential must not hard-fail the run. Only fail when NO
        # credential path exists at all (handled by the else below).
        echo "No seeded gpt_code credential; the funded Azure Codex deployment (an AZURE_FOUNDRY_* region listing the Codex deployment) is configured, so the Codex smoke will run on it (and SKIP if it is out of quota)."
      else
        echo "❌ Codex auth is not ChatGPT mode, the isolated test database has no connected gpt_code credential, and no funded Azure Codex deployment (no AZURE_FOUNDRY_* region lists the Codex deployment) is configured." >&2
        echo "   Run codex login, seed the integration, configure the Azure Codex deployment, or set BACKEND_CODEX_TOKEN_SYNC_SKIP=1 only when the caller already seeded it." >&2
        exit 1
      fi
    fi
  fi
fi

if ! $DB_FOUND || [ -z "${LOCAL_DB_URL:-}" ]; then
  echo "❌ No local Postgres found for coverage (Docker container or system Postgres on :5432)." >&2
  echo "   Start the workspace DB container or \`sudo service postgresql start\` (Cloud: ROSE_USE_SYSTEM_PG=true)." >&2
  exit 1
fi

# DEMO cache still requires an explicit URL outside production, but a local
# coverage run must not write fixtures into (or depend on capacity from) the
# shared production cache database. The local schema includes FastModeCacheEntry,
# so point the instrumented backend at the same isolated database used by every
# other blackbox domain. scripts/run.sh retains the shared-cache behavior for
# real local agent stacks; this override is coverage-only.
export FAST_MODE_CACHE_DATABASE_URL="$LOCAL_DB_URL"

echo "Starting backend with coverage collection on port $COV_PORT..."
launch_coverage_process_group env \
  NODE_V8_COVERAGE="$COV_TMP" PORT="$COV_PORT" DISABLE_GMAIL_SYNC=1 \
    DISABLE_GOOGLE_DATA_PURGE=1 \
  node --import tsx src/bootstrap.ts >"$COV_LOG" 2>&1
BACKEND_PID="$LAUNCHED_COVERAGE_PID"
BLACKBOX_PID=""
UNIT_PID=""

cleanup() {
  local cleanup_exit=$? child_pid raw_evidence_dir raw_staging_dir=""
  for child_pid in "$UNIT_PID" "$BLACKBOX_PID" "$BACKEND_PID"; do
    [[ -n "$child_pid" ]] || continue
    kill -TERM -- "-$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" 2>/dev/null || true
  done
  # Every registered group is now explicitly reaped. Disarm the guardian before
  # releasing it so a long successful run cannot act on a recycled historical
  # PGID during normal cleanup.
  printf 'disarmed\n' >"$COVERAGE_PROCESS_GROUPS_FILE"
  # Archive after shutdown so late backend V8 flushes join the completed suites.
  # Never overwrite or nest into an earlier archive; failed copies retain inputs.
  if [[ "$cleanup_exit" -ne 0 && -d "$COV_TMP" ]]; then
    raw_evidence_dir="${EVIDENCE_DIR:-$ROOT_DIR/.context/test-runs/backend-coverage-failed-$(date -u +%Y%m%d-%H%M%S)-$$}"
    if mkdir -p "$raw_evidence_dir" &&
      [[ ! -e "$raw_evidence_dir/raw-v8" ]] &&
      raw_staging_dir="$(mktemp -d "$raw_evidence_dir/.raw-v8-incomplete.XXXXXX")" &&
      cp -R "$COV_TMP/." "$raw_staging_dir/" &&
      mv "$raw_staging_dir" "$raw_evidence_dir/raw-v8"; then
      echo "    Raw V8 coverage: $raw_evidence_dir/raw-v8"
      rm -rf "$COV_TMP"
    else
      if [[ -n "$raw_staging_dir" ]]; then rm -rf "$raw_staging_dir" || true; fi
      echo "Could not archive raw V8 coverage; retained at $COV_TMP" >&2
    fi
  else
    rm -rf "$COV_TMP"
  fi
  release_coverage_reservations
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Wait for backend to be ready. Instrumented TypeScript startup can exceed a
# minute on a busy shared host, so use a wall-clock five-minute deadline and
# emit progress every ten seconds instead of failing silently.
READY=0
READINESS_STARTED_AT=$SECONDS
READINESS_DEADLINE=$((READINESS_STARTED_AT + 300))
NEXT_READINESS_PROGRESS=10
while ((SECONDS < READINESS_DEADLINE)); do
  REMAINING_READINESS_SECONDS=$((READINESS_DEADLINE - SECONDS))
  CURL_TIMEOUT_SECONDS=2
  if ((REMAINING_READINESS_SECONDS < CURL_TIMEOUT_SECONDS)); then
    CURL_TIMEOUT_SECONDS=$REMAINING_READINESS_SECONDS
  fi
  if curl -fsS -m "$CURL_TIMEOUT_SECONDS" "$TEST_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "❌ Backend process exited before becoming ready"
    tail -n 40 "$COV_LOG" || true
    exit 1
  fi
  READINESS_ELAPSED=$((SECONDS - READINESS_STARTED_AT))
  if ((READINESS_ELAPSED >= NEXT_READINESS_PROGRESS)); then
    echo "Waiting for backend health on $TEST_BASE_URL/health (${READINESS_ELAPSED}s elapsed)..."
    NEXT_READINESS_PROGRESS=$((READINESS_ELAPSED + 10))
  fi
  if ((SECONDS < READINESS_DEADLINE)); then
    sleep 0.5
  fi
done

if [[ "$READY" -ne 1 ]]; then
  echo "❌ Timed out waiting for backend health on $TEST_BASE_URL/health"
  tail -n 40 "$COV_LOG" || true
  exit 1
fi

echo "Backend ready at $TEST_BASE_URL"

# Run the blackbox test suite (the comprehensive test that exercises business logic).
# Propagate NODE_V8_COVERAGE so test processes ALSO dump V8 coverage — this
# picks up module-level fetch-stubbed suites (e.g. rose.blackbox.ts) that
# exercise provider code in the test process rather than via HTTP to the
# instrumented backend. All per-process coverage files merge at report time.
# captcha-solve-indicator launches Node Playwright Chromium. Cloud images can
# have the npm package without the matching browser revision, which fails as
# "Executable doesn't exist at .../chrome-headless-shell". Install before units.
# `install` always takes the machine-wide ms-playwright directory lock, which
# goes stale on a loaded host shared by many worktrees and fails coverage before
# any test runs. Skip it when every needed revision is already complete.
playwright_chromium_installed() {
  local locations location
  locations="$(npx playwright install --dry-run chromium 2>/dev/null |
    sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p')" || return 1
  [ -n "$locations" ] || return 1
  while IFS= read -r location; do
    [ -f "$location/INSTALLATION_COMPLETE" ] || return 1
  done <<< "$locations"
}
if command -v npx >/dev/null 2>&1; then
  echo "Ensuring Playwright Chromium is installed for coverage unit tests..."
  if ! playwright_chromium_installed; then
    npx playwright install chromium
  fi
fi

BLACKBOX_DOMAIN_ARGS=()
if [[ -n "${BACKEND_COVERAGE_BLACKBOX_DOMAINS:-}" ]]; then
  BLACKBOX_DOMAIN_ARGS=("$BACKEND_COVERAGE_BLACKBOX_DOMAINS")
elif [[ -n "$COVERAGE_SHARD" ]]; then
  BLACKBOX_DOMAIN_ARGS=("$(node "$SCRIPT_DIR/coverage-shard-plan.mjs" "$COVERAGE_SHARD" "${BACKEND_COVERAGE_SHARD_DURATIONS:-}")")
fi
if [[ ${#BLACKBOX_DOMAIN_ARGS[@]} -gt 0 ]]; then
  echo "Blackbox domain selection: ${BLACKBOX_DOMAIN_ARGS[0]}"
fi
echo "Running blackbox and unit tests in parallel..."
HOST_PRESSURE_LOG="$BLACKBOX_ARTIFACT_DIR/host-pressure.log"
record_host_pressure "$HOST_PRESSURE_LOG" "suite-start"
TEST_EXIT=0
UNIT_EXIT=0
if [[ "${BACKEND_COVERAGE_SKIP_BLACKBOX:-0}" != "1" ]]; then
  launch_coverage_process_group env \
    NODE_V8_COVERAGE="$COV_TMP" \
    BLACKBOX_TEST_USE_EXISTING_BACKEND=1 CONTRACT_TEST_USE_EXISTING_BACKEND=1 \
    BLACKBOX_TEST_DATABASE_URL="$LOCAL_DB_URL" CONTRACT_TEST_DATABASE_URL="$LOCAL_DB_URL" \
    BLACKBOX_TEST_SKIP_DB_SYNC=1 CONTRACT_TEST_SKIP_DB_SYNC=1 \
    ROSE_TEST_DB_LOCK_INHERITED_KEY="$TEST_DB_RUN_LOCK_KEY" ROSE_TEST_DB_LOCK_INHERITED_PID="$$" \
    BACKEND_CODEX_TOKEN_SYNC_SKIP=1 \
    BLACKBOX_TEST_CONCURRENCY="${BLACKBOX_TEST_CONCURRENCY:-4}" CONTRACT_TEST_CONCURRENCY="${CONTRACT_TEST_CONCURRENCY:-4}" \
    BLACKBOX_TEST_CASE_CONCURRENCY="${BLACKBOX_TEST_CASE_CONCURRENCY:-30}" CONTRACT_TEST_CASE_CONCURRENCY="${CONTRACT_TEST_CASE_CONCURRENCY:-30}" \
    bash scripts/run-blackbox-tests.sh "${BLACKBOX_DOMAIN_ARGS[@]}"
  BLACKBOX_PID="$LAUNCHED_COVERAGE_PID"
else
  # Rerun of unit failures only; nothing failed in the blackbox suite.
  echo "Blackbox suite skipped (BACKEND_COVERAGE_SKIP_BLACKBOX=1)."
fi

if [[ "${BACKEND_COVERAGE_SKIP_UNITS:-0}" != "1" ]]; then
  launch_coverage_process_group env \
    BACKEND_UNIT_COVERAGE_DIR="$COV_TMP" \
    BACKEND_UNIT_CONCURRENCY="${BACKEND_UNIT_CONCURRENCY:-6}" \
    BACKEND_UNIT_RESULTS_FILE="$BACKEND_DIR/coverage/unit-run/results$UNIT_RESULTS_SUFFIX.json" \
    node --import tsx scripts/run-unit-tests.ts
  UNIT_PID="$LAUNCHED_COVERAGE_PID"
else
  echo "Unit suite skipped (BACKEND_COVERAGE_SKIP_UNITS=1)."
fi

if [[ -n "$BLACKBOX_PID" ]]; then
  wait "$BLACKBOX_PID" || TEST_EXIT=$?
  BLACKBOX_PID=""
  # Early-abort retry (previously failed domains first, stop when one fails
  # again): the run can no longer pass, so stop the unit lane too.
  if [[ "$TEST_EXIT" -ne 0 && "${BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE:-0}" == "1" &&
    -n "$UNIT_PID" ]] &&
    grep -q '^PRIORITY FAILURE:' "$BLACKBOX_ARTIFACT_DIR/runner.log" 2>/dev/null; then
    echo "Previously failed blackbox domain failed again; stopping the unit lane early."
    kill -TERM -- "-$UNIT_PID" >/dev/null 2>&1 || true
  fi
fi
if [[ -n "$UNIT_PID" ]]; then
  wait "$UNIT_PID" || UNIT_EXIT=$?
  UNIT_PID=""
fi

if [[ "$TEST_EXIT" -ne 0 || "$UNIT_EXIT" -ne 0 ]]; then
  echo "Backend test phase failed (blackbox exit $TEST_EXIT, unit exit $UNIT_EXIT); skipping report work until the failing lifecycle is fixed."
  record_host_pressure "$HOST_PRESSURE_LOG" "suite-failed"
  if EVIDENCE_DIR="$(preserve_coverage_failure "$COV_LOG" "$BLACKBOX_ARTIFACT_DIR" "$ROOT_DIR/.context/test-runs")"; then
    echo "    Failure evidence (kept across reruns): $EVIDENCE_DIR"
    echo "    Backend log:   $EVIDENCE_DIR/server.log"
    echo "    Runner log:    $EVIDENCE_DIR/runner.log"
    echo "    Host pressure: $EVIDENCE_DIR/host-pressure.log"
  else
    echo "    Could not preserve failure evidence; live copies: $COV_LOG, $BLACKBOX_ARTIFACT_DIR"
  fi
  if [[ "$TEST_EXIT" -ne 0 ]]; then
    exit "$TEST_EXIT"
  fi
  exit "$UNIT_EXIT"
fi

# Stop the server so NODE_V8_COVERAGE flushes data
echo "Stopping backend and collecting coverage data..."
kill "$BACKEND_PID" 2>/dev/null || true
wait "$BACKEND_PID" 2>/dev/null || true
BACKEND_PID=""

if [[ ( -n "$COVERAGE_SHARD" || "$UNIT_PASS" == "1" ) && -n "${BACKEND_COVERAGE_MERGE_DIR:-}" ]]; then
  # The coordinator enforces thresholds on the merged report of every shard
  # and the unit pass.
  mkdir -p "$BACKEND_COVERAGE_MERGE_DIR"
  cp -R "$COV_TMP/." "$BACKEND_COVERAGE_MERGE_DIR/"
  echo "${COVERAGE_SHARD:+Shard $COVERAGE_SHARD}${COVERAGE_SHARD:-Unit pass} passed; raw coverage handed to $BACKEND_COVERAGE_MERGE_DIR for the merged threshold check."
  exit 0
fi
if [[ "$COVERAGE_PARTIAL" -eq 1 ]]; then
  # A subset run is a diagnostic, never a gate result: the selected tests passed
  # but thresholds were not checked, so it must not read as a passing gate row.
  echo "PARTIAL coverage run: the selected tests passed but thresholds were NOT checked. Exiting $COVERAGE_PARTIAL_EXIT so this never counts as a passing gate; a full coverage run is still required before merge."
  exit "$COVERAGE_PARTIAL_EXIT"
fi

# Generate the coverage report and also the json-summary for the gap analysis.
# c8 merges every raw V8 file in memory: with all 347 unit files and 238
# blackbox domains the merge died with "JavaScript heap out of memory" at
# node's default (~2 GB) heap after every test had passed (2026-10-30). The
# report step therefore raises the heap ceiling itself; it is a cap, not a
# reservation, and lives here rather than in the caller's lane env.
echo ""
echo "=== Coverage Report ==="
COV_EXIT=0
if [[ "$REPORT_ONLY" -eq 1 ]]; then
  coverage_report_node npx c8 report --temp-directory="$COV_TMP" --reporter=text --reporter=text-summary --reporter=json-summary || COV_EXIT=$?
else
  coverage_report_node npx c8 report --temp-directory="$COV_TMP" --reporter=text --reporter=text-summary --reporter=json-summary --check-coverage || COV_EXIT=$?
fi

# If coverage thresholds failed, show actionable guidance
if [[ "$COV_EXIT" -ne 0 ]]; then
  SUMMARY_FILE="$BACKEND_DIR/coverage/coverage-summary.json"
  if [[ -f "$SUMMARY_FILE" ]]; then
    echo ""
    echo "=== How to fix: files with the most uncovered lines ==="
    echo ""
    COV_SUMMARY_FILE="$SUMMARY_FILE" COV_BACKEND_DIR="$BACKEND_DIR" python3 <<'PYEOF'
import json, sys, os

summary_file = os.environ.get("COV_SUMMARY_FILE", "")
backend_dir = os.environ.get("COV_BACKEND_DIR", "")

with open(summary_file) as f:
    data = json.load(f)

# Read threshold from .c8rc.json
c8rc_path = os.path.join(backend_dir, ".c8rc.json")
threshold = 88  # default
try:
    with open(c8rc_path) as f2:
        c8rc = json.load(f2)
    threshold = c8rc.get("lines", 88)
except Exception:
    pass
cwd = backend_dir + "/"

# Collect per-file gaps
gaps = []
for filepath, metrics in data.items():
    if filepath == "total":
        continue
    display = filepath.replace(cwd, "")
    lines = metrics.get("lines", {})
    total = lines.get("total", 0)
    covered = lines.get("covered", 0)
    pct = lines.get("pct", 100)
    uncovered = total - covered
    if uncovered > 0 and pct < threshold:
        gaps.append((display, pct, uncovered, total, covered))

# Sort by uncovered lines descending
gaps.sort(key=lambda x: -x[2])

# Show top 20 files
header = "{:<60} {:>5} {:>10} {:>6}".format("File", "Cov%", "Uncovered", "Total")
print(header)
print("-" * 85)
for name, pct, uncov, total, cov in gaps[:20]:
    print("{:<60} {:>4.0f}% {:>10} {:>6}".format(name, pct, uncov, total))

# Show totals
total_all = data.get("total", {})
lines_total = total_all.get("lines", {})
cur_pct = lines_total.get("pct", 0)
cur_covered = lines_total.get("covered", 0)
cur_total = lines_total.get("total", 0)
needed = int(cur_total * threshold / 100) - cur_covered
print()
print("Current:  {}/{} lines covered ({:.1f}%)".format(cur_covered, cur_total, cur_pct))
print("Target:   {}% = {} lines".format(threshold, int(cur_total * threshold / 100)))
print("Gap:      {} more lines need coverage".format(needed))
print()
print("Tip: Focus on the files above -- they have the most uncovered lines.")
print("     Run  npm run test:coverage:report  to see per-file details.")
print("     Add or expand blackbox tests in  src/tests/blackbox/<domain>.blackbox.ts")
PYEOF
  fi
  exit "$COV_EXIT"
fi
