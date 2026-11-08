#!/usr/bin/env python3
"""Offline tests for scripts/deploy_gates.py: temp git repos, fake preparation, no real gates."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import signal
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_gates as g
from deploy_test_cycle import digest

PORTS = {'backend-coverage-blackbox': 20000, 'frontend-coverage-blackbox': 20510,
         'agents-coverage-blackbox': 21020, 'live-probes': 21530}


def standard(host=()):
    """Shape of deploy_test_plan.standard_template() for the gates the host cuts touch."""
    return {'gates': [
        {'name': 'format', 'category': 'format', 'command': ['python3', 'scripts/check_deploy_static.py', 'format'],
         'checks': ['format']},
        {'name': 'deploy-command-structural', 'category': 'deploy-command-structural', 'cwd': '.', 'env': {},
         'command': ['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '5'],
         'checks': ['deploy-command-structural']},
        {'name': 'backend-coverage-blackbox', 'category': 'backend-coverage-blackbox', 'native_backend': True,
         'case_protocol': True, 'cwd': '.', 'env': {'BLACKBOX_TEST_CONCURRENCY': '1'},
         'command': ['python3', 'scripts/deploy_test_backend.py'], 'runner_command': ['npm', 'run', 'x'],
         'checks': ['unit:a', 'blackbox:b']},
        {'name': 'semantic-stack', 'category': 'semantic-stack', 'cwd': '.', 'env': {'KEEP': '1'},
         'command': ['bash', 'scripts/run-deploy-semantic-stack.sh'], 'checks': ['semantic-stack']},
        {'name': 'e2b-smoke', 'category': 'e2b-smoke', 'cwd': '.', 'env': {},
         'command': ['bash', 'scripts/run-deploy-semantic-stack.sh', '--e2b-smoke-only'], 'checks': ['e2b-smoke']},
    ]}


def write_proc(proc, pid, ppid, comm, cwd, rss_pages, pss_kb=None):
    """A fake /proc/<pid>: stat, statm, cwd link and (when readable) smaps_rollup."""
    entry = proc / str(pid)
    entry.mkdir(parents=True)
    (entry / 'stat').write_text(f'{pid} ({comm}) S {ppid} {pid} {pid} 0 -1 0\n')
    (entry / 'statm').write_text(f'{rss_pages * 3} {rss_pages} 10 1 0 5 0\n')
    if cwd is not None:
        os.symlink(cwd, entry / 'cwd')
    if pss_kb is not None:
        (entry / 'smaps_rollup').write_text(f'00400000-7fff [rollup]\nRss: {rss_pages * 4} kB\nPss: {pss_kb} kB\n')


def sh(cwd, *args):
    return subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True).stdout


def env_file(values):
    script = ''.join(f"printf 'export {k}=%q\\n' {json.dumps(v)}; " for k, v in values.items())
    return subprocess.run(['bash', '-c', script], check=True, capture_output=True, text=True).stdout


def args(**overrides):
    base = dict(base='origin/main', state_dir=None, dry_run=False,
                provision_jobs=4, head=None, rca_launcher=None, structural_workers=g.STRUCTURAL_WORKERS,
                semantic_worker_processes=g.SEMANTIC_WORKER_PROCESSES, sample_memory=None, abort_below_mb=None,
                executor='local')
    return SimpleNamespace(**{**base, **overrides})


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        top = Path(self.tmp.name).resolve()
        self.root, self.workers = top / 'rose', top / 'workers'
        self.root.mkdir()
        sh(self.root, 'git', 'init', '-q')
        (self.root / '.gitignore').write_text('.context/\nnode_modules/\n')
        (self.root / 'a.txt').write_text('one')
        (self.root / 'agents/benchmarks/history').mkdir(parents=True)
        (self.root / 'agents/benchmarks/history/runs.jsonl').write_text('{}\n')
        self.commit('first')
        self.old = sh(self.root, 'git', 'rev-parse', 'HEAD').strip()
        (self.root / 'a.txt').write_text('two')
        self.commit('second')
        self.head = sh(self.root, 'git', 'rev-parse', 'HEAD').strip()
        self.environ = patch.dict(os.environ, {'DEPLOY_WORKER_ROOT': str(self.workers)})
        self.environ.start()
        os.environ.pop('DEPLOY_TEST_CYCLE_STATE_DIR', None)
        os.environ.pop('DEPLOY_RUN_ROOT', None)
        (self.root / '.context/deploy-runs').mkdir(parents=True)
        (self.root / '.context/deploy-runs/current').write_text('run-1\n')  # deploy.md step 3
        self.calls, self.calls_lock, self.prepare_hook = [], threading.Lock(), None
        self.events = []
        self.system_pg = True
        for name, fake in (('run_logged', self.fake_run),
                           ('backend_recipe', lambda root, env, timeout: {'sentinel': timeout}),
                           ('standard_template', standard),
                           ('factory_event', lambda root, *event: self.events.append(event)),
                           ('check_capacity', lambda root, workers, proc=None: {
                               'memory_mb': 0, 'available_mb': 0, 'disk_mb': 0, 'free_disk_mb': 0})):
            patcher = patch.object(g, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.environ.stop()
        self.tmp.cleanup()

    def commit(self, message):
        sh(self.root, 'git', 'add', '-A')
        sh(self.root, 'git', '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', message)

    def fake_run(self, argv, cwd, log, timeout):
        with self.calls_lock:
            self.calls.append(list(argv))
        if argv[0] == 'git':
            subprocess.run(argv, check=True, capture_output=True)
            return
        path = Path(argv[argv.index('--worktree') + 1])
        if self.prepare_hook:
            self.prepare_hook(path)
        values = {'ROSE_DEPLOY_WORKTREE': '1', 'ROSE_DEPLOY_WORKTREE_PATH': str(path),
                  'ROSE_DEPLOY_SOURCE_WORKSPACE': str(self.root), 'CONDUCTOR_WORKSPACE_PATH': str(path),
                  'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1',
                  'CONDUCTOR_WORKSPACE_NAME': f'{path.name}-abc123', 'CONDUCTOR_PORT': str(PORTS[path.name])}
        if self.system_pg:
            values['ROSE_USE_SYSTEM_PG'] = 'true'
        (path / '.context').mkdir(exist_ok=True)
        if self.system_pg:
            (path / '.context/deploy-system-pg.db').write_text(f'victoria_deploy_{path.name}\n')
        (path / '.context/deploy-worktree.env').write_text(env_file(values))

    def path(self, gate, head=None):
        return self.workers / g.repo_id(self.root) / (head or self.head)[:12] / gate

    def provision(self, gates, head=None):
        return g.build_inventory(self.root, head or self.head, g.layout(self.root, head or self.head, gates),
                                 self.root / '.context/deploy-pipeline/workers')


class Paths(Fixture):
    def test_worker_path_is_worker_root_repo_head12_gate(self):
        repo = g.repo_id(self.root)
        self.assertRegex(repo, r'^rose-[0-9a-f]{12}$')
        self.assertEqual(self.workers / repo / self.head[:12] / 'live-probes',
                         g.worker_path(g.worker_base(self.root), repo, self.head, 'live-probes'))
        linked = Path(self.tmp.name) / 'linked'
        sh(self.root, 'git', 'worktree', 'add', '-q', '--detach', str(linked), 'HEAD')
        self.assertEqual(repo, g.repo_id(linked))  # one id per repository, not per checkout
        other = Path(self.tmp.name) / 'other' / 'rose'
        other.mkdir(parents=True)
        sh(other, 'git', 'init', '-q')
        self.assertNotEqual(repo, g.repo_id(other))
        for unsafe in ('..', '.hidden', 'a/b', ''):
            with self.assertRaises(g.Blocked):
                g.worker_path(self.workers, repo, self.head, unsafe)

    def test_worker_root_must_be_absolute_and_outside_the_checkout(self):
        for value in (str(self.root / '.context/workers'), str(self.root), 'relative/workers'):
            with self.subTest(value=value), patch.dict(os.environ, {'DEPLOY_WORKER_ROOT': value}):
                with self.assertRaises(g.Blocked):
                    g.worker_base(self.root)
        with patch.dict(os.environ, {'DEPLOY_WORKER_ROOT': ''}):
            self.assertEqual(Path(g.DEFAULT_WORKER_ROOT).resolve(), g.worker_base(self.root))


class EnvFile(Fixture):
    def test_parses_printf_q_exports_and_later_lines_win(self):
        target = Path(self.tmp.name) / 'deploy-worktree.env'
        target.write_text('# comment\n\n' + env_file({'ROSE_DEPLOY_WORKTREE_PATH': "/var/tmp/a b/it's",
                                                       'CONDUCTOR_PORT': '20000', 'EMPTY': ''})
                          + 'export ROSE_USE_SYSTEM_PG=true\nexport CONDUCTOR_PORT=20010\n')
        self.assertEqual({'ROSE_DEPLOY_WORKTREE_PATH': "/var/tmp/a b/it's", 'CONDUCTOR_PORT': '20010',
                          'EMPTY': '', 'ROSE_USE_SYSTEM_PG': 'true'}, g.parse_env_file(target))

    def test_rejects_lines_it_cannot_read_exactly(self):
        target = Path(self.tmp.name) / 'bad.env'
        for line in ('CONDUCTOR_PORT=1', 'export X=a b', "export X=$'a\\nb'", 'export 1X=a', 'export X'):
            with self.subTest(line=line):
                target.write_text(line + '\n')
                with self.assertRaises(ValueError):
                    g.parse_env_file(target)


class Inventory(Fixture):
    def test_smoke_uses_the_cloud_slot_and_local_gates_get_prepared_worktrees(self):
        gates = ['backend-coverage-blackbox', 'smoke', 'frontend-coverage-blackbox']
        inventory = self.provision(gates)
        self.assertEqual(gates, list(inventory))
        self.assertEqual({'id': 'cloud-smoke-worker', 'transport': 'benchmark-cloud-cli'}, inventory['smoke'])
        path = self.path('frontend-coverage-blackbox')
        self.assertEqual({'id': 'frontend-coverage-blackbox-local', 'transport': 'local-isolated',
                          'worker_root': str(path), 'cwd': str(path), 'timeout_seconds': g.GATE_DEADLINE_SECONDS,
                          'env': {'CONDUCTOR_WORKSPACE_NAME': 'frontend-coverage-blackbox-abc123',
                                  'CONDUCTOR_PORT': '20510', 'ROSE_USE_SYSTEM_PG': 'true',
                                  'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1', 'ROSE_DEPLOY_WORKTREE': '1',
                                  'ROSE_DEPLOY_WORKTREE_PATH': str(path), 'ROSE_DEPLOY_SOURCE_WORKSPACE': str(self.root),
                                  'CONDUCTOR_WORKSPACE_PATH': str(path),
                                  'DEPLOY_RUN_ROOT': str(self.root / '.context/deploy-runs'),
                                  'BENCHMARK_HISTORY_PARK_DIR': ''}},
                         inventory['frontend-coverage-blackbox'])
        backend = self.path('backend-coverage-blackbox')
        self.assertEqual('postgresql://postgres:postgres@localhost:5432/victoria_deploy_backend-coverage-blackbox',
                         inventory['backend-coverage-blackbox']['env']['BACKEND_COVERAGE_DATABASE_URL'])
        self.assertEqual(str(backend), inventory['backend-coverage-blackbox']['env']['ROSE_DEPLOY_WORKTREE_PATH'])
        self.assertNotIn('BACKEND_COVERAGE_DATABASE_URL', inventory['frontend-coverage-blackbox']['env'])
        self.assertEqual({'sentinel': g.GATE_DEADLINE_SECONDS}, inventory['backend-coverage-blackbox']['recipe'])
        self.assertNotIn('recipe', inventory['frontend-coverage-blackbox'])
        self.assertEqual(self.head, sh(path, 'git', 'rev-parse', 'HEAD').strip())
        self.assertIn(str(path), sh(self.root, 'git', 'worktree', 'list', '--porcelain'))
        self.assertIn(['bash', str(self.root / 'scripts/prepare-deploy-worktree.sh'), '--worktree', str(path),
                       '--source', str(self.root)], self.calls)
        self.assertIn(['git', '-C', str(self.root), 'worktree', 'add', '--detach', str(path), self.head], self.calls)
        self.assertEqual([], g.footprint_conflicts(inventory))

    def test_only_benchmark_gates_park_history_rows(self):
        """RCA 2026-11-07: every local slot got BENCHMARK_HISTORY_PARK_DIR, so agents coverage's ledger
        tests wrote fixture rows ('t', 'first', 'second') into the coordinator's publishable park dir and
        span-history/benchmark failed. Test-suite gates never park; benchmark gates still do."""
        values = {'CONDUCTOR_WORKSPACE_NAME': 'w', 'CONDUCTOR_PORT': '21530'}
        # An inherited coordinator park directory must not reach a test-suite gate either.
        with patch.dict(os.environ, {'BENCHMARK_HISTORY_PARK_DIR': '/srv/inherited-park'}):
            for gate in ('agents-coverage-blackbox', 'deploy-command-structural', 'semantic-stack'):
                path = self.path(gate)
                self.assertEqual('', g.local_slot(self.root, gate, path, values)['env']['BENCHMARK_HISTORY_PARK_DIR'])
            path = self.path('agentcard-lifecycle')
            self.assertEqual(str(self.root.resolve() / '.context/deploy-ledger-park'),
                             g.local_slot(self.root, 'agentcard-lifecycle', path, values)['env']['BENCHMARK_HISTORY_PARK_DIR'])

    def test_system_pg_is_carried_only_when_prepared_and_identity_is_required(self):
        self.system_pg = False
        slots = self.provision(['live-probes', 'backend-coverage-blackbox'])
        self.assertNotIn('ROSE_USE_SYSTEM_PG', slots['live-probes']['env'])
        # Docker mode: the backend uses its prepared container, never a guessed system database URL.
        self.assertNotIn('BACKEND_COVERAGE_DATABASE_URL', slots['backend-coverage-blackbox']['env'])
        path = self.path('agents-coverage-blackbox')
        for broken in ({'CONDUCTOR_WORKSPACE_NAME': 'x'},
                       {'CONDUCTOR_WORKSPACE_NAME': 'x', 'CONDUCTOR_PORT': '1', 'ROSE_DEPLOY_WORKTREE_PATH': '/else'}):
            with self.subTest(broken=broken), self.assertRaises(g.Blocked):
                g.local_slot(self.root, path.name, path, broken)

    def test_worker_identity_overrides_the_inherited_coordinator_identity(self):
        """Gates inherit the coordinator's env; the slot must name the worker, and stage receipts the
        coordinator's timing run (an explicit DEPLOY_RUN_ROOT wins)."""
        path = self.path('live-probes')
        values = {'CONDUCTOR_WORKSPACE_NAME': 'w', 'CONDUCTOR_PORT': '21530', 'ROSE_DEPLOY_WORKTREE': '1',
                  'ROSE_DEPLOY_WORKTREE_PATH': str(path), 'UNRELATED': 'x'}
        with patch.dict(os.environ, {'ROSE_DEPLOY_WORKTREE_PATH': str(self.root), 'DEPLOY_RUN_ROOT': '/srv/runs'}):
            env = g.local_slot(self.root, 'live-probes', path, values)['env']
        self.assertEqual({'CONDUCTOR_WORKSPACE_NAME': 'w', 'CONDUCTOR_PORT': '21530', 'ROSE_DEPLOY_WORKTREE': '1',
                          'ROSE_DEPLOY_WORKTREE_PATH': str(path), 'DEPLOY_RUN_ROOT': '/srv/runs',
                          'BENCHMARK_HISTORY_PARK_DIR': ''}, env)
        backend = self.path('backend-coverage-blackbox')
        backend.mkdir(parents=True)
        system = {**values, 'ROSE_DEPLOY_WORKTREE_PATH': str(backend), 'ROSE_USE_SYSTEM_PG': 'true'}
        env = g.local_slot(self.root, g.BACKEND_GATE, backend, system)['env']
        self.assertNotIn('BACKEND_COVERAGE_DATABASE_URL', env)  # no prepared marker, no URL
        (backend / '.context').mkdir()
        (backend / '.context/deploy-system-pg.db').write_text('victoria_deploy_b\n')
        env = g.local_slot(self.root, g.BACKEND_GATE, backend, system)['env']
        self.assertEqual('postgresql://postgres:postgres@localhost:5432/victoria_deploy_b',
                         env['BACKEND_COVERAGE_DATABASE_URL'])

    def test_overlapping_registry_claims_are_reported_per_pair(self):
        slots = {name: {'transport': 'local-isolated', 'env': {'CONDUCTOR_PORT': port}}
                 for name, port in (('a', '20000'), ('b', '20010'), ('c', '40000'))}
        slots['smoke'] = dict(g.CLOUD_SLOT)
        conflicts = g.footprint_conflicts(slots)
        self.assertEqual(1, len(conflicts))
        self.assertRegex(conflicts[0], r'^a\(20000\) and b\(20010\) share \d+ listener ports$')

    def test_preparation_runs_concurrently_but_worktree_adds_are_serialized(self):
        gates = list(PORTS)
        barrier, active, peak = threading.Barrier(len(gates), timeout=10), [0], [0]
        original = g.subprocess.run

        def counting_run(argv, *a, **k):
            if argv[:1] == ['git'] and 'add' in argv:
                with self.calls_lock:
                    active[0] += 1
                    peak[0] = max(peak[0], active[0])
                try:
                    return original(argv, *a, **k)
                finally:
                    with self.calls_lock:
                        active[0] -= 1
            return original(argv, *a, **k)
        self.prepare_hook = lambda path: barrier.wait()  # deadlocks (BrokenBarrierError) if serialized
        with patch.object(g.subprocess, 'run', counting_run):
            inventory = g.build_inventory(self.root, self.head, g.layout(self.root, self.head, gates),
                                          self.root / '.context/w', jobs=len(gates))
        self.assertEqual(gates, list(inventory))
        self.assertEqual(1, peak[0])

    def test_one_failed_preparation_is_reported_after_every_peer_finishes(self):
        def fail_frontend(path):
            if path.name == 'frontend-coverage-blackbox':
                raise g.Blocked('workers', 'prepare-deploy-worktree.sh exited 1')
        self.prepare_hook = fail_frontend
        with self.assertRaisesRegex(g.Blocked, 'frontend-coverage-blackbox: prepare-deploy-worktree.sh exited 1'):
            self.provision(list(PORTS))
        prepared = {Path(c[3]).name for c in self.calls if c[0] == 'bash'}
        self.assertEqual(set(PORTS), prepared)


class Reuse(Fixture):
    def test_existing_clean_worker_at_head_is_reused_without_a_second_add(self):
        first = self.provision(['live-probes', 'smoke'])
        self.calls.clear()
        self.assertEqual(['reuse', 'cloud'], [w['mode'] for w in g.layout(self.root, self.head, ['live-probes', 'smoke'])])
        self.assertEqual(first, self.provision(['live-probes', 'smoke']))
        self.assertEqual(['bash'], [c[0] for c in self.calls])  # preparation is re-verified, nothing re-created

    def test_dirty_foreign_moved_or_missing_workers_are_refused_before_anything_is_created(self):
        self.provision(['live-probes', 'agents-coverage-blackbox'])
        (self.path('live-probes') / 'scratch.txt').write_text('edit')
        sh(self.path('agents-coverage-blackbox'), 'git', 'checkout', '-q', '--detach', self.old)
        foreign = self.path('frontend-coverage-blackbox')
        foreign.mkdir(parents=True)
        (foreign / 'file').write_text('someone else')
        self.calls.clear()
        workers = g.layout(self.root, self.head, ['live-probes', 'agents-coverage-blackbox',
                                                  'frontend-coverage-blackbox', 'backend-coverage-blackbox'])
        reasons = {w['gate']: w['reason'] for w in workers}
        self.assertIn('is dirty', reasons['live-probes'])
        self.assertIn(f'is at {self.old[:12]}', reasons['agents-coverage-blackbox'])
        self.assertIn('not a worktree of this repository', reasons['frontend-coverage-blackbox'])
        self.assertEqual('create', workers[-1]['mode'])
        with self.assertRaisesRegex(g.Blocked, 'refusing'):
            g.build_inventory(self.root, self.head, workers, self.root / '.context/w')
        self.assertEqual([], self.calls)
        self.assertFalse(self.path('backend-coverage-blackbox').exists())
        empty = self.path('backend-coverage-blackbox')
        empty.mkdir(parents=True)
        self.assertEqual('create', g.worker_status(empty, self.head, g.registered_worktrees(self.root)))
        missing = self.path('live-probes')
        sh(missing, 'git', 'clean', '-qfd')
        shutil.rmtree(missing)
        with self.assertRaisesRegex(g.Blocked, 'directory is missing'):
            g.worker_status(missing, self.head, g.registered_worktrees(self.root))


class Run(Fixture):
    def setUp(self):
        super().setUp()
        self.selection = {'selected': ['format', 'live-probes', 'smoke'], 'quick': ['format'],
                          'needs_worker': ['live-probes', 'smoke'], 'omitted': []}
        self.codes, self.streamed, self.plan = {}, [], {'gates': [{'name': 'format'}], 'source': {'head': self.head}}
        self.state = self.root / '.context/deploy-pipeline'
        self.selected_with, self.watchers = [], []
        for name, fake in (('list_selected', self.fake_list_selected), ('stream', self.fake_stream)):
            patcher = patch.object(g, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def kind(self, argv):
        name = Path(argv[1]).name
        return {'deploy_test_plan.py': 'plan', 'run_deploy_pipeline.py': 'verify'}.get(name, argv[2])

    def fake_list_selected(self, root, base, template):
        self.selected_with.append((template, json.loads(Path(template).read_text())))
        return self.selection

    def fake_stream(self, argv, cwd, on_start=None):
        self.streamed.append(list(argv))
        self.watchers.append(on_start)
        kind = self.kind(argv)
        if kind == 'plan':
            Path(argv[argv.index('--output') + 1]).write_text(json.dumps(self.plan))
        return self.codes.get(kind, 0)

    def go(self, **overrides):
        output = io.StringIO()
        with redirect_stdout(output):
            code = g.run(args(**overrides), self.root)
        return code, output.getvalue()

    def kinds(self):
        return [self.kind(argv) for argv in self.streamed]

    def test_clean_pass_plans_inits_runs_and_verifies_the_exact_head(self):
        code, out = self.go(rca_launcher=['launcher', '--flag'])
        self.assertEqual(0, code)
        self.assertEqual(f'DEPLOY_GATES PASS head={self.head[:12]} gates=3', out.strip().splitlines()[-1])
        self.assertEqual(['plan', 'init', 'run', 'verify'], self.kinds())
        planner, init, run, verify = self.streamed
        self.assertEqual(['--inventory', str(self.state / 'inventory.candidate.json'), '--base', 'origin/main',
                          '--template', str(self.state / 'template.candidate.json'),
                          '--output', str(self.state / 'plan.candidate.json')],
                         planner[2:])
        self.assertEqual(['--plan', str(self.state / 'plan.json'), '--state-dir', str(self.state)], init[3:])
        self.assertEqual(['--rca-launcher', 'launcher', '--flag'], run[-3:])
        self.assertEqual(['verify', '--require-staged', '--state-dir', str(self.state), '--expect-head', self.head],
                         verify[2:])
        inventory = json.loads((self.state / 'inventory.json').read_text())
        self.assertEqual(['live-probes', 'smoke'], list(inventory))
        self.assertEqual(self.plan, json.loads((self.state / 'plan.json').read_text()))
        self.assertFalse((self.state / 'plan.candidate.json').exists())
        expected = g.build_template(g.STRUCTURAL_WORKERS, g.SEMANTIC_WORKER_PROCESSES)
        self.assertEqual([(self.state / 'template.candidate.json', expected)], self.selected_with)
        self.assertEqual(expected, json.loads((self.state / 'template.json').read_text()))
        self.assertFalse((self.state / 'template.candidate.json').exists())
        self.assertEqual([None] * 4, self.watchers)  # nothing is watched without --sample-memory
        self.assertEqual([('stage-start', 'runtime-blackbox'), ('stage-finish', 'runtime-blackbox')], self.events)

    def test_each_stage_exit_code_propagates_and_stops_later_stages(self):
        for kind, code, expected in (('plan', 2, ['plan']), ('init', 2, ['plan', 'init']),
                                     ('run', 1, ['plan', 'init', 'run']), ('verify', 5, ['plan', 'init', 'run', 'verify'])):
            with self.subTest(kind=kind):
                shutil.rmtree(self.state, ignore_errors=True)
                self.codes, self.streamed = {kind: code}, []
                result, out = self.go()
                self.assertEqual(code, result)
                self.assertEqual(expected, self.kinds())
                stage = {'plan': 'plan', 'init': 'init', 'run': 'cycle', 'verify': 'verify'}[kind]
                self.assertIn(f'DEPLOY_GATES BLOCKED head={self.head[:12]} stage={stage} exit={code}:', out)
                if kind in ('run', 'verify'):  # a failed round still closes its runtime-blackbox boundary
                    self.assertEqual(('stage-finish', 'runtime-blackbox'), self.events[-1])

    def test_existing_cycle_is_continued_never_reinitialized(self):
        self.state.mkdir(parents=True)
        for phase, ready, expected, code in (('interrupted', False, ['plan', 'resume', 'verify'], 0),
                                             ('ready', True, ['plan', 'verify'], 0),
                                             ('final', False, ['plan', 'run', 'verify'], 0),
                                             ('triage', False, ['plan', 'status'], 1)):
            with self.subTest(phase=phase):
                (self.state / 'cycle.json').write_text(json.dumps({'plan_digest': digest(self.plan), 'phase': phase,
                                                                   'ready': ready}))
                self.streamed = []
                result, out = self.go()
                self.assertEqual(code, result, out)
                self.assertEqual(expected, self.kinds())

    def test_cycle_for_another_plan_is_kept_unchanged(self):
        self.state.mkdir(parents=True)
        cycle = json.dumps({'plan_digest': 'other', 'phase': 'final', 'ready': False})
        (self.state / 'cycle.json').write_text(cycle)
        (self.state / 'plan.json').write_text('{"original": true}')
        code, out = self.go()
        self.assertEqual(2, code)
        self.assertIn('stage=cycle', out)
        self.assertEqual(['plan'], self.kinds())
        self.assertEqual(cycle, (self.state / 'cycle.json').read_text())
        self.assertEqual('{"original": true}', (self.state / 'plan.json').read_text())
        self.assertTrue((self.state / 'plan.candidate.json').exists())

    def test_uncommitted_source_is_refused_before_selection_but_history_ledgers_may_differ(self):
        (self.root / 'agents/benchmarks/history/runs.jsonl').write_text('{}\n{"new": 1}\n')
        (self.root / 'agents/benchmarks/history/new.jsonl').write_text('{}\n')
        self.assertEqual([], g.dirty_paths(self.root))
        for edit in (lambda: (self.root / 'untracked.py').write_text('x'),
                     lambda: (self.root / 'a.txt').write_text('changed')):
            edit()
            with patch.object(g, 'list_selected', side_effect=AssertionError('selection must not run')):
                code, out = self.go()
            self.assertEqual(2, code)
            self.assertIn('stage=source', out)
            self.assertEqual([], self.streamed)
        self.assertEqual(['a.txt', 'untracked.py'], g.dirty_paths(self.root))

    def test_missing_timing_run_blocks_before_selection(self):
        (self.root / '.context/deploy-runs/current').unlink()
        with patch.object(g, 'list_selected', side_effect=AssertionError('selection must not run')):
            code, out = self.go()
        self.assertEqual(2, code)
        self.assertIn('stage=timing', out)
        self.assertIn('bash scripts/run-deploy-stage --start', out)
        self.assertEqual([], self.streamed + self.calls)
        code, out = self.go(dry_run=True)  # a dry run reports it instead
        self.assertEqual(0, code)
        self.assertEqual({'current': str(self.root / '.context/deploy-runs/current'), 'active': False},
                         json.loads('\n'.join(out.strip().splitlines()[:-1]))['timing_run'])

    def test_overlapping_port_claims_block_before_planning(self):
        self.selection['needs_worker'] = ['live-probes', 'agents-coverage-blackbox']
        with patch.dict(PORTS, {'agents-coverage-blackbox': PORTS['live-probes'] + 10}):
            code, out = self.go()
        self.assertEqual(2, code)
        self.assertIn('prepared port claims overlap the isolation footprint', out)
        self.assertEqual([], self.streamed)

    def test_dry_run_prints_paths_and_commands_and_changes_nothing(self):
        code, out = self.go(dry_run=True)
        self.assertEqual(0, code)
        *body, summary = out.strip().splitlines()
        self.assertEqual(f'DEPLOY_GATES DRY-RUN head={self.head[:12]} gates=3 workers=1', summary)
        shown = json.loads('\n'.join(body))
        worker = shown['workers'][0]
        path = self.path('live-probes')
        self.assertEqual(('live-probes', 'create', str(path)), (worker['gate'], worker['mode'], worker['path']))
        self.assertEqual([['git', '-C', str(self.root), 'worktree', 'add', '--detach', str(path), self.head],
                          ['bash', str(self.root / 'scripts/prepare-deploy-worktree.sh'), '--worktree', str(path),
                           '--source', str(self.root)]], worker['commands'])
        self.assertEqual({'gate': 'smoke', 'mode': 'cloud', 'slot': g.CLOUD_SLOT}, shown['workers'][1])
        self.assertEqual(4, len(shown['then']))
        self.assertEqual([], self.calls + self.streamed)
        self.assertFalse(path.exists() or self.state.exists())
        (scratch, template), = self.selected_with  # a scratch template, gone afterwards
        self.assertNotIn(self.root, scratch.parents)
        self.assertFalse(scratch.exists())
        self.assertEqual(g.build_template(2, 2), template)
        self.assertEqual({'path': str(self.state / 'template.json'), 'structural_workers': 2,
                          'semantic_worker_processes': 2}, shown['template'])
        self.assertIn('--template', shown['then'][0])

    def test_dry_run_reports_a_refused_worker(self):
        foreign = self.path('live-probes')
        foreign.mkdir(parents=True)
        (foreign / 'x').write_text('x')
        code, out = self.go(dry_run=True)
        self.assertEqual(2, code)
        self.assertIn('stage=workers', out.strip().splitlines()[-1])


class Retire(Fixture):
    def retire(self, proc=None, **overrides):
        output = io.StringIO()
        with redirect_stdout(output):
            code = g.retire(args(**overrides), self.root, proc or self.proc)
        return code, output.getvalue()

    def setUp(self):
        super().setUp()
        self.proc = Path(self.tmp.name) / 'proc'
        self.proc.mkdir()

    def test_removes_only_clean_idle_workers_and_never_follows_links(self):
        self.provision(['live-probes', 'agents-coverage-blackbox', 'frontend-coverage-blackbox'])
        dirty, busy, clean = (self.path(n) for n in ('live-probes', 'agents-coverage-blackbox',
                                                       'frontend-coverage-blackbox'))
        (dirty / 'notes.txt').write_text('unsaved')
        (busy / 'sub').mkdir()
        (busy / 'sub/keep').write_text('untracked')
        (self.proc / '4242').mkdir()
        (self.proc / '4242/cwd').symlink_to(busy)
        (self.proc / 'self').mkdir()
        outside = Path(self.tmp.name) / 'shared-venv'
        outside.mkdir()
        (outside / 'python').write_text('keep me')
        (clean / 'node_modules').mkdir()
        (clean / 'node_modules/venv').symlink_to(outside, target_is_directory=True)
        code, out = self.retire()
        self.assertEqual(1, code)
        self.assertFalse(clean.exists())
        self.assertEqual('keep me', (outside / 'python').read_text())
        self.assertNotIn(str(clean), sh(self.root, 'git', 'worktree', 'list', '--porcelain'))
        self.assertTrue(dirty.exists() and busy.exists())
        self.assertIn(f'RETAINED {dirty}: dirty', out)
        self.assertIn(f'RETAINED {busy}: dirty', out)  # the untracked sub/keep also makes it dirty
        (busy / 'sub/keep').unlink()
        (busy / 'sub').rmdir()
        code, out = self.retire()
        self.assertIn(f'RETAINED {busy}: live process cwd inside: pid 4242', out)
        self.assertEqual('DEPLOY_GATES RETIRE removed=0 retained=2', out.strip().splitlines()[-1])

    def test_reports_released_claim_and_retained_database_then_prunes_empty_parents(self):
        self.provision(['frontend-coverage-blackbox'])
        path = self.path('frontend-coverage-blackbox')
        (path / '.context/deploy-system-pg.db').write_text('victoria_deploy_frontend\n')
        code, out = self.retire(dry_run=True)
        self.assertEqual(0, code)
        self.assertTrue(path.exists())
        self.assertIn(f'WOULD REMOVE {path}', out)
        code, out = self.retire()
        self.assertEqual(0, code)
        self.assertIn(f'REMOVED {path}: port claim 20510 is released by the registry once its owner directory '
                      'is gone; system Postgres database victoria_deploy_frontend retained', out)
        self.assertEqual('DEPLOY_GATES RETIRE removed=1 retained=0', out.strip().splitlines()[-1])
        self.assertFalse(path.parent.exists() or path.parent.parent.exists())
        self.assertTrue(self.workers.exists())

    def test_head_scope_strays_and_unobservable_hosts(self):
        self.provision(['live-probes'])
        self.provision(['live-probes'], head=self.old)
        stray = self.path('agents-coverage-blackbox')
        stray.mkdir(parents=True)
        code, out = self.retire(head=self.head)
        self.assertEqual(1, code)
        self.assertFalse(self.path('live-probes').exists())
        self.assertTrue(self.path('live-probes', self.old).exists())
        self.assertIn(f'RETAINED {stray}: not a registered worktree of this repository', out)
        code, out = self.retire(proc=Path(self.tmp.name) / 'no-proc', head=self.old)
        self.assertIn('process working directories cannot be observed on this host', out)
        self.assertTrue(self.path('live-probes', self.old).exists())

    def test_benchmark_history_rows_are_preserved_then_the_worker_is_removed(self):
        self.provision(['live-probes'])
        path = self.path('live-probes')
        (path / 'agents/benchmarks/history/runs.jsonl').write_text('{}\n{"task": "agent-payment-test-shop"}\n')
        (path / 'agents/benchmarks/history/span_durations.extra.jsonl').write_text('{"span": 1}\n')
        code, out = self.retire()
        self.assertEqual(0, code, out)
        self.assertFalse(path.exists())
        kept = self.root / '.context/deploy-worker-ledgers' / path.parent.name / path.name / 'agents/benchmarks/history'
        self.assertEqual('{}\n{"task": "agent-payment-test-shop"}\n', (kept / 'runs.jsonl').read_text())
        self.assertEqual('{"span": 1}\n', (kept / 'span_durations.extra.jsonl').read_text())
        self.assertIn(f'PRESERVED 2 benchmark-history file(s) from {path}', out)

    def test_other_edits_beside_ledger_rows_still_block(self):
        self.provision(['live-probes'])
        path = self.path('live-probes')
        (path / 'agents/benchmarks/history/runs.jsonl').write_text('{}\n{"x": 1}\n')
        (path / 'a.txt').write_text('edited')
        code, out = self.retire()
        self.assertEqual(1, code)
        self.assertIn(f'RETAINED {path}: dirty: 1 changed or untracked paths (e.g. a.txt)', out)
        self.assertEqual('{}\n{"x": 1}\n', (path / 'agents/benchmarks/history/runs.jsonl').read_text())

    @unittest.skipUnless(Path('/proc/self/cwd').exists(), 'Linux /proc required')
    def test_real_proc_scan_sees_a_child_running_inside_the_worker(self):
        self.provision(['live-probes'])
        path = self.path('live-probes')
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=path)
        try:
            self.assertIn(child.pid, g.live_processes(path))
        finally:
            child.terminate()
            child.wait()
        self.assertNotIn(child.pid, g.live_processes(path))


class Capacity(unittest.TestCase):
    """Fail before provisioning when the box cannot hold the selected gates."""
    ALL = [{'gate': g, 'mode': 'create'} for g in g.GATE_PEAK_PSS_MB] + [{'gate': 'smoke', 'mode': 'cloud'}]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proc = Path(self.tmp.name) / 'proc'
        (self.proc / '4242').mkdir(parents=True)
        (self.proc / '4242/stat').write_text('4242 (node) S 1 0 0')
        (self.proc / '4242/statm').write_text('0 262144 0')  # 1 GiB at 4 KiB pages

    def tearDown(self):
        self.tmp.cleanup()

    def meminfo(self, available_mb):
        (self.proc / 'meminfo').write_text(f'MemTotal: {16 * 1024 * 1024} kB\nMemAvailable: {available_mb * 1024} kB\n')

    def check(self, workers, available_mb, free_gb):
        self.meminfo(available_mb)
        out = io.StringIO()
        usage = SimpleNamespace(total=0, used=0, free=free_gb * 2**30)
        with patch.object(g.shutil, 'disk_usage', return_value=usage), \
             patch.object(g, 'worker_base', return_value=Path(self.tmp.name)), \
             patch.object(g.os, 'sysconf', return_value=4096), redirect_stdout(out):
            try:
                return g.check_capacity(Path(self.tmp.name), workers, self.proc), out.getvalue()
            except g.Blocked as error:
                return error, out.getvalue()

    def test_full_measured_selection_needs_its_measured_peak_plus_margin_and_floor(self):
        need = g.capacity_requirements(self.ALL)
        share = sum(g.GATE_PEAK_PSS_MB.values()) / g.MEASURED_TOTAL_PSS_MB
        self.assertEqual(round(g.MEASURED_CONCURRENT_MB * share * g.MEMORY_MARGIN) + 1024, need['gates_mb'])
        self.assertEqual(need['gates_mb'] + g.WATCHDOG_FLOOR_MB, need['memory_mb'])
        self.assertEqual(11, need['new_workers'])
        self.assertEqual(11 * g.WORKER_DISK_MB + g.DISK_MARGIN_MB, need['disk_mb'])

    def test_retired_agentcard_lane_keeps_every_remaining_gate_estimate_and_charges_smoke_its_controller(self):
        # The AgentCard tasks run in cloud smoke now; the local lane and its 1,500 MB peak are gone, but the
        # 2026-11-05 measurement it was part of still weights every remaining gate exactly as before.
        self.assertNotIn('agentcard-lifecycle', g.GATE_PEAK_PSS_MB)
        self.assertEqual(18_330, g.MEASURED_TOTAL_PSS_MB)
        for gate, peak in g.GATE_PEAK_PSS_MB.items():
            with self.subTest(gate=gate):
                self.assertEqual(round(g.MEASURED_CONCURRENT_MB * peak / 18_330 * g.MEMORY_MARGIN),
                                 g.capacity_requirements([{'gate': gate, 'mode': 'reuse'}])['gates_mb'])
        smoke = g.capacity_requirements([{'gate': 'smoke', 'mode': 'cloud'}])
        self.assertEqual((1024, 0, 0), (smoke['gates_mb'], smoke['new_workers'], smoke['disk_mb']))

    def test_subsets_scale_by_measured_peaks_and_unknown_gates_are_charged(self):
        small = g.capacity_requirements([{'gate': 'seed-cache-decision', 'mode': 'reuse'}])
        self.assertLess(small['gates_mb'], 100)
        self.assertEqual(0, small['disk_mb'])
        unknown = g.capacity_requirements([{'gate': 'new-gate', 'mode': 'create'}])
        self.assertEqual(g.DEFAULT_GATE_MB, unknown['gates_mb'])

    def test_an_idle_box_passes(self):
        report, out = self.check(self.ALL, available_mb=14_700, free_gb=80)
        self.assertNotIsInstance(report, g.Blocked)
        self.assertEqual('', out)

    def test_a_busy_box_fails_early_listing_needs_and_largest_processes(self):
        error, out = self.check(self.ALL, available_mb=9_000, free_gb=30)
        self.assertIsInstance(error, g.Blocked)
        self.assertEqual(('capacity', g.CAPACITY_EXIT), (error.stage, error.code))
        need = g.capacity_requirements(self.ALL)
        self.assertIn(f"NEED memory: need {need['memory_mb']} MB available", out)
        self.assertIn(f"available now 9000 MB; free {need['memory_mb'] - 9000} MB", out)
        self.assertIn('NEED disk: need 61.1 GB free (11 new workers x 5.4 GB + 2 GB); free now 30.0 GB', out)
        self.assertIn('pid 4242 1024 MB node', out)
        self.assertIn('scripts/deploy gates retire', out)
        self.assertIn('nothing was provisioned', out)


class Cli(Fixture):
    def test_arguments(self):
        with patch.object(g, 'run', return_value=7) as run, patch.object(g, 'ROOT', self.root):
            self.assertEqual(7, g.main(['--dry-run', '--rca-launcher', 'boxes', '--to', 'x']))
        parsed = run.call_args[0][0]
        self.assertEqual(('run', True, ['boxes', '--to', 'x']), (parsed.action, parsed.dry_run, parsed.rca_launcher))
        with patch.object(g, 'retire', return_value=0) as retire, patch.object(g, 'ROOT', self.root):
            self.assertEqual(0, g.main(['retire', '--head', self.head]))
        self.assertEqual(self.head, retire.call_args[0][0].head)
        # AgentCard runs inside cloud smoke: there is no AgentCard gate to elect away.
        for bad in (['retire', '--rca-launcher', 'x'], ['--head', 'abc'], ['--skip-agentcard', 'no card today'],
                    ['--provision-jobs', '0'], ['deploy'], ['--structural-workers', '0'],
                    ['--semantic-worker-processes', '0'], ['--semantic-worker-processes', '1000'],
                    ['--abort-below-mb', '1200'], ['--sample-memory', 'm.jsonl', '--abort-below-mb', '0'],
                    ['--dry-run', '--sample-memory', 'm.jsonl'], ['retire', '--structural-workers', '2'],
                    ['retire', '--sample-memory', 'm.jsonl']):
            with self.subTest(bad=bad), redirect_stdout(io.StringIO()), \
                    patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                g.main(bad)

    def test_list_selected_passes_selection_flags_and_fails_closed(self):
        selection = {'selected': ['format'], 'quick': ['format'], 'needs_worker': [], 'omitted': []}
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(selection))
        template = self.root / 'template.json'
        with patch.object(g.subprocess, 'run', return_value=done) as run:
            self.assertEqual(selection, g.list_selected(self.root, 'review-base', template))
        self.assertEqual(['--list-selected', '--base', 'review-base', '--template', str(template)],
                         run.call_args[0][0][2:])
        for result, code in ((subprocess.CompletedProcess([], 2, stdout=''), 2),
                             (subprocess.CompletedProcess([], 0, stdout='{"selected": []}'), 2)):
            with self.subTest(code=result.returncode), patch.object(g.subprocess, 'run', return_value=result):
                with self.assertRaises(g.Blocked) as caught:
                    g.list_selected(self.root, 'origin/main', template)
                self.assertEqual(code, caught.exception.code)

    def test_host_cut_flags_default_and_pass_through(self):
        with patch.object(g, 'run', return_value=0) as run, patch.object(g, 'ROOT', self.root):
            g.main([])
            parsed = run.call_args[0][0]
            self.assertEqual((2, 2, None, None), (parsed.structural_workers, parsed.semantic_worker_processes,
                                                  parsed.sample_memory, parsed.abort_below_mb))
            g.main(['--executor', 'local', '--structural-workers', '5', '--semantic-worker-processes', '8',
                    '--sample-memory', 'm.jsonl', '--abort-below-mb', '1200'])
            parsed = run.call_args[0][0]
            self.assertEqual((5, 8, Path('m.jsonl'), 1200.0), (parsed.structural_workers,
                             parsed.semantic_worker_processes, parsed.sample_memory, parsed.abort_below_mb))

    def test_stream_returns_the_child_exit_code(self):
        self.assertEqual(3, g.stream([sys.executable, '-c', 'raise SystemExit(3)'], self.root))

    def test_stream_hands_the_exact_child_to_on_start_and_clears_it(self):
        seen = []
        self.assertEqual(0, g.stream([sys.executable, '-c', 'pass'], self.root, on_start=seen.append))
        self.assertIsInstance(seen[0], subprocess.Popen)
        self.assertEqual([0, None], [seen[0].returncode, seen[1]])


class Template(unittest.TestCase):
    def test_cuts_only_structural_width_and_semantic_workers(self):
        original = standard()
        cut = g.build_template(3, 4, standard=lambda: original)
        self.assertEqual(standard(), original)  # the standard template object is not mutated
        by_name = {gate['name']: gate for gate in cut['gates']}
        self.assertEqual(['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '3'],
                         by_name['deploy-command-structural']['command'])
        self.assertEqual({'KEEP': '1', 'DEPLOY_SEMANTIC_WORKER_PROCESSES': '4'}, by_name['semantic-stack']['env'])
        # Everything else, including the native backend recipe fields and every check list, is unchanged.
        for gate in cut['gates']:
            source = next(g0 for g0 in original['gates'] if g0['name'] == gate['name'])
            ignored = {'deploy-command-structural': 'command', 'semantic-stack': 'env'}.get(gate['name'])
            self.assertEqual({k: v for k, v in source.items() if k != ignored},
                             {k: v for k, v in gate.items() if k != ignored}, gate['name'])
        self.assertEqual({}, by_name['e2b-smoke']['env'])  # the standalone E2B lane starts no stack

    def test_refuses_a_template_it_cannot_cut(self):
        def without(name):
            return lambda: {'gates': [x for x in standard()['gates'] if x['name'] != name]}

        def structural(command):
            def make():
                template = standard()
                template['gates'][1]['command'] = command
                return template
            return make
        for case in (without('deploy-command-structural'), without('semantic-stack'),
                     structural(['python3', 'scripts/run-deploy-structural-gates.py']),
                     structural(['python3', 'x.py', '--max-workers', '1', '--max-workers', '2']),
                     structural(['python3', 'x.py', '--max-workers'])):
            with self.assertRaises(g.Blocked) as caught:
                g.build_template(2, 2, standard=case)
            self.assertEqual('template', caught.exception.stage)

    def test_blacksmith_plan_uses_a_fixed_reference_host_and_local_follows_this_host(self):
        """A VM's worker counts must not drift with the coordinator's live MemAvailable (resume matched plans)."""
        seen = []

        def recorder(host=()):
            seen.append(tuple(host))
            return standard()

        with patch.object(g, 'standard_template', recorder):
            g.build_template(2, 2, executor='blacksmith')
            g.build_template(2, 2, executor='local')
        self.assertEqual([g.BLACKSMITH_REFERENCE_HOST, ()], seen)
        flags = dict(zip(g.BLACKSMITH_REFERENCE_HOST[::2], g.BLACKSMITH_REFERENCE_HOST[1::2]))
        self.assertEqual({'--host-cpus', '--host-mem-mb', '--host-total-mem-mb', '--host-watchdog-mb'}, set(flags))

    def test_real_standard_template_keeps_the_native_backend_recipe(self):
        """The cut applies to the actual standard template and leaves the backend's native fields intact."""
        real = g.standard_template()
        cut = g.build_template(2, 2)
        names = [gate['name'] for gate in real['gates']]
        self.assertEqual(names, [gate['name'] for gate in cut['gates']])
        backend = [gate for gate in cut['gates'] if gate['name'] == g.BACKEND_GATE]
        self.assertEqual([gate for gate in real['gates'] if gate['name'] == g.BACKEND_GATE], backend)
        self.assertTrue(backend[0]['native_backend'] and len(backend[0]['checks']) > 1)
        structural, = [gate for gate in cut['gates'] if gate['name'] == g.STRUCTURAL_GATE]
        self.assertEqual('2', structural['command'][structural['command'].index('--max-workers') + 1])


class Memory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.top = Path(self.tmp.name)
        self.proc = self.top / 'proc'
        self.proc.mkdir()
        self.addCleanup(self.tmp.cleanup)
        self.worker, self.coordinator = self.top / 'workers/semantic-stack', self.top / 'rose'

    def meminfo(self, available_kb, total_kb=16_000_000):
        (self.proc / 'meminfo').write_text(f'MemTotal:       {total_kb} kB\nMemFree:          1 kB\n'
                                           f'MemAvailable:   {available_kb} kB\nBuffers: 2 kB\n')

    def test_meminfo_reads_total_and_available_in_mb(self):
        self.meminfo(1_228_800, 16_384_000)
        self.assertEqual({'mem_total_mb': 16000.0, 'mem_available_mb': 1200.0}, g.meminfo(self.proc))
        (self.proc / 'meminfo').write_text('MemTotal: 1 kB\n')
        with self.assertRaises(ValueError):
            g.meminfo(self.proc)

    def test_processes_are_attributed_by_cwd_then_ancestry_and_summed(self):
        page = 4096
        write_proc(self.proc, 1, 0, 'systemd', None, 100)  # root's cwd is unreadable
        write_proc(self.proc, 10, 1, 'python3', str(self.coordinator), 1000, 3000)  # coordinator
        write_proc(self.proc, 11, 10, 'python3', str(self.worker), 2000, 5000)  # gate worker
        write_proc(self.proc, 12, 11, 'node', str(self.worker / 'front-end'), 3000, 7000)  # subdirectory
        write_proc(self.proc, 13, 12, 'chrome (renderer)', '/tmp/fixture', 500, None)  # cwd elsewhere: ancestry
        write_proc(self.proc, 14, 1, 'postgres', None, 400, None)  # another user's server
        write_proc(self.proc, 15, 14, 'postgres', None, 100, None)
        write_proc(self.proc, 16, 1, 'claude', '/home/boxes/rose', 800, 900)  # same prefix, not a root
        write_proc(self.proc, 17, 99, 'orphan', str(self.worker) + '-other', 50, 60)  # sibling path is not inside
        (self.proc / 'self').mkdir()  # non-numeric entries are skipped
        table = g.process_table(self.proc, page_size=page)
        self.assertEqual({'ppid': 12, 'comm': 'chrome (renderer)', 'cwd': '/tmp/fixture', 'rss_kb': 2000.0,
                          'pss_kb': None}, table[13])
        roots = {'coordinator': self.coordinator, 'semantic-stack': self.worker}
        buckets = g.attribute(table, roots)
        self.assertEqual({1: 'other', 10: 'coordinator', 11: 'semantic-stack', 12: 'semantic-stack',
                          13: 'semantic-stack', 14: 'postgres', 15: 'postgres', 16: 'other', 17: 'other'}, buckets)
        summary = g.summarize(table, buckets)
        self.assertEqual({'processes': 3, 'rss_mb': round((2000 + 3000 + 500) * 4 / 1024, 1),
                          'pss_mb': round(12000 / 1024, 1), 'pss_unreadable': 1}, summary['semantic-stack'])
        self.assertEqual({'processes': 1, 'rss_mb': round(4000 / 1024, 1), 'pss_mb': round(3000 / 1024, 1),
                          'pss_unreadable': 0}, summary['coordinator'])
        self.assertEqual(2, summary['postgres']['processes'])
        # The deepest root wins when a worker root is nested under another root.
        nested = g.attribute(table, {'outer': self.top, 'semantic-stack': self.worker})
        self.assertEqual(('outer', 'semantic-stack', 'semantic-stack'), (nested[10], nested[11], nested[13]))

    def test_low_memory_needs_three_consecutive_samples_strictly_below(self):
        def samples(*values):
            return [{'mem_available_mb': v} for v in values]
        self.assertTrue(g.low_memory(samples(9000, 1000, 1100, 1199.9), 1200))
        self.assertFalse(g.low_memory(samples(1000, 1300, 1000, 1000), 1200))  # streak of two
        self.assertFalse(g.low_memory(samples(1000, 1000), 1200))  # too few samples
        self.assertFalse(g.low_memory(samples(1000, 1200, 1000), 1200))  # equal is not below
        self.assertFalse(g.low_memory([], 1200))

    @staticmethod
    def samples_written(output, count=5):
        """More low samples than the abort needs (a missed abort would have fired by now)."""
        return output.is_file() and output.read_text().count('"kind": "sample"') >= count

    def run_sampler(self, available_kb, watch, abort_below_mb=1200.0, wait_for=None):
        self.meminfo(available_kb)
        write_proc(self.proc, 10, 1, 'python3', str(self.coordinator), 1000, 3000)
        output = self.top / 'out/memory.jsonl'
        sampler = g.MemorySampler(output, {'coordinator': self.coordinator}, abort_below_mb, interval=0.01,
                                  proc=self.proc)
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        self.addCleanup(lambda: child.poll() is None and (child.kill(), child.wait()))
        if watch:
            sampler.watch(child)
        with redirect_stdout(io.StringIO()) as printed:
            sampler.begin()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not (wait_for or (lambda _: sampler.aborted))(output):
                time.sleep(0.01)
            sampler.finish()
        records = [json.loads(line) for line in output.read_text().splitlines()]
        return sampler, child, records, printed.getvalue()

    def test_three_low_samples_term_only_the_watched_cycle_child_and_record_the_abort(self):
        sampler, child, records, printed = self.run_sampler(1_000_000, watch=True)
        self.assertEqual(-signal.SIGTERM, child.wait(timeout=10))
        abort, = [r for r in records if r['kind'] == 'abort']
        self.assertEqual(('ABORTED_LOW_MEMORY', child.pid, 1200.0, 3),
                         (abort['status'], abort['target_pid'], abort['threshold_mb'], abort['consecutive']))
        self.assertEqual([976.6] * 3, [s['mem_available_mb'] for s in abort['last_samples']])
        self.assertEqual(['start', 'sample', 'sample', 'sample'], [r['kind'] for r in records[:4]])
        self.assertEqual('abort', records[4]['kind'])
        self.assertEqual('summary', records[-1]['kind'])
        self.assertTrue(records[-1]['aborted'])
        self.assertEqual(976.6, records[-1]['peaks']['min_available_mb']['value'])
        self.assertEqual(round(3000 / 1024, 1), records[-1]['peaks']['coordinator.pss_mb']['value'])
        sample = records[1]
        self.assertEqual((15625.0, 976.6, 14648.4), (sample['mem_total_mb'], sample['mem_available_mb'],
                                                     sample['used_mb']))
        self.assertEqual({'coordinator'}, set(sample['groups']) - {'other', 'postgres'})
        self.assertIn('ABORTED_LOW_MEMORY', printed)
        self.assertEqual(1, sum(r['kind'] == 'abort' for r in records))  # signalled once

    def test_low_memory_without_a_watched_child_or_threshold_signals_nothing(self):
        for watch, threshold in ((False, 1200.0), (True, None)):
            with self.subTest(watch=watch, threshold=threshold):
                sampler, child, records, _ = self.run_sampler(1_000_000, watch=watch, abort_below_mb=threshold,
                                                              wait_for=self.samples_written)
                self.assertIsNone(child.poll())
                self.assertIsNone(sampler.aborted)
                self.assertGreaterEqual(sum(r['kind'] == 'sample' for r in records), 3)
                self.assertFalse(any(r['kind'] == 'abort' for r in records))
                child.kill()
                child.wait()
                shutil.rmtree(self.proc / '10')
                (self.top / 'out/memory.jsonl').unlink()

    def test_healthy_memory_never_aborts(self):
        sampler, child, records, _ = self.run_sampler(8_000_000, watch=True, wait_for=self.samples_written)
        self.assertIsNone(child.poll())
        self.assertFalse(records[-1]['aborted'])


class RunMemory(Fixture):
    def setUp(self):
        super().setUp()
        self.selection = {'selected': ['format', 'live-probes'], 'quick': ['format'],
                          'needs_worker': ['live-probes'], 'omitted': []}
        self.plan, self.watched = {'gates': [{'name': 'format'}], 'source': {'head': self.head}}, []
        self.state = self.root / '.context/deploy-pipeline'
        test = self

        class FakeSampler:
            def __init__(self, path, roots, abort_below_mb):
                self.path, self.roots, self.abort_below_mb, self.aborted = path, dict(roots), abort_below_mb, None
                self.events = ['init']
                test.sampler = self

            def begin(self):
                self.events.append('begin')

            def set_roots(self, roots):
                self.roots.update(roots)

            def watch(self, target):
                test.watched.append(target)
                if target is not None and test.abort_on == test.kind(target):
                    self.aborted = {'target_pid': 4242}

            def finish(self):
                self.events.append('finish')

        self.abort_on = None
        for name, fake in (('list_selected', lambda root, base, template: self.selection),
                           ('stream', self.fake_stream), ('MemorySampler', FakeSampler)):
            patcher = patch.object(g, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def kind(self, argv):
        return {'deploy_test_plan.py': 'plan', 'run_deploy_pipeline.py': 'verify'}.get(Path(argv[1]).name, argv[2])

    def fake_stream(self, argv, cwd, on_start=None):
        if self.kind(argv) == 'plan':
            Path(argv[argv.index('--output') + 1]).write_text(json.dumps(self.plan))
        if on_start is not None:
            on_start(argv)
            on_start(None)
        return 1 if self.abort_on == self.kind(argv) else 0

    def go(self, **overrides):
        output = io.StringIO()
        with redirect_stdout(output):
            code = g.run(args(sample_memory=Path('memory.jsonl'), abort_below_mb=1200.0, **overrides), self.root)
        return code, output.getvalue()

    def test_sampler_spans_the_run_and_watches_only_cycle_children(self):
        code, out = self.go()
        self.assertEqual(0, code, out)
        self.assertEqual(['init', 'begin', 'finish'], self.sampler.events)
        self.assertEqual((self.root / 'memory.jsonl').resolve(), self.sampler.path)
        self.assertEqual({'coordinator': self.root, 'live-probes': self.path('live-probes')}, self.sampler.roots)
        self.assertEqual(['init', 'run'], [self.kind(t) for t in self.watched if t is not None])

    def test_low_memory_abort_reports_its_own_stage_and_exit_code(self):
        self.abort_on = 'run'
        code, out = self.go()
        self.assertEqual(g.LOW_MEMORY_EXIT, code)
        last = out.strip().splitlines()[-1]
        self.assertIn(f'DEPLOY_GATES BLOCKED head={self.head[:12]} stage=memory exit={g.LOW_MEMORY_EXIT}: '
                      'ABORTED_LOW_MEMORY', last)
        self.assertIn('pid 4242', last)
        self.assertEqual('finish', self.sampler.events[-1])  # the summary is written on every exit

    def test_blocked_runs_still_finish_the_sampler(self):
        (self.root / 'untracked.py').write_text('x')
        code, _ = self.go()
        self.assertEqual(2, code)
        self.assertFalse(hasattr(self, 'sampler'))  # refused before any sampling starts
        (self.root / 'untracked.py').unlink()
        self.selection['needs_worker'] = ['live-probes', 'agents-coverage-blackbox']
        with patch.dict(PORTS, {'agents-coverage-blackbox': PORTS['live-probes'] + 10}):
            code, _ = self.go()
        self.assertEqual(2, code)
        self.assertEqual(['init', 'begin', 'finish'], self.sampler.events)


if __name__ == '__main__':
    unittest.main()
