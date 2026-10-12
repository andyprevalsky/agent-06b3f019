#!/usr/bin/env bash
# Cold-start the native WMH standalone; record /healthz time, identity and peak memory.
set -uo pipefail
export HOME=/home/boxes
repo=/home/boxes/rose-wmh-resume
out="$repo/.context/wmh-resume-20261009/serve-test"
mkdir -p "$out"
port=28690
cd "$repo/agents"
source venv/bin/activate
set -a; source .env; set +a
export PATH="$HOME/.local/bin:$PATH" PYTHONUNBUFFERED=1 NO_PROXY=localhost,127.0.0.1,::1
export WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 WMH_EXECUTION_POLICY=rose-outcome-distribution-v2
start=$(date +%s.%N)
setsid /usr/bin/time -v python -m benchmarks.serve_world_model --name rose-archive --port "$port" \
    --root "$repo/.context/world-model-native-resume" > "$out/serve.log" 2>&1 &
owner=$!
echo "$owner" > "$out/owner.pid"
ready=""
while kill -0 "$owner" 2>/dev/null; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" > "$out/healthz.json" 2>/dev/null; then
        ready=$(python3 -c "import time;print(round(time.time()-$start,2))")
        break
    fi
    elapsed=$(python3 -c "import time;print(int(time.time()-$start))")
    [ "$elapsed" -gt 1800 ] && break
    sleep 2
done
echo "ready_seconds=${ready:-not_ready}" | tee "$out/result.txt"
curl -fsS --max-time 10 "http://127.0.0.1:$port/models/rose-archive" > "$out/model.json" 2>/dev/null || true
free -m >> "$out/result.txt"
# Stop only the exact owned server group; it joins its native child on TERM.
kill -TERM -- "-$owner" 2>/dev/null
for _ in $(seq 60); do kill -0 "$owner" 2>/dev/null || break; sleep 1; done
kill -0 "$owner" 2>/dev/null && echo "owner still alive after 60s" | tee -a "$out/result.txt"
grep -E 'Maximum resident|Elapsed \(wall' "$out/serve.log" | tee -a "$out/result.txt"
