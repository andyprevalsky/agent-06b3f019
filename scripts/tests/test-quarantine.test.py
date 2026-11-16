#!/usr/bin/env python3
"""@quarantine (scripts/lib/test_quarantine.py): a quarantined test runs and never blocks.

1. Metadata is validated where the marker is applied: a module with a marker that lacks a
   valid date, boxes.dev repair thread, one-line error or evidence fails to import.
2. Real unittest and pytest runs (sync and async, in child processes): a failing quarantined
   test exits 0, reports QUARANTINED_FAIL with the marker metadata and the traceback, prints
   the TEST_QUARANTINE line; a passing one reports QUARANTINED_PASS. Unit ids are the
   runner's own (TestCase.id(), pytest node id), with an optional runner prefix.
3. Skips, interrupts and cancellation are not failures: they pass through and report nothing.
4. forward() copies only a child's valid QUARANTINED_* rows into the gate's progress file.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / 'scripts' / 'lib'
sys.path.insert(0, str(LIB))
import test_quarantine as tq

progress = tq.progress
PYTHON = os.path.abspath(sys.executable)
META = dict(since='2026-11-08', repair='https://boxes.dev/thread/thr_0123abcd',
            error='AssertionError: expected 3, got 2', evidence='.context/test-runs/x/benchmark.log')
GATE_ENVS = (progress.ENV, progress.CASE_ENV, tq.QUARANTINE_PROGRESS_ENV, tq.UNIT_PREFIX_ENV,
             'PYTEST_CURRENT_TEST', 'PYTEST_ADDOPTS')


def clean_env(**extra: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in GATE_ENVS}
    env.update(extra)
    return env


def marker_source(**overrides: str) -> str:
    meta = {**META, **overrides}
    return ', '.join(f'{key}={value!r}' for key, value in meta.items())


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.saved = {key: os.environ.pop(key) for key in GATE_ENVS if key in os.environ}

    def tearDown(self):
        for key in GATE_ENVS:
            os.environ.pop(key, None)
        os.environ.update(self.saved)
        self.tmp.cleanup()

    def rows(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_child(self, args: list[str], **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=self.dir, env=clean_env(**env), text=True, capture_output=True,
                              timeout=120)


class MetadataTest(Fixture):
    def test_valid_metadata_is_kept_verbatim(self):
        @tq.quarantine(**META)
        def case():
            return 7
        self.assertEqual(case.__quarantine__, META)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(case(), 7)
        self.assertEqual(out.getvalue(), 'TEST_QUARANTINE status=QUARANTINED_PASS unit=MetadataTest.'
                         'test_valid_metadata_is_kept_verbatim.<locals>.case since=2026-11-08 '
                         'repair=https://boxes.dev/thread/thr_0123abcd\n')

    def test_invalid_metadata_is_refused(self):
        bad = [
            {'since': '2026-11-8'}, {'since': '2026-02-30'}, {'since': ''},
            {'repair': 'https://example.com/thread/thr_1'}, {'repair': 'https://boxes.dev/thread/'},
            {'repair': 'TODO'}, {'error': ''}, {'error': 'line one\nline two'}, {'evidence': '   '},
            {'repair': 'pending-handoff:'}, {'repair': 'pending-handoff:' + 'G' * 32},
            {'repair': 'pending-handoff:' + 'a' * 31},
        ]
        for override in bad:
            with self.subTest(override=override), self.assertRaises(tq.QuarantineMetadataError):
                tq.quarantine(**{**META, **override})
        # Before merge, a marker names its FLAKY occurrence; the repair is dispatched after merge.
        self.assertEqual('pending-handoff:' + 'a' * 32,
                         tq.validate(**{**META, 'repair': 'pending-handoff:' + 'a' * 32})['repair'])
        missing = dict(META)
        del missing['repair']
        with self.assertRaises(TypeError):
            tq.quarantine(**missing)
        with self.assertRaises(tq.QuarantineMetadataError):
            tq.quarantine(**META)(type('NotATest', (), {}))

    def test_a_module_with_an_invalid_marker_fails_at_import(self):
        module = self.dir / 'bad_marker_test.py'
        module.write_text(textwrap.dedent(f'''
            import sys
            sys.path.insert(0, {str(LIB)!r})
            from test_quarantine import quarantine

            @quarantine({marker_source(repair='')})
            def test_never_collected():
                pass
        '''))
        result = self.run_child([PYTHON, str(module)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('QuarantineMetadataError', result.stderr)
        self.assertIn('repair must be the boxes.dev thread URL', result.stderr)


class UnittestRunTest(Fixture):
    def write_suite(self) -> Path:
        module = self.dir / 'quarantined_unittest.py'
        module.write_text(textwrap.dedent(f'''
            import asyncio, sys, unittest
            sys.path.insert(0, {str(LIB)!r})
            from test_quarantine import quarantine

            class Sync(unittest.TestCase):
                @quarantine({marker_source()})
                def test_fails(self):
                    self.assertEqual(2, 3)

                @quarantine({marker_source()})
                def test_passes(self):
                    self.assertTrue(True)

                @quarantine({marker_source()})
                def test_skips(self):
                    raise unittest.SkipTest('not here')

                @quarantine({marker_source()})
                def test_subtest_fails(self):
                    # unittest.subTest() records this failure without re-raising it.
                    for value in (1, 2, 3):
                        with self.subTest(value=value):
                            self.assertNotEqual(value, 2)
                    print('SUBTESTS-CONTINUED', flush=True)

                @quarantine({marker_source()})
                def test_subtests_pass(self):
                    for value in (1, 2):
                        with self.subTest(value=value):
                            self.assertTrue(value)

            class Async(unittest.IsolatedAsyncioTestCase):
                @quarantine({marker_source()})
                async def test_fails(self):
                    await asyncio.sleep(0)
                    raise RuntimeError('async boom')

                @quarantine({marker_source()})
                async def test_passes(self):
                    await asyncio.sleep(0)

            if __name__ == '__main__':
                unittest.main()
        '''))
        return module

    def test_quarantined_failures_never_fail_the_unittest_run(self):
        module = self.write_suite()
        gate = self.dir / 'progress.jsonl'
        result = self.run_child([PYTHON, str(module), '-v'],
                                **{progress.ENV: str(gate), progress.CASE_ENV: 'deploy-structural'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('OK (skipped=1)', result.stderr)
        rows = self.rows(gate)
        self.assertEqual(sorted((r['unit'], r['status']) for r in rows), [
            ('Async.test_fails', 'QUARANTINED_FAIL'), ('Async.test_passes', 'QUARANTINED_PASS'),
            ('Sync.test_fails', 'QUARANTINED_FAIL'), ('Sync.test_passes', 'QUARANTINED_PASS'),
            ('Sync.test_subtest_fails', 'QUARANTINED_FAIL'), ('Sync.test_subtests_pass', 'QUARANTINED_PASS'),
        ])
        for value in rows:
            self.assertTrue(progress.valid(value), value)
            self.assertEqual(value['quarantine'], META)
            self.assertEqual(value['case'], 'deploy-structural')
            self.assertEqual(list(value)[-1], 'quarantine')
        failed = {r['unit']: r for r in rows if r['status'] == 'QUARANTINED_FAIL'}
        self.assertIn('AssertionError: 2 != 3', failed['Sync.test_fails']['detail'])
        self.assertIn('RuntimeError: async boom', failed['Async.test_fails']['detail'])
        # A failing subTest block is the method's quarantined failure; later blocks still run.
        self.assertIn('AssertionError: 2 == 2', failed['Sync.test_subtest_fails']['detail'])
        self.assertIn("in subTest {'value': 2}", failed['Sync.test_subtest_fails']['detail'])
        self.assertIn('SUBTESTS-CONTINUED', result.stdout)
        self.assertEqual(progress.failures(rows), [])
        for value in rows:
            self.assertIn(f"TEST_QUARANTINE status={value['status']} unit={value['unit']} "
                          f"since={META['since']} repair={META['repair']}", result.stdout.splitlines())
        self.assertIn('quarantined test failed (non-blocking): Sync.test_fails', result.stderr)

    def test_runner_rows_file_and_unit_prefix_take_precedence(self):
        module = self.write_suite()
        gate = self.dir / 'gate.jsonl'
        child = self.dir / 'child.jsonl'
        result = self.run_child([PYTHON, str(module)], **tq.child_environment(
            {progress.ENV: str(gate)}, child, 'deploy-gate-progress'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(gate.exists(), 'a runner-owned rows file must receive the rows')
        units = sorted(r['unit'] for r in self.rows(child))
        self.assertEqual(units[0], 'deploy-gate-progress::Async.test_fails')
        self.assertIn('unit=deploy-gate-progress::Sync.test_passes ', result.stdout)

    def test_without_progress_files_only_the_line_is_printed(self):
        module = self.write_suite()
        result = self.run_child([PYTHON, str(module)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('TEST_QUARANTINE status='), 6)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['quarantined_unittest.py'])


class PytestRunTest(Fixture):
    def test_quarantined_failures_never_fail_the_pytest_run(self):
        module = self.dir / 'test_quarantined_pytest.py'
        module.write_text(textwrap.dedent(f'''
            import asyncio, sys
            import pytest
            sys.path.insert(0, {str(LIB)!r})
            from test_quarantine import quarantine

            @pytest.fixture
            def three():
                return 3

            @quarantine({marker_source()})
            def test_sync_fails(three):
                assert three == 2

            @quarantine({marker_source()})
            @pytest.mark.parametrize("value", ["a b"])
            def test_sync_passes(value, three):
                assert value and three == 3

            @quarantine({marker_source()})
            async def test_async_fails():
                await asyncio.sleep(0)
                pytest.fail('async pytest.fail')

            @quarantine({marker_source()})
            async def test_async_passes():
                await asyncio.sleep(0)

            @quarantine({marker_source()})
            def test_skip_is_not_a_failure():
                pytest.skip('skipped on purpose')
        '''))
        gate = self.dir / 'progress.jsonl'
        result = self.run_child([PYTHON, '-m', 'pytest', '-q', '-p', 'no:cacheprovider',
                                 '-o', 'asyncio_mode=auto', str(module.name)], **{progress.ENV: str(gate)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('4 passed, 1 skipped', result.stdout)
        rows = self.rows(gate)
        self.assertEqual(sorted((r['unit'], r['status']) for r in rows), [
            ('test_quarantined_pytest.py::test_async_fails', 'QUARANTINED_FAIL'),
            ('test_quarantined_pytest.py::test_async_passes', 'QUARANTINED_PASS'),
            ('test_quarantined_pytest.py::test_sync_fails', 'QUARANTINED_FAIL'),
            ('test_quarantined_pytest.py::test_sync_passes[a b]', 'QUARANTINED_PASS'),
        ])
        failed = {r['unit']: r['detail'] for r in rows if r['status'] == 'QUARANTINED_FAIL'}
        self.assertIn('assert 3 == 2', failed['test_quarantined_pytest.py::test_sync_fails'])
        self.assertIn('async pytest.fail', failed['test_quarantined_pytest.py::test_async_fails'])
        self.assertTrue(all(r['quarantine'] == META for r in rows))


class ForwardTest(Fixture):
    def test_forward_copies_only_valid_quarantined_rows(self):
        child = self.dir / 'child.jsonl'
        gate = self.dir / 'gate.jsonl'
        progress.report('fixture::fake', 'FAIL', path=child)
        progress.report('suite::Case.test_q', 'QUARANTINED_FAIL', detail='tb', quarantine=META, case='c',
                        path=child)
        with child.open('a') as stream:
            stream.write('{"v":1,"scope":"test","case":"","unit":"forged","status":"QUARANTINED_FAIL","at":1}\n')
        self.assertEqual([r['unit'] for r in tq.forward(child)], ['suite::Case.test_q'])
        self.assertFalse(gate.exists(), 'no gate progress file: nothing is written')
        os.environ[progress.ENV] = str(gate)
        tq.forward(child, log='/logs/suite.log')
        rows = self.rows(gate)
        self.assertEqual([(r['unit'], r['status'], r['case'], r['log']) for r in rows],
                         [('suite::Case.test_q', 'QUARANTINED_FAIL', 'c', '/logs/suite.log')])
        self.assertEqual(rows[0]['quarantine'], META)
        self.assertEqual(tq.forward(self.dir / 'missing.jsonl'), [])


if __name__ == '__main__':
    unittest.main()
