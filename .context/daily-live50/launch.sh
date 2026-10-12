#!/bin/bash
# Usage: launch.sh <trial_dir>  — uncached image build, exact activation, 50-task LIVE campaign.
set -uo pipefail
trial_dir="$1"
. /tmp/deploy-env.sh
umask 077
trial_ref=$(cat "$trial_dir/trial-ref")
mapfile -t tasks < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))))' "$trial_dir/tasks.json")
date -u +%s > "$trial_dir/image-start.epoch"
echo "STAGE image-build start $(date -u +%s)"
scripts/run-bench image-build --builder depot --no-cache --build-context "$PWD" --out-dir "$trial_dir/image-build" || { echo "STAGE image-build FAILED rc=$?"; exit 11; }
trial_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_ref"])' "$trial_dir/image-build/cloudbench-image-build.json")
echo "STAGE image-activate start $(date -u +%s) image=$trial_image"
scripts/run-bench image-activate "$trial_image" --ref "$trial_ref" --out-dir "$trial_dir/image-activation" || { echo "STAGE image-activate FAILED rc=$?"; exit 12; }
echo "STAGE fleet start $(date -u +%s)"
CLOUDBENCH_APP_MACHINE_CEILING=138 \
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=performance-1x \
CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-1x \
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1 \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200 \
  scripts/run-bench "${tasks[@]}" --ref "$trial_ref" --timeout 1200 --autoscale-max 15 \
  --retry-infra 1 --concurrency 50 --strict-barrier --e2e-timeout 5400 \
  --e2e-started-at "$(cat "$trial_dir/image-start.epoch")"
rc=$?
echo "STAGE fleet done $(date -u +%s) rc=$rc"
exit $rc
