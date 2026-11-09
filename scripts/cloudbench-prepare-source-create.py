#!/usr/bin/env python3
"""Create at most one independently owned, parked private source.

Requires FLY_API_TOKEN and flyctl read access. Never stages app secrets, starts
Machines, snapshots/stops donors, retries creates, or adopts discovered IDs.
Use the same --journal and arguments after interruption. A pending write without
its durable ACK is ambiguous and requires provider reconciliation outside this
CLI. `cleanup` removes only positively acknowledged parked resources, optionally
through --prepared-request/--prepared-result/--prepared-manifest verification;
it never guesses an ID. Retain this journal as original create authority for the
prepare-source helper. Capacity reads follow run-original600 capacity_snapshot:
authenticated org setting, complete app listing, every native Machine object
(including stopped, leased and reserved), plus conservative destroying margin.
Additional reservations/headroom only reduce capacity; they never grant credit.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
from datetime import datetime
import re
import runpy
import secrets
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
STORAGE = runpy.run_path(str(HERE / 'cloudbench-volume-migration.py'))
DEADLINES = runpy.run_path(str(HERE / 'cloudbench-disposable-controller.py'))
SNAPSHOT = runpy.run_path(str(HERE / 'cloudbench-select-snapshot.py'))['available_snapshot']
APP = 'navi-whisper-lux-bench'
PROTECTED_MACHINES = {'683e47df5094d8', '811d632f2650e8', '832717a71940d8'}
PROTECTED_VOLUMES = {'vol_vwnym366kn7k8mmv', 'vol_r1jde9donnx2mn9r'}
MAX_BYTES = 64 * 1024 * 1024


class Refusal(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise Refusal(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def read(path):
    STORAGE['plain'](path)
    before = path.lstat()
    def stable(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                info.st_mode, info.st_uid, info.st_gid, info.st_nlink)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_size <= 16 * 1024 * 1024, 'bounded receipt required')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(16 * 1024 * 1024 + 1)
        need(len(raw) == st.st_size and stable(before) == stable(st) == stable(os.fstat(fd)) == stable(path.lstat()),
             'receipt changed during read')
    finally:
        os.close(fd)
    need(st.st_uid == os.geteuid() and not st.st_mode & 0o077 and st.st_nlink == 1,
         'private original receipt required')
    return json.loads(raw, object_pairs_hook=STORAGE['unique_object'])


def save(path, value):
    if path.exists() or path.is_symlink():
        need(read(path) == value, 'immutable receipt differs')
        return
    STORAGE['publish'](path, canonical(value), immutable=True)


def endpoint(value):
    parts = urllib.parse.urlsplit(value)
    need(parts.scheme == 'https' or (parts.scheme == 'http' and parts.hostname in {'localhost', '127.0.0.1', '::1'}),
         'HTTPS or local test endpoint required')
    need(not parts.username and not parts.password and not parts.query and not parts.fragment, 'invalid endpoint')
    return value.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        raise Refusal('redirect refused')


class Native:
    def __init__(self):
        self.base = endpoint(os.environ.get('FLY_FLAPS_BASE_URL', 'https://api.machines.dev'))
        self.graphql = endpoint(os.environ.get('FLY_GRAPHQL_URL', 'https://api.fly.io/graphql'))
        auth = runpy.run_path(str(HERE / 'cloudbench-campaign-machines.py'))['authorization']
        self.auth = auth(os.environ.get('FLY_API_TOKEN', ''), time.monotonic() + 30)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, url, body=None, absent=False, headers=None):
        request = urllib.request.Request(url, method=method, data=None if body is None else canonical(body),
            headers={'Authorization': self.auth, 'Content-Type': 'application/json', 'Accept': 'application/json', **(headers or {})})
        try:
            with DEADLINES['bounded'](20), self.opener.open(request, timeout=20) as response:
                raw = response.read(MAX_BYTES + 1)
                need(len(raw) <= MAX_BYTES, 'native response too large')
                return json.loads(raw, object_pairs_hook=STORAGE['unique_object']) if raw.strip() else {}
        except urllib.error.HTTPError as error:
            if absent and error.code == 404:
                return None
            failure = Refusal('native HTTP request failed: status ' + str(error.code))
            failure.native_status = error.code
            raise failure from None
        except (OSError, ValueError, DEADLINES['Deadline']):
            raise Refusal('native response unavailable or malformed') from None

    def api(self, method, path, body=None, app=APP, absent=False, headers=None):
        return self.request(method, self.base + '/v1/apps/' + app + path, body, absent, headers)


def inventory(rows, label):
    need(isinstance(rows, list) and all(isinstance(r, dict) and isinstance(r.get('id'), str) and r['id'] for r in rows),
         'complete ' + label + ' inventory required')
    need(len({r['id'] for r in rows}) == len(rows), 'duplicate ' + label + ' identity')
    return rows


def reservation_inventory():
    """Observe normal fleet pending slots; never prune, release, or discount foreign records."""
    root = Path(os.environ.get('CLOUDBENCH_CAPACITY_RESERVATION_ROOT',
                str(Path(os.environ.get('TMPDIR', '/tmp')) / ('rose-cloudbench-capacity-' + APP))))
    need(root.is_absolute() and root.resolve() == root, 'physical reservation root required')
    result = dict(root=str(root), exists=root.exists(), records=[], machine_slots=0)
    if not root.exists():
        need(not root.is_symlink(), 'reservation root alias')
        return result
    STORAGE['plain'](root, True)
    directory = root / 'reservations'
    if not directory.exists():
        need(not directory.is_symlink(), 'reservation directory alias')
        return result
    STORAGE['plain'](directory, True)
    for path in sorted(directory.iterdir()):
        # A half-published or malformed foreign reservation is uncertainty, not capacity.
        fields = STORAGE['fields'](path)
        required = {'version', 'app', 'host', 'pid', 'pid_start', 'run_id', 'token',
                    'machine_slots', 'shared_units', 'kind'}
        need(required <= fields.keys() and fields['version'] == '1' and fields['app'] == APP
             and fields['token'] == path.name and fields['host'] and fields['pid_start']
             and fields['pid'].isdecimal() and int(fields['pid']) > 0
             and fields['machine_slots'].isdecimal() and fields['shared_units'].isdecimal(),
             'malformed normal fleet reservation')
        result['records'].append(dict(name=path.name, sha256=sha(fields), machine_slots=int(fields['machine_slots'])))
        result['machine_slots'] += int(fields['machine_slots'])
    return result


def capacity(api, args, journal, phase):
    started = time.time()
    query = 'query { organization(slug:' + json.dumps(args.org) + ') { id slug settings billingStatus } }'
    result = api.request('POST', api.graphql, {'query': query})
    org = result.get('data', {}).get('organization')
    need(not result.get('errors') and isinstance(org, dict) and org.get('slug') == args.org,
         'complete organization settings required')
    limit = org.get('settings', {}).get('machines_per_org_limit')
    need(type(limit) is int and 1 <= limit <= 1000, 'measured organization Machine limit required')
    process = subprocess.run(['flyctl', 'apps', 'list', '--org', args.org, '--json'],
                             capture_output=True, timeout=20, check=True)
    apps = json.loads(process.stdout, object_pairs_hook=STORAGE['unique_object'])
    need(isinstance(apps, list) and apps and all(isinstance(a, dict) for a in apps), 'complete app inventory required')
    names = [a.get('Name') for a in apps]
    need(all(isinstance(n, str) and re.fullmatch('[a-z0-9-]+', n) for n in names)
         and len(set(names)) == len(names) and APP in names, 'complete scoped app inventory required')
    for app in apps:
        scope = app.get('Organization')
        need((scope.get('Slug') if isinstance(scope, dict) else scope) == args.org, 'app organization mismatch')
    rows = {name: inventory(api.api('GET', '/machines?summary=true', app=name), 'Machine') for name in names}
    count = sum(len(items) for items in rows.values())
    reservations = reservation_inventory()
    available = limit - count - args.extra_destroying_count - reservations['machine_slots'] - args.reserved_slots - args.headroom
    proof = dict(version=1, started_epoch=started, ended_epoch=time.time(), machine_limit=limit,
        organization=org, apps=apps, native_counts={name: len(items) for name, items in rows.items()},
        total_active_inventory_objects=count, conservative_extra_destroying_bench_objects=args.extra_destroying_count,
        observed_reservations=reservations, additional_reserved_slots=args.reserved_slots, headroom=args.headroom,
        available_slots_conservative=available, measured_unmet_need=1, atomic_snapshot=False,
        all_reserved_native_objects_counted=True, reservations_observed_epoch=time.time())
    save(journal / (phase + '.capacity.json'), proof)
    # No inventory can establish ownership. A name collision requires a receipt,
    # never a stop, takeover, fresh name, or discovery-based resource adoption.
    need(not any(m.get('name') == 'cloudbench-source-' + args.owner_token for m in rows[APP]),
         'source name exists without original successful create authority')
    need(time.time() - started <= 60 and available >= 1, 'insufficient fresh measured capacity')
    return proof


def donor(api, args):
    machine = api.api('GET', '/machines/' + args.donor_machine_id)
    volume = api.api('GET', '/volumes/' + args.donor_volume_id)
    need(isinstance(machine, dict) and machine.get('id') == args.donor_machine_id, 'exact donor Machine required')
    need(isinstance(volume, dict) and volume.get('id') == args.donor_volume_id, 'exact donor volume required')
    config = machine.get('config')
    need(isinstance(config, dict) and config.get('mounts') == [{'volume': args.donor_volume_id, 'path': '/data'}]
         or isinstance(config, dict) and isinstance(config.get('mounts'), list) and len(config['mounts']) == 1
         and config['mounts'][0].get('volume') == args.donor_volume_id and config['mounts'][0].get('path') == '/data',
         'donor mount identity changed')
    need(machine.get('region') == volume.get('region') and re.fullmatch('[a-z]{3}', machine.get('region', '')),
         'donor region mismatch')
    need(volume.get('attached_machine_id') == args.donor_machine_id and volume.get('state') == 'created'
         and type(volume.get('size_gb')) is int and volume['size_gb'] > 0, 'donor volume not ready')
    digest = machine.get('image_ref', {}).get('digest')
    need(isinstance(digest, str) and re.fullmatch('sha256:[0-9a-f]{64}', digest), 'pinned donor image required')
    image = config.get('image')
    if not isinstance(image, str) or not image.endswith('@' + digest):
        ref = machine.get('image_ref', {})
        need(isinstance(ref.get('registry'), str) and isinstance(ref.get('repository'), str), 'pinned image reference required')
        image = ref['registry'] + '/' + ref['repository'] + '@' + digest
    env = config.get('env', {})
    need(isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()),
         'explicit donor environment required')
    snapshots = api.api('GET', '/volumes/' + args.donor_volume_id + '/snapshots')
    snapshot = SNAPSHOT(snapshots, args.snapshot_id)
    need(snapshot is not None, 'complete exact donor snapshot required')
    proofs = []
    for key, value in (config.get('metadata') or {}).items():
        parts = value.split() if isinstance(value, str) else []
        if (len(parts) == 7 and parts[3:] == [args.snapshot_id, args.donor_volume_id, args.donor_machine_id, APP]
                and re.fullmatch('[0-9a-f]{64}', parts[0]) and re.fullmatch('[0-9a-f]{64}', parts[1])
                and parts[2].isdecimal() and int(parts[2]) > 0
                and key == 'rose_cloudbench_deps_' + hashlib.sha256((parts[0] + '\0' + parts[1]).encode()).hexdigest()[:32]):
            proofs.append(dict(node_fingerprint=parts[0], python_fingerprint=parts[1], verified_at=int(parts[2])))
    need(proofs and all(p == proofs[0] for p in proofs), 'donor snapshot dependency attestation required')
    created = datetime.fromisoformat(snapshot['created_at'].replace('Z', '+00:00')).timestamp()
    need(created >= proofs[0]['verified_at'] - 60, 'snapshot predates donor dependency attestation')
    if snapshot.get('expires_at'):
        need(datetime.fromisoformat(snapshot['expires_at'].replace('Z', '+00:00')).timestamp() > time.time() + 600,
             'donor snapshot expiring')
    return dict(machine_id=machine['id'], volume_id=volume['id'], instance_id=machine.get('instance_id'),
                region=machine['region'], image=image, config_sha256=sha(config), env=env,
                snapshot=snapshot, size_gb=volume['size_gb'], dependency_proof=proofs[0])


def binding(args, api):
    return dict(app=APP, org=args.org, owner_token=args.owner_token,
        donor_machine_id=args.donor_machine_id, donor_volume_id=args.donor_volume_id,
        snapshot_id=args.snapshot_id, reserved_slots=args.reserved_slots, headroom=args.headroom,
        extra_destroying_count=args.extra_destroying_count, parked_memory=args.parked_memory,
        machines_endpoint=api.base, graphql_endpoint=api.graphql,
        reservation_root=reservation_inventory()['root'])


def validate_intent(intent):
    need(isinstance(intent, dict) and intent.get('version') == 1, 'original intent version')
    b, source = intent['binding'], intent['donor']
    need(b['app'] == APP and re.fullmatch('[0-9a-f]{32}', b['owner_token'])
         and re.fullmatch('[0-9a-f]{32}', intent['nonce'])
         and source['machine_id'] == b['donor_machine_id'] and source['volume_id'] == b['donor_volume_id']
         and source['snapshot']['id'] == b['snapshot_id'], 'original donor intent identity differs')
    expected = dict(name='cbs_' + b['owner_token'][:26], region=source['region'], size_gb=source['size_gb'],
                    snapshot_id=b['snapshot_id'], compute={'cpu_kind': 'shared', 'cpus': 1,
                    'memory_mb': b['parked_memory']}, compute_image=source['image'])
    need(intent['volume_request'] == expected, 'original volume intent differs')


def envelope(intent, value):
    return dict(version=1, intent_sha256=sha(intent), owner_token=intent['binding']['owner_token'],
                nonce=intent['nonce'], **value)


def record(journal, name, intent):
    value = read(journal / name)
    need(all(value.get(k) == v for k, v in envelope(intent, {}).items()), 'create receipt authority mismatch')
    return value


def machine_config(intent, volume_id):
    return dict(image=intent['donor']['image'], env=intent['donor']['env'],
        init={'cmd': ['sleep', 'infinity']}, guest={'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': intent['binding']['parked_memory']},
        mounts=[{'volume': volume_id, 'path': '/data'}], restart={'policy': 'no'}, auto_destroy=False,
        metadata={'cloudbench_source_protocol': 'cloudbench-source-lease-v1', 'cloudbench_source_owner': intent['binding']['owner_token'],
                  'cloudbench_source_create_nonce': intent['nonce'], 'cloudbench_source_create_intent': sha(intent)})


def verify_volume(api, intent, receipt, machine_id=None):
    vid = receipt.get('id')
    need(isinstance(vid, str) and re.fullmatch('vol_[A-Za-z0-9]+', vid) and vid not in PROTECTED_VOLUMES
         and vid != intent['donor']['volume_id'], 'invalid owned volume receipt')
    row = api.api('GET', '/volumes/' + vid)
    need(isinstance(row, dict) and row.get('id') == vid and row.get('name') == intent['volume_request']['name']
         and row.get('region') == intent['donor']['region'] and row.get('size_gb') == intent['donor']['size_gb']
         and row.get('state') == 'created' and row.get('attached_machine_id') == machine_id, 'owned volume changed or not ready')
    return row


def verify_machine(api, intent, machine, volume, successor=None):
    mid = machine.get('id')
    need(isinstance(mid, str) and re.fullmatch('[0-9a-f]{14}', mid) and mid not in PROTECTED_MACHINES
         and mid != intent['donor']['machine_id'], 'invalid owned Machine receipt')
    row = api.api('GET', '/machines/' + mid)
    if isinstance(row, dict) and isinstance(row.get('config'), dict):
        actual = json.loads(json.dumps(row))
        meta = actual['config'].get('metadata') or {}
        if meta.get('cloudbench_source_retiring') == intent['nonce']:
            del meta['cloudbench_source_retiring']
        row = actual
    need(isinstance(row, dict) and row.get('id') == mid and row.get('name') == 'cloudbench-source-' + intent['binding']['owner_token']
         and row.get('instance_id') == (successor or machine).get('instance_id') and row.get('region') == intent['donor']['region']
         and row.get('state') in ({'stopped'} if successor else {'created', 'stopped'})
         and row.get('config') == (successor['config'] if successor else machine_config(intent, volume['id']))
         and row.get('image_ref', {}).get('digest') == (successor['config']['image'] if successor else intent['donor']['image']).rsplit('@', 1)[1],
         'owned Machine changed, active, or foreign')
    verify_volume(api, intent, volume, mid)
    return row


def validate_ack(intent, kind, request, ack):
    row = ack.get('response')
    pattern = 'vol_[A-Za-z0-9]+' if kind == 'volume' else '[0-9a-f]{14}'
    protected = PROTECTED_VOLUMES if kind == 'volume' else PROTECTED_MACHINES
    need(isinstance(row, dict) and isinstance(ack.get('id'), str) and re.fullmatch(pattern, ack['id'])
         and ack['id'] == row.get('id') and ack['id'] not in protected
         and ack['id'] not in {intent['donor']['machine_id'], intent['donor']['volume_id']}
         and row.get('name') == request['name'] and row.get('region') == request['region'], 'original create ACK changed')
    if kind == 'machine':
        need(row.get('config') == request['config'] and row.get('instance_id') == ack.get('instance_id')
             and isinstance(row.get('instance_id'), str) and row['instance_id']
             and row.get('state') in {'created', 'stopped'}
             and row.get('image_ref', {}).get('digest') == intent['donor']['image'].rsplit('@', 1)[1],
             'original Machine ACK changed')
    else:
        need(row.get('size_gb') == intent['donor']['size_gb'] and not row.get('attached_machine_id'),
             'original volume ACK changed')


def authority_digest(journal):
    names = ['intent.json', 'volume.pending.json', 'volume.created.json',
             'machine.pending.json', 'machine.created.json']
    return sha({name: sha(read(journal / name)) for name in names})


def verify_created_source(receipt_path):
    """Read-only original creator authority for prepare-source bootstrap; no provider I/O.

    This proves creation, never installed dependencies or a source-volume snapshot.
    The donor dependency proof is an input for subsequent real guest attestation.
    """
    result = read(Path(receipt_path).absolute())
    journal = Path(result['journal'])
    STORAGE['plain'](journal, True)
    intent = read(journal / 'intent.json')
    validate_intent(intent)
    need(result.get('outcome') == 'ready-for-prepare' and result.get('journal_sha256') == authority_digest(journal)
         and all(result.get(k) == v for k, v in envelope(intent, {}).items()), 'original creator result seal changed')
    b = intent['binding']
    need(b['app'] == APP and re.fullmatch('[0-9a-f]{32}', b['owner_token'])
         and re.fullmatch('[0-9a-f]{32}', intent['nonce']), 'original creator identity')
    volume = record(journal, 'volume.created.json', intent)
    machine = record(journal, 'machine.created.json', intent)
    request = dict(name='cloudbench-source-' + b['owner_token'], region=intent['donor']['region'],
                   config=machine_config(intent, volume['id']), skip_launch=True)
    # ACK-present code paths perform no reads or writes through api.
    create_once(None, journal, 'volume', intent['volume_request'], intent)
    create_once(None, journal, 'machine', request, intent)
    for key in ('machine_id', 'volume_id', 'instance_id', 'machine_name', 'owner_token', 'snapshot_id',
                'donor_machine_id', 'donor_volume_id', 'app'):
        expected = dict(machine_id=machine['id'], volume_id=volume['id'], instance_id=machine['instance_id'],
            machine_name=request['name'], owner_token=b['owner_token'], snapshot_id=b['snapshot_id'],
            donor_machine_id=b['donor_machine_id'], donor_volume_id=b['donor_volume_id'], app=APP)
        need(result.get(key) == expected[key], 'creator result identity changed')
    need(not any(journal.glob('*.delete*.json')) and not (journal / 'cleanup.complete.json').exists(),
         'source cleanup already began')
    return dict(intent=intent, machine_request=request, machine=machine['response'], volume=volume['response'],
                journal=str(journal), donor=intent['donor'])


def create_once(api, journal, kind, request, intent):
    pending = journal / (kind + '.pending.json')
    ack = journal / (kind + '.created.json')
    if ack.exists():
        value = record(journal, ack.name, intent)
        expected = envelope(intent, {'request': request})
        need(read(pending) == expected and value.get('request_sha256') == sha(request), 'original writeahead changed')
        validate_ack(intent, kind, request, value)
        return value
    need(not pending.exists(), 'ambiguous create retained; never retry or adopt discovered resources')
    save(pending, envelope(intent, {'request': request}))
    # Signals may interrupt the response/ACK window. The durable pending marker
    # intentionally bars replay even when a request never reached the provider.
    proofs = sorted(journal.glob(kind + '-*.capacity.json'))
    need(proofs, 'original native capacity admission required')
    proof = read(proofs[-1])
    need(time.time() - proof['ended_epoch'] <= 60
         and proof['observed_reservations'] == reservation_inventory(), 'capacity or normal reservations changed')
    try:
        response = api.api('POST', '/volumes' if kind == 'volume' else '/machines', request)
    except Refusal as error:
        status = getattr(error, 'native_status', None)
        save(journal / (kind + '.failed.json'), envelope(intent, dict(
            outcome='native-rejected' if isinstance(status, int) and 400 <= status < 500 else 'ambiguous',
            native_http_status=status)))
        raise
    need(isinstance(response, dict), 'ambiguous create response retained')
    identity = response.get('id')
    pattern = 'vol_[A-Za-z0-9]+' if kind == 'volume' else '[0-9a-f]{14}'
    protected = PROTECTED_VOLUMES if kind == 'volume' else PROTECTED_MACHINES
    need(isinstance(identity, str) and re.fullmatch(pattern, identity) and identity not in protected
         and identity not in {intent['donor']['volume_id'], intent['donor']['machine_id']}
         and response.get('name') == request['name'] and response.get('region') == request['region'],
         'ambiguous or protected create response retained')
    if kind == 'machine':
        need(response.get('config') == request['config'] and isinstance(response.get('instance_id'), str)
             and response['instance_id'], 'ambiguous Machine ACK retained')
    value = envelope(intent, {'id': identity, 'instance_id': response.get('instance_id'), 'request_sha256': sha(request), 'response': response})
    validate_ack(intent, kind, request, value)
    save(ack, value)
    return value


def deleted_state(api, kind, identity):
    """Bounded GET-only confirmation; Fly volume deletion may be pending_destroy."""
    deadline = time.monotonic() + 20
    with DEADLINES['bounded'](20):
        while True:
            row = api.api('GET', '/' + kind + '/' + identity, absent=True)
            if row is None:
                return 'absent'
            need(isinstance(row, dict) and row.get('id') == identity, 'delete confirmation identity changed')
            terminal = {'pending_destroy', 'destroyed'} if kind == 'volumes' else {'destroyed'}
            if row.get('state') in terminal:
                need(kind != 'volumes' or not row.get('attached_machine_id'), 'deleted volume remains attached')
                return row['state']
            need(time.monotonic() < deadline, 'native deletion remains unconfirmed; no delete retry')
            time.sleep(0.2)


def retirement_successor(args, journal, intent):
    paths = [args.prepared_request, args.prepared_result, args.prepared_manifest]
    need(all(paths) or not any(paths), 'complete prepared successor receipt chain required')
    if not any(paths):
        need(not (journal / 'retirement.admission.json').exists(), 'prepared retirement authority required')
        return None
    seals = {name: dict(path=str(path.absolute()), sha256=sha(read(path.absolute())))
             for name, path in zip(('request', 'result', 'manifest'), paths)}
    receipt = journal / 'retirement.admission.json'
    if receipt.exists():
        admitted = record(journal, receipt.name, intent)
        need(admitted['inputs'] == seals, 'prepared retirement inputs changed')
        return admitted['after']
    helper = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))
    request = read(args.prepared_request.absolute())
    need('ownership' in request, 'prepared successor must derive from original create authority')
    authority = journal / 'result.json'
    descriptor = request['ownership']
    need(Path(descriptor['path']) == authority and descriptor['sha256'] == hashlib.sha256(authority.read_bytes()).hexdigest(),
         'prepared ownership does not bind original creator result')
    successor = helper['verify_prepared_source'](args.prepared_request, args.prepared_result, args.prepared_manifest,
        source_ref=request['source_ref'], image_ref=request['image_ref'],
        node_fingerprint=request['node_fingerprint'], python_fingerprint=request['python_fingerprint'])
    need(successor['owner_token'] == intent['binding']['owner_token'], 'prepared successor owner changed')
    prepared = read(args.prepared_result.absolute())
    after = helper['described'](prepared['after'])
    original = machine_config(intent, successor['volume_id'])
    original['image'] = request['image_ref']
    need(after['id'] == successor['machine_id'] and after['config'] == original
         and after['state'] == 'stopped' and after['instance_id'] == successor['instance_id'],
         'prepared retirement identity/config changed')
    save(receipt, envelope(intent, dict(inputs=seals, after=after)))
    return after


def consumer_guard(api, intent, machine_id, volume_id):
    rows = inventory(api.api('GET', '/machines'), 'consumer Machine')
    owner = intent['binding']['owner_token']
    for row in rows:
        if row['id'] == machine_id:
            continue
        config = row.get('config')
        need(isinstance(config, dict), 'full consumer config inventory required')
        metadata = config.get('metadata') or {}
        references = {owner, intent['nonce'], machine_id, volume_id}
        need(not any(isinstance(value, str) and any(ref in value.split() for ref in references) for value in metadata.values())
             and not any(mount.get('volume') == volume_id for mount in config.get('mounts', [])),
             'source consumer remains; retain exact owned source')


def execute(args, api, journal):
    bound = binding(args, api)
    intent_path = journal / 'intent.json'
    if intent_path.exists():
        intent = read(intent_path)
        need(intent.get('version') == 1 and intent.get('binding') == bound
             and re.fullmatch('[0-9a-f]{32}', intent.get('nonce', '')), 'immutable source intent differs')
    else:
        need(args.action == 'create' and not any(p.name != 'lock' for p in journal.iterdir()),
             'original intent required; orphan evidence cannot be adopted')
        source = donor(api, args)
        nonce = secrets.token_hex(16)
        intent = dict(version=1, binding=bound, nonce=nonce, donor=source,
            volume_request={'name': 'cbs_' + args.owner_token[:26], 'region': source['region'],
                'size_gb': source['size_gb'], 'snapshot_id': args.snapshot_id,
                'compute': {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': args.parked_memory},
                'compute_image': source['image']})
        save(intent_path, intent)
    validate_intent(intent)
    if (journal / 'cleanup.complete.json').exists():
        need(args.action == 'cleanup', 'source retired; original intent cannot allocate again')
        return read(journal / 'cleanup.complete.json')
    volume_ack = journal / 'volume.created.json'
    machine_ack = journal / 'machine.created.json'
    if args.action == 'cleanup':
        successor = retirement_successor(args, journal, intent)
        need(not (journal / 'machine.pending.json').exists() or machine_ack.exists(), 'ambiguous Machine create; volume retained')
        if machine_ack.exists():
            volume = record(journal, volume_ack.name, intent)
            machine = record(journal, machine_ack.name, intent)
            # Also prove original requests and response binding before deletion.
            create_once(api, journal, 'volume', intent['volume_request'], intent)
            request = dict(name='cloudbench-source-' + args.owner_token, region=intent['donor']['region'],
                           config=machine_config(intent, volume['id']), skip_launch=True)
            create_once(api, journal, 'machine', request, intent)
            if not (journal / 'machine.deleted.json').exists():
                pending_delete = journal / 'machine.delete.pending.json'
                if pending_delete.exists():
                    need(read(pending_delete) == envelope(intent, {'id': machine['id']}), 'delete authority changed')
                    deleted_state(api, 'machines', machine['id'])
                else:
                    protocol = runpy.run_path(str(HERE / 'cloudbench-source-lease.py'))
                    with protocol['Lease'](api, machine['id']) as leased:
                        protocol['retirement'](leased, args.owner_token, intent['nonce'], intent['nonce'])
                        verify_machine(leased, intent, machine, volume, successor)
                        consumer_guard(leased, intent, machine['id'], volume['id'])
                        protocol['put_metadata'](leased, protocol['RETIRING'], intent['nonce'])
                        save(journal / 'machine.delete.pending.json', envelope(intent, {'id': machine['id']}))
                        leased.api('DELETE', '/machines/' + machine['id'])
                        deleted_state(leased, 'machines', machine['id'])
                        leased.deleted = True
                confirmed = deleted_state(api, 'machines', machine['id'])
                save(journal / 'machine.deleted.json', envelope(intent, {'id': machine['id'], 'native_state': confirmed}))
        if volume_ack.exists() and not (journal / 'volume.deleted.json').exists():
            volume = create_once(api, journal, 'volume', intent['volume_request'], intent)
            pending_delete = journal / 'volume.delete.pending.json'
            if pending_delete.exists():
                need(read(pending_delete) == envelope(intent, {'id': volume['id']}), 'delete authority changed')
                deleted_state(api, 'volumes', volume['id'])
            else:
                verify_volume(api, intent, volume)
                save(journal / 'volume.delete.pending.json', envelope(intent, {'id': volume['id']}))
                api.api('DELETE', '/volumes/' + volume['id'])
            confirmed = deleted_state(api, 'volumes', volume['id'])
            save(journal / 'volume.deleted.json', envelope(intent, {'id': volume['id'], 'native_state': confirmed}))
        need(not (journal / 'volume.pending.json').exists() or volume_ack.exists(), 'ambiguous volume create retained')
        result = envelope(intent, {'outcome': 'cleaned'})
        save(journal / 'cleanup.complete.json', result)
        return result
    need(not any(journal.glob('*.delete*.json')), 'cleanup began; no create reuse')
    if machine_ack.exists():
        volume = create_once(api, journal, 'volume', intent['volume_request'], intent)
        request = dict(name='cloudbench-source-' + args.owner_token, region=intent['donor']['region'],
                       config=machine_config(intent, volume['id']), skip_launch=True)
        machine = create_once(api, journal, 'machine', request, intent)
        verify_machine(api, intent, machine, volume)
    else:
        need(not (journal / 'machine.pending.json').exists(), 'ambiguous Machine create retained')
        need(not (journal / 'volume.pending.json').exists() or volume_ack.exists(), 'ambiguous volume create retained')
        need(donor(api, args) == intent['donor'], 'donor snapshot/config/environment changed from immutable intent')
        if not volume_ack.exists():
            capacity(api, args, journal, 'volume-' + str(time.time_ns()))
            need(not any(v.get('name') == intent['volume_request']['name'] for v in inventory(api.api('GET', '/volumes'), 'volume')),
                 'volume name exists without successful original create authority')
        volume = create_once(api, journal, 'volume', intent['volume_request'], intent)
        verify_volume(api, intent, volume)
        need(donor(api, args) == intent['donor'], 'donor snapshot/config/environment changed before Machine create')
        capacity(api, args, journal, 'machine-' + str(time.time_ns()))
        request = dict(name='cloudbench-source-' + args.owner_token, region=intent['donor']['region'],
                       config=machine_config(intent, volume['id']), skip_launch=True)
        machine = create_once(api, journal, 'machine', request, intent)
        verify_machine(api, intent, machine, volume)
    return envelope(intent, dict(outcome='ready-for-prepare', app=APP, machine_id=machine['id'], volume_id=volume['id'],
        instance_id=machine['instance_id'], machine_name='cloudbench-source-' + args.owner_token,
        donor_machine_id=args.donor_machine_id, donor_volume_id=args.donor_volume_id,
        snapshot_id=args.snapshot_id, journal=str(journal), journal_sha256=authority_digest(journal),
        config_sha256=hashlib.sha256(json.dumps(machine_config(intent, volume['id']), sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        env_sha256=hashlib.sha256(json.dumps(intent['donor']['env'], sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        guest_env_sha256={k: hashlib.sha256(v.encode()).hexdigest() for k, v in intent['donor']['env'].items()
                          if k in {'AGENTS_ENV_B64', 'BACKEND_ENV_B64'}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'cleanup'])
    parser.add_argument('--journal', type=Path, required=True)
    parser.add_argument('--owner-token', required=True)
    parser.add_argument('--donor-machine-id', required=True)
    parser.add_argument('--donor-volume-id', required=True)
    parser.add_argument('--snapshot-id', required=True)
    parser.add_argument('--org', required=True)
    parser.add_argument('--reserved-slots', type=int, required=True, help='Additional prospective reservations; no native capacity credits')
    parser.add_argument('--headroom', type=int, required=True)
    parser.add_argument('--extra-destroying-count', type=int, default=1)
    parser.add_argument('--parked-memory', type=int, default=2048)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--prepared-request', type=Path)
    parser.add_argument('--prepared-result', type=Path)
    parser.add_argument('--prepared-manifest', type=Path)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    try:
        os.umask(0o077)
        need(args.action == 'cleanup' or not any((args.prepared_request, args.prepared_result, args.prepared_manifest)),
             'prepared successor applies only to retirement')
        for value, pattern in [(args.owner_token, '[0-9a-f]{32}'), (args.donor_machine_id, '[0-9a-f]{14}'),
            (args.donor_volume_id, 'vol_[A-Za-z0-9]+'), (args.snapshot_id, 'vs_[A-Za-z0-9]+'), (args.org, '[a-z0-9-]+')]:
            need(re.fullmatch(pattern, value), 'invalid source identity')
        need(args.reserved_slots >= 0 and args.headroom >= 0 and args.extra_destroying_count >= 1
             and 256 <= args.parked_memory <= 8192 and 1 <= args.timeout <= 600, 'invalid admission bound')
        journal = args.journal.absolute()
        need(journal.resolve() == journal, 'physical journal required')
        STORAGE['make_directory'](journal)
        need(journal.stat().st_uid == os.geteuid() and not journal.stat().st_mode & 0o077, 'private journal required')
        fd = os.open(journal / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            lock_state = os.fstat(fd)
            need(stat.S_ISREG(lock_state.st_mode) and lock_state.st_uid == os.geteuid()
                 and lock_state.st_nlink == 1 and not lock_state.st_mode & 0o077, 'private regular journal lock required')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def interrupted(*_):
                raise Refusal('interrupted; original writeahead retained for exact recovery')
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
                signal.signal(sig, interrupted)
            signal.alarm(args.timeout)
            result = execute(args, Native(), journal)
            if args.action == 'create':
                save(journal / 'result.json', result)
            if args.output:
                save(args.output.absolute(), result)
            print(canonical(result).decode().strip())
        finally:
            signal.alarm(0)
            os.close(fd)
        return 0
    except Refusal as error:
        print('private source create refused: ' + str(error), file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        print('private source create refused: evidence or native boundary unavailable', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
