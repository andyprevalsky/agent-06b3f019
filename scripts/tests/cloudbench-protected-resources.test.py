#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('protections', Path(__file__).resolve().parents[1]/'cloudbench-protected-resources.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProtectionUnion(unittest.TestCase):
    MID = '84910df24d2168'
    VOL = 'vol_458oyxl95o057jj4'

    def candidate(self):
        return dict(id=self.MID, name='retained-original', config=dict(mounts=[dict(volume=self.VOL)]))

    def test_actual_retained_v41_identity_cannot_fall_outside_old_roster(self):
        old = ('old19', {'identities': [dict(machine_id='11111111111111')]})
        current = ('V41', {'matches': [dict(machine=self.MID, volume=self.VOL,
                   cleanup_policy='retain', latches={'runtime-evidence-unconfirmed': True})]})
        self.assertEqual(m.select([self.candidate()], m.combine([old])), [self.candidate()])
        self.assertEqual(m.select([self.candidate()], m.combine([old, current])), [])

    def test_conflicting_reap_record_never_cancels_retain(self):
        rows = [dict(machine=self.MID, cleanup_policy=p, latches={}) for p in ('retain', 'reap')]
        for order in (rows, rows[::-1]):
            self.assertEqual(m.select([self.candidate()], m.combine([('conflict', {'matches': order})])), [])

    def test_heterogeneous_sources_include_volume_and_incomplete_owner(self):
        sources = [('old', {'kind':'historical-retain-policy-owner-clones', 'clones':[{'clone':{'recorded_volume':self.VOL}}]}),
                   ('ledger', {'owners':[{'clones':[{'recorded_id':self.MID}]}]})]
        protection = m.combine(sources)
        self.assertIn(self.VOL, protection['volumes'])
        self.assertIn(self.MID, protection['machines'])
        self.assertFalse(protection['admission_authorized'])

    def test_raw_registry_and_claim_hold_are_exclusions(self):
        prefix = 'git-common/cloudbench-fleet-ownership/owner'
        raw = {prefix+'/meta':'cleanup_policy=retain\n', prefix+'/clones/one':f'machine_id={self.MID}\nvolume_id={self.VOL}\n',
               'git-common/cloudbench-pool-claims/22222222222222':'owner=active\n'}
        result = m.combine([('raw', raw)])
        self.assertEqual(result['machines'], ['22222222222222', self.MID])

    def test_durable_json_claim_and_outgoing_handoff_are_exclusions(self):
        import json
        claim = json.dumps(dict(machine_id=self.MID, volume_id=self.VOL, state='PENDING',
                                target=dict(pool_name='p')), sort_keys=True, separators=(',', ':'))+'\n'
        hold = json.dumps(dict(volume_id='vol_outgoing1'))+'\n'
        raw = {'git-common/cloudbench-pool-claims/'+self.MID: claim,
               'git-common/cloudbench-cold-handoffs/outgoing/33333333333333': hold}
        result = m.combine([('raw', raw)])
        self.assertEqual(result['machines'], ['33333333333333', self.MID])
        self.assertEqual(result['volumes'], [self.VOL, 'vol_outgoing1'])
        with self.assertRaises(ValueError):
            m.combine([('raw', {'git-common/cloudbench-pool-claims/'+self.MID: '{"machine_id": '})])

    def test_missing_or_unrecognized_source_refuses_and_latch_protects(self):
        with self.assertRaises(ValueError):m.combine([('unknown', {})])
        x={'owners':[dict(cleanup_policy='reap', latches={'recovery-lock':True}, clones=[dict(recorded_id=self.MID)])]}
        self.assertIn(self.MID, m.combine([('ledger', x)])['machines'])

    def test_raw_id_alias_and_nested_recovery_or_outgoing_hold(self):
        prefix = 'git-common/cloudbench-fleet-ownership/owner'
        for hold in ('recovery-lock/meta', 'cold-handoff-outgoing/intent'):
            raw = {prefix+'/meta':'cleanup_policy=reap\n', prefix+'/clones/one':f'id={self.MID}\n', prefix+'/'+hold:'state=pending\n'}
            self.assertIn(self.MID, m.combine([('raw', raw)])['machines'])

    def test_duplicate_policy_and_malformed_fields_refuse(self):
        prefix = 'git-common/cloudbench-fleet-ownership/owner'
        for meta in ('cleanup_policy=retain\ncleanup_policy=reap\n', 'cleanup_policy=reap\nbad-line\n'):
            raw = {prefix+'/meta':meta, prefix+'/clones/one':f'id={self.MID}\n'}
            with self.assertRaises(ValueError):m.combine([('raw', raw)])


if __name__ == '__main__':unittest.main()
