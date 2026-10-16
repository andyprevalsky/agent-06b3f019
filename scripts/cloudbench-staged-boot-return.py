#!/usr/bin/env python3
"""Verify a completed staged primary before the existing exact claim release."""
import argparse
import io
import json
import os
from pathlib import Path
import re
import runpy
import socket
import stat
import sys
import tarfile

HERE = Path(__file__).resolve().parent
H = runpy.run_path(str(HERE / 'cloudbench-explicit-idle-admission.py'))
read, sha, canonical, need = (H[k] for k in ('read', 'sha', 'canonical', 'require'))


def fields(path):
    pairs = [line.split('=', 1) for line in read(path, 65536).decode().splitlines()]
    need(all(len(p) == 2 for p in pairs) and len(dict(pairs)) == len(pairs), 'invalid fields')
    return dict(pairs)


def validate_return_volume(original, current):
    # These allocation counters change when the boot payload writes to the
    # retained filesystem. Every other field, including capacity and identity,
    # remains an exact comparison; unknown/new fields are not ignored.
    counters = {'blocks_free', 'blocks_avail', 'bytes_used'}
    need(isinstance(original, dict) and isinstance(current, dict)
         and original.keys() == current.keys(), 'return Volume fields changed')
    need({k: v for k, v in original.items() if k not in counters}
         == {k: v for k, v in current.items() if k not in counters}, 'return Volume changed')
    present = counters & original.keys()
    if present:
        need(present == counters, 'incomplete Volume usage counters')
        for value in (original, current):
            need(all(type(value.get(k)) is int and value[k] >= 0
                     for k in (*counters, 'blocks', 'bytes_total')), 'invalid Volume usage counters')
            need(value['blocks_avail'] <= value['blocks_free'] <= value['blocks']
                 and value['bytes_used'] <= value['bytes_total'], 'Volume usage counters out of range')


def validate_runtime(output, machine, token):
    # Execute the canonical validator verbatim from this same sealed script
    # snapshot, rather than maintaining a second runtime-evidence predicate.
    source = read(HERE / 'run-bench-fleet', 4 * 1024 * 1024).decode()
    marker = 'cloudbench_validate_primary_runtime_evidence() {  # <bench-output> <machine> <run-token>\n    python3 - "$@" <<\'PY\'\n'
    need(source.count(marker) == 1, 'canonical runtime validator missing')
    code = source.split(marker, 1)[1].split('\nPY\n}', 1)[0]
    previous = sys.argv
    try:
        sys.argv = ['runtime-evidence', str(output), machine, token]
        exec(compile(code, 'canonical-primary-runtime-validator', 'exec'), {})
    finally:
        sys.argv = previous
    return sha(code.encode())


def validate_probe(output, machine, token, app, source):
    """A typed substrate probe is never full task-runtime evidence."""
    owner = json.loads(read(output / 'staged-probe.owner.json'))
    need(owner == dict(schema='cloudbench-staged-probe-owner-v1', app=app, machine_id=machine,
                       run_token=token, source_ref=source, infra_probe=True, runtime_success=False), 'typed probe owner')
    need(not any(os.path.lexists(output / name) for name in
                 ('runtime-evidence.owner.json', 'runtime-evidence.pending', 'remote-logs/runtime-evidence/manifest.json')),
         'probe cannot impersonate real runtime evidence')
    need(read(output / 'benchmark-child.finished', 32).strip() == b'0', 'probe child did not succeed')
    need(read(output / 'barrier.ready.observed', 32) == b'', 'probe never reached strict barrier')
    need(read(output / 'autoscaler.completed-after-child', 32) == b''
         and read(output / 'desired-worker-count', 32).strip() == b'0', 'probe worker controller not joined')
    if os.path.lexists(output / 'worker-clones.ids'):
        need(read(output / 'worker-clones.ids', 65536) == b'', 'probe allocated workers')
    provenance = H['sibling']('cloudbench_execution_provenance.py')['load_provenance'](output.parent / 'execution-provenance.json')
    need(provenance['base_sha'] == source and provenance['config']['values'].get('infra_probe') == '1', 'probe provenance')
    result = json.loads(read(output / 'cloudbench-run.json'))
    need(result.get('infra_probe') is True, 'real result cannot be probe evidence')
    matrix = H['sibling']('cloudbench_execution_provenance.py')['load_task_matrix'](output.parent / 'execution-task-matrix.json')
    task = [t for t in matrix['tasks'] if t['name'] == output.name]
    need(len(task) == 1, 'probe task mapping')
    validator = H['sibling']('cloudbench_result.py')
    need(not validator['validate_run_document'](result, [output.name], require_pass=True,
             expected_execution_provenance=provenance, expected_world_model_mode=task[0]['world_model_mode']), 'invalid canonical probe result')
    card = json.loads(read(output / 'cloudbench-report-card.json'))
    need(card.get('infra_probe') is True and card.get('tasks') == {output.name: dict(passed=True, status='PASSED')}
         and card.get('summary') == dict(total=1, passed=1, failed=0, pass_rate=1.0), 'invalid probe report card')
    return {name: H['descriptor'](output / name) for name in
            ('staged-probe.owner.json', 'cloudbench-run.json', 'cloudbench-report-card.json',
             'benchmark-child.finished', 'barrier.ready.observed', 'autoscaler.completed-after-child', 'desired-worker-count')}


def _verify(output, registry, common, source, machine, volume, before, after, volume_path, *, expected_owner):
    output, registry, common = map(Path, (output, registry, common))
    need(all(p.is_absolute() and p.resolve(strict=True) == p for p in (output, registry, common)), 'physical roots')
    meta = fields(registry / 'meta')
    need(meta['fleet_owner_token'] == registry.name and meta['host'] == socket.gethostname(), 'current owner')
    owner = H['sibling']('cloudbench-explicit-idle-preconfig.py')
    need(expected_owner in ('live', 'absent'), 'invalid owner requirement')
    need(owner['pid_birth_state'](meta['pid'], meta['pid_start']) == expected_owner, 'owner state differs')
    run = Path(meta['runs_root']) / meta['run_id']
    need(output.parent == run, 'output outside exact run')
    contract = H['sibling']('cloudbench_execution_provenance.py')
    provenance = contract['load_provenance'](run / 'execution-provenance.json')
    matrix = contract['load_task_matrix'](run / 'execution-task-matrix.json')
    need(not contract['validate_task_matrix_binding'](provenance, matrix), 'task binding')
    values = provenance['config']['values']
    need(provenance['base_sha'] == source and values.get('boot_transport') == 'staged'
         and all(values.get(k) == '1' for k in ('boot_launch', 'primary_reuse_only', 'cold_primary_bootstrap')), 'staged provenance')
    matches = [i for i, task in enumerate(matrix['tasks']) if task['name'] == output.name]
    need(len(matches) == 1, 'exact task')
    token = registry.name + '-' + str(matches[0])
    need(read(output / '.cid', 256).decode().split() == ['pool', machine], 'borrowed identity')
    claim_path = common / 'cloudbench-pool-claims' / machine
    claim = fields(claim_path)
    need(all(claim.get(k) == meta.get(k) for k in ('fleet_owner_token', 'host', 'pid', 'pid_start'))
         and claim.get('machine_id') == machine and claim.get('volume_id') == volume, 'exact current claim')
    stage = output / 'staged-boot'
    intent = json.loads(read(stage / 'intent.json'))
    ack = json.loads(read(stage / 'launch.ack.json'))
    terminal = json.loads(read(stage / 'terminal.json'))
    is_probe = intent.get('evidence_kind') == 'infra-probe'
    need(intent.get('evidence_kind') in (None, 'infra-probe')
         and ack.get('evidence_kind') == intent.get('evidence_kind')
         and (values.get('infra_probe') == '1') == is_probe, 'staged evidence kind/provenance')
    need(intent['schema'] == 'cloudbench-staged-boot-request-v1' and intent['update_attempted'] is False, 'staged intent')
    need(ack['schema'] == 'cloudbench-staged-boot-launch-v1' and ack['dispatched'] is True
         and ack['runtime_success'] is False, 'dispatch ACK')
    need(all(intent[k] == ack[k] for k in ('app', 'machine', 'volume_id', 'instance_id', 'run_token', 'source_ref', 'config_sha256', 'nonce')), 'ACK identity differs')
    need((intent['app'], intent['machine'], intent['volume_id'], intent['run_token'], intent['source_ref'])
         == (meta['app'], machine, volume, token, source), 'intent current identity')
    expected_terminal = dict(status='BOOT_DISPATCHED', intent_sha256=sha(read(stage / 'intent.json')),
                             launch_ack_sha256=sha(read(stage / 'launch.ack.json')), runtime_success=False, update_attempted=False)
    if is_probe: expected_terminal['evidence_kind'] = 'infra-probe'
    need(ack['intent_sha256'] == sha(read(stage / 'intent.json')) and terminal == expected_terminal, 'dispatch terminal binding')
    need(ack['guest_once'] == '/tmp/cloudbench-staged-boot/' + token
         and type(ack['supervisor_pid']) is int and ack['supervisor_pid'] > 1
         and re.fullmatch('[0-9]+', ack['supervisor_birth']), 'guest dispatch identity')
    payload = json.loads(read(stage / 'payload.json'))
    archive = read(stage / 'boot.tar.gz', 16 * 1024 * 1024)
    need(payload == dict(archive_sha256=sha(archive), bytes=len(archive))
         and ack['archive_sha256'] == sha(archive), 'dispatch archive binding')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        members = tar.getmembers()
        need(len(members) == 7 and len({m.name for m in members}) == 7
             and all(m.isfile() and '/' not in m.name and m.size <= 16 * 1024 * 1024 for m in members), 'archive members')
        contents = {m.name: tar.extractfile(m).read() for m in members}
    need(json.loads(contents['request.json']) == intent, 'archive intent differs')
    environment = json.loads(contents['env.json'])
    need(environment.get('REF') == source and environment.get('CLOUDBENCH_RUN_TOKEN') == token
         and environment.get('CLOUDBENCH_BOOT') == '1', 'archive runtime identity')
    need((environment.get('CLOUDBENCH_INFRA_PROBE') == '1') == is_probe, 'archive probe mode')
    need(set(intent['files']) == {'cloudbench-boot.sh', 'cloudbench-status-server.py',
                                  'cloudbench-boot-payload.py', 'cloudbench-boot-payload.json.gz'}, 'payload entrypoints')
    for name, binding in intent['files'].items():
        need(binding == dict(sha256=sha(contents[name]), bytes=len(contents[name])), 'payload file differs')
    original = json.loads(read(stage / 'native-before.json'))
    started = json.loads(read(stage / 'native-started.json'))
    original_volume = json.loads(read(stage / 'volume-before.json'))
    need(original['id'] == machine and original['instance_id'] == intent['instance_id']
         and original['state'] == 'stopped' and started['state'] == 'started'
         and all(original.get(k) == started.get(k) for k in ('id', 'name', 'instance_id', 'config', 'image_ref'))
         and sha(canonical(original['config'])) == intent['config_sha256'], 'same-config dispatch native')
    first, last = json.loads(read(before)), json.loads(read(after))
    need(Path(before) != Path(after) and not Path(before).samefile(after), 'distinct return reads')
    need(all(first.get(k) == last.get(k) == original.get(k) for k in ('id', 'name', 'instance_id', 'config', 'image_ref'))
         and first['state'] == last['state'] == 'stopped', 'return native changed')
    current_volume = json.loads(read(volume_path))
    validate_return_volume(original_volume, current_volume)
    proof = common / 'cloudbench-pool-reuse' / (machine + '.json')
    H['verify_pool'](proof, common, H['descriptor'](before), H['descriptor'](after), source, current_volume)
    probe_evidence = validate_probe(output, machine, token, meta['app'], source) if is_probe else None
    validator_sha = None if is_probe else validate_runtime(output, machine, token)
    need(read(output / 'guest-shutdown.confirmed', 256).decode().strip() == meta['run_id'], 'guest shutdown not confirmed')
    need(not os.path.lexists(output / 'runtime-evidence.pending'), 'runtime evidence still pending')
    result = dict(schema='cloudbench-staged-boot-return-v1', status='STOPPED_RUNTIME_VERIFIED',
                machine=machine, volume_id=volume, run_token=token, source_ref=source,
                proof=H['descriptor'](proof), output=str(output),
                claim_sha256=sha(read(claim_path)), launch_ack_sha256=sha(read(stage / 'launch.ack.json')),
                canonical_validator_sha256=validator_sha,
                shutdown=H['descriptor'](output / 'guest-shutdown.confirmed'),
                before=H['descriptor'](before), after=H['descriptor'](after), volume=H['descriptor'](volume_path))
    if is_probe:
        result.update(schema='cloudbench-staged-probe-return-v1', status='STOPPED_PROBE_VERIFIED',
                      historical_task_credit=0, real_task_credit=0, probe_evidence=probe_evidence)
    else:
        result['runtime_manifest'] = H['descriptor'](output / 'remote-logs/runtime-evidence/manifest.json')
    return result


def verify(output, registry, common, source, machine, volume, before, after, volume_path):
    return _verify(output, registry, common, source, machine, volume, before, after, volume_path, expected_owner='live')


def verify_existing_return(result, common):
    """Refresh current evidence without replacing the first immutable return."""
    output = Path(result['output']); target = output / 'staged-boot/return.json'
    index = json.loads(read(Path(common) / 'cloudbench-staged-boot-returns' / (result['machine'] + '.json')))
    need(index['receipt'] == H['descriptor'](target), 'saved return binding changed')
    original = H['described'](index['receipt'])
    observations = {'before', 'after', 'volume'}
    for key in observations:
        H['described'](original[key])
    need({k: v for k, v in result.items() if k not in observations}
         == {k: v for k, v in original.items() if k not in observations}, 'saved return identity changed')
    need(not os.path.lexists(output / 'staged-boot/released.json'), 'return already released')
    return result


def current_policy(proof_path):
    proof_path = Path(proof_path)
    index = proof_path.parent.parent / 'cloudbench-staged-boot-returns' / (proof_path.stem + '.json')
    if not os.path.lexists(index):
        return H['current_policy'](proof_path)
    value = json.loads(read(index))
    receipt = H['described'](value['receipt'])
    is_probe = receipt['schema'] == 'cloudbench-staged-probe-return-v1'
    need((receipt['schema'], receipt['status']) in {('cloudbench-staged-boot-return-v1', 'STOPPED_RUNTIME_VERIFIED'),
                                                   ('cloudbench-staged-probe-return-v1', 'STOPPED_PROBE_VERIFIED')}
         and receipt['proof'] == H['descriptor'](proof_path), 'staged return proof changed')
    output = Path(receipt['output'])
    released = json.loads(read(output / 'staged-boot/released.json'))
    need(released == dict(receipt=value['receipt'], claim_sha256=receipt['claim_sha256']), 'staged return not released')
    claim = proof_path.parent.parent / 'cloudbench-pool-claims' / proof_path.stem
    need(not os.path.lexists(claim) or sha(read(claim)) != receipt['claim_sha256'], 'original staged claim still held')
    for key in ('before', 'after', 'volume'):
        H['described'](receipt[key])
    need(H['descriptor'](receipt['shutdown']['path']) == receipt['shutdown'], 'shutdown evidence changed')
    need(sha(read(output / 'staged-boot/launch.ack.json')) == receipt['launch_ack_sha256'], 'launch ACK changed')
    if is_probe:
        need(receipt['historical_task_credit'] == receipt['real_task_credit'] == 0, 'probe cannot carry task credit')
        need(validate_probe(output, receipt['machine'], receipt['run_token'], json.loads(read(proof_path))['app'], receipt['source_ref'])
             == receipt['probe_evidence'], 'probe evidence changed')
    else:
        H['described'](receipt['runtime_manifest'])
        validate_runtime(output, receipt['machine'], receipt['run_token'])
    return 'existing-git-reset-v1'


def record(result, common):
    output = Path(result['output']); target = output / 'staged-boot/return.json'
    save = H['sibling']('cloudbench-startup-failure-archive.py')['durable_handoff_json']
    save(target, result)
    parent = Path(common) / 'cloudbench-staged-boot-returns'
    if not os.path.lexists(parent):
        parent.mkdir(mode=0o700)
        fd=os.open(parent.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
    info=parent.lstat()
    need(parent.resolve(strict=True)==parent and stat.S_ISDIR(info.st_mode)
         and info.st_uid==Path(common).stat().st_uid and stat.S_IMODE(info.st_mode)==0o700, 'return index directory')
    index=parent/(result['machine']+'.json');temporary=parent/(result['machine']+'.'+result['claim_sha256'])
    save(temporary, dict(receipt=H['descriptor'](target)))
    os.replace(temporary,index)
    fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def released(output, common, machine):
    output,common=Path(output),Path(common)
    value=json.loads(read(common/'cloudbench-staged-boot-returns'/(machine+'.json')))
    receipt=H['described'](value['receipt'])
    need(receipt['output']==str(output) and receipt['machine']==machine,'released return identity')
    need(not os.path.lexists(common/'cloudbench-pool-claims'/machine),'claim still exists')
    H['sibling']('cloudbench-startup-failure-archive.py')['durable_handoff_json'](
        output/'staged-boot/released.json',dict(receipt=value['receipt'],claim_sha256=receipt['claim_sha256']))


def worker_shape_matches(proof_path, size, memory):
    """Preselect a matching admitted shape without taking a Machine claim."""
    proof_path=Path(proof_path);proof=json.loads(read(proof_path))
    admission=H['described'](proof['explicit_idle']['admission'])
    need('worker' in admission['allowed_future_roles'],'worker role not admitted')
    state=H['returned_state'](proof_path)
    shape=state['native']['config']['guest'] if state else admission['resource']['shape']
    return shape==H['worker_profile'](size,memory)


def worker_stage(assignment_path, source, node, python_fp, size, memory, api, *, seconds=120):
    assignment=json.loads(read(assignment_path));proof=json.loads(read(assignment['proof']))
    admitted=H['described'](proof['explicit_idle']['admission'])
    if admitted['schema']=='cloudbench-fixed-native-worker-admission-v1':
        fixed=runpy.run_path(str(Path(__file__).with_name('cloudbench-fixed-native-worker.py')))
        return fixed['stage_worker'](assignment_path,source,node,python_fp,size,memory,api,seconds=seconds)

    # Preserve the original stage/shape/claim/API predicates, while letting a
    # released staged primary carry its verified reset policy into a worker.
    original = H['stage_worker'].__globals__['current_policy']
    H['stage_worker'].__globals__['current_policy'] = current_policy
    try:
        if os.environ.get('CLOUDBENCH_BOOT_TRANSPORT') == 'staged':
            target=H['worker_profile'](size,memory);original_api=api
            def api(method,path,body=None,timeout=None):
                need(method=='GET','staged worker cannot resize or mutate config')
                value=original_api(method,path,body,timeout=timeout)
                if path.startswith('/machines/'):
                    need(value.get('config',{}).get('guest')==target,'staged worker requires exact native shape')
                return value
        return H['stage_worker'](assignment_path,source,node,python_fp,size,memory,api,seconds=seconds)
    finally:
        H['stage_worker'].__globals__['current_policy'] = original


def main():
    if len(sys.argv)>1 and sys.argv[1]=='worker-shape':
        p=argparse.ArgumentParser()
        for name in ('proof','size','memory'):p.add_argument('--'+name,required=True)
        a=p.parse_args(sys.argv[2:]);raise SystemExit(0 if worker_shape_matches(a.proof,a.size,a.memory) else 75)
    if len(sys.argv) > 1 and sys.argv[1] == 'worker-stage':
        H['main'].__globals__['stage_worker'] = worker_stage
        H['main']()
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'released':
        need(len(sys.argv)==5,'released arguments');released(*sys.argv[2:]);return
    p = argparse.ArgumentParser()
    for key in ('output', 'registry', 'common', 'source', 'machine', 'volume', 'before', 'after', 'volume-path'):
        p.add_argument('--' + key, required=True)
    p.add_argument('--refresh-existing', action='store_true')
    args = vars(p.parse_args()); refresh = args.pop('refresh_existing')
    result = verify(**{k.replace('-', '_'): v for k, v in args.items()})
    if refresh:
        verify_existing_return(result, args['common'])
    else:
        record(result,args['common'])
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
