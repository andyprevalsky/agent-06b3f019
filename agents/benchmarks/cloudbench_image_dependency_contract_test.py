"""Fresh image admission consumes image publication proof, never volume proof."""
import hashlib
import json
import os
import shlex
import subprocess
from pathlib import Path

import pytest

from benchmarks.cloudbench_dependency_sync_test import (
    _extract_fleet_function, _write_manifests,
    test_central_refresh_installs_changed_manifest_dependencies as refresh_volume,
)

ROOT = Path(os.environ.get('I19_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
HELPER = ROOT / 'scripts/lib/cloudbench-env.sh'
FLEET = ROOT / 'scripts/run-bench-fleet'
IMAGE = 'sha256:' + 'a' * 64
NODE, PYTHON = 'b' * 64, 'c' * 64


def admission(tmp_path, fault='', storage='fresh', simulate=False, namespace='ordinary'):
    source_id = 'private-warm' if namespace == 'private' else 'warm'
    receipt = {
        'schema': 'cloudbench-image-build-v1', 'publication_verified': True,
        'published_digest': IMAGE,
        'published_image_ref': 'registry.fly.io/fixture:image@' + IMAGE,
        'image_ref': 'registry.fly.io/fixture:image@' + IMAGE,
        'node_dependency_fingerprint': NODE,
        'python_dependency_fingerprint': PYTHON,
        'source_sha': 'older-script-only-source',
    }
    inventory = [{'id': source_id, 'image_ref': {'digest': IMAGE}, 'config': {}}]
    if fault == 'foreign-source':
        inventory[0]['id'] = 'foreign-warm'
    if fault == 'duplicate-source':
        inventory.append(dict(inventory[0]))
    if fault == 'missing-source':
        inventory = []
    if fault == 'old-image':
        inventory[0]['image_ref']['digest'] = 'sha256:' + 'd' * 64
    if fault in ('node', 'python'):
        receipt[f'{fault}_dependency_fingerprint'] = 'e' * 64
    if fault == 'unverified':
        receipt['publication_verified'] = False
    if fault == 'bool-string':
        receipt['publication_verified'] = 'true'
    if fault == 'tag-only':
        inventory[0]['image_ref'] = {}
        inventory[0]['config'] = {'image': 'registry.fly.io/fixture:image'}
    if fault == 'receipt-image':
        receipt['image_ref'] = 'registry.fly.io/fixture:other@sha256:' + 'd' * 64
    if fault == 'wrong-schema':
        receipt['schema'] = 'volume-proof'
    if fault == 'wrong-type':
        receipt = []
    path = tmp_path / 'receipt.json'
    path.write_text('{' if fault == 'malformed' else json.dumps(receipt))
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    if fault == 'checksum':
        path.write_text('{}')
    if fault == 'missing':
        path.unlink()
    trace = tmp_path / 'calls'
    source = FLEET.read_text()
    gate = (_extract_fleet_function(source, 'fresh_image_deps_preflight() {')
            if 'fresh_image_deps_preflight() {' in source else '')
    # On the original source only the volume gate existed and admitted this
    # matching volume proof, regardless of which baked image fresh storage used.
    volume_gate = _extract_fleet_function(source, 'warm_deps_preflight() {')
    classifier = _extract_fleet_function(source, 'primary_clone_storage_mode() {')
    script = f'''set -eu
source {shlex.quote(str(HELPER))}
ROOT_DIR=fixture
FRESH_VOLUMES={int(storage == 'fresh')}
BENCHES=(fixture)
CATALOG_MODES=(real)
WARM_ID={source_id}
CLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)
CLOUDBENCH_IMAGE_BUILD_RECEIPT={shlex.quote(str(path))}
CLOUDBENCH_IMAGE_BUILD_RECEIPT_SHA256={checksum}
PRIVATE_SOURCE_FILE={'fixture' if namespace == 'private' else ''}
WARM_DEPS_STATE_FILE={shlex.quote(str(tmp_path / 'volume-proof'))}
SNAP_ID=snapshot
SNAPSHOTS_JSON='[{{}}]'
warm_json='[]'
warm_deps_recorded_state() {{ printf '%s\\n' '{NODE} {PYTHON} 1000 snapshot'; }}
snapshot_created_epoch() {{ printf 2000; }}
PRIVATE_SOURCE_NODE_FP={NODE}
PRIVATE_SOURCE_PY_FP={PYTHON}
cloudbench_node_dependency_fingerprint() {{ printf {NODE}; }}
cloudbench_manifest_fingerprint() {{ printf {PYTHON}; }}
is_sim_on() {{ return {0 if simulate else 1}; }}
campaign_inventory_capture() {{ printf inventory >> {shlex.quote(str(trace))}; printf -v "$1" '%s' {shlex.quote(json.dumps(inventory))}; }}
{classifier}
{volume_gate}
{gate}
{('fresh_image_deps_preflight' if gate else 'warm_deps_preflight')}
printf ALLOCATE >> {shlex.quote(str(trace))}
'''
    result = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
    return result, trace.read_text() if trace.exists() else ''


@pytest.mark.parametrize('fault', ['old-image', 'node', 'python', 'unverified', 'bool-string', 'tag-only', 'receipt-image', 'wrong-schema', 'wrong-type', 'malformed', 'checksum', 'missing', 'foreign-source', 'duplicate-source', 'missing-source'])
@pytest.mark.parametrize('namespace', ['ordinary', 'private'])
def test_fresh_storage_refuses_unproven_image_before_allocation(tmp_path, fault, namespace):
    result, calls = admission(tmp_path, fault, namespace=namespace)
    assert result.returncode != 0, (fault, result.stdout, result.stderr, calls)
    assert 'ALLOCATE' not in calls


@pytest.mark.parametrize('namespace', ['ordinary', 'private'])
@pytest.mark.parametrize('storage,simulate', [('fresh', False), ('snapshot', False), ('fresh', True)])
def test_matching_image_and_other_storage_namespaces(tmp_path, storage, simulate, namespace):
    result, calls = admission(tmp_path, 'missing' if storage == 'snapshot' or simulate else '', storage, simulate, namespace)
    assert result.returncode == 0, result.stderr
    assert 'ALLOCATE' in calls
    if storage == 'snapshot' or simulate:
        assert 'inventory' not in calls


def test_actual_volume_refresh_does_not_repair_fresh_image_donor(tmp_path):
    # Real sync-deps with native filesystem copies; npm/npx fixture only avoids
    # network install. The volume's dependency marker never becomes an image.
    refresh_volume(tmp_path)
    donor, volume = tmp_path / 'donor', tmp_path / 'repo'
    fresh = tmp_path / 'fresh'
    _write_manifests(fresh, lock='branch-lock')
    script = ROOT / 'scripts/cloudbench-sync-deps.sh'
    env = {**os.environ, 'CLOUDBENCH_ENV_HELPER': str(HELPER)}
    failed = subprocess.run(['bash', str(script), str(donor), str(fresh)], env=env, capture_output=True, text=True)
    assert failed.returncode == 1
    assert 'warm image/volume JavaScript dependencies do not match' in failed.stderr
    assert not (fresh / 'node_modules/.cloudbench-deps-fingerprint').exists()
    # A correctly populated matching donor succeeds at the unchanged boundary.
    compatible = subprocess.run(['bash', str(script), str(volume), str(fresh)], env=env, capture_output=True, text=True)
    assert compatible.returncode == 0, compatible.stderr
    assert (fresh / 'node_modules/installed-from-manifests').exists()
    assert (fresh / 'node_modules/.cloudbench-deps-fingerprint').read_text() == (volume / 'node_modules/.cloudbench-deps-fingerprint').read_text()


def test_image_producer_records_semantic_identity_not_script_source(tmp_path):
    context = tmp_path / 'context'
    _write_manifests(context)
    (context / 'Dockerfile.cloudbench-warm').write_text('FROM fixture\n')
    (context / 'fly.cloudbench-warm.toml').write_text('app = "fixture"\n')
    function = _extract_fleet_function((ROOT / 'scripts/run-bench-cloud').read_text(), 'image_build_input_provenance() {')
    def produce():
        result = subprocess.run(['bash', '-c', f'''set -eu
source {shlex.quote(str(HELPER))}
IMAGE_BUILD_CONTEXT={shlex.quote(str(context))}
{function}
image_build_input_provenance
'''], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    first = produce()
    (context / 'back-end/package.json').write_text(json.dumps({'scripts': {'migrate': 'new-command'}}))
    scripted = produce()
    assert first['node_dependency_fingerprint'] == scripted['node_dependency_fingerprint']
    assert first['python_dependency_fingerprint'] == scripted['python_dependency_fingerprint']
    (context / 'back-end/package.json').write_text(json.dumps({'dependencies': {'fixture': '2.0'}}))
    assert produce()['node_dependency_fingerprint'] != first['node_dependency_fingerprint']
