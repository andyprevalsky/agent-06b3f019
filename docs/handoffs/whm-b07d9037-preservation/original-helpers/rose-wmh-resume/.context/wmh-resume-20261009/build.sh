#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../agents"
source venv/bin/activate
set -a; source .env; set +a
export PATH="$HOME/.local/bin:$PATH" PYTHONUNBUFFERED=1
export WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 \
  WMH_EXECUTION_POLICY=rose-outcome-distribution-v2 \
  WMH_BUILD_DIR="$PWD/../.context/world-model-native-resume" \
  WMH_MODEL_NAME=rose-archive WMH_GEPA_BUDGET=0 \
  WMH_MAX_BUNDLES=0 WMH_MAX_STEPS=0 WMH_MAX_STEPS_PER_BUNDLE=0 \
  WMH_CONFORMANCE_EXAMPLES=100 WMH_REQUIRE_CONFORMANCE=1
exec /usr/bin/time -v python -c 'from benchmarks.world_model_harness import update_world_model_for_simulation as build; print(build())'
