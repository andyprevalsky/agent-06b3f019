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


def unused_local_port():
    """A loopback port nothing listens on now: the custody check asserts the host-wide socket table is
    quiet for the fixture's Hub port, so a live benchmark Hub on the default 8765 must not be reused."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


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
            owner='b'*32; self.hub_port=str(unused_local_port()); hub=runs/'_hub'/('agent-link-server.'+self.hub_port+'.'+'c'*32+'.owner')
            self.hub=hub; self.fleet=fleet; self.audit=self.root/'.git/cloudbench-fleet-audits'/owner
            self.put(hub,'version=1\npid=2147483004\npgid=2147483004\npid_start=proc-start:fixture:1\nowner_token='+ 'c'*32+
                '\nargv_sha256='+'d'*64+'\nroot='+str(runs)+'\nruns_root='+str(runs)+'\nrepo_root='+str(self.root)+
                '\ncontext_dir='+str(runs/'_hub')+'\ncommand='+str(self.root/'agents/benchmarks/agent_link_server.py')+
                '\nhost=127.0.0.1\nport='+self.hub_port+'\nstatus=live-transfer-required\n')
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
                rows=[dict(port=self.hub_port,owner=str(hub),owner_sha256=c.sha_file(hub),terminal=str(terminal),terminal_sha256=c.sha_file(terminal),native_exit=0,
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

if __name__=='__main__':unittest.main()
