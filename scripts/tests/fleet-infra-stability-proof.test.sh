#!/usr/bin/env bash
# Structural contracts for the 10×20 infra stability proof (no live Fly).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

PROOF="$ROOT_DIR/scripts/run-fleet-infra-stability-proof"
SAMPLER="$ROOT_DIR/scripts/fleet_infra_sample.py"
RUN_BENCH="$ROOT_DIR/scripts/run-bench"
PLAN="$ROOT_DIR/docs/plans/active/fleet-demo-concurrency-e2e.md"

[ -x "$PROOF" ] || fail "run-fleet-infra-stability-proof must be executable"
[ -f "$SAMPLER" ] || fail "fleet_infra_sample.py must exist"
[ -x "$RUN_BENCH" ] || fail "run-bench must exist"
grep -Fq 'run-fleet-infra-stability-proof' "$PLAN" || fail "plan must document the stability proof"
grep -Fq -- '--infra-probe' "$PROOF" || fail "proof must launch fleets with --infra-probe"
grep -Fq 'fail closed' "$PROOF" || fail "proof must fail closed on first bad slice"

# Bad args fail closed.
if "$PROOF" --width 0 >/tmp/infra-proof-bad.out 2>&1; then
  fail "--width 0 must fail"
fi
grep -Eqi 'positive integer|width' /tmp/infra-proof-bad.out || fail "--width 0 must explain failure"

if "$PROOF" --width 99 --dry-sample >/tmp/infra-proof-cap.out 2>&1; then
  fail "width 99 must fail hard cap"
fi
grep -Fq 'hard cap 32' /tmp/infra-proof-cap.out || fail "over-cap must mention hard cap 32"

# Env overrides must also fail closed (CLI path is not the only entry).
if FLEET_INFRA_PROOF_RUNS=0 "$PROOF" --dry-sample >/tmp/infra-proof-runs0.out 2>&1; then
  fail "FLEET_INFRA_PROOF_RUNS=0 must fail closed"
fi
grep -Eqi 'RUNS must be a positive integer' /tmp/infra-proof-runs0.out \
  || fail "RUNS=0 must explain failure"

if python3 "$SAMPLER" dry-proof --repo "$ROOT_DIR" --runs 1 --width 0 --seed 1 \
  >/tmp/infra-sample-width0.out 2>&1; then
  fail "fleet_infra_sample dry-proof --width 0 must exit non-zero"
fi
grep -Eqi 'positive integer|width' /tmp/infra-sample-width0.out \
  || fail "dry-proof --width 0 must explain failure (exit 2 path, not traceback)"
rc=0
python3 "$SAMPLER" dry-proof --repo "$ROOT_DIR" --runs 1 --width 0 --seed 1 \
  >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "dry-proof --width 0 must exit 2 (got $rc)"

# Negative seeds are valid integers for deterministic sampling.
"$PROOF" --dry-sample --runs 1 --width 2 --seed -7 >/tmp/infra-proof-neg-seed.out \
  || fail "negative --seed must be accepted"
grep -Fq '"seed": -7' /tmp/infra-proof-neg-seed.out || fail "negative seed must round-trip in JSON"

# Dual-writer race: failure lines must go to stdout only (outer tee captures).
grep -Fvq 'tee -a "$SUMMARY_ARTIFACT"' "$PROOF" \
  || fail "proof must not append SUMMARY_ARTIFACT while also piping to tee"
grep -Fq 'tee "$SUMMARY_ARTIFACT"' "$PROOF" \
  || fail "proof must still tee the outer summary artifact once"

# Dry sample: 10×20 deterministic, unique within slice, catalog-valid.
OUT="$(mktemp)"
"$PROOF" --dry-sample --runs 10 --width 20 --seed 20260908 >"$OUT"
python3 - "$OUT" "$ROOT_DIR" <<'PY' || fail "dry-sample payload invalid"
import json, sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
repo = Path(sys.argv[2])
sys.path.insert(0, str(repo / "scripts"))
from cloudbench_catalog import get_task_metadata

assert payload["runs"] == 10, payload["runs"]
assert payload["width"] == 20, payload["width"]
assert payload["seed"] == 20260908, payload["seed"]
assert payload["pool_size"] >= 200, payload["pool_size"]
assert len(payload["slices"]) == 10, len(payload["slices"])

seen_signatures = set()
for sl in payload["slices"]:
    names = sl["names"]
    assert len(names) == 20, names
    assert len(set(names)) == 20, names
    get_task_metadata(repo / "agents/benchmarks/tasks.json", names)
    sig = tuple(names)
    seen_signatures.add(sig)

# Different slices should not be identical under the default seed.
assert len(seen_signatures) == 10, "expected 10 distinct random slices"
print("OK dry-sample 10×20 distinct catalog slices")
PY

# Determinism: same seed → same first slice.
A="$(python3 "$SAMPLER" sample --repo "$ROOT_DIR" --width 20 --seed 20260908 --slice 0)"
B="$(python3 "$SAMPLER" sample --repo "$ROOT_DIR" --width 20 --seed 20260908 --slice 0)"
[ "$A" = "$B" ] || fail "sampler must be deterministic for a fixed seed/slice"

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT
cat >"$tmp/fake-fleet" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
run_dir="$CLOUDBENCH_RUNS_ROOT/fake-$FLEET_STABILITY_SLICE"
mkdir -p "$run_dir/_batch"
tasks=()
for arg in "$@"; do
  case "$arg" in --*) break ;; *) tasks+=("$arg") ;; esac
done
python3 - "$run_dir/_batch/run.json" "$FLEET_STABILITY_SLICE" \
  "${FLEET_STABILITY_FAKE_INFRA_SLICE:-}" "${tasks[@]}" <<'PY'
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

path = Path(sys.argv[1])
slice_index = int(sys.argv[2])
infra_slice = sys.argv[3]
tasks = []
for index, name in enumerate(sys.argv[4:]):
    if infra_slice and slice_index == int(infra_slice):
        status = "INFRA_ERROR"
        passed = False
    elif slice_index == 0 and index == 0:
        status = "FAILED"
        passed = False
    else:
        status = "PASSED"
        passed = True
    task = {"name": name, "status": status, "passed": passed}
    if os.environ.get("FLEET_STABILITY_FAKE_AGENT_STATUS") == "1":
        task["benchmark_status"] = status
        task["status"] = "ACTIVE" if not passed else "PAUSED"
    if os.environ.get("FLEET_STABILITY_FAKE_CANCELLED") == "1":
        task.update(status="ACTIVE", benchmark_status="CANCELLED", passed=False)
    if os.environ.get("FLEET_STABILITY_FAKE_MALFORMED") == "1":
        task["benchmark_status"] = []
    tasks.append(task)
path.write_text(json.dumps({"tasks": tasks}) + "\n")
owner = os.environ.get("CLOUDBENCH_FLEET_OWNER_TOKEN", "0" * 32)
run_dir = path.parent.parent
audit = run_dir / "teardown-ownership"
audit.mkdir()
(audit / "pool").mkdir()
(audit / "pool-handoffs").mkdir()
(audit / "pool/fixture").write_text("disposition=returned-stopped-claim-released\n")
(audit / "pool-handoffs/fixture").write_text("disposition=transferred\n")
workspace = str(Path.cwd())
(audit / "meta").write_text(
    f"version=1\nfleet_owner_token={owner}\nrun_id={run_dir.name}\n"
    f"workspace_root={workspace}\nstatus=provider-teardown-verified\n"
)
digest = hashlib.sha256()
for item in sorted(audit.rglob("*"), key=lambda item: str(item.relative_to(audit))):
    if item.is_file():
        relative = str(item.relative_to(audit)).encode()
        payload = item.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
common = subprocess.check_output(["git", "rev-parse", "--git-common-dir"], text=True).strip()
source = (Path(common) / "cloudbench-fleet-audits" / owner).resolve()
(audit / "source-audit").write_text(f"path={source}\nsha256={digest.hexdigest()}\n")
teardown = os.environ.get("FLEET_STABILITY_FAKE_TEARDOWN", "verified")
if teardown != "missing":
    (path.parent / "lifecycle.json").write_text(json.dumps({
        "version": 1, "fleet_owner_token": owner, "run_id": run_dir.name,
        "workspace_root": workspace, "status": teardown,
        "audit_sha256": digest.hexdigest(),
        "controller_exit_code": 1 if slice_index == 0 or infra_slice == str(slice_index) else 0,
    }))
PY
echo "🔏 execution provenance: $run_dir/execution-provenance.json"
if [ "${FLEET_STABILITY_FAKE_INFRA_SLICE:-}" = "$FLEET_STABILITY_SLICE" ] \
  || [ "$FLEET_STABILITY_SLICE" = 0 ]; then
  exit 1
fi
SH
chmod +x "$tmp/fake-fleet"

for teardown in failed missing; do
  if FLEET_STABILITY_FAKE_TEARDOWN="$teardown" \
    FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
    FLEET_INFRA_PROOF_STATE_ROOT="$tmp/teardown-$teardown" \
    FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
      "$RUN_BENCH" stability-proof --runs 1 --concurrency 2 --seed 13 \
      >"$tmp/teardown-$teardown.log" 2>&1; then
    fail "ordinary task outcomes must not mask $teardown final teardown"
  fi
done

if FLEET_STABILITY_FAKE_MALFORMED=1 \
  FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
  FLEET_INFRA_PROOF_STATE_ROOT="$tmp/malformed-outcome" \
  FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
    "$RUN_BENCH" stability-proof --runs 1 --concurrency 2 --seed 13 \
    >"$tmp/malformed-outcome.log" 2>&1; then
  fail "malformed explicit outcome must not fall back to an accepted legacy status"
fi

# Real runner rows retain the agent lifecycle state independently of their
# evaluator outcome. A passed payment-abandonment task is legitimately PAUSED;
# a failed evaluated timeout can still have an ACTIVE snapshot. Interruption
# has the same snapshot, so its explicit CANCELLED outcome must remain INFRA.
FLEET_STABILITY_FAKE_AGENT_STATUS=1 \
FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
FLEET_INFRA_PROOF_STATE_ROOT="$tmp/agent-status" \
FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
  "$RUN_BENCH" stability-proof --runs 1 --concurrency 2 --seed 13 \
  >"$tmp/agent-status.log" 2>&1 \
  || fail "evaluated agent lifecycle states were classified as infrastructure"
if FLEET_STABILITY_FAKE_CANCELLED=1 \
  FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
  FLEET_INFRA_PROOF_STATE_ROOT="$tmp/cancelled-status" \
  FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
    "$RUN_BENCH" stability-proof --runs 1 --concurrency 2 --seed 13 \
    >"$tmp/cancelled-status.log" 2>&1; then
  fail "interrupted ACTIVE snapshot must remain infrastructure"
fi

broken_artifacts="$tmp/broken-artifacts"
ln -s "$tmp/unavailable/artifacts" "$broken_artifacts"
broken_artifact_status=0
FLEET_INFRA_PROOF_ARTIFACT_DIR="$broken_artifacts" \
FLEET_INFRA_PROOF_STATE_ROOT="$tmp/capability-broken-artifact" \
FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
  "$RUN_BENCH" stability-proof --runs 1 --concurrency 2 --seed 13 \
  >"$tmp/broken-artifact.log" 2>&1 || broken_artifact_status=$?
[ "$broken_artifact_status" -eq 0 ] \
  || fail "unavailable optional artifact directory masked proof status (exit=$broken_artifact_status)"
grep -Fq "CAPABILITY STABILITY PROOF PASSED" "$tmp/broken-artifact.log" \
  || fail "proof did not reach its canonical terminal result without artifact storage"

FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
FLEET_INFRA_PROOF_STATE_ROOT="$tmp/capability-pass" \
FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
  "$RUN_BENCH" stability-proof -k=2 --concurrency=3 --seed 17
python3 - "$tmp/capability-pass" <<'PY' || fail "capability proof summary invalid"
import json
import sys
from pathlib import Path

summaries = list(Path(sys.argv[1]).glob("*/summary.json"))
assert len(summaries) == 1, summaries
summary = json.loads(summaries[0].read_text())
assert summary["status"] == "passed", summary
assert summary["runs"] == 2
assert summary["width"] == 3
assert summary["passed_slices"] == 2
assert [item["classification"] for item in summary["slices"]] == [
    "harness",
    "pass",
]
assert all(len(item["names"]) == 3 for item in summary["slices"])
PY

set +e
FLEET_STABILITY_FAKE_INFRA_SLICE=1 \
FLEET_INFRA_PROOF_ARTIFACT_DIR="$tmp/artifacts" \
FLEET_INFRA_PROOF_STATE_ROOT="$tmp/capability-infra" \
FLEET_INFRA_PROOF_FLEET_BIN="$tmp/fake-fleet" \
  "$RUN_BENCH" stability-proof --runs 3 --concurrency 2 --seed 19
infra_status=$?
set -e
[ "$infra_status" -ne 0 ] || fail "capability proof must fail on INFRA"
python3 - "$tmp/capability-infra" <<'PY' || fail "INFRA reset summary invalid"
import json
import sys
from pathlib import Path

summaries = list(Path(sys.argv[1]).glob("*/summary.json"))
assert len(summaries) == 1, summaries
summary = json.loads(summaries[0].read_text())
assert summary["status"] == "failed", summary
assert summary["failed_slice"] == 1
assert summary["passed_slices"] == 1
assert [item["classification"] for item in summary["slices"]] == [
    "harness",
    "infra",
]
PY

echo "All fleet infra stability proof structural checks passed."
