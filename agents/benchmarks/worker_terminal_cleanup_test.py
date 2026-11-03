"""Compact actual-ledger controls for late allocation and exact worker cleanup."""

import hashlib
import json
import shutil
import subprocess
import time
import base64
import copy
import os
import runpy
import shlex
from unittest.mock import patch
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def worker_packet(tmp_path, monkeypatch, *, token_override=None):
    from benchmarks.cloudbench_worker_evidence_test import make_bundle
    import argparse
    h = runpy.run_path(str(ROOT / "scripts/cloudbench-worker-reuse.py"))
    e, data, agents, state, expected = make_bundle(tmp_path)
    token = token_override or ('a' * 32 + '-0')
    for name in ('owner.json', 'terminal.json'):
        path = state / name
        row = json.loads(path.read_text()); row['run_token'] = token
        path.write_text(json.dumps(row))
    expected = e.authority(token, '1234abcd')
    monkeypatch.setenv('FLY_MACHINE_ID', '1234abcd')
    archive = tmp_path / 'evidence.tar'
    e.capture(argparse.Namespace(run_token=token, machine_id='1234abcd', data_dir=str(data), output=str(archive)))
    common = tmp_path / "source"
    owner = "a" * 32
    registry = common / "cloudbench-fleet-ownership" / owner
    audit = common / "audit"
    out = common / "runs/run/bench"
    capture = out / "worker-runtime-evidence/1234abcd/capture"
    capture.parent.mkdir(parents=True)
    e.check_archive(archive, expected, capture)
    meta = dict(version="2", fleet_owner_token=owner, cleanup_policy="reap", app="fixture-app",
                run_id="run", runs_root=str(common / "runs"), audit_dir=str(audit), host=os.uname().nodename,
                pid="99999999", pid_start="proc-start:00000000-0000-0000-0000-000000000000:1")
    record = {k: meta[k] for k in ("app", "run_id", "fleet_owner_token")}
    record.update(machine_id="1234abcd", volume_id="vol_worker", clone_name="cloudbench-worker",
                  source_machine_id="87654321", disposition="owned", source="fresh-clone")
    deps = dict(node_dependency_fingerprint="b" * 64, python_dependency_fingerprint="c" * 64)
    contract = runpy.run_path(str(ROOT / 'scripts/cloudbench_execution_provenance.py'))
    matrix = contract['build_task_matrix'](['bench=real'])
    config = contract['build_config'](contract['CONFIG_SCHEMA_VERSION'],
        [f'{k}={v}' for k,v in deps.items()] + ['task_count=1', 'task_matrix_sha256=' + matrix['sha256']])
    provenance = dict(schema_version=contract['EXECUTION_SCHEMA_VERSION'], base_sha='d'*40,
        workspace_patch_sha256='none', controller_snapshot=dict(schema_version=contract['SNAPSHOT_SCHEMA_VERSION'], sha256='4'*64), config=config)
    text = lambda row: "".join(f"{k}={v}\n" for k, v in row.items()).encode()
    f = {"registry/meta": text(meta), "registry/worker": text(dict(name="cloudbench-worker", id="1234abcd", volume_id="vol_worker")),
         "audit/meta": text({k: meta[k] for k in ("app", "run_id", "fleet_owner_token")}), "audit/worker": text(record),
         "run/execution-provenance.json": json.dumps(provenance).encode(),
         "worker/owner.json": json.dumps(dict(version=1, machine_id="1234abcd", primary_machine_id="87654321", run_token=token, workspace="old")).encode()}
    f.update({"capture/" + str(p.relative_to(capture)): p.read_bytes() for p in capture.rglob("*") if p.is_file()})
    paths = {"registry/meta": registry / "meta", "registry/worker": registry / "clones/cloudbench-worker",
             "audit/meta": audit / "meta", "audit/worker": audit / "fresh/cloudbench-worker",
             "run/execution-provenance.json": common / "runs/run/execution-provenance.json",
             "worker/owner.json": capture.parent / "owner.json"}
    for key, path in paths.items():
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(f[key])
    target_common = tmp_path / "destination"; target_common.mkdir()
    target = dict(machine="f" * 14, volume="vol_controller", workspace=str(tmp_path / "destination-workspace"),
                  common=str(target_common), source_ref="e" * 40, ownership_sha256="1" * 64,
                  controller_config_sha256="2" * 64, preservation="rootfs-always", pool_name="workers.cold.ids")
    native = dict(id="1234abcd", name="cloudbench-worker", instance_id="v1", state="stopped",
                  config=dict(init=dict(cmd=["sleep", "infinity"]), env={}, restart=dict(policy="no"),
                              image="fixture@sha256:" + "3" * 64, mounts=[dict(volume="vol_worker", path="/data")],
                              guest=dict(cpu_kind="performance", cpus=1, memory_mb=2048)))
    volume = dict(id="vol_worker", attached_machine_id="1234abcd", state="created", size_gb=40, region="iad")
    encoded = {name: dict(bytes=len(raw), sha256=h['sha'](raw), data=base64.b64encode(raw).decode()) for name, raw in f.items()}
    packet = dict(schema=h['SCHEMA'], role="worker", state="SOURCE_COMMITTED", target=target, owner=owner,
                  machine_id="1234abcd", volume_id="vol_worker", run_token=token, output=str(out),
                  source_ref="d" * 40, dependencies=deps, originals=encoded, native=native, native_volume=volume,
                  snapshot=dict(volume_id="vol_worker", machine_id='1234abcd', native_instance='v1', capture_nonce='9'*32,
                                request=dict(method="POST", path="/volumes/vol_worker/snapshots"),
                                ack=dict(Msg=dict(backup=dict(graph_id="vs_fixture"))),
                                available=dict(id="vs_fixture", size=100, digest="snapshot-digest", state="available")))
    packet['source_hold'] = dict(schema=h['SCHEMA'], role="worker", owner=owner, machine_id="1234abcd",
                                 volume_id="vol_worker", target=target, originals_sha256=h['sha'](h['canonical'](encoded)))
    (audit / 'by-machine-id').mkdir()
    (audit / 'by-machine-id/1234abcd').write_text('cloudbench-worker\n')
    (out / '.cid').write_text('clone 87654321\n')
    (common / 'runs/run/_batch').mkdir()
    (common / 'runs/run/_batch/run.json').write_text(json.dumps(dict(status='failed',run_id='run',execution_provenance=provenance)))
    (common / 'runs/run/_batch/benches.json').write_text(json.dumps([dict(name='bench',mode='REAL')]))
    (common / 'runs/run/execution-task-matrix.json').write_text(json.dumps(matrix))
    (registry / 'runtime-evidence-unconfirmed').write_text('preserved original latch\n')
    before = tmp_path / 'source-before.json'; before.write_text(json.dumps(native))
    after = tmp_path / 'source-after.json'; after.write_text(json.dumps(native))
    volume_path = tmp_path / 'source-volume.json'; volume_path.write_text(json.dumps(volume))
    snapshot_path = tmp_path / 'snapshot.json'; snapshot_path.write_text(json.dumps(packet['snapshot']))
    observation = dict(schema='cloudbench-worker-observation-v1', machine_id='1234abcd', native_instance='v1',
                       nonce='9'*32, collector_sha256=h['sha']((ROOT/'scripts/cloudbench-worker-reuse.py').read_bytes()),
                       observer_sha256=h['sha']((ROOT/'scripts/cloudbench-startup-failure-archive.py').read_bytes()),
                       env_helper_sha256=h['sha']((ROOT/'scripts/lib/cloudbench-env.sh').read_bytes()),
                       source_ref='d'*40, dependencies=deps,
                       data_mount=dict(device=5,inode=6,mount_device='8:1'),
                       observation=dict(kind='exact-inert-quiescence-v1',machine='1234abcd',boot='0'*8+'-'+'0'*4+'-'+'0'*4+'-'+'0'*4+'-'+'0'*12,
                                        unknown=[],inert_sleepers=[dict(pid=10,birth='20')],idle_pinned_agents=[],idle_platform_hallpass=[]))
    observation_path=tmp_path/'observation.json';observation_path.write_text(json.dumps(observation))
    packet = h['collect_packet'](registry, out, '1234abcd', before, after, volume_path, snapshot_path, target, observation_path)
    return h, packet, common, registry


def test_worker_role_handoff_preserves_source_and_uses_distinct_pool(tmp_path, monkeypatch):
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    destination = tmp_path / "packet.json"
    h['export'](packet, common, registry, destination)
    assert h['fields']((registry / 'meta').read_bytes())['cleanup_policy'] == 'retain'
    assert (registry / 'runtime-evidence-unconfirmed').read_text() == 'preserved original latch\n'
    assert (common / 'cloudbench-cold-handoffs/outgoing/1234abcd').exists()
    h['import_packet'](packet, packet['target']['common'], packet['target'])
    target = Path(packet['target']['common'])
    assert (target / 'cloudbench-worker-pools/workers.cold.ids').read_text() == '1234abcd\n'
    assert not (target / 'cloudbench-pools').exists()
    assert not (target / 'cloudbench-pool-claims/1234abcd').exists()
    assert h['validate'](packet, packet['target']) == packet


def test_worker_operator_import_accepts_exported_packet(tmp_path, monkeypatch):
    import sys
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    exported=tmp_path/'operator-export.json'
    target=tmp_path/'target.json';target.write_text(json.dumps(packet['target']))
    export_result=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-worker-reuse.py'),'export',
        '--registry',str(registry),'--output',packet['output'],'--machine','1234abcd',
        '--before',str(tmp_path/'source-before.json'),'--after',str(tmp_path/'source-after.json'),
        '--volume',str(tmp_path/'source-volume.json'),'--snapshot',str(tmp_path/'snapshot.json'),
        '--observation',str(tmp_path/'observation.json'),'--target',str(target),'--packet',str(exported)],
        capture_output=True,text=True,timeout=10)
    assert export_result.returncode==0,export_result.stderr
    assert json.loads(export_result.stdout)['native_calls']==0
    result=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-worker-reuse.py'),str(exported),
        '--target',str(target),'--before',str(tmp_path/'source-before.json'),'--after',str(tmp_path/'source-after.json'),
        '--volume',str(tmp_path/'source-volume.json'),'--source','e'*40,'--node','b'*64,'--python','c'*64,
        '--size','performance-1x','--memory','2048','--app','fixture-app','--import',
        '--packet-sha256',h['sha'](exported.read_bytes())],
        env=dict(os.environ,FLY_MACHINE_ID=packet['target']['machine']),capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr
    assert (Path(packet['target']['common'])/'cloudbench-worker-pools/workers.cold.ids').read_text()=='1234abcd\n'


def test_worker_source_collector_refuses_missing_original_capture(tmp_path, monkeypatch):
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    missing = Path(packet['output']) / 'worker-runtime-evidence/1234abcd/capture/logs/worker.log'
    missing.unlink()
    with pytest.raises((ValueError, KeyError, OSError)):
        h['collect_packet'](registry, Path(packet['output']), '1234abcd', tmp_path / 'source-before.json',
                            tmp_path / 'source-after.json', tmp_path / 'source-volume.json',
                            tmp_path / 'snapshot.json', packet['target'], tmp_path/'observation.json')
    assert not (registry / 'cold-handoff-outgoing').exists()


def test_worker_run_scope_preserves_legacy_evidence_and_refuses_reentry(tmp_path):
    import sys
    data = tmp_path / 'data'; data.mkdir()
    agents = tmp_path / 'agents'; agents.mkdir()
    legacy = data / 'cloudbench-worker-evidence'; legacy.mkdir()
    old = b'{"run_token":"original","retained":true}\n'
    (legacy / 'owner.json').write_bytes(old)
    marker = tmp_path / 'launched'
    command = [sys.executable, str(ROOT / 'scripts/cloudbench-worker-evidence.py'), 'run',
               '--run-token', 'new-token', '--machine-id', '1234abcd', '--data-dir', str(data),
               '--agents-dir', str(agents), '--', sys.executable, '-c',
               f'from pathlib import Path;Path({str(marker)!r}).write_text("new")']
    env = dict(os.environ, FLY_MACHINE_ID='1234abcd', CLOUDBENCH_WORKER_EVIDENCE_SCOPE='run')
    first = subprocess.run(command, env=env, capture_output=True, timeout=10)
    assert first.returncode == 0, first.stderr
    assert marker.read_text() == 'new' and (legacy / 'owner.json').read_bytes() == old
    current = data / 'cloudbench-worker-evidence-new-token/owner.json'
    assert json.loads(current.read_text())['run_token'] == 'new-token'
    marker.unlink()
    second = subprocess.run(command, env=env, capture_output=True, timeout=10)
    assert second.returncode == 1 and not marker.exists()
    assert (legacy / 'owner.json').read_bytes() == old


@pytest.mark.parametrize('fault', ['role', 'owner', 'source', 'capture', 'snapshot', 'target'])
def test_worker_role_handoff_rejects_unproven_records(tmp_path, monkeypatch, fault):
    h, original, _, _ = worker_packet(tmp_path, monkeypatch)
    packet = copy.deepcopy(original)
    if fault == 'role': packet['role'] = 'primary'
    if fault == 'owner': packet['owner'] = 'f' * 32
    if fault == 'source': packet['source_ref'] = 'f' * 40
    if fault == 'capture': packet['originals'].pop('capture/logs/worker.log')
    if fault == 'snapshot': packet['snapshot']['available']['state'] = 'failed'
    if fault == 'target': packet['target']['source_ref'] = 'f' * 40
    with pytest.raises((ValueError, KeyError)):
        h['validate'](packet, original['target'])


def test_existing_worker_reaches_staging_without_creation(tmp_path):
    """The actual worker entry must claim an admitted worker before allocation."""
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    source = _extract_fleet_function(FLEET_SCRIPT.read_text(), "provision_worker() {")
    script = r'''set -uo pipefail
OUT="$1"
claim_reusable_worker() { printf deadbeef000001; }
machine_creation_admission() { echo forbidden >> "$OUT/creates"; return 78; }
cloudbench_record_worker_evidence_owner() { printf '%s\n' "$*" > "$OUT/staged"; return 1; }
''' + source + '\nprovision_worker task workspace deadbeef000002 fdaa::2 0 "$OUT" new-owner-0\n'
    result = subprocess.run(["bash", "-c", script, "worker-reuse", str(tmp_path)], capture_output=True, text=True, timeout=10)
    assert (tmp_path / "staged").exists(), result.stderr
    assert not (tmp_path / "creates").exists(), "existing capacity reached new allocation"
    assert "deadbeef000001 deadbeef000002 new-owner-0 workspace" in (tmp_path / "staged").read_text()


def test_worker_absent_inventory_never_creates(tmp_path):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    source = FLEET_SCRIPT.read_text()
    functions = '\n'.join(_extract_fleet_function(source, n + '() {') for n in
                          ('claim_explicit_idle_worker', 'claim_reusable_worker', 'machine_creation_admission', 'provision_worker'))
    script = ('set -uo pipefail\nROOT_DIR="$1"\n'
              'FLEET_OWNER_TOKEN=11111111111111111111111111111111\n'
              'CURRENT_NODE_FP=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
              'CURRENT_PY_FP=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n'
              + functions + '\nprovision_worker task workspace deadbeef000002 fdaa::2 0 "$1" new-owner-0\n')
    result = subprocess.run(['bash', '-c', script, 'missing', str(tmp_path)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 1
    assert 'No eligible existing worker path' in (tmp_path / 'autoscaler.failed').read_text()


def test_reuse_only_worker_pool_miss_uses_existing_capacity_wait(tmp_path):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    source = FLEET_SCRIPT.read_text()
    functions = '\n'.join(_extract_fleet_function(source, n + '() {') for n in
                          ('claim_explicit_idle_worker', 'claim_reusable_worker',
                           'machine_creation_admission', 'provision_worker'))
    script = ('set -uo pipefail\nROOT_DIR="$1"\n'
              'FLEET_OWNER_TOKEN=11111111111111111111111111111111\n'
              'CURRENT_NODE_FP=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
              'CURRENT_PY_FP=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n'
              'POOL_REUSE_ONLY=1\n'
              + functions + '\nprovision_worker task workspace deadbeef000002 fdaa::2 0 "$1" new-owner-0\n')
    result = subprocess.run(['bash', '-c', script, 'reuse-wait', str(tmp_path)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 75, result.stderr
    assert not (tmp_path / 'autoscaler.failed').exists()
    assert not (tmp_path / 'worker-clones.ids').exists()


@pytest.mark.parametrize('crash_window', [False, True])
def test_worker_claim_executes_shared_exclusive_claim_fsm(tmp_path, monkeypatch, crash_window):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    h['export'](packet, common, registry, tmp_path / 'export.json')
    target = Path(packet['target']['common'])
    h['import_packet'](packet, target, packet['target'])
    out = tmp_path / 'new-output'; out.mkdir()
    (out / 'worker-clones.ids').touch()
    native = tmp_path / 'native.json'; native.write_text(json.dumps(packet['native']))
    volume = tmp_path / 'volume.json'; volume.write_text(json.dumps(packet['native_volume']))
    source = FLEET_SCRIPT.read_text()
    functions = '\n'.join(_extract_fleet_function(source, n + '() {') for n in
        ('pool_claim_fs_transaction', 'write_pool_claim', 'worker_ledger_lock_acquire',
         'worker_ledger_lock_release', 'claim_explicit_idle_worker', 'claim_reusable_worker', 'cloudbench_record_worker_evidence_owner',
             'cloudbench_preserve_unlaunched_worker', 'return_reusable_worker', 'pool_claim_release_exact',
             'cloudbench_fsync_directory', 'cloudbench_validate_worker_evidence_coverage'))
    script = '''set -uo pipefail
ROOT_DIR="$1"; GIT_COMMON_DIR="$2"; OUT="$3"; NATIVE="$4"; VOLUME="$5"
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"
CLOUDBENCH_SCRIPT_SNAPSHOT="$ROOT_DIR/scripts"
POOL_CLAIMS_DIR="$GIT_COMMON_DIR/cloudbench-pool-claims"
APP=fixture-app; FLEET_OWNER_TOKEN=11111111111111111111111111111111
FLEET_OWNER_HOST="$(hostname)"; FLEET_OWNER_PID_START=fixture-birth
BENCH_REF=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
CURRENT_NODE_FP=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CURRENT_PY_FP=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
FLEET_WORKER_VM_SIZE=performance-1x; FLEET_WORKER_VM_MEMORY=2048
fleet_preconfig_native_read() { cp "$NATIVE" "$2"; }
fleet_cold_handoff_volume_read() { cp "$VOLUME" "$2"; }
''' + functions + '''
first="$(claim_reusable_worker "$OUT" 87654321 new-workspace new-token fdaa::2)"
[ "$first" = 1234abcd ] || exit 91
second="$(claim_reusable_worker "$OUT" 87654321 new-workspace new-token fdaa::2)"
[ -z "$second" ] || exit 92
cp "$POOL_CLAIMS_DIR/1234abcd" "$OUT/claim-owner.txt"
cloudbench_record_worker_evidence_owner "$OUT" 1234abcd 87654321 new-token new-workspace
printf 'staging declined before launch\n' > "$OUT/worker-1234abcd.stage.log"
cloudbench_preserve_unlaunched_worker "$OUT" 1234abcd
return_reusable_worker "$OUT" 1234abcd
FLEET_TEARDOWN_OWNERSHIP_DIR="$OUT/audit";mkdir -p "$OUT/audit/fresh"
cloudbench_validate_worker_evidence_coverage "$OUT" 87654321 new-token
'''
    env = dict(os.environ, FLY_MACHINE_ID=packet['target']['machine'])
    result = subprocess.run(['bash', '-c', script, 'claim', str(ROOT), str(target), str(out), str(native), str(volume)],
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert (out / 'worker-clones.ids').read_text() == '1234abcd\n'
    claim = (out / 'claim-owner.txt').read_text()
    authority = json.loads((out / 'worker-borrowed/1234abcd.json').read_text())
    assert f"fleet_owner_token={authority['claim_owner_token']}" in claim
    assert authority['claim_owner_token'] != authority['fleet_owner_token']
    assert authority['primary_host'] == 'fdaa::2'
    assert not (target / 'cloudbench-pool-claims/1234abcd').exists()
    assert h['validate_return'](out, '1234abcd', '87654321', 'new-token')['volume_retained'] is True
    if crash_window:
        released = out / 'worker-borrowed/1234abcd.released.json'
        released.unlink()  # Inject the exact crash after claim unlink and before marker fsync.
        claim_path = target / 'cloudbench-pool-claims/1234abcd'
        claim_path.write_text(claim)
        with pytest.raises(ValueError, match='claim remains held'):
            h['recover_return_release'](out, '1234abcd', '87654321', 'new-token')
        assert not released.exists()
        assert claim_path.read_text() == claim
        claim_path.write_text('new independent generation\n')
        h['verify'](target / 'cloudbench-worker-reuse/proofs/1234abcd.json', packet['target'],
            tmp_path / 'source-before.json', tmp_path / 'source-after.json', tmp_path / 'source-volume.json',
            'e'*40, 'b'*64, 'c'*64, 'performance-1x', 2048)
        assert released.exists()
        assert claim_path.read_text() == 'new independent generation\n'
        assert h['validate_return'](out, '1234abcd', '87654321', 'new-token')['volume_retained'] is True


@pytest.mark.parametrize('fault', ['none', 'old-token', 'old-marker', 'wrong-queue'])
def test_borrowed_worker_readiness_is_new_owner_bound(fault):
    h = runpy.run_path(str(ROOT / 'scripts/cloudbench-worker-reuse.py'))
    e = runpy.run_path(str(ROOT / 'scripts/cloudbench-worker-evidence.py'))
    owner = dict(version=1, machine_id='1234abcd', run_token='new-token', supervisor=dict(pid=101, birth='test'))
    child = dict(version=1, machine_id='1234abcd', run_token='new-token', child=dict(pid=102, birth='test'))
    if fault == 'old-token': child['run_token'] = 'old-token'
    e['read_json'] = lambda path: owner if path.name == 'owner.json' else child
    e['same_process'] = lambda row: True
    env = b'CLOUDBENCH_WORKER_RUN_TOKEN=new-token\0WORKSPACE_NAME=new-workspace\0PRIMARY_HOST=fdaa::2\0'
    if fault == 'wrong-queue': env = env.replace(b'new-workspace', b'old-workspace')
    command = h['ready_command']('1234abcd', 'new-token', 'fdaa::2', 'new-workspace', '/data/new.ready')
    code = shlex.split(command)[-1]
    with patch('runpy.run_path', return_value=e), patch.object(Path, 'read_text', return_value='99' if fault == 'old-marker' else '102'), \
         patch.object(Path, 'read_bytes', return_value=env), patch.object(Path, 'exists', return_value=False), \
         patch.dict(os.environ, FLY_MACHINE_ID='1234abcd'):
        if fault == 'none': exec(code, {})
        else:
            with pytest.raises((AssertionError, ValueError)): exec(code, {})


@pytest.mark.parametrize('mode', ['failure', 'cancel', 'scale-down', 'unknown-idle'])
def test_borrowed_worker_cleanup_never_reaps_and_retains_unknown(tmp_path, mode):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    source = FLEET_SCRIPT.read_text()
    names = ['worker_ledger_lock_acquire', 'worker_ledger_lock_release', 'worker_is_tracked',
             '_pool_ids', 'pool_has_pending_worker', 'cancel_worker_for_scale_down', 'cleanup_failed_worker']
    functions = '\n'.join(_extract_fleet_function(source, n + '() {') for n in names)
    (tmp_path / 'worker-clones.ids').write_text('1234abcd\n')
    (tmp_path / 'worker-ready.ids').write_text('1234abcd\n')
    borrowed = tmp_path / 'worker-borrowed'; borrowed.mkdir()
    (borrowed / '1234abcd.json').write_text('{}')
    evidence = tmp_path / 'worker-runtime-evidence/1234abcd'; evidence.mkdir(parents=True)
    (evidence / 'owner.json').write_text('{}')
    script = '''set -uo pipefail
OUT="$1"; MODE="$2"
reap_machine() { echo forbidden >> "$OUT/reaped"; return 1; }
fleet_registry_volume_for_id() { echo forbidden >> "$OUT/registry"; return 1; }
fleet_registry_release_id() { echo forbidden >> "$OUT/registry"; return 1; }
fleet_audit_update_fresh_clone_by_id() { echo forbidden >> "$OUT/registry"; return 1; }
cloudbench_preserve_unlaunched_worker() { return 1; }
cloudbench_capture_worker_runtime_evidence() { echo captured > "$OUT/captured"; }
return_reusable_worker() { [ "$MODE" != unknown-idle ] || return 1; echo stopped-and-retained > "$OUT/returned"; }
''' + functions + '''
if [ "$MODE" = scale-down ]; then
  selected="$(cancel_worker_for_scale_down "$OUT" 0)"
  [ "$selected" = 1234abcd ] || exit 91
elif [ "$MODE" = cancel ]; then : > "$OUT/worker-1234abcd.cancelled"; fi
cleanup_failed_worker "$OUT" 1234abcd
'''
    result = subprocess.run(['bash', '-c', script, 'cleanup', str(tmp_path), mode], capture_output=True, text=True, timeout=10)
    assert result.returncode == (1 if mode == 'unknown-idle' else 0), result.stderr
    assert not (tmp_path / 'reaped').exists() and not (tmp_path / 'registry').exists()
    assert (tmp_path / 'captured').exists()
    assert (tmp_path / 'worker-clones.ids').read_text() == ('1234abcd\n' if mode == 'unknown-idle' else '')
    assert (tmp_path / 'returned').exists() is (mode != 'unknown-idle')


def test_worker_cleanup_and_terminal_allocation_ownership(tmp_path):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function

    BASE = tmp_path
    RUN = BASE / "cases"
    RUN.mkdir()
    source = FLEET_SCRIPT.read_text()
    functions = (
        "worker_ledger_lock_acquire",
        "worker_ledger_lock_release",
        "cloudbench_record_worker_evidence_owner",
        "cloudbench_preserve_unlaunched_worker",
        "cleanup_failed_worker",
        "provision_worker",
    )
    (BASE / "subject.private.sh").write_text(
        "\n".join(_extract_fleet_function(source, name + "() {") for name in functions)
    )
    results = []
    for mode in [
        "capture_missing_never_launched",
        "capture_present",
        "launched_capture_missing",
        "missing_volume_owner",
        "physical_reap_failed",
        "child_already_finished",
        "child_finished_during_clone",
        "clone_cancelled_without_allocation",
        "clone_failure_ambiguous",
    ]:
        case = RUN / mode
        case.mkdir()
        worker = "deadbeef000001"
        (case / "worker-clones.ids").write_text(worker + "\n")
        (case / "worker-ready.ids").write_text("")
        (case / f"worker-{worker}.pending").touch()
        evidence = case / "worker-runtime-evidence" / worker
        evidence.mkdir(parents=True)
        (evidence / "owner.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "machine_id": worker,
                    "primary_machine_id": "deadbeef000002",
                    "run_token": "fixture-owner-0",
                    "workspace": "fixture",
                }
            )
        )
        # The failed stage never ran the worker. This records failure rather than
        # manufacturing runtime/ready/ACK evidence.
        (case / f"worker-{worker}.stage.log").write_text("neutralize cloned boot command failed rc=1\n")
        if mode in ("capture_present", "launched_capture_missing"):
            (case / f"worker-{worker}.launch-attempted").touch()
        if mode == "child_finished_during_clone":
            shutil.rmtree(case / "worker-runtime-evidence")
            (case / f"worker-{worker}.stage.log").unlink()
        script = r"""set -uo pipefail
    source "$1"
    CASE="$2"; MODE="$3"; ROOT_DIR="$4"; WID=deadbeef000001
    python3() { if [ "${3:-}" = shared-demo-cache-read-only ]; then return 10; fi; command python3 "$@"; }  # catalog policy: writable cache
    fleet_registry_volume_for_id() {
        [ "$1" = "$WID" ] || return 1
        [ "$MODE" != missing_volume_owner ] || return 1
        printf 'vol-owned-fixture'
    }
    cloudbench_capture_worker_runtime_evidence() {
        printf '%s\n' "$2" >> "$CASE/capture-calls"
        [ "$MODE" = capture_present ] || [ "$MODE" = physical_reap_failed ]
    }
    reap_machine() {
        [ "$1" = "$WID" ] && [ "$3" = vol-owned-fixture ] || return 98
        printf '%s\n' "$1" >> "$CASE/reap-calls"
        [ "$MODE" != physical_reap_failed ]
    }
    fleet_audit_update_fresh_clone_by_id() {
        [ "$1" = "$WID" ] && [ "$2" = destroyed-verified-absent ] || return 98
        : > "$CASE/audit-terminal"
    }
    fleet_registry_release_id() { [ "$1" = "$WID" ] || return 98; : > "$CASE/registry-released"; }
    FLEET_OWNER_TOKEN=fixture-owner
    WARM_SOURCE_SIZE_GB=20; SNAP_ID=fixture-snapshot
    FLEET_WORKER_VM_SIZE=performance-1x; FLEET_WORKER_VM_MEMORY=8192
    machine_volume_size_gb() { printf 20; }
    reserve_worker_machine_slot() { : > "$CASE/reservation-called"; return 0; }
    # This control owns late-clone cleanup; admission has its separate real
    # refusal control above and the provider here is entirely fake.
    machine_creation_admission() { return 0; }
    capacity_release_reservation() { : > "$CASE/reservation-released"; return 0; }
    clone_machine_target() {
        : > "$CASE/clone-called"
        if [ "$MODE" = child_finished_during_clone ]; then
            printf '1\n' > "$CASE/benchmark-child.finished"
        fi
        if [ "$MODE" = clone_cancelled_without_allocation ]; then return 75; fi
        if [ "$MODE" = clone_failure_ambiguous ]; then return 1; fi
        printf '%s\n' "$WID" > "$1"
        printf '%s' "$WID"
    }
    controller_github_token_b64() { : > "$CASE/postterminal-setup-called"; return 1; }
    status=0
    case "$MODE" in
      child_already_finished|child_finished_during_clone|clone_cancelled_without_allocation|clone_failure_ambiguous)
        : > "$CASE/worker-clones.ids"
        if [ "$MODE" = child_already_finished ]; then printf '1\n' > "$CASE/benchmark-child.finished"; fi
        provision_worker fixture-task fixture-workspace deadbeef000002 ::1 0 "$CASE" fixture-owner-0 || status=$?
        ;;
      *) cleanup_failed_worker "$CASE" "$WID" || status=$? ;;
    esac
    printf '%s\n' "$status" > "$CASE/result-rc"
    """
        driver = case / "driver.private.sh"
        driver.write_text(script)
        start = time.monotonic()
        with (case / "stdout.private.log").open("wb") as out, (case / "stderr.private.log").open("wb") as err:
            p = subprocess.Popen(
                [shutil.which("bash") or "bash", str(driver), str(BASE / "subject.private.sh"), str(case), mode, str(ROOT)],
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
            birth = subprocess.run(
                ["ps", "-p", str(p.pid), "-o", "lstart="], capture_output=True, text=True, timeout=10
            ).stdout.strip()
            try:
                process_rc = p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                p.terminate()
                process_rc = p.wait(timeout=10)
        actual = int((case / "result-rc").read_text()) if (case / "result-rc").exists() else None
        facts = {
            name: (case / name).exists()
            for name in [
                "reap-calls",
                "capture-calls",
                "registry-released",
                "audit-terminal",
                "clone-called",
                "reservation-called",
                "postterminal-setup-called",
                "worker-clones.ids.lock",
            ]
        }
        tracked = (case / "worker-clones.ids").read_text().splitlines()
        error = None
        try:
            assert process_rc == 0, "fixture-shell-exited"
            if mode in ["capture_missing_never_launched", "capture_present"]:
                assert facts["reap-calls"], "optional-capture-blocked-exact-reap"
                assert actual == 0 and facts["registry-released"] and facts["audit-terminal"] and not tracked
            elif mode in ["missing_volume_owner", "physical_reap_failed", "launched_capture_missing"]:
                assert actual != 0 and tracked == [worker] and not facts["registry-released"]
                assert not facts["audit-terminal"]
                if mode in ("missing_volume_owner", "launched_capture_missing"):
                    assert not facts["reap-calls"], "unowned-volume-reap"
                else:
                    assert facts["reap-calls"], "physical-reap-control-not-reached"
                if mode == "launched_capture_missing":
                    assert facts["capture-calls"], "launched-capture-control-not-reached"
            elif mode == "child_already_finished":
                assert not facts["reservation-called"] and not facts["clone-called"], "postterminal-worker-allocation"
                assert not facts["postterminal-setup-called"]
            elif mode in ("clone_cancelled_without_allocation", "clone_failure_ambiguous"):
                assert facts["reservation-called"] and facts["clone-called"]
                assert not facts["postterminal-setup-called"]
                assert actual == (0 if mode == "clone_cancelled_without_allocation" else 1)
                assert not tracked
                assert (case / "reservation-released").exists() is (mode == "clone_cancelled_without_allocation")
                assert (case / "autoscaler.failed").exists() is (mode == "clone_failure_ambiguous")
            else:
                assert not facts["postterminal-setup-called"], "postterminal-worker-staging"
                assert facts["reap-calls"] and facts["registry-released"] and not tracked, "late-clone-not-released"
                assert (evidence / "not-launched.json").is_file(), "late-clone-evidence-not-preserved"
            assert not facts["worker-clones.ids.lock"], "owned-lock-retained"
        except AssertionError as exc:
            error = str(exc) or "incorrect-exact-release-state"
        current = subprocess.run(
            ["ps", "-p", str(p.pid), "-o", "lstart="], capture_output=True, text=True, timeout=10
        ).stdout.strip()
        result = {
            "case": mode,
            "passed": error is None,
            "error": error,
            "helper_rc": actual,
            "facts": facts,
            "tracked_count": len(tracked),
            "elapsed_seconds": time.monotonic() - start,
            "owner": {"pid": p.pid, "birth": birth, "reaped": True, "absent": not current},
        }
        (case / "receipt.private.json").write_text(json.dumps(result, indent=2))
        results.append(result)
    receipt = {
        "source_sha256": hashlib.sha256((BASE / "subject.private.sh").read_bytes()).hexdigest(),
        "control_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "run": str(RUN),
        "cases": results,
        "passed": sum(x["passed"] for x in results),
        "total": len(results),
        "real_ledger_claim_and_cleanup_function": True,
        "provider_model_calls": 0,
        "private_only": True,
    }
    (RUN / "receipt.private.json").write_text(json.dumps(receipt, indent=2))
    assert receipt["passed"] == receipt["total"], receipt["cases"]
    assert all(row["owner"]["absent"] for row in results)


@pytest.mark.parametrize('fault', ['untracked', 'tracked-during-dependencies', 'untracked-during-dependencies'])
def test_worker_guest_rejects_dirty_or_changing_source(tmp_path, fault):
    h = runpy.run_path(str(ROOT / 'scripts/cloudbench-worker-reuse.py'))
    repo = tmp_path / 'repo'; repo.mkdir()
    subprocess.run(['git','init','-q',str(repo)],check=True)
    (repo/'source.py').write_text('original\n')
    subprocess.run(['git','-C',str(repo),'add','.'],check=True)
    subprocess.run(['git','-C',str(repo),'-c','user.email=fixture@example.test','-c','user.name=Fixture','commit','-qm','fixture'],check=True)
    if fault == 'untracked': (repo/'extra.py').write_text('unexpected\n')
    def dependencies():
        if fault == 'tracked-during-dependencies': (repo/'source.py').write_text('changed\n')
        if fault == 'untracked-during-dependencies': (repo/'extra.py').write_text('unexpected\n')
        return {}
    with pytest.raises((ValueError, subprocess.CalledProcessError)):
        h['capture_worker_guest']('v1','9'*32,data=tmp_path,observe=lambda:{},mount=lambda p:{},dependencies=dependencies)


def test_worker_archive_rejects_foreign_task_ordinal(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match='task|ordinal|owner'):
        worker_packet(tmp_path, monkeypatch, token_override='a'*32+'-7')


@pytest.mark.parametrize('fault', ['batch-run', 'matrix-mode', 'primary'])
def test_worker_archive_rejects_mismatched_original_contract(tmp_path, monkeypatch, fault):
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    raw = h['originals'](packet)
    if fault == 'batch-run':
        row = json.loads(raw['full/batch/run.json']); row['run_id'] = 'foreign'
        raw['full/batch/run.json'] = json.dumps(row).encode()
    elif fault == 'matrix-mode':
        raw['full/batch/benches.json'] = json.dumps([dict(name='bench',mode='SIM')]).encode()
    else:
        raw['primary/identity'] = b'clone unrelated-primary\n'
    packet['originals'] = {name: dict(bytes=len(value),sha256=h['sha'](value),data=base64.b64encode(value).decode()) for name,value in raw.items()}
    packet['source_hold']['originals_sha256'] = h['sha'](h['canonical'](packet['originals']))
    with pytest.raises(ValueError, match='owner/task ordinal/primary'):
        h['validate'](packet, packet['target'])


@pytest.mark.parametrize('fault', ['native', 'volume', 'proof'])
def test_legacy_worker_post_claim_failure_is_not_capacity_wait(tmp_path, monkeypatch, fault):
    """An owned-but-unverified legacy worker is unresolved, not an empty pool."""
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function
    h, packet, common, registry = worker_packet(tmp_path, monkeypatch)
    h['export'](packet, common, registry, tmp_path / 'export.json')
    target = Path(packet['target']['common'])
    h['import_packet'](packet, target, packet['target'])
    out = tmp_path / 'current-output'; out.mkdir()
    native_value = copy.deepcopy(packet['native'])
    if fault == 'proof':
        native_value['instance_id'] = 'foreign-instance'
    native = tmp_path / 'current-native.json'; native.write_text(json.dumps(native_value))
    volume = tmp_path / 'current-volume.json'; volume.write_text(json.dumps(packet['native_volume']))
    source = FLEET_SCRIPT.read_text()
    functions = '\n'.join(_extract_fleet_function(source, name + '() {') for name in
        ('pool_claim_fs_transaction', 'write_pool_claim', 'pool_claim_cleanup_unconfirmed',
         'pool_claim_mark_cleanup_unconfirmed', 'claim_explicit_idle_worker',
         'claim_reusable_worker', 'provision_worker'))
    functions = _extract_fleet_function((ROOT / 'scripts/lib/cloudbench-inventory.sh').read_text(), 'registry_meta_value() {') + '\n' + functions
    script = '''set -uo pipefail
ROOT_DIR="$1"; GIT_COMMON_DIR="$2"; OUT="$3"; NATIVE="$4"; VOLUME="$5"; FAULT="$6"
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"
CLOUDBENCH_SCRIPT_SNAPSHOT="$ROOT_DIR/scripts"
POOL_CLAIMS_DIR="$GIT_COMMON_DIR/cloudbench-pool-claims"
APP=fixture-app; FLEET_OWNER_TOKEN=11111111111111111111111111111111
FLEET_OWNER_HOST="$(hostname)"; FLEET_OWNER_PID_START=fixture-birth
BENCH_REF=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
CURRENT_NODE_FP=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CURRENT_PY_FP=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
FLEET_WORKER_VM_SIZE=performance-1x; FLEET_WORKER_VM_MEMORY=2048; POOL_REUSE_ONLY=1
fleet_preconfig_native_read() { [ "$FAULT" != native ] || return 1; cp "$NATIVE" "$2"; }
fleet_cold_handoff_volume_read() { [ "$FAULT" != volume ] || return 1; cp "$VOLUME" "$2"; }
machine_creation_admission() { echo forbidden > "$OUT/allocation-attempted"; return 1; }
''' + functions + '\nprovision_worker task workspace 87654321 fdaa::2 0 "$OUT" new-token\n'
    result = subprocess.run(['bash', '-c', script, 'unresolved-worker', str(ROOT), str(target),
        str(out), str(native), str(volume), fault], env=dict(os.environ, FLY_MACHINE_ID=packet['target']['machine']), capture_output=True, text=True, timeout=10)
    assert result.returncode == 1, result.stderr
    assert 'Existing worker admission is unresolved' in (out / 'autoscaler.failed').read_text()
    assert not (out / 'allocation-attempted').exists()
    assert not (out / 'worker-clones.ids').exists()
    claim = target / 'cloudbench-pool-claims/1234abcd'
    assert claim.is_file()
    assert h['fields'](claim.read_bytes())['cleanup_state'] == 'unconfirmed'
    assert (target / 'cloudbench-worker-pools/workers.cold.ids').read_text() == '1234abcd\n'
