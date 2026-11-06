#!/usr/bin/env python3
"""Offline tests for scripts/deploy_prod.py (`scripts/deploy production`).

Every side effect goes through injected fakes: no gh, git (except the real
classify-agent-runtime-changes.sh on stdin), HTTP, provider or production call.
"""
from __future__ import annotations

import ast
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import importlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
dp = importlib.import_module('deploy_prod')  # scripts/ is not a package

SHA = '1234567890abcdef1234567890abcdef12345678'
SECRETS = {'BACKEND_API_KEY': 'backend-key-SEKRIT-0001', 'RENDER_API_KEY': 'rnd_SEKRIT_render_0002',
           'GITHUB_TOKEN': 'ghp_SEKRIT_github_0003', 'DATABASE_URL': 'postgresql://u:SEKRITpw0004@db.example/x'}
ISO = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')


def classify(changed: list[str]) -> list[str]:
    done = subprocess.run(['bash', str(ROOT / dp.CLASSIFY)], input=''.join(f'{p}\n' for p in changed),
                          capture_output=True, text=True, check=True)
    return [line for line in done.stdout.splitlines() if line]


NO_MAC = {'ship': 'false', 'reason': 'no-shipped-change', 'label': 'false'}


def mac(changed: list[str], labels: list[str] | None = None, label_error: str | None = None):
    """The real scripts/mac-app-release-decision on the merge diff."""
    return dp.mac_release_decision(dp._capture, ROOT, {'PATH': '/usr/bin:/bin'}, changed, labels, label_error)


def applicable(changed: list[str], labels: list[str] | None = None) -> set[str]:
    decision, error = mac(changed, labels or [])
    plan = dp.plan_lanes(changed, classify(changed), decision, mac_error=error)
    return {name for name, lane in plan.items() if lane.applicable}


class Fake:
    """Injected IO: records every command, gh call, HTTP request and output line."""

    def __init__(self, root: Path, changed: list[str], *, handler=None, http=None, gh=None, gh_exists=True):
        self.root, self.changed, self.handler, self.http, self.gh = root, changed, handler, http, gh
        self.gh_exists = gh_exists
        self.runs: list[tuple[list[str], Path, dict]] = []
        self.factory: list[tuple[str, str]] = []
        self.requests: list[tuple[str, dict]] = []
        self.lines: list[str] = []
        self.sleeps: list[float] = []
        self.decisions: list[str | None] = []
        self.lock = threading.Lock()

    def io(self) -> dp.IO:
        return dp.IO(run=self.run, capture=self.capture, http_get=self.http_get, sleep=self.sleeps.append,
                     out=self.lines.append, exists=lambda path: self.gh_exists and path == dp.DEVBOX_GH)

    def run(self, argv, cwd, env, on_line):
        with self.lock:
            self.runs.append((list(argv), Path(cwd), dict(env)))
        return self.handler(argv, cwd, env, on_line) if self.handler else 0

    def capture(self, argv, cwd, env, input=None):
        if argv[:2] == ['git', 'rev-parse']:
            return 0, SHA + '\n', ''
        if argv[:2] == ['git', 'diff']:
            return 0, ''.join(f'{p}\n' for p in self.changed), ''
        if argv[:2] == ['git', 'show']:
            return 0, '2026-11-05T10:00:00-08:00\n', ''
        if argv[0] == 'bash' and argv[1].endswith('mac-app-release-decision'):
            with self.lock:
                self.decisions.append(env.get('MAC_APP_RELEASE_LABEL'))
            return dp._capture(['bash', str(ROOT / dp.MAC_DECISION)], ROOT, env, input=input)
        if argv[0] == 'bash' and argv[1].endswith('classify-agent-runtime-changes.sh'):
            return 0, ''.join(f'{p}\n' for p in classify([p for p in input.splitlines() if p])), ''
        if len(argv) > 1 and argv[1].endswith('record_factory_event.py'):
            with self.lock:
                self.factory.append((argv[3], argv[4]))
            return 0, 'FACTORY_EVENT {}', ''
        if argv[0].endswith('gh'):
            if self.gh:
                return self.gh(argv[1:])
            if argv[1:3] == ['pr', 'view']:
                return 0, json.dumps({'labels': []}), ''
            return 0, '[]', ''
        raise AssertionError(f'unexpected capture {argv}')

    def http_get(self, url, headers, timeout):
        with self.lock:
            self.requests.append((url, dict(headers)))
        return self.http(url, headers) if self.http else (200, b'{}')

    def kinds(self) -> list[str]:
        return [kind(argv) for argv, _cwd, _env in self.runs]


def kind(argv: list[str]) -> str:
    joined = ' '.join(argv)
    for marker in ('production-render', 'production-semantic', 'worker-deployment-queue.ts', 'prod-endpoint-smoke.ts',
                   'validate-prod-workflow-migration.ts', 'agent-payment-production-abandonment', '--build-wmh',
                   '--refresh-wmh', 'raise-5m-rose-labs-brex', 'run watch'):
        if marker in joined:
            return marker
    if 'run_deploy_pipeline.py' in joined and 'production' in argv:
        return 'production'
    return joined


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / 'back-end').mkdir()
        (self.root / 'back-end' / '.env').write_text(
            ''.join(f'{key}="{value}"\n' for key, value in SECRETS.items())
            + 'RENDER_OWNER_ID=tea-owner\nRENDER_SERVICE_ID=srv-service\n')
        (self.root / '.context').mkdir()
        (self.root / '.context' / 'deploy-merged.json').write_text(json.dumps({'pr': 1690, 'merged_sha': SHA}))
        self.state = self.root / '.context' / 'deploy-pipeline'

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def main(self, fake: Fake, *args: str, environ: dict | None = None, lane_funcs=None) -> int:
        return dp.main(['--state-dir', str(self.state), *args], io=fake.io(), root=self.root,
                       environ={'PATH': '/usr/bin', **(environ or {})}, lane_funcs=lane_funcs)

    def report(self) -> dict:
        return json.loads((self.state / dp.REPORT).read_text())

    def write_production(self, **fields) -> None:
        self.state.mkdir(parents=True, exist_ok=True)
        path = self.state / 'production.json'
        current = json.loads(path.read_text()) if path.exists() else {}
        path.write_text(json.dumps({**current, 'merged_sha': SHA, **fields}))

    def ctx(self, fake: Fake, plan_changed: list[str] | None = None, **kw) -> dp.Ctx:
        ctx = dp.Ctx(sha=SHA, root=self.root, state_dir=self.state, io=fake.io(), environ={'PATH': '/usr/bin'}, **kw)
        ctx.plan = dp.plan_lanes(plan_changed or [], [], NO_MAC)
        self.state.mkdir(parents=True, exist_ok=True)
        return ctx


class ApplicabilityTest(unittest.TestCase):
    def test_backend_only(self) -> None:
        self.assertEqual(applicable(['back-end/src/server.ts']), {'render', 'backend-probes', 'semantic'})
        self.assertEqual(applicable(['scripts/run-bench-hub-poller']), {'render', 'backend-probes', 'semantic'})

    def test_frontend_only(self) -> None:  # the Mac app bundles front-end/, so CI cuts a release
        self.assertEqual(applicable(['front-end/src/App.tsx']), {'vercel', 'mac-release', 'semantic'})
        self.assertEqual(applicable(['front-end/src/tests/blackbox/a.blackbox.ts']), {'vercel', 'semantic'})

    def test_agents_runtime_and_test_only(self) -> None:
        self.assertEqual(applicable(['agents/tools/web_search.py']), {'fly', 'workflow-migration', 'semantic'})
        self.assertEqual(applicable(['agents/tests/test_web_search.py', 'agents/README.md']), {'semantic'})

    def test_deploy_agents_workflow(self) -> None:
        plan = dp.plan_lanes([dp.AGENTS_WORKFLOW_PATH], [], NO_MAC)
        self.assertTrue(plan['fly'].applicable and plan['workflow-migration'].applicable)
        self.assertIn('deploy-agents.yml changed', plan['fly'].reason)

    def test_agentcard_paths(self) -> None:
        self.assertEqual(applicable(['back-end/src/domains/agentcard/service.ts']),
                         {'render', 'backend-probes', 'agentcard', 'semantic'})
        self.assertEqual(applicable(['agents/tools/request_payment_card.py']),
                         {'fly', 'workflow-migration', 'agentcard', 'semantic'})
        self.assertEqual(applicable(['scripts/run.sh']), {'agentcard', 'semantic'})
        plan = dp.plan_lanes(['back-end/src/domains/purchases/x.ts', 'front-end/src/features/test-payment/a.tsx'], [],
                             NO_MAC)
        self.assertEqual(plan['agentcard'].deps, ('render', 'vercel'))

    def test_history_ledger_only(self) -> None:
        self.assertEqual(applicable(['agents/benchmarks/history/task_attempts.jsonl',
                                     'agents/benchmarks/history/task_durations.jsonl']), {'semantic'})

    def test_wmh_serving_vs_build_input(self) -> None:
        serving = dp.plan_lanes(['agents/benchmarks/serve_world_model.py'], [], NO_MAC)
        self.assertTrue(serving['wmh'].applicable)
        self.assertFalse(serving['wmh'].build_wmh)
        self.assertEqual(applicable(['agents/benchmarks/wmh_build_cache.py']), {'wmh', 'agentcard', 'semantic'})
        for path in ('agents/requirements-world-model.txt', 'agents/vendor/world-model/x.whl',
                     'agents/benchmarks/build_experiential_world_model.py', 'scripts/setup-world-model.sh'):
            plan = dp.plan_lanes([path], classify([path]), NO_MAC)
            self.assertTrue(plan['wmh'].applicable and plan['wmh'].build_wmh, path)
        self.assertEqual(applicable(['scripts/setup-world-model.sh']), {'wmh', 'semantic'})

    def test_docs_only_is_semantic_only(self) -> None:
        self.assertEqual(applicable(['docs/api/agents.mdx', 'README.md', '.claude/commands/deploy.md']), {'semantic'})

    def test_mac_release_label_only(self) -> None:
        decision, error = mac(['docs/a.mdx'], ['MAC-APP-RELEASE'])
        self.assertEqual((decision, error), ({'ship': 'true', 'reason': 'label', 'label': 'true'}, None))
        lane = dp.plan_lanes(['docs/a.mdx'], [], decision, pr=1690)['mac-release']
        self.assertTrue(lane.applicable)
        self.assertEqual(lane.reason, 'mac-app-release-decision ship=true reason=label (PR #1690 with MAC-APP-RELEASE)')

    def test_mac_release_shipped_surface_without_label(self) -> None:
        decision, error = mac(['mac-app/main/index.ts'], ['bug'])
        self.assertEqual((decision, error), ({'ship': 'true', 'reason': 'shipped-surface', 'label': 'false'}, None))
        lane = dp.plan_lanes(['mac-app/main/index.ts'], [], decision, pr=1690)['mac-release']
        self.assertTrue(lane.applicable)
        self.assertEqual(lane.reason,
                         'mac-app-release-decision ship=true reason=shipped-surface (PR #1690 without MAC-APP-RELEASE)')
        self.assertIsNone(lane.error)
        # A failed label lookup cannot matter when the changed files alone ship.
        self.assertEqual(mac(['mac-app/main/index.ts'], None, 'HTTP 401')[1], None)

    def test_mac_release_no_shipped_change(self) -> None:
        for changed in (['docs/a.mdx'], ['mac-app/tests/blackbox/a.blackbox.ts', 'mac-app/README.md'], []):
            decision, error = mac(changed, [])
            self.assertEqual((decision, error), (NO_MAC, None), changed)
            lane = dp.plan_lanes(changed, [], decision)['mac-release']
            self.assertFalse(lane.applicable)
            self.assertIn('reason=no-shipped-change', lane.reason)

    def test_mac_release_unknown_decision_fails_closed(self) -> None:
        decision, error = mac(['docs/a.mdx'], None, 'gh pr view failed')
        self.assertIn('label unknown (gh pr view failed) and no shipped-surface change', error)
        lane = dp.plan_lanes(['docs/a.mdx'], [], decision, mac_error=error)['mac-release']
        self.assertTrue(lane.applicable)
        self.assertEqual(lane.error, error)
        broken = dp.mac_release_decision(lambda *a, **k: (2, '', 'boom'), ROOT, {}, [], [])
        self.assertEqual(broken[0], None)
        self.assertIn('exited 2 without ship=true|false: boom', broken[1])

    def test_waves_respect_dependencies(self) -> None:
        changed = ['back-end/src/a.ts', 'front-end/src/b.tsx', 'agents/tools/c.py']
        plan = dp.plan_lanes(changed, classify(changed), *mac(changed, []))
        self.assertEqual(dp.waves(plan), [['render', 'fly', 'vercel', 'mac-release'],
                                          ['backend-probes', 'workflow-migration', 'semantic']])
        self.assertEqual(plan['semantic'].deps, ('render', 'vercel', 'fly'))


def fake_lanes(results: dict, order: list, lock: threading.Lock, hooks: dict | None = None) -> dict:
    def make(name):
        def lane(ctx):
            with lock:
                order.append(('start', name))
            if hooks and name in hooks:
                hooks[name]()
            result = results.get(name, (True, f'{name} ok', 0))
            with lock:
                order.append(('end', name))
            if isinstance(result, Exception):
                raise result
            return result
        return lane
    return {name: make(name) for name in dp.LANES}


class SchedulerTest(Base):
    CHANGED = ['back-end/src/domains/agentcard/a.ts', 'front-end/src/b.tsx', 'agents/tools/c.py']

    def test_failure_blocks_only_dependents_and_others_continue(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        lanes = fake_lanes({'render': (False, 'Render build_failed', 1)}, order, lock)
        self.assertEqual(self.main(fake, lane_funcs=lanes), 1)
        lanes_report = self.report()['lanes']
        self.assertEqual(lanes_report['render']['status'], dp.FAIL)
        for name in ('backend-probes', 'agentcard', 'semantic'):
            self.assertEqual(lanes_report[name]['status'], dp.BLOCKED, name)
            self.assertIn('render', lanes_report[name]['reason'])
        for name in ('vercel', 'fly', 'workflow-migration'):
            self.assertEqual(lanes_report[name]['status'], dp.PASS, name)
        self.assertEqual(lanes_report['wmh']['status'], dp.SKIPPED)
        self.assertLess(order.index(('end', 'fly')), order.index(('start', 'workflow-migration')))
        self.assertNotIn(('start', 'semantic'), order)
        self.assertIn(('production-start', 'render'), fake.factory)
        self.assertNotIn(('production-finish', 'render'), fake.factory)
        self.assertIn(('production-finish', 'vercel'), fake.factory)
        self.assertNotIn(('stage-finish', 'production-verify'), fake.factory)
        self.assertRegex(fake.lines[-2], r'^DEPLOY_PRODUCTION FAIL sha=1234567890ab failed=render ')
        self.assertIn('  render: Render build_failed', fake.lines[-1])

    def test_independent_lanes_run_concurrently_and_all_pass(self) -> None:
        order, lock = [], threading.Lock()
        render_started, vercel_started = threading.Event(), threading.Event()

        def render_hook():
            render_started.set()
            self.assertTrue(vercel_started.wait(5), 'vercel never started while render ran')

        def vercel_hook():
            vercel_started.set()
            self.assertTrue(render_started.wait(5), 'render never started while vercel ran')

        fake = Fake(self.root, self.CHANGED)
        lanes = fake_lanes({}, order, lock, {'render': render_hook, 'vercel': vercel_hook})
        self.assertEqual(self.main(fake, lane_funcs=lanes), 0)
        for dependent, deps in dp.DEPENDS.items():
            for dep in deps:
                self.assertLess(order.index(('end', dep)), order.index(('start', dependent)))
        self.assertEqual(fake.factory[-1], ('stage-finish', 'production-verify'))
        for name in dp.FACTORY_LANES - {'mac-release'}:
            self.assertIn(('production-start', name), fake.factory)
            self.assertIn(('production-finish', name), fake.factory)
        self.assertNotIn(('production-start', 'workflow-migration'), fake.factory)
        self.assertRegex(fake.lines[-1], r'^DEPLOY_PRODUCTION PASS sha=1234567890ab lanes=render:PASS,')

    def test_lane_exception_is_a_failure_not_a_crash(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, ['front-end/a.tsx'])
        lanes = fake_lanes({'vercel': RuntimeError('boom')}, order, lock)
        self.assertEqual(self.main(fake, lane_funcs=lanes), 1)
        self.assertEqual(self.report()['lanes']['vercel']['reason'], 'RuntimeError: boom')
        self.assertEqual(self.report()['lanes']['semantic']['status'], dp.BLOCKED)

    def test_json_report_shape(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, ['back-end/src/a.ts'])
        self.assertEqual(self.main(fake, lane_funcs=fake_lanes({}, order, lock)), 0)
        report = self.report()
        self.assertEqual({'schema_version', 'sha', 'pr', 'status', 'started_at', 'finished_at', 'changed_files',
                          'selected', 'lanes'}, set(report))
        self.assertEqual((report['sha'], report['pr'], report['status'], report['changed_files']), (SHA, 1690, 'PASS', 1))
        self.assertEqual(list(report['lanes']), list(dp.LANES))
        for name, lane in report['lanes'].items():
            self.assertTrue({'status', 'reason', 'started_at', 'finished_at', 'exit_code', 'command'} <= set(lane))
            self.assertIn(lane['status'], {dp.PASS, dp.FAIL, dp.BLOCKED, dp.SKIPPED, dp.NOT_SELECTED})
            if lane['status'] == dp.PASS:
                self.assertRegex(lane['started_at'], ISO)
                self.assertRegex(lane['finished_at'], ISO)
                self.assertEqual(lane['exit_code'], 0)
            else:
                self.assertEqual((lane['status'], lane['started_at'], lane['exit_code']), (dp.SKIPPED, None, None), name)
        self.assertEqual({n for n, lane in report['lanes'].items() if lane['status'] == dp.PASS},
                         {'render', 'backend-probes', 'semantic'})
        self.assertFalse(list(self.state.glob('.production-lanes.json.*.tmp')))

    def test_lane_subset_carries_forward_prior_pass(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, ['back-end/src/a.ts'])
        self.assertEqual(self.main(fake, '--lanes', 'backend-probes', lane_funcs=fake_lanes({}, order, lock)), 1)
        self.assertEqual(self.report()['lanes']['render']['status'], dp.NOT_SELECTED)
        self.assertEqual(self.report()['lanes']['backend-probes']['status'], dp.BLOCKED)
        self.assertEqual(self.main(fake, lane_funcs=fake_lanes({'semantic': (False, 'red', 1)}, order, lock)), 1)
        order.clear()
        self.assertEqual(self.main(fake, '--lanes', 'semantic', lane_funcs=fake_lanes({}, order, lock)), 0)
        self.assertEqual(order, [('start', 'semantic'), ('end', 'semantic')])
        self.assertTrue(self.report()['lanes']['render']['carried_forward'])

    def test_unknown_lane_is_a_usage_error(self) -> None:
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            dp.parse_args(['--lanes', 'render,nope'])
        self.assertEqual(raised.exception.code, 2)


class ElectionTest(Base):
    CHANGED = ['back-end/src/domains/agentcard/service.ts']
    WHY = 'Step 6a release-stall exception: closed card, consumed transfer observed'

    def test_elected_agentcard_is_recorded_never_run_and_can_pass(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--skip-agentcard', f'  {self.WHY} ', lane_funcs=fake_lanes({}, order, lock)), 0)
        lane = self.report()['lanes']['agentcard']
        self.assertEqual((lane['status'], lane['reason']), (dp.ELECTED, f'elected: {self.WHY}'))
        self.assertEqual((lane['started_at'], lane['exit_code'], lane['command']), (None, None, None))
        self.assertEqual(self.report()['status'], 'PASS')
        self.assertNotIn(('start', 'agentcard'), order)
        self.assertEqual({name for kind_, name in order}, {'render', 'backend-probes', 'semantic'})
        self.assertNotIn(('production-start', 'agentcard'), fake.factory)
        self.assertEqual(fake.factory[-1], ('stage-finish', 'production-verify'))
        self.assertEqual(fake.lines[-1], (
            'DEPLOY_PRODUCTION PASS sha=1234567890ab lanes=render:PASS,backend-probes:PASS,agentcard:SKIPPED-elected,'
            f'semantic:PASS elected=agentcard:"elected: {self.WHY}" report={self.state / dp.REPORT}'))

    def test_election_does_not_hide_other_failures(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        lanes = fake_lanes({'render': (False, 'Render build_failed', 1)}, order, lock)
        self.assertEqual(self.main(fake, '--skip-agentcard', self.WHY, lane_funcs=lanes), 1)
        report = self.report()['lanes']
        self.assertEqual(report['agentcard']['status'], dp.ELECTED)
        self.assertEqual((report['backend-probes']['status'], report['semantic']['status']), (dp.BLOCKED, dp.BLOCKED))
        self.assertRegex(fake.lines[-2], r'^DEPLOY_PRODUCTION FAIL sha=1234567890ab failed=render '
                                         r'not-run=backend-probes,semantic lanes=.*agentcard:SKIPPED-elected')

    def test_election_persists_for_a_later_lane_subset(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--skip-agentcard', self.WHY,
                                   lane_funcs=fake_lanes({'semantic': (False, 'red', 1)}, order, lock)), 1)
        order.clear()
        self.assertEqual(self.main(fake, '--lanes', 'semantic', lane_funcs=fake_lanes({}, order, lock)), 0)
        self.assertEqual(order, [('start', 'semantic'), ('end', 'semantic')])
        self.assertEqual(self.report()['lanes']['agentcard']['status'], dp.ELECTED)

    def test_election_requires_a_reason(self) -> None:
        for reason in ('', '   '):
            with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()) as err:
                dp.parse_args(['--skip-agentcard', reason])
            self.assertEqual(raised.exception.code, 2)
            self.assertIn('--skip-agentcard requires a nonempty REASON', err.getvalue())

    def test_election_without_applicable_agentcard_changes_nothing(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, ['docs/a.mdx'])
        self.assertEqual(self.main(fake, '--skip-agentcard', self.WHY, lane_funcs=fake_lanes({}, order, lock)), 0)
        self.assertEqual(self.report()['lanes']['agentcard']['status'], dp.SKIPPED)
        self.assertNotIn('elected=', fake.lines[-1])

    def test_dry_run_shows_election(self) -> None:
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--dry-run', '--skip-agentcard', self.WHY), 0)
        text = '\n'.join(fake.lines)
        self.assertRegex(text, r'agentcard\s+SKIPPED-elected\s+AgentCard payment path changed')
        self.assertIn(f'elected: {self.WHY} (never run; not a failure)', text)
        self.assertNotIn('agent-payment-production-abandonment', text)
        self.assertNotIn('agentcard', ''.join(line for line in fake.lines if line.startswith('order ')))
        self.assertEqual((fake.runs, fake.factory), ([], []))


class DryRunTest(Base):
    def test_dry_run_prints_plan_and_executes_nothing(self) -> None:
        fake = Fake(self.root, ['back-end/src/a.ts', 'front-end/src/b.tsx'])
        self.assertEqual(self.main(fake, '--dry-run'), 0)
        text = '\n'.join(fake.lines)
        self.assertEqual((fake.runs, fake.requests, fake.factory), ([], [], []))
        self.assertFalse((self.state / dp.REPORT).exists())
        self.assertIn('DEPLOY_PRODUCTION DRY-RUN sha=1234567890ab pr=#1690 changed=2', text)
        self.assertRegex(text, r'render\s+APPLICABLE\s+back-end changed: back-end/src/a.ts')
        self.assertRegex(text, r'fly\s+SKIPPED-not-applicable')
        self.assertIn(f'run_deploy_pipeline.py production-render --merged-sha {SHA} --state-dir {self.state}', text)
        self.assertIn('cd back-end && env -u SMOKE_BASE_URL -u SMOKE_HEALTH_URL -u SMOKE_FRONTEND_URL npx tsx '
                      'scripts/prod-endpoint-smoke.ts', text)
        self.assertIn('--frontend-url https://www.roselabs.ai --backend-url https://navi-j9a9.onrender.com', text)
        self.assertIn('after: render, vercel', text)
        self.assertRegex(text, r'mac-release\s+APPLICABLE\s+mac-app-release-decision ship=true reason=shipped-surface')
        self.assertIn('order 1: render, vercel, mac-release (concurrent)', text)
        self.assertIn('order 2: backend-probes, semantic (concurrent)', text)
        self.assertIn(f'gh: {dp.DEVBOX_GH} (GH_TOKEN=back-end/.env GITHUB_TOKEN;', text)
        for secret in SECRETS.values():
            self.assertNotIn(secret, text)

    def test_dry_run_shows_wmh_build_and_migration_token_source(self) -> None:
        fake = Fake(self.root, ['agents/requirements-world-model.txt'])
        self.assertEqual(self.main(fake, '--dry-run'), 0)
        text = '\n'.join(fake.lines)
        self.assertIn('bash scripts/run-bench-cloud --build-wmh', text)
        self.assertIn('bash scripts/run-bench-cloud --refresh-wmh', text)
        self.assertIn('TEMPORAL_WORKER_DEPLOYMENT_TOKEN=\'<run_id>-<run_attempt>\'', text)
        self.assertIn('(only with --resume-fly; otherwise FAIL)', text)


class VercelTest(Base):
    def gh_script(self, responses: list):
        def gh(args):
            response = responses.pop(0) if len(responses) > 1 else responses[0]
            return (1, '', 'HTTP 502') if response == 'error' else (0, json.dumps(response), '')
        return gh

    def test_state_machine_to_success(self) -> None:
        bot = [{'id': 7, 'creator': {'login': 'vercel[bot]'}}]
        responses = [[], 'error', [{'id': 1, 'creator': {'login': 'someone'}}], bot, [], bot,
                     [{'state': 'in_progress'}], bot, [{'state': 'success'}, {'state': 'pending'}]]
        fake = Fake(self.root, [], gh=self.gh_script(responses))
        self.assertEqual(dp.lane_vercel(self.ctx(fake)), (True, 'Vercel deployment 7 success', 0))
        self.assertEqual(fake.sleeps, [10.0] * 5)

    def test_terminal_failures(self) -> None:
        for state in ('failure', 'error', 'inactive'):
            fake = Fake(self.root, [], gh=self.gh_script([[{'id': 9, 'creator': {'login': 'vercel[bot]'}}],
                                                          [{'state': state}]]))
            passed, reason, _code = dp.lane_vercel(self.ctx(fake))
            self.assertFalse(passed)
            self.assertEqual(reason, f'Vercel deployment 9 {state}')

    def test_bounded_wait(self) -> None:
        fake = Fake(self.root, [], gh=self.gh_script([[]]))
        passed, reason, _code = dp.lane_vercel(self.ctx(fake), attempts=3, interval=10)
        self.assertFalse(passed)
        self.assertIn('did not bring 1234567890ab live within 3x10s', reason)
        self.assertEqual(fake.sleeps, [10, 10])

    def test_decide(self) -> None:
        self.assertEqual(dp.vercel_decide([]), ('pending', 'pending'))
        self.assertEqual(dp.vercel_decide([{'state': 'queued'}]), ('pending', 'queued'))
        self.assertEqual(dp.vercel_decide([{'state': 'success'}]), ('success', 'success'))
        self.assertEqual(dp.vercel_decide([{'state': 'inactive'}]), ('failed', 'inactive'))


class BackendProbesTest(Base):
    LOGS = {'logs': [{'timestamp': '2026-11-05T18:01:02.000Z', 'message': 'GET /api/agents -> 200'},
                     {'timestamp': '2026-11-05T18:01:03.000Z', 'message': 'prisma:error column x does not exist'},
                     {'timestamp': '2026-11-05T18:01:04.000Z', 'message': '{"status":500,"path":"/api/models"}'},
                     {'timestamp': '2026-11-05T18:01:05.000Z', 'message': 'GET /api/people -> 500 in 20ms'},
                     {'timestamp': '2026-11-05T18:01:06.000Z', 'message': 'status 5000 ok'}]}

    def test_log_scan_filter(self) -> None:
        bad = dp.bad_log_lines(self.LOGS['logs'] + ['not-a-dict', {'message': None}])
        self.assertEqual([entry['timestamp'][17:19] for entry in bad], ['03', '04', '05'])

    def test_log_scan_uses_render_credentials_and_fails_on_errors(self) -> None:
        fake = Fake(self.root, [], http=lambda url, headers: (200, json.dumps(self.LOGS).encode()))
        ctx = self.ctx(fake)
        self.assertEqual(dp.render_log_scan(ctx), (False, '3 post-deploy error lines in the Render log'))
        url, headers = fake.requests[0]
        self.assertTrue(url.startswith('https://api.render.com/v1/logs?ownerId=tea-owner&resource=srv-service'
                                       '&limit=100&direction=backward'))
        self.assertEqual(headers['Authorization'], f'Bearer {SECRETS["RENDER_API_KEY"]}')
        self.assertIn('[backend-probes] 18:01:03 prisma:error column x does not exist', fake.lines)
        clean = Fake(self.root, [], http=lambda url, headers: (200, b'{"logs": [{"message": "ok"}]}'))
        self.assertEqual(dp.render_log_scan(self.ctx(clean)), (True, 'Render log clean'))

    def test_missing_render_credentials_names_keys_only(self) -> None:
        (self.root / 'back-end' / '.env').write_text(f'BACKEND_API_KEY={SECRETS["BACKEND_API_KEY"]}\n')
        fake = Fake(self.root, [])
        self.assertEqual(dp.render_log_scan(self.ctx(fake)), (
            False, 'Render log scan: RENDER_API_KEY, RENDER_OWNER_ID, RENDER_SERVICE_ID missing from back-end/.env'))
        self.assertEqual(fake.requests, [])

    def test_probe_sequence_passes(self) -> None:
        def http(url, headers):
            return (200, b'{"logs": []}') if 'api.render.com' in url else (200, b'[]')
        fake = Fake(self.root, [], http=http)
        ctx = self.ctx(fake)
        self.assertEqual(dp.lane_backend_probes(ctx)[0], True)
        self.assertEqual([url.split('?')[0] for url, _ in fake.requests],
                         [f'{dp.BACKEND_URL}/health', f'{dp.BACKEND_URL}/api/agents', dp.RENDER_LOGS_URL])
        self.assertEqual(fake.kinds(), ['prod-endpoint-smoke.ts'])

    def test_no_secret_is_ever_printed_or_recorded(self) -> None:
        """A failing probe whose responses and children echo every secret prints none of them."""
        echoed = ' '.join(SECRETS.values()).encode()

        agents_calls: list[int] = []
        succeed_on = [13]

        def http(url, headers):
            if url.endswith('/health'):
                return 200, b'ok'
            if 'api.render.com' in url:
                return 200, json.dumps({'logs': [{'timestamp': 'x' * 19, 'message': f'-> 500 {echoed.decode()}'}]}).encode()
            agents_calls.append(1)
            return (200, b'[]') if len(agents_calls) >= succeed_on[0] else (500, b'invalid key ' + echoed)

        def handler(argv, cwd, env, on_line):
            on_line(f'child leaked {SECRETS["GITHUB_TOKEN"]} and {SECRETS["DATABASE_URL"]}')
            if 'production-render' in argv:
                return 0
            return 1

        fake = Fake(self.root, ['back-end/src/a.ts'], http=http, handler=handler)
        environ = {'SMOKE_BASE_URL': 'http://localhost:3001', 'SMOKE_HEALTH_URL': 'x', 'SMOKE_FRONTEND_URL': 'y'}
        self.assertEqual(self.main(fake, '--lanes', 'render,backend-probes', environ=environ), 1)
        agents_headers = [headers for url, headers in fake.requests if url.endswith('/api/agents')]
        self.assertEqual(len(agents_headers), 12)
        self.assertEqual(agents_headers[0], {'X-API-Key': SECRETS['BACKEND_API_KEY'], 'X-User-Id': dp.PROBE_USER_ID})
        self.assertEqual(fake.sleeps, [5] * 11)
        render_env = fake.runs[0][2]
        self.assertEqual((render_env['GH_TOKEN'], render_env['DEPLOY_GH_BIN']), (SECRETS['GITHUB_TOKEN'], str(dp.DEVBOX_GH)))
        printed = '\n'.join(fake.lines)
        recorded = (self.state / dp.REPORT).read_text()
        logs = ''.join(path.read_text() for path in (self.state / 'production-logs').glob('*.log'))
        self.assertIn('FUNCTIONAL CHECK FAILED: /api/agents -> 500', recorded)
        self.assertIn('[render] child leaked *** and ***', printed)
        for secret in SECRETS.values():
            for text in (printed, recorded, logs):
                self.assertNotIn(secret, text)
        # The 12th attempt succeeds: the smoke child and the Render log scan echo secrets too.
        agents_calls.clear()
        succeed_on[0] = 12
        fake.lines.clear()
        ctx = self.ctx(fake)
        passed, reason, _code = dp.lane_backend_probes(ctx)
        self.assertFalse(passed)
        self.assertEqual(reason, 'prod-endpoint-smoke exited 1; 1 post-deploy error lines in the Render log')
        printed = '\n'.join(fake.lines)
        self.assertIn('-> 500 *** *** *** ***', printed)
        for secret in SECRETS.values():
            self.assertNotIn(secret, printed + reason)

    def test_smoke_runs_without_injected_smoke_urls(self) -> None:
        fake = Fake(self.root, [], http=lambda url, headers: (200, b'{"logs": []}'))
        ctx = self.ctx(fake)
        ctx.environ.update(SMOKE_BASE_URL='http://localhost:3001', KEEP='1')
        self.assertTrue(dp.lane_backend_probes(ctx)[0])
        argv, cwd, env = fake.runs[0]
        self.assertEqual((argv, cwd), (dp.SMOKE_ARGV, self.root / 'back-end'))
        self.assertNotIn('SMOKE_BASE_URL', env)
        self.assertEqual(env['KEEP'], '1')


class FlyTest(Base):
    JOB = 'f' * 64

    def handler(self, production_results: list):
        def run(argv, cwd, env, on_line):
            k = kind(argv)
            if k == 'production':
                stage = production_results.pop(0)
                fly = {'required': True, 'run_id': '123', 'attempt': '2', 'deployment_token': '123-2',
                       'job_id': self.JOB, 'job_stage': stage, 'conclusion': 'failure'}
                self.write_production(fly=fly, status='passed' if stage == 'SUCCEEDED' else 'failed',
                                      error=None if stage == 'SUCCEEDED' else f'durable job is {stage}')
                return 0 if stage == 'SUCCEEDED' else 1
            return 0
        return run

    def test_not_succeeded_without_resume_fails_with_exact_command(self) -> None:
        fake = Fake(self.root, ['agents/tools/c.py'], handler=self.handler(['PREPARING']))
        self.assertEqual(self.main(fake, '--lanes', 'fly,workflow-migration'), 1)
        lanes = self.report()['lanes']
        self.assertEqual(lanes['fly']['status'], dp.FAIL)
        self.assertIn(f'durable job {self.JOB} is PREPARING', lanes['fly']['reason'])
        self.assertIn(f'cd back-end && set -a && . ./.env && set +a && node --import tsx '
                      f'scripts/worker-deployment-queue.ts run --job-id {self.JOB} -- python3 '
                      '../scripts/worker_pool_cutover.py', lanes['fly']['reason'])
        self.assertIn('--resume-fly', lanes['fly']['reason'])
        self.assertEqual(lanes['workflow-migration']['status'], dp.BLOCKED)
        self.assertEqual(fake.kinds(), ['production'])
        self.assertIn(('stage-start', 'cooperative-cutover'), fake.factory)
        self.assertNotIn(('stage-finish', 'cooperative-cutover'), fake.factory)

    def test_resume_fly_resumes_same_job_then_migration_uses_token(self) -> None:
        fake = Fake(self.root, ['agents/tools/c.py'], handler=self.handler(['FAILED', 'SUCCEEDED']))
        self.assertEqual(self.main(fake, '--lanes', 'fly,workflow-migration', '--resume-fly'), 1)  # semantic not selected
        lanes = self.report()['lanes']
        self.assertEqual((lanes['fly']['status'], lanes['workflow-migration']['status']), (dp.PASS, dp.PASS))
        self.assertEqual(fake.kinds(), ['production', 'worker-deployment-queue.ts', 'production',
                                        'validate-prod-workflow-migration.ts'])
        resume_argv, resume_cwd, resume_env = fake.runs[1]
        self.assertEqual((resume_argv, resume_cwd), (dp.resume_argv(self.JOB), self.root / 'back-end'))
        self.assertEqual(resume_env['DATABASE_URL'], SECRETS['DATABASE_URL'])  # `source back-end/.env`
        _argv, cwd, env = fake.runs[3]
        self.assertEqual(cwd, self.root / 'back-end')
        self.assertEqual({k: env[k] for k in dp.migration_env(SHA, '')}, {
            'PRODUCTION_WORKFLOW_MIGRATION_VALIDATION': '1', 'TEMPORAL_TASK_QUEUE': 'navi-agent-tasks',
            'TEMPORAL_WORKER_BUILD_ID': SHA, 'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': '123-2'})
        self.assertIn(('stage-finish', 'cooperative-cutover'), fake.factory)
        self.assertEqual(lanes['semantic']['status'], dp.NOT_SELECTED)

    def test_existing_process_mode_is_refused(self) -> None:
        fake = Fake(self.root, ['agents/tools/c.py'])
        self.assertEqual(self.main(fake, '--lanes', 'fly,workflow-migration',
                                   environ={'AGENT_DEPLOY_MODE': 'existing-process'}), 1)
        self.assertIn(dp.EXISTING_PROCESS_DOC, self.report()['lanes']['fly']['reason'])
        self.assertEqual(fake.runs, [])

    def test_migration_without_token_fails(self) -> None:
        fake = Fake(self.root, [])
        passed, reason, _code = dp.lane_workflow_migration(self.ctx(fake))
        self.assertFalse(passed)
        self.assertIn('no fly.deployment_token', reason)


TASK = 'agent-payment-production-abandonment'
RCA_DOC = 'docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md'
CARD, TRANSFER = 'card_b2e87905c62c34ba8abff4d4', 'owt_ff135698c18b095f3a40a249'


def runner_source() -> ast.Module:
    return ast.parse((ROOT / 'agents' / 'benchmarks' / 'run_benchmark.py').read_text())


def runtime_constant(name: str) -> str:
    """A module-level string constant of run_benchmark.py, read without importing the 18k-line runner."""
    for node in runner_source().body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f'{name} not found in run_benchmark.py')


def stall_lifecycle(*, livemode: bool = True, **transfer) -> dict:
    """The production lifecycle of a closed card whose transfer AgentCard left consumed (runner fixtures' shape)."""
    lifecycle = {
        'agentId': '00000000-0000-4000-8000-000000000021',
        'integrity': {'purchaseCount': 1, 'walletFundingCount': 1, 'stripePaymentIntentCount': 1, 'cardCount': 1},
        'purchase': {'id': '571cab13-0531-4173-85ef-d0709227fcd8', 'status': 'HELD', 'merchant': 'Rose Labs Test Payment',
                     'totalCents': 100, 'cardId': CARD, 'stripePaymentIntentId': 'pi_test'},
        'walletFunding': {'status': 'RECLAIMING', 'amountCents': 100, 'providerTransferId': TRANSFER,
                          'reclaimProviderTransferId': None},
        'stripeHold': {'status': 'succeeded', 'amountCents': 100, 'livemode': livemode},
        'stripeRefund': None,
        'agentCard': {'id': CARD, 'status': 'CLOSED', 'balanceCents': 0},
        'orgTransfer': {'id': TRANSFER, 'status': 'consumed', 'amountCents': 100, 'transferredCents': 4396,
                        'releasedCents': 0, 'cardId': CARD, 'livemode': livemode},
        'attention': {'openKinds': [], 'resolvedKinds': []},
    }
    lifecycle['orgTransfer'].update(transfer)
    return lifecycle


def stall_record(lifecycle: dict | None = None, *, name: str = TASK, status: str = 'SKIPPED',
                 benchmark_status: str | None = None, reason: str | None = None, errors: list | None = None,
                 cleanup_failure: object = None, summary: dict | None = None, timestamp: datetime | None = None,
                 more_tasks: tuple = (), logs: dict | None = None) -> dict:
    """A native run record shaped like BenchmarkRun.to_dict() for one task that hit the standing stall."""
    skipped = status == 'SKIPPED'
    task = {'name': name, 'status': status, 'benchmark_status': benchmark_status or status, 'passed': False,
            'agent_id': 'a1e098ad-02a5-49d6-9b9e-bf8a8163ba6a', 'cleanup_failure': cleanup_failure,
            'failure_reason': (reason if reason is not None else runtime_constant('AGENTCARD_RELEASE_SKIP_REASON')
                               + ': Payment lifecycle did not reach the expected terminal state before timeout'),
            'logs': logs if logs is not None else {
                'agentcard_release_stall_lifecycle': lifecycle if lifecycle is not None else stall_lifecycle(),
                'failure_evidence': {'agent_id': 'a1e098ad', 'errors': [] if errors is None else errors}}}
    tasks = [task, *more_tasks]
    return {'run_id': 'r-1', 'suite': name, 'timestamp': (timestamp or datetime.now(timezone.utc)).isoformat(),
            'summary': summary if summary is not None else {
                'total': len(tasks), 'passed': 0, 'failed': 0 if skipped else 1, 'skipped': 1 if skipped else 0,
                'cleanup_failures': 0},
            'tasks': tasks}


class AgentCardStallTest(Base):
    """deploy.md's permanent user-approved exception, for the production lane: a fully observed closed-card /
    consumed-transfer / zero-release stall is SKIPPED-stall (satisfied, never PASS); every other failure blocks."""
    CHANGED = ['back-end/src/domains/agentcard/service.ts']

    def setUp(self) -> None:
        super().setUp()
        benchmarks = self.root / 'agents' / 'benchmarks'
        self.runs = benchmarks / 'runs'
        self.runs.mkdir(parents=True)
        for name in ('select_predeploy_benches.py', 'tasks.json'):  # the real catalog, bound through ctx.root
            (benchmarks / name).symlink_to(ROOT / 'agents' / 'benchmarks' / name)

    def execute(self, record, *, code: int = 0, lines=None, environ: dict | None = None, rel: str | None = None):
        """Run the REAL lane_agentcard through main(); only the CLI process is faked."""
        def handler(argv, cwd, env, on_line):
            if TASK not in argv:
                return 0
            built = record() if callable(record) else record
            for index, item in enumerate(built if isinstance(built, list) else [built]):
                if item is None:
                    continue
                path = self.runs / (rel or f'20261106_000000_r{index}_{TASK}.json')
                if isinstance(item, (dict, list)):
                    path.write_text(json.dumps(item))
                else:
                    path.write_text(item)
                if lines is None:
                    on_line(f'\n  Results saved: {path}')
            for line in lines or ():
                on_line(line.format(runs=self.runs))
            return code
        fake = Fake(self.root, self.CHANGED, handler=handler)
        lanes = {name: lane for name, lane in fake_lanes({}, [], threading.Lock()).items() if name != 'agentcard'}
        return fake, self.main(fake, lane_funcs=lanes, environ=environ)

    def lane(self) -> dict:
        return self.report()['lanes']['agentcard']

    def test_qualifying_stall_is_satisfied_but_never_pass(self) -> None:
        for code in (0, 1):  # the production runner exits 0 for the permitted skip; a nonzero runner still qualifies
            with self.subTest(code=code):
                fake, exit_code = self.execute(lambda: stall_record(), code=code)
                self.assertEqual(exit_code, 0)
                lane = self.lane()
                self.assertEqual((lane['status'], lane['exit_code']), (dp.STALL, code))
                self.assertEqual(dp.STALL, 'SKIPPED-stall')
                self.assertTrue(lane['reason'].startswith(
                    'Unreleased: $43.96 live (transferredCents 4396 / releasedCents 0); pending Stripe refund; '
                    'followup: unreleased funds stay open'), lane['reason'])
                self.assertIn('20261106_000000_r0_', lane['reason'])  # the exact native record is cited
                self.assertRegex(lane['started_at'], ISO)
                self.assertRegex(lane['finished_at'], ISO)
                self.assertEqual(self.report()['status'], 'PASS')
                self.assertEqual(fake.lines[-1], (
                    'DEPLOY_PRODUCTION PASS sha=1234567890ab lanes=render:PASS,backend-probes:PASS,'
                    f'agentcard:SKIPPED-stall,semantic:PASS stall=agentcard:{json.dumps(lane["reason"])} '
                    f'report={self.state / dp.REPORT}'))
                self.assertTrue(any('SKIPPED-stall' in line and line.startswith('[agentcard] ') and '⚠️⚠️' in line
                                    for line in fake.lines), fake.lines)
                self.assertFalse(any(line.startswith('[agentcard] PASS') for line in fake.lines))

    def test_stall_records_timing_only_factory_events_and_verifies_production(self) -> None:
        fake, exit_code = self.execute(lambda: stall_record())
        self.assertEqual(exit_code, 0)
        # production-start/finish is a wall-clock pair with no verdict field (factory_diagnostics pairs it as
        # external-deploy time): the stall's run time is real lane time, the verdict lives in production-lanes.json.
        self.assertIn(('production-start', 'agentcard'), fake.factory)
        self.assertIn(('production-finish', 'agentcard'), fake.factory)
        self.assertEqual(fake.factory[-1], ('stage-finish', 'production-verify'))

    def test_unrecorded_amount_is_never_zero(self) -> None:
        for bad in ({'transferredCents': None}, {'transferredCents': True}, {'transferredCents': -5},
                    {'transferredCents': '4396'}, {'transferredCents': 4396.5}):
            with self.subTest(bad=bad):
                self.execute(lambda bad=bad: stall_record(stall_lifecycle(**bad)))
                self.assertEqual(self.lane()['status'], dp.STALL)
                self.assertTrue(self.lane()['reason'].startswith('Unreleased: UNRECORDED; pending Stripe refund; '
                                                                 'followup'), self.lane()['reason'])
        lifecycle = stall_lifecycle()
        del lifecycle['orgTransfer']['transferredCents']
        self.execute(lambda: stall_record(lifecycle))
        self.assertIn('Unreleased: UNRECORDED', self.lane()['reason'])

    def assert_blocks(self, record, *, why: str | None = None, **kw) -> None:
        fake, exit_code = self.execute(record, **kw)
        self.assertEqual(exit_code, 1, fake.lines[-3:])
        lane = self.lane()
        self.assertEqual(lane['status'], dp.FAIL, lane)
        self.assertEqual(self.report()['status'], 'FAIL')
        self.assertNotIn('SKIPPED-stall', fake.lines[-2])
        self.assertNotIn(('production-finish', 'agentcard'), fake.factory)
        if why:
            self.assertIn(why, lane['reason'])

    def test_any_other_exit_code_stays_a_failure(self) -> None:
        for code in (2, 127, 130, 137, 143, -9):
            with self.subTest(code=code):
                self.assert_blocks(lambda: stall_record(), code=code)
                self.assertEqual(self.lane()['reason'], f'run-bench agent-payment-production-abandonment exited {code}')

    def test_a_missing_older_or_ambiguous_record_stays_a_failure(self) -> None:
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        self.assert_blocks(lambda: stall_record(timestamp=old), code=1, why='before this lane started')
        self.assert_blocks(lambda: stall_record(), code=1, lines=[], why='no run record path')
        self.assert_blocks(lambda: stall_record(), code=1, lines=['Results saved: {runs}/not-written.json'],
                           why='not a file')
        self.assert_blocks(lambda: [stall_record(), stall_record()], code=1, why='2 different run records')
        self.assert_blocks(lambda: stall_record(), code=1, lines=['  Results saved: /etc/hostname'],
                           why='outside agents/benchmarks/runs')
        self.assert_blocks(lambda: stall_record(), code=1, lines=['  Results saved: {runs}/../escape.json'],
                           why='outside agents/benchmarks/runs')
        (self.runs.parent / 'elsewhere.json').write_text(json.dumps(stall_record()))
        (self.runs / 'link.json').symlink_to(self.runs.parent / 'elsewhere.json')  # a link out of the runs directory
        self.assert_blocks(lambda: None, code=1, lines=['  Results saved: {runs}/link.json'],
                           why='outside agents/benchmarks/runs')
        self.assert_blocks(lambda: 'not json {', code=1, why='not a JSON object')
        self.assert_blocks(lambda: '[1, 2]', code=1, why='not a JSON object')
        self.assert_blocks(lambda: {**stall_record(), 'timestamp': 'yesterday'}, code=1, why='timestamp')
        naive = datetime.now(timezone.utc).replace(tzinfo=None)
        self.assert_blocks(lambda: stall_record(timestamp=naive), code=1, why='timestamp')

    def test_a_record_for_another_task_or_with_extra_tasks_stays_a_failure(self) -> None:
        self.assert_blocks(lambda: stall_record(name='agent-payment-abandonment'), code=1, why=f'is not exactly one {TASK} task')
        extra = stall_record(name='other-task')['tasks'][0]
        self.assert_blocks(lambda: stall_record(more_tasks=(extra,),
                                                summary={'total': 2, 'passed': 0, 'failed': 0, 'skipped': 2,
                                                         'cleanup_failures': 0}), code=1, why=f'is not exactly one {TASK} task')

    def test_other_native_outcomes_stay_failures(self) -> None:
        for status in ('FAILED', 'ERROR', 'CANCELLED', 'PASSED'):
            self.assert_blocks(lambda status=status: stall_record(status=status), code=1, why='SKIPPED')
        self.assert_blocks(lambda: stall_record(benchmark_status='ERROR'), code=1, why='SKIPPED')
        self.assert_blocks(lambda: stall_record(reason='Cloud cleanup failed: payment: TimeoutError'), code=1,
                           why='reason')
        self.assert_blocks(lambda: stall_record(reason=''), code=1, why='reason')
        self.assert_blocks(lambda: stall_record(errors=['cleanup: TimeoutError']), code=1, why='evidence/cleanup errors')
        self.assert_blocks(lambda: stall_record(logs={'agentcard_release_stall_lifecycle': stall_lifecycle()}), code=1,
                           why='evidence/cleanup errors')
        self.assert_blocks(lambda: stall_record(cleanup_failure='cleanup unverified'), code=1, why='cleanup_failure')
        for summary in ({'total': 1, 'passed': 0, 'failed': 1, 'skipped': 1, 'cleanup_failures': 0},
                        {'total': 1, 'passed': 0, 'failed': 0, 'skipped': 1, 'cleanup_failures': 1},
                        {'total': 1, 'passed': 0, 'failed': 0, 'skipped': 1},
                        {'total': 1, 'passed': 0, 'failed': 0, 'cleanup_failures': 0}):
            self.assert_blocks(lambda summary=summary: stall_record(summary=summary), code=1, why='summary')

    def test_strict_release_diagnostics_restore_the_failure(self) -> None:
        for value in ('0', '', 'true'):
            self.assert_blocks(lambda: stall_record(), code=1, environ={dp.STALL_ENV: value}, why=dp.STALL_ENV)

    def test_sandbox_or_partial_lifecycle_stays_a_failure(self) -> None:
        self.assert_blocks(lambda: stall_record(stall_lifecycle(livemode=False)), code=1, why='lifecycle')
        mutations = {
            'purchase HELD': lambda l: l['purchase'].update(status='VOIDED'),
            'funding RECLAIMING': lambda l: l['walletFunding'].update(status='RECLAIMED'),
            'card CLOSED': lambda l: l['agentCard'].update(status='OPEN'),
            'balance 0': lambda l: l['agentCard'].update(balanceCents=1),
            'balance bool': lambda l: l['agentCard'].update(balanceCents=False),
            'balance missing': lambda l: l['agentCard'].pop('balanceCents'),
            'card id missing': lambda l: l['agentCard'].pop('id'),
            'card id blank': lambda l: (l['agentCard'].update(id=' '), l['purchase'].update(cardId=' '),
                                        l['orgTransfer'].update(cardId=' ')),
            'purchase card differs': lambda l: l['purchase'].update(cardId='card_other'),
            'transfer card differs': lambda l: l['orgTransfer'].update(cardId='card_other'),
            'transfer card missing': lambda l: l['orgTransfer'].pop('cardId'),
            'transfer id blank': lambda l: (l['orgTransfer'].update(id=''), l['walletFunding'].update(providerTransferId='')),
            'funding transfer differs': lambda l: l['walletFunding'].update(providerTransferId='owt_other'),
            'transfer consumed': lambda l: l['orgTransfer'].update(status='reclaimed'),
            'released 0': lambda l: l['orgTransfer'].update(releasedCents=4396),
            'released bool': lambda l: l['orgTransfer'].update(releasedCents=False),
            'released missing': lambda l: l['orgTransfer'].pop('releasedCents'),
            'live mode': lambda l: l['orgTransfer'].update(livemode=False),
            'live mode missing': lambda l: l['orgTransfer'].pop('livemode'),
            'refund present': lambda l: l.update(stripeRefund={'status': 'succeeded', 'amountCents': 100}),
            'refund missing': lambda l: l.pop('stripeRefund'),
            'transfer missing': lambda l: l.pop('orgTransfer'),
            'lifecycle not a dict': None,
        }
        for label, mutate in mutations.items():
            lifecycle = stall_lifecycle()
            if mutate is None:
                lifecycle = ['not', 'a', 'lifecycle']
            else:
                mutate(lifecycle)
            with self.subTest(label):
                self.assert_blocks(lambda lifecycle=lifecycle: stall_record(lifecycle), code=1, why='lifecycle')

    def test_exit_zero_is_pass_unless_the_record_claims_an_unproven_stall(self) -> None:
        passed = lambda: stall_record(status='PASSED', reason='', logs={})
        fake, exit_code = self.execute(passed, code=0)
        self.assertEqual((exit_code, self.lane()['status']), (0, dp.PASS))
        self.assertEqual(self.lane()['reason'], 'agent-payment-production-abandonment passed')
        self.assertIn(('production-finish', 'agentcard'), fake.factory)
        fake, exit_code = self.execute(lambda: None, code=0, lines=[])  # no record printed: unchanged exit-code rule
        self.assertEqual((exit_code, self.lane()['status']), (0, dp.PASS))
        # SKIPPED with the stall's runtime reason but not the exact stall: PASS would misreport it.
        self.assert_blocks(lambda: stall_record(stall_lifecycle(livemode=False)), code=0,
                           why='claims the AgentCard release stall')
        self.assert_blocks(lambda: stall_record(errors=['delete: boom']), code=0,
                           why='claims the AgentCard release stall')
        self.assertEqual(self.lane()['exit_code'], 0)

    def test_stall_is_carried_forward_and_prior_stall_never_becomes_pass(self) -> None:
        self.execute(lambda: stall_record())
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--lanes', 'semantic', lane_funcs=fake_lanes({}, order, lock)), 0)
        lane = self.lane()
        self.assertEqual((lane['status'], lane.get('carried_forward')), (dp.STALL, True))
        self.assertEqual(order, [('start', 'semantic'), ('end', 'semantic')])
        self.assertIn('agentcard:SKIPPED-stall', fake.lines[-1])
        self.assertIn('stall=agentcard:', fake.lines[-1])

    def test_a_stall_does_not_hide_another_failure(self) -> None:
        def handler(argv, cwd, env, on_line):
            if TASK in argv:
                path = self.runs / 'run.json'
                path.write_text(json.dumps(stall_record()))
                on_line(f'Results saved: {path}')
            return 0
        fake = Fake(self.root, self.CHANGED, handler=handler)
        lanes = {n: f for n, f in fake_lanes({'semantic': (False, 'red', 1)}, [], threading.Lock()).items() if n != 'agentcard'}
        self.assertEqual(self.main(fake, lane_funcs=lanes), 1)
        self.assertEqual(self.lane()['status'], dp.STALL)
        self.assertRegex(fake.lines[-2], r'^DEPLOY_PRODUCTION FAIL sha=1234567890ab failed=semantic not-run=- '
                                         r'lanes=.*agentcard:SKIPPED-stall,semantic:FAIL stall=agentcard:')

    def test_election_stays_distinct_from_the_stall(self) -> None:
        order, lock = [], threading.Lock()
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--skip-agentcard', 'why', lane_funcs=fake_lanes({}, order, lock)), 0)
        self.assertEqual(self.lane()['status'], dp.ELECTED)
        self.assertNotEqual(dp.ELECTED, dp.STALL)
        self.assertEqual(set(dp.SATISFIED), {dp.PASS, dp.ELECTED, dp.STALL})
        self.assertNotIn('stall=', fake.lines[-1])

    def test_dry_run_is_unchanged_by_the_stall_qualification(self) -> None:
        fake = Fake(self.root, self.CHANGED)
        self.assertEqual(self.main(fake, '--dry-run'), 0)
        text = '\n'.join(fake.lines)
        self.assertRegex(text, r'agentcard\s+APPLICABLE\s+AgentCard payment path changed')
        self.assertIn('scripts/run-bench agent-payment-production-abandonment', text)
        self.assertNotIn('SKIPPED-stall', text)
        self.assertEqual((fake.runs, fake.factory), ([], []))

    def test_json_report_shape_with_a_stall(self) -> None:
        self.execute(lambda: stall_record())
        report = self.report()
        self.assertEqual({'schema_version', 'sha', 'pr', 'status', 'started_at', 'finished_at', 'changed_files',
                          'selected', 'lanes'}, set(report))
        self.assertEqual(list(report['lanes']), list(dp.LANES))
        lane = report['lanes']['agentcard']
        self.assertTrue({'status', 'reason', 'started_at', 'finished_at', 'exit_code', 'command', 'log',
                         'depends_on', 'applicable'} <= set(lane))
        self.assertTrue(lane['command'].startswith(f'PATH={self.root / "agents" / "venv" / "bin"}:$PATH '), lane['command'])
        self.assertTrue(lane['command'].endswith(' scripts/run-bench agent-payment-production-abandonment'))
        self.assertEqual({n for n, row in report['lanes'].items() if row['status'] == dp.STALL}, {'agentcard'})

    def test_lane_result_fails_closed_for_callers_that_only_read_passed(self) -> None:
        def handler(argv, cwd, env, on_line):
            path = self.runs / 'run.json'
            path.write_text(json.dumps(stall_record()))
            on_line(f'Results saved: {path}')
            return 0
        fake = Fake(self.root, self.CHANGED, handler=handler)
        ctx = self.ctx(fake, self.CHANGED)
        passed, reason, code = dp.lane_agentcard(ctx)
        self.assertIs(passed, False)
        self.assertIsInstance(reason, dp.Stall)
        self.assertEqual(code, 0)


class StallExactnessTest(unittest.TestCase):
    """The deploy-side predicate and prefix stay bound to the runner that produces the record."""

    def test_reason_prefix_is_the_runtime_reason(self) -> None:
        cycle = importlib.import_module('deploy_test_cycle')
        self.assertTrue(runtime_constant('AGENTCARD_RELEASE_SKIP_REASON').startswith(cycle.AGENTCARD_RELEASE_STALL_REASON))
        self.assertEqual(runtime_constant('AGENTCARD_RELEASE_SKIP_ENV'), dp.STALL_ENV)
        self.assertIn('2026-10-02-agentcard-abandonment-closed-card-transfer-never-released',
                      runtime_constant('AGENTCARD_RELEASE_SKIP_REASON'))

    def test_predicate_matches_run_benchmark_for_every_single_field_mutation(self) -> None:
        source = next(n for n in runner_source().body if isinstance(n, ast.FunctionDef)
                      and n.name == '_agentcard_release_stalled')
        namespace: dict = {}
        exec(compile(ast.Module(body=[source], type_ignores=[]), 'run_benchmark.py', 'exec'), namespace)
        runner = namespace['_agentcard_release_stalled']
        base = stall_lifecycle()
        variants = [base, stall_lifecycle(livemode=False), [], None, 'x', {}]
        sections = ('purchase', 'walletFunding', 'agentCard', 'orgTransfer')
        values = (None, '', ' ', 'x', 0, 1, -1, True, False, [], {}, 'HELD', 'RECLAIMING', 'CLOSED', 'consumed',
                  'reclaimed', 'OPEN', 'VOIDED', 'card_other', 'owt_other', 4396)
        for section in sections:
            for field in list(base[section]) + ['missing-field']:
                for value in values:
                    row = copy.deepcopy(base)
                    row[section][field] = value
                    variants.append(row)
                row = copy.deepcopy(base)
                row[section].pop(field, None)
                variants.append(row)
            row = copy.deepcopy(base)
            row.pop(section)
            variants.append(row)
            row = copy.deepcopy(base)
            row[section] = None
            variants.append(row)
        for value in (None, {}, {'status': 'succeeded'}, 'refund'):
            row = copy.deepcopy(base)
            row['stripeRefund'] = value
            variants.append(row)
        row = copy.deepcopy(base)
        row.pop('stripeRefund')
        variants.append(row)
        self.assertGreater(len(variants), 400)
        stalled = 0
        for row in variants:
            for livemode in (True, False):
                expected = runner(row, livemode=livemode)
                stalled += expected
                self.assertEqual(dp.release_stalled(row, livemode=livemode), expected, (livemode, row))
        self.assertGreater(stalled, 2)  # the good production and sandbox lifecycles both qualify in their own mode

    def test_catalog_predicate_binds_the_production_task_not_the_sandbox_task(self) -> None:
        cycle = importlib.import_module('deploy_test_cycle')
        self.assertTrue(cycle.agentcard_release_stall_task(TASK, ROOT, production=True))
        self.assertFalse(cycle.agentcard_release_stall_task(TASK, ROOT))  # smoke rows stay sandbox-only
        self.assertFalse(cycle.agentcard_release_stall_task('agent-payment-abandonment', ROOT, production=True))
        self.assertTrue(cycle.agentcard_release_stall_task('agent-payment-abandonment', ROOT))
        self.assertFalse(cycle.agentcard_release_stall_task('no-such-task', ROOT, production=True))



class OtherLanesTest(Base):
    def test_semantic_runs_fly_gate_only_when_receipt_not_passed(self) -> None:
        fake = Fake(self.root, [])
        self.assertTrue(dp.lane_semantic(self.ctx(fake))[0])
        self.assertEqual(fake.kinds(), ['production', 'production-semantic'])
        self.write_production(status='passed', semantic={'run_id': '55'})
        fake = Fake(self.root, [])
        self.assertEqual(dp.lane_semantic(self.ctx(fake)), (True, 'chat-lifecycle-ratchet run 55 success', 0))
        self.assertEqual(fake.kinds(), ['production-semantic'])

    def test_agentcard_and_wmh_use_agents_venv(self) -> None:
        fake = Fake(self.root, [])
        ctx = self.ctx(fake)
        ctx.plan = dp.plan_lanes(['agents/vendor/world-model/x.whl'], [], NO_MAC)
        self.assertTrue(dp.lane_agentcard(ctx)[0])
        self.assertTrue(dp.lane_wmh(ctx)[0])
        self.assertEqual(fake.kinds(), ['agent-payment-production-abandonment', '--build-wmh', '--refresh-wmh',
                                        'raise-5m-rose-labs-brex'])
        self.assertTrue(fake.runs[0][2]['PATH'].startswith(str(self.root / 'agents' / 'venv' / 'bin') + ':'))
        self.assertEqual(fake.runs[3][0], dp.WMH_ARGV)

    def test_wmh_build_failure_stops_before_sim(self) -> None:
        fake = Fake(self.root, [], handler=lambda argv, cwd, env, on_line: 1 if '--build-wmh' in argv else 0)
        ctx = self.ctx(fake)
        ctx.plan = dp.plan_lanes(['agents/requirements-world-model.txt'], [], NO_MAC)
        self.assertFalse(dp.lane_wmh(ctx)[0])
        self.assertEqual(fake.kinds(), ['--build-wmh'])

    def test_mac_release_binds_exact_sha_after_merge(self) -> None:
        polls = [[{'databaseId': 1, 'headSha': SHA, 'createdAt': '2026-11-05T17:59:59Z'},
                  {'databaseId': 2, 'headSha': 'b' * 40, 'createdAt': '2026-11-05T18:05:00Z'}],
                 [{'databaseId': 3, 'headSha': SHA, 'createdAt': '2026-11-05T18:01:00Z', 'headBranch': 'v1.0.9'}]]
        fake = Fake(self.root, [], gh=lambda args: (0, json.dumps(polls.pop(0) if len(polls) > 1 else polls[0]), ''))
        ctx = self.ctx(fake, gh=str(dp.DEVBOX_GH))
        ctx.plan = dp.plan_lanes([], [], {'ship': 'true', 'reason': 'label', 'label': 'true'})
        self.assertEqual(dp.lane_mac_release(ctx), (True, 'release-mac-app run 3 success', 0))
        self.assertEqual(fake.runs[0][0], [str(dp.DEVBOX_GH), 'run', 'watch', '3', '--exit-status'])
        self.assertEqual(fake.sleeps, [10.0])

    def test_mac_release_label_lookup_failure_fails_closed(self) -> None:
        fake = Fake(self.root, ['docs/a.mdx'], gh=lambda args: (1, '', 'HTTP 401 Bad credentials'))
        self.assertEqual(self.main(fake, '--lanes', 'mac-release'), 1)
        lane = self.report()['lanes']['mac-release']
        self.assertEqual(lane['status'], dp.FAIL)
        self.assertIn('HTTP 401 Bad credentials', lane['reason'])
        self.assertEqual(fake.runs, [])

    def test_main_feeds_merge_diff_and_pr_label_to_decision(self) -> None:
        labelled = Fake(self.root, ['docs/a.mdx'], gh=lambda args: (0, json.dumps({'labels': [{'name': 'MAC-APP-RELEASE'}]}), ''))
        self.assertEqual(self.main(labelled, '--dry-run'), 0)
        self.assertEqual(labelled.decisions, ['true'])
        self.assertRegex('\n'.join(labelled.lines), r'mac-release\s+APPLICABLE\s+mac-app-release-decision ship=true '
                                                     r'reason=label \(PR #1690 with MAC-APP-RELEASE\)')
        plain = Fake(self.root, ['docs/a.mdx'])
        self.assertEqual(self.main(plain, '--dry-run'), 0)
        self.assertEqual(plain.decisions, ['false'])
        self.assertRegex('\n'.join(plain.lines), r'mac-release\s+SKIPPED-not-applicable\s+mac-app-release-decision '
                                                  r'ship=false reason=no-shipped-change')

    def test_gh_setup(self) -> None:
        gh, env, values = dp.gh_setup(self.root, {}, lambda path: path == dp.DEVBOX_GH)
        self.assertEqual((gh, env), (str(dp.DEVBOX_GH), {'DEPLOY_GH_BIN': str(dp.DEVBOX_GH),
                                                         'GH_TOKEN': SECRETS['GITHUB_TOKEN']}))
        self.assertEqual(dp.gh_setup(self.root, {'DEPLOY_GH_BIN': '/x/gh'}, lambda path: False), ('/x/gh', {}, {}))
        self.assertEqual(dp.gh_setup(self.root, {}, lambda path: False), ('gh', {}, {}))


if __name__ == '__main__':
    unittest.main()
