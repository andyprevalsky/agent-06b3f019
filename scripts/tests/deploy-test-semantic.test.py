#!/usr/bin/env python3
"""Native Playwright report fixtures; no browser, services, DB or model calls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_test_semantic as adapter


class SemanticReports(unittest.TestCase):
    def fixture(self):
        item = {'id': 'native-id', 'project': 'chromium', 'file': 'a.spec.ts',
                'title': ['a.spec.ts', 'suite', 'case']}
        events = [{'event': 'begin', 'tests': [item]},
                  {'event': 'testBegin', 'id': item['id'], 'retry': 0},
                  {'event': 'hookEnd', 'id': item['id'], 'retry': 0,
                   'title': 'Before Hooks', 'ok': True},
                  {'event': 'hookEnd', 'id': item['id'], 'retry': 0,
                   'title': 'After Hooks', 'ok': True},
                  {'event': 'testEnd', 'id': item['id'], 'retry': 0, 'status': 'failed'},
                  {'event': 'end', 'status': 'failed'}]
        report = {'errors': [], 'suites': [{'specs': [{'id': item['id'], 'tests': [
            {'expectedStatus': 'passed', 'results': [{'retry': 0, 'status': 'failed',
              'errors': [{'message': 'expect received false'}]}]}]}]}]}
        return item, events, report

    def test_native_assertion_failure_is_fail_not_aggregate_unknown(self):
        item, events, report = self.fixture()
        self.assertEqual(adapter.classify_lane('ui', [item], report, events),
                         {adapter.case_key('ui', item): 'FAIL'})

    def test_incomplete_never_gets_assertion_credit(self):
        item, events, report = self.fixture()
        for change in ('before', 'after', 'end', 'skipped', 'interrupted', 'retry', 'extra', 'global'):
            with self.subTest(change=change):
                e, r = copy.deepcopy(events), copy.deepcopy(report)
                result = r['suites'][0]['specs'][0]['tests'][0]['results'][0]
                if change == 'before': e[2]['ok'] = False
                if change == 'after': e[3]['ok'] = False
                if change == 'end': e.pop()
                if change in ('skipped', 'interrupted'):
                    result['status'] = change; e[4]['status'] = change
                if change == 'retry': result['retry'] = 1
                if change == 'extra': r['suites'][0]['specs'].append(copy.deepcopy(r['suites'][0]['specs'][0]))
                if change == 'global': r['errors'] = [{'message': 'global setup failed'}]
                self.assertEqual(set(adapter.classify_lane('ui', [item], r, e).values()), {'UNVERIFIED'})


    def test_complete_native_retries_preserve_terminal_assertion_failure(self):
        item, events, report = self.fixture()
        report['config'] = {'projects': [{'name': 'chromium', 'retries': 1}]}
        result = report['suites'][0]['specs'][0]['tests'][0]['results'][0]
        second = copy.deepcopy(result)
        second['retry'] = 1
        report['suites'][0]['specs'][0]['tests'][0]['results'].append(second)
        retry_events = copy.deepcopy(events[1:5])
        for event in retry_events:
            event['retry'] = 1
        events[5:5] = retry_events
        self.assertEqual(adapter.classify_lane('ui', [item], report, events),
                         {adapter.case_key('ui', item): 'FAIL'})
        passed_events, passed_report = copy.deepcopy(events), copy.deepcopy(report)
        first = passed_report['suites'][0]['specs'][0]['tests'][0]['results'][0]
        first.update(status='passed', errors=[])
        passed_report['suites'][0]['specs'][0]['tests'][0]['results'] = [first]
        passed_events = passed_events[:5] + [passed_events[-1]]
        passed_events[4]['status'] = passed_events[-1]['status'] = 'passed'
        self.assertEqual(adapter.classify_lane('ui', [item], passed_report, passed_events),
                         {adapter.case_key('ui', item): 'PASS'})
        for defect in ('missing_original', 'missing_final', 'before', 'after', 'end', 'interrupted',
                       'skipped', 'duplicate', 'gap', 'pass_without_flaky_receipt',
                       'missing_project', 'missing_budget', 'duplicate_project', 'null_config',
                       'null_project', 'null_result', 'unknown_id'):
            with self.subTest(defect=defect):
                e, r = copy.deepcopy(events), copy.deepcopy(report)
                attempts = r['suites'][0]['specs'][0]['tests'][0]['results']
                if defect == 'missing_original':
                    attempts.pop(0)
                    e = [event for event in e if event.get('retry') != 0]
                if defect == 'missing_final':
                    attempts.pop()
                    e = [event for event in e if event.get('retry') != 1]
                if defect in ('before', 'after'):
                    e[6 if defect == 'before' else 7]['ok'] = False
                if defect == 'end': e.pop(8)
                if defect in ('interrupted', 'skipped'):
                    attempts[1]['status'] = e[8]['status'] = defect
                if defect in ('duplicate', 'gap'):
                    retry = 0 if defect == 'duplicate' else 2
                    attempts[1]['retry'] = retry
                    for event in e[5:9]: event['retry'] = retry
                if defect == 'pass_without_flaky_receipt':
                    attempts[1]['status'] = e[8]['status'] = 'passed'
                    e[-1]['status'] = 'passed'
                if defect == 'missing_project': r['config']['projects'] = []
                if defect == 'missing_budget': r['config']['projects'][0].pop('retries')
                if defect == 'duplicate_project':
                    r['config']['projects'].append({'name': 'chromium', 'retries': 2})
                if defect == 'null_config': r['config'] = None
                if defect == 'null_project': r['config']['projects'] = [None]
                if defect == 'null_result': attempts[-1] = None
                if defect == 'unknown_id':
                    e.insert(-1, {'event': 'testBegin', 'id': 'outside-inventory', 'retry': 0})
                self.assertEqual(set(adapter.classify_lane('ui', [item], r, e).values()),
                                 {'UNVERIFIED'})

    def test_native_pass_and_timeout(self):
        item, events, report = self.fixture()
        for status, expected in [('passed', 'PASS'), ('timedOut', 'FAIL')]:
            events[4]['status'] = status
            report['suites'][0]['specs'][0]['tests'][0]['results'][0]['status'] = status
            self.assertEqual(set(adapter.classify_lane('ui', [item], report, events).values()), {expected})

    def test_summary_never_hides_an_unknown_constituent(self):
        self.assertEqual(adapter.summary_status(['PASS', 'FAIL']), 'FAIL')
        self.assertEqual(adapter.summary_status(['PASS', 'PASS']), 'PASS')
        self.assertEqual(adapter.summary_status(['FAIL', 'UNVERIFIED']), 'UNVERIFIED')
        self.assertEqual(adapter.summary_status([]), 'UNVERIFIED')

    def run_worker(self, defect=None, malformed_event=None, malformed_report=None):
        import deploy_test_worker as worker
        import deploy_test_result as result_contract
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            freeze = {'head': 'fixture-head', 'digest': 'fixture-digest'}
            item, events, report = self.fixture()
            selected = {lane: [dict(item, id=lane + '-native-id')] for lane in adapter.LANES}
            spec = {'command': list(adapter.RUNNER), 'cwd': '.', 'aggregate': True, 'env': {}}
            request = {'token': 'fixture-token', 'source': freeze, 'gate': 'semantic-stack',
                       'phase': 'initial', 'worker_root': str(root), 'checks': ['semantic-stack'],
                       'skips': {}, 'worker_recipe': {'cases': {'semantic-stack': spec}}}
            calls = []
            raw_reports = {}
            def produce(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv, adapter.RUNNER)
                self.assertIsNone(kwargs['timeout'])  # Original has no deadline.
                folder = Path(kwargs['env']['DEPLOY_SEMANTIC_ARTIFACT_DIR'])
                for lane in adapter.LANES:
                    e, r = copy.deepcopy(events), copy.deepcopy(report)
                    row = selected[lane][0]
                    e[0]['tests'] = [row]
                    for event in e[1:-1]: event['id'] = row['id']
                    r['suites'][0]['specs'][0]['id'] = row['id']
                    if lane == 'latency' or defect == 'all_pass_nonzero':
                        e[4]['status'] = e[5]['status'] = 'passed'
                        r['suites'][0]['specs'][0]['tests'][0]['results'][0]['status'] = 'passed'
                    if lane == 'ui' and defect == 'malformed_event':
                        e.append(malformed_event)
                    if lane == 'ui' and defect == 'malformed_report':
                        path, value = malformed_report
                        target = r
                        for key in path[:-1]: target = target[key]
                        target[path[-1]] = value
                    raw_reports[lane] = json.dumps(r).encode()
                    (folder / (lane + '.json')).write_bytes(raw_reports[lane])
                    (folder / (lane + '.jsonl')).write_text(''.join(json.dumps(x) + '\n' for x in e))
                receipt = {'token': request['token'], 'source': freeze, 'ready': True,
                           'cleanup_complete': True, 'cleanup_exit': 0, 'ui': 1, 'latency': 0}
                if defect == 'cleanup': receipt['cleanup_complete'] = False
                if defect == 'cleanup_exit': receipt['cleanup_exit'] = 1
                if defect == 'token': receipt['token'] = 'old-token'
                if defect == 'source': receipt['source'] = {'head': 'old'}
                if defect == 'not_ready': receipt['ready'] = False
                if defect == 'lane_exit': receipt['ui'] = 2
                if defect == 'all_pass_nonzero': receipt['ui'] = 0
                if defect != 'missing_cleanup': (folder / 'stack.json').write_text(json.dumps(receipt))
                return (0 if defect == 'zero_with_failure' else 1), defect == 'timeout', defect == 'cancel', defect == 'lingering'
            with patch.object(worker, 'source', return_value=freeze), patch.object(adapter, 'source',
                    side_effect=[freeze, {'head': 'changed'}] if defect == 'changed' else [freeze, freeze]), \
                    patch.object(adapter, 'native_inventory', return_value=selected), \
                    patch.object(adapter, 'run_command', side_effect=produce):
                result = worker.execute(request, root)
            self.assertEqual(calls, [adapter.RUNNER])
            self.assertEqual(result['recipe_digest'], worker.digest(request['worker_recipe']))
            self.assertEqual(len(result['evidence']['semantic-stack']['native_cases']), 2)
            if defect is None:
                self.assertEqual(result['cases'], {'semantic-stack': 'FAIL'})
                self.assertTrue(result['complete'])
                result_contract.validate(result, request, 1)
            else:
                self.assertEqual(result['cases'], {'semantic-stack': 'UNVERIFIED'})
                self.assertFalse(result['complete'])
            if defect == 'malformed_event':
                self.assertEqual(result['evidence']['semantic-stack']['errors'], ['ui: ValueError'])
                self.assertTrue(result['cleanup_complete'])
                self.assertEqual(result['native_exit'], 1)
                self.assertFalse(result['interrupted'])
                native = result['evidence']['semantic-stack']['native_cases']
                self.assertEqual(native[adapter.case_key('ui', selected['ui'][0])], 'UNVERIFIED')
                self.assertEqual(native[adapter.case_key('latency', selected['latency'][0])], 'PASS')
                captured = Path(result['evidence']['semantic-stack']['artifact_directory'])
                self.assertEqual(adapter.events_at(captured / 'ui.jsonl')[-1], malformed_event)
                raw = json.loads((captured / 'ui.json').read_text())
                self.assertEqual(raw['suites'][0]['specs'][0]['tests'][0]['results'][0]['status'], 'failed')

            if defect == 'malformed_report':
                import hashlib
                evidence = result['evidence']['semantic-stack']
                self.assertEqual(evidence['errors'], ['ui: ValueError'])
                self.assertTrue(result['cleanup_complete'])
                self.assertEqual(result['native_exit'], 1)
                self.assertTrue(result['source_unchanged'])
                self.assertFalse(result['interrupted'])
                self.assertEqual(evidence['native_cases'][adapter.case_key('ui', selected['ui'][0])],
                                 'UNVERIFIED')
                self.assertEqual(evidence['native_cases'][adapter.case_key('latency', selected['latency'][0])],
                                 'PASS')
                captured = Path(evidence['artifact_directory']) / 'ui.json'
                self.assertEqual(captured.read_bytes(), raw_reports['ui'])
                self.assertEqual(evidence['artifacts']['ui.json'],
                                 hashlib.sha256(raw_reports['ui']).hexdigest())

    def test_malformed_nested_native_report_is_unknown_with_lane_diagnostic(self):
        mutations = [
            (('suites',), [None]),
            (('suites',), None),
            (('suites',), {}),
            (('suites', 0, 'suites'), [None]),
            (('suites', 0, 'suites'), None),
            (('suites', 0, 'specs'), None),
            (('suites', 0, 'specs'), {}),
            (('suites', 0, 'specs'), [None]),
            (('suites', 0, 'specs'), ['x']),
            (('suites', 0, 'specs', 0, 'tests'), None),
            (('suites', 0, 'specs', 0, 'tests'), {}),
            (('suites', 0, 'specs', 0, 'tests'), [None]),
            (('suites', 0, 'specs', 0, 'tests'), ['x']),
        ]
        for path, value in mutations:
            with self.subTest(path=path, value=value):
                self.run_worker('malformed_report', malformed_report=(path, value))

    def test_malformed_final_native_event_is_unknown_with_lane_diagnostic(self):
        for value in (1, [], 'x', None):
            with self.subTest(value=value):
                self.run_worker('malformed_event', malformed_event=value)

    def test_existing_worker_dispatch_one_sweep_original_recipe(self):
        self.run_worker()

    def test_cleanup_identity_interruption_and_source_fail_closed(self):
        for defect in ('cleanup', 'cleanup_exit', 'token', 'source', 'not_ready',
                       'lane_exit', 'all_pass_nonzero', 'zero_with_failure', 'missing_cleanup', 'timeout', 'cancel', 'lingering', 'changed'):
            with self.subTest(defect=defect): self.run_worker(defect)

    def test_recipe_refuses_replacement_setup_or_filter(self):
        original = {'cases': {'semantic-stack': {'command': adapter.RUNNER, 'cwd': '.', 'aggregate': True}}}
        self.assertEqual(adapter.sweep_from_recipe(original), original['cases']['semantic-stack'])
        for defect in ('setup', 'cleanup', 'services', 'execution_timeout_seconds'):
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                adapter.sweep_from_recipe({**original, defect: True})

    def test_actual_stack_shell_records_cleanup_exit_not_echo(self):
        import os
        import shutil
        for cleanup_exit in (0, 1):
            with self.subTest(cleanup_exit=cleanup_exit), tempfile.TemporaryDirectory() as d:
                folder = Path(d)
                (folder / 'scripts/lib').mkdir(parents=True)
                (folder / '.context').mkdir()
                (folder / 'bin').mkdir()
                for relative in ('scripts/run-deploy-semantic-stack.sh', 'scripts/lib/workspace-env.sh',
                                 'scripts/lib/deploy-local-env.sh'):
                    shutil.copyfile(ROOT / relative, folder / relative)
                for name in ('pg_isready', 'curl'):
                    path = folder / 'bin' / name
                    path.write_text('#!/bin/bash\nexit 0\n'); path.chmod(0o700)
                (folder / 'scripts/run.sh').write_text('#!/bin/bash\nexec sleep 30\n')
                (folder / 'scripts/kill-services.sh').write_text(
                    '#!/bin/bash\nif [ -f .context/swept ]; then exit "$FAKE_CLEANUP_RC"; fi\ntouch .context/swept\n')
                (folder / 'scripts/run-deploy-stage').write_text(
                    '#!/bin/bash\n[ "$1" = semantic-latency ]\n')
                (folder / '.context/services.json').write_text(json.dumps(
                    {'status': 'running', 'ports': {'backend': 29080}, 'database': {'runtime_port': 29085}}))
                env = {**os.environ, 'PATH': str(folder / 'bin') + os.pathsep + os.environ['PATH'],
                       'CONDUCTOR_PORT': '29080', 'CONDUCTOR_WORKSPACE_NAME': 'semantic_fixture',
                       'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1', 'ROSE_USE_SYSTEM_PG': 'false',
                       'DEPLOY_SEMANTIC_ARTIFACT_DIR': str(folder / '.context'),
                       'DEPLOY_SEMANTIC_TOKEN': 'request-token', 'DEPLOY_SEMANTIC_SOURCE': '{"digest":"frozen"}',
                       'FAKE_CLEANUP_RC': str(cleanup_exit)}
                proc = subprocess.run(['bash', 'scripts/run-deploy-semantic-stack.sh'], cwd=folder,
                                      env=env, capture_output=True, timeout=20)
                self.assertEqual(proc.returncode, 1, proc.stderr.decode())
                self.assertIn('STACK_TEARDOWN_DONE', proc.stdout.decode())
                receipt = json.loads((folder / '.context/stack.json').read_text())
                self.assertEqual(receipt['cleanup_complete'], cleanup_exit == 0)
                self.assertEqual(receipt['cleanup_exit'], cleanup_exit)
                self.assertEqual((receipt['ui'], receipt['latency']), (1, 0))
                self.assertTrue(receipt['ready'])
                self.assertEqual(receipt['token'], 'request-token')

    def test_inventory_cli_matches_frontend_first_and_root_fallback(self):
        import os
        for mode in ('frontend_bin', 'frontend_package', 'root_fallback', 'competing', 'missing'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'front-end').mkdir()
                out = root / 'reports'; out.mkdir()
                choices = []
                if mode in ('frontend_bin', 'competing'): choices.append(('front-end/node_modules/.bin/playwright', 'frontend', True))
                if mode == 'frontend_package': choices.append(('front-end/node_modules/@playwright/test/cli.cjs', 'package', False))
                if mode in ('root_fallback', 'competing'): choices.append(('node_modules/.bin/playwright', 'root', True))
                for relative, label, executable in choices:
                    target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('#!/usr/bin/env node\n' +
                        "const fs=require('node:fs'); const lane=process.argv.some(x=>x.includes('chat-lifecycle-latency.spec'))?'latency':'ui';\n" +
                        f"fs.appendFileSync({json.dumps(str(root / 'chosen'))}, {json.dumps(label + chr(10))});\n" +
                        "const row={id:lane,project:'chromium',file:lane+'.spec.ts',title:[lane]};\n" +
                        "fs.writeFileSync(process.env.DEPLOY_SEMANTIC_LIFECYCLE, JSON.stringify({event:'begin',tests:[row]})+'\\n'+JSON.stringify({event:'end',status:'passed'})+'\\n');\n")
                    target.chmod(0o700 if executable else 0o600)
                    if mode == 'frontend_package':
                        (target.parent / 'package.json').write_text(json.dumps({'name':'@playwright/test','bin':{'playwright':'cli.cjs'}}))
                if mode == 'missing':
                    with self.assertRaises(ValueError): adapter.native_inventory(root, out)
                else:
                    selected = adapter.native_inventory(root, out, dict(os.environ))
                    self.assertEqual(len(adapter.checks_for(selected)), 2)
                    preferred = 'package' if mode == 'frontend_package' else ('root' if mode == 'root_fallback' else 'frontend')
                    self.assertEqual((root / 'chosen').read_text().splitlines(), [preferred, preferred])

    def test_optional_native_output_keeps_lane_attachments(self):
        import os
        tail = (ROOT / 'front-end/scripts/run-semantic-tests.sh').read_text().split(
            '# Optional native evidence output;', 1)[1]
        tail = '# Optional native evidence output;' + tail
        for lane in ('ui', 'latency'):
            for native in (False, True):
                with self.subTest(lane=lane, native=native), tempfile.TemporaryDirectory() as d:
                    folder = Path(d)
                    (folder / 'tests-e2e').mkdir()
                    (folder / 'tests-e2e/chat-lifecycle-latency.spec.ts').touch()
                    capture = "run_playwright() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \"$@\"; exit 0; }\n"
                    env = {**os.environ, 'SEMANTIC_WORKERS': '4', 'REPO_DIR': str(ROOT)}
                    env.pop('SEMANTIC_NATIVE_REPORT_PREFIX', None)
                    prefix = folder / lane
                    if native: env['SEMANTIC_NATIVE_REPORT_PREFIX'] = str(prefix)
                    args = ['chat-lifecycle-latency'] if lane == 'latency' else []
                    proc = subprocess.run(['bash', '-eu', '-c', capture + tail, 'fixture', *args],
                                          cwd=folder, env=env, capture_output=True, text=True, timeout=10)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    argv = json.loads(proc.stdout)
                    if native:
                        self.assertIn('--output=' + str(prefix) + '-artifacts', argv)
                    else:
                        self.assertFalse(any(a.startswith('--output') for a in argv))
                    self.assertIn('--workers=4', argv)

    def test_real_playwright_reports_setup_failure_as_unverified(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            pkg = Path(subprocess.check_output(
                ['node', '-p', "require.resolve('@playwright/test')"], cwd=ROOT / 'front-end', text=True
            ).strip())
            (folder / 'fixture.spec.cjs').write_text(
                f"const {{test,expect}} = require({json.dumps(str(pkg))});\n"
                "test('pass',()=>expect(1).toBe(1));\n"
                "test('assertion',()=>expect(1).toBe(2));\n"
                "test.describe('setup',()=>{test.beforeEach(()=>{throw Error('setup failed')});"
                "test('not executed',()=>{});});\n")
            (folder / 'playwright.config.cjs').write_text("module.exports={testDir:'.',retries:0,workers:1,projects:[{name:'chromium'}]};")
            import os
            env = {**os.environ, 'DEPLOY_SEMANTIC_LIFECYCLE': str(folder / 'events.jsonl'),
                   'PLAYWRIGHT_JSON_OUTPUT_FILE': str(folder / 'report.json')}
            proc = subprocess.run([*adapter.playwright_command(ROOT), 'test', '--reporter=json,' + str(
                ROOT / 'scripts/deploy-semantic-reporter.cjs'), '--output', str(folder / 'test-results')],
                cwd=folder, env=env,
                capture_output=True, timeout=45)
            self.assertEqual(proc.returncode, 1, proc.stderr.decode())
            events = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()]
            cases = adapter.classify_lane('ui', events[0]['tests'],
                                           json.loads((folder / 'report.json').read_text()), events)
            self.assertEqual(sorted(cases.values()), ['FAIL', 'PASS', 'UNVERIFIED'], str(events) + (folder / 'report.json').read_text())


if __name__ == '__main__':
    unittest.main()
