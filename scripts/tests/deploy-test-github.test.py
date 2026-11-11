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
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from condition_wait import wait_until
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

    def test_local_new_test_stability_bounds_its_cpu_load_and_blacksmith_keeps_nproc(self):
        def with_stability():
            template = standard()
            template['gates'].append({'name': 'new-test-stability', 'checks': ['new-test-stability'], 'command': [
                'python3', 'scripts/select_affected_tests.py', '--stability', '--base', 'origin/main']})
            return template
        remote = next(gate for gate in g.build_template(2, 2, with_stability, executor='blacksmith')['gates']
                      if gate['name'] == 'new-test-stability')
        self.assertNotIn('--load-workers', remote['command'])
        local = next(gate for gate in g.build_template(2, 2, with_stability, executor='local')['gates']
                     if gate['name'] == 'new-test-stability')
        self.assertEqual(['--load-workers', str(g.LOCAL_STABILITY_LOAD_WORKERS)], local['command'][-2:])

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

    def test_user_elected_overrides_travel_to_the_vm_and_nothing_else_does(self):
        """deploy.md lets the user override a named gate; a Blacksmith VM's env is its own, so the
        coordinator's DEPLOY_GATE_OVERRIDES must ride the envelope (PR #1854's live Tilion override)."""
        self.assertEqual('a:b,browser-provider:tilion-residential-live',
                         gh.gate_overrides(' browser-provider:tilion-residential-live , a:b,a:b '))
        for bad in ('Bad Name', 'x;rm -rf /', '-flag'):
            with self.assertRaises(ValueError):
                gh.gate_overrides(bad)
        with patch.dict(os.environ, {gh.OVERRIDES_ENV: ''}):
            plain = gh.envelope(remote_request('a' * 40), 'deploy_test_worker.py', RUNNER)
        self.assertNotIn(b'overrides', plain)  # an ordinary request keeps its deterministic tag
        with patch.dict(os.environ, {gh.OVERRIDES_ENV: 'browser-provider:tilion-residential-live'}):
            elected = gh.envelope(remote_request('a' * 40), 'deploy_test_worker.py', RUNNER)
        self.assertEqual('browser-provider:tilion-residential-live', json.loads(elected)['overrides'])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            head = git_repo(root)
            for elected_value in ('browser-provider:tilion-residential-live', ''):
                out = self.run_extract(root, remote_request(head, root=str(root)), overrides=elected_value)
                self.assertEqual(elected_value, (out / 'overrides').read_text())

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

    def run_extract(self, root, request, runner=RUNNER, script='deploy_test_worker.py', name=None, overrides=''):
        name = name or gh.tag_name(runner, request['gate'], request['token'])
        fields = {'version': gh.ENVELOPE_VERSION, 'worker_script': script, 'runner': runner, 'request': request}
        if overrides:
            fields['overrides'] = overrides
        body = (json.dumps(fields) + '\n').encode()
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

    def test_preexisting_native_dumps_and_all_manifest_worker_logs_are_hash_bound(self):
        # Explicit offline fixture bytes, never an original provider payload.
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root, out = Path(tmp) / 'repo', Path(tmp) / 'out'
            out.mkdir(); (root / '.context').mkdir(parents=True)
            primary = root / 'agents/custom-worker.txt'
            primary.parent.mkdir()
            expected = {'.llm-dumps/offline-fixture/1-span-router.json': b'offline retention fixture'}
            expected.update({f'agents/custom-worker{suffix}.txt': f'offline worker {i}'.encode()
                             for i, suffix in enumerate([''] + [f'.{i}' for i in range(1, 8)])})
            for rel, data in expected.items():
                path = root / rel; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
            private = root / '.context/private/.env.secret'; private.parent.mkdir(); private.write_text('offline-secret')
            (root / '.context/services.json').write_text(json.dumps({'logs': {'worker': str(primary),
                'backend': str(private), 'frontend': str(Path(tmp) / 'outside.txt')}}))
            malformed = root / '.context/offline-fixture/services.json'
            malformed.parent.mkdir(); malformed.write_text('[]')
            secret = root / '.rose/tools.json'; secret.parent.mkdir(); secret.write_text('secret fixture')
            (root / '.llm-dumps/offline-fixture/alias.json').symlink_to(secret)
            (root / '.llm-dumps/alias-dir').symlink_to(secret.parent, target_is_directory=True)
            (root / '.llm-dumps/offline-fixture/.env').write_text('secret fixture')
            (primary.parent / 'custom-worker.extra.txt').write_text('unrelated')
            large = root / '.llm-dumps/offline-fixture/oversize.json'
            with large.open('wb') as stream: stream.truncate(gh.BUNDLE_FILE_BYTES + 1)
            outside = Path(tmp) / 'outside.txt'; outside.write_text('outside fixture')
            (root / '.context/outside.txt').symlink_to(outside)
            with patch.object(gh, 'ROOT', root), patch.object(gh, 'publish_done') as publish:
                self.assertEqual(gh.remote_bundle(type('Args', (), {'out': out})()), 0)
            publish.assert_called_once_with(out, out / 'artifact')
            self.assertEqual([rel for rel in expected if not (out / 'artifact/files' / rel).is_file()], [],
                             'preexisting native dumps/worker streams excluded')
            for rel, data in expected.items():
                path = out / 'artifact/files' / rel
                self.assertTrue(path.is_file(), f'preexisting native evidence lost: {rel}')
                self.assertEqual(path.read_bytes(), data)
            manifest = json.loads((out / 'artifact/bundle.json').read_text())
            bound = {row['path']: row for row in manifest['captured']}
            for rel, data in expected.items():
                self.assertEqual(bound[rel]['sha256'], hashlib.sha256(data).hexdigest())
                self.assertEqual(bound[rel]['bytes'], len(data))
            self.assertTrue(any(row['path'] == str(large.relative_to(root)) for row in manifest['skipped']))
            self.assertFalse((out / 'artifact/files/.rose').exists())
            self.assertFalse((out / 'artifact/files/.context/private/.env.secret').exists())
            self.assertTrue(any(row['path'] == '.context/private/.env.secret'
                                and row.get('reason') == 'private_config' for row in manifest['skipped']))
            self.assertFalse((out / 'artifact/files/.llm-dumps/offline-fixture/.env').exists())
            self.assertFalse((out / 'artifact/files/.llm-dumps/offline-fixture/alias.json').exists())
            self.assertFalse((out / 'artifact/files/agents/custom-worker.extra.txt').exists())
            self.assertEqual(gh.BUNDLE_FILE_BYTES, 64 * 1024 * 1024)
            self.assertEqual(gh.BUNDLE_TOTAL_BYTES, 400 * 1024 * 1024)

    def test_capped_bundle_keeps_existing_dumps_before_bulk_coverage_json(self):
        # Same capped selection as production, with small offline fixture bytes.
        self.assertEqual(gh.BUNDLE_FILE_BYTES, 64 * 1024 * 1024)
        self.assertEqual(gh.BUNDLE_TOTAL_BYTES, 400 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as tmp:
            root, out = Path(tmp) / 'repo', Path(tmp) / 'out'
            dump = root / '.llm-dumps/offline-fixture/last-request.json'
            dump.parent.mkdir(parents=True); dump.write_bytes(b'd' * 60)
            raw = root / '.context/test-runs/backend-coverage-failed-fixture/raw-v8'
            raw.mkdir(parents=True); out.mkdir()
            for index in range(8):
                (raw / f'coverage-{index}.json').write_bytes(b'v' * 50)
            with patch.object(gh, 'ROOT', root), patch.object(gh, 'BUNDLE_FILE_BYTES', 64), \
                    patch.object(gh, 'BUNDLE_TOTAL_BYTES', 400), patch.object(gh, 'publish_done'):
                gh.remote_bundle(type('Args', (), {'out': out})())
            self.assertEqual((out / 'artifact/files' / dump.relative_to(root)).read_bytes(), b'd' * 60)
            manifest = json.loads((out / 'artifact/bundle.json').read_text())
            self.assertLessEqual(manifest['bytes'], 400)
            self.assertTrue(any(row['path'].startswith('.context/') for row in manifest['skipped']))

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

    def test_a_member_the_launch_token_outranked_is_never_handed_out_again(self):
        for code in (404, 403, 401):
            client, seen, _ = self.client(
                lambda method, token, etag, code=code: self.http_error(code) if token == 'pool' else self.ok(),
                picks=(('GITHUB_APP', 'pool'), ('GITHUB_APP', 'pool'), ('GITHUB_TOKEN_2', 'pool2')))
            client.request('GET', '/actions/runs/1/artifacts')
            client.read_attempted_at -= gh.READ_REPICK_RETRY_SECONDS
            client.request('GET', '/actions/runs/2')  # the re-pick returns the denied member: refused
            client.read_attempted_at -= gh.READ_REPICK_RETRY_SECONDS
            client.request('GET', '/actions/runs/3')
            self.assertEqual(['pool', 'launch', 'launch', 'pool2'], [token for _, token, _ in seen], code)
            self.assertEqual({gh.identity('pool')}, client.read_denied)
        # Both identities answered 404: that is GitHub's answer, and the member keeps serving reads.
        client, seen, _ = self.client(
            lambda method, token, etag: self.http_error(404) if len(seen) <= 2 else self.ok())
        with self.assertRaises(gh.urllib.error.HTTPError):
            client.request('GET', '/actions/runs/1')
        client.request('GET', '/actions/runs/2')
        self.assertEqual(['pool', 'launch', 'pool'], [token for _, token, _ in seen])
        self.assertEqual(set(), client.read_denied)

    def test_a_bounded_stop_window_reads_with_the_launch_token_only(self):
        picked = []
        client, seen, _ = self.client(lambda method, token, etag: self.ok())
        client.read_picker = lambda: picked.append(1) or ('GITHUB_APP', 'pool')
        client.until = 1_000_010.0
        self.assertEqual(['launch'], client.tokens('GET'))
        client.request('GET', '/actions/runs/1')
        self.assertEqual(([], [('GET', 'launch', None)]), (picked, seen))
        client.until = None
        self.assertEqual(['pool', 'launch'], client.tokens('GET'))

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
        note(op='channel-get', leaf=leaf)  # the observable "launcher is watching its channel" signal
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
        """Wait until the tag push happened (the remote run exists) and the launcher polls its channel."""
        def watching():
            self.assertIsNone(proc.poll(), 'launcher exited before launching')
            ops = [r['op'] for r in self.rows()]
            return 'push' in ops and ops[ops.index('push'):].count('channel-get') >= 2
        wait_until(watching, timeout=30, description='launcher pushed its tag and polls its channel')

    def wait_result(self, seconds=20):
        wait_until(self.result.exists, timeout=seconds, description='launcher receipt')
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
            # Git 2.47+ starts `maintenance run --auto --detach` from fetch; it rewrites the split
            # commit-graph after the --shared clone chained onto it (hunt round 10, original600).
            self.assertIn('-c maintenance.autoDetach=false', script, 'mirror maintenance must not outlive the step')



class GateSetupReleaseTools(unittest.TestCase):
    """scripts/ci/deploy-gate-setup.sh flyctl + tunnel tools, executed with stand-in curl/sudo/tar.

    PR #1826 (2026-11-08): GitHub's unauthenticated release downloads answered 504 for 15+ minutes
    and the unauthenticated `--retry 3` installs failed every Blacksmith gate in "Prepare runner"
    before a single test ran. Release binaries are fetched through the GitHub API with the job token,
    retrying any error for minutes, and scripts/ci/release-tool.sh installs the dependency disk's
    last good copy when the fetch still fails.
    """

    def run_block(self, tmp, calls, curl_fails=False):
        text = (ROOT / 'scripts/ci/deploy-gate-setup.sh').read_text()
        block = text[text.index('# Release binaries (flyctl'):text.index('step "dependency disk"')]
        bin_dir = tmp / 'bin'
        bin_dir.mkdir(exist_ok=True)
        (tmp / 'deps').mkdir(exist_ok=True)  # the mounted dependency disk
        api = json.dumps({'assets': [
            {'name': 'flyctl_0.5.5_Linux_x86_64.tar.gz', 'url': 'https://api.github.com/assets/1'},
            {'name': 'cloudflared-linux-amd64', 'url': 'https://api.github.com/assets/2'},
        ]})
        (tmp / 'api.json').write_text(api)
        (bin_dir / 'curl').write_text(
            '#!/usr/bin/env bash\nprintf "%s\\x1f" "$@" >> ' + str(calls) + '\nprintf "\\n" >> ' + str(calls) + '\n'
            + ('exit 22\n' if curl_fails else '')
            + 'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n'
            'if [ -n "$out" ]; then printf "#!/bin/sh\\n" > "$out"; else cat ' + str(tmp / 'api.json') + '; fi\n')
        (bin_dir / 'tar').write_text('#!/usr/bin/env bash\nprintf "#!/bin/sh\\n" > "$4/$5"\n')
        (bin_dir / 'sudo').write_text('#!/usr/bin/env bash\n[ "$1" = bash ] && exit 0\n'
                                      'case "$*" in *" /usr/local/bin/"*) exit 0;; esac\nexec "$@"\n')
        for name in ('curl', 'tar', 'sudo'):
            (bin_dir / name).chmod(0o755)
        env = {'PATH': f'{bin_dir}:/usr/bin:/bin', 'HOME': str(tmp / 'home'), 'DEPS': str(tmp / 'deps'),
               'GITHUB_PATH': str(tmp / 'ghpath'), 'FETCH_TOKEN': 'tok-123', 'RELEASE_TOOL_RETRY_SECONDS': '0'}
        script = 'set -euo pipefail\nstep() { :; }\n' + block
        return subprocess.run(['bash', '-c', script], cwd=ROOT, env=env, capture_output=True, text=True,
                              timeout=60)

    def test_release_tools_use_the_token_retry_for_minutes_and_fall_back_to_the_disk_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            calls = tmp / 'curl-calls'
            first = self.run_block(tmp, calls)
            self.assertEqual(first.returncode, 0, first.stderr)
            invocations = [line.split('\x1f')[:-1] for line in calls.read_text().splitlines()]
            self.assertGreaterEqual(len(invocations), 4, invocations)  # API + asset, for flyctl and cloudflared
            for args in invocations:
                self.assertIn('Authorization: Bearer tok-123', args)
                self.assertIn('--retry-all-errors', args)
                self.assertGreaterEqual(int(args[args.index('--retry-max-time') + 1]), 120, args)
                self.assertTrue(any(a.startswith('https://api.github.com/') for a in args), args)
            self.assertTrue(any('https://api.github.com/repos/cloudflare/cloudflared/releases/latest' in args
                                for args in invocations), invocations)
            self.assertTrue((tmp / 'home/.fly/bin/flyctl').exists())
            self.assertTrue((tmp / 'deps/release-tools/flyctl').exists())
            # A later runner on the same dependency disk during an outage installs the last good copy.
            calls.unlink()
            (tmp / 'home/.fly/bin/flyctl').unlink()
            second = self.run_block(tmp, calls, curl_fails=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("flyctl: installing the dependency disk's last good copy", second.stderr)
            self.assertTrue((tmp / 'home/.fly/bin/flyctl').exists())


class GitHubTerminalCleanup(unittest.TestCase):
    """Cleanup reconciliation retains observation loss, even after remote worker PASS."""
    def setUp(self):
        import deploy_test_cycle as cycle
        import deploy_test_github_cleanup as cleanup
        import hashlib, zipfile
        self.c, self.m = cycle, cleanup
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        self.token = 'same-original-token'
        self.tag = gh.tag_name(RUNNER, 'semantic-stack', self.token)
        self.owner = {'transport':'github-actions','run_id':7,'url':'https://github.com/Rose-Ai-Labs/rose/actions/runs/7'}
        self.request = {'token':self.token,'source':self.source,'gate':'semantic-stack','worker_root':gh.REMOTE_ROOT,'checks':['semantic-stack'],'skips':{}}
        self.adapter = {**self.request,'cases':{'semantic-stack':'UNVERIFIED'},'complete':False,'cleanup_complete':False,'cleanup_owner':self.owner,
                        'remote':{'run_id':7,'run_attempt':'1','event_sha':self.source['head'],'tag':self.tag}}
        self.receipt = {**self.request,'cases':{'semantic-stack':'UNVERIFIED'},'complete':False,'worker_result':str(self.folder/'result.json'),
                        'log':str(self.folder/'output.log'),'cleanup_owner':{'worker_cleanup_owner':self.owner,'request_token':self.token},'timed_out':True}
        self.process = {'supervisor_pid':41,'child_pid':42,'native_exit':1,'quiescent':True,'orphaned_children':False,'remaining':[],'error':None,'reaped':[{'pid':42,'status':256}],'term_sent':[42],'timed_out':True}
        for n, doc in [('request.json',self.request),('result.json',self.adapter),('receipt.json',self.receipt),('output.log.process.json',self.process)]:
            (self.folder/n).write_text(json.dumps(doc))
        self.artifact = self.folder/'artifact.zip'
        native = {**self.request,'complete':True,'cases':{'semantic-stack':'PASS'},'cleanup_complete':True}
        with zipfile.ZipFile(self.artifact,'w') as z:
            for n, doc in [('request.json',self.request),('result.json',native),('timing.json',{'worker_finished_at':100,'worker_exit':0})]: z.writestr(n,json.dumps(doc))
        digest=cycle.sha_file(self.artifact)
        self.seen={'run':{'id':7,'run_attempt':1,'status':'completed','conclusion':'success','head_sha':self.source['head'],'head_branch':self.tag,'path':'.github/workflows/deploy-gates.yml','event':'push','repository':{'id':10},'head_repository':{'id':10}},
                   'jobs':{'total_count':1,'jobs':[{'id':8,'run_id':7,'run_attempt':1,'status':'completed','completed_at':'2026-11-09T00:00:00Z','labels':[RUNNER]}]},
                   'artifacts':{'artifacts':[{'id':9,'name':gh.ARTIFACT,'expired':False,'digest':'sha256:'+digest,'workflow_run':{'id':7,'repository_id':10,'head_repository_id':10,'head_branch':self.tag,'head_sha':self.source['head']}}]}}
        self.proof={'kind':cleanup.KIND,'token':self.token,'receipt_sha256':cycle.sha_file(self.folder/'receipt.json'),
                    'original_files':{n:cycle.sha_file(self.folder/n) for n in cleanup.FILES},'artifact':str(self.artifact),
                    'remote':{'repository':'Rose-Ai-Labs/rose','run_id':7,'run_attempt':1,'job_ids':[8],'artifact_id':9,'artifact_sha256':digest}}
        self.state={'attempts':[{'results':[self.receipt]}],'failures':[{'id':'failure','gate':'semantic-stack','native_result':'UNVERIFIED','complete':False}],
                    'phase':'triage','pending':['failure'],'repair_gates':[]}
        self.mock=self.enterContext(patch.object(cleanup,'observe',side_effect=lambda rid:copy.deepcopy(self.seen)))
        self.original={p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()}
    def test_exact_terminal_owner_allows_normal_reexecute_without_credit(self):
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])
        self.c.reconcile(self.state,'failure',self.proof)
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),[])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.c.reexecute(self.state,'failure')
        self.assertEqual(self.state['failures'][0]['native_result'],'UNVERIFIED')
        self.assertEqual({p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()},self.original)
    def interrupted_fixture(self):
        self.receipt['executed'] = True
        (self.folder/'receipt.json').write_text(json.dumps(self.receipt))
        self.proof['receipt_sha256'] = self.c.sha_file(self.folder/'receipt.json')
        self.proof['original_files']['receipt.json'] = self.proof['receipt_sha256']
        self.state.update(phase='interrupted', source=self.source, failures=[])
        self.state.pop('pending')
        self.state['attempts'][-1]['interrupted'] = True

    def test_interrupted_original_token_reconciles_without_inventing_a_failure(self):
        self.interrupted_fixture()
        original = copy.deepcopy(self.state['attempts'])
        self.c.reconcile(self.state,self.token,self.proof)
        self.assertEqual([],self.state['failures'])
        self.assertEqual(original,self.state['attempts'])
        self.assertEqual([],self.c.retained_owners(self.state,['semantic-stack']))
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_interrupted_token_does_not_bypass_source_phase_or_live_remote_checks(self):
        self.interrupted_fixture()
        for key,value in [('phase','ready'),('source',{'head':'wrong'}),('running',True)]:
            before=copy.deepcopy(self.state)
            self.state[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.c.reconcile(self.state,self.token,self.proof)
            self.state=before
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'wrong-token',self.proof)
        self.seen['run']['status']='in_progress'
        with self.assertRaises(ValueError):self.c.reconcile(self.state,self.token,self.proof)
        self.assertNotIn('reconciled_owners',self.state)
    def test_local_wait_identity_negatives(self):
        original=copy.deepcopy(self.process)
        malformed=[{'reaped':[{'pid':99,'status':0}]},
                   {'reaped':[{'pid':42,'status':256},{'pid':42,'status':256}]},
                   {'reaped':[{'pid':42,'status':0}]},
                   {'reaped':[{'pid':42,'status':127}]},
                   {'reaped':[{'pid':42,'status':65535}]},
                   {'reaped':[{'pid':41,'status':0},{'pid':42,'status':256}]},
                   {'child_pid':True},{'supervisor_pid':True},{'native_exit':True},
                   {'child_pid':41},{'native_exit':-999},{'native_exit':256}]
        for change in malformed:
            with self.subTest(change=change):
                row={**original,**change}
                (self.folder/'output.log.process.json').write_text(json.dumps(row))
                self.proof['original_files']['output.log.process.json']=self.c.sha_file(self.folder/'output.log.process.json')
                with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
        row={**original,'native_exit':-15,'reaped':[{'pid':42,'status':15},{'pid':43,'status':9}]}
        (self.folder/'output.log.process.json').write_text(json.dumps(row))
        self.proof['original_files']['output.log.process.json']=self.c.sha_file(self.folder/'output.log.process.json')
        self.c.reconcile(self.state,'failure',self.proof)
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_wrong_run_attempt_head_tag_live_jobs_and_digest_refuse(self):
        for group,key,value in [('run','id',True),('run','run_attempt',2),('run','head_sha','c'*40),('run','head_branch','wrong'),('run','status','in_progress')]:
            with self.subTest(key=key):
                original=self.seen[group][key];self.seen[group][key]=value
                with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
                self.seen[group][key]=original
        self.seen['jobs']['jobs'][0]['status']='in_progress'
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
        self.seen['jobs']['jobs'][0]['status']='completed';self.seen['artifacts']['artifacts'][0]['digest']='sha256:wrong'
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
    def test_original_mutation_and_new_owner_refuse(self):
        (self.folder/'result.json').write_text('{}')
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
        (self.folder/'result.json').write_bytes(self.original['result.json'])
        newer=copy.deepcopy(self.receipt);newer['token']='new-owner';self.state['attempts'].append({'results':[newer]})
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
    def test_stale_certificate_keeps_gate_owned_and_execution_fenced(self):
        self.c.reconcile(self.state,'failure',self.proof)
        entry=next(iter(self.state['reconciled_owners'].values()))
        self.assertFalse(self.m.still_bound(self.state,self.receipt,self.owner,None))
        for key, value in [('credit_granted',True),('token','wrong'),('owner',{})]:
            with self.subTest(key=key):
                original=entry[key];entry[key]=value
                self.assertFalse(self.m.still_bound(self.state,self.receipt,self.owner,entry))
                self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])
                with self.assertRaisesRegex(ValueError,'cleanup owner'):self.c.reexecute(self.state,'failure')
                entry[key]=original
        self.assertEqual({p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()},self.original)

    def test_missing_malformed_and_changed_native_evidence_keeps_gate_owned(self):
        self.c.reconcile(self.state,'failure',self.proof)
        entry=next(iter(self.state['reconciled_owners'].values()))
        artifact=self.artifact.read_bytes()
        self.artifact.unlink()
        self.assertFalse(self.m.still_bound(self.state,self.receipt,self.owner,entry))
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])
        self.artifact.write_bytes(artifact)
        # Authenticate malformed retained process bytes to exercise bounded JSON rejection,
        # rather than merely the earlier changed-file hash guard.
        path=self.folder/'output.log.process.json';path.write_text('{malformed')
        self.proof['original_files']['output.log.process.json']=self.c.sha_file(path)
        self.assertFalse(self.m.still_bound(self.state,self.receipt,self.owner,entry))
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])

    def test_unrelated_programming_errors_propagate(self):
        self.c.reconcile(self.state,'failure',self.proof)
        for error in (RuntimeError('unexpected bug'),AssertionError('invariant bug'),ValueError('unrelated value bug')):
            with self.subTest(error=type(error).__name__),patch.object(self.m,'validate',side_effect=error):
                with self.assertRaises(type(error)):self.c.retained_owners(self.state,['semantic-stack'])

    def test_expected_observation_refusal_keeps_gate_owned(self):
        self.c.reconcile(self.state,'failure',self.proof)
        try:
            self.m.need(False,'remote unavailable')
        except ValueError as error:
            rejection=error
        with patch.object(self.m,'observe',side_effect=rejection):
            self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),[])

    def test_revalidation_and_remote_drift_refuse(self):
        self.c.reconcile(self.state,'failure',self.proof)
        self.seen['run']['run_attempt']=2
        self.assertEqual(self.c.retained_owners(self.state,['semantic-stack']),['semantic-stack'])


    def cancelled_controller_fixture(self):
        import zipfile
        name = 'cloudbench-controller'
        recipe = {'cases': {name: {'command': ['python3', 'scripts/run-cloudbench-controller-local.py'],
                  'cwd': '.', 'env': {'CONDUCTOR_WORKSPACE_NAME': 'deploy-cloudbench-controller',
                                      'CONDUCTOR_PORT': '12000'}, 'aggregate': True}}}
        self.tag = gh.tag_name(RUNNER, name, self.token)
        self.request.update(gate=name, checks=[name], worker_recipe=recipe)
        self.adapter.update(gate=name, cases={name:'UNVERIFIED'}, recipe_digest=self.c.digest(recipe))
        self.adapter['remote'].update(tag=self.tag, stop_cause='SIGTERM',runner_name='exact-runner')
        command=['python3','scripts/deploy_test_github.py','--runner',RUNNER,
                 '--worker-script','deploy_test_worker.py','--worker-root',gh.REMOTE_ROOT]
        self.receipt['command']=command
        gate = {'name':name,'checks':[name],'worker_recipe':recipe,'command':command,
                'worker_transport':'github-actions','worker_root':gh.REMOTE_ROOT}
        self.state.update(source=self.source,plan={'source':self.source,'gates':[gate]},
                          input_fingerprints={name:'c'*64},environment='d'*64)
        self.state['failures'][0]['gate'] = name
        self.receipt.update(gate=name, checks=[name],cases={name:'UNVERIFIED'},cancelled=True,timed_out=False,
                            native_exit=1,execution_binding={'input_fingerprint':'c'*64,
                            'contract_digest':self.c.digest(gate),'environment':'d'*64})
        self.process.update(cancelled=True,timed_out=False)
        self.seen['run'].update(head_branch=self.tag,conclusion='cancelled')
        job=self.seen['jobs']['jobs'][0]
        labels=[('Run gate','cancelled'),('Bundle evidence','success'),('Release dependency mounts','success'),
                ('Run actions/upload-artifact@v4','success'),('Post Mount dependency disk','success'),
                ('Post Mount git mirror','success'),('Complete runner','success'),('Complete job','success')]
        job.update(conclusion='cancelled',runner_id=11,runner_name='exact-runner',steps=[
            {'name':label,'conclusion':conclusion,'status':'completed','number':i+1,
             'completed_at':'2026-11-09T00:00:00Z'} for i,(label,conclusion) in enumerate(labels)])
        self.seen['artifacts']['artifacts'][0]['workflow_run']['head_branch']=self.tag
        for n,doc in [('request.json',self.request),('result.json',self.adapter),('receipt.json',self.receipt),
                      ('output.log.process.json',self.process)]: (self.folder/n).write_text(json.dumps(doc))
        self.proof['receipt_sha256']=self.c.sha_file(self.folder/'receipt.json')
        self.proof['original_files']={n:self.c.sha_file(self.folder/n) for n in self.m.FILES}
        with zipfile.ZipFile(self.artifact,'w') as z:
            for n,doc in [('request.json',self.request),('timing.json',{'job_started_at':100,'extracted_at':101}),
                          ('bundle.json',{'bytes':0,'skipped':[],'captured':[]})]:z.writestr(n,json.dumps(doc))
        self.proof['remote']['artifact_sha256']=self.c.sha_file(self.artifact)
        self.seen['artifacts']['artifacts'][0]['digest']='sha256:'+self.proof['remote']['artifact_sha256']
        return name

    def test_cancelled_missing_result_controller_certificate_routes_normal_reexecute_without_credit(self):
        name=self.cancelled_controller_fixture()
        original=copy.deepcopy(self.state)
        files={p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()}
        self.assertEqual(self.c.retained_owners(self.state,[name]),[name])
        self.c.reconcile(self.state,'failure',self.proof)
        self.assertEqual(self.c.retained_owners(self.state,[name]),[])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.c.reexecute(self.state,'failure')
        self.assertIn(name,self.state['repair_gates'])
        self.assertEqual(self.state['failures'][0]['native_result'],'UNVERIFIED')
        self.assertIs(self.state['failures'][0]['complete'],False)
        self.assertEqual(self.state['attempts'],original['attempts'])
        self.assertEqual({p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()},files)

    def test_cancelled_missing_result_refuses_foreign_recipe_owner_job_process_and_artifact(self):
        import zipfile
        self.cancelled_controller_fixture()
        pristine=copy.deepcopy((self.state,self.request,self.adapter,self.receipt,self.process,self.seen,self.proof))
        files={p.name:p.read_bytes() for p in self.folder.iterdir() if p.is_file()}
        mutations=[lambda:self.request.update(gate='semantic-stack'),
                   lambda:self.request['source'].update(head='f'*40),
                   lambda:self.adapter.update(cleanup_owner={}),
                   lambda:self.seen['jobs']['jobs'][0].update(status='in_progress'),
                   lambda:self.seen['jobs']['jobs'][0]['steps'][2].update(conclusion='failure'),
                   lambda:self.seen['jobs']['jobs'][0].update(runner_name='foreign'),
                   lambda:self.process.update(child_pid=99),
                   lambda:self.request['worker_recipe']['cases']['cloudbench-controller'].update(command=['python3','scripts/run-bench-cloud']),
                   lambda:self.seen['artifacts']['artifacts'][0].update(digest='sha256:forged')]
        for i,mutate in enumerate(mutations):
            self.state,self.request,self.adapter,self.receipt,self.process,self.seen,self.proof=copy.deepcopy(pristine)
            for name,data in files.items():(self.folder/name).write_bytes(data)
            mutate()
            for n,doc in [('request.json',self.request),('result.json',self.adapter),('output.log.process.json',self.process)]:
                (self.folder/n).write_text(json.dumps(doc));self.proof['original_files'][n]=self.c.sha_file(self.folder/n)
            before=copy.deepcopy(self.state)
            with self.subTest(control=i),self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
            self.assertEqual(self.state,before)
        for control in ('contradictory_result','malformed_bundle','forged_file'):
            self.state,self.request,self.adapter,self.receipt,self.process,self.seen,self.proof=copy.deepcopy(pristine)
            for name,data in files.items():(self.folder/name).write_bytes(data)
            with zipfile.ZipFile(self.artifact) as z:members={n:z.read(n) for n in z.namelist()}
            if control=='contradictory_result':members['result.json']=json.dumps({'cleanup_complete':True}).encode()
            elif control=='malformed_bundle':members['bundle.json']=b'[]'
            else:members['files/unmanifested']=b'forged'
            with zipfile.ZipFile(self.artifact,'w') as z:
                for name,data in members.items():z.writestr(name,data)
            self.proof['remote']['artifact_sha256']=self.c.sha_file(self.artifact)
            self.seen['artifacts']['artifacts'][0]['digest']='sha256:'+self.proof['remote']['artifact_sha256']
            before=copy.deepcopy(self.state)
            with self.subTest(control=control),self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
            self.assertEqual(self.state,before)

    def test_cancelled_missing_result_external_gate_stays_owned(self):
        import zipfile
        for gate in ('semantic-stack','codeagent-smoke','smoke','agentcard-lifecycle'):
            self.cancelled_controller_fixture()
            self.request.update(gate=gate,checks=[gate])
            self.adapter.update(gate=gate,cases={gate:'UNVERIFIED'})
            self.receipt.update(gate=gate,cases={gate:'UNVERIFIED'})
            self.state['failures'][0]['gate']=gate
            self.state['plan']['gates'][0]['name']=gate
            self.tag=gh.tag_name(RUNNER,gate,self.token)
            self.adapter['remote']['tag']=self.tag
            self.seen['run']['head_branch']=self.tag
            self.seen['artifacts']['artifacts'][0]['workflow_run']['head_branch']=self.tag
            for n,doc in [('request.json',self.request),('result.json',self.adapter),('receipt.json',self.receipt)]:
                (self.folder/n).write_text(json.dumps(doc))
            self.proof['receipt_sha256']=self.c.sha_file(self.folder/'receipt.json')
            self.proof['original_files']={n:self.c.sha_file(self.folder/n)for n in self.m.FILES}
            with zipfile.ZipFile(self.artifact,'w') as z:
                for n,doc in [('request.json',self.request),('timing.json',{'job_started_at':100,'extracted_at':101}),
                              ('bundle.json',{'bytes':0,'skipped':[],'captured':[]})]:z.writestr(n,json.dumps(doc))
            self.proof['remote']['artifact_sha256']=self.c.sha_file(self.artifact)
            self.seen['artifacts']['artifacts'][0]['digest']='sha256:'+self.proof['remote']['artifact_sha256']
            before=copy.deepcopy(self.state)
            with self.subTest(gate=gate),self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
            self.assertEqual(self.state,before)

    def test_cancelled_certificate_survives_current_source_refresh_but_not_original_contract_drift(self):
        name = self.cancelled_controller_fixture()
        self.state['ready'] = False
        self.c.reconcile(self.state, 'failure', self.proof)
        original = copy.deepcopy(self.state['attempts'])
        self.state['source'] = {'head': '9' * 40, 'digest': '8' * 64}
        self.state['plan']['source'] = self.state['source']
        self.state['plan']['gates'][0]['explanation'] = 'current refreshed selection'
        self.state['input_fingerprints'][name] = '7' * 64
        self.state['environment'] = '6' * 64
        self.assertEqual(self.c.retained_owners(self.state, [name]), [])
        self.assertEqual(self.state['attempts'], original)
        pristine = copy.deepcopy(self.state)
        record = next(iter(self.state['reconciled_owners'].values()))
        record['original_controller_gate']['worker_recipe']['cases'][name]['command'] = ['foreign']
        self.assertEqual(self.c.retained_owners(self.state, [name]), [name])
        self.state = pristine
        self.c.reexecute(self.state, 'failure')
        self.assertIn(name, self.state['repair_gates'])
        self.assertEqual(self.state['attempts'], original)
        self.assertFalse(self.state['ready'])


class GitHubRunnerRetirement(unittest.TestCase):
    from deploy_test_github_retirement import registered_runners as inventory_reader

    def setUp(self):
        import deploy_test_github_retirement as retirement
        import zipfile
        GitHubTerminalCleanup.setUp(self)
        self.retirement = retirement
        self.gate = {'name':'semantic-stack', 'category':'semantic-stack', 'worker_transport':'github-actions',
                     'command':[sys.executable,str(ROOT/'scripts/deploy_test_github.py')]}
        self.receipt.update(command=self.gate['command'], native_exit=1, cancelled=True, timed_out=False,
                            execution_binding={'contract_digest':self.c.digest(self.gate)}, executed=True)
        (self.folder/'receipt.json').write_text(json.dumps(self.receipt))
        self.proof.update(kind=retirement.KIND, execution_gate=self.gate,
                          receipt_sha256=self.c.sha_file(self.folder/'receipt.json'))
        self.proof['original_files']['receipt.json'] = self.proof['receipt_sha256']
        with zipfile.ZipFile(self.artifact,'w') as z:
            z.writestr('request.json',json.dumps(self.request))
            z.writestr('timing.json',json.dumps({'extracted_at':100}))
        digest=self.c.sha_file(self.artifact)
        self.proof['remote']['artifact_sha256']=digest
        self.seen['artifacts']['artifacts'][0]['digest']='sha256:'+digest
        self.seen['run']['conclusion']='cancelled'
        job=self.seen['jobs']['jobs'][0]
        job['runner_id']=99
        job['steps']=[{'name':name,'status':'completed','conclusion':'success',
                       'started_at':start,'completed_at':end} for name,start,end in [
            ('Complete runner','2026-11-09T00:00:00Z','2026-11-09T00:00:01Z'),
            ('Complete job','2026-11-09T00:00:01Z','2026-11-09T00:00:02Z')]]
        self.log=(b'2026-11-09T00:00:00.5Z No active SSH sessions detected. Proceeding with shutdown immediately.\n'
                  b'2026-11-09T00:00:01.5Z Cleaning up orphan processes\n')
        self.log_path=self.folder/'job.log';self.log_path.write_bytes(self.log)
        self.proof['job_logs']={'8':{'path':str(self.log_path),'sha256':self.c.sha_file(self.log_path)}}
        self.enterContext(patch.object(retirement,'registered_runners',return_value=set()))
        self.enterContext(patch.object(retirement,'job_log',side_effect=lambda _: self.log))

    def test_missing_result_can_retire_only_the_verified_runner_not_the_test(self):
        before=copy.deepcopy(self.state['attempts'])
        self.c.reconcile(self.state,'failure',self.proof)
        entry=next(iter(self.state['reconciled_owners'].values()))
        self.assertTrue(entry['runtime_retired'])
        self.assertFalse(entry['native_cleanup_verified'])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(before,self.state['attempts'])
        self.assertEqual(['failure'],self.state['pending'])
        self.assertEqual([],self.c.retained_owners(self.state,['semantic-stack']))

    def test_present_runner_or_missing_provider_teardown_refuses(self):
        with patch.object(self.retirement,'registered_runners',return_value={99}):
            with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
        for change in ({'status':'in_progress'}, {'conclusion':'failure'}):
            original=copy.deepcopy(self.seen['jobs']['jobs'][0]['steps'][0])
            self.seen['jobs']['jobs'][0]['steps'][0].update(change)
            with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
            self.seen['jobs']['jobs'][0]['steps'][0]=original

    def test_fake_or_wrong_time_log_is_not_provider_teardown(self):
        original=self.log
        for body in (original.replace(b'00:00:00.5',b'00:10:00.5'), b'No active SSH sessions detected. Proceeding with shutdown immediately.'):
            self.log=body;self.log_path.write_bytes(body)
            self.proof['job_logs']['8']['sha256']=self.c.sha_file(self.log_path)
            with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)
        self.log=original;self.log_path.write_bytes(b'forged')
        self.proof['job_logs']['8']['sha256']=self.c.sha_file(self.log_path)
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)

    def test_cloud_or_changed_execution_contract_refuses(self):
        self.gate['native_cloud']=True
        self.receipt['execution_binding']['contract_digest']=self.c.digest(self.gate)
        (self.folder/'receipt.json').write_text(json.dumps(self.receipt))
        self.proof['receipt_sha256']=self.c.sha_file(self.folder/'receipt.json')
        self.proof['original_files']['receipt.json']=self.proof['receipt_sha256']
        with self.assertRaises(ValueError):self.c.reconcile(self.state,'failure',self.proof)

    def test_registered_runner_inventory_requires_complete_unambiguous_pages(self):
        for documents in ([{'total_count':True,'runners':[]}],
                          [{'total_count':1,'runners':[]}],
                          [{'total_count':2,'runners':[{'id':99}]},{'total_count':2,'runners':[]}],
                          [{'total_count':2,'runners':[{'id':99},{'id':99}]}],
                          [{'total_count':1,'runners':[{'id':True}]}]):
            from unittest.mock import Mock
            client=Mock()
            client.json.side_effect=documents
            with self.subTest(documents=documents), patch.object(gh,'GitHub',return_value=client), \
                    patch.object(gh,'load_token',return_value='fixture-only'):
                with self.assertRaises(ValueError):
                    # Call the real implementation, not setUp's isolated observation.
                    type(self).inventory_reader()

    def test_retirement_revalidates_without_upgrading_cleanup(self):
        self.c.reconcile(self.state,'failure',self.proof)
        with patch.object(self.retirement,'registered_runners',return_value={99}):
            self.assertEqual(['semantic-stack'],self.c.retained_owners(self.state,['semantic-stack']))
        entry=next(iter(self.state['reconciled_owners'].values()))
        entry['native_cleanup_verified']=True
        self.assertEqual(['semantic-stack'],self.c.retained_owners(self.state,['semantic-stack']))


if __name__ == '__main__':
    unittest.main()
