#!/usr/bin/env bash
# Structural contracts for the 10×20 infra stability proof (no live Fly).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

PROOF="$ROOT_DIR/scripts/run-fleet-infra-stability-proof"
SAMPLER="$ROOT_DIR/scripts/fleet_infra_sample.py"
PLAN="$ROOT_DIR/docs/plans/active/fleet-demo-concurrency-e2e.md"

[ -x "$PROOF" ] || fail "run-fleet-infra-stability-proof must be executable"
[ -f "$SAMPLER" ] || fail "fleet_infra_sample.py must exist"
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

echo "All fleet infra stability proof structural checks passed."
