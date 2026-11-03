"""Exercise claimed-pool CPU admission and its native-provider fence."""

import json
import os
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "requested,kind,cpus,memory,state,accepted",
    [
        ("shared-cpu-4x", "shared", 4, 8192, "stopped", True),
        ("performance-1x", "performance", 1, 4096, "stopped", True),
        ("performance-1x", "shared", 1, 4096, "stopped", False),
        ("shared-cpu-4x", "performance", 4, 8192, "stopped", False),
        ("performance-1x", "performance", 2, 4096, "stopped", False),
        ("performance-1x", "performance", 1, 8192, "stopped", False),
        ("performance-1x", "performance", 1, 4096, "started", False),
        ("unknown-1x", "performance", 1, 4096, "stopped", False),
    ],
)
def test_claimed_pool_shape_requires_exact_requested_native_shape(
    tmp_path, requested, kind, cpus, memory, state, accepted,
):
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("    _pool_shape_args=()")
    arguments = source[start:source.index("    _boot_file_args=(", start)]
    start = source.index('    if [ "$_upd" = 1 ] && [ "${#_pool_shape_args[@]}" -gt 0 ]; then')
    verification = source[start:source.index('    [ "$_upd" = 1 ] || {', start)]
    fixture = tmp_path / "native.json"
    fixture.write_text(json.dumps([{
        "id": "bench-one", "state": state,
        "config": {"guest": {"cpu_kind": kind, "cpus": cpus, "memory_mb": memory}},
    }]))
    script = tmp_path / "verify.sh"
    script.write_text(
        'set -euo pipefail\n'
        'mid=bench-one; APP=navi-whisper-lux-bench; _upd=1\n'
        'FLY() { cat "$NATIVE_SHAPE_FIXTURE"; }\n'
        'sleep() { :; }\n'
        + arguments + verification
        + '\n[ "$_upd" = 1 ]\n'
    )
    result = subprocess.run(
        ["bash", str(script)],
        env={**os.environ, "NATIVE_SHAPE_FIXTURE": str(fixture),
             "CLOUDBENCH_POOL_BOOT_VM_SIZE": requested,
             "CLOUDBENCH_POOL_BOOT_VM_MEMORY": "8192" if requested == "shared-cpu-4x" else "4096"},
        capture_output=True, text=True, timeout=10,
    )
    assert (result.returncode == 0) is accepted, result.stderr + result.stdout


def test_dynamic_pool_preserves_admitted_performance_shape(tmp_path):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    functions = []
    for name in ("pool_machine_shape_from_json", "normalize_current_pool_shape"):
        start = source.index(name + "() {")
        functions.append(source[start:source.index("\n}\n", start) + 3])
    fixture = tmp_path / "native.json"
    fixture.write_text(json.dumps([
        {"id": "primary", "state": "stopped", "config": {"guest": {
            "cpu_kind": "performance", "cpus": 1, "memory_mb": 4096}}},
        {"id": "large", "state": "stopped", "config": {"guest": {
            "cpu_kind": "performance", "cpus": 1, "memory_mb": 8192}}},
    ]))
    ids = tmp_path / "pool.ids"
    ids.write_text("primary\nlarge\n")
    script = tmp_path / "normalize.sh"
    script.write_text(
        'set -euo pipefail\n' + "\n".join(functions)
        + '\nPOOL_INVENTORY_JSON=$(cat "$NATIVE_SHAPE_FIXTURE")\n'
        + 'resize_pool_machine() { echo "unexpected resize of $1" >&2; return 1; }\n'
        + 'FLY() { cat "$NATIVE_SHAPE_FIXTURE"; }\n'
        + 'normalize_current_pool_shape\n'
    )
    result = subprocess.run(
        ["bash", str(script)],
        env={**os.environ, "NATIVE_SHAPE_FIXTURE": str(fixture), "POOL_IDS_FILE": str(ids),
             "FLEET_DIR": str(tmp_path), "GIT_COMMON_DIR": str(tmp_path / "git-common"),
             "CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE": "1",
             "FLEET_PRIMARY_VM_SIZE": "performance-1x", "FLEET_PRIMARY_VM_MEMORY": "4096",
             "FLEET_BUNDLED_FRONTEND_VM_SIZE": "performance-1x", "FLEET_BUNDLED_FRONTEND_VM_MEMORY": "8192"},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert "unexpected resize" not in result.stderr


def test_claim_prefers_exact_performance_shape_over_earlier_candidates(tmp_path):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index("claim_pool_machine() {")
    function = source[start:source.index("\n}\n", start) + 3]
    for name in ("pool_reuse_proof_file", "pool_verify_reuse_proof"):
        helper_start = source.index(name + "() {")
        function += source[helper_start:source.index("\n}\n", helper_start) + 3]
    ids = tmp_path / "pool.ids"
    ids.write_text("a1\nb2\nc3\n")
    (tmp_path / "pool-shapes.tsv").write_text(
        "a1 shared 1 8192\nb2 performance 1 4096\nc3 performance 1 8192\n"
    )
    script = tmp_path / "claim.sh"
    script.write_text(
        "set -euo pipefail\n" + function
        + '\nUNAVAILABLE_POOL_IDS=(); POOL_INVENTORY_JSON="[]"\n'
        + 'machine_volume_id_from_json() { cat >/dev/null; printf "vol-fixture"; }\n'
        + 'write_pool_claim() { printf "owned\\n" > "$1"; }\n'
        + 'cloudbench_env_sha256() { printf "%064d" 0; }\n'
        + 'fleet_audit_record_pool_machine() { return 0; }\n'
        + 'claim_pool_machine performance-1x 8192\n'
    )
    result = subprocess.run(
        ["bash", str(script)],
        env={**os.environ, "POOL_IDS_FILE": str(ids), "FLEET_DIR": str(tmp_path),
             "GIT_COMMON_DIR": str(tmp_path / "common"),
             "POOL_CLAIMS_DIR": str(tmp_path / "claims"),
             "CLAIMED_POOL_FILE": str(tmp_path / "claimed.ids")},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "c3", result.stdout
    assert (tmp_path / "claimed.ids").read_text() == "c3\n"
    assert [p.name for p in (tmp_path / "claims").iterdir()] == ["c3"]


@pytest.mark.parametrize(
    "current,resize",
    [("performance 1 4096", False), ("shared 1 4096", True),
     ("performance 2 4096", True), ("performance 1 8192", True)],
)
def test_boot_resizes_only_mismatched_performance_shapes(tmp_path, current, resize):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index('    pool_boot_vm_size=""')
    selection = source[start:source.index("    # Deterministic per-bench workspace", start)]
    (tmp_path / "pool-shapes.tsv").write_text(f"a1 {current}\n")
    script = tmp_path / "select.sh"
    script.write_text(
        'set -euo pipefail\nsrc=pool; cid=a1; bench=task-one\n'
        + 'primary_vm_size_for_bench() { printf "performance-1x"; }\n'
        + 'primary_vm_memory_for_bench() { printf "4096"; }\n'
        + selection
        + '\nprintf "%s|%s" "$pool_boot_vm_size" "$pool_boot_vm_memory"\n'
    )
    result = subprocess.run(
        ["bash", str(script)],
        env={**os.environ, "FLEET_DIR": str(tmp_path),
             "CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE": "1"},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ("performance-1x|4096" if resize else "|")
