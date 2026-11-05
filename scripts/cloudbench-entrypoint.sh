#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Cloud-bench container entrypoint.
#
# Runs the ENTIRE isolated Rose stack + a single benchmark task in --simulate
# on this one Fly machine, then prints the report card to logs between
# delimiters so the controller (scripts/run-bench-cloud) can retrieve it.
#
# Flow:
#   1. Decode injected secrets → agents/.env + back-end/.env.
#   2. Run cloud-build.sh (idempotent): writes .cloud-env, installs/starts
#      system Postgres (no Docker on Fly), ensures deps (already baked → fast).
#   3. Ensure Postgres cluster is up (system fallback path).
#   4. Launch `scripts/run.sh --benchmark` in the background with simulate env
#      set (worker inherits BENCHMARK_WORLD_MODEL_MODE / WMH_BASE_URL / model).
#      run.sh builds the WMH model from the R2 corpus + serves it, and boots
#      backend + frontend + worker.
#   5. Wait for services.json (status=running) + WMH health.
#   6. Run run_benchmark.py --task $BENCH_TASK --simulate --port <backend>.
#   7. Print report-card.json + a run-result summary between delimiters.
#
# Runs as root (needs to start the Postgres cluster); drops to `rose` for the
# stack + benchmark via gosu.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR=/app
APP_USER=rose
CONTEXT_DIR="$APP_DIR/.context/cloudbench"

# Report/marker delimiters the controller greps for in the machine logs.
REPORT_BEGIN="::CLOUDBENCH-REPORT-CARD-BEGIN::"
REPORT_END="::CLOUDBENCH-REPORT-CARD-END::"
RESULT_BEGIN="::CLOUDBENCH-RESULT-BEGIN::"
RESULT_END="::CLOUDBENCH-RESULT-END::"
DONE_MARKER="::CLOUDBENCH-DONE::"

log() { echo "[cloudbench] $*"; }

emit_report_and_result() {
    # Always try to surface whatever report card / run results exist, even on
    # failure, so the controller can retrieve partial output.
    local card="$CONTEXT_DIR/report-card.json"
    echo "$REPORT_BEGIN"
    if [ -f "$card" ]; then
        cat "$card"
    else
        echo '{"error":"no report-card.json produced"}'
    fi
    echo ""
    echo "$REPORT_END"

    echo "$RESULT_BEGIN"
    # Newest run record (run_benchmark.py writes runs/*.json).
    local latest_run
    latest_run="$(ls -t "$APP_DIR/agents/benchmarks/runs/"*.json 2>/dev/null | head -1 || true)"
    if [ -n "$latest_run" ] && [ -f "$latest_run" ]; then
        echo "run_file: $latest_run"
        cat "$latest_run"
    else
        echo '{"error":"no runs/*.json produced"}'
    fi
    echo ""
    echo "$RESULT_END"
}

finish() {
    local code="${1:-0}"
    emit_report_and_result || true
    echo "$DONE_MARKER exit=$code"
    # Hold the machine ALIVE for a grace window after DONE so the controller can
    # SSH-fetch the report card + run record directly from disk (a stopped machine
    # is unreachable over SSH, and the log buffer only holds ~100 lines so a large
    # report card scrolls out). The controller destroys the machine as soon as it
    # has fetched. Override with CLOUDBENCH_HOLD_OPEN_SECONDS; 0 disables the hold.
    local hold="${CLOUDBENCH_HOLD_OPEN_SECONDS:-300}"
    if [ "$hold" -gt 0 ] 2>/dev/null; then
        log "holding machine open ${hold}s for report retrieval (then exiting $code)"
        sleep "$hold" || true
    fi
    exit "$code"
}

cd "$APP_DIR" || { log "FATAL: cannot cd $APP_DIR"; exit 1; }

# ── 1. Decode injected secrets into the .env files the stack reads ─────────
# agents worker loads agents/.env (load_dotenv from agents/); backend loads
# back-end/.env (dotenv.config from back-end/). Injected as base64 blobs so the
# entire file is captured exactly, key-for-key, with no per-key drift.
ENV_HELPER="$APP_DIR/scripts/lib/cloudbench-env.sh"
[ -f "$ENV_HELPER" ] || { log "FATAL: missing $ENV_HELPER"; exit 1; }
# shellcheck source=lib/cloudbench-env.sh
source "$ENV_HELPER"
umask 077
if [ -n "${AGENTS_ENV_B64:-}" ]; then
    echo "$AGENTS_ENV_B64" | base64 -d > "$APP_DIR/agents/.env" || { log "FATAL: failed to decode AGENTS_ENV_B64"; exit 1; }
    log "wrote agents/.env ($(wc -l < "$APP_DIR/agents/.env") lines)"
else
    log "FATAL: AGENTS_ENV_B64 secret is not set"; exit 1
fi
if [ -n "${BACKEND_ENV_B64:-}" ]; then
    echo "$BACKEND_ENV_B64" | base64 -d > "$APP_DIR/back-end/.env" || { log "FATAL: failed to decode BACKEND_ENV_B64"; exit 1; }
    log "wrote back-end/.env ($(wc -l < "$APP_DIR/back-end/.env") lines)"
else
    log "FATAL: BACKEND_ENV_B64 secret is not set"; exit 1
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/agents/.env" "$APP_DIR/back-end/.env"
chmod 600 "$APP_DIR/agents/.env" "$APP_DIR/back-end/.env"
cloudbench_verify_env_file "$APP_DIR/agents/.env" "${AGENTS_ENV_SHA256:-}" agents || exit 1
cloudbench_verify_env_file "$APP_DIR/back-end/.env" "${BACKEND_ENV_SHA256:-}" backend || exit 1
cloudbench_require_agentcard_org_oauth "$APP_DIR/back-end/.env" || exit 1
cloudbench_validate_browser_provider_contract \
    "$APP_DIR/agents/.env" "$APP_DIR/back-end/.env" \
    "${CLOUDBENCH_BROWSER_PROVIDER:-}" "${CLOUDBENCH_WORKER_BROWSER_PROVIDER:-}" || exit 1

# ── 2. Pin a stable single-tenant workspace + base port for this box ───────
# One machine == one worktree, so a fixed workspace id / base port is fine and
# keeps the Temporal task queue (navi-agent-tasks-<workspace>) isolated from
# prod's queue. Write .cloud-env directly so run.sh sources it as authoritative.
BASE_PORT="${CONDUCTOR_PORT:-3001}"
WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-cloudbench}"
cat > "$APP_DIR/.cloud-env" <<EOF
# Generated by cloudbench-entrypoint.sh — single-tenant cloud bench box.
export CONDUCTOR_PORT=${BASE_PORT}
export CONDUCTOR_WORKSPACE_NAME=${WORKSPACE_NAME}
export CONDUCTOR_ROOT_PATH=${APP_DIR}
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.cloud-env"
WMH_PORT=$((BASE_PORT + 6))

# ── 3. System Postgres (no Docker on Fly) ──────────────────────────────────
# Deps are baked; cloud-build.sh's Postgres install is skipped (already present)
# but we still need to START the cluster + ensure the victoria DB exists. Do it
# directly here (cloud-build.sh's Docker-first logic assumes it can install).
log "starting system Postgres cluster..."
PG_VER="$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')"
if [ -z "$PG_VER" ]; then
    # No cluster yet — create the default one.
    PG_VER="$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -1)"
    if [ -n "$PG_VER" ]; then
        pg_createcluster "$PG_VER" main 2>/dev/null || true
    fi
fi
pg_ctlcluster "$PG_VER" main start 2>/dev/null || service postgresql start 2>/dev/null || true

# Wait for Postgres to accept connections.
PG_READY=false
for i in $(seq 1 30); do
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

# Set password + create the victoria DB to match run.sh's expected DSN
# (postgresql://postgres:postgres@localhost:5432/victoria) and enable md5 auth so
# localhost TCP with a password works.
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

# ── 4. Launch the stack (run.sh --benchmark) with simulate env ─────────────
# The worker forked by run.sh reads BENCHMARK_WORLD_MODEL_MODE / WMH_BASE_URL /
# WMH_MODEL_NAME from its process env, so they MUST be exported here (mirrors
# benchmarks/local.py start_services isolated-simulate wiring).
BENCH_SIMULATE="${BENCH_SIMULATE:-1}"
WMH_MODEL_NAME="${WMH_MODEL_NAME:-rose-archive}"

mkdir -p "$CONTEXT_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/.context"

STACK_LOG="$CONTEXT_DIR/stack.log"

# Env shared by run.sh + the benchmark. BENCHMARK_SKIP_PUBLIC_TUNNEL=1 avoids the
# ngrok reserved-domain requirement (simulate-only; no external browser needed).
#
# FLY_APP_NAME="" DISABLES the worker's prod-style fleet autoscaler on this box:
# the Fly runtime injects FLY_APP_NAME=navi-whisper-lux-bench, and the worker's
# _scale_fleet() then hammers the Fly Machines API with the injected (prod-scoped)
# FLY_API_TOKEN → constant 403 "fleet list failed" log spam that steals CPU from
# the cold WMH build. _scale_fleet() returns early when FLY_APP_NAME is empty, so
# this single-machine bench box (which never autoscales) stays quiet. run.sh forks
# the worker from this env, so the override propagates.
STACK_ENV=(
    "HOME=/home/$APP_USER"
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "BENCHMARK_ISOLATED_RUN=true"
    # Canonical seed restores share a BrowserProviderProfile ID across boxes;
    # isolate the external provider profile too, then let backend shutdown
    # delete the run-local profile.
    "BENCHMARK_ISOLATED_BROWSER_PROFILES=true"
    "BENCHMARK_CONTEXT_DIR=$CONTEXT_DIR"
    "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE=$CONTEXT_DIR/sms-web-search-fixture.json"
    "BENCHMARK_SKIP_PUBLIC_TUNNEL=1"
    "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1"
    "DISABLE_GMAIL_SYNC=1"
    "FLY_APP_NAME="
    "WMH_MODEL_NAME=$WMH_MODEL_NAME"
    # Non-GEPA index-only WMH build from the R2 corpus (no ~20-min GEPA cold build,
    # no GEPA LLM spend) — matches the gepa_budget=0 models validated locally.
    "WMH_GEPA_BUDGET=${WMH_GEPA_BUDGET:-0}"
)
if [ "${WMH_BUILD_DIR:-}" != "" ]; then
    STACK_ENV+=("WMH_BUILD_DIR=$WMH_BUILD_DIR")
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    STACK_ENV+=(
        "BENCHMARK_WORLD_MODEL_MODE=simulate"
        "WMH_BASE_URL=http://localhost:$WMH_PORT"
    )
else
    # Real mode needs no WMH — skip the slow R2+GEPA cold build so it never blocks
    # run.sh from flipping services.json to "running".
    STACK_ENV+=("BENCHMARK_SKIP_WMH_BUILD=1")
fi

log "launching stack (run.sh --benchmark) — base_port=$BASE_PORT wmh_port=$WMH_PORT workspace=$WORKSPACE_NAME simulate=$BENCH_SIMULATE"
# Run as rose. run.sh's system-Postgres fallback connects as postgres over TCP
# with a password (no su needed at runtime), so rose can drive it.
gosu "$APP_USER" env "${STACK_ENV[@]}" bash scripts/run.sh --benchmark > "$STACK_LOG" 2>&1 &
STACK_PID=$!
log "stack pid=$STACK_PID (logs → $STACK_LOG)"

# Tail the stack log to the container's stdout so `flyctl logs` shows progress.
tail -n +1 -F "$STACK_LOG" &
TAIL_PID=$!

cleanup_stack() {
    kill "$TAIL_PID" 2>/dev/null || true
    if kill -0 "$STACK_PID" 2>/dev/null; then
        # run.sh installs its own EXIT trap that tears down services + DB.
        kill -TERM "-$STACK_PID" 2>/dev/null || kill -TERM "$STACK_PID" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "$STACK_PID" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$STACK_PID" 2>/dev/null || true
    fi
}
trap 'cleanup_stack' EXIT

# ── 5. Wait for services.json (status=running) + WMH health ────────────────
MANIFEST="$CONTEXT_DIR/services.json"
BACKEND_PORT="$BASE_PORT"
HEALTH_PORT=$((BASE_PORT + 2))

log "waiting for stack to become healthy (services.json + backend + worker + WMH)..."
STACK_READY=false
STATUS="none"
# The cold WMH FIRST-build from the R2 trace corpus (full corpus export + GEPA
# reflection budget of 10 with Opus) is a one-time infra cost of a fresh box —
# entirely separate from the benchmark's own timeout. Measured ~17 min of build
# on shared-cpu-4x, on top of ~7 min boot+seed, so it runs BEFORE run.sh flips
# services.json to "running" and the health-wait must cover the whole thing.
# Default ceiling 2400s (40 min); override with WMH_BUILD_WAIT_SECONDS.
STACK_WAIT_SECONDS="${WMH_BUILD_WAIT_SECONDS:-2400}"
for i in $(seq 1 "$STACK_WAIT_SECONDS"); do
    if ! kill -0 "$STACK_PID" 2>/dev/null; then
        log "FATAL: stack process exited before becoming healthy (see stack log above)"
        wait "$STACK_PID" 2>/dev/null
        finish 1
    fi
    if [ -f "$MANIFEST" ]; then
        STATUS="$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('status',''))" 2>/dev/null || echo "")"
        if [ "$STATUS" = "running" ] \
            && curl -fsS "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1 \
            && curl -fsS "http://localhost:$HEALTH_PORT/health" >/dev/null 2>&1; then
            # WMH up (simulate only)?
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
    # Surface WMH build progress so the streamed logs show it's alive, not hung.
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
log "stack healthy — backend :$BACKEND_PORT, WMH :$WMH_PORT"

# ── 6. Run the benchmark ───────────────────────────────────────────────────
if [ -z "${BENCH_TASK:-}" ]; then
    log "FATAL: BENCH_TASK is not set"
    finish 1
fi

BENCH_ARGS=(--task "$BENCH_TASK" --port "$BACKEND_PORT" --ci --keep-failed-agents)
if [ "$BENCH_SIMULATE" = "1" ]; then
    BENCH_ARGS+=(--simulate --world-model-url "http://localhost:$WMH_PORT" --world-model-name "$WMH_MODEL_NAME")
fi
# shellcheck disable=SC2206
[ -n "${BENCH_FLAGS:-}" ] && BENCH_ARGS+=(${BENCH_FLAGS})

log "running benchmark: run_benchmark.py ${BENCH_ARGS[*]}"
set +e
gosu "$APP_USER" env \
    "HOME=/home/$APP_USER" \
    "BENCHMARK_CONTEXT_DIR=$CONTEXT_DIR" \
    "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE=$CONTEXT_DIR/sms-web-search-fixture.json" \
    "BENCHMARK_ISOLATED_RUN=true" \
    "BENCHMARK_ISOLATED_BROWSER_PROFILES=true" \
    "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1" \
    bash -c "cd '$APP_DIR/agents' && exec venv/bin/python -u benchmarks/run_benchmark.py \"\$@\"" _ "${BENCH_ARGS[@]}"
BENCH_RC=$?
set -e 2>/dev/null || true

log "benchmark finished rc=$BENCH_RC"
finish "$BENCH_RC"
