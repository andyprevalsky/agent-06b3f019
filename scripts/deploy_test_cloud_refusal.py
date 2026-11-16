"""Typed launch-only retirement of an audited cloud source-guard refusal."""
import copy
import hashlib
import math
import os
import sys
import json
from pathlib import Path
import re
import subprocess
import time
from deploy_test_historical_custody import ADMISSION_REFUSALS
from deploy_test_interrupted_cleanup import Evidence, no_holders, namespace_quiet

KIND = 'cloud-source-refusal-cleanup-v1'
# Audited historical producer/import closure: refusal precedes mkdir/admission.
POLICIES = {'scripts/deploy_test_cloud.py': ('6841691abdc6ba6a83cdeccf11053c65828b7cb863193fd5eb2a2902fb5c4d49',),
 'scripts/deploy_test_cycle.py': ('fc3a86120dbd8eafa1506b6b43d7b4004c03043cb0ac76db4b9321f3d0ff3d82',),
 'scripts/deploy_test_process.py': ('68117aee616cb4f6087df187347e7a56c620e85ec7e45b8ba33af670ad867f90',),
 'scripts/cloudbench_execution_provenance.py': ('25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f',),
 'scripts/cloudbench_result.py': ('43ec01ea772df562b625aeadf1b22b677ed58f5304bb2c9de4e1c38dcefd4fa6',)}
MESSAGE = b'DEPLOY_CLOUD BLOCKED: cloud source differs from the requested freeze\n'
SOURCE_DIFFERS = 'cloud source differs from the requested freeze'


# This legacy producer emitted a plain ValueError before mkdir/capacity/provider calls.
# Keep this closed set separate from the older source-diff policy above.
LEGACY_CUSTODY_HEAD = '9915ee3ca962bb051f58e57efafca933d7823932'
LEGACY_CUSTODY_POLICIES = {
    'scripts/deploy_test_cloud.py': ('2e9e3e8c04c5c6a1913b348d9adbdc0ab8616b5c262012b421d635b4e8bcf94d',),
    'scripts/deploy_test_cycle.py': ('47a03e7e01a0668d0a47319af8085869ebc3a31adfbfdfa93f5600240bca6f37',),
    'scripts/deploy_test_process.py': ('40c7333db6fe216a6eadc1989d0e440963d6efbfce9e7d5ce28a6ec20af40078',),
    'scripts/deploy_test_historical_custody.py': ('29b8fa0af55a9debe2828c286605ef275935676b18fb545d5f890cbb2db312c3',),
    'scripts/cloudbench_execution_provenance.py': ('25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f',),
    'scripts/cloudbench_result.py': ('43ec01ea772df562b625aeadf1b22b677ed58f5304bb2c9de4e1c38dcefd4fa6',),
}
LEGACY_CUSTODY_MESSAGE = b'DEPLOY_CLOUD BLOCKED: historical custody: missing canonical custody locator\n'
LEGACY_CUSTODY_CAPTURE = {
    'source': {'head': LEGACY_CUSTODY_HEAD,
               'digest': 'c63146aafedb9975aabfe608996220c03910fea8cbf81103a0050fbc40a376a5'},
    'token': '0c0c22c980ac47bb85ea3586efc871c2',
    'locator': '/home/boxes/rose/.context/deploy-final/cycle.json',
    'request_sha256': '16ddab8c43d5a9ed686bdaec4ffca2b3a1edb7ac268ce8f5a0db5ad53172942e',
    'receipt_sha256': 'e4a9ef1b443985a5d1a1ffc9898b33e572bf7161c796e005ca4195bc3fcf1f76',
}


# Exact historical catalog refusal: no provider work preceded this immutable reader.
CATALOG_REFUSAL_OWNER_UID = 1002  # Shared checkout owner at original launch.
CATALOG_REFUSAL_UID = 0  # Original controller and evidence were root-owned.
CATALOG_REFUSAL_HEAD = 'c04bacf96b8293782ec8810fed66561448f6a289'
CATALOG_REFUSAL_MESSAGE = b"DEPLOY_CLOUD BLOCKED: browser-biometrics-webdecoy: duplicate JSON key 'quarantine' in agents/benchmarks/tasks.json\n"
CATALOG_REFUSAL_CAPTURE = {
    'source': {'head': CATALOG_REFUSAL_HEAD,
               'digest': 'fcf1674eb2aeef31cad66f45f45a58cc77470b6049ac0f4630d1958c41bda7e2'},
    'token': 'f7bbc7bc6f1441d987a1539684cf0d55',
    'locator': '/home/boxes/rose/.context/deploy-pipeline/cycle.json',
    'request_sha256': 'fdf3cd655304369f086f85f0c98502198d299e3456b9113073ad8652b5a7729c',
    'receipt_sha256': 'c57d5dcc99a74a8775d9e179ef8de0a35a986ec17171e38d91b56696ba39fc5f',
}
CATALOG_REFUSAL_POLICIES = {
    'scripts/deploy_test_native_cleanup.py': ('f3dc382e6c0b3f146fd8fe8e85d07da907a8b018cadb33d6d1f6645050444d9c',),
    'scripts/deploy_test_interrupted_cleanup.py': ('3ce7759c34eba42b538257ab9b6a24383ff2366af0a763af2487f2dcffdbd316',),
    'scripts/deploy_test_cloud.py': ('304471f41224d4d43912e8c97cfd004c1db37644872d795f25697d3c25b64ff4',),
    'scripts/deploy_test_cycle.py': ('6c3fe733644df7ff37f8f618921b0de9fc579da3aef7009a13387a5f608c78bd',),
    'scripts/deploy_test_process.py': ('54dd36312ea5a753f91d026bc7441f7e7dcb5f036de3c2c8a077ed6117848f2c',),
    'scripts/deploy_test_historical_custody.py': ('3d84641a77c5b7fe53e523bf8ea144ede2b5f45ef5614bca6d503bacc570636d',),
    'scripts/cloudbench_execution_provenance.py': ('04122d46f536923a0c8aa8e7859d6dcf1d1395e5d8a1998f6cad573a7073c6c2',),
    'scripts/cloudbench_result.py': ('43ec01ea772df562b625aeadf1b22b677ed58f5304bb2c9de4e1c38dcefd4fa6',),
    'scripts/deploy_test_quarantine.py': ('6a4fc1aaf1287ed5dbb90ddc2740b034f6bd3a6d5ea666dbb2f762ecb30ba89b',),
    'agents/benchmarks/tasks.json': ('306795a9b6a5cdb1403836d0f566e77141d4356c8d811e565f41e802bba953d5',),
}


def catalog_namespace_quiet(root, namespace, evidence_paths=()):
    """Check root producers and the original checkout owner under each real UID."""
    need(os.geteuid() == CATALOG_REFUSAL_UID, 'root visibility required for original root-owned launch')
    need(root.stat().st_uid == CATALOG_REFUSAL_OWNER_UID, 'original checkout owner changed')
    namespace_quiet(namespace, set())
    if CATALOG_REFUSAL_OWNER_UID != os.geteuid():
        # /proc deliberately hides non-dumpable processes across UIDs. Observe
        # the second owner as that owner, rather than treating EACCES as absence.
        script = ("import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
                  "import json;from deploy_test_interrupted_cleanup import namespace_quiet,no_holders;"
                  "namespace_quiet(Path(sys.argv[2]),set());paths=[Path(p) for p in json.loads(sys.argv[3])];"
                  "no_holders(paths) if paths else None")
        observed = subprocess.run(
            [sys.executable, '-B', '-c', script, str(root / 'scripts'), str(namespace),
             json.dumps([str(path) for path in evidence_paths])],
            user=CATALOG_REFUSAL_OWNER_UID, group=root.stat().st_gid, extra_groups=[],
            capture_output=True, timeout=30)
        need(observed.returncode == 0, 'checkout-owner namespace consumer or visibility failure')


def replay_catalog_refusal(root, head):
    """Replay the original strict reader against original Git bytes, never today's catalog."""
    import ast
    import json
    reader = subprocess.check_output(['git', 'show', head + ':scripts/deploy_test_quarantine.py'], cwd=root)
    catalog = subprocess.check_output(['git', 'show', head + ':agents/benchmarks/tasks.json'], cwd=root)
    for name, raw in [('scripts/deploy_test_quarantine.py', reader), ('agents/benchmarks/tasks.json', catalog)]:
        need(hashlib.sha256(raw).hexdigest() in CATALOG_REFUSAL_POLICIES[name], 'original catalog reader/input changed')
    tree = ast.parse(reader)
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name in {'_reject_duplicate_keys', 'catalog_quarantines'}]
    need(len(nodes) == 2, 'original strict reader missing')
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    scope = {'json': json, 'CATALOG': Path('agents/benchmarks/tasks.json')}
    exec(compile(ast.fix_missing_locations(module), '<original catalog reader>', 'exec'), scope)

    class ArchivedCatalog:
        def is_file(self): return True
        def read_text(self): return catalog.decode()

    class ArchivedRoot:
        def __truediv__(self, path):
            need(path == scope['CATALOG'], 'reader used another input')
            return ArchivedCatalog()

    try:
        scope['catalog_quarantines'](ArchivedRoot())
    except ValueError as error:
        need(('DEPLOY_CLOUD BLOCKED: ' + str(error) + '\n').encode() == CATALOG_REFUSAL_MESSAGE,
             'original strict reader did not reproduce recorded refusal')
        return
    raise ValueError('cloud source refusal: original strict reader did not refuse')


def legacy_custody_request(state, receipt, request, proof, evidence, folder, root):
    """Verify original request ownership, without creating a retroactive adapter receipt."""
    from deploy_test_cycle import digest, latest_receipts, read
    from deploy_test_historical_custody import state_identity
    locator = folder.parents[3] / 'cycle.json'
    snapshot_path = Path(proof['legacy_state_snapshot'])
    need(folder.resolve() == folder and folder.parents[2].name == 'attempts'
         and folder.parent.parent.name.isdigit() and folder.parent.name == request['phase']
         and folder.is_relative_to(root / '.context')
         and request.get('custody_state') == str(locator)
         and locator.is_file() and locator.resolve() == locator and not locator.is_symlink(),
         'request-owned legacy locator')
    need(snapshot_path != locator and snapshot_path.is_relative_to(root / '.context'),
         'immutable parent state snapshot required')
    catalog_refusal = receipt['source']['head'] == CATALOG_REFUSAL_HEAD
    capture = CATALOG_REFUSAL_CAPTURE if catalog_refusal else LEGACY_CUSTODY_CAPTURE
    need(receipt['source'] == capture['source'] and receipt['token'] == capture['token']
         and request.get('custody_state') == capture['locator']
         and hashlib.sha256(evidence.raw(folder / 'request.json')).hexdigest() == capture['request_sha256']
         and hashlib.sha256(evidence.raw(folder / 'receipt.json')).hexdigest() == capture['receipt_sha256'],
         'original archived capture changed')
    snapshot = evidence.doc(snapshot_path)
    current = read(locator)
    need(latest_receipts(snapshot).get('smoke') == receipt
         and latest_receipts(current).get('smoke') == receipt,
         'original latest parent receipt changed')
    need(snapshot.get('source') == receipt['source'] == snapshot.get('plan', {}).get('source')
         and digest(snapshot['plan']) == snapshot.get('plan_digest')
         and request.get('custody_state_sha256') == state_identity(snapshot),
         'original parent admission binding')
    gate, = [g for g in snapshot['plan']['gates'] if g['name'] == 'smoke']
    binding = receipt['execution_binding']
    need(digest(gate) == binding['contract_digest']
         and snapshot.get('environment') == binding.get('environment')
         and snapshot.get('input_fingerprints', {}).get('smoke') == binding.get('input_fingerprint')
         and all(isinstance(binding.get(k), str) and re.fullmatch('[0-9a-f]{64}', binding[k])
                 for k in ('environment', 'input_fingerprint')),
         'original parent environment/input binding')
    runtime = request.get('custody_runtime')
    need(isinstance(runtime, dict)
         and all(isinstance(k, str) and isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v)
                 for k, v in runtime.items())
         and isinstance(request.get('custody_child_environment'), str)
         and re.fullmatch('[0-9a-f]{64}', request['custody_child_environment']),
         'original child environment/runtime binding')
    if catalog_refusal:
        need(os.geteuid() == CATALOG_REFUSAL_UID, 'root visibility required for original root-owned launch')
        replay_catalog_refusal(root, receipt['source']['head'])
    message = CATALOG_REFUSAL_MESSAGE if catalog_refusal else LEGACY_CUSTODY_MESSAGE
    need(evidence.raw(folder / 'output.log') == message,
         'exact legacy custody refusal')


def unpushed_reason(head):
    """An unpushed requested commit: every guest fetch would refuse it at run-bench preflight (PR #1767)."""
    return (f'push {head} before gates: requested benchmark commit {head} is not fetchable from origin '
            'and cloud smoke disables local patch shipping')


def refusal_reasons(request):
    """The only typed pre-admission refusals and their reason codes; any other error keeps
    fail-closed native custody. Source refusals predate reason codes and carry none."""
    return {SOURCE_DIFFERS: None, unpushed_reason(request['source']['head']): None,
            **{message: code for code, message in ADMISSION_REFUSALS.items()}}


def refused_before_admission(result, request, gate, root, code, *, invalid_process):
    """Accept an explicit source refusal for custody only; all cases stay UNVERIFIED."""
    namespace = root / '.context/deploy-cloud' / hashlib.sha256(request['token'].encode()).hexdigest()
    return (not invalid_process and code == 2 and gate.get('native_cloud') is True
            and gate.get('worker_transport') == 'benchmark-cloud-cli'
            and len(gate['command']) == 2
            and gate['command'][1] == str(root / 'scripts/deploy_test_cloud.py')
            and all(result.get(k) == request[k] for k in ('token', 'source', 'gate'))
            and result.get('admission') == {'kind': 'cloud-source-refusal-v1', 'admitted': False}
            and result.get('cases') == dict.fromkeys(request['checks'], 'UNVERIFIED')
            and result.get('complete') is False and result.get('cleanup_complete') is True
            and result.get('reused') is False and result.get('native_exit') == 2
            and result.get('native_command') == [] and result.get('fleet_directory') is None
            and result.get('evidence') == {} and not result.get('cleanup_owner')
            and result.get('reason') in refusal_reasons(request)
            and result.get('reason_code') == refusal_reasons(request)[result['reason']]
            and namespace.resolve() == namespace and not any(p.is_symlink() for p in (root / '.context', namespace.parent, namespace))
            and not namespace.exists())


def need(value, message):
    if not value:
        raise ValueError('cloud source refusal: ' + message)


def validate(state, receipt, proof):
    from deploy_test_cycle import digest, latest_receipts
    legacy = 'legacy_state_snapshot' in proof
    keys = {'kind', 'root', 'request_token', 'files', 'confirmed_at', 'observed_by'}
    need(set(proof) == keys | ({'legacy_state_snapshot'} if legacy else set())
         and proof['kind'] == KIND, 'typed proof required')
    root = Path(proof['root'])
    need(root.is_absolute() and root.resolve(strict=True) == root
         and subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root,
                                     text=True).strip() == str(root), 'canonical root')
    token = receipt.get('token')
    need(isinstance(token, str) and re.fullmatch('[0-9a-f]{32}', token)
         and proof['request_token'] == token, 'request token')
    current_gate, = [g for g in state['plan']['gates'] if g['name'] == 'smoke']
    gate = current_gate
    if legacy:
        # Like other historical cleanup proofs, bind the old execution contract;
        # refreshed selection evidence is not an old native execution fact.
        from deploy_test_result import preserve_contract
        snapshot = Evidence(proof['files']).doc(Path(proof['legacy_state_snapshot']))
        gate, = [g for g in snapshot['plan']['gates'] if g['name'] == 'smoke']
        preserve_contract(gate, current_gate)
        need(all(gate.get(k) == current_gate.get(k) for k in
                 ('checks', 'native_cloud', 'native_backend')), 'legacy execution contract changed')
    need(latest_receipts(state).get('smoke') == receipt, 'latest retained receipt')
    need(gate.get('category') == 'smoke' and gate.get('native_cloud') is True
         and gate.get('worker_transport') == 'benchmark-cloud-cli'
         and gate.get('cwd') == str(root) and not gate.get('env')
         and len(gate['command']) == 2 and Path(gate['command'][0]).name.startswith('python3')
         and gate['command'][1] == str(root / 'scripts/deploy_test_cloud.py')
         and receipt.get('command') == gate['command']
         and receipt.get('execution_binding', {}).get('contract_digest') == digest(gate), 'original cloud contract')
    need(receipt.get('gate') == 'smoke' and receipt.get('native_exit') == 2
         and receipt.get('executed') is True and receipt.get('status') == 'FAIL'
         and receipt.get('complete') is False and receipt.get('lifecycle') == 'native-producer'
         and receipt.get('timed_out') is False and receipt.get('cancelled') is False
         and receipt.get('lingering_group') is True and receipt.get('worker_result') is None
         and receipt.get('native_cleanup_reference') is None
         and receipt.get('cases') == dict.fromkeys(gate['checks'], 'UNVERIFIED')
         and receipt.get('case_complete') == dict.fromkeys(gate['checks'], False), 'exact refused outcome')
    owner = {'request_token': token, 'worker_root': str(root), 'native_cleanup_reference': None}
    need(receipt.get('cleanup_owner') == owner and not receipt.get('resource_skips')
         and not receipt.get('worker_evidence') and not receipt.get('isolated_validation'), 'original owner')
    source = receipt['source']
    need(re.fullmatch('[0-9a-f]{40}', source['head'])
         and re.fullmatch('[0-9a-f]{64}', source['digest']), 'original source')
    if legacy:
        need(source['head'] in (LEGACY_CUSTODY_HEAD, CATALOG_REFUSAL_HEAD), 'unaudited legacy source')
    policies = (CATALOG_REFUSAL_POLICIES if legacy and source['head'] == CATALOG_REFUSAL_HEAD
                else LEGACY_CUSTODY_POLICIES if legacy else POLICIES)
    for name, expected in policies.items():
        original = subprocess.check_output(['git', 'show', source['head'] + ':' + name], cwd=root)
        need(hashlib.sha256(original).hexdigest() in expected, 'unaudited producer: ' + name)
    folder = Path(receipt['log']).parent
    need((legacy or folder.is_relative_to(root / '.context/deploy-pipeline/attempts'))
         and folder.name == 'smoke' and receipt['log'] == str(folder / 'output.log')
         and receipt['stderr_log'] == str(folder / 'stderr.log'), 'original evidence namespace')
    names = ('request.json', 'receipt.json', 'output.log', 'stderr.log')
    paths = {str(folder / name) for name in names}
    if legacy:
        paths.add(proof['legacy_state_snapshot'])
    need(set(proof['files']) == paths, 'complete exact evidence inventory')
    evidence = Evidence(proof['files'])
    need(evidence.doc(folder / 'receipt.json') == receipt, 'receipt bytes')
    request = evidence.doc(folder / 'request.json')
    need(all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
         and request.get('checks') == gate['checks'] and request.get('skips') == {}
         and request.get('phase') == folder.parent.name, 'request binding')
    if legacy:
        legacy_custody_request(state, receipt, request, proof, evidence, folder, root)
    else:
        need(evidence.raw(folder / 'output.log') == MESSAGE, 'exact source-guard refusal')
    need(evidence.raw(folder / 'stderr.log') == b'', 'original stderr changed')
    confirmed = proof['confirmed_at']
    if legacy:
        need(all(type(value) in (int, float) and math.isfinite(value) and value > 0
                 for value in (receipt['started_at'], receipt['finished_at'], confirmed)),
             'finite legacy timestamps required')
    need(type(confirmed) in (int, float) and receipt['started_at'] <= receipt['finished_at'] <= confirmed <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'confirmation clock')
    namespace = root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest()
    need(namespace.resolve() == namespace
         and not any(path.is_symlink() for path in (root / '.context', namespace.parent, namespace))
         and not namespace.exists(), 'request was admitted or namespace ambiguous')
    need(not (folder / 'result.json').exists() and not (folder / 'result.json').is_symlink(), 'adapter must remain absent')
    no_holders([Path(path) for path in paths])
    if legacy and source['head'] == CATALOG_REFUSAL_HEAD:
        catalog_namespace_quiet(root, namespace, paths)
    else:
        namespace_quiet(namespace, set())
    return {'kind': KIND, 'gate': 'smoke', 'token': token, 'owner': copy.deepcopy(owner),
            'execution_gate': copy.deepcopy(gate), 'proof': copy.deepcopy(proof),
            'credit_granted': False, 'financial_cleanup_credit': False, 'original_outcomes_preserved': True}


def reconcile(state, token, proof):
    from deploy_test_cycle import latest_receipts, sha_file
    need(not state.get('running') and 'live_failures' not in state, 'quiescent coordinator required')
    receipt = latest_receipts(state).get('smoke', {})
    need(receipt.get('token') == token, 'latest token')
    entry = validate(state, receipt, proof)
    key = sha_file(Path(receipt['log']).parent / 'receipt.json')
    need(not any(e.get('token') == token and k != key for k, e in state.get('reconciled_owners', {}).items()),
         'token already bound elsewhere')
    previous = state.get('reconciled_owners', {}).get(key)
    need(previous is None or previous == entry, 'existing reconciliation must remain unchanged')
    state.setdefault('reconciled_owners', {})[key] = entry


def still_bound(state, receipt, entry):
    try:
        return validate(state, receipt, entry['proof']) == entry
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        return False
