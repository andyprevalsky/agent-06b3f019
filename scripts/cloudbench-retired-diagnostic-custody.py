#!/usr/bin/env python3
"""Retain zero-credit diagnostics for an already retired, childless primary.

Never creates a normal runtime manifest, guest ACK, task result, or native
release assertion. Called only under the canonical exact-owner recovery lock.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys
import time

HERE = Path(__file__).resolve().parent
F = runpy.run_path(str(HERE / 'cloudbench-forensic-retirement.py'))
S = runpy.run_path(str(HERE / 'cloudbench-staged-probe-recovery.py'))
E = runpy.run_path(str(HERE / 'cloudbench-exact-session-cleanup.py'))
P = S['P']
read, fields = F['regular_bytes'], F['fields']
need = P['need']


class NotApplicable(Exception):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def directory(path):
    need(path.is_absolute() and path.resolve(strict=True) == path and path.is_dir(), 'physical directory')
    return path



def owner_outputs(run, out):
    """Enumerate every retained output; no unexamined allocation can retire."""
    markers = {'.cid', 'cloudbench-run.json', 'runtime-evidence.pending',
               'runtime-evidence.owner.json', 'post-config-start.accepted',
               'guest-never-started.confirmed', 'worker-runtime-evidence',
               'worker-borrowed', 'worker-clones.ids', 'worker-clones.names'}
    found = []
    def failed(error):
        raise error
    for parent, directories, files in os.walk(run, followlinks=False, onerror=failed):
        parent = directory(Path(parent))
        for name in directories + files:
            path = parent / name
            need(not path.is_symlink(), 'retained output has symlink ancestry')
            if name in markers:
                need(parent == out, 'unexamined admitted output or allocation marker')
                found.append(str(path.relative_to(run)))
    return sorted(found)


def plan(registry, common):
    registry, common = directory(Path(registry)), directory(Path(common))
    meta = fields(registry / 'meta')
    owner = registry.name
    need(re.fullmatch('[0-9a-f]{32}', owner) and registry == common / 'cloudbench-fleet-ownership' / owner, 'exact owner')
    run = directory(Path(meta['runs_root']) / meta['run_id'])
    tasks = json.loads(read(run / '_batch/benches.json', 1048576))
    if not isinstance(tasks, list) or len(tasks) != 1:
        raise NotApplicable('not a single-primary diagnostic owner')
    name = tasks[0]['name']
    need(isinstance(name, str) and re.fullmatch('[A-Za-z0-9._-]+', name) and name not in ('.', '..'), 'task name')
    out = run / name
    diag = out / 'remote-logs/failed-runtime-evidence'
    if not (diag / 'manifest.json').is_file():
        raise NotApplicable('no existing diagnostic capture')
    out = directory(out)
    allocation_paths = owner_outputs(run, out)
    directory(out / 'remote-logs')
    directory(diag)
    directory(diag / 'logs')
    if (os.path.lexists(out / 'remote-logs/runtime-evidence/manifest.json')
            or os.path.lexists(out / 'guest-shutdown.confirmed')
            or os.path.lexists(run / '_forensic/manifest.json')):
        raise NotApplicable('ordinary captured/acknowledged primary')
    audit = directory(Path(meta['audit_dir']))
    records = sorted(directory(audit / 'fresh').iterdir())
    if len(records) != 1:
        raise NotApplicable('not a single fresh allocation')
    original = fields(records[0])
    if original.get('disposition') not in {'destroyed-provider-retained', 'destroyed-verified-absent'}:
        raise NotApplicable('primary has not already retired')
    need(meta.get('version') == '2' and meta.get('fleet_owner_token') == owner
         and meta.get('cleanup_policy') == 'reap' and meta.get('host') == S['socket'].gethostname(), 'recovery owner policy')
    need(P['pid_birth_state'](meta['pid'], meta['pid_start']) == 'absent', 'original controller not dead')
    need(not os.path.lexists(registry / 'guest-cleanup-unconfirmed'), 'guest cleanup still owed')
    need(read(registry / 'runtime-evidence-unconfirmed', 256) == b'', 'runtime latch missing')
    need(not os.path.lexists(out / 'remote-logs/runtime-evidence/manifest.json'), 'normal capture takes ordinary path')
    need(not os.path.lexists(out / 'guest-shutdown.confirmed'), 'ACK takes ordinary path')
    need(audit == common / 'cloudbench-fleet-audits' / owner
         and Path(meta['workspace_root']) == run.parent.parent.parent.parent, 'original roots')
    ameta = fields(audit / 'meta')
    need(all(ameta.get(k) == meta.get(k) for k in ('fleet_owner_token', 'run_id', 'app')), 'audit binding')
    need(original.get('version') == '1' and original.get('source') == 'fresh-clone'
         and all(original.get(k) == meta.get(k) for k in ('fleet_owner_token', 'run_id', 'app')), 'allocation binding')
    mid, vid, clone = original['machine_id'], original['volume_id'], original['clone_name']
    need(re.fullmatch('[0-9a-f]+', mid) and re.fullmatch('vol_[A-Za-z0-9]+', vid)
         and records[0].name == clone and re.fullmatch('cloudbench-[A-Za-z0-9._-]+', clone), 'allocation identity')
    need(read(out / '.cid', 256) == ('clone ' + mid + '\n').encode(), 'task Machine binding')
    token = owner + '-0'
    binding = {'version': 1, 'machine_id': mid, 'run_token': token}
    need(json.loads(read(out / 'runtime-evidence.owner.json', 65536)) == binding
         and json.loads(read(out / 'runtime-evidence.pending', 65536)) == binding, 'pending capture binding')
    for folder in (registry / 'clones',):
        need(not list(directory(folder).iterdir()), 'unretired clone')
    for folder in (audit / 'pool', audit / 'archived-reuse', out / 'worker-runtime-evidence', out / 'worker-borrowed'):
        need(not os.path.lexists(folder) or not list(directory(folder).iterdir()), 'other owned resources')
    need(read(out / 'worker-clones.ids', 65536) == b'', 'worker allocation')
    for n in ('owned-clones.ids', 'owned-clones.names'):
        need(read(audit / n, 65536) == b'', 'owned allocation remains')
    expected = directory(audit / 'expected-fresh')
    index = directory(audit / 'by-machine-id')
    need([f.name for f in expected.iterdir()] == [clone] and [f.name for f in index.iterdir()] == [mid], 'allocation enumeration')
    need(fields(expected / clone) == {'clone_name': clone, 'source_machine_id': original['source_machine_id']}
         and read(index / mid, 256) == (clone + '\n').encode(), 'source allocation index')
    need(re.fullmatch('[0-9a-f]+', original['source_machine_id']) and original['source_machine_id'] != mid, 'source Machine')
    life = json.loads(read(run / '_batch/lifecycle.json', 1048576))
    need(life.get('version') == 1 and life.get('status') == 'failed'
         and life.get('fleet_owner_token') == owner and life.get('run_id') == meta['run_id']
         and type(life.get('controller_exit_code')) is int and life['controller_exit_code'] != 0, 'failed lifecycle')
    C = runpy.run_path(str(HERE / 'cloudbench_execution_provenance.py'))
    provenance = C['load_provenance'](run / 'execution-provenance.json')
    matrix = C['load_task_matrix'](run / 'execution-task-matrix.json')
    need(not C['validate_task_matrix_binding'](provenance, matrix)
         and provenance['config']['values']['app'] == meta['app'], 'source matrix')
    need(matrix['tasks'] == [{'name': name, 'world_model_mode': 'simulate' if tasks[0]['mode'] == 'SIM' else 'real'}], 'task matrix')
    sources = {}
    def retain(path, limit=1048576):
        data = read(path, limit); sources[str(path)] = {'sha256': sha(data), 'bytes': len(data)}
        return data
    for path in (registry / 'meta', audit / 'meta', *records, expected / clone, index / mid,
                 run / '_batch/benches.json', run / '_batch/lifecycle.json', run / 'execution-provenance.json',
                 run / 'execution-task-matrix.json', out / '.cid', out / 'runtime-evidence.owner.json',
                 out / 'runtime-evidence.pending', out / 'worker-clones.ids', audit / 'owned-clones.ids', audit / 'owned-clones.names'):
        retain(path)
    metadata_paths = list(sources)
    manifest = json.loads(retain(diag / 'manifest.json'))
    need(manifest.get('version') == 1 and manifest.get('diagnostic_only') is True
         and type(manifest.get('proof_credit')) is int and manifest['proof_credit'] == 0
         and manifest.get('machine_id') == mid and manifest.get('run_token') == token
         and manifest.get('stack_cleanup_state') == 'failed', 'diagnostic provenance')
    files = manifest.get('files');need(isinstance(files, dict), 'diagnostic file map')
    services = json.loads(read(diag / 'services.json', 1048576));count = services.get('env', {}).get('worker_processes')
    need(services.get('status') == 'stopped' and type(count) is int and 1 <= count <= 64, 'stopped diagnostic services')
    cleanup_name = 'cloudbench-stack-cleanup-' + token + '.status'
    required = {'run.json', 'services.json', 'stack.log', 'logs/backend.log', 'logs/worker.log', cleanup_name}
    required.update('logs/worker.' + str(i) + '.log' for i in range(1, count))
    need(set(files) - {'guest-diagnostics.jsonl'} == required, 'complete diagnostic files')
    need(sum(info.get('bytes', 0) for info in files.values()) <= 512 * 1024 * 1024, 'diagnostic total bound')
    for relative, info in files.items():
        data = retain(diag / relative, 128 * 1024 * 1024)
        need(info == {'bytes': len(data), 'sha256': sha(data)}, 'diagnostic source changed')
    cleanup = fields(diag / cleanup_name)
    need(cleanup.get('token') == token and cleanup.get('state') == 'failed', 'diagnostic cleanup identity')
    document = json.loads(read(diag / 'run.json', 128 * 1024 * 1024))
    need(not C['validate_run_provenance'](document, provenance), 'diagnostic execution source')
    need(len(document.get('tasks', [])) == 1 and document['tasks'][0].get('name') == name, 'diagnostic task')
    task = document['tasks'][0];root = task.get('agent_id')
    need(isinstance(root, str) and E['SAFE_AGENT'].fullmatch(root), 'root identity')
    logs = task.get('logs', {});cleanup = logs.get('cloud_cleanup_evidence', {})
    need(cleanup.get('root_agent_id') == root and cleanup.get('errors') == [] and cleanup.get('warnings') == [], 'root cleanup errors')
    sessions = set()
    for phase in ('before', 'after', 'final', 'payment_snapshot'):
        row = cleanup.get(phase, {})
        need(row.get('root_exists') is True and row.get('tree_agent_ids') == [root]
             and row.get('purchase_cleanup') == [], 'complete root-only snapshot')
        if phase != 'before':
            need(row.get('root_deleted') is True and row.get('unsealed_tree_agent_ids') == [], 'unsealed root')
        found = row.get('browser_sessions');need(isinstance(found, list), 'session enumeration')
        for s in found:
            need(s.get('agent_id') == root and s.get('provider') in E['empty_sessions']()
                 and isinstance(s.get('session_id'), str), 'foreign provider allocation')
            sessions.add((s['provider'], s['session_id']))
    backend, _ = E['read_backend_evidence'](diag / 'logs/backend.log', root)
    E['validate_complete_backend_lifecycle'](backend)
    need(E['parse_active_root_agent'](backend) == root
         and backend.count('[HTTP] POST /api/agents -> 201') == 1, 'backend root binding')
    native_sessions, _, _ = E['collect_session_evidence'](backend)
    _, possibly_created = E['tilion_create_requests'](backend)
    need(possibly_created == len(native_sessions['tilion']), 'unmatched Tilion create')
    need(sessions == {(k, sid) for k, ids in native_sessions.items() for sid in ids} and sessions, 'provider allocation coverage')
    provider = logs.get('cloud_provider_cleanup', {});payment = logs.get('cloud_payment_cleanup', {})
    need(provider.get('root_agent_id') == root and provider.get('root_deleted') is True
         and provider.get('tree_sealed') is True and payment == {'root_agent_id': root, 'purchases': []}, 'provider/payment closure')
    receipts = provider.get('provider_receipts');need(isinstance(receipts, list) and receipts == cleanup.get('provider_receipts'), 'provider receipt binding')
    actual = set()
    for r in receipts:
        pair = (r.get('provider'), r.get('session_id'))
        need(pair in sessions and pair not in actual and type(r.get('status')) is int and r['status'] in E['RELEASED_STATUSES'][r['provider']]
             and re.fullmatch('[0-9a-f]{64}', str(r.get('response_sha256', ''))), 'unproven provider closure')
        actual.add(pair)
    need(actual == sessions, 'missing provider cleanup')
    return {'owner': owner, 'run_id': meta['run_id'], 'app': meta['app'], 'task': name, 'machine_id': mid,
            'volume_id': vid, 'clone_name': clone, 'source': provenance['base_sha'],
            'patch': provenance['workspace_patch_sha256'], 'run_token': token, 'root': root,
            'sources': sources, 'metadata_paths': metadata_paths, 'allocation_paths': allocation_paths, 'run': str(run), 'workspace': meta['workspace_root']}


def verify_native(p, machine, volume):
    need(machine.get('id') == p['machine_id'] and machine.get('name') == p['clone_name']
         and machine.get('state') == 'destroyed', 'native Machine not exactly destroyed')
    config = machine.get('config', {});env = config.get('env', {})
    need(env.get('CLOUDBENCH_RUN_TOKEN') == p['run_token'] and env.get('REF') == p['source']
         and (env.get('LOCAL_PATCH_SHA256') or 'none') == p['patch'], 'native source binding')
    need([m.get('volume') for m in config.get('mounts', [])] == [p['volume_id']], 'native volume binding')
    need(volume.get('id') == p['volume_id'] and volume.get('state') in ('pending_destroy','destroyed')
         and volume.get('attached_machine_id') in (None,'') and volume.get('attached_alloc_id') in (None,''), 'native volume is not detached terminal')
    return {'machine': {k: machine.get(k) for k in ('id','name','state','instance_id','created_at','updated_at')},
            'volume': {k: volume.get(k) for k in ('id','state','attached_machine_id','attached_alloc_id','created_at')},
            'machine_sha256': sha(json.dumps(machine, sort_keys=True, separators=(',',':')).encode()),
            'volume_sha256': sha(json.dumps(volume, sort_keys=True, separators=(',',':')).encode())}


def recover(registry, common, native_read, volume_read, guard_fd, pid, birth):
    p = plan(registry, common)
    S['guard'](Path(registry), Path(common), guard_fd, pid, birth)
    before = native_read(p['machine_id']);volume = volume_read(p['volume_id']);after = native_read(p['machine_id'])
    observed = verify_native(p, before, volume)
    need(verify_native(p, after, volume) == observed, 'native identity changed')
    need(plan(registry, common) == p, 'local custody changed')
    destination = Path(p['run']) / '_retired-diagnostic-custody'
    destination.mkdir(mode=0o700, exist_ok=True);directory(destination)
    # Preserve small owner/audit inputs before normal registry retirement. Large
    # diagnostic originals stay in the retained failed-runtime-evidence folder.
    originals = {path: base64.b64encode(read(Path(path), p['sources'][path]['bytes'])).decode()
                 for path in p['metadata_paths']}
    receipt = {'schema':'cloudbench-retired-diagnostic-custody-v1','version':1,'proof_credit':0,
               'normal_runtime_verified':False,'guest_ack_observed':False,'diagnostic_only':True,
               'binding':p,'native':observed,'small_originals_b64':originals,
               'verifier_sha256':sha(read(Path(__file__),1048576))}
    receipt_path = destination / 'receipt.json'
    if receipt_path.exists():
        previous = json.loads(read(receipt_path, 16 * 1048576))
        need(isinstance(previous, dict) and set(previous) == set(receipt), 'saved diagnostic receipt schema changed')
        need(all(previous[key] == value for key, value in receipt.items() if key != 'native'),
             'saved diagnostic receipt binding changed')
        native = previous['native']
        need(isinstance(native, dict) and set(native) == set(observed), 'saved native observation schema changed')
        old_machine, old_volume = native.get('machine'), native.get('volume')
        need(isinstance(old_machine, dict) and set(old_machine) == set(observed['machine'])
             and all(old_machine[key] == value for key, value in observed['machine'].items() if key != 'updated_at'),
             'saved native Machine identity changed')
        need(isinstance(old_volume, dict) and set(old_volume) == set(observed['volume'])
             and old_volume.get('state') in ('pending_destroy', 'destroyed')
             and all(old_volume[key] == value for key, value in observed['volume'].items() if key != 'state'),
             'saved native Volume identity changed')
        need(all(re.fullmatch('[0-9a-f]{64}', str(native[key])) for key in ('machine_sha256', 'volume_sha256')),
             'saved native observation hash malformed')
        receipt = previous  # Fresh native reads above prove closure; retain the original observation.
    else:
        P['save'](receipt_path, receipt)
    saved_bytes = read(receipt_path, 16 * 1048576)
    need(plan(registry, common) == p, 'custody changed before latch retirement')
    need(read(receipt_path, 16 * 1048576) == saved_bytes, 'saved receipt changed before latch retirement')
    (Path(registry) / 'runtime-evidence-unconfirmed').unlink();P['sync'](Path(registry))
    return receipt


def main():
    parser=argparse.ArgumentParser()
    for key in ('registry','common'):parser.add_argument('--'+key, type=Path, required=True)
    parser.add_argument('--guard-fd',type=int,required=True)
    parser.add_argument('--recovery-pid',type=int,required=True);parser.add_argument('--recovery-birth',required=True)
    a=parser.parse_args()
    try:
        p=plan(a.registry,a.common)
        S['guard'](a.registry,a.common,a.guard_fd,a.recovery_pid,a.recovery_birth)
        B=P['B'];deadline=time.monotonic()+60
        client=P['bounded_read'](lambda:B['Fly'](p['app'],B['resolve_token'](p)),deadline)
        native=lambda mid:P['bounded_read'](lambda:client.machine(mid),deadline)
        volume=lambda vid:P['bounded_read'](lambda:client.volume(vid),deadline)
        receipt=recover(a.registry,a.common,native,volume,a.guard_fd,a.recovery_pid,a.recovery_birth)
        print(json.dumps({'schema':receipt['schema'],'owner':p['owner'],'proof_credit':0,'normal_runtime_verified':False}))
    except NotApplicable:
        raise SystemExit(2)
    except Exception as error:
        print('retired diagnostic custody refused: '+type(error).__name__,file=sys.stderr)
        raise SystemExit(1)

if __name__=='__main__':main()
