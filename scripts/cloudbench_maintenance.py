#!/usr/bin/env python3
"""Native, lease-bound warm image transition; never cleanup or task credit.

Capture is deliberately limited to an existing stopped warm singleton. Declared
pool targets require their own ownership authority and cannot be silently omitted.
All network operations in this module are GETs. Only native --setup mutates Fly.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.request

SCHEMA = 'cloudbench-native-maintenance-v1'
# Explicit v1 recipe closure: installers, manifests, postinstall/verify inputs,
# Prisma schema and vendored wheels. /app source is deliberately not relabelled:
# guests still execute the separately sealed complete current workspace patch.
IMAGE_INPUTS = ('Dockerfile.cloudbench-warm', 'fly.cloudbench-warm.toml', '.dockerignore',
                'package.json', '.npmrc', 'back-end/package.json', 'back-end/package-lock.json',
                'back-end/prisma', 'front-end', 'agents/package.json', 'agents/requirements.txt',
                'agents/vendor', 'scripts/cloudbench-install-image-deps.sh',
                'scripts/cloudbench-install-ngrok.sh', 'scripts/cloudbench-install-pgvector.sh')
# Unknown recipe semantics cannot inherit a known closure merely by matching HEAD.
IMAGE_RECIPE_V1 = 'cfd577f370e9f22c1b4263853cecdc50372483e8ab573ad958ae45eac97522a3'

SCRIPTS = ('scripts/cloudbench_maintenance.py', 'scripts/run-bench-cloud',
           'scripts/run-bench', 'scripts/lib/cloudbench-app-env-lock.sh')


def need(value, message):
    if not value:
        raise ValueError('native maintenance: ' + message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read(path):
    path = Path(path)
    need(path.is_file() and not path.is_symlink() and path.resolve() == path, 'unsafe evidence path')
    return json.loads(path.read_text())


def write_once(path, value):
    from cloudbench_preallocation import write_once as write
    write(path, value)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE).decode().strip()


def common(root):
    path = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    need(path.is_dir() and not path.is_symlink() and path.resolve() == path, 'unsafe native common directory')
    return path


def script_hashes(root, head):
    result = {}
    for name in SCRIPTS:
        committed = subprocess.check_output(['git', '-C', str(root), 'show', head + ':' + name], stderr=subprocess.PIPE)
        actual = (root / name).read_bytes()
        need(actual == committed and not (root / name).is_symlink(), 'uncommitted native producer')
        result[name] = hashlib.sha256(committed).hexdigest()
    return result


def identity(pid):
    from importlib.machinery import SourceFileLoader
    helper = SourceFileLoader('maintenance_process_identity', str(Path(__file__).with_name('process-identity.py'))).load_module()
    return helper.linux_identity(pid)


def native_owner(root, pid, state=None, state_fd=None):
    need(os.getppid() == pid, 'capture must be a direct native setup child')
    args = Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
    need(os.fsencode(str(root / 'scripts/run-bench-cloud')) in args and b'--setup' in args,
         'not the original setup process')
    need(Path('/proc', str(pid), 'fd/255').resolve() == root / 'scripts/run-bench-cloud', 'native script descriptor')
    lock = common(root) / 'cloudbench-app-env.lock'
    need(not lock.is_symlink() and lock.read_text().strip() == str(pid), 'original native lease ownership')
    if state is not None:
        need(Path('/proc', str(pid), 'fd', str(state_fd)).resolve() == state.parent/'lock'
             and 'FLOCK  ADVISORY  WRITE' in Path('/proc', str(pid), 'fdinfo', str(state_fd)).read_text(),
             'original cycle lease descriptor')
    return {'pid': pid, 'start': identity(pid), 'argv_sha256': hashlib.sha256(b'\0'.join(args)).hexdigest()}


def quiescent(*, native_pid=None):
    """Unknown live process ownership blocks, never grants an empty-inventory waiver."""
    seen = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            stat = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
            if stat[0] in ('Z', 'X'):
                continue
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            consumers = {Path(os.fsdecode(a)).name for a in args if a} & {
                'run-bench-cloud', 'run-bench-fleet', 'run-bench-campaign.py'}
            need(not consumers or int(proc.name) == native_pid and consumers == {'run-bench-cloud'},
                 'another native consumer')
            seen.append(int(proc.name))
        except FileNotFoundError:
            continue
        except PermissionError as error:
            raise ValueError('native maintenance: unreadable live process') from error
    return {'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'uid': os.getuid(), 'observed_at': time.time(), 'scanned': len(seen)}


def get(app, resource):
    need(re.fullmatch(r'[a-z0-9-]+', app) is not None, 'invalid app')
    token = os.environ.get('FLY_API_TOKEN')
    if not token:
        from deploy_test_round12_isolation import fly_token
        token = fly_token()
    request = urllib.request.Request('https://api.machines.dev/v1/apps/' + app + '/' + resource,
                                    headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=25) as response:
        need(response.status == 200, 'native GET failed')
        return json.load(response)


def cache_addition_projections(config, machine_id):
    """Only the native seven-field advisory cache namespace; no ownership keys."""
    result=[]
    for key,value in (config.get('metadata') or {}).items():
        if not isinstance(value,str):continue
        fields=value.split()
        if len(fields)!=7 or value!=' '.join(fields):continue
        node,python,epoch,snapshot,volume,mid,app=fields
        if (not all(re.fullmatch('[a-f0-9]{64}',x) for x in (node,python))
            or key!='rose_cloudbench_deps_'+hashlib.sha256((node+'\0'+python).encode()).hexdigest()[:32]
            or not re.fullmatch('[1-9][0-9]*',epoch) or not re.fullmatch('[A-Za-z0-9_-]+',snapshot)
            or mid!=machine_id or not re.fullmatch('[a-z0-9-]+',app)
            or not any(m.get('volume')==volume for m in config.get('mounts',[]))):continue
        projected=copy.deepcopy(config);del projected['metadata'][key]
        result.append(dict(key=key,node=node,python=python,epoch=int(epoch),snapshot=snapshot,
                           volume=volume,machine=mid,app=app,without_key_sha256=digest(projected)))
    return result


def machine(value, *, cache_baseline=None):
    """Only hashes/presence of config and env/file contents persist in receipts."""
    config = copy.deepcopy(value['config'])
    stable = copy.deepcopy(config)
    stable.pop('image', None); stable.pop('guest', None)
    init = stable.get('init', {}); init.pop('cmd', None)
    if not init:
        stable.pop('init', None)
    result = {**{k: value[k] for k in ('id', 'instance_id', 'name', 'state')},
            'config_sha256': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
            'stable_sha256': digest(stable), 'cache_addition_projections':cache_addition_projections(stable,value['id']),
            'guest': config.get('guest'),
            'command': config.get('init', {}).get('cmd'),
            'image': config['image'], 'image_digest': value.get('image_ref', {}).get('digest'),
            'mounts': config.get('mounts', [])}
    if cache_baseline is not None and value['id']==cache_baseline['machine']:
        result['cache_renewal_projection']=cache_renewal_projection(stable,cache_baseline)
    return result


def diagnostic_machine(value):
    """No environment, file contents or executable command enters diagnostics."""
    result = {k:value[k] for k in ('id','instance_id','name','state','config_sha256',
                                  'stable_sha256','image','image_digest')}
    guest = value.get('guest')
    result['guest'] = {k:v for k,v in (guest if isinstance(guest,dict) else {}).items()
                       if k in ('cpu_kind','cpus','memory_mb')}
    result['mounts'] = [{k:v for k,v in mount.items()
                        if k in ('volume','path','name','encrypted','size_gb')}
                       for mount in value.get('mounts',[])]
    return result


def observation(app, warm_id, *, native_pid=None, failure_diagnostic=None, diagnostic_samples=None, cache_baseline=None):
    evidence = diagnostic_samples if diagnostic_samples is not None else {}
    samples = {}
    read_times = []
    started = time.time()

    def enrich():
        # Defer all fallible diagnostic normalization until the original path
        # has returned or raised. Never substitute raw data for a failed field.
        def field(key, make):
            try:
                evidence[key] = make()
            except Exception:
                pass
        field('started_at', lambda: started)
        field('read_times', lambda: read_times)
        for key in ('before', 'after'):
            if key in samples:
                field(key, lambda key=key: diagnostic_machine(samples[key]))
        if 'inventory' in samples:
            def inventory_summary():
                result = {}
                for item in samples['inventory']:
                    try:
                        result[item['id']] = {
                            'name':item['name'], 'instance_id':item['instance_id'],
                            'state':item['state'], 'config_sha256':machine(item)['config_sha256']}
                    except Exception:
                        pass
                return result
            field('inventory', inventory_summary)
        if 'volumes' in samples:
            def volume_summary():
                result = {}
                for vid, volume in samples['volumes'].items():
                    try:
                        result[vid] = {k:volume.get(k) for k in ('id','attached_machine_id','state')}
                    except Exception:
                        pass
                return result
            field('volumes', volume_summary)
        if 'before' in samples and 'after' in samples:
            field('comparisons', lambda: {
                'same_machine':samples['before']==samples['after'],
                'before_stopped':samples['before']['state']=='stopped',
                'changed_fields':[k for k in samples['before'] if samples['before'][k]!=samples['after'].get(k)]})

    try:
        before = machine(get(app, 'machines/' + warm_id),cache_baseline=cache_baseline)
        samples['before'] = before
        read_times.append({'kind':'machine-before','at':time.time()})
        inventory = get(app, 'machines')
        samples['inventory'] = inventory
        read_times.append({'kind':'inventory','at':time.time()})
        need(isinstance(inventory, list) and len({m['id'] for m in inventory}) == len(inventory), 'inventory unreadable')
        need(any(machine(item,cache_baseline=cache_baseline)==before for item in inventory), 'warm missing/changed in global inventory')
        volumes = {}
        for mount in before['mounts']:
            vid = mount['volume']; volume = get(app, 'volumes/' + vid)
            read_times.append({'kind':'volume','id':vid,'at':time.time()})
            samples.setdefault('volumes',{})[vid] = volume
            need(volume['id'] == vid and volume.get('attached_machine_id') == warm_id
                 and volume['state'] not in ('destroyed', 'pending_destroy'), 'retained volume ownership')
            volumes[vid] = {'id': vid, 'attached_machine_id': warm_id, 'state': volume['state']}
        need(volumes, 'retained volume missing')
        after = machine(get(app, 'machines/' + warm_id),cache_baseline=cache_baseline)
        samples['after'] = after
        read_times.append({'kind':'machine-after','at':time.time()})
        need(before == after and before['state'] == 'stopped', 'unstable/nonstopped native partition')
        result = {'warm': before, 'volumes': volumes,
                  'inventory': {m['id']: {'name': m['name'], 'instance_id': m['instance_id'],
                                'state': m['state'], 'config_sha256': machine(m)['config_sha256']} for m in inventory},
                  'guard': quiescent(native_pid=native_pid), 'observed_at': time.time()}
    except Exception as error:
        try:
            enrich()
            if failure_diagnostic is not None:
                evidence['finished_at'] = time.time()
                evidence['error_type'] = type(error).__name__
                if isinstance(error,ValueError) and str(error).startswith('native maintenance:'):
                    evidence['reason'] = str(error)
                failure_diagnostic(evidence)
        except Exception:
            pass  # Neither enrichment nor a write can replace the original refusal.
        raise
    try:
        enrich()
    except Exception:
        pass  # Successful observations do not depend on diagnostic enrichment.
    return result


def debts(state, gate):
    values = [e for e in state.get('reconciled_owners', {}).values()
              if e.get('purpose') == 'isolated-validation' and e['gate'] == gate]
    need(values and len({e['token'] for e in values}) == len(values), 'complete unique debt set')
    need(all(e['cleanup_complete'] is False and e['credit_granted'] is False
             and e['obligations_preserved'] is True for e in values), 'old debt changed')
    return sorted(values, key=lambda e: e['token'])


def anchor_for(entries):
    # This extends the existing pinned-partition ancestry contract, not its pins.
    import deploy_test_round16_isolation as r16
    import deploy_test_round19_isolation as r19
    known = {r16.MODE: r16, r19.MODE: r19}
    anchors = [e for e in entries if e['proof'].get('compatibility') in known]
    need(anchors, 'original shared partition authority missing')
    anchor = max(anchors, key=lambda e: len(e['proof']['inherited_admissions']))
    return anchor, known[anchor['proof']['compatibility']]


def image_inputs(root, build_source, current_source):
    recipe = subprocess.check_output(['git', '-C', str(root), 'show', build_source+':Dockerfile.cloudbench-warm'])
    need(hashlib.sha256(recipe).hexdigest() == IMAGE_RECIPE_V1, 'unknown image recipe inputs')
    def inventory(head):
        return subprocess.check_output(['git','-C',str(root),'ls-tree','-r','-z',head,'--',*IMAGE_INPUTS])
    original = inventory(build_source)
    need(original == inventory(current_source), 'image dependency/recipe inputs changed')
    need(not subprocess.check_output(['git','-C',str(root),'diff','HEAD','--',*IMAGE_INPUTS])
         and not subprocess.check_output(['git','-C',str(root),'ls-files','--others','--exclude-standard','--',*IMAGE_INPUTS]),
         'uncommitted image dependency inputs')
    return {'schema':'cloudbench-image-input-equivalence-v1','build_source':build_source,
            'current_source':current_source,'paths':list(IMAGE_INPUTS),
            'tree_inventory_sha256':hashlib.sha256(original).hexdigest(),
            'recipe_sha256':hashlib.sha256(recipe).hexdigest()}


def image_build(path, image, root, source):
    value = read(path)
    need(value.get('schema') == 'cloudbench-image-build-v1' and value.get('publication_verified') is True
         and value.get('registry_handoff_verified') is True and value.get('publisher_exit_code') == 0
         and value.get('build_attempts') == 1 and value.get('source_dirty') is False,
         'unqualified image build')
    need(value['image_ref'] == image and image.endswith('@' + value['published_digest'])
         and re.fullmatch('sha256:[0-9a-f]{64}', value['published_digest']) is not None,
         'exact immutable published image required')
    subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', value['source_sha'], source['head']],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    need(value['dockerfile_sha256'] == IMAGE_RECIPE_V1
         and value['config_sha256'] == hashlib.sha256(subprocess.check_output(
             ['git','-C',str(root),'show',value['source_sha']+':fly.cloudbench-warm.toml'])).hexdigest(),
         'original image recipe/config receipt')
    image_inputs(root,value['source_sha'],source['head'])
    return value


def verify_transition(intent, complete):
    need(intent['schema'] == complete['schema'] == SCHEMA and complete['intent_sha256'] == digest(intent), 'native intent seal')
    need(re.fullmatch('[0-9a-f]{32}', intent['nonce']) is not None
         and complete['nonce'] == intent['nonce'] and complete['producer'] == intent['producer']
         and intent['producer']['start'] and complete['native_exit'] == 0 and complete.get('qualified') is True,
         'nonce/producer/native exit')
    need(complete['cleanup_complete'] is False and complete['credit_granted'] is False,
         'maintenance grants no cleanup/credit')
    before, after = intent['before'], complete['after']
    old, new = before['warm'], after['warm']
    need(intent['started_at'] <= before['observed_at'] <= complete['finished_at']
         and before['observed_at'] <= after['observed_at'] <= complete['finished_at'], 'native chronology')
    need(before['guard']['boot'] == after['guard']['boot'] and before['guard']['uid'] == after['guard']['uid'], 'observer incarnation')
    need(intent['targets'] == [['warm', old['id']]] and old['id'] == new['id'] and old['name'] == new['name']
         and old['state'] == new['state'] == 'stopped' and old['instance_id'] and new['instance_id'], 'exact stopped warm target')
    need(old['stable_sha256'] == new['stable_sha256'] and old['mounts'] == new['mounts']
         and before['volumes'] == after['volumes'], 'foreign config/volume delta')
    need(new['image'] == intent['image'] and new['image_digest'] == intent['image_digest'], 'image digest changed')
    need(new['guest'] == {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': 2048}
         and new['command'] == ['sleep', 'infinity'], 'only native default parked shape/command allowed')
    need(set(before['inventory']) == set(after['inventory']) and old['id'] in before['inventory'], 'extra/missing inventory target')
    need(all(after['inventory'][key] == value for key, value in before['inventory'].items() if key != old['id']),
         'foreign machine changed')
    for observation_value in (before, after):
        warm = observation_value['warm']; row = observation_value['inventory'][warm['id']]
        need(row == {k: warm[k] for k in ('name', 'instance_id', 'state', 'config_sha256')}, 'inventory/warm mismatch')


def pool_binding(root):
    path = root/'.context/cloudbench-pool.ids'
    if not path.exists():
        need(not path.is_symlink(), 'unsafe declared pool')
        return 'absent'
    need(path.is_file() and not path.is_symlink() and path.resolve() == path,
         'unsafe declared pool')
    value = path.read_bytes()
    need(not value.strip(), 'declared pool targets need separate ownership authority')
    return hashlib.sha256(value).hexdigest()


def historical_debt_audit(state, gate):
    """No source/admission coverage: exact static scopes plus full native audits."""
    from deploy_test_cycle import bound_isolated_owner_roots
    from deploy_test_native_cleanup import inherited_native_sources
    bound_isolated_owner_roots(state, gate)
    entries=debts(state,gate['name'])
    need(inherited_native_sources(state,entries,_historical_only=True)=={}, 'historical audit grants no launch credit')
    return entries


def original_owned_baseline(state, root, entries):
    """An original failed intent/result can bind scope without becoming success."""
    candidates=[]
    for record in state.get('native_maintenance',[]):
        directory=Path(record['directory'])
        need(directory==common(root)/'cloudbench-maintenance'/record['nonce']
             and directory.resolve()==directory and not directory.is_symlink(),'original custody operation path')
        intent=read(directory/'intent.json');result=read(directory/'result.json')
        need(record.get('intent_sha256')==digest(intent) and record.get('result_sha256')==digest(result)
             and result['intent_sha256']==digest(intent) and result['producer']==record['producer']==intent['producer']
             and result['nonce']==record['nonce']==intent['nonce'] and record['source']==intent['source']
             and result['native_exit']==record['native_exit'] and result['qualified']==record['qualified']
             and result['cleanup_complete'] is False and result['credit_granted'] is False,
             'original custody native seals')
        # The original state hash/digest was captured before original mutation;
        # its source/script hashes and native producer evidence remain immutable.
        need(intent['root']==str(root) and intent['producer']['start'], 'original custody producer/root')
        anchor,_=anchor_for(entries)
        pin=anchor['proof']['guest_observation']['warm']
        if all(intent['before']['warm'][k]==pin[k] for k in ('id','instance_id','name','state','config_sha256')):
            candidates.append((record,intent,result))
    need(candidates,'original owned maintenance custody missing')
    # Failed attempts are never filtered out or modified, nor does this test
    # certify their complete transition. Only original scope is reused.
    record,intent,result=candidates[0]
    need(intent['targets']==[['warm',intent['before']['warm']['id']]],'original custody singleton')
    return intent['before']['warm'], {'nonce':record['nonce'],'intent_sha256':digest(intent),'result_sha256':digest(result)}


CACHE_FIELDS=('node','python','epoch','snapshot','volume','machine','app')


def native_cache_baseline(state, root, entries):
    """Only historical native before records; failed outcomes stay failed."""
    if not state.get('native_maintenance'):return None
    original,_=original_owned_baseline(state,root,entries)  # verifies ALL state/file seals
    for record in state['native_maintenance']:
        directory=Path(record['directory']);intent=read(directory/'intent.json')
        before=intent['before']['warm'];addition=intent['before'].get('cache_addition')
        # Never derive authority from a renewal generation or its after-state.
        if not isinstance(addition,dict) or 'schema' in addition or 'key' not in addition:continue
        if addition.get('without_key_sha256')!=original['stable_sha256']:continue
        need(intent['gate']==entries[0]['gate'] and intent['app']==addition['app']
             and intent['targets']==[['warm',original['id']]]
             and intent['requested_ref']==intent['source']['head'],'sealed cache native operation binding')
        need(all(before[k]==original[k] for k in ('id','name','mounts')) and before['state']=='stopped'
             and before['command']==['sleep','infinity'],'sealed cache baseline scope')
        need(set(intent['scripts'])==set(SCRIPTS) and all(
             hashlib.sha256(subprocess.check_output(['git','-C',str(root),'show',intent['source']['head']+':'+name],stderr=subprocess.PIPE)).hexdigest()==sha
             for name,sha in intent['scripts'].items()),'sealed cache producer source')
        values=before.get('cache_addition_projections',[])
        known={v['key']:{k:v[k] for k in CACHE_FIELDS} for v in values}
        need(len(known)==len(values) and addition['key'] in known and
             known[addition['key']]=={k:addition[k] for k in CACHE_FIELDS},'sealed cache tuples')
        # Tuple spelling is the publisher's exact seven-field value. Its bytes
        # are independently checked against BOTH original native full hashes.
        for key,v in known.items():
            canonical=' '.join(str(v[k]) for k in CACHE_FIELDS)
            parsed=cache_addition_projections({'metadata':{key:canonical},'mounts':before['mounts']},before['id'])
            need(len(parsed)==1 and parsed[0]['app']==intent['app'],'sealed cache tuple identity')
        return dict(schema='native-cache-baseline-v1',machine=before['id'],app=intent['app'],
                    original_stable_sha256=original['stable_sha256'],before_stable_sha256=before['stable_sha256'],
                    admitted_addition=addition['key'],entries=known,
                    native_before=dict(nonce=record['nonce'],intent_sha256=record['intent_sha256'],
                                       result_sha256=record['result_sha256'],source=record['source']))
    return None


def cache_renewal_projection(stable, baseline):
    """Hash reconstruction only; invalid or missing data grants no coverage."""
    try:
        metadata=stable.get('metadata',{})
        parsed=cache_addition_projections(stable,baseline['machine'])
        current={v['key']:{k:v[k] for k in CACHE_FIELDS} for v in parsed}
        # Unknown cache namespace entries cannot be excluded by a broad prefix.
        if set(current)!=set(baseline['entries']):return None
        # Legacy/unrecognized fields stay byte-for-byte in the full hash;
        # they are never reconstructed or excluded as advisory entries.
        restored=copy.deepcopy(stable)
        for key,old in baseline['entries'].items():
            value=current[key]
            if any(value[k]!=old[k] for k in ('node','python','volume','machine','app')):return None
            restored['metadata'][key]=' '.join(str(old[k]) for k in CACHE_FIELDS)
        prior=digest(restored)
        del restored['metadata'][baseline['admitted_addition']]
        return dict(baseline_sha256=digest(baseline),before_stable_sha256=prior,
                    original_stable_sha256=digest(restored),entries=current)
    except (KeyError,TypeError,ValueError,AttributeError):
        return None


def qualified_cache_renewal(warm, original, baseline, app):
    projection=warm.get('cache_renewal_projection')
    need(baseline['app']==app and baseline['machine']==warm['id'] and projection is not None
         and projection['baseline_sha256']==digest(baseline)
         and projection['before_stable_sha256']==baseline['before_stable_sha256']
         and projection['original_stable_sha256']==original['stable_sha256']==baseline['original_stable_sha256'],
         'sealed native cache full-hash reconstruction')
    current=projection['entries'];old=baseline['entries'];changed=[]
    need(set(current)==set(old),'native cache entry set changed')
    for key,value in current.items():
        need(all(value[k]==old[key][k] for k in ('node','python','volume','machine','app')),'native cache tuple changed')
        if value!=old[key]:
            need(value['epoch']>old[key]['epoch'] and value['snapshot']!=old[key]['snapshot'], 'native cache renewal monotonicity')
            changed.append(key)
    # The original admitted addition must still have a completed live snapshot;
    # unchanged historical entries are protected by the full hash, not re-used.
    verify=sorted(set(changed)|{baseline['admitted_addition']});inventories={};proofs={}
    import datetime
    for key in verify:
        value=current[key];vid=value['volume']
        need(0<value['epoch']<=time.time(),'native cache future epoch')
        if vid not in inventories:inventories[vid]=get(app,'volumes/'+vid+'/snapshots')
        rows=inventories[vid]
        need(isinstance(rows,list) and all(isinstance(r,dict) for r in rows),'native cache snapshot inventory')
        found=[r for r in rows if r.get('id')==value['snapshot']]
        need(len(found)==1,'native cache snapshot identity')
        row=found[0]
        need(row.get('volume_id',vid)==vid,'native cache snapshot volume')
        created=datetime.datetime.fromisoformat(row['created_at'].replace('Z','+00:00')).timestamp()
        need(row.get('status','').lower() in {'created','complete','completed','ready'}
             and int(row.get('size') or 0)>0 and value['epoch']-60<=created<=time.time(), 'native cache snapshot completion')
        proofs[key]={**value,'created_at':row['created_at'],'status':row['status'],'size':row['size']}
    return dict(schema='native-cache-renewal-v1',baseline_sha256=digest(baseline),
                native_before=baseline['native_before'],original_stable_sha256=original['stable_sha256'],
                renewed_entries=sorted(changed),snapshots=proofs,dependency_reuse_credit=False)


def owned_scope(warm, original, *, app=None, cache_baseline=None):
    # Full old digest remains the authority. A single additive advisory cache
    # entry may be projected out ONLY when the exact remaining digest matches.
    need(all(warm[k]==original[k] for k in ('id','name','mounts'))
         and warm['state']=='stopped' and warm['instance_id']
         and warm['command']==['sleep','infinity'], 'prospective original owned resource scope')
    if cache_baseline is not None:
        return qualified_cache_renewal(warm,original,cache_baseline,app)
    if warm['stable_sha256']==original['stable_sha256']:return None
    matching=[p for p in warm.get('cache_addition_projections',[])
              if p['without_key_sha256']==original['stable_sha256'] and p['app']==app]
    need(len(matching)==1,'prospective original owned resource scope')
    proof=matching[0]
    # Same completed-snapshot predicate as cloudbench_warm_deps_state_from_inventory.
    import datetime
    snapshots=get(app,'volumes/'+proof['volume']+'/snapshots')
    need(isinstance(snapshots,list) and all(isinstance(r,dict) for r in snapshots),'added cache snapshot inventory')
    rows=[r for r in snapshots if r.get('id')==proof['snapshot']]
    need(len(rows)==1,'added cache snapshot identity')
    row=rows[0]
    created=datetime.datetime.fromisoformat(row['created_at'].replace('Z','+00:00')).timestamp()
    need(row.get('status','').lower() in {'created','complete','completed','ready'}
         and int(row.get('size') or 0)>0 and 0<proof['epoch']<=time.time()
         and created>=proof['epoch']-60,'added cache snapshot completion')
    return {**proof,'snapshot_created_at':row['created_at'],'snapshot_status':row['status'],
            'snapshot_size':row['size'],'dependency_reuse_credit':False}


def prestart(args):
    pointer=read(args.pointer);directory=Path(pointer['directory']);intent=read(directory/'intent.json')
    if 'prospective_origin' not in intent:
        return  # Preserve the existing pinned-generation setup contract.
    root=Path(intent['root'])
    need(directory==common(root)/'cloudbench-maintenance'/intent['nonce']
         and pointer['intent_sha256']==digest(intent),'prestart original intent')
    need(native_owner(root,args.pid,Path(intent['state_path']),intent['state_fd'])==intent['producer'],
         'prestart native producer')
    from deploy_test_cycle import source
    state=read(intent['state_path'])
    need(state['native_maintenance'][-1]==pointer and source(root)==intent['source']
         and script_hashes(root,intent['source']['head'])==intent['scripts'], 'prestart source/state anchor')
    previous=copy.deepcopy(state);previous['native_maintenance'].pop()
    if not previous['native_maintenance'] and not intent['previous_native_maintenance_present']:
        previous.pop('native_maintenance')
    need(digest(previous)==intent['state_sha256'], 'prestart cycle changed during native maintenance')
    need(digest(read(intent['build_path']))==intent['build_sha256'], 'prestart original build receipt')
    image_build(Path(intent['build_path']),intent['image'],root,intent['source'])
    def preserve_failure(evidence, error=None):
        if error is not None:
            evidence['finished_at'] = time.time()
            evidence['error_type'] = type(error).__name__
            if isinstance(error,ValueError) and str(error).startswith('native maintenance:'):
                evidence['reason'] = str(error)
        comparisons=evidence.setdefault('comparisons',{})
        if 'volumes' in evidence:
            comparisons['retained_volumes_equal']=evidence['volumes']==intent['before']['volumes']
        if 'inventory' in evidence:
            warm_id=intent['targets'][0][1]
            comparisons['foreign_inventory_equal']=(
                {k:v for k,v in evidence['inventory'].items() if k!=warm_id} ==
                {k:v for k,v in intent['before']['inventory'].items() if k!=warm_id})
        write_once(directory/'prestart-observation-failure.json', {
            'schema':'native-maintenance-observation-diagnostic-v1','diagnostic_only':True,'stage':'prestart',
            'nonce':intent['nonce'],'source':intent['source'],'producer':intent['producer'],
            'intent_sha256':digest(intent),'observation':evidence,
            'cleanup_complete':False,'credit_granted':False,
        })
    samples={}
    current=observation(intent['app'],intent['targets'][0][1],native_pid=args.pid,
                        failure_diagnostic=preserve_failure, diagnostic_samples=samples)
    try:
        # Historical compatibility authorizes begin only. Before guest start,
        # the NEW intent's entire protected config must remain unchanged.
        need(current['warm']['stable_sha256']==intent['before']['warm']['stable_sha256'],
             'prestart protected config changed')
        owned_scope(current['warm'],intent['before']['warm'],app=intent['app'])
        need(current['warm']['image']==intent['image'] and current['warm']['image_digest']==intent['image_digest'],
             'prestart desired immutable image')
        need(current['volumes']==intent['before']['volumes']
             and {k:v for k,v in current['inventory'].items() if k!=current['warm']['id']}==
                 {k:v for k,v in intent['before']['inventory'].items() if k!=current['warm']['id']}, 'prestart foreign inventory/volume changed')
    except Exception as error:
        try:
            preserve_failure(samples,error)
        except Exception:
            pass  # Diagnostics never replace the original post-observation refusal.
        raise
    record=dict(schema=SCHEMA,nonce=intent['nonce'],intent_sha256=digest(intent),producer=intent['producer'],observation=current)
    write_once(directory/'prestart.json',record)
    # Anchor the in-memory capture before this child authorizes guest start.
    # A read-only file alone is replaceable through its parent directory.
    from deploy_test_cycle import write
    state['native_maintenance'][-1]={**pointer,'prestart_sha256':digest(record)}
    write(Path(intent['state_path']),state)


def begin(args):
    from deploy_test_cycle import source, isolated_admissions
    root = args.root.resolve(); state = read(args.state)
    need(args.root == root and not args.root.is_symlink(), 'physical original root required')
    current = source(root)
    need(args.requested_ref == current['head'], 'exact requested setup source')
    need(all('result_sha256' in record for record in state.get('native_maintenance', [])),
         'unfinished original maintenance must be reconciled, not discarded')
    need(state['source'] == state['plan']['source'] == current, 'frozen original source')
    gate = next(g for g in state['plan']['gates'] if g['name'] == args.gate)
    need(gate.get('native_cloud') is True, 'native cloud gate required')
    need(args.state.resolve() == args.state and args.state.is_relative_to(root/'.context'), 'original cycle path')
    producer = native_owner(root, args.pid, args.state, args.state_fd)
    need(state.get('ready') is False and state.get('phase') == 'needs-focused-plan', 'quiescent failed cycle required')
    quiescent(native_pid=args.pid)
    entries = debts(state, args.gate)
    anchor, _ = anchor_for(entries)
    expected = anchor['proof']['guest_observation']['warm']
    targets = [line.split('\t') for line in args.targets.splitlines()]
    need(targets == [['warm', expected['id']]], 'pool/extra target needs separate authority')
    pool = pool_binding(root)
    build = image_build(args.build, args.image, root, current)
    cache_baseline=native_cache_baseline(state,root,entries)
    started = time.time(); before = observation(args.app, expected['id'], native_pid=args.pid,cache_baseline=cache_baseline)
    prospective=not all(before['warm'][key] == expected[key] for key in ('id','instance_id','name','state','config_sha256'))
    predecessor=None
    if prospective:
        need(historical_debt_audit(state,gate)==entries,'original historical debt authority')
        original,predecessor=original_owned_baseline(state,root,entries)
        compatibility=owned_scope(before['warm'],original,app=args.app,cache_baseline=cache_baseline)
        if compatibility is not None:before['cache_addition']=compatibility
    else:
        need(sorted(isolated_admissions(state, args.gate), key=lambda e: e['token']) == entries, 'original debt authority')
    registry = common(root)/'cloudbench-maintenance'
    need(not registry.is_symlink() and registry.resolve() == registry, 'unsafe native registry parent')
    need(args.pointer.resolve() == args.pointer, 'unsafe native output parent')
    nonce = secrets.token_hex(16); directory = registry/nonce
    directory.mkdir(parents=True, mode=0o700)
    need(directory.resolve() == directory and not directory.is_symlink(), 'unsafe native operation directory')
    intent = dict(schema=SCHEMA, nonce=nonce, root=str(root), source=current, scripts=script_hashes(root,current['head']),
                  producer=producer, app=args.app, gate=args.gate, targets=targets, pool_sha256=pool, debt_sha256=digest(entries),
                  state_path=str(args.state), state_sha256=digest(state), state_fd=args.state_fd,
                  previous_native_maintenance_present='native_maintenance' in state, requested_ref=args.requested_ref,
                  image=args.image, image_digest=build['published_digest'], build_path=str(args.build),
                  build_sha256=digest(build), image_input_equivalence=image_inputs(root,build['source_sha'],current['head']),
                  before=before, started_at=started)
    if prospective:
        intent['prospective_origin']={'predecessor':predecessor}
    write_once(directory/'intent.json', intent)
    pointer = {'schema': SCHEMA, 'directory': str(directory), 'intent_sha256': digest(intent),
               'nonce': nonce, 'producer': producer, 'source': current, 'debt_sha256': digest(entries)}
    write_once(args.pointer, pointer)
    # The trusted original coordinator state anchors intent BEFORE any mutation.
    # The native shell holds its existing cycle flock for the entire operation.
    from deploy_test_cycle import write
    state.setdefault('native_maintenance', []).append(pointer)
    write(args.state, state)


def validate_prestart(intent,result,record):
    need(record['schema']==SCHEMA and record['nonce']==intent['nonce']
         and record['intent_sha256']==digest(intent) and record['producer']==intent['producer'], 'prestart native seal')
    current=record['observation'];owned_scope(current['warm'],intent['before']['warm'],app=intent['app'])
    need(current['warm']['image']==intent['image'] and current['warm']['image_digest']==intent['image_digest']
         and intent['started_at']<=current['observed_at']<=result['finished_at'], 'prestart image/time binding')
    need(current['volumes']==intent['before']['volumes'] and
         {k:v for k,v in current['inventory'].items() if k!=current['warm']['id']}==
         {k:v for k,v in intent['before']['inventory'].items() if k!=current['warm']['id']}, 'prestart original resource inventory')
    need(result.get('prestart_sha256')==digest(record),'prestart result seal')


def finish(args):
    from deploy_test_cycle import source
    pointer = read(args.pointer); directory = Path(pointer['directory']); intent = read(directory/'intent.json')
    root = Path(intent['root'])
    need(directory == common(root)/'cloudbench-maintenance'/intent['nonce']
         and pointer['intent_sha256'] == digest(intent), 'original operation path/seal')
    state_path = Path(intent['state_path']); state = read(state_path)
    records = state.get('native_maintenance', [])
    need(records and {k:v for k,v in records[-1].items() if k!='prestart_sha256'} == pointer, 'original pre-mutation cycle anchor')
    pointer=records[-1]
    previous = copy.deepcopy(state); previous['native_maintenance'].pop()
    if not previous['native_maintenance'] and not intent['previous_native_maintenance_present']:
        previous.pop('native_maintenance')
    need(digest(previous) == intent['state_sha256'], 'cycle changed during native maintenance')
    need(native_owner(root, args.pid, state_path, intent['state_fd']) == intent['producer'] and source(root) == intent['source']
         and script_hashes(root,intent['source']['head']) == intent['scripts'], 'original native process/source changed')
    need(pool_binding(root) == intent['pool_sha256'], 'declared targets changed during maintenance')
    # Record failed exits faithfully; they never receive a successful transition.
    complete = dict(schema=SCHEMA, nonce=intent['nonce'], producer=intent['producer'],
                    intent_sha256=digest(intent), native_exit=args.native_exit,
                    cleanup_complete=False, credit_granted=False)
    complete['qualified'] = args.native_exit == 0
    try:
        if args.native_exit == 0:
            complete['after'] = observation(intent['app'], intent['targets'][0][1], native_pid=args.pid)
        complete['finished_at'] = time.time()
        if 'prospective_origin' in intent:
            record=read(directory/'prestart.json')
            need(pointer.get('prestart_sha256')==digest(record),'original prestart cycle anchor')
            complete['prestart_sha256']=pointer['prestart_sha256']
            validate_prestart(intent,complete,record)
        verify_transition(intent, complete)
    except (OSError, ValueError, KeyError, TypeError) as error:
        complete['qualified'] = False
        complete['finished_at'] = time.time()
        # Class only: provider error payloads/config/secrets never enter logs.
        complete['verification_error'] = type(error).__name__
    write_once(directory/'result.json', complete)
    from deploy_test_cycle import write
    records[-1] = {**pointer, 'result_sha256': digest(complete), 'native_exit': args.native_exit,
                   'qualified': complete['qualified']}
    write(state_path, state)
    need(complete['qualified'], 'native transition did not qualify; original exit retained')


def validate_current(state, entries, anchor, operation):
    """Only a genuine recorded native transition can replace current guest pins."""
    root = Path(anchor['owner']['worker_root'])
    records = state.get('native_maintenance', [])
    matching = [record for record in records if record.get('debt_sha256') == digest(sorted(entries,key=lambda e:e['token']))]
    # Failed native outcomes remain anchored forever. They do not become a
    # second successful authority or prevent a fresh, independently qualified
    # operation. An unfinished intent, however, is not an authenticated failure.
    for record in matching:
        directory = Path(record['directory'])
        need(directory == common(root)/'cloudbench-maintenance'/record['nonce']
             and directory.resolve() == directory and not directory.is_symlink(), 'native attempt path')
        prior_intent = read(directory/'intent.json'); prior_result = read(directory/'result.json')
        need(record.get('result_sha256') == digest(prior_result)
             and record['intent_sha256'] == digest(prior_intent)
             and prior_result['intent_sha256'] == digest(prior_intent)
             and prior_intent['nonce'] == prior_result['nonce'] == record['nonce']
             and prior_intent['producer'] == prior_result['producer'] == record['producer']
             and prior_result['native_exit'] == record['native_exit']
             and prior_result['qualified'] == record['qualified']
             and prior_result['cleanup_complete'] is False and prior_result['credit_granted'] is False,
             'preserved native attempt seal')
    candidates = [record for record in matching if record['native_exit'] == 0 and record['qualified'] is True]
    need(len(candidates) == 1, 'unique successful original maintenance producer required')
    record = candidates[0]
    directory = Path(record['directory'])
    need(directory == common(root)/'cloudbench-maintenance'/record['nonce']
         and directory.resolve() == directory and not directory.is_symlink(), 'original native operation directory')
    intent = read(directory/'intent.json'); result = read(directory/'result.json')
    need(record.get('result_sha256') == digest(result) and record.get('intent_sha256') == digest(intent)
         and record['producer'] == intent['producer'] and record['nonce'] == intent['nonce']
         and record['source'] == intent['source'] and record['native_exit'] == 0,
         'original pre-mutation/result cycle seals')
    need(directory.name == intent['nonce'] and intent['root'] == str(root)
         and intent['gate'] == anchor['gate'] and intent['source'] == state['source'] == state['plan']['source'],
         'native root/debt/source binding')
    need(script_hashes(root,state['source']['head']) == intent['scripts'], 'native producer source hash')
    image_build(Path(intent['build_path']), intent['image'], root, intent['source'])
    build = read(intent['build_path'])
    need(digest(build) == intent['build_sha256']
         and image_inputs(root,build['source_sha'],state['source']['head']) == intent['image_input_equivalence'],
         'original build receipt/input equivalence changed')
    need(pool_binding(root) == intent['pool_sha256'], 'declared targets changed after maintenance')
    expected = anchor['proof']['guest_observation']['warm']
    if 'prospective_origin' in intent:
        gate=next(g for g in state['plan']['gates'] if g['name']==intent['gate'])
        historical_debt_audit(state,gate)
        original,predecessor=original_owned_baseline(state,root,entries)
        need(intent['prospective_origin']=={'predecessor':predecessor},'original prospective scope seal')
        cache_baseline=native_cache_baseline(state,root,entries)
        compatibility=owned_scope(intent['before']['warm'],original,app=intent['app'],cache_baseline=cache_baseline)
        need(intent['before'].get('cache_addition')==compatibility,'original cache addition proof changed')
    else:
        need(all(intent['before']['warm'][k] == expected[k] for k in ('id','instance_id','name','state','config_sha256')),
             'original pinned before authority')
    if 'prospective_origin' in intent:
        need(record.get('prestart_sha256')==result.get('prestart_sha256') and record.get('prestart_sha256'),
             'original prestart result/cycle anchor')
        validate_prestart(intent,result,read(directory/'prestart.json'))
    verify_transition(intent, result)
    current = observation(intent['app'], intent['targets'][0][1])
    need(current['warm'] == result['after']['warm'] and current['volumes'] == result['after']['volumes']
         and current['inventory'] == result['after']['inventory']
         and all(current['guard'][key] == result['after']['guard'][key] for key in ('boot','uid')),
         'fresh native partition changed')
    # Reuse all existing resource/socket audits with the exact new expected warm.
    import deploy_test_round16_isolation as prior
    # Do not replace the file or invoke a mock observer. Audit existing excluded
    # resources and original Hub via the operation's immutable resource contract.
    for mid, vid in operation.operation_spec()['excluded_resources'].items():
        import urllib.error
        for resource, identifier in (('machines',mid),('volumes',vid)):
            try:
                item = get(intent['app'], resource+'/'+identifier)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    continue
                raise
            need(item['id'] == identifier and item['state'] in ('destroyed','pending_destroy')
                 and (resource == 'machines' or item.get('attached_machine_id') is None), 'original resource remains active')
    old_socket = anchor['proof']['guest_observation']['hub_socket']
    need(prior.hub_socket(pid=old_socket['pid'],port=old_socket['port']) == old_socket, 'original Hub socket changed')
    final = observation(intent['app'], intent['targets'][0][1])
    need(all(final[key] == current[key] for key in ('warm','volumes','inventory'))
         and all(final['guard'][key] == current['guard'][key] for key in ('boot','uid')),
         'partition changed during inherited resource/Hub audit')
    return True


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('operation', choices=('begin','prestart','finish')); p.add_argument('--pointer',type=Path,required=True)
    p.add_argument('--pid',type=int,required=True); p.add_argument('--root',type=Path)
    p.add_argument('--state',type=Path); p.add_argument('--gate'); p.add_argument('--build',type=Path)
    p.add_argument('--requested-ref'); p.add_argument('--image'); p.add_argument('--targets'); p.add_argument('--app')
    p.add_argument('--native-exit',type=int,default=1); p.add_argument('--state-fd',type=int)
    args = p.parse_args()
    {'begin':begin,'prestart':prestart,'finish':finish}[args.operation](args)

if __name__ == '__main__':
    main()
