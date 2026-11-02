#!/usr/bin/env python3
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_test_plan as p


class Selection(unittest.TestCase):
    def setUp(self):
        self.template = {'gates': [
            {'name':'lint','category':'eslint','command':['true'],'checks':['lint']},
            {'name':'be','category':'backend-coverage-blackbox','command':['true'],'checks':['be']},
            {'name':'fe','category':'frontend-coverage-blackbox','command':['true'],'checks':['fe']},
            {'name':'smoke','category':'smoke','command':['true'],'checks':['smoke']},
        ] + [{'name':name,'category':name,'command':['true'],'checks':[name]}
             for name in ('format','typescript','backend-structural')]}
        self.workers = tempfile.TemporaryDirectory()
        self.bindings = {n:{'id':n+'-isolated','command':['true'],
                           'transport':'local-isolated',
                           'cwd':str(Path(self.workers.name)/n),
                           'env':{'CONDUCTOR_WORKSPACE_NAME':n,
                                  'CONDUCTOR_PORT':str(12000+i*12000)}}
                         for i,n in enumerate(['be','fe','smoke'])}
        self.bindings['smoke'].update(transport='benchmark-cloud-cli',
                                     command=['bash','scripts/run-predeploy-cloud'])
        self.result = {'all':False,'reasons':[], 'lanes':{'backend-unit':['test-one'],'frontend-vitest':[]}}
        self.mock = patch.object(p,'source',return_value={'head':'fixed','digest':'fixed'});self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.workers.cleanup()

    def test_untouched_frontend_omitted(self):
        plan=p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)
        self.assertEqual({'lint','be','smoke','format','typescript','backend-structural'},
                         {x['name'] for x in plan['gates']})
        self.assertEqual('fe',plan['omitted'][0]['gate'])

    def test_api_change_can_select_frontend_via_graph(self):
        self.result['lanes']['frontend-vitest']=['contract-consumer']
        plan=p.select(self.template,['back-end/src/router.ts'],self.result,self.bindings)
        self.assertIn('fe',[x['name'] for x in plan['gates']])

    def test_unknown_source_selects_all(self):
        self.result.update(all=True,reasons=['unmapped source'])
        plan=p.select(self.template,['new-language/source'],self.result,self.bindings)
        self.assertEqual(7,len(plan['gates']))

    def test_documentation_only_keeps_quick_phase(self):
        self.result['lanes']['backend-unit']=[]
        plan=p.select(self.template,['docs/guide.md'],self.result,self.bindings)
        self.assertEqual(['lint','format','typescript','backend-structural'],[x['name'] for x in plan['gates']])

    def test_cloud_smoke_required(self):
        self.bindings['smoke']['transport']='local'
        with self.assertRaisesRegex(ValueError,'cloud benchmark'):
            p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)

    def test_missing_worker_fails_before_any_execution(self):
        del self.bindings['be']
        with self.assertRaisesRegex(ValueError,'worker binding missing'):
            p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)

    def test_worker_identity_is_required_with_a_clear_refusal(self):
        del self.bindings['be']['id']
        with self.assertRaisesRegex(ValueError,'worker binding requires an id'):
            p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)

    def test_case_recipe_is_bound_into_plan(self):
        self.bindings['be'].update(recipe={'cases':{'be':{'command':['true']}}},
                                   result_transport='stdout',timeout_seconds=10)
        plan=p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)
        gate=next(g for g in plan['gates'] if g['name']=='be')
        self.assertTrue(gate['case_protocol'])
        self.assertEqual('stdout',gate['result_transport'])
        self.assertEqual({'be'},set(gate['worker_recipe']['cases']))

    def test_recipe_cannot_replace_full_gate_inventory(self):
        self.bindings['be']['recipe']={'cases':{'other':{'command':['true']}}}
        with self.assertRaisesRegex(ValueError,'full registered'):
            p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)

    def test_selection_removes_artificial_cross_gate_ordering(self):
        self.template['gates'][1]['after']=['lint','smoke']
        plan=p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)
        self.assertTrue(all(not x.get('after') for x in plan['gates']))

    def test_new_category_cannot_silently_disappear(self):
        self.template['gates'].append({'name':'new','command':['true'],'checks':['new']})
        self.bindings['new']={'id':'new-worker','command':['true'],
            'transport':'local-isolated','cwd':str(Path(self.workers.name)/'new'),
            'env':{'CONDUCTOR_WORKSPACE_NAME':'new','CONDUCTOR_PORT':'48000'}}
        plan=p.select(self.template,['docs/guide.md'],self.result,self.bindings)
        self.assertIn('new',[x['name'] for x in plan['gates']])

    def test_inventory_generates_the_original_full_command(self):
        from deploy_test_bindings import generate
        inventory={'be':{'id':'be-worker','transport':'local-isolated',
            'worker_root':str(Path(self.workers.name)/'be'),'timeout_seconds':60,
            'env':{'CONDUCTOR_WORKSPACE_NAME':'be','CONDUCTOR_PORT':'12000'}}}
        bindings=generate(self.template,inventory,p.ROOT)
        recipe=bindings['be']['recipe']['cases']['be']
        self.assertEqual(self.template['gates'][1]['command'],recipe['command'])
        self.assertTrue(recipe['aggregate'])
        self.assertIn('--stdio',bindings['be']['command'])

    def test_ssh_inventory_is_refused_until_a_remote_cancel_path_exists(self):
        from deploy_test_bindings import generate  # finding 4447557475: no remote cancel/cleanup over ssh
        inventory={'be':{'id':'be-worker','transport':'ssh','worker_host':'test-worker',
                         'worker_root':'/prepared source'}}
        with self.assertRaisesRegex(ValueError,'be: ssh transport has no remote cancel/cleanup path'):
            generate(self.template,inventory,p.ROOT)
        boxes={'be':{'id':'be-worker','transport':'boxes-thread','worker_thread':'ph-a','worker_host':'devbox-a',
                     'coordinator_thread':'ph-c','worker_root':'/prepared source','timeout_seconds':60,
                     'env':{'CONDUCTOR_WORKSPACE_NAME':'be','CONDUCTOR_PORT':'12000'}}}
        self.assertEqual('--thread',generate(self.template,boxes,p.ROOT)['be']['command'][2])

    def test_native_cloud_binding_preserves_each_task_in_the_plan(self):
        from deploy_test_bindings import generate
        self.template['gates'][3].update(native_cloud=True,case_protocol=True,checks=['task-a','task-b'])
        self.bindings.update(generate(self.template,{'smoke':{'id':'smoke',
            'transport':'benchmark-cloud-cli'}},p.ROOT))
        planned=p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)
        smoke=next(g for g in planned['gates'] if g['name']=='smoke')
        self.assertEqual(['task-a','task-b'],smoke['checks'])
        self.assertTrue(smoke['case_protocol'])
        self.assertEqual(str(p.ROOT/'scripts/deploy_test_cloud.py'),smoke['command'][1])

    def test_standard_template_runs_actual_cold_seed_measurement(self):
        gate = next(g for g in p.standard_template()['gates']
                    if g['name'] == 'seed-memory-ratchet')
        self.assertEqual(['bash','scripts/measure-seed-memory.sh','5','0','0',
                          '--enforce-budget'],gate['command'])
        self.assertEqual('back-end',gate['cwd'])


if __name__=='__main__':unittest.main()
