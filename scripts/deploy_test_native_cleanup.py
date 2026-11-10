"""Read-only, launch-only reconciliation of sealed native cloud fleet cleanup."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import time

KIND = 'native-cloud-cleanup-v1'
ISOLATED_RENEWAL_PHASES = frozenset({'triage', 'needs-focused-plan', 'failed-gates'})

# Bound raw run evidence per proof; ordinary receipts retain their existing limit.
MAX_RAW_FORENSIC_RUN_BYTES = 128 * 1024 * 1024

# A fleet's own _batch/run.json carries every message and log of its run: a mass-agent record was
# 98 MB on 2026-11-07, beyond the 64 MiB receipt cap, so its verified cleanup could never be bound
# and every later smoke launch was refused. Run records get their own, still finite, cap.
RUN_RECORD_MAX_BYTES = 512 * 1024 * 1024


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


def fleet_audit_root(root):
    return fleet_git_common(root) / 'cloudbench-fleet-audits'


def fleet_ownership_root(root):
    return fleet_git_common(root) / 'cloudbench-fleet-ownership'


def need(value, message):
    if not value:
        raise ValueError('native cleanup: ' + message)


def fields(raw):
    rows = [line.partition('=') for line in raw.decode().splitlines()]
    need(all(k and sep for k, sep, _ in rows) and len({r[0] for r in rows}) == len(rows), 'invalid fields')
    return {k: v for k, _, v in rows}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def recovered_roots(path, bench, bound):
    """Replay the producer's sealed-tree, provider and terminal payment guards."""
    native = runpy.run_path(str(Path(__file__).with_name('cloudbench-exact-session-cleanup.py')))
    batch = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'agents/benchmarks/cloud_batch_cleanup.py'))
    run = json.loads(bound(path))
    tasks = run['tasks']
    need(isinstance(tasks, list) and len(tasks) == 1 and tasks[0]['name'] == bench, 'recovered run inventory')
    task = tasks[0]
    root = task['agent_id']
    need(isinstance(root, str) and native['SAFE_AGENT'].fullmatch(root)
         and task.get('graded_root_creation_outcome') == 'allocated', 'recovered root identity')
    owned = task['owned_roots']
    need(isinstance(owned, list) and owned and len({r['root_agent_id'] for r in owned}) == len(owned)
         and root in {r['root_agent_id'] for r in owned}, 'owned root closure')
    for row in owned:
        aid, logs = row['root_agent_id'], row['logs']
        need(row.get('role') in {'fixture_first_run', 'graded'}
             and row.get('creation') == {'source': 'create_agent_return', 'root_agent_id': aid}
             and isinstance(logs, dict) and (row['role'] != 'graded' or aid == root)
             and (aid != root or row['role'] == 'graded'), 'native root custody')
        snapshot = logs.get('fixture_snapshot')
        need(not isinstance(snapshot, dict) or (snapshot.get('agent') or {}).get('id') in {None, aid},
             'root fixture custody')
        need(isinstance(aid, str) and native['SAFE_AGENT'].fullmatch(aid)
             and row['task_name'] == bench, 'owned root identity')
        if aid == root:
            need(all(logs[k] == task['logs'][k] for k in
                     ('cloud_cleanup_evidence', 'cloud_provider_cleanup', 'cloud_payment_cleanup')), 'primary root evidence')
        evidence, provider, payment = (logs[k] for k in
                                       ('cloud_cleanup_evidence', 'cloud_provider_cleanup', 'cloud_payment_cleanup'))
        need(evidence['root_agent_id'] == provider['root_agent_id'] == payment['root_agent_id'] == aid
             and provider['root_deleted'] is True and provider['tree_sealed'] is True, 'root cleanup authority')
        sessions = set()
        for phase in ('before', 'after', 'final'):
            snapshot = evidence[phase]
            tree = snapshot['tree_agent_ids']
            need(snapshot['root_exists'] is True and isinstance(tree, list) and aid in tree
                 and len(set(tree)) == len(tree) and all(isinstance(x, str) and native['SAFE_AGENT'].fullmatch(x) for x in tree)
                 and isinstance(snapshot['browser_sessions'], list), 'root database snapshot')
            if phase != 'before':
                need(snapshot['root_deleted'] is True and snapshot['unsealed_tree_agent_ids'] == [], 'root tree seal')
            for session in snapshot['browser_sessions']:
                need(session['agent_id'] in tree and session['provider'] in native['RELEASED_STATUSES']
                     and isinstance(session['session_id'], str) and native['SAFE_SESSION'].fullmatch(session['session_id']),
                     'root session ownership')
                sessions.add((session['provider'], session['session_id']))
        after, final = evidence['after'], evidence['final']
        need(evidence['before']['root_user_id'] == after['root_user_id'] == final['root_user_id']
             and isinstance(final['root_user_id'], str) and native['SAFE_AGENT'].fullmatch(final['root_user_id']),
             'root database owner')
        need({k: v for k, v in after.items() if k != 'purchase_cleanup'}
             == {k: v for k, v in final.items() if k != 'purchase_cleanup'}, 'sealed tree drift')
        receipts = provider['provider_receipts']
        need(isinstance(receipts, list) and receipts == evidence['provider_receipts']
             and [(r['provider'], r['session_id']) for r in receipts] == sorted(sessions), 'provider release coverage')
        for row in receipts:
            need(type(row['status']) is int and row['status'] in native['RELEASED_STATUSES'][row['provider']]
                 and isinstance(row['response_sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['response_sha256']),
                 'provider release result')
        snapshot = evidence['payment_snapshot']
        need({k: v for k, v in snapshot.items() if k != 'purchase_cleanup'}
             == {k: v for k, v in final.items() if k != 'purchase_cleanup'}, 'payment root snapshot drift')
        need(snapshot['root_exists'] is True and snapshot['root_deleted'] is True
             and snapshot['unsealed_tree_agent_ids'] == [] and snapshot['tree_agent_ids'] == final['tree_agent_ids']
             and snapshot['root_user_id'] == final['root_user_id']
             and payment['purchases'] == snapshot['purchase_cleanup'], 'terminal payment snapshot')
        try:
            pending = batch['pending_root_payments'](snapshot)
        except RuntimeError as error:
            raise ValueError('native cleanup: ' + str(error)) from error
        need(not pending, 'pending native payment obligation')


def recovered_runtime(fleet, owner_token, benches, rows, identities, bound, document):
    """Consume the native guest ACK and its complete captured V2 stack evidence."""
    need(len(benches) == 1 and set(identities) == {benches[0]['name']}, 'recovered task closure')
    machines = set()
    for index, bench in enumerate(benches):
        name = bench['name']
        need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_-]+', name), 'recovered task name')
        out = fleet / name
        cid = bound(out / '.cid').decode().split()
        need(len(cid) == 2 and cid[0] == 'clone' and re.fullmatch('[0-9a-f]+', cid[1]), 'recovered machine')
        machine, token = cid[1], owner_token + '-' + str(index)
        machines.add(machine)
        need(bound(out / 'guest-shutdown.confirmed') == (fleet.name + '\n').encode(), 'native guest ACK')
        owner = document(out / 'runtime-evidence.owner.json')
        need(owner == {'version': 1, 'machine_id': machine, 'run_token': token}, 'runtime owner')
        runtime = out / 'remote-logs/runtime-evidence'
        manifest = document(runtime / 'manifest.json')
        need(set(manifest) == {'version', 'machine_id', 'run_token', 'files'}
             and manifest['version'] == 1 and manifest['machine_id'] == machine
             and manifest['run_token'] == token, 'runtime manifest identity')
        services = document(runtime / 'services.json')
        count = services['env']['worker_processes']
        need(services['status'] == 'stopped' and type(count) is int and 1 <= count <= 1024, 'stopped services')
        cleanup_name = 'cloudbench-stack-cleanup-' + token + '.status'
        expected = {'services.json', 'run.json', 'stack.log', cleanup_name, 'logs/backend.log',
                    'logs/worker.log', *(f'logs/worker.{i}.log' for i in range(1, count))}
        files = manifest['files']
        need(isinstance(files, dict) and set(files) - {'wmh-serve-log.txt', 'guest-diagnostics.jsonl'} == expected,
             'runtime file inventory')
        need({str(p.relative_to(runtime)) for p in runtime.rglob('*') if p.is_file()}
             == set(files) | {'manifest.json'}, 'captured runtime closure')
        total = 0
        for path, info in files.items():
            need(set(info) == {'bytes', 'sha256'} and type(info['bytes']) is int and info['bytes'] >= 0,
                 'runtime file metadata')
            total += info['bytes']
            need(total <= 512 * 1024 * 1024, 'runtime evidence size')
            raw = bound(runtime / path)
            need(len(raw) == info['bytes'] and hashlib.sha256(raw).hexdigest() == info['sha256'], 'runtime file seal')
        status = fields(bound(runtime / cleanup_name))
        identity = identities[name]
        need(isinstance(identity, str) and re.fullmatch(r'linux:[0-9a-f-]{36}:[0-9]+', identity), 'native stack identity')
        need(status.get('version') == '2' and status.get('state') == 'clean' and status.get('token') == token
             and status.get('stack_native_identity') == identity and status.get('stack_birth')
             and type(services.get('run_sh_pid')) is int and services['run_sh_pid'] > 1
             and status.get('stack_pid') == str(services['run_sh_pid']), 'native V2 stack cleanup')
        recovered_roots(runtime / 'run.json', name, bound)
    need(machines == {row['machine_id'] for row in rows}, 'recovered resource coverage')


# These typed witnesses admit only a separate validation launch. They never close old cleanup.
RUNLESS_SCAN = r'''import base64,hashlib,json,os,stat,sys,time,subprocess
from pathlib import Path
b=json.loads(sys.argv[1]);end=time.monotonic()+8
assert os.geteuid()==0 and os.environ.get('FLY_MACHINE_ID')==b['machine_id']
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
repo_head=subprocess.check_output(['/usr/bin/git','-c','safe.directory=/data/repo','-C','/data/repo','rev-parse','HEAD'],text=True,timeout=2,env={'PATH':'/usr/bin:/bin','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','GIT_OPTIONAL_LOCKS':'0'}).strip()
payload_stats={}
def payload(path,limit):
 p=Path(path)
 if not p.exists():return None
 assert p.resolve()==p and not p.is_symlink() and p.is_file()
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);assert stat.S_ISREG(before.st_mode) and before.st_size<=limit
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(limit+1)
  after=os.fstat(fd)
  assert len(raw)==before.st_size and (before.st_ino,before.st_dev,before.st_size,before.st_mtime_ns)==(after.st_ino,after.st_dev,after.st_size,after.st_mtime_ns)
  payload_stats[path]=dict(device=before.st_dev,mode=before.st_mode)
  return raw
 finally:os.close(fd)
mountinfo=Path('/proc/self/mountinfo').read_text();assert len(mountinfo.encode())<=2097152
paths={}
for name in ('/','/data','/data/repo'):
 info=os.lstat(name);paths[name]=dict(device=info.st_dev,inode=info.st_ino,mode=info.st_mode,realpath=str(Path(name).resolve(strict=True)))
services=payload('/data/repo/.context/cloudbench/services.json',1048576)
run=payload('/data/repo/.context/cloudbench/run.json',134217728)
backend=payload('/data/repo/.context/cloudbench/logs/backend.log',67108864)
def identity(path,follow=False):
 fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|(0 if follow else os.O_NOFOLLOW))
 try:
  a=os.fstat(fd);assert stat.S_ISREG(a.st_mode) and a.st_size<=67108864
  digest=hashlib.sha256();count=0
  while count<a.st_size:
   block=os.read(fd,min(65536,a.st_size-count));assert block;count+=len(block);digest.update(block)
  z=os.fstat(fd);assert(a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid,a.st_size,a.st_mtime_ns)==(z.st_dev,z.st_ino,z.st_mode,z.st_uid,z.st_gid,z.st_size,z.st_mtime_ns)
  return dict(device=a.st_dev,inode=a.st_ino,mode=a.st_mode,uid=a.st_uid,sha256=digest.hexdigest())
 finally:os.close(fd)
roles={}
rows=[];gone=[];errors=[]
for p in sorted(Path('/proc').iterdir()):
 if not p.name.isdigit():continue
 assert time.monotonic()<end
 try:
  raw=(p/'stat').read_text();v=raw.rsplit(') ',1)[1].split();flags=int(v[6]);pid=int(p.name)
  row=dict(pid=pid,stat=raw)
  if flags&0x00200000 or v[0] in ('Z','X','x'):rows.append(row);continue
  with (p/'environ').open('rb') as f:env=f.read(4194305)
  with (p/'cmdline').open('rb') as f:cmd=f.read(4194305)
  cwd=os.readlink(p/'cwd');exe=os.readlink(p/'exe')
  assert len(env)<=4194304 and len(cmd)<=4194304
  values=dict(x.split(b'=',1) for x in env.split(b'\0') if b'=' in x)
  row.update(run_token=values.get(b'CLOUDBENCH_RUN_TOKEN',b'').decode(errors='replace'),
   cwd=cwd,exe=exe,cmdline_b64=base64.b64encode(cmd).decode(),stat_after=(p/'stat').read_text())
  args=[x for x in cmd.split(b'\0') if x]
  if args in ([b'sleep',b'infinity'],[b'/bin/sleep',b'infinity'],[b'/usr/bin/sleep',b'infinity']) or (len(args)>1 and args[1]==b'/cloudbench-status-server.py'):
   canonical=str(Path('/bin/sleep' if b'sleep' in args[0] else '/usr/bin/python3').resolve(strict=True))
   info=dict(uid_status=(p/'status').read_text(),exe_path=canonical,exe=identity(canonical),proc_exe=identity(p/'exe',True),
    fd_links={name:os.readlink(p/'fd'/name) for name in os.listdir(p/'fd')},
    unsafe_startup={k.decode():hashlib.sha256(values[k]).hexdigest() for k in (b'PYTHONPATH',b'PYTHONHOME',b'PYTHONSTARTUP',b'PYTHONINSPECT',b'PYTHONUSERBASE',b'PYTHONEXECUTABLE',b'PYTHONPLATLIBDIR',b'LD_PRELOAD',b'LD_LIBRARY_PATH',b'LD_AUDIT') if values.get(k)})
   if len(args)>1 and args[1]==b'/cloudbench-status-server.py':info['script']=identity('/cloudbench-status-server.py')
   roles[str(pid)]=info
  row['stat_after']=(p/'stat').read_text()
  rows.append(row)
 except FileNotFoundError:gone.append(int(p.name))
 except (PermissionError,OSError,ValueError) as e:errors.append(dict(pid=int(p.name),error=type(e).__name__))
by={x['pid']:x for x in rows};ancestry=[];pid=os.getpid()
while pid>1:
 assert pid in by and pid not in ancestry
 ancestry.append(pid);pid=int(by[pid]['stat'].rsplit(') ',1)[1].split()[1])
sockets={}
for name in ('tcp','tcp6','udp','udp6'):
 with Path('/proc/net/'+name).open() as f:sockets[name]=f.read(2097153)
 assert len(sockets[name].encode())<=2097152
print(json.dumps(dict(schema='original-runless-proc-scan-v1',binding=b,uid=os.geteuid(),machine_id=os.environ.get('FLY_MACHINE_ID'),
 boot=boot,repo_head=repo_head,self_pid=os.getpid(),ancestors=ancestry,processes=rows,gone=gone,errors=errors,sockets=sockets,
 infrastructure=dict(roles=roles,driver_state=payload('/data/cloudbench-driver.state',4096).decode() if Path('/data/cloudbench-driver.state').exists() else None,driver_pid_b64=None if not Path('/data/cloudbench-driver.pid').exists() else base64.b64encode(payload('/data/cloudbench-driver.pid',4096)).decode()),
 filesystem=dict(mountinfo=mountinfo,mountinfo_after=Path('/proc/self/mountinfo').read_text(),paths=paths,payloads=payload_stats),
 services_b64=None if services is None else base64.b64encode(services).decode(),run_present=run is not None,
 backend_sha256=None if backend is None else hashlib.sha256(backend).hexdigest(),finished_epoch=time.time())))
'''


def isolated_original(fleet, owner, root, receipt, row, bound, document):
    """Canonical captured custody; no missing task/run payload can become a success."""
    audit, registry = fleet_audit_root(root) / owner, fleet_ownership_root(root) / owner
    meta = fields(bound(registry / 'meta'))
    need(meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root) and meta.get('app') == row['app'], 'runless registry custody')
    original = fields(bound(audit / 'fresh' / row['clone_name']))
    need(original == row and bound(audit / 'by-machine-id' / row['machine_id']).decode().strip() == row['clone_name'],
         'runless ledger identity')
    provenance = document(fleet / 'execution-provenance.json')
    from cloudbench_execution_provenance import validate_provenance
    need(not validate_provenance(provenance) and provenance['base_sha'] == receipt['source']['head'],
         'runless original provenance')
    matrix = document(fleet / 'execution-task-matrix.json')
    source = document(fleet / 'source-manifest.json')
    need(bound(registry / 'source-manifest.json') == bound(audit / 'source-manifest.json')
         == bound(fleet / 'source-manifest.json') and source['machine_id'] == row['source_machine_id']
         and provenance['config']['values']['base_source_manifest_sha256']
             == hashlib.sha256(bound(fleet / 'source-manifest.json')).hexdigest()
         and isinstance(matrix, dict), 'runless source capture')
    binding = dict(app=row['app'], owner=owner, run_id=fleet.name, machine_id=row['machine_id'],
                   volume_id=row['volume_id'], run_token=owner+'-0', source=receipt['source']['head'])
    return binding


def isolation_wire(packet, kind, machine, volume, bound):
    rows = packet['rows']
    selected = [row for row in rows if row.get('kind') == kind]
    need(len(selected) == 1, 'typed provider response closure')
    row = selected[0]
    need(row['method'] == 'GET' and row['path'] == '/'+('machines/' + machine if kind == 'machine' else 'volumes/' + volume)
         and row.get('no_retry') is True, 'typed provider request scope')
    raw = bound(row['body_path'])
    need(hashlib.sha256(raw).hexdigest() == row['response_sha256'], 'typed raw native response seal')
    import base64
    wire=Path(row['wire']);request=json.loads(bound(wire/'request.json'));record=json.loads(bound(wire/'0001-wire.json'))
    native_raw=base64.b64decode(record['body_b64'],validate=True)
    need(request['method']=='GET' and request['path']==row['path'] and request['body'] is None
         and request['headers']=={} and request['app']==packet['app']
         and record['method']=='GET' and record['path']==row['path'] and record['status']==row['http_status']
         and native_raw==raw and hashlib.sha256(native_raw).hexdigest()==record['sha256'], 'authenticated current GET wire')
    return row['http_status'], json.loads(raw) if row['http_status'] == 200 else None


def isolated_absent_pair(fleet, owner, root, receipt, row, evidence, proof, bound, document):
    """404 is current nonexecution, never a substitute for an authenticated original DELETE."""
    import base64
    need(proof.get('purpose')=='isolated-validation','typed witness is launch-only')
    binding = isolated_original(fleet, owner, root, receipt, row, bound, document)
    packet = document(evidence)
    need(packet.get('app')==binding['app'],'typed provider app')
    need(packet.get('schema') == 'original-absent-pair-v1' and packet.get('binding') == binding
         and packet.get('endpoint_origin') == 'https://api.machines.dev'
         and receipt['finished_at'] <= packet['observed_epoch'] <= proof['confirmed_at'], 'absent pair original custody')
    status, _ = isolation_wire(packet, 'machine', row['machine_id'], row['volume_id'], bound)
    vstatus, volume = isolation_wire(packet, 'volume', row['machine_id'], row['volume_id'], bound)
    need(status == 404 and vstatus == 200 and volume['id'] == row['volume_id']
         and volume['state'] in {'pending_destroy','destroyed'} and volume.get('attached_machine_id') is None,
         'absent pair not nonexecuting')
    registry = fleet_ownership_root(root) / owner
    for kind, identifier in [('machine', row['machine_id']), ('volume', row['volume_id'])]:
        need(document(registry / ('disposable-delete-'+kind+'-'+identifier+'.json'))
             == dict(owner=owner, app=row['app'], kind=kind, identifier=identifier), 'original delete intent')
    directory = Path(packet['delete_fence'])
    expected = fleet_git_common(root) / 'cloudbench-native-effect-fences' / owner / fleet.name / row['machine_id'] / 'destroy'
    need(directory.parent == expected and directory.name == hashlib.sha256(
        json.dumps([row['machine_id'],document(directory/'intent.json')['machine']['instance_id'],
                    document(directory/'intent.json')['machine']['config']],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
         'original native delete fence path')
    intent = document(directory/'intent.json');native=intent['machine']
    need(intent['operation'] == 'destroy' and native['id'] == row['machine_id'] and native['name'] == row['clone_name']
         and native['config']['env'].get('REF') == binding['source']
         and native['config']['env'].get('CLOUDBENCH_RUN_TOKEN') == binding['run_token']
         and [m['volume'] for m in native['config']['mounts']] == [row['volume_id']], 'original deleted incarnation')
    ack = document(directory/'ack.json')
    wire = Path(packet['delete_wire']);request=document(wire/'request.json');response=document(wire/'0001-wire.json')
    need(wire.parent == expected/'wire' and request['app'] == row['app'] and request['method'] == 'DELETE'
         and request['path'] == '/machines/'+row['machine_id']+'?force=true' and request['body'] is None
         and response['method'] == 'DELETE' and response['path'] == request['path']
         and response['status'] in {200,202,204}, 'original authenticated DELETE acknowledgement')
    raw = base64.b64decode(response['body_b64'],validate=True)
    need(hashlib.sha256(raw).hexdigest() == response['sha256'] and json.loads(raw or b'{}') == ack
         == document(wire/'result.json'), 'original DELETE raw ACK seal')
    records=[]
    for folder in sorted((expected/'wire').iterdir()):
        req=document(folder/'request.json');body=document(folder/'0001-wire.json')
        data=base64.b64decode(body['body_b64'],validate=True)
        need(hashlib.sha256(data).hexdigest()==body['sha256'] and body['method']==req['method']
             and body['path']==req['path'] and req['app']==row['app'], 'original leased wire seal')
        records.append((req,body,json.loads(data or b'{}')))
    acquired=[x for x in records if x[0]['method']=='POST' and x[0]['path']=='/machines/'+row['machine_id']+'/lease']
    released=[x for x in records if x[0]['method']=='DELETE' and x[0]['path']=='/machines/'+row['machine_id']+'/lease']
    guarded=[x for x in records if x[0]['method']=='GET' and x[0]['path']=='/machines/'+row['machine_id']]
    need(len(acquired)==len(released)==len(guarded)==1 and len(records)==4, 'original exact lease journal closure')
    acquire,release,guard=acquired[0],released[0],guarded[0]
    nonce=acquire[2]['data']['nonce']
    need(acquire[1]['status'] in {200,201} and acquire[2]['data']['version']==native['instance_id']
         and isinstance(nonce,str) and nonce and guard[2]==native and guard[1]['status']==200
         and release[1]['status']==200 and release[2]['data']['ok'] is True
         and all(x['headers']=={'fly-machine-lease-nonce':nonce} for x in (request,guard[0],release[0]))
         and acquire[1]['monotonic_ns']<guard[1]['monotonic_ns']<response['monotonic_ns']<release[1]['monotonic_ns'],
         'original delete lease/version/chronology')


def isolated_runless_os(fleet, owner, root, receipt, row, evidence, proof, bound, document):
    import base64
    need(proof.get('purpose')=='isolated-validation','typed witness is launch-only')
    binding = isolated_original(fleet, owner, root, receipt, row, bound, document)
    packet = document(evidence)
    need(packet.get('schema') == 'original-runless-current-os-v1' and packet.get('binding') == binding
         and packet.get('endpoint_origin') == 'https://api.machines.dev'
         and receipt['finished_at'] <= packet['observed_epoch'] <= proof['confirmed_at'], 'runless observation custody')
    original_path=Path(packet['original_native'])
    need(original_path == fleet.parent.parent/'campaigns'/('deploy-'+fleet.parent.parent.name)/'shared-inventory/machines.json',
         'canonical original native cache required')
    originals=json.loads(bound(original_path));need(isinstance(originals,list),'original native array');matches=[x for x in originals if isinstance(x,dict) and x.get('id')==row['machine_id']]
    need(len(matches)==1,'original native exact row');expected=matches[0]
    observed = []
    attachment = packet.get('attachment_observation')
    need(attachment in (None,'explicit-null-original-quarantined-v1'), 'runless attachment observation kind')
    unresolved = attachment is not None
    volumes = []
    for phase in ('before','after'):
        native = document(packet[phase])
        need(native.get('app')==binding['app'],'current native app')
        mstatus,machine=isolation_wire(native,'machine',row['machine_id'],row['volume_id'],bound)
        vstatus,volume=isolation_wire(native,'volume',row['machine_id'],row['volume_id'],bound)
        need(mstatus == vstatus == 200 and machine.get('state')=='started' and machine['id'] == row['machine_id'] and machine['name'] == row['clone_name']
             and machine.get('instance_id') and machine['config']['env'].get('REF') == binding['source']
             and machine['config']['env'].get('CLOUDBENCH_RUN_TOKEN') == binding['run_token']
             and [(m['volume'],m['path']) for m in machine['config']['mounts']] == [(row['volume_id'],'/data')]
             and volume['id'] == row['volume_id'] and volume.get('encrypted') is True
             and volume['state'] == 'created'
             and (volume.get('attached_machine_id') == row['machine_id'] if not unresolved else
                  all(key in volume and volume[key] is None for key in ('attached_machine_id','attached_alloc_id'))),
             'runless exact current native identity')
        need(all(machine.get(key) == expected.get(key) for key in ('id','name','instance_id','config')),
             'runless original incarnation differs')
        if unresolved:
            mount=expected['config']['mounts'][0]
            need(all(key in volume and key in mount and volume[key] == mount[key] for key in ('name','size_gb'))
                 and type(volume['size_gb']) is int and volume['size_gb']>0
                 and mount.get('encrypted') is True and volume.get('region') == expected.get('region')
                 and isinstance(expected.get('region'),str) and expected['region'],
                 'unresolved original Volume identity differs')
            volumes.append({key:volume[key] for key in ('id','name','region','size_gb','encrypted','state','attached_machine_id','attached_alloc_id')})
        observed.append(machine)
    need(all(observed[0][key] == observed[1][key] for key in ('id','name','instance_id','config','state')),
         'runless native incarnation changed')
    need(not unresolved or volumes[0] == volumes[1], 'unresolved Volume observation changed')
    scan = document(packet['scan'])
    need(packet['program_sha256'] == hashlib.sha256(RUNLESS_SCAN.encode()).hexdigest()
         and packet['command'] == shlex.join(['timeout','--signal=TERM','10s','/usr/bin/python3','-I','-B','-c',RUNLESS_SCAN,
                                              json.dumps(binding,sort_keys=True,separators=(',',':'))])
         and packet['ssh_argv'] == ['ssh','console','--quiet','-a',row['app'],'--machine',row['machine_id'],'-C',packet['command']]
         and packet['ssh_exit'] == 0
         and bound(packet['ssh_stderr']) in (b'',('Connecting to '+str(observed[0].get('private_ip',''))+'...\n').encode())
         and json.loads(bound(packet['ssh_stdout'])) == scan and scan['binding'] == binding
         and scan['schema'] == 'original-runless-proc-scan-v1' and type(scan['uid']) is int and scan['uid'] == 0
         and scan['machine_id'] == row['machine_id'] and scan['repo_head'] == binding['source'] and scan['errors'] == []
         and scan['run_present'] is False and receipt['finished_at'] <= scan['finished_epoch'] <= proof['confirmed_at'],
         'runless authentic collector output')
    if unresolved:
        import stat
        fs=scan['filesystem'];paths=fs['paths'];payloads=fs['payloads']
        need(isinstance(fs['mountinfo'],str) and fs['mountinfo']==fs['mountinfo_after']
             and len(fs['mountinfo'].encode())<=2097152, 'unresolved mount changed during scan')
        for path in ('/','/data','/data/repo'):
            entry=paths[path]
            need(type(entry['device']) is int and entry['device']>=0 and type(entry['mode']) is int
                 and stat.S_ISDIR(entry['mode']) and entry['realpath']==path, 'unresolved canonical directory')
        device=paths['/data']['device']
        need(device!=paths['/']['device'] and paths['/data/repo']['device']==device, 'unresolved data rootfs or device mismatch')
        mounts=[]
        for line in fs['mountinfo'].splitlines():
            parts=line.split();need(len(parts)>=10 and '-' in parts, 'unresolved mountinfo malformed')
            mounts.append(parts)
        data=[parts for parts in mounts if parts[4]=='/data']
        need(len(data)==1 and data[0][2]==str(os.major(device))+':'+str(os.minor(device))
             and data[0][3]=='/' and not any(parts[4]!='/' and parts[4]!='/data' and (target==parts[4] or target.startswith(parts[4].rstrip('/')+'/'))
                 for parts in mounts for target in ('/data/repo','/data/repo/.context/cloudbench/services.json','/data/repo/.context/cloudbench/logs/backend.log')),
             'unresolved actual data mount missing or redirected')
        for path in ('/data/repo/.context/cloudbench/services.json','/data/repo/.context/cloudbench/logs/backend.log'):
            entry=payloads[path]
            need(type(entry['device']) is int and entry['device']==device and type(entry['mode']) is int
                 and stat.S_ISREG(entry['mode']), 'unresolved original payload is on another filesystem')
        # This proves Machine/filesystem execution only, never physical Volume attachment or release.
    services = json.loads(base64.b64decode(scan['services_b64'],validate=True))
    original_state=document(packet['original_state'])
    task=Path(packet['original_state']).parent
    benches=json.loads(bound(fleet/'_batch/benches.json'))
    need(task.parent==fleet and task.name in {x['name'] for x in benches}
         and Path(packet['original_state'])==task/'guest-cleanup.state.json'
         and Path(packet['original_backend'])==task/'guest-cleanup.backend.log'
         and document(task/'runtime-evidence.owner.json')==dict(version=1,machine_id=row['machine_id'],run_token=binding['run_token'])
         and bound(task/'.cid').decode().split()==['clone',row['machine_id']], 'runless exact original task files')
    need(services.get('status') == 'stopped' and services.get('worktree') == '/data/repo'
         and services.get('benchmark_mode') is True and original_state['machine_id'] == row['machine_id']
         and original_state['guest_run_token'] == binding['run_token']
         and original_state['services_status'] == 'stopped' and original_state['live_service_pids'] == []
         and original_state['driver_pid'] is None and original_state['driver_state'] == 'exited'
         and scan['backend_sha256'] == hashlib.sha256(bound(packet['original_backend'])).hexdigest(),
         'runless original service/backend custody')
    recovery=runpy.run_path(str(Path(__file__).with_name('cloudbench-guest-recovery.py')))
    need(services.get('schema_version')==1 and isinstance(services.get('services'),list), 'runless services schema')
    try:service_pids=recovery['service_pids'](services);recovery['backend_port'](services)
    except recovery['GuestRecoveryError'] as error:raise ValueError('native cleanup: exact services parser refused') from error
    need(set(service_pids) == set(original_state['stopped_service_pids']), 'runless original service PIDs')
    rows = scan['processes'];need(len({p['pid'] for p in rows}) == len(rows), 'runless proc inventory')
    index={p['pid']:p for p in rows};ancestors=scan['ancestors'];pid=scan['self_pid']
    need(not set(service_pids)&set(index), 'original service PID present or reused')
    ports=services.get('ports');need(isinstance(ports,dict) and ports and all(type(x) is int and 0<=x<=65535 for x in ports.values()),
         'runless original ports')
    need(ancestors and len(set(ancestors)) == len(ancestors), 'collector ancestry')
    def stat_fields(process):
        raw=process['stat'];need(raw.startswith(str(process['pid'])+' ('),'raw proc PID')
        values=raw.rsplit(') ',1)[1].split();need(len(values)>=20 and all(values[k].isdigit() for k in (1,6,19)), 'raw proc stat')
        return values
    for parent in ancestors:
        need(parent == pid and parent in index, 'collector process chain');pid=int(stat_fields(index[parent])[1])
    need(pid == 1, 'collector ancestry root')
    infrastructure=set()
    if 'infrastructure_prior' in packet:
        prior=document(packet['infrastructure_prior']);past=document(prior['scan'])
        prior_command=shlex.split(prior['command'])
        need(prior['binding']==binding and prior['schema']=='original-runless-current-os-v1'
             and prior['endpoint_origin']=='https://api.machines.dev' and prior['ssh_exit']==0
             and len(prior_command)==9 and prior_command[:7]==['timeout','--signal=TERM','10s','/usr/bin/python3','-I','-B','-c']
             and hashlib.sha256(prior_command[7].encode()).hexdigest()==prior['program_sha256']=='aa33a7dc25dbc450b00f99556ca5349d9cab57bc36016aedabeacdeab8eadc43'
             and json.loads(prior_command[8])==binding
             and prior['ssh_argv']==['ssh','console','--quiet','-a',row['app'],'--machine',row['machine_id'],'-C',prior['command']]
             and bound(prior['ssh_stderr']) in (b'',('Connecting to '+str(expected.get('private_ip',''))+'...\n').encode())
             and json.loads(bound(prior['ssh_stdout']))==past and past['binding']==binding
             and past['boot']==scan['boot'] and past['finished_epoch']<=scan['finished_epoch'], 'infrastructure prior authenticated scan')
        for phase in ('before','after'):
            native=document(prior[phase]);status,old=isolation_wire(native,'machine',row['machine_id'],row['volume_id'],bound)
            need(native['app']==binding['app'] and status==200 and all(old.get(k)==expected.get(k) for k in ('id','name','instance_id','config')),
                 'infrastructure prior original incarnation')
        env=expected['config']['env'];port=env.get('CLOUDBENCH_STATUS_PORT');barrier=env.get('CLOUDBENCH_START_BARRIER')
        need(isinstance(port,str) and port.isdigit() and 0<int(port)<=65535 and int(port) not in set(ports.values())
             and barrier==binding['run_id'] and expected['config']['init']=={'cmd':['bash','/cloudbench-boot.sh']}, 'original metadata boot configuration')
        expected_args=dict(sleep=[b'sleep',b'infinity'],status=[b'python3',b'/cloudbench-status-server.py',b'--directory',b'/data',b'--port',port.encode(),b'--barrier',barrier.encode(),b'--run-token',binding['run_token'].encode()])
        injected={}
        for target,digest in (('/cloudbench-status-server.py','738ad4b98a1aa1f441601ae078b3f9f405e275ec492ccc75f8a10621425c5093'),('/cloudbench-boot.sh','66ce198f59bc8f6c32e4667e11151dcec5fb81631ddafb86624a69540464fa9c')):
            candidates=[f for f in expected['config']['files'] if f.get('guest_path')==target]
            need(len(candidates)==1 and hashlib.sha256(base64.b64decode(candidates[0]['raw_value'],validate=True)).hexdigest()==digest, 'original metadata program source')
            injected[target]=digest
        info=scan['infrastructure'];need(info['driver_state']=='exited\n' and info['driver_pid_b64'] is None, 'original driver terminal metadata')
        def trusted_file(value):
            return (type(value['mode']) is int and __import__('stat').S_ISREG(value['mode']) and value['uid']==0
                    and not value['mode']&0o022 and type(value['device']) is int and type(value['inode']) is int
                    and re.fullmatch('[0-9a-f]{64}',value['sha256']) is not None)
        for role,args in expected_args.items():
            pins=[p for p in past['processes'] if 'cmdline_b64' in p and base64.b64decode(p['cmdline_b64'],validate=True).split(b'\0')[:-1]==args]
            need(len(pins)==1 and pins[0]['pid'] in index, 'original infrastructure role missing or duplicated')
            pin=pins[0];process=index[pin['pid']];values=stat_fields(process);evidence=info['roles'][str(process['pid'])]
            need(base64.b64decode(process['cmdline_b64'],validate=True).split(b'\0')[:-1]==args
                 and stat_fields(pin)[19]==values[19] and stat_fields(dict(process,stat=process['stat_after']))[19]==values[19]
                 and values[1]=='1' and values[0] not in {'Z','X','x'} and process['run_token']==binding['run_token']
                 and process['cwd']==('/app' if role=='sleep' else '/data/repo')
                 and values[2]==('0' if role=='sleep' else str(process['pid']))
                 and not any(int(stat_fields(p)[1])==process['pid'] for p in rows), 'infrastructure role epoch/ancestry differs')
            uid_rows=[line.split()[1:] for line in evidence['uid_status'].splitlines() if line.startswith('Uid:')]
            need(len(uid_rows)==1 and len(uid_rows[0])==4 and len(set(uid_rows[0]))==1 and uid_rows[0][0] in {'0','1001'}
                 and not evidence['unsafe_startup'] and trusted_file(evidence['exe']) and evidence['exe']==evidence['proc_exe']
                 and process['exe']==evidence['exe_path']
                 and (process['exe']=='/usr/bin/sleep' if role=='sleep' else re.fullmatch('/usr/bin/python3(?:[.][0-9]+)?',process['exe']) is not None),
                 'infrastructure UID/executable or startup differs')
            if role=='status':
                need(trusted_file(evidence['script']) and evidence['script']['sha256']==injected['/cloudbench-status-server.py'], 'metadata server script changed')
                sockets={link[8:-1] for link in evidence['fd_links'].values() if re.fullmatch(r'socket:\[[0-9]+\]',link)}
                listeners=[]
                for protocol,raw in scan['sockets'].items():
                    for line in raw.splitlines()[1:]:
                        fields=line.split();need(len(fields)>=10,'metadata socket row malformed')
                        if protocol.startswith('tcp') and fields[3]=='0A':
                            if int(fields[1].rsplit(':',1)[1],16)==int(port):
                                need(fields[9] in sockets, 'metadata port owned by another process')
                                listeners.append(fields[9])
                            if fields[9] in sockets:need(int(fields[1].rsplit(':',1)[1],16)==int(port), 'metadata server extra listener')
                        if protocol.startswith('udp') and int(fields[1].rsplit(':',1)[1],16)==int(port):need(False,'metadata port is UDP')
                need(len(listeners)==1, 'exact metadata listener missing or duplicated')
            infrastructure.add(process['pid'])
        need(set(info['roles'])=={str(pid) for pid in infrastructure}, 'unexpected infrastructure role')
    for process in rows:
        values=stat_fields(process)
        if int(values[6])&0x00200000 or values[0] in {'Z','X','x'}:continue
        after_stat=dict(process,stat=process['stat_after'])
        need(stat_fields(after_stat)[19]==values[19], 'process birth changed during scan')
        command=base64.b64decode(process['cmdline_b64'],validate=True)
        need(len(command)<=4194304,'bounded proc command')
        if process['pid'] in ancestors or process['pid'] in infrastructure:continue
        scoped=(process['run_token']==binding['run_token'] or process['cwd']=='/data/repo'
                or process['cwd'].startswith('/data/repo/') or process['exe'].startswith('/data/repo/')
                or re.search(rb'(?<![A-Za-z0-9_./-])/data/repo(?:/|\x00|$)',command) is not None
                or any(x in command for x in (b'cloudbench-run.sh',b'cloudbench-worker.sh',b'run_benchmark.py')))
        need(not scoped, 'original scoped execution remains active')
    for protocol,raw in scan['sockets'].items():
        for line in raw.splitlines()[1:]:
            parts=line.split();need(len(parts)>=10,'socket scan malformed')
            port=int(parts[1].rsplit(':',1)[1],16)
            active=parts[3]=='0A' if protocol.startswith('tcp') else int(parts[9])>0
            need(not (port and active and port in set(ports.values())),'owned listener remains')
    need(set(scan['sockets']) == {'tcp','tcp6','udp','udp6'}, 'socket scan closure')
    # Missing historical run is preserved as debt; no synthetic empty run or cleanup receipt.


def make_isolated_read_plan(root, fleet, machine, receipt_path, *, branch, delete_fence=None, delete_wire=None, infrastructure_prior=None):
    """Local-only constructor: bind original canonical bytes before any provider construction."""
    root, fleet, receipt_path = Path(root).absolute(), Path(fleet).absolute(), Path(receipt_path).absolute()
    files = {}
    def bound(path):
        path=Path(path);need(path.resolve()==path and path.is_file() and not path.is_symlink(), 'canonical plan file')
        raw=path.read_bytes();need(len(raw)<=MAX_RAW_FORENSIC_RUN_BYTES,'plan file bound')
        files[str(path)]=hashlib.sha256(raw).hexdigest();return raw
    document=lambda path:json.loads(bound(path))
    receipt=document(receipt_path);owner=document(fleet/'_batch/lifecycle.json')['fleet_owner_token']
    need(receipt.get('complete') is False and receipt.get('cleanup_complete') is not True
         and receipt.get('lifecycle')=='native-producer' and receipt['cleanup_owner']['worker_root']==str(root), 'original failed receipt required')
    audit=fleet_audit_root(root)/owner;registry=fleet_ownership_root(root)/owner
    name=bound(audit/'by-machine-id'/machine).decode().strip();ledger=audit/'fresh'/name;row=fields(bound(ledger))
    binding=isolated_original(fleet,owner,root,receipt,row,bound,document)
    need(machine==binding['machine_id'] and fleet.parent==root/'.context/deploy-cloud'/hashlib.sha256(receipt['token'].encode()).hexdigest()/'runs', 'original request namespace')
    need(not Path('/proc',fleet.name.rsplit('-',1)[-1]).exists(), 'original controller remains')
    for directory in (audit,registry):
        for path in directory.rglob('*'):
            if path.is_file():bound(path)
            else:need(path.is_dir() and not path.is_symlink(),'canonical original quarantine tree')
    plan=dict(schema='original-isolation-read-plan-v1',branch=branch,root=str(root),fleet=str(fleet),owner=owner,
        receipt=str(receipt_path),ledger=str(ledger),binding=binding,files=files,
        collector_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    if branch=='runless-os':
        original=fleet.parent.parent/'campaigns'/('deploy-'+fleet.parent.parent.name)/'shared-inventory/machines.json'
        inventory=json.loads(bound(original));need(isinstance(inventory,list) and len([x for x in inventory if isinstance(x,dict) and x.get('id')==machine])==1,'original exact native inventory')
        task=next(p for p in fleet.iterdir() if p.is_dir() and (p/'runtime-evidence.owner.json').is_file()
                  and document(p/'runtime-evidence.owner.json').get('machine_id')==machine)
        plan.update(original_native=str(original),original_state=str(task/'guest-cleanup.state.json'),original_backend=str(task/'guest-cleanup.backend.log'))
        for key in ('original_state','original_backend'):bound(plan[key])
        if infrastructure_prior is not None:
            prior=Path(infrastructure_prior);packet=document(prior)
            need(packet['binding']==binding and packet['schema']=='original-runless-current-os-v1', 'original infrastructure prior identity')
            plan['infrastructure_prior']=str(prior)
            for path in prior.parent.rglob('*'):
                if path.is_file():bound(path)
    else:
        need(branch=='absent-pair' and delete_fence and delete_wire,'original absent fence required')
        plan.update(delete_fence=str(Path(delete_fence)),delete_wire=str(Path(delete_wire)))
        for folder in [Path(delete_fence),Path(delete_wire)]:
            for path in folder.rglob('*'):
                if path.is_file():bound(path)
    return plan


def collect_isolated_witness(plan, output, *, fly_factory=None):
    """Explicit finite GET/SSH collector. Constructing a plan does not invoke this function."""
    import base64
    need(plan.get('schema') == 'original-isolation-read-plan-v1' and plan.get('branch') in {'runless-os','absent-pair'},
         'typed isolation collection plan required')
    root, fleet, output = Path(plan['root']), Path(plan['fleet']), Path(output)
    need(hashlib.sha256(Path(__file__).read_bytes()).hexdigest()==plan['collector_sha256'], 'collector producer changed')
    need(not Path('/proc',fleet.name.rsplit('-',1)[-1]).exists(), 'original controller remains at collection')
    need(root.resolve() == root and fleet.resolve() == fleet and output.is_absolute()
         and output.resolve() == output and not output.exists(), 'physical fresh collection output')
    def bound(path):
        path=Path(path);need(path.resolve()==path and path.is_file() and not path.is_symlink(), 'original collection file')
        raw=path.read_bytes();need(len(raw)<=MAX_RAW_FORENSIC_RUN_BYTES
             and hashlib.sha256(raw).hexdigest()==plan['files'].get(str(path)), 'collection original input changed')
        return raw
    document=lambda p:json.loads(bound(p))
    receipt=document(plan['receipt']);row=fields(bound(plan['ledger']))
    binding=isolated_original(fleet, plan['owner'], root, receipt, row, bound, document)
    need(binding==plan['binding'] and row['machine_id'] not in {'8d04d3fe39e3d8','83dd701b759598','683e47df5094d8','811d632f2650e8'}
         and row['machine_id'] != row['source_machine_id'], 'protected/nonoriginal collector target')
    for path in plan['files']:bound(path)
    output.mkdir(mode=0o700)
    deadline=time.monotonic()+90
    def save(name,value):
        path=output/name;raw=value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:os.write(fd,raw);os.fsync(fd)
        finally:os.close(fd)
        return str(path)
    save('intent.json',plan)
    capture=runpy.run_path(str(Path(__file__).with_name('cloudbench-original-volume-capture.py')))
    effects=runpy.run_path(str(Path(__file__).with_name('cloudbench-archived-machine-reuse.py')))
    fly=(fly_factory or capture['Fly'])(binding['app'],os.environ.get('FLY_API_TOKEN',''))
    need(fly.base=='https://api.machines.dev', 'collector native endpoint')
    adapter=effects['NativeAdapter'](fly,output/'native')
    def native_pair(name):
        rows=[];values={};started=time.time()
        for kind,key,plural in [('machine','machine_id','machines'),('volume','volume_id','volumes')]:
            existing=set((output/'native').glob('*')) if (output/'native').exists() else set()
            try:
                remaining=int(deadline-time.monotonic())-5;need(remaining>0,'collector absolute deadline')
                values[kind]=adapter.request('GET','/'+plural+'/'+binding[key],timeout=min(15,remaining))
            except Exception:values[kind]=None
            fresh=set((output/'native').glob('*'))-existing
            need(len(fresh)==1,'one exact native observation')
            wire=next(iter(fresh));packets=list(wire.glob('*-wire.json'));need(len(packets)==1,'native outcome unconfirmed')
            record=json.loads(packets[0].read_bytes());raw=base64.b64decode(record['body_b64'],validate=True)
            need(record['status'] in {200,404}, 'native observation unsuccessful')
            rows.append(dict(kind=kind,method='GET',path='/'+plural+'/'+binding[key],no_retry=True,
                http_status=record['status'],response_sha256=hashlib.sha256(raw).hexdigest(),
                body_path=save(name+'-'+kind+'.raw.json',raw),wire=str(wire)))
        return save(name+'.json',dict(rows=rows,app=binding['app'],started_epoch=started,finished_epoch=time.time())),values
    packet=dict(schema='original-absent-pair-v1' if plan['branch']=='absent-pair' else 'original-runless-current-os-v1',
                binding=binding,endpoint_origin=fly.base)
    if 'infrastructure_prior' in plan:packet['infrastructure_prior']=plan['infrastructure_prior']
    if plan['branch']=='absent-pair':
        pair,_=native_pair('current');packet.update(json.loads(Path(pair).read_bytes()),
            delete_fence=plan['delete_fence'],delete_wire=plan['delete_wire'])
    else:
        before,values=native_pair('before');originals=json.loads(bound(plan['original_native']));need(isinstance(originals,list),'collector original native array');matches=[x for x in originals if isinstance(x,dict) and x.get('id')==binding['machine_id']];need(len(matches)==1,'collector original native row');expected=matches[0]
        volume=values['volume'];mount=expected['config']['mounts'][0]
        unresolved=volume is not None and all(key in volume and volume[key] is None for key in ('attached_machine_id','attached_alloc_id'))
        if unresolved:
            need(all(key in volume and key in mount and volume[key]==mount[key] for key in ('name','size_gb'))
                 and type(volume['size_gb']) is int and volume['size_gb']>0 and mount.get('encrypted') is True
                 and isinstance(expected.get('region'),str) and expected['region']
                 and volume.get('region')==expected['region'], 'collector unresolved original Volume differs')
            packet['attachment_observation']='explicit-null-original-quarantined-v1'
        need(values['machine'] is not None and values['machine'].get('state')=='started' and all(values['machine'].get(k)==expected.get(k)
             for k in ('id','name','instance_id','config')) and values['volume'] is not None
             and values['volume'].get('id')==binding['volume_id'] and values['volume'].get('encrypted') is True
             and (values['volume'].get('attached_machine_id')==binding['machine_id'] or unresolved)
             and values['volume'].get('state')=='created', 'collector original incarnation differs before SSH')
        command=shlex.join(['timeout','--signal=TERM','10s','/usr/bin/python3','-I','-B','-c',RUNLESS_SCAN,
                           json.dumps(binding,sort_keys=True,separators=(',',':'))])
        argv=['ssh','console','--quiet','-a',binding['app'],'--machine',binding['machine_id'],'-C',command]
        save('ssh-request.json',dict(argv=argv,program_sha256=hashlib.sha256(RUNLESS_SCAN.encode()).hexdigest()))
        remaining=int(deadline-time.monotonic());need(remaining>0,'collector absolute deadline')
        code,stdout,stderr=fly.flyctl(min(20,remaining),*argv)
        packet.update(before=before,command=command,ssh_argv=argv,ssh_exit=code,
            ssh_stdout=save('ssh.stdout.private.json',stdout.encode()),ssh_stderr=save('ssh.stderr.private.log',stderr.encode()),
            program_sha256=hashlib.sha256(RUNLESS_SCAN.encode()).hexdigest(),original_native=plan['original_native'],
            original_state=plan['original_state'],original_backend=plan['original_backend'])
        need(code==0 and stderr in ('','Connecting to '+str(values['machine'].get('private_ip',''))+'...\n'),
             'collector SSH outcome unconfirmed')
        need(len(stdout.encode())<=16*1024*1024,'collector output bound')
        packet['scan']=save('scan.json',json.loads(stdout))
        packet['after'],_=native_pair('after')
    packet['observed_epoch']=time.time();save('packet.json',packet)
    # This output is a witness candidate only: the normal native-cloud validator must admit it.
    return packet


def isolated_execution(fleet, life, root, receipt, proof, bound, document, tree):
    """Execution admission only; quarantined archives, finances and resources remain owned."""
    owner = life['fleet_owner_token']
    audit = fleet_audit_root(root) / owner
    meta = fields(bound(audit / 'meta'))
    need(meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root), 'isolated audit identity')
    tree(audit)
    registry = fleet_ownership_root(root) / owner
    if registry.exists():
        registered = fields(bound(registry / 'meta'))
        need(all(registered.get(k) == meta.get(k) for k in ('fleet_owner_token', 'run_id', 'workspace_root', 'app'))
             and registered.get('cleanup_policy') in {'reap', 'retain'}
             and any((registry / k).is_file() for k in
                     ('runtime-evidence-unconfirmed', 'guest-cleanup-unconfirmed', 'cold-handoff-outgoing')),
             'old resources must remain natively quarantined')
        tree(registry)
    else:
        need(meta.get('status') == 'provider-teardown-verified', 'unowned unreleased fleet')
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
    pid = int(fleet.name.rsplit('-', 1)[-1])
    need(pid > 1 and not any(int(r.split()[0]) == pid or int(r.split()[1]) == pid
                            for r in processes.splitlines() if not r.split()[2].startswith('Z')),
         'old controller still active')
    rows = [fields(bound(p)) for p in (audit / 'fresh').iterdir()] if (audit / 'fresh').exists() else []
    need(len({r['machine_id'] for r in rows}) == len(rows), 'duplicate old machine')
    observations = proof['execution_quiescence']
    for row in rows:
        machine, token = row['machine_id'], owner + '-0'
        need(row.get('fleet_owner_token') == owner and row.get('run_id') == fleet.name
             and row.get('source') == 'fresh-clone' and row.get('app') == meta['app'], 'old resource custody')
        evidence = observations[machine]
        if evidence == {'sealed_native_release': True}:
            need(not registry.exists() and meta.get('status') == 'provider-teardown-verified'
                 and row.get('disposition') == 'destroyed-provider-retained', 'native release not sealed')
            local = fleet / 'teardown-ownership'
            seal = tree(local)
            need(tree(audit) == seal and fields(bound(local / 'source-audit'))
                 == {'path': str(audit), 'sha256': seal}, 'native release seal')
            release = float(bound(audit / 'provider-teardown-verified.epoch'))
            need(finite(release) and receipt['started_at'] <= release <= proof['confirmed_at'], 'native release clock')
        elif set(evidence) == {'original_absent_pair'}:
            isolated_absent_pair(fleet, owner, root, receipt, row, evidence['original_absent_pair'], proof, bound, document)
        elif set(evidence) == {'runless_current_os'}:
            isolated_runless_os(fleet, owner, root, receipt, row, evidence['runless_current_os'], proof, bound, document)
        elif 'provider_pair' in evidence:
            packet = document(evidence['provider_pair'])
            need(packet.get('endpoint_origin') == 'https://api.machines.dev' and packet.get('app') == meta['app'],
                 'provider observation origin')
            pair = [r for r in packet['rows'] if r.get('expected_machine') == machine]
            need(len(pair) == 2 and {r['kind'] for r in pair} == {'machine', 'volume'}, 'provider pair closure')
            for observed in pair:
                need(observed['method'] == 'GET' and observed['http_status'] == 200 and observed['no_retry'] is True
                     and observed['expected_volume'] == row['volume_id']
                     and re.fullmatch('[0-9a-f]{64}', observed['response_sha256']), 'provider response identity')
                value = observed['metadata']
                if observed['kind'] == 'machine':
                    need(observed['id'] == value['id'] == machine and value['state'] == 'destroyed'
                         and value['source_binding'] == {'REF': receipt['source']['head'], 'CLOUDBENCH_RUN_TOKEN': token},
                         'old execution not provider terminal')
                else:
                    need(observed['id'] == value['id'] == row['volume_id']
                         and value['state'] in {'pending_destroy', 'destroyed'} and value['attached_machine_id'] is None,
                         'old volume remains attached')
        else:
            observed = document(evidence['current_os'])
            value = observed['native_result']
            from datetime import datetime
            observed_at = datetime.fromisoformat(value['observed_at']).timestamp()
            need(finite(observed_at) and receipt['finished_at'] <= observed_at <= proof['confirmed_at'], 'OS observation clock')
            need(observed.get('status') == 'TERMINAL' and observed.get('native_exit') == 0
                 and observed.get('guard_identity_status') == 'PASS'
                 and observed.get('protected_original_inputs_unchanged') is True
                 and value.get('kind') == 'exact-original-current-os-read-only'
                 and value.get('result') == 'QUIESCED_CURRENT_OS' and value.get('identity_guards_pass') is True
                 and value.get('machine_id') == machine and value.get('guest_run_token') == token
                 and value.get('source') == receipt['source']['head']
                 and value.get('driver_current_alive') is False and value.get('socket_scan_readable') is True
                 and value.get('remote_effective_uid') == 0 and value.get('kernel_exclusion_flag') == 0x00200000
                 and value.get('unreadable_live_userland_errno_counts') == {}
                 and all(type(value.get(k)) is int and value[k] == 0 for k in ('original_service_pid_present_count',
                     'original_pid_identity_unproven_or_reused_count', 'scoped_execution_process_count',
                     'owned_listening_port_count', 'unreadable_proc_count', 'financial_calls', 'mutations')),
                 'current original execution quiescence unproven')
            for key in ('run', 'backend', 'services'):
                need(hashlib.sha256(bound(evidence[key])).hexdigest() == value[key + '_sha256'], 'OS payload binding')
        need(registry.exists() or row.get('disposition') == 'destroyed-provider-retained', 'resource not excluded')
    return {r['machine_id']: r['volume_id'] for r in rows}


def isolated_canary_release(fleet, life, benches, run, root, receipt, proof, link, bound, tree):
    """A linked infra-probe may fail before producing execution provenance, never task credit."""
    need(link and link['ref'] == receipt['source']['head']
         and link['owner'] == life['fleet_owner_token'], 'failed canary source/owner linkage')
    owner = life['fleet_owner_token']
    local, canonical = fleet / 'teardown-ownership', fleet_audit_root(root) / owner
    seal = tree(local)
    need(tree(canonical) == seal and life['audit_sha256'] == seal
         and fields(bound(local / 'source-audit')) == {'path': str(canonical), 'sha256': seal}, 'canary audit seal')
    meta = fields(bound(canonical / 'meta'))
    need(meta.get('status') == 'provider-teardown-verified' and meta.get('version') == '1'
         and meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root), 'canary provider release')
    epoch = float(bound(canonical / 'provider-teardown-verified.epoch'))
    need(finite(epoch) and receipt['started_at'] <= epoch <= proof['confirmed_at'], 'canary release clock')
    registry = fleet_ownership_root(root) / owner
    need(not registry.exists() and not registry.is_symlink(), 'canary registry retained')
    ids = bound(canonical / 'owned-clones.ids').decode().splitlines()
    names = bound(canonical / 'owned-clones.names').decode().splitlines()
    rows = [fields(bound(p)) for p in (canonical / 'fresh').iterdir()] if (canonical / 'fresh').exists() else []
    need(len(ids) == len(set(ids)) == len(rows) and set(ids) == {r['machine_id'] for r in rows}
         and len(names) == len(set(names)) == len(rows) and set(names) == {r['clone_name'] for r in rows}, 'canary resource closure')
    need(all(r.get('fleet_owner_token') == owner and r.get('run_id') == fleet.name
             and r.get('app') == meta['app'] and r.get('source') == 'fresh-clone'
             and r.get('disposition') == 'destroyed-provider-retained' for r in rows), 'canary resource not retired')
    for name in ('pool', 'pool-handoffs', 'volume-migrations'):
        path = canonical / name
        need(not path.exists() or path.is_dir() and not path.is_symlink() and not any(path.iterdir()), 'canary resource class')
    disposable = json.loads(bound(fleet / '_batch/disposable-cleanup.json'))
    need(disposable.get('schema') == 'disposable-cleanup-v1' and disposable.get('owner') == owner
         and disposable.get('guest_cleanup_missing') is False and disposable.get('runtime_evidence_missing') is False,
         'canary native cleanup unverified')
    tasks = run.get('tasks')
    need(run.get('run_id') == fleet.name and run.get('controller_exit_code') == life['controller_exit_code']
         and run.get('status') == 'failed' and isinstance(tasks, list) and len(tasks) == len(benches)
         and {t['name'] for t in tasks} == {b['name'] for b in benches}
         and all(t.get('status') == 'INFRA_ERROR' and t.get('passed') is False and not t.get('agent_id')
                 and not t.get('owned_roots') and t.get('lifecycle_stage') == 'released'
                 and t.get('failure_reason') == 'no current run artifact produced' for t in tasks), 'canary pre-task projection')
    return not rows  # Missing provenance is supported only before ANY native guest allocation.


def unlaunched_relay_retired(campaign, bound, document):
    """Observe startup-only local custody after every exact producer has joined."""
    location = document(campaign / 'shared-relay-location.json')
    directory = Path(location['directory'])
    need(directory.is_absolute() and directory.resolve() == directory
         and directory.parent == Path('/tmp') and directory.name.startswith('cb-relay-')
         and directory.is_dir() and not directory.is_symlink(), 'relay startup directory')
    archive = campaign / 'shared-relay'
    for name in ('authority.private.json', 'startup-cleanup.json', 'bootstrap.private.log', 'broker.private.log'):
        need(bound(directory / name) == bound(archive / name), 'relay startup archive differs')
    authority = document(directory / 'authority.private.json')
    cleanup = document(directory / 'startup-cleanup.json')
    socket = directory / 'fly-agent.sock'
    need(authority.get('agent_socket') == str(socket)
         and authority.get('inventory_directory') == str(campaign / 'shared-inventory')
         and cleanup.get('bootstrap_joined') is True
         and cleanup.get('agent_shutdown_verified') is False
         and cleanup.get('agent_retirement_pending') is True,
         'original startup custody')
    native = runpy.run_path(str(Path(__file__).with_name('cloudbench-shared-relay.py')))
    native['physical'](directory, True)
    prefix = 'proc-start:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':'
    def local_birth(value):
        """Require the producer's native identity on this exact machine boot."""
        return (isinstance(value, str) and value.startswith(prefix)
                and value[len(prefix):].isdigit() and int(value[len(prefix):]) > 0)
    need(type(authority.get('parent_pid')) is int and authority['parent_pid'] > 1
         and local_birth(authority.get('parent_start'))
         and native['birth'](authority['parent_pid']) != authority['parent_start'],
         'startup parent identity not retired on this host')
    for role in ('bootstrap', 'broker'):
        path = directory / (role + '-owner.json')
        if not path.exists():
            need(role == 'broker' and cleanup.get('broker_joined') is False
                 and not path.is_symlink() and not (archive / path.name).exists(), 'startup producer evidence absent')
            continue
        need(bound(path) == bound(archive / path.name), 'startup producer archive differs')
        owner = document(path)
        need(owner.get('parent_pid') == authority['parent_pid']
             and owner.get('parent_start') == authority['parent_start']
             and type(owner.get('pid')) is int and owner['pid'] > 1
             and local_birth(owner.get('birth'))
             and cleanup.get(role + '_joined') is True
             and native['birth'](owner['pid']) != owner['birth'], 'startup producer still live')
    need(not socket.exists() and not socket.is_symlink()
         and not (directory / 'ready.json').exists() and not (directory / 'ready.json').is_symlink(),
         'startup agent socket or admitted broker remains')
    # Before PING/version validation there is no sealed agent PID. Observe the
    # official executable's unique inherited socket scope, never signal by name.
    expected = ('FLY_AGENT_SOCKET_PATH=' + str(socket)).encode()
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if process.stat().st_uid != os.getuid() or not (process / 'comm').read_text().strip().startswith('flyctl'):
                continue
            need(expected not in (process / 'environ').read_bytes().split(b'\0'), 'unsealed startup agent remains')
        except (FileNotFoundError, ProcessLookupError):
            continue
    logs = [directory / name for name in ('bootstrap.private.log', 'broker.private.log')]
    holders = subprocess.run(['lsof', '-t', '--', *map(str, logs)], capture_output=True, timeout=10)
    need(holders.returncode == 1 and not holders.stdout and not holders.stderr, 'startup log holder remains')



def retired_local_process(value):
    """Refuse a live exact birth; PID reuse is never signalled by reconciliation."""
    need(type(value.get('pid')) is int and value['pid'] > 1
         and isinstance(value.get('birth'),str)
         and re.fullmatch(r'proc-start:[0-9a-f-]+:[0-9]+',value['birth']), 'local process identity')
    path = Path('/proc')/str(value['pid'])/'stat'
    try:
        row = path.read_text().rsplit(') ',1)[1].split()
        current = 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+row[19]
    except (FileNotFoundError,ProcessLookupError):
        return
    need(current != value['birth'] or row[0] in ('Z','X'), 'exact local process remains live')


def preallocation_processes(root,runs,campaign,request,receipt,adapter,document,bound):
    """Bind original supervised controller/relay closure before zero-allocation replay."""
    checks=request['checks']
    command=adapter.get('native_command',[])
    need(len(command)==len(checks)+10 and command[:2]==['bash','scripts/run-bench']
         and command[2:2+len(checks)]==checks and command[-8:-5]==['--runs','1','--concurrency']
         and command[-5].isdigit() and 1<=int(command[-5])<=len(checks)
         and command[-4:]==['--retry-infra','0','--ref',receipt['source']['head']], 'preallocation command')
    relay=campaign/'shared-relay'
    authority=document(relay/'authority.private.json')
    capture=document(relay/'startup-agent.json')
    ready=document(relay/'ready.json');serve=document(relay/'serve.once.json')
    bootstrap=document(relay/'bootstrap-owner.json');broker=document(relay/'broker-owner.json')
    parent=dict(pid=authority['parent_pid'],birth=authority['parent_start'])
    original=subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',
                                     receipt['source']['head']+':scripts/cloudbench-shared-relay.py'])
    need(authority['schema']=='shared-relay-authority-v1'
         and authority['source_sha256']==hashlib.sha256(original).hexdigest()
         and authority['inventory_directory']==str(campaign/'shared-inventory')
         and capture['schema']=='shared-relay-startup-agent-v1'
         and capture['authority_sha256']==ready['authority_sha256']==serve['authority_sha256']
             ==hashlib.sha256(bound(relay/'authority.private.json')).hexdigest()
         and capture['parent']==parent and capture['broker']==dict(pid=broker['pid'],birth=broker['birth'])
         and ready['agent']==capture['agent'] and ready['pid']==serve['pid']==broker['pid']
         and ready['birth']==serve['birth']==broker['birth']
         and all(v['parent_pid']==parent['pid'] and v['parent_start']==parent['birth'] for v in (bootstrap,broker)),
         'preallocation relay custody')
    location=document(campaign/'shared-relay-location.json')['directory']
    need(re.fullmatch(r'/tmp/cb-relay-[A-Za-z0-9_]{8}',location)
         and capture['socket']==authority['agent_socket']==location+'/fly-agent.sock'
         and ready['socket']==location+'/control.sock'
         and bound(relay/'broker.private.log').decode().strip()=='{"stopped": true}', 'preallocation relay shutdown')
    for name in ('fly-agent.sock','control.sock'):
        path=Path(location)/name
        need(not path.exists() and not path.is_symlink(), 'preallocation socket remains')
    inventory=campaign/'shared-inventory'
    publisher=authority['inventory_owner']
    need(publisher['parent_pid']==str(parent['pid']) and publisher['parent_start']==parent['birth'], 'preallocation publisher')
    owner=inventory/'owner'
    if owner.exists() or owner.is_symlink():
        need(fields(bound(owner))==publisher, 'preallocation publisher conflict')
    else:
        original=subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',
                                         receipt['source']['head']+':scripts/cloudbench-campaign-inventory.sh'])
        need(hashlib.sha256(original).hexdigest()=='e924d72f258bd5b2507348e5b53143aa4c2afa1c410cd63bdf495f27dfd2082d'
             and bound(inventory/'scripts/cloudbench-campaign-inventory.sh')==original
             and bound(inventory/'stop')==b'', 'preallocation publisher removal')
    identities=[parent,bootstrap,broker,capture['agent'],dict(pid=int(publisher['pid']),birth=publisher['pid_start'])]
    need(len({p['pid'] for p in identities})==len(identities), 'preallocation aliased identity')
    for value in identities:retired_local_process(value)
    supervisor=document(runs.parent/'cli.log.process.json')
    need(supervisor['child_pid']==parent['pid'] and supervisor['native_exit']==adapter['native_exit']
         and type(adapter['native_exit']) is int and 1<=adapter['native_exit']<=255
         and supervisor['quiescent'] is True and supervisor['remaining']==supervisor['kill_sent']==[]
         and supervisor['timed_out'] is False and supervisor['cancelled'] is False and supervisor['error'] is None
         and not Path('/proc',str(supervisor['supervisor_pid'])).exists()
         and len({r['pid'] for r in supervisor['reaped']})==len(supervisor['reaped'])
         and any(r==dict(pid=parent['pid'],status=adapter['native_exit']*256)for r in supervisor['reaped']),
         'preallocation supervisor closure')
    return supervisor


def preallocation_dispatch_ref(root, job, receipt, log_ref, native_command):
    """Use a captured command, or the exact original pre-banner dispatch contract."""
    head = receipt['source']['head']
    need(log_ref is None or log_ref == head, 'preallocation foreign log ref')
    command = job.get('controller_command')
    if command is not None:
        need(command == ['bash',str(root/'scripts/run-bench'),job['task'],'--ref',head,'--foreground'],
             'preallocation controller command source')
        return dict(kind='captured-controller-command-v1',ref=command[-2])
    # This historical producer printed its ref banner only after warm readiness.
    # Its immutable native_command carries --ref and the exact reviewed dispatcher
    # forwards that argument unchanged to every original per-task command.
    for name, expected in (
        ('run-bench','d6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e'),
        ('run-bench-campaign.py','2f12eeda57532f376a490b0afb4d234b1894fe1959285f867b350adff4600982'),
        ('run-bench-cloud','4c6c532f61bce7cdbd7b4113736df62730ee8df7e5a5a719bf82c462fbdb76fe'),
        ('run-bench-fleet','db6ca7938e1ca359402f6cf678569cca8a5562a721ccf8dfd47a53db5f37b429')):
        original = subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',head+':scripts/'+name])
        need(hashlib.sha256(original).hexdigest() == expected, 'unsupported historical preallocation dispatch')
    return dict(kind='historical-native-dispatch-v1',ref=native_command[-1])


def logged_startup_agent(proof, root, socket_path, parent, start, finish, bound):
    """Consume positive original Fly log identity; never invent a missing birth."""
    import ast
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    logs = proof.get('fly_native_logs')
    need(isinstance(logs,dict) and set(logs) == {'bootstrap','agent','timezone'}, 'startup original Fly logs and timezone required')
    try:
        zone = ZoneInfo(logs['timezone'])
    except (TypeError, ValueError, ZoneInfoNotFoundError) as error:
        raise ValueError('native cleanup: startup original timezone unavailable') from error
    bootstrap = bound(Path(logs['bootstrap'])).decode()
    agent = bound(Path(logs['agent'])).decode()
    matches = re.findall(r'^DEBUG started agent process \(pid: ([0-9]+), log: ([^\n]+)\)$',bootstrap,re.M)
    need(len(matches) == 1, 'startup native agent identity ambiguous')
    pid = int(matches[0][0])
    need(pid > 1 and f'DEBUG determined working directory: "{root}"' in bootstrap
         and 'dial unix '+str(socket_path)+': operation was canceled' in bootstrap
         and re.fullmatch(r'/[^\n]+/agent-logs/[0-9]+[.]log',matches[0][1])
         and Path(logs['agent']).resolve() == Path(matches[0][1]).resolve(), 'startup native bootstrap binding')
    observed, opened, stopped, quit_at = [], [], [], []
    for line in agent.splitlines():
        match = re.fullmatch(r'([0-9/]{10} [0-9:.]+) (.*)',line)
        need(match is not None, 'startup native log framing')
        local = datetime.strptime(match[1],'%Y/%m/%d %H:%M:%S.%f')
        zoned = local.replace(tzinfo=zone)
        need(zoned.utcoffset() == local.replace(tzinfo=zone,fold=1).utcoffset()
             and zoned.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == local,
             'startup ambiguous local log clock')
        instant = zoned.timestamp()
        need(start <= instant <= finish, 'startup native log clock')
        message = match[2]
        if message == 'srv OK '+str(pid): opened.append(instant)
        if message == 'srv parent process exited; shutting down': stopped.append(instant)
        if message == 'srv QUIT': quit_at.append(instant)
        frame = re.fullmatch(r'#[0-9]+ -> \( *([0-9]+)\) (".*")',message)
        if frame:
            raw = ast.literal_eval(frame[2]).encode('latin1')
            # Other RPC frames may be truncated/redacted by native logging;
            # they supply no identity evidence. A used PING must be complete.
            if b'"PID"' not in raw[2:]:
                continue
            need(len(raw) == int(frame[1]) and len(raw) >= 2
                 and int.from_bytes(raw[:2],'little') == len(raw)-2
                 and raw[2:].startswith(b'ok {'), 'startup native frame length')
            if raw[2:].startswith(b'ok {'):
                ping = json.loads(raw[5:])
                need(type(ping.get('PID')) is int and ping['PID'] == pid
                     and isinstance(ping.get('Version'),str) and ping['Version'], 'startup native PING identity')
                observed.append((instant,ping['Version']))
    need(len(opened) == len(stopped) == len(quit_at) == 1 and observed
         and opened[0] <= min(t for t,_v in observed) <= max(t for t,_v in observed)
         <= stopped[0] <= quit_at[0] and len({v for _t,v in observed}) == 1
         and 'write unix '+str(socket_path)+'->@' in agent, 'startup native shutdown chain')
    boot = parent['birth'].split(':')
    need(len(boot) == 3 and Path('/proc/sys/kernel/random/boot_id').read_text().strip() == boot[1],
         'startup native boot changed')
    # A reused PID is deliberately refused, even if a different birth is visible.
    need(not (Path('/proc')/str(pid)).exists(), 'startup logged agent PID present')
    return dict(pid=pid, native_log_identity=True, version=observed[0][1])


def startup_campaign(root, runs, campaign, request, receipt, adapter, confirmed, document, bound, proof):
    """Only a positively captured, supervised, never-dispatched startup can retire."""
    from datetime import datetime
    summary = document(campaign / 'summary.json')
    checks, jobs = request['checks'], summary['jobs']
    need(checks and len(set(checks)) == len(checks)
         and summary['campaign_id'] == campaign.name and summary['runs'] == 1
         and summary['retry_infra'] == 0 and summary['status'] == 'failed'
         and summary['peak_concurrency'] == 0 and summary['shared_inventory_failed'] is True
         and summary['task_count'] == summary['total_jobs'] == len(jobs) == len(checks), 'startup inventory')
    need(len({j['job_id'] for j in jobs}) == len(jobs) and {j['task'] for j in jobs} == set(checks)
         and all(re.fullmatch(r'r001-j[0-9]{4}', j['job_id']) and j['run'] == 1 and j['attempt'] == 1
                 and j['attempts'] == [] and j['status'] == 'cancelled'
                 and all(j.get(k) is None for k in ('started_at','finished_at','controller_pid','controller_exit_code','wall_clock_seconds'))
                 for j in jobs), 'startup dispatched job')
    need(runs.is_dir() and not any(runs.iterdir()), 'startup has native participants')
    need(not request.get('skips') and receipt.get('cases') == dict.fromkeys(checks,'UNVERIFIED')
         and adapter.get('cases') == receipt['cases'], 'startup case outcomes changed')
    command = adapter.get('native_command',[])
    need(len(command) == len(checks)+10 and command[:2] == ['bash','scripts/run-bench']
         and command[2:2+len(checks)] == checks and command[-8:-5] == ['--runs','1','--concurrency']
         and isinstance(command[-5],str) and command[-5].isdigit() and 1 <= int(command[-5]) <= len(checks)
         and command[-4:] == ['--retry-infra','0','--ref',receipt['source']['head']], 'startup native command')
    for job in jobs:
        log = campaign/(job['job_id']+'.log')
        need(job['log'] == str(log) and not log.exists() and not log.is_symlink(), 'startup job log present')
    need(not summary.get('startup_cohorts') and not summary.get('cleanup_ticket_failure')
         and not summary.get('shared_transport_cleanup_pending'), 'startup additional ownership')
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at','finished_at'))
    need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
         <= receipt['finished_at'] <= confirmed, 'startup clocks')
    relay = campaign / 'shared-relay'
    cleanup = document(relay / 'startup-cleanup.json')
    authority = document(relay / 'authority.private.json')
    bootstrap, broker = (document(relay / (name + '-owner.json')) for name in ('bootstrap','broker'))
    need(cleanup['bootstrap_joined'] is True and cleanup['broker_joined'] is True, 'startup joins')
    for name in ('ready.json','serve.once.json'):
        need(not (relay/name).exists() and not (relay/name).is_symlink(), 'startup reached relay admission')
    leases = relay/'leases'
    need(not leases.is_symlink() and (not leases.exists() or (leases.is_dir() and not any(leases.iterdir()))), 'startup relay leases present')
    parent = dict(pid=authority['parent_pid'], birth=authority['parent_start'])
    need(authority['schema'] == 'shared-relay-authority-v1'
         and all(v['parent_pid'] == parent['pid'] and v['parent_start'] == parent['birth'] for v in (bootstrap,broker))
         and authority['inventory_directory'] == str(campaign/'shared-inventory'), 'startup owner binding')
    location = document(campaign/'shared-relay-location.json')
    need(isinstance(location.get('directory'),str)
         and re.fullmatch(r'/tmp/cb-relay-[A-Za-z0-9_]{8}',location['directory'])
         and authority['agent_socket'] == location['directory']+'/fly-agent.sock', 'startup socket binding')
    # The authority carries the exact source used by the producer, not HEAD now.
    original = subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',
                                        receipt['source']['head']+':scripts/cloudbench-shared-relay.py'])
    campaign_source = subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',
                                               receipt['source']['head']+':scripts/run-bench-campaign.py'])
    need(authority['source_sha256'] == hashlib.sha256(original).hexdigest(), 'startup producer source')
    socket_path = Path(authority['agent_socket'])
    need(not socket_path.exists() and not socket_path.is_symlink(), 'startup private socket remains')
    if cleanup.get('schema') == 'shared-relay-startup-cleanup-v1':
        need(not proof.get('fly_native_logs')
             and all(type(cleanup.get(k)) is int for k in ('bootstrap_exit','broker_exit'))
             and cleanup['broker_exit'] != 0, 'startup duplicate agent authority or joins')
        capture = document(relay/'startup-agent.json')
        need(capture.get('schema') == 'shared-relay-startup-agent-v1'
             and cleanup['agent_identity_sha256'] == hashlib.sha256(bound(relay/'startup-agent.json')).hexdigest()
             and capture['authority_sha256'] == hashlib.sha256(bound(relay/'authority.private.json')).hexdigest()
             and capture['parent'] == cleanup['parent'] == parent
             and capture['broker'] == dict(pid=broker['pid'],birth=broker['birth'])
             and capture['socket'] == str(socket_path)
             and cleanup['producer_sha256'] == hashlib.sha256(campaign_source).hexdigest(), 'startup capture binding')
        agent = capture['agent']
        need(type(capture['uid']) is int and capture['uid'] == (relay/'startup-agent.json').stat().st_uid
             and isinstance(agent.get('version'),str) and agent['version']
             and isinstance(agent.get('socket_identity'),list) and len(agent['socket_identity']) == 2
             and all(type(x) is int and x >= 0 for x in agent['socket_identity']), 'startup peer identity')
        supervisor = document(runs.parent/'cli.log.process.json')
        need(type(adapter['native_exit']) is int and adapter['native_exit'] != 0
             and supervisor['native_exit'] == adapter['native_exit'] and supervisor['child_pid'] == parent['pid']
             and supervisor['quiescent'] is True and supervisor['orphaned_children'] is False
             and supervisor['timed_out'] is False and supervisor['cancelled'] is False
             and supervisor['remaining'] == supervisor['term_sent'] == supervisor['kill_sent'] == []
             and supervisor['error'] is None
             and any(r.get('pid') == parent['pid'] and r.get('status') == adapter['native_exit'] * 256
                     for r in supervisor['reaped']), 'startup native process closure')
    else:
        need(cleanup == dict(bootstrap_joined=True,broker_joined=True,agent_shutdown_verified=False,
                             agent_retirement_pending=True)
             and all(type(v) is bool for v in cleanup.values())
             and not (relay/'startup-agent.json').exists()
             and bound(relay/'broker.private.log').decode().strip() == 'unsupported Fly agent version',
             'unsupported legacy startup record')
        agent = logged_startup_agent(proof,root,socket_path,parent,start,finish,bound)
    # Never infer which agent retired from socket disappearance or a process name.
    inventory_directory = campaign/'shared-inventory'
    owner_path = inventory_directory/'owner'
    if owner_path.exists() or owner_path.is_symlink():
        publisher = fields(bound(owner_path))
    else:
        # This exact producer joins its snapshot loop and removes owner on EXIT.
        # Use the original captured authority, never recreate a deleted owner.
        # Unknown producer contracts remain unsupported rather than inferred.
        publisher_source = subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',
                                                    receipt['source']['head']+':scripts/cloudbench-campaign-inventory.sh'])
        need(hashlib.sha256(publisher_source).hexdigest()
             == 'e924d72f258bd5b2507348e5b53143aa4c2afa1c410cd63bdf495f27dfd2082d'
             and bound(inventory_directory/'scripts/cloudbench-campaign-inventory.sh') == publisher_source,
             'startup publisher removal contract')
        need(bound(inventory_directory/'stop') == b'', 'startup publisher stop marker')
        publisher = authority['inventory_owner']
    need(publisher == authority['inventory_owner'] and publisher['parent_pid'] == str(parent['pid'])
         and publisher['parent_start'] == parent['birth'], 'startup inventory publisher binding')
    inventory = dict(pid=int(publisher['pid']),birth=publisher['pid_start'])
    identities = [parent, bootstrap, broker, agent, inventory]
    need(len({v['pid'] for v in identities}) == len(identities), 'startup aliased process identity')
    for value in identities:
        if value.get('native_log_identity') is True:
            continue  # Checked PID absence and boot above; no fabricated birth.
        need(type(value.get('pid')) is int and value['pid'] > 1
             and isinstance(value.get('birth'),str)
             and re.fullmatch(r'proc-start:[0-9a-f-]+:[0-9]+',value['birth']), 'startup process identity')
        path = Path('/proc')/str(value['pid'])/'stat'
        try:
            process_fields = path.read_text().rsplit(') ',1)[1].split()
            current = 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+process_fields[19]
        except (FileNotFoundError,ProcessLookupError):
            continue
        need(current != value['birth'] or process_fields[0] in ('Z','X'), 'startup exact process remains live')
    # Reuse the native publisher contract; failed inventory is retained as a
    # failure, while all local publication processes must have actually joined.
    from deploy_test_cloud import campaign_published
    native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
    for path in (campaign/'hub-group.json',campaign/'hub-group-publication-ack.private.json'):
        document(path)
    try:
        published = campaign_published(summary,campaign,adapter['started_at'],native)
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
        raise ValueError('native cleanup: startup publication unavailable') from error
    need(published, 'startup publication closure')
    return identities


PREFLIGHT_REFUSAL = 'FATAL: requested benchmark commit {} is not fetchable from origin and local patch shipping is disabled'
PREFLIGHT_PRODUCER = ('echo "FATAL: requested benchmark commit $resolved is not fetchable from origin '
                      'and local patch shipping is disabled" >&2')
PREFLIGHT_DISPATCH = ('if ! BENCH_REF="$(cloudbench_fetchable_ref "$ROOT_DIR" "$BENCH_REF" \\\n'
                      '        "$([ "${CLOUDBENCH_SKIP_LOCAL_PATCH:-0}" = "1" ] && printf 0 || printf 1)")"; then\n'
                      '        exit 1\n')


def preflight_refusal_campaign(root, runs, campaign, request, receipt, adapter, confirmed, document, bound, proof):
    """Every dispatched job refused at run-bench preflight before any fleet existed (PR #1767).

    Positive evidence only: each job's bound log ends in the exact producer refusal for the bound
    source, with no monitor handle; no fleet participant exists; relay, publisher and supervisor
    closure are replayed exactly as for a preallocation campaign. Launch eligibility only."""
    from datetime import datetime
    head = receipt['source']['head']
    summary = document(campaign / 'summary.json')
    checks, jobs = request['checks'], summary['jobs']
    need(checks and len(set(checks)) == len(checks) and not request.get('skips')
         and summary['campaign_id'] == campaign.name and summary['runs'] == 1
         and summary['retry_infra'] == 0 and summary['status'] == 'failed'
         and summary['task_count'] == summary['total_jobs'] == len(jobs) == len(checks)
         and {j['task'] for j in jobs} == set(checks) and len({j['job_id'] for j in jobs}) == len(jobs),
         'preflight inventory')
    need(not any(summary.get(k) for k in ('cleanup_ticket_failure', 'shared_inventory_failed',
                                          'shared_transport_cleanup_pending', 'workspace_binding'))
         and not any(c.get('cleanup_budget_retirement_pending') for c in summary.get('startup_cohorts', [])),
         'preflight additional ownership')
    unverified = dict.fromkeys(checks, 'UNVERIFIED')
    need(receipt.get('cases') == adapter.get('cases') == unverified and adapter.get('complete') is False
         and adapter.get('cleanup_complete') is False and adapter.get('reason') is None
         and adapter.get('fleet_directory') == str(campaign) and type(adapter.get('native_exit')) is int
         and 1 <= adapter['native_exit'] <= 255
         and adapter.get('evidence') == {n: {'unverified': 'campaign job has no native fleet handle'} for n in checks},
         'preflight adapter outcome')
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
    need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
         <= receipt['finished_at'] <= confirmed, 'preflight clocks')
    need(runs.is_dir() and not runs.is_symlink() and runs.resolve() == runs and not any(runs.iterdir()),
         'preflight fleet participant present')
    # The bound source's own producer emits this exact refusal and exits before lock or Machine.
    library = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                       head + ':scripts/lib/cloudbench-env.sh']).decode()
    fleet = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                     head + ':scripts/run-bench-fleet']).decode()
    need(library.count(PREFLIGHT_PRODUCER) == 1 and fleet.count(PREFLIGHT_DISPATCH) == 1,
         'unsupported preflight producer')
    refusal = PREFLIGHT_REFUSAL.format(head)
    refused = {}
    for job in jobs:
        need(re.fullmatch(r'r001-j[0-9]{4}', job['job_id']) and job['run'] == 1 and job['attempt'] == 1
             and job['attempts'] == [] and job['status'] == 'failed'
             and type(job.get('controller_exit_code')) is int and 1 <= job['controller_exit_code'] <= 255
             and type(job.get('controller_pid')) is int and job['controller_pid'] > 1
             and job.get('controller_command') == ['bash', str(root / 'scripts/run-bench'), job['task'],
                                                   '--ref', head, '--foreground'], 'preflight job')
        need(job['job_id'] not in refused and job['task'] in checks, 'preflight job identity')
        log = campaign / (job['job_id'] + '.log')
        need(job['log'] == str(log), 'preflight job log binding')
        lines = [line.strip() for line in bound(log).decode(errors='replace').splitlines() if line.strip()]
        need(lines and lines[-1] == refusal and sum(line.startswith('FATAL:') for line in lines) == 1,
             'preflight refusal for the bound source')
        # The exact fleet handle/banner shapes campaign-v1 parses; prose such as "printed monitor" is not one.
        handle = str(root / 'scripts/run-bench') + ' monitor '
        need(not any(handle in line or re.fullmatch(r'ref\s*:\s*([0-9a-f]{40})(?:\s+.*)?', line) for line in lines),
             'preflight dispatched a fleet')
        # A live or reused controller PID is refused, never signalled.
        need(not Path('/proc', str(job['controller_pid'])).exists(), 'preflight controller PID present')
        refused[job['job_id']] = {'task': job['task'], 'controller_exit_code': job['controller_exit_code']}
    supervision = preallocation_processes(root, runs, campaign, request, receipt, adapter, document, bound)
    need(supervision['term_sent'] == supervision['kill_sent'] == [] and supervision['orphaned_children'] is False,
         'preflight unexpected supervised termination')
    from deploy_test_cloud import campaign_published
    native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
    for path in (campaign / 'hub-group.json', campaign / 'hub-group-publication-ack.private.json'):
        document(path)
    try:
        published = campaign_published(summary, campaign, adapter['started_at'], native)
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
        raise ValueError('native cleanup: preflight publication unavailable') from error
    need(published, 'preflight publication closure')
    return refused


def dispatch_refusal(root, runs, campaign, request, receipt, adapter, confirmed, document, bound):
    """Retire only the audited source-refusal path before any fleet admission.

    This grants launch eligibility, never task or financial cleanup credit.
    Unknown historical producers still require their own custody proof.
    """
    policies = {
        'scripts/run-bench': 'd6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e',
        'scripts/run-bench-fleet': '7552a933e8510bfb3b2b03787cd102d7f144cb25039ea4a9e883d29a48c57451',
        'scripts/lib/cloudbench-env.sh': '166f249b055d9b5ebf6d28cb54c7f522e4ad0ab5652cfe670ecc58388a947e2d',
        'scripts/run-bench-campaign.py': '57196da49e7dd07eb696e85ee8b6394d61237ad339579093d12c5645f298691f',
    }
    for name, expected in policies.items():
        original = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                            receipt['source']['head'] + ':' + name])
        need(hashlib.sha256(original).hexdigest() == expected, 'unaudited dispatch refusal producer: ' + name)
    checks = request['checks']
    skips = request.get('skips', {})
    from deploy_test_historical_custody import KIND as CUSTODY_KIND
    need(checks and len(set(checks)) == len(checks) and not set(checks).intersection(skips)
         and all(isinstance(v, dict) and v.get('kind') == CUSTODY_KIND
                 and v.get('disposition') == 'NO_RETRY_CUSTODY' and v.get('source') == receipt['source']
                 and v.get('current_binding', {}).get('source') == receipt['source']
                 and v.get('current_execution') == v.get('current_financial_state') == 'UNVERIFIED'
                 and v.get('credit') == {'test_execution': False, 'assertions': False, 'financial_release': False}
                 for v in skips.values()), 'dispatch refusal exclusion inventory')
    expected = {**dict.fromkeys(checks, 'UNVERIFIED'), **dict.fromkeys(skips, 'SKIP')}
    need(receipt['cases'] == expected and adapter['cases'] == dict.fromkeys(checks, 'UNVERIFIED')
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False
         and adapter.get('reused') is False and adapter.get('native_exit') == 1,
         'dispatch refusal original outcomes')
    need(runs.is_dir() and not runs.is_symlink() and not any(runs.iterdir()), 'dispatch refusal has native participants')
    summary = document(campaign / 'summary.json')
    jobs = summary['jobs']
    need(summary['campaign_id'] == campaign.name and summary['runs'] == 1 and summary['retry_infra'] == 0
         and summary['status'] == 'failed' and summary['task_count'] == summary['total_jobs'] == len(jobs) == len(checks)
         and len({j['job_id'] for j in jobs}) == len(jobs) and {j['task'] for j in jobs} == set(checks)
         and not any(summary.get(k) for k in ('startup_cohorts', 'cleanup_ticket_failure',
                                             'shared_inventory_failed', 'shared_transport_cleanup_pending')),
         'dispatch refusal campaign inventory')
    from datetime import datetime
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
    need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
         <= receipt['finished_at'] <= confirmed, 'dispatch refusal clocks')
    message = ('FATAL: requested benchmark commit ' + receipt['source']['head']
               + ' is not fetchable from origin and local patch shipping is disabled')
    pids = []
    for job in jobs:
        need(re.fullmatch(r'r001-j[0-9]{4}', job['job_id']) and job['run'] == job['attempt'] == 1
             and job['attempts'] == [] and job['status'] == 'failed' and type(job['controller_exit_code']) is int
             and job['controller_exit_code'] == 1 and type(job['controller_pid']) is int
             and job['controller_pid'] > 1 and start <= datetime.fromisoformat(job['started_at']).timestamp()
             <= datetime.fromisoformat(job['finished_at']).timestamp() <= finish
             and job['controller_command'] == ['bash', str(root / 'scripts/run-bench'), job['task'],
                                               '--ref', receipt['source']['head'], '--foreground'],
             'dispatch refusal child identity')
        log = campaign / (job['job_id'] + '.log')
        need(job['log'] == str(log), 'dispatch refusal log binding')
        lines = bound(log).decode().splitlines()
        need(lines and lines[-1] == message and lines.count(message) == 1
             and not any(str(root / 'scripts/run-bench') + ' monitor ' in line for line in lines),
             'dispatch refusal exact boundary')
        need(not Path('/proc', str(job['controller_pid'])).exists(), 'dispatch refusal child remains')
        pids.append(job['controller_pid'])
    need(len(set(pids)) == len(pids), 'dispatch refusal aliased children')
    supervisor = preallocation_processes(root, runs, campaign, request, receipt, adapter, document, bound)
    need(supervisor['orphaned_children'] is False and supervisor['term_sent'] == [], 'dispatch refusal supervision')
    from deploy_test_cloud import campaign_published
    native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
    for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
        document(campaign / name)
    need(campaign_published(summary, campaign, adapter['started_at'], native), 'dispatch refusal publication closure')


def inventory_init_failure(root, runs, campaign, request, receipt, adapter, bound, document):
    """A sealed, read-only publisher timeout before any fleet or relay admission."""
    checks = request['checks']
    need(receipt.get('cases') == adapter.get('cases') == dict.fromkeys(checks, 'UNVERIFIED')
         and receipt.get('case_complete') == dict.fromkeys(checks, False)
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False
         and type(adapter.get('native_exit')) is int and adapter['native_exit'] == 1,
         'inventory init changed outcome')
    command = adapter.get('native_command', [])
    need(len(command) == len(checks) + 10 and command[:2] == ['bash', 'scripts/run-bench']
         and command[2:2+len(checks)] == checks and command[-8:-5] == ['--runs', '1', '--concurrency']
         and command[-5].isdigit() and 1 <= int(command[-5]) <= len(checks)
         and command[-4:] == ['--retry-infra', '0', '--ref', receipt['source']['head']],
         'inventory init native command')
    # These original native producers initialize the API-only feed before relay
    # or task dispatch; later source changes must establish their own boundary.
    supported = {
        'scripts/cloudbench-campaign-inventory.sh': 'e924d72f258bd5b2507348e5b53143aa4c2afa1c410cd63bdf495f27dfd2082d',
        'scripts/lib/cloudbench-inventory.sh': '01dc00ebba29ea4307f78774c3d8d73fd214c64f06fda1d00fc86df24c08b8e2',
        'scripts/run-bench-campaign.py': '57196da49e7dd07eb696e85ee8b6394d61237ad339579093d12c5645f298691f',
        'scripts/lib/cloudbench-env.sh': '166f249b055d9b5ebf6d28cb54c7f522e4ad0ab5652cfe670ecc58388a947e2d',
        'scripts/cloudbench-campaign-machines.py': 'e85eb826790c70e87b4d397467e01b2d1f9e805ce1efedb458edc16bff60353b',
        'scripts/cloudbench-machine-readiness.py': '5843e509a64380711147b140c346e81622a2f904b300d3af5a247415f5488797',
        'scripts/run-bench': 'd6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e',
        'scripts/cloudbench_catalog.py': 'fd6adad0f3961a77f5cbb8b82abd648e910614cd0017c21f116f413be6e7702e',
        'scripts/cloudbench-timeout-policy.py': '1a5b0453284a8c0af9bc4fd2d5e9bd38fd50b275fee373f677af7d8816f6d5f5',
        'scripts/cloudbench-shard-coordinator.py': '1af282bba9119573f489f671790bdad3cbe758e664ac406c92c9fedd503831c5',
        'agents/benchmarks/benchmark_tasks.py': 'be31c1eb4b0be2fc6fd75f9fa0d17617757348206df3649d6707a9a122356a61',
        'agents/benchmarks/fixtures.py': 'f91cf759cab84c6f35b3d5f69d9b672f7ae5f90d65dad4442808d4228a91b95e',
        'agents/benchmarks/live_fixtures.py': 'd6262bda88a214a79f340275f08fd7327bf8f933bd401822e142941001447efd',
        'agents/benchmarks/polar_catalog.py': '23809eb3426240e01271dff3b562388ca42974cff5a6466413ac7c949a7de319',
        'agents/benchmarks/timeout_history.py': '4f63f44e8d59b5e77fcc317ba376b7289306772eb6c029b42f4b3ae28854c148',
        'agents/benchmarks/history_ledger.py': '8a7f727b0c1988f4ae78381d10328680a03f607c59806b3cb795bf76d1ae3f72',
        'scripts/cloudbench-provider-capacity.py': 'b8ffc0fa2a39b6b390d45ef839030bd4a33585cd1716a724fbd2538b8bd15eea',
        'scripts/cloudbench-production-only-tasks.py': '1913e6273aa278a2ee7bf4685c35c92a102dc8f254ae571a35acd040333e0887',
        'scripts/cloudbench-campaign-seed.py': '4435e9c3bfbca5fea28b196f9d2c9a653d708b4bf6c43b7d2df2df6a8a087316',
        'agents/benchmarks/hub_upload.py': '9717841cd456c9a0e48d5807746a142f63f01a4984e0dbaf5b61ab667fc005e5',
        'scripts/cloudbench-scorecard.py': '2084612fbc0468f5ddffad7e86794660cb219ffea1d9a534697623859935524f',
        'scripts/cloudbench_experiments.py': '3ae289a75fd1a1188c49d28636dc9b30927ba5a74a8e5c9bc6e384a672c6c797',
        'scripts/cloudbench-port-lease.py': '183116af91e2044a91c3d497d4229db78caa8c867af408a3448fb15c58b021e1',
    }
    for relative, expected in supported.items():
        original = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                            receipt['source']['head'] + ':' + relative])
        need(hashlib.sha256(original).hexdigest() == expected, 'inventory init unsupported producer')
        if relative in {'scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
                        'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-campaign-machines.py',
                        'scripts/cloudbench-machine-readiness.py'}:
            need(bound(campaign / 'shared-inventory/scripts' / Path(relative).name) == original,
                 'inventory init source changed')
    inventory = campaign / 'shared-inventory'
    text = bound(inventory / 'publisher.private.log').decode()
    match = re.fullmatch(r'\[warn\] FLY_COMPLETION_TIMEOUT shell_pid=([0-9]+) shell_start_ticks=([0-9]+) '
                         r'fly_return_status=unknown fifo_read_status=142\n'
                         r'❌ shared inventory snapshot did not initialize\n', text)
    need(match is not None and int(match[1]) > 1, 'inventory init timeout boundary')
    diagnostic = inventory / 'inventory-refresh-diagnostics'
    latest = fields(bound(diagnostic / 'latest'))
    need(latest.get('phase') == 'volumes-list' and latest.get('status') == '142'
         and latest.get('elapsed_seconds', '').isdigit()
         and latest.get('epoch', '').isdigit() and latest.get('pid', '').isdigit()
         and int(latest['pid']) > 1, 'inventory init diagnostic')
    need(bound(diagnostic / 'history').decode().splitlines() == [
        '\t'.join((latest['epoch'], 'volumes-list', '142', latest['elapsed_seconds']))]
         and bound(diagnostic / 'failure.raw.private') == b'', 'inventory init diagnostic history')
    supervisor = document(runs.parent / 'cli.log.process.json')
    child, owner = supervisor.get('child_pid'), supervisor.get('supervisor_pid')
    need(type(child) is int and child > 1 and type(owner) is int and owner > 1 and child != owner
         and type(supervisor.get('native_exit')) is int
         and supervisor.get('native_exit') == adapter['native_exit']
         and supervisor.get('quiescent') is True and supervisor.get('orphaned_children') is False
         and supervisor.get('remaining') == supervisor.get('term_sent') == supervisor.get('kill_sent') == []
         and supervisor.get('timed_out') is False and supervisor.get('cancelled') is False
         and supervisor.get('error') is None
         and supervisor.get('reaped') == [dict(pid=child, status=adapter['native_exit'] * 256)],
         'inventory init supervisor closure')
    for pid in {child, owner, int(match[1]), int(latest['pid'])}:
        need(not Path('/proc', str(pid)).exists(), 'inventory init process remains')


def validate(receipt, owner, proof):
    """Validate bound native retirement evidence without granting execution credit."""
    from deploy_test_cycle import MAX_RECEIPT_BYTES, bounded_read, sha_file
    need(proof.get('kind') == KIND and proof.get('owner') == owner, 'full original owner mismatch')
    need(set(owner) == {'request_token', 'worker_root', 'native_cleanup_reference'}, 'unsupported owner shape')
    token, root = receipt['token'], Path(owner['worker_root'])
    need(root.is_absolute() and root.resolve() == root, 'noncanonical worker root')
    need(proof['request_token'] == owner['request_token'] == token and proof['source'] == receipt['source'], 'request identity')
    folder = Path(receipt['log']).parent
    adapter_path = Path(receipt['worker_result'])
    adapter = bounded_read(adapter_path, 'native adapter')
    need(bounded_read(folder / 'receipt.json', 'native receipt') == receipt, 'recorded receipt changed')
    receipt_sha, adapter_sha = sha_file(folder / 'receipt.json'), sha_file(adapter_path)
    need(proof['receipt_sha256'] == receipt_sha and proof['worker_result_sha256'] == adapter_sha, 'original bytes changed')
    need(all(adapter.get(k) == receipt.get(k) for k in ('token', 'source', 'gate')), 'adapter identity')
    reference = owner['native_cleanup_reference']
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('complete') is False
         and receipt.get('timed_out') is False and receipt.get('cancelled') is False
         and reference == receipt.get('native_cleanup_reference') and reference['result'] == str(adapter_path)
         and reference['result_sha256'] == adapter_sha, 'native cleanup reference')
    confirmed = proof['confirmed_at']
    need(finite(confirmed) and finite(receipt['finished_at']) and receipt['finished_at'] <= confirmed <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'confirmation')
    bindings, used = proof['files'], set()
    run_artifacts = set()
    raw_remaining = [MAX_RAW_FORENSIC_RUN_BYTES]
    historical_sources = {}
    need(isinstance(bindings, dict), 'missing file bindings')

    def bound(path, limit=MAX_RECEIPT_BYTES, *, historical_head=None):
        path = Path(path)
        historical_head = historical_head or historical_sources.get(str(path))
        need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'noncanonical proof file')
        if historical_head is not None:
            need(isinstance(historical_head, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', historical_head),
                 'historical producer head')
            relative = path.relative_to(root)
            need(relative.parts[0] == 'scripts', 'historical producer scope')
            raw = subprocess.check_output(['git', '-C', str(root), 'show', historical_head + ':' + relative.as_posix()])
            need(len(raw) <= min(limit, MAX_RECEIPT_BYTES), 'proof file too large')
        else:
            need(path.is_file(), 'noncanonical proof file')
            need(path.stat().st_size <= limit, 'proof file too large')
            raw = path.read_bytes()
        need(bindings.get(str(path)) == hashlib.sha256(raw).hexdigest(), 'file hash mismatch: ' + str(path))
        used.add(str(path))
        if historical_head is not None:
            historical_sources[str(path)] = historical_head
        return raw

    def document(path, limit=MAX_RECEIPT_BYTES):
        value = json.loads(bound(path, limit))
        need(isinstance(value, dict), 'expected object')
        return value

    def tree(path):
        need(path.resolve() == path and path.is_dir() and not path.is_symlink(), 'audit directory')
        digest = hashlib.sha256()
        for item in sorted(path.rglob('*'), key=lambda p: str(p.relative_to(path))):
            need(not item.is_symlink() and (item.is_dir() or item.is_file()), 'unsafe audit member')
            if item.is_file() and item.name != 'source-audit':
                for value in (str(item.relative_to(path)).encode(), bound(item)):
                    digest.update(len(value).to_bytes(8, 'big'))
                    digest.update(value)
        return digest.hexdigest()

    request = document(folder / 'request.json')
    need(all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate')), 'request document')
    runs = root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest() / 'runs'
    cli = runs.parent / 'cli.log'
    need(adapter.get('runner_log') == str(cli), 'adapter native root')
    cli_text = bound(cli).decode()
    parents, canary_links, preallocation_links = {}, {}, {}
    layout = proof.get('layout')
    if layout in {'campaign-unlaunched-v1', 'campaign-unlaunched-relay-v1', 'campaign-inventory-init-failure-v1'}:
        # Missing host tooling can stop inventory before any controller exists.
        # Reconcile only that zero-admission boundary, retaining every native
        # UNVERIFIED outcome. A launched campaign still needs the fleet audit.
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('purpose')
             and not proof.get('controller_log') and not proof.get('recovered_runtime')
             and reference.get('native_directory') == str(campaign)
             and str(campaign) in cli_text,
             'unlaunched startup failure binding')
        if layout == 'campaign-unlaunched-v1':
            need("No such file or directory: 'flyctl'" in cli_text, 'missing executable boundary')
        elif layout == 'campaign-unlaunched-relay-v1':
            unlaunched_relay_retired(campaign, bound, document)
        else:
            inventory_init_failure(root, runs, campaign, request, receipt, adapter, bound, document)
        summary = document(campaign / 'summary.json')
        checks, jobs = request['checks'], summary['jobs']
        need(checks and len(set(checks)) == len(checks)
             and summary.get('campaign_id') == campaign.name and summary.get('runs') == 1
             and summary.get('retry_infra') == 0 and summary.get('status') == 'failed'
             and type(summary.get('peak_concurrency')) is int and summary['peak_concurrency'] == 0
             and summary.get('shared_inventory_failed') is True and not summary.get('startup_cohorts')
             and summary.get('task_count') == summary.get('total_jobs') == len(checks) == len(jobs),
             'unlaunched campaign inventory')
        need({job.get('task') for job in jobs} == set(checks)
             and all(job.get('job_id') == f'r001-j{index:04d}' and job.get('run') == 1
                     and job.get('attempt') == 1 and job.get('attempts') == []
                     and job.get('status') == 'cancelled'
                     and all(job.get(key) is None for key in
                             ('controller_pid', 'controller_exit_code', 'started_at', 'finished_at', 'wall_clock_seconds'))
                     and job.get('log') == str(campaign / (job['job_id'] + '.log'))
                     and not Path(job['log']).exists() and not Path(job['log']).is_symlink()
                     for index, job in enumerate(jobs, 1)), 'a campaign controller was admitted')
        need(runs.is_dir() and not runs.is_symlink() and not any(runs.iterdir()), 'native fleet resources exist')
        from datetime import datetime
        start, finish = (datetime.fromisoformat(summary[key]).timestamp() for key in ('started_at', 'finished_at'))
        need(adapter['started_at'] <= start <= finish <= receipt['finished_at'] <= confirmed,
             'unlaunched terminal clocks')
        inventory = campaign / 'shared-inventory'
        need(bound(inventory / 'stop') == b'' and not (inventory / 'owner').exists()
             and not (inventory / 'owner').is_symlink(), 'inventory publisher still owns startup')
        logs = [cli, inventory / 'publisher.private.log', campaign / 'hub-group-publication.private.log']
        for path in logs[1:]:
            bound(path)
        holders = subprocess.run(['lsof', '-t', '--', *map(str, logs)], capture_output=True, timeout=10)
        need(holders.returncode == 1 and not holders.stdout and not holders.stderr,
             'startup log writer or unknown process observation')
        for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
            document(campaign / name)
        from deploy_test_cloud import campaign_published
        native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
        need(campaign_published(summary, campaign, adapter['started_at'], native), 'startup publication or publisher cleanup')
        need(used == set(bindings), 'unlaunched proof file closure')
        return {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
                'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
                'participants': [], 'native_audit_seals': {}, 'retained_services': [], 'credit_granted': False}
    if layout == 'campaign-ref-preflight-v1':
        from deploy_test_native_ref_preflight import validate_ref_preflight
        result = validate_ref_preflight(receipt, owner, proof, adapter, root, runs, cli_text, bound, document)
        need(used == set(bindings), 'proof file closure')
        return result
    if layout == 'campaign-prelaunch-v1':
        from deploy_test_native_prelaunch import validate_prelaunch
        result = validate_prelaunch(receipt, owner, proof, adapter, root, runs, cli_text, bound, document)
        need(used == set(bindings), 'proof file closure')
        return result
    if layout == 'campaign-cleanup-prepare-v1':
        from deploy_test_native_prepare import validate_prepare
        result = validate_prepare(receipt, owner, proof, adapter, root, runs, cli_text, bound, document)
        need(used == set(bindings), 'prepare proof file closure')
        return result
    if layout == 'campaign-dispatch-refusal-v1':
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
             and proof.get('purpose') is None and not proof.get('recovered_runtime')
             and reference.get('native_directory') == str(campaign)
             and str(campaign) in cli_text, 'dispatch refusal root binding')
        dispatch_refusal(root, runs, campaign, request, receipt, adapter, confirmed, document, bound)
        need(used == set(bindings), 'dispatch refusal proof file closure')
        return {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
                'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
                'participants': [], 'native_audit_seals': {}, 'retained_services': [],
                'credit_granted': False, 'financial_cleanup_credit': False}
    if layout == 'campaign-startup-v1':
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
             and proof.get('purpose') is None and not proof.get('recovered_runtime')
             and reference.get('native_directory') == str(campaign)
             and str(campaign) in cli_text, 'startup root binding')
        identities = startup_campaign(root, runs, campaign, request, receipt, adapter, confirmed, document, bound, proof)
        need(used == set(bindings), 'startup proof file closure')
        return {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
                'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
                'participants': [], 'native_audit_seals': {}, 'retained_services': [],
                'startup_processes': identities, 'credit_granted': False}
    if layout == 'campaign-preflight-refusal-v1':
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
             and proof.get('purpose') is None and not proof.get('recovered_runtime')
             and not proof.get('current_hub_retirement')
             and reference.get('native_directory') == str(campaign)
             and str(campaign) in cli_text, 'preflight root binding')
        refused = preflight_refusal_campaign(root, runs, campaign, request, receipt, adapter, confirmed,
                                             document, bound, proof)
        need(used == set(bindings), 'preflight proof file closure')
        return {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
                'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
                'participants': [], 'native_audit_seals': {}, 'retained_services': [],
                'preflight_refusals': refused, 'credit_granted': False}
    preallocation = layout == 'campaign-preallocation-v1'
    mixed = layout == 'campaign-mixed-preallocation-v1'
    staged_preallocation = preallocation or mixed
    supervision = None
    if layout in {'campaign-v1', 'campaign-preallocation-v1', 'campaign-admission-rejected-v1', 'campaign-mixed-preallocation-v1'}:
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
             and (reference.get('native_directory') == str(campaign) or preallocation
                  and reference.get('native_directory') is None and adapter.get('fleet_directory') is None
                  and adapter.get('reason') == 'cloud command interrupted or source changed')
             and str(campaign) in cli_text, 'campaign root binding')
        summary = document(campaign / 'summary.json')
        checks, jobs = request['checks'], summary['jobs']
        need(checks and len(set(checks)) == len(checks)
             and summary['campaign_id'] == campaign.name and summary['runs'] == 1
             and summary['retry_infra'] == 0 and summary['task_count'] == len(checks)
             and summary['total_jobs'] == len(checks) == len(jobs)
             and summary['status'] in {'passed', 'failed', 'cancelled'}, 'campaign inventory')
        need(len({j['job_id'] for j in jobs}) == len(jobs)
             and {j['task'] for j in jobs} == set(checks)
             and all(j['run'] == 1 and j['attempt'] == 1 and j['attempts'] == []
                     and j['status'] in {'passed', 'failed', 'cancelled'}
                     and type(j['controller_exit_code']) is int
                     and 0 <= j['controller_exit_code'] <= 255 for j in jobs), 'campaign terminal jobs')
        from datetime import datetime
        start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
        need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
             <= receipt['finished_at'] <= confirmed, 'campaign terminal clocks')
        pending_hubs = summary.get('shared_transport_cleanup_pending')
        need(not any(summary.get(key) for key in ('cleanup_ticket_failure', 'shared_inventory_failed'))
             and (not pending_hubs or staged_preallocation and pending_hubs is True
                  and isinstance(proof.get('current_hub_retirement'),dict)),
             'campaign shared cleanup pending')
        cohorts = summary.get('startup_cohorts', [])
        need(isinstance(cohorts, list) and all(isinstance(c, dict) for c in cohorts)
             and not any(c.get('cleanup_budget_retirement_pending') for c in cohorts), 'campaign cohort retirement pending')
        from deploy_test_cloud import campaign_published
        native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
        publication = [campaign / 'hub-group.json', campaign / 'hub-group-publication-ack.private.json']
        for path in publication:
            document(path)
        try:
            published = campaign_published(summary, campaign, adapter['started_at'], native)
        except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
            raise ValueError('native cleanup: campaign publication unavailable') from error
        need(published, 'campaign publication or publisher cleanup')
        for path in publication:
            bound(path)
        if staged_preallocation:
            expected_cases = dict.fromkeys(checks, 'UNVERIFIED')
            if mixed:
                from deploy_test_historical_custody import KIND as CUSTODY_KIND
                skips = request.get('skips', {})
                need(isinstance(skips, dict) and not set(skips).intersection(checks)
                     and all(isinstance(v, dict) and v.get('kind') == CUSTODY_KIND
                             and v.get('disposition') == 'NO_RETRY_CUSTODY' and v.get('source') == receipt['source']
                             and v.get('current_binding', {}).get('source') == receipt['source']
                             and v.get('current_execution') == v.get('current_financial_state') == 'UNVERIFIED'
                             and v.get('credit') == {'test_execution': False, 'assertions': False, 'financial_release': False}
                             for v in skips.values()),
                     'mixed original exclusion inventory')
            else:
                skips = request.get('skips')
                need(isinstance(skips, dict) and not set(checks).intersection(skips),
                     'preallocation active/skip inventory')
            expected_cases.update(dict.fromkeys(skips, 'SKIP'))
            need(summary['status'] in {'failed','cancelled'} and not proof.get('purpose')
                 and not proof.get('recovered_runtime') and (mixed or not summary.get('workspace_binding'))
                 and receipt['cases'] == expected_cases,
                 'preallocation outcomes')
            supervision=preallocation_processes(root,runs,campaign,request,receipt,adapter,document,bound)
            if pending_hubs:
                marker=proof['current_hub_retirement']
                hub=runs/'_hub'
                need(hub.is_dir() and not hub.is_symlink() and hub.resolve()==hub,
                     'current Hub inventory root')
                owners=sorted(hub.glob('agent-link-server.*.owner'))
                need(set(marker)=={'kind','owners'}
                     and marker['kind']=='current-native-hub-retirement-v1'
                     and marker['owners']==list(map(str,owners)) and owners
                     and supervision['quiescent'] is True and supervision['orphaned_children'] is False
                     and supervision['term_sent']==supervision['kill_sent']==supervision['remaining']==[],
                     'current Hub retirement proof')
                for path in owners:
                    before=bound(path)
                    need(native['native_hub_owner_retired'](path,runs,root), 'current Hub remains live')
                    need(bound(path)==before, 'current Hub owner changed')
            else:
                need(not proof.get('current_hub_retirement'), 'unexpected current Hub retirement proof')
        handles = []
        for job in jobs:
            need(re.fullmatch(r'r001-j[0-9]{4}', job['job_id']), 'campaign job id')
            log = campaign / (job['job_id'] + '.log')
            need(job['log'] == str(log), 'campaign job log binding')
            one = []
            lines = bound(log).decode(errors='replace').splitlines()
            ref, infra = None, False
            for index, line in enumerate(lines):
                match = re.fullmatch(r'ref\s*:\s*([0-9a-f]{40})(?:\s+.*)?', line.strip())
                if match:
                    if staged_preallocation:
                        need(match[1] == receipt['source']['head'], 'preallocation foreign log ref')
                    ref = match[1]
                if line.strip() == 'mode: --infra-probe (strict barrier, no LLM / run_benchmark)':
                    infra = True
                if str(root / 'scripts/run-bench') + ' monitor ' not in line:
                    continue
                args = shlex.split(line.strip())
                need(len(args) == 3 and args[:2] == [str(root / 'scripts/run-bench'), 'monitor'], 'campaign monitor binding')
                if one and infra:
                    owner_line = lines[index + 1].strip() if index + 1 < len(lines) else ''
                    match = re.fullmatch(r'owner: ([0-9a-f]{32}); private controller diagnostics stay in this run directory\.', owner_line)
                    canary_links[Path(args[2])] = {'parent': one[0], 'ref': ref, 'owner': match[1] if match else None}
                    infra = False
                if preallocation or mixed and not one:
                    match=re.fullmatch(r'owner: ([0-9a-f]{32}); private controller diagnostics stay in this run directory[.]',
                                       lines[index+1].strip() if index+1<len(lines) else '')
                    need(match is not None, 'preallocation controller owner')
                    source_authority=preallocation_dispatch_ref(root,job,receipt,ref,adapter['native_command'])
                    preallocation_links[Path(args[2])]=dict(
                        ref=source_authority['ref'],owner=match[1],source_authority=source_authority)
                one.append(Path(args[2]))
            need(one and one[0] not in parents and type(job.get('controller_pid')) is int
                 and job['controller_pid'] > 1 and one[0].name.rsplit('-', 1)[-1] == str(job['controller_pid']),
                 'campaign parent identity')
            parents[one[0]] = {'checks': {job['task']}, 'exit': job['controller_exit_code']}
            handles.extend(one)
        need(len(handles) == len(set(handles)), 'duplicate campaign participant')
    else:
        need(layout is None, 'unsupported proof layout')
        log = Path(proof['controller_log'])
        need(log.parent == runs and log.name.startswith('detached-') and log.suffix == '.log', 'controller handle')
        status = log.with_suffix('.status')
        need(str(log) in cli_text and str(status) in cli_text, 'controller not in original CLI')
        exit_code = int(bound(status).decode().strip())
        need(type(adapter.get('native_exit')) is int and exit_code == adapter['native_exit'] and exit_code in (0, 1), 'terminal exit')
        handles = []
        for line in bound(log).decode(errors='replace').splitlines():
            if str(root / 'scripts/run-bench') + ' monitor ' not in line:
                continue
            args = shlex.split(line.strip())
            need(len(args) == 5 and args[:2] == [str(root / 'scripts/run-bench'), 'monitor']
                 and args[3:] == ['--controller-status', str(status)], 'native monitor binding')
            handles.append(Path(args[2]))
        need(handles, 'no native parent handle')
        participants = {p for p in runs.iterdir() if p.is_dir() and p.name != '_hub'}
        need(set(handles) == participants and all(p.parent == runs and (p / '_batch').is_dir() for p in participants), 'participant closure')
        parents[handles[0]] = {'checks': set(request['checks']), 'exit': exit_code}
    participants = {p for p in runs.iterdir() if p.is_dir() and p.name != '_hub'}
    need(set(handles) == participants and all(p.parent == runs and (p / '_batch').is_dir() for p in participants), 'participant closure')
    isolated = proof.get('purpose') == 'isolated-validation'
    need(proof.get('purpose') in {None, 'isolated-validation'} and (not isolated or layout == 'campaign-v1'), 'proof purpose')
    retained, audit_seals, recovered, excluded = {}, {}, {}, {}
    zero_parents, graded_parents = set(), set()
    recovery = proof.get('recovered_runtime', {})
    need(isinstance(recovery, dict) and (not recovery or layout == 'campaign-v1'), 'recovery scope')
    admission_parents = frozenset()
    if layout == 'campaign-admission-rejected-v1':
        from deploy_test_native_admission import validate_campaign
        admission_parents = validate_campaign(receipt, proof, root, runs, parents, participants, bound, document)
    cancelled_parent_zero = frozenset()
    if 'cancelled_parent_admission' in proof:
        from deploy_test_native_cancelled_parent import cancelled_parent_admission
        cancelled_parent_zero = cancelled_parent_admission(receipt, proof, adapter, root, parents, participants, bound, document, tree)
    from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding
    for fleet in sorted(participants):
        benches = json.loads(bound(fleet / '_batch/benches.json'))
        need(isinstance(benches, list) and benches and len({b['name'] for b in benches}) == len(benches), 'native inventory')
        if fleet in parents:
            need({b['name'] for b in benches} == parents[fleet]['checks'], 'parent requested inventory')
        run_path = fleet / '_batch/run.json'
        if isolated or preallocation or mixed or fleet in admission_parents:
            # These layouts consume the original projection. Bind its control
            # metadata through the bounded forensic reader; logs stay opaque.
            from deploy_test_run_artifact import read_run_artifact
            run = read_run_artifact(run_path, bindings.get(str(run_path)), MAX_RECEIPT_BYTES,
                                    raw_limit=min(RUN_RECORD_MAX_BYTES, MAX_RAW_FORENSIC_RUN_BYTES),
                                    raw_remaining=raw_remaining)
            used.add(str(run_path))
            run_artifacts.add(str(run_path))
        else:
            # Native task logs can exceed the small control-receipt cap. Preserve
            # the full hash and JSON-object contract without loading those logs.
            from native_json_evidence import verify_native_object
            need(run_path.is_file() and run_path.stat().st_size <= RUN_RECORD_MAX_BYTES, 'proof file too large')
            verify_native_object(run_path, bindings.get(str(run_path)))
            verified_size = run_path.stat().st_size
            need(run_path.is_file() and verified_size <= RUN_RECORD_MAX_BYTES, 'proof file too large')
            # Every participant run record shares the proof's aggregate raw-run allowance.
            need(verified_size <= raw_remaining[0], 'native artifact: aggregate raw admission bound exceeded')
            raw_remaining[0] -= verified_size
            used.add(str(run_path))
            run = None
        life = document(fleet / '_batch/lifecycle.json')
        owner_token = life['fleet_owner_token']
        need(isinstance(owner_token, str) and re.fullmatch('[0-9a-f]{32}', owner_token), 'fleet owner')
        failed_canary = isolated and fleet not in parents and life.get('status') == 'failed'
        need(type(life.get('version')) is int and life['version'] == 1 and life['run_id'] == fleet.name
             and life['workspace_root'] == str(root) and life['hub_publication_failed'] is False
             and type(life['controller_exit_code']) is int
             and (life['controller_exit_code'] == parents[fleet]['exit'] if fleet in parents
                  else 1 <= life['controller_exit_code'] <= 255 if failed_canary
                  else life['controller_exit_code'] == 0 and life['status'] == 'verified')
             and life['status'] in {'verified', 'failed'}, 'native terminal lifecycle')
        zero_allocation = False
        provenance_path, matrix_path = fleet / 'execution-provenance.json', fleet / 'execution-task-matrix.json'
        if mixed and fleet in parents:
            absent = [not p.exists() and not p.is_symlink() for p in (provenance_path, matrix_path)]
            if all(absent):
                need(life['status'] == 'failed' and isolated_canary_release(
                    fleet, life, benches, run, root, receipt, proof, preallocation_links.get(fleet), bound, tree),
                    'mixed preallocation zero resources')
                need(not Path('/proc', fleet.name.rsplit('-', 1)[-1]).exists(), 'mixed preallocation controller PID present')
                for bench in benches:
                    for name in ('cloudbench-run.json', '.cid', 'primary.ids', 'worker-clones.ids'):
                        artifact = fleet / bench['name'] / name
                        need(not artifact.exists() and not artifact.is_symlink(), 'mixed preallocation task artifact present')
                need(document(fleet / '_batch/disposable-cleanup.json').get('successful_runtime_inferred') is False,
                     'mixed preallocation runtime inference is not evidence')
                zero_parents.add(fleet)
                zero_allocation = True
            else:
                need(all(p.is_file() and not p.is_symlink() for p in (provenance_path, matrix_path)),
                     'mixed execution evidence incomplete')
                graded_parents.add(fleet)
        if preallocation:
            need(fleet in parents and life['status']=='failed'
                 and isolated_canary_release(fleet,life,benches,run,root,receipt,proof,
                                             preallocation_links.get(fleet),bound,tree), 'preallocation zero resources')
            need(not provenance_path.exists() and not matrix_path.exists(), 'preallocation execution evidence present')
            need(not Path('/proc',fleet.name.rsplit('-',1)[-1]).exists(), 'preallocation controller PID present')
        if failed_canary:
            link = canary_links.get(fleet)
            need(link and link['parent'] in parents, 'failed canary parent link')
            zero_allocation = isolated_canary_release(fleet, life, benches, run, root, receipt, proof, link, bound, tree)
        admission_parent = fleet in admission_parents
        if admission_parent:
            from deploy_test_native_admission import validate_parent
            validate_parent(fleet, life, benches, run, root, bound, document, tree)
        provenance_path, matrix_path = fleet / 'execution-provenance.json', fleet / 'execution-task-matrix.json'
        if (preallocation or (mixed and fleet in zero_parents) or (failed_canary and zero_allocation) or admission_parent or fleet in cancelled_parent_zero) and not provenance_path.exists() and not matrix_path.exists():
            pass  # Positive native admission boundary and sealed ownership; absence alone proves nothing.
        else:
            provenance, matrix = document(provenance_path), document(matrix_path)
            need(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance, matrix)
                 and provenance['base_sha'] == receipt['source']['head'] and provenance['workspace_patch_sha256'] == 'none', 'execution source')
            need(len(benches) == len(matrix['tasks'])
                 and {b['name'] for b in benches} == {t['name'] for t in matrix['tasks']}, 'native inventory')
        if isolated:
            excluded.update(isolated_execution(fleet, life, root, receipt, proof, bound, document, tree))
            continue
        audit = fleet / 'teardown-ownership'
        canonical = fleet_audit_root(root) / owner_token
        binding = fields(bound(audit / 'source-audit'))
        seal = tree(audit)
        need(binding == {'path': str(canonical), 'sha256': seal}
             and tree(canonical) == seal
             and (life['audit_sha256'] == seal or str(fleet) in recovery
                  and life['audit_sha256'] == '' and life['status'] == 'failed'), 'native audit seal')
        meta = fields(bound(audit / 'meta'))
        need(meta.get('status') == 'provider-teardown-verified' and meta.get('version') == '1'
             and meta.get('fleet_owner_token') == owner_token and meta.get('run_id') == fleet.name
             and meta.get('workspace_root') == str(root), 'native provider release')
        release = float(bound(audit / 'provider-teardown-verified.epoch'))
        need(finite(release) and adapter['started_at'] <= release <= confirmed, 'release epoch')
        registry = fleet_ownership_root(root) / owner_token
        need(not registry.exists() and not registry.is_symlink(), 'fleet registry still retained')
        ids = bound(audit / 'owned-clones.ids').decode().splitlines()
        names = bound(audit / 'owned-clones.names').decode().splitlines()
        rows = [fields(bound(p)) for p in (audit / 'fresh').iterdir()] if (audit / 'fresh').exists() else []
        need(len(ids) == len(set(ids)) == len(rows) and set(ids) == {r['machine_id'] for r in rows}
             and len(names) == len(set(names)) == len(rows) and set(names) == {r['clone_name'] for r in rows}, 'resource closure')
        need(all(r.get('fleet_owner_token') == owner_token and r.get('run_id') == fleet.name
                 and r.get('app') == meta['app'] and r.get('source') == 'fresh-clone'
                 and r.get('disposition') == 'destroyed-provider-retained' for r in rows), 'unsupported resource disposition')
        for name in ('pool', 'pool-handoffs', 'volume-migrations'):
            path = audit / name
            need(not path.exists() or path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
                 'unsupported resource class')
        disposable = document(fleet / '_batch/disposable-cleanup.json')
        need(disposable.get('schema') == 'disposable-cleanup-v1' and disposable.get('owner') == owner_token, 'guest cleanup owner')
        if str(fleet) in recovery:
            need(fleet in parents and life['status'] == 'failed' and life['audit_sha256'] == ''
                 and type(disposable.get('guest_cleanup_missing')) is bool
                 and type(disposable.get('runtime_evidence_missing')) is bool
                 and (disposable['guest_cleanup_missing'] or disposable['runtime_evidence_missing']), 'historical recovery facts')
            recovered_runtime(fleet, owner_token, benches, rows, recovery[str(fleet)], bound, document)
            recovered[str(fleet)] = {'original_lifecycle': life, 'original_disposable_cleanup': disposable,
                                     'release_epoch': release, 'native_audit_sha256': seal, 'credit_granted': False}
        else:
            need(disposable.get('guest_cleanup_missing') is False
                 and disposable.get('runtime_evidence_missing') is False, 'guest cleanup')
        need(meta['hub_disposition'] == 'retained-exact-owner-transfer-required', 'unsupported Hub disposition')
        hub = Path(meta['hub_owner_file'])
        need(hub.parent == runs / '_hub', 'Hub root')
        hub_owner = fields(bound(hub))
        need(hub_owner.get('status') == 'live-transfer-required' and hub_owner.get('version') == '1'
             and all(hub_owner.get(k) == str(runs) for k in ('root', 'runs_root'))
             and hub_owner.get('repo_root') == str(root) and hub_owner.get('context_dir') == str(runs / '_hub')
             and hub_owner.get('command') == str(root / 'agents/benchmarks/agent_link_server.py')
             and all(hub_owner.get(k) == meta['hub_' + k] for k in ('pid', 'pid_start', 'argv_sha256'))
             and hub_owner.get('pgid') == hub_owner.get('pid') and hub_owner.get('owner_token') == meta['hub_owner_token'], 'retained Hub identity')
        retained[str(hub)] = {'path': str(hub), 'sha256': bindings[str(hub)], 'owner': hub_owner,
                             'disposition': meta['hub_disposition']}
        audit_seals[str(audit)] = seal
    if mixed:
        need(zero_parents and graded_parents and zero_parents | graded_parents == set(parents),
             'mixed cleanup requires both zero-allocation and graded parents')
    if staged_preallocation:
        need(set(supervision['term_sent']) <= {int(r['owner']['pid'])for r in retained.values()}
             and all(any(v==dict(pid=pid,status=15)for v in supervision['reaped'])for pid in supervision['term_sent']),
             'preallocation unexpected supervised termination')
        for value in retained.values():
            retired_local_process(dict(pid=int(value['owner']['pid']),birth=value['owner']['pid_start']))
    need(isolated or set(recovered) == set(recovery), 'recovered fleet closure')
    if isolated:
        need(set(proof['execution_quiescence']) == set(excluded), 'execution observation closure')
        for path in bindings:
            hub = Path(path)
            if hub.parent == runs / '_hub' and hub.name.endswith('.owner'):
                value = fields(bound(hub))
                need(value.get('runs_root') == str(runs) and value.get('repo_root') == str(root)
                     and value.get('pid') == value.get('pgid') and value.get('pid_start')
                     and value.get('owner_token') and value.get('argv_sha256'), 'retained service custody')
                retained[str(hub)] = {'path': str(hub), 'sha256': bindings[str(hub)], 'owner': value,
                                      'disposition': 'retained-exact-owner-transfer-required'}
        need(retained, 'retained service evidence missing')
        for path in bindings:
            if path in run_artifacts:
                from deploy_test_run_artifact import read_run_artifact
                read_run_artifact(path, bindings[path], MAX_RECEIPT_BYTES,
                                  raw_limit=MAX_RAW_FORENSIC_RUN_BYTES)
            else:
                bound(path)  # Retain and re-hash ALL original debt evidence, including retained Hub owners.
    need(used == set(bindings), 'proof file closure')
    result = {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
            'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
            'participants': sorted(map(str, participants)), 'native_audit_seals': audit_seals,
            'retained_services': [retained[k] for k in sorted(retained)], 'credit_granted': False}
    if staged_preallocation:
        result['preallocation_source_authorities']={str(k):v['source_authority'] for k,v in preallocation_links.items()
                                                     if preallocation or k in zero_parents}
    if staged_preallocation and proof.get('current_hub_retirement'):
        result['current_hub_retirement']=copy.deepcopy(proof['current_hub_retirement'])
    if isolated:
        need(isinstance(proof.get('validation_source'), dict) and set(proof['validation_source']) == {'head', 'digest'}, 'next source')
        result.update(purpose='isolated-validation', validation_source=proof['validation_source'], excluded_resources=excluded,
                      obligations_preserved=True, cleanup_complete=False)
    if recovered:
        result['recovered_release_evidence'] = recovered
    return result


def clean_isolated_successor(state, prior, original, successor):
    """A later full native result may close execution without clearing historical debt or FAILs."""
    from deploy_test_cycle import bounded_read, digest, receipt_owner, sha_file, validate_result
    gate = next(g for g in state['plan']['gates'] if g['name'] == prior['gate'])
    need(successor is not None and successor.get('token') != original['token']
         and successor.get('executed') is True and successor.get('complete') is True
         and type(successor.get('native_exit')) is int and successor['native_exit'] in (0, 1)
         and successor.get('timed_out') is False and successor.get('cancelled') is False
         and successor.get('lingering_group') is False and not successor.get('cleanup_owner')
         and receipt_owner(prior['gate'], successor) is None
         and successor.get('command') == gate['command'], 'successor execution/ownership')
    rows = [(a, r) for a in state['attempts'] for r in a.get('results', []) if r is successor]
    need(len(rows) == 1 and rows[0][0].get('phase') in {'initial', 'focused', 'failed-gates', 'final', 'triage'}
         and not rows[0][0].get('interrupted')
         and (rows[0][0]['phase'] != 'triage' or rows[0][0].get('independent_full') is True), 'successor full attempt')
    binding = successor.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate) and binding.get('environment') == state['environment']
         and isinstance(binding.get('input_fingerprint'), str) and binding['input_fingerprint'], 'successor contract')
    folder = Path(successor['log']).parent
    need(bounded_read(folder / 'receipt.json', 'successor receipt') == successor, 'successor receipt changed')
    request = bounded_read(folder / 'request.json', 'successor request')
    need(all(request.get(k) == successor.get(k) for k in ('token', 'source', 'gate'))
         and request.get('worker_recipe') == gate.get('worker_recipe'), 'successor request identity')
    checks, skips = request['checks'], request['skips']
    need(isinstance(checks, list) and checks and isinstance(skips, dict)
         and len(set(checks)) == len(checks) and not set(checks) & set(skips)
         and set(checks) | set(skips) == set(gate['checks'])
         and all(v.get('source') == successor['source'] for v in skips.values()), 'successor full inventory')
    root = Path(prior['owner']['worker_root'])
    native_root = root / '.context/deploy-cloud' / hashlib.sha256(successor['token'].encode()).hexdigest()
    expected = dict(original_receipt_sha256=prior['proof']['receipt_sha256'], original_request_token=prior['token'],
        new_request_token=successor['token'], source=successor['source'], new_native_root=str(native_root),
        excluded_resources=prior['excluded_resources'], credit_granted=False)
    admissions = request.get('isolated_validation')
    need(isinstance(admissions, list) and admissions == successor.get('isolated_validation')
         and [v for v in admissions if v.get('original_request_token') == prior['token']] == [expected],
         'successor original isolation binding')
    result_path = folder / 'result.json'
    need(successor.get('worker_result') == str(result_path), 'successor result locator')
    result = bounded_read(result_path, 'successor native result')
    cases, complete = validate_result(result, request, successor['native_exit'], invalid_process=False)
    need(complete and successor.get('cases') == {**dict.fromkeys(skips, 'SKIP'), **cases}
         and successor.get('case_complete') == dict.fromkeys(gate['checks'], True)
         and successor.get('status') == ('PASS' if all(v == 'PASS' for v in cases.values()) else 'FAIL'),
         'successor complete cases')
    reference = successor['native_cleanup_reference']
    need(reference == dict(result=str(result_path), native_directory=result.get('fleet_directory'), cleanup_complete=True,
            result_sha256=sha_file(result_path), native_evidence=result.get('evidence'))
         and result.get('fleet_directory') == str(native_root / 'campaigns' / ('deploy-' + native_root.name))
         and result.get('runner_log') == str(native_root / 'cli.log'), 'successor native cleanup binding')
    need(not result.get('cleanup_owner') and isinstance(result.get('evidence'), dict)
         and set(result['evidence']) == set(checks), 'successor native evidence inventory')
    for evidence in result['evidence'].values():
        need(isinstance(evidence, dict) and isinstance(evidence.get('path'), str)
             and sha_file(evidence['path']) == evidence.get('sha256'), 'successor native evidence changed')
    need(finite(original.get('finished_at')) and finite(successor.get('started_at'))
         and finite(successor.get('finished_at'))
         and original['finished_at'] <= successor['started_at'] <= successor['finished_at'], 'successor clocks')


def reconciliation_occurrence(state, entry, receipt):
    """Keep token-based interruption and failure-based reconciliation identities distinct."""
    if entry.get('occurrence') == receipt['token']:
        return
    rows = [f for f in state.get('failures', []) if f.get('id') == entry.get('occurrence')]
    need(len(rows) == 1, 'reconciliation occurrence identity')
    failure = rows[0]
    case = failure.get('check', '').partition('/')[2]
    need(failure.get('gate') == receipt['gate'] and failure.get('source') == receipt['source']
         and failure.get('evidence') == receipt['log'] and failure.get('command') == receipt['command']
         and failure.get('worker_result') == receipt['worker_result']
         and failure.get('native_result') == 'UNVERIFIED' and failure.get('complete') is False
         and receipt['cases'].get(case) == 'UNVERIFIED', 'reconciliation occurrence binding')


def reconciled_failed_isolated_successor_v1(state, prior, original, successor):
    """Launch-only authority from an immutable full failed cohort's strict normal reconciliation."""
    from deploy_test_cycle import bounded_read, receipt_owner, sha_file
    gate = next(g for g in state['plan']['gates'] if g['name'] == prior['gate'])
    need(successor is not None and successor.get('token') != original['token']
         and successor.get('executed') is True and successor.get('complete') is False
         and successor.get('status') == 'FAIL' and type(successor.get('native_exit')) is int
         and successor['native_exit'] in (0, 1) and successor.get('timed_out') is False
         and successor.get('cancelled') is False and successor.get('command') == gate['command'],
         'failed successor execution')
    rows = [(a, r) for a in state['attempts'] for r in a.get('results', []) if r is successor]
    need(len(rows) == 1 and rows[0][0].get('phase') in {'initial', 'focused', 'failed-gates', 'final', 'triage'}
         and not rows[0][0].get('interrupted') and not rows[0][0].get('stale')
         and rows[0][0].get('source') == successor['source']
         and (rows[0][0]['phase'] != 'triage' or rows[0][0].get('independent_full') is True),
         'failed successor full attempt')
    binding = successor.get('execution_binding', {})
    # This receipt's hash-bound execution inputs are historical. Current target inputs
    # can legitimately differ and must earn fresh full-gate credit after renewal.
    need(isinstance(binding, dict) and set(binding) == {'contract_digest', 'environment', 'input_fingerprint'}
         and all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in binding.values()),
         'failed successor historical execution binding')
    folder = Path(successor['log']).parent
    need(bounded_read(folder / 'receipt.json', 'failed successor receipt') == successor,
         'failed successor receipt changed')
    need(successor.get('worker_result') == str(folder / 'result.json'), 'failed successor result locator')
    request = bounded_read(folder / 'request.json', 'failed successor request')
    need(all(request.get(k) == successor.get(k) for k in ('token', 'source', 'gate'))
         and request.get('phase') == rows[0][0]['phase']
         and request.get('worker_recipe') == gate.get('worker_recipe'), 'failed successor request identity')
    checks, skips = request['checks'], request['skips']
    need(isinstance(checks, list) and checks and isinstance(skips, dict)
         and len(set(checks)) == len(checks) and not set(checks) & set(skips)
         and set(checks) | set(skips) == set(gate['checks'])
         and all(isinstance(v, dict) and v.get('source') == successor['source'] for v in skips.values())
         and set(successor.get('cases', {})) == set(gate['checks'])
         and set(successor.get('case_complete', {})) == set(gate['checks'])
         and all(successor['cases'].get(k) == 'SKIP' for k in skips)
         and all(successor['cases'].get(k) in {'PASS', 'FAIL', 'UNVERIFIED'} for k in checks)
         and all(type(v) is bool for v in successor['case_complete'].values())
         and any(successor['cases'][k] == 'UNVERIFIED' and successor['case_complete'][k] is False for k in checks),
         'failed successor full inventory')
    owner = receipt_owner(prior['gate'], successor)
    need(isinstance(owner, dict) and owner.get('worker_root') == prior['owner']['worker_root'],
         'failed successor owner')
    native_root = Path(owner['worker_root']) / '.context/deploy-cloud' / hashlib.sha256(successor['token'].encode()).hexdigest()
    expected = dict(original_receipt_sha256=prior['proof']['receipt_sha256'], original_request_token=prior['token'],
        new_request_token=successor['token'], source=successor['source'], new_native_root=str(native_root),
        excluded_resources=prior['excluded_resources'], credit_granted=False)
    admissions = request.get('isolated_validation')
    need(isinstance(admissions, list) and all(isinstance(v, dict) for v in admissions)
         and admissions == successor.get('isolated_validation')
         and [v for v in admissions if v.get('original_request_token') == prior['token']] == [expected],
         'failed successor original isolation binding')
    entries = [(k, e) for k, e in state.get('reconciled_owners', {}).items()
               if e.get('token') == successor['token']]
    need(len(entries) == 1, 'one strict normal successor reconciliation required')
    key, entry = entries[0]
    normal = entry.get('proof', {})
    need(entry.get('kind') == KIND and entry.get('gate') == prior['gate']
         and entry.get('purpose') is None and normal.get('purpose') is None
         and normal.get('layout') == 'campaign-v1' and key == normal.get('receipt_sha256')
         and key == sha_file(folder / 'receipt.json') and entry.get('credit_granted') is False,
         'strict normal successor reconciliation required')
    reconciliation_occurrence(state, entry, successor)
    # Re-run the unchanged normal validator: all native file hashes, audits, retained Hub custody,
    # provider release and publication closure are required even when this result is incomplete.
    need(still_bound(entry, successor, owner), 'strict normal successor proof changed')
    need(finite(original.get('finished_at')) and finite(successor.get('started_at'))
         and finite(successor.get('finished_at'))
         and original['finished_at'] <= successor['started_at'] <= successor['finished_at'],
         'failed successor clocks')


def renew_isolated_validation(state, request_token, proof):
    """Renew only the next source of an already verified original operation."""
    from deploy_test_cycle import CANCEL, latest_receipts, receipt_owner, source
    need(state.get('phase') in ISOLATED_RENEWAL_PHASES and state.get('ready') is False
         and not state.get('running')
         and 'live_failures' not in state and not CANCEL.is_set(), 'quiescent repair boundary required')
    previous = [(key, entry) for key, entry in state.get('reconciled_owners', {}).items()
                if entry.get('token') == request_token]
    need(len(previous) == 1, 'one prior reconciliation required')
    key, prior = previous[0]
    need(prior.get('kind') == KIND and prior.get('purpose') == 'isolated-validation'
         and key == proof.get('receipt_sha256'), 'original reconciliation identity')
    receipts = [row for attempt in state.get('attempts', []) for row in attempt.get('results', [])
                if row.get('gate') == prior['gate'] and row.get('token') == request_token]
    need(len(receipts) == 1, 'original receipt identity')
    receipt = receipts[0]
    reconciliation_occurrence(state, prior, receipt)
    latest = latest_receipts(state).get(prior['gate'])
    if latest != receipt:
        if latest is not None and latest.get('complete') is False:
            reconciled_failed_isolated_successor_v1(state, prior, receipt, latest)
        else:
            clean_isolated_successor(state, prior, receipt, latest)
    need(any(g.get('name') == prior['gate'] and g.get('native_cloud') is True for g in state['plan']['gates']), 'native_cloud gate required')
    owner = receipt_owner(prior['gate'], receipt)
    need(still_bound(prior, receipt, owner), 'prior native proof changed')
    need({k: v for k, v in proof.items() if k != 'validation_source'} ==
         {k: v for k, v in prior['proof'].items() if k != 'validation_source'}, 'only validation_source may change')
    need(proof.get('validation_source') == state['source'] == state['plan'].get('source')
         == source(Path(owner['worker_root'])), 'current source binding')
    entry = validate(receipt, owner, proof)
    entry['occurrence'] = prior['occurrence']
    if entry != prior:
        state.setdefault('reconciled_owner_history', []).append(copy.deepcopy(prior))
        state['reconciled_owners'][key] = entry


def reconcile(state, occurrence_id, proof):
    """Record verified retirement while preserving the original native result and credit."""
    from deploy_test_cycle import CANCEL, latest_receipts, receipt_owner, interrupted_receipt
    try:
        failure = next((f for f in state['failures'] if f['id'] == occurrence_id), None)
        if (failure is None and state.get('phase') in ISOLATED_RENEWAL_PHASES
                and proof.get('purpose') == 'isolated-validation'):
            return renew_isolated_validation(state, occurrence_id, proof)
        if failure is None and state.get('phase') == 'stale':
            # A source refresh can finish a full attempt before its failures are
            # promoted to triage. Its retained owner still requires exact proof.
            need(not state.get('running') and 'live_failures' not in state and not CANCEL.is_set()
                 and state.get('attempts') and state['attempts'][-1].get('stale') is True
                 and proof.get('layout') in {'campaign-startup-v1', 'campaign-prelaunch-v1'}, 'quiescent stale startup required')
            candidates = [r for r in latest_receipts(state).values()
                          if r.get('token') == occurrence_id]
            need(len(candidates) == 1, 'stale operation identity')
            interrupted = candidates[0]
            need(interrupted.get('source') == state.get('source') and interrupted.get('complete') is False
                 and interrupted.get('executed') is True and 'UNVERIFIED' in interrupted.get('cases', {}).values()
                 and proof.get('request_token') == occurrence_id, 'stale operation identity')
        else:
            interrupted = interrupted_receipt(state, occurrence_id) if failure is None else None
        gate = interrupted['gate'] if interrupted is not None else failure['gate']
        need(any(g['name'] == gate and g.get('native_cloud') is True for g in state['plan']['gates']), 'native_cloud gate required')
        receipt = latest_receipts(state)[gate]
        if proof.get('purpose') == 'isolated-validation':
            candidates = [r for a in state.get('attempts', []) for r in a.get('results', [])
                          if r.get('gate') == gate and r.get('token') == proof.get('request_token')]
            need(len(candidates) == 1, 'ambiguous historical receipt')
            receipt = candidates[0]
        if failure is not None:
            case = failure['check'].split('/', 1)[1]
            need(failure.get('native_result') == 'UNVERIFIED' and not failure.get('complete')
                 and receipt.get('complete') is False and receipt['cases'].get(case) == 'UNVERIFIED', 'latest incomplete occurrence required')
        else:
            need(receipt == interrupted and receipt.get('token') == proof.get('request_token'), 'interrupted token mismatch')
        entry = validate(receipt, receipt_owner(gate, receipt), proof)
        entry['occurrence'] = occurrence_id
        key = proof['receipt_sha256']
        need(not any(e.get('token') == entry['token'] and k != key for k, e in state.get('reconciled_owners', {}).items()), 'token already reconciled elsewhere')
    except (OSError, KeyError, TypeError, StopIteration, ValueError) as error:
        raise ValueError('native cleanup proof refused: ' + str(error)) from error
    state.setdefault('reconciled_owners', {})[key] = entry


def still_bound(entry, receipt, owner):
    try:
        actual = validate(receipt, owner, entry['proof'])
        return actual == {k: v for k, v in entry.items() if k != 'occurrence'}
    except (OSError, ValueError, KeyError, TypeError):
        return False
