"""Launch custody for a cancelled, unfinalized campaign with one fresh N2 probe.

The recovery projection is new evidence. It never replaces a producer result,
summary or lifecycle, and is published only through the native Hub uploader.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import signal
import stat
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone

from deploy_test_interrupted_cleanup import Evidence, finite, groups_absent, namespace_quiet, no_holders, need
from deploy_test_native_cleanup import fleet_audit_root, fleet_ownership_root, retired_local_process

KIND = 'interrupted-fresh-campaign-custody-v1'
RECORD = 'interrupted-fresh-campaign-recovery-v1'
POLICIES = ('scripts/run-bench-campaign.py', 'scripts/cloudbench-shared-relay.py',
            'scripts/cloudbench-campaign-inventory.sh', 'agents/benchmarks/hub_upload.py',
            'scripts/cloudbench_execution_provenance.py', 'scripts/cloudbench-campaign-seed.py',
            'scripts/cloudbench-port-lease.py')
FIELDS = {'kind', 'root', 'files', 'confirmed_at', 'observed_by', 'recovery_directory'}


def absent(path):
    return not path.exists() and not path.is_symlink()


def capture_files(receipt, proof, *, controls_pending=False):
    """Seal explicit owned namespaces once; never silently rebind an old file."""
    root = Path(proof['root'])
    base = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    runs = base / 'runs'
    scopes = [base, Path(receipt['log']).parent]
    for fleet in runs.iterdir():
        if fleet.name != '_hub':
            audit = Path((fleet / 'teardown-ownership.path').read_text().strip())
            need(audit.parent == fleet_audit_root(root), 'foreign audit scope')
            scopes.append(audit)
    location = json.loads(next((base / 'campaigns').glob('*/shared-relay-location.json')).read_text())['directory']
    need(re.fullmatch(r'/tmp/cb-relay-[A-Za-z0-9_]{8}', location), 'foreign relay scope')
    scopes.append(Path(location))
    recovery = Path(proof['recovery_directory'])
    if recovery.exists():
        scopes.append(recovery)
    paths = [root / name for name in POLICIES]
    paths += [root / 'scripts' / name for name in ('cloudbench-prestart-recovery.py',
              'deploy_test_interrupted_fresh_cleanup.py', 'deploy_test_interrupted_cleanup.py', 'deploy_test_native_cleanup.py')]
    retirement = recovery / 'control-retirement.json'
    if retirement.exists():
        record = json.loads(retirement.read_text())
        paths.append(Path(record['manifest']))
        paths += [Path(r['copy']) for r in record['targets'] if 'copy' in r]
    for scope in scopes:
        need(scope.is_dir() and scope.resolve() == scope and not scope.is_symlink(), 'unsafe seal scope')
        for path in scope.rglob('*'):
            if path.is_symlink():
                expected = base / 'campaigns' / ('deploy-' + base.name) / 'shared-inventory/inventory/current'
                need(path == expected and re.fullmatch(r'\.generation-[A-Za-z0-9._-]+', os.readlink(path))
                     and path.resolve().is_dir() and path.resolve().parent == path.parent,
                     'linked evidence cannot be sealed')
                continue
            if controls_pending and path in {Path(location) / 'control.sock',
                    base / 'campaigns' / ('deploy-' + base.name) / 'shared-inventory/inventory-refresh.wait'}:
                continue
            need(path.is_file() or path.is_dir(), 'special evidence cannot be sealed')
            if path.is_file():
                paths.append(path)
    old = proof.get('files', {})
    sealed = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    need(all(sealed.get(p) == sha for p, sha in old.items()), 'previous evidence changed; refuse reseal')
    return sealed


def policies(root, receipt, evidence):
    for name in POLICIES:
        raw = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root),
                                       'show', receipt['source']['head'] + ':' + name])
        need(evidence.raw(root / name) == raw, 'original policy changed: ' + name)
    # Pin the new consumer and its dependencies separately from the old execution.
    for name in ('cloudbench-prestart-recovery.py', 'deploy_test_interrupted_fresh_cleanup.py',
                 'deploy_test_interrupted_cleanup.py', 'deploy_test_native_cleanup.py'):
        evidence.raw(root / 'scripts' / name)


def membership(root, runs, campaign, summary, receipt, evidence, waits):
    """Derive every parent and nested participant from original controller logs."""
    jobs = summary['jobs']
    need(len(jobs) == 13 and len({j['job_id'] for j in jobs}) == 13
         and {j['task'] for j in jobs} == set(receipt['cases']), 'whole thirteen-job inventory')
    parents, probes = {}, {}
    for job in jobs:
        pid = job['controller_pid']
        need(type(pid) is int and pid > 1 and waits.get(pid) == 9
             and job['status'] == 'running' and job.get('controller_exit_code') is None
             and job.get('finished_at') is None and job.get('run') == job.get('attempt') == 1
             and job.get('attempts') == [], 'original controller wait binding')
        start = datetime.fromisoformat(job['started_at']).timestamp()
        need(receipt['started_at'] <= start <= receipt['finished_at'], 'original controller clock')
        need(job['controller_command'] == ['bash', str(root / 'scripts/run-bench'), job['task'],
                                          '--ref', receipt['source']['head'], '--foreground'],
             'original controller source/command')
        log = campaign / (job['job_id'] + '.log')
        need(job['log'] == str(log), 'original controller log')
        lines = evidence.raw(log).decode().splitlines()
        found, probe = [], False
        for i, line in enumerate(lines):
            if line.strip().startswith('ref :') or re.match(r'^\s*ref\s*:', line):
                need(re.fullmatch(r'\s*ref\s*:\s*' + receipt['source']['head'] + r'(?:\s+.*)?', line),
                     'foreign controller ref')
            if line.strip() == 'mode: --infra-probe (strict barrier, no LLM / run_benchmark)':
                probe = True
            if str(root / 'scripts/run-bench') + ' monitor ' not in line:
                continue
            argv = shlex.split(line.strip())
            need(len(argv) == 3 and argv[:2] == [str(root / 'scripts/run-bench'), 'monitor'], 'monitor identity')
            fleet = Path(argv[2])
            match = re.fullmatch(r'owner: ([0-9a-f]{32}); private controller diagnostics stay in this run directory\.',
                                 lines[i + 1].strip() if i + 1 < len(lines) else '')
            need(match and fleet.parent == runs and fleet not in parents and fleet not in probes, 'participant owner')
            if not found:
                need(fleet.name.rsplit('-', 1)[-1] == str(pid), 'parent birth namespace')
                parents[fleet] = (match[1], job['task'])
            else:
                need(probe and len(found) == 1, 'unexpected nested execution')
                probes[fleet] = (match[1], found[0])
            found.append(fleet)
            probe = False
        need(1 <= len(found) <= 2, 'missing original parent')
    need(len(parents) == 13 and len(probes) == 1
         and set(parents) | set(probes) == {p for p in runs.iterdir() if p.name != '_hub'},
         'whole fourteen-participant closure')
    return parents, probes


def released(root, fleet, owner, expected, fresh, receipt, proof, evidence, *, interrupted_parent=False):
    from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding
    benches = json.loads(evidence.raw(fleet / '_batch/benches.json'))
    need(absent(fleet / '_batch/lifecycle.json'), 'original missing lifecycle must remain absent')
    names = [b['name'] for b in benches]
    need(len(names) == len(set(names)) and (names == [expected] if not fresh else len(names) == 2), 'task inventory')
    provenance = evidence.doc(fleet / 'execution-provenance.json')
    matrix = evidence.doc(fleet / 'execution-task-matrix.json')
    need(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance, matrix)
         and provenance['base_sha'] == receipt['source']['head'] and provenance['workspace_patch_sha256'] == 'none'
         and {t['name'] for t in matrix['tasks']} == set(names), 'source/task contract')
    audit = fleet_audit_root(root) / owner
    meta = evidence.fields(audit / 'meta')
    need(meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root) and meta.get('status') == 'provider-teardown-verified',
         'canonical participant release pending')
    epoch = float(evidence.raw(audit / 'provider-teardown-verified.epoch'))
    need(finite(epoch) and receipt['started_at'] <= epoch <= proof['confirmed_at'], 'release epoch')
    need(absent(fleet_ownership_root(root) / owner), 'participant registry retained')
    need(evidence.raw(fleet / 'teardown-ownership.path').decode().strip() == str(audit), 'canonical audit locator')
    seal = evidence.tree(audit)
    local = fleet / 'teardown-ownership'
    if local.exists():
        need(evidence.tree(local) == seal and evidence.fields(local / 'source-audit') ==
             {'path': str(audit), 'sha256': seal}, 'mirrored native audit changed')
    if fresh:
        need(all(absent(fleet / '_batch' / name) for name in ('run.json', 'disposable-cleanup.json', 'llm-usage.json')),
             'fresh original projection must remain absent')
        helper = runpy.run_path(str(root / 'scripts/cloudbench-prestart-recovery.py'))
        verified = helper['verify_released_fresh'](audit, fleet, root / 'scripts')
        need(verified['schema'] == 'cloudbench-released-fresh-no-start-verified-v1'
             and verified['owner'] == owner and verified['run_id'] == fleet.name
             and verified['proof_credit'] == 0 and verified['provider_teardown_verified'] is True
             and len(verified['machine_ids']) == 2, 'fresh native closure refused')
    else:
        allowed = {'meta', 'source-audit', 'owned-clones.ids', 'owned-clones.names', 'provider-teardown-verified.epoch',
                   'fresh', 'expected-fresh', 'by-machine-id', 'pool', 'pool-handoffs', 'volume-migrations', 'archived-reuse',
                   'prestart-recovery.log'}
        need({p.name for p in audit.iterdir()} <= allowed, 'unknown resource audit')
        need(absent(audit / 'prestart-recovery.log') or (audit / 'prestart-recovery.log').is_file(), 'native recovery log kind')
        for name in ('owned-clones.ids', 'owned-clones.names'):
            need(evidence.raw(audit / name) == b'', 'parent allocated resources')
        for p in audit.iterdir():
            if p.is_dir():
                need(not any(p.iterdir()), 'nonempty parent allocation class')
        forbidden = {'cloudbench-run.json', 'runtime-evidence.owner.json', 'runtime-evidence.pending',
                     'post-config-start.accepted', 'worker-runtime-evidence', 'worker-clones.ids', '.cid',
                     'primary.ids', 'primary.names', 'guest-shutdown.confirmed'}
        need(not any(p.name in forbidden for p in fleet.rglob('*')), 'unknown parent execution or worker')
        run_path = fleet / '_batch/run.json'
        need(absent(run_path) if interrupted_parent else not absent(run_path), 'original parent projection changed')
        if interrupted_parent:
            need(all(absent(fleet / '_batch' / name) for name in ('disposable-cleanup.json','llm-usage.json')),
                 'interrupted parent projection must remain absent')
        if not absent(run_path):
            run = evidence.doc(run_path)
            tasks = run['tasks']
            need(run['run_id'] == fleet.name and run['status'] == 'failed' and run['controller_exit_code'] == 143
                 and set(run) <= {'run_id','timestamp','elapsed_s','suite','source','base_url','summary','memory_summary',
                                 'tasks','status','controller_exit_code','execution_provenance','execution_task_matrix'}
                 and run['execution_provenance'] == provenance and run['execution_task_matrix'] == matrix
                 and len(tasks) == 1 and tasks[0]['name'] == expected
                 and tasks[0].get('passed') is False and tasks[0].get('status') == 'INFRA_ERROR'
                 and tasks[0].get('lifecycle_stage') == 'released'
                 and tasks[0].get('failure_reason') == 'no current run artifact produced'
                 and set(tasks[0]) <= {'name', 'passed', 'status', 'failure_reason', 'lifecycle_stage',
                                      'execution_provenance', 'world_model_mode'}, 'unverified original task execution')
            need('execution_provenance' not in tasks[0] or tasks[0]['execution_provenance'] == provenance,
                 'task source provenance changed')
            disposable = evidence.doc(fleet / '_batch/disposable-cleanup.json')
            need(disposable == {'schema': 'disposable-cleanup-v1', 'owner': owner,
                 'guest_cleanup_missing': False, 'runtime_evidence_missing': False,
                 'successful_runtime_inferred': False}, 'original parent runtime debt')
            usage = evidence.doc(fleet / '_batch/llm-usage.json')
            need(usage.get('run_id') == fleet.name and usage.get('providers')
                 and all(type(v.get('calls')) is int and v['calls'] == 0 and v.get('models') == {}
                         and all(finite(v.get(k)) and v[k] == 0 for k in ('input_tokens','output_tokens','cost_usd'))
                         for v in usage['providers'].values()), 'parent LLM execution unknown')
        verified = None
    # All original and final files the native helper consumes are part of the seal.
    fleet_seal = evidence.tree(fleet)
    return {'owner': owner, 'run': str(fleet), 'audit_sha256': seal, 'run_sha256': fleet_seal,
            'release_epoch': epoch, 'fresh_no_start': verified, 'hub_owner': meta.get('hub_owner_file')}


def shared(root, runs, campaign, evidence, waits, *, controls_pending=False, recovery=None):
    """Use original relay birth authority and native Hub retirement observation."""
    location = evidence.doc(campaign / 'shared-relay-location.json')['directory']
    need(re.fullmatch(r'/tmp/cb-relay-[A-Za-z0-9_]{8}', location), 'relay namespace')
    relay = Path(location)
    module = runpy.run_path(str(root / 'scripts/cloudbench-shared-relay.py'))
    authority, authority_sha = module['authority'](relay / 'authority.private.json')
    need(evidence.doc(relay / 'authority.private.json') == authority
         and authority['inventory_directory'] == str(campaign / 'shared-inventory'), 'relay authority binding')
    capture = evidence.doc(relay / 'startup-agent.json')
    ready, serve = (evidence.doc(relay / n) for n in ('ready.json', 'serve.once.json'))
    broker, bootstrap = (evidence.doc(relay / n) for n in ('broker-owner.json', 'bootstrap-owner.json'))
    parent = {'pid': authority['parent_pid'], 'birth': authority['parent_start']}
    need(capture['authority_sha256'] == ready['authority_sha256'] == serve['authority_sha256'] == authority_sha
         and capture['parent'] == parent and capture['broker'] == {'pid': broker['pid'], 'birth': broker['birth']}
         and ready['agent'] == capture['agent'] and ready['pid'] == serve['pid'] == broker['pid']
         and ready['birth'] == serve['birth'] == broker['birth']
         and capture['socket'] == authority['agent_socket'] == str(relay / 'fly-agent.sock')
         and ready['socket'] == str(relay / 'control.sock'), 'foreign relay capability')
    publisher = authority['inventory_owner']
    identities = [parent, broker, bootstrap, capture['agent'],
                  {'pid': int(publisher['pid']), 'birth': publisher['pid_start']}]
    need(len({x['pid'] for x in identities}) == len(identities), 'aliased original processes')
    for row in identities:
        need(row['pid'] in waits, 'original shared process not reaped')
        retired_local_process(row)
    for row in (broker, bootstrap):
        need(row['parent_pid'] == parent['pid'] and row['parent_start'] == parent['birth'], 'shared parent birth')
    need(publisher['parent_pid'] == str(parent['pid']) and publisher['parent_start'] == parent['birth'], 'publisher birth')
    inventory_owner = campaign / 'shared-inventory/owner'
    if not absent(inventory_owner):
        need(evidence.fields(inventory_owner) == publisher, 'inventory owner changed')
    for name in ('fly-agent.sock', 'control.sock'):
        if controls_pending and name == 'control.sock':
            continue
        need(absent(relay / name), 'relay socket retained')
    if not controls_pending:
        need(absent(campaign / 'shared-inventory/inventory-refresh.wait') and absent(inventory_owner),
             'retired inventory control still present')
        retirement = evidence.doc(recovery / 'control-retirement.json')
        need(set(retirement) == {'kind','root','campaign','manifest','manifest_sha256','authority_sha256',
                                'source_sha256','targets','verified_absent','started_at','finished_at'}
             and retirement['kind'] == 'interrupted-fresh-controls-retired-v1'
             and retirement['root'] == str(root) and retirement['campaign'] == str(campaign)
             and retirement['manifest_sha256'] == evidence.bindings[retirement['manifest']]
             and retirement['authority_sha256'] == authority_sha
             and retirement['source_sha256'] == evidence.bindings[str(root / 'scripts/deploy_test_interrupted_fresh_cleanup.py')],
             'control retirement provenance')
        need(finite(retirement['started_at']) and finite(retirement['finished_at'])
             and retirement['started_at'] <= retirement['finished_at'] <= time.time(), 'control retirement clock')
        manifest = evidence.doc(retirement['manifest'])
        expected = {str(relay / 'control.sock'), str(campaign / 'shared-inventory/inventory-refresh.wait'), str(inventory_owner)}
        need({r['source'] for r in retirement['targets']} == expected and len(retirement['targets']) == 3
             and all(r in manifest['rows'] for r in retirement['targets']) and retirement['verified_absent'] is True,
             'control retirement inventory')
        original_owner, = [r for r in retirement['targets'] if r['source'] == str(inventory_owner)]
        need(evidence.fields(original_owner['copy']) == publisher
             and evidence.bindings[original_owner['copy']] == original_owner['sha256'], 'original inventory owner preservation')
    leases = relay / 'leases'
    need(absent(leases) or leases.is_dir() and not leases.is_symlink() and not any(leases.iterdir()), 'relay lease retained')
    native = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))
    owners = sorted((runs / '_hub').glob('*.owner'))
    need(owners, 'missing original Hub inventory')
    ports = set()
    for owner in owners:
        value = evidence.fields(owner)
        need(native['native_hub_owner_retired'](owner, runs, root), 'retained Hub consumer')
        need(int(value['pid']) in waits, 'Hub outside original supervised custody')
        ports.add(int(value['port']))
    groups_absent({x['pid'] for x in identities})
    namespace_quiet(runs.parent, ports)
    namespace_quiet(relay, set())
    pointer = campaign / 'shared-inventory/inventory/current'
    inventory_pointer = None
    if not absent(pointer):
        need(pointer.is_symlink() and re.fullmatch(r'\.generation-[A-Za-z0-9._-]+', os.readlink(pointer))
             and pointer.resolve().is_dir() and pointer.resolve().parent == pointer.parent, 'native inventory pointer')
        inventory_pointer = os.readlink(pointer)
    return {str(p): evidence.bindings[str(p)] for p in owners}, parent['pid'], inventory_pointer


def closure(state, receipt, proof, gate, *, controls_pending=False):
    from deploy_test_cycle import digest
    need(set(proof) == FIELDS and proof['kind'] == KIND, 'typed fresh custody fields')
    need(finite(proof['confirmed_at']) and receipt['finished_at'] <= proof['confirmed_at'] <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'confirmation clock')
    root = Path(proof['root'])
    need(root.is_absolute() and root.resolve() == root
         and subprocess.check_output(['git','-C',str(root),'rev-parse','--show-toplevel'],text=True).strip() == str(root),
         'canonical root')
    need(receipt['gate'] == gate['name'] == gate['category'] == 'smoke' and gate.get('native_cloud') is True
         and receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and receipt.get('native_exit') == -9 and receipt.get('lifecycle') == 'native-producer'
         and receipt.get('executed') is True and receipt.get('complete') is False
         and receipt.get('status') == 'FAIL' and receipt.get('lingering_group') is True
         and receipt.get('worker_result') is None and receipt.get('native_cleanup_reference') is None
         and receipt.get('cleanup_owner') == {'request_token': receipt['token'], 'worker_root': str(root),
                                               'native_cleanup_reference': None}
         and receipt['command'] == gate['command'] and receipt['cases'] == dict.fromkeys(gate['checks'], 'UNVERIFIED')
         and receipt['execution_binding']['contract_digest'] == digest(gate), 'exact interrupted execution')
    evidence = Evidence(proof['files'])
    policies(root, receipt, evidence)
    folder = Path(receipt['log']).parent
    need(folder.is_relative_to(root / '.context/deploy-pipeline/attempts') and folder.name == 'smoke'
         and Path(receipt['log']) == folder / 'output.log', 'original receipt namespace')
    request = evidence.doc(folder / 'request.json')
    need(evidence.doc(folder / 'receipt.json') == receipt and absent(folder / 'result.json')
         and all(request[k] == receipt[k] for k in ('token', 'source', 'gate'))
         and request['checks'] == gate['checks'] and request['skips'] == {} and request['phase'] == 'final'
         and request['custody_child_environment'] and request['custody_runtime'], 'original request binding')
    base = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    runs, campaign = base / 'runs', base / 'campaigns' / ('deploy-' + base.name)
    summary = evidence.doc(campaign / 'summary.json')
    need(summary['status'] == 'running' and summary['finished_at'] is None and summary['runs'] == 1
         and summary['retry_infra'] == 0 and summary['task_count'] == summary['total_jobs'] == 13
         and summary['campaign_id'] == campaign.name, 'original unfinalized summary')
    need(receipt['started_at'] <= datetime.fromisoformat(summary['started_at']).timestamp()
         <= receipt['finished_at'] <= proof['confirmed_at'], 'original campaign clock')
    supervisor = evidence.doc(base / 'cli.log.process.json')
    need(supervisor['native_exit'] == -9 and supervisor['cancelled'] is True and supervisor['timed_out'] is False
         and supervisor['quiescent'] is True and supervisor['remaining'] == [] and supervisor['error'] is None,
         'native supervisor closure')
    rows = supervisor['reaped']
    need(isinstance(rows, list) and 1 < len(rows) <= 4096
         and all(set(r) == {'pid', 'status'} and type(r['pid']) is int and type(r['status']) is int
             and r['pid'] > 1 and 0 <= r['status'] <= 65535
             and r['pid'] != supervisor['supervisor_pid']
             and (os.WIFEXITED(r['status']) or os.WIFSIGNALED(r['status'])) for r in rows), 'native wait records')
    waits = {r['pid']: r['status'] for r in rows}
    need(len(waits) == len(rows) and waits.get(supervisor['child_pid']) == 9
         and set(supervisor['kill_sent']) <= set(supervisor['term_sent']) <= set(waits), 'supervisor wait inventory')
    groups_absent({supervisor['supervisor_pid'], supervisor['child_pid'], *waits})
    parents, probes = membership(root, runs, campaign, summary, receipt, evidence, waits)
    # This phase had no worker admission anywhere. Do not treat another claim as
    # evidence of emptiness or borrow it to complete this historical operation.
    for claims in (fleet_audit_root(root).parent / 'cloudbench-pool-claims',
                   fleet_audit_root(root).parent / 'cloudbench-worker-reuse/imported'):
        need(absent(claims) or claims.is_dir() and not claims.is_symlink() and not any(claims.iterdir()),
             'shared worker claims require separate custody')
    interrupted_parents = {parent for _, parent in probes.values()}
    seals = [released(root, f, token, task, False, receipt, proof, evidence,
                      interrupted_parent=f in interrupted_parents) for f, (token, task) in parents.items()]
    for fleet, (token, parent) in probes.items():
        need(parent in parents and waits.get(int(fleet.name.rsplit('-', 1)[-1])) == 9, 'nested original wait')
        seals.append(released(root, fleet, token, None, True, receipt, proof, evidence))
    hubs, child_pid, inventory_pointer = shared(root, runs, campaign, evidence, waits,
                                               controls_pending=controls_pending, recovery=Path(proof['recovery_directory']))
    need(child_pid == supervisor['child_pid'] and all(s['hub_owner'] in hubs for s in seals), 'shared owner closure')
    no_holders([base / 'cli.log', folder / 'output.log', folder / 'stderr.log',
                *[campaign / (j['job_id'] + '.log') for j in summary['jobs']]])
    new = copy.deepcopy(summary)
    new.update(status='cancelled', finished_at=datetime.fromtimestamp(proof['confirmed_at'], timezone.utc).isoformat())
    for job in new['jobs']:
        job.update(status='cancelled', controller_exit_code=-9)
    record = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))['campaign_group_record'](new)
    provenance = {'schema': RECORD, 'request_token': receipt['token'], 'source': receipt['source'],
                  'execution_binding': receipt['execution_binding'], 'original_summary_sha256': evidence.bindings[str(campaign / 'summary.json')],
                  'original_receipt_sha256': evidence.bindings[str(folder / 'receipt.json')],
                  'original_request_sha256': evidence.bindings[str(folder / 'request.json')],
                  'custody_runtime': request['custody_runtime'],
                  'custody_child_environment': request['custody_child_environment'],
                  'native_supervisor_sha256': evidence.bindings[str(base / 'cli.log.process.json')],
                  'observed_at': proof['confirmed_at'], 'participants': seals, 'hubs': hubs,
                  'inventory_pointer': inventory_pointer,
                  'execution_credit': False, 'financial_cleanup_credit': False}
    return new, record, provenance


def control_identity(path, row):
    info = path.lstat()
    return (not path.is_symlink() and info.st_nlink == 1 and info.st_uid == os.getuid()
            and all(actual == row[key] for key, actual in (
                ('mode',info.st_mode),('size',info.st_size),('dev',info.st_dev),('ino',info.st_ino),
                ('mtime_ns',info.st_mtime_ns),('ctime_ns',info.st_ctime_ns))))


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def retire_controls(state, receipt, proof, gate, manifest_path, *, dry_run=False):
    """Unlink only three stale local controls after positive native closure.

    This is an operation receipt, never a broker shutdown ACK. An intent permits
    safe retry after an interrupted unlink; each remaining inode is rechecked.
    """
    root = Path(proof['root'])
    recovery = Path(proof['recovery_directory'])
    base = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    campaign = base / 'campaigns' / ('deploy-' + base.name)
    need(recovery.is_absolute() and recovery.resolve() == recovery and not recovery.is_relative_to(base),
         'separate control retirement directory')
    relay = Path(json.loads((campaign / 'shared-relay-location.json').read_text())['directory'])
    need(manifest_path.is_absolute() and manifest_path.resolve() == manifest_path and not manifest_path.is_symlink(), 'control manifest path')
    original_manifest = manifest_path.read_bytes()
    manifest = json.loads(original_manifest)
    expected = [(relay / 'control.sock', stat.S_ISSOCK),
                (campaign / 'shared-inventory/inventory-refresh.wait', stat.S_ISFIFO),
                (campaign / 'shared-inventory/owner', stat.S_ISREG)]
    rows = []
    for path, kind in expected:
        matches = [r for r in manifest['rows'] if r['source'] == str(path)]
        need(len(matches) == 1 and kind(matches[0]['mode']), 'original control kind/identity')
        rows.append(matches[0])
    source_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    authority_sha = hashlib.sha256((relay / 'authority.private.json').read_bytes()).hexdigest()
    record = dict(kind='interrupted-fresh-controls-retired-v1', root=str(root), campaign=str(campaign),
                  manifest=str(manifest_path), manifest_sha256=hashlib.sha256(original_manifest).hexdigest(),
                  authority_sha256=authority_sha, source_sha256=source_sha, targets=rows, verified_absent=True)
    intent = {k:v for k,v in record.items() if k != 'verified_absent'}
    intent_path, result_path = recovery / 'control-retirement-intent.json', recovery / 'control-retirement.json'
    need(not intent_path.is_symlink() and not result_path.is_symlink(), 'linked retirement record')
    resumed = intent_path.exists()
    if resumed:
        previous = json.loads(intent_path.read_text())
        need({k:v for k,v in previous.items() if k != 'started_at'} == intent
             and finite(previous['started_at']), 'retirement intent changed')
        intent['started_at'] = previous['started_at']
    else:
        need(all(not absent(path) for path, _ in expected), 'missing control without native intent')
        intent['started_at'] = time.time()
    transient = copy.deepcopy(proof)
    owner = rows[-1]
    owner_copy = Path(owner['copy']).read_bytes()
    need(hashlib.sha256(owner_copy).hexdigest() == owner['sha256'], 'original owner copy changed')
    from deploy_test_native_cleanup import fields
    need(fields(owner_copy) == json.loads((relay / 'authority.private.json').read_text())['inventory_owner'],
         'preserved owner differs from original authority')
    if resumed and absent(expected[-1][0]):
        # The unlink can complete before the caller persists the new proof map.
        # Only this exact intent-owned original may be replaced by its copy.
        old = transient.get('files', {}).get(str(expected[-1][0]))
        need(old is None or old == owner['sha256'], 'retired owner binding changed')
        transient.get('files', {}).pop(str(expected[-1][0]), None)
    transient['files'] = capture_files(receipt, transient, controls_pending=True)
    closure(state, receipt, transient, gate, controls_pending=True)
    if not absent(expected[-1][0]):
        need(expected[-1][0].read_bytes() == Path(owner['copy']).read_bytes(), 'original owner bytes changed')
    need(manifest_path.read_bytes() == original_manifest, 'control manifest changed')

    def guard():
        namespace_quiet(base, set())
        namespace_quiet(relay, set())
        paths = [path for path, _ in expected if not absent(path)]
        if paths:
            no_holders(paths)
        for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
            fields = line.split()
            need(len(fields) < 8 or fields[7] not in {str(relay / 'control.sock'), str(relay / 'fly-agent.sock')},
                 'live kernel relay socket remains')
        for path, _ in expected:
            if not absent(path):
                row, = [r for r in rows if r['source'] == str(path)]
                need(control_identity(path, row), 'original control inode changed')

    guard()
    if dry_run:
        return {**intent, 'action': 'unlink-exact-stale-controls', 'dry_run': True}
    need(recovery.parent.is_dir() and recovery.parent.resolve() == recovery.parent, 'retirement parent directory')
    recovery.mkdir(exist_ok=True)
    fsync_directory(recovery.parent)
    if not resumed:
        with intent_path.open('x') as stream:
            json.dump(intent, stream, sort_keys=True)
            stream.flush();os.fsync(stream.fileno())
        fsync_directory(recovery)
    for path, _ in expected:
        guard()
        if not absent(path):
            path.unlink()
            fsync_directory(path.parent)
    guard()
    need(all(absent(path) for path, _ in expected), 'control retirement incomplete')
    if result_path.exists():
        previous = json.loads(result_path.read_text())
        record.update(started_at=intent['started_at'], finished_at=previous['finished_at'])
        need(previous == record, 'retirement result changed')
    else:
        record.update(started_at=intent['started_at'], finished_at=time.time())
        with result_path.open('x') as stream:
            json.dump(record, stream, sort_keys=True)
            stream.flush();os.fsync(stream.fileno())
        fsync_directory(recovery)
    # Only the exact retired owner may leave the live-file map; its native
    # pre-operation copy and hash replace the path in this new operation proof.
    for path, _ in expected:
        transient['files'].pop(str(path), None)
    proof['files'] = capture_files(receipt, transient)
    return record


def validate(state, receipt, proof, gate, *, published=True):
    summary, record, provenance = closure(state, receipt, proof, gate)
    recovery = Path(proof['recovery_directory'])
    need(recovery.is_absolute() and recovery.resolve() == recovery
         and not recovery.is_relative_to(Path(proof['root']) / '.context/deploy-cloud'), 'separate recovery directory')
    if published:
        evidence = Evidence(proof['files'])
        need(evidence.doc(recovery / 'recovery-summary.json') == summary
             and evidence.doc(recovery / 'recovery-provenance.json') == provenance
             and evidence.doc(recovery / 'hub-group.json') == record, 'derived recovery changed')
        publication = evidence.doc(recovery / 'publication.json')
        evidence.doc(recovery / 'hub-group-publication-ack.private.json')
        need(set(publication) == {'native_producer', 'started_at', 'finished_at', 'published', 'source_sha256'}
             and publication['published'] is True
             and publication['native_producer'] == 'scripts/run-bench-campaign.py::publish_campaign_group'
             and publication['source_sha256'] == evidence.bindings[str(Path(proof['root']) / 'scripts/run-bench-campaign.py')]
             and proof['confirmed_at'] <= publication['started_at'] <= publication['finished_at'] <= time.time(),
             'native publication receipt')
        from deploy_test_cloud import campaign_published
        native = runpy.run_path(str(Path(proof['root']) / 'scripts/run-bench-campaign.py'))
        need(campaign_published(summary, recovery, receipt['started_at'], native), 'native publication ACK or consumer')
        no_holders([recovery / 'hub-group-publication.private.log'])
    return {'kind': KIND, 'gate': receipt['gate'], 'token': receipt['token'], 'execution_gate': copy.deepcopy(gate),
            'proof': copy.deepcopy(proof), 'credit_granted': False, 'financial_cleanup_credit': False,
            'cleanup_complete': False, 'original_outcomes_preserved': True}


def reconciliation(state, token, proof):
    from deploy_test_cycle import interrupted_receipt, sha_file
    receipt = interrupted_receipt(state, token)
    need(state.get('phase') == 'interrupted' and state.get('resume_phase') == 'final'
         and state.get('ready') is False and not state.get('pending'), 'quiescent final interruption required')
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    need(state['source'] == receipt['source'] and state['environment'] == receipt['execution_binding']['environment'],
         'initial source/environment changed')
    need(state['plan']['source'] == state['source'], 'plan source changed')
    entry = validate(state, receipt, proof, gate)
    entry['occurrence'] = token
    key = sha_file(Path(receipt['log']).parent / 'receipt.json')
    need(not any(e.get('token') == token and k != key for k, e in state.get('reconciled_owners', {}).items()), 'duplicate token')
    previous = state.get('reconciled_owners', {}).get(key)
    need(previous is None or previous == entry, 'existing reconciliation differs')
    return key, entry


def reconcile(state, token, proof):
    try:
        key, entry = reconciliation(state, token, proof)
    except (OSError, ValueError, KeyError, TypeError, IndexError, StopIteration, subprocess.SubprocessError) as error:
        raise ValueError('fresh custody proof refused: ' + str(error)) from error
    state.setdefault('reconciled_owners', {})[key] = entry


def still_bound(state, receipt, entry):
    from deploy_test_result import preserve_contract
    try:
        current, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
        preserve_contract(entry['execution_gate'], current)
        return validate(state, receipt, entry['proof'], entry['execution_gate']) == {
            k: v for k, v in entry.items() if k != 'occurrence'} and entry['occurrence'] == receipt['token']
    except (OSError, KeyError, ValueError, TypeError, subprocess.SubprocessError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('retire-controls', 'prepare', 'publish', 'verify'))
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--proof', required=True, type=Path)
    parser.add_argument('--request-token', required=True)
    parser.add_argument('--control-manifest', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    from deploy_test_cycle import bounded_read, interrupted_receipt, write
    need(args.proof.absolute() == args.proof.resolve(), 'canonical proof path required')
    state, proof = bounded_read(args.state, 'state'), bounded_read(args.proof, 'proof')
    receipt = interrupted_receipt(state, args.request_token)
    need(state.get('phase') == 'interrupted' and state.get('resume_phase') == 'final'
         and state.get('ready') is False and not state.get('pending')
         and state['source'] == state['plan']['source'] == receipt['source']
         and state['environment'] == receipt['execution_binding']['environment'], 'original final interruption required')
    gate, = [g for g in state['plan']['gates'] if g['name'] == 'smoke']
    directory = Path(proof['recovery_directory'])
    need(not args.proof.resolve().is_relative_to(directory.resolve()), 'proof must be outside publication directory')
    if args.action == 'retire-controls':
        need(args.control_manifest is not None, 'original control manifest required')
        result = retire_controls(state, receipt, proof, gate, args.control_manifest, dry_run=args.dry_run)
        if args.dry_run:
            print(json.dumps(result, sort_keys=True, indent=2))
            return
        write(args.proof, proof);fsync_directory(args.proof.parent)
        return
    need(not args.dry_run, 'dry-run is only supported for control retirement')
    if args.action == 'verify':
        validate(state, receipt, proof, gate)
        return
    if not proof.get('files'):
        proof['files'] = capture_files(receipt, proof)
    summary, record, provenance = closure(state, receipt, proof, gate)
    validate(state, receipt, proof, gate, published=False)
    if args.action == 'prepare':
        directory.mkdir(parents=True, exist_ok=True)
        records = [(directory / name, (json.dumps(value, sort_keys=name != 'hub-group.json', indent=2) + '\n').encode()) for name, value in
                   (('recovery-summary.json', summary), ('recovery-provenance.json', provenance), ('hub-group.json', record))]
        for path, raw in records:
            need(absent(path) or not path.is_symlink() and path.read_bytes() == raw, 'existing recovery differs')
        for path, raw in records:
            if path.exists():
                continue
            else:
                with path.open('xb') as stream:
                    stream.write(raw)
        proof['files'] = capture_files(receipt, proof)
        write(args.proof, proof);fsync_directory(args.proof.parent)
        return
    for name, expected in (('recovery-summary.json', summary), ('recovery-provenance.json', provenance), ('hub-group.json', record)):
        need(bounded_read(directory / name, name) == expected, 'prepared recovery changed')
    need(absent(directory / 'publication.json') and absent(directory / 'hub-group-publication-ack.private.json'), 'publication already attempted')
    from deploy_test_process import CANCEL
    native = runpy.run_path(str(Path(proof['root']) / 'scripts/run-bench-campaign.py'))
    start = time.time()
    previous = {s: signal.signal(s, lambda *_: CANCEL.set()) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        result = native['publish_campaign_group'](Path(proof['root']), directory, summary,
                                                  live=False, stop_requested=CANCEL.is_set)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    (directory / 'publication.json').write_text(json.dumps({
        'native_producer': 'scripts/run-bench-campaign.py::publish_campaign_group',
        'started_at': start, 'finished_at': time.time(), 'published': result,
        'source_sha256': hashlib.sha256((Path(proof['root']) / 'scripts/run-bench-campaign.py').read_bytes()).hexdigest()}) + '\n')
    proof['files'] = capture_files(receipt, proof)
    write(args.proof, proof);fsync_directory(args.proof.parent)
    need(result is True, 'native publisher refused')


if __name__ == '__main__':
    main()
