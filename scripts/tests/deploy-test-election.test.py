#!/usr/bin/env python3
"""Exercise optional selection through native refresh without task/cleanup credit."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('_deploy_cycle_fixture', ROOT / 'scripts/tests/deploy-test-cycle.test.py')
cycle_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle_fixture)
c = cycle_fixture.c

class AgentCardElection(unittest.TestCase):
    setUp = cycle_fixture.Cycle.setUp
    tearDown = cycle_fixture.Cycle.tearDown

    def card_plan(self):
        old = copy.deepcopy(self.plan)
        gate = copy.deepcopy(old['gates'][1])
        target = Path(self.workers.name) / 'card'
        target.mkdir(exist_ok=True)
        gate.update(name='agentcard-lifecycle', category='agentcard-lifecycle', worker='card-worker',
                    cwd=str(target), worker_root=str(target), checks=['agentcard-lifecycle'],
                    env={'CONDUCTOR_WORKSPACE_NAME':'card', 'CONDUCTOR_PORT':'36000'})
        old['gates'].append(gate)
        state = c.initialize(old, self.root)
        state.update(phase='triage', ready=False)
        new = copy.deepcopy(old)
        new['gates'] = [g for g in new['gates'] if g['name'] != 'agentcard-lifecycle']
        new['omitted'] = [{'gate':'agentcard-lifecycle', 'category':'agentcard-lifecycle',
                          'reason':'explicit AgentCard opt-out: operator browser-only deployment',
                          'disposition':'SKIPPED', 'executed':False}]
        return old, new, state

    def test_explicit_unstarted_optional_election_preserves_cycle_and_other_coverage(self):
        old, new, state = self.card_plan()
        original = copy.deepcopy(state)
        c.refresh(state, old, new, self.root)
        self.assertEqual(state['round'], original['round'])
        self.assertEqual(state['attempts'], original['attempts'])
        self.assertEqual(state['failures'], original['failures'])
        self.assertEqual(len(state['plan']['gates']), len(old['gates']) - 1)
        self.assertFalse(state['elected_omissions'][0]['test_credit'])
        self.assertFalse(state['elected_omissions'][0]['cleanup_credit'])
        self.assertEqual(state['elected_omissions'][0]['native_result'], 'UNEXECUTED')

    def test_unexplained_optional_removal_still_rejects(self):
        old, new, state = self.card_plan()
        new['omitted'][0]['reason'] = 'make failing tests disappear'
        with self.assertRaises(ValueError):
            c.refresh(state, old, new, self.root)

    def test_non_optional_gate_cannot_be_removed_by_election(self):
        old, new, state = self.card_plan()
        new['gates'] = [g for g in new['gates'] if g['name'] != 'api']
        with self.assertRaises(ValueError):
            c.refresh(state, old, new, self.root)

    def test_started_optional_gate_cannot_discard_unknown_owner(self):
        old, new, state = self.card_plan()
        state['attempts'].append({'phase':'initial','results':[{'gate':'agentcard-lifecycle',
            'source':state['source'], 'token':'original-token', 'complete':False,
            'cleanup_owner':{'unknown':'owner'}, 'cases':{'agentcard-lifecycle':'UNVERIFIED'}}]})
        original = copy.deepcopy(state)
        with self.assertRaises(ValueError):
            c.refresh(state, old, new, self.root)
        self.assertEqual(state, original)

    def started_fixture(self):
        old, new, state = self.card_plan()
        receipt = {'gate':'agentcard-lifecycle', 'source':state['source'], 'token':'original-token',
                   'complete':False, 'cases':{'agentcard-lifecycle':'UNVERIFIED'}}
        state['attempts'].append({'phase':'initial', 'results':[receipt]})
        failure = {'id':'card-error', 'gate':'agentcard-lifecycle', 'check':'agentcard-lifecycle',
                   'source':state['source'], 'command':['original', 'command'], 'native_result':'UNVERIFIED'}
        other = {**failure, 'id':'api-error', 'gate':'api', 'check':'a'}
        state.update(failures=[failure, other], pending=['card-error','api-error'],
                     repair_gates=['api','agentcard-lifecycle'],
                     reconciled_owners={'historical':{'original':'custody'}})
        proof = {'rca':[{**failure, 'attribution':'NOT_INTRODUCED',
                         'description':'Original unchanged failure', 'evidence':'captured native error'}]}
        return old, new, state, proof

    def test_started_selection_keeps_receipts_owners_and_native_failure(self):
        import deploy_test_election as election
        old, new, state, proof = self.started_fixture()
        original = copy.deepcopy(state)
        # Boundary validation has its own source-bound native replay; this exercises
        # refresh routing after valid custody, including the remaining failure.
        with patch.object(election, 'validate_custody'):
            c.refresh(state, old, new, self.root, election_proof=proof)
        self.assertEqual(state['attempts'], original['attempts'])
        self.assertEqual(state['reconciled_owners'], original['reconciled_owners'])
        self.assertEqual(state['pending'], ['api-error'])
        self.assertEqual(state['failures'][0]['native_result'], 'UNVERIFIED')
        self.assertEqual(state['failures'][0]['disposition'], election.DISPOSITION)
        self.assertNotIn('agentcard-lifecycle', state['repair_gates'])
        with patch.object(election, 'validate_custody'):
            self.assertIn('operational custody acceptance', election.completion_block(state))

    def test_started_election_rejects_changed_attribution_waivers_and_assigned_repairs(self):
        import deploy_test_election as election
        mutations = [lambda s,p:p['rca'][0].update(attribution='INTRODUCED'),
                     lambda s,p:p['rca'][0].update(command=['replacement']),
                     lambda s,p:p['rca'][0].update(repair_agent='https://boxes.dev/thread/another'),
                     lambda s,p:p['rca'][0].update(post_merge=True),
                     lambda s,p:p['rca'][0].update(assigned_repair=True),
                     lambda s,p:s['failures'][0].update(rca={'assigned_repair':True})]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                old, new, state, proof = self.started_fixture()
                mutate(state, proof)
                original = copy.deepcopy(state)
                with patch.object(election, 'validate_custody'), self.assertRaises(ValueError):
                    c.refresh(state, old, new, self.root, election_proof=proof)
                self.assertEqual(state, original)

    def test_custody_acceptance_requires_actual_other_box_and_exact_original_debt(self):
        import deploy_test_election as election
        archive = self.root / 'archive.json'
        archive.write_text(json.dumps({'key':'devbox-closeout-private/original', 'ciphertext_sha256':'f'*64}))
        acceptance = self.root / 'acceptance.json'
        platform = self.root / 'platform.json'
        obligations = [{'transfer_id':'original-transfer', 'amount_cents':4396}]
        original = {'archive':str(archive), 'originating_devbox':'source-box', 'obligations':obligations}
        state = {'elected_omissions':[{'proof':original}]}
        value = {'custodian_devbox':'other-box', 'thread_url':'https://boxes.dev/thread/custodian',
                 'obligations':obligations, 'archive_key':'devbox-closeout-private/original',
                 'ciphertext_sha256':'f'*64, 'financial_cleanup_verified':False, 'test_credit':False,
                 'continuing_parent_accountability':True, 'independent_archive_recovery_verified':True}
        def prepare(value):
            acceptance.write_text(json.dumps(value))
            digest = election.sha(acceptance)
            platform.write_text(json.dumps({'ok':True, 'data':{'status':'completed', 'completedAt':1,
                'executionInstanceId':value['custodian_devbox'],
                'output':{'text':'OPERATIONAL_CUSTODY_ACCEPTED_SHA256 ' + digest}}}))
            return {'acceptance':str(acceptance), 'acceptance_sha256':digest,
                    'platform_result':str(platform), 'platform_result_sha256':election.sha(platform),
                    'originating_devbox':'source-box', 'custody_link':value['thread_url']}
        for changed in ({'custodian_devbox':'source-box'}, {'obligations':[]},
                        {'financial_cleanup_verified':True}, {'test_credit':True},
                        {'independent_archive_recovery_verified':False}):
            proof = prepare({**value, **changed})
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                election.accept(copy.deepcopy(state), proof)
        proof = prepare(value)
        election.accept(state, proof)
        self.assertEqual(state['elected_omissions'][0]['accepted_custody'], proof)
        acceptance.write_text('{}')
        with self.assertRaises(ValueError):
            election.accept({'elected_omissions':[{'proof':original}]}, proof)

if __name__ == '__main__': unittest.main()
