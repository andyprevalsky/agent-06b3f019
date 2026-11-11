"""Read-only, launch-only reconciliation of sealed native cloud fleet cleanup."""
import base64
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
SOURCE_REFUSAL = 'private fleet source validation failed'
ISOLATED_RENEWAL_PHASES = frozenset({'quick', 'final', 'triage', 'needs-focused-plan', 'failed-gates'})

# Bound raw run evidence per proof; ordinary receipts retain their existing limit.
MAX_RAW_FORENSIC_RUN_BYTES = 128 * 1024 * 1024

# A fleet's own _batch/run.json carries every message and log of its run: a mass-agent record was
# 98 MB on 2026-11-07, beyond the 64 MiB receipt cap, so its verified cleanup could never be bound
# and every later smoke launch was refused. Run records get their own, still finite, cap.
RUN_RECORD_MAX_BYTES = 512 * 1024 * 1024
# A complete multi-participant proof has a separate finite I/O allowance.
MAX_RAW_RUN_PROOF_BYTES = RUN_RECORD_MAX_BYTES


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


def stopped_pre_stack_execution(fleet, root, receipt, machine, token, evidence, bound, document):
    """Launch isolation only for a positively captured pre-stack dependency rejection."""
    native_driver = bound(root / 'scripts/cloudbench-run.sh', historical_head=receipt['source']['head'])
    need(hashlib.sha256(native_driver).hexdigest()
         == '1958de1798e8fdc46bd2081c1d530e9574c0957db80857d367802904f5ad5521',
         'unreviewed pre-stack driver')
    benches = json.loads(bound(fleet / '_batch/benches.json'))
    need(len(benches) == 1, 'stopped startup task closure')
    out = fleet / benches[0]['name']
    need(bound(out / '.cid') == ('clone ' + machine + '\n').encode()
         and document(out / 'runtime-evidence.owner.json')
             == {'version': 1, 'machine_id': machine, 'run_token': token}, 'stopped startup owner')
    import base64, gzip
    payload = json.loads(gzip.decompress(bound(out / 'cloudbench-boot-payload.json.gz')))
    need(base64.b64decode(payload['files']['cloudbench-run.sh'], validate=True) == native_driver,
         'stopped startup driver payload changed')
    path = out / 'remote-logs/cloudbench-driver.log'
    need(evidence.get('startup_rejection_log') == str(path), 'stopped startup log binding')
    log = bound(path).decode()
    steps = re.findall(r'^\[cloudbench [0-9:]+\] STEP (\S+)$', log, re.M)
    need(steps == ['git_sync', 'env_decode', 'dep_sync']
         and log.count('RUNSTAMP-' + token + '\n') == 1
         and ('[cloudbench] verified checkout ' + receipt['source']['head'] + '\n') in log
         and log.count('FATAL: cloudbench dependency synchronization failed') == 1
         and log.count('::CLOUDBENCH-DONE:: token=' + token + ' exit=1\n') == 1
         and 'driver cleanup evidence interrupt_status=0 cleanup_ack=1' in log,
         'stopped startup positive terminal boundary')


STOPPED_INERT_PRODUCER_SHA256 = '51f69b6cf96ca6ff4bceabb9c1b3a8b0c3da2ad5a0d5e7aa35368e4ed76685be'


def stopped_inert_execution(fleet, root, receipt, proof, row, token, evidence, pair, bound, document):
    """Admit execution isolation for a reviewed STOP-retained inert fresh allocation only."""
    import ast
    spec = evidence['stopped_inert_allocation']
    need(isinstance(spec, dict) and set(spec) == {'operator', 'result', 'intent', 'stopped'},
         'stopped inert descriptor')
    operator = bound(spec['operator'])
    need(hashlib.sha256(operator).hexdigest()
         == STOPPED_INERT_PRODUCER_SHA256,
         'unreviewed stopped inert producer')
    result, intent, final = (document(spec[k]) for k in ('result', 'intent', 'stopped'))
    machine, volume, owner = row['machine_id'], row['volume_id'], row['fleet_owner_token']
    need(result.get('kind') == 'exact-worker-stop-retain-v1' and result.get('status') == 'STOPPED_RETAINED'
         and all(result.get(k) is False for k in ('task_credit', 'evidence_credit', 'cleanup_complete'))
         and all(result.get(k) is True for k in ('custody_unchanged', 'primary_sealed_evidence_unchanged',
                                                'runtime_latch_retained', 'ledger_retained')),
         'stopped inert retention result')
    names = {'MID', 'VOL', 'OWNER', 'REF', 'PRIMARY', 'INSTANCE', 'CONFIG_SHA'}
    constants = {target.id: ast.literal_eval(node.value) for node in ast.parse(operator).body
                 if isinstance(node, ast.Assign) for target in node.targets
                 if isinstance(target, ast.Name) and target.id in names}
    need(constants == {'MID': machine, 'VOL': volume, 'OWNER': owner, 'REF': receipt['source']['head'],
                       'PRIMARY': result.get('primary_untouched'), 'INSTANCE': intent.get('instance_id'),
                       'CONFIG_SHA': intent.get('config_sha256')}, 'stopped inert producer target binding')
    need(result.get('machine') == intent.get('machine') == machine
         and result.get('volume') == intent.get('volume') == volume
         and result.get('owner') == intent.get('owner') == owner
         and intent.get('kind') == 'exact-worker-stop-retain-intent-v1'
         and intent.get('source') == receipt['source']['head']
         and intent.get('script_sha256') == hashlib.sha256(operator).hexdigest()
         and intent.get('method') == 'POST' and intent.get('path') == '/machines/' + machine + '/stop'
         and intent.get('evidence_credit') is False
         and result.get('stop_intent_sha256') == hashlib.sha256(bound(spec['intent'])).hexdigest()
         and result.get('native_stopped_sha256') == hashlib.sha256(bound(spec['stopped'])).hexdigest(),
         'stopped inert receipt binding')
    attempt = Path(intent['attempt'])
    before, after = (document(attempt / (name + '.private.json')) for name in ('native-before', 'native-after'))
    guest, custody = document(attempt / 'guest-proof.json'), document(attempt / 'custody.private.json')
    need(before == after and final.get('machine', {}).get('state') == 'stopped',
         'stopped inert native capture')
    initial, stopped = before['machine'], final['machine']
    config = initial['config']
    need(initial.get('id') == stopped.get('id') == machine and initial.get('state') == 'started'
         and initial.get('instance_id') == stopped.get('instance_id') == intent.get('instance_id')
         and isinstance(intent.get('instance_id'), str) and bool(intent['instance_id'])
         and isinstance(initial.get('image_ref'), dict)
         and re.fullmatch('sha256:[0-9a-f]{64}', initial['image_ref'].get('digest', ''))
         and initial.get('image_ref') == stopped.get('image_ref')
         and config == stopped.get('config')
         and hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest() == intent.get('config_sha256')
         and config.get('init') == {'cmd': ['sleep', 'infinity']} and config.get('restart') == {'policy': 'no'}
         and not any(config.get(k) for k in ('auto_destroy', 'containers', 'processes', 'standbys', 'schedule'))
         and config.get('env', {}).get('REF') == receipt['source']['head']
         and config.get('env', {}).get('CLOUDBENCH_RUN_TOKEN') == token
         and len(config.get('mounts', [])) == 1 and config['mounts'][0].get('volume') == volume
         and config['mounts'][0].get('path') == '/data'
         and before['volume'] == after['volume'] == final['volume']
         and final['volume'].get('id') == volume and final['volume'].get('state') == 'created'
         and final['volume'].get('attached_machine_id') == machine, 'stopped inert immutable native identity')
    nonce = attempt.name.removeprefix('preflight-')
    need(re.fullmatch('[0-9a-f]{32}', nonce) and guest.get('nonce') == nonce
         and guest.get('kind') == 'exact-inert-quiescence-v1' and guest.get('machine') == machine
         and re.fullmatch('[0-9a-f-]{36}', guest.get('boot', '')) and guest.get('unknown') == []
         and isinstance(guest.get('inert_sleepers'), list) and guest['inert_sleepers']
         and isinstance(guest.get('idle_pinned_agents'), list)
         and isinstance(guest.get('idle_platform_hallpass'), list) and len(guest['idle_platform_hallpass']) <= 1
         and finite(guest.get('observed_epoch')) and finite(intent.get('epoch'))
         and receipt['finished_at'] <= guest['observed_epoch'] <= intent['epoch'] <= proof['confirmed_at'],
         'stopped inert guest quiescence')
    classified = guest['inert_sleepers'] + guest['idle_pinned_agents'] + guest['idle_platform_hallpass']
    need(len(classified) <= 4096 and all(type(p.get('pid')) is int and p['pid'] > 1
         and isinstance(p.get('birth'), str) and p['birth'].isdigit() for p in classified)
         and len({p['pid'] for p in classified}) == len(classified), 'stopped inert process identities')
    helper = bound(root / 'scripts/cloudbench-original-volume-capture.py')
    need(hashlib.sha256(helper).hexdigest() == 'ddde11af81f8200c1987648ad19b10dd5aa893fbd6e05c6a25ec0c7ea8c12c58',
         'stopped inert guest producer changed')
    source = next(ast.literal_eval(node.value) for node in ast.parse(helper).body
                  if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'BILLING_GUEST'
                                                         for t in node.targets))
    old_pin = "'1fc252c042a279787eb1a83a15c7e19d634fc0059ad8abf4acaa9a752f5684a2'"
    source = source.replace(old_pin, old_pin + ", 'ead561de4c1c9488463aad634677d8be63d2e7d162b6b1b8f476727af4dc0310'")
    source = source.replace('TARGET', repr(machine)).replace('NONCE', repr(nonce))
    need(hashlib.sha256(source.encode()).hexdigest() == intent.get('guest_code_sha256'),
         'stopped inert scanner identity')
    primary = result.get('primary_untouched')
    benches = json.loads(bound(fleet / '_batch/benches.json'))
    need(len(benches) == 1 and isinstance(primary, str) and primary != machine
         and intent.get('primary_untouched') == primary and row.get('source_machine_id') == primary,
         'stopped inert worker source')
    out = fleet / benches[0]['name']
    need(bound(out / '.cid') == ('clone ' + primary + '\n').encode()
         and bound(out / 'worker-clones.ids').decode().splitlines().count(machine) == 1
         and machine not in bound(out / 'worker-ready.ids').decode().splitlines()
         and not (out / 'worker-runtime-evidence' / machine).exists()
         and not list(out.glob('worker-' + machine + '*'))
         and not (out / 'worker-borrowed' / (machine + '.json')).exists(), 'stopped inert worker staged')
    registry, audit = fleet_ownership_root(root) / owner, fleet_audit_root(root) / owner
    need((registry / 'runtime-evidence-unconfirmed').is_file()
         and fields(bound(registry / 'clones' / row['clone_name']))
             == {'name': row['clone_name'], 'id': machine, 'volume_id': volume}, 'stopped inert custody released')
    need(not (root / '.git/cloudbench-pool-claims' / machine).exists()
         and not (registry / 'cold-handoff-outgoing').exists(), 'stopped inert reassigned')
    need(hashlib.sha256(bound(fleet / 'execution-provenance.json')).hexdigest() == custody.get('source'),
         'stopped inert source custody')
    for name, base in (('registry', registry), ('audit', audit), ('index', fleet / '.native-retirement-index')):
        saved = custody[name]
        need(set(saved) == {str(base), *(str(p) for p in base.rglob('*'))}, 'stopped inert custody inventory')
        for path, value in saved.items():
            path = Path(path); st = path.lstat()
            need(path.resolve() == path and not path.is_symlink(), 'stopped inert custody path')
            current = ['directory' if path.is_dir() else 'file', st.st_dev, st.st_ino, st.st_mode]
            if path.is_file(): current.append(hashlib.sha256(bound(path)).hexdigest())
            need(current == value, 'stopped inert custody drift')
    seal = custody['primary_seal']; runtime = out / 'remote-logs/runtime-evidence'
    manifest_raw = bound(runtime / 'manifest.json'); manifest = json.loads(manifest_raw)
    need(hashlib.sha256(manifest_raw).hexdigest() == seal.get('manifest_sha256')
         and manifest.get('machine_id') == primary and manifest.get('run_token') == token
         and set(manifest['files']) == set(seal['files']), 'stopped inert primary seal')
    total = 0
    for name, info in manifest['files'].items():
        need(Path(name).as_posix() == name and not Path(name).is_absolute() and '..' not in Path(name).parts,
             'stopped inert primary path')
        data = bound(runtime / name, MAX_RAW_RUN_PROOF_BYTES); total += len(data)
        digest = hashlib.sha256(data).hexdigest()
        need(total <= MAX_RAW_RUN_PROOF_BYTES and digest == seal['files'][name]
             and info == {'bytes': len(data), 'sha256': digest}, 'stopped inert primary file changed')
    need(total == seal['bytes'], 'stopped inert primary bytes')
    for observed in pair:
        native = json.loads(bound(observed['raw_response']))
        expected = final[observed['kind']]
        need(finite(observed.get('observed_at')) and intent['epoch'] <= observed['observed_at'] <= proof['confirmed_at'],
             'stopped inert current provider clock')
        need(native.get('id') == expected['id'] and native.get('state') == expected['state'],
             'stopped inert provider rebound')
        if observed['kind'] == 'machine':
            need(native.get('instance_id') == stopped['instance_id'] and native.get('config') == config
                 and native.get('image_ref') == stopped.get('image_ref'), 'stopped inert provider reused')
        else:
            need(native.get('attached_machine_id') == machine, 'stopped inert volume rebound')


def isolated_execution(fleet, life, root, receipt, proof, bound, document, tree, archived=None):
    """Execution admission only; quarantined archives, finances and resources remain owned."""
    owner = life['fleet_owner_token']
    audit = fleet_audit_root(root) / owner
    meta = fields(bound(audit / 'meta'))
    need(meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root), 'isolated audit identity')
    tree(audit)
    registry = fleet_ownership_root(root) / owner
    registry_present = registry.exists() if archived is None else str(registry / 'meta') in archived
    if registry_present:
        registered = fields(bound(registry / 'meta'))
        need(all(registered.get(k) == meta.get(k) for k in ('fleet_owner_token', 'run_id', 'workspace_root', 'app'))
             and registered.get('cleanup_policy') in {'reap', 'retain'}
             and any((registry / k).is_file() if archived is None else str(registry / k) in archived for k in
                     ('runtime-evidence-unconfirmed', 'guest-cleanup-unconfirmed', 'cold-handoff-outgoing')),
             'old resources must remain natively quarantined')
        tree(registry)
    else:
        need(meta.get('status') == 'provider-teardown-verified', 'unowned unreleased fleet')
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
    pid = int(fleet.name.rsplit('-', 1)[-1])
    collision = any(int(r.split()[0]) == pid or int(r.split()[1]) == pid
                    for r in processes.splitlines() if not r.split()[2].startswith('Z'))
    need(pid > 1, 'old controller identity')
    if collision and archived is not None:
        # Only authenticated original registry identity distinguishes a reused PID.
        identity = fields(bound(registry / 'meta'))
        need(identity.get('host') == os.uname().nodename and identity.get('pid') == str(pid),
             'archived controller host/PID identity')
        # A surviving group without its leader has no proven replacement identity.
        leader = Path('/proc', str(pid), 'stat')
        need(leader.is_file(), 'archived controller group identity unproven')
        retired_local_process(dict(pid=pid, birth=identity.get('pid_start')))
        leader_start = int(leader.read_text().rsplit(') ', 1)[1].split()[19])
        for row in processes.splitlines():
            member, group, status = row.split()
            if int(group) == pid and not status.startswith('Z'):
                start = int(Path('/proc', member, 'stat').read_text().rsplit(') ', 1)[1].split()[19])
                need(start >= leader_start, 'original controller group member remains')
    else:
        need(not collision, 'old controller still active')
    if archived is None:
        paths = list((audit / 'fresh').iterdir()) if (audit / 'fresh').exists() else []
    else:
        paths = [Path(p) for p in proof['files'] if Path(p).parent == audit / 'fresh']
    rows = [fields(bound(p)) for p in paths]
    need(len({r['machine_id'] for r in rows}) == len(rows), 'duplicate old machine')
    observations = proof['execution_quiescence']
    for row in rows:
        machine, token = row['machine_id'], owner + '-0'
        need(row.get('fleet_owner_token') == owner and row.get('run_id') == fleet.name
             and row.get('source') == 'fresh-clone' and row.get('app') == meta['app'], 'old resource custody')
        evidence = observations[machine]
        if evidence == {'sealed_native_release': True}:
            need(not registry_present and meta.get('status') == 'provider-teardown-verified'
                 and row.get('disposition') == 'destroyed-provider-retained', 'native release not sealed')
            local = fleet / 'teardown-ownership'
            seal = tree(local)
            need(tree(audit) == seal and fields(bound(local / 'source-audit'))
                 == {'path': str(audit), 'sha256': seal}, 'native release seal')
            release = float(bound(audit / 'provider-teardown-verified.epoch'))
            need(finite(release) and receipt['started_at'] <= release <= proof['confirmed_at'], 'native release clock')
        elif 'provider_pair' in evidence:
            packet = document(evidence['provider_pair'])
            need(packet.get('endpoint_origin') == 'https://api.machines.dev' and packet.get('app') == meta['app'],
                 'provider observation origin')
            pair = [r for r in packet['rows'] if r.get('expected_machine') == machine]
            need(len(pair) == 2 and {r['kind'] for r in pair} == {'machine', 'volume'}, 'provider pair closure')
            stopped_startup = next(r for r in pair if r['kind'] == 'machine')['metadata'].get('state') == 'stopped'
            if stopped_startup:
                need(registry_present and row.get('disposition') == 'owned', 'stopped startup custody must remain quarantined')
                if 'stopped_inert_allocation' in evidence:
                    need(set(evidence) == {'provider_pair', 'stopped_inert_allocation'}, 'stopped inert evidence fields')
                    stopped_inert_execution(fleet, root, receipt, proof, row, token, evidence, pair, bound, document)
                else:
                    stopped_pre_stack_execution(fleet, root, receipt, machine, token, evidence, bound, document)
            else:
                need('stopped_inert_allocation' not in evidence, 'stopped inert allocation is not stopped')
            for observed in pair:
                need(observed['method'] == 'GET' and observed['http_status'] == 200 and observed['no_retry'] is True
                     and observed['expected_volume'] == row['volume_id']
                     and re.fullmatch('[0-9a-f]{64}', observed['response_sha256']), 'provider response identity')
                value = observed['metadata']
                if stopped_startup:
                    raw = bound(Path(observed['raw_response']))
                    need(hashlib.sha256(raw).hexdigest() == observed['response_sha256'],
                         'stopped startup provider response hash')
                    native_value = json.loads(raw)
                    need(native_value['id'] == value['id'] and native_value['state'] == value['state'],
                         'stopped startup provider response state')
                    if observed['kind'] == 'machine':
                        env = native_value['config']['env']
                        need({key: env.get(key) for key in ('REF', 'CLOUDBENCH_RUN_TOKEN')} == value['source_binding']
                             and any(mount.get('volume') == row['volume_id'] and mount.get('path') == '/data'
                                     for mount in native_value['config']['mounts']),
                             'stopped startup provider source and mount')
                    else:
                        need(native_value['attached_machine_id'] == value['attached_machine_id'],
                             'stopped startup provider attachment')
                if observed['kind'] == 'machine':
                    need(observed['id'] == value['id'] == machine and value['state'] == ('stopped' if stopped_startup else 'destroyed')
                         and value['source_binding'] == {'REF': receipt['source']['head'], 'CLOUDBENCH_RUN_TOKEN': token},
                         'old execution not provider terminal')
                else:
                    need(observed['id'] == value['id'] == row['volume_id']
                         and (value['state'] == 'created' and value['attached_machine_id'] == machine if stopped_startup
                              else value['state'] in {'pending_destroy', 'destroyed'} and value['attached_machine_id'] is None),
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
        need(registry_present or row.get('disposition') == 'destroyed-provider-retained', 'resource not excluded')
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


def quarantine_bytes(archive, proof, root):
    """Authenticate original mutable audit/registry bytes against the admitted proof."""
    from deploy_test_cycle import MAX_RECEIPT_BYTES
    need(isinstance(archive, dict) and set(archive) == {'kind', 'receipt_sha256', 'files'}
         and archive['kind'] == 'original-quarantine-bytes-v1'
         and archive['receipt_sha256'] == proof['receipt_sha256']
         and isinstance(archive['files'], dict) and archive['files'], 'quarantine archive identity')
    runs = root / '.context/deploy-cloud' / hashlib.sha256(proof['request_token'].encode()).hexdigest() / 'runs'
    result, total = {}, 0
    for name, encoded in archive['files'].items():
        path = Path(name)
        local = path.is_relative_to(runs) and len(path.relative_to(runs).parts) >= 3 and path.relative_to(runs).parts[1] == 'teardown-ownership'
        need(name in proof['files'] and path.is_absolute() and path.resolve() == path
             and (local or any(path.is_relative_to(base) for base in (fleet_audit_root(root), fleet_ownership_root(root)))),
             'quarantine archive scope')
        need(isinstance(encoded, str) and len(encoded) <= 2 * MAX_RECEIPT_BYTES, 'quarantine archive size')
        raw = base64.b64decode(encoded, validate=True)
        total += len(raw)
        need(total <= MAX_RECEIPT_BYTES and hashlib.sha256(raw).hexdigest() == proof['files'][name],
             'quarantine archive bytes changed')
        result[name] = raw
    return result


def validate(receipt, owner, proof, *, quarantine_archive=None):
    """Validate bound native retirement evidence without granting execution credit."""
    from deploy_test_cycle import MAX_RECEIPT_BYTES, bounded_read, sha_file
    need(quarantine_archive is None or proof.get('purpose') == 'isolated-validation',
         'archive overlay requires historical isolated proof')
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
    archived = None if quarantine_archive is None else quarantine_bytes(quarantine_archive, proof, root)
    bindings, used = proof['files'], set()
    validated_sizes = {}
    run_artifacts = set()
    raw_remaining = [MAX_RAW_RUN_PROOF_BYTES]
    historical_sources = {}
    need(isinstance(bindings, dict), 'missing file bindings')

    def bound(path, limit=MAX_RECEIPT_BYTES, *, historical_head=None):
        """Read original bytes and require the original admitted SHA-256 binding."""
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
        elif archived is not None and str(path) in archived:
            raw = archived[str(path)]
            need(len(raw) <= limit, 'proof file too large')
        else:
            need(path.is_file(), 'noncanonical proof file')
            need(path.stat().st_size <= limit, 'proof file too large')
            raw = path.read_bytes()
        need(bindings.get(str(path)) == hashlib.sha256(raw).hexdigest(), 'file hash mismatch: ' + str(path))
        used.add(str(path))
        validated_sizes[str(path)] = len(raw)
        if historical_head is not None:
            historical_sources[str(path)] = historical_head
        return raw

    def document(path, limit=MAX_RECEIPT_BYTES):
        """Read a hash-bound object through the selected evidence custody path."""
        value = json.loads(bound(path, limit))
        need(isinstance(value, dict), 'expected object')
        return value

    def tree(path):
        """Hash a current audit tree or its authenticated original file inventory."""
        if archived is not None and any(Path(p).is_relative_to(path) for p in archived):
            digest = hashlib.sha256()
            for item in sorted((Path(p) for p in bindings if Path(p).is_relative_to(path)),
                               key=lambda p: str(p.relative_to(path))):
                if item.name != 'source-audit':
                    for value in (str(item.relative_to(path)).encode(), bound(item)):
                        digest.update(len(value).to_bytes(8, 'big'))
                        digest.update(value)
            return digest.hexdigest()
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
             and (reference.get('native_directory') == str(campaign) or staged_preallocation
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
            # A campaign-v1 parent whose controller refused at private fleet source validation
            # stopped before allocation; it is held to the same zero-resource admission checks.
            refusals = [x for x in lines if x.startswith(SOURCE_REFUSAL)]
            parents[one[0]] = {'checks': {job['task']}, 'exit': job['controller_exit_code'],
                               'source_refused': layout == 'campaign-v1' and job['status'] == 'failed'
                               and job['controller_exit_code'] == 1 and len(refusals) == 1}
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
    if layout == 'campaign-v1':
        admission_parents = admission_parents | frozenset(f for f, p in parents.items() if p.get('source_refused'))
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
        life = document(fleet / '_batch/lifecycle.json')
        failed_canary = (layout in {'campaign-v1', 'campaign-mixed-preallocation-v1'} and fleet not in parents
                         and life.get('status') == 'failed')
        run_path = fleet / '_batch/run.json'
        if isolated or preallocation or mixed or fleet in admission_parents or failed_canary:
            # These layouts consume the original projection. Bind its control
            # metadata through the bounded forensic reader; logs stay opaque.
            from deploy_test_run_artifact import read_run_artifact
            run = read_run_artifact(run_path, bindings.get(str(run_path)), MAX_RECEIPT_BYTES,
                                    raw_limit=min(RUN_RECORD_MAX_BYTES, MAX_RAW_FORENSIC_RUN_BYTES),
                                    raw_remaining=raw_remaining, raw_aggregate_limit=MAX_RAW_RUN_PROOF_BYTES)
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
        owner_token = life['fleet_owner_token']
        need(isinstance(owner_token, str) and re.fullmatch('[0-9a-f]{32}', owner_token), 'fleet owner')
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
            if not isolated:
                # Normal release of a failed probe still requires exact execution retirement.
                processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
                pid = int(fleet.name.rsplit('-', 1)[-1])
                need(pid > 1 and not any(int(r.split()[0]) == pid or int(r.split()[1]) == pid
                    for r in processes.splitlines() if not r.split()[2].startswith('Z')),
                    'failed canary controller still active')
                need(document(fleet / '_batch/disposable-cleanup.json').get('successful_runtime_inferred') is False,
                     'failed canary runtime inference is not evidence')
                if zero_allocation:
                    for bench in benches:
                        for name in ('cloudbench-run.json', '.cid', 'primary.ids', 'worker-clones.ids'):
                            artifact = fleet / bench['name'] / name
                            need(not artifact.exists() and not artifact.is_symlink(), 'failed canary zero-allocation artifact present')
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
            excluded.update(isolated_execution(fleet, life, root, receipt, proof, bound, document, tree, archived))
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
                # Rehash each exact file within the size already verified by its owning reader.
                bound(path, max(MAX_RECEIPT_BYTES, validated_sizes.get(path, 0)))
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


def historical_successor_gate(witness, successor, request, current_gate, root=None):
    """Authenticate old admission; current catalog omissions grant launch authority only."""
    from deploy_test_cycle import bounded_read, digest, sha_file, MAX_RECEIPT_BYTES
    from deploy_test_historical_custody import state_identity
    need(isinstance(witness, dict) and set(witness) ==
         {'kind', 'request_token', 'receipt_sha256', 'custody_state'}
         and witness['kind'] == 'historical-clean-successor-v1'
         and witness['request_token'] == successor['token']
         and witness['receipt_sha256'] == sha_file(Path(successor['log']).parent / 'receipt.json'),
         'historical successor witness identity')
    locator = witness['custody_state']
    need(isinstance(locator, dict) and set(locator) == {'path', 'sha256'}
         and isinstance(locator['path'], str), 'historical successor snapshot locator')
    path = Path(locator['path'])
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink()
         and path.is_file() and path.stat().st_size <= MAX_RECEIPT_BYTES
         and sha_file(path) == locator['sha256'], 'historical successor snapshot bytes')
    snapshot = bounded_read(path, 'historical successor admission')
    need(snapshot.get('plan_digest') == digest(snapshot.get('plan'))
         and state_identity(snapshot) == request.get('custody_state_sha256')
         and snapshot.get('source') == request['source'] == successor['source']
         and snapshot['plan'].get('source') == snapshot['source'], 'historical successor admission binding')
    candidates = [g for g in snapshot['plan']['gates'] if g.get('name') == current_gate['name']]
    need(len(candidates) == 1, 'historical successor gate identity')
    historical = candidates[0]
    old_checks, new_checks = historical.get('checks'), current_gate.get('checks')
    need(isinstance(old_checks, list) and isinstance(new_checks, list)
         and all(isinstance(k, str) for k in old_checks + new_checks)
         and len(set(old_checks)) == len(old_checks) and len(set(new_checks)) == len(new_checks),
         'historical successor check inventory')
    if old_checks != new_checks:
        from deploy_test_quarantine import deploy_selection_omissions
        need(root is not None, 'historical successor omission requires catalog')
        # Removals need catalog deploy omissions; later-selected cases only extend current
        # coverage. The successor is still validated against the returned historical gate.
        removed = deploy_selection_omissions(root, historical, current_gate)
        kept = [k for k in old_checks if k not in removed]
        need((removed or set(new_checks) - set(old_checks))
             and [k for k in new_checks if k in set(old_checks)] == kept,
             'historical successor ordered catalog subset')
    need(set(historical) == set(current_gate)
         and all(isinstance(g.get('selection_evidence'), list)
             and all(isinstance(reason, str) for reason in g['selection_evidence'])
             for g in (historical, current_gate))
         and digest({k: v for k, v in historical.items() if k not in {'selection_evidence', 'checks'}}) ==
             digest({k: v for k, v in current_gate.items() if k not in {'selection_evidence', 'checks'}}),
         'historical successor execution contract changed')
    need(successor.get('execution_binding') == {
        'contract_digest': digest(historical), 'environment': snapshot.get('environment'),
        'input_fingerprint': snapshot.get('input_fingerprints', {}).get(current_gate['name'])},
        'historical successor execution inputs changed')
    return historical


def historical_successor_runtime(root, admitted_gate, request, binding):
    """Bind old runtime hashes to the sealed native fingerprint, using Git's old file map."""
    from fnmatch import fnmatchcase
    from deploy_test_cycle import digest, native_inputs, source_files
    runtime = request.get('custody_runtime')
    allowed = {'.env', 'env.sh', 'back-end/.env', 'agents/.env', 'agents/.env.benchmark-temporal',
               'front-end/.env', 'front-end/.env.local'}
    need(isinstance(runtime, dict) and set(runtime) <= allowed
         and all(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) for value in runtime.values()),
         'historical successor runtime identity')
    _, files = native_inputs(root, request['source']['head'], source_files(root))
    # Same input object as input_fingerprints(); no environment bytes are read or
    # restored from history. A dirty historical source cannot pass this commit reconstruction.
    fingerprint = digest({'files': {p: value for p, value in files.items()
                           if any(fnmatchcase(p, glob) for glob in admitted_gate.get('input_paths', ['*']))},
        'runtime_config': runtime, 'command': admitted_gate['command'], 'env': admitted_gate.get('env', {}),
        'worker': admitted_gate.get('worker'), 'checks': admitted_gate['checks'],
        'environment': binding['environment']})
    need(fingerprint == binding['input_fingerprint'], 'historical successor runtime fingerprint')


def clean_isolated_successor(state, prior, original, successor, renewal_witness=None):
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
    folder = Path(successor['log']).parent
    request = bounded_read(folder / 'request.json', 'successor request')
    root = Path(prior['owner']['worker_root'])
    admitted_gate = (historical_successor_gate(renewal_witness, successor, request, gate, root)
                     if renewal_witness is not None else gate)
    binding = successor.get('execution_binding', {})
    need(bounded_read(folder / 'receipt.json', 'successor receipt') == successor, 'successor receipt changed')
    need(all(request.get(k) == successor.get(k) for k in ('token', 'source', 'gate'))
         and request.get('worker_recipe') == gate.get('worker_recipe'), 'successor request identity')
    checks, skips = request['checks'], request['skips']
    if renewal_witness is None and binding.get('contract_digest') != digest(gate):
        # Authenticate the complete historical gate, not current-case coverage. Only an
        # inventory extension can be reconstructed: every other byte and old ordering
        # must still hash to the immutable successor receipt's original contract.
        attempt = rows[0][0]
        need(attempt.get('source') == successor['source'] and not attempt.get('stale')
             and request.get('phase') == attempt['phase'], 'successor historical attempt')
        need(isinstance(checks, list) and checks and all(isinstance(v, str) for v in checks)
             and isinstance(skips, dict) and all(isinstance(v, str) for v in skips)
             and len(set(checks)) == len(checks) and not set(checks) & set(skips),
             'successor historical inventory shape')
        historical_checks = set(checks) | set(skips)
        need(set(original['cases']) <= historical_checks <= set(gate['checks']),
             'successor historical inventory must preserve original debt')
        admitted_gate = copy.deepcopy(gate)
        admitted_gate['checks'] = [name for name in gate['checks'] if name in historical_checks]
    need(binding.get('contract_digest') == digest(admitted_gate)
         and (renewal_witness is not None or binding.get('environment') == state['environment'])
         and isinstance(binding.get('input_fingerprint'), str) and binding['input_fingerprint'], 'successor contract')
    if renewal_witness is not None and (binding.get('environment') != state['environment']
                                        or admitted_gate['checks'] != gate['checks']):
        import deploy_test_historical_custody as h
        current_inputs = h.binding(state['plan'], root)
        need(current_inputs == {k: state.get(k) for k in current_inputs}, 'successor fresh admission inputs')
    need(isinstance(checks, list) and checks and isinstance(skips, dict)
         and all(isinstance(value, dict) for value in skips.values())
         and len(set(checks)) == len(checks) and not set(checks) & set(skips)
         and set(checks) | set(skips) == set(admitted_gate['checks'])
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
    custody = {k: v for k, v in skips.items() if v.get('disposition') == 'NO_RETRY_CUSTODY'}
    import deploy_test_historical_custody as h
    known = {row['check'].split('/', 1)[1] for row in h.known(state, root).values()
             if row['gate'] == gate['name']}
    if custody or known:
        import deploy_test_cycle as c
        # Discover authority from the canonical ledger, never an incoming skip label.
        legacy_current = c.reuse_qualifications(state, gate, root=root, include_custody=False)
        current = h.binding(state['plan'], root)
        need(current == {k: state.get(k) for k in current}, 'successor current custody inputs')
        qualified = h.guard(state, gate, root, legacy_current, current=current)
        need(set(qualified) == set(custody), 'successor current custody inventory')
    if custody:
        legacy = {k: v for k, v in skips.items() if k not in custody}
        bindings = [v.get('current_binding') for v in custody.values()]
        admitted = bindings[0]
        need(isinstance(admitted, dict) and set(admitted) == set(current)
             and all(v == admitted for v in bindings)
             and admitted['source'] == successor['source']
             and binding == dict(contract_digest=digest(admitted_gate), environment=admitted['environment'],
                                 input_fingerprint=admitted['input_fingerprints'].get(gate['name'])),
             'successor admitted custody inputs')
        # This is ONLY an identity-bearing projection, never a captured full snapshot.
        # The request's recorded state identity authenticates every reconstructed field.
        projection = {k: copy.deepcopy(state[k]) for k in
                      ('historical_custody_history', 'historical_custody_import',
                       'historical_custody_transfers', 'failures', 'pending_post_merge',
                       'resource_warnings', 'superseded_resource_warnings') if k in state}
        projection.update(copy.deepcopy(admitted))
        projection['historical_no_retry_custody'] = [
            {k: copy.deepcopy(v) for k, v in custody[r['original_failure']['check'].split('/', 1)[1]].items()
             if k != 'source'} if r['original_failure']['gate'] == gate['name'] else copy.deepcopy(r)
            for r in state.get('historical_no_retry_custody', [])]
        need(h.state_identity(projection) == request.get('custody_state_sha256'),
             'successor custody identity projection')
        historical = h.guard(projection, admitted_gate, root, legacy, current=admitted)
        need(historical == custody, 'successor admitted custody qualifications')
        # Original authority must be identical; both independently checked input bindings stay intact.
        def authority(values):
            return {k: {field: value for field, value in row.items() if field != 'current_binding'}
                    for k, row in c.qualification_identity(values).items()}
        runtime_bound = request.get('custody_runtime') == h.runtime_identity(root)
        if not runtime_bound:
            need(renewal_witness is not None, 'historical successor runtime witness required')
            historical_successor_runtime(root, admitted_gate, request, binding)
            runtime_bound = True
        need(authority(qualified) == authority(custody)
             and checks == [k for k in admitted_gate['checks'] if k not in skips]
             and runtime_bound
             and isinstance(request.get('custody_child_environment'), str)
             and re.fullmatch('[0-9a-f]{64}', request['custody_child_environment'])
             and digest(successor.get('custody_skips')) == digest(custody)
             and all(successor.get('case_complete', {}).get(k) is False for k in custody)
             and all(successor.get('case_complete', {}).get(k) is True for k in checks)
             and all(successor.get('current_execution', {}).get(k) == 'UNVERIFIED' for k in custody),
             'successor custody authority/runtime/projection')
    result_path = folder / 'result.json'
    need(successor.get('worker_result') == str(result_path), 'successor result locator')
    result = bounded_read(result_path, 'successor native result')
    cases, complete = validate_result(result, request, successor['native_exit'], invalid_process=False)
    need(complete and successor.get('cases') == {**dict.fromkeys(skips, 'SKIP'), **cases}
         and successor.get('case_complete') == {k: k not in custody for k in admitted_gate['checks']}
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
         # Mixed is the same full-cohort validator with zero-allocation members (infra stop).
         and normal.get('layout') in {'campaign-v1', 'campaign-mixed-preallocation-v1'}
         and key == normal.get('receipt_sha256')
         and key == sha_file(folder / 'receipt.json') and entry.get('credit_granted') is False,
         'strict normal successor reconciliation required')
    reconciliation_occurrence(state, entry, successor)
    # Re-run the unchanged normal validator: all native file hashes, audits, retained Hub custody,
    # provider release and publication closure are required even when this result is incomplete.
    need(still_bound(entry, successor, owner, state), 'strict normal successor proof changed')
    need(finite(original.get('finished_at')) and finite(successor.get('started_at'))
         and finite(successor.get('finished_at'))
         and original['finished_at'] <= successor['started_at'] <= successor['finished_at'],
         'failed successor clocks')


def recovered_isolated_successor_v1(state, prior, original, successor):
    """Committed negative recovery grants source renewal only, never outer execution credit."""
    import stat
    import deploy_test_cycle as c
    from deploy_test_historical_custody import state_identity
    from deploy_test_interrupted_cleanup import namespace_quiet
    from deploy_test_process import scan_same_user_processes

    seals = {}
    def sealed(path):
        path = Path(path)
        info = path.lstat()
        need(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode)
             and info.st_uid == os.getuid() and not info.st_mode & 0o022
             and info.st_size <= c.MAX_RECEIPT_BYTES, 'negative successor unsafe artifact')
        raw = path.read_bytes()
        seals[str(path)] = hashlib.sha256(raw).hexdigest()
        return raw

    def doc(path):
        value = json.loads(sealed(path))
        need(isinstance(value, dict), 'negative successor artifact object')
        return value

    rows = [(a, r) for a in state['attempts'] for r in a.get('results', [])
            if r.get('gate') == prior['gate'] and r.get('token') == successor.get('token')]
    need(len(rows) == 1 and rows[0][1] is successor and successor.get('token') != original['token'],
         'negative successor unique attempt')
    attempt = rows[0][0]
    round_number = attempt.get('round')
    need(type(round_number) is int and round_number > 0 and attempt.get('recovered') is True
         and attempt.get('positive_credit') is False and not attempt.get('interrupted')
         and not attempt.get('stale'), 'negative successor recovered attempt')
    folder = Path(successor['log']).parent
    directory = folder.parents[3]
    need(folder == directory / 'attempts' / str(round_number) / attempt['phase'] / prior['gate']
         and successor['log'] == str(folder / 'output.log'), 'negative successor round locator')
    journal_path = directory / f'settlement-round{round_number}-journal.json'
    journal = doc(journal_path)
    need(doc(directory / f'settlement-round{round_number}-committed.json') ==
         {'journal_sha256': seals[str(journal_path)]}
         and set(journal) == {'kind', 'round', 'positive_credit', 'proof_digest', 'original_state_hex',
                             'after_state', 'receipts'}
         and journal['kind'] == 'native-settlement-journal-v1' and journal['round'] == round_number
         and type(journal['round']) is int and journal['positive_credit'] is False,
         'negative successor committed typed journal')
    raw = bytes.fromhex(journal['original_state_hex'])
    snapshot = json.loads(raw)
    need(isinstance(snapshot, dict) and snapshot['round'] == round_number
         and snapshot['phase'] == attempt['phase'] and snapshot['phase'] in {'initial', 'focused', 'failed-gates', 'final'}
         and snapshot.get('ready') is False and 'live_failures' in snapshot
         and not snapshot.get('running') and not snapshot.get('resume_phase')
         and snapshot['source'] == snapshot['plan']['source'] == successor['source']
         and snapshot['plan_digest'] == c.digest(snapshot['plan']), 'negative successor original snapshot')
    after = journal['after_state']
    need(after['attempts'] == snapshot['attempts'] + [attempt]
         and state['attempts'][:len(after['attempts'])] == after['attempts']
         and attempt.get('source') == snapshot['source']
         and after['attempts'][-1] == attempt and after.get('ready') is False
         and journal['receipts'].get(str(folder / 'receipt.json')) == successor
         and doc(folder / 'receipt.json') == successor, 'negative successor journal projection')
    recovery = successor['recovery_evidence']
    need(isinstance(recovery, dict) and set(recovery) == {'files', 'native'}
         and isinstance(recovery['files'], dict) and recovery['files'], 'negative successor recovery binding')
    proof = dict(kind='interrupted-round-settlement-v1', source=snapshot['source'], round=round_number,
        phase=snapshot['phase'], state_sha256=hashlib.sha256(raw).hexdigest(), plan_digest=snapshot['plan_digest'],
        files=recovery['files'], native={r['gate']: r['recovery_evidence']['native']
            for r in journal['receipts'].values()})
    need(c.digest(proof) == journal['proof_digest'], 'negative successor reviewed recovery proof')
    for path, expected in recovery['files'].items():
        need(hashlib.sha256(sealed(path)).hexdigest() == expected, 'negative successor original file changed')
    request_path, result_path = folder / 'request.json', folder / 'result.json'
    need(all(str(p) in recovery['files'] for p in (request_path, result_path)),
         'negative successor request/result seals')
    request, result = doc(request_path), doc(result_path)
    historical, = [g for g in snapshot['plan']['gates'] if g['name'] == prior['gate']]
    checks, skips = request['checks'], request['skips']
    need(historical.get('native_cloud') is True and historical['command'] == successor['command']
         and request.get('worker_recipe') == historical.get('worker_recipe')
         and successor['execution_binding'] == dict(contract_digest=c.digest(historical),
             environment=snapshot['environment'], input_fingerprint=snapshot['input_fingerprints'][prior['gate']])
         and all(request.get(k) == successor.get(k) == result.get(k) for k in ('gate', 'source', 'token'))
         and request.get('phase') == snapshot['phase']
         and request.get('custody_state') == str(directory / 'cycle.json')
         and request.get('custody_state_sha256') == state_identity(snapshot),
         'negative successor historical admission inputs')
    need(isinstance(checks, list) and checks and len(set(checks)) == len(checks)
         and isinstance(skips, dict) and not set(checks) & set(skips)
         and set(checks) | set(skips) == set(historical['checks'])
         and all(isinstance(v, dict) and v.get('source') == successor['source'] for v in skips.values())
         and result.get('complete') is True and set(result['cases']) == set(checks)
         and all(v in {'PASS', 'FAIL'} for v in result['cases'].values())
         and result.get('cleanup_complete') is True and not result.get('cleanup_owner')
         and result.get('reused', False) is False, 'negative successor full inventory/cleanup')
    need(successor.get('kind') == 'recovered-native-execution-v1' and successor.get('executed') is True
         and successor.get('status') == 'FAIL' and successor.get('complete') is False
         and successor.get('positive_credit') is False and successor.get('lingering_group') is False
         and all(successor.get(k) is None for k in ('native_exit', 'timed_out', 'cancelled', 'started_at', 'finished_at'))
         and successor.get('original_coordinator') == dict(timed_out='UNVERIFIED', cancelled='UNVERIFIED',
             native_exit='UNVERIFIED', finished_at='UNVERIFIED')
         and successor.get('cases') == {k: 'SKIP' if k in skips else 'UNVERIFIED' for k in historical['checks']}
         and successor.get('case_complete') == dict.fromkeys(historical['checks'], False)
         and successor.get('current_execution') == dict.fromkeys(skips, 'UNVERIFIED')
         and successor.get('custody_skips') == {k:v for k,v in skips.items() if v.get('disposition') == 'NO_RETRY_CUSTODY'}
         and successor.get('worker_result') == str(result_path)
         and c.receipt_owner(prior['gate'], successor) is None, 'negative successor no execution credit')
    root = Path(prior['owner']['worker_root'])
    native_root = root / '.context/deploy-cloud' / hashlib.sha256(successor['token'].encode()).hexdigest()
    expected = dict(original_receipt_sha256=prior['proof']['receipt_sha256'], original_request_token=prior['token'],
        new_request_token=successor['token'], source=successor['source'], new_native_root=str(native_root),
        excluded_resources=prior['excluded_resources'], credit_granted=False)
    admissions = request.get('isolated_validation')
    need(isinstance(admissions, list) and all(isinstance(v, dict) for v in admissions)
         and [v for v in admissions if v.get('original_request_token') == prior['token']] == [expected],
         'negative successor original isolation binding')
    need(finite(original.get('finished_at')) and finite(result.get('started_at'))
         and finite(result.get('finished_at'))
         and original['finished_at'] <= result['started_at'] <= result['finished_at'], 'negative successor native clocks')
    def inspect_owner(process):
        environment = (process / 'environ').read_bytes().split(b'\0')
        need(not any(item in environment for item in (
            os.fsencode('DEPLOY_GATE_TOKEN=' + successor['token']),
            os.fsencode('DEPLOY_GATE_REQUEST=' + str(request_path)),
            os.fsencode('DEPLOY_GATE_RESULT=' + str(result_path)))), 'negative successor live adapter')
    scan_same_user_processes(inspect_owner,
        lambda pid: need(False, 'negative successor owner unknown: ' + str(pid)))
    namespace_quiet(folder.parent, set())
    need(c.settlement_native(request, result, root) == recovery['native'], 'negative successor current native closure')
    for path, expected in list(seals.items()):
        need(hashlib.sha256(sealed(path)).hexdigest() == expected, 'negative successor changed during validation')


def refusal_inventory(state, prior, attempt, latest, gate):
    """Authenticate an untyped pre-dispatch refusal by its own sealed request.

    run_phase writes request.json before isolated_request raises, so exactly one request-only
    namespace of this gate/phase/source exists whose token no recorded row carries. Its full
    inventory must equal the refusal's cases; the current gate may only have extended it.
    """
    from deploy_test_cycle import bounded_read
    cases = latest.get('cases')
    if (not isinstance(cases, dict) or not cases or set(cases.values()) != {'UNVERIFIED'}
            or not set(cases) <= set(gate['checks'])):
        return False
    attempts_root = Path(prior['owner']['native_cleanup_reference']['result']).parents[3]
    known = {r.get('token') for a in state.get('attempts', []) for r in a.get('results', [])}
    matches = []
    for path in attempts_root.glob(f"*/{attempt.get('phase')}/{gate['name']}/request.json"):
        folder = path.parent
        if (path.is_symlink() or folder.is_symlink() or not path.is_file()
                or {p.name for p in folder.iterdir()} != {'request.json'}):
            continue
        request = bounded_read(path, 'refusal request')
        if (request.get('gate') == gate['name'] and request.get('phase') == attempt.get('phase')
                and request.get('source') == latest.get('source') == attempt.get('source')
                and isinstance(request.get('token'), str) and request['token'] not in known):
            matches.append(request)
    if len(matches) != 1:
        return False
    request = matches[0]
    return (isinstance(request.get('checks'), list) and isinstance(request.get('skips'), dict)
            and len(set(request['checks'])) == len(request['checks'])
            and set(request['checks']) | set(request['skips']) == set(cases))


def stale_successor_released(state, prior, row):
    """An executed stale row whose exact owner has a strict normal no-credit reconciliation."""
    token = row.get('token')
    entries = [e for e in state.get('reconciled_owners', {}).values() if e.get('token') == token]
    return (isinstance(token, str) and token != prior['token'] and row.get('executed') is True
            and row.get('complete') is False and len(entries) == 1
            and entries[0].get('kind') == KIND and entries[0].get('gate') == prior['gate']
            and entries[0].get('purpose') is None and entries[0].get('credit_granted') is False)


def isolated_successor(state, prior, renewal_witness=None):
    """A known pre-dispatch source refusal is not a newer native execution.

    Keep that failed attempt as the latest coverage result. Only renewal may
    inspect its immediate native predecessor, whose full validation is unchanged.
    These exact six-field rows are emitted by run_phase for pre-dispatch
    exceptions. The early custody refusal also requires an absent gate namespace
    and authenticated sibling receipts; neither path creates execution credit.
    """
    rows = [(attempt, row) for attempt in state.get('attempts', [])
            for row in attempt.get('results', []) if row.get('gate') == prior['gate']]
    # A stale attempt (source changed mid-run) is superseded and never earns credit. Once its
    # exact native owner is released by a normal no-credit reconciliation, renewal looks past it.
    while rows and rows[-1][0].get('stale') is True and stale_successor_released(state, prior, rows[-1][1]):
        rows.pop()
    if not rows:
        return None
    attempt, latest = rows[-1]
    if (set(latest) == {'gate', 'status', 'complete', 'cases', 'source', 'reason'}
            and latest.get('reason') == 'historical custody: current source not frozen'):
        from deploy_test_cycle import bounded_read, receipt_owner, validate_result
        need(set(attempt) == {'phase', 'stale', 'results'} and attempt['stale'] is True
             and attempt['phase'] in {'initial', 'focused', 'failed-gates', 'final'}
             and latest['status'] == 'FAIL' and latest['complete'] is False and len(rows) >= 2,
             'custody source refusal identity')
        previous = rows[-2][1]
        need(previous.get('executed') is True and previous.get('complete') is True,
             'custody source refusal requires immediate complete native predecessor')
        gate = next(g for g in state['plan']['gates'] if g['name'] == prior['gate'])
        root = Path(prior['owner']['worker_root'])
        request = bounded_read(Path(previous['log']).parent / 'request.json', 'refusal predecessor request')
        admitted = historical_successor_gate(renewal_witness, previous, request, gate, root)
        authorities = [prior, *state.get('reconciled_owner_history', [])]
        need(latest['cases'] == dict.fromkeys(admitted['checks'], 'UNVERIFIED')
             and any(e.get('token') == prior['token'] and e.get('proof', {}).get('receipt_sha256') == prior['proof']['receipt_sha256']
                     and e.get('validation_source') == latest['source'] for e in authorities),
             'custody source refusal inventory/source')
        # The exception precedes UUID/folder creation. Authenticate the enclosing
        # attempt from its retained sibling request/receipt, then require absence
        # of this gate's namespace. A token-bearing or partial native row never enters here.
        peers = [r for r in attempt['results'] if r is not latest]
        need(peers and len({r.get('gate') for r in attempt['results']}) == len(attempt['results']),
             'custody source refusal enclosing attempt')
        phase_folders = set()
        for peer in peers:
            folder = Path(peer.get('log', '')).parent
            need(folder.is_absolute() and folder.resolve() == folder and root / '.context' in folder.parents
                 and folder.name == peer.get('gate') and folder.parent.name == attempt['phase']
                 and folder.parent.parent.name.isdigit() and folder.parent.parent.parent.name == 'attempts'
                 and peer.get('source') == latest['source'] and isinstance(peer.get('token'), str) and re.fullmatch('[0-9a-f]{32}', peer['token'])
                 and peer.get('executed') is True and peer.get('complete') is True
                 and type(peer.get('native_exit')) is int and peer['native_exit'] in (0, 1)
                 and peer.get('cancelled') is False and peer.get('timed_out') is False
                 and peer.get('lingering_group') is False and not peer.get('cleanup_owner')
                 and receipt_owner(peer['gate'], peer) is None
                 and finite(peer.get('started_at')) and finite(peer.get('finished_at'))
                 and peer['started_at'] <= peer['finished_at']
                 and bounded_read(folder / 'receipt.json', 'refusal sibling receipt') == peer,
                 'custody source refusal sibling identity')
            peer_request = bounded_read(folder / 'request.json', 'refusal sibling request')
            need(peer_request.get('phase') == attempt['phase']
                 and all(peer_request.get(k) == peer.get(k) for k in ('token', 'source', 'gate')),
                 'custody source refusal sibling request')
            result_path = folder / 'result.json'
            need(peer.get('worker_result') == str(result_path), 'custody source refusal sibling result locator')
            result = bounded_read(result_path, 'refusal sibling result')
            cases, complete = validate_result(result, peer_request, peer['native_exit'], invalid_process=False)
            need(complete and not result.get('cleanup_owner')
                 and peer.get('cases') == {**dict.fromkeys(peer_request.get('skips', {}), 'SKIP'), **cases}
                 and peer.get('case_complete') == dict.fromkeys(peer['cases'], True)
                 and peer.get('status') == ('PASS' if all(v == 'PASS' for v in cases.values()) else 'FAIL'),
                 'custody source refusal sibling terminal result')
            phase_folders.add(folder.parent)
        need(len(phase_folders) == 1, 'custody source refusal attempt namespace')
        absent = phase_folders.pop() / prior['gate']
        need(not absent.exists() and not absent.is_symlink(), 'custody source refusal has request namespace')
        return previous
    if (set(latest) == {'gate', 'status', 'complete', 'cases', 'source', 'reason'}
            and latest.get('reason') == 'native cleanup: next source/inventory binding'):
        if latest.get('source') == LEGACY_ISOLATED_REFUSAL['source']:
            return isolated_refusal_successor(state, prior, latest)  # pinned historical capture
        gate = next(g for g in state['plan']['gates'] if g['name'] == prior['gate'])
        need(latest['status'] == 'FAIL' and latest['complete'] is False
             and refusal_inventory(state, prior, attempt, latest, gate)
             and isinstance(latest['source'], dict) and set(latest['source']) == {'head', 'digest'}
             and isinstance(latest['source']['head'], str)
             and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', latest['source']['head'])
             and isinstance(latest['source']['digest'], str)
             and re.fullmatch(r'[0-9a-f]{64}', latest['source']['digest'])
             and latest['source'] == attempt.get('source')
             and (attempt.get('phase') in {'initial', 'focused', 'failed-gates', 'final'}
                  or attempt.get('phase') == 'triage' and attempt.get('independent_full') is True)
             and not attempt.get('interrupted') and not attempt.get('stale')
             and len(rows) >= 2, 'unexecuted source refusal identity')
        # Never skip an unknown refusal, an unknown setup failure or a native attempt. The one
        # known earlier refusal (pre-dispatch custody source refusal) is resolved by its own fully
        # authenticated branch on the history before this attempt; it needs its own native predecessor.
        previous = rows[-2][1]
        if previous.get('token') == prior['token']:
            return previous
        if (set(previous) == {'gate', 'status', 'complete', 'cases', 'source', 'reason'}
                and previous.get('reason') == 'historical custody: current source not frozen'):
            index = next(i for i, a in enumerate(state['attempts']) if a is attempt)
            return isolated_successor({**state, 'attempts': state['attempts'][:index]}, prior, renewal_witness)
        need(previous.get('executed') is True and previous.get('complete') is True,
             'source refusal requires immediate complete native predecessor')
        return previous
    return latest


# The historical coordinator recorded this exception before opening output or
# calling run_command. Authenticate its immutable producer and exact request;
# missing output by itself never establishes an unexecuted operation.
LEGACY_ISOLATED_REFUSAL = {
    'source': {'head': 'e979f73b8930bedb3dd5d3dba1518520e2931d8d',
               'digest': '9febe7d354fb883b518af2f9ce74778220088dd43816fdc748418b645ee19847'},
    'token': '1958fbf77dd84099b9fb21a6259fca71',
    'request_sha256': 'fa2938ec9282fc49a0a91f3f30aa763858ad250cd24023711397d6404b6f95b3',
    'relative_request': '.context/deploy-pipeline/attempts/13/focused/smoke/request.json',
    'phase': 'focused',
}
ISOLATED_REFUSAL_PRODUCERS = {
    'scripts/deploy_test_cycle.py': 'b1d74544dce3577ac87babea109b7e4e022da453e6a7309911bb3bbc8c396f19',
    'scripts/deploy_test_native_cleanup.py': '45fe68918105a0bb05b315fba73e1f1ababc734898b654099463a0bb12248759',
}
ISOLATED_REFUSAL_KIND = 'isolated-native-pre-command-refusal-v1'
ISOLATED_REFUSAL_REASON = 'native cleanup: next source/inventory binding'


def isolated_refusal_successor(state, prior, latest):
    """A proved pre-command refusal adds no native operation to renew or retire."""
    from deploy_test_cycle import bounded_read, sha_file
    rows = [(a, r) for a in state['attempts'] for r in a.get('results', [])
            if r.get('gate') == prior['gate']]
    need(latest.get('pre_command_refusal') is None or isinstance(latest['pre_command_refusal'], dict),
         'malformed pre-command refusal witness')
    if ((latest.get('pre_command_refusal') or {}).get('kind') != ISOLATED_REFUSAL_KIND
            and latest.get('reason') != ISOLATED_REFUSAL_REASON):
        return latest  # Unknown or executed debt follows the original strict path.
    need(len(rows) >= 2 and rows[-1][1] is latest, 'refusal latest identity')
    attempt, row = rows[-1]
    root = Path(prior['owner']['worker_root'])
    gate = next(g for g in state['plan']['gates'] if g['name'] == prior['gate'])
    witness = row.get('pre_command_refusal')
    if witness is None:
        capture = LEGACY_ISOLATED_REFUSAL
        request_path = root / capture['relative_request']
        need(row == dict(gate=prior['gate'], status='FAIL', complete=False,
                         cases=dict.fromkeys(gate['checks'], 'UNVERIFIED'),
                         source=capture['source'], reason=ISOLATED_REFUSAL_REASON),
             'legacy pre-command refusal shape')
        need(attempt.get('source') == capture['source'] and attempt.get('phase') == capture['phase']
             and not attempt.get('stale') and not attempt.get('interrupted'), 'legacy refusal attempt')
        for relative, expected in ISOLATED_REFUSAL_PRODUCERS.items():
            raw = subprocess.check_output(['git', '-C', str(root), 'show',
                capture['source']['head'] + ':' + relative], timeout=30)
            need(hashlib.sha256(raw).hexdigest() == expected, 'legacy refusal producer')
        need(sha_file(request_path) == capture['request_sha256'], 'legacy refusal request hash')
        token = capture['token']
        allowed = {'request.json'}
    else:
        need(isinstance(witness, dict) and set(witness) == {'kind', 'request', 'request_sha256',
             'stage', 'command_started'} and witness.get('stage') == 'isolated_request'
             and witness.get('command_started') is False, 'typed refusal witness')
        request_path = Path(witness['request'])
        need(request_path.is_relative_to(root / '.context') and request_path.name == 'request.json'
             and request_path.parent.name == prior['gate'] and request_path.parent.parent.name == attempt.get('phase')
             and request_path.parent.parent.parent.name.isdigit()
             and request_path.parent.parent.parent.parent.name == 'attempts', 'typed refusal locator')
        need(sha_file(request_path) == witness['request_sha256']
             and bounded_read(request_path.parent / 'receipt.json', 'pre-command receipt') == row,
             'typed refusal sealed request/receipt')
        token = row.get('token')
        need(row == dict(gate=prior['gate'], status='FAIL', complete=False,
                         cases=dict.fromkeys(gate['checks'], 'UNVERIFIED'), source=attempt.get('source'),
                         reason=ISOLATED_REFUSAL_REASON, token=token, executed=False, native_exit=None,
                         pre_command_refusal=witness), 'typed pre-command refusal shape')
        allowed = {'request.json', 'receipt.json'}
    need(request_path.resolve() == request_path and not request_path.is_symlink()
         and {p.name for p in request_path.parent.iterdir()} == allowed
         and all(p.is_file() and not p.is_symlink() for p in request_path.parent.iterdir()),
         'refusal request-only namespace')
    request = bounded_read(request_path, 'pre-command request')
    need(isinstance(token, str) and re.fullmatch('[0-9a-f]{32}', token)
         and request.get('token') == token and request.get('gate') == prior['gate']
         and request.get('source') == row['source'] == attempt.get('source')
         and request.get('phase') == attempt.get('phase')
         and attempt.get('phase') in {'focused', 'failed-gates', 'initial', 'final', 'triage'}
         and not attempt.get('stale') and not attempt.get('interrupted'), 'refusal request identity')
    checks, skips = request.get('checks'), request.get('skips')
    need(isinstance(checks, list) and all(isinstance(v, str) for v in checks)
         and isinstance(skips, dict) and not set(checks) & set(skips)
         and len(checks) == len(set(checks)) and set(checks) | set(skips) == set(gate['checks'])
         and len(set(gate['checks'])) == len(gate['checks'])
         and request.get('worker_recipe') == gate.get('worker_recipe'), 'refusal full inventory')
    native_root = root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest()
    need(not native_root.exists() and not native_root.is_symlink(), 'refusal native root exists')
    # Never skip a second unknown/refused row or an admitted incomplete operation.
    successor = rows[-2][1]
    need(successor.get('executed') is True, 'refusal preceding executed successor required')
    return successor


def renew_isolated_validation(state, request_token, proof, renewal_witness=None):
    """Renew only the next source of an already verified original operation."""
    from deploy_test_cycle import CANCEL, receipt_owner, source
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
    latest = isolated_successor(state, prior, renewal_witness)
    if latest is not None and latest != receipt:
        latest = isolated_refusal_successor(state, prior, latest)
    if latest != receipt:
        if latest is not None and latest.get('complete') is False:
            need(renewal_witness is None, 'historical witness requires complete successor')
            if latest.get('kind') == 'recovered-native-execution-v1':
                recovered_isolated_successor_v1(state, prior, receipt, latest)
            else:
                reconciled_failed_isolated_successor_v1(state, prior, receipt, latest)
        else:
            clean_isolated_successor(state, prior, receipt, latest, renewal_witness)
    else:
        need(renewal_witness is None, 'historical witness requires successor')
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
        if renewal_witness is not None:
            state.setdefault('native_successor_renewals', []).append({
                'original_request_token': request_token, 'validation_source': copy.deepcopy(state['source']),
                'witness': copy.deepcopy(renewal_witness)})


def retired_isolation_origin(state, entry):
    """Keep the complete isolated evidence binding after a separate normal retirement."""
    from deploy_test_cycle import digest
    seal = entry.get('retired_isolation_sha256')
    need(isinstance(seal, str) and re.fullmatch(r'[0-9a-f]{64}', seal), 'retired isolation seal')
    origins = [row for row in state.get('reconciled_owner_history', []) if digest(row) == seal]
    need(len(origins) == 1, 'one archived isolated origin required')
    prior = origins[0]
    need(prior.get('kind') == KIND and prior.get('purpose') == 'isolated-validation'
         and 'retired_isolation_sha256' not in prior
         and all(prior.get(k) == entry.get(k) for k in ('gate', 'token', 'owner', 'occurrence'))
         and prior['proof']['receipt_sha256'] == entry['proof']['receipt_sha256'],
         'archived isolated origin identity')
    return prior


def retire_known_isolation(state, occurrence_id, proof, key, prior):
    """Admit strict normal cleanup for a known original without rewriting its result."""
    from deploy_test_cycle import CANCEL, digest, receipt_owner, source
    need(state.get('phase') in ISOLATED_RENEWAL_PHASES and state.get('ready') is False
         and not state.get('running') and 'live_failures' not in state and not CANCEL.is_set(),
         'quiescent repair boundary required')
    need([k for k, e in state.get('reconciled_owners', {}).items()
          if e.get('token') == prior['token']] == [key], 'token already reconciled elsewhere')
    need(not any(k in proof for k in ('purpose', 'validation_source', 'execution_quiescence', 'excluded_resources'))
         and proof.get('layout') == 'campaign-v1' and key == proof.get('receipt_sha256')
         and occurrence_id in {prior['token'], prior.get('occurrence')}, 'original retirement identity')
    need(any(g.get('name') == prior['gate'] and g.get('native_cloud') is True for g in state['plan']['gates']),
         'native_cloud gate required')
    receipts = [row for attempt in state.get('attempts', []) for row in attempt.get('results', [])
                if row.get('gate') == prior['gate'] and row.get('token') == prior['token']]
    need(len(receipts) == 1, 'original receipt identity')
    receipt = receipts[0]
    owner = receipt_owner(prior['gate'], receipt)
    need(state['source'] == state['plan'].get('source') == source(Path(owner['worker_root'])),
         'current source binding')
    reconciliation_occurrence(state, prior, receipt)
    need(still_bound(prior, receipt, owner, state, quarantine_archive=proof.get('quarantine_archive')),
         'prior native proof changed')
    entry = validate(receipt, owner, proof)
    entry['occurrence'] = prior['occurrence']
    if 'retired_isolation_sha256' in prior:
        need(proof == prior['proof'], 'normal retirement replay changed')
        entry['retired_isolation_sha256'] = prior['retired_isolation_sha256']
        need(entry == prior, 'normal retirement replay changed')
        return
    need(prior.get('purpose') == 'isolated-validation', 'isolated origin required')
    seal = digest(prior)
    need(not any(digest(row) == seal for row in state.get('reconciled_owner_history', [])),
         'isolated origin already archived')
    entry['retired_isolation_sha256'] = seal
    # Publish only after every original and normal guard has passed.
    state.setdefault('reconciled_owner_history', []).append(copy.deepcopy(prior))
    state['reconciled_owners'][key] = entry


def reconcile(state, occurrence_id, proof, renewal_witness=None):
    """Record verified retirement while preserving the original native result and credit."""
    from deploy_test_cycle import CANCEL, latest_receipts, receipt_owner, interrupted_receipt
    try:
        failure = next((f for f in state['failures'] if f['id'] == occurrence_id), None)
        existing = [entry for entry in state.get('reconciled_owners', {}).values()
                    if entry.get('kind') == KIND and entry.get('purpose') == 'isolated-validation'
                    and entry.get('token') == proof.get('request_token')]
        known = [(key, entry) for key, entry in state.get('reconciled_owners', {}).items()
                 if entry.get('kind') == KIND and entry.get('token') == proof.get('request_token')
                 and (entry.get('purpose') == 'isolated-validation' or 'retired_isolation_sha256' in entry)]
        if proof.get('purpose') is None and known:
            need(renewal_witness is None and len(known) == 1, 'one original retirement required')
            return retire_known_isolation(state, occurrence_id, proof, *known[0])
        if proof.get('purpose') == 'isolated-validation' and existing:
            need(len(existing) == 1, 'one prior reconciliation required')
            prior = existing[0]
            need(occurrence_id in {prior['token'], prior.get('occurrence')}, 'original renewal selector')
            if (occurrence_id == prior['token'] or proof != prior.get('proof')
                    or renewal_witness is not None):
                return renew_isolated_validation(state, prior['token'], proof, renewal_witness)
        if (failure is None and state.get('phase') in ISOLATED_RENEWAL_PHASES
                and proof.get('purpose') == 'isolated-validation'):
            return renew_isolated_validation(state, occurrence_id, proof, renewal_witness)
        need(renewal_witness is None, 'historical witness requires isolated source renewal')
        if failure is None and state.get('phase') == 'stale':
            # A source refresh can finish a full attempt before its failures are
            # promoted to triage. Its retained owner still requires exact proof.
            need(not state.get('running') and 'live_failures' not in state and not CANCEL.is_set()
                 and state.get('attempts') and state['attempts'][-1].get('stale') is True
                 and proof.get('layout') in {'campaign-startup-v1', 'campaign-prelaunch-v1',
                                             'campaign-mixed-preallocation-v1'}, 'quiescent stale startup required')
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


def still_bound(entry, receipt, owner, state=None, *, quarantine_archive=None):
    """Revalidate original quarantine custody and independent current retirement proof."""
    try:
        if 'retired_isolation_sha256' in entry:
            need(state is not None, 'retired isolation custody state required')
            origin = retired_isolation_origin(state, entry)
            reconciliation_occurrence(state, origin, receipt)
            need(still_bound(origin, receipt, owner, quarantine_archive=entry['proof'].get('quarantine_archive')),
                 'archived isolated proof changed')
        actual = validate(receipt, owner, entry['proof'], quarantine_archive=quarantine_archive
                          if entry.get('purpose') == 'isolated-validation' else None)
        return actual == {k: v for k, v in entry.items()
                          if k not in {'occurrence', 'retired_isolation_sha256'}}
    except (OSError, ValueError, KeyError, TypeError):
        return False
