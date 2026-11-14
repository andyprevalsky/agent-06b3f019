"""Choose proof for consumed dependency trees; retain native storage authority."""
import hashlib
import json
import os
import shlex
import subprocess
from pathlib import Path

import pytest

from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function, _write_manifests

ROOT = Path(os.environ.get('I21_REPO_ROOT', Path(__file__).resolve().parents[2]))
FLEET = Path(os.environ.get('I21_FLEET_SOURCE', ROOT / 'scripts/run-bench-fleet'))
ENV = ROOT / 'scripts/lib/cloudbench-env.sh'


def selection(tmp_path, case, image_fault=''):
    repo = tmp_path / 'repo'
    _write_manifests(repo)
    fingerprint = subprocess.run(['bash', '-c', f'''source {shlex.quote(str(ENV))}
cloudbench_node_dependency_fingerprint {shlex.quote(str(repo))}
cloudbench_manifest_fingerprint {shlex.quote(str(repo))} "${{CLOUDBENCH_PYTHON_MANIFESTS[@]}}"
'''], capture_output=True, text=True, check=True).stdout.splitlines()
    node, python = fingerprint
    image = 'sha256:' + 'a' * 64
    proof = dict(schema='cloudbench-image-build-v1', publication_verified=True,
                 published_digest=image, image_ref='registry.fly.io/fixture:image@' + image,
                 published_image_ref='registry.fly.io/fixture:image@' + image,
                 node_dependency_fingerprint=node, python_dependency_fingerprint=python)
    if image_fault == 'wrong-deps':
        proof['node_dependency_fingerprint'] = '0' * 64
    path = tmp_path / 'image.json'
    path.write_text(json.dumps(proof))
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    # Native catalog SIM needs only snapshot trees, no image receipt at all.
    if case in ('native-sim', 'override-sim') or image_fault == 'missing':
        path.unlink()
    state, calls = tmp_path / 'volume.fp', tmp_path / 'calls'
    state.write_text('old-node old-python 1000 vs_old\n')
    pool = tmp_path / 'pool.ids'
    if case == 'pool':
        pool.write_text('existing-machine\n')
    refresh = tmp_path / 'refresh.sh'
    refresh.write_text(f'''printf 'REFRESH\\n' >> {shlex.quote(str(calls))}
printf '%s\\n' '{node} {python} 2000 vs_new' > {shlex.quote(str(state))}
''')
    modes = {'native-sim': ['simulate'], 'mixed': ['real', 'simulate']}.get(case, ['real'])
    benches = ['task' + str(i) for i in range(len(modes))]
    source = FLEET.read_text()
    functions = '\n'.join(_extract_fleet_function(source, sig) for sig in (
        'is_sim_on() {', 'primary_clone_storage_mode() {',
        'fresh_image_deps_preflight() {', 'warm_deps_preflight() {',
    ))
    mutation = ':'
    if case == 'image-drift':
        mutation = 'printf %s ' + shlex.quote(json.dumps({'dependencies': {'changed': '2.0'}})) + ' > ' + shlex.quote(str(repo / 'back-end/package.json'))
    if case == 'image-missing-manifest':
        mutation = 'rm -- ' + shlex.quote(str(repo / 'back-end/package-lock.json'))
    script = f'''set -eu
source {shlex.quote(str(ENV))}
ROOT_DIR={shlex.quote(str(repo))}
APP=fixture
WARM_ID=warm
FRESH_VOLUMES={0 if case == 'snapshot' else 1}
DISPOSABLE_LIFECYCLE={0 if case == 'reuse' else 1}
POOL_IDS_FILE={shlex.quote(str(pool))}
PRIVATE_SOURCE_FILE={'private-source' if case.startswith('private') else ''}
PRIVATE_SOURCE_NODE_FP={'0' * 64 if case == 'private-mismatch' else node}
PRIVATE_SOURCE_PY_FP={python}
BENCHES=({' '.join(benches)})
CATALOG_MODES=({' '.join(modes)})
SIM_ON_CSV={'task0' if case == 'override-sim' else ''}
WARM_DEPS_STATE_FILE={shlex.quote(str(state))}
SNAP_ID=vs_old
SNAPSHOTS_JSON='[{{}}]'
warm_json='[]'
BENCH_REF=fixture
RUN_BENCH_CLOUD_BIN={shlex.quote(str(refresh))}
CLOUDBENCH_IMAGE_BUILD_RECEIPT={shlex.quote(str(path))}
CLOUDBENCH_IMAGE_BUILD_RECEIPT_SHA256={checksum}
campaign_inventory_capture() {{ printf -v "$1" '%s' '[{{"id":"warm","image_ref":{{"digest":"{image}"}}}}]'; }}
warm_deps_recorded_state() {{ printf 'READ_VOLUME_PROOF\\n' >> {shlex.quote(str(calls))}; cat "$WARM_DEPS_STATE_FILE"; }}
snapshot_created_epoch() {{ printf 3000; }}
snapshot_is_complete_exact() {{ return 0; }}
git() {{ return 0; }}
write_startup_card() {{ :; }}
controller_github_token_b64() {{ return 1; }}
{functions}
fresh_image_deps_preflight || exit 1
{mutation}
warm_deps_preflight || exit 1
printf 'CURRENT=%s:%s SNAP=%s\\n' "$CURRENT_NODE_FP" "$CURRENT_PY_FP" "$SNAP_ID"
printf 'ALLOCATE\\n' >> {shlex.quote(str(calls))}
'''
    result = subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=10)
    return result, calls.read_text().splitlines() if calls.exists() else [], node, python


def test_fresh_only_uses_image_without_reading_or_refreshing_volume_dependencies(tmp_path):
    result, calls, node, python = selection(tmp_path, 'fresh')
    assert result.returncode == 0, result.stderr
    assert calls == ['ALLOCATE']
    assert f'CURRENT={node}:{python} SNAP=vs_old' in result.stdout


@pytest.mark.parametrize('case', ['native-sim', 'override-sim', 'mixed', 'snapshot', 'reuse', 'pool'])
def test_snapshot_consumers_keep_volume_dependency_refresh(tmp_path, case):
    result, calls, node, python = selection(tmp_path, case)
    assert result.returncode == 0, result.stderr
    assert calls == ['READ_VOLUME_PROOF', 'REFRESH', 'ALLOCATE']
    assert f'CURRENT={node}:{python} SNAP=vs_new' in result.stdout


@pytest.mark.parametrize('fault', ['wrong-deps', 'missing'])
def test_fresh_image_proof_failure_blocks_before_volume_maintenance(tmp_path, fault):
    result, calls, _, _ = selection(tmp_path, 'fresh', fault)
    assert result.returncode != 0
    assert calls == []


@pytest.mark.parametrize('case', ['private', 'private-mismatch'])
def test_private_source_keeps_its_exact_dependency_contract(tmp_path, case):
    result, calls, node, python = selection(tmp_path, case)
    assert result.returncode == (1 if case.endswith('mismatch') else 0), result.stderr
    assert calls == ([] if case.endswith('mismatch') else ['ALLOCATE'])
    if not case.endswith('mismatch'):
        assert f'CURRENT={node}:{python} SNAP=vs_old' in result.stdout


@pytest.mark.parametrize('case', ['image-drift', 'image-missing-manifest'])
def test_intervening_dependency_drift_refuses_before_volume_maintenance(tmp_path, case):
    result, calls, _, _ = selection(tmp_path, case)
    assert result.returncode != 0
    assert calls == []
