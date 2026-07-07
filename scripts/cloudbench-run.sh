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
#   - Deps (agents venv + node_modules) are baked into /app; mirrored into /data/repo
#     only when missing (rsync), so after the first run this is a near-noop.
#
# Per-run flow:
#   1. cd /data/repo → git fetch/checkout/reset --hard "$REF" (pre-authed remote).
#   2. Decode AGENTS_ENV_B64 / BACKEND_ENV_B64 → repo .env files.
#   3. Mirror baked venv + node_modules from /app → /data/repo if missing.
#   4. Ensure the system Postgres cluster is up + the victoria DB exists (:5432).
#   5. Stage the live dashboard (copy dashboard.html into the context dir + start a
#      static http server rooted there on DASHPORT) so run-bench-cloud can proxy it.
#   6. Launch scripts/run.sh --benchmark (from /data/repo) in the BACKGROUND with the
#      isolated + simulate + serve-cached-WMH env.
#   7. Wait for services.json status=running AND curl localhost:3007/healthz.
#   8. Run run_benchmark.py for the requested tasks (--parallel/--max-concurrency
#      when >1) --simulate --port 3001 --ci.
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

# Report/marker delimiters run-bench-cloud greps for in /data/bench.log.
REPORT_BEGIN="::CLOUDBENCH-REPORT-CARD-BEGIN::"
REPORT_END="::CLOUDBENCH-REPORT-CARD-END::"
RESULT_BEGIN="::CLOUDBENCH-RESULT-BEGIN::"
RESULT_END="::CLOUDBENCH-RESULT-END::"
DONE_MARKER="::CLOUDBENCH-DONE::"

log() { echo "[cloudbench] $*"; }

# ── Normalize the task list (comma OR space separated) into an array ────────
# The controller may pass "a,b,c" or "a b c"; accept both.
read -r -a BENCH_TASK_LIST <<< "$(printf '%s' "$BENCH_TASKS" | tr ',' ' ')"

emit_report_and_result() {
    # Always surface whatever report card / run results exist, even on failure,
    # so the controller can retrieve output from /data/bench.log as a fallback
    # even when the direct-fetch ssh reads race the machine stop.
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
    local latest_run
    latest_run="$(ls -t "$REPO_DIR/agents/benchmarks/runs/"*.json 2>/dev/null | head -1 || true)"
    if [ -n "$latest_run" ] && [ -f "$latest_run" ]; then
        echo "run_file: $latest_run"
        cat "$latest_run"
    else
        echo '{"error":"no runs/*.json produced"}'
    fi
    echo ""
    echo "$RESULT_END"
}

# Best-effort teardown of the static dashboard server started in step 5.
DASH_PID=""
stop_dashboard() {
    [ -n "$DASH_PID" ] || return 0
    kill "$DASH_PID" 2>/dev/null || true
    DASH_PID=""
}

finish() {
    local code="${1:-0}"
    emit_report_and_result || true
    stop_dashboard
    echo "$DONE_MARKER exit=$code"
    exit "$code"
}

# ── 0. Sanity: the volume + repo checkout must exist (created at box setup) ──
if [ ! -d "$REPO_DIR/.git" ]; then
    log "FATAL: $REPO_DIR is not a git checkout (expected a pre-authed volume checkout)"
    finish 1
fi
cd "$REPO_DIR" || { log "FATAL: cannot cd $REPO_DIR"; finish 1; }

# ── 1. git-sync the branch/sha under test ───────────────────────────────────
# The volume checkout's origin URL already embeds a working repo token (set at
# box provisioning), so a plain fetch/checkout/reset needs NO token handling here.
if [ -n "$REF" ]; then
    log "git-syncing $REPO_DIR → $REF (pre-authed remote)"
    gosu "$APP_USER" git -C "$REPO_DIR" fetch origin "$REF" 2>&1 | sed 's/^/   /' || \
        gosu "$APP_USER" git -C "$REPO_DIR" fetch origin 2>&1 | sed 's/^/   /' || true
    if ! gosu "$APP_USER" git -C "$REPO_DIR" checkout -f "$REF" 2>&1 | sed 's/^/   /'; then
        # A bare sha that was just fetched lands in FETCH_HEAD; fall back to it.
        gosu "$APP_USER" git -C "$REPO_DIR" checkout -f FETCH_HEAD 2>&1 | sed 's/^/   /' || {
            log "FATAL: could not checkout $REF"; finish 1
        }
    fi
    gosu "$APP_USER" git -C "$REPO_DIR" reset --hard 2>&1 | sed 's/^/   /' || true
fi
log "checkout at $(gosu "$APP_USER" git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ── 2. Decode injected secrets into the repo .env files the stack reads ─────
# Fly secrets are exposed as env vars in the machine init AND in ssh sessions.
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

# ── 3. Mirror baked deps from the image into the volume checkout ────────────
# The image bakes node_modules (hoisted at /app) + the agents venv. A git checkout
# on the volume has neither, so mirror them — but ONLY if missing (rsync is
# incremental; after the first run this is a near-noop).
if [ ! -d "$REPO_DIR/node_modules" ] || [ ! -f "$REPO_DIR/node_modules/.hoisted-to-root" ]; then
    log "mirroring baked node_modules → $REPO_DIR/node_modules"
    rsync -a --delete "$DEPS_DIR/node_modules/" "$REPO_DIR/node_modules/" 2>&1 | tail -1 | sed 's/^/   /' || true
fi
mkdir -p "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/node_modules"
touch "$REPO_DIR/node_modules/.hoisted-to-root" 2>/dev/null || true
touch "$REPO_DIR/back-end/node_modules/.hoisted-to-root" "$REPO_DIR/agents/node_modules/.hoisted-to-root" 2>/dev/null || true
# back-end node_modules (Prisma client + its own deps) is a separate tree from the
# hoisted root; mirror it only when missing.
if [ ! -x "$REPO_DIR/back-end/node_modules/.bin/tsx" ] && [ -d "$DEPS_DIR/back-end/node_modules" ]; then
    log "mirroring baked back-end/node_modules → $REPO_DIR/back-end/node_modules"
    rsync -a "$DEPS_DIR/back-end/node_modules/" "$REPO_DIR/back-end/node_modules/" 2>&1 | tail -1 | sed 's/^/   /' || true
fi
if [ ! -x "$REPO_DIR/agents/venv/bin/python" ]; then
    log "mirroring baked agents venv → $REPO_DIR/agents/venv"
    rsync -a "$DEPS_DIR/agents/venv/" "$REPO_DIR/agents/venv/" 2>&1 | tail -1 | sed 's/^/   /' || true
fi
# The back-end postinstall generated the Prisma client into /app; mirror it so the
# branch checkout can import it without re-running `prisma generate`.
if [ -d "$DEPS_DIR/node_modules/.prisma" ] && [ ! -d "$REPO_DIR/node_modules/.prisma" ]; then
    rsync -a "$DEPS_DIR/node_modules/.prisma/" "$REPO_DIR/node_modules/.prisma/" 2>&1 | tail -1 | sed 's/^/   /' || true
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

mkdir -p "$CONTEXT_DIR"
chown -R "$APP_USER:$APP_USER" "$REPO_DIR/.context"
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
# WMH_BUILD_DIR points run.sh at the cached model on the volume;
# BENCHMARK_SKIP_WMH_DELTA=1 makes run.sh SERVE it verbatim with NO R2 read / delta
# refresh / rebuild. FLY_APP_NAME="" disables the worker's prod-style fleet
# autoscaler (the Fly runtime injects the app name; _scale_fleet() would otherwise
# hammer the Fly API with the prod-scoped token → 403 log spam).
STACK_LOG="$CONTEXT_DIR/stack.log"
STACK_ENV=(
    "HOME=/home/$APP_USER"
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "BENCHMARK_ISOLATED_RUN=true"
    "BENCHMARK_CONTEXT_DIR=$CONTEXT_DIR"
    "BENCHMARK_SKIP_PUBLIC_TUNNEL=1"
    "CONDUCTOR_PORT=$BASE_PORT"
    "CONDUCTOR_WORKSPACE_NAME=$WORKSPACE_NAME"
    "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1"
    "DISABLE_GMAIL_SYNC=1"
    "FLY_APP_NAME="
    "WMH_MODEL_NAME=$WMH_MODEL_NAME"
    "WMH_BUILD_DIR=$WMH_DIR"
    "BENCHMARK_SKIP_WMH_DELTA=1"
)
if [ "$BENCH_SIMULATE" = "1" ]; then
    STACK_ENV+=(
        "BENCHMARK_WORLD_MODEL_MODE=simulate"
        "WMH_BASE_URL=http://localhost:$WMH_PORT"
    )
else
    STACK_ENV+=("BENCHMARK_SKIP_WMH_BUILD=1")
fi

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
MANIFEST="$CONTEXT_DIR/services.json"
BACKEND_PORT="$BASE_PORT"
HEALTH_PORT=$((BASE_PORT + 2))

log "waiting for stack to become healthy (services.json + backend + worker + WMH)..."
STACK_READY=false
STATUS="none"
# No WMH build on this path (cached model served verbatim), so the stack comes up
# fast — this ceiling only covers boot + DB seed + serve. Default 900s.
STACK_WAIT_SECONDS="${CLOUDBENCH_STACK_WAIT_SECONDS:-900}"
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

# ── 10. Run the benchmark ──────────────────────────────────────────────────
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

BENCH_ARGS+=(--port "$BACKEND_PORT" --ci --keep-failed-agents)
if [ "${#BENCH_TASK_LIST[@]}" -gt 1 ]; then
    BENCH_ARGS+=(--parallel --max-concurrency "$BENCH_MAX_CONCURRENCY")
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    BENCH_ARGS+=(--simulate --world-model-url "http://localhost:$WMH_PORT" --world-model-name "$WMH_MODEL_NAME")
fi

log "running benchmark: run_benchmark.py ${BENCH_ARGS[*]}"
set +e
# Export the workspace/queue env explicitly INSIDE the shell (not just an `env`
# prefix) so run_benchmark's _verify_worker_queue_alignment() reliably sees
# CONDUCTOR_WORKSPACE_NAME, and echo it so the log proves what the process got.
gosu "$APP_USER" bash -c "
export HOME='/home/$APP_USER'
export BENCHMARK_CONTEXT_DIR='$CONTEXT_DIR'
export BENCHMARK_ISOLATED_RUN=true
export ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1
export CONDUCTOR_WORKSPACE_NAME='$WORKSPACE_NAME'
export CONDUCTOR_PORT='$BASE_PORT'
export TEMPORAL_TASK_QUEUE='navi-agent-tasks-$WORKSPACE_NAME'
echo \"[cloudbench] run_benchmark env: CONDUCTOR_WORKSPACE_NAME=\$CONDUCTOR_WORKSPACE_NAME TEMPORAL_TASK_QUEUE=\$TEMPORAL_TASK_QUEUE\"
cd '$REPO_DIR/agents' && exec venv/bin/python -u benchmarks/run_benchmark.py \"\$@\"" _ "${BENCH_ARGS[@]}"
BENCH_RC=$?
set -e 2>/dev/null || true

log "benchmark finished rc=$BENCH_RC"
finish "$BENCH_RC"
