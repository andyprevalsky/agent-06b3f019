#!/usr/bin/env python3
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile

MODULE = Path(__file__).resolve().parents[1] / 'validate_predeploy_receipts.py'
spec = importlib.util.spec_from_file_location('validator', MODULE)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def fixture():
    summary = {'tasks': ['pass-' + str(i) for i in range(8)] + ['mass'], 'git_sha': 'a'*40, 'status': 'passed', 'exit_code': 0, 'run_id':'plan', 'started_at':'1970-01-01T00:00:00+00:00', 'finished_at':'1970-01-01T00:00:04+00:00'}
    rows = [{'name': name, 'status': 'COMPLETED', 'passed': True, 'benchmark_status': 'PASSED', 'failure_reason': None} for name in summary['tasks']]
    rows[-1].update(status='SKIPPED', passed=False, failure_reason='Compute token pool exhausted or cooling down')
    run = {'run_id': 'original', 'timestamp':'1970-01-01T00:00:01+00:00', 'tasks': rows}
    card = {'run_id': 'original', 'source_sha': 'a'*40, 'started_at': 1, 'finished_at': 2,
            'tasks': {'total': 9, 'completed': 9, 'running': 0, 'queued': 0},
            'per_task': [{'name': r['name'], 'status': 'passed' if r['passed'] else 'skipped'} for r in rows]}
    digest = hashlib.sha256(json.dumps(run).encode()).hexdigest()
    bundle = {'run': run, 'card': card, 'sha256': digest, 'evidence': 'original/run.json', 'card_sha256':'c'*64, 'cleanup_verified':True}
    proof = {'run_id': 'original', 'task': 'mass', 'receipt_sha256': digest,
             'receipt_reason': rows[-1]['failure_reason'], 'resource_scope': 'third_party',
             'reason_code': 'compute_quota_exhausted', 'provider': 'Codex', 'exclusive_cause': True,
             'evidence': 'reviewed/provider-receipt.json', 'confirmed_at': 3}
    return summary, [bundle], [proof]


def check(summary, bundles, proofs, explanation=None, observation=None):
    bindings=[{'run_id': b['run'].get('run_id'), 'plan_run_id': summary.get('run_id'),
               'planned_source_sha':summary.get('git_sha'), 'receipt_sha256': b['sha256'],
               'card_sha256':b['card_sha256']} for b in bundles]
    return v.validate(summary,bundles,proofs,bindings,explanation,observation)


def nonzero_fixture():
    s,b,p=fixture();s['exit_code']=1;s['status']='failed'
    observation={'summary_sha256':'d'*64,'runner_log_sha256':'e'*64}
    explanation={'kind':'task_result_exit','plan_run_id':s['run_id'],'exit_code':1,
                 **observation,'receipt_cohort':[[b[0]['run']['run_id'],b[0]['sha256'],b[0]['card_sha256']]],
                 'resource_tasks':[['original','mass']],'exclusive_cause':True,'independent_failures':[],
                 'evidence':'reviewed/wrapper-terminal.json','confirmed_at':5}
    return s,b,p,explanation,observation


class ReceiptPolicy(unittest.TestCase):
    def test_original_eight_pass_plus_skip_never_pass(self):
        data = fixture(); original = copy.deepcopy(data)
        r = check(*data)
        self.assertEqual(r['status'], 'SKIPPED_WITH_WARNING')
        self.assertEqual(r['counts'], {'passed': 8, 'skipped': 1, 'blocked': 0})
        self.assertEqual(r['per_task'][-1]['original_status'], 'SKIPPED')
        self.assertEqual(r['warnings'][0]['provider'], 'Codex')
        self.assertEqual(data, original)

    def test_all_pass(self):
        s, b, p = fixture(); b[0]['run']['tasks'][-1].update(passed=True,status='COMPLETED');b[0]['card']['per_task'][-1]['status']='passed'
        self.assertEqual(check(s,b,[])['status'],'PASS')

    def test_nonresource_reasons_block(self):
        for code in ['assertion', 'authentication', 'permission', 'local_disk_full', 'outage', 'unknown', 'rate_limit_exceeded', 'token_unavailable']:
            with self.subTest(code=code):
                s,b,p=fixture();p[0]['reason_code']=code
                self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_allowed_resource_codes(self):
        for code in v.RESOURCE_CODES:
            with self.subTest(code=code):
                s,b,p=fixture();p[0]['reason_code']=code
                self.assertEqual(check(s,b,p)['status'],'SKIPPED_WITH_WARNING')

    def test_missing_confirmation(self):
        s,b,p=fixture();self.assertEqual(check(s,b,[])['status'],'BLOCKED')

    def test_binding_and_causality(self):
        mutations={'receipt_sha256':'wrong','receipt_reason':'unrelated expected negative log','resource_scope':'local','exclusive_cause':False,'confirmed_at':float('nan'),'provider':'','evidence':''}
        for key,value in mutations.items():
            with self.subTest(key=key):
                s,b,p=fixture();p[0][key]=value
                self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_cleanup_still_blocks(self):
        s,b,p=fixture();b[0]['run']['tasks'][-1]['cleanup_failure']='owned browser remains'
        self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_missing_duplicate_extra_and_empty_inventory(self):
        for change in ['missing','duplicate','extra','empty','plan-duplicate']:
            with self.subTest(change=change):
                s,b,p=fixture()
                if change=='missing':s['tasks'].append('not-received')
                if change=='duplicate':b.append(copy.deepcopy(b[0]))
                if change=='extra':s['tasks'].remove('pass-0')
                if change=='empty':s['tasks']=[]
                if change=='plan-duplicate':s['tasks'].append('mass')
                self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_nonterminal_and_source_mismatch(self):
        for change in ['time','queued','running','source','card-missing','duplicate-display','identity','nonzero-exit','bool-exit']:
            with self.subTest(change=change):
                s,b,p=fixture();c=b[0]['card']
                if change=='time':c['finished_at']=None
                if change in ['queued','running']:c['tasks'][change]=1
                if change=='source':c['source_sha']='b'*40
                if change=='card-missing':c['per_task'].pop()
                if change=='duplicate-display':c['per_task'][-1]['name']='pass-0'
                if change=='identity':c['run_id']='other'
                if change=='nonzero-exit':s['exit_code']=1
                if change=='bool-exit':s['exit_code']=False
                self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_unknown_source_preserved(self):
        s,b,p=fixture();b[0]['card']['source_sha']=None
        r=check(s,b,p);self.assertIsNone(r['warnings'][0]['source_sha']);self.assertEqual(r['status'],'BLOCKED')

    def test_duplicate_unused_confirmation(self):
        s,b,p=fixture();self.assertEqual(check(s,b,p+p)['status'],'BLOCKED')
        p[0]['task']='other';self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_cancelled_never_resource_skip(self):
        s,b,p=fixture();b[0]['run']['tasks'][-1]['status']='CANCELLED'
        self.assertEqual(check(s,b,p)['status'],'BLOCKED')


    def test_terminal_evaluator_required(self):
        for verdict in ['RUNNING','UNKNOWN',None,'FAILED','SKIPPED']:
            s,b,p=fixture();b[0]['run']['tasks'][0]['benchmark_status']=verdict
            self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_plan_binding_and_cleanup_required(self):
        s,b,p=fixture();self.assertEqual(v.validate(s,b,p,[])['status'],'BLOCKED')
        b[0]['cleanup_verified']=False;self.assertEqual(check(s,b,p)['status'],'BLOCKED')

    def test_outside_plan_timestamp(self):
        s,b,p=fixture();b[0]['run']['timestamp']='1970-01-01T00:00:05+00:00'
        self.assertEqual(check(s,b,p)['status'],'BLOCKED')


    def test_malformed_ids_and_rows_fail_closed(self):
        for field in ['name','status']:
            s,b,p=fixture();b[0]['run']['tasks'][0][field]=[]
            self.assertEqual(check(s,b,p)['status'],'BLOCKED')
        s,b,p=fixture();b[0]['card']['per_task'][0]['name']=[]
        self.assertEqual(check(s,b,p)['status'],'BLOCKED')
        self.assertEqual(v.validate(None,[],[],[])['status'],'BLOCKED')


    def test_exact_cleanup_receipt_join(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp)/'run';directory.mkdir()
            benchmark={'run_id':'run','state':'cleanup_verified','token':'abc'}
            stack={'run_id':'run','token':'def','pid':12,'native_identity':'linux:boot:22','birth':'birth'}
            (directory/'local-benchmark-owner.json').write_text(json.dumps(benchmark))
            (directory/'local-stack-owner.json').write_text(json.dumps(stack))
            (directory/'benchmark-cleanup-abc.status').write_text('version=1\ntoken=abc\nstate=clean\n')
            good='version=2\ntoken=def\nstate=clean\nstack_pid=12\nstack_birth=birth\nstack_native_identity=linux:boot:22\n'
            receipt=directory/'local-stack-cleanup.status';receipt.write_text(good)
            self.assertTrue(v.verify_cleanup(directory))
            for bad in [good.replace('token=def','token=other'),good.replace('state=clean','state=unknown'),good.replace('stack_pid=12','stack_pid=13'),good.replace('boot:22','boot:23'),good+'state=clean\n']:
                receipt.write_text(bad);self.assertFalse(v.verify_cleanup(directory))


    def test_confirmed_nonzero_resource_exit_is_warning_not_block(self):
        s,b,p,e,o=nonzero_fixture()
        result=check(s,b,p,e,o)
        self.assertEqual(result['status'],'SKIPPED_WITH_WARNING')
        self.assertEqual(result['original_exit_code'],1)
        self.assertEqual(result['counts'],{'passed':8,'skipped':1,'blocked':0})
        self.assertEqual(result['wrapper_warning']['original_exit_code'],1)

    def test_resource_plus_independent_wrapper_failure_blocks(self):
        for mutation in ['crash','mixed','partial','cleanup','missing-proof','wrong-log','wrong-summary','wrong-exit','wrong-cohort','wrong-tasks','no-exclusive','unknown-time','signal','no-log-observation']:
            with self.subTest(mutation=mutation):
                s,b,p,e,o=nonzero_fixture()
                if mutation=='crash':e['kind']='wrapper_crash'
                if mutation=='mixed':e['independent_failures']=['assertion failure after task']
                if mutation=='partial':s['tasks'].append('not-run')
                if mutation=='cleanup':b[0]['cleanup_verified']=False
                if mutation=='missing-proof':e=None
                if mutation=='wrong-log':e['runner_log_sha256']='f'*64
                if mutation=='wrong-summary':e['summary_sha256']='f'*64
                if mutation=='wrong-exit':e['exit_code']=2
                if mutation=='wrong-cohort':e['receipt_cohort']=[]
                if mutation=='wrong-tasks':e['resource_tasks']=[]
                if mutation=='no-exclusive':e['exclusive_cause']=False
                if mutation=='unknown-time':e['confirmed_at']=float('nan')
                if mutation=='signal':s['exit_code']=143;e['exit_code']=143
                if mutation=='no-log-observation':o={}
                self.assertEqual(check(s,b,p,e,o)['status'],'BLOCKED')

    def test_nonzero_mixed_nonresource_task_blocks(self):
        s,b,p,e,o=nonzero_fixture();b[0]['run']['tasks'][0].update(passed=False,benchmark_status='FAILED',status='FAILED',failure_reason='assertion failed')
        b[0]['card']['per_task'][0]['status']='failed'
        self.assertEqual(check(s,b,p,e,o)['status'],'BLOCKED')

    def test_nonzero_without_resource_failure_never_passes(self):
        s,b,p,e,o=nonzero_fixture();b[0]['run']['tasks'][-1].update(passed=True,benchmark_status='PASSED',status='COMPLETED');b[0]['card']['per_task'][-1]['status']='passed'
        self.assertEqual(check(s,b,[],e,o)['status'],'BLOCKED')



    def test_planned_run_identity_is_required(self):
        for value in (None, "", " ", 3, [], {}):
            with self.subTest(value=value):
                s,b,p=fixture();s["run_id"]=value
                self.assertEqual(check(s,b,p)["status"],"BLOCKED")
        s,b,p,e,o=nonzero_fixture();s.pop("run_id");e.pop("plan_run_id")
        self.assertEqual(check(s,b,p,e,o)["status"],"BLOCKED")

    def test_numeric_overflow_returns_serializable_blocked(self):
        s,b,p=fixture();p[0]["confirmed_at"]=10**400
        self.assertEqual(check(s,b,p)["status"],"BLOCKED")
        for field in ("passed", "failure_reason"):
            with self.subTest(field=field):
                s,b,p=fixture();b[0]["run"]["tasks"][0][field]=float("inf")
                result=check(s,b,p)
                self.assertEqual(result["status"],"BLOCKED")
                json.dumps(result,allow_nan=False)

    def test_json_exponent_overflow_is_rejected(self):
        with self.assertRaises(ValueError):
            v.strict_json('{"original_reason":1e999}')
        with self.assertRaises(ValueError):
            v.strict_json('{"original_reason":-1e999}')
        self.assertEqual(v.strict_json('{"value":1.25}'), {"value":1.25})

    def test_cli_serialization_failure_emits_blocked_json(self):
        import contextlib, io
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);run=root/"run";run.mkdir()
            for name,value in (("run.json",{}),("report-card.json",{})):
                (run/name).write_text(json.dumps(value))
            for name,value in (("summary.json",{}),("confirmations.json",[]),("bindings.json",[])):
                (root/name).write_text(json.dumps(value))
            argv=["validator", "--summary",str(root/"summary.json"),"--run-dir",str(run),"--confirmations",str(root/"confirmations.json"),"--bindings",str(root/"bindings.json")]
            for value in (float("inf"), {"not-json"}):
                with self.subTest(value=value), patch("sys.argv",argv), patch.object(v,"verify_cleanup",return_value=True), patch.object(v,"validate",return_value={"status":"PASS","unexpected":value}), contextlib.redirect_stdout(io.StringIO()) as stream:
                    self.assertEqual(v.main(),1)
                    result=json.loads(stream.getvalue())
                    self.assertEqual(result["status"],"BLOCKED")


    def test_timestamp_os_error_is_structured_blocked(self):
        from unittest.mock import patch
        s,b,p=fixture()
        with patch.object(v,"datetime") as clock:
            clock.fromisoformat.side_effect=OSError("unrepresentable timestamp")
            self.assertEqual(check(s,b,p)["status"],"BLOCKED")


if __name__=='__main__': unittest.main()
