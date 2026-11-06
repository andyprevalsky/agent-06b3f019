#!/usr/bin/env bash
set -euo pipefail

# Frontend Semantic Test Runner (Playwright)
#
# Runs browser-based e2e tests via Playwright/Chromium against the running
# local stack or production.
#
# Usage:
#   bash scripts/run-semantic-tests.sh              # run all (local)
#   bash scripts/run-semantic-tests.sh <name>       # run specific test (local)
#   bash scripts/run-semantic-tests.sh --prod       # run all against production
#   bash scripts/run-semantic-tests.sh --prod <name> # run specific test against production
#   bash scripts/run-semantic-tests.sh --list       # list available tests
#
# Requirements (local):
#   - Backend running on $BACKEND_PORT (default: 3001)
#   - Frontend running on $FRONTEND_PORT (default: 3002)
#   - Chromium downloaded: `npx playwright install chromium`
#
# Requirements (--prod):
#   - SUPABASE_JWT_SECRET, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
#   - Chromium downloaded: `npx playwright install chromium`

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$FRONTEND_DIR")"

apply_local_semantic_db_urls() {
  # The semantic command runs in a fresh shell, so LOCAL_DB_PORT exported while
  # starting run.sh may be absent here. An explicit database URL is authoritative.
  # Otherwise require the running stack's exact backend manifest: guessing the
  # default Postgres port can seed a different database from the live backend.
  if [[ -n "${SEMANTIC_DATABASE_URL:-}" ]]; then
    if [[ -z "${SEMANTIC_DIRECT_URL:-}" ]]; then
      export SEMANTIC_DIRECT_URL="$SEMANTIC_DATABASE_URL"
    fi
    return 0
  fi
  local manifest="$REPO_DIR/.context/services.json"
  local database_name="victoria"
  if [[ -f "$manifest" ]]; then
    local database_identity="" manifest_port=""
    database_identity=$(jq -er --arg backend "${BACKEND_URL:-}" '
      select(.status == "running" and .urls.backend == $backend)
      | .database
      | select(.runtime_port | type == "number" and . == floor and . >= 1 and . <= 65535)
      | select(.name | type == "string" and test("^[A-Za-z0-9_]+$"))
      | [.runtime_port, .name] | @tsv
    ' "$manifest" 2>/dev/null) || {
      echo "FAIL: Cannot identify the running stack database for ${BACKEND_URL:-unset}; set SEMANTIC_DATABASE_URL" >&2
      return 1
    }
    IFS=$'\t' read -r manifest_port database_name <<< "$database_identity"
    if [[ -n "${LOCAL_DB_PORT:-}" && "$LOCAL_DB_PORT" != "$manifest_port" ]]; then
      echo "FAIL: LOCAL_DB_PORT differs from the running stack database port; set SEMANTIC_DATABASE_URL for an explicit override" >&2
      return 1
    fi
    export LOCAL_DB_PORT="$manifest_port"
  elif [[ -z "${LOCAL_DB_PORT:-}" ]]; then
    echo "FAIL: Cannot identify the running stack database for ${BACKEND_URL:-unset}; set SEMANTIC_DATABASE_URL or LOCAL_DB_PORT" >&2
    return 1
  fi
  if [[ ! "$LOCAL_DB_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_DB_PORT < 1 || LOCAL_DB_PORT > 65535 )); then
    echo "FAIL: LOCAL_DB_PORT must be a valid TCP port, got $LOCAL_DB_PORT" >&2
    return 1
  fi
  export SEMANTIC_DATABASE_URL="postgresql://postgres:postgres@localhost:${LOCAL_DB_PORT}/${database_name}?connection_limit=50&pool_timeout=30"
  if [[ -z "${SEMANTIC_DIRECT_URL:-}" ]]; then
    export SEMANTIC_DIRECT_URL="$SEMANTIC_DATABASE_URL"
  fi
}

# Local semantic runs share this machine with other Conductor workspaces whose
# load may never drop below the core count, so the runner never waits for
# headroom: it sizes Playwright concurrency to the headroom it measures.
# RCA 2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget: at load ~56
# on 14 cores, four Chromium workers left one renderer frozen for 34s.
# Prints "cpus|load1|mem_free_pct"; a field is empty when it cannot be read.
# cpus is the smaller of the affinity mask (cpusets and taskset hide cores that
# os.cpu_count() still reports) and the CFS bandwidth quota (cgroup v2 cpu.max
# or v1 cpu.cfs_quota_us/cpu.cfs_period_us on this cgroup or an ancestor; a quota
# does not hide cores, it caps CPU time, so it is rounded up to whole CPUs).
# load1 is empty when that count is narrower than the host's CPU count: the
# host-wide load then mostly measures work outside this mask, and subtracting it
# would starve the allowed CPUs' worker count. SEMANTIC_CGROUP_ROOT and
# SEMANTIC_PROC_CGROUP exist for the deploy gate's fake-cgroup regression.
probe_semantic_host_capacity() {
  python3 - <<'PY'
import math
import os
import subprocess

CGROUP_ROOT = os.environ.get("SEMANTIC_CGROUP_ROOT", "/sys/fs/cgroup")
PROC_CGROUP = os.environ.get("SEMANTIC_PROC_CGROUP", "/proc/self/cgroup")


def read_text(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def own_cgroup_paths():
    """(v2 path, v1 cpu-controller path) of this process; None when absent."""
    v2 = v1 = None
    for line in (read_text(PROC_CGROUP) or "").splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        hierarchy, controllers, path = parts
        if hierarchy == "0" and controllers == "":
            v2 = path
        elif "cpu" in controllers.split(","):
            v1 = path
    return v2, v1


def ancestors(path):
    parts = [part for part in (path or "").split("/") if part]
    for depth in range(len(parts), -1, -1):
        yield os.path.join(*parts[:depth]) if depth else ""


def quota_limits():
    """CFS bandwidth limits (quota / period, in CPUs) on this cgroup and its ancestors."""
    v2, v1 = own_cgroup_paths()
    for rel in ancestors(v2):  # the root cpu.max is checked even without a v2 line
        text = read_text(os.path.join(CGROUP_ROOT, rel, "cpu.max"))
        if text:
            quota, _, period = text.partition(" ")
            if quota != "max" and quota.isdigit() and period.isdigit() and int(period) > 0:
                yield int(quota) / int(period)
    if v1 is not None:
        for mount in ("cpu", "cpu,cpuacct"):
            for rel in ancestors(v1):
                base = os.path.join(CGROUP_ROOT, mount, rel)
                quota = read_text(os.path.join(base, "cpu.cfs_quota_us"))
                period = read_text(os.path.join(base, "cpu.cfs_period_us"))
                if quota and period and quota.lstrip("-").isdigit() and period.isdigit():
                    if int(quota) > 0 and int(period) > 0:
                        yield int(quota) / int(period)


try:
    affinity = len(os.sched_getaffinity(0)) or 0
except (AttributeError, OSError):
    affinity = os.cpu_count() or 0
cpus = affinity
for limit in quota_limits():
    cpus = min(cpus, max(1, math.ceil(limit)))
host_cpus = os.cpu_count() or 0
restricted = bool(cpus) and host_cpus > cpus
load = ""
if not restricted:
    try:
        load = f"{os.getloadavg()[0]:.2f}"
    except OSError:
        load = ""
mem = ""
try:
    out = subprocess.run(["sysctl", "-n", "kern.memorystatus_level"],
                         capture_output=True, text=True, timeout=5).stdout.strip()
    mem = out if out.isdigit() else ""
except (OSError, subprocess.SubprocessError):
    pass
if not mem:
    try:
        with open("/proc/meminfo") as fh:
            info = {k: int(v.split()[0]) for k, v in (line.split(":", 1) for line in fh)}
        mem = str(info["MemAvailable"] * 100 // info["MemTotal"])
    except (OSError, KeyError, ValueError, ZeroDivisionError):
        pass
print(f"{cpus or ''}|{load}|{mem}")
PY
}

# Prints the Playwright worker count for the measured capacity: never above the
# request, one worker per whole idle core (the CPU count minus the 1-minute
# load when a load is given, the CPU count alone when it is not), one worker
# when free memory is below SEMANTIC_MIN_MEM_FREE_PCT, and never below one.
# Unknown inputs never cap.
# Args: requested cpus load1 mem_free_pct
semantic_workers_for_capacity() {
  # "load" is a reserved builtin name in gawk >= 5.3 (the ubuntu-latest runner):
  # `awk -v load=` is fatal there, so the variable is load1 (RCA 2026-10-31
  # production semantic gate exit 2 on every job after prod-mode sizing landed).
  awk -v req="$1" -v cpus="$2" -v load1="$3" -v mem="$4" \
    -v min_mem="${SEMANTIC_MIN_MEM_FREE_PCT:-20}" 'BEGIN {
    n = req + 0
    if (cpus != "") {
      slots = int(cpus - (load1 != "" ? load1 : 0))
      if (slots < n) n = slots
    }
    if (mem != "" && mem + 0 < min_mem + 0) n = 1
    if (n < 1) n = 1
    print n
  }'
}

cd "$FRONTEND_DIR"

PROD_MODE=0

# Parse --prod flag (can appear anywhere in args)
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--prod" ]]; then
    PROD_MODE=1
  else
    ARGS+=("$arg")
  fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [[ "${1:-}" == "--list" ]]; then
  for f in tests-e2e/*.spec.ts; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .spec.ts)
    echo "  $name"
  done
  exit 0
fi

# True when URL host is loopback: localhost, *.localhost, 127.0.0.0/8, or ::1.
is_loopback_url() {
  local url="$1" host=""
  [[ -n "$url" ]] || return 1
  host=$(URL="$url" python3 - <<'PY'
import os, urllib.parse
u = urllib.parse.urlparse(os.environ["URL"])
host = (u.hostname or "").lower()
print(host)
PY
) || return 1
  [[ -n "$host" ]] || return 1
  case "$host" in
    localhost|*.localhost|::1) return 0 ;;
  esac
  # 127.0.0.0/8
  if [[ "$host" =~ ^127\.([0-9]{1,3}\.){2}[0-9]{1,3}$ ]]; then
    return 0
  fi
  return 1
}

if [[ "$PROD_MODE" -eq 1 ]]; then
  # ── Production mode ──────────────────────────────────────────────────
  # Cloud/injected envs often export BACKEND_URL to a loopback port (same
  # footgun local mode already forces away). In --prod that would health-check
  # a dead local port and false-fail the production gate — drop loopback URLs
  # so the prod defaults win unless an explicit non-local override is set.
  if is_loopback_url "${BACKEND_URL:-}"; then
    unset BACKEND_URL
  fi
  if is_loopback_url "${FRONTEND_URL:-}"; then
    unset FRONTEND_URL
  fi
  export BACKEND_URL="${BACKEND_URL:-https://navi-j9a9.onrender.com}"
  # Prefer www — apex `roselabs.ai` 307s to www, and some runners flake on the
  # apex probe (no AAAA / Happy-Eyeballs). Keep accepting either host.
  export FRONTEND_URL="${FRONTEND_URL:-https://www.roselabs.ai}"
  export SEMANTIC_PROD=1

  echo "=== Semantic tests: PRODUCTION mode ==="
  echo "  Backend:  $BACKEND_URL"
  echo "  Frontend: $FRONTEND_URL"

  # Health checks against prod. Force IPv4 + follow redirects + short retries so
  # a single transient DNS/TLS blip cannot false-fail the production gate.
  if ! curl -4 -sf --max-time 20 "$BACKEND_URL/health" > /dev/null 2>&1; then
    echo "FAIL: Prod backend not healthy at $BACKEND_URL/health" >&2
    exit 1
  fi
  FE_PROBE_OK=""
  for _fe_try in 1 2 3 4 5; do
    if curl -4 -sfL --max-time 20 -o /dev/null "$FRONTEND_URL" 2>/dev/null; then
      FE_PROBE_OK=1
      break
    fi
    sleep 2
  done
  if [[ -z "$FE_PROBE_OK" ]]; then
    echo "FAIL: Prod frontend not accessible at $FRONTEND_URL" >&2
    exit 1
  fi

else
  # ── Local mode (default) ─────────────────────────────────────────────
  BACKEND_PORT="${BACKEND_PORT:-3001}"
  FRONTEND_PORT="${FRONTEND_PORT:-3002}"
  export BACKEND_PORT FRONTEND_PORT
  # Cloud/injected envs often export BACKEND_URL to local port 3001 (and the
  # matching VITE_/API aliases). Playwright helpers prefer BACKEND_URL over
  # BACKEND_PORT, so a stale injection makes create/delete/poll hit a dead port
  # even when CONDUCTOR_PORT health checks pass. Force local-mode URLs to the
  # ports under test.
  export BACKEND_URL="http://localhost:${BACKEND_PORT}"
  export BACKEND_API_URL="http://localhost:${BACKEND_PORT}"
  export VITE_BACKEND_API_URL="http://localhost:${BACKEND_PORT}"
  # Take-control e2e seeds BrowserSession rows. Those must land in the same
  # Postgres the running backend uses (LOCAL_DB_PORT on isolated deploy stacks).
  apply_local_semantic_db_urls

  # Isolated benchmark runs in this worktree (the /deploy smoke and AgentCard
  # lanes) drain the shared Cerebras quota; its 429s push router decisions past
  # the 5s ratchet. Wait before generating the session so it cannot expire.
  if [[ "${1:-}" == "chat-lifecycle-latency" ]]; then
    . "$REPO_DIR/scripts/lib/isolated-benchmarks.sh"
    wait_for_isolated_benchmarks "$REPO_DIR" "${SEMANTIC_LATENCY_BENCH_WAIT_S:-3600}" 30
  fi

  if ! curl -sf "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
    echo "FAIL: Backend not healthy at http://localhost:$BACKEND_PORT/health" >&2
    exit 1
  fi
  if ! curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
    echo "FAIL: Frontend not accessible at http://localhost:$FRONTEND_PORT" >&2
    exit 1
  fi
fi

# Generate exactly one authenticated session for the complete Playwright run.
# Every worker injects this session instead of racing the OTP endpoints.
echo "Generating shared semantic test session..."
if [[ "$PROD_MODE" -eq 1 ]]; then
  SEMANTIC_SESSION=$(node scripts/generate-prod-test-session.mjs)
else
  SEMANTIC_SESSION=$(cd "$REPO_DIR/back-end" && npx tsx scripts/generate-test-session.ts)
fi
if [[ -z "$SEMANTIC_SESSION" ]]; then
  echo "FAIL: Could not generate semantic session. Check Supabase test credentials." >&2
  exit 1
fi
export SEMANTIC_SESSION
TEST_USER_ID=$(printf '%s' "$SEMANTIC_SESSION" | node -e \
  'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).user.id));')
export TEST_USER_ID
echo "  Session generated for test user $TEST_USER_ID"

# Ensure the test account is off the waitlist. A freshly-provisioned account
# (e.g. the prod chat-lifecycle ratchet) has usedInviteCode=null, so the app
# renders WaitlistGate instead of the chat — the agent then produces 0 realtime
# bubbles and every lifecycle assertion fails. A real user isn't gated, so the
# auto-login must land the account in the same state: redeem the master invite
# code (181818) once. Idempotent — an already-redeemed account is a no-op.
SEMANTIC_ACCESS_TOKEN=$(printf '%s' "$SEMANTIC_SESSION" | node -e \
  'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).access_token || ""));')
# Prod mode sets BACKEND_URL; local mode only sets BACKEND_PORT. Default-expand
# so `set -u` doesn't trip when BACKEND_URL is unset (local).
INVITE_BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT:-3001}}"
if [[ -n "$SEMANTIC_ACCESS_TOKEN" ]]; then
  INVITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INVITE_BACKEND_URL/api/invite-codes/use" \
    -H "Authorization: Bearer $SEMANTIC_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"inviteCode":181818}' || echo "000")
  echo "  Waitlist bypass (invite 181818) -> HTTP $INVITE_STATUS"
fi

SEMANTIC_WORKERS="${SEMANTIC_WORKERS:-1}"
if ! [[ "$SEMANTIC_WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: SEMANTIC_WORKERS must be a positive integer, got $SEMANTIC_WORKERS" >&2
  exit 1
fi

# Every Playwright worker drives one Chromium plus its trace/video encoders,
# which are CPU-bound while a page renders, so workers beyond the host's CPUs
# add latency, not throughput: every test's wall time grows with the
# oversubscription ratio and the longest test is the first to exhaust its fixed
# deadline. Size workers in both modes. Local runs share the host with other
# workspaces, so they also subtract the measured 1-minute load. The production
# gate's GitHub-hosted runner is dedicated to this job but small (two vCPUs for
# a private repository), so it caps on CPU count and free memory only; the load
# left by dependency and browser installation is transient and must not
# serialize the gate. chat-lifecycle-ratchet.yml's SEMANTIC_WORKERS is the
# ceiling, not a promise. RCA 2026-10-31-production-semantic-gate-oversubscribed-
# two-vcpu-runner: four workers on two vCPUs scaled every UI case 1.5-1.9x
# between runs of identical source and pushed the 59-78s folder-controls
# desktop case past its 90s deadline.
IFS='|' read -r HOST_CPUS HOST_LOAD1 HOST_MEM_FREE_PCT <<< "$(probe_semantic_host_capacity || true)"
REQUESTED_SEMANTIC_WORKERS="$SEMANTIC_WORKERS"
if [[ "$PROD_MODE" -eq 1 ]]; then
  SIZING_LOAD1=""
else
  SIZING_LOAD1="${HOST_LOAD1:-}"
fi
SEMANTIC_WORKERS=$(semantic_workers_for_capacity "$REQUESTED_SEMANTIC_WORKERS" "${HOST_CPUS:-}" "$SIZING_LOAD1" "${HOST_MEM_FREE_PCT:-}")
echo "  Semantic workers: requested=$REQUESTED_SEMANTIC_WORKERS effective=$SEMANTIC_WORKERS (mode=$([[ "$PROD_MODE" -eq 1 ]] && echo prod || echo local) cpus=${HOST_CPUS:-unknown} load1=${HOST_LOAD1:-unknown} sizing_load1=${SIZING_LOAD1:-ignored} mem_free_pct=${HOST_MEM_FREE_PCT:-unknown} min_mem_free_pct=${SEMANTIC_MIN_MEM_FREE_PCT:-20})"

# Resolve the test runner from this package explicitly. In the root npm
# workspace, `npx playwright` can select the backend's Playwright CLI while the
# specs import the frontend's @playwright/test singleton, making every suite
# fail during discovery with a misleading duplicate-version error.
# Prefer frontend-local .bin, then the CLI declared by the exact @playwright/test
# the specs resolve (via node), then a repo-root hoist as last resort. Resolving
# the package's own bin entry keeps the original guarantee: a shared .bin is
# flat and unnamespaced, so a same-named binary from another package can win
# there and silently run a different Playwright than the one the specs import.
PLAYWRIGHT_BIN=""
if [[ -x "$FRONTEND_DIR/node_modules/.bin/playwright" ]]; then
  PLAYWRIGHT_BIN="$FRONTEND_DIR/node_modules/.bin/playwright"
fi
PLAYWRIGHT_CLI=""
if [[ -z "$PLAYWRIGHT_BIN" ]]; then
  PLAYWRIGHT_CLI="$(cd "$FRONTEND_DIR" 2>/dev/null || exit 0; node -e "
    const path = require('path');
    const pkgPath = require.resolve('@playwright/test/package.json');
    const bin = require(pkgPath).bin;
    const rel = typeof bin === 'string' ? bin : bin && bin.playwright;
    if (!rel) process.exit(1);
    console.log(path.join(path.dirname(pkgPath), rel));
  " 2>/dev/null || true)"
fi
if [[ -z "$PLAYWRIGHT_BIN" && ! -f "$PLAYWRIGHT_CLI" && -x "$REPO_DIR/node_modules/.bin/playwright" ]]; then
  PLAYWRIGHT_BIN="$REPO_DIR/node_modules/.bin/playwright"
fi
if [[ -z "$PLAYWRIGHT_BIN" && ! -f "$PLAYWRIGHT_CLI" ]]; then
  echo "FAIL: Frontend Playwright is not installed (checked front-end/, @playwright/test package, and repo-root .bin)" >&2
  exit 1
fi

# Prefer the frontend-local symlink; otherwise run the resolved package CLI
# under node so the exact @playwright/test the specs import is what executes.
run_playwright() {
  if [[ -x "$PLAYWRIGHT_BIN" ]]; then
    exec "$PLAYWRIGHT_BIN" "$@"
  fi
  exec node "$PLAYWRIGHT_CLI" "$@"
}

# Optional native evidence output; the ordinary command and test policy stay intact.
SEMANTIC_REPORTERS=list
SEMANTIC_OUTPUT_ARGS=()
if [[ -n "${SEMANTIC_NATIVE_REPORT_PREFIX:-}" ]]; then
  [[ "$SEMANTIC_NATIVE_REPORT_PREFIX" = /* ]] || { echo "Native report prefix must be absolute" >&2; exit 2; }
  export PLAYWRIGHT_JSON_OUTPUT_FILE="${SEMANTIC_NATIVE_REPORT_PREFIX}.json"
  export DEPLOY_SEMANTIC_LIFECYCLE="${SEMANTIC_NATIVE_REPORT_PREFIX}.jsonl"
  [[ ! -e "$PLAYWRIGHT_JSON_OUTPUT_FILE" && ! -e "$DEPLOY_SEMANTIC_LIFECYCLE" ]] || { echo "Native report already exists" >&2; exit 2; }
  SEMANTIC_REPORTERS="list,json,$REPO_DIR/scripts/deploy-semantic-reporter.cjs"
  SEMANTIC_OUTPUT_ARGS=("--output=${SEMANTIC_NATIVE_REPORT_PREFIX}-artifacts")
fi

if [[ $# -eq 0 ]]; then
  PLAYWRIGHT_ARGS=(--reporter="$SEMANTIC_REPORTERS" --workers="$SEMANTIC_WORKERS" ${SEMANTIC_OUTPUT_ARGS[@]+"${SEMANTIC_OUTPUT_ARGS[@]}"})
  if [[ -n "${SEMANTIC_GREP_INVERT:-}" ]]; then
    PLAYWRIGHT_ARGS+=(--grep-invert="$SEMANTIC_GREP_INVERT")
  fi
  run_playwright test "${PLAYWRIGHT_ARGS[@]}"
fi

TEST_NAME="$1"
TEST_FILE="tests-e2e/${TEST_NAME}.spec.ts"
if [[ ! -f "$TEST_FILE" ]]; then
  echo "Error: No semantic test found: $TEST_NAME" >&2
  echo "Available:" >&2
  for f in tests-e2e/*.spec.ts; do
    [ -f "$f" ] || continue
    echo "  $(basename "$f" .spec.ts)" >&2
  done
  exit 1
fi

run_playwright test "$TEST_FILE" --reporter="$SEMANTIC_REPORTERS" --workers="$SEMANTIC_WORKERS" ${SEMANTIC_OUTPUT_ARGS[@]+"${SEMANTIC_OUTPUT_ARGS[@]}"}
