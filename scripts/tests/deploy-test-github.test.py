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
        {'name': 'agentcard-lifecycle', 'category': 'agentcard-lifecycle', 'command': ['true'],
         'checks': ['agentcard-lifecycle']},
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

    def test_smoke_and_agentcard_cannot_be_bound_to_blacksmith(self):
        for gate in ('smoke', 'agentcard-lifecycle'):
            with self.subTest(gate), self.assertRaisesRegex(ValueError, 'stays on the cloud benchmark CLI'):
                generate(template(), {gate: slot(gate)}, ROOT)

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
        self.workers = tempfile.TemporaryDirectory()
        self.addCleanup(self.workers.cleanup)
        self.inventory['agentcard-lifecycle'] = {
            'id': 'agentcard-local', 'transport': 'local-isolated', 'timeout_seconds': 900,
            'worker_root': str(Path(self.workers.name) / 'agentcard'),
            'env': {'CONDUCTOR_WORKSPACE_NAME': 'agentcard', 'CONDUCTOR_PORT': '12000'}}

    def plan(self):
        with patch('deploy_test_backend.sweep_from_recipe'):
            bindings = generate(template(), self.inventory, ROOT)
        return p.select(template(), ['back-end/src/one.ts'], self.result, bindings)

    def gate(self, plan, name):
        return next(gate for gate in plan['gates'] if gate['name'] == name)

    def test_plan_with_github_slots_validates_beside_cloud_smoke_and_a_local_agentcard(self):
        plan = self.plan()
        validate_plan(plan, ROOT)
        frontend, backend = self.gate(plan, 'frontend-coverage-blackbox'), self.gate(plan, 'backend-coverage-blackbox')
        for gate in (frontend, backend):
            self.assertEqual(('github-actions', iso.GITHUB_WORKER_ROOT, True, 'file', 900),
                             (gate['worker_transport'], gate['worker_root'], gate['case_protocol'],
                              gate['result_transport'], gate['timeout_seconds']))
        self.assertEqual('deploy_test_backend.py', backend['command'][backend['command'].index('--worker-script') + 1])
        self.assertEqual('benchmark-cloud-cli', self.gate(plan, 'smoke')['worker_transport'])
        self.assertEqual('local-isolated', self.gate(plan, 'agentcard-lifecycle')['worker_transport'])

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

    def test_saved_plan_cannot_move_smoke_or_agentcard_onto_blacksmith(self):
        for name in ('smoke', 'agentcard-lifecycle'):
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


def standard():
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
        self.gates = ['backend-coverage-blackbox', 'smoke', 'agentcard-lifecycle', 'frontend-coverage-blackbox',
                      'deploy-command-structural', 'semantic-stack', 'brand-new-gate']

    def test_blacksmith_moves_every_gate_but_smoke_and_agentcard_off_this_host(self):
        workers = {w['gate']: w for w in g.layout(self.root, self.head, self.gates, 'blacksmith')}
        self.assertEqual({'cloud': ['smoke'], 'create': ['agentcard-lifecycle'],
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
        self.assertEqual(['agentcard-lifecycle'], provisioned)
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
        selection = {'selected': ['format', 'semantic-stack', 'agentcard-lifecycle', 'smoke'], 'quick': ['format'],
                     'needs_worker': ['semantic-stack', 'agentcard-lifecycle', 'smoke'], 'omitted': []}
        args = dict(base='origin/main', state_dir=None, skip_agentcard=None, dry_run=True, provision_jobs=4,
                    head=None, rca_launcher=None, structural_workers=g.STRUCTURAL_WORKERS,
                    semantic_worker_processes=g.SEMANTIC_WORKER_PROCESSES, sample_memory=None,
                    abort_below_mb=None, executor='blacksmith')
        from types import SimpleNamespace
        with patch.object(g, 'list_selected', return_value=selection), \
                patch.object(g, 'standard_template', standard), \
                patch.object(g, 'check_capacity', lambda root, workers, proc=None: seen.append(
                    [w['gate'] for w in workers]) or {'memory_mb': 0, 'available_mb': 0, 'disk_mb': 0,
                                                      'free_disk_mb': 0}):
            output = io.StringIO()
            with redirect_stdout(output):
                code = g.run(SimpleNamespace(**args), self.root)
        self.assertEqual(0, code)
        self.assertEqual([['agentcard-lifecycle', 'smoke']], seen)
        *body, summary = output.getvalue().strip().splitlines()
        self.assertEqual(f'DEPLOY_GATES DRY-RUN head={self.head[:12]} gates=4 workers=1 remote=1', summary)
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

    def test_run_lookup_matches_the_tag_and_reports_a_rejected_workflow(self):
        head, name = 'd' * 40, 'deploy-gates/4vcpu/g-1'

        class Fake:
            def __init__(self, runs):
                self.runs = runs

            def json(self, path, conditional=False):
                return {'workflow_runs': self.runs}

        mine = {'id': 9, 'path': gh.WORKFLOW_PATH, 'head_branch': name}
        other = {'id': 8, 'path': gh.WORKFLOW_PATH, 'head_branch': 'deploy-gates/4vcpu/other'}
        self.assertEqual(gh.find_run(Fake([other, mine]), head, name, gh.time.time() + 5, 0)['id'], 9)
        rejected = {'id': 7, 'path': gh.WORKFLOW_PATH, 'head_branch': None, 'conclusion': 'failure',
                    'created_at': '2030-01-01T00:00:00Z', 'html_url': 'u'}
        clock = iter(range(0, 10_000, 10))  # every reading advances 10 s
        with patch.object(gh.time, 'time', side_effect=lambda: next(clock)), patch.object(gh.STOP, 'wait'):
            with self.assertRaises(gh.WorkflowRejected):
                gh.find_run(Fake([rejected]), head, name, 100, 0)


if __name__ == '__main__':
    unittest.main()
