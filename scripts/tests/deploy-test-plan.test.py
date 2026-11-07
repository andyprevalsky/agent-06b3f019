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
        # Original /deploy Step 4m-lint (DEPRECATED_deploy.md L1380-1388): run when mac-app/ changed.
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

    def test_adjudicated_assigned_repair_cannot_leave_required_repair_routing(self):
        import deploy_test_election as election
        old, new, state, proof = self.started_fixture()
        state['pending'] = ['api-error']
        state['failures'][0]['rca'] = {'assigned_repair':True}
        proof['rca'] = []
        original = copy.deepcopy(state)
        with patch.object(election, 'validate_custody'), self.assertRaisesRegex(ValueError, 'assigned repair'):
            c.refresh(state, old, new, self.root, election_proof=proof)
        self.assertEqual(state, original)

    def test_physical_closure_rejects_another_run_and_unbound_owner_records(self):
        import deploy_test_election as election
        run = self.root / 'original-run'
        run.mkdir()
        physical = self.root / 'physical.json'
        physical.write_text(json.dumps({'canonical_reconcile_exit':0, 'physical_process_absent':True,
            'database_status':'ABSENT', 'listeners':[], 'services_status':'stopped',
            'financial_cleanup_verified':False, 'run':str(run), 'source':'original'}))
        proof = {'physical':str(physical), 'run_json':str(self.root / 'different-run/run.json'),
                 'source':{'head':'original'}, 'files':{}}
        with self.assertRaisesRegex(ValueError, 'original run'):
            election.physical_quiet(proof)
        proof['run_json'] = str(run / 'run.json')
        for name, value in [('local-stack-owner.json',{}), ('services.json',{}),
                            ('local-benchmark-owner.json',{'token':'original'})]:
            (run/name).write_text(json.dumps(value))
        (run/'benchmark-cleanup-original.status').write_text('state=failed\n')
        with self.assertRaisesRegex(ValueError, 'records must be bound'):
            election.physical_quiet(proof)

    def test_custody_acceptance_requires_actual_other_box_and_exact_original_debt(self):
        import deploy_test_election as election
        archive = self.root / 'archive.json'
        archive.write_text(json.dumps({'key':'devbox-closeout-private/original', 'ciphertext_sha256':'f'*64}))
        acceptance = self.root / 'acceptance.json'
        platform = self.root / 'platform.json'
        start = self.root / 'start.json'
        obligations = [{'transfer_id':'original-transfer', 'amount_cents':4396}]
        source_box = '11111111-1111-1111-1111-111111111111'
        other_box = '22222222-2222-2222-2222-222222222222'
        original = {'archive':str(archive), 'originating_devbox':source_box, 'obligations':obligations}
        state = {'elected_omissions':[{'proof':original}]}
        value = {'custodian_devbox':other_box, 'thread_url':'https://boxes.dev/thread/custodian',
                 'obligations':obligations, 'archive_key':'devbox-closeout-private/original',
                 'ciphertext_sha256':'f'*64, 'financial_cleanup_verified':False, 'test_credit':False,
                 'continuing_parent_accountability':True, 'independent_archive_recovery_verified':True}
        def prepare(value):
            acceptance.write_text(json.dumps(value))
            digest = election.sha(acceptance)
            platform.write_text(json.dumps({'ok':True, 'data':{'status':'completed', 'completedAt':1,
                'executionInstanceId':value.get('custodian_devbox'),
                'turnId':'33333333-3333-3333-3333-333333333333',
                'output':{'text':'OPERATIONAL_CUSTODY_ACCEPTED_SHA256 ' + digest}}}))
            start.write_text(json.dumps({'ok':True, 'threadId':'custodian',
                'devboxId':value.get('custodian_devbox'),
                'target':{'executionInstanceId':value.get('custodian_devbox')}}))
            return {'acceptance':str(acceptance), 'acceptance_sha256':digest,
                    'platform_result':str(platform), 'platform_result_sha256':election.sha(platform),
                    'platform_start':str(start), 'platform_start_sha256':election.sha(start),
                    'originating_devbox':source_box, 'custody_link':value['thread_url']}
        for changed in ({'custodian_devbox':source_box}, {'custodian_devbox':None},
                        {'custodian_devbox':''}, {'custodian_devbox':'not-a-devbox'}, {'obligations':[]},
                        {'financial_cleanup_verified':True}, {'test_credit':True},
                        {'independent_archive_recovery_verified':False}):
            proof = prepare({**value, **changed})
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                election.accept(copy.deepcopy(state), proof)
        missing = dict(value)
        missing.pop('custodian_devbox')
        with self.assertRaises(ValueError):
            election.accept(copy.deepcopy(state), prepare(missing))
        proof = prepare(value)
        changed_start = json.loads(start.read_text())
        changed_start['threadId'] = 'different-thread'
        start.write_text(json.dumps(changed_start))
        proof['platform_start_sha256'] = election.sha(start)
        with self.assertRaises(ValueError):
            election.accept(copy.deepcopy(state), proof)
        proof = prepare(value)
        election.accept(state, proof)
        self.assertEqual(state['elected_omissions'][0]['accepted_custody'], proof)
        acceptance.write_text('{}')
        with self.assertRaises(ValueError):
            election.accept({'elected_omissions':[{'proof':original}]}, proof)

def unused_loopback_port():
    """A loopback port no live socket holds when the fixture is built."""
    import socket
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class InterruptedCustody(unittest.TestCase):
    setUp = cycle_fixture.Cycle.setUp
    tearDown = cycle_fixture.Cycle.tearDown

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, (dict, list)) else value)

    def fixture(self, cloud=False):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        import deploy_test_interrupted_cleanup as m
        self.m = m
        now = time.time() - 100
        self.at = lambda n: datetime.fromtimestamp(now+n, timezone.utc).isoformat()
        policies = ['scripts/run-bench-fleet', 'scripts/run-bench-campaign.py', 'agents/benchmarks/hub_upload.py', 'scripts/lib/cloudbench-env.sh']
        for name in policies:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        subprocess.run(['git','add',*policies],cwd=self.root,check=True)
        subprocess.run(['git','-c','user.name=test','-c','user.email=test@example.com','commit','--allow-empty','-qm','native policies'],cwd=self.root,check=True)
        gate = (dict(name='smoke', category='smoke', native_cloud=True, worker_transport='benchmark-cloud-cli',
                     command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],cwd=str(self.root),checks=['task'],env={})
                if cloud else dict(name='backend-structural',category='backend-structural',quick=True,
                                   command=['npm','run','test:structural'],cwd='back-end',checks=['backend-structural'],env={}))
        source = c.source(self.root)
        folder = self.root / '.context/deploy-pipeline/attempts/16/focused' / gate['name']
        token = 'a'*32
        receipt = dict(gate=gate['name'], token=token, source=source, status='FAIL',executed=True, complete=False,
            cancelled=True,timed_out=False,lingering_group=True,worker_result=None,native_cleanup_reference=None,
            command=gate['command'], cases={n:'UNVERIFIED' for n in gate['checks']},
            log=str(folder/'output.log'),stderr_log=str(folder/'stderr.log'),started_at=now,finished_at=now+2,
            execution_binding={'contract_digest':c.digest(gate),'input_fingerprint':'f'*64,'environment':'e'*64},
            native_exit=-9 if cloud else -15,lifecycle='native-producer' if cloud else 'owned')
        if cloud: receipt['cleanup_owner']={'request_token':token,'worker_root':str(self.root),'native_cleanup_reference':None}
        self.put(folder/'request.json',dict(token=token,source=source,gate=gate['name'],checks=gate['checks'],skips={},phase='focused'))
        self.put(folder/'receipt.json',receipt)
        for name in ('output.log','stderr.log'):self.put(folder/name,'original outer log')
        state={'plan':{'gates':[gate],'source':source},'source':source,'phase':'interrupted','resume_phase':'focused',
               'attempts':[{'phase':'focused','interrupted':True,'results':[receipt]}], 'round':16,'failures':[],
               'reconciled_owners':{'older-debt':{'kind':'historical','token':'older','unchanged':True}}}
        proof={'kind':m.KIND,'root':str(self.root),'confirmed_at':time.time(),'observed_by':'independent fixture'}
        if not cloud:
            self.put(folder/'output.log.process.json',dict(native_exit=-15,cancelled=True,timed_out=False,quiescent=True,
                remaining=[],error=None,orphaned_children=True,kill_sent=[],child_pid=2147483001,supervisor_pid=2147483002,
                term_sent=[2147483001,2147483003],reaped=[{'pid':2147483001,'status':15},{'pid':2147483003,'status':0}]))
        else:
            base=self.root/'.context/deploy-cloud'/hashlib.sha256(token.encode()).hexdigest()
            campaign=base/'campaigns'/('deploy-'+base.name); runs=base/'runs'; fleet=runs/'20261106-223817-2147483001'
            # The custody check scans the host's live sockets: never claim a port a real Hub may hold.
            port=str(unused_loopback_port())
            owner='b'*32; hub=runs/'_hub'/('agent-link-server.'+port+'.'+'c'*32+'.owner')
            self.hub=hub; self.fleet=fleet; self.audit=self.root/'.git/cloudbench-fleet-audits'/owner
            self.put(hub,'version=1\npid=2147483004\npgid=2147483004\npid_start=proc-start:fixture:1\nowner_token='+ 'c'*32+
                '\nargv_sha256='+'d'*64+'\nroot='+str(runs)+'\nruns_root='+str(runs)+'\nrepo_root='+str(self.root)+
                '\ncontext_dir='+str(runs/'_hub')+'\ncommand='+str(self.root/'agents/benchmarks/agent_link_server.py')+
                '\nhost=127.0.0.1\nport='+port+'\nstatus=live-transfer-required\n')
            self.put(base/'cli.log',str(campaign))
            log=campaign/'r001-j0001.log'
            self.put(log,str(self.root/'scripts/run-bench')+' monitor '+str(fleet))
            job=dict(job_id='r001-j0001',task='task',run=1,attempt=1,attempts=[],status='cancelled',
                     controller_exit_code=143,controller_pid=2147483001,started_at=self.at(1),finished_at=self.at(5),log=str(log))
            summary=dict(campaign_id=campaign.name,status='cancelled',runs=1,retry_infra=0,task_count=1,total_jobs=1,
                         peak_concurrency=1,jobs=[job],started_at=self.at(1),finished_at=self.at(6))
            self.put(campaign/'summary.json',summary)
            record=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))['campaign_group_record'](summary)
            self.put(campaign/'hub-group.json',record)
            self.put(campaign/'hub-group-publication-ack.private.json',{'pid':2147483005,'token':'f'*32,'record_sha256':'0'*64})
            self.put(campaign/'shared-inventory/stop','')
            for name in ('shared-inventory/publisher.private.log','hub-group-publication.private.log'):self.put(campaign/name,'original publication')
            self.put(fleet/'_batch/benches.json',[{'name':'task'}])
            self.put(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=143,
                tasks=[dict(name='task',status='INFRA_ERROR',passed=False,agent_id=None,lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            self.put(fleet/'_batch/llm-usage.json',dict(run_id=fleet.name,providers={'native':{'calls':0,'input_tokens':0,'output_tokens':0,'cost_usd':0.0,'models':{}}}))
            self.put(fleet/'_batch/disposable-cleanup.json',dict(schema='disposable-cleanup-v1',owner=owner,
                guest_cleanup_missing=False,runtime_evidence_missing=False,successful_runtime_inferred=False))
            meta='version=1\napp=fixture-bench\nfleet_owner_token='+owner+'\nrun_id='+fleet.name+'\nworkspace_root='+str(self.root)+'\nstatus=provider-teardown-verified\nhub_disposition=retained-exact-owner-transfer-required\nhub_owner_file='+str(hub)+'\nhub_owner_token='+'c'*32+'\nhub_pid=2147483004\nhub_pid_start=proc-start:fixture:1\nhub_argv_sha256='+'d'*64+'\n'
            self.put(self.audit/'meta',meta)
            for name in ('owned-clones.ids','owned-clones.names'):self.put(self.audit/name,'')
            self.put(self.audit/'provider-teardown-verified.epoch',str(now+4))
            for name in ('fresh','expected-fresh','by-machine-id','pool','pool-handoffs','volume-migrations','archived-reuse'):(self.audit/name).mkdir()
            self.put(fleet/'_batch/lifecycle.json',dict(version=1,run_id=fleet.name,fleet_owner_token=owner,workspace_root=str(self.root),status='failed',controller_exit_code=143,hub_publication_failed=False,audit_sha256='pending'))
            recovery=self.root/'.context/recovery';proof['publication_recovery']=str(recovery)
            for name in ('summary.json','hub-group.json','hub-group-publication-ack.private.json'):self.put(recovery/('original-'+name),(campaign/name).read_text())
            self.put(recovery/'hub-group.json',(campaign/'hub-group.json').read_text())
            self.put(recovery/'hub-group-publication-ack.private.json',dict(pid=2147483005,token='f'*32,record_sha256=hashlib.sha256(json.dumps(record,sort_keys=True).encode()).hexdigest()))
            self.put(recovery/'native-publisher.private.log','uploaded run bundle to hub: '+campaign.name)
            self.put(recovery/'owner.json',dict(pid=2147483005,started_at=now+15,source=source['head'],
                native_producer='agents/benchmarks/hub_upload.py --upload-final',original_campaign=str(campaign)))
            self.put(recovery/'receipt.json',dict(started_at=now+15,finished_at=now+16,native_exit=0,verified=True,
                original_bytes_unchanged={n:c.sha_file(campaign/n) for n in ('summary.json','hub-group.json','hub-group-publication-ack.private.json')},
                campaign=str(campaign),record_sha256=c.sha_file(campaign/'hub-group.json'),ack_path=str(recovery/'hub-group-publication-ack.private.json'),
                benchmark_execution_credit=False,guest_or_provider_resource_operation=False))
            terminal=Path(str(hub)+'.terminal')
            self.put(terminal,'version=1\nowner_file='+str(hub)+'\nowner_sha256='+c.sha_file(hub)+'\npid=2147483004\npgid=2147483004\npid_start=proc-start:fixture:1\nowner_token='+'c'*32+'\ndisposition=terminated-verified\nterminated_at='+self.at(11)+'\n')
            proof['hub_consumers']=str(self.root/'.context/consumers.json');proof['hub_retirement']=str(self.root/'.context/retirement.json')
            self.put(Path(proof['hub_consumers']),dict(runs=str(runs),owner=str(hub),owner_sha256=c.sha_file(hub),remaining_external_process_references=[],
                consumer_disposition='All original controllers terminal; namespace closed to new borrowers.',observed_at=now+9,borrowers=[]))
            self.put(Path(proof['hub_retirement']),dict(provider_operations=False,historical_runtime_financial_obligations_unchanged=True,
                rows=[dict(port=port,owner=str(hub),owner_sha256=c.sha_file(hub),terminal=str(terminal),terminal_sha256=c.sha_file(terminal),native_exit=0,
                           immutable_owner_unchanged=True,borrowers_terminal=1,started_at=now+10,finished_at=now+12)]))
            proof['producer_files']={n:str(self.root/n) for n in policies}
            self.reseal(proof)
        self.rebind(proof)
        return state,receipt,proof

    def rebind(self, proof):
        paths=[p for area in (self.root/'.context',self.root/'.git/cloudbench-fleet-audits') if area.exists()
               for p in area.rglob('*') if p.is_file() and not p.is_symlink()]
        paths += [Path(p) for p in proof.get('producer_files',{}).values()]
        proof['files']={str(p):c.sha_file(p) for p in paths}

    def reseal(self, proof):
        import shutil,hashlib
        h=hashlib.sha256()
        for p in sorted(self.audit.rglob('*'),key=lambda p:str(p.relative_to(self.audit))):
            if p.is_file():
                for raw in (str(p.relative_to(self.audit)).encode(),p.read_bytes()):h.update(len(raw).to_bytes(8,'big'));h.update(raw)
        local=self.fleet/'teardown-ownership'
        if local.exists():shutil.rmtree(local)
        shutil.copytree(self.audit,local)
        self.put(local/'source-audit','path='+str(self.audit)+'\nsha256='+h.hexdigest()+'\n')
        life=self.fleet/'_batch/lifecycle.json';v=json.loads(life.read_text());v['audit_sha256']=h.hexdigest();self.put(life,v)
        p=Path(proof['hub_consumers']);v=json.loads(p.read_text());v['borrowers']=[{'lifecycle':str(life),'sha256':c.sha_file(life),'status':'failed','controller_exit_code':143}];self.put(p,v)

    def test_existing_boundaries_reproduce_both_exact_refusals(self):
        import deploy_test_native_cleanup as native
        import deploy_test_local_cleanup as local
        state,r,proof=self.fixture()
        with self.assertRaises(KeyError):local.validate(state,r,{'kind':local.KIND,'files':proof['files'],'confirmed_at':proof['confirmed_at'],'observed_by':'fixture'})
        state,r,proof=self.fixture(cloud=True)
        with self.assertRaises(TypeError):native.validate(r,r['cleanup_owner'],{'kind':native.KIND,'owner':r['cleanup_owner'],'request_token':r['token'],'source':r['source']})

    def test_static_and_cloud_reconcile_preserve_originals_and_history(self):
        for cloud in (False,True):
            with self.subTest(cloud=cloud):
                state,r,proof=self.fixture(cloud)
                original=copy.deepcopy(state);bytes_before={p:Path(p).read_bytes() for p in proof['files']}
                c.reconcile(state,r['token'],proof);c.interrupted_boundary(state)
                self.assertEqual(state['attempts'],original['attempts']);self.assertEqual(state['failures'],original['failures'])
                self.assertEqual(state['reconciled_owners']['older-debt'],original['reconciled_owners']['older-debt'])
                entry=state['reconciled_owners'][c.sha_file(Path(r['log']).parent/'receipt.json')]
                self.assertFalse(entry['credit_granted']);self.assertFalse(entry['financial_cleanup_credit'])
                self.assertTrue(self.m.still_bound(state,r,entry))
                saved=copy.deepcopy(state['reconciled_owners'])
                c.reconcile(state,r['token'],proof)
                self.assertEqual(state['reconciled_owners'],saved)
                changed={**proof,'observed_by':'replacement observer'}
                with self.assertRaisesRegex(ValueError,'remain unchanged'):c.reconcile(state,r['token'],changed)
                self.assertEqual(state['reconciled_owners'],saved)
                state['source']={'head':'later','digest':'later'}
                self.assertTrue(self.m.still_bound(state,r,entry))
                state['plan']['gates'][0]['command']=['replacement']
                self.assertFalse(self.m.still_bound(state,r,entry))
                self.assertTrue(all(Path(p).read_bytes()==raw for p,raw in bytes_before.items()))

    def policy_relocation_fixture(self):
        import time
        state, receipt, proof = self.fixture(True)
        policy = self.root / 'scripts/lib/cloudbench-env.sh'
        frozen = self.fleet.parent.parent / 'campaigns' / ('deploy-' + self.fleet.parent.parent.name) / 'shared-inventory/scripts/cloudbench-env.sh'
        self.put(frozen, policy.read_text())
        self.rebind(proof)
        c.reconcile(state, receipt['token'], proof)
        key = c.sha_file(Path(receipt['log']).parent / 'receipt.json')
        previous = copy.deepcopy(state['reconciled_owners'][key])
        policy.write_text(policy.read_text() + '\n# legitimate incoming main policy change\n')
        subprocess.run(['git', 'add', str(policy)], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com',
                        'commit', '-qm', 'incoming main'], cwd=self.root, check=True)
        state['source'] = state['plan']['source'] = c.source(self.root)
        state['phase'] = 'focused'
        state.pop('resume_phase')
        state['attempts'].append({'phase': 'quick', 'results': []})
        renewal = {'kind': 'interrupted-policy-witness-renewal-v1', 'receipt_sha256': key,
                   'previous_entry_sha256': c.digest(previous), 'relocations': {str(policy): str(frozen)},
                   'confirmed_at': time.time(), 'observed_by': 'independent relocation fixture'}
        return state, receipt, proof, previous, renewal

    def test_historical_policy_drift_renews_without_changing_original_bindings(self):
        state, receipt, proof, previous, renewal = self.policy_relocation_fixture()
        original = copy.deepcopy(state)
        original_bytes = {p: Path(p).read_bytes() for p in proof['files']}
        self.assertEqual(c.retained_owners(state, ['smoke']), ['smoke'])
        c.reconcile(state, receipt['token'], renewal)
        entry = state['reconciled_owners'][renewal['receipt_sha256']]
        self.assertTrue(c._reconciled(state, receipt, receipt['cleanup_owner']))
        self.assertEqual(c.retained_owners(state, ['smoke']), [])
        self.assertEqual(entry['proof'], proof)
        self.assertEqual(entry['policy_witness_renewal']['previous'], previous)
        self.assertFalse(entry['credit_granted'])
        self.assertFalse(entry['financial_cleanup_credit'])
        self.assertEqual(state['attempts'], original['attempts'])
        self.assertEqual(state['failures'], original['failures'])
        self.assertEqual(state['reconciled_owners']['older-debt'], original['reconciled_owners']['older-debt'])
        self.assertEqual({p: Path(p).read_bytes() for p in proof['files']}, original_bytes)
        saved = copy.deepcopy(state)
        c.reconcile(state, receipt['token'], renewal)
        self.assertEqual(state, saved)

    def test_policy_renewal_rejects_wrong_identity_path_bytes_and_symlink(self):
        state, receipt, proof, previous, renewal = self.policy_relocation_fixture()
        frozen = Path(next(iter(renewal['relocations'].values())))
        original = frozen.read_bytes()
        for field in ('receipt_sha256', 'previous_entry_sha256'):
            invalid = copy.deepcopy(renewal)
            invalid[field] = '0' * 64
            saved = copy.deepcopy(state)
            with self.subTest(field=field), self.assertRaises(ValueError):
                c.reconcile(state, receipt['token'], invalid)
            self.assertEqual(state, saved)
        invalid = copy.deepcopy(renewal)
        invalid['relocations'] = {str(frozen): str(frozen)}
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], invalid)
        unbound = frozen.with_name('unbound-identical.sh')
        unbound.write_bytes(original)
        invalid['relocations'] = {next(iter(renewal['relocations'])): str(unbound)}
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], invalid)
        unbound.unlink()
        frozen.write_bytes(b'wrong original bytes')
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], renewal)
        frozen.unlink()
        frozen.symlink_to(self.root / 'scripts/lib/cloudbench-env.sh')
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], renewal)
        frozen.unlink()
        frozen.write_bytes(original)
        c.reconcile(state, receipt['token'], renewal)
        # Rehashing a corrupt historical witness cannot replace original Git provenance.
        bad = copy.deepcopy(state['reconciled_owners'][renewal['receipt_sha256']])
        frozen.write_bytes(b'forged historical policy')
        bad['proof']['files'][str(frozen)] = c.sha_file(frozen)
        self.assertFalse(self.m.still_bound(state, receipt, bad))

    def test_policy_renewal_original_git_blob_survives_incoming_fleet_policy(self):
        state, receipt, proof, previous, renewal = self.policy_relocation_fixture()
        policy = self.root / 'scripts/run-bench-fleet'
        blob = subprocess.check_output(['git', 'rev-parse', receipt['source']['head'] + ':scripts/run-bench-fleet'],
                                       cwd=self.root, text=True).strip()
        policy.write_text(policy.read_text() + '\n# incoming main warm-source wait fix\n')
        subprocess.run(['git', 'add', str(policy)], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com',
                        'commit', '-qm', 'incoming fleet policy'], cwd=self.root, check=True)
        state['source'] = state['plan']['source'] = c.source(self.root)
        renewal['relocations'][str(policy)] = 'git:' + blob
        invalid = copy.deepcopy(renewal)
        invalid['relocations'][str(policy)] = 'git:' + '0' * 40
        with self.assertRaisesRegex(ValueError, 'original Git blob'): c.reconcile(state, receipt['token'], invalid)
        c.reconcile(state, receipt['token'], renewal)
        self.assertEqual(c.retained_owners(state, ['smoke']), [])
        self.assertEqual(state['reconciled_owners'][renewal['receipt_sha256']]['proof'], proof)

    def test_policy_renewal_rechecks_evidence_allocations_consumers_and_contract(self):
        state, receipt, proof, previous, renewal = self.policy_relocation_fixture()
        log = Path(receipt['log'])
        original = log.read_bytes()
        log.write_bytes(original + b'changed original')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            c.reconcile(state, receipt['token'], renewal)
        log.write_bytes(original)
        with patch.object(self.m, 'processes', return_value=[(2147483001, 2147483001)]), self.assertRaises(ValueError):
            c.reconcile(state, receipt['token'], renewal)
        with patch.object(self.m, 'namespace_quiet', side_effect=ValueError('live consumer')), self.assertRaises(ValueError):
            c.reconcile(state, receipt['token'], renewal)
        with (Path(proof['publication_recovery']) / 'native-publisher.private.log').open('a'):
            with self.assertRaisesRegex(ValueError, 'writer'):
                c.reconcile(state, receipt['token'], renewal)
        for name in ('fresh', 'expected-fresh', 'by-machine-id', 'pool', 'pool-handoffs', 'volume-migrations', 'archived-reuse'):
            path = self.audit / name / 'new-allocation'
            self.put(path, 'machine=allocated')
            with self.subTest(name=name), self.assertRaises(ValueError):
                c.reconcile(state, receipt['token'], renewal)
            path.unlink()
        for change in ({'running': ['smoke']}, {'live_failures': []}):
            invalid = {**state, **change}
            with self.assertRaisesRegex(ValueError, 'quiescent'):
                c.reconcile(invalid, receipt['token'], renewal)
        invalid = copy.deepcopy(state)
        invalid['plan']['gates'][0]['command'] = ['replacement']
        with self.assertRaises(ValueError): c.reconcile(invalid, receipt['token'], renewal)
        invalid = copy.deepcopy(state)
        invalid['source'] = {'head': '0' * 40, 'digest': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'source binding'):
            c.reconcile(invalid, receipt['token'], renewal)
        c.reconcile(state, receipt['token'], renewal)
        entry = state['reconciled_owners'][renewal['receipt_sha256']]
        log.write_bytes(original + b'late evidence mutation')
        self.assertFalse(self.m.still_bound(state, receipt, entry))

    def test_static_rejects_unknown_waits_active_targets_and_changed_contract(self):
        state,r,proof=self.fixture();path=Path(r['log']).parent/'output.log.process.json';original=path.read_bytes()
        for change in ({'quiescent':False},{'remaining':[2147483001]},{'reaped':[]},{'kill_sent':[2147483001]}, {'term_sent':[2147483001,2147483006]}):
            v=json.loads(original);v.update(change);self.put(path,v);self.rebind(proof)
            with self.subTest(change=change),self.assertRaises(ValueError):c.reconcile(copy.deepcopy(state),r['token'],proof)
        path.write_bytes(original);self.rebind(proof)
        with patch.object(self.m,'processes',return_value=[(2147483001,2147483001)]),self.assertRaises(ValueError):c.reconcile(state,r['token'],proof)
        state['plan']['gates'][0]['cwd']='somewhere-else'
        with self.assertRaises(ValueError):c.reconcile(state,r['token'],proof)

    def test_cloud_rejects_every_populated_allocation_class(self):
        state,r,proof=self.fixture(True)
        for name in ('fresh','expected-fresh','by-machine-id','pool','pool-handoffs','volume-migrations','archived-reuse'):
            path=self.audit/name/'allocated';self.put(path,'machine=allocated');self.reseal(proof);self.rebind(proof)
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'allocation class'):c.reconcile(copy.deepcopy(state),r['token'],proof)
            path.unlink()

    def test_cloud_rejects_nested_marker_symlink_and_retained_registry(self):
        state,r,proof=self.fixture(True)
        for name in self.m.MARKERS:
            path=self.fleet/'nested'/name;self.put(path,'allocated');self.rebind(proof)
            with self.subTest(name=name),self.assertRaises(ValueError):c.reconcile(copy.deepcopy(state),r['token'],proof)
            path.unlink()
        path=self.fleet/'nested'/'dangling';path.symlink_to('/missing-original')
        with self.assertRaises(ValueError):c.reconcile(copy.deepcopy(state),r['token'],proof)
        path.unlink();self.rebind(proof)
        registry=self.root/'.git/cloudbench-fleet-ownership'/('b'*32);registry.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError,'registry'):c.reconcile(state,r['token'],proof)

    def test_cloud_rejects_wrong_task_source_owner_and_mixed_allocation(self):
        state,r,proof=self.fixture(True)
        for name,change in [('run.json',lambda v:v['tasks'][0].update(agent_id='allocated')),
                            ('run.json',lambda v:v['tasks'][0].update(graded_root_creation_outcome='unknown')),
                            ('run.json',lambda v:v['tasks'][0].update(name='other-task')),
                            ('lifecycle.json',lambda v:v.update(fleet_owner_token='c'*32)),
                            ('llm-usage.json',lambda v:v['providers']['native'].update(calls=1))]:
            path=self.fleet/'_batch'/name;original=path.read_bytes();v=json.loads(original);change(v);self.put(path,v);self.rebind(proof)
            with self.subTest(name=name),self.assertRaises(ValueError):c.reconcile(copy.deepcopy(state),r['token'],proof)
            path.write_bytes(original)
        self.rebind(proof);state['attempts'][-1]['results'][0]['source']['head']='0'*40
        with self.assertRaises(ValueError):c.reconcile(state,r['token'],proof)

    def test_cloud_rejects_old_bad_ack_missing_retirement_active_writer_and_early_clock(self):
        state,r,proof=self.fixture(True);recovery=Path(proof['publication_recovery']);ack=recovery/'hub-group-publication-ack.private.json';original=ack.read_bytes()
        v=json.loads(original);v['record_sha256']='0'*64;self.put(ack,v);self.rebind(proof)
        with self.assertRaisesRegex(ValueError,'ACK'):c.reconcile(copy.deepcopy(state),r['token'],proof)
        ack.write_bytes(original);self.rebind(proof)
        terminal=Path(str(self.hub)+'.terminal');raw=terminal.read_bytes();terminal.unlink();proof['files'].pop(str(terminal))
        with self.assertRaises(ValueError):c.reconcile(copy.deepcopy(state),r['token'],proof)
        terminal.write_bytes(raw);self.rebind(proof)
        with (recovery/'native-publisher.private.log').open('a'), self.assertRaisesRegex(ValueError,'writer'):
            c.reconcile(copy.deepcopy(state),r['token'],proof)
        proof['confirmed_at']=r['finished_at']
        with self.assertRaises(ValueError):c.reconcile(state,r['token'],proof)

class InterruptedProcessObservation(unittest.TestCase):
    """The old-namespace scan cannot read every same-uid process at every instant.

    An exiting process answers EACCES for its fd table for a few milliseconds before it disappears (the Blacksmith
    failure: PermissionError on /proc/<pid>/fd). That is a read failure, never proof of absence or of a leak: it is
    re-observed a bounded number of times, skipped once the process is gone and refused, naming the pid, only while
    it stays unreadable and alive. A genuinely held namespace is still refused. The real Linux process is the
    fixture: a child that clears PR_SET_DUMPABLE is unreadable to its same-uid parent exactly like an exiting one.
    """
    CHILD = """
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
def dumpable(flag):
    assert libc.prctl(4, flag, 0, 0, 0) == 0  # PR_SET_DUMPABLE
held = open(os.environ['HELD']) if os.environ.get('HELD') else None
dumpable(sys.argv[1] == 'open')
print('ready', flush=True)
for line in sys.stdin:
    dumpable(line.strip() == 'open')
    print('ack', flush=True)
"""

    def setUp(self):
        import deploy_test_interrupted_cleanup as m
        self.m = m
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.namespace = Path(self.tmp.name) / 'old-namespace'
        self.elsewhere = Path(self.tmp.name) / 'elsewhere'
        self.namespace.mkdir()
        self.elsewhere.mkdir()
        self.sleeps = []

    def child(self, state, cwd=None, held='', label=''):
        proc = subprocess.Popen([sys.executable, '-c', self.CHILD, state, label], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, text=True, cwd=cwd or self.elsewhere,
                                env={**os.environ, 'HELD': held})
        self.addCleanup(self.reap, proc)
        self.assertEqual(proc.stdout.readline().strip(), 'ready')
        return proc

    @staticmethod
    def reap(proc):
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdin.close()
        proc.stdout.close()

    def switch(self, proc, state):
        proc.stdin.write(state + '\n')
        proc.stdin.flush()
        self.assertEqual(proc.stdout.readline().strip(), 'ack')

    def scan(self, while_waiting=None):
        def sleep(seconds):
            self.sleeps.append(seconds)
            if while_waiting:
                while_waiting()
        with patch.object(self.m.time, 'sleep', sleep):
            self.m.namespace_quiet(self.namespace, set())

    def test_process_that_becomes_readable_while_waiting_is_reobserved(self):
        child = self.child('sealed')
        self.scan(lambda: self.switch(child, 'open'))
        self.assertTrue(self.sleeps)

    def test_fd_table_denied_after_cwd_was_read_is_reobserved(self):
        for site in ('listing', 'link'):
            with self.subTest(site):
                child = self.child('open')
                denied = [1, 2]
                real_iterdir, real_readlink = Path.iterdir, os.readlink

                def iterdir(path):
                    if site == 'listing' and str(path) == '/proc/%d/fd' % child.pid and denied:
                        denied.pop()
                        raise PermissionError(13, 'Permission denied', str(path))
                    return real_iterdir(path)

                def readlink(path, *args, **kwargs):
                    if site == 'link' and str(path).startswith('/proc/%d/fd/' % child.pid) and denied:
                        denied.pop()
                        raise PermissionError(13, 'Permission denied', str(path))
                    return real_readlink(path, *args, **kwargs)

                with patch.object(Path, 'iterdir', iterdir), patch.object(os, 'readlink', readlink):
                    self.scan()
                self.assertEqual(denied, [])
                self.assertGreaterEqual(len(self.sleeps), 2)

    def test_process_that_exits_while_unreadable_is_not_a_holder(self):
        child = self.child('sealed')
        self.scan(lambda: (child.kill(), child.wait()))
        self.assertTrue(self.sleeps)

    def test_process_that_changes_owner_while_unreadable_is_another_users(self):
        child = self.child('sealed')
        owner = {'uid': os.geteuid()}
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            if str(path) == '/proc/%d' % child.pid:
                return SimpleNamespace(st_uid=owner['uid'])
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, 'stat', stat):
            self.scan(lambda: owner.update(uid=os.geteuid() + 1))
        self.assertTrue(self.sleeps)

    def test_process_that_stays_unreadable_and_alive_fails_closed_naming_it(self):
        child = self.child('sealed')
        with self.assertRaisesRegex(ValueError, r'cannot observe pid %d: EACCES' % child.pid) as raised:
            self.scan()
        self.assertNotRegex(str(raised.exception), 'live consumer|holder remains')
        self.assertGreaterEqual(len(self.sleeps), self.m.OBSERVATION_ATTEMPTS - 1)
        self.assertLessEqual(self.m.OBSERVATION_ATTEMPTS * self.m.OBSERVATION_DELAY, 2)

    def test_a_held_namespace_is_still_refused(self):
        held = self.namespace / 'held.log'
        held.write_text('original')
        for name, kwargs, message in (
                ('cwd', dict(cwd=self.namespace), 'live consumer'),
                ('open file', dict(held=str(held)), 'file holder remains'),
                ('argv of an unreadable process', dict(label=str(self.namespace)), 'live consumer')):
            with self.subTest(name):
                child = self.child('sealed' if name.startswith('argv') else 'open', **kwargs)
                with self.assertRaisesRegex(ValueError, message):
                    self.scan()
                self.reap(child)


if __name__=='__main__':unittest.main()
