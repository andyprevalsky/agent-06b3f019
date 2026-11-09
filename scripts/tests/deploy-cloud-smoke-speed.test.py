#!/usr/bin/env python3
"""The /deploy cloud smoke lane reuses one infra-canary pass per repository.

deploy_test_cloud.py hands the fleet a repository-scoped canary stamp and lock (the git
common directory), so a fresh deploy worktree does not re-run the 2-machine canary that
another worktree passed within its TTL. The fleet's own fail-closed gate is unchanged.
"""
import os
import shutil
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
    # Keep the real source transport closed over a committed, local-only fixture.
    (main / '.git/info/exclude').write_text('.context/\n')
    for relative in ('scripts/lib/cloudbench-env.sh', 'scripts/create-worktree-patch.sh'):
        target = main / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(cloud.__file__).parent.parent / relative, target)
    subprocess.run(['git', 'add', '.'], cwd=main, check=True, env=env)
    subprocess.run(['git', 'commit', '-q', '-m', 'c'], cwd=main, check=True, env=env)
    subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd=main, check=True, env=env)
    subprocess.run(['git', 'worktree', 'add', '-q', '--detach', str(linked)], cwd=main, check=True)
    return main, linked


class SharedCanaryStamp(unittest.TestCase):
    def setUp(self):
        # Offline: fixture refs count as pushed unless a test exercises the real preflight.
        pushed = patch.object(cloud, 'origin_fetchable', return_value=True)
        pushed.start()
        self.addCleanup(pushed.stop)
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
            _, root = repo_with_worktree(tmp)
            request = {'token': 'a' * 32, 'source': cloud.source(root),
                       'gate': 'smoke', 'checks': ['one'], 'skips': {}}
            request_path, result_path = Path(tmp) / 'request.json', Path(tmp) / 'result.json'
            cloud.write(request_path, request)
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(request_path), DEPLOY_GATE_RESULT=str(result_path)), \
                    patch.object(sys, 'argv', ['deploy_test_cloud.py', '--root', str(root)]), \
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
            request['source'] = cloud.source(linked)
            with mock.patch.dict(os.environ), \
                    mock.patch.object(cloud, 'campaign_width', lambda _checks: 1), \
                    mock.patch.object(cloud, 'run_command', run_command), \
                    mock.patch.object(cloud, 'collect_campaign',
                                      lambda *_a: ({'browser-smoke': 'UNVERIFIED'}, {}, False, None)):
                for key in ('FLEET_INFRA_CANARY_STAMP', 'FLEET_INFRA_CANARY_LOCK',
                            'DEPLOY_GATE_REQUEST', 'DEPLOY_GATE_RESULT'):
                    os.environ.pop(key, None)
                expected = cloud.shared_canary_env(linked, {})
                result = cloud.execute(request, linked)
                binding = result['source_transport']
                self.assertEqual(binding['source'], request['source'])
                self.assertEqual(binding['base_sha'], request['source']['head'])
                self.assertEqual(binding['workspace_patch_sha256'], 'none')
                self.assertEqual(cloud.read(Path(binding['patch']).with_name('source-transport.json')), binding)
        self.assertEqual(len(launches), 1)
        argv, env = launches[0]
        self.assertEqual(argv[:3], ['bash', 'scripts/run-bench', 'browser-smoke'])
        self.assertEqual(env['DEPLOY_CYCLE_FRESH'], '1')
        self.assertEqual({key: env[key] for key in expected}, expected)
        self.assertNotIn(str(linked), env['FLEET_INFRA_CANARY_STAMP'])  # not the worktree's .context

    def test_standalone_fixture_still_refuses_foreign_request_custody(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, root = repo_with_worktree(tmp)
            request = dict(checks=['browser-smoke'], skips={}, token='owned',
                           source=cloud.source(root), gate='smoke')
            foreign = Path(tmp) / 'foreign/attempts/0/initial/smoke/request.json'
            with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(foreign)), \
                    patch.object(cloud, 'run_command') as launch:
                with self.assertRaisesRegex(ValueError, 'missing request-owned custody locator'):
                    cloud.execute(request, root)
                launch.assert_not_called()
                self.assertFalse((root / '.context/deploy-cloud').exists())


if __name__ == '__main__':
    unittest.main()
