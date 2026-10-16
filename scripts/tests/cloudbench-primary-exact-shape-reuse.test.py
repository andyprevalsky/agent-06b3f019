#!/usr/bin/env python3
"""Exercise the actual primary dispatcher and pool claimer without provider calls."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'run-bench-fleet'


def function(name):
    match = re.search(r'^' + name + r'\(\).*?^}\n', SOURCE.read_text(), re.M | re.S)
    assert match, name
    return match.group()


class ExactShapeReuse(unittest.TestCase):
    def run_case(self, *, shape='shared 4 8192', hints=True, claimed=False, reuse_only=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'claims').mkdir()
            (root / 'out').mkdir()
            (root / 'pool.ids').write_text('abcd\n')
            if hints:
                (root / 'pool-shapes.tsv').write_text('abcd ' + shape + '\n')
            if claimed:
                (root / 'claims/abcd').write_text('quarantined\n')
            script = '''
set -e
GIT_COMMON_DIR="$CASE_DIR"; FLEET_DIR="$CASE_DIR"
POOL_IDS_FILE="$CASE_DIR/pool.ids"; POOL_CLAIMS_DIR="$CASE_DIR/claims"
CLAIMED_POOL_FILE="$CASE_DIR/claimed.ids"; POOL_INVENTORY_JSON='[]'
FLEET_OWNER_TOKEN=owner; FLEET_OWNER_HOST=host; FLEET_OWNER_PID_START=birth
FRESH_TARGET_REGION=''; PRIVATE_SOURCE_ID=''; POOL_COLD_BOOTSTRAP=0
WARM_ID=warm; SNAP_ID=snapshot; UNAVAILABLE_POOL_IDS=()
primary_vm_size_for_bench() { echo shared-cpu-4x; }
primary_vm_memory_for_bench() { echo 8192; }
bench_uses_default_pool_shape() { return 1; }
registry_meta_value() { :; }
pool_claim_cleanup_unconfirmed() { return 0; }
machine_volume_id_from_json() { cat >/dev/null; echo vol_exact; }
write_pool_claim() { printf owned > "$1"; }
cloudbench_env_sha256() { echo digest; }
fleet_audit_record_pool_machine() { echo audit >> "$CASE_DIR/actions"; }
pool_verify_reuse_proof() { echo proof >> "$CASE_DIR/actions"; }
clone_machine_target() { echo clone >> "$CASE_DIR/actions"; echo cdef; }
primary_clone_storage_mode() { echo default; }
'''
            script += function('claim_pool_machine') + function('provision_primary_machine')
            script += '\nprovision_primary_machine large "$CASE_DIR/out"\n'
            result = subprocess.run(['bash', '-c', script], env={**os.environ, 'CASE_DIR': directory,
                                    'POOL_REUSE_ONLY': '1' if reuse_only else '0'}, capture_output=True, text=True)
            cid = (root / 'out/.cid').read_text() if (root / 'out/.cid').exists() else None
            actions = (root / 'actions').read_text().splitlines() if (root / 'actions').exists() else []
            return result, cid, actions

    def test_matching_large_pool_uses_same_machine_without_create(self):
        result, cid, actions = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cid, 'pool abcd\n')
        self.assertEqual(actions, ['audit', 'proof'])

    def test_different_shape_does_not_claim_or_resize(self):
        result, cid, actions = self.run_case(shape='shared 2 4096')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cid, 'clone cdef\n')
        self.assertEqual(actions, ['clone'])

    def test_reuse_only_mismatch_never_creates(self):
        result, cid, actions = self.run_case(shape='shared 2 4096', reuse_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(cid)
        self.assertEqual(actions, [])

    def test_quarantined_exact_match_is_not_claimed(self):
        result, cid, actions = self.run_case(claimed=True, reuse_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(cid)
        self.assertEqual(actions, [])

    def test_missing_shape_proof_is_not_claimed(self):
        result, cid, actions = self.run_case(hints=False, reuse_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(cid)
        self.assertEqual(actions, [])


class ReuseOnlyDefaults(unittest.TestCase):
    def run_shell(self, body, explicit=None, reuse=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pool.ids').write_text('abcd\n')
            script = "set -e\n" + "\n".join(function(name) for name in (
                'reuse_pool_only_admission', 'bench_needs_large_primary',
                'primary_vm_size_for_bench', 'primary_vm_memory_for_bench',
                'bench_uses_default_pool_shape', 'shared_cpu_units_for_vm_size',
                'pool_machine_shape_from_json', 'normalize_current_pool_shape'))
            script += r'''
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x; FLEET_PRIMARY_VM_MEMORY=4096
FLEET_BUNDLED_FRONTEND_VM_SIZE=shared-cpu-4x; FLEET_BUNDLED_FRONTEND_VM_MEMORY=8192
POOL_IDS_FILE="$CASE_DIR/pool.ids"; FLEET_DIR="$CASE_DIR"
POOL_INVENTORY_JSON='[{"id":"abcd","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":4,"memory_mb":8192}}}]'
CATALOG_BROWSER_REQUIRED_TASKS=(browser-task)
PROVISION_POOL=''; FRESH_VOLUMES_REQUESTED=0; RECOVER_STALE_ONLY=0
unset CLOUDBENCH_FRESH_TARGET_REGION CLOUDBENCH_FRESH_VOLUME_UNIQUE_ZONE
unset CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE
'''
            if explicit is not None:
                script += 'CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=' + explicit + '\n'
            script += 'reuse_pool_only_admission\n' + body
            return subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                                  env={**os.environ, 'CASE_DIR': directory, 'POOL_REUSE_ONLY': '1' if reuse else '0'})

    def test_reuse_only_defaults_to_supported_dynamic_mode(self):
        result = self.run_shell('printf "%s" "$CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '1')

    def test_explicit_zero_is_preserved(self):
        result = self.run_shell('printf "%s" "$CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE"', explicit='0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '0')

    def test_ordinary_cli_does_not_change_unset_option(self):
        result = self.run_shell('printf "%s" "${CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE-unset}"', reuse=False)
        self.assertEqual(result.stdout, 'unset')

    def test_default_reuse_normalizer_does_not_resize_large_machine(self):
        result = self.run_shell('resize_pool_machine() { echo unexpected-resize >&2; return 9; }; normalize_current_pool_shape')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('unexpected-resize', result.stderr)

    def test_existing_capacity_plan_counts_requested_large_cpu_and_zero_creates(self):
        source = function('enforce_app_capacity_guard')
        start = source.index('    primary_nx=')
        end = source.index('    capacity_parse_status=0')
        result = self.run_shell('BENCHES=(plain browser-task); replacement_slots=2; warm_json="[]"; available_stopped_pool_machine_count() { echo 2; };\n' + source[start:end] + 'printf "%s %s %s" "$requested_shared" "$requested_fresh_machines" "$requested_pool_eligible_machines"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '6 0 2')


if __name__ == '__main__':
    unittest.main()
