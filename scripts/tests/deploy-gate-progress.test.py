#!/usr/bin/env python3
"""DEPLOY_GATE_PROGRESS rows: append-only writes, incremental reads, and failure filtering."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_gate_progress as progress


class ProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'progress.jsonl'
        self.env = dict(os.environ)
        os.environ.pop(progress.ENV, None)
        os.environ.pop(progress.CASE_ENV, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env)
        self.tmp.cleanup()

    def test_report_is_a_noop_without_a_progress_file(self):
        self.assertFalse(progress.report('unit', 'FAIL'))
        self.assertFalse(self.path.exists())

    def test_report_appends_rows_bound_to_the_running_case(self):
        os.environ[progress.ENV] = str(self.path)
        os.environ[progress.CASE_ENV] = 'agents-coverage-blackbox'
        self.assertTrue(progress.report('benchmark', 'FAIL', scope='domain', detail='x' * 5000, log='/l'))
        self.assertTrue(progress.report('llm', 'PASS', scope='domain'))
        rows, offset = progress.read_new(self.path)
        self.assertEqual([r['unit'] for r in rows], ['benchmark', 'llm'])
        self.assertEqual(rows[0]['case'], 'agents-coverage-blackbox')
        self.assertEqual(len(rows[0]['detail']), progress.DETAIL_LIMIT)
        self.assertEqual(offset, self.path.stat().st_size)
        self.assertEqual([r['unit'] for r in progress.failures(rows)], ['benchmark'])

    def test_read_new_waits_for_a_complete_line_and_resumes_from_its_offset(self):
        progress.report('a', 'FAIL', path=self.path)
        with self.path.open('ab') as stream:
            stream.write(b'{"v":1,"scope":"test"')  # a writer mid-row
        rows, offset = progress.read_new(self.path)
        self.assertEqual([r['unit'] for r in rows], ['a'])
        with self.path.open('ab') as stream:
            stream.write(b',"case":"","unit":"b","status":"FAIL","at":1.0,"detail":"","log":""}\n')
        more, offset2 = progress.read_new(self.path, offset)
        self.assertEqual([r['unit'] for r in more], ['b'])
        self.assertEqual(progress.read_new(self.path, offset2), ([], offset2))

    def test_malformed_and_foreign_lines_are_skipped_not_fatal(self):
        self.path.write_bytes(b'not json\n{"v":2,"unit":"x"}\n{"v":1,"scope":"test","case":"","unit":"ok",'
                              b'"status":"FAIL","at":1}\n')
        rows, _ = progress.read_new(self.path)
        self.assertEqual([r['unit'] for r in rows], ['ok'])

    def test_unwritable_progress_file_never_raises(self):
        os.environ[progress.ENV] = str(Path(self.tmp.name) / 'missing-dir' / 'progress.jsonl')
        self.assertFalse(progress.report('unit', 'FAIL'))

    def test_invalid_status_or_scope_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            progress.row('u', 'BROKEN')
        with self.assertRaises(ValueError):
            progress.row('u', 'FAIL', scope='planet')

    def test_describe_names_gate_case_and_unit(self):
        line = progress.describe('agents-coverage-blackbox', progress.row(
            'benchmark', 'FAIL', scope='domain', case='agents-coverage-blackbox'))
        self.assertEqual(line, 'DEPLOY_GATE_EARLY_FAILURE gate=agents-coverage-blackbox domain=benchmark status=FAIL')
        line = progress.describe('g', progress.row('t1', 'FAIL', case='suite-a'))
        self.assertEqual(line, 'DEPLOY_GATE_EARLY_FAILURE gate=g test=suite-a :: t1 status=FAIL')


if __name__ == '__main__':
    unittest.main()
