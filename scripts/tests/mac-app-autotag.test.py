#!/usr/bin/env python3
"""Blackbox the actual auto-tag workflow step against disposable Git remotes."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/auto-tag-mac-app.yml'


class AutoTagBlackbox(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mac-autotag-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.repo = self.path / 'checkout'
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
                    'GIT_AUTHOR_NAME': 'Fixture', 'GIT_COMMITTER_NAME': 'Fixture',
                    'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                    'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        self.git('init', '--bare', str(self.path / 'origin.git'), cwd=self.path)
        self.git('init', str(self.repo), cwd=self.path)
        self.git('remote', 'add', 'origin', str(self.path / 'origin.git'))
        self.git('commit', '--allow-empty', '-m', 'previous release')
        self.old = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('commit', '--allow-empty', '-m', 'shipped merge')
        self.target = self.git('rev-parse', 'HEAD').stdout.strip()
        # Deliberately keep HEAD different from MERGE_SHA: the tag's identity
        # must come from the triggering event even if checkout state drifts.
        self.git('commit', '--allow-empty', '-m', 'later checkout')
        doc = yaml.safe_load(WORKFLOW.read_text())
        self.script = next(s['run'] for s in doc['jobs']['auto-tag']['steps']
                           if s['name'] == 'Create and push tag')

    def git(self, *args, cwd=None, input=None, check=True):
        return subprocess.run(['git', *args], cwd=cwd or self.repo, env=self.env,
                              input=input, text=True, capture_output=True,
                              check=check, timeout=30)

    def tags(self, count, target=None):
        refs = ''.join(f'create refs/tags/v1.1.{i} {target or self.old}\n'
                       for i in range(count))
        self.git('update-ref', '--stdin', input=refs)

    def run_step(self):
        script = self.path / 'step.sh'
        script.write_text(self.script)
        return subprocess.run(['/usr/bin/bash', '-e', str(script)], cwd=self.repo,
                              env={**self.env, 'MERGE_SHA': self.target,
                                   'REASON': 'shipped-surface'},
                              text=True, capture_output=True, timeout=30)

    def remote_refs(self):
        return self.git('ls-remote', '--tags', 'origin').stdout

    def assert_created(self, tag):
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.remote_refs(), f'{self.target}\trefs/tags/{tag}\n')
        self.assertEqual(self.git('rev-parse', tag).stdout.strip(), self.target)
        # The identical workflow rerun must not publish another release.
        again = self.run_step()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn('already tagged', again.stdout)
        self.assertEqual(self.remote_refs(), f'{self.target}\trefs/tags/{tag}\n')

    def test_large_inventory_selects_and_pushes_once(self):
        self.tags(20000)
        self.assert_created('v1.1.20000')

    def test_small_inventory_uses_version_sort_and_event_target(self):
        self.tags(12)
        self.assert_created('v1.1.12')

    def test_existing_target_large_inventory_is_noop(self):
        self.tags(20000, self.target)
        before = self.git('show-ref', '--tags').stdout
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('already tagged', result.stdout)
        self.assertEqual(self.git('show-ref', '--tags').stdout, before)
        self.assertEqual(self.remote_refs(), '')

    def test_existing_nonversion_tag_is_still_noop(self):
        self.git('tag', 'already-shipped', self.target)
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('already tagged', result.stdout)
        self.assertEqual(self.git('tag').stdout, 'already-shipped\n')
        self.assertEqual(self.remote_refs(), '')

    def test_git_query_error_is_not_an_empty_inventory(self):
        self.tags(12)
        self.target = 'not-a-commit'
        result = self.run_step()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.remote_refs(), '')
        self.assertEqual(len(self.git('tag').stdout.splitlines()), 12)

    def test_no_tags_fails_without_publication(self):
        result = self.run_step()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.remote_refs(), '')
        self.assertEqual(self.git('tag').stdout, '')

    def test_malformed_latest_version_fails_without_publication(self):
        self.git('tag', 'v1.2.3.4', self.old)
        result = self.run_step()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.remote_refs(), '')
        self.assertEqual(self.git('tag').stdout, 'v1.2.3.4\n')

    def test_remote_collision_does_not_overwrite_or_publish_another_tag(self):
        self.tags(12)
        # Another writer wins after this checkout's inventory was fetched.
        other = self.path / 'other'
        self.git('clone', str(self.repo), str(other), cwd=self.path)
        self.git('tag', 'v1.1.12', self.old, cwd=other)
        self.git('push', str(self.path / 'origin.git'), 'refs/tags/v1.1.12', cwd=other)
        before = self.remote_refs()
        result = self.run_step()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.remote_refs(), before)
        self.assertEqual(before, f'{self.old}\trefs/tags/v1.1.12\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
