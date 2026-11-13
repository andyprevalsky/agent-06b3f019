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
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy_test_plan as p
import importlib.util as _quarantine_util

# scripts/test_quarantine.py (the CLI) already owns the `test_quarantine` module name here.
_quarantine_spec = _quarantine_util.spec_from_file_location(
    'lib_test_quarantine', Path(__file__).resolve().parents[1] / 'lib' / 'test_quarantine.py')
_quarantine_module = _quarantine_util.module_from_spec(_quarantine_spec)
_quarantine_spec.loader.exec_module(_quarantine_module)
quarantine = _quarantine_module.quarantine


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

def reserved_loopback_port(test):
    """A port no live socket can take while the test runs.

    A released probe port returns to the kernel's ephemeral range, where a concurrent
    client connection can take it and trip the host-wide Hub socket check. Holding a
    bound, non-listening socket keeps it out of /proc/net/tcp and out of autobind; a
    dual-stack :: bind also refuses explicit IPv4 and IPv6 binds of the same port."""
    import socket
    try:
        reservation = socket.socket(socket.AF_INET6)
    except OSError:
        reservation = None
    if reservation is not None:
        try:
            reservation.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            reservation.bind(('::', 0))
        except OSError:
            reservation.close()
            reservation = None
    if reservation is None:  # host without IPv6: an IPv4 wildcard bind still blocks IPv4 and autobind
        reservation = socket.socket()
        reservation.bind(('', 0))
    test.addCleanup(reservation.close)
    return reservation.getsockname()[1]


class InterruptedCustody(unittest.TestCase):
    setUp = cycle_fixture.Cycle.setUp
    tearDown = cycle_fixture.Cycle.tearDown

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, (dict, list)) else value)

    def fixture(self, cloud=False, static='backend-structural'):
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
                                   command=['npm','run','test:structural'],cwd='back-end',checks=['backend-structural'],env={})
                if static == 'backend-structural' else dict(name='format',category='format',quick=True,
                                   command=[sys.executable,'scripts/check_deploy_static.py','format','--base','origin/main'],
                                   checks=['format']))
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
            port=str(reserved_loopback_port(self))
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

    def test_format_quick_gate_term_cancellation_uses_the_static_route(self):
        # A TERM'd coordinator also cancels the root format check; it releases like backend-structural.
        state,r,proof=self.fixture(static='format')
        original=copy.deepcopy(state)
        c.reconcile(state,r['token'],proof);c.interrupted_boundary(state)
        self.assertEqual(state['attempts'],original['attempts'])
        entry=state['reconciled_owners'][c.sha_file(Path(r['log']).parent/'receipt.json')]
        self.assertFalse(entry['credit_granted']);self.assertTrue(self.m.still_bound(state,r,entry))
        for command in (['python3','scripts/check_deploy_static.py','eslint','--base','origin/main'],
                        ['python3','scripts/other.py','format','--base','origin/main']):
            gate={**state['plan']['gates'][0],'command':command}
            with self.subTest(command=command),self.assertRaisesRegex(ValueError,'static quick routes'):
                self.m.static_worker(self.root,gate,r,Path(r['log']).parent,None)

    def test_budget_expired_static_quick_gate_reconciles_only_when_fully_reaped(self):
        # backend-structural can hit its own quick budget inside a phase that is later cancelled:
        # timed out, TERM'd and reaped by its supervisor. That terminal shape releases like a TERM.
        def expired(**process):
            state,r,proof=self.fixture()
            folder=Path(r['log']).parent
            r.update(cancelled=False,timed_out=True);self.put(folder/'receipt.json',r)
            doc=json.loads((folder/'output.log.process.json').read_text())
            doc.update(cancelled=False,timed_out=True);doc.update(process);self.put(folder/'output.log.process.json',doc)
            self.rebind(proof)
            return state,r,proof
        state,r,proof=expired()
        original=copy.deepcopy(state)
        c.reconcile(state,r['token'],proof);c.interrupted_boundary(state)
        self.assertEqual(state['attempts'],original['attempts'])
        entry=state['reconciled_owners'][c.sha_file(Path(r['log']).parent/'receipt.json')]
        self.assertFalse(entry['credit_granted']);self.assertTrue(self.m.still_bound(state,r,entry))
        for change in (dict(cancelled=True),dict(remaining=[2147483003]),dict(kill_sent=[2147483001])):
            self.tearDown();self.setUp()
            state,r,proof=expired(**change)
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'interrupted custody proof refused'):
                c.reconcile(state,r['token'],proof)

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

    def test_cloud_fixture_hub_port_stays_reserved_for_the_test(self):
        import socket
        self.fixture(True)
        port = int(self.hub.name.split('.')[1])
        attempts = [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET, '')]
        if socket.has_ipv6:
            attempts.append((socket.AF_INET6, '::1'))
        import errno
        for family, host in attempts:
            try:
                other = socket.socket(family)
            except OSError:
                continue  # family unavailable on this host
            with other, self.assertRaises(OSError) as refused:
                other.bind((host, port))
            if refused.exception.errno == errno.EADDRNOTAVAIL and host == '::1':
                continue  # loopback IPv6 not configured: nothing can bind it either
            self.assertEqual(refused.exception.errno, errno.EADDRINUSE, (host, port))

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
    def test_namespace_scan_reobserves_unreadable_same_user_process(self):
        import deploy_test_interrupted_cleanup as m
        import tempfile, time
        namespace = Path(tempfile.mkdtemp(dir=self.root))
        port = reserved_loopback_port(self)
        # PR_SET_DUMPABLE=4: /proc/<pid> stays ours while fd/cwd turn unreadable, as during a setuid exec.
        body = "import ctypes,sys,time;ctypes.CDLL(None).prctl(4,0,0,0,0);print('ready',flush=True);" \
               "time.sleep(float(sys.argv[1]));ctypes.CDLL(None).prctl(4,1,0,0,0);time.sleep(30)"
        for hidden, refused in ((0.3, False), (60, True)):
            child = subprocess.Popen([sys.executable, '-c', body, str(hidden)], stdout=subprocess.PIPE, text=True)
            self.addCleanup(child.kill)
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            if refused:
                with self.assertRaisesRegex(ValueError, 'unverifiable'):
                    m.namespace_quiet(namespace, {port})
            else:
                m.namespace_quiet(namespace, {port})
            child.kill(); child.wait(); child.stdout.close()
        # setuid exec mid-scan: the owner turns root after the first look while the real uid stays ours.
        child = subprocess.Popen([sys.executable, '-c', body, '60'], stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.kill)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        proc_dir, real_stat, seen = f'/proc/{child.pid}', Path.stat, []

        def owner_turns_root(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if str(path) != proc_dir:
                return result
            seen.append(path)
            return result if len(seen) == 1 else os.stat_result((result.st_mode, *result[1:4], 0, *result[5:]))
        with patch.object(Path, 'stat', owner_turns_root), self.assertRaisesRegex(ValueError, 'unverifiable'):
            m.namespace_quiet(namespace, {port})
        child.kill(); child.wait(); child.stdout.close()
        # An unreadable /proc/<pid>/status is unverifiable too: refused by the deadline, never a raw crash.
        child = subprocess.Popen([sys.executable, '-c', body, '60'], stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.kill)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        status, real_read_text = f'/proc/{child.pid}/status', Path.read_text

        def status_unreadable(path, *args, **kwargs):
            if str(path) == status:
                raise PermissionError(13, 'Permission denied', status)
            return real_read_text(path, *args, **kwargs)
        with patch.object(Path, 'read_text', status_unreadable), self.assertRaisesRegex(ValueError, 'unverifiable'):
            m.namespace_quiet(namespace, {port})
        child.kill(); child.wait(); child.stdout.close()

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
        real_sleep = time.sleep

        def sleep(seconds):
            # Really wait: unrelated exiting processes on a busy host need the production window, not instant re-reads.
            self.sleeps.append(seconds)
            real_sleep(seconds)
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

    def test_process_that_stays_unreadable_and_alive_fails_closed_naming_it(self):
        child = self.child('sealed')
        with self.assertRaisesRegex(ValueError, r'original namespace process %d is unverifiable' % child.pid) as raised:
            self.scan()
        self.assertNotRegex(str(raised.exception), 'live consumer|holder remains')
        self.assertTrue(self.sleeps)

    def test_a_held_namespace_is_still_refused(self):
        held = self.namespace / 'held.log'
        held.write_text('original')
        for name, kwargs, message in (
                ('cwd', dict(cwd=self.namespace), 'live consumer'),
                ('open file', dict(held=str(held)), 'file holder remains'),
                ('argv of an unreadable process', dict(label=str(self.namespace)), 'live consumer|is unverifiable')):
            with self.subTest(name):
                child = self.child('sealed' if name.startswith('argv') else 'open', **kwargs)
                with self.assertRaisesRegex(ValueError, message):
                    self.scan()
                self.reap(child)

    @quarantine(since='2026-11-11', repair='pending-handoff:7a087289ad244447887849683a096b6e',
                error="AssertionError: [0.05] is not false : the service manager is skipped on evidence, not after the grace window",
                evidence='PR #1928 deploy-command-structural FLAKY occurrence 7a087289ad244447887849683a096b6e (source 622d4e979)')
    def test_own_user_service_manager_is_skipped_only_on_cgroup_evidence(self):
        # The Blacksmith failure (SHA 7b243b4ec, InterruptedCardRecovery / StructuralSupervisorCleanup): the
        # runner's `systemd --user` and `(sd-pam)` share our uid but are permanently non-dumpable, so cwd/fd
        # answer EACCES for the whole grace window. The kernel places exactly those two processes in
        # user@<uid>.service/init.scope. A real sealed child is the fixture; only its cgroup row is pinned.
        scope = f'/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/init.scope'
        real_read_text = Path.read_text

        def scan_in(child, cgroup, own=None):
            def read_text(path, *args, **kwargs):
                if str(path) == f'/proc/{child.pid}/cgroup':
                    return cgroup
                if own is not None and str(path) == '/proc/self/cgroup':
                    return own
                return real_read_text(path, *args, **kwargs)
            self.sleeps.clear()
            with patch.object(Path, 'read_text', read_text):
                self.scan()

        manager = self.child('sealed')
        scan_in(manager, f'0::{scope}\n')
        self.assertFalse(self.sleeps, 'the service manager is skipped on evidence, not after the grace window')
        scan_in(manager, f'12:name=systemd:{scope}\n3:cpu,cpuacct:/\n')  # cgroup v1 hybrid
        for name, cgroup, own in (
                ('another uid manager', f'0::/user.slice/user-0.slice/user@{os.getuid() + 1}.service/init.scope\n', None),
                ('a user unit, not the manager', f'0::{scope[:-len("init.scope")]}app.slice/run-u1.service\n', None),
                ('scanner shares the scope', f'0::{scope}\n', f'0::{scope}\n'),
                ('no systemd hierarchy', '3:cpu,cpuacct:/\n', None)):
            # When the scanner shares the scope, a real manager on this host is refused first, as it must be.
            named = r'process \d+ is' if own else r'process %d is' % manager.pid
            with self.subTest(name), self.assertRaisesRegex(ValueError, named + ' unverifiable'):
                scan_in(manager, cgroup, own)
        self.reap(manager)
        worker = self.child('open', cwd=self.namespace)  # readable: inspected exactly as before, never skipped
        with self.assertRaisesRegex(ValueError, 'live consumer'):
            scan_in(worker, f'0::{scope}\n')


import hashlib
from deploy_test_run_artifact import read_run_artifact, ForensicValue

class NativeRunArtifact(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name)/'run.json'
 def tearDown(self):self.tmp.cleanup()
 def read(self,raw,limit=4096,expected=None):
  self.p.write_bytes(raw);return read_run_artifact(self.p,expected or hashlib.sha256(raw).hexdigest(),limit)
 def test_large_forensics_preserve_all_control_fields_and_raw_bytes(self):
  value={'run_id':'original','status':'failed','controller_exit_code':1,'tasks':[{'name':'original','passed':True,'logs':{'messages':['a'*600 for _ in range(40)]},'owned_roots':[{'root_agent_id':'root','logs':{'messages':['b'*600 for _ in range(40)]}}]}]};raw=json.dumps(value).encode();v=self.read(raw)
  self.assertEqual(self.p.read_bytes(),raw);self.assertEqual(v['status'],'failed');self.assertEqual(v['controller_exit_code'],1);self.assertTrue(v['tasks'][0]['passed']);self.assertIsInstance(v['tasks'][0]['logs'],ForensicValue);self.assertEqual(v['tasks'][0]['owned_roots'][0]['root_agent_id'],'root')
 def test_raw_cap_keeps_size_refusal_and_unknown_metadata_remains_bounded(self):
     # Native results serialize task logs as dictionaries of arrays; only these paths are opaque.
     raw=json.dumps({'tasks':[{'logs':{'worker_logs':['x'*128]*40}}]}).encode()
     self.p.write_bytes(raw);digest=hashlib.sha256(raw).hexdigest()
     with self.assertRaisesRegex(ValueError,'proof file too large'):
         read_run_artifact(self.p,digest,4096,raw_limit=len(raw)-1)
     self.assertEqual(raw,self.p.read_bytes())
     value=read_run_artifact(self.p,digest,4096,raw_limit=len(raw))
     self.assertIsInstance(value['tasks'][0]['logs'],ForensicValue)
     metadata=json.dumps({'padding':'x'*4097}).encode()
     self.p.write_bytes(metadata)
     with self.assertRaisesRegex(ValueError,'metadata document byte bound'):
         read_run_artifact(self.p,hashlib.sha256(metadata).hexdigest(),4096,raw_limit=len(metadata))
     self.assertEqual(metadata,self.p.read_bytes())

 def test_big_nonforensic_metadata_refused(self):
  with self.assertRaisesRegex(ValueError,'bound'):self.read(json.dumps({'tasks':[{'unknown':['x'*600 for _ in range(40)]}]}).encode())
 def test_wrong_hash_including_opaque_bytes_refused(self):
  with self.assertRaisesRegex(ValueError,'hash'):self.read(b'{"tasks":[{"logs":{"data":"changed"}}]}',expected='0'*64)
 def test_symlink_refused(self):
  self.p.write_text('{}');q=self.p.with_name('link');q.symlink_to(self.p)
  with self.assertRaisesRegex(ValueError,'canonical'):read_run_artifact(q,hashlib.sha256(b'{}').hexdigest(),4096)
 def test_malformed_opaque_payloads_refused_even_with_matching_hash(self):
  for raw in [b'{"tasks":[{"logs":{"x":"bad\\q"}}]}',b'{"tasks":[{"logs":{"x":"bad\\uZ000"}}]}',b'{"tasks":[{"logs":[1,]}]}',b'{"tasks":[{"logs":{"x":01}}]}',b'{"tasks":[{"logs":{"x":"bad\xff"}}]}',b'{"tasks":[{"logs":{"x":"bad\x01"}}]}',b'{"tasks":[{"logs":{"x":truefalse}}]}',b'{"tasks":[{"logs":{"x":1,"x":2}}]}',b'{"tasks":[{"logs":{}}]}garbage']:
   with self.subTest(raw_hash=hashlib.sha256(raw).hexdigest()):
    with self.assertRaises((ValueError,UnicodeDecodeError)):self.read(raw)
 def test_large_scalar_and_depth_refused(self):
  for raw in [b'{"tasks":[{"logs":"'+b'x'*5000+b'"}]}',b'{"tasks":[{"logs":'+b'['*140+b'0'+b']'*140+b'}]}']:
   with self.assertRaisesRegex(ValueError,'bound|depth'):self.read(raw)
 def test_nonobject_and_duplicate_control_keys_refused(self):
  for raw in [b'[]',b'{"run_id":"good","run_id":"foreign"}']:
   with self.assertRaises(ValueError):self.read(raw)
 def test_strings_numbers_whitespace_match_stdlib_for_metadata(self):
  value={'run_id':'\u2603\\"','status':'failed','number':-1.25e-4,'flag':True,'empty':None,'tasks':[{'owned_roots':[],'passed':False}]};self.assertEqual(self.read(json.dumps(value).encode()),value)

 def test_nonforensic_whitespace_counts_toward_wire_budget(self):
     with self.assertRaisesRegex(ValueError, 'metadata document byte bound'):
         self.read(b'{' + b' ' * 32768 + b'"status":"failed"}', limit=4096)

 def test_truncation_child_is_python_refusal_not_signal(self):
     import textwrap
     program = textwrap.dedent('\n            import sys, tempfile, hashlib, resource\n            from pathlib import Path\n            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))\n            sys.path.insert(0, sys.argv[1])\n            import deploy_test_run_artifact as m\n            with tempfile.TemporaryDirectory() as folder:\n                p=Path(folder)/\'run.json\';raw=b\'{"tasks":[{"logs":[\'+b\'"x",\'*30000+b\'"x"]}]}\';p.write_bytes(raw)\n                original=m._Reader.value\n                fired=False\n                def raced(self,*args):\n                    global fired\n                    if not fired:\n                        fired=True\n                        with p.open(\'r+b\') as writer:writer.truncate(0)\n                    return original(self,*args)\n                m._Reader.value=raced\n                try:m.read_run_artifact(p,hashlib.sha256(raw).hexdigest(),4096)\n                except (OSError,ValueError):print(\'SAFE_REFUSAL\')\n                else:raise AssertionError(\'truncation accepted\')\n')
     r=subprocess.run([sys.executable,'-B','-c',program,str(Path(__file__).resolve().parents[1])],capture_output=True,text=True)
     self.assertEqual(0,r.returncode,r.stderr)
     self.assertIn('SAFE_REFUSAL',r.stdout)

 def test_fifo_cancel_deadline_and_default_raw_bound(self):
     import time
     from deploy_test_process import CANCEL
     fifo=self.p.with_name('fifo');os.mkfifo(fifo)
     with self.assertRaisesRegex(ValueError,'regular fd'):
         read_run_artifact(fifo,'0'*64,4096)
     self.p.write_bytes(b'{}');digest=hashlib.sha256(b'{}').hexdigest()
     CANCEL.set()
     try:
         with self.assertRaisesRegex(ValueError,'cancelled'):
             read_run_artifact(self.p,digest,4096)
     finally:CANCEL.clear()
     with self.assertRaisesRegex(ValueError,'deadline'):
         read_run_artifact(self.p,digest,4096,deadline=time.monotonic()-1)
     with self.assertRaisesRegex(ValueError,'raw file byte bound'):
         read_run_artifact(self.p,digest,4096,raw_limit=1)

 def test_explicit_raw_budget_charges_each_regular_descriptor_and_stays_aggregate(self):
     import deploy_test_run_artifact as artifact
     raw=b'{"tasks":[{"logs":"'+b'x'*700+b'"}],"status":"failed"}'
     self.p.write_bytes(raw);other=self.p.with_name('other.json');other.write_bytes(raw)
     digest=hashlib.sha256(raw).hexdigest();remaining=[1024]
     value=read_run_artifact(self.p,digest,4096,raw_limit=1024,raw_remaining=remaining)
     self.assertEqual('failed',value['status'])
     self.assertEqual([1024-len(raw)],remaining)
     with self.assertRaisesRegex(ValueError,'aggregate'):
         read_run_artifact(other,digest,4096,raw_limit=1024,raw_remaining=remaining)
     self.assertEqual(64*1024*1024,artifact.MAX_RECEIPT_BYTES)

 def test_malformed_shared_raw_budgets_refuse_before_reading(self):
     raw=b'{}';self.p.write_bytes(raw);digest=hashlib.sha256(raw).hexdigest()
     for remaining in [[],[0],[-1],[True],[1025],[1024,1024],'1024']:
         with self.subTest(remaining=remaining):
             with self.assertRaisesRegex(ValueError,'aggregate'):
                 read_run_artifact(self.p,digest,4096,raw_limit=1024,raw_remaining=remaining)


 def test_opaque_sibling_objects_release_transient_key_memory(self):
     raw=b'{"status":"failed","tasks":[{"logs":['+b','.join([b'{"a":0}']*3000)+b']}]}';before=hashlib.sha256(raw).hexdigest()
     value=self.read(raw)
     self.assertEqual('failed',value['status'])
     self.assertIsInstance(value['tasks'][0]['logs'],ForensicValue)
     self.assertEqual(before,hashlib.sha256(self.p.read_bytes()).hexdigest())

 def test_opaque_owned_root_siblings_release_transient_key_memory(self):
     raw=b'{"tasks":[{"owned_roots":[{"logs":['+b','.join([b'{"a":0}']*3000)+b']}]}]}'
     value=self.read(raw)
     self.assertIsInstance(value['tasks'][0]['owned_roots'][0]['logs'],ForensicValue)

 def test_opaque_live_object_and_nested_key_sets_remain_bounded(self):
     wide=b'{'+b','.join(b'"k'+str(i).encode()+b'":0' for i in range(500))+b'}'
     nested=b'0'
     for _ in range(12):
         nested=b'{'+b','.join(b'"k'+str(i).encode()+b'":0' for i in range(10))+b',"child":'+nested+b'}'
     for payload in (wide,nested):
         with self.subTest(payload_length=len(payload)),self.assertRaisesRegex(ValueError,'materialization bound'):
             self.read(b'{"tasks":[{"logs":'+payload+b'}]}')

 def test_opaque_tail_still_checks_decoded_duplicates_and_grammar(self):
     prefix=b'{"tasks":[{"logs":['+b','.join([b'{"a":0}']*3000)+b','
     for tail in (b'{"a":0,"\\u0061":1}]}]}',b'{"x":"bad\\q"}]}]}',b'{"x":01}]}]}',b'{"x":"bad\xff"}]}]}'):
         with self.subTest(tail=repr(tail)),self.assertRaisesRegex((ValueError,UnicodeDecodeError),'duplicate|escape|scalar|utf-8'):
             self.read(prefix+tail)

 def test_retained_sibling_values_keep_materialization_accounting(self):
     raw=b'{"retained":['+b','.join([b'"a"']*500)+b']}'
     with self.assertRaisesRegex(ValueError,'materialization bound'):
         self.read(raw)



class InterruptedFreshBoundary(unittest.TestCase):
    """PR1918 native boundary captures, never synthetic release or success fixtures.

    These tests document why neither accepted older contract is the recovery
    authority. Positive fresh custody still requires the canonical producer,
    post-release consumer and publication record; these tests grant no custody.
    """
    RECEIPT = {'token': '4ee3b87f768d4631ad68739dafcf7032',
 'source': {'head': '2d4c45c0da9c56e7145b2f3df8114cc5b95b7bb3',
            'digest': '2cc09984798fed0d84196b7715677f5af083e0aac6277f8441054adf4622f2ec'},
 'gate': 'smoke',
 'status': 'FAIL',
 'cases': {'test-mass-agent-run-0': 'UNVERIFIED',
           'chat-mode': 'UNVERIFIED',
           'spawn-sub-agents': 'UNVERIFIED',
           'parallel-tool-calls': 'UNVERIFIED',
           'background-agent-message-smoke': 'UNVERIFIED',
           'claude-code-agent': 'UNVERIFIED',
           'browser-smoke': 'UNVERIFIED',
           'agent-payment-test-shop': 'UNVERIFIED',
           'agent-payment-setup-resume': 'UNVERIFIED',
           'agent-payment-idempotent-abandonment': 'UNVERIFIED',
           'agent-payment-abandonment': 'UNVERIFIED',
           'browser-biometrics-webdecoy': 'UNVERIFIED',
           'agent-payment-new-user-journey': 'UNVERIFIED'},
 'native_exit': -9,
 'executed': True,
 'complete': False,
 'timed_out': False,
 'cancelled': True,
 'lingering_group': True,
 'command': ['/home/boxes/rose/agents/venv/bin/python3', '/home/boxes/rose/scripts/deploy_test_cloud.py'],
 'log': '/home/boxes/rose/.context/deploy-pipeline/attempts/4/final/smoke/output.log',
 'started_at': 1794356345.6364365,
 'finished_at': 1794356449.096868,
 'execution_binding': {'input_fingerprint': '80d8d257414a0c7e055407d42efcc76980f3e8a5089f64a08fb828ae9a02c90d',
                       'contract_digest': '7b5911eb9da076f899f658f2eb0cd8ae6ebbbc90488cbf8773277042b08f914c',
                       'environment': '68b66631658a84f29a5507045c72868df2e7a86a797d68ae25f314d302093737'},
 'lifecycle': 'native-producer',
 'native_cleanup_reference': None,
 'cleanup_owner': {'request_token': '4ee3b87f768d4631ad68739dafcf7032',
                   'worker_root': '/home/boxes/rose',
                   'native_cleanup_reference': None},
 'worker_result': None}
    SUMMARY = {'campaign_id': 'deploy-ccbb94ee0e246be9e4651d3a5b6214e8c2dbfe45d9a411ca8346e095f87522ef',
 'status': 'running',
 'started_at': '2026-11-11T00:19:11.917075+00:00',
 'finished_at': None,
 'runs': 1,
 'retry_infra': 0,
 'task_count': 13,
 'total_jobs': 13,
 'peak_concurrency': 13,
 'jobs': [{'job_id': 'r001-j0001',
           'task': 'test-mass-agent-run-0',
           'controller_pid': 3802154,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0002',
           'task': 'chat-mode',
           'controller_pid': 3802157,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0003',
           'task': 'spawn-sub-agents',
           'controller_pid': 3802161,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0004',
           'task': 'parallel-tool-calls',
           'controller_pid': 3802166,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0005',
           'task': 'background-agent-message-smoke',
           'controller_pid': 3802169,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0006',
           'task': 'claude-code-agent',
           'controller_pid': 3802173,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0007',
           'task': 'browser-smoke',
           'controller_pid': 3802177,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0008',
           'task': 'agent-payment-test-shop',
           'controller_pid': 3802182,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0009',
           'task': 'agent-payment-setup-resume',
           'controller_pid': 3802185,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0010',
           'task': 'agent-payment-idempotent-abandonment',
           'controller_pid': 3802196,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0011',
           'task': 'agent-payment-abandonment',
           'controller_pid': 3802201,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0012',
           'task': 'browser-biometrics-webdecoy',
           'controller_pid': 3802208,
           'status': 'running',
           'controller_exit_code': None},
          {'job_id': 'r001-j0013',
           'task': 'agent-payment-new-user-journey',
           'controller_pid': 3802211,
           'status': 'running',
           'controller_exit_code': None}]}


    def test_exact_null_adapter_retains_native_path_none_refusal(self):
        import deploy_test_native_cleanup as native
        receipt = copy.deepcopy(self.RECEIPT)
        before = copy.deepcopy(receipt)
        with self.assertRaisesRegex(TypeError, 'NoneType'):
            native.validate(receipt, receipt['cleanup_owner'], {
                'kind': native.KIND, 'owner': receipt['cleanup_owner'],
                'request_token': receipt['token'], 'source': receipt['source']})
        self.assertEqual(receipt, before)
        self.assertEqual(list(receipt['cases'].values()), ['UNVERIFIED'] * 13)

    def test_running_summary_is_not_cancelled_zero_allocation_authority(self):
        import hashlib
        import deploy_test_interrupted_cleanup as old
        receipt, summary = copy.deepcopy(self.RECEIPT), copy.deepcopy(self.SUMMARY)
        root = Path(receipt['cleanup_owner']['worker_root'])
        base = root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
        campaign = base / 'campaigns' / summary['campaign_id']
        raw = {str(base / 'cli.log'): (str(campaign) + '\n').encode(),
               str(campaign / 'summary.json'): json.dumps(summary).encode()}
        evidence = old.Evidence({p: hashlib.sha256(v).hexdigest() for p, v in raw.items()}, raw)
        gate = dict(name='smoke', category='smoke', native_cloud=True,
                    worker_transport='benchmark-cloud-cli', cwd=str(root), env={},
                    command=receipt['command'], checks=list(receipt['cases']))
        with self.assertRaisesRegex(ValueError, 'complete original campaign inventory required'):
            old.cloud(root, gate, receipt, Path(receipt['log']).parent, {}, evidence)
        self.assertEqual(summary, self.SUMMARY)
        self.assertIsNone(summary['finished_at'])
        self.assertEqual({j['status'] for j in summary['jobs']}, {'running'})

    def test_native_publication_does_not_accept_a_running_summary(self):
        import runpy
        from deploy_test_cloud import campaign_published
        native = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        summary = copy.deepcopy(self.SUMMARY)
        for job in summary['jobs']:
            job['run'] = 1
        # Exercise the actual source-owned schedule producer. It preserves the
        # absent end, so a normal final-publication verifier cannot consume it.
        record = native['campaign_group_record'](summary)
        with tempfile.TemporaryDirectory() as directory:
            campaign = Path(directory)
            (campaign / 'hub-group.json').write_text(json.dumps(record))
            (campaign / 'hub-group-publication-ack.private.json').write_text('{}')
            with self.assertRaisesRegex(TypeError, 'fromisoformat'):
                campaign_published(summary, campaign, self.RECEIPT['started_at'], native)
        self.assertIsNone(summary['finished_at'])
        self.assertEqual(self.RECEIPT['cases'], dict.fromkeys(self.RECEIPT['cases'], 'UNVERIFIED'))

    def test_existing_zero_allocation_contract_still_refuses_fresh_resources(self):
        fixture = InterruptedCustody()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        state, receipt, proof = fixture.fixture(cloud=True)
        # Use the established producer fixture and its seal writer. The old
        # contract must reject allocations even when its summary is terminal.
        fixture.put(fixture.audit / 'owned-clones.ids', '82ddd00ce36728\n683ed57a572168\n')
        fixture.reseal(proof)
        fixture.rebind(proof)
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, 'provider allocation was recorded'):
            c.reconcile(state, receipt['token'], proof)
        self.assertEqual(state, before)



class InterruptedFreshRecovery(unittest.TestCase):
    """Real no-start producer fixtures through the public custody dispatcher."""
    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, (dict, list)) else value)

    def setUp(self):
        import hashlib, runpy, shutil
        import deploy_test_interrupted_fresh_cleanup as fresh
        from cloudbench_execution_provenance import build_config, build_task_matrix
        self.m = fresh
        controls = runpy.run_path(str(ROOT / 'scripts/tests/cloudbench-prestart-recovery.test.py'))
        self.h = controls['FreshPrestartRecoveryTest']()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        self.hm = controls['MODULE']
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        subprocess.run(['git','init','-q',str(self.root)], check=True)
        common = subprocess.check_output(['git','-C',str(ROOT),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
        self.put(self.root / '.git/objects/info/alternates', common + '/objects\n')
        self.head = '2d4c45c0da9c56e7145b2f3df8114cc5b95b7bb3'
        for name in fresh.POLICIES:
            data = subprocess.check_output(['git','-C',str(ROOT),'show',self.head+':'+name])
            path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        for name in ('cloudbench-prestart-recovery.py','deploy_test_interrupted_fresh_cleanup.py',
                     'deploy_test_interrupted_cleanup.py','deploy_test_native_cleanup.py'):
            shutil.copyfile(ROOT/'scripts'/name,self.root/'scripts'/name)
        self.r=copy.deepcopy(InterruptedFreshBoundary.RECEIPT)
        self.r.update(source={'head':self.head,'digest':'d'*64},started_at=time.time()-100,finished_at=time.time()-90)
        self.r['command']=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')]
        self.r['cleanup_owner']['worker_root']=str(self.root)
        self.gate=dict(name='smoke',category='smoke',native_cloud=True,command=self.r['command'],checks=list(self.r['cases']))
        self.r['execution_binding']['contract_digest']=c.digest(self.gate)
        self.r['execution_binding']['environment']='e'*64
        self.folder=self.root/'.context/deploy-pipeline/attempts/4/final/smoke'
        self.r['log']=str(self.folder/'output.log')
        for name in ('output.log','stderr.log'):self.put(self.folder/name,'')
        self.put(self.folder/'receipt.json',self.r)
        self.put(self.folder/'request.json',dict(token=self.r['token'],source=self.r['source'],gate='smoke',checks=self.gate['checks'],skips={},phase='final',custody_runtime={'agents/.env':'c'*64},custody_child_environment='c'*64))
        self.base=self.root/'.context/deploy-cloud'/hashlib.sha256(self.r['token'].encode()).hexdigest()
        self.runs=self.base/'runs';self.runs.mkdir(parents=True)
        self.campaign=self.base/'campaigns'/('deploy-'+self.base.name);self.campaign.mkdir(parents=True)
        self.put(self.base/'cli.log',str(self.campaign))
        self.state=dict(source=self.r['source'],environment='e'*64,phase='interrupted',resume_phase='final',ready=False,
                        plan={'source':self.r['source'],'gates':[self.gate]},attempts=[{'phase':'final','interrupted':True,'results':[self.r]}],
                        failures=[{'id':'ui-'+str(i),'status':'FAIL'} for i in range(5)],pending=[],reconciled_owners={'older':{'token':'owed','credit_granted':False}})
        self.now=time.time()-10
        self.proof=dict(kind=fresh.KIND,root=str(self.root),files={},confirmed_at=self.now,observed_by='owning fixture',
                        recovery_directory=str(self.root/'.context/recovery'))
        self.relay=Path(tempfile.mkdtemp(prefix='cb-relay-')).resolve()
        self.addCleanup(shutil.rmtree,self.relay)
        # tempfile uses exactly eight random characters, matching the native relay namespace.
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        birth=lambda n:f'proc-start:{boot}:{n}'
        self.parent_pid=99999998;hubpid=99999099
        hub=self.runs/'_hub'/('agent-link-server.8765.'+'c'*32+'.owner')
        self.put(hub, '\n'.join(f'{k}={v}' for k,v in dict(version=1,pid=hubpid,pid_start=birth(10),pgid=hubpid,owner_token='c'*32,
            command=str(self.root/'agents/benchmarks/agent_link_server.py'),argv_sha256='a'*64,root=str(self.runs),runs_root=str(self.runs),
            repo_root=str(self.root),context_dir=str(self.runs/'_hub'),host='127.0.0.1',port=8765,status='live-transfer-required').items())+'\n')
        hub.chmod(0o444)
        self.hub=hub
        self.summary=copy.deepcopy(InterruptedFreshBoundary.SUMMARY)
        self.summary['started_at']=__import__('datetime').datetime.fromtimestamp(self.r['started_at']+1,__import__('datetime').timezone.utc).isoformat()
        pids=[]
        for i,job in enumerate(self.summary['jobs']):
            pid=99999000+i;pids.append(pid);owner=hashlib.md5(str(i).encode()).hexdigest()
            fleet=self.runs/f'20260101-000000-{pid}';(fleet/'_batch').mkdir(parents=True)
            job.update(controller_pid=pid,run=1,attempt=1,attempts=[],finished_at=None,started_at=self.summary['started_at'],
                       controller_command=['bash',str(self.root/'scripts/run-bench'),job['task'],'--ref',self.head,'--foreground'])
            job['log']=str(self.campaign/(job['job_id']+'.log'))
            self.put(Path(job['log']),f'{self.root}/scripts/run-bench monitor {fleet}\nowner: {owner}; private controller diagnostics stay in this run directory.\n')
            self.put(fleet/'_batch/benches.json',[{'name':job['task']}])
            matrix=build_task_matrix([job['task']+'=real'])
            config=build_config('cloudbench-fleet-config-v1',['task_matrix_sha256='+matrix['sha256'],'task_count=1'])
            self.put(fleet/'execution-provenance.json',dict(schema_version='cloudbench-execution-provenance-v1',base_sha=self.head,
                     workspace_patch_sha256='none',controller_snapshot={'schema_version':'cloudbench-controller-snapshot-v1','sha256':'a'*64},config=config))
            self.put(fleet/'execution-task-matrix.json',matrix)
            parent_provenance=json.loads((fleet/'execution-provenance.json').read_text())
            self.put(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=143,execution_provenance=parent_provenance,execution_task_matrix=matrix,
                tasks=[dict(name=job['task'],passed=False,status='INFRA_ERROR',lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            self.put(fleet/'_batch/disposable-cleanup.json',dict(schema='disposable-cleanup-v1',owner=owner,
                guest_cleanup_missing=False,runtime_evidence_missing=False,successful_runtime_inferred=False))
            self.put(fleet/'_batch/llm-usage.json',dict(run_id=fleet.name,providers={'native':dict(calls=0,input_tokens=0,output_tokens=0,cost_usd=0,models={})}))
            audit=self.root/'.git/cloudbench-fleet-audits'/owner
            self.put(audit/'meta',f'version=1\nfleet_owner_token={owner}\nrun_id={fleet.name}\nworkspace_root={self.root}\nstatus=provider-teardown-verified\nhub_owner_file={hub}\n')
            self.put(audit/'provider-teardown-verified.epoch',str(int(self.now)-1))
            for name in ('owned-clones.ids','owned-clones.names'):self.put(audit/name,'')
            self.put(fleet/'teardown-ownership.path',str(audit)+'\n')
        self.put(self.campaign/'summary.json',self.summary)
        first=next(p for p in self.runs.iterdir() if p.name.endswith('99999000'))
        for name in ('run.json','disposable-cleanup.json','llm-usage.json'):(first/'_batch'/name).unlink()
        # Relocate the established native producer fixture before generating any receipt.
        h=self.h;oldrun=h.run;oldregistry=h.registry;oldaudit=h.audit
        h.run_id='20260929-032004-99999999';h.run=self.runs/h.run_id
        shutil.move(str(oldrun),h.run)
        h.audit_root=self.root/'.git/cloudbench-fleet-audits';h.audit=h.audit_root/h.owner
        shutil.move(str(oldaudit),h.audit)
        h.registry=self.root/'.git/cloudbench-fleet-ownership'/h.owner;h.registry.parent.mkdir(parents=True)
        shutil.move(str(oldregistry),h.registry)
        h.scripts=self.root/'scripts';h.workspace=self.root
        text=(h.registry/'meta').read_text().replace(str(oldrun.parent),str(self.runs)).replace(str(oldaudit),str(h.audit))
        text=text.replace('run_id=20260929-032004-9714','run_id='+h.run_id).replace(str(ROOT),str(self.root))
        self.put(h.registry/'meta',text)
        for path in (h.audit/'fresh').iterdir():path.write_text(path.read_text().replace('20260929-032004-9714',h.run_id))
        self.put(h.audit/'meta',f'version=1\nfleet_owner_token={h.owner}\nrun_id={h.run_id}\napp={h.app}\nworkspace_root={self.root}\nhub_owner_file={hub}\n')
        matrix=build_task_matrix([bench+'=real' for bench,_,_ in h.mapping])
        value=json.loads((h.run/'execution-provenance.json').read_text())
        value['config']=build_config('cloudbench-fleet-config-v1',['boot_launch=1','requested_boot_transport=config','task_matrix_sha256='+matrix['sha256'],'task_count=2'])
        self.put(h.run/'execution-provenance.json',value);self.put(h.run/'execution-task-matrix.json',matrix)
        self.put(h.run/'teardown-ownership.path',str(h.audit)+'\n')
        for machinepath in h.native.glob('*.json'):
            value=json.loads(machinepath.read_text())
            if isinstance(value,dict):value['config']['env']['CLOUDBENCH_START_BARRIER']=h.run_id
            machinepath.write_text(json.dumps(value))
        self.put(Path(self.summary['jobs'][0]['log']),Path(self.summary['jobs'][0]['log']).read_text()+
                 f'mode: --infra-probe (strict barrier, no LLM / run_benchmark)\n{self.root}/scripts/run-bench monitor {h.run}\nowner: {h.owner}; private controller diagnostics stay in this run directory.\n')
        sharedids=[self.parent_pid,99999101,99999102,99999103,99999104,hubpid]
        allpids=pids+[99999999]+sharedids
        self.supervisor=dict(supervisor_pid=99999997,child_pid=self.parent_pid,native_exit=-9,cancelled=True,timed_out=False,
                             quiescent=True,orphaned_children=True,remaining=[],error=None,reaped=[dict(pid=p,status=9) for p in allpids],term_sent=allpids,kill_sent=allpids)
        self.put(self.base/'cli.log.process.json',self.supervisor)
        inv={'pid':'99999104','pid_start':birth(5),'parent_pid':str(self.parent_pid),'parent_start':birth(1)}
        authority=dict(schema='shared-relay-authority-v1',app=h.app,org_slug='personal',network='',parent_pid=self.parent_pid,
                       parent_start=birth(1),source_sha256=c.sha_file(self.root/'scripts/cloudbench-shared-relay.py'),
                       agent_socket=str(self.relay/'fly-agent.sock'),inventory_directory=str(self.campaign/'shared-inventory'),
                       inventory_owner=inv,allowed_remote_ports=[3001,3003,8011],deadline=1e300)
        self.put(self.relay/'authority.private.json',authority)
        authoritysha=c.sha_file(self.relay/'authority.private.json')
        agent={'pid':99999103,'birth':birth(4),'socket_identity':[1,2],'version':'0.4.115'}
        broker={'pid':99999102,'birth':birth(3),'parent_pid':self.parent_pid,'parent_start':birth(1)}
        self.put(self.relay/'broker-owner.json',broker)
        self.put(self.relay/'bootstrap-owner.json',{'pid':99999101,'birth':birth(2),'parent_pid':self.parent_pid,'parent_start':birth(1)})
        self.put(self.relay/'startup-agent.json',{'schema':'shared-relay-startup-agent-v1','authority_sha256':authoritysha,
                 'agent':agent,'broker':{'pid':broker['pid'],'birth':broker['birth']},'parent':{'pid':self.parent_pid,'birth':birth(1)},'socket':authority['agent_socket']})
        self.put(self.relay/'ready.json',dict(authority_sha256=authoritysha,agent=agent,pid=broker['pid'],birth=broker['birth'],socket=str(self.relay/'control.sock')))
        self.put(self.relay/'serve.once.json',dict(authority_sha256=authoritysha,pid=broker['pid'],birth=broker['birth']))
        for path in self.relay.iterdir():path.chmod(0o600)
        self.put(self.campaign/'shared-relay-location.json',{'directory':str(self.relay)})
        self.put(self.campaign/'shared-inventory/owner','\n'.join(k+'='+v for k,v in inv.items())+'\n')
        self.put(h.audit/'owned-clones.ids',''.join(machine+'\n' for _,machine,_ in h.mapping))
        self.put(h.audit/'owned-clones.names',''.join('cloudbench-'+machine+'\n' for _,machine,_ in h.mapping))
        self.hm.publish(h.validate())
        shutil.rmtree(h.registry)
        with (h.audit/'meta').open('a') as stream:stream.write('status=provider-teardown-verified\n')
        self.put(h.audit/'provider-teardown-verified.epoch',str(int(self.now)-1))
        for path in (h.audit/'fresh').iterdir():path.write_text(path.read_text().replace('disposition=owned','disposition=destroyed-verified-absent'))
        self.assertEqual(self.hm.verify_released_fresh(h.audit,h.run,h.scripts)['proof_credit'],0)
        import socket
        sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        sock.bind(str(self.relay/'control.sock'));sock.close()
        os.mkfifo(self.campaign/'shared-inventory/inventory-refresh.wait')
        self.control_manifest=self.root/'control-originals.json'
        control_rows=[]
        for path in (self.relay/'control.sock',self.campaign/'shared-inventory/inventory-refresh.wait',self.campaign/'shared-inventory/owner'):
            st=path.lstat();row=dict(source=str(path),mode=st.st_mode,size=st.st_size,dev=st.st_dev,ino=st.st_ino,mtime_ns=st.st_mtime_ns,ctime_ns=st.st_ctime_ns)
            if path.is_file():
                original=self.root/'original-inventory-owner';original.write_bytes(path.read_bytes())
                row.update(copy=str(original),sha256=c.sha_file(original))
            control_rows.append(row)
        self.put(self.control_manifest,dict(observed_at=time.time(),rows=control_rows))
        self.proof['files']=self.m.capture_files(self.r,self.proof,controls_pending=True)

    def prepare_publication(self):
        import gzip, threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        records=[]
        class Hub(BaseHTTPRequestHandler):
            def do_POST(server):
                data=server.rfile.read(int(server.headers['Content-Length']))
                records.append(json.loads(gzip.decompress(data)))
                server.send_response(200);server.send_header('Content-Type','application/json');server.end_headers()
                server.wfile.write(json.dumps({'run':{'run_id':records[-1]['run_id']}}).encode())
            def log_message(*args): pass
        hub=HTTPServer(('127.0.0.1',0),Hub)
        thread=threading.Thread(target=hub.serve_forever,daemon=True);thread.start()
        state_path=self.root/'state.json';proof_path=self.root/'proof.json'
        self.put(state_path,self.state);self.put(proof_path,self.proof)
        env=dict(os.environ,BENCHMARK_HUB_UPLOAD_URL=f'http://127.0.0.1:{hub.server_port}',
                 BENCHMARK_HUB_API_KEY='local-owning-fixture',BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS='10')
        for key in list(env):
            if key.startswith('RUN_BENCH_CAMPAIGN_'):env.pop(key)
        try:
            for action in ('retire-controls','prepare','publish'):
                result=subprocess.run([sys.executable,str(ROOT/'scripts/deploy_test_interrupted_fresh_cleanup.py'),action,
                                       '--state',str(state_path),'--proof',str(proof_path),'--request-token',self.r['token'],
                                       *(['--control-manifest',str(self.control_manifest)] if action=='retire-controls' else [])],env=env,capture_output=True,text=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.proof=json.loads(proof_path.read_text())
            self.assertEqual(len(records),1)
            self.assertEqual(records[0]['tasks'],[])
            self.assertEqual(records[0]['run_group']['status'],'cancelled')
        finally:
            hub.shutdown();thread.join();hub.server_close()

    def test_public_reconcile_real_producer_closure_and_idempotence(self):
        self.prepare_publication()
        original=copy.deepcopy(self.state)
        c.reconcile(self.state,self.r['token'],self.proof)
        self.assertEqual(self.state['attempts'],original['attempts'])
        self.assertEqual(self.state['failures'],original['failures'])
        self.assertEqual(self.state['reconciled_owners']['older'],original['reconciled_owners']['older'])
        entry=self.state['reconciled_owners'][c.sha_file(self.folder/'receipt.json')]
        self.assertFalse(entry['credit_granted']);self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(set(self.r['cases'].values()),{'UNVERIFIED'})
        self.assertTrue(c._reconciled(self.state,self.r,self.r['cleanup_owner']))
        before=copy.deepcopy(self.state);c.reconcile(self.state,self.r['token'],self.proof);self.assertEqual(self.state,before)

    def test_reused_shared_pid_reconciles_and_stays_bound(self):
        # 4532674831: exercise real closure/reconciliation, with only the
        # read-only process observation replaced by a deterministic PID reuse.
        import deploy_test_interrupted_cleanup as old
        self.prepare_publication()
        c.reconcile(self.state, self.r['token'], self.proof)
        entry = self.state['reconciled_owners'][c.sha_file(self.folder/'receipt.json')]
        broker = json.loads((self.relay/'broker-owner.json').read_text())
        read_text = Path.read_text
        def observed(path, *args, **kwargs):
            if path == Path('/proc')/str(broker['pid'])/'stat':
                return str(broker['pid']) + ' (unrelated) S ' + ' '.join(['0']*18 + ['987654321'])
            return read_text(path, *args, **kwargs)
        with patch.object(old, 'processes', return_value=[(broker['pid'], 88888888)]), \
                patch.object(Path, 'read_text', observed):
            self.assertTrue(self.m.still_bound(self.state, self.r, entry))
            key, actual = self.m.reconciliation(self.state, self.r['token'], self.proof)
            self.assertEqual(actual, entry)
            self.assertEqual(key, c.sha_file(self.folder/'receipt.json'))

    def test_pid_reuse_keeps_original_group_and_unknown_identity_guards(self):
        import deploy_test_interrupted_cleanup as old
        self.prepare_publication()
        c.reconcile(self.state, self.r['token'], self.proof)
        entry = self.state['reconciled_owners'][c.sha_file(self.folder/'receipt.json')]
        broker = json.loads((self.relay/'broker-owner.json').read_text())
        read_text = Path.read_text
        scenarios = [
            ('original birth', [(broker['pid'], 88888888)], broker['birth'].rsplit(':', 1)[1]),
            ('original group descendant', [(88888887, broker['pid'])], '987654321'),
            ('reused group leader remains ambiguous', [(broker['pid'], broker['pid'])], '987654321'),
            ('unknown supervisor birth', [(self.supervisor['supervisor_pid'], 88888888)], '987654321'),
        ]
        for label, rows, start in scenarios:
            def observed(path, *args, **kwargs):
                if path == Path('/proc')/str(broker['pid'])/'stat':
                    return str(broker['pid']) + ' (observed) S ' + ' '.join(['0']*18 + [start])
                return read_text(path, *args, **kwargs)
            with self.subTest(label=label), patch.object(old, 'processes', return_value=rows), \
                    patch.object(Path, 'read_text', observed):
                self.assertFalse(self.m.still_bound(self.state, self.r, entry))
                with self.assertRaises(ValueError):
                    self.m.reconciliation(self.state, self.r['token'], self.proof)
        for guard in ('namespace_quiet', 'no_holders'):
            with self.subTest(guard=guard), patch.object(self.m, guard, side_effect=ValueError('live consumer')):
                self.assertFalse(self.m.still_bound(self.state, self.r, entry))
                with self.assertRaises(ValueError):
                    self.m.reconciliation(self.state, self.r['token'], self.proof)

    def fresh_witness_renewal_fixture(self):
        # Captured original receipt/summary, original committed consumer bytes,
        # and real native closure/publication in the existing local fixture.
        import hashlib
        witness_head = '65584b8b59489aaef09334af1714a936716b0f96'
        names = ('scripts/deploy_test_interrupted_fresh_cleanup.py',
                 'scripts/cloudbench-prestart-recovery.py')
        for name in names:
            raw = subprocess.check_output(['git', '-C', str(ROOT), 'show', witness_head + ':' + name])
            (self.root/name).write_bytes(raw)
        self.proof['files'] = {}
        self.proof['files'] = self.m.capture_files(self.r, self.proof, controls_pending=True)
        native_scripts = str(ROOT/'scripts')
        with patch.object(sys.modules[__name__], 'ROOT', self.root), \
                patch.dict(os.environ, {'PYTHONPATH': native_scripts}):
            self.prepare_publication()
        c.reconcile(self.state, self.r['token'], self.proof)
        key = c.sha_file(self.folder/'receipt.json')
        previous = copy.deepcopy(self.state['reconciled_owners'][key])
        for name in names:
            (self.root/name).write_bytes((ROOT/name).read_bytes() + b'\n# current consumer revision\n')
        self.assertFalse(self.m.still_bound(self.state, self.r, previous))
        subprocess.run(['git', '-C', str(self.root), 'update-ref', 'HEAD', witness_head], check=True)
        # Keep test evidence out of the current source digest, as in the real repo.
        self.put(self.root/'.git/info/exclude', '.context/\ncontrol-originals.json\noriginal-inventory-owner\n')
        self.state['phase'] = 'focused'
        self.state.pop('resume_phase')
        request = dict(kind='interrupted-fresh-policy-witness-renewal-v1', receipt_sha256=key,
                       previous_entry_sha256=c.digest(previous), source_head=witness_head,
                       current_source=c.source(self.root),
                       relocations={str(self.root/name): 'git:' + subprocess.check_output(
                           ['git', '-C', str(self.root), 'rev-parse', witness_head + ':' + name], text=True).strip()
                           for name in names}, confirmed_at=time.time(), observed_by='owning local fixture')
        return previous, request

    def test_fresh_witness_renewal_preserves_original_and_replays(self):
        previous, request = self.fresh_witness_renewal_fixture()
        original = copy.deepcopy(self.state)
        c.reconcile(self.state, self.r['token'], request)
        entry = self.state['reconciled_owners'][request['receipt_sha256']]
        self.assertEqual(entry['policy_witness_renewal']['previous'], previous)
        self.assertEqual(entry['proof'], previous['proof'])
        self.assertTrue(self.m.still_bound(self.state, self.r, entry))
        self.assertEqual(self.state['source'], original['source'])
        self.assertEqual(self.state['plan'], original['plan'])
        self.assertNotEqual(self.state['source'], request['current_source'])
        self.assertEqual(self.state['attempts'], original['attempts'])
        self.assertEqual(self.state['failures'], original['failures'])
        renewed = copy.deepcopy(self.state)
        c.reconcile(self.state, self.r['token'], request)
        self.assertEqual(self.state, renewed)

    def test_fresh_witness_renewal_refuses_unbound_data_and_live_custody(self):
        previous, request = self.fresh_witness_renewal_fixture()
        bad_requests = []
        for key, value in (('previous_entry_sha256', '0'*64), ('receipt_sha256', '0'*64),
                           ('source_head', self.head), ('observed_by', ''), ('confirmed_at', 0),
                           ('current_source', {'head': '0'*40, 'digest': '0'*64})):
            bad = copy.deepcopy(request);bad[key] = value;bad_requests.append(bad)
        for old, destination in ((str(self.folder/'receipt.json'), next(iter(request['relocations'].values()))),
                                 (next(iter(request['relocations'])), 'git:'+'0'*40),
                                 (next(iter(request['relocations'])), str(self.root/'arbitrary.py'))):
            bad = copy.deepcopy(request);bad['relocations'] = {old: destination};bad_requests.append(bad)
        for bad in bad_requests:
            before = copy.deepcopy(self.state)
            with self.subTest(request=bad), self.assertRaises((ValueError, subprocess.SubprocessError)):
                c.reconcile(self.state, self.r['token'], bad)
            self.assertEqual(self.state, before)
        for mutation in ('running', 'live_failures', 'source', 'contract', 'owner', 'token'):
            state = copy.deepcopy(self.state)
            if mutation == 'running': state['running'] = {'pid': 123}
            elif mutation == 'live_failures': state['live_failures'] = []
            elif mutation == 'source': state['source'] = {'head': '0'*40, 'digest': '0'*64}
            elif mutation == 'contract': state['plan']['gates'][0]['command'] = ['foreign-command']
            else:
                receipt = state['attempts'][0]['results'][0]
                if mutation == 'owner': receipt['cleanup_owner']['request_token'] = 'foreign-owner'
                else: receipt['token'] = 'foreign-token'
            before = copy.deepcopy(state)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                c.reconcile(state, self.r['token'], request)
            self.assertEqual(state, before)
        data = Path(self.proof['recovery_directory'])/'hub-group.json'
        original = data.read_bytes()
        try:
            data.write_bytes(original + b'\n')
            with self.assertRaises(ValueError):
                c.reconcile(self.state, self.r['token'], request)
        finally:
            data.write_bytes(original)
        for guard in ('namespace_quiet', 'no_holders'):
            with patch.object(self.m, guard, side_effect=ValueError('live consumer')), self.assertRaises(ValueError):
                c.reconcile(self.state, self.r['token'], request)
        import deploy_test_interrupted_cleanup as old
        with patch.object(old, 'processes', return_value=[(88888887, self.parent_pid)]), self.assertRaises(ValueError):
            c.reconcile(self.state, self.r['token'], request)
        # The current verifier executes even when its historical read witness is relocated.
        with (self.root/'scripts/cloudbench-prestart-recovery.py').open('a') as stream:
            stream.write("\ndef verify_released_fresh(*args, **kwargs): raise ValueError('current verifier ran')\n")
        request['current_source'] = c.source(self.root)
        with self.assertRaisesRegex(ValueError, 'current verifier ran'):
            c.reconcile(self.state, self.r['token'], request)

    def test_every_original_controller_wait_is_required_atomically(self):
        self.prepare_publication()
        original=(self.base/'cli.log.process.json').read_bytes()
        for job in self.summary['jobs']:
            value=json.loads(original);value['reaped']=[r for r in value['reaped'] if r['pid']!=job['controller_pid']]
            self.put(self.base/'cli.log.process.json',value)
            self.proof['files'][str(self.base/'cli.log.process.json')]=c.sha_file(self.base/'cli.log.process.json')
            before=copy.deepcopy(self.state)
            with self.assertRaises((ValueError,KeyError)):c.reconcile(self.state,self.r['token'],self.proof)
            self.assertEqual(self.state,before)
        (self.base/'cli.log.process.json').write_bytes(original)
        self.proof['files'][str(self.base/'cli.log.process.json')]=c.sha_file(self.base/'cli.log.process.json')

    def test_missing_native_publication_and_nested_audit_refuse_atomically(self):
        self.prepare_publication()
        for path in (Path(self.proof['recovery_directory'])/'publication.json',self.h.audit/'provider-teardown-verified.epoch'):
            original=path.read_bytes();path.unlink();before=copy.deepcopy(self.state)
            with self.assertRaises((ValueError,OSError)):c.reconcile(self.state,self.r['token'],self.proof)
            self.assertEqual(self.state,before);path.write_bytes(original)


    def test_semantic_negative_controls_refuse_atomically(self):
        import hashlib
        self.prepare_publication()
        proof_path=self.h.run/'_batch/fresh-prestart-recovery.json'
        output=self.h.run/self.h.mapping[0][0]
        machine=self.h.mapping[0][1]
        out=Path(self.proof['recovery_directory'])
        parent=self.runs/self.summary['jobs'][1]['log'].split('/')[-1]  # choose by native PID below
        parent=next(p for p in self.runs.iterdir() if p.name.endswith(str(self.summary['jobs'][1]['controller_pid'])))
        parent_audit=Path((parent/'teardown-ownership.path').read_text().strip())
        def edit(document, keys, value):
            obj=json.loads(document)
            target=obj
            for key in keys[:-1]:target=target[key]
            target[keys[-1]]=value
            return json.dumps(obj).encode()
        faults=[
            ('nested-owner',proof_path,lambda b:edit(b,['owner'],'0'*32)),
            ('producer-refused',proof_path,lambda b:edit(b,['proof_credit'],1)),
            ('started-guest',proof_path,lambda b:edit(b,['native',machine,1,'state'],'started')),
            ('foreign-token',proof_path,lambda b:edit(b,['native',machine,1,'config','env','CLOUDBENCH_RUN_TOKEN'],'foreign')),
            ('foreign-volume',proof_path,lambda b:edit(b,['native',machine,1,'config','mounts',0,'volume'],'vol_foreign')),
            ('changed-payload',output/'cloudbench-boot-payload.json.gz',lambda b:b+b'foreign'),
            ('parent-pending',parent_audit/'meta',lambda b:b.replace(b'provider-teardown-verified',b'incomplete')),
            ('nested-pending',self.h.audit/'meta',lambda b:b.replace(b'provider-teardown-verified',b'incomplete')),
            ('retained-hub',self.hub,lambda b:b.replace(b'pid=99999099',('pid='+str(os.getpid())).encode())),
            ('foreign-capability',self.relay/'authority.private.json',lambda b:edit(b,['source_sha256'],'f'*64)),
            ('publication-refused',out/'publication.json',lambda b:edit(b,['published'],False)),
            ('publication-wrong-source',out/'publication.json',lambda b:edit(b,['source_sha256'],'f'*64)),
            ('fake-original-result',self.folder/'receipt.json',lambda b:edit(b,['worker_result'],'fake-result.json')),
            ('changed-old-summary',self.campaign/'summary.json',lambda b:edit(b,['status'],'failed')),
            ('changed-source',parent/'execution-provenance.json',lambda b:edit(b,['base_sha'],'f'*40)),
            ('false-publication-pass',out/'recovery-summary.json',lambda b:edit(b,['status'],'passed')),
        ]
        original_proof=copy.deepcopy(self.proof)
        for label,path,change in faults:
            with self.subTest(fault=label):
                original=path.read_bytes();mode=path.stat().st_mode & 0o777;path.chmod(0o600);path.write_bytes(change(original));path.chmod(mode)
                # Challenge semantics after binding the changed observation. The
                # independent source/native/provenance authorities must reject it.
                self.proof['files'][str(path)]=c.sha_file(path)
                before=copy.deepcopy(self.state)
                with self.assertRaises(ValueError):c.reconcile(self.state,self.r['token'],self.proof)
                self.assertEqual(self.state,before)
                path.chmod(0o600);path.write_bytes(original);path.chmod(mode);self.proof=copy.deepcopy(original_proof)
        for label,path in [('missing-native-publication',out/'publication.json'),
                           ('missing-nested-audit',self.h.audit/'provider-teardown-verified.epoch'),
                           ('missing-parent-audit',parent_audit/'provider-teardown-verified.epoch')]:
            with self.subTest(fault=label):
                original=path.read_bytes();path.unlink();before=copy.deepcopy(self.state)
                with self.assertRaises(ValueError):c.reconcile(self.state,self.r['token'],self.proof)
                self.assertEqual(self.state,before);path.write_bytes(original)
        for label,path in [('retained-registry',self.h.registry),('active-lease',self.relay/'leases/foreign'),
                           ('unknown-worker',parent/self.summary['jobs'][1]['task']/'worker-clones.ids')]:
            with self.subTest(fault=label):
                if label=='retained-registry':path.mkdir()
                else:
                    path.parent.mkdir(exist_ok=True,parents=True);path.write_text('unknown')
                    self.proof['files'][str(path)]=c.sha_file(path)
                before=copy.deepcopy(self.state)
                with self.assertRaises(ValueError):c.reconcile(self.state,self.r['token'],self.proof)
                self.assertEqual(self.state,before)
                if label=='retained-registry':path.rmdir()
                else:path.unlink()
                self.proof=copy.deepcopy(original_proof)
        before=copy.deepcopy(self.state)
        self.state['source']={'head':'f'*40,'digest':'a'*64}
        changed=copy.deepcopy(self.state)
        with self.assertRaises(ValueError):c.reconcile(self.state,self.r['token'],self.proof)
        self.assertEqual(self.state,changed);self.state=before
        self.assertEqual(len(self.state['failures']),5)
        self.assertEqual(set(self.r['cases'].values()),{'UNVERIFIED'})

    def test_live_namespace_consumer_refuses_without_changing_state(self):
        self.prepare_publication()
        process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],cwd=self.base)
        try:
            before=copy.deepcopy(self.state)
            with self.assertRaisesRegex(ValueError,'consumer|holder'):
                c.reconcile(self.state,self.r['token'],self.proof)
            self.assertEqual(self.state,before)
        finally:
            process.terminate();process.wait(timeout=5)



    def test_control_retirement_refuses_inode_changes_and_open_holders(self):
        manifest=json.loads(self.control_manifest.read_text())
        original=copy.deepcopy(manifest)
        manifest['rows'][0]['ino']+=1
        self.put(self.control_manifest,manifest)
        with self.assertRaisesRegex(ValueError,'inode changed'):
            self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        self.put(self.control_manifest,original)
        owner=self.campaign/'shared-inventory/owner'
        with owner.open('rb'):
            with self.assertRaisesRegex(ValueError,'holder'):
                self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        self.assertFalse((Path(self.proof['recovery_directory'])/'control-retirement-intent.json').exists())
        self.assertTrue(owner.exists());self.assertTrue((self.relay/'control.sock').exists())

    def test_control_retirement_joined_kernel_socket_is_mandatory(self):
        import socket
        path=self.relay/'control.sock';path.unlink()
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(path));server.listen()
        try:
            manifest=json.loads(self.control_manifest.read_text());st=path.lstat()
            row=next(r for r in manifest['rows'] if r['source']==str(path))
            row.update(mode=st.st_mode,size=st.st_size,dev=st.st_dev,ino=st.st_ino,mtime_ns=st.st_mtime_ns,ctime_ns=st.st_ctime_ns)
            self.put(self.control_manifest,manifest)
            with self.assertRaisesRegex(ValueError,'holder|kernel'):
                self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
            self.assertTrue(path.exists())
        finally:server.close()

    def test_control_retirement_partial_retry_and_repeat_are_idempotent(self):
        fifo=self.campaign/'shared-inventory/inventory-refresh.wait'
        unlink=Path.unlink
        def interrupted(path,*args,**kwargs):
            if path==fifo:raise OSError('injected interruption after the first unlink')
            return unlink(path,*args,**kwargs)
        before=copy.deepcopy(self.state)
        with patch.object(Path,'unlink',interrupted):
            with self.assertRaisesRegex(OSError,'injected interruption'):
                self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        self.assertFalse((self.relay/'control.sock').exists());self.assertTrue(fifo.exists())
        first=self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        second=self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        self.assertEqual(first,second);self.assertEqual(self.state,before)
        self.assertTrue(first['verified_absent'])
        self.assertFalse(fifo.exists());self.assertFalse((self.campaign/'shared-inventory/owner').exists())


    def test_control_retirement_preview_is_read_only(self):
        before=copy.deepcopy(self.proof)
        paths=[Path(r['source']) for r in json.loads(self.control_manifest.read_text())['rows']]
        identities=[(p.lstat().st_ino,p.lstat().st_ctime_ns) for p in paths]
        result=self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest,dry_run=True)
        self.assertTrue(result['dry_run']);self.assertEqual(self.proof,before)
        self.assertEqual([(p.lstat().st_ino,p.lstat().st_ctime_ns) for p in paths],identities)
        self.assertFalse(Path(self.proof['recovery_directory']).exists())

    def test_control_retirement_crash_after_final_unlink_and_stale_proof_retry(self):
        owner=self.campaign/'shared-inventory/owner'
        unlink=Path.unlink
        def after_final_unlink(path,*args,**kwargs):
            result=unlink(path,*args,**kwargs)
            if path==owner:raise OSError('injected crash after final owner unlink')
            return result
        original=copy.deepcopy(self.proof)
        with patch.object(Path,'unlink',after_final_unlink):
            with self.assertRaisesRegex(OSError,'after final owner unlink'):
                self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        self.assertFalse(owner.exists());self.assertEqual(self.proof,original)
        first=self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)
        # Model a crash after the operation receipt, before the CLI saved proof.
        second=self.m.retire_controls(self.state,self.r,original,self.gate,self.control_manifest)
        self.assertEqual(first,second)
        self.assertNotIn(str(owner),original['files'])
        self.assertIn(str(self.root/'original-inventory-owner'),original['files'])

    def test_control_intent_directory_is_durable_before_first_unlink(self):
        recovery=Path(self.proof['recovery_directory']);synced=[]
        sync=self.m.fsync_directory;unlink=Path.unlink
        def checked_sync(path):
            result=sync(path);synced.append(path);return result
        def checked_unlink(path,*args,**kwargs):
            self.assertIn(recovery,synced)
            self.assertIn(recovery.parent,synced)
            return unlink(path,*args,**kwargs)
        with patch.object(self.m,'fsync_directory',checked_sync),patch.object(Path,'unlink',checked_unlink):
            self.m.retire_controls(self.state,self.r,self.proof,self.gate,self.control_manifest)

if __name__=='__main__':unittest.main()
