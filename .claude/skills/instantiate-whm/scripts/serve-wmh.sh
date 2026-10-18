#!/usr/bin/env bash
# Serve the native WMH for one local simulated run, inside the calling systemd scope.
# Mirrors the environment run.sh would hand a served WMH for that run's stack.
# usage: serve-wmh.sh <repo> <native model root> <wmh port> <run backend port>
set -euo pipefail
repo=$1 root=$2 port=$3 backend_port=$4
export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
export PYTHONUNBUFFERED=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
cd "$repo/agents"
source venv/bin/activate
set -a; source .env; set +a
export PATH="$HOME/.local/bin:$PATH"
export WMH_ENGINE="${WMH_ENGINE:-experiential}" WMH_ROSE_POOL="${WMH_ROSE_POOL:-rose-wmh-gpt61}" \
    WMH_EXECUTION_POLICY="${WMH_EXECUTION_POLICY:-rose-outcome-distribution-v4}"
export WMH_INFERENCE_POOL="${WMH_INFERENCE_POOL:-rose-1-flash}" \
    WMH_AZURE_FIRST="${WMH_AZURE_FIRST:-1}" \
    WMH_EXCLUDE_FAILED_TOOL_EXAMPLES="${WMH_EXCLUDE_FAILED_TOOL_EXAMPLES:-1}"
export WMH_JSON_MODE="${WMH_JSON_MODE:-1}"
# The run's own backend (DEMO-cache traffic), simulate-scoped cache keys, fast_cache:on writes.
export BACKEND_API_URL="http://localhost:$backend_port" BENCHMARK_WORLD_MODEL_MODE=simulate \
    WMH_MODEL_NAME=rose-archive FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1
export FAST_MODE_CACHE_RECORD_DEMO=1
unset BENCHMARK_DEMO_CACHE_READ_ONLY FAST_MODE_AGENT_ENV_FINGERPRINT WMH_ROSE_USER_ID
exec python -m benchmarks.serve_world_model --name rose-archive --port "$port" --root "$root"
