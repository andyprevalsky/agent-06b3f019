#!/usr/bin/env bash
# One five-minute WMH cache-condition run against the condition's external WMH.
# usage: launch.sh <iteration 0-3> <run commit> <provider sha256>
set -euo pipefail
iteration="$1"; expected_commit="$2"; expected_provider="$3"
repo=/home/boxes/rose-wmh-resume
cd "$repo"
actual=$(git rev-parse HEAD)
[ "$actual" = "$(git rev-parse "$expected_commit")" ] || { echo "HEAD $actual != $expected_commit" >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked tree dirty" >&2; exit 2; }
provider=$(sha256sum agents/benchmarks/wmh_rose_provider.py | cut -d' ' -f1)
[ "$provider" = "$expected_provider" ] || { echo "provider $provider != $expected_provider" >&2; exit 2; }
curl -fsS --max-time 5 http://127.0.0.1:28690/healthz > /dev/null || { echo "external WMH not healthy" >&2; exit 2; }
run_id="wmh-cache-20261009-i${iteration}-$(date -u +%s)"
safe_run_id=$(printf '%s' "$run_id" | tr -c '[:alnum:]' '_')
out="$repo/.context/wmh-resume-20261009/runs/$run_id"
mkdir -p "$out"
printf 'iteration=%s\ncommit=%s\nrun_id=%s\nprovider_sha256=%s\nstarted_epoch=%s\n' \
    "$iteration" "$actual" "$run_id" "$provider" "$(date -u +%s)" > "$out/launch.env"
export PATH="$HOME/.local/bin:$PATH" NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=rose-wmh-resume CONDUCTOR_ROOT_PATH="$repo"
unset CONDUCTOR_PORT TEMPORAL_TASK_QUEUE
export WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 WMH_EXECUTION_POLICY=rose-outcome-distribution-v2
export WMH_BUILD_DIR="$repo/.context/world-model-native-resume" WMH_MODEL_NAME=rose-archive BENCHMARK_SKIP_WMH_DELTA=1
export WMH_EXTERNAL_BASE_URL=http://127.0.0.1:28690
# Frozen production-derived Tamy fixture source, identical for every condition.
export SEED_REMOTE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wmh_fixture_source_20261009
# Fresh DEMO cache: this run's own isolated DB (the restored canonical base has 0 cache rows).
export FAST_MODE_CACHE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/victoria_bench_${safe_run_id}"
export TRACE_ARCHIVE_ENABLED=1
echo "$run_id" > "$repo/.context/wmh-resume-20261009/runs/latest"
exec scripts/run-bench --local raise-5m-rose-labs-brex --simulate \
    --timeout-seconds 300 --run-id "$run_id" --base-port 28600 --no-clean --no-dashboard \
    > "$out/launcher.log" 2>&1
