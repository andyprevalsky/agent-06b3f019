#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloudbench-run.sh — the on-box, DETACHED per-run driver for the warm cloud box.
#
# Runs ON the persistent Fly machine (app: navi-whisper-lux-bench). It is NOT the
# image CMD and is NOT held open by an SSH session: run-bench-cloud writes this
# script to /tmp/rb.sh and launches it DETACHED
#     setsid bash /tmp/rb.sh > /data/bench.log 2>&1 < /dev/null &
# then polls /data/bench.log for the DONE marker over SEPARATE short ssh -C reads.
# (flyctl ssh console -C BUFFERS stdout until the session ends AND returns exit
# 4294967295 whenever the remote command backgrounds a process — so a foreground,
# session-held run is unusable here. Detach + poll-a-logfile is the only pattern
# that survives.)
#
# Everything is HANDS-OFF + WARM:
#   - /data persists across machine stop/start (the container's baked /app does NOT).
#   - /data/repo is a pre-authenticated git checkout (remote URL already carries a
#     working repo token — no token handling needed here).
#   - /data/world-model is a PRE-BUILT WMH model. We SERVE it (never build from R2:
#     R2→Fly is throttled to ~14 KB/s = hours). run.sh serves a pre-built model with
#     no R2 access when WMH_BUILD_DIR=/data/world-model AND BENCHMARK_SKIP_WMH_DELTA=1.
#   - Deps (agents venv + node_modules) are baked into /app; manifest fingerprints
#     refresh the volume trees when the donor image changes and reject stale images.
#
# Per-run flow:
#   1. cd /data/repo → git fetch/checkout/reset --hard "$REF" (pre-authed remote).
#   2. Decode AGENTS_ENV_B64 / BACKEND_ENV_B64 → repo .env files.
#   3. Fingerprint + sync baked venv/node_modules from /app → /data/repo.
#   4. Ensure the system Postgres cluster is up + the victoria DB exists (:5432).
#   5. Stage the live dashboard (copy dashboard.html into the context dir + start a
#      static http server rooted there on DASHPORT) so run-bench-cloud can proxy it.
#   6. Launch scripts/run.sh --benchmark (from /data/repo) in the BACKGROUND with the
#      isolated + simulate + serve-cached-WMH env.
#   7. Wait for services.json status=running AND curl localhost:3007/healthz.
#   8. Run run_benchmark.py for the requested tasks (--parallel/--max-concurrency
#      when >1) against the catalog-mandated production or isolated target.
#   9. Print the DONE marker + the report card between BEGIN/END markers.
#
# Inputs (all from env, exported by run-bench-cloud's on-box invocation):
#   REF                 branch/sha to sync + run (required; defaults to HEAD if empty)
#   WMH_MODEL_NAME      cached WMH model artifact name (default rose-r2-archive-anthropic)
#   BENCH_TASKS         comma- OR space-separated task list (required)
#   BENCH_MAX_CONCURRENCY  max concurrent tasks when >1 task (default 5)
#   BENCH_SIMULATE      "1" simulate (default) | "0" real mode (no WMH)
#   BENCH_DASHPORT      port for the on-box static dashboard server (default 8009)
#
# Runs as root (needs to start the Postgres cluster); drops to `rose` via gosu for
# the stack + benchmark. This script does NOT stop the machine — run-bench-cloud
# stops it after retrieving results.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_DIR="${CLOUDBENCH_REPO_DIR:-/data/repo}"
DEPS_DIR="${CLOUDBENCH_DEPS_DIR:-/app}"           # baked dependency donor image.
WMH_DIR="${CLOUDBENCH_WMH_DIR:-/data/world-model}"
APP_USER=rose
CONTEXT_DIR="$REPO_DIR/.context/cloudbench"
RUN_OUTPUT_MARKER="/tmp/cloudbench-run-start.$$"
FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-$REPO_DIR/scripts/cloudbench-fetch-ref.sh}"
SYNC_DEPS_SCRIPT="${CLOUDBENCH_SYNC_DEPS_SCRIPT:-$REPO_DIR/scripts/cloudbench-sync-deps.sh}"
SYNC_PRISMA_SCRIPT="${CLOUDBENCH_SYNC_PRISMA_SCRIPT:-$REPO_DIR/scripts/cloudbench-sync-prisma-client.sh}"
CURRENT_RUN_ARTIFACT_SCRIPT="${CLOUDBENCH_CURRENT_RUN_ARTIFACT_SCRIPT:-$REPO_DIR/scripts/cloudbench-current-run-artifact.py}"
PREPARE_PATCH_SCRIPT="${CLOUDBENCH_PREPARE_PATCH_SCRIPT:-$REPO_DIR/scripts/cloudbench-prepare-patch.sh}"
STATUS_SERVER_SCRIPT="${CLOUDBENCH_STATUS_SERVER_SCRIPT:-$REPO_DIR/scripts/cloudbench-status-server.py}"
BENCHMARK_TARGET_SCRIPT="${CLOUDBENCH_BENCHMARK_TARGET_SCRIPT:-$REPO_DIR/scripts/cloudbench-benchmark-target.py}"

# ── Inputs (env) ────────────────────────────────────────────────────────────
REF="${REF:-}"
WMH_MODEL_NAME="${WMH_MODEL_NAME:-rose-r2-archive-anthropic}"
BENCH_TASKS="${BENCH_TASKS:-}"
# The controller passes the task list base64-encoded (BENCH_TASKS_B64) so commas
# survive the base64/exec layers verbatim; fall back to a raw BENCH_TASKS.
if [ -n "${BENCH_TASKS_B64:-}" ]; then
    BENCH_TASKS="$(printf '%s' "$BENCH_TASKS_B64" | base64 -d 2>/dev/null || printf '%s' "$BENCH_TASKS")"
fi
BENCH_MAX_CONCURRENCY="${BENCH_MAX_CONCURRENCY:-5}"
BENCH_SIMULATE="${BENCH_SIMULATE:-1}"
BENCH_DASHPORT="${BENCH_DASHPORT:-8009}"
BENCHMARK_FAST_MODE_CACHE="${BENCHMARK_FAST_MODE_CACHE:-}"
BENCHMARK_PEAK_FLY_MACHINES="${BENCHMARK_PEAK_FLY_MACHINES:-}"
BENCHMARK_VM_USD_PER_HOUR="${BENCHMARK_VM_USD_PER_HOUR:-}"
BENCHMARK_FRONTEND_URL="${BENCHMARK_FRONTEND_URL:-}"
BENCHMARK_REPORT_FRONTEND_URL="${BENCHMARK_REPORT_FRONTEND_URL:-}"
CLOUDBENCH_START_BARRIER="${CLOUDBENCH_START_BARRIER:-}"
CLOUDBENCH_BARRIER_TOKEN="${CLOUDBENCH_BARRIER_TOKEN:-}"
CLOUDBENCH_STATUS_PORT="${CLOUDBENCH_STATUS_PORT:-8011}"
CLOUDBENCH_RUN_TOKEN="${CLOUDBENCH_RUN_TOKEN:-}"
STACK_SEED_DUMP="${CLOUDBENCH_SEED_DUMP_PATH:-/data/cloudbench-cache/victoria-seed.dump}"

if [ -n "$CLOUDBENCH_RUN_TOKEN" ]; then
    case "$CLOUDBENCH_RUN_TOKEN" in
        *[!a-zA-Z0-9._-]*)
            echo "[cloudbench] FATAL: invalid run token"
            exit 2
            ;;
    esac
fi
MARKER_SUFFIX=""
[ -n "$CLOUDBENCH_RUN_TOKEN" ] && MARKER_SUFFIX=" token=$CLOUDBENCH_RUN_TOKEN"

# Report/marker delimiters run-bench-cloud greps for in /data/bench.log.
REPORT_BEGIN="::CLOUDBENCH-REPORT-CARD-BEGIN::$MARKER_SUFFIX"
REPORT_END="::CLOUDBENCH-REPORT-CARD-END::$MARKER_SUFFIX"
RESULT_BEGIN="::CLOUDBENCH-RESULT-BEGIN::$MARKER_SUFFIX"
RESULT_END="::CLOUDBENCH-RESULT-END::$MARKER_SUFFIX"
DONE_MARKER="::CLOUDBENCH-DONE::$MARKER_SUFFIX"

log() { echo "[cloudbench $(date -u +%H:%M:%S)] $*"; }
# Step markers: STEP <name> lines are machine-parseable timing boundaries for
# scripts/cloudbench-bring-up-report.py — isolate each bring-up step's cost.
step() { log "STEP $*"; }

# stack_wait_budget_seconds: the box's fallback-safe stack-health ceiling. A
# pre-launch dump check cannot prove run.sh will restore instead of cold-syncing,
# so matching dumps retain the larger ceiling without delaying healthy startup.
# See scripts/tests/cloudbench-seed-budget.test.sh.
# run-bench-cloud sftp's this lib to /data/ and overrides CLOUDBENCH_SEED_BUDGET_LIB,
# exactly like cloudbench-fetch-ref.sh / cloudbench-sync-deps.sh: at driver start the
# /data/repo checkout is still at the OLD ref (the driver git-fetches the ref later),
# so the lib must come from the controller-staged /data copy, not /data/repo.
SEED_BUDGET_LIB="${CLOUDBENCH_SEED_BUDGET_LIB:-$REPO_DIR/scripts/lib/cloudbench-seed-budget.sh}"
if [ ! -f "$SEED_BUDGET_LIB" ]; then
    echo "[cloudbench] FATAL: seed-budget lib missing: $SEED_BUDGET_LIB" >&2
    exit 1
fi
# shellcheck source=lib/cloudbench-seed-budget.sh
source "$SEED_BUDGET_LIB"

run_with_heartbeat() {
    local label="$1" command_pid interval
    shift
    interval="${CLOUDBENCH_HEARTBEAT_SECONDS:-30}"
    "$@" &
    command_pid=$!
    while kill -0 "$command_pid" 2>/dev/null; do
        sleep "$interval"
        if kill -0 "$command_pid" 2>/dev/null; then
            log "$label heartbeat (pid=$command_pid)"
        fi
    done
    wait "$command_pid"
}

# ── Normalize the task list (comma OR space separated) into an array ────────
# The controller may pass "a,b,c" or "a b c"; accept both.
read -r -a BENCH_TASK_LIST <<< "$(printf '%s' "$BENCH_TASKS" | tr ',' ' ')"
BENCH_ENABLE_NON_PURCHASE_GATES=0
for task_name in "${BENCH_TASK_LIST[@]}"; do
    case "$task_name" in
        gate-source-connect-gmail)
            BENCH_ENABLE_NON_PURCHASE_GATES=1
            ;;
    esac
done

emit_report_and_result() {
    # Always surface whatever report card / run results exist, even on failure,
    # so the controller can retrieve output from /data/bench.log as a fallback
    # even when the direct-fetch ssh reads race the machine stop.
    local card="$CONTEXT_DIR/report-card.json"
    local latest_run
    latest_run="$(python3 "$CURRENT_RUN_ARTIFACT_SCRIPT" "$REPO_DIR/agents/benchmarks/runs" "$RUN_OUTPUT_MARKER" 2>/dev/null || true)"
    if [ -n "$latest_run" ] && [ -f "$latest_run" ]; then
        cp -f "$latest_run" "$CONTEXT_DIR/run.json" 2>/dev/null || true
        chown "$APP_USER:$APP_USER" "$CONTEXT_DIR/run.json" 2>/dev/null || true
    fi
    echo "$REPORT_BEGIN"
    if [ -f "$card" ] && [ "$card" -nt "$RUN_OUTPUT_MARKER" ]; then
        cat "$card"
    else
        echo '{"error":"no report-card.json produced"}'
    fi
    echo ""
    echo "$REPORT_END"

    echo "$RESULT_BEGIN"
    if [ -n "$latest_run" ] && [ -f "$latest_run" ]; then
        echo "run_file: $latest_run"
        cat "$latest_run"
    else
        echo '{"error":"no fresh matching benchmark run produced"}'
    fi
    echo ""
    echo "$RESULT_END"
}

# Best-effort teardown of the static dashboard server started in step 5.
DASH_PID=""
STATUS_PID=""
stop_dashboard() {
    [ -n "$DASH_PID" ] || return 0
    kill "$DASH_PID" 2>/dev/null || true
    DASH_PID=""
}

stop_status_server() {
    [ -n "$STATUS_PID" ] || return 0
    kill "$STATUS_PID" 2>/dev/null || true
    STATUS_PID=""
}

finish() {
    local code="${1:-0}"
    emit_report_and_result || true
    stop_dashboard
    echo "$DONE_MARKER exit=$code"
    exit "$code"
}

if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    case "$CLOUDBENCH_START_BARRIER" in
        *[!a-zA-Z0-9._-]*)
            log "FATAL: invalid synchronized start barrier token"
            finish 1
            ;;
    esac
fi

# ── 0. Sanity: the volume + repo checkout must exist (created at box setup) ──
if [ ! -d "$REPO_DIR/.git" ]; then
    log "FATAL: $REPO_DIR is not a git checkout (expected a pre-authed volume checkout)"
    finish 1
fi
cd "$REPO_DIR" || { log "FATAL: cannot cd $REPO_DIR"; finish 1; }

# Snapshot clones retain the source machine's ignored .context tree. Clear it
# before any setup step that can fail so an infrastructure error can never be
# presented as a benchmark result from the snapshot's previous run.
rm -rf "$CONTEXT_DIR"
mkdir -p "$CONTEXT_DIR"
chown -R "$APP_USER:$APP_USER" "$REPO_DIR/.context"
touch "$RUN_OUTPUT_MARKER"
printf '%s\n' "$$" > /data/cloudbench-driver.pid
if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    rm -f "/data/cloudbench-start-$CLOUDBENCH_START_BARRIER.ready" \
        "/data/cloudbench-start-$CLOUDBENCH_START_BARRIER.release"
fi

# ── 1. git-sync the branch/sha under test ───────────────────────────────────
step git_sync
# The volume checkout's origin URL already embeds a working repo token (set at
# box provisioning), so a plain fetch/checkout/reset needs NO token handling here.
if [ -n "$REF" ]; then
    log "git-syncing + verifying $REPO_DIR → $REF"
    if ! CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not verify requested ref $REF"
        finish 1
    fi
fi
# The controller credential is needed only for this exact fetch. Do not let it
# flow into the benchmark stack, workers, or agent subprocess environments.
unset CLOUDBENCH_GITHUB_TOKEN_B64
# reset --hard does not remove untracked files created by an earlier uploaded
# worktree patch. Remove only non-ignored untracked files; dependency/cache trees
# are ignored and remain warm.
if ! gosu "$APP_USER" git -C "$REPO_DIR" clean -fd 2>&1 | sed 's/^/   /'; then
    log "FATAL: could not remove stale untracked worktree files"
    finish 1
fi
log "checkout at $(gosu "$APP_USER" git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "${LOCAL_PATCH_FILE:-}" ]; then
    [ -s "$LOCAL_PATCH_FILE" ] || {
        log "FATAL: declared local patch payload is missing or empty"
        finish 1
    }
    [ -n "${LOCAL_PATCH_SHA256:-}" ] || {
        log "FATAL: local patch payload has no checksum"
        finish 1
    }
    _actual_patch_sha="$(sha256sum "$LOCAL_PATCH_FILE" | awk '{print $1}')"
    [ "$_actual_patch_sha" = "$LOCAL_PATCH_SHA256" ] || {
        log "FATAL: patch payload checksum mismatch"
        finish 1
    }
    log "applying uploaded local workspace patch on top of checkout"
    if ! bash "$PREPARE_PATCH_SCRIPT" "$REPO_DIR" "$LOCAL_PATCH_FILE"; then
        log "FATAL: could not prepare uploaded local workspace patch"
        finish 1
    fi
    if ! gosu "$APP_USER" git -C "$REPO_DIR" apply --whitespace=nowarn - \
        < "$LOCAL_PATCH_FILE" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not apply uploaded local workspace patch"
        finish 1
    fi
    log "verified local workspace patch $_actual_patch_sha"
fi

# Replace the bootstrap read-only http.server with the ref's authenticated
# data-plane server. The same WireGuard proxy keeps serving bench.log, while the
# controller can now release the synchronized barrier without an SSH/API burst.
pkill -f "http.server $CLOUDBENCH_STATUS_PORT" 2>/dev/null || true
pkill -f "cloudbench-status-server.py.*--port $CLOUDBENCH_STATUS_PORT" 2>/dev/null || true
if [ ! -f "$STATUS_SERVER_SCRIPT" ]; then
    log "FATAL: missing $STATUS_SERVER_SCRIPT"
    finish 1
fi
setsid python3 "$STATUS_SERVER_SCRIPT" \
    --directory /data \
    --port "$CLOUDBENCH_STATUS_PORT" \
    --barrier "$CLOUDBENCH_START_BARRIER" \
    >/dev/null 2>&1 </dev/null &
STATUS_PID=$!

# ── 2. Decode injected secrets into the repo .env files the stack reads ─────
step env_decode
# Fly secrets are exposed as env vars in the machine init AND in ssh sessions.
ENV_HELPER="$REPO_DIR/scripts/lib/cloudbench-env.sh"
[ -f "$ENV_HELPER" ] || { log "FATAL: missing $ENV_HELPER"; finish 1; }
# shellcheck source=lib/cloudbench-env.sh
source "$ENV_HELPER"
umask 077
if [ -n "${AGENTS_ENV_B64:-}" ]; then
    echo "$AGENTS_ENV_B64" | base64 -d > "$REPO_DIR/agents/.env" || { log "FATAL: failed to decode AGENTS_ENV_B64"; finish 1; }
    log "wrote agents/.env ($(wc -l < "$REPO_DIR/agents/.env") lines)"
else
    log "FATAL: AGENTS_ENV_B64 secret is not set"; finish 1
fi
if [ -n "${BACKEND_ENV_B64:-}" ]; then
    echo "$BACKEND_ENV_B64" | base64 -d > "$REPO_DIR/back-end/.env" || { log "FATAL: failed to decode BACKEND_ENV_B64"; finish 1; }
    log "wrote back-end/.env ($(wc -l < "$REPO_DIR/back-end/.env") lines)"
else
    log "FATAL: BACKEND_ENV_B64 secret is not set"; finish 1
fi
chown "$APP_USER:$APP_USER" "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
chmod 600 "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
cloudbench_verify_env_file "$REPO_DIR/agents/.env" "${AGENTS_ENV_SHA256:-}" agents || finish 1
cloudbench_verify_env_file "$REPO_DIR/back-end/.env" "${BACKEND_ENV_SHA256:-}" backend || finish 1
cloudbench_validate_browser_provider_contract \
    "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env" \
    "${CLOUDBENCH_BROWSER_PROVIDER:-}" "${CLOUDBENCH_BROWSER_PROVIDER:-}" || finish 1

# ── 3. Sync baked deps from the image into the volume checkout ──────────────
step dep_sync
# A persistent volume can outlive many donor images. Missing-only checks leave
# old package trees behind after package-lock/requirements changes, so compare
# fingerprints and refresh atomically from the image. A donor/ref mismatch is a
# hard infrastructure error: the image must be rebuilt before this ref can run.
if ! bash "$SYNC_DEPS_SCRIPT" "$DEPS_DIR" "$REPO_DIR"; then
    log "FATAL: cloudbench dependency synchronization failed"
    finish 1
fi

# Prisma's generated client is compiled from schema.prisma, not just the npm
# manifests. A warm dependency tree can therefore be package-current but
# schema-stale when a benchmark checks out another ref or applies a local patch.
if ! bash "$SYNC_PRISMA_SCRIPT" "$REPO_DIR" "$APP_USER"; then
    log "FATAL: Prisma client synchronization failed"
    finish 1
fi
chown -R "$APP_USER:$APP_USER" "$REPO_DIR/node_modules" "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/venv" 2>/dev/null || true

# ── 4. Pin a stable single-tenant workspace + base port for this box ────────
BASE_PORT="${CONDUCTOR_PORT:-3001}"
WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-cloudbench}"
cat > "$REPO_DIR/.cloud-env" <<EOF
# Generated by cloudbench-run.sh — single-tenant warm cloud bench box.
export CONDUCTOR_PORT=${BASE_PORT}
export CONDUCTOR_WORKSPACE_NAME=${WORKSPACE_NAME}
export CONDUCTOR_ROOT_PATH=${REPO_DIR}
EOF
chown "$APP_USER:$APP_USER" "$REPO_DIR/.cloud-env"
WMH_PORT=$((BASE_PORT + 6))   # run.sh: WMH_PORT = base + 6 (3001 → 3007).

# ── 5. System Postgres (no Docker on Fly) ──────────────────────────────────
step postgres
log "ensuring system Postgres cluster (victoria on :5432)..."
PG_VER="$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')"
if [ -z "$PG_VER" ]; then
    PG_VER="$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -1)"
    if [ -n "$PG_VER" ]; then
        pg_createcluster "$PG_VER" main 2>/dev/null || true
    fi
fi
pg_ctlcluster "$PG_VER" main start 2>/dev/null || service postgresql start 2>/dev/null || true

PG_READY=false
for _ in $(seq 1 30); do
    if pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null || pg_isready -q 2>/dev/null; then
        PG_READY=true
        break
    fi
    sleep 1
done
if ! $PG_READY; then
    log "FATAL: system Postgres did not become ready"
    pg_lsclusters || true
    finish 1
fi
su - postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" 2>/dev/null || true
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='victoria'\" | grep -q 1 || createdb victoria" 2>/dev/null || true
PG_HBA="$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)"
if [ -n "$PG_HBA" ]; then
    sed -i 's/^local\s\+all\s\+all\s\+peer/local   all             all                                     md5/' "$PG_HBA"
    sed -i 's/^\(host\s\+all\s\+all\s\+127\.0\.0\.1\/32\s\+\)\(scram-sha-256\|ident\)/\1md5/' "$PG_HBA"
    sed -i 's/^\(host\s\+all\s\+all\s\+::1\/128\s\+\)\(scram-sha-256\|ident\)/\1md5/' "$PG_HBA"
    pg_ctlcluster "$PG_VER" main reload 2>/dev/null || service postgresql reload 2>/dev/null || true
fi
log "system Postgres ready (victoria on :5432)"

# ── 6. Guard the cached WMH model (simulate serves it verbatim — no R2 read) ─
if [ "$BENCH_SIMULATE" = "1" ]; then
    if [ ! -f "$WMH_DIR/build.manifest.json" ] || [ ! -d "$WMH_DIR/models/$WMH_MODEL_NAME" ]; then
        log "FATAL: no cached WMH model at $WMH_DIR/models/$WMH_MODEL_NAME"
        log "       (expected a PRE-BUILT volume model — never build from R2 at run time)"
        finish 1
    fi
fi

chown -R "$APP_USER:$APP_USER" "$WMH_DIR" 2>/dev/null || true

# ── 7. Stage + serve the live dashboard (proxied to the Mac by run-bench-cloud) ─
# Copy dashboard.html into the context dir (same logic as
# benchmarks/dashboard.py:write_dashboard_asset — the page fetch()es
# report-card.json from its own directory, so the asset must sit alongside it),
# then serve that dir over HTTP on DASHPORT. run-bench-cloud `flyctl proxy`es this
# port to the Mac and opens http://localhost:<localport>/dashboard.html in Chrome.
DASH_SRC="$REPO_DIR/agents/benchmarks/dashboard.html"
if [ -f "$DASH_SRC" ]; then
    cp -f "$DASH_SRC" "$CONTEXT_DIR/dashboard.html" 2>/dev/null || true
    chown "$APP_USER:$APP_USER" "$CONTEXT_DIR/dashboard.html" 2>/dev/null || true
    log "staged dashboard asset → $CONTEXT_DIR/dashboard.html"
else
    log "WARN: dashboard.html not found at $DASH_SRC — dashboard page will 404 (run continues)"
fi
# Serve the context dir. python3 http.server binds all interfaces so the Fly
# proxy (which connects to the machine's private IP) can reach it.
gosu "$APP_USER" env HOME=/home/$APP_USER \
    python3 -m http.server "$BENCH_DASHPORT" --directory "$CONTEXT_DIR" \
    > "$CONTEXT_DIR/dashboard-server.log" 2>&1 &
DASH_PID=$!
log "dashboard static server pid=$DASH_PID on :$BENCH_DASHPORT (root $CONTEXT_DIR)"

# ── 8. Launch the stack (run.sh --benchmark) — SERVE the cached WMH ─────────
step stack_launch
# WMH_BUILD_DIR points run.sh at the cached model on the volume;
# BENCHMARK_SKIP_WMH_DELTA=1 makes run.sh SERVE it verbatim with NO R2 read / delta
# refresh / rebuild. FLY_APP_NAME="" disables the worker's prod-style fleet
# autoscaler (the Fly runtime injects the app name; _scale_fleet() would otherwise
# hammer the Fly API with the prod-scoped token → 403 log spam).
ensure_cloudflared_agent() {
    command -v cloudflared >/dev/null 2>&1 && return 0
    log "cloudflared missing from warm image — installing official release"
    local attempt
    for attempt in 1 2 3; do
        rm -f /tmp/cloudflared.deb
        if curl -fsSL --connect-timeout 10 --max-time 120 \
                "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb" \
                -o /tmp/cloudflared.deb \
            && apt-get install -y -qq --no-install-recommends /tmp/cloudflared.deb; then
            rm -f /tmp/cloudflared.deb
            command -v cloudflared >/dev/null 2>&1 && return 0
        fi
        log "cloudflared install attempt $attempt/3 failed"
        sleep 2
    done
    rm -f /tmp/cloudflared.deb
    return 1
}

if [ "$BENCH_SIMULATE" != "1" ]; then
    if ! ensure_cloudflared_agent; then
        log "FATAL: could not install cloudflared for isolated benchmark webhooks"
        finish 1
    fi
fi

STACK_LOG="$CONTEXT_DIR/stack.log"
STACK_ENV=(
    "HOME=/home/$APP_USER"
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "BENCHMARK_ISOLATED_RUN=true"
    "BENCHMARK_CONTEXT_DIR=$CONTEXT_DIR"
    "CONDUCTOR_PORT=$BASE_PORT"
    "CONDUCTOR_WORKSPACE_NAME=$WORKSPACE_NAME"
    "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1"
    "DISABLE_GMAIL_SYNC=1"
    "FLY_APP_NAME="
    # Compute-only autoscaler: the box worker still computes desired_machine_count
    # (exposed on HEALTH_CHECK_PORT/metrics with prod's params) but NEVER actuates
    # the shared bench app. run-bench-cloud's per-bench autoscaler is the sole
    # scaler, cloning bench-queue-scoped worker machines. FLY_APP_NAME="" already
    # short-circuits _scale_fleet; this makes the intent explicit + defends the
    # worker-only pool nodes too.
    "AUTOSCALER_ACTUATE=0"
    # A bench starts at ONE machine (the box itself). The worker then computes
    # desired off its own queue with prod's scale params; the controller adds
    # workers from there. Prod's default MIN=2 would make an idle bench look like
    # it wants a 2nd machine, so pin the per-bench floor to 1.
    "MIN_MACHINES=1"
    # Warm-start cache: run.sh restores this /data dump (persists across stop/start
    # + fork) instead of the ~50s push+seed when the schema is unchanged. First run
    # on a machine seeds + writes it; later claims restore in seconds.
    "BENCHMARK_SEED_DUMP=$STACK_SEED_DUMP"
    "WMH_MODEL_NAME=$WMH_MODEL_NAME"
    "WMH_BUILD_DIR=$WMH_DIR"
    "BENCHMARK_SKIP_WMH_DELTA=1"
    # The isolated stack is launched through `env` with this allow-list. Keep the
    # controller's provider exclusion inside that environment so the WMH Rose
    # provider cannot lease/use Claude after the outer runner explicitly disabled
    # the Anthropic family.
    "ROSE_EXCLUDE_ANTHROPIC_FAMILY=${ROSE_EXCLUDE_ANTHROPIC_FAMILY:-}"
)
if [ -n "$BENCHMARK_FAST_MODE_CACHE" ]; then
    STACK_ENV+=("BENCHMARK_FAST_MODE_CACHE=$BENCHMARK_FAST_MODE_CACHE")
fi
if [ -n "$BENCHMARK_PEAK_FLY_MACHINES" ]; then
    STACK_ENV+=("BENCHMARK_PEAK_FLY_MACHINES=$BENCHMARK_PEAK_FLY_MACHINES")
fi
if [ -n "$BENCHMARK_VM_USD_PER_HOUR" ]; then
    STACK_ENV+=("BENCHMARK_VM_USD_PER_HOUR=$BENCHMARK_VM_USD_PER_HOUR")
fi
if [ "$BENCH_ENABLE_NON_PURCHASE_GATES" = "1" ]; then
    STACK_ENV+=("NON_PURCHASE_GATES_ENABLED=1")
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    STACK_ENV+=(
        "BENCHMARK_WORLD_MODEL_MODE=simulate"
        "BENCHMARK_SKIP_PUBLIC_TUNNEL=1"
        "BENCHMARK_SKIP_BROWSER_AUTH_SYNC=1"
        "BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE=1"
        "WMH_BASE_URL=http://localhost:$WMH_PORT"
    )
else
    STACK_ENV+=(
        "BENCHMARK_SKIP_WMH_BUILD=1"
        # Each isolated VM gets a random Quick Tunnel URL for this run. The URL
        # is process-scoped, so concurrent benchmark stacks cannot share traffic.
        "BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1"
    )
fi

# The DB warm-start dump lives on the /data volume (persists across stop/start +
# fork) but must be writable by $APP_USER — /data itself is root-owned and
# /data/repo gets `git reset --hard`'d, so use a dedicated cache dir we chown.
mkdir -p /data/cloudbench-cache && chown "$APP_USER:$APP_USER" /data/cloudbench-cache 2>/dev/null || true

log "launching stack (run.sh --benchmark) — base_port=$BASE_PORT wmh_port=$WMH_PORT workspace=$WORKSPACE_NAME simulate=$BENCH_SIMULATE"
gosu "$APP_USER" env "${STACK_ENV[@]}" bash "$REPO_DIR/scripts/run.sh" --benchmark > "$STACK_LOG" 2>&1 &
STACK_PID=$!
log "stack pid=$STACK_PID (logs → $STACK_LOG)"

tail -n +1 -F "$STACK_LOG" &
TAIL_PID=$!

cleanup_stack() {
    kill "$TAIL_PID" 2>/dev/null || true
    stop_dashboard
    if kill -0 "$STACK_PID" 2>/dev/null; then
        kill -TERM "-$STACK_PID" 2>/dev/null || kill -TERM "$STACK_PID" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "$STACK_PID" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$STACK_PID" 2>/dev/null || true
    fi
}
trap 'cleanup_stack' EXIT

# ── 9. Wait for services.json (status=running) + WMH health ────────────────
step services_wait
MANIFEST="$CONTEXT_DIR/services.json"
BACKEND_PORT="$BASE_PORT"
HEALTH_PORT=$((BASE_PORT + 2))

log "waiting for stack to become healthy (services.json + backend + worker + WMH)..."
STACK_READY=false
STATUS="none"
# No WMH build happens on this path (the cached model is served verbatim). The
# larger configured first-run ceiling covers production sync + DB dump + service
# startup even if run.sh rejects a dump that looked restorable at preflight. A
# successful warm restore still exits this loop as soon as health is ready.
STACK_WAIT_SECONDS="$(stack_wait_budget_seconds)"
if [ ! -s "$STACK_SEED_DUMP" ]; then
    log "first-run seed dump absent — using cold stack health budget ${STACK_WAIT_SECONDS}s"
fi
for i in $(seq 1 "$STACK_WAIT_SECONDS"); do
    if ! kill -0 "$STACK_PID" 2>/dev/null; then
        # Capture the ACTUAL death cause. "see stack log above" was a dead end at
        # fleet width: the stack log truncated mid-startup with no error, leaving
        # the failure unclassifiable (OOM? sync error? signal?). Record the exit
        # code (rc=137 ⇒ SIGKILL/OOM), the stack-log tail, and a dmesg OOM probe
        # so a sporadic bring-up death is diagnosable from the pulled-back logs.
        wait "$STACK_PID" 2>/dev/null; stack_rc=$?
        log "FATAL: stack process exited (rc=$stack_rc) before becoming healthy after ${i}s"
        log "───── last 40 lines of stack log ($STACK_LOG) ─────"
        tail -40 "$STACK_LOG" 2>/dev/null | while IFS= read -r _line; do log "  | $_line"; done
        if [ "$stack_rc" = 137 ] || dmesg 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
            log "  ⚠️ rc=137/OOM signature — stack was SIGKILLed (likely out-of-memory); check machine RAM vs concurrent service footprint"
        fi
        finish 1
    fi
    if [ -f "$MANIFEST" ]; then
        STATUS="$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('status',''))" 2>/dev/null || echo "")"
        if [ "$STATUS" = "running" ] \
            && curl -fsS "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1 \
            && curl -fsS "http://localhost:$HEALTH_PORT/health" >/dev/null 2>&1; then
            if [ "$BENCH_SIMULATE" = "1" ]; then
                if curl -fsS "http://localhost:$WMH_PORT/healthz" >/dev/null 2>&1; then
                    STACK_READY=true
                    break
                fi
            else
                STACK_READY=true
                break
            fi
        fi
    fi
    if [ $((i % 30)) -eq 0 ]; then
        WMH_TAIL="$(tail -1 "$CONTEXT_DIR/wmh-serve-log.txt" 2>/dev/null || true)"
        log "…still waiting (${i}s): status=${STATUS:-none} wmh=[${WMH_TAIL}]"
    fi
    sleep 1
done

if ! $STACK_READY; then
    log "FATAL: stack did not become healthy within the timeout"
    log "─── tail of stack log ───"
    tail -80 "$STACK_LOG" || true
    finish 1
fi
log "stack healthy — backend :$BACKEND_PORT, WMH :$WMH_PORT, dashboard :$BENCH_DASHPORT"

# Fleet batches hold every task here until every isolated stack is healthy.
# The controller releases all machines together, so slow database/bootstrap
# work cannot turn a nominally parallel batch into serial benchmark execution.
if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    BARRIER_READY="/data/cloudbench-start-$CLOUDBENCH_START_BARRIER.ready"
    BARRIER_RELEASE="/data/cloudbench-start-$CLOUDBENCH_START_BARRIER.release"
    touch "$BARRIER_READY"
    log "synchronized start barrier ready: $CLOUDBENCH_START_BARRIER"
    BARRIER_RELEASED=false
    for _ in $(seq 1 "${CLOUDBENCH_START_BARRIER_WAIT_SECONDS:-900}"); do
        if [ -f "$BARRIER_RELEASE" ]; then
            BARRIER_RELEASED=true
            break
        fi
        sleep 1
    done
    if ! $BARRIER_RELEASED; then
        log "FATAL: synchronized start barrier timed out"
        finish 1
    fi
    rm -f "$BARRIER_READY" "$BARRIER_RELEASE"
    log "synchronized start barrier released: $CLOUDBENCH_START_BARRIER"
fi

# ── 10. Run the benchmark ──────────────────────────────────────────────────
step benchmark
if [ "${#BENCH_TASK_LIST[@]}" -eq 0 ]; then
    log "FATAL: BENCH_TASKS is empty"
    finish 1
fi

# Task selector: pass the exact requested task names. `run_benchmark.py`
# accepts repeated `--task` values, so the cloud runner does not need to encode
# multi-task selection as "suite all minus exclusions".
BENCH_ARGS=()
for task_name in "${BENCH_TASK_LIST[@]}"; do
    BENCH_ARGS+=(--task "$task_name")
done

if ! BENCH_TARGET_PLAN="$(python3 "$BENCHMARK_TARGET_SCRIPT" \
    "$REPO_DIR/agents/benchmarks/tasks.json" "$BACKEND_PORT" "${BENCH_TASK_LIST[@]}")"; then
    log "FATAL: could not resolve the catalog-mandated benchmark target"
    finish 1
fi
BENCH_TARGET_MODE="$(printf '%s\n' "$BENCH_TARGET_PLAN" | head -1)"
BENCH_TARGET_ARGS=()
while IFS= read -r target_arg; do
    [ -n "$target_arg" ] && BENCH_TARGET_ARGS+=("$target_arg")
done < <(printf '%s\n' "$BENCH_TARGET_PLAN" | tail -n +2)
if [ "${#BENCH_TARGET_ARGS[@]}" -eq 0 ]; then
    log "FATAL: benchmark target resolver returned no CLI arguments"
    finish 1
fi
BENCH_ARGS+=("${BENCH_TARGET_ARGS[@]}" --ci --keep-failed-agents)
if [ "${#BENCH_TASK_LIST[@]}" -gt 1 ]; then
    BENCH_ARGS+=(--parallel --max-concurrency "$BENCH_MAX_CONCURRENCY")
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    BENCH_ARGS+=(--simulate --world-model-url "http://localhost:$WMH_PORT" --world-model-name "$WMH_MODEL_NAME")
fi

log "running benchmark: target=$BENCH_TARGET_MODE run_benchmark.py ${BENCH_ARGS[*]}"
# Retouch after checkout/setup so files merely restored or rewritten during
# clone initialization cannot qualify as output from this benchmark process.
touch "$RUN_OUTPUT_MARKER"
set +e
# Export the workspace/queue env explicitly INSIDE the shell (not just an `env`
# prefix) so run_benchmark's _verify_worker_queue_alignment() reliably sees
# CONDUCTOR_WORKSPACE_NAME, and echo it so the log proves what the process got.
run_with_heartbeat "benchmark" gosu "$APP_USER" bash -c "
export HOME='/home/$APP_USER'
export BENCHMARK_CONTEXT_DIR='$CONTEXT_DIR'
export BENCHMARK_ISOLATED_RUN=true
export ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1
export CONDUCTOR_WORKSPACE_NAME='$WORKSPACE_NAME'
export CONDUCTOR_PORT='$BASE_PORT'
export TEMPORAL_TASK_QUEUE='navi-agent-tasks-$WORKSPACE_NAME'
export BENCHMARK_SEED_DUMP='$STACK_SEED_DUMP'
if [ -n '$BENCHMARK_FAST_MODE_CACHE' ]; then
  export BENCHMARK_FAST_MODE_CACHE='$BENCHMARK_FAST_MODE_CACHE'
fi
if [ -n '$BENCHMARK_PEAK_FLY_MACHINES' ]; then
  export BENCHMARK_PEAK_FLY_MACHINES='$BENCHMARK_PEAK_FLY_MACHINES'
fi
if [ -n '$BENCHMARK_VM_USD_PER_HOUR' ]; then
  export BENCHMARK_VM_USD_PER_HOUR='$BENCHMARK_VM_USD_PER_HOUR'
fi
if [ '$BENCH_TARGET_MODE' = 'prod' ]; then
  unset BENCHMARK_FRONTEND_URL
elif [ -n '$BENCHMARK_FRONTEND_URL' ]; then
  export BENCHMARK_FRONTEND_URL='$BENCHMARK_FRONTEND_URL'
else
  unset BENCHMARK_FRONTEND_URL
fi
if [ -n '$BENCHMARK_REPORT_FRONTEND_URL' ]; then
  export BENCHMARK_REPORT_FRONTEND_URL='$BENCHMARK_REPORT_FRONTEND_URL'
else
  unset BENCHMARK_REPORT_FRONTEND_URL
fi
if [ '$BENCH_ENABLE_NON_PURCHASE_GATES' = '1' ]; then
  export NON_PURCHASE_GATES_ENABLED=1
fi
if [ '$BENCH_SIMULATE' = '1' ]; then
  export BENCHMARK_WORLD_MODEL_MODE='simulate'
  export WMH_BASE_URL='http://localhost:$WMH_PORT'
else
  export BENCHMARK_WORLD_MODEL_MODE='real'
fi
echo \"[cloudbench] run_benchmark env: CONDUCTOR_WORKSPACE_NAME=\$CONDUCTOR_WORKSPACE_NAME TEMPORAL_TASK_QUEUE=\$TEMPORAL_TASK_QUEUE\"
cd '$REPO_DIR/agents' && exec venv/bin/python -u benchmarks/run_benchmark.py \"\$@\"" _ "${BENCH_ARGS[@]}"
BENCH_RC=$?
set -e 2>/dev/null || true

log "benchmark finished rc=$BENCH_RC"
finish "$BENCH_RC"
