#!/usr/bin/env python3
"""Offline tests for the github-actions (Blacksmith) deploy gate executor binding.

Covers deploy_test_bindings (argv generation), deploy_test_isolation (exact-argv
acceptance and fail-closed rejection), deploy_test_plan (a plan with
github-actions slots validates) and deploy_gates --executor blacksmith (which
gates leave this host, their runner sizes, and the unchanged local fallback).
The launcher (scripts/deploy_test_github.py) is exercised offline: tag naming, the
request envelope round trip through a real annotated tag object, runner-side
validation, run lookup against a fake GitHub API, and receipts the cycle accepts.
"""
from contextlib import redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_gates as g
import deploy_test_plan as p
from deploy_test_bindings import generate
from deploy_test_cycle import validate_plan
import deploy_test_isolation as iso
import deploy_test_github as gh
from deploy_test_result import validate as validate_result

ROOT = p.ROOT
LAUNCHER = str(ROOT / 'scripts/deploy_test_github.py')
RUNNER = 'blacksmith-8vcpu-ubuntu-2404'


def template():
    return {'gates': [
        {'name': name, 'category': name, 'command': ['true'], 'checks': [name]}
        for name in ('format', 'eslint', 'typescript', 'backend-structural')
    ] + [
        {'name': 'frontend-coverage-blackbox', 'category': 'frontend-coverage-blackbox',
         'command': ['npm', 'run', 'test:coverage'], 'cwd': 'front-end', 'env': {'KEEP': '1'},
         'checks': ['frontend-coverage-blackbox']},
        {'name': 'backend-coverage-blackbox', 'category': 'backend-coverage-blackbox', 'native_backend': True,
         'case_protocol': True, 'command': ['python3', 'scripts/deploy_test_backend.py'],
         'checks': ['unit:a', 'blackbox:b']},
        {'name': 'smoke', 'category': 'smoke', 'command': ['bash', 'scripts/run-predeploy-cloud'],
         'checks': ['smoke']},
    ]}


def backend_recipe(env=None):
    case = {'command': ['npm', 'run', 'test:coverage:sharded'], 'cwd': 'back-end', 'env': dict(env or {}),
            'aggregate': False, 'sweep': 'backend-coverage-blackbox'}
    return {'cases': {'unit:a': dict(case), 'blackbox:b': dict(case)}, 'execution_timeout_seconds': 900}


def slot(gate, runner=RUNNER, **extra):
    value = {'id': f'{gate}-blacksmith', 'transport': 'github-actions', 'runner': runner,
             'worker_root': iso.GITHUB_WORKER_ROOT, 'timeout_seconds': 900,
             'env': {'CONDUCTOR_WORKSPACE_NAME': f'deploy-{gate}', 'CONDUCTOR_PORT': '12000'}}
    value.update(extra)
    return value


def expected_argv(runner, script, timeout=900):
    return [sys.executable, LAUNCHER, '--runner', runner, '--worker-script', script,
            '--worker-root', iso.GITHUB_WORKER_ROOT, '--deadline-seconds', str(timeout)]


class Bindings(unittest.TestCase):
    def test_single_case_gate_gets_the_exact_launcher_argv_and_its_full_command_as_recipe(self):
        binding = generate(template(), {'frontend-coverage-blackbox': slot('frontend-coverage-blackbox')},
                           ROOT)['frontend-coverage-blackbox']
        self.assertEqual(expected_argv(RUNNER, 'deploy_test_worker.py'), binding['command'])
        self.assertEqual(('file', 900, iso.GITHUB_WORKER_ROOT, str(ROOT)),
                         (binding['result_transport'], binding['timeout_seconds'], binding['worker_root'],
                          binding['cwd']))
        case = binding['recipe']['cases']['frontend-coverage-blackbox']
        self.assertEqual((['npm', 'run', 'test:coverage'], 'front-end', True),
                         (case['command'], case['cwd'], case['aggregate']))
        self.assertEqual({'KEEP': '1', 'CONDUCTOR_WORKSPACE_NAME': 'deploy-frontend-coverage-blackbox',
                          'CONDUCTOR_PORT': '12000'}, case['env'])

    def test_native_backend_uses_the_backend_worker_script_and_its_frozen_recipe(self):
        with patch('deploy_test_backend.sweep_from_recipe') as sweep:
            binding = generate(template(), {'backend-coverage-blackbox': slot(
                'backend-coverage-blackbox', 'blacksmith-16vcpu-ubuntu-2404', recipe=backend_recipe())},
                ROOT)['backend-coverage-blackbox']
        sweep.assert_called_once()
        self.assertEqual(expected_argv('blacksmith-16vcpu-ubuntu-2404', 'deploy_test_backend.py'),
                         binding['command'])
        self.assertEqual(backend_recipe(), binding['recipe'])
        self.assertEqual('file', binding['result_transport'])

    def test_inventory_contract_is_refused_before_any_plan_exists(self):
        cases = {
            'runner checkout': ({'worker_root': '/tmp/elsewhere'}, 'runner checkout'),
            'missing runner': ({'runner': None}, 'Blacksmith Ubuntu 24.04 runner label'),
            'foreign runner': ({'runner': 'ubuntu-latest'}, 'Blacksmith Ubuntu 24.04 runner label'),
            'odd size': ({'runner': 'blacksmith-6vcpu-ubuntu-2404'}, 'Blacksmith Ubuntu 24.04 runner label'),
            'old image': ({'runner': 'blacksmith-4vcpu-ubuntu-2204'}, 'Blacksmith Ubuntu 24.04 runner label'),
            'no deadline': ({'timeout_seconds': None}, 'existing gate deadline'),
            'relative root': ({'worker_root': 'home/runner/_work/rose/rose'}, 'must be absolute'),
        }
        for label, (change, message) in cases.items():
            value = slot('frontend-coverage-blackbox')
            value.update(change)
            if value['timeout_seconds'] is None:
                del value['timeout_seconds']
            with self.subTest(label), self.assertRaisesRegex(ValueError, message):
                generate(template(), {'frontend-coverage-blackbox': value}, ROOT)

    def test_smoke_cannot_be_bound_to_blacksmith(self):
        # Smoke (AgentCard lifecycle tasks included) runs on the Fly fleet through the benchmark CLI.
        with self.assertRaisesRegex(ValueError, 'smoke: smoke stays on the cloud benchmark CLI'):
            generate(template(), {'smoke': slot('smoke')}, ROOT)

    def test_multi_case_gate_without_its_recipe_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'slot still carries the single-case aggregate recipe'):
            generate(template(), {'backend-coverage-blackbox': slot('backend-coverage-blackbox')}, ROOT)


class Portable(unittest.TestCase):
    def test_remote_recipes_use_the_runner_interpreter_not_the_coordinator_path(self):
        from deploy_test_bindings import portable
        recipe = {'cases': {'c': {'command': [sys.executable, 'scripts/x.py'], 'cwd': '.'},
                            'd': {'command': ['npm', 'run', 't'], 'cwd': 'back-end'}},
                  'setup': {'command': ['/opt/py/bin/python3.11', '-V']}}
        out = portable(recipe)
        self.assertEqual(out['cases']['c']['command'], ['python3', 'scripts/x.py'])
        self.assertEqual(out['cases']['d']['command'], ['npm', 'run', 't'])
        self.assertEqual(out['setup']['command'], ['python3', '-V'])
        self.assertEqual(recipe['cases']['c']['command'][0], sys.executable)  # input untouched


class Isolation(unittest.TestCase):
    def setUp(self):
        self.source = patch.object(p, 'source', return_value={'head': 'fixed', 'digest': 'fixed'})
        self.source.start()
        self.addCleanup(self.source.stop)
        self.result = {'all': True, 'reasons': ['fixture'], 'lanes': {lane: [] for lanes in p.GRAPH_LANES.values()
                                                                       for lane in lanes}}
        self.inventory = {'frontend-coverage-blackbox': slot('frontend-coverage-blackbox'),
                          'backend-coverage-blackbox': slot('backend-coverage-blackbox',
                                                            'blacksmith-16vcpu-ubuntu-2404',
                                                            recipe=backend_recipe()),
                          'smoke': {'id': 'cloud-smoke-worker', 'transport': 'benchmark-cloud-cli'}}

    def plan(self):
        with patch('deploy_test_backend.sweep_from_recipe'):
            bindings = generate(template(), self.inventory, ROOT)
        return p.select(template(), ['back-end/src/one.ts'], self.result, bindings)

    def gate(self, plan, name):
        return next(gate for gate in plan['gates'] if gate['name'] == name)

    def test_plan_with_github_slots_validates_beside_cloud_smoke(self):
        plan = self.plan()
        validate_plan(plan, ROOT)
        frontend, backend = self.gate(plan, 'frontend-coverage-blackbox'), self.gate(plan, 'backend-coverage-blackbox')
        for gate in (frontend, backend):
            self.assertEqual(('github-actions', iso.GITHUB_WORKER_ROOT, True, 'file', 900),
                             (gate['worker_transport'], gate['worker_root'], gate['case_protocol'],
                              gate['result_transport'], gate['timeout_seconds']))
        self.assertEqual('deploy_test_backend.py', backend['command'][backend['command'].index('--worker-script') + 1])
        self.assertEqual('benchmark-cloud-cli', self.gate(plan, 'smoke')['worker_transport'])
        self.assertNotIn('agentcard-lifecycle', {gate['name'] for gate in plan['gates']})

    def test_every_vm_owns_its_ports_and_workspace_so_identical_identities_are_accepted(self):
        for value in self.inventory.values():
            if value['transport'] == 'github-actions':
                value['env'] = {'CONDUCTOR_WORKSPACE_NAME': 'deploy-gate', 'CONDUCTOR_PORT': '12000'}
        validate_plan(self.plan(), ROOT)

    def test_identity_is_still_required(self):
        self.inventory['frontend-coverage-blackbox']['env'] = {}
        with self.assertRaisesRegex(ValueError, 'explicit isolated workspace'):
            validate_plan(self.plan(), ROOT)

    def test_saved_plans_fail_closed_on_any_drift_from_the_bound_contract(self):
        def argv(gate, index, value):
            gate['command'][index] = value

        mutations = {
            'other launcher': (lambda gate: argv(gate, 1, str(ROOT / 'scripts/deploy_test_boxes.py')),
                               'argv must bind the launcher'),
            'foreign runner': (lambda gate: argv(gate, 3, 'ubuntu-latest'), 'runner label'),
            'missing runner flag': (lambda gate: gate['command'].__setitem__(2, '--machine'), 'runner label'),
            'backend script on another gate': (lambda gate: argv(gate, 5, 'deploy_test_backend.py'),
                                               'argv must bind'),
            'other root': (lambda gate: gate.update(worker_root='/srv/rose'), 'runner checkout'),
            'root argv drift': (lambda gate: argv(gate, 7, '/srv/rose'), 'argv must bind'),
            'deadline drift': (lambda gate: argv(gate, 9, '60'), 'argv must bind'),
            'no deadline': (lambda gate: gate.pop('timeout_seconds'), 'existing gate deadline'),
            'stdout receipts': (lambda gate: gate.update(result_transport='stdout'), 'receipt protocol'),
            'no recipe': (lambda gate: gate.pop('worker_recipe'), 'receipt protocol'),
            'no case protocol': (lambda gate: gate.update(case_protocol=False), 'receipt protocol'),
            'extra argument': (lambda gate: gate['command'].append('--reuse'), 'argv must bind'),
            'native backend elsewhere': (lambda gate: gate.update(native_backend=True),
                                         'restricted to the backend coverage gate'),
        }
        for label, (mutate, message) in mutations.items():
            plan = self.plan()
            mutate(self.gate(plan, 'frontend-coverage-blackbox'))
            with self.subTest(label), self.assertRaisesRegex(ValueError, message):
                iso.validate(plan, ROOT)

    def test_saved_backend_plan_must_keep_the_backend_worker_script(self):
        plan = self.plan()
        backend = self.gate(plan, 'backend-coverage-blackbox')
        backend['command'][backend['command'].index('--worker-script') + 1] = 'deploy_test_worker.py'
        with self.assertRaisesRegex(ValueError, 'argv must bind'):
            iso.validate(plan, ROOT)

    def test_saved_plan_cannot_move_smoke_onto_blacksmith(self):
        for name in ('smoke',):
            plan = self.plan()
            frontend = self.gate(plan, 'frontend-coverage-blackbox')
            target = self.gate(plan, name)
            target.update({k: copy.deepcopy(frontend[k]) for k in
                           ('command', 'worker_transport', 'worker_root', 'case_protocol', 'result_transport',
                            'timeout_seconds', 'worker_recipe', 'env')})
            with self.subTest(name), self.assertRaisesRegex(ValueError, 'stays on the cloud benchmark CLI'):
                iso.validate(plan, ROOT)

    def test_runner_sizes_accepted_by_the_validator(self):
        for size in (2, 4, 8, 16, 32):
            self.assertTrue(iso.GITHUB_RUNNER.fullmatch(f'blacksmith-{size}vcpu-ubuntu-2404'))
        for label in ('blacksmith-64vcpu-ubuntu-2404', 'blacksmith-4vcpu-ubuntu-2404-arm',
                      'blacksmith-6vcpu-macos-26', 'ubuntu-24.04', ' blacksmith-4vcpu-ubuntu-2404'):
            self.assertIsNone(iso.GITHUB_RUNNER.fullmatch(label), label)


def standard(host=()):
    return {'gates': [
        {'name': 'format', 'category': 'format', 'command': ['python3', 'scripts/check_deploy_static.py', 'format'],
         'checks': ['format']},
        {'name': 'deploy-command-structural', 'category': 'deploy-command-structural', 'cwd': '.', 'env': {},
         'command': ['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '5'],
         'checks': ['deploy-command-structural']},
        {'name': 'semantic-stack', 'category': 'semantic-stack', 'cwd': '.', 'env': {'KEEP': '1'},
         'command': ['bash', 'scripts/run-deploy-semantic-stack.sh'], 'checks': ['semantic-stack']},
    ]}


class Executor(unittest.TestCase):
    """deploy_gates --executor blacksmith (default) vs --executor local."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        top = Path(self.tmp.name).resolve()
        self.root, self.workers = top / 'rose', top / 'workers'
        self.root.mkdir()
        for argv in (['git', 'init', '-q'], ['git', 'commit', '-q', '--allow-empty', '-m', 'one']):
            subprocess.run(argv, cwd=self.root, check=True, capture_output=True,
                           env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x',
                                'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x'})
        self.head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.root, check=True, capture_output=True,
                                   text=True).stdout.strip()
        environ = patch.dict(os.environ, {'DEPLOY_WORKER_ROOT': str(self.workers)})
        environ.start()
        self.addCleanup(environ.stop)
        recipe = patch.object(g, 'backend_recipe', lambda root, env, timeout: {'sentinel': timeout, 'env': env})
        recipe.start()
        self.addCleanup(recipe.stop)
        self.gates = ['backend-coverage-blackbox', 'smoke', 'frontend-coverage-blackbox',
                      'deploy-command-structural', 'semantic-stack', 'brand-new-gate']

    def test_blacksmith_moves_every_gate_but_smoke_off_this_host(self):
        self.assertEqual(frozenset({'smoke'}), g.BLACKSMITH_LOCAL_GATES)
        workers = {w['gate']: w for w in g.layout(self.root, self.head, self.gates, 'blacksmith')}
        self.assertEqual({'cloud': ['smoke'], 'create': [],
                          'remote': ['backend-coverage-blackbox', 'frontend-coverage-blackbox',
                                     'deploy-command-structural', 'semantic-stack', 'brand-new-gate']},
                         {mode: [n for n, w in workers.items() if w['mode'] == mode]
                          for mode in ('cloud', 'create', 'remote')})
        frontend = workers['frontend-coverage-blackbox']['slot']
        self.assertEqual({'id': 'frontend-coverage-blackbox-blacksmith', 'transport': 'github-actions',
                          'runner': 'blacksmith-4vcpu-ubuntu-2404', 'worker_root': '/home/runner/_work/rose/rose',
                          'env': {'CONDUCTOR_WORKSPACE_NAME': 'deploy-frontend-coverage-blackbox',
                                  'CONDUCTOR_PORT': g.REMOTE_PORT},
                          'timeout_seconds': g.GATE_DEADLINE_SECONDS}, frontend)
        backend = workers['backend-coverage-blackbox']['slot']
        self.assertEqual('blacksmith-16vcpu-ubuntu-2404', backend['runner'])
        self.assertEqual({'sentinel': g.GATE_DEADLINE_SECONDS, 'env': backend['env']}, backend['recipe'])
        self.assertEqual(g.DEFAULT_BLACKSMITH_RUNNER, workers['brand-new-gate']['slot']['runner'])
        for worker in workers.values():
            if worker['mode'] == 'remote':  # coordinator paths never leave this host
                self.assertEqual({'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_PORT'}, set(worker['slot']['env']))
        self.assertFalse(self.workers.exists())  # layout itself never creates anything

    def test_runner_map_names_real_gates_with_valid_labels(self):
        names = {gate['name'] for gate in p.standard_template()['gates']}
        self.assertEqual(set(), set(g.BLACKSMITH_RUNNERS) - names)
        self.assertEqual(set(), names - set(g.BLACKSMITH_RUNNERS) - g.BLACKSMITH_LOCAL_GATES
                         - {gate['name'] for gate in p.standard_template()['gates']
                            if gate.get('category', gate['name']) in p.QUICK or gate.get('platform') == 'darwin'})
        for label in (*g.BLACKSMITH_RUNNERS.values(), g.DEFAULT_BLACKSMITH_RUNNER):
            self.assertTrue(iso.GITHUB_RUNNER.fullmatch(label), label)
        self.assertEqual('blacksmith-16vcpu-ubuntu-2404', g.BLACKSMITH_RUNNERS['backend-coverage-blackbox'])
        for gate in ('agents-coverage-blackbox', 'deploy-command-structural', 'semantic-stack'):
            self.assertEqual('blacksmith-8vcpu-ubuntu-2404', g.BLACKSMITH_RUNNERS[gate])
        for gate in ('frontend-coverage-blackbox', 'cloudbench-controller', 'seed-memory-ratchet'):
            self.assertEqual('blacksmith-4vcpu-ubuntu-2404', g.BLACKSMITH_RUNNERS[gate])
        for gate in ('seed-cache-decision', 'canonical-seed-whatsapp-content', 'live-probes', 'e2b-smoke'):
            self.assertEqual('blacksmith-2vcpu-ubuntu-2404', g.BLACKSMITH_RUNNERS[gate])

    def test_blacksmith_inventory_provisions_only_the_local_gates(self):
        workers = g.layout(self.root, self.head, self.gates, 'blacksmith')
        provisioned = []

        def fake(root, gate, path, head, mode, logs, lock):
            provisioned.append(gate)
            return {'id': f'{gate}-local', 'transport': 'local-isolated',
                    'env': {'CONDUCTOR_WORKSPACE_NAME': gate, 'CONDUCTOR_PORT': g.REMOTE_PORT}}

        with patch.object(g, 'provision', fake):
            inventory = g.build_inventory(self.root, self.head, workers, self.root / '.context/w')
        self.assertEqual([], provisioned)
        self.assertEqual(self.gates, list(inventory))
        self.assertEqual('github-actions', inventory['semantic-stack']['transport'])
        self.assertEqual(g.CLOUD_SLOT, inventory['smoke'])
        self.assertEqual([], g.footprint_conflicts(inventory))

    def test_local_executor_layout_is_unchanged(self):
        default = g.layout(self.root, self.head, self.gates)
        self.assertEqual(default, g.layout(self.root, self.head, self.gates, 'local'))
        self.assertEqual({'smoke': 'cloud'}, {w['gate']: w['mode'] for w in default if w['mode'] != 'create'})
        with self.assertRaises(g.Blocked):
            g.layout(self.root, self.head, self.gates, 'elsewhere')

    def test_blacksmith_keeps_standard_concurrency_and_local_keeps_the_host_cuts(self):
        self.assertEqual(standard(), g.build_template(2, 2, standard, executor='blacksmith'))
        local = g.build_template(2, 2, standard, executor='local')
        self.assertEqual(local, g.build_template(2, 2, standard))
        structural = next(gate for gate in local['gates'] if gate['name'] == 'deploy-command-structural')
        semantic = next(gate for gate in local['gates'] if gate['name'] == 'semantic-stack')
        self.assertEqual('2', structural['command'][-1])
        self.assertEqual('2', semantic['env'][g.SEMANTIC_ENV])

    def test_cli_defaults_to_blacksmith_and_refuses_host_cuts_there(self):
        with patch.object(g, 'run', return_value=0) as run, patch.object(g, 'ROOT', self.root):
            g.main([])
            self.assertEqual('blacksmith', run.call_args[0][0].executor)
            g.main(['--executor', 'local', '--structural-workers', '3'])
            self.assertEqual(('local', 3), (run.call_args[0][0].executor, run.call_args[0][0].structural_workers))
        for bad in (['--structural-workers', '3'], ['--semantic-worker-processes', '4'],
                    ['--executor', 'blacksmith', '--structural-workers', '5'], ['--executor', 'ssh']):
            with self.subTest(bad=bad), redirect_stdout(io.StringIO()), \
                    patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                g.main(bad)

    def test_capacity_counts_only_gates_this_host_runs(self):
        seen = []
        selection = {'selected': ['format', 'semantic-stack', 'smoke'], 'quick': ['format'],
                     'needs_worker': ['semantic-stack', 'smoke'], 'omitted': []}
        args = dict(base='origin/main', state_dir=None, dry_run=True, provision_jobs=4,
                    head=None, rca_launcher=None, structural_workers=g.STRUCTURAL_WORKERS,
                    semantic_worker_processes=g.SEMANTIC_WORKER_PROCESSES, sample_memory=None,
                    abort_below_mb=None, executor='blacksmith')
        from types import SimpleNamespace
        # Cloud smoke is selected, so gates refuse an unpushed HEAD; this fixture's HEAD is treated as pushed.
        with patch.object(g, 'list_selected', return_value=selection), \
                patch.object(g, 'unpushed_smoke_refusal', return_value=None), \
                patch.object(g, 'standard_template', standard), \
                patch.object(g, 'check_capacity', lambda root, workers, proc=None: seen.append(
                    [w['gate'] for w in workers]) or {'memory_mb': 0, 'available_mb': 0, 'disk_mb': 0,
                                                      'free_disk_mb': 0}):
            output = io.StringIO()
            with redirect_stdout(output):
                code = g.run(SimpleNamespace(**args), self.root)
        self.assertEqual(0, code)
        self.assertEqual([['smoke']], seen)
        *body, summary = output.getvalue().strip().splitlines()
        self.assertEqual(f'DEPLOY_GATES DRY-RUN head={self.head[:12]} gates=3 workers=0 remote=1', summary)
        shown = json.loads('\n'.join(body))
        self.assertEqual('blacksmith', shown['executor'])
        self.assertEqual('standard', shown['template']['concurrency'])


def git_repo(path):
    subprocess.run(['git', 'init', '-q', str(path)], check=True)
    (path / 'f.txt').write_text('x')
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@t', 'GIT_AUTHOR_DATE': '1700000000 +0000', 'GIT_COMMITTER_DATE': '1700000000 +0000'}
    subprocess.run(['git', 'add', '.'], cwd=path, check=True)
    subprocess.run(['git', 'commit', '-qm', 'c'], cwd=path, check=True, env=env)
    return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=path, check=True, capture_output=True, text=True).stdout.strip()


def remote_request(head, root=gh.REMOTE_ROOT, gate='frontend-coverage-blackbox'):
    return {'token': 'tok-1', 'source': {'head': head, 'digest': 'd'}, 'gate': gate, 'checks': [gate],
            'skips': {}, 'phase': 'initial', 'worker_root': root,
            'worker_recipe': {'cases': {gate: {'command': ['true'], 'cwd': '.', 'aggregate': True}}}}


class Launcher(unittest.TestCase):
    def test_tag_names_carry_the_runner_size_and_are_stable_per_request(self):
        name = gh.tag_name('blacksmith-16vcpu-ubuntu-2404', 'backend coverage/x', 'tok')
        self.assertTrue(name.startswith('deploy-gates/16vcpu/backend-coverage-x-'))
        self.assertEqual(name, gh.tag_name('blacksmith-16vcpu-ubuntu-2404', 'backend coverage/x', 'tok'))
        self.assertNotEqual(name, gh.tag_name('blacksmith-16vcpu-ubuntu-2404', 'backend coverage/x', 'tok2'))
        with self.assertRaises(ValueError):
            gh.tag_name('ubuntu-latest', 'g', 'tok')

    def test_envelope_binds_the_runner_root_and_a_known_worker(self):
        with self.assertRaises(ValueError):
            gh.envelope(remote_request('a' * 40, root='/elsewhere'), 'deploy_test_worker.py', RUNNER)
        with self.assertRaises(ValueError):
            gh.envelope(remote_request('a' * 40), 'rm.py', RUNNER)

    def test_request_round_trips_through_a_deterministic_annotated_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            head = git_repo(root)
            message = gh.envelope(remote_request(head), 'deploy_test_worker.py', RUNNER)
            raw = gh.tag_object(root, head, 'deploy-gates/8vcpu/x', message)
            self.assertEqual(raw, gh.tag_object(root, head, 'deploy-gates/8vcpu/x', message))
            fields, body = gh.parse_tag(raw)
            self.assertEqual((fields['object'], fields['type']), (head, 'commit'))
            self.assertEqual(json.loads(body)['request']['source']['head'], head)

    def run_extract(self, root, request, runner=RUNNER, script='deploy_test_worker.py', name=None):
        name = name or gh.tag_name(runner, request['gate'], request['token'])
        body = (json.dumps({'version': gh.ENVELOPE_VERSION, 'worker_script': script, 'runner': runner,
                            'request': request}) + '\n').encode()
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, check=True, capture_output=True,
                              text=True).stdout.strip()
        sha = subprocess.run(['git', 'hash-object', '-t', 'tag', '-w', '--stdin'], cwd=root, check=True,
                             capture_output=True, input=gh.tag_object(root, head, name, body)).stdout.decode().strip()
        subprocess.run(['git', 'update-ref', gh.REQUEST_REF, sha], cwd=root, check=True)
        out = root / '.out'
        cwd = os.getcwd()
        os.chdir(root)
        try:
            with redirect_stdout(io.StringIO()):
                gh.main(['remote-extract', '--ref', f'refs/tags/{name}', '--out', str(out)])
        finally:
            os.chdir(cwd)
        return out

    def test_runner_extracts_only_a_request_for_this_checkout_and_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            head = git_repo(root)
            out = self.run_extract(root, remote_request(head, root=str(root)))
            self.assertEqual(json.loads((out / 'request.json').read_text())['gate'], 'frontend-coverage-blackbox')
            self.assertEqual((out / 'worker_script').read_text(), 'deploy_test_worker.py')
            for bad in (remote_request('b' * 40, root=str(root)), remote_request(head, root='/other')):
                with self.assertRaises(SystemExit):
                    self.run_extract(root, bad)
            with self.assertRaises(SystemExit):
                self.run_extract(root, remote_request(head, root=str(root)), name='deploy-gates/8vcpu/forged')

    def test_blocked_receipts_validate_as_unverified_and_carry_any_retained_owner(self):
        request = remote_request('c' * 40)
        result = gh.blocked(request, 'never started')
        cases, complete = validate_result(result, request, 1)
        self.assertEqual((cases, complete), ({request['gate']: 'UNVERIFIED'}, False))
        owned = gh.blocked(request, 'cancel unconfirmed', owner={'transport': 'github-actions', 'run_id': 7, 'url': 'u'})
        self.assertEqual(owned['cleanup_owner']['run_id'], 7)
        with self.assertRaises(ValueError):  # unconfirmed teardown never validates as clean
            validate_result(owned, request, 1)

    def test_evidence_logs_point_at_the_downloaded_artifact_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp)
            local = artifact / 'files/.context/deploy-worker/h/a.log'
            local.parent.mkdir(parents=True)
            local.write_text('log')
            result = {'evidence': {'c': {'log': gh.REMOTE_ROOT + '/.context/deploy-worker/h/a.log'},
                                   'd': {'log': '/etc/passwd'}}}
            gh.localize_logs(result, artifact)
            self.assertEqual(result['evidence']['c']['log'], str(local))
            self.assertEqual(result['evidence']['c']['remote_log'], gh.REMOTE_ROOT + '/.context/deploy-worker/h/a.log')
            self.assertEqual(result['evidence']['d']['log'], '/etc/passwd')

    def test_capped_bundle_keeps_server_logs_before_bulk_coverage_json(self):
        # The PR #1762 shard-2 artifact dropped its 10 MB server log: 3,000 raw V8
        # and replay-cache JSON files, each smaller, had filled the 400 MB budget first.
        with tempfile.TemporaryDirectory() as tmp:
            root, out = Path(tmp) / 'repo', Path(tmp) / 'out'
            coverage = root / 'back-end/coverage'
            coverage.mkdir(parents=True)
            (coverage / 'server-shard2.log').write_bytes(b'l' * 1000)
            raw = root / '.context/test-runs/backend-coverage-failed-x/raw-v8'
            raw.mkdir(parents=True)
            for index in range(10):
                (raw / f'coverage-{index}.json').write_bytes(b'j' * 300)
            out.mkdir()
            with patch.object(gh, 'ROOT', root), patch.object(gh, 'BUNDLE_TOTAL_BYTES', 2000), \
                    patch.object(gh, 'publish_done'):
                gh.remote_bundle(type('Args', (), {'out': out})())
            self.assertTrue((out / 'artifact/files/back-end/coverage/server-shard2.log').is_file())
            skipped = {row['path'] for row in json.loads((out / 'artifact/bundle.json').read_text())['skipped']}
            self.assertNotIn('back-end/coverage/server-shard2.log', skipped)
            self.assertEqual(len(skipped), 7)  # 1000 B of log, then three 300 B JSON files fit

    def test_run_lookup_matches_the_tag_and_reports_a_rejected_workflow(self):
        head, name = 'd' * 40, 'deploy-gates/4vcpu/g-1'

        class Fake:
            def __init__(self, runs):
                self.runs = runs

            def json(self, path, conditional=False):
                wanted = gh.urllib.parse.parse_qs(gh.urllib.parse.urlsplit(path).query).get('branch')
                return {'workflow_runs': [r for r in self.runs if not wanted or r.get('head_branch') == wanted[0]]}

        mine = {'id': 9, 'path': gh.WORKFLOW_PATH, 'head_branch': name}
        other = {'id': 8, 'path': gh.WORKFLOW_PATH, 'head_branch': 'deploy-gates/4vcpu/other'}
        self.assertEqual(gh.find_run(Fake([other, mine]), head, name, gh.time.time() + 5, 0)['id'], 9)
        rejected = {'id': 7, 'path': gh.WORKFLOW_PATH, 'head_branch': None, 'conclusion': 'failure',
                    'created_at': '2030-01-01T00:00:00Z', 'html_url': 'u'}
        clock = iter(range(0, 10_000, 10))  # every reading advances 10 s
        with patch.object(gh.time, 'time', side_effect=lambda: next(clock)), patch.object(gh.STOP, 'wait'):
            with self.assertRaises(gh.WorkflowRejected):
                gh.find_run(Fake([rejected]), head, name, 100, 0)


class FakeS3:
    """In-memory stand-in for the boto3 S3 client the result channel uses."""

    class Missing(Exception):
        response = {'Error': {'Code': 'NoSuchKey'}}

    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body):
        self.objects[(Bucket, Key)] = Body

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise self.Missing()
        return {'Body': io.BytesIO(self.objects[(Bucket, Key)])}

    def list_objects_v2(self, Bucket, Prefix):
        return {'Contents': [{'Key': k} for b, k in self.objects if b == Bucket and k.startswith(Prefix)]}

    def delete_objects(self, Bucket, Delete):
        for item in Delete['Objects']:
            self.objects.pop((Bucket, item['Key']), None)


class ResultChannel(unittest.TestCase):
    def channel(self):
        return gh.Channel({'R2_BUCKET_TRACE_ARCHIVE': 'b'}, client=FakeS3())

    def test_objects_round_trip_under_the_tag_prefix_and_are_deleted_together(self):
        channel = self.channel()
        digest = channel.put('deploy-gates/2vcpu/g-1', 'result.json', b'{}')
        self.assertEqual(digest, __import__('hashlib').sha256(b'{}').hexdigest())
        self.assertEqual(channel.get('deploy-gates/2vcpu/g-1', 'result.json'), b'{}')
        self.assertIsNone(channel.get('deploy-gates/2vcpu/g-1', 'done.json'))
        channel.put('deploy-gates/2vcpu/other', 'done.json', b'1')
        channel.delete('deploy-gates/2vcpu/g-1')
        self.assertIsNone(channel.get('deploy-gates/2vcpu/g-1', 'result.json'))
        self.assertEqual(channel.get('deploy-gates/2vcpu/other', 'done.json'), b'1')

    def test_missing_credentials_fall_back_to_the_rest_path(self):
        with self.assertRaises(ValueError):
            gh.Channel({})

    def test_done_marker_is_written_last_with_every_object_digest(self):
        channel = self.channel()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / 'artifact').mkdir()
            (out / 'artifact' / 'result.json').write_text('{"ok": 1}')
            (out / 'result.json').write_text('{"ok": 1}')
            env = {'GITHUB_REF_NAME': 'deploy-gates/2vcpu/g-1', 'GITHUB_RUN_ID': '42', 'GITHUB_REPOSITORY': 'o/r'}
            writes = []
            original = channel.put
            channel.put = lambda name, leaf, data: (writes.append(leaf), original(name, leaf, data))[1]
            with patch.dict(os.environ, env), patch.object(gh, 'Channel', return_value=channel):
                gh.publish_done(out, out / 'artifact')
            self.assertEqual(writes[-1], 'done.json')
            done = json.loads(channel.get('deploy-gates/2vcpu/g-1', 'done.json'))
            self.assertEqual(done['run_id'], 42)
            for leaf, digest in done['objects'].items():
                self.assertEqual(__import__('hashlib').sha256(channel.get('deploy-gates/2vcpu/g-1', leaf)).hexdigest(),
                                 digest)

    def test_watch_returns_on_done_and_asks_github_only_for_a_silent_channel(self):
        channel = self.channel()
        name = 'deploy-gates/4vcpu/g-1'
        channel.put(name, 'started.json', json.dumps({'run_id': 5, 'url': 'u'}).encode())
        channel.put(name, 'done.json', json.dumps({'run_id': 5, 'objects': {}, 'at': 1}).encode())

        class NoGitHub:
            def json(self, *a, **k):
                raise AssertionError('the channel path must not call the GitHub API')

        with redirect_stdout(io.StringIO()):
            outcome = gh.watch_channel(NoGitHub(), channel, 'h', name, gh.time.time() + 60, 0)
        self.assertEqual((outcome['kind'], outcome['receipt']['run_id']), ('channel', 5))
        silent = self.channel()
        with patch.object(gh, 'START_SECONDS', 0), patch.object(gh, 'find_run', return_value=None), \
                patch.object(gh.STOP, 'wait'):
            self.assertEqual(gh.watch_channel(NoGitHub(), silent, 'h', name, gh.time.time() + 60, 0)['kind'],
                             'never-started')


    def test_vm_streams_only_complete_progress_rows_and_survives_upload_errors(self):
        channel, name = self.channel(), 'deploy-gates/4vcpu/g-1'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'progress.jsonl'
            gh.progress.report('t1', 'FAIL', path=path)
            with path.open('ab') as stream:
                stream.write(b'{"v":1,"partial')
            streamer = gh.ProgressStreamer(channel, name, path)
            streamer.flush()
            self.assertEqual(1, len(gh.progress.parse(channel.get(name, 'progress.jsonl'))))
            self.assertTrue(channel.get(name, 'progress.jsonl').endswith(b'\n'))
            broken = gh.ProgressStreamer(type('Broken', (), {'put': lambda *a: 1 / 0})(), name, path)
            with redirect_stdout(io.StringIO()) as out:
                broken.flush()
                broken.flush()
            self.assertEqual(1, out.getvalue().count('DEPLOY_GATE_PROGRESS upload failed'))

    def test_coordinator_mirrors_each_new_progress_row_once_before_the_result(self):
        channel, name = self.channel(), 'deploy-gates/4vcpu/g-1'
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / 'progress.jsonl'
            mirror = gh.ProgressMirror(str(local))
            row = (json.dumps(gh.progress.row('t1', 'FAIL')) + '\n').encode()
            channel.put(name, 'progress.jsonl', row + b'{"v":1')
            self.assertEqual(len(row), mirror.pull(channel, name))
            self.assertEqual(0, mirror.pull(channel, name))  # nothing new; a partial line waits
            second = (json.dumps(gh.progress.row('t2', 'FAIL')) + '\n').encode()
            channel.put(name, 'progress.jsonl', row + second)
            mirror.pull(channel, name)
            self.assertEqual(['t1', 't2'], [r['unit'] for r in gh.progress.read_new(local)[0]])
            self.assertEqual(0, gh.ProgressMirror(None).pull(channel, name))

            final = gh.ProgressMirror(str(Path(tmp) / 'final.jsonl'))
            channel.put(name, 'started.json', json.dumps({'run_id': 5, 'url': 'u'}).encode())
            channel.put(name, 'done.json', json.dumps({'run_id': 5, 'objects': {}, 'at': 1}).encode())
            with redirect_stdout(io.StringIO()):
                gh.watch_channel(None, channel, 'h', name, gh.time.time() + 60, 0, final)
            self.assertEqual(['t1', 't2'], [r['unit'] for r in gh.progress.read_new(final.path)[0]])

    def test_remote_run_streams_a_failing_test_while_the_worker_is_still_running(self):
        channel, name = self.channel(), 'deploy-gates/4vcpu/g-1'
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / 'timing.json').write_text('{}')
            (out / 'worker_script').write_text('deploy_test_worker.py')
            (out / 'request.json').write_text(json.dumps({'token': 't'}))
            seen_while_running = []

            def fake_run(argv, **kwargs):
                if argv[0] == 'bash':
                    return subprocess.CompletedProcess(argv, 0)
                gh.progress.report('t1', 'FAIL', path=kwargs['env'][gh.progress.ENV])
                deadline = gh.time.time() + 5
                while channel.get(name, 'progress.jsonl') is None and gh.time.time() < deadline:
                    gh.time.sleep(0.02)
                seen_while_running.append(channel.get(name, 'progress.jsonl') is not None)
                return subprocess.CompletedProcess(argv, 1)

            with patch.dict(os.environ, {'GITHUB_REF_NAME': name}), patch.object(gh, 'Channel', return_value=channel), \
                    patch.object(gh, 'env_file_values', return_value={}), patch.object(gh, 'STREAM_SECONDS', 0.02), \
                    patch.object(gh.subprocess, 'run', side_effect=fake_run), redirect_stdout(io.StringIO()):
                self.assertEqual(0, gh.remote_run(type('Args', (), {'out': out})()))
            self.assertEqual([True], seen_while_running)
            self.assertEqual(1, json.loads((out / 'timing.json').read_text())['worker_exit'])


class RestQuota(unittest.TestCase):
    """A shared-token rate limit waits for the reset GitHub reports, never a fixed 300 s, and never past the deadline."""

    def limited(self, headers: dict, body: bytes = b'{"message": "API rate limit exceeded for user"}'):
        from email.message import Message
        message = Message()
        for key, value in headers.items():
            message[key] = value
        return gh.urllib.error.HTTPError('https://api.github.com/x', 403, 'Forbidden', message, io.BytesIO(body))

    def run_request(self, client, outcomes, now=1_000_000.0):
        class Response:
            status, headers = 200, {}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"ok": true}'

        class Opener:
            def open(self, req, timeout):
                outcome = outcomes.pop(0)
                if isinstance(outcome, Exception):
                    raise outcome
                return Response()

        pauses = []
        with patch.object(gh.urllib.request, 'build_opener', return_value=Opener()), \
             patch.object(gh.time, 'time', return_value=now), patch.object(gh.STOP, 'wait', side_effect=pauses.append), \
             redirect_stdout(io.StringIO()) as out:
            result = client.request('GET', '/actions/runs/1')
        return result, pauses, out.getvalue()

    def test_waits_until_the_reported_primary_reset_not_a_fixed_300_seconds(self):
        client = gh.GitHub('t', 'acme/rose')
        (status, _, _), pauses, out = self.run_request(
            client, [self.limited({'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1001234'}), None])
        self.assertEqual(status, 200)
        self.assertEqual(pauses, [1235.0])
        self.assertEqual(client.rate_limited_seconds, 1235.0)
        self.assertIn('DEPLOY_GATE_RATE_LIMITED waiting 1235s (until 1970-01-12T14:07:15Z)', out)

    def test_a_secondary_limit_waits_for_its_retry_after(self):
        client = gh.GitHub('t', 'acme/rose')
        secondary = self.limited({'Retry-After': '7'}, b'{"message": "You have exceeded a secondary rate limit"}')
        _, pauses, _ = self.run_request(client, [secondary, None])
        self.assertEqual(pauses, [7.0])
        _, pauses, _ = self.run_request(client, [self.limited({}), None])
        self.assertEqual(pauses, [60.0], 'a limit naming no reset waits the documented minute')

    def test_the_wait_is_capped_by_the_callers_deadline_and_then_raises(self):
        client = gh.GitHub('t', 'acme/rose', deadline=1_000_100.0)
        reset = {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1003600'}
        _, pauses, _ = self.run_request(client, [self.limited(reset), None])
        self.assertEqual(pauses, [100.0])
        with self.assertRaises(gh.urllib.error.HTTPError):
            self.run_request(client, [self.limited(reset)], now=1_000_100.0)

    def test_the_cancel_poll_is_conditional(self):
        polled = []

        class Fake:
            def request(self, method, path, **kwargs):
                return 202, {}, b''

            def json(self, path, conditional=False):
                polled.append(conditional)
                return {'status': 'completed' if len(polled) > 2 else 'in_progress'}

        with patch.object(gh.time, 'sleep'):
            self.assertEqual(gh.cancel_run(Fake(), 1)['status'], 'completed')
        self.assertEqual(polled, [True, True, True])


class PoolReads(unittest.TestCase):
    """Reads use the token-pool member with the most quota; writes keep the launch identity.

    A pool member's 401/403/404 is not authoritative (it may lack access) and its rate limit is not the
    launch identity's, so the read is retried with the launch token; that token's answer stays final.
    """

    def http_error(self, code, body=b'{}', headers=None):
        from email.message import Message
        message = Message()
        for key, value in (headers or {}).items():
            message[key] = value
        return gh.urllib.error.HTTPError('https://api.github.com/x', code, 'x', message, io.BytesIO(body))

    def client(self, behave, picks=(('GITHUB_APP', 'pool'),), now=1_000_000.0):
        """A GitHub client whose transport calls behave(method, token, if_none_match) for every request."""
        seen, pauses, queue = [], [], list(picks)

        class Response:
            def __init__(self, status, headers, body):
                self.status, self.headers, self.body = status, headers, body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return self.body

        class Opener:
            def open(self, req, timeout):
                token = req.get_header('Authorization').removeprefix('Bearer ')
                etag = req.get_header('If-none-match')
                seen.append((req.get_method(), token, etag))
                outcome = behave(req.get_method(), token, etag)
                if isinstance(outcome, Exception):
                    raise outcome
                return Response(*outcome)

        client = gh.GitHub('launch', 'acme/rose', read_picker=lambda: queue.pop(0) if queue else None)
        patches = [patch.object(gh.urllib.request, 'build_opener', return_value=Opener()),
                   patch.object(gh.time, 'time', return_value=now),
                   patch.object(gh.STOP, 'wait', side_effect=pauses.append)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return client, seen, pauses

    def ok(self, body=b'{"ok": 1}', headers=None):
        return 200, dict(headers or {}), body

    def test_reads_use_the_pool_member_and_writes_keep_the_launch_identity(self):
        client, seen, _ = self.client(lambda method, token, etag: self.ok())
        client.request('GET', '/actions/runs/1')
        client.request('POST', '/actions/runs/1/cancel')
        self.assertEqual([('GET', 'pool', None), ('POST', 'launch', None)], seen)
        self.assertEqual(('GITHUB_APP', 0), (client.read_name, client.read_fallbacks))

    def test_a_pool_404_403_or_401_is_retried_with_the_launch_token_whose_404_is_final(self):
        for code in (404, 403, 401):
            client, seen, _ = self.client(
                lambda method, token, etag, code=code: self.http_error(code) if token == 'pool' else self.ok())
            self.assertEqual(200, client.request('GET', '/actions/runs/1/artifacts')[0])
            self.assertEqual(['pool', 'launch'], [token for _, token, _ in seen], code)
            self.assertEqual(1, client.read_fallbacks)
        client, seen, _ = self.client(lambda method, token, etag: self.http_error(404))
        with self.assertRaises(gh.urllib.error.HTTPError) as raised:
            client.request('GET', '/actions/runs/1')
        self.assertEqual(404, raised.exception.code)
        self.assertEqual(['pool', 'launch'], [token for _, token, _ in seen])

    def test_a_drained_pool_member_asks_the_launch_token_before_the_existing_reset_wait(self):
        limit = b'{"message": "API rate limit exceeded"}'
        reset = {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1000010'}
        client, seen, pauses = self.client(
            lambda method, token, etag: self.http_error(403, limit, reset) if token == 'pool' else self.ok())
        with redirect_stdout(io.StringIO()):
            self.assertEqual(200, client.request('GET', '/actions/runs/1')[0])
        self.assertEqual(([], ['pool', 'launch']), (pauses, [token for _, token, _ in seen]))
        # Both identities drained: the unchanged wait until X-RateLimit-Reset, then the pool member first again.
        calls = []

        def both(method, token, etag):
            calls.append(token)
            return self.http_error(403, limit, reset) if len(calls) <= 2 else self.ok()

        client, seen, pauses = self.client(both, picks=(('GITHUB_APP', 'pool'), ('GITHUB_TOKEN_2', 'pool2')))
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(200, client.request('GET', '/actions/runs/1')[0])
        self.assertEqual([11.0], pauses)
        self.assertEqual(11.0, client.rate_limited_seconds)
        self.assertIn('DEPLOY_GATE_RATE_LIMITED waiting 11s', out.getvalue())
        self.assertEqual(['pool', 'launch', 'pool2'], calls, 'the drained member is re-picked after the wait')

    def test_etags_and_cached_bodies_are_per_identity_so_a_304_stays_free(self):
        tags = {'pool': '"p"', 'launch': '"l"'}

        def behave(method, token, etag):
            if etag == tags[token]:
                return self.http_error(304)
            if etag is not None:
                raise AssertionError(f'{token} was sent another identity\'s ETag')
            return self.ok(json.dumps({'who': token}).encode(), {'ETag': tags[token]})

        client, seen, _ = self.client(behave)
        self.assertEqual({'who': 'pool'}, client.json('/actions/runs/1', conditional=True))
        self.assertEqual({'who': 'pool'}, client.json('/actions/runs/1', conditional=True))
        self.assertEqual(('GET', 'pool', '"p"'), seen[-1])
        client.read_token = 'launch'  # the pool now picks the launch identity: its own ETag, never the pool's
        self.assertEqual({'who': 'launch'}, client.json('/actions/runs/1', conditional=True))
        self.assertEqual(('GET', 'launch', None), seen[-1])
        self.assertEqual({'who': 'launch'}, client.json('/actions/runs/1', conditional=True))
        self.assertEqual(('GET', 'launch', '"l"'), seen[-1])

    def test_the_read_member_is_re_picked_when_low_stale_or_rejected(self):
        client, seen, _ = self.client(lambda method, token, etag: self.ok(headers={'X-RateLimit-Remaining': '50'}),
                                      picks=(('GITHUB_APP', 'pool'), ('GITHUB_TOKEN_2', 'pool2')))
        client.request('GET', '/a')
        client.request('GET', '/b')  # remaining 50 < READ_LOW_REMAINING, but a re-pick waits a minute
        self.assertEqual(['pool', 'pool'], [token for _, token, _ in seen])
        client.read_attempted_at -= gh.READ_REPICK_RETRY_SECONDS
        client.request('GET', '/c')
        self.assertEqual(('pool2', 'GITHUB_TOKEN_2'), (seen[-1][1], client.read_name))
        client, seen, _ = self.client(lambda method, token, etag: self.ok(), picks=(('A', 'pool'),))
        client.request('GET', '/a')
        client.read_picked_at -= gh.READ_REPICK_SECONDS
        client.read_attempted_at -= gh.READ_REPICK_SECONDS
        client.request('GET', '/b')  # stale, and the pool has nothing better: the old member stays
        self.assertEqual(['pool', 'pool'], [token for _, token, _ in seen])

    def test_no_picker_or_a_pick_of_the_launch_token_reads_with_the_launch_token(self):
        client, seen, _ = self.client(lambda method, token, etag: self.ok(), picks=(('GITHUB_TOKEN', 'launch'),))
        client.request('GET', '/a')
        self.assertEqual([('GET', 'launch', None)], seen)
        plain = gh.GitHub('launch', 'acme/rose')
        self.assertEqual(['launch'], plain.tokens('GET'))

    def test_pick_read_member_uses_core_quota_and_fails_open_to_the_launch_token(self):
        import github_token_pool as pool
        calls = []

        def fake_pick(resource, repo_root=None, timeout=None):
            calls.append((resource, repo_root))
            return pool.Member('GITHUB_APP', 'pool')

        with patch.object(pool, 'pick_member', fake_pick), patch.dict(os.environ, {'DEPLOY_GATE_GITHUB_POOL': '1'}):
            self.assertEqual(('GITHUB_APP', 'pool'), gh.pick_read_member(ROOT))
        self.assertEqual([('core', ROOT)], calls)
        with patch.object(pool, 'pick_member', side_effect=RuntimeError('probe')), \
                redirect_stdout(io.StringIO()) as out:
            self.assertIsNone(gh.pick_read_member(ROOT))
        self.assertNotIn('pool', out.getvalue().split('(')[0].lower().replace('deploy_gate_github_pool', ''))
        with patch.object(pool, 'pick_member', fake_pick), patch.dict(os.environ, {'DEPLOY_GATE_GITHUB_POOL': '0'}):
            self.assertIsNone(gh.pick_read_member(ROOT))
        self.assertEqual(1, len(calls))


class TagPush(unittest.TestCase):
    def test_a_transient_remote_rejection_is_retried_with_the_same_tag_object(self):
        calls = []

        def fake_git(root, *args, env=None, input_bytes=None):
            calls.append(args[0])
            if args[0] == 'hash-object':
                return 'a' * 40
            if args[0] == 'ls-remote':
                return ''
            if args[0] == 'push' and calls.count('push') == 1:
                raise subprocess.CalledProcessError(1, 'git push', stderr=b'! [remote rejected] (failed)')
            return ''

        with patch.object(gh, 'git', side_effect=fake_git), patch.object(gh.time, 'sleep'):
            self.assertEqual(gh.push_tag(ROOT, 't', 'o/r', 'deploy-gates/2vcpu/g-1', b'tag'), 'a' * 40)
        self.assertEqual(calls.count('push'), 2)

    def test_a_tag_naming_a_different_request_is_refused_not_overwritten(self):
        with patch.object(gh, 'git', side_effect=lambda root, *a, **k: 'a' * 40 if a[0] == 'hash-object'
                          else ('b' * 40 + '\trefs/tags/x') if a[0] == 'ls-remote' else ''):
            with self.assertRaises(ValueError):
                gh.push_tag(ROOT, 't', 'o/r', 'x', b'tag')


# A real launcher process (scripts/deploy_test_github.py main) whose network edges are fakes: GitHub REST
# calls and R2 channel reads are answered in-process and appended to FAKE_LOG. No live API is reached.
LAUNCHER_FAKE = r"""
import io, hashlib, json, os, sys, zipfile
from pathlib import Path
sys.path.insert(0, os.environ['FAKE_ROOT'] + '/scripts')
import deploy_test_github as gh
LOG, RUN, FOREIGN = Path(os.environ['FAKE_LOG']), 42452647149, 42452640000
STATE = {'cancelled': False, 'name': None}
REQUEST = json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text())

def note(**row):
    with LOG.open('a') as stream:
        stream.write(json.dumps(row) + '\n')

def artifact():
    result = {k: REQUEST[k] for k in ('token', 'source', 'gate')}
    result.update(cases={c: 'PASS' for c in REQUEST['checks']}, complete=True, reused=False,
                  cleanup_complete=True, evidence={}, worker_root=REQUEST['worker_root'])
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('result.json', json.dumps(result))
    return buffer.getvalue()

class Channel:
    def __init__(self, env, client=None):
        pass
    def get(self, name, leaf):
        mode = os.environ['FAKE_MODE']
        if leaf == 'started.json' and mode != 'silent':
            return json.dumps({'transport': gh.TRANSPORT, 'run_id': RUN, 'url': 'u', 'tag': name}).encode()
        if mode == 'done' and leaf == 'artifact.zip':
            return artifact()
        if mode == 'done' and leaf == 'done.json':
            return json.dumps({'objects': {'artifact.zip': hashlib.sha256(artifact()).hexdigest()}, 'at': 1,
                               'run_id': RUN, 'conclusion': 'success', 'status': 'completed'}).encode()
        return None
    def delete(self, name):
        note(op='channel-delete')

def request(self, method, path, **kwargs):
    note(op=method, path=path)
    if method == 'POST':
        STATE['cancelled'] = path == f'/actions/runs/{RUN}/cancel' or STATE['cancelled']
    return 202, {}, b''

def read(self, path, conditional=False):
    note(op='GET', path=path)
    if path.startswith('/actions/runs?'):  # this tag's run beside another owner's run on the same commit
        runs = [{'id': FOREIGN, 'path': gh.WORKFLOW_PATH, 'head_branch': 'deploy-gates/8vcpu/other-0000000000000000'},
                {'id': RUN, 'path': gh.WORKFLOW_PATH, 'head_branch': STATE['name'], 'html_url': 'u'}]
        return {'workflow_runs': runs}
    done = STATE['cancelled'] and path == f'/actions/runs/{RUN}'
    return {'id': RUN, 'status': 'completed' if done else 'in_progress', 'conclusion': 'cancelled' if done else None}

def push(root, token, repo, name, raw):
    STATE['name'] = name
    note(op='push', tag=name)
    return 'sha'

gh.Channel, gh.GitHub.request, gh.GitHub.json, gh.push_tag = Channel, request, read, push
gh.git = lambda *args, **kwargs: ''
gh.load_token, gh.repository = (lambda root: 'x'), (lambda root: 'o/r')
gh.delete_tag = lambda *args: note(op='tag-delete')
gh.env_file_values = lambda root: {}
gh.CHANNEL_POLL_SECONDS = gh.START_POLL_SECONDS = 0.1
gh.PARENT_POLL_SECONDS = 0.1
note(op='ready', pid=os.getpid())
raise SystemExit(gh.main(['--runner', 'blacksmith-8vcpu-ubuntu-2404', '--worker-script', 'deploy_test_worker.py',
                          '--worker-root', gh.REMOTE_ROOT, '--deadline-seconds', '900']))
"""

# The cycle's own path: cancellation_handlers + run_command(owned_lifecycle) under deploy_test_supervisor.
CYCLE_DRIVER = r"""
import os, sys
sys.path.insert(0, os.environ['FAKE_ROOT'] + '/scripts')
from deploy_test_process import cancellation_handlers, run_command
with cancellation_handlers(), open(os.environ['FAKE_OUTPUT'], 'wb') as output:
    print(run_command([sys.executable, sys.argv[1]], cwd=os.environ['FAKE_ROOT'], env=dict(os.environ),
                      output=output, timeout=None, owned_lifecycle=True), flush=True)
"""

# A parent that is SIGKILLed while its launcher child watches the run.
DYING_PARENT = r"""
import subprocess, sys, time
subprocess.Popen([sys.executable, sys.argv[1]])
time.sleep(600)
"""


class LauncherStopTest(unittest.TestCase):
    """A stopped launcher cancels exactly the run its tag push started, inside the supervisor's TERM grace."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gh-launcher-stop-', dir='/var/tmp'))
        self.addCleanup(lambda: subprocess.run(['rm', '-rf', str(self.tmp)]))
        for name, text in (('launcher.py', LAUNCHER_FAKE), ('cycle.py', CYCLE_DRIVER), ('parent.py', DYING_PARENT)):
            (self.tmp / name).write_text(text)
        request = {'token': 't' * 16, 'source': {'head': 'h' * 40}, 'gate': 'new-test-stability',
                   'checks': ['new-test-stability'], 'worker_root': gh.REMOTE_ROOT}
        (self.tmp / 'request.json').write_text(json.dumps(request))
        self.log, self.result = self.tmp / 'log.jsonl', self.tmp / 'result.json'
        self.addCleanup(self.reap_launchers)

    def reap_launchers(self):
        """A regressed launcher outlives its killed parent: stop exactly this test's fake launchers."""
        for row in self.rows():
            if row['op'] == 'ready':
                try:
                    if str(self.tmp / 'launcher.py').encode() in Path(f"/proc/{row['pid']}/cmdline").read_bytes():
                        os.kill(row['pid'], 9)
                except (OSError, ProcessLookupError):
                    pass

    def env(self, mode):
        return {**os.environ, 'FAKE_ROOT': str(ROOT), 'FAKE_LOG': str(self.log), 'FAKE_MODE': mode,
                'FAKE_OUTPUT': str(self.tmp / 'output.log'), 'DEPLOY_GATE_REQUEST': str(self.tmp / 'request.json'),
                'DEPLOY_GATE_RESULT': str(self.result)}

    def rows(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def launched(self, proc):
        """Wait until the fake tag push happened (the remote run now exists), never on a fixed sleep."""
        end = time.monotonic() + 30
        while not any(r['op'] == 'push' for r in self.rows()):
            self.assertIsNone(proc.poll(), 'launcher exited before launching')
            self.assertLess(time.monotonic(), end, 'launcher never pushed its tag')
            time.sleep(0.05)
        time.sleep(0.3)  # a few channel polls: the launcher is now watching

    def wait_result(self, seconds=20):
        end = time.monotonic() + seconds
        while not self.result.exists():
            self.assertLess(time.monotonic(), end, 'launcher wrote no receipt')
            time.sleep(0.05)
        return json.loads(self.result.read_text())

    def assert_cancelled_once(self, result, cause):
        posts = [r['path'] for r in self.rows() if r['op'] == 'POST']
        self.assertEqual(posts, ['/actions/runs/42452647149/cancel'])  # exactly its own run, never the foreign one
        self.assertEqual(result['reason'], 'remote run cancelled')
        self.assertNotIn('cleanup_owner', result)
        remote = result['remote']
        self.assertEqual((remote['run_id'], remote['status'], remote['conclusion']),
                         (42452647149, 'completed', 'cancelled'))
        self.assertEqual(remote['stop_cause'], cause)
        self.assertIn('cancel_requested_at', remote)
        self.assertLess(remote['launcher_finished_at'] - remote['cancel_requested_at'], gh.STOP_CANCEL_SECONDS)
        request = json.loads((self.tmp / 'request.json').read_text())
        self.assertEqual(validate_result(result, request, 1), ({'new-test-stability': 'UNVERIFIED'}, False))

    def launcher(self, mode):
        proc = subprocess.Popen([sys.executable, str(self.tmp / 'launcher.py')], env=self.env(mode),
                                stdout=subprocess.DEVNULL)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        return proc

    def test_term_after_the_run_reported_itself_cancels_exactly_that_run(self):
        proc = self.launcher('started')
        self.launched(proc)
        proc.terminate()
        self.assertEqual(proc.wait(timeout=gh.STOP_CANCEL_SECONDS + 3), 1)
        self.assert_cancelled_once(self.wait_result(), 'SIGTERM')

    def test_term_before_the_run_reported_itself_still_names_and_cancels_it(self):
        # The 2026-11-08 leak: a silent channel plus STOP made the run lookup return at once, so the
        # launched run was reported never-started and only its tag was deleted.
        proc = self.launcher('silent')
        self.launched(proc)
        proc.terminate()
        self.assertEqual(proc.wait(timeout=gh.STOP_CANCEL_SECONDS + 3), 1)
        self.assert_cancelled_once(self.wait_result(), 'SIGTERM')

    @unittest.skipUnless(sys.platform == 'linux', 'owned worker lifecycle requires Linux')
    def test_term_to_the_cycle_cancels_through_its_owned_supervisor(self):
        for mode in ('silent', 'started'):
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                self.result.unlink(missing_ok=True)
                cycle = subprocess.Popen([sys.executable, str(self.tmp / 'cycle.py'), str(self.tmp / 'launcher.py')],
                                         env=self.env(mode), stdout=subprocess.PIPE, text=True)
                self.addCleanup(lambda: cycle.poll() is None and cycle.kill())
                self.launched(cycle)
                cycle.terminate()
                out, _ = cycle.communicate(timeout=30)
                code, _, cancelled, lingering = eval(out.strip().splitlines()[-1])
                self.assertEqual((code, cancelled, lingering), (1, True, False))  # exited inside the TERM grace
                self.assert_cancelled_once(self.wait_result(1), 'SIGTERM')

    def test_parent_death_cancels_the_launched_run(self):
        parent = subprocess.Popen([sys.executable, str(self.tmp / 'parent.py'), str(self.tmp / 'launcher.py')],
                                  env=self.env('started'), stdout=subprocess.DEVNULL)
        self.addCleanup(lambda: parent.poll() is None and parent.kill())
        self.launched(parent)
        parent.kill()
        parent.wait()
        self.assert_cancelled_once(self.wait_result(), 'parent exited')

    def test_normal_completion_never_cancels(self):
        proc = self.launcher('done')
        self.assertEqual(proc.wait(timeout=30), 0)
        result = self.wait_result(1)
        self.assertEqual(result['cases'], {'new-test-stability': 'PASS'})
        self.assertNotIn('stop_cause', result['remote'])
        self.assertEqual([r for r in self.rows() if r['op'] == 'POST'], [])
class WorkflowMirrorCheckout(unittest.TestCase):
    """deploy-gates.yml "Check out the frozen commit", executed from the workflow text itself.

    PR #1787 run 42440778292: the restored sticky-disk mirror kept a commit-graph chain naming a
    deleted graph file, so every git command in the job's --shared clone printed "warning: unable to
    find all commit-graph files" and original600's exact-stderr check failed. The step must rebuild
    such a chain before cloning, and run any gc in the foreground.
    """
    STEP = '      - name: Check out the frozen commit\n'

    def step_script(self, mirror_root, url):
        text = (ROOT / '.github/workflows/deploy-gates.yml').read_text()
        body = text[text.index(self.STEP):]
        body = body[:body.index('\n      - name:', 1)]
        lines = body.split('        run: |\n', 1)[1].splitlines()
        script = '\n'.join(line[10:] for line in lines) + '\n'
        for old, new in (('sudo chown "$(id -u):$(id -g)" /home/runner/rose-git-mirror', ':'),
                         ('/home/runner/rose-git-mirror', mirror_root),
                         ('url="https://github.com/${GITHUB_REPOSITORY}.git"', 'url=' + url)):
            self.assertIn(old, script, 'workflow checkout step drifted from this fixture')
            script = script.replace(old, new)
        return script

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=True)

    def test_restored_broken_commit_graph_chain_is_rebuilt_before_the_clone(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            origin, ws = tmp / 'origin', tmp / 'ws'
            ws.mkdir()
            self.git('init', '-q', '--initial-branch=main', str(origin))
            for i in range(3):
                (origin / 'f').write_text(str(i))
                self.git('add', 'f', cwd=origin)
                self.git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', str(i), cwd=origin)
            self.git('tag', 'deploy-gates/8vcpu/x', cwd=origin)
            env = {**os.environ, 'FETCH_TOKEN': 't', 'GITHUB_REF': 'refs/tags/deploy-gates/8vcpu/x',
                   'GITHUB_WORKSPACE': str(ws), 'GIT_CONFIG_NOSYSTEM': '1', 'HOME': str(tmp)}
            script = self.step_script(str(tmp / 'disk'), origin.as_uri())

            def run():
                return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=120)
            first = run()
            self.assertEqual(first.returncode, 0, first.stderr)
            mirror = tmp / 'disk/rose.git'
            # The saved snapshot: a split chain whose base graph file is gone.
            for i in range(3, 5):
                (origin / 'f').write_text(str(i))
                self.git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qam', str(i), cwd=origin)
                self.git('-C', str(mirror), 'fetch', '-q', origin.as_uri(), '+refs/heads/main:refs/heads/main')
                self.git('-C', str(mirror), 'commit-graph', 'write', '--reachable', '--split')
            graphs = mirror / 'objects/info/commit-graphs'
            base = (graphs / 'commit-graph-chain').read_text().split()[0]
            (graphs / f'graph-{base}.graph').unlink()
            broken = subprocess.run(['git', '-C', str(mirror), 'log', '-1'], capture_output=True, text=True)
            self.assertIn('unable to find all commit-graph files', broken.stderr, 'fixture did not break the chain')
            second = run()
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertNotIn('commit-graph', second.stderr)
            self.assertIn('mirror commit-graph rebuilt', second.stdout)
            log = subprocess.run(['git', '-C', str(ws), 'log', '-1', '--format=%H'], capture_output=True, text=True)
            self.assertEqual(log.stderr, '')
            self.assertEqual(log.stdout.strip(), self.git('rev-parse', 'deploy-gates/8vcpu/x^{commit}', cwd=origin).stdout.strip())
            self.assertIn('-c gc.autoDetach=false', script, 'mirror gc must not outlive the step')


if __name__ == '__main__':
    unittest.main()
