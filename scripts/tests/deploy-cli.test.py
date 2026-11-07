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
            ('READINESS_FILE', context / 'deletion-readiness.json'), ('PARK_DIR', context / 'deploy-ledger-park'))]
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
        self.assertEqual(d.disposition('agents/venv', {}), 'reproducible')  # a symlinked venv has no trailing slash
        self.assertEqual(d.disposition('agents/venv', {}, '/var/tmp/wt'), 'reproducible')
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
             patch.object(d, 'approvals_clear', return_value=0), patch.object(d, 'mergeable', return_value='CONFLICTING'):
            code, _, err = self.call(d.cmd_merge)
        self.assertEqual(code, 1)
        self.assertIn('run `scripts/deploy sync`, rerun the affected gates', err)
        self.assertFalse(any('merge' in argv and 'pr' in argv for argv in [c.args[0] for c in runner.call_args_list]))
        event.assert_not_called()


class Sync(Repo):
    def feature(self):
        sh('git', 'checkout', '-qb', 'feature', cwd=self.root)

    def push_to_main(self, name, text):
        """Another contributor lands a commit on origin/main."""
        other = Path(self.tmp.name) / 'other'
        if not other.exists():
            sh('git', 'clone', '-q', '-b', 'main', str(self.remote), str(other), cwd=self.tmp.name)
            for key, value in (('user.email', 'o@example.com'), ('user.name', 'O'), ('commit.gpgsign', 'false')):
                sh('git', 'config', key, value, cwd=other)
        (other / name).write_text(text)
        sh('git', 'add', name, cwd=other)
        sh('git', 'commit', '-qm', f'main: {name}', cwd=other)
        sh('git', 'push', '-q', 'origin', 'main', cwd=other)

    def test_up_to_date_changes_nothing(self):
        self.feature()
        before = d.head()
        code, out, _ = self.call(d.cmd_sync)
        self.assertEqual(code, 0)
        self.assertIn('DEPLOY_SYNC up-to-date', out)
        self.assertEqual(before, d.head())

    def test_a_clean_merge_commits_main_and_fast_forwards_local_main(self):
        self.feature()
        self.push_to_main('other.py', 'y = 2\n')
        code, out, _ = self.call(d.cmd_sync)
        self.assertEqual(code, 0, out)
        self.assertIn('DEPLOY_SYNC merged=1 commit(s) from main', out)
        self.assertEqual(2, len(sh('git', 'rev-list', '--parents', '-n1', 'HEAD', cwd=self.root).split()) - 1)
        self.assertTrue((self.root / 'other.py').is_file())
        self.assertEqual(sh('git', 'rev-parse', 'main', cwd=self.root), sh('git', 'rev-parse', 'origin/main', cwd=self.root))

    def test_a_conflict_lists_the_files_and_leaves_the_merge_open(self):
        self.feature()
        (self.root / 'app.py').write_text('x = "branch"\n')
        sh('git', 'commit', '-qam', 'branch edit', cwd=self.root)
        self.push_to_main('app.py', 'x = "main"\n')
        code, _, err = self.call(d.cmd_sync)
        self.assertEqual(code, 1)
        self.assertIn('DEPLOY_SYNC CONFLICTS (1): app.py', err)
        self.assertIn('rerun `scripts/deploy sync`', err)
        self.assertTrue((self.root / '.git' / 'MERGE_HEAD').is_file())

    def test_local_main_is_left_alone_while_a_worktree_has_it_checked_out(self):
        self.feature()
        sibling = Path(self.tmp.name) / 'main-checkout'
        sh('git', 'worktree', 'add', '-q', str(sibling), 'main', cwd=self.root)
        old_main = sh('git', 'rev-parse', 'main', cwd=self.root)
        self.push_to_main('other.py', 'y = 2\n')
        code, out, _ = self.call(d.cmd_sync)
        self.assertEqual(code, 0, out)
        self.assertEqual(old_main, sh('git', 'rev-parse', 'main', cwd=self.root))

    def test_refuses_main_and_detached_heads(self):
        code, _, err = self.call(d.cmd_sync)
        self.assertEqual(code, 1)
        self.assertIn('feature branch', err)
        sh('git', 'checkout', '-q', '--detach', cwd=self.root)
        code, _, err = self.call(d.cmd_sync)
        self.assertEqual(code, 1)
        self.assertIn('feature branch', err)

    def test_uncommitted_changes_that_git_refuses_to_overwrite_block_without_a_half_merge(self):
        self.feature()
        (self.root / 'app.py').write_text('x = "dirty"\n')
        self.push_to_main('app.py', 'x = "main"\n')
        code, _, err = self.call(d.cmd_sync)
        self.assertEqual(code, 1)
        self.assertIn('git refused the merge', err)
        self.assertFalse((self.root / '.git' / 'MERGE_HEAD').exists())
        self.assertEqual('x = "dirty"\n', (self.root / 'app.py').read_text())


class ReviewWait(Repo):
    def wait(self, wait_code, check):
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'feature', 'head': 'a' * 40})
        with patch.object(d, 'review_state', return_value={'cycles': [{'head': 'b' * 40}]}), \
             patch.object(d, 'run', return_value=wait_code) as runner, patch.object(d, 'coderabbit_check', return_value=check):
            return (*self.call(d.cmd_review_wait, timeout=600), runner)

    def test_a_delivered_review_passes(self):
        code, out, _, runner = self.wait(0, ('success', 'Review completed'))
        self.assertEqual(code, 0)
        self.assertIn('DEPLOY_REVIEW_WAIT delivered head=bbbbbbbbbbbb', out)
        self.assertEqual(runner.call_args[0][0][:2], ['bash', 'scripts/wait-for-code-review'])

    def test_a_neutral_rate_limited_check_is_not_a_review(self):
        code, _, err, _ = self.wait(0, ('neutral', 'Review rate limited'))
        self.assertEqual(code, 3)
        self.assertIn('NOT-A-REVIEW: CodeRabbit check is "neutral" (Review rate limited)', err)
        self.assertIn('deploy_review_cycle.py skip', err)

    def test_a_missing_check_is_not_a_review(self):
        code, _, err, _ = self.wait(0, ('', ''))
        self.assertEqual(code, 3)
        self.assertIn('is "missing"', err)

    def test_a_gh_failure_is_reported_not_read_as_a_missing_check(self):
        limited = subprocess.CompletedProcess([], 1, stdout='', stderr="gh: GitHub's API rate limit was reached; try again in 15 minutes.\n")
        with patch.object(d.subprocess, 'run', return_value=limited):
            conclusion, why = d.coderabbit_check('c' * 40)
        self.assertEqual('error', conclusion)
        self.assertIn('rate limit was reached', why)
        code, _, err, _ = self.wait(0, (conclusion, why))
        self.assertEqual(code, 3)
        self.assertIn('is "error" (gh failed: gh: GitHub', err)

    def test_the_check_run_listing_is_parsed(self):
        ok = subprocess.CompletedProcess([], 0, stdout='neutral\tReview rate limited\n', stderr='')
        with patch.object(d.subprocess, 'run', return_value=ok):
            self.assertEqual(('neutral', 'Review rate limited'), d.coderabbit_check('c' * 40))
        none = subprocess.CompletedProcess([], 0, stdout='\t\n', stderr='')
        with patch.object(d.subprocess, 'run', return_value=none):
            self.assertEqual(('', ''), d.coderabbit_check('c' * 40))

    def test_a_failed_wait_propagates_without_reading_the_check(self):
        with patch.object(d, 'coderabbit_check') as check:
            d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'feature', 'head': 'a' * 40})
            with patch.object(d, 'review_state', return_value={'cycles': [{'head': 'b' * 40}]}), \
                 patch.object(d, 'run', return_value=124):
                code, _, _ = self.call(d.cmd_review_wait, timeout=600)
        self.assertEqual(code, 124)
        check.assert_not_called()


class ReviewApprovalLedger(Repo):
    def opened(self):
        sh('git', 'checkout', '-qb', 'feature', cwd=self.root)
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'feature', 'head': d.head()})

    def test_open_pr_never_resets_an_open_deploys_review_ledger(self):
        self.opened()
        with patch.object(d, 'run') as runner:
            code, _, err = self.call(d.cmd_open_pr, title='t', body_file=None, restart=False)
        self.assertEqual(code, 1)
        self.assertIn('use `scripts/deploy review-next`', err)
        runner.assert_not_called()

    def test_review_next_requires_a_committed_batch_and_reviewed_ledger_rows(self):
        self.opened()
        (self.root / 'app.py').write_text('x = 9\n')
        code, _, err = self.call(d.cmd_review_next, verification_approval=None)
        self.assertEqual(code, 1)
        self.assertIn('commit the stabilization batch first', err)
        sh('git', 'checkout', '--', 'app.py', cwd=self.root)
        d.PARK_DIR.mkdir(parents=True)
        (d.PARK_DIR / 'task_attempts.jsonl').write_text('{}\n')
        code, _, err = self.call(d.cmd_review_next, verification_approval=None)
        self.assertEqual(code, 1)
        self.assertIn('run `scripts/deploy ledger`', err)

    def test_review_next_opens_the_cycle_the_ledger_allows_then_pushes_and_requests(self):
        self.opened()
        calls = []
        nxt = subprocess.CompletedProcess([], 0, stdout='{"kind": "verification"}', stderr='')
        real = subprocess.run
        only_next = lambda argv, **kw: nxt if 'next' in argv else real(argv, **kw)
        with patch.object(d.subprocess, 'run', side_effect=only_next), patch.object(d, 'factory') as event, \
             patch.object(d, 'run', side_effect=lambda argv, **_: calls.append(argv) or 0):
            code, out, _ = self.call(d.cmd_review_next, verification_approval='appr-1')
        self.assertEqual(code, 0, out)
        self.assertEqual(calls[0][1:], ['scripts/deploy_review_cycle.py', 'start', '--kind', 'verification',
                                        '--head', d.head(), '--verification-approval', 'appr-1'])
        self.assertEqual(calls[1], ['git', 'push', 'origin', 'HEAD'])
        self.assertEqual(calls[2], ['gh', 'pr', 'comment', '7', '--body', '@coderabbitai review'])
        event.assert_called_once_with('stage-start', 'code-review')

    def test_review_next_refusal_points_to_deferral_not_a_stop(self):
        self.opened()
        refused = subprocess.CompletedProcess([], 1, stdout='', stderr='fourth cycle refused\n')
        real = subprocess.run
        only_next = lambda argv, **kw: refused if 'next' in argv else real(argv, **kw)
        with patch.object(d.subprocess, 'run', side_effect=only_next), patch.object(d, 'run') as runner:
            code, _, err = self.call(d.cmd_review_next, verification_approval=None)
        self.assertEqual(code, 1)
        self.assertIn('defer the remaining non-security findings', err)
        runner.assert_not_called()

    def test_approval_decisions_record_events_and_rerun_flagged_guards(self):
        check = subprocess.CompletedProcess([], 0, stdout='{"status": "covered", "guards_to_flag": ["prompt-approval"]}',
                                            stderr='')
        calls = []
        with patch.object(d.subprocess, 'run', return_value=check), patch.object(d, 'factory') as event, \
             patch.object(d, 'run', side_effect=lambda argv, **_: calls.append(argv) or 0):
            code, out, _ = self.call(d.cmd_approval, action='decide', decision='approved', evidence='user: ok')
        self.assertEqual(code, 0, out)
        event.assert_called_once_with('approval-decision', 'approved')
        self.assertEqual(calls[0][1:], ['scripts/deploy_approval_batch.py', 'decide', '--decision', 'approved',
                                        '--evidence', 'user: ok'])
        self.assertEqual(calls[1], ['bash', 'scripts/run-deploy-stage', 'prompt-approval', '--', 'bash',
                                    'scripts/check-prompt-human-approval.sh', 'mandatory-human-approval-retrieved=true'])
        with patch.object(d, 'factory') as event, patch.object(d, 'run', return_value=0):
            code, _, _ = self.call(d.cmd_approval, action='decide', decision='rejected', evidence='user: no')
        self.assertEqual(code, 1)
        with patch.object(d, 'factory') as event, patch.object(d, 'run', return_value=0), \
             patch.object(d, 'approvals_clear', return_value=0):
            self.call(d.cmd_approval, action='decide', decision='grounded', evidence='reviewer r1')
        event.assert_not_called()

    def test_ledger_commits_only_the_benchmark_history_rows(self):
        ledger = self.root / 'agents/benchmarks/history'
        ledger.mkdir(parents=True)
        (ledger / 'task_attempts.jsonl').write_text('{"task": "x"}\n')
        (self.root / 'app.py').write_text('x = 7\n')
        with patch.object(d, 'run', return_value=0):
            code, out, _ = self.call(d.cmd_ledger)
        self.assertEqual(code, 0)
        self.assertIn('committed=1', out)
        self.assertEqual(sh('git', 'show', '--name-only', '--format=', 'HEAD', cwd=self.root).split(),
                         ['agents/benchmarks/history/task_attempts.jsonl'])
        self.assertIn('app.py', sh('git', 'status', '--porcelain', cwd=self.root))

    def test_merge_refuses_unreviewed_parked_ledger_rows(self):
        d.write_json(d.PR_FILE, {'pr': 7, 'branch': 'main', 'head': d.head()})
        sh('git', 'branch', '-q', '--set-upstream-to=origin/main', cwd=self.root)
        d.PARK_DIR.mkdir(parents=True)
        (d.PARK_DIR / 'span_durations.jsonl').write_text('{}\n')
        (d.PARK_DIR / 'task_attempts.jsonl.applied-20261106').write_text('{}\n')
        with patch.object(d, 'run', return_value=0) as runner:
            code, _, err = self.call(d.cmd_merge)
        self.assertEqual(code, 1)
        self.assertIn('parked benchmark-history rows are not in the reviewed batch', err)
        runner.assert_not_called()


class HarnessProcesses(unittest.TestCase):
    def test_only_the_devbox_daemon_helpers_are_harness(self):
        home = str(Path.home())
        daemon_script = f'/opt/devbox-runtime/node/current/bin/node {home}/.devbox/daemon/bundle/wrappers/boxes-github-credential.mjs'
        for exe, argv in ((f'{home}/.devbox/daemon/bundle/bin/pidfd-janitor', ''), ('/opt/devbox-tools/bin/gh', ''),
                          ('/opt/devbox-runtime/node/current/bin/node', daemon_script)):
            self.assertTrue(d.is_harness_process(exe, argv), exe)
        for exe, argv in ((None, ''), ('', ''), ('/usr/bin/bash', ''), (f'{home}/rose/agents/venv/bin/python3', ''),
                          ('/opt/devbox-runtime-evil/node', ''), (f'{home}/.devbox/daemon-lookalike/bin/x', ''), ('/usr/bin/node', ''),
                          # other threads' agent sessions and project scripts on the shared runtime are live work
                          ('/opt/devbox-tools/claude/current/bin/claude', '--settings x'),
                          ('/opt/devbox-tools/codex/versions/0.166.0/bin/codex', ''),
                          ('/opt/devbox-runtime/node/current/bin/node', 'node /home/boxes/rose/back-end/src/server.js')):
            self.assertFalse(d.is_harness_process(exe, argv), (exe, argv))


class DeletionCheck(Repo):
    def test_ready_only_when_every_ignored_path_has_a_disposition(self):
        (self.root / 'node_modules').mkdir()
        (self.root / 'node_modules/x.js').write_text('')
        (self.root / '.context').mkdir(exist_ok=True)
        (self.root / '.context/run.log').write_text('evidence')
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=None, receipt=None)
        self.assertEqual(code, 1)
        self.assertIn('ignored path without a disposition: .context/', out)
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps({'.context/': 'archived'}))
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=manifest, receipt=None)
        self.assertEqual(code, 0, out)
        receipt = json.loads(d.READINESS_FILE.read_text())
        self.assertTrue(receipt['ready'])
        self.assertEqual(receipt['ignored']['node_modules/'], 'reproducible')

    def test_unpushed_commits_and_live_processes_block(self):
        (self.root / 'app.py').write_text('x = 5\n')
        sh('git', 'commit', '-qam', 'local only', cwd=self.root)
        with patch.object(d, 'live_processes', return_value=[{'pid': 42, 'argv': 'worker.py'}]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=None, receipt=None)
        self.assertEqual(code, 1)
        self.assertIn('1 unpushed commit(s)', out)
        self.assertIn('branch main has 1 commit(s) on no remote', out)
        self.assertIn('live process 42 in this checkout: worker.py', out)

    def entry(self, tip, **override):
        return {'disposition': 'archived', 'tip': tip, 'archive': 'devbox-closeout-private/pr-7/git.tar.gz.aesgcm',
                'sha256': 'a' * 64, **override}

    def check(self, manifest):
        path = Path(self.tmp.name) / 'manifest.json'
        path.write_text(json.dumps({'.context/': 'regenerated', **manifest}))
        with patch.object(d, 'live_processes', return_value=[]):
            return self.call(d.cmd_deletion_check, manifest=path, receipt=None)

    def test_local_only_branches_and_stashes_need_an_archived_disposition_bound_to_their_tip(self):
        sh('git', 'checkout', '-q', '-b', 'wip/local', cwd=self.root)
        (self.root / 'app.py').write_text('x = 9\n')
        sh('git', 'commit', '-qam', 'local only', cwd=self.root)
        tip = sh('git', 'rev-parse', 'HEAD', cwd=self.root).strip()
        sh('git', 'checkout', '-q', 'main', cwd=self.root)
        (self.root / 'app.py').write_text('x = 3\n')
        sh('git', 'stash', cwd=self.root)
        stash = sh('git', 'stash', 'list', '--format=%H', cwd=self.root).strip()
        code, out, _ = self.check({})
        self.assertEqual(code, 1)
        self.assertIn('branch wip/local has 1 commit(s) on no remote', out)
        self.assertIn(f'git stash entry {stash[:12]} is not preserved', out)
        refs = {'branch:wip/local': self.entry(tip), f'stash:{stash}': self.entry(stash)}
        code, out, _ = self.check(refs)
        self.assertEqual(code, 0, out)
        receipt = json.loads(d.READINESS_FILE.read_text())
        self.assertEqual(receipt['preserved_refs'], dict(sorted(refs.items())))
        # An assertion is not a binding: a bare string, a stale tip, a missing archive key or a bad hash all stay open.
        for bad in ('archived', self.entry('b' * 40), self.entry(tip, archive=''), self.entry(tip, sha256='xyz'),
                    self.entry(tip, disposition='asserted')):
            code, out, _ = self.check({**refs, 'branch:wip/local': bad})
            self.assertEqual(code, 1, bad)
            self.assertIn('branch wip/local has 1 commit(s) on no remote', out)
        code, out, _ = self.check({**refs, 'branch:wip/local': self.entry('b' * 40)})
        self.assertIn(f'(archived at {"b" * 12}, now {tip[:12]})', out)
        # Git-object keys are never mistaken for ignored-path globs.
        self.assertIsNone(d.disposition('branch:wip/local', {'branch:*': 'archived'}))

    def test_ignored_files_in_a_sibling_worktree_need_a_disposition_too(self):
        sibling = Path(self.tmp.name) / 'sibling'
        sh('git', 'worktree', 'add', '-q', '-b', 'sibling-work', str(sibling), cwd=self.root)
        (sibling / '.context').mkdir()
        (sibling / '.context/evidence.log').write_text('only here')
        (sibling / 'node_modules').mkdir()
        (sibling / 'node_modules/x.js').write_text('')
        code, out, _ = self.check({})
        self.assertEqual(code, 1)
        self.assertIn(f'ignored path without a disposition: {sibling}/.context/', out)
        self.assertNotIn('node_modules', out)
        code, out, _ = self.check({f'{sibling}/.context/': self.entry('c' * 40, disposition='archived')})
        self.assertEqual(code, 0, out)
        receipt = json.loads(d.READINESS_FILE.read_text())
        self.assertEqual(receipt['ignored'][f'{sibling}/.context/'], 'archived')
        self.assertEqual(receipt['ignored'][f'{sibling}/node_modules/'], 'reproducible')
        self.assertEqual(receipt['ignored']['.context/'], 'regenerated')

    def test_a_worktree_head_with_unpushed_commits_is_covered_by_its_branch_disposition(self):
        (self.root / 'app.py').write_text('x = 5\n')
        sh('git', 'commit', '-qam', 'local only', cwd=self.root)
        tip = sh('git', 'rev-parse', 'HEAD', cwd=self.root).strip()
        code, out, _ = self.check({})
        self.assertIn('1 unpushed commit(s) in', out)
        code, out, _ = self.check({'branch:main': self.entry(tip)})
        self.assertEqual(code, 0, out)
        sh('git', 'checkout', '-q', '--detach', cwd=self.root)
        code, out, _ = self.check({'branch:main': self.entry(tip)})
        self.assertEqual(code, 1)
        self.assertIn('1 unpushed commit(s) in', out)
        code, out, _ = self.check({'branch:main': self.entry(tip), f'commit:{tip}': self.entry(tip)})
        self.assertEqual(code, 0, out)

    def test_after_merge_the_receipt_is_a_committed_record_that_reruns_byte_identically(self):
        d.write_json(d.MERGED_FILE, {'pr': 7, 'merged_sha': 'a' * 40})
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps({'.context/': 'archived'}))
        record = self.root / 'docs/handoffs/pr-7-closeout/deletion-readiness.json'
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=manifest, receipt=None)
        self.assertEqual(code, 1)
        self.assertIn('records-only follow-up PR', out)
        first = record.read_text()
        self.assertEqual('a' * 40, json.loads(first)['deployed_sha'])
        self.assertNotIn('"head"', first)
        sh('git', 'add', str(record), cwd=self.root)
        sh('git', 'commit', '-qm', 'records', cwd=self.root)
        sh('git', 'push', '-q', 'origin', 'main', cwd=self.root)
        with patch.object(d, 'live_processes', return_value=[]):
            code, out, _ = self.call(d.cmd_deletion_check, manifest=manifest, receipt=None)
        self.assertEqual(code, 0, out)
        self.assertEqual(first, record.read_text())
        self.assertEqual('', sh('git', 'status', '--porcelain', '--', str(record), cwd=self.root))

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
        doc = (Path(__file__).resolve().parents[2] / '.claude/commands/deploy.md').read_text()
        names = set(d.COMMANDS) | {'gates', 'production'}
        for name in names:
            self.assertTrue(f'scripts/deploy {name}' in doc, f'deploy.md does not document {name}')


if __name__ == '__main__':
    unittest.main()
