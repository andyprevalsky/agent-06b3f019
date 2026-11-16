#!/usr/bin/env python3
"""The /deploy cloud smoke lane reuses one infra-canary pass per repository.

deploy_test_cloud.py hands the fleet a repository-scoped canary stamp and lock (the git
common directory), so a fresh deploy worktree does not re-run the 2-machine canary that
another worktree passed within its TTL. The fleet's own fail-closed gate is unchanged.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_test_cloud as cloud
import deploy_test_cloud_refusal as refusal

ORIGIN_FETCHABLE = cloud.origin_fetchable  # the real preflight; tests patch the module copy offline


def repo_with_worktree(tmp):
    main, linked = Path(tmp) / 'main', Path(tmp) / 'linked'
    subprocess.run(['git', 'init', '-q', str(main)], check=True)
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@t'}
    subprocess.run(['git', 'commit', '-q', '--allow-empty', '-m', 'c'], cwd=main, check=True, env=env)
    subprocess.run(['git', 'worktree', 'add', '-q', '--detach', str(linked)], cwd=main, check=True)
    return main, linked


class SharedCanaryStamp(unittest.TestCase):
    def setUp(self):
        # This disposable fixture owns its request; the parent deploy owns its own.
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('DEPLOY_GATE_REQUEST', None)
        # Offline: fixture refs count as pushed unless a test exercises the real preflight.
        pushed = patch.object(cloud, 'origin_fetchable', return_value=True)
        pushed.start()
        self.addCleanup(pushed.stop)

    def test_outer_request_does_not_rebind_fixture_custody(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            request.parent.mkdir(parents=True)
            request.write_text('{}')
            env = dict(os.environ, DEPLOY_GATE_REQUEST=str(request))
            result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()),
                'SharedCanaryStamp.test_the_smoke_launch_passes_the_shared_stamp_to_the_fleet'], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn('Ran 1 test', result.stdout)

    def test_fixture_restores_request_and_native_owner_guard(self):
        import deploy_test_historical_custody as custody
        before = dict(os.environ)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            with patch.dict(os.environ, {'DEPLOY_GATE_REQUEST': str(request)}):
                fixture = type(self)('test_the_smoke_launch_passes_the_shared_stamp_to_the_fleet')
                try:
                    fixture.setUp()
                    self.assertFalse('DEPLOY_GATE_REQUEST' in os.environ)
                finally:
                    fixture.doCleanups()
                self.assertEqual(os.environ['DEPLOY_GATE_REQUEST'], str(request))
                for value in ({}, {'custody_state': str(root / '.context/foreign/cycle.json')}):
                    with self.assertRaisesRegex(ValueError, 'missing request-owned custody locator'):
                        custody.admission(value, root)
        self.assertEqual(dict(os.environ), before)

    def test_historical_custody_guard_precedes_namespace_and_provider_admission(self):
        import deploy_test_historical_custody as custody
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = dict(token='a' * 32, source={'head': 'b' * 40}, gate='smoke', checks=['case'], skips={})
            with patch.object(cloud, 'source', return_value=request['source']), \
                    patch.object(custody, 'admission', side_effect=ValueError('historical custody missing')) as guard, \
                    patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir')) as mkdir, \
                    patch.object(cloud, 'campaign_width', side_effect=AssertionError('capacity')) as capacity, \
                    patch.object(cloud, 'run_command', side_effect=AssertionError('provider')) as provider:
                with self.assertRaisesRegex(ValueError, 'historical custody'):
                    cloud.execute(request, root)
                guard.assert_called_once_with(request, root)
                mkdir.assert_not_called(); capacity.assert_not_called(); provider.assert_not_called()

    def test_source_guard_writes_explicit_unverified_no_admission_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'token': 'a' * 32, 'source': {'head': 'a' * 40, 'digest': 'a' * 64},
                       'gate': 'smoke', 'checks': ['one', 'two'], 'skips': {}}
            request_path, result_path = root / 'request.json', root / 'result.json'
            cloud.write(request_path, request)
            mkdir_original = Path.mkdir
            def result_parent_only(path, *args, **kwargs):
                self.assertEqual(path, root, 'source refusal crossed the allocation mkdir boundary')
                return mkdir_original(path, *args, **kwargs)
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                    patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
                    patch.object(cloud, 'source', return_value={'head': 'b' * 40}), \
                    patch.object(Path, 'mkdir', autospec=True, side_effect=result_parent_only), \
                    patch.object(cloud, 'campaign_width', side_effect=AssertionError('capacity')) as capacity, \
                    patch.object(cloud, 'shared_canary_env', side_effect=AssertionError('canary')) as canary, \
                    patch.object(cloud, 'run_command', side_effect=AssertionError('provider')) as provider:
                self.assertEqual(cloud.main(), 2)
                for sentinel in (capacity, canary, provider):
                    sentinel.assert_not_called()
            result = cloud.read(result_path)
            self.assertEqual(result['admission'], {'kind': 'cloud-source-refusal-v1', 'admitted': False})
            self.assertTrue(result['cleanup_complete'])
            self.assertFalse(result['complete'])
            self.assertEqual(result['cases'], {'one': 'UNVERIFIED', 'two': 'UNVERIFIED'})
            self.assertFalse((root / '.context/deploy-cloud').exists())

    def test_unpushed_ref_writes_typed_refusal_before_any_admission(self):
        # PR #1767: an unpushed sync merge reached 13 dispatched jobs that all died at run-bench preflight.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'token': 'a' * 32, 'source': {'head': 'a' * 40, 'digest': 'a' * 64},
                       'gate': 'smoke', 'checks': ['one', 'two'], 'skips': {}}
            request_path, result_path = root / 'request.json', root / 'result.json'
            cloud.write(request_path, request)
            mkdir_original = Path.mkdir
            def result_parent_only(path, *args, **kwargs):
                self.assertEqual(path, root, 'unpushed refusal crossed the allocation mkdir boundary')
                return mkdir_original(path, *args, **kwargs)
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                    patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
                    patch.object(cloud, 'source', return_value=request['source']), \
                    patch.object(cloud, 'origin_fetchable', return_value=False) as fetchable, \
                    patch.object(Path, 'mkdir', autospec=True, side_effect=result_parent_only), \
                    patch.object(cloud, 'campaign_width', side_effect=AssertionError('capacity')) as capacity, \
                    patch.object(cloud, 'shared_canary_env', side_effect=AssertionError('canary')) as canary, \
                    patch.object(cloud, 'run_command', side_effect=AssertionError('provider')) as provider:
                self.assertEqual(cloud.main(), 2)
                fetchable.assert_called_once_with(root, 'a' * 40)
                for sentinel in (capacity, canary, provider):
                    sentinel.assert_not_called()
            result = cloud.read(result_path)
            self.assertEqual(result['admission'], {'kind': 'cloud-source-refusal-v1', 'admitted': False})
            self.assertEqual(result['reason'], refusal.unpushed_reason('a' * 40))
            self.assertTrue(result['reason'].startswith('push ' + 'a' * 40 + ' before gates'))
            self.assertEqual((result['native_command'], result['fleet_directory']), ([], None))
            self.assertTrue(result['cleanup_complete'])
            self.assertFalse(result['complete'])
            self.assertEqual(result['cases'], {'one': 'UNVERIFIED', 'two': 'UNVERIFIED'})
            self.assertFalse((root / '.context/deploy-cloud').exists())

    def test_custody_locator_refusal_writes_typed_receipt_before_allocation(self):
        # PR #1784 cycle bn6: a custody locator refusal took the generic BLOCKED path, so the
        # coordinator retained a cleanup owner although no namespace or fleet existed.
        import deploy_test_historical_custody as custody
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'token': 'a' * 32, 'source': {'head': 'a' * 40, 'digest': 'a' * 64},
                       'gate': 'smoke', 'checks': ['one', 'two'], 'skips': {}}
            request_path, result_path = root / 'request.json', root / 'result.json'
            cloud.write(request_path, request)
            mkdir_original = Path.mkdir
            def result_parent_only(path, *args, **kwargs):
                self.assertEqual(path, root, 'custody refusal crossed the allocation mkdir boundary')
                return mkdir_original(path, *args, **kwargs)
            refusal_error = custody.AdmissionRefusal('canonical-custody-uncovered', 'fixture detail')
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                    patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
                    patch.object(cloud, 'source', return_value=request['source']), \
                    patch.object(custody, 'admission', side_effect=refusal_error), \
                    patch.object(Path, 'mkdir', autospec=True, side_effect=result_parent_only), \
                    patch.object(cloud, 'campaign_width', side_effect=AssertionError('capacity')) as capacity, \
                    patch.object(cloud, 'shared_canary_env', side_effect=AssertionError('canary')) as canary, \
                    patch.object(cloud, 'run_command', side_effect=AssertionError('provider')) as provider:
                self.assertEqual(cloud.main(), 2)
                for sentinel in (capacity, canary, provider):
                    sentinel.assert_not_called()
            result = cloud.read(result_path)
            self.assertEqual(result['admission'], {'kind': 'cloud-source-refusal-v1', 'admitted': False})
            self.assertEqual(result['reason_code'], 'canonical-custody-uncovered')
            self.assertEqual(result['reason'], custody.ADMISSION_REFUSALS['canonical-custody-uncovered'])
            self.assertEqual((result['native_command'], result['fleet_directory'], result['evidence']), ([], None, {}))
            self.assertEqual((result['complete'], result['cleanup_complete']), (False, True))
            self.assertEqual(result['cases'], {'one': 'UNVERIFIED', 'two': 'UNVERIFIED'})
            self.assertFalse((root / '.context/deploy-cloud').exists())

    def test_custody_refusal_after_namespace_or_untyped_error_never_claims_no_admission(self):
        import deploy_test_historical_custody as custody
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'token': 'a' * 32, 'source': {'head': 'a' * 40, 'digest': 'a' * 64},
                       'gate': 'smoke', 'checks': ['one'], 'skips': {}}
            request_path, result_path = root / 'request.json', root / 'result.json'
            cloud.write(request_path, request)
            namespace = root / '.context/deploy-cloud' / cloud.hashlib.sha256(request['token'].encode()).hexdigest()
            for error, existing in ((custody.AdmissionRefusal('canonical-locator-missing'), True),
                                    (ValueError('historical custody: admission input fingerprint changed'), False)):
                if existing:
                    namespace.mkdir(parents=True)
                with self.subTest(error=str(error)), \
                        patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                        patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
                        patch.object(cloud, 'source', return_value=request['source']), \
                        patch.object(custody, 'admission', side_effect=error), \
                        patch.object(cloud, 'run_command', side_effect=AssertionError('provider')) as provider:
                    self.assertEqual(cloud.main(), 2)
                    provider.assert_not_called()
                    self.assertFalse(result_path.exists())
                if existing:
                    namespace.rmdir()

    def test_origin_fetchable_is_the_fleet_preflight_without_patch_shipping(self):
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
               'GIT_COMMITTER_EMAIL': 't@t', 'CLOUDBENCH_GITHUB_TOKEN_B64': ''}
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            root = Path(tmp).resolve()
            git = lambda *a: subprocess.run(['git', *a], cwd=root, check=True, env=env, capture_output=True,
                                            text=True).stdout.strip()
            git('init', '-q')
            (root / 'scripts/lib').mkdir(parents=True)
            (root / 'scripts/lib/cloudbench-env.sh').write_bytes(
                (Path(cloud.__file__).parent / 'lib/cloudbench-env.sh').read_bytes())
            git('add', '-A')
            git('commit', '-qm', 'pushed')
            pushed = git('rev-parse', 'HEAD')
            git('remote', 'add', 'origin', str(root / 'not-github.git'))  # no live advertisement admitted
            self.assertFalse(ORIGIN_FETCHABLE(root, pushed, env))  # no origin/main ancestry yet
            git('update-ref', 'refs/remotes/origin/main', pushed)
            self.assertTrue(ORIGIN_FETCHABLE(root, pushed, env))
            git('commit', '-q', '--allow-empty', '-m', 'local sync merge, not pushed')
            self.assertFalse(ORIGIN_FETCHABLE(root, git('rev-parse', 'HEAD'), env))

    def test_other_refusals_never_claim_no_admission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'token': 'a' * 32, 'source': {'head': 'a' * 40, 'digest': 'a' * 64},
                       'gate': 'smoke', 'checks': ['one'], 'skips': {}}
            request_path, result_path = root / 'request.json', root / 'result.json'
            cloud.write(request_path, request)
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                    patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
                    patch.object(cloud, 'source', return_value=request['source']), \
                    patch.object(cloud, 'campaign_width', return_value=0):
                self.assertEqual(cloud.main(), 2)
                self.assertFalse(result_path.exists())
                self.assertTrue((root / '.context/deploy-cloud').is_dir())
                cloud.write(request_path, {**request, 'checks': []})
                self.assertEqual(cloud.main(), 2)
                self.assertFalse(result_path.exists())

    def test_every_worktree_of_a_repository_shares_one_stamp_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            main, linked = repo_with_worktree(tmp)
            first, second = cloud.shared_canary_env(main, {}), cloud.shared_canary_env(linked, {})
            self.assertEqual(first, second)
            directory = (main / '.git/cloudbench-infra-canary').resolve()
            self.assertEqual(first, {'FLEET_INFRA_CANARY_STAMP': str(directory / 'last-pass'),
                                     'FLEET_INFRA_CANARY_LOCK': str(directory / 'transaction.lock')})
            self.assertTrue(directory.is_dir())
            self.assertNotIn(str(linked), first['FLEET_INFRA_CANARY_STAMP'])  # not the worktree's .context

    def test_explicit_overrides_are_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            main, _ = repo_with_worktree(tmp)
            env = cloud.shared_canary_env(main, {'FLEET_INFRA_CANARY_STAMP': '/x/stamp'})
            self.assertEqual(env['FLEET_INFRA_CANARY_STAMP'], '/x/stamp')
            self.assertTrue(env['FLEET_INFRA_CANARY_LOCK'].endswith('cloudbench-infra-canary/transaction.lock'))

    def test_a_root_outside_git_keeps_the_fleet_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(cloud.shared_canary_env(Path(tmp), {}), {})

    def test_the_smoke_launch_passes_the_shared_stamp_to_the_fleet(self):
        # Behavioral, not a source literal: the real execute() must hand the native CLI the
        # repository-scoped stamp and lock, unoverridden by any later env entry (for example
        # the capacity-admission deadline added after it).
        request = {'checks': ['browser-smoke'], 'skips': {}, 'token': 'owned',
                   'source': {'head': 'a' * 40}, 'gate': 'smoke'}
        launches = []

        def run_command(argv, **kwargs):
            launches.append((argv, kwargs['env']))
            return 1, False, False, False

        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            _, linked = repo_with_worktree(tmp)
            with mock.patch.dict(os.environ), \
                    mock.patch.object(cloud, 'source', lambda _root: request['source']), \
                    mock.patch.object(cloud, 'campaign_width', lambda _checks: 1), \
                    mock.patch.object(cloud, 'run_command', run_command), \
                    mock.patch.object(cloud, 'collect_campaign',
                                      lambda *_a: ({'browser-smoke': 'UNVERIFIED'}, {}, False, None)):
                for key in ('FLEET_INFRA_CANARY_STAMP', 'FLEET_INFRA_CANARY_LOCK'):
                    os.environ.pop(key, None)
                expected = cloud.shared_canary_env(linked, {})
                cloud.execute(request, linked)
        self.assertEqual(len(launches), 1)
        argv, env = launches[0]
        self.assertEqual(argv[:3], ['bash', 'scripts/run-bench', 'browser-smoke'])
        self.assertEqual(env['DEPLOY_CYCLE_FRESH'], '1')
        self.assertEqual({key: env[key] for key in expected}, expected)
        self.assertNotIn(str(linked), env['FLEET_INFRA_CANARY_STAMP'])  # not the worktree's .context



class SingleWidthRerunOwnsFlyTransport(unittest.TestCase):
    """PR #1981 rounds 9 and 13: the single same-source rerun must not leave an unowned Fly agent.

    A natively failed smoke task gets one rerun of just that task, so the rerun campaign has width 1.
    run-bench-campaign started its owned inventory + shared relay (the campaign's private, joined
    `flyctl agent`) only when --concurrency > 1, so the lone rerun controller's flyctl auto-started
    the per-HOME `flyctl agent` daemon. That daemon outlived the campaign; the owned supervisor
    TERMed it (orphaned_children=true, quiescent=true) and launch() reported the rerun as
    "cloud command interrupted or source changed", so the gate went complete=false and every
    smoke occurrence UNVERIFIED although the rerun was a clean native FAIL.
    """

    def setUp(self):
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('DEPLOY_GATE_REQUEST', None)
        pushed = patch.object(cloud, 'origin_fetchable', return_value=True)
        pushed.start()
        self.addCleanup(pushed.stop)

    def run_first_failure_then_rerun(self, rerun_process):
        """Drive the real execute(): one native FAIL, then its single rerun with `rerun_process` flags."""
        request = {'checks': ['chat-mode', 'agent-payment-idempotent-abandonment'], 'skips': {},
                   'token': 'owned', 'source': {'head': 'a' * 40}, 'gate': 'smoke'}
        failed = 'agent-payment-idempotent-abandonment'
        native = {'native_task': {'name': failed, 'benchmark_status': 'FAILED', 'passed': False,
                                  'failure_reason': 'Timeout after 900s'}}
        launches = []

        def run_command(argv, **kwargs):
            launches.append((argv, kwargs['env']))
            return (1, False, False, False) if len(launches) == 1 else (1, *rerun_process)

        def collect(request_, *_args):
            if request_['checks'] == request['checks']:
                return {'chat-mode': 'PASS', failed: 'FAIL'}, {failed: native}, True, 'first'
            return {failed: 'FAIL'}, {failed: native}, True, 'rerun'

        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            _, linked = repo_with_worktree(tmp)
            with mock.patch.object(cloud, 'source', lambda _root: request['source']), \
                    mock.patch.object(cloud, 'campaign_width', lambda checks: len(checks)), \
                    mock.patch.object(cloud, 'catalog_quarantines', lambda *_a: {}), \
                    mock.patch.object(cloud, 'run_command', run_command), \
                    mock.patch.object(cloud, 'collect_campaign', collect):
                result = cloud.execute(request, linked)
        return result, launches

    def test_the_width_one_rerun_starts_the_campaign_owned_fly_transport(self):
        import runpy
        # An inherited "0" must not drop the owned transport (CodeRabbit 4570070975).
        os.environ.update(CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY='0', CLOUDBENCH_CAMPAIGN_SHARED_RELAY='0')
        result, launches = self.run_first_failure_then_rerun((False, False, False))
        self.assertEqual(len(launches), 2)
        argv, env = launches[1]
        self.assertEqual(argv[argv.index('--concurrency') + 1], '1')
        self.assertEqual({k: env[k] for k in ('CLOUDBENCH_CAMPAIGN_OWNED_TRANSPORT', 'CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY',
                                              'CLOUDBENCH_CAMPAIGN_SHARED_RELAY')}, dict.fromkeys(
            ('CLOUDBENCH_CAMPAIGN_OWNED_TRANSPORT', 'CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY', 'CLOUDBENCH_CAMPAIGN_SHARED_RELAY'), '1'))
        # Feed the rerun's exact env and width to the real native campaign entrypoint.
        module = runpy.run_path(str(Path(cloud.__file__).with_name('run-bench-campaign.py')))
        namespace = module['main'].__globals__
        owned = []

        def start_shared_inventory(*_args, **_kwargs):
            owned.append('inventory')
            return None, None, Path(tmp) / 'inventory'

        def start_shared_relay(*_args, **_kwargs):
            # The relay owns the campaign's private, joined flyctl agent (FLY_AGENT_SOCKET_PATH).
            owned.append('relay')
            raise RuntimeError('fixture stops before any controller or provider call')

        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            root = Path(tmp)
            arguments = ['campaign', '--root', str(root), '--runs', '1', '--concurrency', '1',
                         '--retry-infra', '0', '--task=agent-payment-idempotent-abandonment']
            replacements = dict(campaign_workspace=lambda r, _forward: (r, None),
                                provider_capacity_refusal=lambda _n, _tasks=None: None, scorecard_hooks=lambda: None,
                                start_shared_inventory=start_shared_inventory,
                                start_shared_relay=start_shared_relay,
                                stop_shared_inventory=lambda *_a: True,
                                publish_campaign_group=lambda *_a, **_kw: True,
                                join_native_hubs=lambda *_a: True)
            campaign_env = {**env, 'RUN_BENCH_CAMPAIGN_ROOT': str(root / 'campaigns'),
                            'RUN_BENCH_CAMPAIGN_ID': 'width-one-rerun',
                            'BENCHMARK_HUB_GROUP_RUN_ID': '', 'BENCHMARK_HUB_PARENT_RUN_ID': ''}
            with patch.dict(namespace, replacements), patch.object(sys, 'argv', arguments), \
                    patch.dict(os.environ, campaign_env, clear=True):
                module['main']()
        self.assertEqual(owned, ['inventory', 'relay'],
                         'a width-1 deploy campaign must own its inventory/relay (private Fly agent); '
                         'otherwise flyctl starts the unowned per-HOME agent daemon that outlives it')

    def test_a_clean_native_rerun_failure_stays_a_verified_fail(self):
        result, _launches = self.run_first_failure_then_rerun((False, False, False))
        self.assertEqual(result['cases']['agent-payment-idempotent-abandonment'], 'FAIL')
        self.assertEqual(result['cases']['chat-mode'], 'PASS')
        self.assertIsNone(result['rerun']['reason'])
        self.assertTrue(result['complete'])
        self.assertTrue(result['cleanup_complete'])

    def test_a_genuinely_lingering_rerun_stays_unverified_with_its_exact_cause(self):
        for flags, cause in (((False, False, True), 'left a lingering process'),
                             ((True, False, False), 'timed out'),
                             ((False, True, False), 'was cancelled')):
            with self.subTest(cause=cause):
                result, _launches = self.run_first_failure_then_rerun(flags)
                self.assertEqual(result['rerun']['cases'], {'agent-payment-idempotent-abandonment': 'UNVERIFIED'})
                self.assertIn(cause, result['rerun']['reason'])
                self.assertNotIn('source changed', result['rerun']['reason'])
                self.assertFalse(result['complete'])
                self.assertFalse(result['cleanup_complete'])
                # A rerun never upgrades the first native failure.
                self.assertEqual(result['cases']['agent-payment-idempotent-abandonment'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
