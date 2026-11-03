#!/usr/bin/env bash
# One simulated trajectory end to end: external WMH in a RAM-bounded systemd scope, the
# unchanged catalog task with an optional per-run world state, exact-owner WMH retirement,
# and evidence capture under --out.
# usage: run-trajectory.sh --task NAME --timeout SECONDS --wmh-root DIR --out DIR
#        [--state-file FILE] [--repo DIR] [--base-port 28600] [--wmh-port 28690] [--memory-high 11G]
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
task="" timeout="" wmh_root="" out="" state_file="" repo="" base_port=28600 wmh_port=28690 memory_high=11G
while [ $# -gt 0 ]; do
    case "$1" in
        --task) task=$2 ;; --timeout) timeout=$2 ;; --wmh-root) wmh_root=$2 ;; --out) out=$2 ;;
        --state-file) state_file=$2 ;; --repo) repo=$2 ;; --base-port) base_port=$2 ;;
        --wmh-port) wmh_port=$2 ;; --memory-high) memory_high=$2 ;;
        *) echo "unknown argument $1" >&2; exit 2 ;;
    esac
    shift 2
done
[ -n "$task" ] && [ -n "$timeout" ] && [ -n "$wmh_root" ] && [ -n "$out" ] || { sed -n 2,7p "$0" >&2; exit 2; }
repo=${repo:-$(git -C "$here" rev-parse --show-toplevel)}
mkdir -p "$out"; out=$(cd "$out" && pwd)
[ -z "$state_file" ] || state_file=$(cd "$(dirname "$state_file")" && pwd)/$(basename "$state_file")
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/orchestrator.log"; }
unit="wmh-serve-$(printf '%s' "$(basename "$out")" | tr -c '[:alnum:]-' '-' | cut -c1-60)"
cgroup="/sys/fs/cgroup/system.slice/$unit.scope/cgroup.procs"
commit=$(git -C "$repo" rev-parse HEAD)
# A transient scope has no main PID: TERM the exact recorded owner. It stops its native
# child first, which retires open world sessions; never use a cgroup-wide stop.
stop_owner() {
    local owner; owner=$(cat "$out/wmh-owner.pid" 2>/dev/null)
    if [ -n "$owner" ] && grep -qx "$owner" "$cgroup" 2>/dev/null; then
        log "TERM exact WMH owner $owner"; sudo kill -TERM "$owner"
        for _ in $(seq 120); do systemctl is-active --quiet "$unit.scope" || break; sleep 1; done
    fi
    systemctl is-active --quiet "$unit.scope" && log "WMH scope still active" || log "WMH scope retired"
}
[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || { log "tracked tree dirty"; exit 2; }
for port in "$wmh_port" $(seq "$base_port" $((base_port + 9))); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then log "port $port busy"; exit 2; fi
done
swap_gb=$(awk '/SwapTotal/{print int($2/1048576)}' /proc/meminfo)
[ "$swap_gb" -ge 40 ] || log "warning: only ${swap_gb} GB swap; a cold native load peaks near 40 GB"
log "commit $commit task $task timeout ${timeout}s state ${state_file:-none}"
log "WMH inference ${WMH_INFERENCE_POOL:-rose-1-flash} azure_first=${WMH_AZURE_FIRST:-1} exclude_failed_examples=${WMH_EXCLUDE_FAILED_TOOL_EXAMPLES:-1}"
log "WMH json_mode=${WMH_JSON_MODE:-1}; DEMO recording enabled only for this isolated local run"
date -u +%s > "$out/wmh-start.epoch"
sudo systemd-run --scope --quiet --unit="$unit" -p MemoryHigh="$memory_high" -p MemorySwapMax=infinity \
    --uid="$(id -u)" --gid="$(id -g)" -- "$here/serve-wmh.sh" "$repo" "$wmh_root" "$wmh_port" "$base_port" \
    > "$out/wmh-serve.log" 2>&1 &
for _ in $(seq 60); do systemctl is-active --quiet "$unit.scope" && break; sleep 1; done
head -1 "$cgroup" > "$out/wmh-owner.pid"
log "WMH owner $(cat "$out/wmh-owner.pid")"
ready=""
for _ in $(seq 1800); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$wmh_port/healthz" > "$out/wmh-healthz.json" 2>/dev/null; then
        ready=$(( $(date -u +%s) - $(cat "$out/wmh-start.epoch") )); break
    fi
    systemctl is-active --quiet "$unit.scope" || { log "WMH scope exited before health"; exit 3; }
    # Keep machine MemAvailable above the devbox watcher's ~1.1 GB floor.
    if [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -lt 1500 ]; then
        sudo systemctl set-property --runtime "$unit.scope" MemoryHigh=10G
    fi
    sleep 2
done
[ -n "$ready" ] || { log "WMH not healthy within 3600s"; stop_owner; exit 3; }
log "WMH healthy after ${ready}s"
sudo systemctl set-property --runtime "$unit.scope" MemoryHigh=8G
run_id="wmh-$(echo "$task" | cut -c1-24)-$(date -u +%s)"
safe_run_id=$(printf '%s' "$run_id" | tr -c '[:alnum:]' '_')
printf 'commit=%s\nrun_id=%s\ntask=%s\ntimeout_seconds=%s\nstate_file=%s\nstate_sha256=%s\nwmh_root=%s\nwmh_port=%s\nbase_port=%s\nstarted_epoch=%s\n' \
    "$commit" "$run_id" "$task" "$timeout" "$state_file" \
    "$([ -n "$state_file" ] && sha256sum "$state_file" | cut -d' ' -f1)" "$wmh_root" "$wmh_port" "$base_port" \
    "$(date -u +%s)" > "$out/run.env"
printf 'wmh_inference_pool=%s\nwmh_azure_first=%s\nwmh_exclude_failed_tool_examples=%s\nbenchmark_fast_mode_cache=1\n' \
    "${WMH_INFERENCE_POOL:-rose-1-flash}" "${WMH_AZURE_FIRST:-1}" "${WMH_EXCLUDE_FAILED_TOOL_EXAMPLES:-1}" >> "$out/run.env"
printf 'wmh_json_mode=%s\nfast_mode_cache_record_demo=1\n' "${WMH_JSON_MODE:-1}" >> "$out/run.env"
# The fixture source and message cap define the run's starting data; record them without credentials.
printf 'seed_source_db=%s\nseed_message_limit=%s\n' "${SEED_REMOTE_DATABASE_URL##*/}" \
    "${SEED_MESSAGE_LIMIT:-10000}" >> "$out/run.env"
extra=()
[ -z "$state_file" ] || extra=(--wmh-initial-state-file "$state_file")
(
    cd "$repo" || exit 2
    export PATH="$HOME/.local/bin:$PATH" NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
    export ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME="$(basename "$repo")" CONDUCTOR_ROOT_PATH="$repo"
    unset CONDUCTOR_PORT TEMPORAL_TASK_QUEUE
    export WMH_ENGINE="${WMH_ENGINE:-experiential}" WMH_ROSE_POOL="${WMH_ROSE_POOL:-rose-wmh-gpt61}" \
        WMH_EXECUTION_POLICY="${WMH_EXECUTION_POLICY:-rose-outcome-distribution-v4}"
    export WMH_BUILD_DIR="$wmh_root" WMH_MODEL_NAME=rose-archive BENCHMARK_SKIP_WMH_DELTA=1 \
        WMH_EXTERNAL_BASE_URL="http://127.0.0.1:$wmh_port" TRACE_ARCHIVE_ENABLED=1
    # A fresh DEMO cache per run; keep SEED_REMOTE_DATABASE_URL if the caller pinned a fixture source.
    export FAST_MODE_CACHE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/victoria_bench_${safe_run_id}"
    # Keep any Fast Mode pool small: the shared production pooler has a hard client cap.
    export FAST_CACHE_DB_POOL="${FAST_CACHE_DB_POOL:-5}" BENCHMARK_FAST_MODE_CACHE=1
    # This DB is created by this invocation; never re-record the shared DEMO store.
    export FAST_MODE_CACHE_RECORD_DEMO=1 FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=0
    exec scripts/run-bench --local "$task" --simulate --timeout-seconds "$timeout" "${extra[@]}" \
        --run-id "$run_id" --base-port "$base_port" --no-clean --no-dashboard
) > "$out/launcher.log" 2>&1
rc=$?
log "benchmark launcher exited rc=$rc run_id=$run_id"
# Runs append to the tracked attempt ledger; keep this run's lines with its evidence.
git -C "$repo" diff -- agents/benchmarks/history > "$out/history.patch"
git -C "$repo" checkout -- agents/benchmarks/history
stop_owner
cp "$out/wmh-serve.log" "$out/wmh-serve.final.log" 2>/dev/null
echo "finished_epoch=$(date -u +%s)" >> "$out/run.env"
log "done"
exit "$rc"
