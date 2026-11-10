#!/usr/bin/env python3
"""Create at most one independently owned, parked private source.

Requires FLY_API_TOKEN and flyctl read access. Never stages app secrets, starts
Machines, snapshots/stops donors, or retries creates. Inventory alone grants no
ownership; GET-only reconciliation requires the original writeahead authority.
Use the same --journal and arguments after interruption. A pending write without
its durable ACK is ambiguous and requires explicit GET-only reconciliation.
`cleanup` removes only positively acknowledged/reconciled parked resources, optionally
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
import math
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
LEGACY_HEAD = 'd8f1bcd128c02bb938b64323991eabd70748e175'
LEGACY_SOURCE_SHA = 'ac749cf4f4eaeb317fd5474fcc39d73171f69bd8953f3b69025a31502c3f3585'
LEGACY_JOURNAL = HERE.parent / '.context/image-preparation-forensics/live/create-source-a'
LEGACY_PINS = {
    'intent.json': 'bc5b4956bc25e0d7be884132bfff147227f11062b34f0f6f9eaecb8ab76129aa',
    'volume.pending.json': '5a4acaa77b9d81bd61ff3171134cc6a292f47985e876b77073dc9b74e3390cbd',
    'volume.failed.json': 'edb33e389820f9023c6ea63d5999faea3415f59c2456ec11ec427ac05f3279b9',
    'volume-1794264702770370112.capacity.json': 'b97bcff1c449d9ec8677938bd123ef7fbd81f7b561b0f5d7be2ef2e129f8358a'}


class Refusal(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise Refusal(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def private_payload(path):
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
    return raw


def read(path):
    return json.loads(private_payload(path), object_pairs_hook=STORAGE['unique_object'])


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

    def request(self, method, url, body=None, absent=False, headers=None, capture=None):
        request = urllib.request.Request(url, method=method, data=None if body is None else canonical(body),
            headers={'Authorization': self.auth, 'Content-Type': 'application/json', 'Accept': 'application/json', **(headers or {})})
        started = time.time()
        phase, status = 'headers', None
        try:
            with DEADLINES['bounded'](20), self.opener.open(request, timeout=20) as response:
                status = response.status
                phase = 'body'
                raw = response.read(MAX_BYTES + 1)
                need(len(raw) <= MAX_BYTES, 'native response too large')
                if capture is not None:
                    capture(raw, status, started, time.time())
                phase = 'decode'
                return json.loads(raw, object_pairs_hook=STORAGE['unique_object']) if raw.strip() else {}
        except urllib.error.HTTPError as error:
            if absent and error.code == 404:
                return None
            failure = Refusal('native HTTP request failed: status ' + str(error.code))
            failure.native_status = error.code
            failure.diagnostic = dict(exception_class=type(error).__name__, response_phase=phase,
                reason='native-http-error', started_epoch=started, failed_epoch=time.time(), elapsed_s=time.time()-started)
            raise failure from None
        except (OSError, ValueError, DEADLINES['Deadline']) as error:
            failure = Refusal('native response unavailable or malformed')
            failure.native_status = status
            failure.diagnostic = dict(exception_class=type(error).__name__, response_phase=phase,
                reason='absolute-response-deadline' if isinstance(error, DEADLINES['Deadline']) else
                       'socket-timeout' if isinstance(error, TimeoutError) else 'decode-or-transport-failure',
                started_epoch=started, failed_epoch=time.time(), elapsed_s=time.time()-started)
            raise failure from None

    def api(self, method, path, body=None, app=APP, absent=False, headers=None, capture=None):
        return self.request(method, self.base + '/v1/apps/' + app + path, body, absent, headers, capture)


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


def verify_fork_snapshot_input(api, args, intent):
    """A completed owned fork retains its pinned inputs across donor image updates.

    The new Machine still uses the original immutable image/config request.
    Only the donor's mutable image activation/version is outside this boundary;
    snapshot, dependency attestation, mount, environment and storage inputs stay
    exact. This check grants no mutation rights over the donor.
    """
    current = donor(api, args)
    original = intent['donor']
    fields = ('machine_id', 'volume_id', 'region', 'size_gb', 'env', 'snapshot', 'dependency_proof')
    need(all(current.get(key) == original.get(key) for key in fields),
         'original fork snapshot/dependency/environment input changed')


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


def normalized_config(config, intent, volume_id):
    """Only Fly's documented omitempty defaults and GET mount enrichments.

    https://github.com/superfly/fly-go/blob/main/machine_types.go
    Raw native configuration remains the receipt/preparer identity.
    """
    need(isinstance(config, dict), 'full native configuration required')
    value = json.loads(json.dumps(config))
    need('auto_destroy' not in value or value['auto_destroy'] is False, 'invalid auto_destroy default')
    value.setdefault('auto_destroy', False)
    value.setdefault('env', {})
    need(isinstance(value['env'], dict) and all(isinstance(k, str) and isinstance(v, str)
         for k, v in value['env'].items()), 'invalid environment default')
    mounts = value.get('mounts')
    need(isinstance(mounts, list) and len(mounts) == 1 and isinstance(mounts[0], dict), 'one exact mount required')
    mount = mounts[0]
    need({'volume', 'path'} <= mount.keys() <= {'volume', 'path', 'name', 'size_gb', 'encrypted'}
         and mount['volume'] == volume_id and mount['path'] == '/data', 'native mount ownership changed')
    enrichment = dict(name=intent['volume_request']['name'], size_gb=intent['donor']['size_gb'], encrypted=True)
    need(all(type(mount[k]) is type(v) and mount[k] == v for k, v in enrichment.items() if k in mount),
         'native mount metadata differs from owned Volume')
    value['mounts'] = [{'volume': volume_id, 'path': '/data'}]
    return value


def verify_volume(api, intent, receipt, machine_id=None):
    vid = receipt.get('id')
    need(isinstance(vid, str) and re.fullmatch('vol_[A-Za-z0-9]+', vid) and vid not in PROTECTED_VOLUMES
         and vid != intent['donor']['volume_id'], 'invalid owned volume receipt')
    row = api.api('GET', '/volumes/' + vid)
    need(isinstance(row, dict) and row.get('id') == vid and row.get('name') == intent['volume_request']['name']
         and row.get('region') == intent['donor']['region'] and type(row.get('size_gb')) is int
         and row.get('size_gb') == intent['donor']['size_gb']
         and row.get('state') == 'created' and row.get('encrypted') is True
         and row.get('attached_machine_id') == machine_id, 'owned volume changed or not ready')
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
         and canonical(normalized_config(row.get('config'), intent, volume['id']))
             == canonical(normalized_config(successor['config'] if successor else machine_config(intent, volume['id']), intent, volume['id']))
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
        vid = request['config']['mounts'][0]['volume']
        need(canonical(normalized_config(row.get('config'), intent, vid)) == canonical(request['config']) and row.get('instance_id') == ack.get('instance_id')
             and isinstance(row.get('instance_id'), str) and row['instance_id']
             and row.get('state') in {'created', 'stopped'}
             and row.get('image_ref', {}).get('digest') == intent['donor']['image'].rsplit('@', 1)[1],
             'original Machine ACK changed')
    else:
        need(row.get('size_gb') == intent['donor']['size_gb'] and not row.get('attached_machine_id'),
             'original volume ACK changed')


def raw_sha(path):
    return hashlib.sha256(private_payload(path)).hexdigest()


def volume_authority_path(journal):
    created, reconciled = journal / 'volume.created.json', journal / 'volume.reconciled.json'
    need(not (created.exists() and reconciled.exists()), 'conflicting original/reconciled volume authority')
    return reconciled if reconciled.exists() else created


def machine_authority_path(journal):
    created, reconciled = journal / 'machine.created.json', journal / 'machine.reconciled.json'
    need(not (created.exists() and reconciled.exists()), 'conflicting original/reconciled Machine authority')
    return reconciled if reconciled.exists() else created


def pending_value(journal, kind, request, intent):
    pending = read(journal / (kind + '.pending.json'))
    expected = envelope(intent, {'request': request})
    if 'precreate' in pending:
        descriptor = pending['precreate']
        need(set(descriptor) == {'name', 'sha256'} and re.fullmatch(kind + r'\.precreate-[0-9]+\.json', descriptor['name']),
             'original precreate descriptor required')
        path = journal / descriptor['name']
        need(raw_sha(path) == descriptor['sha256'], 'original precreate inventory changed')
        proof = record(journal, descriptor['name'], intent)
        rows = inventory(proof['volumes' if kind == 'volume' else 'machines'], 'precreate ' + kind)
        observed = proof['observed_epoch']
        pending_mtime = (journal / (kind + '.pending.json')).stat().st_mtime
        need(type(observed) in (int, float) and 0 < observed <= time.time() and math.isfinite(observed)
             and pending_mtime - 60 <= observed <= pending_mtime + 1
             and path.stat().st_mtime <= pending_mtime
             and not any(row.get('name') == request['name'] for row in rows), 'original precreate collision absence required')
        expected['precreate'] = descriptor
    need(pending == expected, 'original pending request changed')
    return pending


def reconciliation_authority(journal, intent, request):
    pending = pending_value(journal, 'volume', request, intent)
    if 'precreate' in pending:
        return dict(kind='sealed-precreate-inventory', precreate=pending['precreate'])
    # The sole legacy exception pins the actual original operation, not a flag
    # accepting an arbitrary caller's receipts or a discovered existing Volume.
    need(journal == LEGACY_JOURNAL, 'no original invocation/precreate authority')
    for name, digest in LEGACY_PINS.items():
        need(raw_sha(journal / name) == digest, 'pinned legacy operation receipt changed')
    operation_path = journal.parent / 'source-operation.json'
    log_path = journal.parent / 'create-source-a.log'
    need(raw_sha(operation_path) == '63d6a806b8cbc201c9d1fe5764d519fa99e2cd1ef3ad5b0432efb4e21d59dd10'
         and hashlib.sha256(private_payload(log_path)).hexdigest() == '6d72c1788585e597c616c70c12a051075317bd54d5e8847a7028b2e33579b570',
         'retained original invocation changed')
    operation = read(operation_path)
    need(operation['head'] == LEGACY_HEAD and operation['owner_token'] == intent['binding']['owner_token']
         and all(operation[k] == intent['binding'][k] for k in ('donor_machine_id', 'donor_volume_id', 'snapshot_id')),
         'original invocation identity differs')
    original = subprocess.check_output(['git', '--no-replace-objects', '-C', str(HERE.parent), 'show',
                                        LEGACY_HEAD + ':scripts/cloudbench-prepare-source-create.py'], timeout=20)
    need(hashlib.sha256(original).hexdigest() == LEGACY_SOURCE_SHA, 'original creator source pin differs')
    need((journal / 'volume.pending.json').stat().st_mtime_ns == 1794264708939776346
         and (journal / 'volume.failed.json').stat().st_mtime_ns == 1794264728944081406,
         'original invocation clock changed')
    return dict(kind='pinned-original-legacy-invocation', source_head=LEGACY_HEAD, source_sha256=LEGACY_SOURCE_SHA,
                operation_sha256=raw_sha(operation_path), precreate_inventory_gap=True)


def verify_reconciled(journal, intent, request, receipt):
    need(receipt.get('authority_kind') == 'reconciled-ambiguous-volume-create'
         and receipt.get('snapshot_lineage_verified') is False
         and receipt.get('snapshot_provenance') == 'original-writeahead-request'
         and receipt.get('request_sha256') == sha(request)
         and receipt.get('pending_sha256') == raw_sha(journal / 'volume.pending.json')
         and receipt.get('failure_sha256') == raw_sha(journal / 'volume.failed.json')
         and receipt.get('authority') == reconciliation_authority(journal, intent, request),
         'reconciled original operation authority changed')
    row = receipt['observed_volume']
    need(receipt['id'] == row.get('id') and receipt['inventory_sha256'] == sha(receipt['inventory'])
         and receipt['snapshot_sha256'] == sha(receipt['donor_snapshot']), 'reconciled native evidence changed')
    verify_reconciliation_row(journal, intent, request, receipt['inventory'], row, receipt['donor_snapshot'])


def verify_reconciliation_row(journal, intent, request, rows, row, snapshot):
    failed = record(journal, 'volume.failed.json', intent)
    need(failed.get('outcome') == 'ambiguous' and (failed.get('native_http_status') is None
         or failed['native_http_status'] >= 500 or 200 <= failed['native_http_status'] < 300),
         'native rejection is not ambiguous-create recovery authority')
    rows = inventory(rows, 'reconciliation Volume')
    matches = [v for v in rows if v.get('name') == request['name']]
    need(len(matches) == 1 and isinstance(row, dict)
         and all(matches[0].get(k) == row.get(k) for k in
                 ('id', 'name', 'region', 'size_gb', 'encrypted', 'created_at', 'attached_machine_id', 'attached_alloc_id'))
         and matches[0].get('state') in {'restoring', 'created'}, 'unique exact native Volume listing/detail required')
    vid = row.get('id')
    need(isinstance(vid, str) and re.fullmatch('vol_[A-Za-z0-9]+', vid)
         and vid not in PROTECTED_VOLUMES and vid != intent['donor']['volume_id']
         and row.get('name') == 'cbs_' + intent['binding']['owner_token'][:26]
         and row.get('region') == request['region'] and row.get('size_gb') == request['size_gb']
         and row.get('encrypted') is True
         and row.get('attached_machine_id') is None and row.get('attached_alloc_id') is None
         and row.get('state') in {'restoring', 'created'}, 'native Volume is foreign, attached, or invalid')
    created = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).timestamp()
    diagnostic = failed.get('diagnostic') or {}
    started = diagnostic.get('started_epoch', (journal / 'volume.pending.json').stat().st_mtime)
    ended = diagnostic.get('failed_epoch', (journal / 'volume.failed.json').stat().st_mtime)
    need(type(started) in (int, float) and type(ended) in (int, float)
         # Kernel filesystem mtimes can lag wall-clock event stamps by a tick.
         and (journal / 'volume.pending.json').stat().st_mtime - 1 <= started <= ended
         <= (journal / 'volume.failed.json').stat().st_mtime + 1
         and started <= created <= ended, 'native Volume outside original create attempt window')
    need(snapshot == intent['donor']['snapshot'] and snapshot['id'] == request['snapshot_id']
         and SNAPSHOT([snapshot], request['snapshot_id']) is not None, 'original donor snapshot proof differs')


def reconcile_volume(api, journal, intent):
    need(not any(journal.glob('machine.*.json')) and not (journal / 'cleanup.complete.json').exists()
         and not any(journal.glob('*.delete*.json')) and not (journal / 'volume.created.json').exists(),
         'reconciliation requires original ambiguous Volume only; no Machine attempt')
    request = intent['volume_request']
    authority = reconciliation_authority(journal, intent, request)
    failed = record(journal, 'volume.failed.json', intent)
    rows = inventory(api.api('GET', '/volumes'), 'reconciliation Volume')
    matches = [row for row in rows if row.get('name') == request['name']]
    need(len(matches) == 1, 'native Volume missing or duplicate')
    row = api.api('GET', '/volumes/' + matches[0]['id'])
    snapshots = api.api('GET', '/volumes/' + intent['donor']['volume_id'] + '/snapshots')
    snapshot = SNAPSHOT(snapshots, request['snapshot_id'])
    verify_reconciliation_row(journal, intent, request, rows, row, snapshot)
    path = journal / 'volume.reconciled.json'
    if path.exists():
        receipt = record(journal, path.name, intent)
        verify_reconciled(journal, intent, request, receipt)
        need(receipt['id'] == row['id'], 'original reconciled Volume changed')
        return receipt
    receipt = envelope(intent, dict(authority_kind='reconciled-ambiguous-volume-create', authority=authority,
        request_sha256=sha(request), pending_sha256=raw_sha(journal / 'volume.pending.json'),
        failure_sha256=raw_sha(journal / 'volume.failed.json'), id=row['id'], instance_id=None,
        observed_volume=row, inventory=rows, inventory_sha256=sha(rows), donor_snapshot=snapshot,
        snapshot_lineage_verified=False, snapshot_provenance='original-writeahead-request',
        snapshot_sha256=sha(snapshot), observed_epoch=time.time(), provider_writes=False))
    save(path, receipt)
    return receipt


def machine_reconciliation_authority(journal, intent, request):
    pending = pending_value(journal, 'machine', request, intent)
    if 'precreate' in pending:
        return dict(kind='sealed-precreate-inventory', precreate=pending['precreate'])
    need(journal == LEGACY_JOURNAL, 'no original Machine invocation/precreate authority')
    pins = dict(LEGACY_PINS, **{
        'machine.pending.json': '4ae0658062114f6a6e2424ebd46acf4aaf0a96701f3981bcc8b13a7f9d281c14',
        'machine-1794266845846846129.capacity.json': '967affe1904931758fd4cb2c6a633ed6df3d13fde63cc73d098f8e8a37835f8b',
        'volume.reconciled.json': '52977998cb75c282b08f85df94ea105f23b2f2a1c2f1fc1995f4e558bf074300'})
    need(all(raw_sha(journal / name) == digest for name, digest in pins.items()), 'original Machine journal changed')
    invocation = journal.parent / 'create-invocation-3.json'
    source = HERE.parent / '.context/creator-machine-reconcile/original-a60.py'
    operation = journal.parent / 'source-operation.json'
    need(raw_sha(invocation) == '660be19d5ec9539c9e1222dee65ce9b53d3fc03166e791ac8e2ed11b48e3eb25'
         and raw_sha(source) == 'a60d29aaa17e6876a3a5c125a5eb9e5b38945fc8be1529e0d6106b9283146fb3'
         and raw_sha(operation) == '63d6a806b8cbc201c9d1fe5764d519fa99e2cd1ef3ad5b0432efb4e21d59dd10'
         and read(operation)['head'] == LEGACY_HEAD
         and read(invocation)['creator_sha256'] == raw_sha(source)
         and (journal / 'machine.pending.json').stat().st_mtime_ns == 1794266849060412838,
         'retained original Machine source/invocation differs')
    return dict(kind='pinned-original-legacy-machine-invocation', source_sha256=raw_sha(source),
                invocation_sha256=raw_sha(invocation), operation_sha256=raw_sha(operation), precreate_inventory_gap=True)


def machine_request(intent, volume_id):
    return dict(name='cloudbench-source-' + intent['binding']['owner_token'], region=intent['donor']['region'],
                config=machine_config(intent, volume_id), skip_launch=True)


def machine_attempt_evidence(journal):
    names = ['machine.pending.json', volume_authority_path(journal).name]
    names += [name for name in ('machine.failed.json', 'machine.response.json', 'machine.response.raw.json')
              if (journal / name).exists()]
    return {name: raw_sha(journal / name) for name in names}


def verify_machine_reconciliation(journal, intent, request, receipt):
    need(receipt.get('authority_kind') == 'reconciled-ambiguous-machine-create'
         and receipt.get('provider_writes') is False
         and receipt.get('request_sha256') == sha(request)
         and receipt.get('pending_sha256') == raw_sha(journal / 'machine.pending.json')
         and receipt.get('volume_authority_sha256') == raw_sha(volume_authority_path(journal))
         and receipt.get('attempt_evidence') == machine_attempt_evidence(journal)
         and receipt.get('authority') == machine_reconciliation_authority(journal, intent, request),
         'reconciled Machine authority changed')
    rows, row, volume = receipt['inventory'], receipt['response'], receipt['observed_volume']
    need(receipt['inventory_sha256'] == sha(rows) and receipt['response_sha256'] == sha(row)
         and receipt['volume_sha256'] == sha(volume), 'reconciled Machine native evidence changed')
    rows = inventory(rows, 'reconciliation Machine')
    matches = [item for item in rows if item.get('name') == request['name']]
    need(len(matches) == 1 and all(matches[0].get(k) == row.get(k) for k in
         ('id', 'name', 'instance_id', 'region', 'config', 'state', 'image_ref', 'created_at')),
         'unique exact native Machine listing/detail required')
    validate_ack(intent, 'machine', request, receipt)
    if (journal / 'machine.response.json').exists():
        wire = record(journal, 'machine.response.json', intent)
        raw = private_payload(journal / 'machine.response.raw.json')
        need(wire.get('request_sha256') == sha(request) and type(wire.get('native_http_status')) is int
             and 200 <= wire['native_http_status'] < 300
             and wire.get('raw_sha256') == hashlib.sha256(raw).hexdigest(), 'original Machine wire response differs')
        original = json.loads(raw, object_pairs_hook=STORAGE['unique_object'])
        need(isinstance(original, dict), 'original native response malformed')
        validate_ack(intent, 'machine', request, dict(id=original.get('id'), instance_id=original.get('instance_id'), response=original))
        need(original['id'] == row['id'] and original['instance_id'] == row['instance_id'],
             'known native Machine response differs from reconciliation')
    vid = request['config']['mounts'][0]['volume']
    need(volume.get('id') == vid and volume.get('name') == intent['volume_request']['name']
         and volume.get('region') == intent['donor']['region'] and volume.get('state') == 'created'
         and type(volume.get('size_gb')) is int and volume['size_gb'] == intent['donor']['size_gb']
         and volume.get('encrypted') is True and volume.get('attached_machine_id') == row['id']
         and row.get('state') == 'stopped'
         and row.get('incomplete_config') is None, 'exact owned Volume attachment and stopped Machine required')
    pending = journal / 'machine.pending.json'
    ended = pending.stat().st_mtime + 20
    failure = journal / 'machine.failed.json'
    if failure.exists():
        failed = record(journal, failure.name, intent)
        status = failed.get('native_http_status')
        need(failed.get('outcome') == 'ambiguous' and (status is None or type(status) is int
             and (status >= 500 or 200 <= status < 300)), 'native Machine rejection cannot reconcile')
        ended = (failed.get('diagnostic') or {}).get('failed_epoch', failure.stat().st_mtime)
    created = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).timestamp()
    # Machine created_at has second precision; the request clock has fractions.
    need(type(ended) in (int, float) and math.isfinite(ended)
         and pending.stat().st_mtime - 1 <= created <= ended <= pending.stat().st_mtime + 21,
         'native Machine outside original POST window')


def reconcile_machine(api, journal, intent):
    need(not (journal / 'machine.created.json').exists() and not (journal / 'result.json').exists()
         and not any(journal.glob('*.delete*.json')) and not (journal / 'cleanup.complete.json').exists(),
         'Machine reconciliation requires unfinished original create')
    volume = create_once(None, journal, 'volume', intent['volume_request'], intent)
    request = machine_request(intent, volume['id'])
    authority = machine_reconciliation_authority(journal, intent, request)
    rows = inventory(api.api('GET', '/machines'), 'reconciliation Machine')
    matches = [row for row in rows if row.get('name') == request['name']]
    need(len(matches) == 1, 'native Machine missing or duplicate')
    row = api.api('GET', '/machines/' + matches[0]['id'])
    current_volume = verify_volume(api, intent, volume, matches[0]['id'])
    value = envelope(intent, dict(authority_kind='reconciled-ambiguous-machine-create', authority=authority,
        request_sha256=sha(request), pending_sha256=raw_sha(journal / 'machine.pending.json'),
        attempt_evidence=machine_attempt_evidence(journal),
        volume_authority_sha256=raw_sha(volume_authority_path(journal)), id=row.get('id'), instance_id=row.get('instance_id'),
        response=row, response_sha256=sha(row), inventory=rows, inventory_sha256=sha(rows),
        observed_volume=current_volume, volume_sha256=sha(current_volume), provider_writes=False))
    verify_machine_reconciliation(journal, intent, request, value)
    path = journal / 'machine.reconciled.json'
    if path.exists():
        original = record(journal, path.name, intent)
        verify_machine_reconciliation(journal, intent, request, original)
        need(original['response'] == row and original['observed_volume'] == current_volume,
             'reconciled Machine native observation changed')
        return original
    save(path, value)
    return value


def authority_digest(journal):
    names = ['intent.json', 'volume.pending.json', volume_authority_path(journal).name,
             'machine.pending.json', machine_authority_path(journal).name]
    if (journal / 'machine.ready.json').exists():
        names.append('machine.ready.json')
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
    volume = record(journal, volume_authority_path(journal).name, intent)
    machine = record(journal, machine_authority_path(journal).name, intent)
    request = dict(name='cloudbench-source-' + b['owner_token'], region=intent['donor']['region'],
                   config=machine_config(intent, volume['id']), skip_launch=True)
    # ACK-present code paths perform no reads or writes through api.
    create_once(None, journal, 'volume', intent['volume_request'], intent)
    create_once(None, journal, 'machine', request, intent)
    native = machine['response']
    if (journal / 'machine.ready.json').exists():
        ready = record(journal, 'machine.ready.json', intent)
        need(ready.get('machine_authority_sha256') == raw_sha(machine_authority_path(journal))
             and ready.get('request_sha256') == sha(request), 'ready native observation authority changed')
        native = ready['response']
        validate_ack(intent, 'machine', request, dict(id=machine['id'], instance_id=machine['instance_id'], response=native))
    for key in ('machine_id', 'volume_id', 'instance_id', 'machine_name', 'owner_token', 'snapshot_id',
                'donor_machine_id', 'donor_volume_id', 'app'):
        expected = dict(machine_id=machine['id'], volume_id=volume['id'], instance_id=machine['instance_id'],
            machine_name=request['name'], owner_token=b['owner_token'], snapshot_id=b['snapshot_id'],
            donor_machine_id=b['donor_machine_id'], donor_volume_id=b['donor_volume_id'], app=APP)
        need(result.get(key) == expected[key], 'creator result identity changed')
    need(not any(journal.glob('*.delete*.json')) and not (journal / 'cleanup.complete.json').exists(),
         'source cleanup already began')
    need(result.get('config_sha256') == hashlib.sha256(json.dumps(native['config'],
         sort_keys=True, separators=(',', ':')).encode()).hexdigest()
         and result.get('env_sha256') == hashlib.sha256(json.dumps(intent['donor']['env'],
         sort_keys=True, separators=(',', ':')).encode()).hexdigest(), 'creator raw native config/environment seal changed')
    return dict(intent=intent, machine_request=request, machine=native, volume=volume.get('observed_volume', volume.get('response')), volume_authority=volume.get('authority_kind', 'original-create-ack'),
                machine_authority=machine.get('authority_kind', 'original-create-ack'), journal=str(journal), donor=intent['donor'])


def create_once(api, journal, kind, request, intent):
    pending = journal / (kind + '.pending.json')
    ack = journal / (kind + '.created.json')
    if kind == 'machine' and (journal / 'machine.reconciled.json').exists():
        need(not ack.exists(), 'conflicting original/reconciled Machine authority')
        value = record(journal, 'machine.reconciled.json', intent)
        verify_machine_reconciliation(journal, intent, request, value)
        return value
    if kind == 'volume' and (journal / 'volume.reconciled.json').exists():
        need(not ack.exists(), 'conflicting original/reconciled Volume authority')
        value = record(journal, 'volume.reconciled.json', intent)
        verify_reconciled(journal, intent, request, value)
        return value
    if ack.exists():
        value = record(journal, ack.name, intent)
        pending_value(journal, kind, request, intent)
        need(value.get('request_sha256') == sha(request), 'original writeahead changed')
        validate_ack(intent, kind, request, value)
        if (journal / (kind + '.response.json')).exists():
            wire = record(journal, kind + '.response.json', intent)
            raw = private_payload(journal / (kind + '.response.raw.json'))
            need(wire.get('request_sha256') == sha(request) and type(wire.get('native_http_status')) is int
                 and 200 <= wire['native_http_status'] < 300
                 and wire.get('raw_sha256') == hashlib.sha256(raw).hexdigest()
                 and json.loads(raw, object_pairs_hook=STORAGE['unique_object']) == value['response'],
                 'original raw native response changed')
        return value
    need(not pending.exists(), 'ambiguous create retained; never retry or adopt discovered resources')
    pending_body = {'request': request}
    if kind in ('volume', 'machine'):
        precreate = sorted(journal.glob(kind + '.precreate-*.json'))
        need(precreate and time.time() - read(precreate[-1])['observed_epoch'] <= 60, 'fresh sealed precreate inventory required')
        pending_body['precreate'] = dict(name=precreate[-1].name, sha256=raw_sha(precreate[-1]))
    save(pending, envelope(intent, pending_body))
    # Signals may interrupt the response/ACK window. The durable pending marker
    # intentionally bars replay even when a request never reached the provider.
    proofs = sorted(journal.glob(kind + '-*.capacity.json'))
    need(proofs, 'original native capacity admission required')
    proof = read(proofs[-1])
    need(time.time() - proof['ended_epoch'] <= 60
         and proof['observed_reservations'] == reservation_inventory(), 'capacity or normal reservations changed')
    def capture(raw, status, started, finished):
        target = journal / (kind + '.response.raw.json')
        STORAGE['publish'](target, raw, immutable=True)
        save(journal / (kind + '.response.json'), envelope(intent, dict(request_sha256=sha(request),
            native_http_status=status, started_epoch=started, finished_epoch=finished,
            raw_sha256=hashlib.sha256(raw).hexdigest())))
    try:
        response = api.api('POST', '/volumes' if kind == 'volume' else '/machines', request, capture=capture)
    except Refusal as error:
        status = getattr(error, 'native_status', None)
        save(journal / (kind + '.failed.json'), envelope(intent, dict(
            outcome='native-rejected' if isinstance(status, int) and 400 <= status < 500 else 'ambiguous',
            native_http_status=status, diagnostic=getattr(error, 'diagnostic',
                {'exception_class': type(error).__name__, 'response_phase': 'headers',
                 'reason': 'native-http-rejection', 'failed_epoch': time.time()}))))
        raise
    need(isinstance(response, dict), 'ambiguous create response retained')
    identity = response.get('id')
    pattern = 'vol_[A-Za-z0-9]+' if kind == 'volume' else '[0-9a-f]{14}'
    protected = PROTECTED_VOLUMES if kind == 'volume' else PROTECTED_MACHINES
    need(isinstance(identity, str) and re.fullmatch(pattern, identity) and identity not in protected
         and identity not in {intent['donor']['volume_id'], intent['donor']['machine_id']}
         and response.get('name') == request['name'] and response.get('region') == request['region'],
         'ambiguous or protected create response retained')
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
    original_descriptor = dict(path=str(authority), sha256=raw_sha(authority))
    bootstrap = verify_created_source(authority)
    if Path(descriptor['path']) == authority:
        need(descriptor == original_descriptor, 'prepared ownership does not bind original creator result')
    else:
        path = Path(descriptor['path'])
        need(path.is_absolute() and path.resolve() == path and raw_sha(path) == descriptor['sha256'],
             'recovered bootstrap descriptor changed')
        recovered = read(path)
        resolver = helper.get('resolve_bootstrap_ownership')
        need(recovered.get('schema') == 'cloudbench-recovered-bootstrap-v1'
             and recovered.get('qualified') is False and recovered.get('credit_granted') is False
             and callable(resolver), 'pure recovered bootstrap authority required')
        resolved = resolver(path)
        need(resolved.get('original_creator') == original_descriptor
             and Path(resolved['journal']) == journal
             and canonical(resolved['intent']) == canonical(intent), 'recovered original creator custody changed')
        before, volume = resolved['machine'], resolved['volume']
        prior = bootstrap['machine']
        need(before.get('id') == prior['id'] and volume.get('id') == bootstrap['volume']['id']
             and before.get('name') == prior['name'] and before.get('region') == prior['region']
             and before.get('state') == 'stopped' and isinstance(before.get('instance_id'), str)
             and before['instance_id'] and volume.get('attached_machine_id') == prior['id'],
             'recovered owned resource identity changed')
        expected = json.loads(json.dumps(prior['config']))
        expected['image'] = before['config']['image']
        env_mode = before['config'].get('metadata', {}).get('cloudbench_source_guest_env_mode')
        env_hash = before['config'].get('metadata', {}).get('cloudbench_source_guest_env_capsule_sha256')
        if env_mode is not None or env_hash is not None:
            need(env_mode == 'owned-capsule-v1' and isinstance(env_hash, str)
                 and re.fullmatch('[a-f0-9]{64}', env_hash), 'recovered environment metadata changed')
            expected['metadata'].update(cloudbench_source_guest_env_mode=env_mode,
                                        cloudbench_source_guest_env_capsule_sha256=env_hash)
        need(canonical(normalized_config(before['config'], intent, volume['id']))
             == canonical(normalized_config(expected, intent, volume['id'])),
             'recovered bootstrap changed original parked configuration')
        bootstrap = resolved
    successor = helper['verify_prepared_source'](args.prepared_request, args.prepared_result, args.prepared_manifest,
        source_ref=request['source_ref'], image_ref=request['image_ref'],
        node_fingerprint=request['node_fingerprint'], python_fingerprint=request['python_fingerprint'])
    need(successor['owner_token'] == intent['binding']['owner_token']
         and successor['machine_id'] == bootstrap['machine']['id']
         and successor['volume_id'] == bootstrap['volume']['id'], 'prepared successor owner/resource changed')
    prepared = read(args.prepared_result.absolute())
    after = helper['described'](prepared['after'])
    original = json.loads(json.dumps(bootstrap['machine']['config']))
    original['image'] = request['image_ref']
    if successor.get('guest_env_mode') == 'owned-capsule-v1':
        need(request.get('guest_env_mode') == 'owned-capsule-v1'
             and request['guest_env_capsule']['sha256'] == successor['guest_env_capsule_sha256'],
             'prepared environment capsule authority changed')
        original['metadata'].update(cloudbench_source_guest_env_mode='owned-capsule-v1',
                                    cloudbench_source_guest_env_capsule_sha256=successor['guest_env_capsule_sha256'])
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
    volume_ack = volume_authority_path(journal)
    machine_ack = machine_authority_path(journal)
    if args.action == 'reconcile-volume':
        return reconcile_volume(api, journal, intent)
    if args.action == 'reconcile-machine':
        return reconcile_machine(api, journal, intent)
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
        native = verify_machine(api, intent, machine, volume)
    else:
        need(not (journal / 'machine.pending.json').exists(), 'ambiguous Machine create retained')
        need(not (journal / 'volume.pending.json').exists() or volume_ack.exists(), 'ambiguous volume create retained')
        if volume_ack.exists():
            verify_fork_snapshot_input(api, args, intent)
        else:
            need(donor(api, args) == intent['donor'], 'donor snapshot/config/environment changed from immutable intent')
        if not volume_ack.exists():
            capacity(api, args, journal, 'volume-' + str(time.time_ns()))
            rows = inventory(api.api('GET', '/volumes'), 'volume')
            need(not any(v.get('name') == intent['volume_request']['name'] for v in rows),
                 'volume name exists without successful original create authority')
            save(journal / ('volume.precreate-' + str(time.time_ns()) + '.json'),
                 envelope(intent, dict(observed_epoch=time.time(), volumes=rows)))
        volume = create_once(api, journal, 'volume', intent['volume_request'], intent)
        verify_volume(api, intent, volume)
        verify_fork_snapshot_input(api, args, intent)
        capacity(api, args, journal, 'machine-' + str(time.time_ns()))
        rows = inventory(api.api('GET', '/machines'), 'precreate Machine')
        need(not any(row.get('name') == 'cloudbench-source-' + args.owner_token for row in rows),
             'Machine name exists without successful original create authority')
        save(journal / ('machine.precreate-' + str(time.time_ns()) + '.json'),
             envelope(intent, dict(observed_epoch=time.time(), machines=rows)))
        request = dict(name='cloudbench-source-' + args.owner_token, region=intent['donor']['region'],
                       config=machine_config(intent, volume['id']), skip_launch=True)
        machine = create_once(api, journal, 'machine', request, intent)
        native = verify_machine(api, intent, machine, volume)
    ready_path = journal / 'machine.ready.json'
    if ready_path.exists():
        ready = record(journal, ready_path.name, intent)
        need(ready.get('machine_authority_sha256') == raw_sha(machine_ack)
             and ready.get('request_sha256') == sha(request)
             and all(ready['response'].get(k) == native.get(k) for k in
                     ('id', 'instance_id', 'config', 'name', 'region', 'image_ref')),
             'sealed native ready config changed')
    else:
        save(ready_path, envelope(intent, dict(machine_authority_sha256=raw_sha(machine_authority_path(journal)),
             request_sha256=sha(request), response=native)))
    return envelope(intent, dict(outcome='ready-for-prepare', app=APP, machine_id=machine['id'], volume_id=volume['id'],
        instance_id=machine['instance_id'], machine_name='cloudbench-source-' + args.owner_token,
        donor_machine_id=args.donor_machine_id, donor_volume_id=args.donor_volume_id,
        snapshot_id=args.snapshot_id, journal=str(journal), journal_sha256=authority_digest(journal),
        config_sha256=hashlib.sha256(json.dumps(native['config'], sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        env_sha256=hashlib.sha256(json.dumps(intent['donor']['env'], sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        guest_env_sha256={k: hashlib.sha256(v.encode()).hexdigest() for k, v in intent['donor']['env'].items()
                          if k in {'AGENTS_ENV_B64', 'BACKEND_ENV_B64'}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'cleanup', 'reconcile-volume', 'reconcile-machine'])
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
            public = result
            if args.action == 'reconcile-machine':
                # Full native inventories/config environments are private evidence.
                public = {key: result[key] for key in ('authority_kind', 'id', 'instance_id', 'provider_writes')}
                public.update(journal=str(journal), receipt_sha256=raw_sha(journal / 'machine.reconciled.json'))
            print(canonical(public).decode().strip())
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
