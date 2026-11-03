"""Read-only, launch-only reconciliation of sealed native cloud fleet cleanup."""
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import time

KIND = 'native-cloud-cleanup-v1'


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


def isolated_execution(fleet, life, root, receipt, proof, bound, document, tree):
    """Execution admission only; quarantined archives, finances and resources remain owned."""
    owner = life['fleet_owner_token']
    audit = root / '.git/cloudbench-fleet-audits' / owner
    meta = fields(bound(audit / 'meta'))
    need(meta.get('fleet_owner_token') == owner and meta.get('run_id') == fleet.name
         and meta.get('workspace_root') == str(root), 'isolated audit identity')
    tree(audit)
    registry = root / '.git/cloudbench-fleet-ownership' / owner
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


def validate(receipt, owner, proof):
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
    need(isinstance(bindings, dict), 'missing file bindings')

    def bound(path):
        path = Path(path)
        need(path.is_absolute() and path.resolve() == path and path.is_file() and not path.is_symlink(), 'noncanonical proof file')
        need(path.stat().st_size <= MAX_RECEIPT_BYTES, 'proof file too large')
        raw = path.read_bytes()
        need(bindings.get(str(path)) == hashlib.sha256(raw).hexdigest(), 'file hash mismatch: ' + str(path))
        used.add(str(path))
        return raw

    def document(path):
        value = json.loads(bound(path))
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
    parents = {}
    layout = proof.get('layout')
    if layout == 'campaign-v1':
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
             and reference.get('native_directory') == str(campaign)
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
        need(not any(summary.get(key) for key in
                     ('shared_transport_cleanup_pending', 'cleanup_ticket_failure', 'shared_inventory_failed')),
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
        handles = []
        for job in jobs:
            need(re.fullmatch(r'r001-j[0-9]{4}', job['job_id']), 'campaign job id')
            log = campaign / (job['job_id'] + '.log')
            need(job['log'] == str(log), 'campaign job log binding')
            one = []
            for line in bound(log).decode(errors='replace').splitlines():
                if str(root / 'scripts/run-bench') + ' monitor ' not in line:
                    continue
                args = shlex.split(line.strip())
                need(len(args) == 3 and args[:2] == [str(root / 'scripts/run-bench'), 'monitor'], 'campaign monitor binding')
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
    recovery = proof.get('recovered_runtime', {})
    need(isinstance(recovery, dict) and (not recovery or layout == 'campaign-v1'), 'recovery scope')
    from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding
    for fleet in sorted(participants):
        provenance = document(fleet / 'execution-provenance.json')
        matrix = document(fleet / 'execution-task-matrix.json')
        need(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance, matrix)
             and provenance['base_sha'] == receipt['source']['head'] and provenance['workspace_patch_sha256'] == 'none', 'execution source')
        benches = json.loads(bound(fleet / '_batch/benches.json'))
        need(isinstance(benches, list) and len(benches) == len(matrix['tasks'])
             and len({b['name'] for b in benches}) == len(benches)
             and {b['name'] for b in benches} == {t['name'] for t in matrix['tasks']}, 'native inventory')
        if fleet in parents:
            need({b['name'] for b in benches} == parents[fleet]['checks'], 'parent requested inventory')
        document(fleet / '_batch/run.json')  # Bind original outcomes without regrading them.
        life = document(fleet / '_batch/lifecycle.json')
        owner_token = life['fleet_owner_token']
        need(isinstance(owner_token, str) and re.fullmatch('[0-9a-f]{32}', owner_token), 'fleet owner')
        need(type(life.get('version')) is int and life['version'] == 1 and life['run_id'] == fleet.name
             and life['workspace_root'] == str(root) and life['hub_publication_failed'] is False
             and type(life['controller_exit_code']) is int
             and (life['controller_exit_code'] == parents[fleet]['exit'] if fleet in parents
                  else life['controller_exit_code'] == 0 and life['status'] == 'verified')
             and life['status'] in {'verified', 'failed'}, 'native terminal lifecycle')
        if isolated:
            excluded.update(isolated_execution(fleet, life, root, receipt, proof, bound, document, tree))
            continue
        audit = fleet / 'teardown-ownership'
        canonical = root / '.git/cloudbench-fleet-audits' / owner_token
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
        registry = root / '.git/cloudbench-fleet-ownership' / owner_token
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
            bound(path)  # Retain and re-hash ALL original debt evidence, including retained Hub owners.
    need(used == set(bindings), 'proof file closure')
    result = {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
            'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
            'participants': sorted(map(str, participants)), 'native_audit_seals': audit_seals,
            'retained_services': [retained[k] for k in sorted(retained)], 'credit_granted': False}
    if isolated:
        need(isinstance(proof.get('validation_source'), dict) and set(proof['validation_source']) == {'head', 'digest'}, 'next source')
        result.update(purpose='isolated-validation', validation_source=proof['validation_source'], excluded_resources=excluded,
                      obligations_preserved=True, cleanup_complete=False)
    if recovered:
        result['recovered_release_evidence'] = recovered
    return result


def reconcile(state, occurrence_id, proof):
    from deploy_test_cycle import latest_receipts, receipt_owner
    try:
        failure = next(f for f in state['failures'] if f['id'] == occurrence_id)
        gate = failure['gate']
        need(any(g['name'] == gate and g.get('native_cloud') is True for g in state['plan']['gates']), 'native_cloud gate required')
        receipt = latest_receipts(state)[gate]
        if proof.get('purpose') == 'isolated-validation':
            candidates = [r for a in state.get('attempts', []) for r in a.get('results', [])
                          if r.get('gate') == gate and r.get('token') == proof.get('request_token')]
            need(len(candidates) == 1, 'ambiguous historical receipt')
            receipt = candidates[0]
        case = failure['check'].split('/', 1)[1]
        need(failure.get('native_result') == 'UNVERIFIED' and not failure.get('complete')
             and receipt.get('complete') is False and receipt['cases'].get(case) == 'UNVERIFIED', 'latest incomplete occurrence required')
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
