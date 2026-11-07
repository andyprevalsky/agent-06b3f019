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


if __name__ == '__main__':
    unittest.main()
