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
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_test_cloud as cloud


def repo_with_worktree(tmp):
    main, linked = Path(tmp) / 'main', Path(tmp) / 'linked'
    subprocess.run(['git', 'init', '-q', str(main)], check=True)
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@t'}
    subprocess.run(['git', 'commit', '-q', '--allow-empty', '-m', 'c'], cwd=main, check=True, env=env)
    subprocess.run(['git', 'worktree', 'add', '-q', '--detach', str(linked)], cwd=main, check=True)
    return main, linked


class SharedCanaryStamp(unittest.TestCase):
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
        source = (Path(cloud.__file__)).read_text()
        self.assertIn("'DEPLOY_CYCLE_FRESH': '1', **shared_canary_env(root)}", source)


if __name__ == '__main__':
    unittest.main()
