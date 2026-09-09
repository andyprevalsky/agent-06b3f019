#!/usr/bin/env bash
# Structural contracts for the fleet infra canary (no live Fly).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

CANARY="$ROOT_DIR/scripts/run-fleet-infra-canary"
SAMPLER="$ROOT_DIR/scripts/fleet_infra_sample.py"
FLEET="$ROOT_DIR/scripts/run-bench-fleet"
DRIVER="$ROOT_DIR/scripts/cloudbench-run.sh"
DESCEND="$ROOT_DIR/.claude/commands/descend.md"
PLAN="$ROOT_DIR/docs/plans/active/fleet-demo-concurrency-e2e.md"

[ -x "$CANARY" ] || fail "run-fleet-infra-canary must be executable"
[ -f "$SAMPLER" ] || fail "fleet_infra_sample.py must exist"
[ -f "$PLAN" ] || fail "fleet-demo-concurrency-e2e plan must exist"

grep -Fq 'infra-probe' "$FLEET" || fail "fleet must accept --infra-probe"
grep -Fq 'strict-barrier' "$FLEET" || fail "fleet must accept --strict-barrier"
grep -Fq 'infra-probe: skipping mandatory autoscaler startup wait' "$FLEET" \
  || fail "infra-probe must skip mandatory autoscaler startup wait"
grep -Fq 'per-bench autoscaler SKIPPED (infra-probe' "$FLEET" \
  || fail "infra-probe must skip per-bench autoscaler launch"
grep -Fq 'skip-autoscaler' "$FLEET" \
  || fail "fleet must accept --skip-autoscaler for DEMO concurrency"
grep -Fq 'per-bench autoscaler SKIPPED (--skip-autoscaler' "$FLEET" \
  || fail "skip-autoscaler must skip per-bench autoscaler launch"
grep -Fq 'skip-autoscaler: skipping mandatory autoscaler startup wait' "$FLEET" \
  || fail "skip-autoscaler must skip autoscaler startup wait"
grep -Fq 'guest cleanup skipped for infra-probe' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "infra-probe must skip browser cleanup handshake"
grep -Fq 'CLOUDBENCH_INFRA_PROBE:-0}" = "1"' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "infra-probe must accept DONE without waiting for driver exit"
grep -Fq 'recovering OUTCOME_OK from validated pass artifacts' "$ROOT_DIR/scripts/run-bench-cloud" \
  || fail "cloud must recover OUTCOME_OK from validated pass artifacts after FINISHED race"
grep -Fq 'CLOUDBENCH_INFRA_PROBE' "$DRIVER" || fail "driver must honor CLOUDBENCH_INFRA_PROBE"
grep -Fq 'skipping run_benchmark.py' "$DRIVER" || fail "infra probe must skip run_benchmark"
grep -Fq 'infra_probe' "$DRIVER" || fail "infra probe must emit synthetic artifacts"
# Probe artifacts must emit catalog-compatible world_model_mode (real|simulate),
# not a literal "infra-probe" string — that fails cloudbench_result after
# execution-provenance wiring and surfaces as fleet NORESULT.
if grep -Eq 'world_model_mode.: .infra-probe' "$DRIVER"; then
  fail "infra probe must not emit world_model_mode=infra-probe (breaks result contract)"
fi
grep -Fq 'BENCHMARK_WORLD_MODEL_MODE' "$DRIVER" || fail "infra probe must inherit BENCHMARK_WORLD_MODEL_MODE"
# Runtime guarantee: every capability fleet (N>=1) must preflight a recent
# infra canary before provisioning so /descend multi-bench slices AND
# single-bench outcome-proof reruns fail closed on INFRA. Command-wiring
# asserts below are soft until /descend docs merge.
grep -Fq 'fleet_infra_canary_preflight' "$FLEET" \
  || fail "run-bench-fleet must define fleet_infra_canary_preflight"
grep -Fq 'fleet-infra-canary.last-pass' "$FLEET" \
  || fail "preflight must stamp .context/fleet-infra-canary.last-pass"
grep -Fq 'CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT' "$FLEET" \
  || fail "preflight must honor CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT"
grep -Fq 'cloudbench-controller-infra-canary-preflight.lock' "$FLEET" \
  || fail "preflight must use a distinct controller lock"
# N=1 must NOT early-return — single-bench outcome-proof is a common /descend path.
if grep -E '#BENCHES\[@\] -lt 2|BENCHES\[@\] -lt 2' "$FLEET" | grep -v '^[[:space:]]*#' >/dev/null; then
  # Allow comments mentioning the old hole; forbid a live size skip.
  if awk '/^fleet_infra_canary_preflight\(\)/,/^}/' "$FLEET" | grep -E '#BENCHES\[@\] -lt 2|\$\{#BENCHES\[@\]\} -lt 2'; then
    fail "preflight must not skip single-bench fleets (N=1 /descend outcome-proof hole)"
  fi
fi
grep -Fq 'including single-bench' "$FLEET" \
  || fail "preflight docs must cover single-bench capability fleets"
if grep -Fq 'FLEET_INFRA_CANARY' "$DESCEND"; then
  grep -Fq 'bash scripts/run-fleet-infra-canary' "$DESCEND" \
    || fail "/descend must invoke the infra canary when wired"
else
  echo "SKIP: /descend command wiring (FLEET_INFRA_CANARY) not in this tree — runtime preflight covers substrate"
fi
grep -Fq 'Do not' "$PLAN" || fail "plan must reject 50-DEMO-every-deploy"
grep -Fq 'fleet_infra_sample.py' "$CANARY" || fail "canary must sample real catalog names"
grep -Fq 'CLOUDBENCH_FAKE_DIR' "$CANARY" || fail "canary must refuse inherited CLOUDBENCH_FAKE_DIR"
grep -Fq 'fake-bin' "$CANARY" || fail "canary must scrub/reject fixture fake-bin PATH entries"
# Capacity-pressure clone path: after owned-volume reap (destroyed-verified-absent),
# skip re-auditing the same name as not-allocated-verified — that illegal
# transition aborted retries after attempt 1 ("unresolved clone name" → INFRA).
grep -Fq 'already_cleaned' "$FLEET" \
  || fail "clone retry must skip not-allocated-verified after owned-volume cleanup"
grep -Fq 'Skip the absent→not-allocated-verified transition' "$FLEET" \
  || fail "clone retry must document the owned-volume vs reconcile ordering"

# Exercise the production function body with a canary that exits 17. Negating
# the command before reading $? turns that failure into 0 and launches the
# capability fleet, so this must assert behavior rather than source strings.
PREFLIGHT_REPRO="$(mktemp -d)"
trap 'rm -rf "$PREFLIGHT_REPRO"' EXIT
mkdir -p "$PREFLIGHT_REPRO/root/scripts"
cat > "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" <<'SH'
#!/usr/bin/env bash
exit 17
SH
chmod +x "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary"
awk '
  /^fleet_infra_canary_preflight\(\) \{/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$FLEET" > "$PREFLIGHT_REPRO/run.sh"
{
  printf 'ROOT_DIR=%q\n' "$PREFLIGHT_REPRO/root"
  cat <<'SH'
INFRA_PROBE=0
RECOVER_STALE_ONLY=0
PROVISION_POOL=
INFRA_CANARY_PREFLIGHT_SCRIPT="$ROOT_DIR/scripts/cloudbench-infra-canary-preflight.py"
fleet_infra_canary_preflight
status=$?
printf 'preflight_status=%s\n' "$status"
exit "$status"
SH
} >> "$PREFLIGHT_REPRO/run.sh"
set +e
bash "$PREFLIGHT_REPRO/run.sh" > "$PREFLIGHT_REPRO/output" 2>&1
PREFLIGHT_STATUS=$?
set -e
[ "$PREFLIGHT_STATUS" -eq 17 ] \
  || fail "failed canary status must propagate unchanged (expected 17, got $PREFLIGHT_STATUS)"
grep -Fq 'FAILED (exit=17)' "$PREFLIGHT_REPRO/output" \
  || fail "failed preflight must report the original canary status"
[ ! -e "$PREFLIGHT_REPRO/root/.context/fleet-infra-canary.last-pass" ] \
  || fail "failed canary must never stamp preflight success"

# Two campaign controllers may have distinct lifecycle locks, but their
# check→canary→stamp transaction is shared. Exactly one canary may run; the
# follower must wait, observe the fresh stamp, and return success.
cat > "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$CLOUDBENCH_PREFLIGHT_CALLS"
sleep 0.5
SH
chmod +x "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary"
rm -f "$PREFLIGHT_REPRO/root/.context/fleet-infra-canary.last-pass"
: > "$PREFLIGHT_REPRO/calls"
CLOUDBENCH_PREFLIGHT_CALLS="$PREFLIGHT_REPRO/calls" \
  bash "$PREFLIGHT_REPRO/run.sh" >"$PREFLIGHT_REPRO/concurrent-a.out" 2>&1 &
PREFLIGHT_A=$!
CLOUDBENCH_PREFLIGHT_CALLS="$PREFLIGHT_REPRO/calls" \
  bash "$PREFLIGHT_REPRO/run.sh" >"$PREFLIGHT_REPRO/concurrent-b.out" 2>&1 &
PREFLIGHT_B=$!
wait "$PREFLIGHT_A" || fail "first concurrent preflight failed"
wait "$PREFLIGHT_B" || fail "second concurrent preflight failed"
[ "$(grep -c . "$PREFLIGHT_REPRO/calls")" -eq 1 ] \
  || fail "concurrent controllers must execute exactly one serialized infra canary"
grep -Fq 'stamp fresh' "$PREFLIGHT_REPRO/concurrent-a.out" \
  || grep -Fq 'stamp fresh' "$PREFLIGHT_REPRO/concurrent-b.out" \
  || fail "serialized follower must consume the first controller's fresh stamp"

# Dry-run arg validation (no Fly): invalid N fails closed.
# Scrub inherited fixture env so N validation is what we exercise.
unset CLOUDBENCH_FAKE_DIR
if "$CANARY" 0 >/tmp/infra-canary-bad.out 2>&1; then
  fail "N=0 must fail"
fi
grep -Fq 'positive integer' /tmp/infra-canary-bad.out || fail "N=0 must explain the failure"

if "$CANARY" 99 >/tmp/infra-canary-cap.out 2>&1; then
  fail "N=99 must fail the hard cap"
fi
grep -Fq 'hard cap 32' /tmp/infra-canary-cap.out || fail "over-cap must mention hard cap 32"

# Inherited fake-provider env from a prior hermetic suite must fail closed
# before any Fly / catalog work (unless explicitly opted into fixtures).
if CLOUDBENCH_FAKE_DIR=/tmp/not-a-real-fake "$CANARY" 4 >/tmp/infra-canary-fake.out 2>&1; then
  fail "CLOUDBENCH_FAKE_DIR must fail closed for live canaries"
fi
grep -Fq 'CLOUDBENCH_FAKE_DIR' /tmp/infra-canary-fake.out || fail "fake-dir refusal must name CLOUDBENCH_FAKE_DIR"

# Catalog sample must be preflight-valid (no fake infra-canary-$i names).
mapfile -t SAMPLED < <(
  python3 "$SAMPLER" sample --repo "$ROOT_DIR" --width 4 --seed 20260908 --slice 0
)
[ "${#SAMPLED[@]}" -eq 4 ] || fail "sampler must return width=4 names"
python3 - "$ROOT_DIR" "${SAMPLED[@]}" <<'PY' || fail "sampled names must pass catalog preflight"
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from cloudbench_catalog import CatalogError, get_task_metadata
try:
    get_task_metadata(Path(sys.argv[1]) / "agents/benchmarks/tasks.json", sys.argv[2:])
except CatalogError as exc:
    raise SystemExit(f"catalog reject: {exc}")
for name in sys.argv[2:]:
    if name.startswith("infra-canary-"):
        raise SystemExit(f"refusing fake name {name}")
print("OK catalog sample:", ", ".join(sys.argv[2:]))
PY

echo "All fleet infra canary structural checks passed."
