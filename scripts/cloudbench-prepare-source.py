#!/usr/bin/env python3
"""Prepare one previously owned private fleet source, without app environment writes.

Private request -> exact leased Machine/image -> bounded guest fetch/attestation
-> stopped Volume snapshot -> existing cloudbench-source.py v1 consumer contract.
No create, delete, dependency installation, shared-donor mutation or task credit.
The coordinator supplies admission and owns any live invocation.
"""
from __future__ import annotations

import argparse
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
PROTECTED = frozenset({'683e47df5094d8', '811d632f2650e8'})
PROTECTED_RESOURCES = {'683e47df5094d8': 'vol_vwnym366kn7k8mmv',
                       '811d632f2650e8': 'vol_r1jde9donnx2mn9r'}
ENV_KEYS = frozenset({'AGENTS_ENV_B64', 'BACKEND_ENV_B64'})
IMAGE_INPUTS = ('Dockerfile.cloudbench-warm', 'fly.cloudbench-warm.toml', '.dockerignore',
                'package.json', 'package-lock.json', '.npmrc', 'back-end/package.json',
                'back-end/package-lock.json', 'back-end/prisma', 'front-end', 'agents/package.json',
                'agents/requirements.txt', 'agents/vendor', 'scripts/cloudbench-install-image-deps.sh',
                'scripts/cloudbench-install-ngrok.sh', 'scripts/cloudbench-install-pgvector.sh')
DEPENDENCIES = ('cloudbench-source.py', 'cloudbench-volume-migration.py', 'cloudbench-machine-readiness.py',
                'cloudbench-select-snapshot.py', 'cloudbench-archived-machine-reuse.py',
                'cloudbench-archived-reuse-effects.py', 'cloudbench-original600-runner.py',
                'cloudbench-original-volume-capture.py', 'cloudbench-disposable-controller.py',
                'cloudbench-prepare-source-create.py', 'process-identity.py')


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


def read_request(path):
    value = load(path)
    need(value.get('schema') == REQUEST, 'request schema')
    fields = {'schema', 'nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'image_ref',
              'source_root', 'native', 'guest_env_sha256', 'protected_resources', 'scripts', 'build'}
    base_fields = set(value) - {'transport'}
    need(base_fields == fields | {'ownership'}, 'fresh unpublished creator authority required; published sources are immutable')
    for key, pattern in [('nonce', '[a-f0-9]{32}'), ('source_ref', '[a-f0-9]{40}'),
                         ('node_fingerprint', '[a-f0-9]{64}'), ('python_fingerprint', '[a-f0-9]{64}')]:
        need(isinstance(value.get(key), str) and re.fullmatch(pattern, value[key]), key)
    need(re.fullmatch(r'registry\.fly\.io/navi-whisper-lux-bench[^\s]*@sha256:[a-f0-9]{64}',
                      value.get('image_ref', '')), 'immutable app image')
    if 'ownership' in value:
        described(value['ownership'])
        creator = runpy.run_path(str(HERE / 'cloudbench-prepare-source-create.py'))
        authority = creator['verify_created_source'](Path(value['ownership']['path']))
        machine, donor = authority['machine'], authority['donor']
        proof = donor['dependency_proof']
        need(machine['config']['metadata'].get('cloudbench_source_protocol') == 'cloudbench-source-lease-v1'
             and machine['config']['metadata'].get('cloudbench_source_create_nonce') == authority['intent']['nonce'],
             'versioned native source lease protocol required')
        predecessor = dict(version=2, lease_protocol='cloudbench-source-lease-v1', creation_nonce=authority['intent']['nonce'],
                           app='navi-whisper-lux-bench', owner_token=authority['intent']['binding']['owner_token'],
                           machine_id=machine['id'], instance_id=machine['instance_id'], machine_name=machine['name'],
                           volume_id=authority['volume']['id'], region=machine['region'],
                           image_digest=machine['config']['image'].rsplit('@', 1)[1], snapshot_id=donor['snapshot']['id'],
                           node_fingerprint=proof['node_fingerprint'], python_fingerprint=proof['python_fingerprint'],
                           verified_at=proof['verified_at'], shared_machine_id=donor['machine_id'], shared_volume_id=donor['volume_id'])
        SOURCE['manifest'](canonical(predecessor))
    else:
        predecessor = SOURCE['manifest'](canonical(described(value['predecessor'])))
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
    need(set(value['guest_env_sha256']) == ENV_KEYS
         and all(re.fullmatch('[a-f0-9]{64}', item) for item in value['guest_env_sha256'].values()),
         'expected effective guest environment hashes')
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
            self.lease_end = time.monotonic() + 150
        except BaseException:
            self.lost = True
            raise

    def request(self, method, url, body=None, *, timeout=20, direct=False):
        if self.nonce and time.monotonic() + timeout + 55 >= self.lease_end:
            self.renew()
        return super().request(method, url, body, timeout=timeout, direct=direct)

    @contextmanager
    def lease(self):
        response = self._lease_wire('POST', '/machines/' + self.mid + '/lease',
                                    {'ttl': 180, 'description': 'private source preparation'})
        self.nonce = response.get('data', {}).get('nonce')
        need(isinstance(self.nonce, str) and self.nonce, 'lease nonce absent')
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


def exact_machine(api, request, predecessor, config, *, state=None, instance=None):
    value = api.request('GET', '/machines/' + request['native']['machine_id'])
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
    return value, volume


def wait_state(api, request, predecessor, config, state, instance, deadline):
    while time.monotonic() < deadline:
        machine, volume = exact_machine(api, request, predecessor, config, instance=instance)
        if machine.get('state') == state:
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
    return '''import base64,hashlib,json,os,pathlib,subprocess,time
r=REQUEST
directory=pathlib.Path('/tmp/cloudbench-prepare-source-'+r['nonce'])
directory.mkdir(mode=0o700)
def save(name,value):
 with open(directory/name,'x') as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
started=int(time.time())
job=dict(pid=os.getpid(),birth=pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19],boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
try:
 assert os.geteuid()==0 and os.environ['FLY_MACHINE_ID']==r['machine_id']
 assert os.path.ismount('/data') and pathlib.Path('/data/repo').resolve()==pathlib.Path('/data/repo')
 assert pathlib.Path('/data/repo/.git').is_dir()
 for name,raw in FILES.items():
  p=directory/name;p.parent.mkdir(mode=0o700,exist_ok=True);p.write_bytes(base64.b64decode(raw))
 env={k:os.environ[k] for k in ('PATH','HOME','GITHUB_TOKEN','AGENTS_ENV_B64','BACKEND_ENV_B64','FLY_MACHINE_ID') if k in os.environ}
 assert all(env.get(k) and hashlib.sha256(env[k].encode()).hexdigest()==v for k,v in r['guest_env_sha256'].items())
 # Use the existing inherited app credential in a process environment, never argv.
 if not env.get('CLOUDBENCH_GITHUB_TOKEN_B64') and env.get('GITHUB_TOKEN'):
  env['CLOUDBENCH_GITHUB_TOKEN_B64']=base64.b64encode(env['GITHUB_TOKEN'].encode()).decode()
 with open(directory/'fetch.private.log','x') as log:
  fetch_ref=r['transport']['base_sha'] if r['transport'] else r['source_ref']
  subprocess.run(['bash',str(directory/'cloudbench-fetch-ref.sh'),'/data/repo',fetch_ref],env=env,stdout=log,stderr=log,check=True,timeout=300)
 ref=subprocess.check_output(['git','-c','safe.directory=/data/repo','-C','/data/repo','rev-parse','HEAD'],text=True).strip()
 transport=None
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
 assert fps==[r['node_fingerprint'],r['python_fingerprint']]
 image_cmd='source '+str(directory/'lib/cloudbench-env.sh')+'; cloudbench_node_dependency_fingerprint /app; cloudbench_manifest_fingerprint /app "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"'
 image_fps=subprocess.check_output(['bash','-euc',image_cmd],text=True).splitlines();assert image_fps==fps
 # Persist the normal matching-image copy on the private Volume. An ephemeral
 # overlay would disappear before snapshot, and online rebuild is forbidden.
 env.update(CLOUDBENCH_REBUILD_DEPS='0',CLOUDBENCH_DEPENDENCY_OVERLAY='0',CLOUDBENCH_ENV_HELPER=str(directory/'lib/cloudbench-env.sh'))
 with open(directory/'sync-deps.private.log','x') as log:
  subprocess.run(['bash',str(directory/'cloudbench-sync-deps.sh'),'/app','/data/repo'],env=env,stdout=log,stderr=log,check=True,timeout=1800)
 observed=dict(schema='cloudbench-source-guest-v1',nonce=r['nonce'],source_ref=ref,machine_id=os.environ['FLY_MACHINE_ID'],node_fingerprint=fps[0],python_fingerprint=fps[1],installed_node=pathlib.Path('/data/repo/node_modules/.cloudbench-deps-fingerprint').read_text().strip(),installed_python=pathlib.Path('/data/repo/agents/venv/.cloudbench-deps-fingerprint').read_text().strip(),guest_env_sha256={k:hashlib.sha256(os.environ[k].encode()).hexdigest() for k in r['guest_env_sha256']},mount='/data',guest_exit=0,started_epoch=started,finished_epoch=int(time.time()),job=job)
 subprocess.run(['sync','-f','/data'],check=True)
 if transport is not None:observed['transport']=transport
 observed['image_node_fingerprint']=image_fps[0];observed['image_python_fingerprint']=image_fps[1]
 save('result.json',observed)
except BaseException as error:
 save('result.json',dict(schema='cloudbench-source-guest-v1',nonce=r['nonce'],guest_exit=1,error=type(error).__name__,started_epoch=started,finished_epoch=int(time.time())))
'''.replace('REQUEST', repr(minimal), 1).replace('FILES', repr(files), 1)


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


def guest_job(api, request, deadline):
    mid = request['native']['machine_id']
    directory = '/tmp/cloudbench-prepare-delivery-' + request['nonce']
    for command, expected in delivery_commands(guest_program(request).encode(), directory):
        need(time.monotonic() < deadline, 'guest delivery deadline')
        ack = api.request('POST', '/machines/' + mid + '/exec', dict(command=command, timeout=5))
        need(ack.get('exit_code') == 0 and ack.get('stdout', '').strip() == expected, 'guest delivery acknowledgement')
    # Explicit fork: the API exec itself exits quickly; the job has one immutable nonce path.
    launcher = job_launcher(Path(directory) / 'worker.py')
    ack = api.request('POST', '/machines/' + mid + '/exec',
                      dict(command=['python3', '-c', launcher], timeout=5))
    need(ack.get('exit_code') == 0, 'guest job launch not acknowledged')
    job = json.loads(ack.get('stdout', ''))
    need(type(job.get('pid')) is int and job['pid'] > 1, 'guest job PID absent')
    result_path = '/tmp/cloudbench-prepare-source-' + request['nonce'] + '/result.json'
    probe = ('import pathlib; p=pathlib.Path(' + repr(result_path) + '); '
             'print(p.read_text() if p.is_file() else "PENDING")')
    while time.monotonic() < deadline:
        value = api.request('POST', '/machines/' + mid + '/exec',
                            dict(command=['python3', '-c', probe], timeout=5))
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


def verify_journal(value, mid, vid, shared, *, request=None, before=None, after=None, guest=None, successor=None, prestart=None):
    actual = journal_index(value['path'])
    need(actual == value, 'native journal changed')
    rows = []
    for member in actual['files']:
        if member.endswith('/request.json'):
            path = Path(value['path']) / member
            sent = load(path)
            need((path.parent / 'result.json').is_file(), 'native call has unknown outcome')
            need(sent['app'] == 'navi-whisper-lux-bench', 'native app escaped scope')
            raw_paths = list(path.parent.glob('*-wire.json'))
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
    nonce = None; expiry = 0; released = False
    for row in rows:
        need(not released and row['started'] <= row['finished'], 'native call order after release')
        sent_nonce = row['headers'].get('fly-machine-lease-nonce')
        if row['method'] == 'POST' and row['path'] == '/machines/' + mid + '/lease':
            need(row['body'] == {'ttl': 180, 'description': 'private source preparation'}, 'lease request changed')
            acquired = row['response'].get('data', {}).get('nonce')
            need(isinstance(acquired, str) and acquired and (nonce is None or acquired == nonce), 'lease response nonce')
            need(sent_nonce == nonce and (nonce is None or row['finished'] < expiry), 'lease renewal ownership/expiry')
            nonce = acquired; expiry = row['started'] + 180_000_000_000
        elif row['method'] != 'GET':
            need(nonce and sent_nonce == nonce and row['finished'] < expiry, 'native effect without valid lease')
            if row['method'] == 'DELETE':
                released = True
    need(released, 'native lease not released')
    if request is not None:
        own = '/machines/' + mid
        updates = [row for row in rows if row['method'] == 'POST' and row['path'] == own]
        need(len(updates) == 2, 'exact prepare and park updates required')
        expected_config = copy.deepcopy(before['config']); expected_config['image'] = request['image_ref']
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
        final_reads = [row['response'] for row in rows if row['method'] == 'GET' and row['path'] == own
                       and row['started'] > snapshots[0]['finished']]
        need(final_reads and final_reads[-1] == after, 'final native state original response')
    return rows


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
    def cleanup():
        if not armed:
            return
        try:
            current = api.request('GET', '/machines/' + predecessor['machine_id'])
            need(current.get('id') == predecessor['machine_id']
                 and current.get('name') == predecessor['machine_name']
                 and current.get('config') in (original_config, config), 'cleanup native identity changed')
            active_config = current['config']
            if current.get('state') != 'stopped':
                api.request('POST', '/machines/' + predecessor['machine_id'] + '/stop', {})
            wait_state(api, request, predecessor, active_config, 'stopped', current['instance_id'], time.monotonic() + 60)
            parked_config = copy.deepcopy(active_config)
            parked_config['guest'] = copy.deepcopy(original_config['guest'])
            if parked_config != active_config:
                parked = api.request('POST', '/machines/' + predecessor['machine_id'],
                                     dict(config=parked_config, current_version=current['instance_id'], skip_launch=True))
                wait_state(api, request, predecessor, parked_config, 'stopped', parked['instance_id'], time.monotonic() + 60)
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
            armed = True
            config['image'] = request['image_ref']
            config['guest'] = dict(config['guest'], cpus=4, memory_mb=8192)
            ack = api.request('POST', '/machines/' + predecessor['machine_id'],
                              dict(config=config, current_version=before['instance_id'], skip_launch=True))
            instance = ack.get('instance_id')
            need(instance, 'native update version acknowledgement absent')
            prestart, _ = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120)
            save(output / 'prestart.json', prestart)
            api.request('POST', '/machines/' + predecessor['machine_id'] + '/start', {})
            wait_state(api, request, predecessor, config, 'started', instance, time.monotonic() + 120)
            guest = guest_job(api, request, time.monotonic() + 2160)
            save(output / 'guest.json', guest)
            api.request('POST', '/machines/' + predecessor['machine_id'] + '/stop', {})
            after, volume = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120)
            config['guest'] = copy.deepcopy(original_config['guest'])
            parked = api.request('POST', '/machines/' + predecessor['machine_id'],
                                 dict(config=config, current_version=instance, skip_launch=True))
            instance = parked.get('instance_id')
            need(instance, 'park version acknowledgement absent')
            after, volume = wait_state(api, request, predecessor, config, 'stopped', instance, time.monotonic() + 120)
            snapshot_ack = api.request('POST', '/volumes/' + predecessor['volume_id'] + '/snapshots', {})
            snapshot_id = snapshot_ack.get('id')
            need(isinstance(snapshot_id, str) and re.fullmatch('vs_[A-Za-z0-9]+', snapshot_id), 'exact created snapshot ID')
            successor = dict(predecessor, instance_id=after['instance_id'], image_digest=request['image_ref'].rsplit('@', 1)[1],
                             snapshot_id=snapshot_id, verified_at=guest['finished_epoch'],
                             node_fingerprint=request['node_fingerprint'], python_fingerprint=request['python_fingerprint'])
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
    except BaseException as error:
        # A failed lease or ambiguous native update never grants guessed cleanup rights.
        result.update(error=type(error).__name__)
        result.setdefault('stopped_verified', False)
        raise
    finally:
        result['finished_epoch'] = int(time.time())
        result['journal'] = journal_index(output / 'native')
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
    for key in set(successor) - {'instance_id', 'image_digest', 'snapshot_id', 'verified_at', 'node_fingerprint', 'python_fingerprint'}:
        need(successor[key] == predecessor[key], 'successor ownership changed: ' + key)
    need(successor['image_digest'] == image_ref.rsplit('@', 1)[1], 'successor image digest')
    need(successor['node_fingerprint'] == node_fingerprint and successor['python_fingerprint'] == python_fingerprint,
         'successor dependency set')
    before, after = described(result['before']), described(result['after'])
    need(before['instance_id'] == predecessor['instance_id']
         and sha(canonical(before['config'])) == request['native']['config_sha256'], 'original native source')
    expected_config = copy.deepcopy(before['config']); expected_config['image'] = image_ref
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
                   request=request, before=before, after=after, guest=guest, successor=successor, prestart=prestart)
    return successor


def build_request(ownership, build, source_root, source_ref, guest_env_contract, protected_resources, output, transport=None):
    """Canonical mutation-free request producer from creator authority and explicit env expectations."""
    creator = runpy.run_path(str(HERE / 'cloudbench-prepare-source-create.py'))
    authority = creator['verify_created_source'](Path(ownership))
    machine = authority['machine']; config = machine['config']
    root = Path(source_root).absolute()
    need(subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True, timeout=10).strip() == source_ref,
         'request checkout must be exact source ref')
    subprocess.run(['git', '-C', str(root), 'diff', '--quiet', source_ref, '--', *IMAGE_INPUTS], check=True, timeout=20)
    transport_value = load(transport) if transport else None
    effective_ref = transport_value['replayed_tree'] if transport_value else source_ref
    script = source_bytes(root, effective_ref, 'lib/cloudbench-env.sh').decode()
    command = script + '\ncloudbench_node_dependency_fingerprint "$1"\ncloudbench_manifest_fingerprint "$1" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"\n'
    fingerprints = subprocess.check_output(['bash', '-euc', command, 'prepare-source-request', str(root)], text=True, timeout=20).splitlines()
    need(len(fingerprints) == 2, 'source fingerprints unavailable')
    value = dict(schema=REQUEST, nonce=transport_value['token'] if transport_value else secrets.token_hex(16), source_root=str(root), source_ref=source_ref,
                 image_ref=load(build)['image_ref'], node_fingerprint=fingerprints[0], python_fingerprint=fingerprints[1],
                 ownership=descriptor(ownership), build=descriptor(build),
                 native=dict(machine_id=machine['id'], volume_id=authority['volume']['id'], instance_id=machine['instance_id'],
                             config_sha256=sha(canonical(config)), env_sha256=sha(canonical(config.get('env') or {}))),
                 guest_env_sha256=load(guest_env_contract), protected_resources=load(protected_resources),
                 scripts={member: sha(source_bytes(root, effective_ref, member))
                          for member in ('cloudbench-fetch-ref.sh', 'lib/cloudbench-env.sh', 'cloudbench-sync-deps.sh', *(['cloudbench-prepare-patch.sh'] if transport_value else []))})
    if transport_value:
        value['transport'] = transport_value
    save(Path(output).absolute(), value)
    read_request(output)  # Run the identical execution preflight before publishing a usable request.
    return value


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'request':
        parser = argparse.ArgumentParser(description=build_request.__doc__)
        for name in ('ownership', 'build', 'source-root', 'guest-env-contract', 'protected-resources', 'output'):
            parser.add_argument('--' + name, type=Path, required=True)
        parser.add_argument('--source-ref', required=True)
        parser.add_argument('--transport', type=Path)
        args = parser.parse_args(sys.argv[2:])
        os.umask(0o077)
        try:
            build_request(args.ownership, args.build, args.source_root, args.source_ref,
                          args.guest_env_contract, args.protected_resources, args.output, args.transport)
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
