#!/usr/bin/env bash
# Native WMH build from the completed export, in a RAM-bounded scope (swap absorbs the peak).
set -euo pipefail
export HOME=/home/boxes PYTHONUNBUFFERED=1
D=/home/boxes/rose-wmh-resume/.context/world-model-native-resume
cd /home/boxes/rose-wmh-resume/agents
exec /usr/bin/time -v /home/boxes/rose-wmh-resume/.context/experiential-venv/bin/python -m benchmarks.build_experiential_world_model \
  --source-root "$D" --root "$D" --name rose-archive --pool rose-wmh-gpt61 \
  --pool-sha256 31497e147da1d8aa72f949a59120fb4dac636621dbe7e239039701e52b3e1f47
