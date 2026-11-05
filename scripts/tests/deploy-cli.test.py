#!/usr/bin/env python3
"""Offline regressions for scripts/deploy_cli.py (the one-line /deploy steps)."""
import argparse
import contextlib
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
import deploy_cli as d


def sh(*args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout


class Repo(unittest.TestCase):
    """A throwaway repository with a bare remote, patched in as the CLI's ROOT."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.remote, self.root = base / 'remote.git', base / 'work'
        sh('git', 'init', '--bare', '-q', str(self.remote), cwd=base)
        sh('git', 'init', '-q', '-b', 'main', str(self.root), cwd=base)
        for key, value in (('user.email', 't@example.com'), ('user.name', 'T'), ('commit.gpgsign', 'false')):
            sh('git', 'config', key, value, cwd=self.root)
        (self.root / '.gitignore').write_text('node_modules/\n.context/\n.env\n')
        (self.root / 'app.py').write_text('x = 1\n')
        sh('git', 'add', '.', cwd=self.root)
        sh('git', 'commit', '-qm', 'init', cwd=self.root)
        sh('git', 'remote', 'add', 'origin', str(self.remote), cwd=self.root)
        sh('git', 'push', '-q', 'origin', 'main', cwd=self.root)
        context = self.root / '.context'
        self.patches = [patch.object(d, name, value) for name, value in (
            ('ROOT', self.root), ('CONTEXT', context), ('PR_FILE', context / 'deploy-pr.json'),
            ('MERGED_FILE', context / 'deploy-merged.json'), ('COLLECT_FILE', context / 'deploy-collect.json'),
            ('READINESS_FILE', context / 'deletion-readiness.json'))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    def call(self, function, **kwargs):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = function(argparse.Namespace(**kwargs))
        return code, out.getvalue(), err.getvalue()


class SecretGuard(unittest.TestCase):
    def test_secret_looking_paths(self):
        for path in ('.env', 'back-end/.env', 'agents/.env.benchmark-temporal', 'certs/server.pem',
                     'x/id_rsa', 'credentials-prod.json', 'deploy.key'):
            self.assertTrue(d.SECRET_NAMES.search(path), path)
        for path in ('.env.example', 'back-end/.env.example', 'envs.py', 'docs/keys.md', 'scripts/deploy'):
            self.assertFalse(d.SECRET_NAMES.search(path), path)


class Disposition(unittest.TestCase):
    def test_manifest_then_reproducible_then_unknown(self):
        manifest = {'.context/': 'archived', 'logs/*.log': {'disposition': 'committed'}}
        self.assertEqual(d.disposition('.context/', manifest), 'archived')
        self.assertEqual(d.disposition('logs/run.log', manifest), 'committed')
        self.assertEqual(d.disposition('front-end/node_modules/', {}), 'reproducible')
        self.assertEqual(d.disposition('agents/venv/', {}), 'reproducible')
        self.assertIsNone(d.disposition('back-end/.env', {}))
        self.assertIsNone(d.disposition('agents/navi-worker-log.txt', {}))


class Collect(Repo):
    def test_reports_dirty_sibling_worktree_and_unpushed_branch(self):
        sibling = Path(self.tmp.name) / 'sibling'
        sh('git', 'worktree', 'add', '-q', '-b', 'feature', str(sibling), cwd=self.root)
        (sibling / 'new.py').write_text('y = 2\n')
        sh('git', 'add', 'new.py', cwd=sibling)
        sh('git', 'commit', '-qm', 'feature work', cwd=sibling)
        (sibling / 'draft.py').write_text('z = 3\n')
        code, out, _ = self.call(d.cmd_collect)
        self.assertEqual(code, 0)
        report = json.loads(d.COLLECT_FILE.read_text())
        trees = {Path(t['path']).name: t for t in report['worktrees']}
        self.assertFalse(trees['work']['needs_integration'])
        self.assertTrue(trees['sibling']['needs_integration'])
        self.assertEqual(trees['sibling']['uncommitted'], ['draft.py'])
        self.assertEqual(trees['sibling']['unpushed_commits'], 1)
        self.assertEqual(report['unpushed_branches'], [{'branch': 'feature', 'unpushed_commits': 1}])
        self.assertIn('DEPLOY_COLLECT worktrees=2 integrate=1', out)

    def test_ledger_rows_are_not_uncommitted_work(self):
        ledger = self.root / 'agents/benchmarks/history'
        ledger.mkdir(parents=True)
        (ledger / 'task_attempts.jsonl').write_text('{}\n')
        self.assertEqual(d.uncommitted(), [])


class Freeze(Repo):
    def test_refuses_secret_files_before_committing(self):
        (self.root / '.gitignore').write_text('node_modules/\n')
        (self.root / '.env').write_text('TOKEN=never-printed\n')
        with patch.object(d, 'cmd_fix', return_value=0):
            code, out, err = self.call(d.cmd_freeze, base='origin/main', message='ship')
        self.assertEqual(code, 1)
        self.assertIn('refusing to commit secret-looking files: .env', err)
        self.assertNotIn('never-printed', out + err)
        self.assertEqual(sh('git', 'log', '--oneline', cwd=self.root).count('\n'), 1)

    def test_needs_a_message_for_uncommitted_changes(self):
        (self.root / 'app.py').write_text('x = 2\n')
        with patch.object(d, 'cmd_fix', return_value=0):
            code, _, err = self.call(d.cmd_freeze, base='origin/main', message=None)
        self.assertEqual(code, 1)
        self.assertIn('need --message', err)

    def test_commits_then_freezes_the_approval_batch(self):
        (self.root / 'app.py').write_text('x = 2\n')
        calls = []
        with patch.object(d, 'cmd_fix', return_value=0), \
             patch.object(d, 'run', side_effect=lambda argv, **_: calls.append(argv) or 0):
            code, out, _ = self.call(d.cmd_freeze, base='origin/main', message='ship it')
        self.assertEqual(code, 0)
        self.assertEqual(sh('git', 'log', '-1', '--format=%s', cwd=self.root).strip(), 'ship it')
        self.assertEqual(calls[-1][1:4], ['scripts/deploy_approval_batch.py', 'freeze', '--head'])
        self.assertEqual(calls[-1][4], d.head())
        self.assertIn('committed=1', out)

    def test_stops_when_fix_fails(self):
        with patch.object(d, 'cmd_fix', return_value=1), patch.object(d, 'run') as runner:
            code, _, err = self.call(d.cmd_freeze, base='origin/main', message='x')
        self.assertEqual(code, 1)
        self.assertIn('format/lint errors', err)
        runner.assert_not_called()


class OpenPrAndMerge(Repo):
    def test_open_pr_refuses_main_and_dirty_source(self):
        code, _, err = self.call(d.cmd_open_pr, title='t', body_file=None)
        self.assertEqual(code, 1)
        self.assertIn('feature branch', err)
        sh('git', 'checkout', '-qb', 'feature', cwd=self.root)
        (self.root / 'app.py').write_text('x = 3\n')
        with patch.object(d, 'run') as runner:
            code, _, err = self.call(d.cmd_open_pr, title='t', body_file=None)
        self.assertEqual(code, 1)
        self.assertIn('run `scripts/deploy freeze` first', err)
        runner.assert_not_called()

    def test_merge_requires_an_opened_pr_and_clean_reviewed_source(self):
        with self.assertRaises(SystemExit) as raised:
            self.call(d.cmd_merge)
        self.assertIn('scripts/deploy open-pr', str(raised.exception))
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'feature', 'head': d.head()})
        (self.root / 'app.py').write_text('x = 4\n')
        with patch.object(d, 'run') as runner:
            code, _, err = self.call(d.cmd_merge)
        self.assertEqual(code, 1)
        self.assertIn('uncommitted changes after review', err)
        runner.assert_not_called()

    def test_merge_stops_at_the_first_failed_proof(self):
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'main', 'head': d.head()})
        sh('git', 'branch', '-q', '--set-upstream-to=origin/main', cwd=self.root)
        calls = []
        def fake(argv, **_):
            calls.append(argv)
            return 5 if 'require-mergeable' in argv else 0
        with patch.object(d, 'run', side_effect=fake), patch.object(d, 'factory') as event:
            code, _, err = self.call(d.cmd_merge)
        self.assertEqual(code, 1)
        self.assertIn('deploy_review_cycle.py exited 5', err)
        self.assertEqual(len(calls), 2)
        event.assert_not_called()


    def test_merge_conflict_forces_sync_instead_of_a_local_main_merge(self):
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'main', 'head': d.head()})
        sh('git', 'branch', '-q', '--set-upstream-to=origin/main', cwd=self.root)
        with patch.object(d, 'run', return_value=0) as runner, patch.object(d, 'factory') as event, \
             patch.object(d, 'mergeable', return_value='CONFLICTING'):
            code, _, err = self.call(d.cmd_merge)
        self.assertEqual(code, 1)
        self.assertIn('run /sync, rerun the affected gates', err)
        self.assertFalse(any('merge' in argv and 'pr' in argv for argv in [c.args[0] for c in runner.call_args_list]))
        event.assert_not_called()


class DeletionCheck(Repo):
    def test_ready_only_when_every_ignored_path_has_a_disposition(self):
        (self.root / 'node_modules').mkdir()
        (self.root / 'node_modules/x.js').write_text('')
        (self.root / '.context').mkdir(exist_ok=True)
        (self.root / '.context/run.log').write_text('evidence')
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=None)
        self.assertEqual(code, 1)
        self.assertIn('ignored path without a disposition: .context/', out)
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps({'.context/': 'archived'}))
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=manifest)
        self.assertEqual(code, 0, out)
        receipt = json.loads(d.READINESS_FILE.read_text())
        self.assertTrue(receipt['ready'])
        self.assertEqual(receipt['ignored']['node_modules/'], 'reproducible')

    def test_unpushed_commits_and_live_processes_block(self):
        (self.root / 'app.py').write_text('x = 5\n')
        sh('git', 'commit', '-qam', 'local only', cwd=self.root)
        with patch.object(d, 'live_processes', return_value=[{'pid': 42, 'argv': 'worker.py'}]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=None)
        self.assertEqual(code, 1)
        self.assertIn('1 unpushed commit(s)', out)
        self.assertIn('branch main has 1 commit(s) on no remote', out)
        self.assertIn('live process 42 in this checkout: worker.py', out)

    @unittest.skipUnless(Path('/proc/self/cwd').exists(), 'needs Linux /proc')
    def test_live_processes_finds_a_child_in_the_checkout_but_not_itself(self):
        child = subprocess.Popen(['sleep', '30'], cwd=self.root)
        try:
            found = d.live_processes(self.root.resolve())
        finally:
            child.terminate()
            child.wait()
        self.assertIn(child.pid, [p['pid'] for p in found])
        self.assertNotIn(os.getpid(), [p['pid'] for p in found])


class Dispatch(unittest.TestCase):
    def test_gates_and_production_delegate_their_arguments(self):
        with patch.object(d, 'delegate', return_value=3) as delegate:
            self.assertEqual(d.main(['gates', '--dry-run']), 3)
            delegate.assert_called_with('deploy_gates', ['--dry-run'])
            self.assertEqual(d.main(['production', '--sha', 'abc']), 3)
            delegate.assert_called_with('deploy_prod', ['--sha', 'abc'])

    def test_every_documented_subcommand_exists(self):
        doc = (Path(__file__).resolve().parents[2] / '.claude/commands/deploy-v2.md').read_text()
        names = set(d.COMMANDS) | {'gates', 'production'}
        for name in names:
            self.assertTrue(f'scripts/deploy {name}' in doc, f'deploy-v2.md does not document {name}')


if __name__ == '__main__':
    unittest.main()
