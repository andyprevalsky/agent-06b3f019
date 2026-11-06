#!/usr/bin/env python3
import copy
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

    def test_agentcard_opt_out_records_skip_without_reducing_other_all_categories(self):
        self.template['gates'].append({'name':'payment','category':'agentcard-lifecycle',
                                      'command':['true'],'checks':['card']})
        self.result.update(all=True,reasons=['unmapped source'])
        plan=p.select(self.template,['new-language/source'],self.result,self.bindings,
                      skip_agentcard='operator elected no live payment test')
        self.assertEqual(7,len(plan['gates']))
        self.assertNotIn('payment',{gate['name'] for gate in plan['gates']})
        self.assertEqual([{'gate':'payment','category':'agentcard-lifecycle',
                          'reason':'explicit AgentCard opt-out: operator elected no live payment test',
                          'disposition':'SKIPPED','executed':False}],plan['omitted'])
        self.assertEqual('payment',self.template['gates'][-1]['name'])

    def test_agentcard_opt_out_rejects_blank_reason(self):
        with self.assertRaisesRegex(ValueError,'nonempty reason'):
            p.select(self.template,[],self.result,self.bindings,skip_agentcard='  ')

    def test_cli_agentcard_opt_out_does_not_require_an_unused_inventory_binding(self):
        self.template['gates'].append({'name':'payment','category':'agentcard-lifecycle',
                                      'command':['true'],'checks':['card']})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); template=root/'template.json'; inventory=root/'inventory.json'; output=root/'plan.json'
            template.write_text(json.dumps(self.template));inventory.write_text('{}')
            selected=SimpleNamespace(all_lanes=True,reasons=['unmapped source'],selected=self.result['lanes'])
            def bindings(actual, *_):
                self.assertNotIn('payment',{gate['name'] for gate in actual['gates']})
                return self.bindings
            with patch.object(sys,'argv',['deploy_test_plan.py','--template',str(template),
                    '--inventory',str(inventory),'--output',str(output),'--skip-agentcard','user elected skip']), \
                    patch.object(p,'changed_files',return_value=['new-language/source']), \
                    patch.object(p.Selector,'select',return_value=selected), \
                    patch.object(p,'generate_bindings',side_effect=bindings):
                self.assertEqual(0,p.main())
            saved=json.loads(output.read_text())
            self.assertEqual('SKIPPED',saved['omitted'][0]['disposition'])
            self.assertEqual(7,len(saved['gates']))

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

if __name__=='__main__':unittest.main()
