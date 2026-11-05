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


def machine(value):
    """Only hashes/presence of config and env/file contents persist in receipts."""
    config = copy.deepcopy(value['config'])
    stable = copy.deepcopy(config)
    stable.pop('image', None); stable.pop('guest', None)
    init = stable.get('init', {}); init.pop('cmd', None)
    if not init:
        stable.pop('init', None)
    return {**{k: value[k] for k in ('id', 'instance_id', 'name', 'state')},
            'config_sha256': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
            'stable_sha256': digest(stable), 'guest': config.get('guest'),
            'command': config.get('init', {}).get('cmd'),
            'image': config['image'], 'image_digest': value.get('image_ref', {}).get('digest'),
            'mounts': config.get('mounts', [])}


def observation(app, warm_id, *, native_pid=None):
    before = machine(get(app, 'machines/' + warm_id))
    inventory = get(app, 'machines')
    need(isinstance(inventory, list) and len({m['id'] for m in inventory}) == len(inventory), 'inventory unreadable')
    volumes = {}
    for mount in before['mounts']:
        vid = mount['volume']; volume = get(app, 'volumes/' + vid)
        need(volume['id'] == vid and volume.get('attached_machine_id') == warm_id
             and volume['state'] not in ('destroyed', 'pending_destroy'), 'retained volume ownership')
        volumes[vid] = {'id': vid, 'attached_machine_id': warm_id, 'state': volume['state']}
    need(volumes, 'retained volume missing')
    after = machine(get(app, 'machines/' + warm_id))
    need(before == after and before['state'] == 'stopped', 'unstable/nonstopped native partition')
    return {'warm': before, 'volumes': volumes,
            'inventory': {m['id']: {'name': m['name'], 'instance_id': m['instance_id'],
                          'state': m['state'], 'config_sha256': machine(m)['config_sha256']} for m in inventory},
            'guard': quiescent(native_pid=native_pid), 'observed_at': time.time()}


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
    need(sorted(isolated_admissions(state, args.gate), key=lambda e: e['token']) == entries, 'original debt authority')
    anchor, _ = anchor_for(entries)
    expected = anchor['proof']['guest_observation']['warm']
    targets = [line.split('\t') for line in args.targets.splitlines()]
    need(targets == [['warm', expected['id']]], 'pool/extra target needs separate authority')
    pool = pool_binding(root)
    build = image_build(args.build, args.image, root, current)
    started = time.time(); before = observation(args.app, expected['id'], native_pid=args.pid)
    need(all(before['warm'][key] == expected[key] for key in ('id', 'instance_id', 'name', 'state', 'config_sha256')),
         'original warm pin changed before mutation')
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
    write_once(directory/'intent.json', intent)
    pointer = {'schema': SCHEMA, 'directory': str(directory), 'intent_sha256': digest(intent),
               'nonce': nonce, 'producer': producer, 'source': current, 'debt_sha256': digest(entries)}
    write_once(args.pointer, pointer)
    # The trusted original coordinator state anchors intent BEFORE any mutation.
    # The native shell holds its existing cycle flock for the entire operation.
    from deploy_test_cycle import write
    state.setdefault('native_maintenance', []).append(pointer)
    write(args.state, state)


def finish(args):
    from deploy_test_cycle import source
    pointer = read(args.pointer); directory = Path(pointer['directory']); intent = read(directory/'intent.json')
    root = Path(intent['root'])
    need(directory == common(root)/'cloudbench-maintenance'/intent['nonce']
         and pointer['intent_sha256'] == digest(intent), 'original operation path/seal')
    state_path = Path(intent['state_path']); state = read(state_path)
    records = state.get('native_maintenance', [])
    need(records and records[-1] == pointer, 'original pre-mutation cycle anchor')
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
    need(all(intent['before']['warm'][k] == expected[k] for k in ('id','instance_id','name','state','config_sha256')),
         'original pinned before authority')
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
    p.add_argument('operation', choices=('begin','finish')); p.add_argument('--pointer',type=Path,required=True)
    p.add_argument('--pid',type=int,required=True); p.add_argument('--root',type=Path)
    p.add_argument('--state',type=Path); p.add_argument('--gate'); p.add_argument('--build',type=Path)
    p.add_argument('--requested-ref'); p.add_argument('--image'); p.add_argument('--targets'); p.add_argument('--app')
    p.add_argument('--native-exit',type=int,default=1); p.add_argument('--state-fd',type=int)
    args = p.parse_args()
    begin(args) if args.operation == 'begin' else finish(args)

if __name__ == '__main__':
    main()
