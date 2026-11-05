#!/usr/bin/env bash
# Structural contracts for the fleet infra canary (no live Fly).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

CANARY="$ROOT_DIR/scripts/run-fleet-infra-canary"
PREFLIGHT_HELPER="$ROOT_DIR/scripts/cloudbench-infra-canary-preflight.py"
SAMPLER="$ROOT_DIR/scripts/fleet_infra_sample.py"
FLEET="$ROOT_DIR/scripts/run-bench-fleet"
DRIVER="$ROOT_DIR/scripts/cloudbench-run.sh"
DESCEND="$ROOT_DIR/.claude/commands/descend.md"
PLAN="$ROOT_DIR/docs/plans/active/fleet-demo-concurrency-e2e.md"

[ -x "$CANARY" ] || fail "run-fleet-infra-canary must be executable"
[ -f "$PREFLIGHT_HELPER" ] || fail "cloudbench-infra-canary-preflight.py must exist"
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
# Behavioural outcome contract: artifact recovery covers only the unobserved
# terminal race (FINISHED=0). An observed nonzero benchmark exit is
# authoritative: run.json is saved before post-run gates such as the cache
# ratchet, so a validated pass artifact must never convert that exit into PASS
# (descend-full69 claude-code-agent 31f51d25: 14.7% < 35% ratchet, rc=1).
outcome_function="$(awk '/^cloudbench_outcome_ok\(\)/{c=1} c{print} c&&/^}$/{exit}' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$outcome_function" ] || fail "run-bench-cloud must define cloudbench_outcome_ok"
eval "$outcome_function"
assert_outcome() {  # expected finished timed_out bench_exit identity pass relay
  local expected="$1"
  FINISHED="$2" TIMED_OUT="$3" BENCH_EXIT="$4" RUN_IDENTITY_OK="$5" RUN_PASS_OK="$6" IMESSAGE_RELAY_OK="$7"
  OUTCOME_OK=""
  cloudbench_outcome_ok >/dev/null
  [ "$OUTCOME_OK" = "$expected" ] \
    || fail "outcome(finished=$2 timed_out=$3 bench_exit=$4 identity=$5 pass=$6 relay=$7)=$OUTCOME_OK, want $expected"
}
assert_outcome 1 1 0 0 1 1 1   # clean pass
assert_outcome 0 1 0 1 1 1 1   # observed gate failure (cache ratchet) stays FAIL
assert_outcome 1 0 0 1 1 1 1   # unobserved terminal race recovers from artifacts
assert_outcome 0 0 1 1 1 1 1   # timeout never recovers
assert_outcome 0 0 0 1 1 0 1   # artifact without strict pass never recovers
assert_outcome 0 0 0 1 0 1 1   # wrong-run artifact never recovers
assert_outcome 0 1 0 0 1 1 0   # missing relay confirmation fails
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
grep -Fq 'INFRA_CANARY_PREFLIGHT_SCRIPT="$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-infra-canary-preflight.py"' "$FLEET" \
  || fail "preflight helper must resolve from the sealed runtime snapshot"
grep -Fq '"$ROOT_DIR/scripts/cloudbench-infra-canary-preflight.py"' "$FLEET" \
  || fail "preflight helper must be copied into the sealed runtime snapshot"
grep -Fq 'fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)' "$PREFLIGHT_HELPER" \
  || fail "preflight transaction lock must block portably on Linux/macOS"
grep -Fq 'pass_fds=(lock_handle.fileno(),)' "$PREFLIGHT_HELPER" \
  || fail "nested canary must retain the lock if its helper parent crashes"
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
cp "$PREFLIGHT_HELPER" "$PREFLIGHT_REPRO/root/scripts/cloudbench-infra-canary-preflight.py"
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
INFRA_CANARY_PREFLIGHT_SCRIPT="${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts}/cloudbench-infra-canary-preflight.py"
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

# The parent resolved an unpublished source to a fetchable base. The nested
# canary must keep the original request so its fleet packages the same delta.
cat > "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$CLOUDBENCH_INFRA_CANARY_REF" > "$CLOUDBENCH_TEST_CANARY_REF"
exit 17
SH
chmod +x "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary"
set +e
CLOUDBENCH_TEST_CANARY_REF="$PREFLIGHT_REPRO/ref" \
  REQUESTED_BENCH_REF=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  BENCH_REF=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  bash "$PREFLIGHT_REPRO/run.sh" > "$PREFLIGHT_REPRO/ref.out" 2>&1
PREFLIGHT_STATUS=$?
set -e
[ "$PREFLIGHT_STATUS" -eq 17 ] || fail "source-pinned canary must preserve its exit status"
[ "$(cat "$PREFLIGHT_REPRO/ref")" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ] \
  || fail "nested canary lost requested source and would omit the committed workspace patch"

# Two campaign controllers may have distinct lifecycle locks, but their
# check→canary→stamp transaction is shared. Exactly one canary may run; the
# follower must wait, observe the fresh stamp, and return success.
cat > "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" <<'SH'
#!/usr/bin/env bash
[ "${CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT:-0}" = "1" ] || exit 91
[ "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" = "1" ] || exit 92
[ "${CLOUDBENCH_CONTROLLER_LOCK_NAME:-}" = "cloudbench-controller-infra-canary-preflight.lock" ] || exit 93
# Each caller already owns its audit directory. A nested fleet must receive a
# fresh identity, while the serialized follower must still reuse the stamp.
[[ "${CLOUDBENCH_FLEET_OWNER_TOKEN:-}" =~ ^[a-f0-9]{32}$ ]] || exit 94
[ "$CLOUDBENCH_FLEET_OWNER_TOKEN" != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ] || exit 95
[ "$CLOUDBENCH_FLEET_OWNER_TOKEN" != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ] || exit 96
printf '%s\n' "$CLOUDBENCH_FLEET_OWNER_TOKEN" >> "$CLOUDBENCH_PREFLIGHT_CALLS.owners"
printf '%s\n' "$$" >> "$CLOUDBENCH_PREFLIGHT_CALLS"
sleep 0.5
SH
chmod +x "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary"
rm -f "$PREFLIGHT_REPRO/root/.context/fleet-infra-canary.last-pass"
: > "$PREFLIGHT_REPRO/calls"
CLOUDBENCH_PREFLIGHT_CALLS="$PREFLIGHT_REPRO/calls" \
  CLOUDBENCH_FLEET_OWNER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bash "$PREFLIGHT_REPRO/run.sh" >"$PREFLIGHT_REPRO/concurrent-a.out" 2>&1 &
PREFLIGHT_A=$!
CLOUDBENCH_PREFLIGHT_CALLS="$PREFLIGHT_REPRO/calls" \
  CLOUDBENCH_FLEET_OWNER_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  bash "$PREFLIGHT_REPRO/run.sh" >"$PREFLIGHT_REPRO/concurrent-b.out" 2>&1 &
PREFLIGHT_B=$!
wait "$PREFLIGHT_A" || fail "first concurrent preflight failed"
wait "$PREFLIGHT_B" || fail "second concurrent preflight failed"
[ "$(grep -c . "$PREFLIGHT_REPRO/calls")" -eq 1 ] \
  || fail "concurrent controllers must execute exactly one serialized infra canary"
grep -Fq 'stamp fresh' "$PREFLIGHT_REPRO/concurrent-a.out" \
  || grep -Fq 'stamp fresh' "$PREFLIGHT_REPRO/concurrent-b.out" \
  || fail "serialized follower must consume the first controller's fresh stamp"

# A substrate canary owns a nested controller, not its caller's campaign slot.
# Exercise the real rendezvous helper so inherited campaign identity rejects
# the distinct nested PID before this boundary is isolated in the preflight.
python3 - "$PREFLIGHT_HELPER" "$ROOT_DIR/scripts/cloudbench-campaign-barrier.py" \
  "$PREFLIGHT_REPRO" <<'PY' || fail "nested canary consumed its parent's campaign rendezvous"
import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

helper, rendezvous, root = map(Path, sys.argv[1:])
directory = root / "campaign-boundary" / "c001"
(directory / "ready").mkdir(parents=True)
identity = {
    "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(directory),
    "RUN_BENCH_CAMPAIGN_COHORT": "c001",
    "RUN_BENCH_CAMPAIGN_JOB_ID": "parent-job",
    "CLOUDBENCH_CAMPAIGN_SEED_PROOF": str(directory / "seed-proof.private.json"),
    "BENCHMARK_HUB_GROUP_RUN_ID": "outer-group",
    "RUN_BENCH_CAMPAIGN_RUN": "outer-campaign",
    "RUN_BENCH_CAMPAIGN_STARTED_AT": "outer-start",
    "RUN_BENCH_CAMPAIGN_TOTAL_JOBS": "50",
}
environment = os.environ.copy()
environment.update(identity)
environment["CLOUDBENCH_CAMPAIGN_INVENTORY_DIR"] = str(root / "shared-inventory")
environment["CLOUDBENCH_FLEET_OWNER_TOKEN"] = "a" * 32
preserved = {
    key: value
    for key, value in environment.items()
    if key == "CLOUDBENCH_CAMPAIGN_INVENTORY_DIR"
    or key.lower() in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
}
expected = root / "nested-preserved-environment.json"
expected.write_text(json.dumps(preserved))
canary = root / "nested-campaign-canary.sh"
fleet = (helper.parent / "run-bench-fleet").read_text()
seed_branch_start = fleet.index('if [ -n "${CLOUDBENCH_CAMPAIGN_SEED_PROOF:-}" ]; then')
seed_branch = fleet[seed_branch_start:fleet.index("\nelse", seed_branch_start)] + "\nfi\n"
canary.write_text(
    "#!/usr/bin/env bash\nset -euo pipefail\n"
    + "ROOT_DIR=" + shlex.quote(str(helper.parent.parent)) + "\n"
    + "CLOUDBENCH_SCRIPT_SNAPSHOT=" + shlex.quote(str(helper.parent)) + "\n"
    + "FLEET_CONTROLLER_STARTED_EPOCH=0\nSTART_BARRIER_WAIT_SECONDS=60\n"
    + seed_branch
    + shlex.quote(sys.executable) + " " + shlex.quote(str(rendezvous))
    + ' --deadline "' + str(time.time() + 60) + '" --controller-pid "$$"\n'
    + shlex.quote(sys.executable) + " - " + shlex.quote(str(expected)) + " <<'INNER'\n"
    + "import json, os, sys\n"
    + "from pathlib import Path\n"
    + "expected = json.loads(Path(sys.argv[1]).read_text())\n"
    + "assert all(os.environ.get(k) == v for k, v in expected.items())\n"
    + "assert os.environ['CLOUDBENCH_CONTROLLER_LOCK_NAME'] == 'nested-canary.lock'\n"
    + "assert os.environ['CLOUDBENCH_FLEET_OWNER_TOKEN'] != 'a' * 32\n"
    + "assert not any(k in os.environ for k in " + repr(tuple(identity)) + ")\n"
    + "INNER\n"
)
(directory / "manifest.json").write_text(json.dumps({
    "cohort_id": "c001", "jobs": {"parent-job": os.getpid()},
}))
(directory / "release.json").write_text(json.dumps({
    "cohort_id": "c001", "jobs": {"parent-job": os.getpid()},
}))
with (directory.parent / "parent.lock").open("w") as parent_lock:
    fcntl.flock(parent_lock, fcntl.LOCK_EX)
    for campaign in (True, False):
        child_environment = environment.copy()
        if not campaign:
            for key in identity:
                child_environment.pop(key)
        stamp = root / f"nested-campaign-{campaign}.stamp"
        completed = subprocess.run([
            sys.executable, str(helper), "--stamp", str(stamp),
            "--lock", str(root / f"nested-campaign-{campaign}.lock"),
            "--ttl-seconds", "3600", "--width", "2", "--canary", str(canary),
            "--nested-controller-lock", "nested-canary.lock",
        ], env=child_environment, capture_output=True, timeout=15)
        assert completed.returncode == 0, "nested controller rejected outer campaign identity"
        assert stamp.is_file()
        assert not (directory / "ready" / "parent-job.json").exists()
    assert all(environment[key] == value for key, value in identity.items())
    command = [sys.executable, str(rendezvous), "--deadline", str(time.time() + 60),
               "--controller-pid"]
    assert subprocess.run(command + [str(os.getpid() + 1000000)], env=environment,
                          capture_output=True).returncode != 0
    assert subprocess.run(command + [str(os.getpid())], env=environment,
                          capture_output=True).returncode == 0
    assert (directory / "ready" / "parent-job.json").is_file()
PY

# A killed lock-helper process must not orphan or prematurely release its lock.
# The canary inherits the descriptor, so a follower blocks until the in-flight
# nested canary exits, then rechecks the still-missing stamp and runs safely.
cat > "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" <<'SH'
#!/usr/bin/env bash
if [ ! -e "$CLOUDBENCH_CRASH_STARTED" ]; then
  : > "$CLOUDBENCH_CRASH_STARTED"
  sleep 0.5
  : > "$CLOUDBENCH_CRASH_FINISHED"
elif [ ! -e "$CLOUDBENCH_CRASH_FINISHED" ]; then
  : > "$CLOUDBENCH_CRASH_OVERLAP"
fi
SH
chmod +x "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary"
CRASH_STAMP="$PREFLIGHT_REPRO/root/.context/crash.last-pass"
CRASH_LOCK="$PREFLIGHT_REPRO/root/.context/crash.transaction.lock"
export CLOUDBENCH_CRASH_STARTED="$PREFLIGHT_REPRO/crash-started"
export CLOUDBENCH_CRASH_FINISHED="$PREFLIGHT_REPRO/crash-finished"
export CLOUDBENCH_CRASH_OVERLAP="$PREFLIGHT_REPRO/crash-overlap"
python3 "$PREFLIGHT_REPRO/root/scripts/cloudbench-infra-canary-preflight.py" \
  --stamp "$CRASH_STAMP" --lock "$CRASH_LOCK" --ttl-seconds 3600 --width 2 \
  --canary "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" \
  --nested-controller-lock cloudbench-controller-infra-canary-preflight.lock \
  >"$PREFLIGHT_REPRO/crash-a.out" 2>&1 &
CRASH_HELPER=$!
for _ in {1..50}; do
  [ -e "$CLOUDBENCH_CRASH_STARTED" ] && break
  sleep 0.02
done
[ -e "$CLOUDBENCH_CRASH_STARTED" ] || fail "crash-safety canary did not start"
kill -9 "$CRASH_HELPER"
set +e
wait "$CRASH_HELPER" 2>/dev/null
CRASH_STATUS=$?
set -e
[ "$CRASH_STATUS" -ne 0 ] || fail "killed preflight helper unexpectedly succeeded"
python3 "$PREFLIGHT_REPRO/root/scripts/cloudbench-infra-canary-preflight.py" \
  --stamp "$CRASH_STAMP" --lock "$CRASH_LOCK" --ttl-seconds 3600 --width 2 \
  --canary "$PREFLIGHT_REPRO/root/scripts/run-fleet-infra-canary" \
  --nested-controller-lock cloudbench-controller-infra-canary-preflight.lock \
  >"$PREFLIGHT_REPRO/crash-b.out" 2>&1 \
  || fail "follower could not recover the crashed preflight lock"
[ ! -e "$CLOUDBENCH_CRASH_OVERLAP" ] \
  || fail "crashed lock helper released while its nested canary was still active"
[ -f "$CRASH_STAMP" ] || fail "crash-recovery follower did not stamp success"

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
