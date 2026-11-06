#!/usr/bin/env python3
import copy
import io
import json
import os
import subprocess
from types import SimpleNamespace
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
        self.result = {'all':False,'reasons':[],
                       'lanes':{lane: [] for lanes in p.GRAPH_LANES.values() for lane in lanes}}
        self.result['lanes']['backend-unit'] = ['test-one']
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

    def test_agentcard_is_not_a_gate_category_and_cannot_be_elected_away(self):
        # The AgentCard lifecycle tasks are ordinary smoke tasks (agents/benchmarks/tasks.json tag smoke):
        # there is no agentcard-lifecycle gate, path rule or opt-out; production keeps its own lane.
        self.assertNotIn('agentcard-lifecycle',p.PATHS)
        self.assertFalse(hasattr(p,'PATH_EXCLUDES'))
        for argv in (['--list-selected','--skip-agentcard','no card'],
                     ['--inventory','i.json','--output','o.json','--skip-agentcard','no card']):
            with self.subTest(argv=argv), patch('sys.stderr',io.StringIO()), \
                    self.assertRaises(SystemExit) as caught:
                p.main(argv)
            self.assertEqual(2,caught.exception.code)

    def test_selection_only_matches_the_bound_selection_without_worker_checks(self):
        self.template['gates'].append({'name':'mac','category':'mac-app-coverage-blackbox','platform':'other-os',
                                      'command':['true'],'checks':['mac']})
        bound=p.select(self.template,['back-end/src/one.ts'],self.result,self.bindings)
        with patch.object(p,'validate_plan',side_effect=AssertionError('selection-only must not validate')), \
                patch.object(p,'source',side_effect=AssertionError('selection-only must not hash source')):
            unbound=p.select(self.template,['back-end/src/one.ts'],self.result,None)
        self.assertEqual([g['name'] for g in bound['gates']],[g['name'] for g in unbound['gates']])
        self.assertEqual(bound['omitted'],unbound['omitted'])
        self.assertEqual('mac',unbound['omitted'][-1]['gate'])
        self.assertTrue(all('worker' not in g for g in unbound['gates']))
        self.assertIsNone(unbound['source'])
        with self.assertRaisesRegex(ValueError,'worker binding missing'):
            p.select(self.template,['back-end/src/one.ts'],self.result,{})

    def test_cli_list_selected_prints_selection_without_bindings_or_output(self):
        with tempfile.TemporaryDirectory() as folder:
            template=Path(folder)/'template.json'; template.write_text(json.dumps(self.template))
            selected=SimpleNamespace(all_lanes=False,reasons=[],selected=self.result['lanes'])
            out=io.StringIO()
            with patch.object(p,'changed_files',return_value=['back-end/src/one.ts']) as changed, \
                    patch.object(p.Selector,'select',return_value=selected), \
                    patch.object(p,'generate_bindings',side_effect=AssertionError('no bindings in list mode')), \
                    patch('sys.stdout',out):
                self.assertEqual(0,p.main(['--template',str(template),'--list-selected','--base','review-base']))
            changed.assert_called_once_with('review-base',None)
            self.assertEqual(['template.json'],[x.name for x in Path(folder).iterdir()])
        listed=json.loads(out.getvalue())
        self.assertEqual(['lint','be','smoke','format','typescript','backend-structural'],listed['selected'])
        self.assertEqual(['lint','format','typescript','backend-structural'],listed['quick'])
        self.assertEqual(['be','smoke'],listed['needs_worker'])
        self.assertEqual(['fe'],[o['gate'] for o in listed['omitted']])

    def test_cli_requires_bindings_and_output_outside_list_mode(self):
        for argv in (['--output','plan.json'],['--workers','w.json'],['--list-selected','--workers','w.json'],
                     ['--list-selected','--output','plan.json'],['--workers','w.json','--inventory','i.json',
                     '--output','plan.json']):
            with self.subTest(argv=argv), patch('sys.stderr',io.StringIO()), \
                    self.assertRaises(SystemExit) as caught:
                p.main(argv)
            self.assertEqual(2,caught.exception.code)

    def test_unknown_graph_lane_refuses_selection_instead_of_silently_omitting_coverage(self):
        del self.result['lanes']['backend-blackbox']
        for all_lanes in (False, True):
            with self.subTest(all_lanes=all_lanes):
                self.result['all'] = all_lanes
                with self.assertRaisesRegex(ValueError, "be: graph lane 'backend-blackbox' is not defined"):
                    p.select(self.template, ['docs/guide.md'], self.result, self.bindings)

    def test_both_native_planning_children_have_a_finite_observation_bound(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); scripts = root / 'scripts'; scripts.mkdir()
            pipeline = scripts / 'run_deploy_pipeline.py'
            smoke = scripts / 'run-predeploy-cloud'
            for blocked_child in ('plan', 'smoke'):
                with self.subTest(blocked_child=blocked_child):
                    pipeline.write_text(
                        'import json,time\n' + ('time.sleep(2)\n' if blocked_child == 'plan' else '')
                        + 'print(json.dumps({"lanes":[{"name":"smoke","command":["original-smoke"]}]}))\n')
                    smoke.write_text(
                        'exec ' + sys.executable + " -c 'import time; time.sleep(2); print(\"original-task\")'\n"
                        if blocked_child == 'smoke' else "printf 'original-task\\n'\n")
                    with patch.object(p, 'ROOT', root), patch.object(
                            p, 'PLANNING_TIMEOUT_SECONDS', 0.05, create=True):
                        with self.assertRaises(subprocess.TimeoutExpired):
                            p.standard_template()

    def test_e2b_smoke_is_selected_on_every_deploy_with_recorded_reason(self):
        # Original /deploy 6c (deploy.md L2226): the Claude Code E2B smoke runs on every deploy.
        self.template['gates'].append({'name':'e2b-smoke','category':'e2b-smoke','command':['true'],
                                      'checks':['e2b-smoke']})
        self.bindings['e2b-smoke']={'id':'e2b-worker','command':['true'],'transport':'local-isolated',
            'cwd':str(Path(self.workers.name)/'e2b'),
            'env':{'CONDUCTOR_WORKSPACE_NAME':'e2b','CONDUCTOR_PORT':'36000'}}
        self.result['lanes']['backend-unit']=[]
        for changed in (['docs/guide.md'],['mac-app/main/index.ts'],['agents/benchmarks/history/task_attempts.jsonl'],[]):
            for binding in (self.bindings, None):
                with self.subTest(changed=changed, bound=binding is not None):
                    plan=p.select(self.template,changed,self.result,binding)
                    gate=next((g for g in plan['gates'] if g['name']=='e2b-smoke'),None)
                    self.assertIsNotNone(gate,plan['omitted'])
                    self.assertFalse(gate['quick'])
                    self.assertIn(p.ALWAYS['e2b-smoke'],gate['selection_evidence'])
        self.assertIn('every deploy',p.ALWAYS['e2b-smoke'])

    def test_agentcard_payment_paths_select_the_cloud_smoke_gate_that_carries_its_tasks(self):
        # Every path the retired AgentCard lane triggered on (original /deploy CHANGED_AGENTCARD_PAYMENT,
        # deploy.md L516) still selects the gate that now runs those four tasks: cloud smoke.
        self.result['lanes']['backend-unit']=[]
        triggers=['back-end/scripts/setup-benchmark-payment.ts',
                  'back-end/src/domains/agentcard/service.ts','back-end/src/domains/purchases/router.ts',
                  'back-end/src/domains/test-payment/router.ts',
                  'back-end/src/providers/agentcard/client.ts','back-end/src/providers/card-provider/index.ts',
                  'back-end/src/providers/purchaseCleanup.ts','back-end/src/providers/purchase-wallet-funding.ts',
                  'back-end/src/providers/purchase-wallet-funding-retry.ts','back-end/src/providers/wallet-funding.ts',
                  'back-end/prisma/schema.prisma',
                  'agents/benchmarks/run_benchmark.py','agents/benchmarks/tasks.json',
                  'agents/domains/request_payment_card/flow.py','agents/tools/request_payment_card.py',
                  'front-end/src/features/test-payment/Page.tsx',
                  'scripts/run.sh','scripts/run-agentcard-lifecycle-task.sh']
        for path in triggers:
            with self.subTest(path=path):
                plan=p.select(self.template,[path],self.result,None)
                self.assertIn('smoke',[g['name'] for g in plan['gates']],path)
        plan=p.select(self.template,['docs/guide.md'],self.result,None)
        self.assertIn('smoke',[o['gate'] for o in plan['omitted']])

    def test_standard_template_has_no_agentcard_lane_and_smoke_checks_are_the_selector_inventory(self):
        smoke_tasks='agent-payment-test-shop\nagent-payment-setup-resume\nagent-payment-idempotent-abandonment\n'\
                    'agent-payment-abandonment\nchat-mode\n'
        with patch.object(p.subprocess,'run') as execute:
            execute.side_effect=[SimpleNamespace(stdout=json.dumps({'lanes':[{'name':'smoke','command':['x']}]})),
                                 SimpleNamespace(stdout=smoke_tasks)]
            gates={g['name']:g for g in p.standard_template()['gates']}
        planner=execute.call_args_list[0].args[0]
        self.assertEqual('plan',planner[2])
        self.assertNotIn('--agentcard',planner)
        self.assertEqual(['bash','scripts/run-predeploy-cloud','--list'],execute.call_args_list[1].args[0])
        self.assertNotIn('agentcard-lifecycle',gates)
        self.assertEqual(smoke_tasks.split(),gates['smoke']['checks'])
        self.assertTrue(gates['smoke']['native_cloud'])

    def test_mac_app_static_is_a_conditional_quick_check_never_a_platform_pass(self):
        # Original /deploy Step 4m-lint (deploy.md L1380-1388): run when mac-app/ changed.
        gate = p.MAC_APP_STATIC
        self.assertEqual(['bash','-c','npm run format:check && npm run lint && npm run type-check'],gate['command'])
        self.assertEqual(('mac-app','darwin','mac-app-static'),(gate['cwd'],gate['platform'],gate['category']))
        import deploy_test_cycle
        self.assertIn('mac-app-static',deploy_test_cycle.QUICK)
        self.assertNotIn('mac-app-static',deploy_test_cycle.REQUIRED_QUICK)
        self.assertEqual({'mac-app-static'},p.CONDITIONAL_QUICK)
        self.template['gates'].append(copy.deepcopy(gate))
        self.result['lanes']['backend-unit']=[]
        for platform in ('darwin','linux'):
            with self.subTest(platform=platform), patch.object(p.sys,'platform',platform):
                for binding in (self.bindings, None):
                    untouched=p.select(self.template,['docs/guide.md'],self.result,binding)
                    self.assertNotIn('mac-app-static',[g['name'] for g in untouched['gates']])
                    entry=next(o for o in untouched['omitted'] if o['gate']=='mac-app-static')
                    self.assertEqual('no dependency or runtime-path trigger',entry['reason'])
                    changed=p.select(self.template,['mac-app/main/index.ts'],self.result,binding)
                    names=[g['name'] for g in changed['gates']]
                    if platform=='darwin':
                        static=next(g for g in changed['gates'] if g['name']=='mac-app-static')
                        self.assertTrue(static['quick'])
                        self.assertNotIn('worker',static)
                        self.assertIn('runtime/contract path trigger',static['selection_evidence'])
                        self.assertNotIn('mandatory quick check',static['selection_evidence'])
                        self.assertEqual(600,static['timeout_seconds'])
                    else:
                        self.assertNotIn('mac-app-static',names)
                        entry=next(o for o in changed['omitted'] if o['gate']=='mac-app-static')
                        self.assertEqual({'disposition':'PLATFORM_OMITTED','executed':False,
                                          'reason':'platform not available; not a test pass'},
                                         {k:entry[k] for k in ('disposition','executed','reason')})
                        self.assertIn('runtime/contract path trigger',entry['selection_evidence'])
                    # The required quick set is unchanged either way.
                    self.assertTrue({'lint','format','typescript','backend-structural'} <= set(names))
                self.result.update(all=True,reasons=['unmapped source'])
                every=p.select(self.template,['new-language/source'],self.result,None)
                self.assertEqual(platform=='darwin','mac-app-static' in [g['name'] for g in every['gates']])
                self.result.update(all=False,reasons=[])

    def test_standard_template_registers_the_mac_app_static_gate(self):
        with patch.object(p.subprocess,'run') as execute:
            execute.side_effect=[SimpleNamespace(stdout=json.dumps({'lanes':[]})),SimpleNamespace(stdout='task-a\n')]
            gates={g['name']:g for g in p.standard_template()['gates']}
        self.assertEqual(p.MAC_APP_STATIC,gates['mac-app-static'])

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

    def test_local_inventory_normalizes_roots_but_remote_and_relative_roots_keep_their_contract(self):
        from deploy_test_bindings import generate
        actual = Path(self.workers.name) / 'actual'
        actual.mkdir()
        alias = Path(self.workers.name) / 'alias'
        alias.symlink_to(actual, target_is_directory=True)
        for native in (False, True):
            template = copy.deepcopy(self.template)
            template['gates'][1]['native_backend'] = native
            for location in (str(actual) + '/', str(alias)):
                with self.subTest(native=native, location=location):
                    slot = {'id': 'be-worker', 'transport': 'local-isolated', 'worker_root': location,
                            'recipe': {'cases': {'be': {'command': ['true']}}},
                            'env': {'CONDUCTOR_WORKSPACE_NAME': 'be', 'CONDUCTOR_PORT': '12000'}}
                    with patch('deploy_test_backend.sweep_from_recipe'):
                        binding = generate(template, {'be': slot}, p.ROOT)['be']
                    self.assertEqual(str(actual), binding['worker_root'])
                    self.assertEqual(str(actual), binding['cwd'])
                    self.assertEqual(str(actual), binding['command'][binding['command'].index('--root') + 1])
                    self.assertEqual(location, slot['worker_root'])
            slot['worker_root'] = 'relative-worker'
            with self.assertRaisesRegex(ValueError, 'must be absolute'):
                generate(template, {'be': slot}, p.ROOT)
        remote = {**slot, 'transport': 'boxes-thread', 'worker_root': str(alias),
                  'worker_thread': 'ph-fixture', 'worker_host': 'remote-fixture',
                  'coordinator_thread': 'ph-coordinator', 'timeout_seconds': 60}
        binding = generate(self.template, {'be': remote}, p.ROOT)['be']
        self.assertEqual(str(alias), binding['worker_root'])
        self.assertEqual(str(alias), binding['command'][binding['command'].index('--worker-root') + 1])

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


    def test_custom_planner_base_reaches_both_real_static_checks(self):
        import check_deploy_static as quick
        import select_affected_tests as selector
        root = Path(self.workers.name) / 'base-fixture'; root.mkdir()
        def git(*args):
            return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True).stdout
        git('init', '-q')
        (root / '.gitignore').write_text('**/node_modules/\n')
        source = root / 'back-end/src/a.ts'; source.parent.mkdir(parents=True); source.write_text('before')
        git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'base')
        git('branch', 'review-base'); source.write_text('after')
        git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'head')
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        tools = root / 'node_modules/.bin'; tools.mkdir(parents=True)
        for name in ('prettier', 'node'):
            tool = tools / name; tool.write_text('#!' + sys.executable + '\nraise SystemExit(7)\n'); tool.chmod(0o700)
        template = copy.deepcopy(self.template)
        for gate in template['gates']:
            if gate['category'] in ('eslint', 'format'):
                gate['command'] = [sys.executable, 'scripts/check_deploy_static.py',
                                   'lint' if gate['category'] == 'eslint' else 'format']
        folder = Path(self.workers.name)
        tpl, bindings, output = (folder / name for name in ('template.json', 'workers.json', 'plan.json'))
        tpl.write_text(json.dumps(template)); bindings.write_text(json.dumps(self.bindings))
        selected_lanes = {lane: set() for lanes in p.GRAPH_LANES.values() for lane in lanes}
        selected_lanes['backend-unit'] = {'one'}
        selected = SimpleNamespace(all_lanes=False, reasons=[], selected=selected_lanes)
        with patch.object(p, 'ROOT', root), patch.object(selector, 'ROOT', root), \
                patch.object(quick, 'ROOT', root), patch.object(p, 'Selector') as factory, \
                patch.dict(os.environ, {'DEPLOY_BASE_REF': 'origin/main',
                                       'PATH': str(tools) + os.pathsep + os.environ['PATH']}):
            factory.return_value.select.return_value = selected
            with patch.object(sys, 'argv', ['plan', '--base', 'review-base', '--template', str(tpl),
                                           '--workers', str(bindings), '--output', str(output)]):
                self.assertEqual(0, p.main())
            plan = json.loads(output.read_text())
            for gate in plan['gates']:
                if gate['category'] in ('eslint', 'format'):
                    with patch.object(sys, 'argv', gate['command'][1:]):
                        self.assertEqual(7, quick.main(), gate['category'])
                    self.assertEqual(['--base', 'review-base'], gate['command'][-2:])
            self.assertEqual('review-base', plan['base'])
            self.assertEqual(['back-end/src/a.ts'], plan['changed_files'])


if __name__=='__main__':unittest.main()
