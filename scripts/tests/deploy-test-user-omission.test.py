"""Private prospective-election owning CLI fixtures; never contact a provider."""
import copy
import hashlib
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / 'scripts'))
# Pin the actual admission consumer to this source root. Some existing script
# imports prepend their own root, which otherwise selects the live source while
# the private fixture is validating candidate bytes. Canonical runs use the
# same source-root path; no admission code or assertion is mocked here.
import importlib.util
_admission_spec = importlib.util.spec_from_file_location(
    'deploy_test_historical_custody', HERE / 'scripts/deploy_test_historical_custody.py')
_admission_module = importlib.util.module_from_spec(_admission_spec)
sys.modules['deploy_test_historical_custody'] = _admission_module
_admission_spec.loader.exec_module(_admission_module)
import deploy_test_cycle as c
from deploy_failure_report import USER_OVERRIDE_CHECKS, USER_OVERRIDE_REFERENCE


class ProspectiveElection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'cycle'
        self.directory.mkdir()
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        self.environment = 'c' * 64
        self.six = sorted(USER_OVERRIDE_CHECKS)
        self.plan = {'source': self.source, 'gates': [
            {'name': 'smoke', 'checks': [x.split('/')[1] for x in self.six if x.startswith('smoke/')] + ['browser-smoke', 'MASS-t7'],
             'command': ['never-run'], 'case_protocol': True},
            {'name': 'agentcard-lifecycle', 'checks': ['agentcard-lifecycle'], 'command': ['never-run'], 'case_protocol': True}]}
        self.fingerprints = {g['name']: str(i + 4) * 64 for i, g in enumerate(self.plan['gates'])}
        self.state = {'version': 1, 'source': self.source, 'plan': self.plan, 'plan_digest': c.digest(self.plan),
                      'environment': self.environment, 'input_fingerprints': self.fingerprints, 'phase': 'triage',
                      'ready': False, 'round': 4, 'pending': ['unrelated-failure'], 'skips': {}, 'attempts': [],
                      'failures': [{'id': 'unrelated-failure', 'gate': 'smoke', 'check': 'smoke/browser-smoke',
                                    'native_result': 'FAIL', 'source': self.source}],
                      'resource_warnings': [{'check': 'smoke/MASS-t7', 'proof': 'existing-quota'}],
                      'historical_no_retry_custody': [{'unchanged': 4396}],
                      'historical_custody_history': [{'original_failure': 'untouched'}]}
        self.authority = self.root / 'authority.json'
        self.native_source = {'fileIdentityKey': 'test-native-file', 'lineId': 'test-native-line',
                              'textOffset': 0, 'textLength': len(USER_OVERRIDE_REFERENCE['reply'])}
        self.page = {'ok': True, 'readMode': 'full', 'scope': 'project',
                     'thread': {'id': USER_OVERRIDE_REFERENCE['thread_id']},
                     'transcript': {'completeness': {'mode': 'full', 'pageComplete': True,
                                                    'missingTurnCount': 0, 'omittedMessageCount': 0,
                                                    'shortenedMessageCount': 0, 'unavailableMessageCount': 0},
                                    'messages': [{'role': 'user', 'text': USER_OVERRIDE_REFERENCE['reply'],
                                                  'turnId': USER_OVERRIDE_REFERENCE['turn_id'], 'textComplete': True,
                                                  'reason': None, 'source': self.native_source}]}}
        self.put(self.authority, self.page)
        self.request = {'kind': 'explicit-agentcard-preexecution-election-v1', 'source': self.source,
                        'environment': self.environment, 'plan_digest': c.digest(self.plan),
                        'input_fingerprints': self.fingerprints, 'checks': self.six,
                        'question_checks': self.six,
                        'authority': {'path': str(self.authority), 'sha256': self.sha(self.authority),
                                      'message_source': self.native_source}}
        self.plan_path = self.root / 'plan.json'
        self.request_path = self.root / 'request.json'
        self.put(self.plan_path, self.plan)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(c, 'source', return_value=self.source))
        self.stack.enter_context(patch.object(c, 'environment_digest', return_value=self.environment))
        self.stack.enter_context(patch.object(c, 'input_fingerprints', return_value=self.fingerprints))
        self.stack.enter_context(patch.object(c, 'validate_plan'))
        self.owners = self.stack.enter_context(patch.object(c, 'retained_owners', return_value=[]))
        c.CANCEL.clear()
        self.addCleanup(c.CANCEL.clear)

    def put(self, path, value):
        path.write_text(json.dumps(value))

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def cli(self, request=None, state=None, request_sha=None):
        self.put(self.directory / 'cycle.json', self.state if state is None else state)
        self.put(self.request_path, self.request if request is None else request)
        return c.main(['elect-user-omission', '--plan', str(self.plan_path), '--state-dir', str(self.directory),
                       '--root', str(self.root), '--input', str(self.request_path),
                       '--input-sha256', request_sha or self.sha(self.request_path)])

    def read(self):
        return json.loads((self.directory / 'cycle.json').read_text())

    def reject(self, request=None, state=None, request_sha=None):
        original = copy.deepcopy(self.state if state is None else state)
        self.assertNotEqual(self.cli(request, original, request_sha), 0)
        self.assertEqual(original, self.read())

    def test_cli_records_selected_six_without_fabricating_failures_or_changing_history(self):
        before = copy.deepcopy(self.state)
        self.assertEqual(self.cli(), 0)
        after = self.read()
        election = after.pop('user_elected_omissions')
        self.assertEqual(after, before)
        self.assertEqual(election['request'], self.request)
        self.assertEqual(set(election['entries']), set(self.six))
        for row in election['entries'].values():
            self.assertEqual(row['native_result'], 'UNEXECUTED')
            self.assertEqual(row['status'], 'SKIP')
            self.assertIsNone(row['native_exit'])
            self.assertIs(row['executed'], False)
            self.assertEqual(row['credit'], {'test_execution': False, 'assertions': False, 'financial_release': False})
        self.assertEqual(self.owners.call_args.args[1], ['smoke', 'agentcard-lifecycle'])

    def test_idempotent_same_request_is_byte_stable(self):
        self.assertEqual(self.cli(), 0)
        first = self.read()
        self.assertEqual(self.cli(state=first), 0)
        self.assertEqual(first, self.read())

    def test_selected_intersection_only_keeps_absent_lifecycle_out(self):
        self.plan['gates'] = self.plan['gates'][:1]
        self.state.update(plan=self.plan, plan_digest=c.digest(self.plan))
        self.fingerprints.pop('agentcard-lifecycle')
        self.state['input_fingerprints'] = self.fingerprints
        self.request.update(plan_digest=c.digest(self.plan), checks=[x for x in self.six if x.startswith('smoke/')],
                            input_fingerprints=self.state['input_fingerprints'])
        self.put(self.plan_path, self.plan)
        self.assertEqual(self.cli(), 0)
        self.assertEqual(set(self.read()['user_elected_omissions']['entries']), set(self.request['checks']))

    def test_refuses_missing_or_altered_authority_hash(self):
        for authority in ({}, {**self.request['authority'], 'sha256': '0' * 64}):
            with self.subTest(authority=authority):
                self.reject({**self.request, 'authority': authority})

    def test_refuses_agent_prose_search_preview_wrong_identity_or_missing_exact_quote(self):
        original = copy.deepcopy(self.page)
        mutations = [lambda p: p.update(readMode='preview'),
                     lambda p: p['thread'].update(id='another-thread'),
                     lambda p: p['transcript']['messages'][0].update(role='assistant'),
                     lambda p: p['transcript']['messages'][0].update(turnId='other-turn'),
                     lambda p: p['transcript']['messages'][0].update(text='No paid cards'),
                     lambda p: p['transcript']['messages'][0].update(textComplete=False),
                     lambda p: p['transcript']['messages'][0].update(reason='continued'),
                     lambda p: p['transcript']['completeness'].update(missingTurnCount=1),
                     lambda p: p['transcript']['messages'][0].update(source={})]
        for mutate in mutations:
            page = copy.deepcopy(original); mutate(page); self.put(self.authority, page)
            request = copy.deepcopy(self.request); request['authority']['sha256'] = self.sha(self.authority)
            with self.subTest(mutation=mutations.index(mutate)): self.reject(request)

    def test_refuses_scope_subset_superset_duplicates_and_unrelated_checks(self):
        for field, value in [('question_checks', self.six[:-1]), ('checks', self.six[:-1]),
                             ('checks', self.six + [self.six[0]]), ('checks', self.six + ['smoke/MASS-t7'])]:
            with self.subTest(field=field, value=value): self.reject({**self.request, field: value})

    def test_refuses_source_environment_plan_or_input_drift(self):
        for field, value in [('source', {'head': '9' * 40, 'digest': '9' * 64}),
                             ('environment', '9' * 64), ('plan_digest', '9' * 64),
                             ('input_fingerprints', {'smoke': '9' * 64})]:
            with self.subTest(field=field): self.reject({**self.request, field: value})

    def test_refuses_cancel_running_resume_or_live_failure(self):
        for extra in ({'running': {'token': 'live'}}, {'resume_phase': 'initial'}, {'live_failures': []}, {'phase': 'ready'}):
            with self.subTest(extra=extra): self.reject(state={**self.state, **extra})
        c.CANCEL.set()
        self.reject()

    def test_refuses_retained_or_unknown_owner(self):
        self.owners.return_value = ['smoke']
        self.reject()
        self.owners.side_effect = ValueError('unknown native owner')
        self.reject()

    def test_refuses_changed_request_digest(self):
        self.reject(request_sha='0' * 64)

    def test_refuses_selected_pending_failure_use_normal_adjudication(self):
        state = copy.deepcopy(self.state)
        state['failures'].append({'id': 'pay-fail', 'gate': 'smoke', 'check': 'smoke/agent-payment-test-shop'})
        state['pending'].append('pay-fail')
        self.reject(state=state)

    def test_authority_revalidated_before_projection_and_custody_wins(self):
        self.assertEqual(self.cli(), 0)
        state = self.read()
        e = importlib.import_module('deploy_test_user_omission')
        gate = self.plan['gates'][0]
        result = e.qualifications(state, gate, {'agent-payment-abandonment': {'disposition': 'NO_RETRY_CUSTODY'}})
        self.assertNotIn('agent-payment-abandonment', result)
        self.assertEqual(set(result), set(gate['checks']) - {'browser-smoke', 'MASS-t7', 'agent-payment-abandonment'})
        self.authority.write_text('{}')
        with self.assertRaises(ValueError): e.qualifications(state, gate, {})

    def test_stale_source_fails_closed_until_re_election_without_synthetic_failure(self):
        self.assertEqual(self.cli(), 0)
        state = self.read()
        e = importlib.import_module('deploy_test_user_omission')
        state['source'] = {'head': '9' * 40, 'digest': '8' * 64}
        with self.assertRaises(ValueError): e.qualifications(state, self.plan['gates'][0], {})
        self.assertEqual(state['failures'], self.state['failures'])

    def test_real_mixed_request_omits_only_elected_cases_and_keeps_historical_custody(self):
        # Existing custody validator is mocked at the prior-proof boundary only;
        # real cycle projection/request generation and election validation run.
        self.state['resource_warnings'] = []
        self.assertEqual(self.cli(), 0)
        state = self.read()
        import deploy_test_historical_custody as h
        custody = {'agent-payment-abandonment': {'disposition': 'NO_RETRY_CUSTODY', 'source': self.source}}
        class CapturedRequest(Exception):
            pass
        with patch.object(h, 'known', return_value={}), patch.object(h, 'guard', return_value=custody) as guard, \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), \
             patch.object(c, 'isolated_request', return_value=[]), \
             patch.object(c, 'run_command', side_effect=CapturedRequest) as transport:
            with self.assertRaises(CapturedRequest):
                c._execute(self.plan['gates'][0], state, self.directory, self.root)
        request = json.loads((self.directory / 'attempts/4/triage/smoke/request.json').read_text())
        self.assertEqual(request['checks'], ['browser-smoke', 'MASS-t7'])
        self.assertEqual(set(request['skips']), {v.split('/')[1] for v in self.six if v.startswith('smoke/')})
        self.assertEqual(request['skips']['agent-payment-abandonment'], custody['agent-payment-abandonment'])
        self.assertNotIn('agent-payment-abandonment', guard.call_args.args[3])
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(state['historical_no_retry_custody'], self.state['historical_no_retry_custody'])

    def test_real_all_skip_has_no_command_native_exit_or_assertion_credit(self):
        self.state['resource_warnings'] = []
        self.state.pop('historical_no_retry_custody')
        self.state.pop('historical_custody_history')
        self.assertEqual(self.cli(), 0)
        state = self.read()
        gate = self.plan['gates'][1]
        with patch.object(c, 'run_command') as transport:
            with self.assertRaises(ValueError): c._execute(gate, state, self.directory, self.root)
            row = c._execute(gate, state, self.directory, self.root, host_admission={'started': True})
        transport.assert_not_called()
        self.assertIsNone(row['native_exit'])
        self.assertIs(row['executed'], False)
        self.assertEqual(row['status'], 'SKIP')
        self.assertEqual(row['case_complete'], {'agentcard-lifecycle': False})
        self.assertEqual(row['current_execution'], {'agentcard-lifecycle': 'UNEXECUTED'})

    def test_renewal_archives_prior_election_without_editing_native_history(self):
        self.assertEqual(self.cli(), 0)
        before = self.read()
        state = copy.deepcopy(before)
        self.source.update(head='9' * 40, digest='8' * 64)
        self.plan['source'] = self.source
        state.update(source=self.source, plan=self.plan, plan_digest=c.digest(self.plan))
        self.request.update(source=self.source, plan_digest=state['plan_digest'])
        self.put(self.plan_path, self.plan)
        self.assertEqual(self.cli(state=state), 0)
        after = self.read()
        self.assertEqual(after['superseded_user_elected_omissions'], [before['user_elected_omissions']])
        for key in ('failures', 'pending', 'attempts', 'resource_warnings', 'historical_no_retry_custody', 'historical_custody_history'):
            self.assertEqual(after[key], before[key])

    def bundle(self):
        cursor = {'publicId': USER_OVERRIDE_REFERENCE['thread_id'], 'fileId': 'fixture-file',
                  'fileIdentityKey': 'fixture-native-file', 'historyMode': 'codex_projected',
                  'projectionVersion': 9, 'pageEndOrdinalInclusive': 359}
        original = {'ok': True, 'scope': 'project', 'thread': {'id': USER_OVERRIDE_REFERENCE['thread_id']},
                    'transcript': {'messages': [{'role': 'notice', 'text': 'Additional message content',
                                                'turnId': USER_OVERRIDE_REFERENCE['turn_id']}],
                                   'pagination': {'nextCursor': json.dumps({**cursor, 'pageEndOrdinalInclusive': 358})}}}
        search = {'ok': True, 'scope': 'project', 'results': [
            {'thread': {'id': USER_OVERRIDE_REFERENCE['thread_id']},
             'match': {'role': 'user', 'messageTimeMs': 1794172045719, 'readCursor': json.dumps(cursor),
                       'snippet': {'text': USER_OVERRIDE_REFERENCE['reply']}}}]}
        continuation = {'ok': True, 'scope': 'project', 'thread': {'id': USER_OVERRIDE_REFERENCE['thread_id']},
                        'transcript': {'messages': [{'role': 'user', 'messageTimeMs': 1794275237473,
                         'turnId': 'turn:01a1c323-5e2d-7da0-b4a9-10ea071ca012',
                         'text': 'No paidAgentCard new/reclaim; user SKIPagentcardbs exactsixscope remains, $43.96UNKNOWN financialdebt remains.'}]}}
        docs = dict(search=search, original_read=original, continuation=continuation)
        proof = {'kind': 'native-search-continuation-v1'}
        for name, value in docs.items():
            path = self.root / (name + '.json'); self.put(path, value)
            proof[name] = {'path': str(path), 'sha256': self.sha(path)}
        return proof, docs

    def test_native_search_turn_join_and_continuing_user_restriction(self):
        proof, docs = self.bundle()
        self.assertEqual(self.cli({**self.request, 'authority': proof}), 0)
        self.assertEqual(self.read()['user_elected_omissions']['request']['authority'], proof)
        self.assertEqual(docs['original_read']['transcript']['messages'][0]['role'], 'notice')

    def test_native_bundle_rejects_wrong_quote_role_turn_cursor_continuation_or_hash(self):
        mutations = [
            ('search', lambda d: d['results'][0]['match'].update(role='assistant')),
            ('search', lambda d: d['results'][0]['match']['snippet'].update(text='SKIP all')),
            ('search', lambda d: d['results'][0]['match'].update(messageTimeMs=True)),
            ('search', lambda d: d.update(results=[{'thread': [], 'match': {}}])),
            ('original_read', lambda d: d['transcript']['messages'][0].update(turnId='other-turn')),
            ('original_read', lambda d: d['transcript']['pagination'].update(nextCursor='{}')),
            ('continuation', lambda d: d['transcript']['messages'][0].update(role='assistant')),
            ('continuation', lambda d: d['transcript']['messages'][0].update(text='agent says approved')),
            ('continuation', lambda d: d['transcript']['messages'][0].update(turnId='other-turn'))]
        for name, mutate in mutations:
            proof, docs = self.bundle(); mutate(docs[name])
            self.put(Path(proof[name]['path']), docs[name]); proof[name]['sha256'] = self.sha(Path(proof[name]['path']))
            with self.subTest(name=name, mutation=mutations.index((name, mutate))):
                self.reject({**self.request, 'authority': proof})
        proof, _ = self.bundle(); proof['continuation']['sha256'] = '0' * 64
        self.reject({**self.request, 'authority': proof})

    def test_full_page_malformed_shapes_are_clear_refusals_without_state_change(self):
        for field in ('thread', 'transcript'):
            page = copy.deepcopy(self.page); page[field] = []
            self.put(self.authority, page)
            request = copy.deepcopy(self.request); request['authority']['sha256'] = self.sha(self.authority)
            with self.subTest(field=field): self.reject(request)

    def test_report_states_omission_without_native_pass_or_financial_credit(self):
        self.assertEqual(self.cli(), 0)
        e = importlib.import_module('deploy_test_user_omission')
        lines = e.report_lines(self.read())
        self.assertEqual(len(lines), 6)
        for line in lines:
            self.assertIn('Overridden', line)
            self.assertIn('UNEXECUTED/SKIP', line)
            self.assertIn('no execution/assertion/financial credit', line)
            self.assertNotIn('PASS', line)

    def test_prior_genuine_pass_fail_attempts_and_qualifications_remain_immutable(self):
        state = copy.deepcopy(self.state)
        state['attempts'] = [{'source': self.source, 'phase': 'initial', 'results': [
            {'gate': 'smoke', 'cases': {'agent-payment-test-shop': 'PASS', 'browser-smoke': 'FAIL'},
             'executed': True, 'native_exit': 1, 'complete': True}]}]
        state['skips'] = {'smoke/MASS-t7': {'disposition': 'external', 'original': 'quota receipt'}}
        before = copy.deepcopy(state)
        self.assertEqual(self.cli(state=state), 0)
        after = self.read(); after.pop('user_elected_omissions')
        self.assertEqual(after, before)

    def test_canonical_cycle_lock_refuses_concurrent_election(self):
        import fcntl
        with (self.directory / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.reject()

    def test_real_mixed_receipt_grants_credit_only_to_active_fixture_checks(self):
        self.state['resource_warnings'] = []
        self.assertEqual(self.cli(), 0)
        state = self.read()
        import deploy_test_historical_custody as h
        custody = {'agent-payment-abandonment': {'disposition': 'NO_RETRY_CUSTODY', 'source': self.source}}
        def fixture_transport(argv, **kwargs):
            request = json.loads(Path(kwargs['env']['DEPLOY_GATE_REQUEST']).read_text())
            result = {'token': request['token'], 'source': request['source'], 'gate': request['gate'],
                      'cases': dict.fromkeys(request['checks'], 'PASS'), 'complete': True,
                      'cleanup_complete': True, 'reused': False}
            Path(kwargs['env']['DEPLOY_GATE_RESULT']).write_text(json.dumps(result))
            return 0, False, False, False
        with patch.object(h, 'known', return_value={}), patch.object(h, 'guard', return_value=custody), \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), \
             patch.object(c, 'isolated_request', return_value=[]), \
             patch.object(c, 'run_command', side_effect=fixture_transport):
            row = c._execute(self.plan['gates'][0], state, self.directory, self.root)
        self.assertEqual(row['status'], 'PASS')  # Active two checks only; never elected task outcome.
        self.assertTrue(row['case_complete']['browser-smoke'])
        self.assertTrue(row['case_complete']['MASS-t7'])
        for check in self.six:
            if not check.startswith('smoke/'): continue
            name = check.split('/')[1]
            self.assertEqual(row['cases'][name], 'SKIP')
            self.assertIs(row['case_complete'][name], False)
            self.assertEqual(row['current_execution'][name], 'UNVERIFIED' if name in custody else 'UNEXECUTED')
        self.assertEqual(row['custody_skips'], custody)
        self.assertNotIn('agent-payment-abandonment', row['elected_skips'])

    def test_permanent_suite_is_registered_with_structural_gate(self):
        import ast
        tree = ast.parse((HERE / 'scripts/run-deploy-structural-gates.py').read_text())
        matches = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Name) and node.func.id == 'Gate'
                   and len(node.args) >= 2 and isinstance(node.args[0], ast.Constant)
                   and node.args[0].value == 'deploy-test-user-omission']
        self.assertEqual(len(matches), 1)
        self.assertEqual(ast.literal_eval(matches[0].args[1]),
                         ('python3', 'scripts/tests/deploy-test-user-omission.test.py'))

    def test_real_preallocation_admission_reconstructs_election_after_custody(self):
        self.state['resource_warnings'] = []
        self.assertEqual(self.cli(), 0)
        state = self.read()
        directory = self.root / '.context/cycle'; directory.mkdir(parents=True)
        self.put(directory / 'cycle.json', state)
        import deploy_test_historical_custody as h
        custody = {'agent-payment-abandonment': {'disposition': 'NO_RETRY_CUSTODY', 'source': self.source}}
        class CaptureBeforeTransport(Exception):
            pass
        with patch.object(h, 'known', return_value={}), patch.object(h, 'guard', return_value=custody), \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), \
             patch.object(c, 'isolated_request', return_value=[]), \
             patch.object(c, 'run_command', side_effect=CaptureBeforeTransport):
            with self.assertRaises(CaptureBeforeTransport):
                c._execute(self.plan['gates'][0], state, directory, self.root)
        request = json.loads((directory / 'attempts/4/triage/smoke/request.json').read_text())
        original = copy.deepcopy(state)
        with patch.object(h, 'guard', return_value=custody), \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), \
             patch.object(c, 'run_command') as transport:
            h.admission(request, self.root)  # Actual no-provider preallocation consumer.
            self.assertEqual(request['skips']['agent-payment-abandonment'], custody['agent-payment-abandonment'])
            for mutate in (lambda r: r['skips'].pop('agent-payment-test-shop'),
                           lambda r: r['checks'].append('agent-payment-test-shop'),
                           lambda r: r['skips'].update({'MASS-t7': {'disposition': 'user / overridden'}})):
                changed = copy.deepcopy(request); mutate(changed)
                with self.assertRaisesRegex(ValueError, 'admission inventory/qualification changed'):
                    h.admission(changed, self.root)
            with patch.object(h, 'guard', side_effect=ValueError('original custody invalid')):
                with self.assertRaisesRegex(ValueError, 'original custody invalid'):
                    h.admission(request, self.root)
            transport.assert_not_called()
        self.assertEqual(original, state)
        self.assertEqual(json.loads((directory / 'cycle.json').read_text()), original)

    def test_malformed_previous_election_is_typed_refusal_without_mutation(self):
        for previous in ([], {'request': []}):
            with self.subTest(previous=previous):
                self.reject(state={**self.state, 'user_elected_omissions': previous})

    def test_malformed_original_pagination_is_typed_refusal_without_mutation(self):
        proof, docs = self.bundle()
        docs['original_read']['transcript']['pagination'] = []
        path = Path(proof['original_read']['path']); self.put(path, docs['original_read'])
        proof['original_read']['sha256'] = self.sha(path)
        self.reject({**self.request, 'authority': proof})



    def broad_fixture(self):
        import deploy_test_user_omission as e
        self.plan['gates'] = self.plan['gates'][:1]
        self.fingerprints.pop('agentcard-lifecycle')
        extras = ['browser-auth-guest-purchase', 'browser-auth-member-discount-purchase']
        self.plan['gates'][0]['checks'] += extras
        self.state.update(plan=self.plan, plan_digest=c.digest(self.plan))
        self.put(self.plan_path, self.plan)
        self.request.update(plan_digest=c.digest(self.plan), input_fingerprints=self.fingerprints,
                            checks=[x for x in self.six if x.startswith('smoke/')])
        proof, _ = self.bundle()
        self.request['authority'] = proof
        self.assertEqual(self.cli(), 0)
        state = self.read()
        request = {k: copy.deepcopy(v) for k, v in self.request.items() if k != 'question_checks'}
        request.update(kind='explicit-paid-agentcard-prohibition-v1', checks=['smoke/' + x for x in extras],
                       catalog={k: self.sha(HERE / 'agents/benchmarks' / f) for k, f in
                                [('tasks_sha256', 'tasks.json'), ('local_sha256', 'local.py')]})
        return e, state, request, extras

    def test_broad_prohibition_real_native_consumer_preserves_original_election_and_custody(self):
        e, before, request, extras = self.broad_fixture()
        self.assertEqual(self.cli(request, before), 0)
        state = self.read()
        self.assertEqual(state['user_elected_omissions'], before['user_elected_omissions'])
        for key in ('pending', 'failures', 'attempts', 'historical_no_retry_custody', 'historical_custody_history'):
            self.assertEqual(state[key], before[key])
        record = state['user_paid_agentcard_prohibition']
        self.assertEqual(set(record['entries']), set(request['checks']))
        for row in record['entries'].values():
            self.assertEqual(row['native_result'], 'UNEXECUTED')
            self.assertEqual(row['status'], 'SKIP')
            self.assertFalse(any(row['credit'].values()))
            self.assertIs(row['executed'], False)
        import deploy_test_historical_custody as h
        custody = {'agent-payment-abandonment': {'disposition': 'NO_RETRY_CUSTODY', 'source': self.source}}
        directory = self.root / '.context/cycle'; directory.mkdir(parents=True)
        state['resource_warnings'] = []
        self.put(directory / 'cycle.json', state)
        class BeforeTransport(Exception): pass
        with patch.object(h, 'known', return_value={}), patch.object(h, 'guard', return_value=custody), \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), \
             patch.object(c, 'isolated_request', return_value=[]), \
             patch.object(c, 'run_command', side_effect=BeforeTransport):
            with self.assertRaises(BeforeTransport):
                c._execute(self.plan['gates'][0], state, directory, self.root)
        native = json.loads((directory / 'attempts/4/triage/smoke/request.json').read_text())
        self.assertEqual(native['checks'], ['browser-smoke', 'MASS-t7'])
        self.assertEqual(len(native['skips']), 7)
        self.assertEqual(native['skips']['agent-payment-abandonment'], custody['agent-payment-abandonment'])
        with patch.object(h, 'guard', return_value=custody), \
             patch.object(h, 'runtime_identity', return_value={}), \
             patch.object(h, 'environment_identity', return_value='fixture'), patch.object(c, 'run_command') as transport:
            h.admission(native, self.root)
            changed = copy.deepcopy(state)
            changed['user_paid_agentcard_prohibition']['request']['catalog']['tasks_sha256'] = '0' * 64
            self.put(directory / 'cycle.json', changed)
            with self.assertRaises(ValueError): h.admission(native, self.root)
            transport.assert_not_called()
        for field in ('user_elected_omissions', 'user_paid_agentcard_prohibition'):
            changed = copy.deepcopy(state)
            changed[field]['request']['source']['head'] = '9' * 40
            with self.assertRaises(ValueError): e.qualifications(changed, self.plan['gates'][0], {})

    def test_broad_prohibition_refuses_scope_catalog_authority_and_input_drift(self):
        e, state, request, extras = self.broad_fixture()
        self.assertEqual(self.cli(request, state), 0)
        for field, value in [('checks', request['checks'] + ['smoke/browser-smoke']),
                             ('checks', request['checks'] + ['smoke/browser-auth-signup-purchase']),
                             ('checks', request['checks'][:1]),
                             ('checks', request['checks'] + [request['checks'][0]]),
                             ('source', {'head': '9' * 40, 'digest': '8' * 64}),
                             ('catalog', {**request['catalog'], 'local_sha256': '0' * 64}),
                             ('authority', self.request['authority'] | {'kind': 'agent-assertion'}),
                             ('input_fingerprints', {'smoke': '0' * 64})]:
            with self.subTest(field=field, value=value): self.reject({**request, field: value}, state)
        self.reject({**self.request, 'checks': self.request['checks'] + request['checks']}, state)
        # Rehash an altered catalog: shape/predicate checks must refuse it, too.
        catalog_root = self.root / 'catalog'; folder = catalog_root / 'agents/benchmarks'; folder.mkdir(parents=True)
        (folder / 'local.py').write_bytes((HERE / 'agents/benchmarks/local.py').read_bytes())
        original = json.loads((HERE / 'agents/benchmarks/tasks.json').read_text())
        for mutate in (lambda t: t.update(tags=['browser', 'payment']),
                       lambda t: t.update(expected_payment_lifecycle={}),
                       lambda t: t.update(environment={'db_fixtures': []}),
                       lambda t: t.update(runner='mock'),
                       lambda t: t['expected_payment_lifecycle']['integrity'].update(cardCount=0)):
            tasks = copy.deepcopy(original)
            mutate(next(t for t in tasks if t['name'] == extras[0]))
            self.put(folder / 'tasks.json', tasks)
            changed = copy.deepcopy(request)
            changed['catalog']['tasks_sha256'] = self.sha(folder / 'tasks.json')
            with patch.object(e, 'CATALOG_ROOT', catalog_root): self.reject(changed, state)
        proof, docs = self.bundle()
        docs['continuation']['transcript']['messages'][0]['role'] = 'assistant'
        self.put(Path(proof['continuation']['path']), docs['continuation'])
        proof['continuation']['sha256'] = self.sha(Path(proof['continuation']['path']))
        self.reject({**request, 'authority': proof}, state)

    def test_broad_prohibition_explicit_source_renewal_preserves_both_ledgers_and_audit(self):
        e, before, request, extras = self.broad_fixture()
        self.assertEqual(self.cli(request, before), 0)
        original = self.read()
        # As with the original election, refresh preserves stale records and
        # default execution fails closed until each kind is explicitly renewed.
        self.source.update(head='9' * 40, digest='8' * 64)
        self.plan['source'] = self.source
        self.put(self.plan_path, self.plan)
        renewed = copy.deepcopy(original)
        renewed.update(source=self.source, plan=self.plan, plan_digest=c.digest(self.plan))
        with self.assertRaises(ValueError): e.verify(renewed)
        old_request = copy.deepcopy(self.request)
        old_request.update(source=self.source, plan_digest=c.digest(self.plan))
        self.assertEqual(self.cli(old_request, renewed), 0)
        halfway = self.read()
        with self.assertRaises(ValueError): c.revalidate_standing_skips(halfway)
        new_request = copy.deepcopy(request)
        new_request.update(source=self.source, plan_digest=c.digest(self.plan))
        self.assertEqual(self.cli(new_request, halfway), 0)
        final = self.read()
        e.verify(final)
        self.assertEqual(final['superseded_user_paid_agentcard_prohibition'],
                         [original['user_paid_agentcard_prohibition']])
        self.assertEqual(final['superseded_user_elected_omissions'], [original['user_elected_omissions']])
        for key in ('failures', 'pending', 'attempts', 'historical_no_retry_custody', 'historical_custody_history'):
            self.assertEqual(final[key], original[key])
        self.assertEqual(self.cli(new_request, final), 0)
        self.assertEqual(self.read(), final)
        # The later restriction is independent of whether an original question
        # happens to be selected. No occurrence-ID or fixed pair allowlist.
        standalone = copy.deepcopy(final)
        standalone.pop('user_elected_omissions')
        standalone.pop('user_paid_agentcard_prohibition')
        self.plan['gates'][0]['checks'] = extras + ['browser-smoke']
        standalone.update(plan=self.plan, plan_digest=c.digest(self.plan))
        self.put(self.plan_path, self.plan)
        new_request['plan_digest'] = c.digest(self.plan)
        self.assertEqual(self.cli(new_request, standalone), 0)
        e.verify(self.read())

    def test_null_or_nonobject_election_ledgers_refuse_before_projection_or_mutation(self):
        e, before, request, _ = self.broad_fixture()
        self.assertEqual(self.cli(request, before), 0)
        valid = self.read()
        for field in ('user_elected_omissions', 'user_paid_agentcard_prohibition'):
            for value in (None, [], 'invalid'):
                for consumer in ('verify', 'qualifications', 'report', 'elect'):
                    with self.subTest(field=field, value=value, consumer=consumer):
                        state = copy.deepcopy(valid)
                        state[field] = value
                        unchanged = copy.deepcopy(state)
                        with self.assertRaises(ValueError):
                            if consumer == 'verify': e.verify(state)
                            elif consumer == 'qualifications': e.qualifications(state, self.plan['gates'][0], {})
                            elif consumer == 'report': e.report_lines(state)
                            else:
                                with patch.object(c, 'source', return_value=self.source), \
                                     patch.object(c, 'environment_digest', return_value=self.environment), \
                                     patch.object(c, 'input_fingerprints', return_value=self.fingerprints), \
                                     patch.object(c, 'retained_owners', return_value=[]):
                                    e.elect(state, request, self.root)
                        self.assertEqual(state, unchanged)

if __name__ == '__main__':
    unittest.main()
