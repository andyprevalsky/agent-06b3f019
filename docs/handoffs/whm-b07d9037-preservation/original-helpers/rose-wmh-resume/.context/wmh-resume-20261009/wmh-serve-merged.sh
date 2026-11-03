#!/usr/bin/env bash
# Serve the native WMH for the checked-out condition inside the calling scope.
set -euo pipefail
export HOME=/home/boxes PYTHONUNBUFFERED=1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
repo=/home/boxes/rose-wmh-merge
cd "$repo/agents"
source venv/bin/activate
set -a; source .env; set +a
export PATH="$HOME/.local/bin:$PATH"
export WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 WMH_EXECUTION_POLICY=rose-outcome-distribution-v2
# Exactly what run.sh would hand a served WMH for this isolated stack (base 28600):
# its own backend for DEMO-cache traffic, simulate-scoped cache keys, and the
# fast_cache:on write policy. Never the shared dev backend from agents/.env.
export BACKEND_API_URL=http://localhost:28600 BENCHMARK_WORLD_MODEL_MODE=simulate WMH_MODEL_NAME=rose-archive \
    FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1
unset BENCHMARK_DEMO_CACHE_READ_ONLY FAST_MODE_AGENT_ENV_FINGERPRINT WMH_ROSE_USER_ID
exec python -m benchmarks.serve_world_model --name rose-archive --port 28690 \
    --root /home/boxes/rose-wmh-resume/.context/world-model-native-resume
