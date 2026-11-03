#!/usr/bin/env bash
# Unchanged fundraiser on the merged code: user-authorized task window, external WMH,
# optional per-run WMH context insertion (user-specified event base rates).
# usage: launch-fundraiser-merged.sh <expected merged commit> <timeout seconds> [wmh initial state file]
set -euo pipefail
expected_commit="$1"
timeout_seconds="$2"
state_file="${3:-}"
extra=()
if [ -n "$state_file" ]; then extra=(--wmh-initial-state-file "$state_file"); fi
repo=/home/boxes/rose-wmh-merge
cd "$repo"
actual=$(git rev-parse HEAD)
[ "$actual" = "$(git rev-parse "$expected_commit")" ] || { echo "HEAD $actual != $expected_commit" >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked tree dirty" >&2; exit 2; }
curl -fsS --max-time 5 http://127.0.0.1:28690/healthz > /dev/null || { echo "external WMH not healthy" >&2; exit 2; }
run_id="wmh-fundraiser-20261010-$(date -u +%s)"
safe_run_id=$(printf '%s' "$run_id" | tr -c '[:alnum:]' '_')
out=/home/boxes/rose-wmh-resume/.context/wmh-resume-20261009/fundraiser/$run_id
mkdir -p "$out"
printf 'commit=%s\nrun_id=%s\nprovider_sha256=%s\ntimeout_seconds=%s\nstate_file=%s\nstate_sha256=%s\nstarted_epoch=%s\n' "$actual" "$run_id" \
    "$(sha256sum agents/benchmarks/wmh_rose_provider.py | cut -d' ' -f1)" "$timeout_seconds" "$state_file" \
    "$([ -n "$state_file" ] && sha256sum "$state_file" | cut -d' ' -f1)" "$(date -u +%s)" > "$out/launch.env"
echo "$run_id" > /home/boxes/rose-wmh-resume/.context/wmh-resume-20261009/fundraiser/latest
export PATH="$HOME/.local/bin:$PATH" NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=rose-wmh-merge CONDUCTOR_ROOT_PATH="$repo"
unset CONDUCTOR_PORT TEMPORAL_TASK_QUEUE
export WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 WMH_EXECUTION_POLICY=rose-outcome-distribution-v2
export WMH_BUILD_DIR=/home/boxes/rose-wmh-resume/.context/world-model-native-resume WMH_MODEL_NAME=rose-archive BENCHMARK_SKIP_WMH_DELTA=1
export WMH_EXTERNAL_BASE_URL=http://127.0.0.1:28690
export SEED_REMOTE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wmh_fixture_source_20261009
export FAST_MODE_CACHE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/victoria_bench_${safe_run_id}"
export TRACE_ARCHIVE_ENABLED=1
exec scripts/run-bench --local raise-5m-rose-labs-brex --simulate \
    --timeout-seconds "$timeout_seconds" "${extra[@]}" --run-id "$run_id" --base-port 28600 --no-clean --no-dashboard \
    > "$out/launcher.log" 2>&1
