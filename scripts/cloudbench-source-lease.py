#!/usr/bin/env python3
"""Fence v2 private-source consumers and retirement using one native source lease.

A holder briefly leases and durably claims its source, releasing the native
lease BEFORE READY. Distinct reader claims coexist. The local guardian heartbeat
fences future admission. Crash, parent
exit, signal and expired native lease retain the claim. Only the normal owning
fleet's provider-teardown-verified audit can close it. No provider allocations.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import signal
import stat
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
C = runpy.run_path(str(HERE / 'cloudbench-prepare-source-create.py'))
need, read, save, canonical = C['need'], C['read'], C['save'], C['canonical']
PROTOCOL = 'cloudbench-source-lease-v1'
CLAIM_PREFIX = 'cloudbench_source_consumer_'
RETIRING = 'cloudbench_source_retiring'


class Lease:
    """Only this exact source's metadata/effects carry its native lease nonce."""
    def __init__(self, native, machine_id, wait=0):
        need(re.fullmatch('[0-9a-f]{14}', machine_id) and machine_id not in C['PROTECTED_MACHINES'], 'lease source protected or invalid')
        self.native, self.mid, self.wait = native, machine_id, wait
        self.nonce, self.expiry = None, 0
        self.prefix = '/machines/' + machine_id
        self.deleted = False

    def __enter__(self):
        deadline = time.monotonic() + self.wait
        while True:
            try:
                response = self.native.api('POST', self.prefix + '/lease', {'ttl': 180, 'description': PROTOCOL})
                break
            except C['Refusal'] as error:
                # A native 409 positively denied this lease; unlike creates,
                # bounded contention waiting has no ambiguous allocation effect.
                if getattr(error, 'native_status', None) != 409 or time.monotonic() >= deadline:
                    raise
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        self.nonce = response.get('data', {}).get('nonce')
        need(isinstance(self.nonce, str) and self.nonce, 'native source lease acknowledgement missing')
        self.expiry = time.monotonic() + 150
        return self

    def ensure(self):
        need(self.nonce and time.monotonic() + 25 < self.expiry, 'source lease lost; admission and cleanup refused')

    def renew(self):
        self.ensure()
        response = self.native.api('POST', self.prefix + '/lease', {'ttl': 180, 'description': PROTOCOL},
                                   headers={'fly-machine-lease-nonce': self.nonce})
        need(response.get('data', {}).get('nonce') == self.nonce, 'source lease renewal changed')
        self.expiry = time.monotonic() + 150

    def api(self, method, path, body=None, **kwargs):
        self.ensure()
        if method != 'GET':
            need(path == self.prefix or path.startswith(self.prefix + '/metadata/'), 'source lease effect escaped exact source')
            kwargs['headers'] = {'fly-machine-lease-nonce': self.nonce}
        return self.native.api(method, path, body, **kwargs)

    def __exit__(self, *_):
        if not self.nonce or time.monotonic() + 25 >= self.expiry:
            return
        try:
            if not self.deleted:
                # Normal source release has five seconds after its 25-second
                # closure budget; uncertain release retains native TTL protection.
                with C['DEADLINES']['bounded'](5):
                    self.native.api('DELETE', self.prefix + '/lease', headers={'fly-machine-lease-nonce': self.nonce})
        finally:
            self.nonce = None


def metadata(machine):
    config = machine.get('config')
    need(isinstance(config, dict) and isinstance(config.get('metadata'), dict), 'native source metadata missing')
    return config['metadata']


def require_protocol(machine, owner, nonce):
    meta = metadata(machine)
    need(meta.get('cloudbench_source_protocol') == PROTOCOL
         and meta.get('cloudbench_source_owner') == owner
         and meta.get('cloudbench_source_create_nonce') == nonce, 'native source protocol/owner/nonce changed')
    return meta


def validate_source(lease, manifest):
    need(manifest.get('version') == 2 and manifest.get('lease_protocol') == PROTOCOL
         and re.fullmatch('[0-9a-f]{32}', manifest.get('creation_nonce', '')), 'version2 lease-fenced source required')
    need(manifest['app'] == C['APP'] and manifest['machine_id'] == lease.mid, 'source lease identity differs')
    machine = lease.api('GET', lease.prefix)
    require_protocol(machine, manifest['owner_token'], manifest['creation_nonce'])
    need(not metadata(machine).get(RETIRING), 'source retirement fenced future admission')
    source = runpy.run_path(str(HERE / 'cloudbench-source.py'))
    shared = lease.api('GET', '/machines/' + manifest['shared_machine_id'])
    volume = lease.api('GET', '/volumes/' + manifest['volume_id'])
    snapshots = lease.api('GET', '/volumes/' + manifest['volume_id'] + '/snapshots')
    source['verify'](manifest, dict(machines=[machine, shared], volumes=[volume], snapshots=snapshots), parked_memory=2048)
    return machine


def put_metadata(lease, key, value):
    lease.api('POST', lease.prefix + '/metadata/' + key, {'value': value})
    current = lease.api('GET', lease.prefix)
    need(metadata(current).get(key) == value, 'source metadata write acknowledgement unconfirmed')


def fleet_git_common(root):
    """run-bench-fleet's GIT_COMMON_DIR, which holds both FLEET_AUDIT_ROOT and FLEET_OWNERSHIP_ROOT. A linked
    worktree's .git is a file, so <root>/.git/cloudbench-fleet-* never existed for a deploy worktree: audits
    could not be bound and a retained ownership registry was invisible (2026-11-07)."""
    dot = Path(root) / '.git'
    if dot.is_dir():
        return dot
    out = subprocess.run(['git', '-C', str(root), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                         capture_output=True, text=True, timeout=30)
    need(out.returncode == 0 and out.stdout.strip(), 'git common directory')
    return Path(out.stdout.strip())


def canonical_custody(workspace, consumer_owner, run_id, manifest_digest, parent_pid):
    root = Path(workspace)
    C['STORAGE']['plain'](root, True)
    common = fleet_git_common(root).resolve(strict=True)
    registry = common / 'cloudbench-fleet-ownership' / consumer_owner
    meta = C['STORAGE']['fields'](registry / 'meta')
    audit = common / 'cloudbench-fleet-audits' / consumer_owner
    need(meta.get('version') == '2' and meta.get('fleet_owner_token') == consumer_owner
         and meta.get('run_id') == run_id and meta.get('app') == C['APP']
         and meta.get('workspace_root') == workspace and meta.get('audit_dir') == str(audit)
         and meta.get('source_manifest_sha256') == manifest_digest and meta.get('pid') == str(parent_pid)
         and meta.get('pid_start') == identity(parent_pid).replace('linux:', 'proc-start:', 1),
         'original canonical fleet registry custody required')
    runs = Path(meta['runs_root'])
    C['STORAGE']['plain'](runs, True)
    lifecycle = runs / run_id / '_batch/lifecycle.json'
    source = runpy.run_path(str(HERE / 'cloudbench-source.py'))
    recorded = C['STORAGE']['payload'](audit / 'source-manifest.json')
    source['manifest'](recorded)
    need(hashlib.sha256(recorded).hexdigest() == manifest_digest, 'original canonical audit source binding differs')
    return dict(workspace=workspace, registry_dir=str(registry), audit_dir=str(audit), lifecycle=str(lifecycle),
                manifest_digest=manifest_digest, original_registry_sha256=hashlib.sha256(C['STORAGE']['payload'](registry / 'meta')).hexdigest())


def claim(lease, manifest, consumer_owner, run_id, claim_nonce, manifest_digest, custody):
    need(re.fullmatch('[0-9a-f]{32}', consumer_owner) and re.fullmatch('[A-Za-z0-9._-]+', run_id), 'invalid consumer owner/run')
    machine = validate_source(lease, manifest)
    key = CLAIM_PREFIX + consumer_owner
    value = canonical(dict(version=1, source_owner=manifest['owner_token'], creation_nonce=manifest['creation_nonce'],
        machine_id=manifest['machine_id'], instance_id=manifest['instance_id'], volume_id=manifest['volume_id'],
        snapshot_id=manifest['snapshot_id'], source_manifest_sha256=manifest_digest, custody=custody, consumer_owner=consumer_owner, run_id=run_id, nonce=claim_nonce)).decode().strip()
    meta = metadata(machine)
    held = {k: v for k, v in meta.items() if k.startswith(CLAIM_PREFIX)}
    for peer_key, peer_raw in held.items():
        need(re.fullmatch('[0-9a-f]{32}', peer_key[len(CLAIM_PREFIX):]) and isinstance(peer_raw, str),
             'untyped durable source consumer claim')
        peer = json.loads(peer_raw, object_pairs_hook=C['STORAGE']['unique_object'])
        need(peer.get('version') == 1 and peer.get('consumer_owner') == peer_key[len(CLAIM_PREFIX):]
             and isinstance(peer.get('run_id'), str) and re.fullmatch('[A-Za-z0-9._-]+', peer['run_id'])
             and isinstance(peer.get('nonce'), str) and re.fullmatch('[0-9a-f]{32}', peer['nonce'])
             and peer.get('source_owner') == manifest['owner_token']
             and peer.get('creation_nonce') == manifest['creation_nonce']
             and peer.get('machine_id') == manifest['machine_id'] and peer.get('instance_id') == manifest['instance_id']
             and peer.get('volume_id') == manifest['volume_id'] and peer.get('snapshot_id') == manifest['snapshot_id']
             and peer.get('source_manifest_sha256') == manifest_digest and isinstance(peer.get('custody'), dict),
             'foreign or changed durable source consumer claim')
    need(key not in held or held[key] == value, 'existing own consumer claim differs; no adoption')
    put_metadata(lease, key, value)
    return dict(key=key, value=value)


def audit_payload(path):
    C['STORAGE']['plain'](path)
    def stable(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                info.st_mode, info.st_uid, info.st_gid, info.st_nlink)
    before = path.lstat()
    need(before.st_size <= 16 * 1024 * 1024, 'bounded original audit member required')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022
             and info.st_size <= 16 * 1024 * 1024 and stable(before) == stable(info),
             'bounded stable original audit inode required')
        raw = stream.read(info.st_size + 1)
        need(len(raw) == info.st_size and stable(info) == stable(os.fstat(stream.fileno())) == stable(path.lstat()),
             'original audit member changed')
    return raw


def digest_tree(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*'), key=lambda p: str(p.relative_to(root))):
        C['STORAGE']['plain'](path, path.is_dir())
        if path.is_file() and path.name != 'source-audit':
            relative, raw = str(path.relative_to(root)).encode(), audit_payload(path)
            digest.update(len(relative).to_bytes(8, 'big')); digest.update(relative)
            digest.update(len(raw).to_bytes(8, 'big')); digest.update(raw)
    return digest.hexdigest()


def terminal_authority(proof, consumer_owner, run_id, manifest_digest, workspace, custody=None):
    need(set(proof) == {'audit_dir', 'lifecycle'}, 'normal fleet cleanup audit and lifecycle required')
    audit, lifecycle = Path(proof['audit_dir']), Path(proof['lifecycle'])
    common = fleet_git_common(Path(workspace)).resolve(strict=True)
    expected_audit = common / 'cloudbench-fleet-audits' / consumer_owner
    need(audit == expected_audit and custody is not None and custody['audit_dir'] == str(expected_audit)
         and custody['workspace'] == workspace and custody['manifest_digest'] == manifest_digest
         and lifecycle == Path(custody['lifecycle'])
         and custody['registry_dir'] == str(common / 'cloudbench-fleet-ownership' / consumer_owner)
         and re.fullmatch('[0-9a-f]{64}', custody['original_registry_sha256']),
         'original canonical source-bound fleet custody required')
    need(not Path(custody['registry_dir']).exists() and not Path(custody['registry_dir']).is_symlink(),
         'fleet ownership registry not retired')
    C['STORAGE']['plain'](audit, True)
    fields = C['STORAGE']['fields'](audit / 'meta')
    need(fields.get('fleet_owner_token') == consumer_owner and fields.get('run_id') == run_id
         and fields.get('app') == C['APP'] and fields.get('status') == 'provider-teardown-verified'
         and fields.get('workspace_root') == workspace
         and fields.get('source_manifest_sha256') == manifest_digest
         and hashlib.sha256(C['STORAGE']['payload'](audit / 'source-manifest.json')).hexdigest() == manifest_digest,
         'exact owning source-bound fleet terminal provider cleanup required')
    epoch = C['STORAGE']['payload'](audit / 'provider-teardown-verified.epoch').decode().strip()
    need(epoch.isdecimal() and 0 < int(epoch) <= time.time(), 'native fleet cleanup timestamp required')
    result = json.loads(audit_payload(lifecycle), object_pairs_hook=C['STORAGE']['unique_object'])
    need(result.get('version') == 1 and type(result.get('cleanup_verified')) is bool
         and result.get('fleet_owner_token') == consumer_owner and result.get('run_id') == run_id
         and result.get('workspace_root') == workspace and lifecycle.parent.name == '_batch',
         'exact owning fleet lifecycle cleanup required')
    local = lifecycle.parent.parent / 'teardown-ownership'
    binding = C['STORAGE']['fields'](local / 'source-audit')
    expected = digest_tree(audit)
    need(binding == {'path': str(audit), 'sha256': expected} and digest_tree(local) == expected, 'original source-audit and lifecycle ledger closure changed')
    return audit, expected, result


def cleanup_authority(proof, consumer_owner, run_id, manifest_digest, workspace, custody=None):
    audit, source_digest, lifecycle = terminal_authority(proof, consumer_owner, run_id, manifest_digest, workspace, custody)
    need(lifecycle['cleanup_verified'] is True and lifecycle.get('audit_sha256') == source_digest,
         'normal owning lifecycle cleanup required')
    return audit


def close_claim(lease, manifest, owned, proof, consumer_owner, run_id, workspace):
    value = json.loads(owned['value'])
    audit = cleanup_authority(proof, consumer_owner, run_id, value['source_manifest_sha256'], workspace, value['custody'])
    current = lease.api('GET', lease.prefix)
    require_protocol(current, manifest['owner_token'], manifest['creation_nonce'])
    if owned['key'] not in metadata(current):
        return  # Original cleanup proof above permits exact interrupted-close recovery.
    need(metadata(current).get(owned['key']) == owned['value'], 'consumer claim changed; no release authority')
    # The audit is the existing fleet's terminal cleanup authority. Native
    # references are an additional refusal guard, never a replacement for it.
    rows = C['inventory'](lease.api('GET', '/machines'), 'consumer closure Machine')
    for row in rows:
        if row['id'] == lease.mid:
            continue
        meta = (row.get('config') or {}).get('metadata') or {}
        need(not any(isinstance(v, str) and consumer_owner in v.split() for v in meta.values()),
             'consumer still has native fleet resources')
    native_by_id = {row['id']: row for row in rows}
    for path in (audit / 'by-machine-id').iterdir():
        need(re.fullmatch('[0-9a-f]{14}', path.name), 'invalid original fleet ledger Machine')
        row = native_by_id.get(path.name)
        need(row is None or row.get('id') == path.name and row.get('state') == 'destroyed',
             'original consumer Machine remains after lease expiry')
    lease.api('DELETE', lease.prefix + '/metadata/' + owned['key'])
    need(owned['key'] not in metadata(lease.api('GET', lease.prefix)), 'durable consumer claim removal unconfirmed')


def retirement(lease, owner, nonce, retiring_value):
    current = lease.api('GET', lease.prefix)
    meta = require_protocol(current, owner, nonce)
    need(not any(key.startswith(CLAIM_PREFIX) for key in meta), 'durable source consumer blocks retirement after lease expiry')
    need(meta.get(RETIRING) in (None, retiring_value), 'foreign source retirement marker')
    return current


def identity(pid):
    state = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(') ', 1)[1].split()[0]
    need(state not in {'Z', 'X', 'x'}, 'source holder or parent exited')
    return runpy.run_path(str(HERE / 'process-identity.py'))['linux_identity'](pid)


def ready_publish(path, value):
    C['STORAGE']['publish'](path, canonical(value))


def check_ready(path, owner, run_id, source_id, manifest_sha256, parent_pid, manifest_path=None):
    need(re.fullmatch('[0-9a-f]{14}', source_id) and re.fullmatch('[0-9a-f]{64}', manifest_sha256)
         and type(parent_pid) is int and parent_pid > 1, 'expected source digest/identity/parent required')
    value = read(path.absolute())
    need(value.get('source_manifest_sha256') == manifest_sha256 and value.get('source_machine_id') == source_id
         and value.get('parent_pid') == parent_pid, 'ready expected source manifest/parent binding differs')
    if manifest_path is not None:
        raw = C['STORAGE']['payload'](manifest_path.absolute())
        source = runpy.run_path(str(HERE / 'cloudbench-source.py'))['manifest'](raw)
        need(hashlib.sha256(raw).hexdigest() == manifest_sha256 and source['machine_id'] == source_id,
             'ready captured source manifest changed')
    need(value.get('protocol') == PROTOCOL and value.get('claimed') is True
         and value.get('consumer_owner') == owner and value.get('run_id') == run_id
         and value.get('native_lease_held') is False and value.get('guard_kind') == 'durable-consumer-claim'
         and type(value.get('claim_guard_deadline_monotonic')) in (float, int)
         and time.monotonic() < value['claim_guard_deadline_monotonic']
         and identity(value['holder_pid']) == value['holder_birth']
         and identity(parent_pid) == value['parent_birth'], 'live exact source lease holder required')
    return value


def hold(args):
    manifest_path = args.manifest.absolute()
    source = runpy.run_path(str(HERE / 'cloudbench-source.py'))
    manifest = source['manifest'](C['STORAGE']['payload'](manifest_path))
    manifest_digest = hashlib.sha256(C['STORAGE']['payload'](manifest_path)).hexdigest()
    journal = args.journal.absolute()
    C['STORAGE']['make_directory'](journal)
    need(not any(journal.iterdir()), 'fresh source consumer journal required')
    parent_birth = identity(args.parent_pid)
    nonce = secrets.token_hex(16)
    custody = canonical_custody(str(args.workspace.absolute()), args.consumer_owner, args.run_id, manifest_digest, args.parent_pid)
    need(journal == Path(custody['lifecycle']).parent.parent / 'source-lease', 'original run source lease journal required')
    native = C['Native']()
    ready = dict(protocol=PROTOCOL, claimed=False, source_machine_id=manifest['machine_id'],
                 consumer_owner=args.consumer_owner, run_id=args.run_id, source_manifest_sha256=manifest_digest,
                 holder_pid=os.getpid(), holder_birth=identity(os.getpid()), parent_pid=args.parent_pid,
                 parent_birth=parent_birth, claim_guard_deadline_monotonic=0, native_lease_held=False,
                 guard_kind='durable-consumer-claim')
    def interrupted(*_):
        ready.update(claimed=False, claim_guard_deadline_monotonic=0)
        if args.ready.exists():
            ready_publish(args.ready.absolute(), ready)
        raise InterruptedError('source holder interrupted; durable claim retained')
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        # All admission, including 409 contention, stays inside the existing
        # 60-second parent startup budget. The native lease ends BEFORE READY.
        with C['DEADLINES']['bounded'](55):
            with Lease(native, manifest['machine_id'], wait=50) as lease:
                owned = claim(lease, manifest, args.consumer_owner, args.run_id, nonce, manifest_digest, custody)
                save(journal / 'claim.json', dict(manifest=manifest, owned=owned, consumer_owner=args.consumer_owner,
                     run_id=args.run_id, parent_pid=args.parent_pid, parent_birth=parent_birth, workspace=str(args.workspace.absolute())))
        ready.update(claimed=True, claim_guard_deadline_monotonic=time.monotonic() + 125)
        ready_publish(args.ready.absolute(), ready)
        heartbeat = time.monotonic()
        while True:
            need(identity(args.parent_pid) == parent_birth, 'source consumer parent changed; durable claim retained')
            if args.release_proof.exists():
                ready.update(claimed=False, claim_guard_deadline_monotonic=0)
                ready_publish(args.ready.absolute(), ready)
                with C['DEADLINES']['bounded'](25):
                    with Lease(native, manifest['machine_id'], wait=20) as lease:
                        close_claim(lease, manifest, owned,
                            json.loads(audit_payload(args.release_proof.absolute()), object_pairs_hook=C['STORAGE']['unique_object']),
                            args.consumer_owner, args.run_id, str(args.workspace.absolute()))
                save(journal / 'closed.json', dict(closed=True, consumer_owner=args.consumer_owner, run_id=args.run_id))
                return
            if time.monotonic() - heartbeat >= 40:
                ready['claim_guard_deadline_monotonic'] = time.monotonic() + 125
                ready_publish(args.ready.absolute(), ready)
                heartbeat = time.monotonic()
            time.sleep(1)
    finally:
        ready.update(claimed=False, claim_guard_deadline_monotonic=0)
        if args.ready.exists():
            ready_publish(args.ready.absolute(), ready)


def recover_close(args):
    saved = read(args.journal.absolute() / 'claim.json')
    need(saved['consumer_owner'] == args.consumer_owner and saved['run_id'] == args.run_id,
         'original source consumer journal differs')
    with Lease(C['Native'](), saved['manifest']['machine_id']) as lease:
        with C['DEADLINES']['bounded'](25):
            close_claim(lease, saved['manifest'], saved['owned'], json.loads(audit_payload(args.release_proof.absolute()), object_pairs_hook=C['STORAGE']['unique_object']),
                        args.consumer_owner, args.run_id, saved['workspace'])
        save(args.journal.absolute() / 'closed.json', dict(closed=True, consumer_owner=args.consumer_owner, run_id=args.run_id))


def original_resources(audit, manifest, consumer_owner, run_id):
    machines, volumes = set(), set()
    for path in (audit / 'by-machine-id').iterdir():
        C['STORAGE']['plain'](path)
        need(re.fullmatch('[0-9a-f]{14}', path.name), 'original ledger Machine identity required')
        machines.add(path.name)
    fresh = audit / 'fresh'
    C['STORAGE']['plain'](fresh, True)
    for path in fresh.iterdir():
        fields = C['STORAGE']['fields'](path)
        need(fields.get('version') == '1' and fields.get('fleet_owner_token') == consumer_owner
             and fields.get('run_id') == run_id and fields.get('app') == C['APP']
             and fields.get('clone_name') == path.name
             # A clone whose Machine was never allocated (ambiguous create) owns only its Volume.
             and (fields.get('machine_id') in machines or fields.get('machine_id') == '')
             and re.fullmatch('vol_[A-Za-z0-9]+', fields.get('volume_id', '')), 'original fresh resource ledger differs')
        volumes.add(fields['volume_id'])
    migrations = audit / 'volume-migrations'
    if migrations.exists() or migrations.is_symlink():
        C['STORAGE']['plain'](migrations, True)
        for path in migrations.rglob('*'):
            C['STORAGE']['plain'](path, path.is_dir())
            if path.is_dir() or path.name.startswith('.migration-'):
                continue
            receipt = json.loads(audit_payload(path), object_pairs_hook=C['STORAGE']['unique_object'])
            need(set(receipt) == C['STORAGE']['RECEIPT_KEYS'] and receipt['version'] == 1
                 and receipt['fleet_owner_token'] == consumer_owner and receipt['run_id'] == run_id
                 and receipt['app'] == C['APP'] and receipt['machine_id'] in machines,
                 'original migration receipt differs')
            for key in ('old_volume_id', 'new_volume_id'):
                need(re.fullmatch('vol_[A-Za-z0-9]+', receipt[key]), 'original migration Volume identity required')
                volumes.add(receipt[key])
    need(not machines & C['PROTECTED_MACHINES'] and manifest['machine_id'] not in machines
         and not volumes & C['PROTECTED_VOLUMES'] and manifest['volume_id'] not in volumes,
         'original consumer ledger aliases protected source resources')
    return machines, volumes


def physical_observations(lease, audit, manifest, consumer_owner, run_id):
    machines, volumes = original_resources(audit, manifest, consumer_owner, run_id)
    rows = C['inventory'](lease.api('GET', '/machines'), 'recovered original Machine')
    for row in rows:
        if row['id'] == lease.mid:
            continue
        meta = (row.get('config') or {}).get('metadata') or {}
        need(not any(isinstance(v, str) and consumer_owner in v.split() for v in meta.values()),
             'recovered consumer still has native fleet resources')
    by_machine = {row['id']: row for row in rows}
    by_volume = {row['id']: row for row in C['inventory'](lease.api('GET', '/volumes'), 'recovered original Volume')}
    observed_machines, observed_volumes = {}, {}
    for mid in sorted(machines):
        row = by_machine.get(mid)
        need(row is None or row.get('state') == 'destroyed', 'original recovered Machine is not absent')
        observed_machines[mid] = 'absent' if row is None else row['state']
    for vid in sorted(volumes):
        row = by_volume.get(vid)
        # pending_destroy/destroyed are provider-terminal deletion states (billing and attachment ended).
        need(row is None or row.get('state') in ('pending_destroy', 'destroyed') and not row.get('attached_machine_id'),
             'original recovered Volume is not absent')
        observed_volumes[vid] = 'absent' if row is None else row['state']
    return dict(machines=observed_machines, volumes=observed_volumes)


def _recover_original_claim(lease, journal, saved, consumer_owner, run_id):
    manifest, owned = saved['manifest'], saved['owned']
    value = json.loads(owned['value'])
    custody = value['custody']
    need(journal == Path(custody['lifecycle']).parent.parent / 'source-lease', 'original run source lease journal required')
    proof = {key: custody[key] for key in ('audit_dir', 'lifecycle')}
    with C['DEADLINES']['bounded'](25):
        started = time.time()
        audit, source_audit_digest, _ = terminal_authority(proof, consumer_owner, run_id, value['source_manifest_sha256'],
                                   saved['workspace'], custody)
        lifecycle_path = Path(proof['lifecycle'])
        lifecycle_raw = audit_payload(lifecycle_path)
        lifecycle_sha = hashlib.sha256(lifecycle_raw).hexdigest()
        current = lease.api('GET', lease.prefix)
        require_protocol(current, manifest['owner_token'], manifest['creation_nonce'])
        need(metadata(current).get(owned['key']) in (None, owned['value']), 'original recovered source claim changed')
        observations = physical_observations(lease, audit, manifest, consumer_owner, run_id)
        binding = dict(schema='cloudbench-source-recovered-physical-closure-v1', consumer_owner=consumer_owner,
            run_id=run_id, source_manifest_sha256=value['source_manifest_sha256'], custody=custody,
            original_claim_sha256=hashlib.sha256(audit_payload(journal / 'claim.json')).hexdigest(),
            source_audit_sha256=source_audit_digest, original_lifecycle_sha256=lifecycle_sha,
            native_observations=observations, historical_task_credit=False)
        receipt_path = journal / 'recovered-physical-closure.json'
        if receipt_path.exists():
            receipt = read(receipt_path)
            need({key: receipt.get(key) for key in binding} == binding,
                 'original recovered physical closure evidence changed')
        else:
            receipt = dict(binding, producer=dict(pid=os.getpid(), birth=identity(os.getpid()),
                helper_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),
                started_epoch=started, observed_epoch=time.time())
            save(receipt_path, receipt)
        need(hashlib.sha256(audit_payload(lifecycle_path)).hexdigest() == lifecycle_sha,
             'historical lifecycle changed during physical recovery')
        if owned['key'] in metadata(current):
            lease.api('DELETE', lease.prefix + '/metadata/' + owned['key'])
            need(owned['key'] not in metadata(lease.api('GET', lease.prefix)), 'recovered claim removal unconfirmed')
        save(journal / 'recovered-close.json', dict(closed=True, consumer_owner=consumer_owner,
             run_id=run_id, physical_receipt_sha256=C['sha'](receipt), historical_task_credit=False))

    return dict(outcome='recovered-physical-closure', consumer_owner=consumer_owner, run_id=run_id,
                historical_task_credit=False)


def recovered_physical_close(args):
    """Internal exact-journal recovery; production callers use workspace discovery."""
    journal = args.journal.absolute()
    saved = read(journal / 'claim.json')
    need(saved['consumer_owner'] == args.consumer_owner and saved['run_id'] == args.run_id,
         'original source consumer journal differs')
    with Lease(C['Native'](), saved['manifest']['machine_id']) as lease:
        return _recover_original_claim(lease, journal, saved, args.consumer_owner, args.run_id)


def recover_workspace(args):
    """Discover original custody from the native claim; never guess an old runs root."""
    root = args.workspace.absolute()
    C['STORAGE']['plain'](root, True)
    common = fleet_git_common(root).resolve(strict=True)
    audit = common / 'cloudbench-fleet-audits' / args.consumer_owner
    C['STORAGE']['plain'](audit, True)
    fields = C['STORAGE']['fields'](audit / 'meta')
    run_id = fields.get('run_id', '')
    need(re.fullmatch('[A-Za-z0-9._-]+', run_id) and fields.get('fleet_owner_token') == args.consumer_owner
         and fields.get('app') == C['APP'] and fields.get('workspace_root') == str(root)
         and fields.get('status') == 'provider-teardown-verified'
         and (args.run_id is None or args.run_id == run_id), 'canonical recovered audit identity required')
    registry = common / 'cloudbench-fleet-ownership' / args.consumer_owner
    need(not registry.exists() and not registry.is_symlink(), 'original fleet registry not retired')
    raw = C['STORAGE']['payload'](audit / 'source-manifest.json')
    manifest = runpy.run_path(str(HERE / 'cloudbench-source.py'))['manifest'](raw)
    manifest_digest = hashlib.sha256(raw).hexdigest()
    need(manifest['version'] == 2 and manifest['lease_protocol'] == PROTOCOL
         and fields.get('source_manifest_sha256') == manifest_digest
         and manifest['machine_id'] not in C['PROTECTED_MACHINES'], 'canonical lease protocol source required')
    epoch = C['STORAGE']['payload'](audit / 'provider-teardown-verified.epoch').decode().strip()
    need(epoch.isdecimal() and 0 < int(epoch) <= time.time(), 'canonical recovered provider epoch required')
    native = C['Native']()
    # A confirmed absent source cannot carry a consumer or admit another reader.
    if native.api('GET', '/machines/' + manifest['machine_id'], absent=True) is None:
        native.mid = manifest['machine_id']
        with C['DEADLINES']['bounded'](25):
            physical_observations(native, audit, manifest, args.consumer_owner, run_id)
        return dict(outcome='source-absent-no-effect', consumer_owner=args.consumer_owner,
                    run_id=run_id, historical_task_credit=False)
    with Lease(native, manifest['machine_id']) as lease:
        with C['DEADLINES']['bounded'](25):
            current = lease.api('GET', lease.prefix)
            require_protocol(current, manifest['owner_token'], manifest['creation_nonce'])
            key = CLAIM_PREFIX + args.consumer_owner
            claim_value = metadata(current).get(key)
            if claim_value is None:
                physical_observations(lease, audit, manifest, args.consumer_owner, run_id)
                return dict(outcome='source-claim-absent-no-effect', consumer_owner=args.consumer_owner,
                            run_id=run_id, historical_task_credit=False)
            need(isinstance(claim_value, str), 'native original source claim malformed')
            value = json.loads(claim_value, object_pairs_hook=C['STORAGE']['unique_object'])
            custody = value['custody']
            lifecycle = Path(custody['lifecycle'])
            need(value.get('version') == 1 and value.get('consumer_owner') == args.consumer_owner
                 and value.get('run_id') == run_id and value.get('machine_id') == manifest['machine_id']
                 and value.get('source_owner') == manifest['owner_token']
                 and value.get('creation_nonce') == manifest['creation_nonce']
                 and value.get('source_manifest_sha256') == manifest_digest
                 and custody.get('workspace') == str(root) and custody.get('audit_dir') == str(audit)
                 and custody.get('registry_dir') == str(registry) and custody.get('manifest_digest') == manifest_digest
                 and lifecycle.is_absolute() and lifecycle.name == 'lifecycle.json' and lifecycle.parent.name == '_batch'
                 and lifecycle.parent.parent.name == run_id, 'native original source custody differs')
            journal = lifecycle.parent.parent / 'source-lease'
            saved = read(journal / 'claim.json')
            need(saved['consumer_owner'] == args.consumer_owner and saved['run_id'] == run_id
                 and saved['workspace'] == str(root) and saved['manifest'] == manifest
                 and saved['owned'] == {'key': key, 'value': claim_value}, 'original saved native source claim differs')
            return _recover_original_claim(lease, journal, saved, args.consumer_owner, run_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['hold', 'check', 'close', 'recover-close'])
    for name in ('manifest', 'journal', 'ready', 'release-proof', 'workspace'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--consumer-owner', required=True)
    parser.add_argument('--run-id')
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--source-id')
    parser.add_argument('--manifest-sha256')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        need(re.fullmatch('[0-9a-f]{32}', args.consumer_owner)
             and (args.action == 'recover-close' and args.workspace is not None and args.run_id is None
                  or isinstance(args.run_id, str) and re.fullmatch('[A-Za-z0-9._-]+', args.run_id)),
             'exact consumer owner/run required')
        if args.action == 'check':
            need(args.ready is not None, 'ready receipt required')
            need(args.source_id is not None and args.manifest_sha256 is not None and args.parent_pid is not None,
                 'expected captured source manifest digest, source ID and parent required')
            check_ready(args.ready, args.consumer_owner, args.run_id, args.source_id, args.manifest_sha256,
                        args.parent_pid, args.manifest)
        elif args.action == 'recover-close':
            need(args.release_proof is None and (args.journal is not None) != (args.workspace is not None),
                 'original workspace or exact journal only; no caller physical recovery overrides')
            result = recover_workspace(args) if args.workspace is not None else recovered_physical_close(args)
            print(canonical(result).decode().strip())
        elif args.action == 'close':
            need(args.journal is not None and args.release_proof is not None, 'original claim journal and cleanup proof required')
            recover_close(args)
        else:
            need(all((args.manifest, args.journal, args.ready, args.release_proof, args.workspace))
                 and args.parent_pid and args.parent_pid > 1, 'complete source holder arguments required')
            hold(args)
    except (Exception, KeyboardInterrupt):
        print('private source lease refused; any durable claim retained', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
