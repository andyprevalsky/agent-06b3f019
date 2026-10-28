#!/usr/bin/env python3
"""Observe exact archived disposable resources; never repair runtime evidence or claims."""
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
import os
import signal
import stat
import time

HERE=Path(__file__).resolve().parent
DEPENDENCIES=HERE
S=runpy.run_path(str(DEPENDENCIES/'cloudbench-archived-owner-stop.py'))
need,raw,obj,sha=S['need'],S['raw'],S['obj'],S['sha']


def prepare(run, inventory, owner):
    need(isinstance(owner,str) and re.fullmatch('[0-9a-f]{32}',owner),'exact forensic owner required')
    plan=S['prepare'](run,inventory)
    need(not plan.get('startup_closure'),'runtime owner required')
    run=Path(run).absolute(); archive=run/'export/originals.tar.gz'
    manifest=json.loads(S['manifest_bytes'](run/'export/manifest.json')); need(not manifest.get('excluded'),'complete forensic export required'); prefix='git-common/cloudbench-fleet-ownership/'+owner
    audit='git-common/cloudbench-fleet-audits/'+owner
    selected={}
    with S['tarfile'].open(archive,'r:gz') as stream:
        for member in stream:
            if not member.name.startswith((prefix+'/',audit+'/', 'git-common/cloudbench-native-effect-fences/'+owner+'/')):continue
            if member.isdir():continue
            expected=manifest['files'].get(member.name,{})
            need(member.isfile() and member.size<=1048576 and expected.get('kind')=='file' and expected.get('bytes')==member.size,'unsafe forensic member')
            data=stream.extractfile(member).read(1048577)
            need(sha(data)==expected['sha256'],'forensic member changed')
            selected[member.name]=data
    def fields(name):return S['fields'](selected[name])
    meta=fields(prefix+'/meta'); shared=fields(audit+'/meta')
    need(audit+'/provider-teardown-verified.epoch' not in manifest['files'] and not any(name.startswith('context/fleet/runs/'+str(meta.get('run_id'))+'/teardown-ownership/') and name.endswith('/provider-teardown-verified.epoch') for name in manifest['files']),'historical provider epoch already exists')
    need(meta.get('version')=='2' and meta.get('host')==plan['controller'] and meta.get('app')==plan['app'] and meta.get('fleet_owner_token')==owner and meta.get('cleanup_policy') in {'reap','retain'},'forensic owner differs')
    run_id=meta.get('run_id')
    need(isinstance(run_id,str) and re.fullmatch('[A-Za-z0-9._-]+',run_id) and shared.get('run_id')==run_id and shared.get('fleet_owner_token')==owner and shared.get('app')==plan['app'] and shared.get('status')=='incomplete','forensic audit differs')
    need(selected.get(prefix+'/disposable-resources-v1')==(owner+'\n'+plan['app']+'\n').encode(),'not disposable owner')
    need(not any(name.startswith(prefix+'/clones/') or '/archived-reuse/' in name or '/pool/' in name for name in selected),'unretired or borrowed ownership')
    # This GET-only forensic authority never grants the fleet reaper authority.
    # Preserve missing guest acknowledgement rather than converting it to success.
    guest_cleanup_missing = prefix+'/guest-cleanup-unconfirmed' in selected
    need(not guest_cleanup_missing or selected[prefix+'/guest-cleanup-unconfirmed'] == b'',
         'guest cleanup marker differs')
    expected={name.removeprefix(audit+'/expected-fresh/'):S['fields'](data) for name,data in selected.items() if name.startswith(audit+'/expected-fresh/')}
    fresh={name.removeprefix(audit+'/fresh/'):S['fields'](data) for name,data in selected.items() if name.startswith(audit+'/fresh/')}
    need(bool(expected) and set(expected)==set(fresh),'incomplete fresh ownership coverage')
    resources=[]; mids=set(); volumes=set()
    for name,row in sorted(fresh.items()):
        need(set(row)=={'version','fleet_owner_token','run_id','app','clone_name','source','source_machine_id','machine_id','volume_id','disposition'},'fresh fields differ')
        mid,vid=row['machine_id'],row['volume_id']
        need(row['version']=='1' and row['fleet_owner_token']==owner and row['run_id']==run_id and row['app']==plan['app'] and row['clone_name']==name and row['source']=='fresh-clone' and row['disposition'] in {'destroyed-verified-absent','destroyed-provider-retained'},'fresh tuple not terminal owned')
        need(expected[name]=={'clone_name':name,'source_machine_id':row['source_machine_id']} and re.fullmatch('[0-9a-f]{14}',mid) and re.fullmatch('vol_[a-z0-9]+',vid),'invalid once-owned tuple')
        need(mid not in mids and vid not in volumes and mid not in plan['protected_machines'] and vid not in plan['protected_volumes'],'duplicate/protected resource')
        mids.add(mid);volumes.add(vid)
        need(selected.get(audit+'/by-machine-id/'+mid)==(name+'\n').encode(),'fresh identity index differs')
        for kind,identifier in (('machine',mid),('volume',vid)):
            intent=json.loads(selected[prefix+'/disposable-delete-'+kind+'-'+identifier+'.json'])
            need(intent==dict(app=plan['app'],identifier=identifier,kind=kind,owner=owner),'original delete intent differs')
        identity = {}
        backup = selected.get(audit+'/volume-backups/'+vid+'/verified.json')
        if backup:
            proof = json.loads(backup)
            need(proof.get('owner')==owner and proof.get('run_id')==run_id
                 and proof.get('app')==plan['app'] and proof.get('machine')==mid
                 and proof.get('volume')==vid and proof['native'].get('id')==vid,
                 'selected volume creation identity differs')
            identity = proof['native']
        resources.append(dict(name=name,machine=mid,volume=vid,source=row['source_machine_id'],volume_identity=identity, machine_identity=_machine_identity(selected, owner, run_id, mid, name)))
    actual_ids={name.removeprefix(audit+'/by-machine-id/') for name in selected if name.startswith(audit+'/by-machine-id/')}
    need(actual_ids==mids,'incomplete identity index')
    for ledger in ('owned-clones.ids','owned-clones.names'):
        need(selected.get(audit+'/'+ledger)==b'','unclosed owned ledger')
    cleanup_path='context/fleet/runs/'+run_id+'/_batch/disposable-cleanup.json'
    cleanup_entry=manifest['files'].get(cleanup_path)
    need(cleanup_entry is not None,'missing disposable cleanup proof')
    with S['tarfile'].open(archive,'r:gz') as stream:
        member=stream.getmember(cleanup_path);need(member.isfile() and member.size<=1048576,'unsafe cleanup proof')
        data=stream.extractfile(member).read(1048577)
        need(sha(data)==cleanup_entry['sha256'],'cleanup proof differs')
        cleanup=json.loads(data)
    need(type(cleanup.get('guest_cleanup_missing')) is bool, 'guest cleanup fact must be boolean')
    runtime_evidence_missing = cleanup.get('runtime_evidence_missing')
    need(type(runtime_evidence_missing) is bool, 'runtime evidence fact must be boolean')
    need(cleanup==dict(schema='disposable-cleanup-v1',owner=owner,guest_cleanup_missing=guest_cleanup_missing,runtime_evidence_missing=runtime_evidence_missing,successful_runtime_inferred=False),'forensic failure facts differ')
    controller_identity = _identity(obj(run/'export/disposable-controller.ownership.json')['machine'])
    need(controller_identity['id'] == plan['controller'], 'controller creation identity differs')
    plan.update(controller_identity=controller_identity,forensic_owner=owner,forensic_resources=resources,run_id=run_id,runtime_sealed=False,original_release_epoch=None)
    # Legacy plans admitted only True and bind that original cleanup via inputs.
    # Preserve their exact shape; explicitly carry the newly admitted False fact.
    if runtime_evidence_missing is False:
        plan['historical_runtime_evidence_missing'] = False
    if meta['cleanup_policy'] == 'retain' or guest_cleanup_missing:
        plan.update(historical_cleanup_policy=meta['cleanup_policy'],
                    historical_guest_cleanup_missing=guest_cleanup_missing)
    return plan


def _identity(machine):
    keys = ('id', 'instance_id', 'name', 'region', 'created_at')
    need(isinstance(machine, dict) and all(isinstance(machine.get(k), str) and machine[k] for k in keys)
         and isinstance(machine.get('config'), dict), 'complete Machine creation identity required')
    return dict({k: machine[k] for k in keys}, config_sha256=sha(json.dumps(
        machine['config'], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()))


def _machine_identity(records, owner, run_id, mid, name):
    prefix = 'git-common/cloudbench-native-effect-fences/'+owner+'/'+run_id+'/'+mid+'/destroy/'
    identities = []
    for path, encoded in records.items():
        if not path.startswith(prefix) or not path.endswith('/intent.json'):
            continue
        incarnation = path.removeprefix(prefix).removesuffix('/intent.json')
        need(re.fullmatch('[0-9a-f]{64}', incarnation), 'invalid native destroy incarnation')
        intent = json.loads(encoded)
        machine = intent.get('machine')
        need(intent.get('operation') == 'destroy', 'original native destroy operation differs')
        identity = _identity(machine)
        need(identity['id'] == mid and identity['name'] == name
             and incarnation == sha(json.dumps([mid, machine['instance_id'], machine['config']],
                        sort_keys=True, separators=(',', ':'), allow_nan=False).encode()),
             'original native destroy identity differs')
        # Successful effect acknowledgement belongs to this exact incarnation;
        # no unacknowledged intent or independently supplied current identity.
        need(json.loads(records[path.removesuffix('intent.json')+'ack.json']) == {'ok': True},
             'original native destroy was not acknowledged')
        identities.append(identity)
    need(len(identities) <= 1, 'ambiguous original Machine destroy incarnation')
    return identities[0] if identities else {}


class Publication:
    """Custody of this invocation's provisional projection, never old receipts."""
    def __init__(self):
        self.path = None
        self.identity = None


def rollback_publication(publication):
    if publication.path is None:
        return
    path = publication.path
    try:
        info = path.lstat()
    except FileNotFoundError:
        publication.path = publication.identity = None
        return
    need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
         and (info.st_dev, info.st_ino) == publication.identity,
         'provisional projection custody changed')
    path.unlink()
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    publication.path = publication.identity = None


def commit_publication(publication):
    # All operation deadline guards have returned before custody is discharged.
    publication.path = publication.identity = None


def _append(directory, prefix, value, publication=None):
    import os
    directory = Path(directory).absolute()
    need(directory.resolve(strict=True) == directory and directory.is_dir()
         and directory.stat().st_uid == os.getuid() and not directory.stat().st_mode & 0o077,
         'private physical receipt directory required')
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    path = directory / (prefix + sha(encoded) + '.json')
    import tempfile
    descriptor, pending = tempfile.mkstemp(prefix='.forensic-pending-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
            staged = os.fstat(stream.fileno())
        # Register exact inode custody while the canonical alarm is blocked.
        # A pending deadline is delivered only after rollback can identify ours.
        if publication is not None:
            need(isinstance(publication, Publication) and publication.path is None,
                 'invalid projection publication custody')
            previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
            try:
                os.link(pending, path)
                publication.path = path
                publication.identity = (staged.st_dev, staged.st_ino)
                info = path.lstat()
                need((info.st_dev, info.st_ino) == publication.identity, 'projection publication inode changed')
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        else:
            os.link(pending, path)
    finally:
        os.unlink(pending)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return path


def _request(api, path):
    captured = []
    def observer(method, received_path, status, payload):
        need(isinstance(payload, bytes) and len(payload) <= 1048576, 'oversized native response')
        captured.append(dict(method=method, path=received_path, status=status,
                             body_b64=base64.b64encode(payload).decode()))
    try:
        api.api('GET', path, timeout=20, observer=observer)
    except S['BASE']['Deadline']:
        raise
    except Exception:
        need(len(captured) == 1 and captured[0]['status'] == 404,
             'exact native response unavailable')
    need(len(captured) == 1 and captured[0]['method'] == 'GET'
         and captured[0]['path'] == path, 'missing exact native response')
    return captured[0]


def _body(item):
    return json.loads(base64.b64decode(item['body_b64'], validate=True))


def _authority(api, app):
    need(getattr(api, 'app', None) == app
         and getattr(api, 'base', None) == 'https://api.machines.dev',
         'canonical native provider namespace required')
    item = _request(api, '')
    value = _body(item)
    need(item['status'] == 200 and isinstance(value, dict) and value.get('name') == app,
         'successful exact app identity required before resource absence')
    return item


def _absence(item, path):
    need(set(item) == {'method', 'path', 'status', 'body_b64'}
         and item['method'] == 'GET' and item['path'] == path
         and type(item['status']) is int and item['status'] == 404,
         'resource is not exactly absent')
    base64.b64decode(item['body_b64'], validate=True)


def _selected_subjects(plan):
    subjects = [dict(kind='machines', id=plan['controller'], terminal_delete=True, identity=plan['controller_identity'])]
    for row in plan['forensic_resources']:
        subjects.append(dict(kind='machines', id=row['machine'], terminal_delete=True, identity=row['machine_identity']))
        subjects.append(dict(kind='volumes', id=row['volume'], terminal_delete=True,
                             original_machine=row['machine'], identity=row['volume_identity']))
    return subjects


def observe(api, plan, output):
    for path, digest in plan['inputs'].items():
        need(S['digest_file'](path) == digest, 'forensic input changed')
    wire = [_authority(api, plan['app'])]
    dispositions = []
    for subject in _selected_subjects(plan):
        path = '/' + subject['kind'] + '/' + subject['id']
        disposition = _observe_terminal(api, subject, output)
        dispositions.append(disposition)
        wire.append(disposition['wire'])
    receipt = dict(schema='cloudbench-forensic-resource-closure-v1', plan=plan, wire=wire,
                   provider_base=api.base, app=api.app, observed_at=time.time(),
                   runtime_sealed=False, original_release_epoch=None, claims_released=False,
                   old_infra_retained=True, benchmark_success_inferred=False,
                   native_resources_terminal=True,
                   native_resources_absent=all(row['disposition']=='ABSENT' for row in dispositions))
    return _append(output, 'forensic-resource-closure-', receipt)


def verify(path):
    path = Path(path).absolute()
    encoded = raw(path, 64 * 1048576)
    receipt = json.loads(encoded)
    need(path.name == 'forensic-resource-closure-' + sha(encoded) + '.json',
         'receipt content digest differs')
    need(type(receipt.get('observed_at')) in (int, float)
         and math.isfinite(receipt['observed_at']) and receipt['observed_at'] > 0,
         'invalid observation clock')
    plan = receipt['plan']
    inputs = plan['inputs']
    run = Path(next(p for p in inputs if p.endswith('/terminal.json'))).parent
    inventory = next(p for p in inputs if p not in {
        str(run / 'terminal.json'), str(run / 'cleanup-call.intent.json'),
        str(run / 'authority.private.json')} and '/export/' not in p)
    need(prepare(run, inventory, plan['forensic_owner']) == plan,
         'forensic plan no longer exact')
    need(receipt.get('provider_base') == 'https://api.machines.dev'
         and receipt.get('app') == plan['app'], 'foreign provider namespace')
    expected = _selected_subjects(plan)
    need(len(receipt['wire']) == len(expected) + 1, 'incomplete native observations')
    app = receipt['wire'][0]
    need(app['method'] == 'GET' and app['path'] == '' and app['status'] == 200
         and _body(app).get('name') == plan['app'], 'app identity observation differs')
    dispositions = [_terminal(item, subject) for item, subject in zip(receipt['wire'][1:], expected)]
    need(receipt['runtime_sealed'] is False and receipt['original_release_epoch'] is None
         and receipt['claims_released'] is False and receipt['old_infra_retained'] is True
         and receipt['benchmark_success_inferred'] is False
         and receipt['native_resources_terminal'] is True
         and type(receipt['native_resources_absent']) is bool
         and receipt['native_resources_absent'] == all(row['disposition']=='ABSENT' for row in dispositions),
         'forensic evidence credit forbidden')
    return receipt


def _archive_records(plan):
    archive = Path(next(path for path in plan['inputs'] if path.endswith('/originals.tar.gz')))
    manifest = json.loads(S['manifest_bytes'](archive.parent / 'manifest.json'))
    need(not manifest.get('excluded'), 'complete admission export required')
    records = {}
    with S['tarfile'].open(archive, 'r:gz') as stream:
        for member in stream:
            if not (member.name.startswith(('git-common/cloudbench-fleet-audits/', 'git-common/cloudbench-native-effect-fences/'))
                    or (member.name.startswith('context/fleet/runs/')
                        and member.name.endswith('/execution-provenance.json'))):
                continue
            if member.isdir():
                continue
            expected = manifest['files'].get(member.name, {})
            need(member.isfile() and member.size <= 1048576
                 and expected.get('kind') == 'file' and expected.get('bytes') == member.size,
                 'unsafe admission ownership record')
            data = stream.extractfile(member).read(1048577)
            need(sha(data) == expected['sha256'], 'admission ownership record changed')
            records[member.name] = data
    return records


def _full_scope(admission, selected, inventory):
    """The existing verified-export authority, narrowed to complete fresh disposables."""
    A = runpy.run_path(str(DEPENDENCIES / 'cloudbench-native-release-audit.py'))
    owned, exports = A['guest_identities'](admission)
    need(exports == A['expected_shards'](admission) > 0,
         'unexported final shard')
    need(owned['registries'] == {selected['forensic_owner']},
         'another retained owner has no forensic closure')
    plans, subjects, bindings = [], {}, {}
    names, tokens, guest_machines, guest_volumes = set(), set(), set(), set()
    def add(kind, identifier, **proof):
        key = kind + '/' + identifier
        need(key not in subjects, 'duplicate admission resource identity')
        need(re.fullmatch('[0-9a-f]{14}', identifier) if kind == 'machines'
             else re.fullmatch('vol_[a-z0-9]+', identifier), 'invalid admission resource ID')
        subjects[key] = dict(kind=kind, id=identifier, **proof)
    for export in A['final_exports'](admission):
        plan = S['prepare'](export.parent, inventory)
        need(plan['app'] == selected['app'] and plan['source_ref'] == selected['source_ref'],
             'foreign admission app/source')
        bindings.update(plan['inputs'])
        plans.append(plan)
        terminal = obj(export.parent / 'terminal.json')
        ownership_path = export / 'disposable-controller.ownership.json'
        workspace_path = export / 'workspace-volume.ownership.json'
        release_path = export / 'disposable-controller.release.json'
        delete_path = export / 'disposable-delete-volume.intent.json'
        controller = obj(ownership_path)
        workspace = obj(workspace_path)
        release = obj(release_path)
        authority_sha = S['digest_file'](export.parent / 'authority.private.json')
        need(controller.get('schema') == 'cloudbench-disposable-controller-ownership-v1'
             and controller.get('authority_sha256') == authority_sha
             and controller.get('workspace_sha256') == S['digest_file'](workspace_path)
             and controller['machine']['id'] == plan['controller'],
             'controller once-owned identity differs')
        vid = workspace['volume_id']
        need(vid not in plan['protected_volumes'], 'protected controller workspace')
        need(workspace.get('app') == plan['app'] and workspace.get('source_ref') == plan['source_ref']
             and controller['volume']['id'] == vid and workspace['native_create']['id'] == vid
             and release == terminal['release'] and release['machine_id'] == plan['controller']
             and release['machine_deleted'] is True and release['volume_id'] == vid
             and release['volume_disposition'] in {'ABSENT', 'pending_destroy', 'destroyed'}
             and obj(delete_path) == dict(authority_sha256=authority_sha, kind='volume', identifier=vid),
             'controller workspace release differs')
        for path in (ownership_path, workspace_path, release_path, delete_path):
            bindings[str(path)] = S['digest_file'](path)
        add('machines', plan['controller'], controller=True, terminal_delete=True, identity=_identity(controller['machine']))
        add('volumes', vid, controller=True, terminal_delete=True,
            original_machine=plan['controller'], identity=workspace['native_create'])
        records = _archive_records(plan)
        metas = [name for name in records if re.fullmatch(
            'git-common/cloudbench-fleet-audits/[0-9a-f]{32}/meta', name)]
        for meta_path in metas:
            prefix = meta_path.removesuffix('/meta')
            owner = prefix.rsplit('/', 1)[1]
            meta = S['fields'](records[meta_path])
            run_id = meta.get('run_id')
            need(meta.get('fleet_owner_token') == owner and meta.get('app') == plan['app']
                 and isinstance(run_id, str) and re.fullmatch('[A-Za-z0-9._-]+', run_id),
                 'audit owner/run/app differs')
            provenance = json.loads(records['context/fleet/runs/' + run_id + '/execution-provenance.json'])
            need(provenance.get('base_sha') == plan['source_ref']
                 and provenance.get('workspace_patch_sha256') == 'none', 'fleet source differs')
            if owner == selected['forensic_owner']:
                need(meta.get('status') == 'incomplete' and plan['controller'] == selected['controller'],
                     'selected failed owner moved')
            else:
                epoch = records.get(prefix + '/provider-teardown-verified.epoch', b'')
                need(meta.get('status') == 'provider-teardown-verified' and epoch
                     and math.isfinite(float(epoch)) and float(epoch) > 0,
                     'another owner lacks canonical teardown')
            expected = {name.removeprefix(prefix + '/expected-fresh/'): S['fields'](data)
                        for name, data in records.items() if name.startswith(prefix + '/expected-fresh/')}
            fresh = {name.removeprefix(prefix + '/fresh/'): S['fields'](data)
                     for name, data in records.items() if name.startswith(prefix + '/fresh/')}
            need(bool(expected) and set(expected) == set(fresh), 'unobserved fresh cohort')
            mids = set()
            for name, row in fresh.items():
                need(row.get('fleet_owner_token') == owner and row.get('run_id') == run_id
                     and row.get('app') == plan['app'] and row.get('version') == '1'
                     and row.get('clone_name') == name and row.get('source') == 'fresh-clone'
                     and row.get('disposition') in {'destroyed-verified-absent', 'destroyed-provider-retained'}
                     and expected[name] == {'clone_name': name, 'source_machine_id': row.get('source_machine_id')},
                     'nonterminal or unknown fresh tuple')
                mid, volume = row['machine_id'], row['volume_id']
                need(records.get(prefix + '/by-machine-id/' + mid) == (name + '\n').encode(),
                     'admission identity index differs')
                need(mid not in plan['protected_machines'] and volume not in plan['protected_volumes'],
                     'protected admission resource')
                add('machines', mid, owner=owner, name=name, terminal_delete=True, identity=_machine_identity(records,owner,run_id,mid,name))
                # The original finalized fresh WAL is canonical delete authority for
                # retired registries; selected retained owners additionally require
                # their original exclusive DELETE intents in prepare().
                backup = records.get(prefix + '/volume-backups/' + volume + '/verified.json')
                identity = {}
                if backup:
                    proof = json.loads(backup)
                    need(proof.get('owner') == owner and proof.get('run_id') == run_id
                         and proof.get('app') == plan['app'] and proof.get('machine') == mid
                         and proof.get('volume') == volume, 'volume identity receipt differs')
                    identity = proof['native']
                    need(identity.get('id') == volume, 'volume receipt ID differs')
                add('volumes', volume, owner=owner, terminal_delete=True, original_machine=mid, identity=identity)
                names.add(name)
                mids.add(mid)
                guest_machines.add(mid)
                guest_volumes.add(volume)
            actual = {name.removeprefix(prefix + '/by-machine-id/') for name in records
                      if name.startswith(prefix + '/by-machine-id/')}
            need(actual == mids, 'unknown admission index subject')
            tokens.add(owner)
    need(owned['ids'] <= guest_machines and owned['volumes'] <= guest_volumes
         and owned['names'] <= names and owned['tokens'] == tokens,
         'unobserved exported ownership subject')
    archive_key = next(path for path in selected['inputs'] if path.endswith('/originals.tar.gz'))
    need(any(plan['controller'] == selected['controller'] and next(value for key, value in plan['inputs'].items() if key.endswith('/originals.tar.gz')) == selected['inputs'][archive_key] for plan in plans),
         'foreign admission archive')
    return A, owned, exports, plans, subjects, bindings


def _terminal(item, subject):
    path = '/' + subject['kind'] + '/' + subject['id']
    need(set(item)=={'method','path','status','body_b64'} and type(item['status']) is int
         and item['method'] == 'GET' and item['path'] == path, 'native subject differs')
    if item['status'] == 404:
        return dict(subject=path, disposition='ABSENT', wire=item)
    need(item['status'] == 200 and subject.get('terminal_delete') is True, 'native resource remains nonterminal')
    if subject['kind'] == 'machines':
        value = _body(item)
        need(isinstance(value, dict) and value.get('state') == 'destroyed'
             and _identity(value) == subject.get('identity'), 'Machine is not terminal exact original incarnation')
        return dict(subject=path, disposition='PROVIDER_TERMINAL_RETAINED', state='destroyed', wire=item)
    need(subject['kind'] == 'volumes', 'unsupported terminal resource kind')
    value = _body(item)
    identity = subject.get('identity') or {}
    need(isinstance(value, dict) and value.get('id') == subject['id']
         and value.get('state') in {'pending_destroy', 'destroyed'}
         and value.get('attached_machine_id') in (None, subject.get('original_machine')), 'Volume is not terminal exact owned ID')
    keys = ('id', 'name', 'region', 'created_at', 'size_gb', 'encrypted')
    need(all(key in identity and value.get(key) == identity[key] for key in keys),
         'terminal Volume creation identity differs')
    return dict(subject=path, disposition='PROVIDER_TERMINAL_RETAINED', state=value['state'], wire=item)


def _observe_terminal(api, subject, output):
    item = _request(api, '/' + subject['kind'] + '/' + subject['id'])
    try:
        return _terminal(item, subject)
    except (ValueError, KeyError, TypeError):
        state = None
        try:
            value = _body(item)
            candidate = value.get('state') if isinstance(value, dict) else None
            if candidate in {'created','starting','started','stopping','stopped','suspended',
                             'destroying','destroyed','pending_destroy','waiting_for_detach'}:
                state = candidate
        except (ValueError, TypeError):
            pass
        diagnostic = dict(schema='cloudbench-forensic-native-refusal-v1',
            subject=item['path'], status=item['status'], state=state, wire=item,
            observed_at=time.time(), claims_released=False)
        # Raw response/config is retained only inside the private receipt; the
        # error contains bounded allowlisted resource identity/status/state.
        _append(output, 'forensic-native-refusal-', diagnostic)
        raise ValueError('native resource refused: subject='+item['path']+
                         ' status='+str(item['status'])+' state='+str(state)) from None


def _reconcile(admission, receipt_path, api, publication):
    receipt = verify(receipt_path)
    selected = receipt['plan']
    need(receipt['provider_base'] == getattr(api, 'base', None)
         and receipt['app'] == getattr(api, 'app', None) == selected['app'],
         'native provider namespace changed')
    admission = Path(admission).absolute()
    run = Path(next(path for path in selected['inputs'] if path.endswith('/terminal.json'))).parent
    inventory = next(path for path in selected['inputs'] if path not in {
        str(run / 'terminal.json'), str(run / 'cleanup-call.intent.json'),
        str(run / 'authority.private.json')} and '/export/' not in path)
    A, owned, exports, plans, subjects, bindings = _full_scope(admission, selected, inventory)
    original_path = admission / 'native-release-audit.json'
    original = obj(original_path)
    original_sha = S['digest_file'](original_path)
    need(original.get('schema') == A['SCHEMA'] and original.get('app') == selected['app']
         and original.get('released') is False
         and original.get('retained_owners') == [selected['forensic_owner']],
         'original audit identity differs')
    # Positive namespace authority precedes both collection and exact resource reads.
    app_proof = _authority(api, selected['app'])
    machines = api.api('GET', '/machines', timeout=60)
    volumes = api.api('GET', '/volumes', timeout=60)
    need(isinstance(machines, list) and isinstance(volumes, list)
         and all(isinstance(row, dict) for row in machines + volumes), 'incomplete current inventory')
    current = A['audit'](machines, app=selected['app'], guest_names=owned['names'],
        guest_ids=owned['ids'], controllers=A['controller_ids'](admission), exports=exports,
        shards=A['expected_shards'](admission), volumes=volumes, guest_volumes=owned['volumes'],
        owner_tokens=owned['tokens'], retained_owners=owned['registries'])
    need(original.get('checked') == current['checked'], 'original admission coverage changed')
    need(not current['present'] and not current['present_volumes'], 'owned native resources remain active')
    # List omission never proves release: exact GET every canonical once-owned ID.
    terminal = [_observe_terminal(api, subject, admission)
                for key, subject in sorted(subjects.items())]
    for path, digest in bindings.items():
        need(S['digest_file'](path) == digest, 'admission proof changed during observation')
    need(S['digest_file'](original_path) == original_sha, 'original audit changed')
    observation = dict(schema='cloudbench-current-resource-observation-v1', app=selected['app'],
        provider_base=api.base, observed_at=time.time(), app_authority=app_proof,
        export_inputs=bindings, source_ref=selected['source_ref'], terminal=terminal,
        current_native_audit=current, selected_forensic_receipt_sha256=S['digest_file'](receipt_path))
    observed_path = _append(admission, 'current-resource-observation-', observation)
    result = dict(schema='cloudbench-forensic-release-projection-v2',
        scope='original-admission-owned-resources', observed_at=observation['observed_at'],
        current_physical_resource_release_verified=True, all_resources_terminal=True,
        all_resources_absent=all(item['disposition'] == 'ABSENT' for item in terminal),
        checked_subjects=sorted(subjects), verified_exports=exports,
        original_audit_sha256=original_sha, observation=str(observed_path),
        observation_sha256=S['digest_file'](observed_path),
        recovery_receipt_sha256=S['digest_file'](receipt_path),
        historical_retained_owners=original['retained_owners'], runtime_sealed=False,
        original_release_epoch=None, claims_released=False, old_infra_retained=True,
        benchmark_success_inferred=False)
    _append(admission, 'forensic-release-projection-', result, publication=publication)
    return result


def reconcile(admission, receipt_path, api, seconds=300, publication=None):
    # Same overall cleanup budget as the canonical archived-owner command.
    need(type(seconds) in (int, float) and math.isfinite(seconds) and 0 < seconds <= 1800, 'invalid recovery observation budget')
    own_publication = publication is None
    publication = Publication() if own_publication else publication
    need(isinstance(publication, Publication) and publication.path is None,
         'invalid projection publication custody')
    try:
        with S['until'](time.monotonic() + seconds):
            result = _reconcile(admission, receipt_path, api, publication)
    except BaseException:
        rollback_publication(publication)
        raise
    if own_publication:
        commit_publication(publication)
    return result
