"""Launch-only custody for interrupted zero-allocation cloud and static TERM workers."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import subprocess
import time
from datetime import datetime

KIND = 'interrupted-preallocation-cleanup-v1'
RENEWAL_KIND = 'interrupted-policy-witness-renewal-v1'
POLICIES = {'scripts/run-bench-fleet', 'scripts/lib/cloudbench-env.sh',
            'scripts/run-bench-campaign.py', 'agents/benchmarks/hub_upload.py'}
MARKERS = {'.cid', 'cloudbench-run.json', 'runtime-evidence.pending',
           'guest-never-started.confirmed', 'runtime-evidence.owner.json',
           'post-config-start.accepted', 'worker-runtime-evidence', 'primary.ids', 'primary.names'}


def need(value, message):
    if not value:
        raise ValueError('interrupted custody: ' + message)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def stamp(value):
    result = datetime.fromisoformat(value).timestamp()
    need(math.isfinite(result), 'invalid native timestamp')
    return result


def processes():
    rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
    return [(int(r.split()[0]), int(r.split()[1])) for r in rows.splitlines()
            if not r.split()[2].startswith('Z')]


def groups_absent(pids):
    need(all(type(pid) is int and pid > 1 for pid in pids), 'invalid original process identity')
    need(not any(pid in pids or group in pids for pid, group in processes()), 'original process/group remains')


def no_holders(paths):
    result = subprocess.run(['lsof', '-t', '--', *map(str, paths)], capture_output=True, timeout=10)
    need(result.returncode == 1 and not result.stdout and not result.stderr, 'log writer or unknown holder remains')


def namespace_quiet(namespace, ports):
    """Observe only the old namespace; other legitimate source workers stay untouched."""
    ancestors, pid = set(), os.getpid()
    while pid > 1 and pid not in ancestors:
        ancestors.add(pid)
        raw = Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1].split()
        pid = int(raw[1])
    prefix = str(namespace)

    def inspect(process):
        argv = (process / 'cmdline').read_bytes().decode(errors='replace')
        cwd = str((process / 'cwd').resolve(strict=True))
        need(int(process.name) in ancestors or (prefix not in argv and cwd != prefix and not cwd.startswith(prefix + '/')),
             'original namespace has a live consumer')
        for fd in (process / 'fd').iterdir():
            try:
                target = os.readlink(fd)
            except (FileNotFoundError, ProcessLookupError):
                continue
            need(target != prefix and not target.startswith(prefix + '/'), 'original namespace file holder remains')

    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        deadline = time.monotonic() + 2
        while True:
            try:
                if process.stat().st_uid != os.geteuid():
                    break
                inspect(process)
                break
            except (FileNotFoundError, ProcessLookupError):
                break
            except PermissionError:
                # A same-user process can turn unreadable mid-scan (non-dumpable, or exec of a setuid
                # binary). Re-observe: it is skipped only once it exits or is another user's.
                need(time.monotonic() < deadline, f'original namespace process {process.name} is unverifiable')
                time.sleep(0.05)
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            local, remote = (int(row[i].rsplit(':', 1)[1], 16) for i in (1, 2))
            need(row[3] in {'06', '07'} or not {local, remote}.intersection(ports),
                 'original Hub listener/socket consumer remains')


class Evidence:
    def __init__(self, bindings, relocations=None):
        need(isinstance(bindings, dict) and bindings, 'file bindings required')
        self.bindings = bindings
        self.relocations = relocations or {}
        for path in bindings:
            self.raw(path)

    def raw(self, value):
        from deploy_test_cycle import MAX_RECEIPT_BYTES
        original = str(value)
        relocated = self.relocations.get(original, original)
        if isinstance(relocated, bytes):
            need(len(relocated) <= MAX_RECEIPT_BYTES
                 and self.bindings.get(original) == hashlib.sha256(relocated).hexdigest(), 'original Git policy changed')
            return relocated
        path = Path(relocated)
        need(path.is_absolute() and path.resolve(strict=True) == path and path.is_file()
             and not path.is_symlink() and path.stat().st_size <= MAX_RECEIPT_BYTES, 'bounded original file required')
        raw = path.read_bytes()
        need(self.bindings.get(original) == self.bindings.get(str(path)) == hashlib.sha256(raw).hexdigest(),
             'original evidence changed: ' + original)
        return raw

    def doc(self, path):
        value = json.loads(self.raw(path))
        need(isinstance(value, dict), 'native object required')
        return value

    def fields(self, path):
        rows = [line.partition('=') for line in self.raw(path).decode().splitlines()]
        need(all(k and sep for k, sep, _ in rows) and len({k for k, _, _ in rows}) == len(rows), 'invalid native fields')
        return {k: v for k, _, v in rows}

    def tree(self, path):
        need(path.is_dir() and path.resolve() == path and not path.is_symlink(), 'native audit directory required')
        result = hashlib.sha256()
        for item in sorted(path.rglob('*'), key=lambda p: str(p.relative_to(path))):
            need(not item.is_symlink() and (item.is_file() or item.is_dir()), 'unsafe audit member')
            if item.is_file() and item.name != 'source-audit':
                for raw in (str(item.relative_to(path)).encode(), self.raw(item)):
                    result.update(len(raw).to_bytes(8, 'big'))
                    result.update(raw)
        return result.hexdigest()


def policy(root, receipt, proof, evidence, name):
    path = Path(proof['producer_files'][name])
    original = subprocess.check_output(['git', 'show', receipt['source']['head'] + ':' + name], cwd=root)
    need(evidence.raw(path) == original, 'original source policy changed')
    relocated = evidence.relocations.get(str(path), str(path))
    return path if isinstance(relocated, bytes) else Path(relocated), original


def static_worker(root, gate, receipt, folder, evidence):
    need(gate.get('name') == gate.get('category') == 'backend-structural' and gate.get('quick') is True
         and gate.get('command') == ['npm', 'run', 'test:structural'] and gate.get('cwd') == 'back-end'
         and gate.get('checks') == ['backend-structural']
         and not gate.get('env') and not any(gate.get(k) for k in
             ('worker', 'worker_root', 'worker_transport', 'worker_recipe', 'worker_host', 'worker_thread',
              'remote_python', 'native_cloud', 'native_backend', 'case_protocol', 'result_transport', 'services')),
         'only the original static structural route is supported')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('native_exit') == -15
         and receipt.get('cleanup_owner') is None, 'original static TERM receipt required')
    path = folder / 'output.log.process.json'
    process = evidence.doc(path)
    need(process.get('native_exit') == -15 and process.get('cancelled') is True
         and process.get('timed_out') is False and process.get('quiescent') is True
         and process.get('remaining') == [] and process.get('error') is None
         and type(process.get('orphaned_children')) is bool and process.get('kill_sent') == [],
         'genuine terminal supervisor evidence required')
    child, supervisor = process['child_pid'], process['supervisor_pid']
    rows, terms = process['reaped'], process['term_sent']
    need(type(child) is int and type(supervisor) is int and child != supervisor
         and isinstance(rows, list) and rows and isinstance(terms, list) and child in terms
         and all(isinstance(r, dict) and set(r) == {'pid', 'status'} and type(r['pid']) is int
                 and r['pid'] > 1 and r['pid'] != supervisor and type(r['status']) is int
                 and 0 <= r['status'] <= 65535 and (os.WIFEXITED(r['status']) or os.WIFSIGNALED(r['status'])) for r in rows),
         'native wait records required')
    reaped = {r['pid']: r['status'] for r in rows}
    need(len(reaped) == len(rows) and reaped.get(child) == 15 and len(set(terms)) == len(terms)
         and all(type(pid) is int and pid in reaped for pid in terms), 'TERM target not reaped')
    groups_absent({child, supervisor, *reaped})
    no_holders([folder / 'output.log', folder / 'stderr.log', path])


def cloud(root, gate, receipt, folder, proof, evidence):
    need(gate.get('name') == gate.get('category') == 'smoke' and gate.get('native_cloud') is True
         and gate.get('worker_transport') == 'benchmark-cloud-cli' and gate.get('cwd') == str(root)
         and not gate.get('env') and gate.get('command')[1:] == [str(root / 'scripts/deploy_test_cloud.py')]
         and len(gate['command']) == 2 and Path(gate['command'][0]).name.startswith('python3'), 'native cloud binding')
    owner = {'request_token': receipt['token'], 'worker_root': str(root), 'native_cleanup_reference': None}
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('native_exit') == -9
         and receipt.get('cleanup_owner') == owner, 'original interrupted cloud owner required')
    base = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    runs, campaign = base / 'runs', base / 'campaigns' / ('deploy-' + base.name)
    cli = base / 'cli.log'
    need(str(campaign) in evidence.raw(cli).decode(), 'original CLI campaign binding')
    summary = evidence.doc(campaign / 'summary.json')
    jobs = summary['jobs']
    need(summary.get('campaign_id') == campaign.name and summary.get('status') == 'cancelled'
         and summary.get('runs') == 1 and summary.get('retry_infra') == 0
         and summary.get('task_count') == summary.get('total_jobs') == len(gate['checks']) == len(jobs)
         and summary.get('peak_concurrency') == len(jobs)
         and {j['task'] for j in jobs} == set(gate['checks'])
         and len({j['job_id'] for j in jobs}) == len(jobs), 'complete original campaign inventory required')
    start, finish = (stamp(summary[k]) for k in ('started_at', 'finished_at'))
    need(receipt['started_at'] <= start <= finish <= proof['confirmed_at'], 'later native campaign clock required')
    need(not any(summary.get(k) for k in ('shared_transport_cleanup_pending', 'cleanup_ticket_failure', 'shared_inventory_failed'))
         and not any(c.get('cleanup_budget_retirement_pending') for c in summary.get('startup_cohorts', [])),
         'shared campaign cleanup remains')
    _, original = policy(root, receipt, proof, evidence, 'scripts/run-bench-fleet')
    policy(root, receipt, proof, evidence, 'scripts/lib/cloudbench-env.sh')
    visibility = original.index(b'\n    require_central_hub_visibility || exit 1')
    provenance = original.index(b'EXECUTION_PROVENANCE_FILE="$FLEET_DIR/execution-provenance.json"')
    allocation = original.index(b'\n        provision_primary_machine "$bench" "$out"')
    need(visibility < provenance < allocation and b'preallocation = not admitted_outputs' in original,
         'original preallocation ordering unavailable')
    parents, logs, lifecycles, hub_paths = set(), [cli], {}, set()
    controllers = set()
    for job in jobs:
        need(re.fullmatch(r'r001-j[0-9]{4}', job['job_id']) and job.get('run') == job.get('attempt') == 1
             and job.get('attempts') == [] and job.get('status') == 'cancelled'
             and job.get('controller_exit_code') == 143 and type(job.get('controller_pid')) is int
             and job['controller_pid'] > 1 and start <= stamp(job['started_at']) <= stamp(job['finished_at']) <= finish,
             'original failed controller identity required')
        controllers.add(job['controller_pid'])
        log = campaign / (job['job_id'] + '.log')
        need(job['log'] == str(log), 'original controller log binding')
        text = evidence.raw(log).decode(errors='replace')
        handles = re.findall(re.escape(str(root / 'scripts/run-bench')) + r' monitor ([^\s]+)', text)
        need(len(handles) == 1, 'unexpected controller/canary participant')
        fleet = Path(handles[0])
        need(fleet.parent == runs and fleet.name.rsplit('-', 1)[-1] == str(job['controller_pid'])
             and fleet not in parents, 'exact parent namespace required')
        parents.add(fleet)
        logs.append(log)
        benches = json.loads(evidence.raw(fleet / '_batch/benches.json'))
        need(isinstance(benches, list) and [b['name'] for b in benches] == [job['task']], 'parent task inventory')
        life_path = fleet / '_batch/lifecycle.json'
        life = evidence.doc(life_path)
        token = life['fleet_owner_token']
        need(re.fullmatch('[0-9a-f]{32}', token) and type(life.get('version')) is int and life['version'] == 1 and life.get('run_id') == fleet.name
             and life.get('workspace_root') == str(root) and life.get('status') == 'failed'
             and life.get('controller_exit_code') == 143 and life.get('hub_publication_failed') is False,
             'original failed fleet lifecycle required')
        lifecycles[str(life_path)] = evidence.bindings[str(life_path)]
        run = evidence.doc(fleet / '_batch/run.json')
        tasks = run.get('tasks')
        need(run.get('run_id') == fleet.name and run.get('status') == 'failed' and run.get('controller_exit_code') == 143
             and isinstance(tasks, list) and len(tasks) == 1 and tasks[0].get('name') == job['task']
             and tasks[0].get('status') == 'INFRA_ERROR' and tasks[0].get('passed') is False
             and set(tasks[0]) <= {'name', 'status', 'passed', 'agent_id', 'owned_roots', 'lifecycle_stage', 'failure_reason'}
             and tasks[0].get('agent_id') is None and tasks[0].get('owned_roots') in (None, [])
             and tasks[0].get('lifecycle_stage') == 'released'
             and tasks[0].get('failure_reason') == 'no current run artifact produced', 'task admission unknown')
        usage = evidence.doc(fleet / '_batch/llm-usage.json')
        need(usage.get('run_id') == fleet.name and isinstance(usage.get('providers'), dict) and usage['providers']
             and all(type(p.get('calls')) is int and p['calls'] == 0
                     and set(p) == {'calls', 'input_tokens', 'output_tokens', 'cost_usd', 'models'}
                     and all(finite(p[k]) and p[k] == 0 for k in ('input_tokens', 'output_tokens', 'cost_usd'))
                     and p['models'] == {} for p in usage['providers'].values()), 'LLM admission unknown')
        disposable = evidence.doc(fleet / '_batch/disposable-cleanup.json')
        need(disposable == {'schema': 'disposable-cleanup-v1', 'owner': token, 'guest_cleanup_missing': False,
                            'runtime_evidence_missing': False, 'successful_runtime_inferred': False}
             and all(disposable[k] is False for k in ('guest_cleanup_missing', 'runtime_evidence_missing', 'successful_runtime_inferred')),
             'original disposable facts changed')
        local, audit = fleet / 'teardown-ownership', root / '.git/cloudbench-fleet-audits' / token
        seal = evidence.tree(local)
        need(seal == evidence.tree(audit) == life['audit_sha256']
             and evidence.fields(local / 'source-audit') == {'path': str(audit), 'sha256': seal}, 'native audit seals differ')
        meta = evidence.fields(audit / 'meta')
        need(meta.get('version') == '1' and meta.get('fleet_owner_token') == token and meta.get('run_id') == fleet.name
             and re.fullmatch('[A-Za-z0-9-]+', meta.get('app', ''))
             and meta.get('workspace_root') == str(root) and meta.get('status') == 'provider-teardown-verified', 'canonical zero-resource release required')
        epoch = float(evidence.raw(audit / 'provider-teardown-verified.epoch'))
        need(math.isfinite(epoch) and stamp(job['started_at']) <= epoch <= proof['confirmed_at'], 'native release clock')
        registry = root / '.git/cloudbench-fleet-ownership' / token
        need(not registry.exists() and not registry.is_symlink(), 'native ownership registry remains')
        for name in ('owned-clones.ids', 'owned-clones.names'):
            need(evidence.raw(audit / name) == b'', 'a provider allocation was recorded')
        for name in ('fresh', 'expected-fresh', 'by-machine-id', 'pool', 'pool-handoffs', 'volume-migrations', 'archived-reuse'):
            path = audit / name
            need(not path.is_symlink() and (not path.exists() or path.is_dir() and not any(path.iterdir())), 'allocation class is not empty')
        for parent, directories, files in os.walk(fleet, followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)):
            for name in directories + files:
                item = Path(parent) / name
                need(not item.is_symlink() and name not in MARKERS, 'allocation/admission marker or symlink present')
        need(not any((fleet / n).exists() for n in ('execution-provenance.json', 'execution-task-matrix.json')), 'not an absent-input preallocation run')
        need(meta.get('hub_disposition') == 'retained-exact-owner-transfer-required', 'unknown retained Hub')
        hub_paths.add(Path(meta['hub_owner_file']))
        hub = evidence.fields(meta['hub_owner_file'])
        need(all(hub.get(k) == meta.get('hub_' + k) for k in ('pid', 'pid_start', 'argv_sha256', 'owner_token')), 'fleet Hub identity differs')
    need({p for p in runs.iterdir() if p.name != '_hub'} == parents and len(controllers) == len(jobs), 'participant closure')
    groups_absent(controllers)
    inventory = campaign / 'shared-inventory'
    need(evidence.raw(inventory / 'stop') == b'' and not (inventory / 'owner').exists()
         and not (inventory / 'owner').is_symlink(), 'inventory publisher still owns namespace')
    publication(root, receipt, proof, evidence, campaign, summary, finish)
    hubs(root, proof, evidence, runs, hub_paths, lifecycles, finish)
    logs += [p for p in (campaign / 'shared-inventory/publisher.private.log', campaign / 'hub-group-publication.private.log') if p.exists()]
    for path in logs:
        evidence.raw(path)
    no_holders([*logs, folder / 'output.log', folder / 'stderr.log'])


def publication(root, receipt, proof, evidence, campaign, summary, finish):
    recovery = Path(proof['publication_recovery'])
    need(recovery.is_absolute() and recovery.resolve() == recovery and recovery != campaign, 'separate native publication recovery required')
    native_path, _ = policy(root, receipt, proof, evidence, 'scripts/run-bench-campaign.py')
    policy(root, receipt, proof, evidence, 'agents/benchmarks/hub_upload.py')
    recovery_receipt, owner = (evidence.doc(recovery / n) for n in ('receipt.json', 'owner.json'))
    originals = {}
    for name in ('summary.json', 'hub-group.json', 'hub-group-publication-ack.private.json'):
        raw = evidence.raw(campaign / name)
        need(evidence.raw(recovery / ('original-' + name)) == raw, 'original publication evidence changed')
        originals[name] = hashlib.sha256(raw).hexdigest()
    need(evidence.raw(recovery / 'hub-group.json') == evidence.raw(campaign / 'hub-group.json'), 'recovery changed original record')
    need(type(recovery_receipt.get('native_exit')) is int and recovery_receipt['native_exit'] == 0 and recovery_receipt.get('verified') is True
         and recovery_receipt.get('original_bytes_unchanged') == originals
         and recovery_receipt.get('campaign') == str(campaign) and recovery_receipt.get('record_sha256') == originals['hub-group.json']
         and recovery_receipt.get('ack_path') == str(recovery / 'hub-group-publication-ack.private.json')
         and recovery_receipt.get('benchmark_execution_credit') is False
         and recovery_receipt.get('guest_or_provider_resource_operation') is False, 'native publication recovery receipt required')
    start, end = recovery_receipt['started_at'], recovery_receipt['finished_at']
    need(finite(start) and finite(end) and max(finish, receipt['finished_at']) <= start <= end <= proof['confirmed_at']
         and owner.get('started_at') == start and owner.get('source') == receipt['source']['head']
         and owner.get('native_producer') == 'agents/benchmarks/hub_upload.py --upload-final'
         and owner.get('original_campaign') == str(campaign), 'native publication identity/clock')
    ack = evidence.doc(recovery / 'hub-group-publication-ack.private.json')
    need(owner.get('pid') == ack.get('pid'), 'publisher identity differs')
    from deploy_test_cloud import campaign_published
    need(campaign_published(summary, recovery, receipt['started_at'], runpy.run_path(str(native_path))), 'native publication ACK or quiescence failed')
    log = recovery / 'native-publisher.private.log'
    need(('uploaded run bundle to hub: ' + campaign.name) in evidence.raw(log).decode(), 'native publication result missing')
    no_holders([log])


def hubs(root, proof, evidence, runs, expected, lifecycles, finish):
    need(len(expected) == 1, 'one exact shared Hub required')
    path, = expected
    need(path.parent == runs / '_hub', 'original Hub namespace differs')
    boundary, retirement = evidence.doc(proof['hub_consumers']), evidence.doc(proof['hub_retirement'])
    need(boundary.get('runs') == str(runs) and boundary.get('owner') == str(path)
         and boundary.get('owner_sha256') == evidence.bindings[str(path)]
         and boundary.get('remaining_external_process_references') == []
         and isinstance(boundary.get('consumer_disposition'), str) and boundary['consumer_disposition'].strip()
         and {r['lifecycle']: r['sha256'] for r in boundary['borrowers']} == lifecycles
         and len(boundary['borrowers']) == len(lifecycles)
         and all(r.get('status') == 'failed' and r.get('controller_exit_code') == 143 for r in boundary['borrowers']), 'exact terminal consumer boundary required')
    rows = retirement.get('rows')
    need(isinstance(rows, list) and len(rows) == 1 and retirement.get('provider_operations') is False
         and retirement.get('historical_runtime_financial_obligations_unchanged') is True, 'native Hub retirement required')
    row = rows[0]
    owner = evidence.fields(path)
    need(owner.get('status') == 'live-transfer-required' and str(row.get('port')) == owner.get('port'),
         'original live Hub identity required')
    terminal_path = Path(str(path) + '.terminal')
    terminal = evidence.fields(terminal_path)
    need(row.get('owner') == str(path) and row.get('owner_sha256') == evidence.bindings[str(path)]
         and row.get('terminal') == str(terminal_path) and row.get('terminal_sha256') == evidence.bindings[str(terminal_path)]
         and type(row.get('native_exit')) is int and row['native_exit'] == 0 and row.get('immutable_owner_unchanged') is True
         and row.get('borrowers_terminal') == len(lifecycles)
         and terminal.get('owner_file') == str(path) and terminal.get('owner_sha256') == evidence.bindings[str(path)]
         and terminal.get('version') == '1' and terminal.get('disposition') == 'terminated-verified'
         and all(terminal.get(k) == owner.get(k) for k in ('pid', 'pid_start', 'pgid', 'owner_token'))
         and finite(boundary.get('observed_at')) and finite(row.get('started_at')) and finite(row.get('finished_at'))
         and finish <= boundary['observed_at'] <= row['started_at'] <= stamp(terminal['terminated_at'])
         <= row['finished_at'] <= proof['confirmed_at'], 'exact original Hub terminal receipt required')
    ports, pids = set(), set()
    for path in (runs / '_hub').glob('*.owner'):
        value = evidence.fields(path)
        need(value.get('version') == '1' and value.get('root') == value.get('runs_root') == str(runs)
             and value.get('repo_root') == str(root) and value.get('context_dir') == str(runs / '_hub')
             and value.get('command') == str(root / 'agents/benchmarks/agent_link_server.py')
             and value.get('host') == '127.0.0.1' and value.get('pid') == value.get('pgid')
             and value.get('pid_start') and re.fullmatch('[0-9a-f]{32}', value.get('owner_token', ''))
             and re.fullmatch('[0-9a-f]{64}', value.get('argv_sha256', ''))
             and value.get('status') in {'starting', 'live-transfer-required'}, 'original Hub owner changed')
        need(path.name == 'agent-link-server.' + value['port'] + '.' + value['owner_token'] + '.owner'
             and (path in expected or value['status'] == 'starting'), 'unexpected additional live Hub authority')
        ports.add(int(value['port']))
        pids.add(int(value['pid']))
    need(ports and all(0 < p < 65536 for p in ports), 'Hub ports unknown')
    groups_absent(pids)
    namespace_quiet(runs.parent, ports)


def validate(state, receipt, proof, gate, *, relocations=None):
    from deploy_test_cycle import digest
    need(set(proof) <= {'kind', 'root', 'files', 'confirmed_at', 'observed_by', 'producer_files',
                        'publication_recovery', 'hub_consumers', 'hub_retirement'} and proof.get('kind') == KIND,
         'typed custody fields required')
    need(finite(proof['confirmed_at']) and finite(receipt.get('finished_at'))
         and receipt['finished_at'] <= proof['confirmed_at'] <= time.time()
         and isinstance(proof.get('observed_by'), str) and proof['observed_by'].strip(), 'independent confirmation required')
    root = Path(proof['root'])
    need(root.is_absolute() and root.resolve(strict=True) == root
         and subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip() == str(root), 'original canonical root required')
    need(receipt.get('executed') is True and receipt.get('complete') is False and receipt.get('status') == 'FAIL'
         and receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and receipt.get('lingering_group') is True and receipt.get('worker_result') is None
         and receipt.get('native_cleanup_reference') is None and receipt.get('command') == gate['command']
         and receipt.get('cases') == {name: 'UNVERIFIED' for name in gate['checks']}
         and receipt.get('execution_binding', {}).get('contract_digest') == digest(gate)
         and all(re.fullmatch('[0-9a-f]{64}', receipt.get('execution_binding', {}).get(k, ''))
                 for k in ('input_fingerprint', 'environment'))
         and re.fullmatch('[0-9a-f]{40}', receipt['source']['head'])
         and re.fullmatch('[0-9a-f]{64}', receipt['source']['digest']), 'original incomplete execution binding required')
    folder = Path(receipt['log']).parent
    need(folder.is_relative_to(root / '.context/deploy-pipeline/attempts') and folder.name == gate['name']
         and Path(receipt['log']) == folder / 'output.log'
         and not any((folder / n).exists() or (folder / n).is_symlink() for n in ('result.json', 'output.log.process.json.watchdog.json')),
         'original adapter must remain absent')
    evidence = Evidence(proof['files'], relocations)
    request = evidence.doc(folder / 'request.json')
    need(evidence.doc(folder / 'receipt.json') == receipt
         and all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
         and request.get('checks') == gate['checks'] and request.get('skips') == {}
         and request.get('phase') == folder.parent.name, 'original request/receipt inventory changed')
    evidence.raw(folder / 'output.log')
    evidence.raw(folder / 'stderr.log')
    if receipt['gate'] == 'smoke':
        cloud(root, gate, receipt, folder, proof, evidence)
    else:
        need(set(proof) == {'kind', 'root', 'files', 'confirmed_at', 'observed_by'}, 'static proof scope')
        static_worker(root, gate, receipt, folder, evidence)
    return {'kind': KIND, 'gate': receipt['gate'], 'token': receipt['token'], 'execution_gate': copy.deepcopy(gate),
            'proof': copy.deepcopy(proof), 'credit_granted': False, 'financial_cleanup_credit': False,
            'original_outcomes_preserved': True}


def reconcile(state, request_token, proof):
    from deploy_test_cycle import interrupted_receipt, sha_file
    receipt = interrupted_receipt(state, request_token)
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    try:
        entry = validate(state, receipt, proof, gate)
        entry['occurrence'] = request_token
        key = sha_file(Path(receipt['log']).parent / 'receipt.json')
        need(not any(e.get('token') == request_token and k != key
                     for k, e in state.get('reconciled_owners', {}).items()), 'original token already reconciled elsewhere')
        previous = state.get('reconciled_owners', {}).get(key)
        need(previous is None or previous == entry, 'existing reconciliation must remain unchanged')
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
        raise ValueError('interrupted custody proof refused: ' + str(error)) from error
    state.setdefault('reconciled_owners', {})[key] = entry


def policy_relocations(entry, receipt):
    """Only already-bound historical producer bytes may replace mutable source witnesses."""
    from deploy_test_cycle import digest, sha_file
    renewal = entry.get('policy_witness_renewal')
    if renewal is None:
        return {}
    need(isinstance(renewal, dict) and set(renewal) == {'previous', 'request'}, 'renewal history required')
    previous, request = renewal['previous'], renewal['request']
    need(isinstance(previous, dict) and isinstance(request, dict)
         and entry == {**previous, 'policy_witness_renewal': renewal}, 'original reconciliation changed')
    need(set(request) == {'kind', 'receipt_sha256', 'previous_entry_sha256', 'relocations', 'confirmed_at', 'observed_by'}
         and request['kind'] == RENEWAL_KIND and request['previous_entry_sha256'] == digest(previous)
         and request['receipt_sha256'] == sha_file(Path(receipt['log']).parent / 'receipt.json')
         and finite(request['confirmed_at']) and previous['proof']['confirmed_at'] <= request['confirmed_at'] <= time.time()
         and isinstance(request['observed_by'], str) and request['observed_by'].strip(), 'exact historical renewal binding required')
    relocations = policy_relocations(previous, receipt)
    changes = request['relocations']
    updated = dict(relocations)
    proof, root = previous['proof'], Path(previous['proof']['root'])
    namespace = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    need(previous.get('kind') == KIND and previous.get('gate') == receipt['gate'] == 'smoke'
         and re.fullmatch('[0-9a-f]{40}', receipt.get('source', {}).get('head', ''))
         and isinstance(changes, dict) and changes, 'cloud policy relocation required')
    previous_time = previous.get('policy_witness_renewal', {}).get('request', {}).get('confirmed_at', proof['confirmed_at'])
    need(previous_time <= request['confirmed_at'], 'renewal history clock changed')
    for old, destination in changes.items():
        need(isinstance(old, str) and isinstance(destination, str), 'policy paths required')
        names = [name for name, path in proof['producer_files'].items() if path == old]
        need(len(names) == 1 and names[0] in POLICIES and Path(old) == root / names[0]
             and Path(old).resolve(strict=True) == Path(old) and not Path(old).is_symlink(), 'only original source policy may relocate')
        revision = receipt['source']['head'] + ':' + names[0]
        if destination.startswith('git:'):
            from deploy_test_cycle import MAX_RECEIPT_BYTES
            need(names[0] in {'scripts/run-bench-fleet', 'scripts/lib/cloudbench-env.sh'}, 'executed policy requires bound file')
            blob = subprocess.check_output(['git', 'rev-parse', revision], cwd=root, text=True).strip()
            need(re.fullmatch('[0-9a-f]{40}', blob) and destination == 'git:' + blob,
                 'exact original Git blob required')
            size = int(subprocess.check_output(['git', 'cat-file', '-s', blob], cwd=root))
            need(0 <= size <= MAX_RECEIPT_BYTES, 'bounded original Git policy required')
            raw = subprocess.check_output(['git', 'cat-file', 'blob', blob], cwd=root)
            need(len(raw) == size and proof['files'].get(old) == hashlib.sha256(raw).hexdigest(), 'original Git policy hash differs')
            updated[old] = raw
            continue
        target = Path(destination)
        need(target.is_relative_to(namespace) and target.resolve(strict=True) == target and not target.is_symlink()
             and old in proof['files'] and destination in proof['files']
             and proof['files'][old] == proof['files'][destination] and old != destination,
             'existing bound campaign policy witness required')
        original = subprocess.check_output(['git', 'show', receipt['source']['head'] + ':' + names[0]], cwd=root)
        need(Evidence({destination: proof['files'][destination]}).raw(target) == original,
             'original Git policy witness differs')
        updated[old] = destination
    need(updated != relocations, 'policy witness already renewed')
    return updated


def _bound(state, receipt, entry):
    from deploy_test_result import preserve_contract
    need(entry.get('occurrence') == receipt['token'], 'original interrupted token changed')
    gate = entry['execution_gate']
    current, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    preserve_contract(gate, current)
    need(all(gate.get(k) == current.get(k) for k in ('native_cloud', 'native_backend')), 'original native route changed')
    need(set(gate['checks']) <= set(current['checks']), 'original checks removed')
    actual = validate(state, receipt, entry['proof'], gate, relocations=policy_relocations(entry, receipt))
    need(actual == {k: v for k, v in entry.items() if k not in {'occurrence', 'policy_witness_renewal'}},
         'original reconciliation facts changed')
    return True


def renew_policy_witness(state, request_token, proof):
    from deploy_test_cycle import latest_receipts, sha_file, source
    need(state.get('phase') in {'quick', 'initial', 'focused', 'failed-gates', 'final', 'triage',
                               'needs-focused-plan', 'ready', 'stale', 'interrupted'}
         and not state.get('running') and 'live_failures' not in state, 'quiescent renewal boundary required')
    rows = [r for r in latest_receipts(state).values() if r.get('token') == request_token]
    need(len(rows) == 1, 'exact latest historical receipt required')
    receipt = rows[0]
    key = sha_file(Path(receipt['log']).parent / 'receipt.json')
    previous = state.get('reconciled_owners', {}).get(key)
    need(isinstance(previous, dict) and previous.get('kind') == KIND
         and previous.get('token') == request_token, 'original native reconciliation required')
    root = Path(previous['proof']['root'])
    need(source(root) == state['source'] == state['plan']['source'], 'current source binding changed')
    if previous.get('policy_witness_renewal', {}).get('request') == proof:
        _bound(state, receipt, previous)
        return  # Exact replay observes all guards without appending duplicate history.
    entry = {**copy.deepcopy(previous), 'policy_witness_renewal':
             {'previous': copy.deepcopy(previous), 'request': copy.deepcopy(proof)}}
    _bound(state, receipt, entry)
    state['reconciled_owners'][key] = entry


def still_bound(state, receipt, entry):
    try:
        return _bound(state, receipt, entry)
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        return False
