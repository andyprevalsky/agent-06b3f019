#!/usr/bin/env python3
"""Prepare one previously owned private fleet source, without app environment writes.

Private request -> exact leased Machine/image -> bounded guest fetch/attestation
-> stopped Volume snapshot -> existing cloudbench-source.py v1 consumer contract.
No create, delete, dependency installation, shared-donor mutation or task credit.
The coordinator supplies admission and owns any live invocation.
"""
from __future__ import annotations

import argparse
import ast
import base64
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shlex
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
SOURCE = runpy.run_path(str(HERE / 'cloudbench-source.py'))
REUSE = runpy.run_path(str(HERE / 'cloudbench-archived-machine-reuse.py'))
IO = runpy.run_path(str(HERE / 'cloudbench-disposable-controller.py'))
CAPTURE = runpy.run_path(str(HERE / 'cloudbench-original-volume-capture.py'))
REQUEST = 'cloudbench-prepare-source-request-v1'
RESULT = 'cloudbench-prepared-source-v1'
RECOVERY = 'cloudbench-recovered-bootstrap-v1'
_RESOLVING = set()
PROTECTED = frozenset({'683e47df5094d8', '811d632f2650e8'})
PROTECTED_RESOURCES = {'683e47df5094d8': 'vol_vwnym366kn7k8mmv',
                       '811d632f2650e8': 'vol_r1jde9donnx2mn9r'}
ENV_KEYS = frozenset({'AGENTS_ENV_B64', 'BACKEND_ENV_B64'})
SAFE_ENV_OBSERVER = '''def observe_guest_environment(blobs,directory,helper):
 import base64,hashlib,os,pathlib,re,subprocess
 def provider(value):
  return dict(value=value if value in ('tilion','kernel','steel','browser-use') else 'unknown',sha256=hashlib.sha256(value.encode()).hexdigest(),present=bool(value))
 observed=dict(schema='cloudbench-guest-env-observation-v1',blobs={},selectors={key:provider(os.environ.get(key,'')) for key in ('CLOUDBENCH_BROWSER_PROVIDER','CLOUDBENCH_WORKER_BROWSER_PROVIDER')},provider_contract_verified=False)
 paths={}
 for key,value in blobs.items():
  item=dict(decoded_valid=False,decoded_sha256=None,provider=provider(''),namespace_present=False,namespace_sha256=None)
  try:
   raw=base64.b64decode(re.sub(rb'[ \\t\\r\\n\\v\\f]',b'',value.encode('ascii')),validate=True)
   item.update(decoded_valid=True,decoded_sha256=hashlib.sha256(raw).hexdigest())
   path=pathlib.Path(directory)/('observed-'+key+'.private.env')
   with open(path,'xb',opener=lambda p,f:os.open(p,f,0o600)) as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
   paths[key]=path
   def field(name):
    return subprocess.check_output(['bash','-c','source "$1"; cloudbench_env_value "$2" "$3"','guest-env-observation',str(helper),str(path),name],text=True,stderr=subprocess.DEVNULL,timeout=5).strip()
   selected=field('BROWSER_PROVIDER');namespace=field('TEMPORAL_NAMESPACE')
   item.update(provider=provider(selected),namespace_present=bool(namespace),namespace_sha256=hashlib.sha256(namespace.encode()).hexdigest())
  except (ValueError,UnicodeError,subprocess.SubprocessError):pass
  observed['blobs'][key]=item
 if len(paths)==2:
  verified=subprocess.run(['bash','-c','source "$1"; cloudbench_validate_browser_provider_contract "$2" "$3" "${CLOUDBENCH_BROWSER_PROVIDER:-}" "${CLOUDBENCH_WORKER_BROWSER_PROVIDER:-}"','guest-env-contract',str(helper),str(paths['AGENTS_ENV_B64']),str(paths['BACKEND_ENV_B64'])],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
  observed['provider_contract_verified']=verified.returncode==0
 return observed
'''
IMAGE_INPUTS = ('Dockerfile.cloudbench-warm', 'fly.cloudbench-warm.toml', '.dockerignore',
                'package.json', 'package-lock.json', '.npmrc', 'back-end/package.json',
                'back-end/package-lock.json', 'back-end/prisma', 'front-end', 'agents/package.json',
                'agents/requirements.txt', 'agents/vendor', 'scripts/cloudbench-install-image-deps.sh',
                'scripts/cloudbench-install-ngrok.sh', 'scripts/cloudbench-install-pgvector.sh')
DEPENDENCIES = ('cloudbench-source.py', 'cloudbench-volume-migration.py', 'cloudbench-machine-readiness.py',
                'cloudbench-select-snapshot.py', 'cloudbench-archived-machine-reuse.py',
                'cloudbench-archived-reuse-effects.py', 'cloudbench-original600-runner.py',
                'cloudbench-original-volume-capture.py', 'cloudbench-disposable-controller.py',
                'cloudbench-prepare-source-create.py', 'process-identity.py', 'cloudbench-source-env.py')
OWNED_MODE='owned-capsule-v1'
OWNED_FIELDS={'guest_env_mode','guest_env_capsule_sha256','guest_env_capsule_binding'}


def dependency_seals():
    return {member: sha((HERE / member).read_bytes()) for member in DEPENDENCIES}


def need(value, reason):
    if not value:
        raise ValueError('private source preparation: ' + reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    return json.loads(IO['read'](Path(path)), object_pairs_hook=SOURCE['storage']['unique_object'])


def save(path, value):
    IO['save'](Path(path), value)


def descriptor(path):
    path = Path(path).absolute()
    return dict(path=str(path), sha256=sha(IO['read'](path)))


def described(value):
    raw = IO['read'](Path(value['path']))
    need(sha(raw) == value['sha256'], 'input digest changed')
    return json.loads(raw, object_pairs_hook=SOURCE['storage']['unique_object'])


def resolve_bootstrap_ownership(path):
    """Resolve original creation or an independently sealed, credit-free recovery."""
    if load(path).get('schema') == RECOVERY:
        key=str(Path(path).absolute())
        need(key not in _RESOLVING and len(_RESOLVING)<8, 'cyclic/excessive bootstrap recovery chain')
        _RESOLVING.add(key)
        try:return verify_recovered_bootstrap(path)
        finally:_RESOLVING.remove(key)
    return runpy.run_path(str(HERE / 'cloudbench-prepare-source-create.py'))['verify_created_source'](Path(path))


def allowed_call(method, path, mid, vid, shared=()):
    if method == 'GET':
        return path in ({'/machines/' + identity for identity in (mid, *shared)}
                        | {'/volumes/' + vid, '/volumes/' + vid + '/snapshots'})
    if method == 'POST':
        return path in {'/machines/' + mid, '/machines/' + mid + '/lease',
                        '/machines/' + mid + '/start', '/machines/' + mid + '/stop',
                        '/machines/' + mid + '/exec', '/volumes/' + vid + '/snapshots'}
    return method == 'DELETE' and path == '/machines/' + mid + '/lease'


def verify_scope(rows, mid, vid, shared=()):
    need(rows and all(allowed_call(row['method'], row['path'], mid, vid, shared)
                      for row in rows), 'native journal escaped exact scope')


def source_bytes(root, ref, member):
    return subprocess.check_output(['git', '--no-replace-objects', '-C', str(root),
                                    'show', ref + ':scripts/' + member], timeout=20)


def owned_manifest(request,predecessor):
    return dict(version=2,lease_protocol='cloudbench-source-lease-v1',owner_token=predecessor['owner_token'],
        creation_nonce=predecessor['creation_nonce'],image_digest=request['image_ref'].rsplit('@',1)[1],
        node_fingerprint=request['node_fingerprint'],python_fingerprint=request['python_fingerprint'],
        guest_env_sha256=request['guest_env_sha256'],guest_env_mode=OWNED_MODE,
        guest_env_capsule_sha256=request['guest_env_capsule']['sha256'],
        guest_env_capsule_binding=dict(owner_token=predecessor['owner_token'],create_nonce=predecessor['creation_nonce'],
            source_ref=request['source_ref'],image_ref=request['image_ref'],node_fingerprint=request['node_fingerprint'],
            python_fingerprint=request['python_fingerprint']))


def capsule_metadata(config,request):
    value=copy.deepcopy(config)
    if request.get('guest_env_mode')==OWNED_MODE:
        value['metadata']=dict(value['metadata'],cloudbench_source_guest_env_mode=OWNED_MODE,
                              cloudbench_source_guest_env_capsule_sha256=request['guest_env_capsule']['sha256'])
    return value


def read_request(path):
    value = load(path)
    need(value.get('schema') == REQUEST, 'request schema')
    fields = {'schema', 'nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'image_ref',
              'source_root', 'native', 'guest_env_sha256', 'protected_resources', 'scripts', 'build'}
    base_fields = set(value) - {'transport', 'guest_transport', 'guest_env_mode', 'guest_env_capsule'}
    if 'guest_env_mode' in value or 'guest_env_capsule' in value:
        need(value.get('guest_env_mode')==OWNED_MODE and isinstance(value.get('guest_env_capsule'),dict), 'owned capsule request pair')
        need(value.get('guest_transport')=='cloudbench-ssh-guest-v1','owned capsule requires typed SSH transport')
    need(value.get('guest_transport', 'native-exec-v1') in ('native-exec-v1','cloudbench-ssh-guest-v1'),
         'unsupported guest execution transport')
    need(base_fields == fields | {'ownership'}, 'fresh unpublished creator authority required; published sources are immutable')
    for key, pattern in [('nonce', '[a-f0-9]{32}'), ('source_ref', '[a-f0-9]{40}'),
                         ('node_fingerprint', '[a-f0-9]{64}'), ('python_fingerprint', '[a-f0-9]{64}')]:
        need(isinstance(value.get(key), str) and re.fullmatch(pattern, value[key]), key)
    need(isinstance(value.get('guest_env_sha256'), dict) and set(value['guest_env_sha256']) == ENV_KEYS
         and all(isinstance(item, str) and re.fullmatch('[a-f0-9]{64}', item)
                 for item in value['guest_env_sha256'].values()), 'expected effective guest environment hashes')
    need(re.fullmatch(r'registry\.fly\.io/navi-whisper-lux-bench[^\s]*@sha256:[a-f0-9]{64}',
                      value.get('image_ref', '')), 'immutable app image')
    if 'ownership' in value:
        described(value['ownership'])
        authority = resolve_bootstrap_ownership(Path(value['ownership']['path']))
        machine, donor = authority['machine'], authority['donor']
        metadata=machine['config'].get('metadata',{})
        if 'cloudbench_source_guest_env_mode' in metadata or 'cloudbench_source_guest_env_capsule_sha256' in metadata:
            need(metadata.get('cloudbench_source_guest_env_mode')==OWNED_MODE
                 and re.fullmatch('[a-f0-9]{64}',metadata.get('cloudbench_source_guest_env_capsule_sha256',''))
                 and value.get('guest_env_mode')==OWNED_MODE,'existing owned environment cannot downgrade to ambient')
        proof = donor['dependency_proof']
        need(machine['config']['metadata'].get('cloudbench_source_protocol') == 'cloudbench-source-lease-v1'
             and machine['config']['metadata'].get('cloudbench_source_create_nonce') == authority['intent']['nonce'],
             'versioned native source lease protocol required')
        predecessor = dict(version=2, lease_protocol='cloudbench-source-lease-v1', creation_nonce=authority['intent']['nonce'],
                           guest_env_sha256=copy.deepcopy(value['guest_env_sha256']),
                           app='navi-whisper-lux-bench', owner_token=authority['intent']['binding']['owner_token'],
                           machine_id=machine['id'], instance_id=machine['instance_id'], machine_name=machine['name'],
                           volume_id=authority['volume']['id'], region=machine['region'],
                           image_digest=machine['config']['image'].rsplit('@', 1)[1], snapshot_id=donor['snapshot']['id'],
                           node_fingerprint=proof['node_fingerprint'], python_fingerprint=proof['python_fingerprint'],
                           verified_at=proof['verified_at'], shared_machine_id=donor['machine_id'], shared_volume_id=donor['volume_id'])
        SOURCE['manifest'](canonical(predecessor))
    else:
        predecessor = SOURCE['manifest'](canonical(described(value['predecessor'])))
    if value.get('guest_env_mode')==OWNED_MODE:
        module=runpy.run_path(str(HERE/'cloudbench-source-env.py'))
        raw=module['descriptor'](value['guest_env_capsule'],private=True)
        module['validate_capsule'](raw,owned_manifest(value,predecessor),value['source_ref'])
    native = value['native']
    need(set(native) == {'machine_id', 'volume_id', 'instance_id', 'config_sha256', 'env_sha256'}, 'native fields')
    protected = value['protected_resources']
    need(protected == PROTECTED_RESOURCES, 'exact protected Machine/Volume bindings required')
    need(native['machine_id'] == predecessor['machine_id'] and native['volume_id'] == predecessor['volume_id']
         and native['instance_id'] == predecessor['instance_id'], 'predecessor native binding')
    need(native['machine_id'] not in PROTECTED
         and native['machine_id'] != predecessor['shared_machine_id']
         and native['volume_id'] not in set(protected.values()) | {predecessor['shared_volume_id']},
         'protected native resource')
    for key in ('config_sha256', 'env_sha256'):
        need(re.fullmatch('[a-f0-9]{64}', native[key]), key)
    build = described(value['build'])
    need(build.get('schema') == 'cloudbench-image-build-v1'
         and build.get('image_ref') == value['image_ref']
         and build.get('published_image_ref', build.get('image_ref')) == value['image_ref']
         and build.get('source_dirty') is False
         and re.fullmatch('[a-f0-9]{40}', build.get('source_sha', '')), 'published clean image receipt')
    root = Path(value['source_root'])
    need(root.is_absolute() and root.resolve(strict=True) == root, 'physical source root')
    effective_ref = value['source_ref']
    if 'transport' in value:
        transport = value['transport']
        need(set(transport) == {'sealed_at', 'token', 'source', 'workspace_root', 'base_sha',
                               'workspace_patch_sha256', 'patch', 'replayed_tree'}
             and transport['token'] == value['nonce'] and transport['source']['head'] == value['source_ref']
             and transport['workspace_root'] == str(root)
             and re.fullmatch('[a-f0-9]{40}', transport['base_sha'])
             and re.fullmatch('[a-f0-9]{40}', transport['replayed_tree']), 'existing source transport binding')
        if transport['workspace_patch_sha256'] == 'none':
            need(not transport['patch'], 'unexpected patch path')
        else:
            need(re.fullmatch('[a-f0-9]{64}', transport['workspace_patch_sha256'])
                 and sha(IO['read'](Path(transport['patch']))) == transport['workspace_patch_sha256'], 'source patch bytes')
        with tempfile.TemporaryDirectory(prefix='cloudbench-source-replay-') as temporary:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
            git = ['git', '--no-replace-objects', '-C', str(root)]
            subprocess.run(git + ['read-tree', transport['base_sha']], env=env, check=True, timeout=20)
            if transport['workspace_patch_sha256'] != 'none':
                subprocess.run(git + ['apply', '--cached', '--binary', transport['patch']], env=env, check=True, timeout=20,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            replayed = subprocess.check_output(git + ['write-tree'], env=env, text=True, timeout=20).strip()
            need(replayed == transport['replayed_tree'], 'source transport reconstructed tree differs')
        effective_ref = transport['replayed_tree']
    def image_inputs(ref):
        return subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'ls-tree',
                                        '-r', '--full-tree', ref, '--', *IMAGE_INPUTS], timeout=20)
    need(image_inputs(effective_ref) == image_inputs(build['source_sha']), 'image input closure differs from source')
    members = {'cloudbench-fetch-ref.sh', 'lib/cloudbench-env.sh', 'cloudbench-sync-deps.sh'} | ({'cloudbench-prepare-patch.sh'} if 'transport' in value else set())
    if value.get('guest_env_mode')==OWNED_MODE:members.add('cloudbench-source-env.py')
    need(set(value['scripts']) == members, 'pinned script fields')
    for member in members:
        need(sha(source_bytes(root, effective_ref, member)) == value['scripts'][member],
             'pinned source member')
    return value, predecessor


def verify_guest(request, guest):
    need(guest.get('schema') == 'cloudbench-source-guest-v1' and guest.get('guest_exit') == 0,
         'guest terminal result')
    for key in ('nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'guest_env_sha256'):
        need(guest.get(key) == request[key], 'observed guest ' + key)
    if request.get('guest_env_mode')==OWNED_MODE:
        authority=resolve_bootstrap_ownership(request['ownership']['path'])
        expected=owned_manifest(request,dict(owner_token=authority['intent']['binding']['owner_token'],creation_nonce=authority['intent']['nonce']))
        need(all(guest.get(key)==expected[key] for key in OWNED_FIELDS),'observed owned capsule binding')
    else:need(not OWNED_FIELDS & set(guest),'unexpected owned guest attestation')
    need(guest.get('machine_id') == request['native']['machine_id'] and guest.get('mount') == '/data',
         'guest native mount/identity')
    if 'transport' in request:
        need(guest.get('transport') == {key: request['transport'][key] for key in ('base_sha', 'workspace_patch_sha256', 'replayed_tree')},
             'observed reconstructed source transport')
    need(guest.get('installed_node') == request['node_fingerprint']
         and guest.get('installed_python') == request['python_fingerprint'], 'installed dependency markers')
    need(guest.get('image_node_fingerprint') == request['node_fingerprint']
         and guest.get('image_python_fingerprint') == request['python_fingerprint'], 'observed matching image dependency set')
    need(type(guest.get('started_epoch')) is int and type(guest.get('finished_epoch')) is int
         and guest['started_epoch'] <= guest['finished_epoch'], 'guest chronology')
    job = guest['job']
    need(type(job['pid']) is int and job['pid'] > 1 and re.fullmatch('[0-9]+', job['birth'])
         and re.fullmatch('[a-f0-9-]{36}', job['boot']), 'guest job process birth')


class ScopedNative(REUSE['NativeAdapter']):
    """Use main's bounded child transport, restricting every wire call before launch."""
    def __init__(self, api, journal, request, predecessor):
        super().__init__(api, journal)
        self.mid = request['native']['machine_id']
        self.vid = request['native']['volume_id']
        self.shared = (predecessor['shared_machine_id'],)
        self.lost = False
        self.on_failure = None
        self.lease_version = None
        self.target_version = None
        need(self.mid not in PROTECTED and self.vid not in request['protected_resources'].values(), 'protected native scope')

    def wire(self, method, url, body=None, timeout=30, headers=None, *, direct=False):
        need(allowed_call(method, url, self.mid, self.vid, self.shared), 'native call outside owned scope')
        return super().wire(method, url, body, timeout, headers, direct=direct)

    def renew(self):
        need(not self.lost and self.nonce and time.monotonic() + 30 < self.lease_end,
             'exclusive native lease lost')
        try:
            response = self._lease_wire('POST', '/machines/' + self.mid + '/lease',
                                        {'ttl': 180, 'description': 'private source preparation'},
                                        {'fly-machine-lease-nonce': self.nonce})
            need(response.get('data', {}).get('nonce') == self.nonce, 'renewal nonce changed')
            need(response.get('data', {}).get('version') == self.target_version and self.target_version,
                 'renewal did not bind acknowledged native version')
            self.lease_version = self.target_version
            self.lease_end = time.monotonic() + 150
        except BaseException:
            self.lost = True
            raise

    def request(self, method, url, body=None, *, timeout=20, direct=False):
        if self.nonce and time.monotonic() + timeout + 55 >= self.lease_end:
            self.renew()
        if method == 'POST' and url in ('/machines/' + self.mid + '/start', '/machines/' + self.mid + '/exec'):
            need(self.lease_version == self.target_version and self.target_version, 'START/EXEC lease version is stale')
        if method == 'POST' and url == '/machines/' + self.mid and self.lease_version != body.get('current_version'):
            self.bind_version(body['current_version'])
        result = super().request(method, url, body, timeout=timeout, direct=direct)
        if method == 'POST' and url == '/machines/' + self.mid:
            self.target_version = result.get('instance_id')
        return result

    def bind_version(self, instance):
        need(isinstance(instance, str) and instance, 'known native version required')
        self.target_version = instance
        self.renew()  # SAME nonce; no release/reacquire window and no EXEC retry.

    @contextmanager
    def lease(self):
        response = self._lease_wire('POST', '/machines/' + self.mid + '/lease',
                                    {'ttl': 180, 'description': 'private source preparation'})
        self.nonce = response.get('data', {}).get('nonce')
        need(isinstance(self.nonce, str) and self.nonce, 'lease nonce absent')
        self.lease_version = response.get('data', {}).get('version')
        need(isinstance(self.lease_version, str) and self.lease_version, 'lease native version absent')
        self.target_version = self.lease_version
        self.lease_end = time.monotonic() + 150
        try:
            yield
        except BaseException:
            if self.on_failure is not None and not self.lost and time.monotonic() + 45 < self.lease_end:
                self.on_failure()
            raise
        finally:
            if not self.lost and time.monotonic() + 30 < self.lease_end:
                self._lease_wire('DELETE', '/machines/' + self.mid + '/lease',
                                 headers={'fly-machine-lease-nonce': self.nonce})
                self.nonce = None
            else:
                need(False, 'lease release unresolved; no successor publication')


def exact_machine(api, request, predecessor, config, *, state=None, instance=None, observation=None):
    value = observation if observation is not None else api.request('GET', '/machines/' + request['native']['machine_id'])
    need(value.get('id') == predecessor['machine_id'] and value.get('name') == predecessor['machine_name']
         and value.get('region') == predecessor['region'] and value.get('instance_id')
         and value.get('config') == config, 'native source identity/config changed')
    need(state is None or value.get('state') == state, 'native source state')
    need(instance is None or value['instance_id'] == instance, 'native source incarnation changed')
    volume = api.request('GET', '/volumes/' + predecessor['volume_id'])
    need(volume.get('id') == predecessor['volume_id'] and volume.get('region') == predecessor['region']
         and volume.get('attached_machine_id') == predecessor['machine_id']
         and volume.get('state') in SOURCE['readiness'].__globals__['MOUNTABLE_VOLUME_STATES'],
         'exact attached source Volume')
    need(request.get('guest_env_mode') != OWNED_MODE or volume.get('encrypted') is True,
         'owned capsule requires encrypted source Volume')
    return value, volume


def wait_state(api, request, predecessor, config, state, instance, deadline, *, prior=None):
    while time.monotonic() < deadline:
        observed_config, observed_instance = config, instance
        row = None
        if prior is not None:
            # A known CAS may still expose its exact predecessor during replacement.
            # This exception is scoped to the acknowledged update, never admission.
            row = api.request('GET', '/machines/' + request['native']['machine_id'])
            if row.get('instance_id') == prior['instance_id'] and row.get('config') == prior['config']:
                need(row.get('state') in ('replacing', 'created', 'stopped'), 'invalid predecessor transition state')
                observed_config, observed_instance = prior['config'], prior['instance_id']
            else:
                need(row.get('instance_id') == instance and row.get('config') == config,
                     'unknown native replacement epoch/config')
        machine, volume = exact_machine(api, request, predecessor, observed_config, instance=observed_instance, observation=row)
        if machine.get('state') == state and machine['instance_id'] == instance and machine['config'] == config:
            if prior is not None:
                api.bind_version(instance)
            return machine, volume
        time.sleep(1)
    raise ValueError('private source preparation: native state deadline')


def guest_program(request):
    """Only the pinned main fetch script changes checkout; dependency trees are observed."""
    effective_ref = request.get('transport', {}).get('replayed_tree', request['source_ref'])
    files = {member: base64.b64encode(source_bytes(Path(request['source_root']), effective_ref, member)).decode()
             for member in request['scripts']}
    if 'transport' in request and request['transport']['workspace_patch_sha256'] != 'none':
        files['workspace.diff'] = base64.b64encode(IO['read'](Path(request['transport']['patch']))).decode()
    minimal = {key: request[key] for key in ('nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'guest_env_sha256')}
    minimal['machine_id'] = request['native']['machine_id']
    minimal['transport'] = request.get('transport')
    minimal['owned_manifest']=None
    if request.get('guest_env_mode')==OWNED_MODE:
        authority=resolve_bootstrap_ownership(request['ownership']['path'])
        minimal['owned_manifest']=owned_manifest(request,dict(owner_token=authority['intent']['binding']['owner_token'],
                                                            creation_nonce=authority['intent']['nonce']))
    return '''import base64,hashlib,json,os,pathlib,subprocess,time
r=REQUEST
directory=pathlib.Path('/tmp/cloudbench-prepare-source-'+r['nonce'])
directory.mkdir(mode=0o700)
def save(name,value):
 with open(directory/name,'x') as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
started=int(time.time())
job=dict(pid=os.getpid(),birth=pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19],boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
OBSERVATION_CODE
phase='preconditions'
preconditions=dict(euid=os.geteuid(),machine_id=os.environ.get('FLY_MACHINE_ID',''),data_mount=os.path.ismount('/data'),repo_physical=str(pathlib.Path('/data/repo').resolve()),git_dir=pathlib.Path('/data/repo/.git').is_dir(),env_present={k:bool(os.environ.get(k)) for k in r['guest_env_sha256']},guest_env_sha256={k:hashlib.sha256(os.environ.get(k,'').encode()).hexdigest() for k in r['guest_env_sha256']})
try:
 assert os.geteuid()==0 and os.environ['FLY_MACHINE_ID']==r['machine_id']
 assert os.path.ismount('/data') and pathlib.Path('/data/repo').resolve()==pathlib.Path('/data/repo')
 assert pathlib.Path('/data/repo/.git').is_dir()
 for name,raw in FILES.items():
  p=directory/name;p.parent.mkdir(mode=0o700,exist_ok=True);p.write_bytes(base64.b64decode(raw))
 capsule_attestation=None
 if r['owned_manifest'] is not None:
  import runpy,stat
  module=runpy.run_path(str(directory/'cloudbench-source-env.py'))
  manifest=r['owned_manifest'];root=pathlib.Path('/data/.cloudbench-private/env')
  for parent in (root.parent,root):
   info=parent.lstat();assert stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700
  raw=module['read_regular'](str(root/(manifest['guest_env_capsule_sha256']+'.json')),uid=0,mode=0o600)
  capsule=module['validate_capsule'](raw,manifest,r['source_ref'])
  os.environ.update(module['effective_env'](capsule,os.environ))
  capsule_attestation={key:manifest[key] for key in ('guest_env_mode','guest_env_capsule_sha256','guest_env_capsule_binding')}
  preconditions['env_present']={k:bool(os.environ.get(k)) for k in r['guest_env_sha256']}
  preconditions['guest_env_sha256']={k:hashlib.sha256(os.environ.get(k,'').encode()).hexdigest() for k in r['guest_env_sha256']}
 preconditions['environment_contract']=observe_guest_environment({k:os.environ.get(k,'') for k in r['guest_env_sha256']},directory,directory/'lib/cloudbench-env.sh')
 env={k:os.environ[k] for k in ('PATH','HOME','GITHUB_TOKEN','AGENTS_ENV_B64','BACKEND_ENV_B64','FLY_MACHINE_ID') if k in os.environ}
 assert all(env.get(k) and hashlib.sha256(env[k].encode()).hexdigest()==v for k,v in r['guest_env_sha256'].items())
 assert preconditions['environment_contract']['provider_contract_verified']
 phase='fetch'
 # Use the existing inherited app credential in a process environment, never argv.
 if not env.get('CLOUDBENCH_GITHUB_TOKEN_B64') and env.get('GITHUB_TOKEN'):
  env['CLOUDBENCH_GITHUB_TOKEN_B64']=base64.b64encode(env['GITHUB_TOKEN'].encode()).decode()
 with open(directory/'fetch.private.log','x') as log:
  fetch_ref=r['transport']['base_sha'] if r['transport'] else r['source_ref']
  subprocess.run(['bash',str(directory/'cloudbench-fetch-ref.sh'),'/data/repo',fetch_ref],env=env,stdout=log,stderr=log,check=True,timeout=300)
 ref=subprocess.check_output(['git','-c','safe.directory=/data/repo','-C','/data/repo','rev-parse','HEAD'],text=True).strip()
 transport=None
 phase='source-transport'
 if r['transport']:
  t=r['transport'];assert ref==t['base_sha']
  git=['git','-c','safe.directory=/data/repo','-C','/data/repo']
  if t['workspace_patch_sha256']!='none':
   patch=directory/'workspace.diff';assert hashlib.sha256(patch.read_bytes()).hexdigest()==t['workspace_patch_sha256']
   env.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0='/data/repo')
   subprocess.run(['bash',str(directory/'cloudbench-prepare-patch.sh'),'/data/repo',str(patch)],env=env,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   subprocess.run(git+['apply','--check',str(patch)],env=env,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   subprocess.run(git+['apply',str(patch)],env=env,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  env['GIT_INDEX_FILE']=str(directory/'verify.index')
  subprocess.run(git+['read-tree',t['base_sha']],env=env,check=True,timeout=60)
  subprocess.run(git+['add','--all','--','.',':(exclude)agents/benchmarks/history/*.jsonl'],env=env,check=True,timeout=60)
  tree=subprocess.check_output(git+['write-tree'],env=env,text=True,timeout=60).strip();assert tree==t['replayed_tree']
  transport={k:t[k] for k in ('base_sha','workspace_patch_sha256','replayed_tree')}
  ref=r['source_ref']
 cmd='source '+str(directory/'lib/cloudbench-env.sh')+'; cloudbench_node_dependency_fingerprint /data/repo; cloudbench_manifest_fingerprint /data/repo "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"'
 fps=subprocess.check_output(['bash','-euc',cmd],text=True).splitlines()
 phase='dependencies'
 assert fps==[r['node_fingerprint'],r['python_fingerprint']]
 image_cmd='source '+str(directory/'lib/cloudbench-env.sh')+'; cloudbench_node_dependency_fingerprint /app; cloudbench_manifest_fingerprint /app "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"'
 image_fps=subprocess.check_output(['bash','-euc',image_cmd],text=True).splitlines();assert image_fps==fps
 # Persist the normal matching-image copy on the private Volume. An ephemeral
 # overlay would disappear before snapshot, and online rebuild is forbidden.
 env.update(CLOUDBENCH_REBUILD_DEPS='0',CLOUDBENCH_DEPENDENCY_OVERLAY='0',CLOUDBENCH_ENV_HELPER=str(directory/'lib/cloudbench-env.sh'))
 with open(directory/'sync-deps.private.log','x') as log:
  subprocess.run(['bash',str(directory/'cloudbench-sync-deps.sh'),'/app','/data/repo'],env=env,stdout=log,stderr=log,check=True,timeout=1800)
 observed=dict(schema='cloudbench-source-guest-v1',nonce=r['nonce'],source_ref=ref,machine_id=os.environ['FLY_MACHINE_ID'],node_fingerprint=fps[0],python_fingerprint=fps[1],installed_node=pathlib.Path('/data/repo/node_modules/.cloudbench-deps-fingerprint').read_text().strip(),installed_python=pathlib.Path('/data/repo/agents/venv/.cloudbench-deps-fingerprint').read_text().strip(),guest_env_sha256={k:hashlib.sha256(os.environ[k].encode()).hexdigest() for k in r['guest_env_sha256']},mount='/data',guest_exit=0,started_epoch=started,finished_epoch=int(time.time()),job=job,preconditions=preconditions)
 subprocess.run(['sync','-f','/data'],check=True)
 if transport is not None:observed['transport']=transport
 if capsule_attestation is not None:observed.update(capsule_attestation)
 observed['image_node_fingerprint']=image_fps[0];observed['image_python_fingerprint']=image_fps[1]
 save('result.json',observed)
except BaseException as error:
 save('result.json',dict(schema='cloudbench-source-guest-v1',nonce=r['nonce'],guest_exit=1,error=type(error).__name__,phase=phase,job=job,preconditions=preconditions,started_epoch=started,finished_epoch=int(time.time())))
'''.replace('REQUEST', repr(minimal), 1).replace('FILES', repr(files), 1).replace('OBSERVATION_CODE',SAFE_ENV_OBSERVER,1)


def delivery_commands(raw, directory):
    """Bound each real exec argument; a large Python string is never passed to execve."""
    target = str(Path(directory) / 'worker.py')
    yield (['python3', '-c', 'import pathlib,os; d=pathlib.Path(' + repr(str(directory))
            + '); d.mkdir(mode=0o700); p=d/"worker.py"; p.touch(mode=0o600,exist_ok=False); print("CLOUDBENCH-DELIVERY:0")'],
           'CLOUDBENCH-DELIVERY:0')
    for offset in range(0, len(raw), 12000):
        block = raw[offset:offset + 12000]
        end = offset + len(block)
        encoded = base64.b64encode(block).decode()
        command = ('import base64,pathlib,os; p=pathlib.Path(' + repr(target) + '); '
                   'assert p.is_file() and not p.is_symlink() and p.stat().st_size==' + str(offset) + '; '
                   'f=open(p,"ab"); f.write(base64.b64decode(' + repr(encoded) + ')); f.flush(); os.fsync(f.fileno()); f.close(); '
                   'print("CLOUDBENCH-DELIVERY:' + str(end) + '")')
        yield (['python3', '-c', command], 'CLOUDBENCH-DELIVERY:' + str(end))
    seal = ('import hashlib,pathlib,os; p=pathlib.Path(' + repr(target) + '); '
            'assert hashlib.sha256(p.read_bytes()).hexdigest()==' + repr(sha(raw))
            + '; os.chmod(p,0o700); print("CLOUDBENCH-DELIVERY:' + str(len(raw)) + '")')
    yield (['python3', '-c', seal], 'CLOUDBENCH-DELIVERY:' + str(len(raw)))


def job_launcher(path):
    return ('import os,subprocess,json,pathlib; p=subprocess.Popen(["python3",' + repr(str(path))
                + '],stdin=subprocess.DEVNULL,'
                'stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True); '
                'print(json.dumps(dict(pid=p.pid,birth=pathlib.Path("/proc/"+str(p.pid)+"/stat").read_text().rsplit(") ",1)[1].split()[19],'
                'boot=pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip())))')


def ssh_argv(app, mid, command):
    return ['ssh','console','-a',app,'--machine',mid,'-C',shlex.join(['timeout','--signal=TERM','5s',*command])]


def capsule_paths(request):
    digest=request['guest_env_capsule']['sha256'];root='/data/.cloudbench-private/env'
    return root+'/.'+digest+'.'+request['nonce']+'.staging/capsule.json',root+'/'+digest+'.json'


def capsule_sftp_argv(request):
    return ['ssh','sftp','put','-a','navi-whisper-lux-bench','--machine',request['native']['machine_id'],
            '-q','-m','0600',request['guest_env_capsule']['path'],capsule_paths(request)[0]]


def capsule_bootstrap(request):
    stage,final=capsule_paths(request)
    return ['python3','-c','''import os,pathlib,stat,json
for name in ('/data/.cloudbench-private','/data/.cloudbench-private/env'):
 p=pathlib.Path(name)
 try:p.mkdir(mode=0o700)
 except FileExistsError:pass
 s=p.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
p=pathlib.Path(STAGE);p.parent.mkdir(mode=0o700)
s=p.parent.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
assert not os.path.lexists(p)
fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
print(json.dumps(dict(schema='cloudbench-capsule-directory-stage-v2',path=str(p),inode=s.st_ino,device=s.st_dev)))
'''.replace('STAGE',repr(stage))]


def capsule_seal(request,stage_proof):
    stage,final=capsule_paths(request)
    return ['python3','-c','''import os,pathlib,stat,hashlib,json
p=STAGE;target=FINAL
d=pathlib.Path(p).parent
def directory():
 for parent in ('/data/.cloudbench-private','/data/.cloudbench-private/env',str(d)):
  s=os.lstat(parent);assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
 s=os.lstat(d);assert s.st_ino==INODE and s.st_dev==DEVICE
directory()
def read(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);assert stat.S_ISREG(a.st_mode) and a.st_uid==0 and stat.S_IMODE(a.st_mode)==0o600 and a.st_nlink==1
  assert a.st_size<=16*1024*1024
  with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(16*1024*1024+1)
  b=os.fstat(fd);assert (a.st_ino,a.st_dev,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_ino,b.st_dev,b.st_size,b.st_mtime_ns,b.st_ctime_ns)
  assert len(raw)==a.st_size and hashlib.sha256(raw).hexdigest()==DIGEST
  os.fsync(fd);return a,raw
 finally:os.close(fd)
s,raw=read(p);directory()
try:os.link(p,target,follow_symlinks=False)
except FileExistsError:read(target)
os.unlink(p)
os.rmdir(d)
s,raw=read(target)
fd=os.open('/data/.cloudbench-private/env',os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
print(json.dumps(dict(schema='cloudbench-capsule-published-v1',path=target,sha256=DIGEST,size=len(raw),uid=s.st_uid,mode=stat.S_IMODE(s.st_mode))))
'''.replace('STAGE',repr(stage)).replace('FINAL',repr(final)).replace('DIGEST',repr(request['guest_env_capsule']['sha256']))
       .replace('INODE',repr(stage_proof['inode'])).replace('DEVICE',repr(stage_proof['device']))]


def stage_capsule(api,request):
    module=runpy.run_path(str(HERE/'cloudbench-source-env.py'))
    module['descriptor'](request['guest_env_capsule'],private=True)
    proof=json.loads(guest_command(api,request,capsule_bootstrap(request),journal_name='capsule-ssh')['stdout'])
    need(proof.get('schema')=='cloudbench-capsule-directory-stage-v2' and proof.get('path')==capsule_paths(request)[0]
         and type(proof.get('inode')) is int and proof['inode']>0 and type(proof.get('device')) is int,'fresh capsule staging inode')
    directory=api.journal.parent/'capsule-sftp'/'0';directory.mkdir(parents=True,mode=0o700)
    context=api.guest_context
    before,volume=exact_machine(api,request,context['predecessor'],context['config'],state='started',instance=api.target_version)
    sent=dict(schema='cloudbench-sftp-command-v1',argv=capsule_sftp_argv(request),timeout=20,
              capsule=request['guest_env_capsule'],stage=proof,nonce=api.nonce,instance_id=api.target_version,
              before=before,volume_before=volume,started=time.monotonic_ns())
    save(directory/'request.json',sent)
    rc,stdout,stderr=api.api.flyctl(20,*sent['argv']);finished=time.monotonic_ns()
    need(len(stdout.encode())<=1024*1024 and len(stderr.encode())<=1024*1024,'SFTP output exceeds bounded receipt size')
    for name,data in (('stdout.private.log',stdout),('stderr.private.log',stderr)):
        fd=os.open(directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    need(rc==0,'SFTP outcome failed/ambiguous; no retry')
    module['descriptor'](request['guest_env_capsule'],private=True)
    after,volume_after=exact_machine(api,request,context['predecessor'],context['config'],state='started',instance=sent['instance_id'])
    save(directory/'result.json',dict(schema='cloudbench-sftp-result-v1',request=descriptor(directory/'request.json'),
        exit_code=rc,stdout=descriptor(directory/'stdout.private.log'),stderr=descriptor(directory/'stderr.private.log'),
        finished=finished,after=after,volume_after=volume_after))
    published=json.loads(guest_command(api,request,capsule_seal(request,proof),journal_name='capsule-ssh')['stdout'])
    need(published==dict(schema='cloudbench-capsule-published-v1',path=capsule_paths(request)[1],
        sha256=request['guest_env_capsule']['sha256'],size=len(module['descriptor'](request['guest_env_capsule'],private=True)),uid=0,mode=0o600),
        'immutable capsule publication readback')


def guest_command(api, request, command, *, journal_name='ssh'):
    if request.get('guest_transport','native-exec-v1') != 'cloudbench-ssh-guest-v1':
        return api.request('POST','/machines/'+request['native']['machine_id']+'/exec',dict(command=command,timeout=5))
    need(api.nonce and not api.lost and api.lease_version==api.target_version and api.target_version,
         'SSH requires continuously held current-version lease')
    context=api.guest_context
    root=api.journal.parent/journal_name
    directory=root/str(len(list(root.glob('*'))) if root.exists() else 0)
    directory.mkdir(parents=True,mode=0o700)
    before,volume=exact_machine(api,request,context['predecessor'],context['config'],state='started',instance=api.target_version)
    argv=ssh_argv(context['predecessor']['app'],api.mid,command)
    sent=dict(schema='cloudbench-ssh-command-v1',argv=argv,command=command,timeout=20,guest_timeout=5,
              nonce=api.nonce,instance_id=api.target_version,before=before,volume_before=volume,started=time.monotonic_ns())
    save(directory/'request.json',sent)
    rc,stdout,stderr=api.api.flyctl(20,*argv)
    need(len(stdout.encode())<=1024*1024 and len(stderr.encode())<=1024*1024,'SSH output exceeds bounded receipt size')
    for name,data in (('stdout.private.log',stdout),('stderr.private.log',stderr)):
        fd=os.open(directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    finished=time.monotonic_ns()
    need(rc==0,'SSH command outcome failed/ambiguous; no retry')
    after,volume_after=exact_machine(api,request,context['predecessor'],context['config'],state='started',instance=sent['instance_id'])
    answer=dict(schema='cloudbench-ssh-result-v1',request=descriptor(directory/'request.json'),exit_code=rc,
                stdout=descriptor(directory/'stdout.private.log'),stderr=descriptor(directory/'stderr.private.log'),
                finished=finished,after=after,volume_after=volume_after)
    save(directory/'result.json',answer)
    return dict(exit_code=rc,stdout=stdout)


def guest_job(api, request, deadline):
    mid = request['native']['machine_id']
    directory = '/tmp/cloudbench-prepare-delivery-' + request['nonce']
    for command, expected in delivery_commands(guest_program(request).encode(), directory):
        need(time.monotonic() < deadline, 'guest delivery deadline')
        ack = guest_command(api,request,command)
        need(ack.get('exit_code') == 0 and ack.get('stdout', '').strip() == expected, 'guest delivery acknowledgement')
    # Explicit fork: the API exec itself exits quickly; the job has one immutable nonce path.
    launcher = job_launcher(Path(directory) / 'worker.py')
    ack = guest_command(api,request,['python3','-c',launcher])
    need(ack.get('exit_code') == 0, 'guest job launch not acknowledged')
    job = json.loads(ack.get('stdout', ''))
    need(type(job.get('pid')) is int and job['pid'] > 1, 'guest job PID absent')
    result_path = '/tmp/cloudbench-prepare-source-' + request['nonce'] + '/result.json'
    probe = ('import pathlib; p=pathlib.Path(' + repr(result_path) + '); '
             'print(p.read_text() if p.is_file() else "PENDING")')
    while time.monotonic() < deadline:
        value = guest_command(api,request,['python3','-c',probe])
        need(value.get('exit_code') == 0, 'guest job observation failed')
        output = value.get('stdout', '').strip()
        if output != 'PENDING':
            guest = json.loads(output)
            verify_guest(request, guest)
            need(guest['job'] == job, 'guest result process differs from launched job')
            return guest
        time.sleep(2)
    raise ValueError('private source preparation: guest job deadline')


def journal_index(directory):
    directory = Path(directory)
    files = {str(path.relative_to(directory)): sha(IO['read'](path))
             for path in sorted(directory.rglob('*')) if path.is_file()}
    return dict(path=str(directory), sha256=sha(canonical(files)), files=files)


def verify_journal(value, mid, vid, shared, *, request=None, before=None, after=None, guest=None, successor=None, prestart=None,
                   allow_pending_prestart_stop=False, allow_rejected_bootstrap=False, versioned=False, ssh=None, capsule_ssh=None,capsule_sftp=None):
    actual = journal_index(value['path'])
    need(actual == value, 'native journal changed')
    rows = []
    for member in actual['files']:
        if member.endswith('/request.json'):
            path = Path(value['path']) / member
            sent = load(path)
            need(sent['app'] == 'navi-whisper-lux-bench', 'native app escaped scope')
            raw_paths = list(path.parent.glob('*-wire.json'))
            if allow_rejected_bootstrap and not (path.parent/'result.json').exists() and len(raw_paths)==1:
                wire=load(raw_paths[0]);raw=base64.b64decode(wire['body_b64'],validate=True)
                need(wire['sha256']==sha(raw) and wire['method']==sent['method'] and wire['path']==sent['path']
                     and wire['status']==409 and sent['method']=='POST' and sent['path']=='/machines/'+mid+'/exec',
                     'only explicit bootstrap EXEC conflict may recover')
                response=json.loads(raw)
                need(isinstance(response.get('error'),str) and 'lease currently held' in response['error'],
                     'bootstrap EXEC rejection lacks lease evidence')
                rows.append(dict(sent,response=response,started=load(path.parent/'transport-start.json')['monotonic_ns'],
                                 finished=wire['monotonic_ns'],rejected=True))
                continue
            if not (path.parent / 'result.json').is_file():
                need(allow_pending_prestart_stop and not raw_paths and sent['method'] == 'POST'
                     and sent['path'] == '/machines/' + mid + '/stop' and sent['body'] == {},
                     'native call has unknown outcome')
                started = load(path.parent / 'transport-start.json')['monotonic_ns']
                rows.append(dict(sent, response=None, started=started, finished=started, pending=True))
                continue  # Retained unresolved cleanup, never a successful STOP receipt.
            need(len(raw_paths) == 1, 'exact original native response required')
            wire = load(raw_paths[0]); raw = base64.b64decode(wire['body_b64'], validate=True)
            need(wire['sha256'] == sha(raw) and wire['method'] == sent['method']
                 and wire['path'] == sent['path'] and type(wire['status']) is int
                 and 200 <= wire['status'] < 300, 'native raw response binding')
            response = json.loads(raw) if raw.strip() else {}
            need(response == load(path.parent / 'result.json'), 'native parsed response changed')
            started = load(path.parent / 'transport-start.json')['monotonic_ns']
            rows.append(dict(sent, response=response, started=started, finished=wire['monotonic_ns']))
    rows.sort(key=lambda row: row['started'])
    verify_scope(rows, mid, vid, shared)
    nonce = None; expiry = 0; released = False; lease_version=None; target_version=None
    strict_versions=versioned or request is not None
    for row in rows:
        need(not released and row['started'] <= row['finished'], 'native call order after release')
        sent_nonce = row['headers'].get('fly-machine-lease-nonce')
        if row['method'] == 'POST' and row['path'] == '/machines/' + mid + '/lease':
            need(row['body'] == {'ttl': 180, 'description': 'private source preparation'}, 'lease request changed')
            acquired = row['response'].get('data', {}).get('nonce')
            need(isinstance(acquired, str) and acquired and (nonce is None or acquired == nonce), 'lease response nonce')
            need(sent_nonce == nonce and (nonce is None or row['finished'] < expiry), 'lease renewal ownership/expiry')
            nonce = acquired; expiry = row['started'] + 180_000_000_000
            observed_version=row['response'].get('data',{}).get('version')
            if strict_versions:
                need(isinstance(observed_version,str) and observed_version
                     and (target_version is None or observed_version==target_version), 'lease native version proof')
            lease_version=observed_version
        elif row['method'] != 'GET':
            need(nonce and sent_nonce == nonce and row['finished'] < expiry, 'native effect without valid lease')
            if row['method'] == 'DELETE':
                released = True
            elif row['path']=='/machines/'+mid:
                if strict_versions:need(lease_version==row['body']['current_version'],'CAS lease version proof')
                target_version=row['response'].get('instance_id')
            elif row['path'] in ('/machines/'+mid+'/start','/machines/'+mid+'/exec') and strict_versions:
                need(lease_version==target_version and target_version, 'START/EXEC current-version lease proof')
    need(released, 'native lease not released')
    if request is not None:
        own = '/machines/' + mid
        updates = [row for row in rows if row['method'] == 'POST' and row['path'] == own]
        need(len(updates) == 2, 'exact prepare and park updates required')
        expected_config = capsule_metadata(before['config'],request); expected_config['image'] = request['image_ref']
        maintenance_config = copy.deepcopy(expected_config)
        maintenance_config['guest'] = dict(maintenance_config['guest'], cpus=4, memory_mb=8192)
        update, park = updates
        need(update['body'] == dict(config=maintenance_config, current_version=before['instance_id'], skip_launch=True)
             and update['response']['instance_id'] == prestart['instance_id']
             and update['response']['config'] == maintenance_config, 'native preparation CAS acknowledgement changed')
        need(park['body'] == dict(config=expected_config, current_version=prestart['instance_id'], skip_launch=True)
             and park['response']['instance_id'] == after['instance_id']
             and park['response']['config'] == expected_config, 'native parking CAS acknowledgement changed')
        starts = [row for row in rows if row['method'] == 'POST' and row['path'] == own + '/start']
        stops = [row for row in rows if row['method'] == 'POST' and row['path'] == own + '/stop']
        snapshots = [row for row in rows if row['method'] == 'POST' and row['path'] == '/volumes/' + vid + '/snapshots']
        execs = [row for row in rows if row['method'] == 'POST' and row['path'] == own + '/exec']
        if request.get('guest_transport','native-exec-v1')=='cloudbench-ssh-guest-v1':
            need(not execs and ssh is not None,'SSH transport must not fabricate native EXEC')
            execs=verify_ssh_journal(ssh,rows,request,prestart)
        if request.get('guest_env_mode')==OWNED_MODE:
            verify_capsule_transport(capsule_ssh,capsule_sftp,rows,request,prestart,execs[0]['started'])
        else:need(capsule_ssh is None and capsule_sftp is None,'unexpected capsule transport evidence')
        need(len(starts) == len(stops) == len(snapshots) == 1 and len(execs) >= 2,
             'native lifecycle chain incomplete')
        need(update['finished'] <= starts[0]['started'] <= execs[0]['started'] <= execs[-1]['started']
             <= stops[0]['started'] <= park['started'] <= snapshots[0]['started'], 'native lifecycle order')
        need(snapshots[0]['response']['id'] == successor['snapshot_id'], 'created snapshot acknowledgement')
        need(execs[-1]['response'].get('exit_code') == 0
             and json.loads(execs[-1]['response']['stdout']) == guest, 'guest observation original response')
        commands = list(delivery_commands(guest_program(request).encode(), '/tmp/cloudbench-prepare-delivery-' + request['nonce']))
        need(len(execs) >= len(commands) + 2, 'guest delivery original responses absent')
        for row, (command, expected) in zip(execs, commands):
            need(row['body'] == dict(command=command, timeout=5)
                 and row['response'].get('exit_code') == 0 and row['response']['stdout'].strip() == expected,
                 'guest delivery command/ACK changed')
        launch = execs[len(commands)]
        need(launch['body'] == dict(command=['python3', '-c', job_launcher('/tmp/cloudbench-prepare-delivery-' + request['nonce'] + '/worker.py')], timeout=5)
             and launch['response'].get('exit_code') == 0
             and json.loads(launch['response']['stdout']) == guest['job'], 'original launched guest identity')
        if request.get('guest_transport')=='cloudbench-ssh-guest-v1':
            result_path='/tmp/cloudbench-prepare-source-'+request['nonce']+'/result.json'
            probe=('import pathlib; p=pathlib.Path('+repr(result_path)+'); '
                   'print(p.read_text() if p.is_file() else "PENDING")')
            for poll in execs[len(commands)+1:]:
                need(poll['body']==dict(command=['python3','-c',probe],timeout=5)
                     and poll['response'].get('exit_code')==0,'SSH exact guest observation command')
        final_reads = [row['response'] for row in rows if row['method'] == 'GET' and row['path'] == own
                       and row['started'] > snapshots[0]['finished']]
        need(final_reads and final_reads[-1] == after, 'final native state original response')
    return rows


def verify_ssh_journal(value,native,request,prestart,*,sftp=False,allow_incomplete=False,capsule_builders=None):
    need(journal_index(value['path'])==value,'SSH journal changed')
    root=Path(value['path']);records=[];mid=request['native']['machine_id'];own='/machines/'+mid
    for path in sorted(root.glob('*/request.json'),key=lambda p:int(p.parent.name)):
        sent=load(path)
        expected_argv=(capsule_builders or globals())['capsule_sftp_argv'](request) if sftp else ssh_argv('navi-whisper-lux-bench',mid,sent['command'])
        if allow_incomplete and not (path.parent/'result.json').exists():
            need(sent.get('schema')==('cloudbench-sftp-command-v1' if sftp else 'cloudbench-ssh-command-v1')
                 and sent['argv']==expected_argv and sent['timeout']==20 and sent['instance_id']==prestart['instance_id']
                 and sent['before']['id']==mid and sent['before']['config']==prestart['config']
                 and sent['before']['state']=='started' and sent['volume_before']['id']==request['native']['volume_id']
                 and sent['volume_before']['attached_machine_id']==mid,'incomplete capsule transport ownership')
            need(request.get('guest_env_mode') != OWNED_MODE or sent['volume_before'].get('encrypted') is True,
                 'owned capsule transport requires encrypted Volume')
            prior=[r for r in native if r['finished']<=sent['started']]
            leases=[r for r in prior if r['method']=='POST' and r['path']==own+'/lease']
            need(leases and leases[-1]['response']['data']['nonce']==sent['nonce']
                 and leases[-1]['response']['data']['version']==sent['instance_id']
                 and any(r['method']=='GET' and r['path']==own and r['response']==sent['before'] for r in prior),
                 'incomplete capsule transport original lease/readback')
            records.append(dict(transport='sftp-v1' if sftp else 'ssh-v1',body=sent if sftp else dict(command=sent['command'],timeout=5),
                                response=None,started=sent['started'],finished=sent['started'],pending=True))
            continue
        answer=load(path.parent/'result.json')
        need(sent.get('schema')==('cloudbench-sftp-command-v1' if sftp else 'cloudbench-ssh-command-v1')
             and answer.get('schema')==('cloudbench-sftp-result-v1' if sftp else 'cloudbench-ssh-result-v1')
             and answer['request']==descriptor(path) and sent['timeout']==20
             and (sftp or sent['guest_timeout']==5)
             and sent['argv']==expected_argv
             and answer['exit_code']==0 and sent['started']<=answer['finished']<=sent['started']+20_000_000_000
             and sent['instance_id']==prestart['instance_id'],'typed SSH command/result contract')
        before,after=sent['before'],answer['after']
        machine_fields=('id','name','region','instance_id','state','config','image_ref')
        volume_fields=('id','name','region','size_gb','encrypted','state','attached_machine_id','attached_alloc_id')
        need(all(before.get(k)==after.get(k) for k in machine_fields) and before['id']==mid and before['state']=='started'
             and before['instance_id']==prestart['instance_id'] and before['config']==prestart['config']
             and all(sent['volume_before'].get(k)==answer['volume_after'].get(k) for k in volume_fields)
             and answer['volume_after']['id']==request['native']['volume_id']
             and answer['volume_after']['attached_machine_id']==mid,'SSH native ownership witnesses')
        need(request.get('guest_env_mode') != OWNED_MODE or sent['volume_before'].get('encrypted') is True,
             'owned capsule transport requires encrypted Volume')
        prior=[r for r in native if r['finished']<=sent['started']]
        leases=[r for r in prior if r['method']=='POST' and r['path']==own+'/lease']
        need(leases and leases[-1]['response']['data']['nonce']==sent['nonce']
             and leases[-1]['response']['data']['version']==sent['instance_id']
             and answer['finished']<leases[-1]['started']+180_000_000_000
             and not any(r['method']=='DELETE' or r['method']=='POST' and r['path']==own
                         for r in native if sent['started']<r['started']<answer['finished']), 'SSH continuous lease/version proof')
        for endpoint,first,last in ((own,before,after),('/volumes/'+request['native']['volume_id'],sent['volume_before'],answer['volume_after'])):
            observations=[r for r in native if r['method']=='GET' and r['path']==endpoint]
            need(any(r['response']==first and r['finished']<=sent['started'] for r in observations)
                 and any(r['response']==last and r['started']>=answer['finished'] for r in observations),'SSH original native readback wire')
        stdout=IO['read'](Path(answer['stdout']['path']));stderr=IO['read'](Path(answer['stderr']['path']))
        need(descriptor(answer['stdout']['path'])==answer['stdout'] and descriptor(answer['stderr']['path'])==answer['stderr'],
             'SSH output evidence changed')
        records.append(dict(transport='sftp-v1' if sftp else 'ssh-v1',body=sent if sftp else dict(command=sent['command'],timeout=5),
                            response=dict(exit_code=0,stdout=stdout.decode()),started=sent['started'],finished=answer['finished']))
    need(records,'SSH command chain absent')
    return records


def verify_failed_capsule_staging(result,rows,request,prestart,stop_started,builders):
    need(result.get('capsule_ssh') is not None,'failed capsule staging journal required')
    commands=verify_ssh_journal(result['capsule_ssh'],rows,request,prestart,allow_incomplete=True)
    need(1<=len(commands)<=2 and commands[0]['body']==dict(command=builders['capsule_bootstrap'](request),timeout=5)
         and all(row['started']<stop_started for row in commands),'failed capsule bootstrap prefix')
    stage=None
    if commands[0]['response'] is not None:
        stage=json.loads(commands[0]['response']['stdout'])
        expected_schema='cloudbench-capsule-directory-stage-v2' if builders['capsule_paths'](request)[0].endswith('/capsule.json') else 'cloudbench-capsule-stage-v1'
        need(stage.get('schema')==expected_schema and stage.get('path')==builders['capsule_paths'](request)[0]
             and type(stage.get('inode')) is int and stage['inode']>0 and type(stage.get('device')) is int,
             'failed capsule staging inode')
    transfers=[]
    if result.get('capsule_sftp') is not None:
        transfers=verify_ssh_journal(result['capsule_sftp'],rows,request,prestart,sftp=True,allow_incomplete=True,capsule_builders=builders)
        need(stage is not None and len(transfers)==1 and transfers[0]['body']['capsule']==request['guest_env_capsule']
             and transfers[0]['body']['stage']==stage and commands[0]['finished']<=transfers[0]['started']<stop_started,
             'failed capsule exact SFTP attempt')
    if len(commands)==2:
        need(stage is not None and len(transfers)==1 and transfers[0]['response'] is not None
             and commands[1]['body']==dict(command=builders['capsule_seal'](request,stage),timeout=5)
             and transfers[0]['finished']<=commands[1]['started'],'failed capsule seal attempt prefix')
    else:need(not transfers or transfers[0].get('pending') is True,'completed capsule upload lacks seal attempt')


def verify_capsule_transport(ssh,sftp,native,request,prestart,guest_started):
    need(ssh is not None and sftp is not None,'owned capsule requires distinct transport proof')
    commands=verify_ssh_journal(ssh,native,request,prestart)
    transfers=verify_ssh_journal(sftp,native,request,prestart,sftp=True)
    need(len(commands)==2 and len(transfers)==1,'exact capsule staging/upload/seal sequence')
    bootstrap,seal=commands;transfer=transfers[0]
    need(bootstrap['body']==dict(command=capsule_bootstrap(request),timeout=5),'capsule directory bootstrap command')
    stage=json.loads(bootstrap['response']['stdout'])
    need(stage.get('schema')=='cloudbench-capsule-directory-stage-v2' and stage.get('path')==capsule_paths(request)[0]
         and type(stage.get('inode')) is int and stage['inode']>0 and type(stage.get('device')) is int,
         'capsule exclusive staging inode proof')
    need(transfer['body']['capsule']==request['guest_env_capsule'] and transfer['body']['stage']==stage
         and seal['body']==dict(command=capsule_seal(request,stage),timeout=5),'capsule SFTP source/inode/seal binding')
    module=runpy.run_path(str(HERE/'cloudbench-source-env.py'))
    raw=module['descriptor'](request['guest_env_capsule'],private=True)
    need(json.loads(seal['response']['stdout'])==dict(schema='cloudbench-capsule-published-v1',path=capsule_paths(request)[1],
         sha256=request['guest_env_capsule']['sha256'],size=len(raw),uid=0,mode=0o600),'capsule immutable final hash/mode proof')
    starts=[r for r in native if r['method']=='POST' and r['path']=='/machines/'+request['native']['machine_id']+'/start']
    need(len(starts)==1 and starts[0]['finished']<=bootstrap['started']<=bootstrap['finished']
         <=transfer['started']<=transfer['finished']<=seal['started']<=seal['finished']<=guest_started,
         'capsule staging timeline before guest delivery')


def prepare(request_path, output, api_factory=None, *, before_effects=None):
    request, predecessor = read_request(request_path)
    output = Path(output).absolute()
    output.mkdir(mode=0o700)  # Never reuse an interrupted transaction directory.
    need(output.resolve() == output, 'physical output directory')
    save(output / 'request.json', request)
    request_pin = descriptor(output / 'request.json')
    origin = dict(schema='cloudbench-prepare-source-origin-v1', producer=dict(pid=os.getpid(),
                  birth=runpy.run_path(str(HERE / 'process-identity.py'))['linux_identity'](os.getpid()),
                  argv_sha256=sha(Path('/proc/self/cmdline').read_bytes())), nonce=request['nonce'],
                  request=descriptor(request_path), source_ref=request['source_ref'],
                  helper_sha256=sha((HERE / 'cloudbench-prepare-source.py').read_bytes()),
                  dependencies=dependency_seals(), output=str(output))
    save(output / 'origin.json', origin)
    if before_effects is not None:
        before_effects(output / 'origin.json')
    started = int(time.time())
    result = dict(schema=RESULT, request=request_pin, qualified=False, credit_granted=False,
                  cleanup_complete=False, started_epoch=started, origin=descriptor(output / 'origin.json'))
    api = None
    config = None
    armed = False
    original_config = None
    known_versions = set()
    def cleanup():
        if not armed:
            return
        try:
            current = api.request('GET', '/machines/' + predecessor['machine_id'])
            need(current.get('id') == predecessor['machine_id']
                 and current.get('name') == predecessor['machine_name']
                 and current.get('instance_id') in known_versions
                 and current.get('config') in (original_config, config), 'cleanup native identity changed')
            need(current.get('state') in ('created', 'stopped', 'started'), 'cleanup replacement is not inactive/owned running state')
            active_config = current['config']
            if current.get('state') != 'stopped':
                api.request('POST', '/machines/' + predecessor['machine_id'] + '/stop', {})
            wait_state(api, request, predecessor, active_config, 'stopped', current['instance_id'], time.monotonic() + 60)
            parked_config = copy.deepcopy(active_config)
            parked_config['guest'] = copy.deepcopy(original_config['guest'])
            if parked_config != active_config:
                parked = api.request('POST', '/machines/' + predecessor['machine_id'],
                                     dict(config=parked_config, current_version=current['instance_id'], skip_launch=True))
                wait_state(api, request, predecessor, parked_config, 'stopped', parked['instance_id'], time.monotonic() + 60, prior=current)
            result['stopped_verified'] = True
        except BaseException as cleanup_error:
            result.update(stopped_verified=False, cleanup_error=type(cleanup_error).__name__)
    try:
        if api_factory is None:
            token = os.environ.get('FLY_API_TOKEN', '')
            need(token, 'FLY_API_TOKEN required')
            api = ScopedNative(CAPTURE['Fly'](predecessor['app'], token), output / 'native', request, predecessor)
        else:
            api = api_factory(output / 'native', request, predecessor)
        api.on_failure = cleanup
        with api.lease():
            before = api.request('GET', '/machines/' + predecessor['machine_id'])
            config = copy.deepcopy(before['config'])
            need(sha(canonical(config)) == request['native']['config_sha256']
                 and sha(canonical(config.get('env') or {})) == request['native']['env_sha256'],
                 'original native config/environment changed')
            need(config.get('init') == {'cmd': ['sleep', 'infinity']}
                 and not any(config.get(key) for key in ('services', 'containers', 'processes', 'schedule', 'checks'))
                 and config.get('restart') == {'policy': 'no'} and config.get('auto_destroy') in (None, False),
                 'source must be inert without services')
            initial_state = before['state'] if 'ownership' in request else 'stopped'
            need(initial_state in ('created', 'stopped'), 'inactive original owned source required')
            before, volume = exact_machine(api, request, predecessor, config, state=initial_state,
                                           instance=predecessor['instance_id'])
            original_config = copy.deepcopy(config)
            shared = api.request('GET', '/machines/' + predecessor['shared_machine_id'])
            if 'ownership' not in request:
                snapshots = api.request('GET', '/volumes/' + predecessor['volume_id'] + '/snapshots')
                SOURCE['verify'](predecessor, dict(machines=[before, shared], volumes=[volume], snapshots=snapshots), parked_memory=2048)
            else:
                need(config['metadata'].get('cloudbench_source_owner') == predecessor['owner_token'], 'created source owner')
            save(output / 'before.json', before)
            known_versions.add(before['instance_id'])
            armed = True
            config['image'] = request['image_ref']
            config=capsule_metadata(config,request)
            config['guest'] = dict(config['guest'], cpus=4, memory_mb=8192)
            ack = api.request('POST', '/machines/' + predecessor['machine_id'],
                              dict(config=config, current_version=before['instance_id'], skip_launch=True))
            instance = ack.get('instance_id')
            need(instance and ack.get('config') == config and ack.get('id') == predecessor['machine_id'],
                 'native update version/config acknowledgement absent')
            known_versions.add(instance)
            prestart, _ = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120, prior=before)
            save(output / 'prestart.json', prestart)
            api.request('POST', '/machines/' + predecessor['machine_id'] + '/start', {})
            wait_state(api, request, predecessor, config, 'started', instance, time.monotonic() + 120)
            api.guest_context=dict(predecessor=predecessor,config=copy.deepcopy(config))
            guest_deadline=time.monotonic()+2160
            if request.get('guest_env_mode')==OWNED_MODE:stage_capsule(api,request)
            guest = guest_job(api, request, guest_deadline)
            save(output / 'guest.json', guest)
            api.request('POST', '/machines/' + predecessor['machine_id'] + '/stop', {})
            after, volume = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120)
            config['guest'] = copy.deepcopy(original_config['guest'])
            parked = api.request('POST', '/machines/' + predecessor['machine_id'],
                                 dict(config=config, current_version=instance, skip_launch=True))
            instance = parked.get('instance_id')
            need(instance, 'park version acknowledgement absent')
            known_versions.add(instance)
            after, volume = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120, prior=after)
            snapshot_ack = api.request('POST', '/volumes/' + predecessor['volume_id'] + '/snapshots', {})
            snapshot_id = snapshot_ack.get('id')
            need(isinstance(snapshot_id, str) and re.fullmatch('vs_[A-Za-z0-9]+', snapshot_id), 'exact created snapshot ID')
            successor = dict(predecessor, instance_id=after['instance_id'], image_digest=request['image_ref'].rsplit('@', 1)[1],
                             snapshot_id=snapshot_id, verified_at=guest['finished_epoch'],
                             node_fingerprint=request['node_fingerprint'], python_fingerprint=request['python_fingerprint'],
                             guest_env_sha256=copy.deepcopy(guest['guest_env_sha256']))
            if request.get('guest_env_mode')==OWNED_MODE:
                attestation=owned_manifest(request,predecessor)
                successor.update({key:attestation[key] for key in OWNED_FIELDS})
            deadline = time.monotonic() + 120
            while True:
                snapshots = api.request('GET', '/volumes/' + predecessor['volume_id'] + '/snapshots')
                if runpy.run_path(str(HERE / 'cloudbench-select-snapshot.py'))['available_snapshot'](snapshots, snapshot_id) is not None:
                    break
                need(time.monotonic() < deadline, 'snapshot completion deadline')
                time.sleep(2)
            after, volume = exact_machine(api, request, predecessor, config, state='stopped', instance=instance)
            shared = api.request('GET', '/machines/' + predecessor['shared_machine_id'])
            SOURCE['verify'](successor, dict(machines=[after, shared], volumes=[volume], snapshots=snapshots), parked_memory=2048)
            save(output / 'after.json', after)
            save(output / 'final-inventory.json', dict(machines=[after, shared], volumes=[volume], snapshots=snapshots))
        # Publication follows release acknowledgement; an unknown release cannot qualify.
        save(output / 'source-manifest.json', successor)
        result.update(qualified=True, source_ref=request['source_ref'], image_ref=request['image_ref'],
                      predecessor=request.get('predecessor', request.get('ownership')), build=request['build'], before=descriptor(output / 'before.json'),
                      after=descriptor(output / 'after.json'), guest=descriptor(output / 'guest.json'),
                      prestart=descriptor(output / 'prestart.json'),
                      inventory=descriptor(output / 'final-inventory.json'), manifest=descriptor(output / 'source-manifest.json'))
        if request.get('guest_transport')=='cloudbench-ssh-guest-v1':result['ssh']=journal_index(output/'ssh')
    except BaseException as error:
        # A failed lease or ambiguous native update never grants guessed cleanup rights.
        result.update(error=type(error).__name__)
        result.setdefault('stopped_verified', False)
        raise
    finally:
        result['finished_epoch'] = int(time.time())
        result['journal'] = journal_index(output / 'native')
        if (output/'ssh').is_dir():result['ssh']=journal_index(output/'ssh')
        for member in ('capsule-ssh','capsule-sftp'):
            if (output/member).is_dir():result[member.replace('-','_')]=journal_index(output/member)
        save(output / 'result.json', result)
    return result


def verify_prepared_source(request_path, result_path, manifest_path, *, source_ref, image_ref,
                           node_fingerprint, python_fingerprint):
    """Read-only parent seam. Original failed receipts and debts are never modified."""
    request, predecessor = read_request(request_path)
    result = load(result_path)
    need(result.get('schema') == RESULT and result.get('qualified') is True
         and result.get('credit_granted') is False and result.get('cleanup_complete') is False, 'result qualification')
    need(described(result['request']) == request and result['predecessor'] == request.get('predecessor', request.get('ownership'))
         and result['build'] == request['build'], 'result input seals')
    origin = described(result['origin'])
    need(origin.get('schema') == 'cloudbench-prepare-source-origin-v1'
         and described(origin['request']) == request and origin['source_ref'] == request['source_ref']
         and origin['nonce'] == request['nonce'] and origin['output'] == str(Path(result_path).absolute().parent)
         and origin['helper_sha256'] == sha((HERE / 'cloudbench-prepare-source.py').read_bytes())
         and origin['dependencies'] == dependency_seals()
         and type(origin['producer']['pid']) is int and origin['producer']['pid'] > 1
         and origin['producer']['birth'], 'original producer origin')
    expected = dict(source_ref=source_ref, image_ref=image_ref, node_fingerprint=node_fingerprint,
                    python_fingerprint=python_fingerprint)
    need(all(request[key] == value for key, value in expected.items()), 'parent expected preparation')
    need(result['source_ref'] == source_ref and result['image_ref'] == image_ref, 'result source/image')
    successor = SOURCE['manifest'](canonical(load(manifest_path)))
    need(described(result['manifest']) == successor and descriptor(manifest_path) == result['manifest'], 'successor manifest seal')
    for key in set(successor) - {'instance_id', 'image_digest', 'snapshot_id', 'verified_at', 'node_fingerprint', 'python_fingerprint'} - OWNED_FIELDS:
        need(successor[key] == predecessor[key], 'successor ownership changed: ' + key)
    need(successor['image_digest'] == image_ref.rsplit('@', 1)[1], 'successor image digest')
    need(successor['node_fingerprint'] == node_fingerprint and successor['python_fingerprint'] == python_fingerprint,
         'successor dependency set')
    need(successor['guest_env_sha256'] == request['guest_env_sha256'], 'successor effective guest environment')
    if request.get('guest_env_mode')==OWNED_MODE:
        owned=owned_manifest(request,predecessor)
        need(all(successor.get(key)==owned[key] for key in OWNED_FIELDS),'successor owned environment binding')
    else:need(not OWNED_FIELDS & set(successor),'unexpected owned successor')
    before, after = described(result['before']), described(result['after'])
    need(before['instance_id'] == predecessor['instance_id']
         and sha(canonical(before['config'])) == request['native']['config_sha256'], 'original native source')
    expected_config = capsule_metadata(before['config'],request); expected_config['image'] = image_ref
    need(after['config'] == expected_config and after['instance_id'] == successor['instance_id']
         and before['id'] == after['id'] == successor['machine_id'] and after['state'] == 'stopped', 'only exact image changed')
    guest = described(result['guest']); verify_guest(request, guest)
    prestart = described(result['prestart'])
    maintenance_config = copy.deepcopy(expected_config)
    maintenance_config['guest'] = dict(maintenance_config['guest'], cpus=4, memory_mb=8192)
    need(prestart['id'] == successor['machine_id'] and prestart['state'] == 'stopped'
         and prestart['config'] == maintenance_config, 'native prestart proof')
    need(result['started_epoch'] <= guest['started_epoch'] <= guest['finished_epoch'] <= result['finished_epoch']
         and successor['verified_at'] == guest['finished_epoch'], 'preparation chronology')
    SOURCE['verify'](successor, described(result['inventory']), parked_memory=2048)
    verify_journal(result['journal'], successor['machine_id'], successor['volume_id'], (successor['shared_machine_id'],),
                   request=request, before=before, after=after, guest=guest, successor=successor, prestart=prestart,ssh=result.get('ssh'),
                   capsule_ssh=result.get('capsule_ssh'),capsule_sftp=result.get('capsule_sftp'))
    return successor


def verify_producer(origin, root, tree):
    if (origin['helper_sha256'] == sha((HERE / 'cloudbench-prepare-source.py').read_bytes())
            and origin['dependencies'] == dependency_seals()):
        return
    raw=source_bytes(root,tree,'cloudbench-prepare-source.py')
    declarations=[node.value for node in ast.parse(raw).body if isinstance(node,ast.Assign)
                  and any(isinstance(target,ast.Name) and target.id=='DEPENDENCIES' for target in node.targets)]
    need(len(declarations)==1,'historical dependency declaration')
    dependencies=ast.literal_eval(declarations[0])
    need(isinstance(dependencies,tuple) and all(isinstance(name,str) and re.fullmatch('[A-Za-z0-9_.-]+',name) for name in dependencies)
         and len(set(dependencies))==len(dependencies) and set(origin['dependencies'])==set(dependencies),'exact historical producer dependency closure')
    need(origin['helper_sha256'] == sha(raw)
         and all(value == sha(source_bytes(root, tree, member)) for member, value in origin['dependencies'].items()),
         'historical producer source/dependency proof')


def historical_guest_functions(origin,request):
    """Read only the pinned producer's three payload builders, never its entrypoint."""
    tree=request.get('transport',{}).get('replayed_tree',request['source_ref'])
    raw=source_bytes(Path(request['source_root']),tree,'cloudbench-prepare-source.py')
    if sha(raw)!=origin['helper_sha256']:
        need(origin['helper_sha256']==sha((HERE/'cloudbench-prepare-source.py').read_bytes()),'historical payload producer')
        raw=(HERE/'cloudbench-prepare-source.py').read_bytes()
    names={'guest_program','delivery_commands','job_launcher'}
    if request.get('guest_env_mode')==OWNED_MODE:names.update(('capsule_paths','capsule_sftp_argv','capsule_bootstrap','capsule_seal'))
    nodes=[node for node in ast.parse(raw).body if isinstance(node,ast.FunctionDef) and node.name in names]
    need(len(nodes)==len(names),'pinned payload builders unavailable')
    constants=[node for node in ast.parse(raw).body if isinstance(node,ast.Assign)
               and any(isinstance(target,ast.Name) and target.id=='SAFE_ENV_OBSERVER' for target in node.targets)]
    need(all(isinstance(node.value,ast.Constant) and isinstance(node.value.value,str) for node in constants),
         'pinned guest observation constant')
    nodes=constants+nodes
    namespace=dict(globals());exec(compile(ast.Module(body=nodes,type_ignores=[]),'<pinned-payload-builders>','exec'),namespace)
    return namespace


def ssh_failure_proof(request,result,directory,origin,predecessor,before,rows,forensic_ssh=None):
    """Guest filesystem is untrusted: only proven power-off/park grants reuse."""
    own='/machines/'+predecessor['machine_id']
    need(request.get('guest_transport')=='cloudbench-ssh-guest-v1' and result.get('stopped_verified') is True,
         'clean failed SSH preparation required')
    need(all(r['method']=='GET' or r['path'] in (own,own+'/lease',own+'/start',own+'/stop') for r in rows),
         'failed SSH journal has EXEC/snapshot/foreign effects')
    updates=[r for r in rows if r['method']=='POST' and r['path']==own]
    starts=[r for r in rows if r['method']=='POST' and r['path']==own+'/start']
    stops=[r for r in rows if r['method']=='POST' and r['path']==own+'/stop']
    need(len(updates)==2 and len(starts)==len(stops)==1,'failed SSH native lifecycle incomplete')
    target=capsule_metadata(before['config'],request);target['image']=request['image_ref'];target['guest']=dict(target['guest'],cpus=4,memory_mb=8192)
    update,park=updates;ack=update['response'];prestart=load(directory/'prestart.json')
    need(update['body']==dict(config=target,current_version=before['instance_id'],skip_launch=True)
         and ack['config']==target and prestart['id']==before['id'] and prestart['instance_id']==ack['instance_id']
         and prestart['config']==target and prestart['state']=='stopped','failed SSH accepted maintenance CAS/prestart')
    parked=copy.deepcopy(target);parked['guest']=copy.deepcopy(before['config']['guest'])
    need(park['body']==dict(config=parked,current_version=ack['instance_id'],skip_launch=True)
         and park['response']['id']==before['id'] and park['response']['config']==parked,
         'failed SSH cleanup parking CAS')
    reads=[r for r in rows if r['method']=='GET' and r['path']==own]
    need(any(r['response']==prestart and update['finished']<=r['started']<=starts[0]['started'] for r in reads),
         'failed SSH original prestart wire')
    final=[r['response'] for r in reads if r['started']>park['finished']]
    need(final and final[-1]['state']=='stopped' and final[-1]['instance_id']==park['response']['instance_id']
         and final[-1]['config']==parked,'failed SSH final power-off/parking readback')
    if request.get('guest_env_mode')==OWNED_MODE and not (directory/'ssh').exists():
        for read in reads:
            row=read['response']
            need(row['id']==before['id'] and row['name']==before['name'] and row['region']==before['region']
                 and any(row['instance_id']==item['instance_id'] and row['config']==item['config'] for item in (before,ack,park['response']))
                 and row['state'] in ('created','stopped','replacing','started','stopping'),'unknown failed capsule native epoch')
        verify_failed_capsule_staging(result,rows,request,prestart,stops[0]['started'],historical_guest_functions(origin,request))
        need(update['finished']<=starts[0]['started']<=stops[0]['started']<=park['started'],'failed capsule power-off order')
        return park['response']
    index=result.get('ssh')
    if index is None:
        need(origin['helper_sha256']=='1928c061e13aaff097a9836d69b589d9dc93dc82634687484a936154051b10a1'
             and forensic_ssh is not None,'legacy unsealed SSH requires explicit forensic descriptor')
        index=forensic_ssh
    need(index.get('path')==str(directory/'ssh') and Path(index['path']).resolve()==directory/'ssh',
         'failed SSH evidence must remain in original operation directory')
    records=verify_ssh_journal(index,rows,request,prestart)
    if request.get('guest_env_mode')==OWNED_MODE:
        verify_capsule_transport(result.get('capsule_ssh'),result.get('capsule_sftp'),rows,request,prestart,records[0]['started'])
    builders=historical_guest_functions(origin,request)
    commands=list(builders['delivery_commands'](builders['guest_program'](request).encode(),'/tmp/cloudbench-prepare-delivery-'+request['nonce']))
    need(len(records)>=len(commands)+2,'failed SSH complete guest execution evidence required')
    for row,(command,expected) in zip(records,commands):
        need(row['body']==dict(command=command,timeout=5) and row['response']['stdout'].strip()==expected,
             'failed SSH original pinned payload delivery')
    launch=records[len(commands)]
    need(launch['body']==dict(command=['python3','-c',builders['job_launcher']('/tmp/cloudbench-prepare-delivery-'+request['nonce']+'/worker.py')],timeout=5),
         'failed SSH original job launcher')
    job=json.loads(launch['response']['stdout'])
    need(type(job.get('pid')) is int and job['pid']>1 and re.fullmatch('[0-9]+',job.get('birth',''))
         and re.fullmatch('[a-f0-9-]{36}',job.get('boot','')),'failed SSH launched process identity')
    result_path='/tmp/cloudbench-prepare-source-'+request['nonce']+'/result.json'
    probe=('import pathlib; p=pathlib.Path('+repr(result_path)+'); print(p.read_text() if p.is_file() else "PENDING")')
    polls=records[len(commands)+1:]
    for poll in polls:need(poll['body']==dict(command=['python3','-c',probe],timeout=5),'failed SSH exact result observation')
    need(all(r['response']['stdout'].strip()=='PENDING' for r in polls[:-1]),'failed SSH contradictory terminal results')
    failure=json.loads(polls[-1]['response']['stdout'])
    need(failure.get('schema')=='cloudbench-source-guest-v1' and failure.get('nonce')==request['nonce']
         and failure.get('guest_exit')==1 and isinstance(failure.get('error'),str)
         and type(failure.get('started_epoch')) is int and type(failure.get('finished_epoch')) is int
         and failure['started_epoch']<=failure['finished_epoch'],'failed SSH terminal failure')
    if 'job' not in failure:
        need(origin['helper_sha256']=='1928c061e13aaff097a9836d69b589d9dc93dc82634687484a936154051b10a1'
             and set(failure)=={'schema','nonce','guest_exit','error','started_epoch','finished_epoch'},
             'legacy guest job gap is not approved for this producer')
    else:
        need(failure['job']==job and failure.get('phase') in ('preconditions','fetch','source-transport','dependencies'),
             'failed SSH job/phase proof')
        observation=failure['preconditions']
        expected_fields={'euid','machine_id','data_mount','repo_physical','git_dir','env_present','guest_env_sha256'}
        need(set(observation) in (expected_fields,expected_fields|{'environment_contract'})
             and set(observation['env_present'])==ENV_KEYS and all(type(v) is bool for v in observation['env_present'].values())
             and set(observation['guest_env_sha256'])==ENV_KEYS
             and all(isinstance(v,str) and re.fullmatch('[a-f0-9]{64}',v) for v in observation['guest_env_sha256'].values()),
             'failed SSH safe precondition evidence')
    need(update['finished']<=starts[0]['started']<=records[0]['started']<=records[-1]['finished']
         <=stops[0]['started']<=park['started'],'failed SSH native execution/cleanup order')
    for read in reads:
        row=read['response']
        need(row['id']==before['id'] and row['name']==before['name'] and row['region']==before['region']
             and any(row['instance_id']==item['instance_id'] and row['config']==item['config'] for item in (before,ack,park['response']))
             and row['state'] in ('created','stopped','replacing','started','stopping'),'unknown failed SSH native observation')
    return park['response']


def prestart_failure(request_path, result_path, *, forensic_ssh=None):
    """Only accepted preparation CAS with no start, guest execution or snapshot."""
    request, predecessor = read_request(request_path)
    authority = resolve_bootstrap_ownership(request['ownership']['path'])
    result = load(result_path); directory = Path(result_path).absolute().parent
    need(result.get('schema') == RESULT and result.get('qualified') is False
         and result.get('credit_granted') is False and result.get('cleanup_complete') is False
         and described(result['request']) == request, 'original failed preparation required')
    need(not any((directory / name).exists() for name in
                 ('guest.json', 'after.json', 'source-manifest.json')), 'failure has guest/publication evidence')
    origin = described(result['origin'])
    need(origin.get('schema') == 'cloudbench-prepare-source-origin-v1'
         and described(origin['request']) == request and origin['nonce'] == request['nonce']
         and origin['source_ref'] == request['source_ref'] and origin['output'] == str(directory), 'failed producer binding')
    verify_producer(origin, Path(request['source_root']), request.get('transport', {}).get('replayed_tree', request['source_ref']))
    before = load(directory / 'before.json')
    need(before['id'] == predecessor['machine_id'] and before['instance_id'] == request['native']['instance_id']
         and before['config'] == authority['machine']['config']
         and sha(canonical(before['config'])) == request['native']['config_sha256'], 'original before authority')
    rows = verify_journal(result['journal'], predecessor['machine_id'], predecessor['volume_id'],
                          (predecessor['shared_machine_id'],), allow_pending_prestart_stop=True,
                          allow_rejected_bootstrap=True)
    own = '/machines/' + predecessor['machine_id']
    if request.get('guest_transport')=='cloudbench-ssh-guest-v1' and ((directory/'ssh').exists() or
            request.get('guest_env_mode')==OWNED_MODE and (directory/'capsule-ssh').exists()):
        parked=ssh_failure_proof(request,result,directory,origin,predecessor,before,rows,forensic_ssh)
        return request,predecessor,authority,before,parked
    updates = [row for row in rows if row['method'] == 'POST' and row['path'] == own]
    execs=[row for row in rows if row['method']=='POST' and row['path']==own+'/exec']
    starts=[row for row in rows if row['method']=='POST' and row['path']==own+'/start']
    stops=[row for row in rows if row['method']=='POST' and row['path']==own+'/stop']
    target = capsule_metadata(before['config'],request); target['image'] = request['image_ref']
    target['guest'] = dict(target['guest'], cpus=4, memory_mb=8192)
    need(updates, 'original preparation CAS absent')
    update = updates[0]; ack = update['response']
    need(update['body'] == dict(config=target, current_version=before['instance_id'], skip_launch=True)
         and ack.get('id') == before['id'] and ack.get('config') == target
         and ack.get('instance_id') and ack['instance_id'] != before['instance_id'], 'original accepted preparation CAS')
    candidates=[before,ack]
    if execs:
        need(len(execs)==len(starts)==len(stops)==1 and len(updates)==2 and result.get('stopped_verified') is True,
             'only one rejected bootstrap followed by verified parking may recover')
        command=next(delivery_commands(b'', '/tmp/cloudbench-prepare-delivery-'+request['nonce']))[0]
        need(execs[0].get('rejected') is True and execs[0]['body']==dict(command=command,timeout=5)
             and not stops[0].get('pending'), 'bootstrap rejection is not a proven first command')
        prestart=load(directory/'prestart.json')
        need(prestart['instance_id']==ack['instance_id'] and prestart['config']==target and prestart['state']=='stopped'
             and any(row['method']=='GET' and row['path']==own and row['response']==prestart
                     and update['finished']<=row['started']<=starts[0]['started'] for row in rows), 'original prestart wire')
        parked=copy.deepcopy(target);parked['guest']=copy.deepcopy(before['config']['guest'])
        park=updates[1]
        need(park['body']==dict(config=parked,current_version=ack['instance_id'],skip_launch=True)
             and park['response'].get('config')==parked and park['response'].get('id')==before['id']
             and park['response'].get('instance_id')
             and update['finished']<=starts[0]['started']<=execs[0]['started']<=stops[0]['started']<=park['started'],
             'original rejected-bootstrap cleanup CAS')
        candidates.append(park['response'])
        reads=[row['response'] for row in rows if row['method']=='GET' and row['path']==own and row['started']>park['finished']]
        need(reads and reads[-1]['state']=='stopped' and reads[-1]['config']==parked
             and reads[-1]['instance_id']==park['response']['instance_id'], 'original cleanup parked readback')
    else:
        need(len(updates)==1 and not starts and not (directory/'prestart.json').exists(), 'failure passed prestart boundary')
    need(all(row['method']=='GET' or row['path'] in (own,own+'/lease',own+'/stop',own+'/start',own+'/exec')
             for row in rows), 'failure journal has guest/snapshot or foreign effects')
    for row in rows:
        if row['method'] == 'GET' and row['path'] == own:
            observation = row['response']
            need(observation.get('id') == before['id'] and observation.get('name') == before['name']
                 and observation.get('region') == before['region']
                 and any(observation.get('instance_id')==item['instance_id'] and observation.get('config')==item['config']
                         for item in candidates)
                 and observation.get('state') in ('created','stopped','replacing','started','stopping')
                 and (execs or observation.get('state')!='started'), 'unknown original preparation observation')
    return request, predecessor, authority, before, candidates[-1]


def recovery_machine(api, request, predecessor, candidates, owned_volume):
    row = api.request('GET', '/machines/' + predecessor['machine_id'])
    need(any(row.get('instance_id') == item['instance_id'] and row.get('config') == item['config'] for item in candidates),
         'recovery native epoch/config is not original or acknowledged')
    need(row.get('state') in ('created', 'stopped'), 'recovery requires inactive source')
    metadata = row.get('config', {}).get('metadata', {})
    need(not any(key.startswith(('cloudbench_source_consumer_', 'cloudbench_source_retiring')) for key in metadata),
         'published/retiring source cannot recover bootstrap')
    row, volume = exact_machine(api, request, predecessor, row['config'], instance=row['instance_id'], observation=row)
    need(volume.get('name') == owned_volume['name'] and type(volume.get('size_gb')) is int
         and volume['size_gb'] == owned_volume['size_gb'] and volume.get('encrypted') is True
         and volume.get('state') == 'created', 'recovery owned Volume changed')
    return row, volume


def recover_bootstrap(request_path, failed_result_path, output, api_factory=None):
    old=load(failed_result_path);failed_directory=Path(failed_result_path).absolute().parent
    forensic=journal_index(failed_directory/'ssh') if 'ssh' not in old and (failed_directory/'ssh').is_dir() else None
    request, predecessor, authority, original, ack = prestart_failure(request_path, failed_result_path,forensic_ssh=forensic)
    output = Path(output).absolute(); output.mkdir(mode=0o700)
    nonce = secrets.token_hex(16)
    result = dict(schema=RECOVERY, nonce=nonce, qualified=False, credit_granted=False, cleanup_complete=False,
                  recovered=False, original_creator=authority.get('original_creator',descriptor(request['ownership']['path'])),
                  original_request=descriptor(request_path), failed_result=descriptor(failed_result_path))
    result['filesystem_untrusted']=True
    intent=dict(schema='cloudbench-bootstrap-recovery-intent-v1',nonce=nonce,original_request=result['original_request'],
                failed_result=result['failed_result'],original_creator=result['original_creator'],
                legacy_unsealed_ssh=forensic is not None,forensic_ssh=forensic)
    save(output/'intent.json',intent);result['intent']=descriptor(output/'intent.json')
    if forensic is not None:result.update(legacy_unsealed_ssh=True,forensic_ssh=forensic)
    origin = dict(schema='cloudbench-recovery-origin-v1', nonce=nonce, output=str(output),
                  helper_sha256=sha((HERE/'cloudbench-prepare-source.py').read_bytes()), dependencies=dependency_seals(),
                  source_ref=subprocess.check_output(['git','-C',str(HERE.parent),'rev-parse','HEAD'],text=True).strip(),
                  producer=dict(pid=os.getpid(), birth=runpy.run_path(str(HERE/'process-identity.py'))['linux_identity'](os.getpid()),
                                argv_sha256=sha(Path('/proc/self/cmdline').read_bytes())))
    save(output/'origin.json', origin); result['origin']=descriptor(output/'origin.json')
    try:
        if api_factory is None:
            need(os.environ.get('FLY_API_TOKEN'), 'FLY_API_TOKEN required')
            api = ScopedNative(CAPTURE['Fly'](predecessor['app'], os.environ['FLY_API_TOKEN']), output/'native', request, predecessor)
        else:
            api = api_factory(output/'native', request, predecessor)
        with api.lease():
            candidates=(ack,) if request.get('guest_transport')=='cloudbench-ssh-guest-v1' else (original,ack)
            before, volume = recovery_machine(api, request, predecessor, candidates, authority['intent']['volume_request'])
            save(output/'before.json',before)
            parked = copy.deepcopy(before['config']); parked['guest'] = copy.deepcopy(original['config']['guest'])
            answer = api.request('POST','/machines/'+predecessor['machine_id'],
                                 dict(config=parked,current_version=before['instance_id'],skip_launch=True))
            need(answer.get('id') == before['id'] and answer.get('config') == parked
                 and answer.get('instance_id'), 'recovery parking CAS acknowledgement')
            after, volume = wait_state(api, request, predecessor, parked, 'stopped', answer['instance_id'],
                                       time.monotonic()+120, prior=before)
            after, volume = recovery_machine(api, request, predecessor, (after,), authority['intent']['volume_request'])
            save(output/'after.json',after); save(output/'volume.json',volume)
        result.update(recovered=True, before=descriptor(output/'before.json'), after=descriptor(output/'after.json'),
                      volume=descriptor(output/'volume.json'))
    finally:
        result['journal']=journal_index(output/'native')
        save(output/'result.json',result)
    verify_recovered_bootstrap(output/'result.json')
    return result


def verify_recovered_bootstrap(result_path):
    """Pure authority for a fresh preparation; never benchmark qualification."""
    result=load(result_path)
    need(result.get('schema')==RECOVERY and result.get('recovered') is True and result.get('qualified') is False
         and result.get('credit_granted') is False and result.get('cleanup_complete') is False
         and re.fullmatch('[a-f0-9]{32}',result.get('nonce','')), 'recovered bootstrap receipt required')
    request_path=result['original_request']['path']; failed_path=result['failed_result']['path']
    described(result['original_request']); described(result['failed_result'])
    forensic=result.get('forensic_ssh')
    request, predecessor, authority, original, ack=prestart_failure(request_path,failed_path,forensic_ssh=forensic)
    if request.get('guest_transport')=='cloudbench-ssh-guest-v1':
        need('intent' in result and result.get('filesystem_untrusted') is True,'failed SSH recovery requires explicit untrusted filesystem intent')
    if 'intent' in result:
        intent=described(result['intent'])
        need(intent==dict(schema='cloudbench-bootstrap-recovery-intent-v1',nonce=result['nonce'],
              original_request=result['original_request'],failed_result=result['failed_result'],original_creator=result['original_creator'],
              legacy_unsealed_ssh=forensic is not None,forensic_ssh=forensic)
             and result.get('filesystem_untrusted') is True,'recovery before-effects intent/filesystem trust')
    if forensic is not None:
        need(result.get('legacy_unsealed_ssh') is True and 'intent' in result,'legacy forensic custody is not original SSH seal')
    need(result['original_creator']==authority.get('original_creator',descriptor(request['ownership']['path'])) and result['nonce'] != request['nonce'],
         'original creator recovery link/new nonce')
    origin=described(result['origin'])
    need(origin.get('schema')=='cloudbench-recovery-origin-v1' and origin['nonce']==result['nonce']
         and origin['output']==str(Path(result_path).absolute().parent)
         and type(origin['producer']['pid']) is int and origin['producer']['pid'] > 1
         and origin['producer']['birth'] and re.fullmatch('[a-f0-9]{64}', origin['producer']['argv_sha256']),
         'recovery producer origin')
    verify_producer(origin,HERE.parent,origin['source_ref'])
    before,after,volume=(described(result[key]) for key in ('before','after','volume'))
    candidates=(ack,) if request.get('guest_transport')=='cloudbench-ssh-guest-v1' else (original,ack)
    need(any(before['instance_id']==item['instance_id'] and before['config']==item['config'] for item in candidates),
         'recovery before version')
    need(before['id']==original['id'] and before['name']==original['name'] and before['region']==original['region']
         and before['state'] in ('created','stopped'), 'recovery inactive before identity')
    parked=copy.deepcopy(before['config']);parked['guest']=copy.deepcopy(original['config']['guest'])
    need(after['id']==before['id']==predecessor['machine_id'] and after['name']==original['name']
         and after['region']==original['region'] and after['state']=='stopped' and after['config']==parked
         and volume['id']==predecessor['volume_id'] and volume['attached_machine_id']==after['id']
         and volume['state']=='created' and volume.get('encrypted') is True
         and volume.get('name')==authority['intent']['volume_request']['name']
         and volume.get('region')==original['region'] and type(volume.get('size_gb')) is int
         and volume['size_gb']==authority['intent']['donor']['size_gb'], 'recovered parked identity')
    need(not any(key.startswith(('cloudbench_source_consumer_','cloudbench_source_retiring')) for key in parked['metadata']),
         'recovered source was published/retiring')
    rows=verify_journal(result['journal'],predecessor['machine_id'],predecessor['volume_id'],(),versioned=True)
    own='/machines/'+predecessor['machine_id']
    need(all(row['method']=='GET' and row['path'] in (own,'/volumes/'+predecessor['volume_id'])
             or row['path']==own+'/lease' or row['method']=='POST' and row['path']==own for row in rows),
         'recovery journal escaped parking-only scope')
    updates=[row for row in rows if row['method']=='POST' and row['path']==own]
    need(len(updates)==1 and updates[0]['body']==dict(config=parked,current_version=before['instance_id'],skip_launch=True)
         and updates[0]['response']['config']==parked and updates[0]['response']['instance_id']==after['instance_id'],
         'recovery original parking CAS wire')
    reads=[row for row in rows if row['method']=='GET' and row['path']==own]
    volumes=[row for row in rows if row['method']=='GET' and row['path']=='/volumes/'+predecessor['volume_id']]
    need(reads and reads[0]['response']==before and reads[-1]['response']==after
         and volumes and volumes[-1]['response']==volume, 'recovery original readback wire')
    value=copy.deepcopy(authority);value.update(machine=after,volume=volume,original_creator=result['original_creator'])
    return value


def build_request(ownership, build, source_root, source_ref, guest_env_contract, protected_resources, output, transport=None,guest_env_capsule=None):
    """Canonical mutation-free request producer from creator authority and explicit env expectations."""
    authority = resolve_bootstrap_ownership(Path(ownership))
    machine = authority['machine']; config = machine['config']
    root = Path(source_root).absolute()
    need(subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True, timeout=10).strip() == source_ref,
         'request checkout must be exact source ref')
    subprocess.run(['git', '-C', str(root), 'diff', '--quiet', source_ref, '--', *IMAGE_INPUTS], check=True, timeout=20)
    transport_value = load(transport) if transport else None
    effective_ref = transport_value['replayed_tree'] if transport_value else source_ref
    script = source_bytes(root, effective_ref, 'lib/cloudbench-env.sh')
    command = 'source "$1"\ncloudbench_node_dependency_fingerprint "$2"\ncloudbench_manifest_fingerprint "$2" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"\n'
    with tempfile.NamedTemporaryFile(prefix='cloudbench-fingerprint-', suffix='.sh') as snapshot:
        os.fchmod(snapshot.fileno(), 0o600)
        snapshot.write(script); snapshot.flush()
        fingerprints = subprocess.check_output(['bash', '-euc', command, 'prepare-source-request', snapshot.name, str(root)], text=True, timeout=20).splitlines()
    need(len(fingerprints) == 2, 'source fingerprints unavailable')
    value = dict(schema=REQUEST, nonce=transport_value['token'] if transport_value else secrets.token_hex(16), source_root=str(root), source_ref=source_ref,
                 guest_transport='cloudbench-ssh-guest-v1',
                 image_ref=load(build)['image_ref'], node_fingerprint=fingerprints[0], python_fingerprint=fingerprints[1],
                 ownership=descriptor(ownership), build=descriptor(build),
                 native=dict(machine_id=machine['id'], volume_id=authority['volume']['id'], instance_id=machine['instance_id'],
                             config_sha256=sha(canonical(config)), env_sha256=sha(canonical(config.get('env') or {}))),
                 guest_env_sha256=load(guest_env_contract), protected_resources=load(protected_resources),
                 scripts={member: sha(source_bytes(root, effective_ref, member))
                          for member in ('cloudbench-fetch-ref.sh', 'lib/cloudbench-env.sh', 'cloudbench-sync-deps.sh', *(['cloudbench-prepare-patch.sh'] if transport_value else []))})
    if transport_value:
        value['transport'] = transport_value
    if guest_env_capsule is not None:
        value.update(guest_env_mode=OWNED_MODE,guest_env_capsule=descriptor(guest_env_capsule))
        value['scripts']['cloudbench-source-env.py']=sha(source_bytes(root,effective_ref,'cloudbench-source-env.py'))
    save(Path(output).absolute(), value)
    read_request(output)  # Run the identical execution preflight before publishing a usable request.
    return value


def main():
    def interrupted(signum, _frame):
        raise InterruptedError('preparation/recovery interrupted')
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    if len(sys.argv)>1 and sys.argv[1]=='recover-bootstrap':
        parser=argparse.ArgumentParser(description='Repark only a proven accepted-CAS prestart failure; no task credit.')
        parser.add_argument('--request',type=Path,required=True)
        parser.add_argument('--failed-result',type=Path,required=True)
        parser.add_argument('--output',type=Path,required=True)
        args=parser.parse_args(sys.argv[2:]);os.umask(0o077)
        try:recover_bootstrap(args.request,args.failed_result,args.output)
        except BaseException as error:
            print('private source recovery failed: '+type(error).__name__,file=sys.stderr);return 1
        print(str(args.output/'result.json'));return 0
    if len(sys.argv) > 1 and sys.argv[1] == 'request':
        parser = argparse.ArgumentParser(description=build_request.__doc__)
        for name in ('ownership', 'build', 'source-root', 'guest-env-contract', 'protected-resources', 'output'):
            parser.add_argument('--' + name, type=Path, required=True)
        parser.add_argument('--source-ref', required=True)
        parser.add_argument('--transport', type=Path)
        parser.add_argument('--guest-env-capsule',type=Path)
        args = parser.parse_args(sys.argv[2:])
        os.umask(0o077)
        try:
            build_request(args.ownership, args.build, args.source_root, args.source_ref,
                          args.guest_env_contract, args.protected_resources, args.output, args.transport,args.guest_env_capsule)
        except Exception as error:
            print('private source request failed: ' + type(error).__name__, file=sys.stderr)
            return 1
        print(str(args.output))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(signum, _frame):
        raise InterruptedError('preparation interrupted')
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        prepare(args.request, args.output)
    except BaseException as error:
        print('private source preparation failed: ' + type(error).__name__, file=sys.stderr)
        return 1
    print(str(args.output / 'result.json'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
