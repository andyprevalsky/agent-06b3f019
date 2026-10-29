#!/usr/bin/env bash
# Measure cold clone→ready vs suspended resume→ready for ONE warm-pool guest.
#
# Hypothesis: resuming a digest-bound SUSPENDED pool member reaches the
# ref-independent warm state (volume mounted, repo present, Postgres accepting
# connections) >= 5 min faster than cloning the donor snapshot cold.
# Metric: seconds from the first provider call to the guest readiness probe
# succeeding (cold: provision phase `warm_ready`; resume: checkout `ready_seconds`).
# Decision rule (owner): keep the pool at K only if cold - mean(resume) >= 300 s.
#
# One paid clone. Resume cycles reuse that Machine (n = RESUME_CYCLES, default 3).
# Run under the shared timing lock:
#   flock /tmp/deploy-speed-exp.lock bash scripts/cloudbench-warm-pool-measure.sh <out-dir>
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?out-dir}"
mkdir -p "$OUT"
PY="${PYTHON:-$ROOT_DIR/agents/venv/bin/python}"
CLI="$ROOT_DIR/scripts/cloudbench-warm-pool.py"
POOL="${CLOUDBENCH_WARM_POOL_NAME:-deploy-warm-pool}"
MEMORY="${WARM_POOL_MEMORY_MB:-4096}"
FALLBACK="${WARM_POOL_SUSPEND_FALLBACK_MB:-2048}"
CYCLES="${RESUME_CYCLES:-3}"
RESULTS="${RESULTS_JSONL:-/home/boxes/rose/.context/deploy-speed-exp/results.jsonl}"
export CLOUDBENCH_WARM_POOL_NAME="$POOL"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
record() {  # record <variant> <cmd> <wall_s> <exit> <notes>
    "$PY" - "$RESULTS" "$1" "$2" "$3" "$4" "$5" <<'PY'
import json, sys, time
path, variant, cmd, wall, code, notes = sys.argv[1:]
row = {"exp": "J", "variant": variant, "cmd": cmd, "wall_s": float(wall), "exit": int(code),
       "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "notes": notes}
with open(path, "a") as handle:
    handle.write(json.dumps(row) + "\n")
PY
}

echo "== $(stamp) pool status before =="
"$PY" "$CLI" status --pool "$POOL" | tee "$OUT/status-before.txt"

echo "== $(stamp) COLD: provision 1 (memory ${MEMORY}MB, fallback ${FALLBACK}MB) =="
t0=$(date +%s.%N)
set +e
"$PY" "$CLI" provision --size 1 --pool "$POOL" --cpus 4 --memory "$MEMORY" \
    --suspend-fallback-memory "$FALLBACK" --fetch-ref main --receipt "$OUT/cold.json" --json >"$OUT/cold.stdout" 2>"$OUT/cold.stderr"
cold_exit=$?
set -e
t1=$(date +%s.%N)
cat "$OUT/cold.stderr"
cold_ready="$("$PY" -c 'import json,sys; r=json.load(open(sys.argv[1]))["provisioned"][0]; print(r["phases"].get("warm_ready", -1))' "$OUT/cold.json" 2>/dev/null || echo -1)"
record baseline "cloudbench-warm-pool.py provision --size 1 --memory $MEMORY (cold clone→warm_ready)" "$cold_ready" "$cold_exit" \
    "phases=$("$PY" -c 'import json,sys; r=json.load(open(sys.argv[1]))["provisioned"][0]; print(json.dumps(r["phases"]), "refused_at=%s fallback=%s" % (r.get("suspend_refused_at_mb"), r.get("suspend_fallback_memory_mb")))' "$OUT/cold.json" 2>/dev/null || echo unparsed); whole_cmd_wall=$("$PY" -c 'import sys; print(round(float(sys.argv[2]) - float(sys.argv[1]), 3))' "$t0" "$t1")"
if [ "$cold_exit" != 0 ]; then
    echo "❌ cold provisioning failed (exit $cold_exit); nothing to resume"
    exit "$cold_exit"
fi
machine="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["provisioned"][0]["machine"])' "$OUT/cold.json")"
image="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$OUT/cold.json")"
deps="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["deps"])' "$OUT/cold.json")"
echo "cold clone→warm_ready = ${cold_ready}s (machine $machine)"

for i in $(seq 1 "$CYCLES"); do
    echo "== $(stamp) RESUME cycle $i: checkout =="
    set +e
    "$PY" "$CLI" checkout --pool "$POOL" --image "$image" --deps-fingerprint "$deps" --lease "measure-$i" \
        --receipt "$OUT/resume-$i.json" --json >"$OUT/resume-$i.stdout" 2>"$OUT/resume-$i.stderr"
    rc=$?
    set -e
    cat "$OUT/resume-$i.stderr"
    ready="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("ready_seconds", -1))' "$OUT/resume-$i.json" 2>/dev/null || echo -1)"
    notes="$("$PY" -c 'import json,sys; r=json.load(open(sys.argv[1])); print("resume_seconds=%s guest_uptime=%s repo=%s seed=%s" % (r.get("resume_seconds"), r.get("guest_uptime"), r.get("repo"), r.get("seed")))' "$OUT/resume-$i.json" 2>/dev/null || echo unparsed)"
    record "candidate-$i" "cloudbench-warm-pool.py checkout (suspended resume→health ready)" "$ready" "$rc" "$notes"
    [ "$rc" = 0 ] || { echo "❌ resume cycle $i failed"; break; }
    echo "== $(stamp) RESUME cycle $i: release (re-suspend) =="
    "$PY" "$CLI" release "$machine" --pool "$POOL" --image "$image" --deps-fingerprint "$deps" \
        --receipt "$OUT/release-$i.json" --json >"$OUT/release-$i.stdout" 2>"$OUT/release-$i.stderr" || { cat "$OUT/release-$i.stderr"; break; }
    cat "$OUT/release-$i.stderr"
done

echo "== $(stamp) pool status after =="
"$PY" "$CLI" status --pool "$POOL" --json --receipt "$OUT/status-after.json" >/dev/null
"$PY" "$CLI" status --pool "$POOL" | tee "$OUT/status-after.txt"
echo "DONE machine=$machine cold_ready=$cold_ready"
