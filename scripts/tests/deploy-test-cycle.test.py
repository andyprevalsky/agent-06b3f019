#!/usr/bin/env python3
"""Exercise the real staged coordinator; no provider, database, or app processes."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
# Source of the original round-37 inventory-init failure whose exact producer bytes the native validator pins.
INVENTORY_INIT_PRODUCER_SOURCE = 'ce016428eeb484b19b503a6f65884eb92f1e3fde'
# The suite builds its own gate requests. A DEPLOY_GATE_REQUEST inherited from an
# outer deploy worker (the local executor runs this suite inside a gate) would
# make admission() demand that outer cycle's custody locator in-process.
os.environ.pop('DEPLOY_GATE_REQUEST', None)
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_test_cycle as c
import deploy_gate_progress as progress
import deploy_test_process

production_process_entries = deploy_test_process.process_entries


@contextmanager
def unrelated_unreadable_process():
    """A same-user non-dumpable process outside this test's tree, like the runner's pid 211414 (PR #1762)."""
    grandchild = ("import ctypes,os,sys;ctypes.CDLL(None).prctl(4,0,0,0,0);"
                  "print(os.getpid(),flush=True);sys.stdin.read()")
    launcher = subprocess.Popen([sys.executable, '-c', 'import subprocess,sys;subprocess.Popen('
                                 f'[sys.executable,"-c",{grandchild!r}],start_new_session=True)'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        pid = int(launcher.stdout.readline())
        launcher.wait(timeout=10)  # the re-parented grandchild leaves this process tree
        yield pid
    finally:
        launcher.stdin.close()  # EOF ends the grandchild; nothing is signalled
        launcher.stdout.close()
        launcher.wait(timeout=10)


def own_process_entries():
    """This test process and its descendants: the only processes a test here can create or own.

    quiet() and namespace_quiet() refuse any same-user process they cannot read, which is the real
    safety check. Unrelated host processes (a sibling suite's non-dumpable fixture, a runner's
    (sd-pam)) are outside every fixture, so the suite scans only its own process tree.
    """
    children = {}
    for process in Path('/proc').iterdir():
        try:
            parent = int((process / 'stat').read_text().rsplit(') ', 1)[1].split()[1]) if process.name.isdigit() else None
        except (FileNotFoundError, ProcessLookupError):
            continue  # exited mid-scan
        if parent is not None:
            children.setdefault(parent, []).append(int(process.name))
    owned, frontier = [], [os.getpid()]
    while frontier:
        pid = frontier.pop()
        owned.append(Path('/proc', str(pid)))
        frontier.extend(children.get(pid, ()))
    return iter(owned)


def setUpModule():
    # Disposable fixtures own their custody; an enclosing deploy request belongs
    # to the runner. Tests for request ownership install their own explicit path.
    environment = patch.dict(os.environ)
    environment.start()
    unittest.addModuleCleanup(environment.stop)
    os.environ.pop('DEPLOY_GATE_REQUEST', None)
    hermetic = patch.object(deploy_test_process, 'process_entries', own_process_entries)
    hermetic.start()
    unittest.addModuleCleanup(hermetic.stop)


class FixtureEnvironment(unittest.TestCase):
    def test_outer_request_does_not_rebind_disposable_fixture_custody(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            request.parent.mkdir(parents=True)
            request.write_text('{}')
            env = dict(os.environ, DEPLOY_GATE_REQUEST=str(request))
            result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()),
                'Cycle.test_historical_custody_rejects_tampering_and_missing_admission_proof',
                'Cycle.test_historical_import_cli_and_admission_keep_current_inventory',
                'RelayStartupEvidence.test_native_adapter_requests_owned_supervision'],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn('Ran 3 tests', result.stdout)

    def test_explicit_request_owner_still_requires_matching_custody(self):
        import deploy_test_historical_custody as h
        before = dict(os.environ)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / '.context/deploy-pipeline/attempts/34/phase/gate/request.json'
            with patch.dict(os.environ, {'DEPLOY_GATE_REQUEST': str(request)}):
                for candidate in ({}, {'custody_state': str(root / '.context/foreign/cycle.json')}):
                    with self.assertRaisesRegex(ValueError, 'missing request-owned custody locator'):
                        h.admission(candidate, root)
        self.assertEqual(dict(os.environ), before)


    def test_module_cleanup_restores_enclosing_environment(self):
        program = (
            "import os,runpy,unittest; "
            "module=runpy.run_path(__import__('sys').argv[1]); "
            "before=dict(os.environ); module['setUpModule'](); "
            "assert 'DEPLOY_GATE_REQUEST' not in os.environ; "
            "assert dict(os.environ)=={k:v for k,v in before.items() if k!='DEPLOY_GATE_REQUEST'}; "
            "unittest.doModuleCleanups(); assert dict(os.environ)==before"
        )
        env = dict(os.environ, DEPLOY_GATE_REQUEST='/enclosing/request.json')
        result = subprocess.run([sys.executable, '-B', '-c', program, str(Path(__file__).resolve())],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)


class EnvironmentIdentity(unittest.TestCase):
    def test_tool_call_nonce_is_not_runtime_configuration(self):
        with patch.dict(os.environ, {"CODEX_TOOL_CALL_ID": "call-a", "BACKEND_API_KEY": "test-key-a"}, clear=True):
            initial = c.environment_digest()
            os.environ["CODEX_TOOL_CALL_ID"] = "call-b"
            self.assertEqual(initial, c.environment_digest())
            os.environ["BACKEND_API_KEY"] = "test-key-b"
            self.assertNotEqual(initial, c.environment_digest())


class Cycle(unittest.TestCase):
    def custody_fixture(self, top_level=None):
        import deploy_test_historical_custody as h
        mocked = patch.object(h, 'native_closure', return_value={'fixture': 'terminal native fleet'})
        mocked.start(); self.addCleanup(mocked.stop)
        names = ['agent-payment-abandonment', 'agent-payment-idempotent-abandonment']
        catalog = [t for t in json.loads((ROOT / 'agents/benchmarks/tasks.json').read_text()) if t['name'] in names]
        path = self.root / 'agents/benchmarks/tasks.json'
        path.parent.mkdir(parents=True); c.write(path, catalog)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'catalog'], check=True)
        gate = self.plan['gates'][1]
        gate.update(checks=names + ['peer-' + str(i) for i in range(13)], case_protocol=True)
        self.plan['source'] = c.source(self.root)
        self.state = c.initialize(self.plan, self.root)
        failures, reports = [], []
        for i, name in enumerate(names):
            task = next(t for t in catalog if t['name'] == name)
            snap = copy.deepcopy(task['expected_payment_lifecycle'])
            snap.update(agentId='root-' + str(i), stripeRefund=None)
            snap['purchase'].update(id='purchase-' + str(i), cardId='card-' + str(i), status='HELD')
            snap['walletFunding'].update(providerTransferId='transfer-' + str(i), status='RECLAIMING')
            snap['agentCard'].update(id='card-' + str(i), status='CLOSED', balanceCents=0)
            snap['orgTransfer'].update(id='transfer-' + str(i), cardId='card-' + str(i), status='consumed',
                                       releasedCents=0, transferredCents=4396, amountCents=4396, livemode=False)
            snap['stripeHold']['livemode'] = False
            snap['integrity'] = dict(agentCardProviderCardCount=1, agentCardProviderTransferCount=1,
                                     agentCardProviderUnlinkedTransferCount=0, cardCount=1, purchaseCount=1,
                                     stripePaymentIntentCount=1, stripeProviderPaymentIntentCount=1,
                                     walletFundingCount=1)
            final = dict(root_deleted=True, tree_agent_ids=[snap['agentId']], unsealed_tree_agent_ids=[], browser_sessions=[],
                         purchase_cleanup=[dict(agent_id=snap['agentId'], purchase_id=snap['purchase']['id'],
                          card_id=snap['agentCard']['id'], provider_transfer_id=snap['orgTransfer']['id'],
                          total_cents=4396, status='HELD', funding_status='RECLAIMING')])
            row = dict(name=name, agent_id=snap['agentId'], passed=False, status='ACTIVE' if i else 'SKIPPED',
                       benchmark_status='FAILED' if i else 'SKIPPED', failure_reason='auth then timeout' if i else self.STALL_REASON)
            native = dict(**row, cleanup_failure=None, context_violations=[],
                          execution_provenance={'base_sha': self.state['source']['head']},
                          logs={'cloud_cleanup_evidence': dict(errors=[], root_agent_id=snap['agentId'], final=final,
                                provider_receipts=[], agentcard_release_stall_lifecycles={snap['agentId']: snap})})
            if not i:
                native['logs']['agentcard_release_stall_lifecycle'] = top_level(copy.deepcopy(snap)) if top_level else snap
            file = self.root / '.context/native' / name / 'cloudbench-run.json'; c.write(file, {'tasks': [native]})
            evidence = dict(native_task=row, path=str(file), sha256=c.sha_file(file))
            result = file.parent / 'result.json'
            c.write(result, dict(source=self.state['source'], gate='api', complete=True, cleanup_complete=True,
                                 evidence={name: evidence}))
            f = dict(id='failure-' + str(i), check='api/' + name, gate='api', source=self.state['source'],
                     native_result='FAIL', complete=True, command=gate['command'], finished_at=1000,
                     worker_evidence=evidence, worker_result=str(result))
            failures.append(f)
            entry = dict(id=f['id'], check=f['check'], source=f['source'], command=f['command'], native_result='FAIL',
                         attribution='NOT_INTRODUCED', description='native original failure', evidence=str(file))
            if i:
                entry['post_merge'] = dict(test=f['check'], command=f['command'], scope='original auth failure',
                                          error='auth then timeout', source=f['source'], evidence=str(file))
            else:
                entry['resource_skip'] = self.stall_confirmation(receipt_sha256=evidence['sha256'])
            reports.append(entry)
        self.state.update(phase='triage', failure_phase='final', pending=[f['id'] for f in failures], failures=failures)
        c.adjudicate(self.state, {'failures': reports})
        self.state.update(phase='ready', ready=True)
        (self.root / 'code').write_text('changed payment backend contract')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        return new

    def transfer_fixture(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture()
        donor = copy.deepcopy(self.state)
        proof = h.build(donor, self.plan, new, self.root)
        c.refresh(donor, self.plan, new, self.root, historical_no_retry_proof=proof)
        for i in range(3):
            negative = copy.deepcopy(donor['failures'][0])
            negative.update(id='lost-' + str(i), native_result='UNVERIFIED', complete=False,
                            disposition='execution required', reexecution={'receipt': 'negative-history'})
            negative.pop('rca', None)
            file = self.root / '.context/negative' / str(i) / 'cloudbench-run.json'
            c.write(file, {'tasks': [dict(negative['worker_evidence']['native_task'], logs={})]})
            negative['worker_evidence']['path'] = str(file)
            negative['worker_evidence']['sha256'] = c.sha_file(file)
            donor['failures'].append(negative)
        file = self.root / '.context/donor/cycle.json'; c.write(file, donor)
        index = self.root / '.context/donor/contents.json'
        c.write(index, {'format': 'PR1770-HISTORICAL-CUSTODY-RECOVERY-CONTENTS-V1',
                        'files': {str(self.root / '.context/deploy-pipeline/cycle.json'): c.sha_file(file)}})
        fresh = c.initialize(new, self.root)
        return fresh, file, index

    def test_historical_import_only_indexed_duties_not_lost_supervisor_history(self):
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        original = donor.read_bytes()
        self.assertEqual(2, len(h.known(c.read(donor), self.root)))
        proof = h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        before = copy.deepcopy(fresh)
        h.import_history(fresh, donor, index, c.sha_file(donor), c.sha_file(index), proof, self.root)
        self.assertEqual([], fresh['attempts']); self.assertEqual({}, fresh['skips'])
        self.assertEqual('quick', fresh['phase']); self.assertFalse(fresh['ready'])
        self.assertEqual(before['source'], fresh['source'])
        self.assertEqual(before['environment'], fresh['environment'])
        self.assertEqual(before['input_fingerprints'], fresh['input_fingerprints'])
        self.assertEqual(2, len(fresh['failures']))
        self.assertEqual(1, len(fresh['pending_post_merge']))
        self.assertTrue(all(r['current_execution'] == r['current_financial_state'] == 'UNVERIFIED'
                            and not any(r['credit'].values()) for r in fresh['historical_no_retry_custody']))
        h.verify(fresh, self.root)
        gate = fresh['plan']['gates'][1]
        self.assertEqual(2, len(c.reuse_qualifications(fresh, gate, root=self.root)))
        same = copy.deepcopy(fresh)
        h.import_history(fresh, donor, index, c.sha_file(donor), c.sha_file(index), proof, self.root)
        self.assertEqual(same, fresh); self.assertEqual(original, donor.read_bytes())
        self.assertEqual([], c.read(donor).get('attempts', []))

    def test_historical_import_rejects_partial_changed_mixed_and_nonfresh(self):
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        args = (donor, index, c.sha_file(donor), c.sha_file(index))
        proof = h.import_proof(fresh, *args, self.root)
        for key, value in [('attempts', [{}]), ('ready', True), ('pending', ['unknown']),
                           ('skips', {'api/peer': {}}), ('running', ['owner']), ('extra', 'foreign')]:
            changed = copy.deepcopy(fresh); changed[key] = value
            before = copy.deepcopy(changed)
            with self.assertRaises(ValueError): h.import_history(changed, *args, proof, self.root)
            self.assertEqual(before, changed)
        bad = copy.deepcopy(proof); bad['cases'].pop()
        with self.assertRaises(ValueError): h.import_history(fresh, *args, bad, self.root)
        before = copy.deepcopy(fresh)
        raw = donor.read_bytes(); data = c.read(donor)
        data['historical_custody_history'].pop(); c.write(donor, data)
        with self.assertRaises(ValueError): h.import_proof(fresh, *args, self.root)
        # Even repinning both files does not authorize a partial indexed set.
        doc = c.read(index); doc['files'][str(self.root / '.context/deploy-pipeline/cycle.json')] = c.sha_file(donor)
        c.write(index, doc)
        with self.assertRaises(ValueError):
            h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        donor.write_bytes(raw)
        doc['files'][str(self.root / '.context/deploy-pipeline/cycle.json')] = c.sha_file(donor)
        c.write(index, doc)
        native = Path(c.read(donor)['historical_custody_history'][0]['original_failure']['worker_evidence']['path'])
        native.write_text('{}')
        with self.assertRaises(ValueError):
            h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        self.assertEqual(before, fresh)

    def test_historical_import_preserves_universal_missing_native_guard(self):
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        negative = Path(c.read(donor)['failures'][-1]['worker_evidence']['path'])
        raw = negative.read_bytes(); negative.unlink()
        before = copy.deepcopy(fresh)
        with self.assertRaisesRegex(ValueError, 'native bytes missing'):
            h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        self.assertEqual(before, fresh)
        negative.write_bytes(raw)
        proof = h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        h.import_history(fresh, donor, index, c.sha_file(donor), c.sha_file(index), proof, self.root)
        self.assertEqual(2, len(fresh['failures']))

    def test_historical_import_cli_and_admission_keep_current_inventory(self):
        import contextlib, io
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        plan = self.root / '.context/new-plan.json'; c.write(plan, fresh['plan'])
        state_file = self.directory / 'cycle.json'; c.write(state_file, fresh)
        args = ['--root', str(self.root), '--plan', str(plan), '--state-dir', str(self.directory),
                '--donor-state', str(donor), '--donor-index', str(index),
                '--donor-sha256', c.sha_file(donor), '--donor-index-sha256', c.sha_file(index)]
        before = state_file.read_bytes()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(0, c.main(['prepare-historical-import', *args]))
        self.assertEqual(before, state_file.read_bytes())
        proof = self.root / '.context/import-proof.json'; proof.write_text(out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['import-historical-custody', *args, '--proof', str(proof),
                                      '--historical-no-retry-proof', str(proof)]))
        self.assertEqual(before, state_file.read_bytes())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['import-historical-custody', *args, '--proof', str(proof)]))
            self.assertEqual(0, c.main(['import-historical-custody', *args, '--proof', str(proof)]))
        state = c.read(state_file); gate = state['plan']['gates'][1]
        request = dict(source=state['source'], gate=gate['name'], checks=gate['checks'][2:],
            skips=c.reuse_qualifications(state, gate, root=self.root), custody_state=str(state_file),
            custody_state_sha256=h.state_identity(state), custody_child_environment=h.environment_identity(os.environ),
            custody_runtime=h.runtime_identity(self.root))
        h.admission(request, self.root)
        request['checks'] = gate['checks']
        with self.assertRaises(ValueError): h.admission(request, self.root)
        changed = copy.deepcopy(state); changed['historical_custody_import']['donor']['state_digest'] = 'wrong'
        c.write(state_file, changed)
        with self.assertRaises(ValueError): h.verify(changed, self.root)
        self.assertNotEqual(h.state_identity(state), h.state_identity(changed))

    def request_owned_admission(self, state, gate, *, checks=None, skips=None):
        """Admit a request exactly as a supported non-default DEPLOY_TEST_CYCLE_STATE_DIR child sees it."""
        import deploy_test_historical_custody as h
        state_file = self.directory / 'cycle.json'; c.write(state_file, state)
        folder = self.directory / 'attempts/1/initial' / gate['name']; folder.mkdir(parents=True, exist_ok=True)
        expected = c.reuse_qualifications(state, gate, root=self.root) if skips is None else skips
        request = dict(token='a' * 32, source=state['source'], gate=gate['name'], phase='initial',
                       checks=[x for x in gate['checks'] if x not in expected] if checks is None else checks,
                       skips=expected, custody_state=str(state_file.resolve()),
                       custody_state_sha256=h.state_identity(state), custody_runtime=h.runtime_identity(self.root))
        with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(folder / 'request.json')):
            request['custody_child_environment'] = h.environment_identity(os.environ)
            c.write(folder / 'request.json', request)
            h.admission(request, self.root)

    def stale_canonical_default(self, source=None, **changes):
        """A finished older cycle left in the canonical default directory (PR1767: phase triage, no custody)."""
        stale = copy.deepcopy(self.state)
        stale.update(source=source or {'head': '1' * 40, 'digest': '2' * 64}, phase='triage', pending=['old-smoke'],
                     failures=[{'id': 'old-smoke', 'check': 'smoke/agent-x', 'gate': 'smoke', 'native_result': 'UNVERIFIED',
                                'complete': False, 'source': source or {'head': '1' * 40, 'digest': '2' * 64}}], **changes)
        default = self.root / '.context/deploy-pipeline/cycle.json'; c.write(default, stale)
        return default

    def test_request_owned_override_admits_stale_canonical_default_without_custody_debt(self):
        # PR #1784 cycle bn6: a supported .context/deploy-pipeline-bn6 cycle was refused before allocation
        # because a stale PR1767 default cycle.json existed, though it carried no custody obligations.
        import deploy_test_historical_custody as h
        gate = self.plan['gates'][1]
        self.stale_canonical_default()
        self.directory = self.root / '.context/deploy-pipeline-bn6'
        self.request_owned_admission(self.state, gate)
        # A request that is not request-owned still cannot pick an alternate ledger beside the canonical one.
        request = dict(source=self.state['source'], gate=gate['name'], checks=gate['checks'], skips={},
                       custody_state=str((self.directory / 'cycle.json').resolve()))
        with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(self.root / 'loose/request.json')):
            with self.assertRaises(h.AdmissionRefusal) as refused:
                h.admission(request, self.root)
        self.assertEqual('canonical-locator-missing', refused.exception.reason_code)
        self.assertEqual('historical custody: missing canonical custody locator', str(refused.exception))
        # The request-owned locator itself remains mandatory.
        folder = self.directory / 'attempts/1/initial/api'
        with patch.dict(os.environ, DEPLOY_GATE_REQUEST=str(folder / 'request.json')):
            with self.assertRaises(h.AdmissionRefusal) as refused:
                h.admission({**request, 'custody_state': str(self.root / '.context/deploy-pipeline/cycle.json')}, self.root)
        self.assertEqual('request-locator-mismatch', refused.exception.reason_code)

    def test_request_owned_override_never_escapes_canonical_custody_debt(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); proof = h.build(self.state, self.plan, new, self.root)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        self.state.update(phase='ready', ready=True)
        canonical = copy.deepcopy(self.state)
        default = self.root / '.context/deploy-pipeline/cycle.json'
        fresh = c.initialize(new, self.root)
        gate = fresh['plan']['gates'][1]
        self.directory = self.root / '.context/deploy-pipeline-alt'
        def refused(code):
            with self.assertRaises(h.AdmissionRefusal) as caught:
                self.request_owned_admission(fresh, gate, skips={})
            self.assertEqual(code, caught.exception.reason_code)
        # Known no-remint obligations in the canonical default: a fresh alternate ledger cannot escape them,
        # whether the canonical cycle is bound to this source or to an older one.
        c.write(default, canonical)
        refused('canonical-custody-uncovered')
        c.write(default, {**canonical, 'source': {'head': '3' * 40, 'digest': '4' * 64}})
        refused('canonical-custody-uncovered')
        # Corrupt, malformed or unverifiable canonical history fails closed.
        default.write_text('{not json')
        refused('canonical-custody-unverifiable')
        for malformed in ({}, [], {**canonical, 'plan_digest': 'tampered'}, {**canonical, 'failures': None},
                          {**canonical, 'historical_custody_import': {'kind': 'wrong'}}):
            c.write(default, malformed)
            refused('canonical-custody-unverifiable')
        native = Path(canonical['failures'][1]['worker_evidence']['path']); raw = native.read_bytes()
        native.unlink(); c.write(default, canonical)
        refused('canonical-custody-unverifiable')
        native.write_bytes(raw)
        orphan = copy.deepcopy(canonical); orphan['historical_no_retry_custody'][0]['original_failure']['id'] = 'orphan'
        c.write(default, orphan)
        refused('canonical-custody-unverifiable')
        # Changed credit, provenance or native history in a canonical record is never coverage.
        for change in (lambda s: s['historical_no_retry_custody'][0]['credit'].update(test_execution=True),
                       lambda s: s['historical_no_retry_custody'][0].update(current_execution='PASS'),
                       lambda s: s['historical_no_retry_custody'][0].update(snapshot_sha256='0' * 64),
                       lambda s: s['historical_custody_history'][0].update(adapter_sha256='0' * 64)):
            tampered = copy.deepcopy(canonical); change(tampered); c.write(default, tampered)
            refused('canonical-custody-unverifiable')
        # An active or same-source canonical coordinator keeps ownership even without custody debt.
        self.state = c.initialize(new, self.root)
        self.stale_canonical_default(running=['smoke'])
        refused('canonical-cycle-active')
        self.stale_canonical_default(source=fresh['source'])
        refused('canonical-cycle-owns-source')
        self.stale_canonical_default()
        self.request_owned_admission(fresh, gate, skips={})

    def test_request_owned_override_admits_imported_canonical_custody(self):
        # PR1770: the canonical ledger's obligations were imported into an alternate fresh ledger.
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        default = self.root / '.context/deploy-pipeline/cycle.json'
        default.parent.mkdir(parents=True, exist_ok=True); default.write_bytes(donor.read_bytes())
        proof = h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        h.import_history(fresh, donor, index, c.sha_file(donor), c.sha_file(index), proof, self.root)
        gate = fresh['plan']['gates'][1]
        self.directory = self.root / '.context/deploy-pipeline-alt'
        self.request_owned_admission(fresh, gate)
        # A covered but tampered canonical record (older source, so ownership cannot refuse it) fails closed.
        donor_state = c.read(donor)
        tampered = copy.deepcopy(donor_state)
        tampered['source'] = {'head': '5' * 40, 'digest': '6' * 64}
        c.write(default, tampered)
        self.request_owned_admission(fresh, gate)
        tampered['historical_no_retry_custody'][0]['credit']['financial_release'] = True
        c.write(default, tampered)
        with self.assertRaises(h.AdmissionRefusal) as caught:
            self.request_owned_admission(fresh, gate)
        self.assertEqual('canonical-custody-unverifiable', caught.exception.reason_code)
        c.write(default, donor_state)
        # Dropping one imported obligation from the alternate ledger is a canonical-debt bypass.
        partial = copy.deepcopy(fresh)
        partial['failures'] = partial['failures'][1:]
        for key in ('historical_no_retry_custody', 'historical_custody_history'):
            partial[key] = [r for r in partial[key] if r['original_failure']['id'] != fresh['failures'][0]['id']]
        partial.pop('historical_custody_import')
        with self.assertRaises(h.AdmissionRefusal) as caught:
            self.request_owned_admission(partial, gate, checks=gate['checks'], skips={})
        self.assertEqual('canonical-custody-uncovered', caught.exception.reason_code)

    def test_historical_import_retained_provenance_blocks_dropped_collections(self):
        import deploy_test_historical_custody as h
        fresh, donor, index = self.transfer_fixture()
        proof = h.import_proof(fresh, donor, index, c.sha_file(donor), c.sha_file(index), self.root)
        h.import_history(fresh, donor, index, c.sha_file(donor), c.sha_file(index), proof, self.root)
        for key in ('failures', 'historical_custody_history', 'historical_no_retry_custody'):
            fresh.pop(key)
        state_file = self.directory / 'cycle.json'; c.write(state_file, fresh)
        receipt = self.directory / 'retained-receipt.json'; c.write(receipt, {'original': 'unchanged'})
        gate = fresh['plan']['gates'][1]
        request = dict(source=fresh['source'], gate=gate['name'], checks=gate['checks'], skips={},
            custody_state=str(state_file), custody_state_sha256=h.state_identity(fresh),
            custody_child_environment=h.environment_identity(os.environ), custody_runtime=h.runtime_identity(self.root))
        before = copy.deepcopy(fresh)
        files = {str(p): p.read_bytes() for p in self.directory.rglob('*') if p.is_file()}
        operations = {
            'verification': lambda: h.verify(fresh, self.root),
            'direct-guard': lambda: h.guard(fresh, gate, self.root),
            'child-admission': lambda: h.admission(request, self.root),
            'preallocation': lambda: c._execute(gate, fresh, self.directory, self.root),
        }
        for name, operation in operations.items():
            with self.subTest(boundary=name), patch.object(c, 'run_command', side_effect=AssertionError('allocation entered')) as launch:
                with self.assertRaises(ValueError): operation()
                launch.assert_not_called()
                self.assertEqual(before, fresh)
                self.assertEqual(files, {str(p): p.read_bytes() for p in self.directory.rglob('*') if p.is_file()})

    def test_historical_import_malformed_retained_provenance_never_looks_absent(self):
        import deploy_test_historical_custody as h
        gate = self.plan['gates'][1]
        for value in (None, False, {}, [], {'donor': None}):
            state = copy.deepcopy(self.state); state['historical_custody_import'] = value
            before = copy.deepcopy(state)
            for operation in (lambda: h.verify(state, self.root), lambda: h.guard(state, gate, self.root),
                              lambda: c._execute(gate, state, self.directory, self.root)):
                with self.subTest(provenance=value), patch.object(c.uuid, 'uuid4', side_effect=AssertionError('allocation entered')) as allocate:
                    with self.assertRaises((ValueError, KeyError, TypeError)): operation()
                    allocate.assert_not_called()
                    self.assertEqual(before, state)

    def test_concurrent_agentcard_selector_keeps_dataclass_module_registered(self):
        import types
        bridge = types.ModuleType('_deploy_selector_race_fixture')
        bridge.first_entered = threading.Event()
        bridge.second_entered = threading.Event()
        bridge.first_finished = threading.Event()
        bridge.lock = threading.Lock()
        bridge.calls = 0
        argv, search_path = list(sys.argv), list(sys.path)
        modules_before = {key for key in sys.modules if key.startswith('_deploy_source_')}
        def enter():
            with bridge.lock:
                bridge.calls += 1
                first = bridge.calls == 1
            if first:
                bridge.first_entered.set()
                if not bridge.second_entered.wait(5): raise RuntimeError('second selector never entered')
            else:
                bridge.second_entered.set()
                if not bridge.first_finished.wait(5): raise RuntimeError('first selector never finished')
        bridge.enter = enter
        target = self.root / 'agents/benchmarks/select_predeploy_benches.py'
        target.parent.mkdir(parents=True)
        real_selector = (ROOT / 'agents/benchmarks/select_predeploy_benches.py').read_text()
        target.write_text(real_selector.replace('@dataclass(frozen=True)',
            'import _deploy_selector_race_fixture\n_deploy_selector_race_fixture.enter()\n@dataclass(frozen=True)', 1))
        (target.parent / 'tasks.json').write_bytes((ROOT / 'agents/benchmarks/tasks.json').read_bytes())
        # The selector loads its history ledger beside itself (PR #1784).
        (target.parent / 'history_ledger.py').write_bytes((ROOT / 'agents/benchmarks/history_ledger.py').read_bytes())
        with patch.dict(sys.modules, {'_deploy_selector_race_fixture': bridge}), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(c.agentcard_release_stall_task, 'agent-payment-abandonment', self.root)
            try:
                self.assertTrue(bridge.first_entered.wait(5))
                second = pool.submit(c.agentcard_release_stall_task, 'agent-payment-abandonment', self.root)
                self.assertTrue(first.result(timeout=10))
            finally:
                bridge.first_finished.set()
            self.assertTrue(second.result(timeout=10))
        self.assertEqual(2, bridge.calls)
        self.assertEqual(argv, sys.argv)
        self.assertEqual(search_path, sys.path)
        self.assertEqual(modules_before, {key for key in sys.modules if key.startswith('_deploy_source_')})

    def test_agentcard_selector_failed_load_retires_only_its_own_module_and_never_caches(self):
        import types
        bridge = types.ModuleType('_deploy_selector_failure_fixture')
        bridge.foreign = object()
        target = self.root / 'agents/benchmarks/select_predeploy_benches.py'
        target.parent.mkdir(parents=True)
        prefix = 'import sys, _deploy_selector_failure_fixture as bridge\nbridge.name = __name__\n'
        with patch.dict(sys.modules, {'_deploy_selector_failure_fixture': bridge}):
            target.write_text(prefix + 'raise RuntimeError("load failed")\n')
            with self.assertRaisesRegex(RuntimeError, 'load failed'):
                c.agentcard_release_stall_task('agent-payment-abandonment', self.root)
            self.assertNotIn(bridge.name, sys.modules)
            target.write_text(prefix + 'sys.modules[__name__] = bridge.foreign\nraise RuntimeError("replaced")\n')
            try:
                with self.assertRaisesRegex(RuntimeError, 'replaced'):
                    c.agentcard_release_stall_task('agent-payment-abandonment', self.root)
                self.assertIs(bridge.foreign, sys.modules[bridge.name])
            finally:
                sys.modules.pop(bridge.name, None)
        target.write_bytes((ROOT / 'agents/benchmarks/select_predeploy_benches.py').read_bytes())
        catalog = target.parent / 'tasks.json'
        catalog.write_bytes((ROOT / 'agents/benchmarks/tasks.json').read_bytes())
        (target.parent / 'history_ledger.py').write_bytes((ROOT / 'agents/benchmarks/history_ledger.py').read_bytes())
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-abandonment', self.root))
        catalog.write_text('[]')
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-abandonment', self.root))
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-abandonment', ROOT))
        # A stale same-size/same-mtime .pyc must never restore an old predicate.
        import py_compile
        original = target.read_bytes(); stamp = target.stat()
        changed = original.replace(b'AgentCard release-stall standing warning', b'agentCard release-stall standing warning')
        self.assertEqual(len(original), len(changed)); self.assertNotEqual(original, changed)
        py_compile.compile(str(target), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)
        target.write_bytes(changed); os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        catalog.write_bytes((ROOT / 'agents/benchmarks/tasks.json').read_bytes())
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-abandonment', self.root))

    def historical_import_fixture(self):
        import deploy_test_historical_custody as h
        native_closure = h.native_closure
        new = self.custody_fixture()
        h.native_closure.side_effect = native_closure
        for index, failure in enumerate(self.state['failures']):
            old = Path(failure['worker_evidence']['path'])
            fleet = self.root / '.context/native' / f'run-{2147483600 + index}'
            native = fleet / old.parent.name / old.name
            native.parent.mkdir(parents=True); native.write_bytes(old.read_bytes())
            failure['worker_evidence']['path'] = str(native)
            adapter = c.read(Path(failure['worker_result']))
            adapter['evidence'][old.parent.name] = copy.deepcopy(failure['worker_evidence'])
            c.write(Path(failure['worker_result']), adapter)
            token = f'{index + 1:032x}'
            local, canonical = fleet / 'teardown-ownership', self.root / '.git/cloudbench-fleet-audits' / token
            meta = (f'status=provider-teardown-verified\nfleet_owner_token={token}\n'
                    f'run_id={fleet.name}\nworkspace_root={self.root}\n')
            for directory in (local, canonical):
                directory.mkdir(parents=True); (directory / 'meta').write_text(meta)
            with c.source_module(ROOT / 'scripts/cloudbench-retained-successor.py') as library:
                seal = library.tree_digest(local)
            for directory in (local, canonical):
                (directory / 'source-audit').write_text(f'path={canonical}\nsha256={seal}\n')
            c.write(fleet / '_batch/lifecycle.json', dict(fleet_owner_token=token, status='verified',
                hub_publication_failed=False, workspace_root=str(self.root), run_id=fleet.name, audit_sha256=seal))
        proof = h.build(self.state, self.plan, new, self.root)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        c.resolve_post_merge(self.state, self.state['pending_post_merge'][0]['id'],
                            'https://boxes.dev/thread/existing-auth-repair')
        self.state.update(phase='ready', ready=True)
        self.state['attempts'] = [{'phase': 'final', 'source': self.state['source'],
                                  'results': [{'gate': 'old-unrelated', 'status': 'PASS'}]}]
        self.state['failures'].append({'id': 'unrelated', 'check': 'ui/c', 'native_result': 'FAIL'})
        donor = self.root / '.context/donor/cycle.json'; c.write(donor, self.state)
        (self.root / 'code').write_text('independent current repair source')
        current = copy.deepcopy(new); current['source'] = c.source(self.root)
        fresh = c.initialize(current, self.root)
        self.donor_sha256 = c.sha_file(donor)
        return fresh, donor

    def test_historical_import_fresh_cycle_retains_exact_debt_without_execution_credit(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        self.assertEqual({}, h.known(fresh, self.root))
        donor_bytes = donor.read_bytes()
        proof = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        original = copy.deepcopy(fresh)
        h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        self.assertEqual(original['source'], fresh['source'])
        self.assertEqual(original['environment'], fresh['environment'])
        self.assertEqual(original['input_fingerprints'], fresh['input_fingerprints'])
        self.assertEqual([], fresh['attempts']); self.assertEqual({}, fresh['skips'])
        self.assertFalse(fresh['ready']); self.assertEqual('quick', fresh['phase'])
        self.assertEqual(2, len(fresh['historical_no_retry_custody']))
        receipt, = fresh['historical_custody_transfers']
        self.assertEqual(c.digest(c.read(donor)), receipt['donor_state_sha256'])
        self.assertEqual(c.digest(proof['transfer_proof']), receipt['proof_sha256'])
        self.assertEqual([r['original_failure']['id'] for r in proof['cases']], receipt['protected_failure_ids'])
        lost = copy.deepcopy(fresh)
        for key in ('failures', 'historical_no_retry_custody', 'historical_custody_history'):
            lost[key] = []
        with self.assertRaisesRegex(ValueError, 'historical failure removed'):
            h.verify(lost, self.root)
        self.assertEqual(c.read(donor)['historical_custody_history'], fresh['historical_custody_history'])
        self.assertEqual([f for f in c.read(donor)['failures'] if f['id'] != 'unrelated'], fresh['failures'])
        self.assertEqual('ACTIVE', fresh['failures'][1]['worker_evidence']['native_task']['status'])
        self.assertEqual('https://boxes.dev/thread/existing-auth-repair', fresh['failures'][1]['rca']['repair_agent'])
        self.assertIn('auth then timeout', fresh['failures'][1]['rca']['resolved_post_merge']['error'])
        h.verify(fresh, self.root)
        same = copy.deepcopy(fresh); h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        self.assertEqual(same, fresh); self.assertEqual(donor_bytes, donor.read_bytes())
        fresh['phase'] = 'final'; c.write(self.directory / 'cycle.json', fresh)
        gate = fresh['plan']['gates'][1]
        def worker(argv, **kwargs):
            request = c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            self.assertEqual(['peer-' + str(i) for i in range(13)], request['checks'])
            self.assertEqual(2, len(request['skips']))
            with patch.dict(os.environ, kwargs['env'], clear=True):
                h.admission(request, self.root)
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), dict(token=request['token'], source=request['source'],
                gate=request['gate'], cases=dict.fromkeys(request['checks'], 'PASS'), complete=True,
                cleanup_complete=True, reused=False))
            return 0, False, False, False
        with patch.object(c, 'run_command', side_effect=worker):
            result = c.execute(gate, fresh, self.directory, self.root)
        self.assertEqual('PASS', result['status'], result)
        for name in gate['checks'][:2]:
            self.assertEqual('SKIP', result['cases'][name]); self.assertFalse(result['case_complete'][name])
            self.assertEqual('UNVERIFIED', result['current_execution'][name])
        for row in fresh['historical_no_retry_custody']:
            self.assertEqual('UNVERIFIED', row['current_financial_state'])
            self.assertFalse(any(row['credit'].values()))

    def test_historical_import_rejects_tampering_and_preserves_current_state(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        proof = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        for mutate in (lambda p: p['cases'].pop(), lambda p: p.update(extra='not allowed'),
                       lambda p: p['failures'][1]['rca'].update(repair_agent='invented'),
                       lambda p: p['current_binding'].update(environment='forged'),
                       lambda p: p.update(target_state=str(self.directory.parent / 'other/cycle.json'))):
            bad = copy.deepcopy(proof); mutate(bad); before = copy.deepcopy(fresh)
            with self.assertRaises(ValueError): h.admit_import(fresh, bad, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
            self.assertEqual(before, fresh)
        for mutate in (lambda s: s.update(phase='initial'), lambda s: s.update(ready=True),
                       lambda s: s['attempts'].append({'phase': 'initial'}),
                       lambda s: s['skips'].update({'api/old': {'disposition': 'SKIP'}}),
                       lambda s: s.update(running=True), lambda s: s.update(pending=['old'])):
            bad = copy.deepcopy(fresh); mutate(bad); before = copy.deepcopy(bad)
            with self.assertRaises(ValueError): h.admit_import(bad, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
            self.assertEqual(before, bad)
        raw = donor.read_bytes(); donor.write_bytes(raw + b'\n')
        with self.assertRaisesRegex(ValueError, 'approved hash'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        donor.write_bytes(raw)
        with patch.dict(os.environ, HISTORICAL_IMPORT_FIXTURE='environment changed'):
            with self.assertRaises(ValueError): h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        for path in (self.root / 'code', self.root / 'agents/benchmarks/tasks.json'):
            raw = path.read_bytes(); path.write_bytes(raw + b' ')
            with self.assertRaises(ValueError): h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
            path.write_bytes(raw)
        altered = copy.deepcopy(fresh); altered['plan']['gates'][1]['command'] = ['false']
        with self.assertRaises(ValueError): h.admit_import(altered, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        for key in ('path', 'worker_result'):
            failure = c.read(donor)['failures'][0]
            path = Path(failure['worker_evidence']['path'] if key == 'path' else failure[key])
            raw = path.read_bytes(); path.write_bytes(raw + b'\n')
            with self.assertRaises(ValueError): h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
            path.write_bytes(raw)
        self.assertEqual({}, fresh['skips']); self.assertEqual([], fresh['failures'])

    def test_historical_import_uses_authoritative_pending_repair_guard(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        altered = c.read(donor)
        resolved = altered['failures'][1]
        # The existing resolved auth row may not acquire an invented pending
        # wrapper through the hash-pinned compatibility interface either.
        altered['pending_post_merge'].append(dict(id=resolved['id'], check=resolved['check'],
            gate=resolved['gate'], native_result='PASS', packet={'invented': True}))
        c.write(donor, altered)
        approved = c.sha_file(donor)
        proof = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=approved)
        before = copy.deepcopy(fresh)
        with self.assertRaisesRegex(ValueError, 'pending repair wrapper changed'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=approved)
        self.assertEqual(before, fresh)

    def test_historical_import_persistent_guard_rejects_erased_active_history(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        proof = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        for key in ('failures', 'historical_no_retry_custody', 'historical_custody_history'):
            fresh[key] = []
        gate = next(g for g in fresh['plan']['gates'] if g['name'] == 'api')
        with self.assertRaisesRegex(ValueError, 'historical failure removed'):
            h.guard(fresh, gate, self.root)

    def test_historical_import_rejects_unrelated_retained_donor_owner(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        altered = c.read(donor)
        gate = next(g['name'] for g in altered['plan']['gates'] if g['name'] != 'api')
        altered['attempts'].append(dict(phase='final', results=[dict(gate=gate, status='FAIL',
            complete=False, lingering_group=True, cleanup_owner={'request_token': 'unrelated-owner'})]))
        self.assertEqual([gate], c.retained_owners(altered, [g['name'] for g in altered['plan']['gates']]))
        c.write(donor, altered)
        before = copy.deepcopy(fresh)
        with self.assertRaisesRegex(ValueError, 'active/unknown coordinator'):
            h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=c.sha_file(donor))
        self.assertEqual(before, fresh)

    def test_historical_import_retains_native_absence_and_collision_guards(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        proof = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        row = proof['cases'][0]; fleet = Path(row['native_closure']['fleet'])
        lifecycle = fleet / '_batch/lifecycle.json'; raw = lifecycle.read_bytes(); lifecycle.unlink()
        with self.assertRaises(OSError): h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        lifecycle.write_bytes(raw)
        token = c.read(lifecycle)['fleet_owner_token']
        registry = self.root / '.git/cloudbench-fleet-ownership' / token
        registry.parent.mkdir(); registry.symlink_to(self.root / 'missing-owner')
        with self.assertRaisesRegex(ValueError, 'still registered'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        registry.unlink(); registry.mkdir()
        with self.assertRaisesRegex(ValueError, 'still registered'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        registry.rmdir()
        original_exists = Path.exists
        with patch.object(Path, 'exists', lambda p: True if p == Path('/proc/2147483600') else original_exists(p)):
            with self.assertRaisesRegex(ValueError, 'active or unknown'):
                h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        audit = self.root / '.git/cloudbench-fleet-audits' / token / 'meta'
        raw = audit.read_bytes(); audit.write_bytes(raw + b'changed=true\n')
        with self.assertRaisesRegex(ValueError, 'audit changed'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        audit.write_bytes(raw)
        self.directory.mkdir(); (self.directory / 'attempts').symlink_to(self.root / 'absent-attempts')
        with self.assertRaisesRegex(ValueError, 'attempt namespace'):
            h.admit_import(fresh, proof, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        (self.directory / 'attempts').unlink()
        alias = donor.parent / 'alias-cycle.json'; alias.symlink_to(donor)
        with self.assertRaisesRegex(ValueError, 'noncanonical'):
            h.admit_import(fresh, proof, alias, self.directory, self.root, donor_sha256=self.donor_sha256)
        self.assertEqual([], fresh['failures'])

    def test_historical_import_rejects_removed_duties_and_mixed_authority(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        for mutate in (lambda p: p['gates'][1]['checks'].pop(0),
                       lambda p: p['gates'][1].update(case_protocol=False)):
            plan = copy.deepcopy(fresh['plan']); mutate(plan)
            target = c.initialize(plan, self.root)
            with self.assertRaisesRegex(ValueError, 'protected task or case protocol'):
                h.prepare_import(target, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        original = donor.read_bytes()
        for mutate in (lambda d: d['historical_custody_history'].pop(),
                       lambda d: d['historical_custody_history'][0].update(snapshot_sha256='changed'),
                       lambda d: d['skips'].update({d['failures'][0]['check']: {'disposition': 'SKIP'}}),
                       lambda d: d.update(running=True)):
            altered = json.loads(original); mutate(altered); c.write(donor, altered)
            with self.assertRaises(ValueError):
                h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=c.sha_file(donor))
        donor.write_bytes(original)
        catalog = self.root / 'agents/benchmarks/tasks.json'; raw = catalog.read_bytes()
        changed = json.loads(raw); changed[0]['prompt'] = 'changed task contract'; c.write(catalog, changed)
        plan = copy.deepcopy(fresh['plan']); plan['source'] = c.source(self.root)
        with self.assertRaisesRegex(ValueError, 'catalog task changed'):
            h.prepare_import(c.initialize(plan, self.root), donor, self.directory, self.root,
                             donor_sha256=self.donor_sha256)
        catalog.write_bytes(raw)

    def test_historical_import_cli_is_atomic_and_replay_revalidates(self):
        import contextlib, io
        fresh, donor = self.historical_import_fixture()
        plan = self.directory / 'plan.json'; c.write(plan, fresh['plan'])
        state_path = self.directory / 'cycle.json'; c.write(state_path, fresh)
        bound = ['--input', str(donor), '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root), '--donor-sha256', self.donor_sha256]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(0, c.main(['prepare-historical-import', *bound]))
        proof = donor.parent / 'import-proof.json'; proof.write_text(output.getvalue())
        before = state_path.read_bytes()
        raw = proof.read_bytes(); value = json.loads(raw); value['cases'][0]['native_sha256'] = '0' * 64
        c.write(proof, value)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['admit-historical-import', *bound, '--proof', str(proof)]))
        self.assertEqual(before, state_path.read_bytes()); proof.write_bytes(raw)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['admit-historical-import', *bound, '--proof', str(proof)]))
            admitted = state_path.read_bytes()
            self.assertEqual(0, c.main(['admit-historical-import', *bound, '--proof', str(proof)]))
        self.assertEqual(admitted, state_path.read_bytes())
        changed = c.read(proof); changed['current_binding']['plan_digest'] = 'changed'; c.write(proof, changed)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['admit-historical-import', *bound, '--proof', str(proof)]))
        self.assertEqual(admitted, state_path.read_bytes())
        empty = self.root / '.context/unused-proof'; plan = donor.parent / 'current-plan.json'; c.write(plan, fresh['plan'])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['init', '--plan', str(plan), '--state-dir', str(empty),
                '--root', str(self.root), '--historical-no-retry-proof', str(proof)]))
        self.assertFalse((empty / 'cycle.json').exists())

    def test_historical_import_cli_rejects_valid_mismatched_named_plan_before_write(self):
        import contextlib, io
        fresh, donor = self.historical_import_fixture()
        plan = self.directory / 'plan.json'; c.write(plan, fresh['plan'])
        other = copy.deepcopy(fresh['plan']); other['gates'][1]['worker'] = 'other-api-worker'
        c.validate_plan(other, self.root)
        self.assertNotEqual(fresh['plan'], other)
        wrong = self.directory / 'other-plan.json'; c.write(wrong, other)
        state_path = self.directory / 'cycle.json'; c.write(state_path, fresh)
        bound = ['--input', str(donor), '--state-dir', str(self.directory), '--root', str(self.root),
                 '--donor-sha256', self.donor_sha256]
        output = io.StringIO()
        before = state_path.read_bytes()
        with contextlib.redirect_stdout(output):
            self.assertEqual(0, c.main(['prepare-historical-import', *bound, '--plan', str(plan)]))
        self.assertEqual(before, state_path.read_bytes())
        proof = donor.parent / 'named-plan-proof.json'; proof.write_text(output.getvalue())
        for action in ('prepare-historical-import', 'admit-historical-import'):
            before = state_path.read_bytes(); errors = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors), \
                    patch.object(c, 'write', wraps=c.write) as writer:
                result = c.main([action, *bound, '--plan', str(wrong), '--proof', str(proof)])
            with self.subTest(action=action, contract='refusal'):
                self.assertEqual(2, result)
                self.assertIn('historical import plan differs from fresh selection', errors.getvalue())
            with self.subTest(action=action, contract='no state write'):
                self.assertEqual([], writer.call_args_list)
                self.assertEqual(before, state_path.read_bytes())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['admit-historical-import', *bound, '--plan', str(plan), '--proof', str(proof)]))
        self.assertEqual(2, len(c.read(state_path)['historical_no_retry_custody']))

    def test_retained_legacy_import_verifies_progress_and_rejects_tampering(self):
        import deploy_test_historical_custody as h
        fresh, donor = self.historical_import_fixture()
        prepared = h.prepare_import(fresh, donor, self.directory, self.root, donor_sha256=self.donor_sha256)
        saved = c.read(donor)
        h.adopt(fresh, saved, saved['plan'], prepared['transfer_proof'], self.root)
        fresh['historical_custody_import'] = dict(kind=prepared['kind'], proof_sha256=c.digest(prepared),
            donor_path=str(donor), donor_sha256=self.donor_sha256)
        fresh.update(phase='final', attempts=[{'phase': 'initial', 'results': []}])
        before = copy.deepcopy(fresh)
        h.verify(fresh, self.root)
        self.assertEqual(before, fresh)
        self.assertEqual(2, len(h.guard(fresh, fresh['plan']['gates'][1], self.root)))
        for key in ('failures', 'historical_custody_history', 'historical_no_retry_custody'):
            changed = copy.deepcopy(fresh); changed.pop(key)
            with self.subTest(collection=key), self.assertRaises(ValueError):
                h.verify(changed, self.root)
        for mutate in (lambda s: s['historical_custody_import'].update(donor_sha256='0' * 64),
                       lambda s: s['historical_custody_import'].update(proof_sha256='not a digest'),
                       lambda s: s['historical_custody_import'].update(extra='unmarked'),
                       lambda s: s['historical_custody_history'][0].update(native_sha256='changed')):
            changed = copy.deepcopy(fresh); mutate(changed)
            with self.assertRaises(ValueError): h.verify(changed, self.root)
        raw = donor.read_bytes(); donor.write_bytes(raw + b'\n')
        with self.assertRaisesRegex(ValueError, 'legacy donor provenance changed'):
            h.verify(fresh, self.root)
        donor.write_bytes(raw)
        h.verify(fresh, self.root)
        self.assertEqual(before, fresh)

    def test_stall_snapshots_may_differ_only_in_provider_wide_counters(self):
        # PR #1784 cycle bn8: the end-of-task and cleanup snapshots of one stall disagreed only in
        # agentCardProviderCardCount/TransferCount (7 vs 12), because six other identical payment
        # lifecycles minted for the shared cardholder in between; refresh refused the custody proof.
        import deploy_test_historical_custody as h
        def concurrent(snapshot):
            snapshot['integrity'].update(agentCardProviderCardCount=7, agentCardProviderTransferCount=7,
                                         agentCardProviderUnlinkedTransferCount=2)
            return snapshot
        new = self.custody_fixture(top_level=concurrent)
        proof = h.build(copy.deepcopy(self.state), self.plan, new, self.root)
        self.assertEqual(['root-0', 'root-1'], sorted(r['root_id'] for r in proof['cases']))

    def test_stall_snapshots_still_refuse_any_lifecycle_difference(self):
        import deploy_test_historical_custody as h
        changes = {
            'lifecycle count': lambda s: s['integrity'].update(cardCount=2) or s,
            'stripe count': lambda s: s['integrity'].update(stripeProviderPaymentIntentCount=2) or s,
            'purchase status': lambda s: s['purchase'].update(status='VOIDED') or s,
            'released funds': lambda s: s['orgTransfer'].update(releasedCents=4396) or s,
            'card identity': lambda s: s['agentCard'].update(id='card-other') or s,
        }
        for name, change in changes.items():
            with self.subTest(name):
                self.tearDown(); self.setUp()
                new = self.custody_fixture(top_level=change)
                with self.assertRaisesRegex(ValueError, 'two native snapshots disagree'):
                    h.build(copy.deepcopy(self.state), self.plan, new, self.root)

    def test_cross_goal_custody_import_preserves_fresh_selection_without_execution_credit(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture()
        donor = copy.deepcopy(self.state)
        # The independent repair's full selection differs from the donor's;
        # same-deploy refresh must continue refusing to drop any checks.
        new['gates'][1]['checks'] = new['gates'][1]['checks'][:2] + ['current-peer']
        proof = h.build(donor, self.plan, new, self.root)
        with self.assertRaisesRegex(ValueError, 'remove originally selected checks'):
            c.refresh(copy.deepcopy(donor), self.plan, new, self.root, historical_no_retry_proof=proof)
        current = c.initialize(new, self.root)
        h.adopt(current, donor, self.plan, proof, self.root)
        self.assertEqual(donor, self.state)
        self.assertEqual('quick', current['phase']); self.assertFalse(current['ready'])
        self.assertEqual([], current['attempts']); self.assertEqual({}, current['skips'])
        self.assertEqual(donor['failures'], current['failures'])
        self.assertEqual(donor['pending_post_merge'], current['pending_post_merge'])
        self.assertEqual(new, current['plan'])
        self.assertFalse(current.get('resource_warnings'))
        self.assertFalse(current.get('carried_passes'))
        self.assertEqual([4396, 4396], [r['original_amount_cents'] for r in current['historical_no_retry_custody']])
        for row in current['historical_no_retry_custody']:
            self.assertEqual('UNVERIFIED', row['current_execution'])
            self.assertEqual('UNVERIFIED', row['current_financial_state'])
            self.assertTrue(all(value is False for value in row['credit'].values()))
        h.verify(current, self.root)
        same = copy.deepcopy(current)
        h.adopt(current, donor, self.plan, proof, self.root)
        self.assertEqual(same, current)
        for key, value in [('environment', 'stale'), ('source', donor['source']),
                           ('input_fingerprints', {}), ('plan_digest', 'stale')]:
            changed = copy.deepcopy(current); changed[key] = value; before = copy.deepcopy(changed)
            with self.assertRaisesRegex(ValueError, 'binding'):
                h.adopt(changed, donor, self.plan, proof, self.root)
            self.assertEqual(before, changed)
        lost = copy.deepcopy(current)
        lost['failures'] = []; lost['historical_no_retry_custody'] = []; lost['historical_custody_history'] = []
        before = copy.deepcopy(lost)
        with self.assertRaisesRegex(ValueError, 'lost original custody'):
            h.adopt(lost, donor, self.plan, proof, self.root)
        self.assertEqual(before, lost)
        with self.assertRaisesRegex(ValueError, 'historical failure removed'):
            h.verify(lost, self.root)
        partial = copy.deepcopy(current)
        auth = donor['failures'][1]['id']
        partial['failures'] = [f for f in partial['failures'] if f['id'] != auth]
        for key in ('historical_no_retry_custody', 'historical_custody_history'):
            partial[key] = [r for r in partial[key] if r['original_failure']['id'] != auth]
        partial['pending_post_merge'] = []
        with self.assertRaisesRegex(ValueError, 'historical failure removed'):
            h.verify(partial, self.root)
        def worker(argv, **kw):
            request = c.read(Path(kw['env']['DEPLOY_GATE_REQUEST']))
            self.assertEqual(['current-peer'], request['checks'])
            self.assertEqual(2, len(request['skips']))
            c.write(Path(kw['env']['DEPLOY_GATE_RESULT']), dict(token=request['token'], source=request['source'],
                gate=request['gate'], cases={'current-peer': 'PASS'}, complete=True, cleanup_complete=True, reused=False))
            return 0, False, False, False
        current.update(phase='final')
        c.write(self.directory / 'cycle.json', current)
        with patch.object(c, 'run_command', side_effect=worker):
            result = c.execute(new['gates'][1], current, self.directory, self.root)
        self.assertEqual('PASS', result['status'], result)
        self.assertEqual('PASS', result['cases']['current-peer'])
        for name in new['gates'][1]['checks'][:2]:
            self.assertEqual('SKIP', result['cases'][name])
            self.assertFalse(result['case_complete'][name])

    def test_cross_goal_custody_import_rejects_nonfresh_state_and_changed_proof_atomically(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); donor = copy.deepcopy(self.state)
        proof = h.build(donor, self.plan, new, self.root)
        current = c.initialize(new, self.root)
        for key, value in [('ready', True), ('attempts', [{'native': 'FAIL'}]),
                           ('failures', [{'id': 'current-failure'}]), ('skips', {'api/current': {}})]:
            changed = copy.deepcopy(current); changed[key] = value; before = copy.deepcopy(changed)
            with self.assertRaisesRegex(ValueError, 'fresh'):
                h.adopt(changed, donor, self.plan, proof, self.root)
            self.assertEqual(before, changed)
        bad = copy.deepcopy(proof); bad['cases'][0]['original_amount_cents'] = 0
        with self.assertRaisesRegex(ValueError, 'proof'):
            h.adopt(current, donor, self.plan, bad, self.root)
        self.assertEqual(c.initialize(new, self.root), current)

    def test_cross_goal_custody_import_rejects_noncurrent_frozen_ledger_binding(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); donor = copy.deepcopy(self.state)
        proof = h.build(donor, self.plan, new, self.root)
        current = c.initialize(new, self.root)
        for key, value in [('environment', 'stale'), ('source', donor['source']), ('input_fingerprints', {})]:
            changed = copy.deepcopy(current); changed[key] = value; before = copy.deepcopy(changed)
            with self.assertRaisesRegex(ValueError, 'fresh'):
                h.adopt(changed, donor, self.plan, proof, self.root)
            self.assertEqual(before, changed)
        missing = copy.deepcopy(new); missing['gates'][1]['checks'].remove('agent-payment-abandonment')
        with self.assertRaisesRegex(ValueError, 'protected task removed'):
            h.adopt(c.initialize(missing, self.root), donor, self.plan, proof, self.root)
        native = Path(proof['cases'][0]['original_failure']['worker_evidence']['path'])
        native.write_text('{}')
        with self.assertRaises(ValueError):
            h.adopt(current, donor, self.plan, proof, self.root)
        self.assertEqual(c.initialize(new, self.root), current)

    def test_cross_goal_custody_import_rejects_duplicate_identity_and_changed_pending_wrapper(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); donor = copy.deepcopy(self.state)
        duplicate = copy.deepcopy(donor)
        duplicate['failures'].append({'id': donor['failures'][0]['id'], 'check': 'other/unrelated',
                                      'native_result': 'PASS'})
        with self.assertRaisesRegex(ValueError, 'duplicate historical failure identity'):
            h.build(duplicate, self.plan, new, self.root)
        donor['pending_post_merge'][0]['native_result'] = 'PASS'
        proof = h.build(donor, self.plan, new, self.root)
        current = c.initialize(new, self.root); before = copy.deepcopy(current)
        with self.assertRaisesRegex(ValueError, 'pending repair wrapper changed'):
            h.adopt(current, donor, self.plan, proof, self.root)
        self.assertEqual(before, current)

    def test_cross_goal_custody_import_cli_keeps_donor_and_fresh_cycle_separate(self):
        import contextlib
        import io
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); donor = copy.deepcopy(self.state)
        new['gates'][1]['checks'] = new['gates'][1]['checks'][:2] + ['current-peer']
        directory = self.root / '.context' / 'independent'
        plan, prior, snapshot, proof = [self.root / '.context' / name for name in
                                        ('new.json', 'prior.json', 'donor.json', 'proof.json')]
        c.write(plan, new); c.write(prior, self.plan); c.write(snapshot, donor)
        c.write(proof, h.build(donor, self.plan, new, self.root))
        args = ['--root', str(self.root), '--plan', str(plan), '--state-dir', str(directory)]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(0, c.main(['init', *args]))
            self.assertEqual(0, c.main(['import-historical-no-retry', *args, '--input', str(prior),
                '--donor-state', str(snapshot), '--historical-no-retry-proof', str(proof)]))
            before = c.read(directory / 'cycle.json')
            self.assertEqual(2, c.main(['import-historical-no-retry', *args]))
        self.assertEqual(before, c.read(directory / 'cycle.json'))
        self.assertEqual(donor, c.read(snapshot))
        self.assertEqual('quick', before['phase']); self.assertFalse(before['ready'])
        self.assertEqual([], before['attempts']); self.assertEqual({}, before['skips'])
        self.assertEqual(new, before['plan']); self.assertEqual(2, len(before['historical_no_retry_custody']))

    def test_historical_stall_cannot_refresh_into_new_card_request_without_proof(self):
        new = self.custody_fixture()
        before = copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError, 'historical custody'):
            c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual(before, self.state)

    def test_historical_custody_refresh_runs_all_peers_and_keeps_native_debt(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture()
        originals = copy.deepcopy(self.state['failures'])
        debt = copy.deepcopy(self.state['pending_post_merge'])
        proof = h.build(self.state, self.plan, new, self.root)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        same = copy.deepcopy(self.state)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        self.assertEqual(same, self.state)
        with self.assertRaisesRegex(ValueError, 'mix election'):
            c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof, election_proof={})
        self.assertEqual(same, self.state)
        self.assertEqual(originals, self.state['failures'])
        self.assertEqual(debt, self.state['pending_post_merge'])
        self.assertEqual({}, self.state['skips']); self.assertEqual([], self.state['resource_warnings'])
        h.verify(self.state, self.root)
        self.state.update(phase='final')
        gate = self.state['plan']['gates'][1]
        def worker(argv, **kw):
            request = c.read(Path(kw['env']['DEPLOY_GATE_REQUEST']))
            self.assertEqual(['peer-' + str(i) for i in range(13)], request['checks'])
            self.assertEqual(2, len(request['skips']))
            self.assertTrue(all(x['disposition'] == h.DISPOSITION for x in request['skips'].values()))
            c.write(Path(kw['env']['DEPLOY_GATE_RESULT']), dict(token=request['token'], source=request['source'],
                gate=request['gate'], cases=dict.fromkeys(request['checks'], 'PASS'), complete=True, cleanup_complete=True, reused=False))
            return 0, False, False, False
        c.write(self.directory / 'cycle.json', self.state)
        with patch.object(c, 'run_command', side_effect=worker):
            result = c.execute(gate, self.state, self.directory, self.root)
        self.assertEqual('PASS', result['status'], result); self.assertTrue(result['complete'])
        for check in gate['checks'][:2]:
            self.assertEqual('SKIP', result['cases'][check])
            self.assertFalse(result['case_complete'][check]); self.assertEqual('UNVERIFIED', result['current_execution'][check])
        self.assertEqual(originals, self.state['failures'])
        self.state['attempts'].append(dict(phase='final', results=[result]))
        self.assertIsNotNone(c.full_pass_binding(self.state, gate, root=self.root))
        failed_directory = self.directory / 'peer-failure'
        c.write(failed_directory / 'cycle.json', self.state)
        def peer_failure(argv, **kw):
            worker(argv, **kw)
            path = Path(kw['env']['DEPLOY_GATE_RESULT']); value = c.read(path)
            value['cases']['peer-12'] = 'FAIL'; c.write(path, value)
            return 1, False, False, False
        with patch.object(c, 'run_command', side_effect=peer_failure):
            failed = c.execute(gate, self.state, failed_directory, self.root)
        self.assertEqual('FAIL', failed['status'])
        self.assertEqual('FAIL', failed['cases']['peer-12'])
        only_omissions = {**gate, 'checks': gate['checks'][:2]}
        with patch.object(c, 'run_command') as launch:
            omitted = c.execute(only_omissions, self.state, self.directory / 'only-omissions', self.root)
            launch.assert_not_called()
        self.assertFalse(omitted['executed'])
        self.assertEqual(dict.fromkeys(only_omissions['checks'], False), omitted['case_complete'])
        self.assertEqual(dict.fromkeys(only_omissions['checks'], 'UNVERIFIED'), omitted['current_execution'])
        self.assertFalse(failed['case_complete']['agent-payment-abandonment'])
        # A second source refresh preserves the original packet after legacy skips disappeared.
        old = self.state['plan']; (self.root / 'code').write_text('next current source')
        newer = copy.deepcopy(old); newer['source'] = c.source(self.root)
        self.state.update(phase='ready', ready=True)
        renewed = h.build(self.state, old, newer, self.root)
        c.refresh(self.state, old, newer, self.root, historical_no_retry_proof=renewed)
        self.assertEqual(debt, self.state['pending_post_merge'])
        self.assertEqual(originals, self.state['failures'])
        h.verify(self.state, self.root)
        c.resolve_post_merge(self.state, debt[0]['id'], 'https://boxes.dev/thread/repair-fixture')
        self.assertEqual([], self.state['pending_post_merge']); h.verify(self.state, self.root)

    def test_historical_custody_full_receipt_carries_across_history_only_commit(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture()
        proof = h.build(self.state, self.plan, new, self.root)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        self.state.update(phase='final')
        gate = self.state['plan']['gates'][1]
        def worker(argv, **kw):
            request = c.read(Path(kw['env']['DEPLOY_GATE_REQUEST']))
            self.assertEqual(['peer-' + str(i) for i in range(13)], request['checks'])
            self.assertEqual(2, len(request['skips']))
            c.write(Path(kw['env']['DEPLOY_GATE_RESULT']), dict(token=request['token'], source=request['source'],
                gate=request['gate'], cases=dict.fromkeys(request['checks'], 'PASS'), complete=True, cleanup_complete=True))
            return 0, False, False, False
        c.write(self.directory / 'cycle.json', self.state)
        with patch.object(c, 'run_command', side_effect=worker):
            receipt = c.execute(gate, self.state, self.directory, self.root)
        self.state['attempts'].append(dict(phase='final', results=[receipt]))
        self.state.update(phase='ready', ready=True)
        original = c.full_pass_binding(self.state, gate, root=self.root)
        self.assertIsNotNone(original)
        old = self.state['plan']
        native_files = {str(Path(receipt['log']).parent / name): (Path(receipt['log']).parent / name).read_bytes()
                        for name in ('request.json', 'receipt.json', 'result.json')}
        ledger = self.root / 'agents/benchmarks/history/writer.jsonl'
        ledger.parent.mkdir(parents=True); ledger.write_text('{"run": 1}\n')
        subprocess.run(['git', '-C', str(self.root), 'add', str(ledger)], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'history only'], check=True)
        newer = copy.deepcopy(old); newer['source'] = c.source(self.root)
        self.assertNotEqual(old['source']['head'], newer['source']['head'])
        # Source digest includes HEAD; execution inputs must remain byte-identical.
        self.assertNotEqual(old['source']['digest'], newer['source']['digest'])
        self.assertEqual(self.state['input_fingerprints'], c.input_fingerprints(newer, self.root))
        renewal = h.build(self.state, old, newer, self.root)
        with patch.object(c, 'run_command') as launch:
            c.refresh(self.state, old, newer, self.root, historical_no_retry_proof=renewal)
            self.assertIn('api', self.state['carried_passes'])
            self.assertEqual(original, self.state['carried_passes']['api']['native_binding'])
            self.assertEqual(original, c.full_pass_binding(self.state, gate, root=self.root))
            launch.assert_not_called()
        self.assertEqual(receipt['source'], original['native_source'])
        h.verify(self.state, self.root)
        self.assertTrue(c.carried_pass(self.state, gate, root=self.root))
        # A second history-only commit must still point to the same original native files.
        prior = self.state['plan']
        ledger.write_text(ledger.read_text() + '{"run": 2}\n')
        subprocess.run(['git', '-C', str(self.root), 'add', str(ledger)], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'second history'], check=True)
        current = copy.deepcopy(prior); current['source'] = c.source(self.root)
        renewal = h.build(self.state, prior, current, self.root)
        c.refresh(self.state, prior, current, self.root, historical_no_retry_proof=renewal)
        self.assertEqual(original, self.state['carried_passes']['api']['native_binding'])
        self.assertTrue(c.carried_pass(self.state, gate, root=self.root))
        self.assertEqual(native_files, {p: Path(p).read_bytes() for p in native_files})
        recovered = copy.deepcopy(self.state)
        recovered['attempts'][-1]['results'][0]['kind'] = 'recovered-native-execution-v1'
        self.assertIsNone(c.full_pass_binding(recovered, gate, root=self.root, custody_refresh=True))
        # File or environment changes invalidate positive carry, even though custody renews.
        code = (self.root / 'code').read_text()
        for change in ('file', 'environment'):
            candidate = copy.deepcopy(self.state)
            if change == 'file': (self.root / 'code').write_text('actual changed input')
            with patch.dict(os.environ, {'CUSTODY_CHANGED_INPUT': '1'} if change == 'environment' else {}):
                updated = copy.deepcopy(current); updated['source'] = c.source(self.root)
                proof = h.build(candidate, current, updated, self.root)
                with patch.object(c, 'run_command') as launch:
                    c.refresh(candidate, current, updated, self.root, historical_no_retry_proof=proof)
                    self.assertNotIn('api', candidate['carried_passes'])
                    self.assertFalse(c.carried_pass(candidate, gate, root=self.root))
                    launch.assert_not_called()
            (self.root / 'code').write_text(code)

    def test_historical_custody_rejects_tampering_and_missing_admission_proof(self):
        import deploy_test_historical_custody as h
        new = self.custody_fixture(); proof = h.build(self.state, self.plan, new, self.root)
        before = copy.deepcopy(self.state)
        for change in (lambda p: p['cases'].pop(), lambda p: p.update(extra=True),
                       lambda p: p['current_binding'].update(environment='wrong'),
                       lambda p: p['cases'][0].update(snapshot_sha256='0' * 64)):
            bad = copy.deepcopy(proof); change(bad)
            with self.assertRaises(ValueError):
                c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=bad)
            self.assertEqual(before, self.state)
        f = self.state['failures'][1]; file = Path(f['worker_evidence']['path']); raw = file.read_bytes()
        mutations = [lambda t: t['logs']['cloud_cleanup_evidence']['agentcard_release_stall_lifecycles'][t['agent_id']]['orgTransfer'].update(livemode=True),
                     lambda t: t['logs']['cloud_cleanup_evidence']['agentcard_release_stall_lifecycles'][t['agent_id']]['orgTransfer'].update(releasedCents=1),
                     lambda t: t['logs']['cloud_cleanup_evidence'].update(errors=['unknown owner'])]
        # Even a newly hashed native snapshot cannot turn live/released/nonstalled facts into custody.
        for change in mutations:
            candidate = copy.deepcopy(self.state)
            doc = json.loads(raw); change(doc['tasks'][0]); c.write(file, doc)
            candidate['failures'][1]['worker_evidence']['sha256'] = c.sha_file(file)
            adapter_path = Path(f['worker_result']); adapter_raw = adapter_path.read_bytes()
            adapter = c.read(adapter_path)
            adapter['evidence'][doc['tasks'][0]['name']] = candidate['failures'][1]['worker_evidence']
            c.write(adapter_path, adapter)
            with self.assertRaises(ValueError): h.build(candidate, self.plan, new, self.root)
            adapter_path.write_bytes(adapter_raw)
        mutations.append(lambda t: t['logs']['cloud_cleanup_evidence'].pop('agentcard_release_stall_lifecycles'))
        for change in mutations:
            doc = json.loads(raw); change(doc['tasks'][0]); c.write(file, doc)
            with self.assertRaises(ValueError): h.build(self.state, self.plan, new, self.root)
        file.write_bytes(raw)
        missing = copy.deepcopy(self.state); missing['failures'][1]['source']['head'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'original catalog'):
            h.known(missing, self.root)
        catalog = self.root / 'agents/benchmarks/tasks.json'; original = catalog.read_bytes()
        changed = json.loads(original); changed[0]['prompt'] = 'changed assertion/task'; c.write(catalog, changed)
        with self.assertRaises(ValueError): h.build(self.state, self.plan, new, self.root)
        catalog.write_bytes(original)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        self.state.update(phase='ready', ready=True); c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        request = dict(source=new['source'], gate='api', checks=['peer-' + str(i) for i in range(13)],
                       skips=c.reuse_qualifications(self.state, new['gates'][1], root=self.root),
                       custody_state=str(self.directory / 'cycle.json'), custody_state_sha256=h.state_identity(self.state), custody_child_environment=h.environment_identity(os.environ), custody_runtime=h.runtime_identity(self.root))
        h.admission(request, self.root)
        runtime = self.root / '.env'; runtime.write_text('CUSTODY_FIXTURE=changed')
        with self.assertRaises(ValueError): h.admission(request, self.root)
        runtime.unlink()
        with patch.dict(os.environ, CUSTODY_FIXTURE='changed'):
            with self.assertRaises(ValueError): h.admission(request, self.root)
        self.state['historical_no_retry_custody'] = []; c.write(self.directory / 'cycle.json', self.state)
        self.assertNotEqual(0, c.verify_saved(self.directory, self.root))
        request['custody_state_sha256'] = h.state_identity(self.state)
        with self.assertRaises(ValueError): h.admission(request, self.root)
        with patch.object(c, 'run_command') as launch:
            with self.assertRaises(ValueError): c.execute(new['gates'][1], self.state, self.directory, self.root)
            launch.assert_not_called()

    def test_historical_native_audit_rejects_corrupt_tree_and_active_owner(self):
        import deploy_test_historical_custody as h
        import runpy
        token = 'b' * 32
        fleet = self.root / '.context/native/run-2147483647'
        local = fleet / 'teardown-ownership'
        canonical = self.root / '.git/cloudbench-fleet-audits' / token
        local.mkdir(parents=True); canonical.mkdir(parents=True)
        meta = ('status=provider-teardown-verified\nfleet_owner_token=' + token
                + '\nrun_id=' + fleet.name + '\nworkspace_root=' + str(self.root) + '\n')
        for directory in (local, canonical): (directory / 'meta').write_text(meta)
        digest = runpy.run_path(str(ROOT / 'scripts/cloudbench-retained-successor.py'))['tree_digest']
        def seal():
            sha = digest(local)
            for directory in (local, canonical):
                (directory / 'source-audit').write_text('path=' + str(canonical) + '\nsha256=' + sha + '\n')
            c.write(fleet / '_batch/lifecycle.json', dict(fleet_owner_token=token, status='verified',
                hub_publication_failed=False, workspace_root=str(self.root), run_id=fleet.name, audit_sha256=sha))
        seal()
        native = fleet / 'task/cloudbench-run.json'
        self.assertEqual(str(fleet), h.native_closure(native, self.root)['fleet'])
        argv = list(sys.argv)
        owned_modules = {key for key in sys.modules if key.startswith('_deploy_source_')}
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(h.native_closure, native, self.root) for _ in range(2)]
            self.assertTrue(all(f.result(timeout=10)['fleet'] == str(fleet) for f in futures))
        self.assertEqual(argv, sys.argv)
        self.assertEqual(owned_modules, {key for key in sys.modules if key.startswith('_deploy_source_')})
        (canonical / 'meta').write_text(meta + 'changed=true\n')
        with self.assertRaises(ValueError): h.native_closure(native, self.root)
        self.assertEqual(owned_modules, {key for key in sys.modules if key.startswith('_deploy_source_')})
        (canonical / 'meta').write_text(meta)
        registry = self.root / '.git/cloudbench-fleet-ownership' / token; registry.mkdir(parents=True)
        with self.assertRaises(ValueError): h.native_closure(native, self.root)
        registry.rmdir()
        for directory in (local, canonical):
            (directory / 'meta').write_text(meta + 'hub_pid=' + str(os.getpid()) + '\n')
        seal()
        with self.assertRaises(ValueError): h.native_closure(native, self.root)

    def test_refresh_unstarted_final_preserves_history_and_refuses_active_or_started_phase(self):
        state = copy.deepcopy(self.state)
        state.update(phase='final', next_after_quick='final')
        state['attempts'].append({'phase': 'quick', 'source': state['source'], 'results': []})
        (self.root / 'code').write_text('repaired source before final admission')
        new = copy.deepcopy(self.plan)
        new['source'] = c.source(self.root)
        before = copy.deepcopy(state)
        c.refresh(state, self.plan, new, self.root)
        self.assertEqual(state['attempts'], before['attempts'])
        self.assertEqual(state['phase'], 'quick')
        self.assertFalse(state['ready'])
        for extra in ({'running': [{'gate': 'api'}]}, {'live_failures': []},
                      {'resume_phase': 'final'}, {'pending': ['unresolved']}):
            candidate = {**copy.deepcopy(before), **extra}
            original = copy.deepcopy(candidate)
            with self.assertRaises(ValueError):
                c.refresh(candidate, self.plan, new, self.root)
            self.assertEqual(candidate, original)
        candidate = copy.deepcopy(before)
        candidate['attempts'].append({'phase': 'final', 'source': candidate['source'], 'results': []})
        with self.assertRaises(ValueError):
            c.refresh(candidate, self.plan, new, self.root)

    def source_refusal_fixture(self):
        import hashlib, time
        import deploy_test_cloud_refusal as refusal
        policies = {}
        for name in refusal.POLICIES:
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('# audited pre-admission fixture: ' + name)
            policies[name] = (hashlib.sha256(path.read_bytes()).hexdigest(),)
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'audited producer'], check=True)
        gate = {'name': 'smoke', 'category': 'smoke', 'native_cloud': True,
                'worker_transport': 'benchmark-cloud-cli', 'cwd': str(self.root),
                'command': ['/fixture/bin/python3', str(self.root / 'scripts/deploy_test_cloud.py')],
                'checks': ['one', 'two']}
        token = 'a' * 32
        folder = self.root / '.context/deploy-pipeline/attempts/2/initial/smoke'
        folder.mkdir(parents=True)
        owner = {'request_token': token, 'worker_root': str(self.root), 'native_cleanup_reference': None}
        receipt = dict(gate='smoke', token=token, source=c.source(self.root), native_exit=2,
                       executed=True, status='FAIL', complete=False, lifecycle='native-producer',
                       timed_out=False, cancelled=False, lingering_group=True, worker_result=None,
                       native_cleanup_reference=None, cleanup_owner=owner,
                       cases=dict.fromkeys(gate['checks'], 'UNVERIFIED'),
                       case_complete=dict.fromkeys(gate['checks'], False), command=gate['command'],
                       execution_binding={'contract_digest': c.digest(gate)},
                       log=str(folder / 'output.log'), stderr_log=str(folder / 'stderr.log'),
                       started_at=time.time() - 2, finished_at=time.time() - 1)
        c.write(folder / 'request.json', {k: receipt[k] for k in ('token', 'source', 'gate')} |
                {'checks': gate['checks'], 'skips': {}, 'phase': 'initial'})
        c.write(folder / 'receipt.json', receipt)
        (folder / 'output.log').write_bytes(refusal.MESSAGE)
        (folder / 'stderr.log').write_bytes(b'')
        state = copy.deepcopy(self.state)
        state['plan']['gates'].append(gate)
        state['attempts'].append({'phase': 'initial', 'results': [receipt]})
        proof = dict(kind=refusal.KIND, root=str(self.root), request_token=token,
                     files={str(p): c.sha_file(p) for p in folder.iterdir()},
                     confirmed_at=time.time(), observed_by='hermetic source-refusal test')
        return refusal, policies, state, receipt, proof

    def test_source_refusal_reconciliation_preserves_unverified_history_and_is_idempotent(self):
        refusal, policies, state, receipt, proof = self.source_refusal_fixture()
        original = copy.deepcopy(state)
        originals = {p: Path(p).read_bytes() for p in proof['files']}
        with patch.dict(refusal.POLICIES, policies, clear=True), \
                patch.object(refusal, 'no_holders'), patch.object(refusal, 'namespace_quiet'):
            self.assertEqual(c.retained_owners(state, ['smoke']), ['smoke'])
            c.reconcile(state, receipt['token'], proof)
            self.assertEqual(c.retained_owners(state, ['smoke']), [])
            accepted = copy.deepcopy(state)
            c.reconcile(state, receipt['token'], proof)
            self.assertEqual(state, accepted)
            entry, = state['reconciled_owners'].values()
            self.assertFalse(entry['credit_granted'])
            self.assertFalse(entry['financial_cleanup_credit'])
            self.assertEqual({k: v for k, v in state.items() if k != 'reconciled_owners'}, original)
            self.assertEqual(originals, {p: Path(p).read_bytes() for p in proof['files']})
            (Path(receipt['log'])).write_bytes(b'changed evidence')
            self.assertEqual(c.retained_owners(state, ['smoke']), ['smoke'])

    def test_source_refusal_reconciliation_refuses_unbound_or_allocated_evidence(self):
        import hashlib
        refusal, policies, state, receipt, proof = self.source_refusal_fixture()
        with patch.dict(refusal.POLICIES, policies, clear=True), \
                patch.object(refusal, 'no_holders'), patch.object(refusal, 'namespace_quiet'):
            mutations = [lambda s, p: p.update(request_token='b' * 32),
                         lambda s, p: p.update(confirmed_at=receipt['started_at'] - 1),
                         lambda s, p: p['files'].update({receipt['log']: '0' * 64}),
                         lambda s, p: p['files'].update({'/unbound': '0' * 64}),
                         lambda s, p: s['plan']['gates'][-1]['command'].append('--other')]
            for mutate in mutations:
                candidate, changed = copy.deepcopy(state), copy.deepcopy(proof)
                mutate(candidate, changed)
                before = copy.deepcopy(candidate)
                with self.assertRaises(ValueError):
                    c.reconcile(candidate, receipt['token'], changed)
                self.assertEqual(candidate, before)
            for name in ('no_holders', 'namespace_quiet'):
                with patch.object(refusal, name, side_effect=ValueError('unknown consumer')):
                    with self.assertRaises(ValueError):
                        c.reconcile(state, receipt['token'], proof)
            with patch.dict(refusal.POLICIES, {next(iter(policies)): ('0' * 64,)}):
                with self.assertRaisesRegex(ValueError, 'unaudited producer'):
                    c.reconcile(state, receipt['token'], proof)
            namespace = self.root / '.context/deploy-cloud' / hashlib.sha256(receipt['token'].encode()).hexdigest()
            namespace.mkdir(parents=True)
            with self.assertRaises(ValueError):
                c.reconcile(state, receipt['token'], proof)
            namespace.rmdir()
            namespace.symlink_to(self.root, target_is_directory=True)
            with self.assertRaises(ValueError):
                c.reconcile(state, receipt['token'], proof)
            namespace.unlink()
            log = Path(receipt['log'])
            log.rename(log.with_suffix('.original'))
            log.symlink_to(log.with_suffix('.original'))
            with self.assertRaises(ValueError):
                c.reconcile(state, receipt['token'], proof)

    def legacy_custody_refusal_fixture(self):
        import hashlib
        import deploy_test_historical_custody as h
        refusal, _, state, receipt, proof = self.source_refusal_fixture()
        policies = {}
        for name in ('deploy_test_cloud.py', 'deploy_test_cycle.py', 'deploy_test_process.py',
                     'deploy_test_historical_custody.py', 'cloudbench_execution_provenance.py', 'cloudbench_result.py'):
            path = self.root / 'scripts' / name
            if not path.exists(): path.write_text('# audited legacy fixture: ' + name)
            policies['scripts/' + name] = (hashlib.sha256(path.read_bytes()).hexdigest(),)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=test@example.com',
                        'commit','-qm','legacy custody producer'],check=True)
        folder=self.root/'.context/deploy-final/attempts/2/initial/smoke'; folder.mkdir(parents=True)
        receipt.update(source=c.source(self.root),log=str(folder/'output.log'),stderr_log=str(folder/'stderr.log'))
        state['source']=receipt['source']; state['plan']['source']=receipt['source']
        state['plan_digest']=c.digest(state['plan']); state['input_fingerprints']['smoke']=c.digest({'input':'smoke'})
        receipt['execution_binding'].update(environment=state['environment'],input_fingerprint=state['input_fingerprints']['smoke'])
        gate=state['plan']['gates'][-1]
        gate.update(worker='cloud-smoke-worker',case_protocol=True,quick=False)
        state['plan_digest']=c.digest(state['plan'])
        receipt['execution_binding']['contract_digest']=c.digest(gate)
        locator=folder.parents[3]/'cycle.json'
        request={k:receipt[k] for k in ('token','source','gate')}
        request.update(checks=state['plan']['gates'][-1]['checks'],skips={},phase='initial',custody_state=str(locator),
                       custody_state_sha256=h.state_identity(state),custody_runtime={'agents/.env':c.digest({'runtime':'fixture'})},custody_child_environment=c.digest({'child':'env'}))
        c.write(folder/'request.json',request); c.write(folder/'receipt.json',receipt)
        (folder/'output.log').write_bytes(b'DEPLOY_CLOUD BLOCKED: historical custody: missing canonical custody locator\n')
        (folder/'stderr.log').write_bytes(b''); c.write(locator,state)
        snapshot=self.root/'.context/proof/parent-cycle.json'; c.write(snapshot,state)
        proof.update(files={str(p):c.sha_file(p) for p in [*folder.iterdir(),snapshot]},legacy_state_snapshot=str(snapshot))
        for name,value in [('LEGACY_CUSTODY_HEAD',receipt['source']['head']),('LEGACY_CUSTODY_POLICIES',policies)]:
            patcher=patch.object(refusal,name,value,create=True);patcher.start();self.addCleanup(patcher.stop)
        capture=dict(source=receipt['source'],token=receipt['token'],locator=str(locator),
                     request_sha256=c.sha_file(folder/'request.json'),receipt_sha256=c.sha_file(folder/'receipt.json'))
        patcher=patch.object(refusal,'LEGACY_CUSTODY_CAPTURE',capture,create=True)
        patcher.start();self.addCleanup(patcher.stop)
        return refusal,state,receipt,proof

    def test_legacy_custody_refusal_retirement_preserves_receipt_and_is_idempotent(self):
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        before=copy.deepcopy(state); raw={p:Path(p).read_bytes() for p in proof['files']}
        self.assertEqual(c.retained_owners(state,['smoke']),['smoke'])
        c.reconcile(state,receipt['token'],proof)
        self.assertEqual(c.retained_owners(state,['smoke']),[])
        accepted=copy.deepcopy(state);c.reconcile(state,receipt['token'],proof);self.assertEqual(state,accepted)
        self.assertEqual({k:v for k,v in state.items() if k!='reconciled_owners'},before)
        self.assertEqual(raw,{p:Path(p).read_bytes() for p in proof['files']})
        entry,=state['reconciled_owners'].values()
        self.assertFalse(entry['credit_granted']);self.assertFalse(entry['financial_cleanup_credit'])
        self.assertEqual(set(receipt['cases'].values()),{'UNVERIFIED'})
        self.assertFalse((Path(receipt['log']).parent/'result.json').exists())

    def test_legacy_custody_refusal_survives_real_refresh_without_relaxing_execution_contract(self):
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        c.reconcile(state,receipt['token'],proof)
        original=copy.deepcopy(receipt);old=copy.deepcopy(state['plan'])
        (self.root/'code').write_text('new frozen source')
        subprocess.run(['git','-C',str(self.root),'add','code'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=test@example.com',
                        'commit','-qm','new source'],check=True)
        new=copy.deepcopy(old);new['source']=c.source(self.root)
        new['gates'][-1]['selection_evidence']=['new infrastructure input']
        c.refresh(state,old,new,self.root)
        self.assertEqual(c.retained_owners(state,['smoke']),[])
        locator=Path(receipt['log']).parent.parents[3]/'cycle.json'
        c.write(locator,state)
        self.assertEqual(c.retained_owners(state,['smoke']),[])
        self.assertEqual(c.latest_receipts(state)['smoke'],original)
        for field,value in [('command',receipt['command']+['--extra']),('checks',['one']),
                            ('timeout_seconds',9),('native_cloud',False)]:
            changed=copy.deepcopy(state);changed['plan']['gates'][-1][field]=value
            self.assertEqual(c.retained_owners(changed,['smoke']),['smoke'])

    def test_legacy_custody_refusal_rejects_resealed_capture(self):
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        folder=Path(receipt['log']).parent;locator=folder.parents[3]/'cycle.json'
        originals={p:Path(p).read_bytes() for p in [*proof['files'],str(locator)]}
        for field,value in [('source',{'head':receipt['source']['head'],'digest':'f'*64}),
                            ('custody_runtime',{}),('custody_child_environment','0'*64)]:
            candidate=copy.deepcopy(state);claim=copy.deepcopy(proof)
            request=c.read(folder/'request.json');request[field]=value
            if field=='source':
                candidate['source']=value;candidate['plan']['source']=value
                candidate['attempts'][-1]['results'][0]['source']=value
                candidate['plan_digest']=c.digest(candidate['plan'])
                c.write(folder/'receipt.json',candidate['attempts'][-1]['results'][0])
                import deploy_test_historical_custody as h
                request['custody_state_sha256']=h.state_identity(candidate)
                c.write(Path(claim['legacy_state_snapshot']),candidate);c.write(locator,candidate)
            c.write(folder/'request.json',request)
            claim['files']={p:c.sha_file(p) for p in claim['files']}
            with self.assertRaises(ValueError):c.reconcile(candidate,receipt['token'],claim)
            for p,raw in originals.items():Path(p).write_bytes(raw)

    def test_legacy_custody_refusal_requires_finite_typed_timestamps(self):
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        for value in (False,True,float('inf'),float('-inf'),float('nan'),0,-1):
            claim={**proof,'confirmed_at':value}
            with self.assertRaises(ValueError):c.reconcile(state,receipt['token'],claim)
        folder=Path(receipt['log']).parent;locator=folder.parents[3]/'cycle.json'
        raw={p:Path(p).read_bytes() for p in [*proof['files'],str(locator)]}
        for field in ('started_at','finished_at'):
            for value in (False,float('-inf'),float('nan')):
                candidate=copy.deepcopy(state);candidate['attempts'][-1]['results'][0][field]=value
                # Deliberately corrupt historical JSON, bypassing the strict producer writer.
                (folder/'receipt.json').write_text(json.dumps(candidate['attempts'][-1]['results'][0]))
                Path(proof['legacy_state_snapshot']).write_text(json.dumps(candidate));locator.write_text(json.dumps(candidate))
                claim=copy.deepcopy(proof);claim['files']={p:c.sha_file(p) for p in claim['files']}
                capture={**refusal.LEGACY_CUSTODY_CAPTURE,'receipt_sha256':c.sha_file(folder/'receipt.json')}
                with patch.object(refusal,'LEGACY_CUSTODY_CAPTURE',capture):
                    with self.assertRaises(ValueError):c.reconcile(candidate,receipt['token'],claim)
                for p,data in raw.items():Path(p).write_bytes(data)

    def test_legacy_custody_refusal_rejects_forged_identity_environment_and_credit(self):
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        folder=Path(receipt['log']).parent;raw={p:Path(p).read_bytes() for p in proof['files']}
        locator=folder.parents[3]/'cycle.json';raw[str(locator)]=locator.read_bytes()
        def check(change,reseal=False):
            candidate,claim=copy.deepcopy(state),copy.deepcopy(proof);change(candidate,claim)
            if reseal:claim['files']={p:c.sha_file(p) for p in claim['files']}
            with self.assertRaises(ValueError):c.reconcile(candidate,receipt['token'],claim)
            for p,data in raw.items():Path(p).write_bytes(data)
        def request_change(**changes):
            def change(s,p):
                request=c.read(folder/'request.json');request.update(changes);c.write(folder/'request.json',request)
            return change
        for change in (lambda s,p:p.update(request_token='b'*32),lambda s,p:p.update(credit_granted=True),
                       lambda s,p:p.update(financial_cleanup_credit=True),lambda s,p:p['files'].update({receipt['log']:'0'*64}),
                       lambda s,p:s['attempts'][-1]['results'][0].update(source={'head':'f'*40,'digest':'f'*64}),
                       lambda s,p:s['attempts'][-1]['results'][0].update(status='PASS'),
                       lambda s,p:s['attempts'][-1]['results'][0].update(cases={'one':'PASS','two':'PASS'}),
                       lambda s,p:s['plan']['gates'][-1]['command'].append('--extra')):check(change)
        for changes in ({'token':'b'*32},{'source':{'head':'f'*40,'digest':'f'*64}},
                        {'custody_state':str(self.root/'.context/other/cycle.json')},
                        {'custody_state_sha256':'0'*64},{'checks':['one']},
                        {'custody_child_environment':'not-a-hash'},{'custody_runtime':{'agents/.env':'bad'}}):
            check(request_change(**changes),True)
        def change_snapshot(s,p):
            snapshot=c.read(Path(p['legacy_state_snapshot']));snapshot['environment']='0'*64
            c.write(Path(p['legacy_state_snapshot']),snapshot)
        check(change_snapshot,True)
        def change_live_parent(s,p):
            parent=c.read(locator);parent['attempts'][-1]['results'][0]['token']='b'*32;c.write(locator,parent)
        check(change_live_parent)
        def other_error(s,p):Path(receipt['log']).write_bytes(b'DEPLOY_CLOUD BLOCKED: arbitrary error\n')
        check(other_error,True)
        with patch.dict(refusal.LEGACY_CUSTODY_POLICIES,{'scripts/deploy_test_cloud.py':('0'*64,)}):
            with self.assertRaisesRegex(ValueError,'unaudited producer'):c.reconcile(state,receipt['token'],proof)

    def test_legacy_custody_refusal_rejects_present_namespace_adapter_symlink_and_live_holder(self):
        import hashlib
        refusal,state,receipt,proof=self.legacy_custody_refusal_fixture()
        namespace=self.root/'.context/deploy-cloud'/hashlib.sha256(receipt['token'].encode()).hexdigest()
        namespace.mkdir(parents=True)
        with self.assertRaises(ValueError):c.reconcile(state,receipt['token'],proof)
        namespace.rmdir();result=Path(receipt['log']).parent/'result.json';result.write_text('{}')
        with self.assertRaises(ValueError):c.reconcile(state,receipt['token'],proof)
        result.unlink();snapshot=Path(proof['legacy_state_snapshot']);original=snapshot.with_suffix('.original')
        snapshot.rename(original);snapshot.symlink_to(original)
        with self.assertRaises(ValueError):c.reconcile(state,receipt['token'],proof)
        snapshot.unlink();original.rename(snapshot)
        for held in (receipt['log'], proof['legacy_state_snapshot']):
            holder=subprocess.Popen([sys.executable,'-c',
                'import sys;f=open(sys.argv[1]);print("ready",flush=True);sys.stdin.read()',held],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
            try:
                self.assertEqual(holder.stdout.readline().strip(),'ready')
                with self.assertRaisesRegex(ValueError,'holder|writer'):c.reconcile(state,receipt['token'],proof)
            finally:
                holder.stdin.close();holder.wait(timeout=10);holder.stdout.close()
        participant=subprocess.Popen([sys.executable,'-c',
            'import sys;print("ready",flush=True);sys.stdin.read()',str(namespace)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(participant.stdout.readline().strip(),'ready')
            with self.assertRaisesRegex(ValueError,'namespace.*consumer'):
                c.reconcile(state,receipt['token'],proof)
        finally:
            participant.stdin.close();participant.wait(timeout=10);participant.stdout.close()

    def test_explicit_cloud_source_refusal_has_no_owner_and_no_test_credit(self):
        import deploy_test_cloud_refusal as refusal
        gate = {'name': 'smoke', 'category': 'smoke', 'native_cloud': True,
                'worker_transport': 'benchmark-cloud-cli', 'cwd': str(self.root),
                'command': [sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')],
                'case_protocol': True, 'checks': ['one', 'two']}
        state = copy.deepcopy(self.state)
        state['input_fingerprints']['smoke'] = 'fixture'
        def native(argv, **kwargs):
            request = c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            result = {k: request[k] for k in ('token', 'source', 'gate')}
            result.update(cases=dict.fromkeys(request['checks'], 'UNVERIFIED'), complete=False,
                          cleanup_complete=True, reused=False, evidence={}, native_exit=2,
                          native_command=[], fleet_directory=None,
                          reason='cloud source differs from the requested freeze',
                          admission={'kind': 'cloud-source-refusal-v1', 'admitted': False})
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
            return 2, False, False, False
        with patch.object(c, 'run_command', side_effect=native):
            receipt = c._execute(gate, state, self.directory, self.root)
        self.assertFalse(receipt['complete'])
        self.assertEqual(receipt['status'], 'FAIL')
        self.assertEqual(receipt['cases'], dict.fromkeys(gate['checks'], 'UNVERIFIED'))
        self.assertFalse(receipt['lingering_group'])
        self.assertIsNone(c.receipt_owner('smoke', receipt))
        request = c.read(Path(receipt['log']).parent / 'request.json')
        result = c.read(Path(receipt['worker_result']))
        for field, value in [('admission', None), ('cleanup_complete', False), ('cases', {'one': 'PASS', 'two': 'PASS'}),
                             ('native_command', ['provider']), ('token', 'other')]:
            changed = {**result, field: value}
            self.assertFalse(refusal.refused_before_admission(changed, request, gate, self.root, 2, invalid_process=False))
        self.assertFalse(refusal.refused_before_admission(result, request, gate, self.root, 2, invalid_process=True))

    def test_unpushed_source_refusal_has_no_owner_and_binds_the_requested_head(self):
        # PR #1767: an unpushed head must end as a typed refusal, never a retained smoke cleanup owner.
        import deploy_test_cloud_refusal as refusal
        gate = {'name': 'smoke', 'category': 'smoke', 'native_cloud': True,
                'worker_transport': 'benchmark-cloud-cli', 'cwd': str(self.root),
                'command': [sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')],
                'case_protocol': True, 'checks': ['one', 'two']}
        state = copy.deepcopy(self.state)
        state['input_fingerprints']['smoke'] = 'fixture'
        def native(argv, **kwargs):
            request = c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            result = {k: request[k] for k in ('token', 'source', 'gate')}
            result.update(cases=dict.fromkeys(request['checks'], 'UNVERIFIED'), complete=False,
                          cleanup_complete=True, reused=False, evidence={}, native_exit=2,
                          native_command=[], fleet_directory=None,
                          reason=refusal.unpushed_reason(request['source']['head']),
                          admission={'kind': 'cloud-source-refusal-v1', 'admitted': False})
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
            return 2, False, False, False
        with patch.object(c, 'run_command', side_effect=native):
            receipt = c._execute(gate, state, self.directory, self.root)
        self.assertEqual((receipt['complete'], receipt['status'], receipt['lingering_group']), (False, 'FAIL', False))
        self.assertEqual(receipt['cases'], dict.fromkeys(gate['checks'], 'UNVERIFIED'))
        self.assertIsNone(c.receipt_owner('smoke', receipt))
        self.assertNotIn('cleanup_owner', receipt)
        request = c.read(Path(receipt['log']).parent / 'request.json')
        result = c.read(Path(receipt['worker_result']))
        self.assertTrue(refusal.refused_before_admission(result, request, gate, self.root, 2, invalid_process=False))
        for reason in (refusal.unpushed_reason('f' * 40), 'push before gates', None):
            self.assertFalse(refusal.refused_before_admission({**result, 'reason': reason}, request, gate,
                                                              self.root, 2, invalid_process=False))

    def test_custody_locator_refusal_has_no_owner_and_binds_its_reason_code(self):
        # PR #1784 cycle bn6: a pre-allocation custody refusal must not retain a smoke cleanup owner.
        import deploy_test_cloud_refusal as refusal
        import deploy_test_historical_custody as h
        gate = {'name': 'smoke', 'category': 'smoke', 'native_cloud': True,
                'worker_transport': 'benchmark-cloud-cli', 'cwd': str(self.root),
                'command': [sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')],
                'case_protocol': True, 'checks': ['one', 'two']}
        state = copy.deepcopy(self.state)
        state['input_fingerprints']['smoke'] = 'fixture'
        def native(argv, **kwargs):
            request = c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            result = {k: request[k] for k in ('token', 'source', 'gate')}
            result.update(cases=dict.fromkeys(request['checks'], 'UNVERIFIED'), complete=False,
                          cleanup_complete=True, reused=False, evidence={}, native_exit=2,
                          native_command=[], fleet_directory=None,
                          reason=h.ADMISSION_REFUSALS['canonical-custody-uncovered'],
                          reason_code='canonical-custody-uncovered',
                          admission={'kind': 'cloud-source-refusal-v1', 'admitted': False})
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
            return 2, False, False, False
        with patch.object(c, 'run_command', side_effect=native):
            receipt = c._execute(gate, state, self.directory, self.root)
        self.assertEqual((receipt['complete'], receipt['status'], receipt['lingering_group']), (False, 'FAIL', False))
        self.assertEqual(receipt['cases'], dict.fromkeys(gate['checks'], 'UNVERIFIED'))
        self.assertEqual(receipt['case_complete'], dict.fromkeys(gate['checks'], False))
        self.assertIsNone(c.receipt_owner('smoke', receipt))
        self.assertNotIn('cleanup_owner', receipt)
        request = c.read(Path(receipt['log']).parent / 'request.json')
        result = c.read(Path(receipt['worker_result']))
        self.assertTrue(refusal.refused_before_admission(result, request, gate, self.root, 2, invalid_process=False))
        for changed in ({**result, 'reason_code': 'canonical-locator-missing'}, {**result, 'reason_code': None},
                        {**result, 'reason': 'historical custody: admission input fingerprint changed'},
                        {**result, 'reason': refusal.SOURCE_DIFFERS},
                        {**result, 'cleanup_owner': {'request_token': result['token']}}):
            self.assertFalse(refusal.refused_before_admission(changed, request, gate, self.root, 2, invalid_process=False))
        source = {**result, 'reason': refusal.SOURCE_DIFFERS}; source.pop('reason_code')
        self.assertTrue(refusal.refused_before_admission(source, request, gate, self.root, 2, invalid_process=False))
        self.assertFalse(refusal.refused_before_admission(result, request, gate, self.root, 2, invalid_process=True))

    def test_native_cloud_rejects_unsupported_host_before_coordinator_admission(self):
        plan = copy.deepcopy(self.plan)
        plan['gates'][1].update(native_cloud=True, case_protocol=True,
                                command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],
                                worker_transport='benchmark-cloud-cli')
        with patch.object(sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(ValueError, 'native cloud.*Linux'):
                c.validate_plan(plan, self.root)

    def test_environment_fingerprint_ignores_codex_call_identity_but_binds_launch_inputs(self):
        with patch.dict(os.environ, {'CODEX_TOOL_CALL_ID': 'call-one', 'PATH': '/fixture/bin',
                                     'SNAPSHOT_LOOP_TOKEN': 'original'}, clear=True):
            original = c.environment_digest()
            os.environ['CODEX_TOOL_CALL_ID'] = 'call-two'
            self.assertEqual(original, c.environment_digest())
            os.environ['PATH'] = '/changed/bin'
            self.assertNotEqual(original, c.environment_digest())
            os.environ['PATH'] = '/fixture/bin'
            os.environ['SNAPSHOT_LOOP_TOKEN'] = 'inherited'
            self.assertNotEqual(original, c.environment_digest())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'code').write_text('original')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'fixture'], check=True)
        self.directory = self.root / '.context' / 'cycle'
        (self.root / '.git' / 'info' / 'exclude').write_text('.context/\n')
        self.workers = tempfile.TemporaryDirectory()
        for name in ('api', 'ui'):
            (Path(self.workers.name) / name).mkdir()
        self.plan = {'source': c.source(self.root), 'gates': [
            {'name': 'static', 'category': 'eslint', 'quick': True, 'command': ['true'], 'checks': ['lint']},
            {'name': 'api', 'worker': 'api-worker', 'command': ['true'], 'checks': ['a', 'b']},
            {'name': 'ui', 'worker': 'ui-worker', 'command': ['true'], 'checks': ['c']},
        ] + [{'name':name,'category':name,'quick':True,'command':['true'],'checks':[name]}
             for name in ('format','typescript','backend-structural')]}
        for index, gate in enumerate(self.plan['gates'][1:3]):
            gate.update(worker_transport='local-isolated',
                        cwd=str(Path(self.workers.name) / gate['name']),
                        env={'CONDUCTOR_WORKSPACE_NAME': gate['name'],
                             'CONDUCTOR_PORT': str(12000 + index * 12000)})
        self.state = c.initialize(self.plan, self.root)

    def tearDown(self):
        c.CANCEL.clear()
        self.workers.cleanup()
        self.temp.cleanup()

    def local_rebind_fixture(self):
        import contextlib, io
        old = copy.deepcopy(self.plan)
        gate = old['gates'][1]
        remote = '/prepared/remote-api'
        env = {'CONDUCTOR_WORKSPACE_NAME': 'remote-api', 'CONDUCTOR_PORT': '4000',
               'DEPLOY_RUN_ROOT': remote + '/.context/deploy-runs', 'DEPLOY_CYCLE_FRESH': '1'}
        recipe = {'cases': {check: {'command': ['bash', remote + '/scripts/case.sh', check],
                   'env': dict(env), 'timeout_seconds': 14400} for check in gate['checks']},
                  'setup': {'command': ['true'], 'env': dict(env)},
                  'cleanup': {'command': ['true'], 'env': dict(env)}, 'services': True}
        gate.update(worker_transport='boxes-thread', worker_host='host-api', worker_thread='thread-api',
                    coordinator_thread='parent', worker_root=remote, remote_python=remote + '/agents/venv/bin/python',
                    cwd=str(self.root), env=env, case_protocol=True, result_transport='file',
                    timeout_seconds=14400, worker_recipe=recipe,
                    command=[sys.executable, str(self.root / 'scripts/deploy_test_boxes.py'), '--thread',
                             'thread-api', '--host', 'host-api', '--worker-root', remote, '--python',
                             remote + '/agents/venv/bin/python', '--coordinator-thread', 'parent',
                             '--deadline-seconds', '14400'])
        target = Path(self.workers.name) / 'new-api'
        subprocess.run(['git', 'clone', '-q', '--local', str(self.root), str(target)], check=True)
        new = copy.deepcopy(old)
        new['gates'][1] = c.local_worker_gate(gate, self.root, str(target), 'local-api', '12000')
        state = c.initialize(old, self.root)
        state.update(phase='ready', ready=True, carried_passes={'api': {'old': 'native evidence'}},
                     reconciled_owners={'historical-owner': {'obligation': 'retained'}},
                     pending_post_merge=[{'packet': 'original immutable post-merge obligation'}])
        native = dict(gate='api', source=state['source'], cases={'a': 'PASS', 'b': 'PASS'},
                      status='PASS', complete=True, executed=True, command=gate['command'], native_exit=0)
        state['attempts'].append({'phase': 'initial', 'results': [native]})
        original = self.directory / 'original.json'; local = self.directory / 'local.json'
        c.write(original, old); c.write(local, new); c.write(self.directory / 'cycle.json', state)
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(['rebind-local', '--plan', str(local), '--input', str(original),
                               '--state-dir', str(self.directory), '--root', str(self.root)])
        return old, new, state, target, local, call

    def test_local_rebind_cli_preserves_native_history_and_requires_fresh_full_gate(self):
        old, new, state, target, local, call = self.local_rebind_fixture()
        with self.assertRaisesRegex(ValueError, 'execution contract'):
            c.refresh(copy.deepcopy(state), old, new, self.root)
        self.assertEqual(0, call())
        after = c.read(self.directory / 'cycle.json')
        for key in ('source', 'attempts', 'failures', 'reconciled_owners', 'pending_post_merge', 'skips', 'round'):
            self.assertEqual(state[key], after[key])
        self.assertFalse(after['ready']); self.assertEqual('quick', after['phase'])
        self.assertEqual('initial', after['next_after_quick']); self.assertNotIn('api', after['carried_passes'])
        self.assertEqual(old, after['worker_rebind_history'][0]['from_plan'])
        self.assertFalse(after['worker_rebind_history'][0]['credit_granted'])
        after['phase'] = 'initial'
        self.assertIn('api', [g['name'] for g in c.records(new, after)])
        gate = new['gates'][1]
        self.assertEqual(['a', 'b'], gate['checks'])
        self.assertEqual(14400, gate['timeout_seconds'])
        self.assertEqual(str(target / '.context/deploy-runs'), gate['worker_recipe']['cleanup']['env']['DEPLOY_RUN_ROOT'])
        self.assertEqual('local-api', gate['worker_recipe']['setup']['env']['CONDUCTOR_WORKSPACE_NAME'])

    def test_local_rebind_refuses_workload_collision_and_unprepared_source_atomically(self):
        old, new, state, target, path, call = self.local_rebind_fixture()
        changed = []
        for mutate in (
                lambda p: p['gates'][1]['checks'].pop(),
                lambda p: p['gates'][1].update(timeout_seconds=14401),
                lambda p: p['gates'][1]['worker_recipe']['cases']['a']['command'].append('--waive'),
                lambda p: p['gates'][1]['worker_recipe']['cleanup'].update(command=['false']),
                lambda p: p['gates'][1]['env'].update(DEPLOY_CYCLE_FRESH='0'),
                lambda p: p['gates'][1]['env'].update(CONDUCTOR_PORT='24000'),
                lambda p: p['gates'].pop(),
                lambda p: p.update(source={'head': 'wrong', 'digest': 'wrong'})):
            candidate = copy.deepcopy(new); mutate(candidate); changed.append(candidate)
        original = (self.directory / 'cycle.json').read_bytes()
        for candidate in changed:
            with self.subTest(candidate=candidate['gates'][1]):
                c.write(path, candidate); self.assertEqual(2, call())
                self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())
        c.write(path, new); (target / 'code').write_text('not frozen')
        self.assertEqual(2, call())
        self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())
        (target / 'code').write_text('original')
        with (target / '.git/info/exclude').open('a') as stream:
            stream.write('\n.env\n')
        (target / '.env').write_text('different ignored runtime configuration')
        self.assertEqual(c.source(self.root), c.source(target))
        self.assertEqual(2, call())
        self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())

    def test_local_rebind_refuses_pending_running_owner_and_concurrent_coordinator(self):
        old, new, state, target, path, call = self.local_rebind_fixture()
        state_path = self.directory / 'cycle.json'
        for update in ({'pending': ['unresolved']}, {'live_failures': []}, {'resume_phase': 'initial'}, {'running': True},
                       {'phase': 'initial'}, {'attempts': [{'phase': 'initial', 'results': [
                           dict(gate='api', lingering_group=True, cleanup_owner={'request_token': 'old'})]}]}):
            candidate = {**copy.deepcopy(state), **update}; c.write(state_path, candidate)
            original = state_path.read_bytes(); self.assertEqual(2, call())
            self.assertEqual(original, state_path.read_bytes())
        c.write(state_path, state); original = state_path.read_bytes()
        with c.exclusive(self.directory):
            self.assertEqual(2, call())
        self.assertEqual(original, state_path.read_bytes())

    def test_native_local_root_refuses_duplicates_and_preserves_original_deadlines(self):
        import time
        gate = {'command': ['fixture'], 'worker_transport': 'local-isolated', 'case_protocol': True}
        active = peak = calls = 0
        guard = threading.Lock()
        admissions = [{}, {}]
        def launch(_argv, **kwargs):
            nonlocal active, peak, calls
            with guard:
                active += 1; peak = max(peak, active); calls += 1
            self.assertGreater(kwargs['timeout'], 0); self.assertLessEqual(kwargs['timeout'], 1)
            time.sleep(.08)
            with guard:
                active -= 1
            return 0, False, False, False
        with patch.object(c, 'run_command', side_effect=launch), ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(c.run_with_local_slot, gate, self.root, a, timeout=1) for a in admissions]
            self.assertCountEqual([(0, False, False, False), (None, False, False, False)], [f.result() for f in futures])
        self.assertEqual((1, 1), (peak, calls))
        self.assertEqual(1, sum(a['started'] for a in admissions))
        lock = self.root / '.context/native-worker-admission.lock'
        with lock.open('a') as held:
            c.fcntl.flock(held, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
            with patch.object(c, 'run_command') as launch:
                admission = {}; start = time.monotonic()
                self.assertEqual((None, False, False, False),
                                 c.run_with_local_slot(gate, self.root, admission, timeout=.08))
                self.assertLess(time.monotonic() - start, .3)
                self.assertFalse(admission['started']); launch.assert_not_called()
                c.CANCEL.set(); admission = {}
                self.assertEqual((None, False, True, False),
                                 c.run_with_local_slot(gate, self.root, admission, timeout=1))
                self.assertFalse(admission['started']); launch.assert_not_called()
                c.CANCEL.clear()
                card = dict(name='card', checks=['card'], command=['must-not-launch'], case_protocol=True,
                            category='generic', worker_transport='local-isolated', timeout_seconds=.05)
                result = c.execute(card, self.state, self.directory, self.root)
                self.assertEqual({'card': 'UNVERIFIED'}, result['cases'])
                self.assertFalse(result['executed']); self.assertFalse(result['complete'])
                self.assertFalse(result['timed_out']); self.assertIsNone(result['native_exit'])
                self.assertFalse(result['lingering_group']); self.assertNotIn('cleanup_owner', result)
                launch.assert_not_called()

    def test_refused_local_admission_keeps_its_reason_when_receipt_preparation_exhausts_deadline(self):
        clock = [1000.0]
        lock = self.root / '.context/native-worker-admission.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        def prepare(_state):
            clock[0] += .08
        def gate(name, timeout):
            return dict(name=name, checks=[name], command=['must-not-launch'], case_protocol=True,
                        category='generic', worker_transport='local-isolated', timeout_seconds=timeout)
        with patch.object(c.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(c, 'revalidate_standing_skips', side_effect=prepare), \
                patch.object(c, 'run_command') as launch, lock.open('a') as held:
            c.fcntl.flock(held, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
            refused = c.execute(gate('refused', .05), self.state, self.directory, self.root)
            c.fcntl.flock(held, c.fcntl.LOCK_UN)
            admitted = c.execute(gate('admitted', .04), self.state, self.directory, self.root)
            for name, result, timed_out in [('refused', refused, False), ('admitted', admitted, True)]:
                with self.subTest(admission=name):
                    self.assertEqual({name: 'UNVERIFIED'}, result['cases'])
                    self.assertFalse(result['executed']); self.assertFalse(result['complete'])
                    self.assertEqual(timed_out, result['timed_out']); self.assertIsNone(result['native_exit'])
                    self.assertFalse(result['lingering_group']); self.assertNotIn('cleanup_owner', result)
            self.assertEqual('isolation root already owns an active worker; refuse duplicate launch', refused['reason'])
            self.assertEqual('existing deadline exhausted before local worker launch', admitted['reason'])
            launch.assert_not_called()

    def test_local_slot_fences_queued_locals_after_unverified_cleanup_without_cancelling_cloud(self):
        # The only local native producer was the retired AgentCard lane (its tasks run in cloud smoke now);
        # an ordinary owned local gate that reports unverified cleanup still fences the queued local root.
        import time
        started = self.root / '.context/first-native-started'
        forbidden = self.root / '.context/queued-native-started'
        script = ("import json,os,time;from pathlib import Path;"
                  "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                  f"Path({str(started)!r}).touch();time.sleep(.15);"
                  "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=False,reused=False);"
                  "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        first = dict(name='card', category='generic', worker_transport='local-isolated',
                     case_protocol=True, checks=['card'], timeout_seconds=2, command=[sys.executable, '-c', script])
        second = dict(name='queued', category='generic', worker_transport='local-isolated',
                      case_protocol=True, checks=['queued'], timeout_seconds=2,
                      command=[sys.executable, '-c', f'from pathlib import Path;Path({str(forbidden)!r}).touch()'])
        self.state['phase'] = 'initial'; failed = threading.Event()
        with ThreadPoolExecutor(2) as pool:
            one = pool.submit(c.execute, first, self.state, self.directory, self.root, local_failure=failed)
            end = time.monotonic() + 1
            while not started.exists() and time.monotonic() < end:
                time.sleep(.005)
            self.assertTrue(started.exists())
            two = pool.submit(c.execute, second, self.state, self.directory, self.root, local_failure=failed)
            a, b = one.result(), two.result()
        self.assertEqual(0, a['native_exit']); self.assertFalse(a['complete'])
        self.assertEqual('owned', a['lifecycle']); self.assertTrue(failed.is_set())
        self.assertEqual({'queued': 'UNVERIFIED'}, b['cases'])
        self.assertFalse(b['executed']); self.assertFalse(b['complete']); self.assertFalse(forbidden.exists())
        cloud_script = ("import json,os;from pathlib import Path;"
                        "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                        "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=True,reused=False);"
                        "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        cloud = dict(name='cloud', native_cloud=True, case_protocol=True, checks=['cloud'], timeout_seconds=2,
                     worker_transport='benchmark-cloud-cli', command=[sys.executable, '-c', cloud_script])
        result = c.execute(cloud, self.state, self.directory, self.root, local_failure=failed)
        self.assertEqual('PASS', result['status']); self.assertTrue(result['executed'])
        self.assertFalse(result['cancelled']); self.assertFalse(c.CANCEL.is_set())
        # Preparation/receipt bookkeeping consumes the same deadline too, without a late child launch.
        delayed = dict(second, name='delayed', checks=['delayed'], timeout_seconds=.04)
        with patch.object(c, 'revalidate_standing_skips', side_effect=lambda _: time.sleep(.08)), \
                patch.object(c, 'run_command') as launch:
            late = c.execute(delayed, self.state, self.directory, self.root)
        self.assertFalse(late['executed']); self.assertTrue(late['timed_out']); launch.assert_not_called()

    def test_lingering_native_supervisor_blocks_queued_local(self):
        import time
        started = self.root / '.context/owned-native-started'
        forbidden = self.root / '.context/owned-queued-started'
        script = ("import json,os,subprocess,sys,time;from pathlib import Path;"
                  "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                  f"Path({str(started)!r}).touch();time.sleep(.1);"
                  "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True);"
                  "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=True,reused=False);"
                  "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        first = dict(name='owned', category='generic', worker_transport='local-isolated',
                     case_protocol=True, checks=['owned'], timeout_seconds=2, command=[sys.executable, '-c', script])
        second = dict(first, name='queued', checks=['queued'],
                      command=[sys.executable, '-c', f'from pathlib import Path;Path({str(forbidden)!r}).touch()'])
        self.state['phase'] = 'initial'; failed = threading.Event()
        with ThreadPoolExecutor(2) as pool:
            one = pool.submit(c.execute, first, self.state, self.directory, self.root, local_failure=failed)
            end = time.monotonic() + 1
            while not started.exists() and time.monotonic() < end:
                time.sleep(.005)
            self.assertTrue(started.exists())
            two = pool.submit(c.execute, second, self.state, self.directory, self.root, local_failure=failed)
            a, b = one.result(), two.result()
        self.assertEqual(0, a['native_exit']); self.assertTrue(a['lingering_group'])
        process = c.read(Path(a['log'] + '.process.json'))
        self.assertTrue(process['orphaned_children']); self.assertTrue(process['quiescent'])
        self.assertEqual([], process['remaining'])
        self.assertTrue(failed.is_set()); self.assertFalse(b['executed']); self.assertFalse(forbidden.exists())

    def test_native_distinct_roots_overlap_with_exact_root_admission(self):
        import time
        roots = [Path(self.workers.name) / name for name in ('api', 'ui')]
        def observe(root):
            target = root / 'native-overlap.json'
            script = ("import json,time;from pathlib import Path;start=time.monotonic();"
                      f"Path({str(target) + '.started'!r}).touch();time.sleep(.35);"
                      f"Path({str(target)!r}).write_text(json.dumps([start,time.monotonic()]))")
            gate = dict(command=[sys.executable, '-c', script], cwd=str(root), worker_root=str(root),
                        worker_transport='local-isolated', case_protocol=True)
            admission = {}
            with (root / 'output.log').open('wb') as output:
                result = c.run_with_local_slot(gate, self.root, admission, timeout=2,
                    cwd=root, env=dict(os.environ), output=output, owned_lifecycle=True)
            self.assertEqual((0, False, False, False), result)
            return json.loads(target.read_text()), admission
        with ThreadPoolExecutor(2) as pool:
            rows = list(pool.map(observe, roots))
        self.assertGreater(min(row[0][1] for row in rows), max(row[0][0] for row in rows))
        self.assertNotEqual(rows[0][1]['lock'], rows[1][1]['lock'])
        for root, (_, admission) in zip(roots, rows):
            self.assertEqual(str(root / '.context/native-worker-admission.lock'), admission['lock'])

    def independent_triage_fixture(self, failing=False):
        import contextlib, io
        plan = copy.deepcopy(self.plan)
        for name, port in [('missing', 37000), ('leased', 47000)]:
            root = Path(self.workers.name) / name; root.mkdir()
            plan['gates'].append(dict(name=name, worker=name, worker_transport='local-isolated',
                cwd=str(root), env={'CONDUCTOR_WORKSPACE_NAME': name, 'CONDUCTOR_PORT': str(port)},
                command=[sys.executable, '-c', 'import sys;sys.exit(' + ('1' if failing and name == 'missing' else '0') + ')'],
                checks=[name], timeout_seconds=2))
        state = c.initialize(plan, self.root); state['phase'] = 'initial'
        api = dict(plan['gates'][1], command=[sys.executable, '-c', 'raise SystemExit(1)'])
        # Original failure and successful full gate both come through actual native execution.
        results = [c.execute(api, state, self.directory, self.root),
                   c.execute(plan['gates'][2], state, self.directory, self.root)]
        c.advance(state, results)
        state['reconciled_owners'] = {'historical': {'debt': 'immutable financial/runtime obligation'}}
        path = self.directory / 'cycle.json'; plan_path = self.directory / 'plan.json'
        c.write(path, state); c.write(plan_path, plan)
        lease = Path(self.workers.name) / 'leased'
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(['triage-independent', '--plan', str(plan_path), '--state-dir', str(self.directory),
                               '--root', str(self.root), '--exclude-root', str(lease)])
        return state, plan, path, plan_path, call

    def test_independent_triage_cli_keeps_pending_passes_and_leased_root(self):
        before, plan, path, _, call = self.independent_triage_fixture()
        self.assertEqual(0, call())
        after = c.read(path)
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        for key in ('pending', 'failures', 'reconciled_owners', 'failure_phase', 'source', 'plan_digest'):
            self.assertEqual(before[key], after[key])
        self.assertEqual(before['attempts'], after['attempts'][:-1])
        self.assertEqual(['missing'], [r['gate'] for r in after['attempts'][-1]['results']])
        self.assertTrue(after['attempts'][-1]['independent_full'])
        self.assertTrue(c.reusable_full_pass(after, next(g for g in plan['gates'] if g['name'] == 'missing')))
        focused = copy.deepcopy(after)
        focused.update(phase='focused', repair_gates=['api', 'ui', 'missing'], focused={
            g['name']: {'command': g['command'], 'checks': g['checks']} for g in plan['gates'] if not g.get('quick')})
        self.assertEqual(['api'], [g['name'] for g in c.records(plan, focused)])
        self.assertEqual(0, call())
        self.assertEqual(after['attempts'], c.read(path)['attempts'])
        self.assertFalse(any((self.directory / 'attempts').glob('*/triage/leased/request.json')))
        original = path.read_bytes()
        with c.exclusive(self.directory): self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes())

    def test_independent_triage_failure_appends_and_unsafe_inputs_refuse(self):
        before, plan, path, plan_path, call = self.independent_triage_fixture(failing=True)
        original = path.read_bytes()
        for update in ({'running': True}, {'live_failures': []}, {'resume_phase': 'triage'}):
            c.write(path, {**before, **update}); saved = path.read_bytes()
            self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())
        path.write_bytes(original)
        changed = copy.deepcopy(plan); changed['gates'][-2]['checks'].append('dropped-contract')
        c.write(plan_path, changed); self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
        c.write(plan_path, plan)
        (self.root / 'code').write_text('changed'); self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes()); (self.root / 'code').write_text('original')
        self.assertEqual(0, call()); after = c.read(path)
        self.assertEqual(before['pending'], after['pending'][:len(before['pending'])])
        self.assertEqual(before['failures'], after['failures'][:len(before['failures'])])
        self.assertEqual(1, len(after['pending']) - len(before['pending']))
        self.assertEqual('missing/missing', after['failures'][-1]['check'])
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])
        import contextlib, io
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['verify', '--plan', str(plan_path), '--state-dir', str(self.directory),
                                       '--root', str(self.root)]))

    def test_pending_triage_refresh_keeps_old_debt_and_allows_new_source_independent_work(self):
        before, old, path, plan_path, call = self.independent_triage_fixture()
        state = copy.deepcopy(before)
        (self.root / 'code').write_text('actual new scheduler source')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(state, old, new, self.root)
        self.assertEqual(before['pending'], state['pending'])
        self.assertEqual(before['failures'], state['failures'])
        self.assertEqual(before['reconciled_owners'], state['reconciled_owners'])
        self.assertEqual(before['attempts'], state['attempts'])
        self.assertEqual(before['source'], state['failures'][0]['source'])
        self.assertEqual(new['source'], state['source'])
        self.assertEqual('refresh', state['failure_phase']); self.assertFalse(state['ready'])
        c.run_phase(new, state, self.directory, self.root)  # only existing quick recipes
        self.assertEqual('triage', state['phase'])
        c.write(path, state); c.write(plan_path, new)
        self.assertEqual(0, call()); after = c.read(path)
        self.assertEqual({'ui', 'missing'}, {r['gate'] for r in after['attempts'][-1]['results']})
        self.assertEqual(before['pending'], after['pending'])
        self.assertEqual(before['failures'], after['failures'])
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual(1, c.verify_saved(self.directory, self.root))

    def repair_independent_fixture(self, failing=False):
        import contextlib, io
        state, plan, path, plan_path, _ = self.independent_triage_fixture(failing=failing)
        state.update(phase='needs-focused-plan', repair_gates=['api'])
        state.pop('pending')
        c.write(path, state)
        lease = Path(self.workers.name) / 'leased'
        def call(*extra):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    return c.main(['repair-independent', '--plan', str(plan_path), '--state-dir', str(self.directory),
                                   '--root', str(self.root), '--exclude-root', str(lease), *extra])
                except SystemExit as error:
                    return error.code
        return state, plan, path, plan_path, call

    def test_repair_independent_observes_full_siblings_without_disposing_of_repairs(self):
        before, plan, path, _, call = self.repair_independent_fixture()
        self.assertEqual(0, call())
        after = c.read(path)
        for key in ('failures', 'reconciled_owners', 'source', 'plan_digest', 'repair_gates'):
            self.assertEqual(before[key], after[key])
        self.assertEqual(('needs-focused-plan', False), (after['phase'], after['ready']))
        self.assertNotIn('pending', after)
        self.assertEqual(before['attempts'], after['attempts'][:-1])
        self.assertEqual(['missing'], [r['gate'] for r in after['attempts'][-1]['results']])
        self.assertEqual('needs-focused-plan', after['attempts'][-1]['origin_phase'])
        self.assertTrue(after['attempts'][-1]['independent_full'])
        self.assertTrue(c.reusable_full_pass(after, next(g for g in plan['gates'] if g['name'] == 'missing')))
        self.assertEqual(0, call())
        self.assertEqual(after['attempts'], c.read(path)['attempts'])

    def test_repair_independent_failure_enters_real_triage_and_keeps_original_debt(self):
        before, _, path, _, call = self.repair_independent_fixture(failing=True)
        self.assertEqual(0, call())
        after = c.read(path)
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual('needs-focused-plan', after['failure_phase'])
        self.assertEqual(before['failures'], after['failures'][:len(before['failures'])])
        self.assertEqual(1, len(after['pending']))
        self.assertEqual('missing/missing', after['failures'][-1]['check'])
        self.assertEqual(before['repair_gates'], after['repair_gates'])
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])

    def test_explicit_local_repair_observation_keeps_full_contract_and_required_repair_set(self):
        before, plan, path, _, call = self.repair_independent_fixture()
        self.assertEqual(0, call('--include-repair-local')); after = c.read(path)
        self.assertEqual({'api', 'missing'}, {row['gate'] for row in after['attempts'][-1]['results']})
        self.assertEqual(before['plan'], after['plan'])
        self.assertEqual(before['repair_gates'], after['repair_gates'])
        self.assertEqual(before['failures'], after['failures'])
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])
        self.assertEqual(('needs-focused-plan', False), (after['phase'], after['ready']))
        self.assertTrue(after['attempts'][-1]['include_repair_local'])
        api = next(g for g in plan['gates'] if g['name'] == 'api')
        self.assertTrue(c.reusable_full_pass(after, api))
        self.assertEqual(set(api['checks']), set(next(row for row in after['attempts'][-1]['results']
                                                    if row['gate'] == 'api')['cases']))

    def test_repair_independent_never_dispatches_an_unrepaired_cloud_gate(self):
        before, plan, path, plan_path, call = self.repair_independent_fixture()
        cloud = dict(name='cloud', category='smoke', worker='native-cloud-worker',
                     native_cloud=True, case_protocol=True, worker_transport='benchmark-cloud-cli',
                     cwd=str(self.root), command=[sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')],
                     checks=['still-required-cloud-check'], timeout_seconds=2)
        plan['gates'].append(cloud)
        before.update(plan=plan, plan_digest=c.digest(plan), input_fingerprints=c.input_fingerprints(plan, self.root))
        c.write(plan_path, plan); c.write(path, before)
        self.assertEqual(0, call('--include-repair-local')); after = c.read(path)
        self.assertEqual({'api', 'missing'}, {row['gate'] for row in after['attempts'][-1]['results']})
        self.assertIn(cloud, after['plan']['gates'])
        self.assertFalse(after['ready'])
        self.assertFalse(after['attempts'][-1]['cloud_execution_allowed'])
        self.assertFalse(any(self.directory.glob('attempts/*/*/cloud/request.json')))

    def test_repair_independent_refuses_legacy_cloud_transport_after_normal_repair_transition(self):
        _, plan, path, plan_path, call = self.repair_independent_fixture()
        launcher = Path(self.workers.name) / 'run-predeploy-cloud'
        marker = Path(self.workers.name) / 'legacy-cloud-launched'
        launcher.write_text('touch "' + str(marker) + '"\n')
        plan['gates'].append(dict(name='legacy-cloud', category='smoke', worker='legacy-cloud',
                                 worker_transport='benchmark-cloud-cli', command=['bash', str(launcher)],
                                 checks=['would-allocate-cloud'], timeout_seconds=2))
        plan['gates'][1]['command'] = [sys.executable, '-c', 'raise SystemExit(1)']
        state = c.initialize(plan, self.root)
        c.run_phase(plan, state, self.directory, self.root)
        c.run_phase(plan, state, self.directory, self.root)
        c.adjudicate(state, {'failures': [self.report(f)['failures'][0] for f in state['failures']]})
        old = copy.deepcopy(plan); (self.root / 'code').write_text('actual local source repair')
        plan = copy.deepcopy(plan); plan['source'] = c.source(self.root)
        c.refresh(state, old, plan, self.root)
        c.run_phase(plan, state, self.directory, self.root)
        self.assertEqual('needs-focused-plan', state['phase']); marker.unlink()
        c.write(plan_path, plan); c.write(path, state)
        self.assertEqual(0, call('--include-repair-local'))
        after = c.read(path)
        self.assertFalse(marker.exists())
        self.assertNotIn('legacy-cloud', [row['gate'] for row in after['attempts'][-1]['results']])
        self.assertIn('legacy-cloud', [gate['name'] for gate in after['plan']['gates']])
        self.assertFalse(after['attempts'][-1]['cloud_execution_allowed'])
        self.assertFalse(after['ready'])

    def test_repair_independent_refuses_unresolved_running_or_stale_boundaries_atomically(self):
        before, _, path, _, call = self.repair_independent_fixture()
        for changes in ({'pending': ['unresolved']}, {'running': True}, {'live_failures': []},
                        {'resume_phase': 'focused'}, {'phase': 'focused'}, {'phase': 'ready'}, {'ready': True}):
            with self.subTest(changes=changes):
                c.write(path, {**before, **changes}); saved = path.read_bytes()
                self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())
        c.write(path, before); saved = path.read_bytes()
        (self.root / 'code').write_text('changed source')
        self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())

    def test_waived_independent_observation_returns_to_required_focused_repairs(self):
        failure = self.failure()
        self.state.update(failure_phase='needs-focused-plan', repair_gates=['ui'])
        c.adjudicate(self.state, self.report(failure, 'NOT_INTRODUCED',
                                           external_provider={'name': 'fixture provider', 'reason': 'outage'}))
        self.assertEqual(('needs-focused-plan', False), (self.state['phase'], self.state['ready']))
        self.assertEqual(['ui'], self.state['repair_gates'])

    def test_old_source_disposition_requires_current_renewal_without_exempting_new_inputs(self):
        failure = self.failure()
        old_native = copy.deepcopy(failure)
        old = copy.deepcopy(self.plan)
        (self.root / 'code').write_text('new source with unresolved old failure')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.state['phase'] = 'triage'  # source-bound quick observation is unrelated to this guard
        report = self.report(failure, 'NOT_INTRODUCED', external_provider={'name': 'provider', 'reason': 'outage'})
        c.adjudicate(self.state, report)
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        self.assertEqual(old_native, {k: failure[k] for k in old_native})
        renewal = next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        self.assertEqual(new['source'], renewal['source'])
        self.assertEqual(old_native['source'], renewal['prior_waiver']['source'])
        self.assertEqual('prior waived failure; changed inputs', renewal['native_result'])
        explicit = self.report(renewal, 'NOT_INTRODUCED', external_provider={'name': 'provider', 'reason': 'outage'})
        c.adjudicate(self.state, explicit)
        self.assertEqual(new['source'], self.state['skips']['api/a']['source'])
        self.assertEqual(explicit['failures'][0], self.state['skips']['api/a']['rca'])
        self.assertFalse(self.state['ready'])  # final new-source coverage remains mandatory

    def test_stale_post_merge_packet_routes_current_execution_without_impossible_renewal(self):
        failure = self.failure(); native = copy.deepcopy(failure)
        old = copy.deepcopy(self.plan)
        (self.root / 'code').write_text('new inputs')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root); self.state['phase'] = 'triage'
        packet = {'test': 'api/a', 'command': failure['command'], 'scope': 'original failure',
                  'error': 'exact original FAIL', 'source': failure['source'], 'evidence': failure['evidence']}
        c.adjudicate(self.state, self.report(failure, 'NOT_INTRODUCED', post_merge=packet))
        self.assertEqual({}, self.state['skips']); self.assertFalse(self.state.get('pending'))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        self.assertIn('api', self.state['repair_gates'])
        self.assertEqual(native, {k: failure[k] for k in native})
        self.assertEqual(packet, failure['rca']['post_merge'])
        self.assertEqual(packet, self.state['superseded_skips'][-1]['rca']['post_merge'])
        self.assertFalse(self.state.get('pending_post_merge'))

    def result(self, gate='api', **cases):
        return {'gate': gate, 'status': 'FAIL' if 'FAIL' in cases.values() else 'PASS',
                'cases': cases, 'complete': True, 'source': self.state['source'],
                'command': ['true'], 'log': 'original.log', 'native_exit': 1}

    def test_refresh_unstarted_quick_preserves_history_and_refuses_active_state(self):
        old = copy.deepcopy(self.plan)
        original = copy.deepcopy(self.state)
        (self.root / 'code').write_text('new repair before quick launch')
        new = copy.deepcopy(old)
        new['source'] = c.source(self.root)
        for update in ({'live_failures': []}, {'running': True}, {'resume_phase': 'quick'}, {'pending': ['unresolved']}):
            state = {**copy.deepcopy(original), **update}
            before = copy.deepcopy(state)
            with self.assertRaisesRegex(ValueError, 'repair boundary|adjudicate pending'):
                c.refresh(state, old, new, self.root)
            self.assertEqual(before, state)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(new['source'], self.state['source'])
        self.assertEqual('quick', self.state['phase'])
        self.assertFalse(self.state['ready'])
        for key in ('attempts', 'failures', 'round'):
            self.assertEqual(original[key], self.state[key])

    def failure(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='PASS'), self.result('ui', c='PASS')])
        return self.state['failures'][-1]

    def report(self, failure, attribution='INTRODUCED', **fields):
        return {'failures': [{'id': failure['id'], 'check': failure['check'],
                'source': failure['source'], 'description': 'real failure', 'evidence': 'RCA evidence',
                'native_result': failure['native_result'], 'command': failure.get('command'), 'attribution': attribution, **fields}]}

    def test_partial_rca_preserves_unhandled_blockers_until_final_adjudication(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='PASS'), self.result('ui', c='FAIL')])
        first, remaining = self.state['failures'][-2:]
        untouched = copy.deepcopy(remaining)
        native_first = copy.deepcopy(first)
        attempts = copy.deepcopy(self.state['attempts'])
        report = {**self.report(first), 'partial': True}
        c.adjudicate(self.state, report)
        self.assertEqual([remaining['id']], self.state['pending'])
        self.assertEqual(untouched, remaining)
        self.assertEqual(native_first, {k: first[k] for k in native_first})
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        self.assertEqual({}, self.state['skips'])
        self.assertIn('api', self.state['triage_repair_gates'])
        self.assertEqual(self.plan, self.state['plan'])
        c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        observed = []
        def full(gate, *_args, **_kwargs):
            observed.append(gate['name'])
            return {**self.result(gate['name'], **dict.fromkeys(gate['checks'], 'PASS')),
                    'native_exit': 0}
        with patch.object(c, 'execute', side_effect=full):
            c.run_phase(self.plan, self.state, self.directory, self.root, independent=True)
        self.assertEqual(['api'], observed)
        self.assertEqual([remaining['id']], self.state['pending'])
        self.assertEqual(untouched, remaining)
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        c.adjudicate(self.state, self.report(remaining))
        self.assertFalse(self.state.get('pending'))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertTrue({'api', 'ui'} <= set(self.state['repair_gates']))
        self.assertFalse(self.state['ready'])

    def test_partial_rca_is_explicit_nonempty_source_bound_and_atomic(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='FAIL'), self.result('ui', c='FAIL')])
        first, second, _ = self.state['failures'][-3:]
        entry = self.report(first)['failures'][0]
        bad_source = {**entry, 'source': {'head': 'wrong', 'digest': 'wrong'}}
        other = self.report(second)['failures'][0]
        variants = [
            {'failures': [entry]},
            {'failures': [entry], 'partial': False},
            {'failures': [entry], 'partial': 'true'},
            {'failures': [], 'partial': True},
            {'failures': [entry, entry], 'partial': True},
            {'failures': [{**entry, 'id': 'foreign'}], 'partial': True},
            {'failures': [bad_source], 'partial': True},
            {'failures': [{**entry, 'attribution': 'UNKNOWN'}], 'partial': True},
            {'failures': [entry, {**other, 'source': bad_source['source']}], 'partial': True},
        ]
        original = copy.deepcopy(self.state)
        for report in variants:
            with self.subTest(report=report):
                self.state = copy.deepcopy(original)
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, report)
                self.assertEqual(original, self.state)

    MAC_STATIC = ['bash', '-c', 'npm run format:check && npm run lint && npm run type-check']

    def triage_quick_fixture(self, mac=None):
        import contextlib, io
        (self.root / 'back-end').mkdir()
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/check_deploy_static.py').write_text(
            "from pathlib import Path\nimport sys\np=Path('.context/observed');p.parent.mkdir(exist_ok=True)\n"
            "with p.open('a') as f:f.write(sys.argv[1]+'\\n')\n")
        bins = self.root / '.context/bin'; bins.mkdir(parents=True)
        for name in ('npm', 'npx'):
            p = bins / name
            p.write_text('#!' + sys.executable + '\nfrom pathlib import Path\nimport sys\n'
                "p=Path('../.context/observed')\nwith p.open('a') as f:f.write(Path(sys.argv[0]).name+'\\n')\n"
                "raise SystemExit(1 if Path('../.context/fail').exists() and Path(sys.argv[0]).name=='npm' else 0)\n")
            p.chmod(0o700)
        self.plan['gates'] = [g for g in self.plan['gates'] if not g.get('quick')] + [
            dict(name=n, category=n, quick=True, checks=[n], cwd='.',
                 command=[sys.executable, 'scripts/check_deploy_static.py', m])
            for n, m in [('eslint', 'lint'), ('format', 'format')]] + [
            dict(name='typescript', category='typescript', quick=True, checks=['typescript'], cwd='back-end',
                 command=['bash', '-c', 'mkdir -p ../.context/tsbuildinfo && npx tsc --noEmit --incremental '
                          '--tsBuildInfoFile ../.context/tsbuildinfo/back-end.tsbuildinfo']),
            dict(name='backend-structural', category='backend-structural', quick=True,
                 checks=['backend-structural'], cwd='back-end', command=['npm', 'run', 'test:structural'])]
        if mac is not None:  # the darwin plan's conditional fifth quick gate (deploy_test_plan.MAC_APP_STATIC)
            gate = {'name': 'mac-app-static', 'category': 'mac-app-static', 'quick': True,
                    'checks': ['mac-app-static'], 'cwd': 'mac-app', 'command': self.MAC_STATIC, **mac}
            (self.root / gate['cwd']).mkdir(exist_ok=True)
            self.plan['gates'].append(gate)
        self.plan['source'] = c.source(self.root)
        self.state = c.initialize(self.plan, self.root); self.failure()
        receipt = self.state['attempts'][-1]['results'][0]
        receipt.update(complete=False, cleanup_owner=dict(request_token='old', worker_root='old-root',
            native_cleanup_reference=dict(cleanup_complete=False)))
        self.state['failures'][-1].update(native_result='UNVERIFIED', complete=False)
        self.state['resource_warnings'] = [dict(original='preserve financial/runtime obligations')]
        (self.root / 'code').write_text('new source requiring quick observation')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        plan = self.root / '.context/new-plan.json'; c.write(plan, new)
        state = self.directory / 'cycle.json'; c.write(state, self.state)
        argv = ['triage-quick', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(argv)
        return new, plan, state, bins, call

    def test_triage_quick_cli_preserves_pending_source_and_native_owner(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture()
            before = c.read(path)
            self.assertEqual(0, call())
            after = c.read(path); observations = after['attempts'].pop()
            self.assertEqual(before, after)
            self.assertEqual(new['source'], observations['source'])
            self.assertEqual({'eslint','format','typescript','backend-structural'},
                             {r['gate'] for r in observations['results']})
            self.assertTrue(all(r['executed'] and r['complete'] and r['native_exit'] == 0 for r in observations['results']))
            self.assertEqual(['api'], c.retained_owners(after, ['api']))
            self.assertEqual('triage', after['phase']); self.assertFalse(after['ready'])
            self.assertEqual(4, len((self.root / '.context/observed').read_text().splitlines()))

    def test_triage_quick_rejects_substitution_inventory_and_active_owner(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(); original = path.read_bytes()
            variants = []
            for mode in ('command', 'category', 'drop'):
                value = copy.deepcopy(new)
                gate = next(g for g in value['gates'] if g['name'] == 'eslint')
                if mode == 'command': gate['command'] = ['bash', '-c', 'echo unsafe']
                elif mode == 'category': gate['category'] = 'smoke'
                else: value['gates'] = [g for g in value['gates'] if g['name'] != 'api']
                variants.append(value)
            for value in variants:
                c.write(plan, value); self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
            c.write(plan, new)
            with c.exclusive(self.directory): self.assertEqual(2, call())
            self.assertEqual(original, path.read_bytes())
            orphan = self.directory / 'triage-quick/orphan'; orphan.mkdir(parents=True)
            self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes()); orphan.rmdir()
            value = c.read(path); value['attempts'][-1]['results'].append(dict(gate='eslint', lingering_group=True))
            c.write(path, value); owned = path.read_bytes()
            self.assertEqual(2, call()); self.assertEqual(owned, path.read_bytes())
            self.assertFalse((self.root / '.context/observed').exists())

    def test_triage_quick_accepts_the_conditional_mac_app_static_fifth_gate(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(mac={})
            before = c.read(path)
            self.assertEqual(0, call())
            after = c.read(path); observations = after['attempts'].pop()
            self.assertEqual(before, after)
            self.assertEqual({'eslint','format','typescript','backend-structural','mac-app-static'},
                             {r['gate'] for r in observations['results']})
            self.assertTrue(all(r['executed'] and r['complete'] and r['native_exit'] == 0 for r in observations['results']))
            # 2 static checks + tsc + structural npm + the three mac-app npm scripts.
            self.assertEqual(7, len((self.root / '.context/observed').read_text().splitlines()))

    def test_triage_quick_refuses_a_substituted_mac_app_static_recipe(self):
        variants = [dict(command=['bash', '-c', 'npm run lint']), dict(cwd='.'), dict(env={'X': '1'}),
                    dict(checks=['mac-app-static', 'extra']), dict(command=['npm', 'run', 'test:structural'])]
        for index, variant in enumerate(variants):
            with self.subTest(variant=variant):
                if index:
                    self.tearDown(); self.setUp()
                with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
                    new, plan, path, bins, call = self.triage_quick_fixture(mac=variant)
                    original = path.read_bytes()
                    self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
                    self.assertFalse((self.root / '.context/observed').exists())

    def test_triage_quick_failure_and_changed_pending_do_not_commit(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(); original = path.read_bytes()
            (self.root / '.context/fail').touch()
            self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
            summaries = list((self.directory / 'triage-quick').glob('*/summary.json'))
            self.assertEqual(1, len(summaries)); self.assertEqual(4, len(c.read(summaries[0])['results']))
            self.assertTrue(any(r['native_exit'] == 1 for r in c.read(summaries[0])['results']))
            (self.root / '.context/fail').unlink()
            execute = c.execute
            def changed(gate, *args):
                result = execute(gate, *args)
                if gate['name'] == 'backend-structural':
                    value = c.read(path); value['pending'].append('concurrent-change'); c.write(path, value)
                return result
            with patch.object(c, 'execute', side_effect=changed): self.assertEqual(2, call())
            after = c.read(path)
            self.assertEqual(['concurrent-change'], after['pending'][len(self.state['pending']):])
            self.assertEqual(self.state['attempts'], after['attempts'])
            self.assertEqual('triage', after['phase']); self.assertFalse(after['ready'])

    def carryover_ready_fixture(self, scoped=False):
        if scoped:
            for path in ('backend.txt', 'frontend.txt'):
                (self.root / path).write_text('original')
            self.plan['gates'][1]['input_paths'] = ['backend.txt']
            self.plan['gates'][2]['input_paths'] = ['frontend.txt']
            self.plan['source'] = c.source(self.root)
            self.state = c.initialize(self.plan, self.root)
        c.run_phase(self.plan, self.state, self.directory, self.root)
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        return copy.deepcopy(self.plan), copy.deepcopy(self.state['attempts'])

    def test_history_only_sync_preserves_full_pass_native_source_and_revalidates_files(self):
        old, native = self.carryover_ready_fixture()
        native_paths = [Path(r['log']).parent / 'receipt.json' for r in native[-1]['results']]
        original = {str(p): p.read_bytes() for p in native_paths}
        for index in range(2):
            subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com',
                            'commit', '--allow-empty', '-qm', 'history-only sync'], cwd=self.root, check=True)
            new = copy.deepcopy(old); new['source'] = c.source(self.root)
            c.refresh(self.state, old, new, self.root)
            self.assertEqual({'api', 'ui'}, set(self.state['carried_passes']))
            c.run_phase(new, self.state, self.directory, self.root)
            self.assertEqual('final', self.state['phase'])
            self.assertEqual([], c.records(new, self.state))
            c.run_phase(new, self.state, self.directory, self.root)
            self.assertEqual(0, c.verify_saved(self.directory, self.root))
            old = new
        self.assertEqual(2, len(self.state['pass_carryover_history']))
        self.assertEqual(native, self.state['attempts'][:len(native)])
        self.assertEqual(original, {str(p): p.read_bytes() for p in native_paths})
        native_paths[0].write_bytes(native_paths[0].read_bytes()+b' ')
        self.assertEqual(5, c.verify_saved(self.directory, self.root))

    def repair_set_refresh_fixture(self):
        # Real request/receipt/result files: api is a healthy historical repair,
        # while a newer ui execution fails only c. Both gates have broad inputs.
        marker = self.root / '.context/fail-ui'
        worker = ("import json,os,sys;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "bad=Path(" + repr(str(marker)) + ").exists();"
            "cases={k:('FAIL' if bad and k=='c' else 'PASS') for k in r['checks']};"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=cases,complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v));"
            "sys.exit(int('FAIL' in cases.values()))")
        ui = self.plan['gates'][2]
        ui.update(command=[sys.executable, '-c', worker], checks=['c', 'd'], case_protocol=True)
        self.state = c.initialize(self.plan, self.root)
        old, _ = self.carryover_ready_fixture()
        self.state.update(phase='final', ready=False, repair_gates=['api', 'ui'])
        self.state['round'] += 1
        marker.touch()
        failed = c.execute(ui, self.state, self.directory, self.root)
        c.advance(self.state, [failed])
        self.assertEqual({'c': 'FAIL', 'd': 'PASS'}, failed['cases'])
        self.assertTrue(failed['complete'])
        return old, marker

    def changed_fixture_plan(self, old):
        for name in ('first-fixture.test.py', 'second-fixture.test.py'):
            (self.root / name).write_text('unrelated fixture repair\n')
        new = copy.deepcopy(old)
        new['source'] = c.source(self.root)
        return new

    def test_rotating_github_token_value_does_not_stale_runtime_config_but_other_changes_do(self):
        with (self.root / '.git/info/exclude').open('a') as stream:
            stream.write('.env\n')
        env = self.root / 'back-end/.env'
        env.parent.mkdir(exist_ok=True)
        env.write_text('SETTING=1\nGITHUB_TOKEN=ghu_issued_first\n')
        before = c.input_fingerprints(self.plan, self.root)
        env.write_text('SETTING=1\nGITHUB_TOKEN=ghu_refreshed_by_the_daemon\n')
        self.assertEqual(before, c.input_fingerprints(self.plan, self.root))
        for changed in ('SETTING=2\nGITHUB_TOKEN=ghu_issued_first\n', 'SETTING=1\n',
                        'SETTING=1\nGITHUB_TOKEN=ghu_issued_first\nEXTRA=1\n',
                        'SETTING=1\nXGITHUB_TOKEN=ghu_issued_first\n'):
            env.write_text(changed)
            self.assertNotEqual(before, c.input_fingerprints(self.plan, self.root), changed)

    def test_refresh_healthy_old_full_pass_leaves_focused_but_requires_new_final_full(self):
        old, marker = self.repair_set_refresh_fixture()
        attempts = copy.deepcopy(self.state['attempts'])
        failures = copy.deepcopy(self.state['failures'])
        native = {r['gate']: (Path(r['log']).parent/'receipt.json').read_bytes()
                  for r in attempts[1]['results']}
        fingerprints = dict(self.state['input_fingerprints'])
        round_before = self.state['round']
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(['ui'], self.state['repair_gates'])
        self.assertEqual({}, self.state['carried_passes'])
        self.assertNotEqual(fingerprints['api'], self.state['input_fingerprints']['api'])
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(failures, self.state['failures'])
        self.assertEqual(round_before, self.state['round'])
        self.assertEqual(old['gates'], new['gates'])
        c.run_phase(new, self.state, self.directory, self.root)  # mandatory fresh quick
        failure = next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        c.adjudicate(self.state, self.report(failure, 'INTRODUCED'))
        c.focused_plan(self.state, new, {'source': new['source'], 'gates': {
            'ui': {'command': new['gates'][2]['command'], 'checks': ['c']}}})
        self.assertEqual(['ui'], [g['name'] for g in c.records(new, self.state)])
        marker.unlink()
        c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['c', 'd'], c.records(new, self.state)[0]['checks'])
        c.run_phase(new, self.state, self.directory, self.root)  # full failed ui
        c.run_phase(new, self.state, self.directory, self.root)  # repeat quick
        self.assertEqual('final', self.state['phase'])
        self.assertEqual(['api'], [g['name'] for g in c.records(new, self.state)])
        c.write(self.directory/'cycle.json', self.state)
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        self.assertEqual(old['source'], c.latest_receipts(self.state)['api']['source'])
        c.run_phase(new, self.state, self.directory, self.root)  # genuine new api full
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        self.assertEqual(new['source'], c.latest_receipts(self.state)['api']['source'])
        self.assertEqual(attempts, self.state['attempts'][:len(attempts)])
        for receipt in attempts[1]['results']:
            self.assertEqual(native[receipt['gate']], (Path(receipt['log']).parent/'receipt.json').read_bytes())

    def test_refresh_repair_retirement_refuses_latest_failure_partial_pending_and_bad_bindings(self):
        old, _ = self.repair_set_refresh_fixture()
        original = copy.deepcopy(self.state)
        receipt = c.latest_receipts(self.state)['api']
        receipt_path = Path(receipt['log']).parent/'receipt.json'
        request_path = receipt_path.parent/'request.json'
        original_receipt, original_request = receipt_path.read_bytes(), request_path.read_bytes()
        new = self.changed_fixture_plan(old)
        for mode in ('failed', 'unverified', 'partial', 'pending', 'owner', 'stale',
                     'receipt', 'request', 'source', 'contract', 'environment'):
            with self.subTest(mode=mode):
                self.state = copy.deepcopy(original)
                receipt_path.write_bytes(original_receipt); request_path.write_bytes(original_request)
                latest = c.latest_receipts(self.state)['api']
                candidate = copy.deepcopy(new)
                if mode in ('failed', 'unverified', 'partial'):
                    replacement = copy.deepcopy(latest)
                    replacement.update(status='FAIL' if mode != 'partial' else 'PASS',
                        complete=mode != 'unverified', native_exit=1 if mode == 'failed' else 0,
                        cases={'a': 'FAIL', 'b': 'PASS'} if mode == 'failed' else
                              {'a': 'UNVERIFIED', 'b': 'PASS'} if mode == 'unverified' else {'a': 'PASS'})
                    self.state['attempts'].append({'phase': 'focused', 'results': [replacement]})
                elif mode == 'pending':
                    self.state['failures'].append(dict(id='pending-api', gate='api', check='api/a'))
                    self.state['pending'].append('pending-api')
                elif mode == 'owner':
                    latest.update(lingering_group=True, cleanup_owner={'request_token': latest['token']})
                    c.write(receipt_path, latest)
                elif mode == 'stale':
                    self.state['attempts'][1]['stale'] = True
                elif mode in ('receipt', 'request'):
                    path = receipt_path if mode == 'receipt' else request_path
                    value = c.read(path); value['token'] = 'wrong-native-token'; c.write(path, value)
                elif mode == 'source':
                    latest['source'] = {'head': 'foreign', 'digest': 'foreign'}
                    value = c.read(request_path); value['source'] = latest['source']
                    c.write(request_path, value); c.write(receipt_path, latest)
                elif mode == 'contract':
                    candidate['gates'][1]['checks'].append('new-check')
                environment = c.environment_digest()
                with patch.object(c, 'environment_digest', return_value='changed-environment' if mode == 'environment' else environment):
                    c.refresh(self.state, old, candidate, self.root)
                self.assertEqual(['api', 'ui'], self.state['repair_gates'])
                self.assertEqual({}, self.state['carried_passes'])
        receipt_path.write_bytes(original_receipt); request_path.write_bytes(original_request)

    def test_refresh_qualified_full_retirement_preserves_new_source_renewals_and_native_debt(self):
        gate, _, _ = self.qualified_full_fixture()
        old = copy.deepcopy(self.plan)
        attempts = copy.deepcopy(self.state['attempts'])
        native = copy.deepcopy(c.latest_receipts(self.state)['smoke'])
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertNotIn('smoke', self.state['repair_gates'])
        self.assertEqual({}, self.state['carried_passes'])
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(3, len(self.state['pending']))
        self.assertTrue(all(f['native_result'] == 'prior waived failure; changed inputs'
                            for f in self.state['failures'] if f['id'] in self.state['pending']))
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(native, c.latest_receipts(self.state)['smoke'])
        final = {**self.state, 'phase': 'final'}
        self.assertIn('smoke', [g['name'] for g in c.records(new, final)])

    def test_refresh_repair_retirement_refuses_bad_qualification_and_worker_result(self):
        gate, _, _ = self.qualified_full_fixture()
        old = copy.deepcopy(self.plan); original = copy.deepcopy(self.state)
        result_path = Path(c.latest_receipts(self.state)['smoke']['worker_result'])
        saved = result_path.read_bytes()
        new = self.changed_fixture_plan(old)
        for mode in ('qualification', 'worker-result', 'triage-routing'):
            with self.subTest(mode=mode):
                self.state = copy.deepcopy(original); result_path.write_bytes(saved)
                if mode == 'qualification':
                    self.state['skips']['smoke/mail-one']['rca']['external_provider']['reason'] = 'auth error'
                elif mode == 'worker-result':
                    value = c.read(result_path); value['cleanup_complete'] = False; c.write(result_path, value)
                else:
                    self.state['triage_repair_gates'] = ['smoke']
                c.refresh(self.state, old, new, self.root)
                self.assertIn('smoke', self.state['repair_gates'])
                self.assertEqual({}, self.state['carried_passes'])
        result_path.write_bytes(saved)

    def test_refresh_nonquick_retirement_does_not_invent_quick_pass_binding(self):
        old, _ = self.carryover_ready_fixture()
        self.state['repair_gates'] = ['format']
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(['format'], self.state['repair_gates'])
        self.assertEqual('quick', self.state['phase'])
        self.assertEqual({}, self.state['carried_passes'])

    def test_scoped_change_preserves_only_unaffected_full_gate_and_never_newer_failure(self):
        old, native = self.carryover_ready_fixture(scoped=True)
        (self.root / 'backend.txt').write_text('actual backend change')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual({'ui'}, set(self.state['carried_passes']))
        self.state['phase'] = 'final'
        self.assertEqual(['api'], [g['name'] for g in c.records(new, self.state)])
        # A new failure/retained owner always supersedes the old native PASS.
        self.state['attempts'].append(dict(phase='final', results=[dict(gate='ui', status='FAIL',
            complete=False, cases={'c':'UNVERIFIED'}, cleanup_owner={'request_token':'new-owner'}, lingering_group=True)]))
        self.assertEqual({'api','ui'}, {g['name'] for g in c.records(new, self.state)})
        self.assertEqual(['ui'], c.retained_owners(self.state, ['ui']))
        self.assertEqual(native, self.state['attempts'][:len(native)])

    def test_unknown_default_scope_reruns_both_gates_after_any_source_change(self):
        old, native = self.carryover_ready_fixture()
        (self.root / 'code').write_text('unknown ownership of this change')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual({}, self.state['carried_passes'])
        self.state['phase'] = 'final'
        self.assertEqual({'api','ui'}, {g['name'] for g in c.records(new, self.state)})

    def test_same_source_full_pass_skips_duplicate_final_but_focused_subset_never_does(self):
        old, native = self.carryover_ready_fixture()
        self.state.update(phase='focused', ready=False, repair_gates=['api', 'ui'], focused={
            g['name']: {'command': g['command'], 'checks': g['checks']} for g in old['gates'] if not g.get('quick')})
        self.assertEqual([], c.records(old, self.state))  # historical repair labels cannot repeat healthy FULL gates
        self.state.update(phase='final', ready=False)
        self.assertEqual([], c.records(old, self.state))
        # An exact FULL focused recipe is eligible; a genuine narrowed case set is not.
        self.state['attempts'][-1]['phase'] = 'focused'
        self.assertEqual([], c.records(old, self.state))
        api = next(r for r in self.state['attempts'][-1]['results'] if r['gate']=='api')
        saved = copy.deepcopy(api['cases']); api['cases'] = {'a':'PASS'}
        self.assertEqual(['api'], [g['name'] for g in c.records(old, self.state)])
        api['cases'] = saved
        self.state['attempts'][-1]['phase'] = 'final'
        api['execution_binding']['contract_digest'] = 'changed recipe'
        self.assertEqual(['api'], [g['name'] for g in c.records(old, self.state)])

    def test_same_source_reuse_pins_native_receipt_and_request_for_final_verification(self):
        script = ("import json,os;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        self.plan['gates'][1].update(command=[sys.executable, '-c', script], case_protocol=True)
        self.state = c.initialize(self.plan, self.root)
        old, native = self.carryover_ready_fixture()
        self.state.update(phase='final', ready=False)
        c.run_phase(old, self.state, self.directory, self.root)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        receipt = c.latest_receipts(self.state)['api']
        for path in [Path(receipt['log']).parent/'receipt.json', Path(receipt['log']).parent/'request.json',
                     Path(receipt['worker_result'])]:
            with self.subTest(path=path):
                original = path.read_bytes(); path.write_bytes(original+b' ')
                self.assertEqual(5, c.verify_saved(self.directory, self.root))
                path.write_bytes(original)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))

    def qualified_full_fixture(self, resource=False):
        worker = self.root / 'scripts/deploy_test_cloud.py'; worker.parent.mkdir()
        worker.write_text("import json,os;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "p=Path('.context/native-launches');p.write_text(p.read_text()+'run\\n' if p.exists() else 'run\\n');"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        self.plan['source'] = c.source(self.root)
        self.state = c.initialize(self.plan, self.root)
        proof, evidence = self.standing_claude_fixture()
        gate = self.plan['gates'][-1]
        gate['checks'] = ['passed-' + str(i) for i in range(14)] + ['mail-one', 'mail-two', 'claude-code-agent']
        self.state = c.initialize(self.plan, self.root)
        c.standing_skip(self.state, proof, self.root)
        for name in ('mail-one', 'mail-two'):
            self.state['skips']['smoke/' + name] = dict(source=self.state['source'],
                input_fingerprint=self.state['input_fingerprints']['smoke'], disposition='external / waived',
                rca=dict(id=name, native_result='FAIL', attribution='NOT_INTRODUCED', description='Exact historical mail operation',
                    evidence='original-mail-receipt', external_provider=dict(name='Primitive',reason='outage')))
        if resource:
            native = self.root / '.context/compute-skip.json'
            row = self.skipped_row()['native_task']; row['name'] = 'passed-0'
            c.write(native,dict(tasks=[row]))
            confirmation=self.confirmation(receipt_sha256=c.sha_file(native))
            failure=dict(id='native-compute-skip',gate='smoke',check='smoke/passed-0',
                source=self.state['source'],native_result='FAIL',complete=True,finished_at=1000.0,
                worker_evidence=dict(native_task=row,path=str(native),sha256=c.sha_file(native)))
            failure['rca']=dict(id=failure['id'],attribution='NOT_INTRODUCED',native_result='FAIL',
                description='Native compute quota skip',evidence=str(native),resource_skip=confirmation)
            self.state['failures'].append(failure)
            self.state['resource_warnings']=[dict(id=failure['id'],check=failure['check'],gate='smoke',
                native_result='FAIL',native_row=row,receipt_sha256=c.sha_file(native),confirmation=confirmation,
                source=self.state['source'],input_fingerprint=self.state['input_fingerprints']['smoke'])]
        self.state.update(phase='needs-focused-plan', repair_gates=['smoke'])
        c.focused_plan(self.state, self.plan, dict(source=self.state['source'], gates={
            'smoke':dict(command=gate['command'],checks=gate['checks'])}))
        c.run_phase(self.plan,self.state,self.directory,self.root)
        return gate, proof, evidence

    def test_qualified_full_coverage_runs_once_and_revalidates_after_repeated_sync(self):
        gate, proof, evidence = self.qualified_full_fixture()
        native = copy.deepcopy(c.latest_receipts(self.state)['smoke'])
        self.assertEqual((14,3), (list(native['cases'].values()).count('PASS'),list(native['cases'].values()).count('SKIP')))
        for phase in ('failed-gates', 'quick', 'final'):
            self.assertEqual(phase,self.state['phase'])
            c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(['run'], (self.root/'.context/native-launches').read_text().splitlines())
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        for index in range(2):
            subprocess.run(['git','-c','user.name=test','-c','user.email=test@example.com',
                'commit','--allow-empty','-qm','history-only sync'],cwd=self.root,check=True)
            new=copy.deepcopy(self.plan);new['source']=c.source(self.root)
            c.refresh(self.state,self.plan,new,self.root);self.plan=new
            for phase in ('quick','final'):
                self.assertEqual(phase,self.state['phase']);c.run_phase(new,self.state,self.directory,self.root)
            self.assertEqual(0,c.verify_saved(self.directory,self.root))
            self.assertEqual(native,c.latest_receipts(self.state)['smoke'])
        self.assertEqual(['run'], (self.root/'.context/native-launches').read_text().splitlines())
        (evidence/'run.json').write_bytes((evidence/'run.json').read_bytes()+b' ')
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

    def test_qualified_full_reuse_refuses_changed_qualification_contract_owner_or_native_bytes(self):
        gate, proof, evidence = self.qualified_full_fixture()
        self.assertTrue(c.full_pass_binding(self.state,gate))
        for mode in ('removed','changed','incomplete','owner','contract','newer-failure'):
            with self.subTest(mode=mode):
                candidate=copy.deepcopy(self.state);receipt=c.latest_receipts(candidate)['smoke']
                if mode=='removed':candidate['skips'].pop('smoke/mail-one')
                elif mode=='changed':candidate['skips']['smoke/mail-one']['rca']['description']='different obligation'
                elif mode=='incomplete':receipt['complete']=False
                elif mode=='owner':receipt['cleanup_owner']={'request_token':'retained'}
                elif mode=='contract':receipt['execution_binding']['contract_digest']='different full recipe'
                else:candidate['attempts'].append(dict(phase='final',results=[dict(gate='smoke',status='FAIL')]))
                self.assertIsNone(c.full_pass_binding(candidate,gate))
        self.state.update(phase='final',ready=False)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        receipt=c.latest_receipts(self.state)['smoke'];folder=Path(receipt['log']).parent
        for path in (folder/'receipt.json',folder/'request.json',Path(receipt['worker_result'])):
            with self.subTest(path=path):
                original=path.read_bytes();path.write_bytes(original+b' ')
                self.assertNotEqual(0,c.verify_saved(self.directory,self.root));path.write_bytes(original)

    def test_qualified_resource_reuse_replays_original_row_confirmation_and_bytes(self):
        gate, proof, evidence=self.qualified_full_fixture(resource=True)
        original=copy.deepcopy(self.state['failures'])
        self.assertTrue(c.full_pass_binding(self.state,gate))
        self.state.update(phase='final',ready=False)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        self.assertEqual(original,self.state['failures'])
        warning=self.state['resource_warnings'][0]
        self.assertEqual('SKIP',c.latest_receipts(self.state)['smoke']['cases']['passed-0'])
        native=Path(self.state['failures'][0]['worker_evidence']['path'])
        native.write_bytes(native.read_bytes()+b' ')
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

    def test_failed_gate_boundary_refresh_keeps_history_and_revalidates_new_source(self):
        import contextlib, io
        failure = self.failure()
        c.adjudicate(self.state, self.report(failure))
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
            'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        history = copy.deepcopy({k: self.state[k] for k in ('attempts', 'failures', 'repair_gates', 'round')})
        old_source = self.state['source']
        (self.root / 'code').write_text('hourly sync changed source')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        old_path, new_path = self.root / '.context/old.json', self.root / '.context/new.json'
        c.write(old_path, self.plan); c.write(new_path, new)
        state_path = self.directory / 'cycle.json'; c.write(state_path, self.state)
        saved = state_path.read_bytes()
        argv = ['refresh', '--plan', str(new_path), '--input', str(old_path),
                '--state-dir', str(self.directory), '--root', str(self.root)]
        # A live coordinator's existing exclusive lease still forbids any refresh mutation.
        with c.exclusive(self.directory), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(argv))
        self.assertEqual(saved, state_path.read_bytes())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(0, c.main(argv))
        self.state = c.read(state_path)
        self.assertEqual(('quick', False, 'needs-focused-plan'),
                         (self.state['phase'], self.state['ready'], self.state['next_after_quick']))
        self.assertEqual({}, self.state['focused'])
        self.assertEqual(new['source'], self.state['source'])
        self.assertNotEqual(old_source, self.state['source'])
        self.assertEqual(history, {k: self.state[k] for k in history})
        self.assertEqual(self.plan['gates'], self.state['plan']['gates'])
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual('needs-focused-plan', self.state['phase'])
        c.focused_plan(self.state, new, {'source': self.state['source'],
            'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        for phase in ('focused', 'failed-gates', 'quick', 'final'):
            self.assertEqual(phase, self.state['phase'])
            if phase == 'failed-gates':
                self.assertEqual(['a', 'b'], c.records(new, self.state)[0]['checks'])
            c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual(('ready', True), (self.state['phase'], self.state['ready']))
        self.assertEqual({'ui'}, {r['gate'] for r in self.state['attempts'][-1]['results']})
        self.assertEqual({'a':'PASS', 'b':'PASS'}, c.latest_receipts(self.state)['api']['cases'])
        self.assertTrue(c.full_pass_binding(self.state, new['gates'][1]))
        self.assertEqual(history['failures'], self.state['failures'])
        self.assertEqual('FAIL', self.state['failures'][0]['native_result'])
        self.assertEqual('blocking', self.state['failures'][0]['disposition'])
        for attempt in self.state['attempts'][len(history['attempts']):]:
            self.assertTrue(all(r['source'] == new['source'] for r in attempt['results']))

    def test_failed_gate_boundary_refresh_preserves_existing_refusals_atomically(self):
        self.state.update(phase='failed-gates', repair_gates=['api'])
        (self.root / 'code').write_text('hourly sync changed source')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        for invalid in ('pending', 'dropped-check', 'dropped-gate'):
            with self.subTest(invalid=invalid):
                state, plan = copy.deepcopy(self.state), copy.deepcopy(new)
                if invalid == 'pending': state['pending'] = ['unadjudicated-occurrence']
                elif invalid == 'dropped-check': plan['gates'][1]['checks'] = ['b']
                else: plan['gates'] = [g for g in plan['gates'] if g['name'] != 'api']
                original = copy.deepcopy(state)
                with self.assertRaises(ValueError): c.refresh(state, self.plan, plan, self.root)
                self.assertEqual(original, state)

    def test_recipe_worker_root_does_not_eagerly_require_cwd(self):
        script=("import json,os,hashlib;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False,"
            "worker_root=r['worker_root'],recipe_digest=hashlib.sha256(json.dumps(r['worker_recipe'],sort_keys=True,separators=(',',':')).encode()).hexdigest());"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        for index, explicit in enumerate((True,False)):
            with self.subTest(explicit=explicit):
                gate=dict(name='recipe-'+str(index),checks=['one'],command=[sys.executable,'-c',script],case_protocol=True,
                    worker_recipe={'cases':{'one':{'command':['true']}}})
                if explicit:gate['worker_root']='/private/prepared-worker'
                result=c.execute(gate,self.state,self.directory,self.root)
                request=c.read(Path(result['log']).parent/'request.json')
                self.assertEqual(gate.get('worker_root',str(self.root.resolve())),request['worker_root'])
                self.assertEqual({'one':'PASS'},result['cases']);self.assertTrue(result['complete'])

    def test_clean_run_finishes_without_second_full_sweep(self):
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertEqual('initial', self.state['phase'])
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        self.assertEqual(['quick', 'initial'], [a['phase'] for a in self.state['attempts']])

    def test_failure_parallel_rca_then_focus_full_failed_and_final(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f))
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                       'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['a', 'b'], c.records(self.plan, self.state)[0]['checks'])
        c.advance(self.state, [self.result(a='PASS', b='PASS')])
        self.assertEqual('quick', self.state['phase'])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('final', self.state['phase'])
        self.assertEqual({'api', 'ui'}, {g['name'] for g in c.records(self.plan, self.state)})
        c.advance(self.state, [self.result(a='PASS', b='PASS'), self.result('ui', c='PASS')])
        self.assertTrue(self.state['ready'])

    def test_skip_only_advances_without_rerun(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     external_provider={'name': 'provider', 'reason': 'outage'}))
        self.assertTrue(self.state['ready'])
        self.assertIn('api/a', self.state['skips'])
        self.assertEqual(1, len(self.state['attempts']))
        self.assertEqual('FAIL', self.state['attempts'][0]['results'][0]['cases']['a'])

    def test_delegation_is_skip_without_waiting_for_ack(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     repair_agent='https://boxes.dev/thread/repair'))
        self.assertTrue(self.state['ready'])

    def treasury_failure(self, peer='PASS'):
        self.plan['gates'][1].update(name='backend-coverage-blackbox', checks=['blackbox:treasury-rails','blackbox:independent'],case_protocol=True)
        self.state=c.initialize(self.plan,self.root)
        self.state['phase']='initial'
        c.advance(self.state,[self.result('backend-coverage-blackbox',**{'blackbox:treasury-rails':'FAIL','blackbox:independent':peer})])
        failure=next(f for f in self.state['failures'] if f['check'].endswith('/blackbox:treasury-rails'))
        failure['finished_at']=100
        policy=dict(name='treasury-failures-skip-and-warn-2026-10-29',reason='thirteen prior mint observations overdue',
                    affected_records=['card-'+str(i) for i in range(13)],evidence_at=200)
        return failure,self.report(failure,'UNKNOWN',standing_policy=policy)

    def test_standing_treasury_unknown_failure_warns_without_pass_or_provider_claim(self):
        from deploy_failure_report import render
        failure,report=self.treasury_failure();original=copy.deepcopy(self.state['attempts'])
        c.adjudicate(self.state,report)
        self.assertTrue(self.state['ready'])
        self.assertEqual(original,self.state['attempts'])
        self.assertEqual('FAIL',failure['native_result']);self.assertEqual('UNKNOWN',failure['rca']['attribution'])
        qualified=c.reuse_qualifications(self.state,self.plan['gates'][1])
        self.assertEqual({'blackbox:treasury-rails'},set(qualified))
        text=render({'failures':[{**failure['rca'],'disposition':failure['disposition']}]})
        self.assertIn('⚠️ Skipped',text);self.assertIn('native FAIL retained',text)
        for i in range(13):self.assertIn('card-'+str(i),text)
        self.assertNotIn('EXTERNAL PROVIDER',text);self.assertNotIn('PASS',text)
        failure['rca']['standing_policy']['name']='other-policy'
        with self.assertRaises(ValueError):c.reuse_qualifications(self.state,self.plan['gates'][1])

    def test_standing_treasury_refuses_unverified_malformed_or_mixed_reports_atomically(self):
        failure,report=self.treasury_failure();original=copy.deepcopy(self.state)
        changes=[('check','backend-coverage-blackbox/blackbox:independent'),('native_result','UNVERIFIED'),
                 ('external_provider',{'name':'provider','reason':'outage'}),('repair_agent','https://boxes.dev/thread/repair'),
                 ('assigned_repair',True),('resource_skip',{}),('post_merge',{}),('prior_waiver',{})]
        for key,value in changes:
            bad=copy.deepcopy(report);bad['failures'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):c.adjudicate(self.state,bad)
            self.assertEqual(original,self.state)
        for policy in [None,{}, {'name':'unknown'}, {**report['failures'][0]['standing_policy'],'evidence_at':False},
                       {**report['failures'][0]['standing_policy'],'affected_records':'card'},
                       {**report['failures'][0]['standing_policy'],'evidence_at':float('nan')}]:
            bad=copy.deepcopy(report);bad['failures'][0]['standing_policy']=policy
            with self.assertRaises(ValueError):c.adjudicate(self.state,bad)
            self.assertEqual(original,self.state)
        failure['complete']=False
        with self.assertRaises(ValueError):c.adjudicate(self.state,report)
        from deploy_failure_report import decision
        for field,value in [('check','backend-coverage-blackbox/blackbox:independent'),('native_result','UNVERIFIED')]:
            bad=copy.deepcopy(report['failures'][0]);bad[field]=value
            with self.assertRaises(ValueError):decision(bad)

    def test_standing_treasury_never_hides_independent_unknown_failure(self):
        failure,report=self.treasury_failure(peer='FAIL')
        other=next(f for f in self.state['failures'] if f is not failure)
        report['failures'].append(self.report(other,'UNKNOWN')['failures'][0])
        before=copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError,'UNKNOWN'):c.adjudicate(self.state,report)
        self.assertEqual(before,self.state)

    def test_standing_treasury_existing_source_renewal_retains_original_fail_without_rerun(self):
        from deploy_failure_report import render
        failure,report=self.treasury_failure();native=copy.deepcopy(self.state['attempts'])
        c.adjudicate(self.state,report)
        old=copy.deepcopy(self.plan)
        (self.root/'code').write_text('new source repair')
        new=copy.deepcopy(old);new['source']=c.source(self.root)
        c.refresh(self.state,old,new,self.root)
        renewal=next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        self.assertEqual('prior waived failure; changed inputs',renewal['native_result'])
        c.advance(self.state,[self.result('static',lint='PASS')])
        after_quick=copy.deepcopy(self.state['attempts'])
        renewed=self.report(renewal,'UNKNOWN',standing_policy=copy.deepcopy(report['failures'][0]['standing_policy']),
                            prior_waiver=copy.deepcopy(renewal['prior_waiver']))
        before=copy.deepcopy(self.state)
        bad=copy.deepcopy(renewed);bad['failures'][0]['prior_waiver']['rca']['source']={}
        with self.assertRaises(ValueError):c.adjudicate(self.state,bad)
        self.assertEqual(before,self.state)
        c.adjudicate(self.state,renewed)
        self.assertNotIn('pending',self.state)
        self.assertEqual(after_quick,self.state['attempts'])
        self.assertEqual(native,self.state['attempts'][:len(native)])
        self.assertEqual('FAIL',failure['native_result']);self.assertEqual(old['source'],failure['source'])
        self.assertEqual({'blackbox:treasury-rails'},set(c.reuse_qualifications(self.state,new['gates'][1])))
        self.assertIn('native FAIL retained',render({'failures':[{**renewed['failures'][0],'disposition':renewal['disposition']}]}))

    def test_unknown_and_introduced_cannot_be_waived(self):
        f = self.failure()
        for attr, fields in [('UNKNOWN', {}), ('INTRODUCED', {'repair_agent': 'https://boxes.dev/thread/repair'}),
                             ('UNKNOWN', {'external_provider': {'name': 'provider', 'reason': 'outage'}})]:
            with self.subTest(attr=attr, fields=fields), self.assertRaises(ValueError):
                c.adjudicate(self.state, self.report(f, attr, **fields))
        self.assertEqual('triage', self.state['phase'])
        self.assertFalse(self.state['ready'])

    def test_missing_policy_helper_blocks_without_traceback(self):
        f=self.failure()
        plan=self.root/'.context/plan.json';report=self.root/'.context/rca.json'
        c.write(plan,self.plan);c.write(report,self.report(f));c.write(self.directory/'cycle.json',self.state)
        with patch.dict(sys.modules,{'deploy_failure_report':None}):
            code=c.main(['triage','--plan',str(plan),'--state-dir',str(self.directory),
                         '--root',str(self.root),'--input',str(report)])
        self.assertEqual(2,code)
        self.assertEqual('triage',c.read(self.directory/'cycle.json')['phase'])

    def test_wrong_source_or_missing_constituent_refused(self):
        f = self.failure()
        report = self.report(f); report['failures'][0]['source'] = {'head': 'wrong'}
        with self.assertRaises(ValueError): c.adjudicate(self.state, report)
        with self.assertRaises(ValueError): c.adjudicate(self.state, {'failures': []})

    def test_unexecuted_constituents_cannot_be_hidden_by_waiver(self):
        f = self.failure(); f['complete'] = False
        with self.assertRaises(ValueError):
            c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                         external_provider={'name': 'provider', 'reason': 'outage'}))

    def test_handed_off_unverified_execution_requires_full_recovery_not_skip(self):
        f = self.failure()
        f['complete'] = False
        f['native_result'] = 'UNVERIFIED'
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     repair_agent='https://boxes.dev/thread/repair', execute_unverified=True))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertFalse(self.state['ready'])
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(['api'], self.state['repair_gates'])
        self.assertEqual('execution required', f['disposition'])
        self.assertEqual('NOT_INTRODUCED', f['rca']['attribution'])
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                           'gates': {'api': {'command': ['true'], 'checks': ['b']}}})
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                       'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['a', 'b'], c.records(self.plan, self.state)[0]['checks'])
        self.assertFalse(self.state['ready'])
        c.advance(self.state, [self.result(a='PASS', b='PASS')])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('final', self.state['phase'])
        self.assertEqual({'api', 'ui'}, {g['name'] for g in c.records(self.plan, self.state)})
        self.assertFalse(self.state['ready'])

    def test_execution_recovery_cannot_authorize_unknown_or_external_waivers(self):
        for attribution, fields in [('UNKNOWN', {}),
                ('NOT_INTRODUCED', {'external_provider': {'name':'provider','reason':'outage'}})]:
            with self.subTest(attribution=attribution):
                f = self.failure()
                f['complete'] = False
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(f, attribution,
                                 execute_unverified=True, **fields))
                self.assertEqual('triage', self.state['phase'])
                self.assertFalse(self.state['ready'])
                self.assertEqual({}, self.state['skips'])

    def test_focus_must_include_failed_case_not_arbitrary_green_subset(self):
        f = self.failure(); c.adjudicate(self.state, self.report(f))
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                           'gates': {'api': {'command': ['true'], 'checks': ['b']}}})

    def test_final_failure_returns_to_rca(self):
        self.state['phase'] = 'final'
        c.advance(self.state, [self.result(a='FAIL', b='PASS')])
        self.assertEqual('triage', self.state['phase'])
        self.assertFalse(self.state['ready'])

    def test_changed_source_refuses_old_green(self):
        (self.root / 'code').write_text('new')
        with self.assertRaises(ValueError):
            c.run_phase(self.plan, self.state, self.directory, self.root)

    def test_all_independent_failures_get_rca_requests(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='FAIL'), self.result('ui', c='FAIL')])
        paths = c.rca_requests(self.state, self.directory)
        self.assertEqual(3, len(paths))
        self.assertEqual({'api/a', 'api/b', 'ui/c'}, {c.read(p)['check'] for p in paths})

    def test_distinct_workers_required_not_silent_local_serialization(self):
        self.plan['gates'][2]['worker'] = 'api-worker'
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_infrastructure_structural_is_not_quick(self):
        self.plan['gates'][0]['category'] = 'deploy-command-structural'
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_mandatory_quick_checks_cannot_be_omitted(self):
        self.plan['gates']=[g for g in self.plan['gates'] if g['name']!='format']
        with self.assertRaisesRegex(ValueError,'quick checks are required'):
            c.validate_plan(self.plan)

    def test_worker_cannot_run_in_coordinator_checkout(self):
        self.plan['gates'][1]['cwd'] = str(self.root)
        with self.assertRaisesRegex(ValueError, 'outside the coordinator'):
            c.initialize(self.plan, self.root)

    def test_workers_cannot_share_checkout_database_or_port(self):
        import copy
        for field in ('cwd', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_PORT'):
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                a, b = plan['gates'][1:3]
                if field == 'cwd': b[field] = a[field]
                else: b['env'][field] = a['env'][field]
                with self.assertRaisesRegex(ValueError, 'must not share'):
                    c.initialize(plan, self.root)

    def test_remote_binding_must_name_its_actual_transport(self):
        gate = self.plan['gates'][1]
        gate.update(worker_transport='ssh', worker_host='worker.example', worker_root='/repo')
        with self.assertRaisesRegex(ValueError, 'ssh transport has no remote cancel'):
            c.initialize(self.plan, self.root)

    def test_saved_ssh_binding_is_refused_on_verify_and_refresh(self):
        # a state saved before the refusal existed: same plan, gate rebound to ssh (finding 4447557475)
        self.state.update(phase='ready', ready=True)
        plan = copy.deepcopy(self.plan)
        plan['gates'][1].update(worker_transport='ssh', worker_host='worker.example', worker_root='/repo',
                                command=['ssh', 'worker.example', 'python3 scripts/deploy_test_worker.py --stdio'],
                                case_protocol=True, result_transport='stdout', timeout_seconds=10,
                                worker_recipe={'cases': {'a': {'command': ['true']}, 'b': {'command': ['true']}}})
        plan['gates'][1].pop('cwd')
        self.state.update(plan=plan, plan_digest=c.digest(plan)); c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(2, c.verify_saved(self.directory, self.root))
        stale = dict(self.state, phase='stale', ready=False)
        with self.assertRaisesRegex(ValueError, 'ssh transport has no remote cancel'):
            c.refresh(stale, plan, {**plan, 'source': c.source(self.root)}, self.root)

    def test_focused_recipe_must_be_identical_except_for_narrowed_checks(self):
        gate = self.plan['gates'][1]  # finding 4447557578 follow-up
        bound = {'cases': {'a': {'command': ['true'], 'env': {'X': '1'}}, 'b': {'command': ['true']}},
                 'cleanup': {'command': ['true']}}
        gate.update(case_protocol=True, worker_recipe=bound)
        self.state = c.initialize(self.plan, self.root)
        self.failure(); self.state.update(phase='needs-focused-plan', repair_gates=['api'])
        self.state['failures'][-1]['disposition'] = 'blocking'
        altered = {'cases': {'a': {'command': ['true'], 'env': {'X': '2'}}}, 'cleanup': {'command': ['true']}}
        with self.assertRaisesRegex(ValueError, 'identical to the bound recipe'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': gate['command'], 'checks': ['a'], 'worker_recipe': altered}}})
        no_cleanup = {'cases': {'a': bound['cases']['a']}}
        with self.assertRaisesRegex(ValueError, 'identical to the bound recipe'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': gate['command'], 'checks': ['a'], 'worker_recipe': no_cleanup}}})
        narrowed = {'cases': {'a': bound['cases']['a']}, 'cleanup': bound['cleanup']}
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
            'command': gate['command'], 'checks': ['a'], 'worker_recipe': narrowed}}})
        self.assertEqual('focused', self.state['phase'])

    def test_nested_worker_checkout_and_overlapping_listener_ports_are_rejected(self):
        import copy
        for kind in ('nested-root', 'port-offset', 'invalid-range'):
            with self.subTest(kind=kind):
                plan=copy.deepcopy(self.plan)
                a,b=plan['gates'][1:3]
                if kind=='nested-root': b['cwd']=str(Path(a['cwd'])/'nested')
                elif kind=='port-offset': b['env']['CONDUCTOR_PORT']='12020'
                else: b['env']['CONDUCTOR_PORT']='65000'
                with self.assertRaises(ValueError): c.initialize(plan,self.root)

    def test_quick_gate_keeps_its_declared_timeout_and_defaults_to_120(self):
        self.plan['gates'][0]['timeout_seconds'] = 300  # finding 4447557550
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(self.plan['gates'][0], self.state, self.directory, self.root)
            self.assertEqual(300, runner.call_args.kwargs['timeout'])

    def test_focused_task_cannot_drop_the_bound_worker_recipe(self):
        gate = self.plan['gates'][1]  # finding 4447557578
        gate.update(case_protocol=True, worker_recipe={'cases': {'a': {'command': ['true']}, 'b': {'command': ['true']}}})
        self.state = c.initialize(self.plan, self.root)
        self.failure(); self.state.update(phase='needs-focused-plan', repair_gates=['api'])
        self.state['failures'][-1]['disposition'] = 'blocking'
        with self.assertRaisesRegex(ValueError, 'bound worker'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': ['bash', '-c', 'heavy command on the coordinator checkout'], 'checks': ['a']}}})
        self.assertEqual('needs-focused-plan', self.state['phase'])

    def test_report_lists_blocking_failures(self):
        failure = self.failure()  # finding 4447557591
        c.adjudicate(self.state, self.report(failure))  # INTRODUCED -> blocking
        self.assertEqual('needs-focused-plan', self.state['phase'])
        plan = self.root / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        import contextlib, io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]))
        text = (self.directory / 'report.md').read_text()
        self.assertIn('BLOCKING', text); self.assertIn('real failure', text); self.assertIn('Deploy validation: needs-focused-plan', text)

    def test_post_merge_packet_identity_mismatch_is_atomic(self):
        failure = self.failure()
        before = copy.deepcopy(self.state)
        packet = {"test": failure["check"], "command": failure["command"],
                  "scope": "api/a", "error": "AssertionError: boom",
                  "source": copy.deepcopy(failure["source"]), "evidence": ["original.log"]}
        for field, value in [("test", "api/b"), ("command", ["false"]),
                             ("source", {**failure["source"], "head": "b" * 40}),
                             ("source", {**failure["source"], "digest": "b" * 64}),
                             ("source", "b" * 40), ("test", True),
                             ("command", "true"), ("source", True)]:
            with self.subTest(field=field, value=value):
                state = copy.deepcopy(before)
                report = self.report(failure, attribution="NOT_INTRODUCED",
                                     post_merge={**packet, field: value})
                with self.assertRaisesRegex(ValueError, "recorded failure"):
                    c.adjudicate(state, report)
                self.assertEqual(before, state)
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertEqual(packet, self.state["pending_post_merge"][0]["packet"])
        self.assertEqual("FAIL", self.state["failures"][0]["native_result"])

    def test_pending_post_merge_qualifies_ready_but_blocks_completion_until_resolved(self):
        failure = self.failure()
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertTrue(self.state["ready"]); self.assertEqual("ready", self.state["phase"])
        kept = next(f for f in self.state["failures"] if f["id"] == failure["id"])
        self.assertEqual("FAIL", kept["native_result"]); self.assertEqual("pending post-merge", kept["disposition"])
        self.assertEqual([failure["id"]], [p["id"] for p in self.state["pending_post_merge"]])
        plan = self.directory / "plan.json"; c.write(plan, self.plan); c.write(self.directory / "cycle.json", self.state)
        # pre-merge readiness is NOT blocked by a pending packet (Phase 3 verify must pass so the merge can happen)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        args = ["--plan", str(plan), "--state-dir", str(self.directory), "--root", str(self.root)]
        import contextlib, io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(0, c.main(["verify", *args]))
        self.assertEqual(1, json.loads(out.getvalue().strip().splitlines()[-1])["pending_post_merge"])  # count reported
        # completion (post-merge) is blocked until the packet is dispatched and resolved
        self.assertEqual(1, c.main(["complete", *args]))
        self.assertEqual(2, c.main(["verify", "--require-resolved", *args]))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(["report", *args]))
        self.assertIn("Pending post-merge: 1", (self.directory / "report.md").read_text())
        # a plain blocking failure still fails verify exactly as before (no loosening)
        blocked = copy.deepcopy(self.state); blocked.update(phase="needs-focused-plan", ready=False)
        c.write(self.directory / "cycle.json", blocked)
        self.assertEqual(2, c.main(["verify", *args])); self.assertEqual(1, c.verify_saved(self.directory, self.root))
        c.write(self.directory / "cycle.json", self.state)
        with self.assertRaisesRegex(ValueError, "repair link"):
            c.resolve_post_merge(self.state, failure["id"], "")
        with self.assertRaisesRegex(ValueError, "repair-thread or Rose repair-agent link"):
            c.resolve_post_merge(self.state, failure["id"], "http://example.com/not-a-repair")
        self.assertEqual(0, c.main(["resolve", *args, "--occurrence", failure["id"],
                                    "--repair-agent", "https://boxes.dev/thread/thr_post_merge_repair"]))
        self.assertEqual(0, c.main(["verify", *args])); self.assertEqual(0, c.main(["complete", *args]))
        self.assertEqual(0, c.main(["verify", "--require-resolved", *args]))
        saved = c.read(self.directory / "cycle.json")
        self.assertEqual([], saved["pending_post_merge"])
        self.assertEqual("delegated / waived", next(f for f in saved["failures"] if f["id"] == failure["id"])["disposition"])
        self.assertEqual("FAIL", next(f for f in saved["failures"] if f["id"] == failure["id"])["native_result"])

    def test_pending_post_merge_is_re_executed_after_a_refresh_that_changes_its_inputs(self):
        self.plan['gates'][1]['input_paths'] = ['code']  # api's fingerprint follows only this file
        self.state = c.initialize(self.plan, self.root)
        failure = self.failure()
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertIn('api/a', self.state['skips']); self.assertEqual(1, len(self.state['pending_post_merge']))
        # unchanged fingerprint for api (a new unrelated file): the pending skip is carried
        unchanged = copy.deepcopy(self.state); unchanged['phase'] = 'stale'
        (self.root / 'other').write_text('unrelated')
        c.refresh(unchanged, self.plan, {**self.plan, 'source': c.source(self.root)}, self.root)
        self.assertEqual('pending post-merge', unchanged['skips']['api/a']['disposition'])
        self.assertEqual(1, len(unchanged['pending_post_merge']))
        # changed fingerprint: skip dropped, no synthetic result, history retained, case re-executes
        (self.root / 'other').unlink(); (self.root / 'code').write_text('changed inputs')
        self.state['phase'] = 'stale'
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertNotIn('api/a', self.state['skips']); self.assertEqual([], self.state['pending_post_merge'])
        self.assertEqual(packet, self.state['superseded_pending_post_merge'][0]['packet'])
        self.assertFalse(any(f['native_result'].startswith('prior waived') for f in self.state['failures']))
        original = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('FAIL', 'pending post-merge'), (original['native_result'], original['disposition']))
        self.assertFalse(self.state.get('pending'))
        while self.state['phase'] in {'quick', 'final'}:
            c.run_phase(new, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        api = next(r for r in self.state['attempts'][-1]['results'] if r['gate'] == 'api')
        self.assertEqual({'a': 'PASS', 'b': 'PASS'}, api['cases'])  # 'a' executed again, not SKIP
        self.assertEqual([], self.state['pending_post_merge'])


    def test_observation_loss_reexecutes_the_bound_gate_without_attribution_or_credit(self):
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False,
                'case_complete': {'a': False, 'b': True}, 'reason': 'coordinator lost the outer exit'}
        c.advance(self.state, [lost, self.result('ui', c='PASS')])
        occurrence = self.state['failures'][-1]
        self.assertEqual(('UNVERIFIED', False), (occurrence['native_result'], occurrence['complete']))
        # refusals: unknown id, a FAIL occurrence, a complete occurrence, an occurrence with a handoff
        with self.assertRaisesRegex(ValueError, 'unknown occurrence|awaiting RCA'):
            c.reexecute(self.state, 'no-such-id')
        for mutation, message in (({'native_result': 'FAIL'}, 'needs /RCA attribution'),
                                  ({'complete': True}, 'needs /RCA attribution'),
                                  ({'repair_agent': 'https://boxes.dev/thread/thr_x'}, 'already carries')):
            with self.subTest(mutation=mutation):
                trial = copy.deepcopy(self.state); next(f for f in trial['failures'] if f['id'] == occurrence['id']).update(mutation)
                with self.assertRaisesRegex(ValueError, message):
                    c.reexecute(trial, occurrence['id'])
        c.reexecute(self.state, occurrence['id'])
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertEqual(['api'], self.state['repair_gates'])
        self.assertNotIn('pending', self.state); self.assertEqual({}, self.state['skips']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == occurrence['id'])
        self.assertEqual('UNVERIFIED', kept['native_result']); self.assertNotIn('rca', kept)
        self.assertEqual('observation loss; re-executing unchanged gate', kept['reexecution']['reason'])
        # the repair sequence executes the BOUND original command; a substitute is refused
        gate = self.plan['gates'][1]
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {'command': ['false'], 'checks': ['b']}}})
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {'command': gate['command'], 'checks': ['a']}}})
        for expected in ('focused', 'failed-gates', 'quick', 'final'):
            self.assertEqual(expected, self.state['phase'])
            c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        self.assertEqual({'a':'PASS', 'b':'PASS'}, c.latest_receipts(self.state)['api']['cases'])
        self.assertTrue(c.full_pass_binding(self.state, gate))
        self.assertNotIn('api', {r['gate'] for r in self.state['attempts'][-1]['results']})

    def test_reexecuted_gate_is_not_lost_when_the_remaining_triage_is_waived(self):
        # CodeRabbit 4449029650: initial phase yields A (api/a UNVERIFIED, observation loss) and B (ui/c FAIL).
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False,
                'case_complete': {'a': False, 'b': True}, 'reason': 'coordinator lost the outer exit'}
        c.advance(self.state, [lost, self.result('ui', c='FAIL')])
        a = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        b = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        c.reexecute(self.state, a['id'])
        self.assertEqual(('triage', [b['id']]), (self.state['phase'], self.state['pending']))
        # the remaining occurrence is waived by delegation: the re-executed gate must still run
        c.adjudicate(self.state, self.report(b, attribution='NOT_INTRODUCED',
                                             repair_agent='https://boxes.dev/thread/thr_repair_b'))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertFalse(self.state['ready'])
        self.assertIn('api', self.state['repair_gates'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual('focused', self.state['phase'])
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def test_per_triage_routing_is_cleared_so_a_stale_entry_cannot_route_a_later_triage(self):
        # path 1: triage completed by adjudicate after a reexecute -> tracking cleared
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False, 'case_complete': {'a': False, 'b': True}}
        c.advance(self.state, [lost, self.result('ui', c='FAIL')])
        a = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        b = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        c.reexecute(self.state, a['id'])
        self.assertEqual(['api'], self.state['triage_repair_gates'])
        c.adjudicate(self.state, self.report(b, attribution='NOT_INTRODUCED', repair_agent='https://boxes.dev/thread/thr_b'))
        self.assertNotIn('triage_repair_gates', self.state)
        # path 2: triage completed by reexecute itself (last pending) -> tracking cleared
        other = copy.deepcopy(self.state); other.update(phase='initial', repair_gates=[])
        c.advance(other, [{**self.result(a='UNVERIFIED', b='PASS'), 'complete': False}])
        c.reexecute(other, other['failures'][-1]['id'])
        self.assertEqual('needs-focused-plan', other['phase']); self.assertNotIn('triage_repair_gates', other)
        # a later waiver-only triage is not routed by the earlier round: no repair, prior phase decides
        later = copy.deepcopy(self.state); later.update(phase='final', repair_gates=[])
        c.advance(later, [self.result('ui', c='FAIL')])
        c.adjudicate(later, self.report(later['failures'][-1], attribution='NOT_INTRODUCED',
                                        repair_agent='https://boxes.dev/thread/thr_later'))
        self.assertEqual(('ready', []), (later['phase'], later['repair_gates']))

    def assigned(self, failure, **changes):
        fields = {'attribution': 'NOT_INTRODUCED', 'assigned_repair': True,
                  'assigned_reason': 'root owns the assigned cloud image prerequisite; compatible image build in progress',
                  'assigned_evidence': '.context/deploy-cloud/95262bce/cli.log', **changes}
        return self.report(failure, **fields)

    def test_assigned_repair_routes_an_owned_not_introduced_failure_without_waiver(self):
        failure = self.failure()
        c.adjudicate(self.state, self.assigned(failure))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('blocking', 'NOT_INTRODUCED', 'FAIL'), (kept['disposition'], kept['rca']['attribution'], kept['native_result']))
        self.assertEqual(['api'], self.state['repair_gates']); self.assertEqual({}, self.state['skips'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def test_assigned_repair_routes_a_diagnosed_unknown_failure_without_relabel(self):
        failure = self.failure()
        c.adjudicate(self.state, self.assigned(failure, attribution='UNKNOWN'))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('blocking', 'UNKNOWN', 'FAIL'), (kept['disposition'], kept['rca']['attribution'], kept['native_result']))
        self.assertEqual(['api'], self.state['repair_gates']); self.assertEqual({}, self.state['skips'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def skipped_row(self, sha='c' * 64, reason='Compute token pool exhausted or cooling down', status='SKIPPED', passed=False,
                    name='a'):
        return {'native_task': {'name': name, 'status': status, 'benchmark_status': status, 'passed': passed,
                                'failure_reason': reason, 'agent_id': 'agent-1'}, 'path': 'native/a/cloudbench-run.json', 'sha256': sha}

    def resource_failure(self, **row):
        self.state['phase'] = 'initial'
        skipped = {**self.result(a='FAIL', b='PASS'), 'finished_at': 1000.0,
                   'worker_evidence': {'a': self.skipped_row(**row)}}
        c.advance(self.state, [skipped, self.result('ui', c='PASS')])
        return next(f for f in self.state['failures'] if f['check'] == 'api/a')

    def confirmation(self, **changes):
        proof = {'receipt_sha256': 'c' * 64, 'receipt_reason': 'Compute token pool exhausted or cooling down',
                 'resource_scope': 'third_party', 'reason_code': 'compute_quota_exhausted', 'exclusive_cause': True,
                 'provider': 'openai-compute-tokens', 'evidence': 'native/a/cloudbench-run.json#failure_reason',
                 'confirmed_at': 1001.0}
        proof.update(changes)
        return proof

    def standing_claude_fixture(self):
        import hashlib, runpy
        template = runpy.run_path(str(ROOT / 'scripts/tests/predeploy-receipts.test.py'))
        summary, bundles, confirmations = template['standing_fixture']()
        bundle = bundles[0]; run, card = bundle['run'], bundle['card']
        summary['tasks'] = ['claude-code-agent']; summary['git_sha'] = self.state['source']['head']
        run['tasks'] = [run['tasks'][7]]; card['per_task'] = [card['per_task'][7]]
        card['source_sha'] = summary['git_sha']; card['tasks'] = dict(total=1, completed=1, running=0, queued=0)
        directory = self.root / '.context/original'; directory.mkdir(parents=True)
        for name, value in [('run.json',run),('report-card.json',card),
            ('local-benchmark-owner.json',dict(token='bench', run_id='original', state='cleanup_verified')),
            ('local-stack-owner.json',dict(token='stack',run_id='original',pid=1234,native_identity='native',birth='birth'))]:
            c.write(directory/name, value)
        (directory/'benchmark-cleanup-bench.status').write_text('version=1\ntoken=bench\nstate=clean\n')
        (directory/'local-stack-cleanup.status').write_text('version=2\nstate=clean\ntoken=stack\nstack_pid=1234\nstack_native_identity=native\nstack_birth=birth\n')
        sha = c.sha_file(directory/'run.json'); confirmations = [confirmations[0]]; confirmations[0]['receipt_sha256'] = sha
        bindings = [dict(run_id='original', plan_run_id='plan', receipt_sha256=sha,
            card_sha256=c.sha_file(directory/'report-card.json'),planned_source_sha=summary['git_sha'])]
        proof = dict(source=self.state['source'],gate='smoke',run_dir=str(directory))
        for name,value in [('summary',summary),('confirmations',confirmations),('bindings',bindings)]:
            path=self.root/'.context'/(name+'.json');c.write(path,value);proof[name]=str(path)
        self.plan['gates'].append(dict(name='smoke',category='smoke',native_cloud=True,worker='native-cloud',
            worker_transport='benchmark-cloud-cli',command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],
            cwd=str(self.root),checks=['claude-code-agent'],case_protocol=True))
        self.state = c.initialize(self.plan,self.root)
        proof['files'] = {str(p):c.sha_file(p) for p in [*directory.iterdir(),*[Path(proof[k]) for k in ('summary','confirmations','bindings')]]}
        return proof,directory

    def test_prelaunch_native_claude_standing_skip_is_separate_and_hash_bound(self):
        proof,directory = self.standing_claude_fixture(); original=copy.deepcopy(self.state)
        import contextlib,io
        proof_path=self.root/'.context/standing-proof.json';plan_path=self.root/'.context/plan.json'
        c.write(proof_path,proof);c.write(plan_path,self.plan);c.write(self.directory/'cycle.json',self.state)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(0,c.main(['standing-skip','--proof',str(proof_path),'--plan',str(plan_path),
                '--state-dir',str(self.directory),'--root',str(self.root)]))
        self.state=c.read(self.directory/'cycle.json')
        self.assertEqual(original['attempts'],self.state['attempts']);self.assertEqual(original['failures'],self.state['failures'])
        self.assertFalse(self.state['ready']);self.assertEqual(['smoke/claude-code-agent'],list(self.state['skips']))
        c.revalidate_standing_skips(self.state)
        path=directory/'run.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaises(ValueError):c.revalidate_standing_skips(self.state)
        self.state.update(phase='ready',ready=True);c.write(self.directory/'cycle.json',self.state)
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

    def test_prelaunch_native_claude_standing_skip_refuses_unclean_wrong_source_and_nonpolicy(self):
        proof,directory=self.standing_claude_fixture();original=copy.deepcopy(self.state)
        for mode in ('missing','source','dirty','auth-reason','nonclaude','incomplete'):
            with self.subTest(mode=mode):
                trial=copy.deepcopy(proof);saved={p:p.read_bytes() for p in directory.iterdir()}
                try:
                    if mode=='missing':trial['files'].pop(str(directory/'local-stack-owner.json'))
                    elif mode=='source':trial['source']={**trial['source'],'head':'f'*40}
                    elif mode=='dirty':(directory/'local-stack-cleanup.status').write_text('state=failed\n')
                    else:
                        run=c.read(directory/'run.json');row=run['tasks'][0]
                        if mode=='auth-reason':row['failure_reason']='Authentication rejected HTTP403'
                        elif mode=='nonclaude':row['name']='chat-mode'
                        else:row['status']='ACTIVE';row['benchmark_status']='FAILED'
                        c.write(directory/'run.json',run)
                    trial['files']={p:c.sha_file(p) for p in trial['files']}
                    with self.assertRaises(ValueError):c.standing_skip(self.state,trial,self.root)
                    self.assertEqual(original,self.state)
                finally:
                    for path,raw in saved.items():path.write_bytes(raw)

    def test_confirmed_compute_token_skip_is_a_warning_not_a_pass(self):
        failure = self.resource_failure()
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation()))
        self.assertEqual('ready', self.state['phase']); self.assertTrue(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('SKIPPED_WITH_WARNING', 'FAIL', 'SKIPPED'),
                         (kept['disposition'], kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))
        self.assertEqual({}, self.state['skips'])  # no pass credit
        warning = self.state['resource_warnings'][0]
        self.assertEqual((failure['id'], 'api/a', 'c' * 64, self.state['source']), (warning['id'], warning['check'], warning['receipt_sha256'], warning['source']))
        plan = self.directory / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]))
        text = (self.directory / 'report.md').read_text()
        self.assertIn('Resource warnings: 1', text); self.assertIn('RESOURCE WARNINGS', text)
        self.assertIn('- api/a — openai-compute-tokens: Compute token pool exhausted or cooling down [compute_quota_exhausted]'
                      ' · Evidence: native/a/cloudbench-run.json#failure_reason · Confirmed at: 1001.0 · Receipt: ' + 'c' * 64, text)
        self.assertNotIn('PASS', text.split('RESOURCE WARNINGS', 1)[1])

    # The native row the 2026-11-06 cloud smoke proof recorded (agent 4f8c38c0, transfer owt_208688aafd52934f33699e9c).
    STALL_REASON = ("AgentCard never released the closed card's org transfer (consumed, releasedCents=0); skipped "
                    "under the standing user-approved warning policy, see docs/rca/cases/2026-10-02-agentcard-"
                    "abandonment-closed-card-transfer-never-released.md: Payment lifecycle did not reach the expected "
                    "terminal state before timeout: payment_lifecycle.purchase.status mismatch: expected 'VOIDED', "
                    "got 'HELD'; last observed purchase.status='HELD', walletFunding.status='RECLAIMING'")

    def stall_confirmation(self, **changes):
        return self.confirmation(**{'receipt_reason': self.STALL_REASON, 'reason_code': 'agentcard_release_stall',
                                    'provider': 'agentcard-sandbox',
                                    'evidence': 'native/agent-payment-abandonment/cloudbench-run.json#failure_reason',
                                    **changes})

    def test_standing_agentcard_release_stall_in_cloud_smoke_is_a_warning_not_a_pass(self):
        # The AgentCard lifecycle tasks are smoke tasks: their standing release stall arrives as a natively SKIPPED
        # cloud row (FAIL case) and is qualified through the same typed warning path, never PASS or pass credit.
        runtime = (ROOT / 'agents/benchmarks/run_benchmark.py').read_text()
        self.assertIn('"AgentCard never released the closed card\'s org transfer (consumed, releasedCents=0); "\n'
                      '    "skipped under the standing user-approved warning policy', runtime)
        failure = self.resource_failure(reason=self.STALL_REASON, name='agent-payment-abandonment')
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.stall_confirmation()))
        self.assertEqual('ready', self.state['phase']); self.assertTrue(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('SKIPPED_WITH_WARNING', 'FAIL', 'SKIPPED'),
                         (kept['disposition'], kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))
        self.assertEqual({}, self.state['skips'])  # no pass credit
        self.assertEqual('agentcard_release_stall', self.state['resource_warnings'][0]['confirmation']['reason_code'])

    def stall_run_document(self, transfer):
        """The runner's own run.json shape for the 2026-11-06 sandbox proof (agent 4f8c38c0)."""
        document = {'run_id': 'flt-agent-payment-abandonment-d9a38b815c82-0', 'tasks': [
            {'name': 'agent-payment-abandonment', 'status': 'SKIPPED', 'benchmark_status': 'SKIPPED', 'passed': False,
             'failure_reason': self.STALL_REASON, 'logs': {'agentcard_release_stall_lifecycle': {
                 'agentCard': {'id': 'card_f82707f47089791fef514b3c', 'status': 'CLOSED', 'balanceCents': 0},
                 'orgTransfer': transfer}}}]}
        path = self.root / '.context/native/agent-payment-abandonment/cloudbench-run.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document))
        return path

    def stall_report_text(self, transfer):
        import contextlib, io
        path = self.stall_run_document(transfer)
        sha = c.sha_file(path)
        failure = self.resource_failure(reason=self.STALL_REASON, name='agent-payment-abandonment', sha=sha)
        failure['worker_evidence']['path'] = str(path)
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED',
                                             resource_skip=self.stall_confirmation(receipt_sha256=sha)))
        plan = self.directory / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory),
                                        '--root', str(self.root)]))
        return (self.directory / 'report.md').read_text().split('RESOURCE WARNINGS', 1)[1]

    def test_agentcard_release_stall_warning_row_states_the_unreleased_amount(self):
        # transferredCents 4396 / releasedCents 0 is $43.96 left unreleased in the sandbox; the row is still
        # a warning (native FAIL retained), never a pass, and says the funds stay a followup.
        warning = self.stall_report_text({'id': 'owt_208688aafd52934f33699e9c', 'status': 'consumed', 'livemode': False,
                                          'amountCents': 4396, 'transferredCents': 4396, 'releasedCents': 0})
        self.assertIn('- api/a — agentcard-sandbox: ' + self.STALL_REASON + ' [agentcard_release_stall]', warning)
        self.assertIn(' · Native: FAIL · Unreleased: $43.96 sandbox (transferredCents 4396 / releasedCents 0)'
                      ' (followup: unreleased funds stay open)', warning)
        self.assertNotIn('PASS', warning)

    def test_agentcard_release_stall_warning_never_invents_an_unstated_amount(self):
        for label, transfer, mode in (('no transferred amount', {'releasedCents': 0, 'livemode': False}, None),
                                      ('no released amount', {'transferredCents': 4396, 'livemode': False}, None),
                                      ('non-integer', {'transferredCents': '4396', 'releasedCents': 0}, None),
                                      ('released above transferred', {'transferredCents': 1, 'releasedCents': 5}, None),
                                      ('live mode', {'transferredCents': 100, 'releasedCents': 25, 'livemode': True}, 'live'),
                                      ('mode unstated', {'transferredCents': 100, 'releasedCents': 25}, 'mode UNRECORDED')):
            with self.subTest(label):
                self.tearDown(); self.setUp()
                warning = self.stall_report_text(transfer)
                if mode is None:
                    self.assertIn(' · Unreleased: UNRECORDED (followup: unreleased funds stay open)', warning)
                    self.assertNotIn('$', warning.split('Native:', 1)[1])
                else:
                    self.assertIn(f' · Unreleased: $0.75 {mode} (transferredCents 100 / releasedCents 25)', warning)

    def test_agentcard_release_stall_helpers_serve_the_production_lane_without_widening_smoke(self):
        # scripts/deploy_prod.py reuses these two helpers for the production lane (production=True); the staged
        # smoke qualification keeps its sandbox-only default, so a production row still blocks there.
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-abandonment'))
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-production-abandonment'))
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-production-abandonment', production=True))
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-abandonment', production=True))
        self.assertFalse(c.agentcard_release_stall_task('chat-mode', production=True))
        self.assertEqual(c.unreleased_amount_text({'transferredCents': 4396, 'releasedCents': 0, 'livemode': True}),
                         'Unreleased: $43.96 live (transferredCents 4396 / releasedCents 0)')
        self.assertEqual(c.unreleased_amount_text({'transferredCents': 4396, 'releasedCents': 0, 'livemode': False}),
                         'Unreleased: $43.96 sandbox (transferredCents 4396 / releasedCents 0)')
        for livemode in (1, 0, None, [], 'true'):  # only a real boolean names the provider mode
            self.assertIn('mode UNRECORDED', c.unreleased_amount_text(
                {'transferredCents': 100, 'releasedCents': 25, 'livemode': livemode}))
        for bad in (None, [], 'x', {}, {'transferredCents': 1}, {'releasedCents': 0}, {'transferredCents': True, 'releasedCents': 0},
                    {'transferredCents': 1, 'releasedCents': 5}, {'transferredCents': -1, 'releasedCents': 0}):
            self.assertEqual(c.unreleased_amount_text(bad), 'Unreleased: UNRECORDED', bad)

    def test_agentcard_release_stall_qualification_binds_the_exact_sandbox_row(self):
        pristine = copy.deepcopy(self.state)
        for label, row in {'production task': dict(name='agent-payment-production-abandonment'),
                           'not an AgentCard lifecycle task': dict(name='chat-mode'),
                           'other AgentCard failure': dict(name='agent-payment-abandonment',
                                                           reason='AgentCard create_card failed: Cardholder not found'),
                           'assertion FAIL with the stall text': dict(name='agent-payment-abandonment', status='FAILED')
                           }.items():
            with self.subTest(label):
                self.state = copy.deepcopy(pristine)
                row.setdefault('reason', self.STALL_REASON)
                failure = self.resource_failure(**row)
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED',
                                                         resource_skip=self.stall_confirmation(receipt_reason=row['reason'])))
                self.assertEqual(before, self.state)

    def test_resource_skip_refusals_are_atomic(self):
        failure = self.resource_failure()
        before = copy.deepcopy(self.state)
        good = self.confirmation()
        variants = {
            'mismatched sha': self.confirmation(receipt_sha256='d' * 64),
            'mismatched reason': self.confirmation(receipt_reason='Compute token pool exhausted'),
            'missing provider': self.confirmation(provider=''),
            'missing confirmed_at': {k: v for k, v in good.items() if k != 'confirmed_at'},
            'early confirmation': self.confirmation(confirmed_at=999.0),
            'wrong reason_code': self.confirmation(reason_code='billing_credit_exhausted'),
            'not exclusive': self.confirmation(exclusive_cause=False),
        }
        for label, proof in variants.items():
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=proof))
                self.assertEqual(before, self.state)
        for label, extra in (('with link', {'repair_agent': 'https://boxes.dev/thread/thr_x'}),
                             ('with provider waiver', {'external_provider': {'name': 'p', 'reason': 'credits exhausted'}}),
                             ('with assigned_repair', {'assigned_repair': True, 'assigned_reason': 'r', 'assigned_evidence': 'e'}),
                             ('with execute', {'execute_unverified': True}),
                             ('with post-merge', {'post_merge': {'test': 't', 'command': ['x'], 'scope': 's', 'error': 'e', 'source': 's', 'evidence': ['v']}})):
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=good, **extra))
                self.assertEqual(before, self.state)
        # an actual assertion FAIL (native FAILED row) or an unverified occurrence can never be qualified
        for row in ({'status': 'FAILED', 'reason': 'AssertionError: boom'}, {'passed': True, 'status': 'PASSED'}):
            with self.subTest(row=row):
                other = copy.deepcopy(before)
                other['failures'][0]['worker_evidence'] = {'a': self.skipped_row(**row)} if row.get('status') != 'PASSED' else {'a': self.skipped_row(**row)}
                failing = other['failures'][0]
                proof = self.confirmation(receipt_reason=failing['worker_evidence']['a']['native_task']['failure_reason'])
                with self.assertRaises(ValueError):
                    c.adjudicate(other, self.report(failing, attribution='NOT_INTRODUCED', resource_skip=proof))
        unverified = copy.deepcopy(before); unverified['failures'][0].update(native_result='UNVERIFIED', complete=False)
        with self.assertRaises(ValueError):
            c.adjudicate(unverified, self.report(unverified['failures'][0], attribution='NOT_INTRODUCED', resource_skip=good))

    def test_mixed_batch_with_a_real_failure_still_blocks(self):
        self.state['phase'] = 'initial'
        skipped = {**self.result(a='FAIL', b='PASS'), 'finished_at': 1000.0, 'worker_evidence': {'a': self.skipped_row()}}
        c.advance(self.state, [skipped, self.result('ui', c='FAIL')])
        skip_f = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        real_f = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        report = {'failures': [*self.report(skip_f, attribution='NOT_INTRODUCED', resource_skip=self.confirmation())['failures'],
                               *self.report(real_f, attribution='INTRODUCED')['failures']]}
        c.adjudicate(self.state, report)
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        self.assertEqual(['ui'], self.state['repair_gates']); self.assertEqual(1, len(self.state['resource_warnings']))

    def test_renewal_contract_tracks_dependencies_task_and_payment_bytes(self):
        import deploy_test_agentcard_renewal as renewal
        task = {'name': 'fixture', 'tags': ['agentcard-lifecycle-sandbox']}
        tasks = self.root / 'agents/benchmarks/tasks.json'
        tasks.parent.mkdir(parents=True)
        tasks.write_text(json.dumps([task]))
        runtime = tasks.with_name('run_benchmark.py')
        runtime.write_text('LIMIT = 1\n' + '\n'.join('def ' + name + '(): return LIMIT'
                                                        for name in renewal.FUNCTIONS))
        cleanup = tasks.with_name('cloud_batch_cleanup.py'); cleanup.write_text('cleanup = 1')
        payment = self.root / renewal.PAYMENT_PATHS[0] / 'fixture.ts'
        payment.parent.mkdir(parents=True); payment.write_text('payment = 1')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'contract fixture'], check=True)
        head = c.source(self.root)['head']
        baseline = renewal.contract(self.root, head, 'fixture')
        (self.root / 'unrelated').write_text('unrelated source')
        self.assertEqual(baseline, renewal.contract(self.root, head, 'fixture'))
        for path, changed in ((payment, 'payment = 2'), (runtime, runtime.read_text().replace('LIMIT = 1', 'LIMIT = 2')),
                              (tasks, json.dumps([{**task, 'timeout_seconds': 1}])), (cleanup, 'cleanup = 2')):
            original = path.read_text(); path.write_text(changed)
            with self.assertRaises(ValueError): renewal.contract(self.root, head, 'fixture')
            path.write_text(original)

    def renewal_fixture(self):
        import deploy_test_agentcard_renewal as renewal
        import time
        task = next(t for t in json.loads((ROOT / 'agents/benchmarks/tasks.json').read_text())
                    if t['name'] == 'agent-payment-abandonment')
        lifecycle = copy.deepcopy(task['expected_payment_lifecycle'])
        lifecycle.update(agentId='root-fixture', stripeRefund=None)
        lifecycle['purchase'].update(status='HELD', cardId='card_fixture')
        lifecycle['walletFunding'].update(status='RECLAIMING', providerTransferId='owt_fixture')
        lifecycle['agentCard'].update(id='card_fixture', status='CLOSED')
        lifecycle['orgTransfer'].update(id='owt_fixture', cardId='card_fixture', status='consumed', releasedCents=0)
        lifecycle['stripeHold']['livemode'] = False
        path = self.stall_run_document(lifecycle['orgTransfer'])
        doc = c.read(path)
        row = doc['tasks'][0]
        row.update(agent_id='root-fixture', cleanup_failure=None, context_violations=[],
                   execution_provenance={'base_sha': self.state['source']['head']})
        row['logs']['agentcard_release_stall_lifecycle'] = lifecycle
        row['logs']['cloud_cleanup_evidence'] = {
            'errors': [], 'root_agent_id': 'root-fixture',
            'agentcard_release_stall_lifecycles': {'root-fixture': lifecycle},
            'final': {'root_deleted': True, 'unsealed_tree_agent_ids': [], 'browser_sessions': []}}
        c.write(path, doc)
        sha = c.sha_file(path)
        failure = self.resource_failure(reason=self.STALL_REASON, name='agent-payment-abandonment', sha=sha)
        failure['worker_evidence'].update(path=str(path))
        failure['worker_evidence']['native_task']['agent_id'] = 'root-fixture'
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED',
                                           resource_skip=self.stall_confirmation(receipt_sha256=sha)))
        original = copy.deepcopy(self.state['failures'])
        (self.root / 'code').write_text('changed source requiring all current gates')
        (self.root / renewal.PRODUCER).parent.mkdir(parents=True, exist_ok=True)
        (self.root / renewal.PRODUCER).write_text('hermetic producer')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.plan = new
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            binding = {**renewal.binding(self.state, failure['id'], self.root), 'prepared_at': time.time() - 2}
        proof = {'binding': binding, 'started_at': time.time() - 1, 'finished_at': time.time(),
                 'observations': {'card': {'id': 'card_fixture', 'status': 'CLOSED', 'balanceCents': 0, 'livemode': False},
                                  'transfer': copy.deepcopy(lifecycle['orgTransfer'])}}
        return renewal, task, proof, original, path

    def test_changed_source_agentcard_renewal_cli_keeps_failure_and_runs_peers(self):
        renewal, task, proof, original, path = self.renewal_fixture()
        self.assertEqual([], self.state['resource_warnings'])  # original refresh revokes the exclusion
        self.assertEqual(original, self.state['failures'])
        native = path.read_bytes()
        before_gate = copy.deepcopy(next(g for g in self.plan['gates'] if g['name'] == 'api'))
        before_gate['case_protocol'] = True
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(before_gate, self.state, self.directory / 'before-renewal', self.root)
        before_request = c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))
        self.assertEqual(['a', 'b'], before_request['checks'])  # old path would request another card
        plan = self.directory / 'plan.json'
        c.write(plan, self.plan)
        c.write(self.directory / 'cycle.json', self.state)
        proof_path = self.directory / 'proof.json'; c.write(proof_path, proof)
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            self.assertEqual(0, c.main(['renew-agentcard-warning', '--plan', str(plan), '--state-dir',
                str(self.directory), '--root', str(self.root), '--proof', str(proof_path)]))
            state = c.read(self.directory / 'cycle.json')
            before = copy.deepcopy(state)
            with patch.object(renewal.time, 'time', return_value=proof['finished_at'] + 600):
                renewal.renew(state, proof, self.root)
            self.assertEqual(before, state)
        self.assertEqual(original, state['failures'])
        self.assertEqual(native, path.read_bytes())
        self.assertEqual({}, state['skips'])
        self.assertFalse(state['ready'])
        self.assertEqual(1, len(state['superseded_resource_warnings']))
        gate = next(g for g in self.plan['gates'] if g['name'] == 'api')
        gate['case_protocol'] = True
        state.update(phase='failed-gates')
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            result = c.execute(gate, state, self.directory, self.root)
        request = c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))
        self.assertEqual(['b'], request['checks'])
        self.assertEqual('SKIP', result['cases']['a'])
        self.assertEqual('SKIPPED_WITH_WARNING', request['skips']['a']['disposition'])

    def test_bounded_transfer_visibility_preserves_original_failure_and_runs_peers(self):
        renewal, task, proof, original, path = self.renewal_fixture()
        proof['observations'].pop('transfer')
        proof['observations']['transfer_page'] = {'status': 'consumed', 'limit': 100, 'row_count': 100,
            'target_present': False, 'oldest_created_at': proof['started_at'], 'rows_sha256': 'a' * 64}
        native = path.read_bytes(); before = copy.deepcopy(self.state)
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            for key, value in [('row_count', 99), ('limit', True), ('target_present', True),
                               ('oldest_created_at', 0), ('oldest_created_at', True), ('rows_sha256', 'bad')]:
                variant = copy.deepcopy(proof); variant['observations']['transfer_page'][key] = value
                with self.assertRaises(ValueError): renewal.renew(self.state, variant, self.root)
                self.assertEqual(before, self.state)
            mixed = copy.deepcopy(proof); mixed['observations']['transfer'] = {}
            with self.assertRaises(ValueError): renewal.renew(self.state, mixed, self.root)
            self.assertEqual(before, self.state)
            renewal.renew(self.state, proof, self.root)
            renewal.validate_active(self.state, self.state['resource_warnings'][0])
        self.assertIn('UNVERIFIED', self.state['resource_warnings'][0]['current_resource_state'])
        self.assertEqual(original, self.state['failures']); self.assertEqual(native, path.read_bytes())
        gate = copy.deepcopy(next(g for g in self.plan['gates'] if g['name'] == 'api')); gate['case_protocol'] = True
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            result = c.execute(gate, self.state, self.directory / 'bounded-visibility', self.root)
        request = c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))
        self.assertEqual(['b'], request['checks']); self.assertEqual('SKIP', result['cases']['a'])
        self.assertFalse(self.state['ready'])

    def test_renewal_accepts_absent_card_mode_without_fabrication(self):
        renewal, task, proof, original, path = self.renewal_fixture()
        proof['observations']['card'].pop('livemode')
        native = path.read_bytes()
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            renewal.renew(self.state, proof, self.root)
        self.assertNotIn('livemode', self.state['resource_warnings'][0]['renewal']['observations']['card'])
        self.assertIs(False, self.state['resource_warnings'][0]['renewal']['observations']['transfer']['livemode'])
        self.assertEqual(original, self.state['failures'])
        self.assertEqual(native, path.read_bytes())
        self.assertFalse(self.state['ready'])

    def test_optional_card_mode_preserves_strict_transfer_and_explicit_mode_guards(self):
        renewal, task, proof, original, path = self.renewal_fixture()
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            for value in (True, None, 0, 1, 'false', [], {}):
                state, changed = copy.deepcopy(self.state), copy.deepcopy(proof)
                changed['observations']['card']['livemode'] = value
                with self.assertRaises(ValueError):
                    renewal.renew(state, changed, self.root)
                self.assertEqual(self.state, state)
            for include_card_mode in (True, False):
                for value in (True, None, 0, 1, 'false', [], {}):
                    state, changed = copy.deepcopy(self.state), copy.deepcopy(proof)
                    if not include_card_mode:
                        changed['observations']['card'].pop('livemode')
                    changed['observations']['transfer']['livemode'] = value
                    with self.assertRaises(ValueError):
                        renewal.renew(state, changed, self.root)
                    self.assertEqual(self.state, state)
                state, changed = copy.deepcopy(self.state), copy.deepcopy(proof)
                if not include_card_mode:
                    changed['observations']['card'].pop('livemode')
                changed['observations']['transfer'].pop('livemode')
                with self.assertRaises(ValueError):
                    renewal.renew(state, changed, self.root)
                self.assertEqual(self.state, state)
        self.assertEqual(original, self.state['failures'])

    def test_changed_source_renewal_fail_closed(self):
        renewal, task, proof, original, path = self.renewal_fixture()
        mutations = [lambda s, p: p['binding'].update(native_sha256='0' * 64),
                     lambda s, p: p['binding'].update(source={'head': 'wrong'}),
                     lambda s, p: p.update(started_at=0),
                     lambda s, p: p.update(provider_waiver=True),
                     lambda s, p: p['observations']['transfer'].update(livemode=True),
                     lambda s, p: p['observations']['transfer'].update(releasedCents=4396),
                     lambda s, p: p['observations']['card'].update(balanceCents=False),
                     lambda s, p: p['observations']['card'].update(id='card_wrong'),
                     lambda s, p: s.update(running=[]),
                     lambda s, p: s['failures'][0].update(complete=False),
                     lambda s, p: s['failures'][0]['rca']['resource_skip'].update(reason_code='compute_quota_exhausted')]
        with patch.object(renewal, 'contract', return_value=(task, 'contract-sha')):
            for mutate in mutations:
                state, changed = copy.deepcopy(self.state), copy.deepcopy(proof)
                mutate(state, changed); before = copy.deepcopy(state)
                with self.assertRaises((ValueError, KeyError)):
                    renewal.renew(state, changed, self.root)
                self.assertEqual(before, state)
            with patch.object(c, 'retained_owners', return_value=['api']):
                with self.assertRaises(ValueError): renewal.renew(self.state, proof, self.root)
            path.write_text('{}')
            with self.assertRaises(ValueError): renewal.renew(self.state, proof, self.root)

    def test_resource_warning_needs_renewed_confirmation_after_changed_inputs(self):
        failure = self.resource_failure()
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation()))
        self.state['phase'] = 'stale'
        (self.root / 'code').write_text('changed inputs')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual([], self.state['resource_warnings'])
        superseded = self.state['superseded_resource_warnings'][0]
        self.assertEqual((failure['id'], 'c' * 64, failure['source']), (superseded['id'], superseded['receipt_sha256'], superseded['source']))
        self.assertFalse(any(f['native_result'].startswith('prior') for f in self.state['failures']))
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('FAIL', 'SKIPPED'), (kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))

    def smoke_plan(self):
        plan = copy.deepcopy(self.plan)
        plan['gates'].append({'name': 'smoke', 'worker': 'smoke-worker', 'checks': ['mass', 'mail'], 'case_protocol': True, 'input_paths': ['code'],
                              'command': ['true'], 'worker_transport': 'local-isolated', 'cwd': str(Path(self.workers.name) / 'smoke'),
                              'env': {'CONDUCTOR_WORKSPACE_NAME': 'smoke', 'CONDUCTOR_PORT': '36000'}})
        (Path(self.workers.name) / 'smoke').mkdir(exist_ok=True)
        return plan

    def qualified_smoke_state(self, plan):
        state = c.initialize(plan, self.root); state['phase'] = 'initial'
        skipped = {**self.result('smoke', mass='FAIL', mail='FAIL'), 'finished_at': 1000.0,
                   'worker_evidence': {'mass': self.skipped_row()}}
        c.advance(state, [skipped])
        mass = next(f for f in state['failures'] if f['check'] == 'smoke/mass')
        mail = next(f for f in state['failures'] if f['check'] == 'smoke/mail')
        report = {'failures': [*self.report(mass, attribution='NOT_INTRODUCED', resource_skip=self.confirmation())['failures'],
                               *self.report(mail, attribution='INTRODUCED')['failures']]}
        c.adjudicate(state, report)
        self.assertEqual(('needs-focused-plan', ['smoke']), (state['phase'], state['repair_gates']))
        return state

    def test_qualified_resource_skip_is_excluded_from_the_next_request_but_kept_in_the_record(self):
        plan = self.smoke_plan(); state = self.qualified_smoke_state(plan)
        gate = next(g for g in plan['gates'] if g['name'] == 'smoke')
        state['phase'] = 'failed-gates'  # the full rerun of the repaired gate
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            result = c.execute(gate, state, self.directory, self.root)
        request = c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))
        self.assertEqual(['mail'], request['checks'])  # no mass invocation
        self.assertEqual('SKIPPED_WITH_WARNING', request['skips']['mass']['disposition'])
        self.assertEqual('c' * 64, request['skips']['mass']['receipt_sha256'])
        self.assertEqual('SKIP', result['cases']['mass']); self.assertIn('mail', result['cases'])
        self.assertEqual('c' * 64, result['resource_skips']['mass']['receipt_sha256'])
        mass = next(f for f in state['failures'] if f['check'] == 'smoke/mass')
        self.assertEqual(('FAIL', 'SKIPPED'), (mass['native_result'], mass['worker_evidence']['native_task']['benchmark_status']))
        # same inputs on a new head: the warning rebinds its active source, keeps the native one, and still excludes
        original_source = state['source']
        state['phase'] = 'stale'; (self.root / 'other').write_text('unrelated')
        same = {**plan, 'source': c.source(self.root)}
        c.refresh(state, plan, same, self.root)
        warning = state['resource_warnings'][0]
        self.assertEqual((same['source'], original_source), (warning['source'], warning['original_source']))
        self.assertNotEqual(same['source'], original_source)
        state.update(phase='failed-gates', round=state['round'] + 1)
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(gate, state, self.directory, self.root)
        self.assertEqual(['mail'], c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))['checks'])
        # a changed input fingerprint removes the warning: mass is requested again until re-confirmed
        state['phase'] = 'stale'; (self.root / 'code').write_text('changed inputs')
        new = {**same, 'source': c.source(self.root)}
        c.refresh(state, same, new, self.root)
        self.assertEqual([], state['resource_warnings'])
        self.assertEqual(original_source, state['superseded_resource_warnings'][0]['original_source'])
        state.update(phase='failed-gates', round=state['round'] + 1)
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(gate, state, self.directory, self.root)
        self.assertEqual(['mass', 'mail'], c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))['checks'])

    def test_missing_finished_at_falls_back_only_to_a_matching_sidecar_receipt(self):
        failure = self.resource_failure()
        del failure['finished_at']  # an occurrence recorded before finished_at existed
        folder = self.directory / 'attempts/9/focused/api'; folder.mkdir(parents=True)
        failure['worker_result'] = str(folder / 'result.json')
        sidecar = {'gate': 'api', 'status': 'FAIL', 'cases': {'a': 'FAIL', 'b': 'PASS'}, 'executed': True, 'complete': True,
                   'case_complete': {'a': True, 'b': True}, 'source': self.state['source'], 'finished_at': 1793667148.9725}
        before = copy.deepcopy(self.state)
        with self.assertRaises(ValueError):  # no sidecar -> refused
            c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
        self.assertEqual(before, self.state)
        for label, bad in (('source', {'source': {'head': 'x' * 40, 'digest': 'y' * 64}}), ('gate', {'gate': 'ui'}),
                           ('case', {'cases': {'z': 'FAIL'}, 'case_complete': {'z': True}}), ('result', {'cases': {'a': 'PASS', 'b': 'PASS'}})):
            with self.subTest(mismatch=label):
                c.write(folder / 'receipt.json', {**sidecar, **bad})
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
                self.assertEqual(before, self.state)
        c.write(folder / 'receipt.json', sidecar)
        with self.assertRaises(ValueError):  # the real terminal timestamp is the bound: an earlier confirmation is refused
            c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1001.0)))
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
        self.assertEqual('SKIPPED_WITH_WARNING', next(f for f in self.state['failures'] if f['id'] == failure['id'])['disposition'])
        self.assertNotIn('finished_at', next(f for f in self.state['failures'] if f['id'] == failure['id']))  # record not backfilled

    def test_assigned_repair_refusals_leave_the_state_unchanged(self):
        failure = self.failure()
        before = copy.deepcopy(self.state)
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        variants = {
            'missing reason': self.assigned(failure, assigned_reason=''),
            'missing evidence': self.assigned(failure, assigned_evidence=None),
            'with link': self.assigned(failure, repair_agent='https://boxes.dev/thread/thr_x'),
            'with provider': self.assigned(failure, external_provider={'name': 'p', 'reason': 'outage'}),
            'with post-merge': self.assigned(failure, post_merge=packet),
            'with execute': self.assigned(failure, execute_unverified=True),
            'unknown missing reason': self.assigned(failure, attribution='UNKNOWN', assigned_reason=''),
            'unknown missing evidence': self.assigned(failure, attribution='UNKNOWN', assigned_evidence=None),
            'unknown with link': self.assigned(failure, attribution='UNKNOWN', repair_agent='https://boxes.dev/thread/thr_x'),
            'unknown with provider': self.assigned(failure, attribution='UNKNOWN', external_provider={'name': 'p', 'reason': 'outage'}),
            'unknown with post-merge': self.assigned(failure, attribution='UNKNOWN', post_merge=packet),
            'unknown with execute': self.assigned(failure, attribution='UNKNOWN', execute_unverified=True),
            'introduced attribution': self.assigned(failure, attribution='INTRODUCED'),
            'non-boolean flag': self.assigned(failure, assigned_repair='yes'),
        }
        for label, report in variants.items():
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, report)
                self.assertEqual(before, self.state)
        self.assertEqual('triage', self.state['phase'])

    def test_retained_remote_owner_blocks_reexecute_and_any_relaunch_of_that_gate(self):
        # CodeRabbit 4450239861: an owned/timeout receipt must not be relaunched via triage -> reexecute -> focus -> run.
        self.state['phase'] = 'initial'
        owner = {'request_token': 'tok-prev', 'worker_cleanup_owner': {'worker_thread': 'ph-worker', 'worker_root': '/prepared/root',
                 'turn_id': 'turn-7', 'pgid': 4242}}
        owned = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False, 'case_complete': {'a': False, 'b': True},
                 'lingering_group': True, 'cleanup_owner': owner, 'reason': 'worker reported a retained remote cleanup owner'}
        c.advance(self.state, [owned, self.result('ui', c='PASS')])
        occurrence = self.state['failures'][-1]
        self.assertEqual(('triage', 'UNVERIFIED', False), (self.state['phase'], occurrence['native_result'], occurrence['complete']))
        with self.assertRaisesRegex(ValueError, 'cleanup owner|reconcil'):
            c.reexecute(self.state, occurrence['id'])
        self.assertEqual('triage', self.state['phase'])
        # even if the state is driven to a focused run of that gate, launch is refused before any dispatch
        forced = copy.deepcopy(self.state)
        forced.update(phase='focused', repair_gates=['api'], focused={'api': {'command': ['true'], 'checks': ['a']}})
        forced.pop('pending', None)
        with patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'api'):
            c.run_phase(self.plan, forced, self.directory, self.root)
        launcher.assert_not_called()
        self.assertEqual(0, forced['round'])
        # a gate whose latest receipt is clean still launches (ui) once the owned gate is not selected
        clean = copy.deepcopy(self.state)
        clean.update(phase='focused', repair_gates=['ui'], focused={'ui': {'command': ['true'], 'checks': ['c']}})
        clean.pop('pending', None)
        with patch.object(c, 'execute', return_value={**self.result('ui', c='PASS'), 'gate': 'ui'}) as launcher:
            c.run_phase(self.plan, clean, self.directory, self.root)
        launcher.assert_called_once()

    def recon_state(self):
        """Self-contained synthetic producer shapes (coordinator receipt, boxes-thread adapter result with
        transport_receipt + cleanup_owner, same-turn platform result, native audit, process sidecar, audit
        record) with fake identities; every hash and marker is computed from the bytes written here."""
        import hashlib
        gate_name, token = 'cloudbench-controller', getattr(self, '_renewal_fixture_token', 'f' * 32)
        source = {'head': 'a' * 40, 'digest': 'b' * 64}
        owner = {'worker_thread': 'ph-fake-worker', 'worker_host': 'fake-devbox-uuid', 'worker_root': '/fake/worker/root',
                 'request_token': token, 'message_id': 'fake-message-id', 'turn_id': 'fake-turn-id',
                 'remote_dir': f'/fake/worker/root/.context/deploy-boxes/{token}', 'pgid': None}
        folder = self.directory / 'attempts/0/initial' / gate_name; folder.mkdir(parents=True, exist_ok=True)
        paths = {k: folder / n for k, n in (('receipt', 'receipt.json'), ('adapter', 'result.json'), ('platform', 'platform.json'),
                                             ('audit', 'native-audit.json'), ('process', 'process.json'), ('record', 'audit-record.json'))}
        audit = {'token': token, 'source': source, 'gate': gate_name, 'cases': {gate_name: 'PASS'}, 'complete': True, 'reused': False,
                 'evidence': {gate_name: {'status': 'PASS', 'native_exit': 0, 'command': ['bash', 'scripts/run-cloudbench-controller-gate'],
                                          'started_at': 1793664491.1, 'finished_at': 1793665704.5, 'timed_out': False, 'cancelled': False,
                                          'lingering_group': False, 'log': '/fake/worker/root/.context/x.log', 'sha256': 'e' * 64, 'tail': 'ok'}},
                 'recipe_digest': 'd' * 64, 'cleanup_complete': True, 'worker_root': owner['worker_root']}
        audit_text = json.dumps(audit, indent=2) + '\n'; paths['audit'].write_text(audit_text)
        audit_sha = hashlib.sha256(audit_text.encode()).hexdigest()
        platform = {'schemaVersion': 1, 'ok': True, 'data': {'completedAt': 1793665720934, 'executionInstanceId': owner['worker_host'],
                    'failure': None, 'output': {'text': 'DEPLOY_GATE_WORKER_PGID 1\nDEPLOY_GATE_WORKER_EXIT 0\n'
                    f'DEPLOY_GATE_RESULT_SHA256 {audit_sha}\nDEPLOY_GATE_RESULT_JSON_BEGIN\n{audit_text}DEPLOY_GATE_RESULT_JSON_END\n'},
                    'status': 'completed', 'turnId': owner['turn_id']}}
        c.write(paths['platform'], platform)
        c.write(paths['process'], {'supervisor_pid': 1, 'child_pid': 2, 'native_exit': 0, 'cancelled': False, 'timed_out': False,
                                   'quiescent': True, 'orphaned_children': False, 'reaped': [{'pid': 2, 'status': 0}], 'term_sent': [],
                                   'kill_sent': [], 'remaining': [], 'error': None})
        c.write(paths['adapter'], {'token': token, 'source': source, 'gate': gate_name, 'cases': {gate_name: 'UNVERIFIED'}, 'complete': False,
                                   'cleanup_complete': False, 'reused': False, 'evidence': {}, 'reason': 'threads wait exited 2', 'worker_stderr': '',
                                   'transport_receipt': {'transport': 'boxes-thread', **{k: owner[k] for k in ('worker_thread', 'worker_host', 'worker_root')},
                                                         'request_token': token, 'idempotency_key': token, 'message_id': owner['message_id'],
                                                         'turn_id': owner['turn_id'], 'native_sha256': None}, 'cleanup_owner': dict(owner)})
        receipt = {'gate': gate_name, 'status': 'FAIL', 'cases': {gate_name: 'UNVERIFIED'}, 'native_exit': 1, 'executed': True, 'complete': False,
                   'reason': 'worker result identity/inventory mismatch', 'timed_out': False, 'case_complete': {gate_name: False}, 'cancelled': False,
                   'lingering_group': False, 'source': source, 'started_at': 1793664471.6, 'finished_at': 1793664913.25,
                   'command': ['bash', 'scripts/run-cloudbench-controller-gate'], 'log': str(folder / 'output.log'),
                   'stderr_log': str(folder / 'stderr.log'), 'token': token, 'lifecycle': 'owned', 'native_cleanup_reference': None,
                   'worker_evidence': {}, 'worker_result': str(paths['adapter'])}
        c.write(paths['receipt'], receipt)  # the producer writes the exact recorded receipt to disk
        c.write(paths['record'], {'observed_at': 1793667622.4, 'original_outer_result': 'UNVERIFIED', 'original_complete': False,
                                  'credit_granted': False, 'files': {'native-audit.json': {'sha256': audit_sha}}})
        gate = {'name': gate_name, 'worker': 'cb-worker', 'checks': [gate_name], 'command': receipt['command'],
                'case_protocol': True, 'worker_transport': 'boxes-thread', 'cwd': '.'}
        plan = {**self.plan, 'gates': [*self.plan['gates'], gate]}
        state = {**copy.deepcopy(self.state), 'plan': plan, 'plan_digest': c.digest(plan), 'phase': 'initial', 'source': source,
                 'input_fingerprints': {**self.state['input_fingerprints'], gate_name: 'fp'}}
        c.advance(state, [receipt])
        occurrence = state['failures'][-1]
        self.assertEqual(('triage', 'UNVERIFIED', False), (state['phase'], occurrence['native_result'], occurrence['complete']))
        shas = {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()}
        proof = {'receipt_sha256': shas['receipt'], 'worker_result_sha256': shas['adapter'], 'request_token': token, 'owner': dict(owner),
                 'platform_result': {'path': str(paths['platform']), 'sha256': shas['platform']},
                 'native_audit': {'path': str(paths['audit']), 'sha256': shas['audit']},
                 'process': {'path': str(paths['process']), 'sha256': shas['process']},
                 'confirmed_at': 1793667622.0, 'observed_by': 'ph-fake-coordinator'}
        return state, plan, gate, occurrence, paths, shas, proof

    def test_legacy_adapter_owner_is_detected_identity_checked_and_blocks_launch(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        self.assertEqual(['cloudbench-controller'], c.retained_owners(state, ['cloudbench-controller']))
        with self.assertRaisesRegex(ValueError, 'cleanup owner'):
            c.reexecute(state, occurrence['id'])
        forced = copy.deepcopy(state); forced.update(phase='focused', repair_gates=['cloudbench-controller'],
                                                    focused={'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}})
        forced.pop('pending', None)
        with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
             patch.object(c, 'environment_digest', return_value=state['environment']), \
             patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
            c.run_phase(plan, forced, self.directory, self.root)
        launcher.assert_not_called(); self.assertEqual(0, forced['round'])
        # identity mismatch or a missing adapter file is a loud error, never silent admission or ignoring
        mismatched = copy.deepcopy(state); bad = self.directory / 'bad-adapter.json'
        bad.write_text(json.dumps({**json.loads(paths['adapter'].read_text()), 'token': 'other-token'}))
        mismatched['attempts'][-1]['results'][0]['worker_result'] = str(bad)
        with self.assertRaisesRegex(ValueError, 'cloudbench-controller.*identity'):
            c.retained_owners(mismatched, ['cloudbench-controller'])
        missing = copy.deepcopy(state); missing['attempts'][-1]['results'][0]['worker_result'] = str(self.directory / 'nope.json')
        with self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
            c.retained_owners(missing, ['cloudbench-controller'])
        # a present-but-partial owner identity is never "unowned": loud error, zero launches
        for missing_field in ('worker_thread', 'worker_host', 'worker_root', 'turn_id'):
            with self.subTest(missing_field=missing_field):
                partial = copy.deepcopy(state); doc = json.loads(paths['adapter'].read_text())
                doc['cleanup_owner'] = {k: v for k, v in doc['cleanup_owner'].items() if k != missing_field}
                path = self.directory / f'partial-{missing_field}.json'; path.write_text(json.dumps(doc))
                partial['attempts'][-1]['results'][0]['worker_result'] = str(path)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller: adapter cleanup owner identity incomplete'):
                    c.retained_owners(partial, ['cloudbench-controller'])
                partial.update(phase='focused', repair_gates=['cloudbench-controller'],
                               focused={'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}})
                partial.pop('pending', None)
                with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
                     patch.object(c, 'environment_digest', return_value=state['environment']), \
                     patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'identity incomplete'):
                    c.run_phase(plan, partial, self.directory, self.root)
                launcher.assert_not_called()
        # No owner is sufficient only with explicitly complete cleanup.
        unowned = copy.deepcopy(state); doc = json.loads(paths['adapter'].read_text()); doc.pop('cleanup_owner')
        doc['cleanup_complete'] = True
        path = self.directory / 'unowned.json'; path.write_text(json.dumps(doc))
        unowned['attempts'][-1]['results'][0]['worker_result'] = str(path)
        self.assertEqual([], c.retained_owners(unowned, ['cloudbench-controller']))
        for cleanup in (False, None, 1, 'true'):
            with self.subTest(uncertain_cleanup=cleanup):
                uncertain = copy.deepcopy(unowned); bad = dict(doc)
                if cleanup is None:
                    bad.pop('cleanup_complete')
                else:
                    bad['cleanup_complete'] = cleanup
                path = self.directory / 'uncertain-cleanup.json'; path.write_text(json.dumps(bad))
                uncertain['attempts'][-1]['results'][0]['worker_result'] = str(path)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller: adapter cleanup state unknown'):
                    c.retained_owners(uncertain, ['cloudbench-controller'])

    def test_actual_reconciliation_proof_unblocks_fresh_reexecution_without_credit(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        before_results = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][shas['receipt']]
        self.assertEqual((occurrence['id'], 'cloudbench-controller', proof['request_token'], shas['adapter'], shas['audit'], proof['owner']['turn_id']),
                         (entry['occurrence'], entry['gate'], entry['token'], entry['worker_result_sha256'], entry['native_audit_sha256'], entry['platform_turn_id']))
        self.assertEqual([], c.retained_owners(state, ['cloudbench-controller']))
        c.reexecute(state, occurrence['id'])
        self.assertEqual('needs-focused-plan', state['phase'])
        c.focused_plan(state, plan, {'source': state['source'], 'gates': {'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}}})
        with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
             patch.object(c, 'environment_digest', return_value=state['environment']), \
             patch.object(c, 'execute', return_value={'gate': 'cloudbench-controller', 'status': 'PASS', 'cases': {'cloudbench-controller': 'PASS'},
                                                      'complete': True, 'source': state['source'], 'command': gate['command'], 'log': 'x', 'native_exit': 0}) as launcher:
            c.run_phase(plan, state, self.directory, self.root)
        launcher.assert_called_once(); self.assertEqual(gate['command'], launcher.call_args.args[0]['command'])
        import hashlib
        self.assertEqual(shas, {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()})  # fixture files untouched
        self.assertEqual(before_results, state['attempts'][:1])  # the original outcome is immutable
        self.assertEqual('UNVERIFIED', state['attempts'][0]['results'][0]['cases']['cloudbench-controller'])
        # a newer receipt with a fresh owner re-blocks despite the earlier reconciliation
        state['attempts'].append({'phase': 'focused', 'results': [{'gate': 'cloudbench-controller', 'status': 'FAIL', 'complete': False,
                                  'cases': {'cloudbench-controller': 'UNVERIFIED'}, 'token': 'tok-new', 'lingering_group': True,
                                  'cleanup_owner': {'request_token': 'tok-new', 'worker_cleanup_owner': {'worker_thread': 'ph7dr8sexrfwqqprpv6m6m0byd8heees', 'turn_id': 'turn-new'}},
                                  'source': state['source'], 'log': 'y'}]})
        self.assertEqual(['cloudbench-controller'], c.retained_owners(state, ['cloudbench-controller']))

    def missing_identity_recon_state(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        original = {**proof['owner'], 'turn_id': None, 'message_id': None}
        adapter = c.read(paths['adapter']); adapter['cleanup_owner'] = original
        adapter['transport_receipt'].update(turn_id=None, message_id=None)
        c.write(paths['adapter'], adapter)
        receipt = state['attempts'][-1]['results'][0]
        receipt.update(lingering_group=True, cleanup_owner={
            'request_token': proof['request_token'], 'worker_cleanup_owner': original})
        c.write(paths['receipt'], receipt)
        proof.update(owner=original, receipt_sha256=c.sha_file(paths['receipt']),
                     worker_result_sha256=c.sha_file(paths['adapter']))
        send = paths['receipt'].parent / 'cached-send.json'
        c.write(send, {'schemaVersion': 1, 'ok': True, 'operation': 'send',
            'threadId': original['worker_thread'], 'disposition': 'started',
            'turnId': 'fake-turn-id', 'messageId': 'fake-message-id'})
        proof['send_receipt'] = {'path': str(send), 'sha256': c.sha_file(send)}
        return state, occurrence, paths, proof

    def test_missing_owner_identity_reconciles_only_hash_bound_same_turn_without_credit(self):
        state, occurrence, paths, proof = self.missing_identity_recon_state()
        before = copy.deepcopy(state['attempts'])
        original_files = {k: p.read_bytes() for k, p in paths.items()}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(proof['owner'], entry['owner'])
        self.assertIsNone(entry['owner']['turn_id']); self.assertIsNone(entry['owner']['message_id'])
        self.assertEqual('fake-turn-id', entry['resolved_owner']['turn_id'])
        self.assertEqual('fake-message-id', entry['resolved_owner']['message_id'])
        self.assertEqual(proof['send_receipt'], entry['proof']['send_receipt'])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([], c.retained_owners(state, ['cloudbench-controller']))
        self.assertEqual(before, state['attempts'])
        self.assertEqual(original_files, {k: p.read_bytes() for k, p in paths.items()})
        self.assertEqual('UNVERIFIED', state['attempts'][-1]['results'][0]['cases']['cloudbench-controller'])

    def test_missing_owner_identity_send_proof_refusals_are_atomic(self):
        state, occurrence, paths, proof = self.missing_identity_recon_state()
        before = copy.deepcopy(state)
        variants = [dict(proof, send_receipt={'path': proof['send_receipt']['path'], 'sha256': '0' * 64}),
                    {k: v for k, v in proof.items() if k != 'send_receipt'}]
        native = c.read(Path(proof['send_receipt']['path']))
        for key, value in [('ok', False), ('operation', 'read'), ('threadId', 'other'),
                           ('disposition', 'rejected'), ('turnId', 'other'), ('turnId', None),
                           ('messageId', None)]:
            path = paths['receipt'].parent / f'bad-{key}-{value}.json'
            c.write(path, {**native, key: value})
            variants.append({**proof, 'send_receipt': {'path': str(path), 'sha256': c.sha_file(path)}})
        for variant in variants:
            with self.subTest(proof=variant['send_receipt'] if 'send_receipt' in variant else None):
                with self.assertRaises(ValueError):
                    c.reconcile(state, occurrence['id'], variant)
                self.assertEqual(before, state)
        # A known identity is never replaced by a new platform send receipt.
        owner = {**proof['owner'], 'message_id': 'known-other'}
        adapter = c.read(paths['adapter']); adapter['cleanup_owner'] = owner; c.write(paths['adapter'], adapter)
        receipt = state['attempts'][-1]['results'][0]
        receipt['cleanup_owner']['worker_cleanup_owner'] = owner; c.write(paths['receipt'], receipt)
        known = {**proof, 'owner': owner, 'receipt_sha256': c.sha_file(paths['receipt']),
                 'worker_result_sha256': c.sha_file(paths['adapter'])}
        before = copy.deepcopy(state)
        with self.assertRaises(ValueError):
            c.reconcile(state, occurrence['id'], known)
        self.assertEqual(before, state)

    def native_recon_state(self):
        import hashlib
        import shutil
        import time
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, plan, gate, occurrence, paths, shas, old_proof = self.recon_state()
        gate['native_cloud'] = True
        token, source = old_proof['request_token'], state['source']
        runs = self.root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest() / 'runs'
        runs.mkdir(parents=True)
        hub = runs / '_hub/agent-link-server.8770.hub.owner'; hub.parent.mkdir()
        hub_owner = dict(version='1', status='live-transfer-required', pid='1234', pgid='1234',
            pid_start='proc-start:fixture:99', owner_token='hub', argv_sha256='c' * 64,
            root=str(runs), runs_root=str(runs), repo_root=str(self.root), context_dir=str(hub.parent),
            command=str(self.root / 'agents/benchmarks/agent_link_server.py'))
        def text_fields(path, values):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(''.join(f'{k}={v}\n' for k, v in values.items()))
        text_fields(hub, hub_owner)
        def tree_hash(folder):
            h = hashlib.sha256()
            for file in sorted(folder.rglob('*'), key=lambda p: str(p.relative_to(folder))):
                if file.is_file() and file.name != 'source-audit':
                    for value in (str(file.relative_to(folder)).encode(), file.read_bytes()):
                        h.update(len(value).to_bytes(8, 'big')); h.update(value)
            return h.hexdigest()
        files = [hub]
        fleets = []
        for ordinal, role in enumerate(('parent', 'canary')):
            fleet = runs / role; fleets.append(fleet)
            names = [gate['name']] if role == 'parent' else ['infra-probe']
            owner = str(ordinal + getattr(self, '_renewal_owner_offset', 1)) * 32
            audit = fleet / 'teardown-ownership'; audit.mkdir(parents=True)
            meta = dict(version='1', fleet_owner_token=owner, run_id=role, app='fixture',
                workspace_root=str(self.root), status='provider-teardown-verified',
                hub_disposition='retained-exact-owner-transfer-required', hub_owner_file=str(hub),
                hub_owner_token='hub', hub_pid='1234', hub_pid_start=hub_owner['pid_start'], hub_argv_sha256='c' * 64)
            text_fields(audit / 'meta', meta)
            (audit / 'provider-teardown-verified.epoch').write_text('1793665721\n')
            (audit / 'owned-clones.ids').write_text('machine1\n' if ordinal else '')
            (audit / 'owned-clones.names').write_text('clone1\n' if ordinal else '')
            if ordinal:
                text_fields(audit / 'fresh/clone1', dict(fleet_owner_token=owner, run_id=role, app='fixture',
                    source='fresh-clone', disposition='destroyed-provider-retained', machine_id='machine1',
                    volume_id='vol_fixture', clone_name='clone1'))
            for scaffold in ('pool', 'pool-handoffs', 'volume-migrations'):
                (audit / scaffold).mkdir()
            canonical = self.root / '.git/cloudbench-fleet-audits' / owner
            shutil.copytree(audit, canonical)
            seal = tree_hash(audit)
            text_fields(audit / 'source-audit', dict(path=str(canonical), sha256=seal))
            c.write(fleet / '_batch/lifecycle.json', dict(version=1, fleet_owner_token=owner, run_id=role,
                workspace_root=str(self.root), status='failed' if not ordinal else 'verified',
                controller_exit_code=1 if not ordinal else 0, audit_sha256=seal, hub_publication_failed=False))
            c.write(fleet / '_batch/run.json', dict(tasks=[], status='failed' if not ordinal else 'passed'))
            c.write(fleet / '_batch/disposable-cleanup.json', dict(schema='disposable-cleanup-v1', owner=owner,
                guest_cleanup_missing=False, runtime_evidence_missing=False, successful_runtime_inferred=False))
            matrix = build_task_matrix([name + '=real' for name in names])
            config = build_config('cloudbench-fleet-config-v1', ['task_count=1', 'task_matrix_sha256=' + matrix['sha256']])
            c.write(fleet / 'execution-task-matrix.json', matrix)
            c.write(fleet / 'execution-provenance.json', dict(schema_version='cloudbench-execution-provenance-v1',
                base_sha=source['head'], workspace_patch_sha256='none', config=config,
                controller_snapshot=dict(schema_version='cloudbench-controller-snapshot-v1', sha256='d' * 64)))
            (fleet / '_batch/benches.json').write_text(json.dumps([dict(name=name, mode='REAL') for name in names]))
            files.extend(p for p in fleet.rglob('*') if p.is_file())
            files.extend(p for p in canonical.rglob('*') if p.is_file())
        log, status = runs / 'detached-fixture.log', runs / 'detached-fixture.status'
        log.write_text(''.join(f'{self.root}/scripts/run-bench monitor {fleet} --controller-status {status}\n' for fleet in fleets))
        status.write_text('1\n')
        cli = runs.parent / 'cli.log'; cli.write_text(f'log: tail -f {log}\ncontroller exit marker: {status}\n')
        receipt = state['attempts'][-1]['results'][0]
        adapter = c.read(paths['adapter']); adapter.update(runner_log=str(cli), native_exit=1, started_at=1793664471.0)
        c.write(paths['adapter'], adapter)
        reference = dict(result=str(paths['adapter']), result_sha256=c.sha_file(paths['adapter']),
                         native_directory=None, cleanup_complete=False, native_evidence={})
        owner = dict(request_token=token, worker_root=str(self.root), native_cleanup_reference=reference)
        receipt.update(lifecycle='native-producer', native_cleanup_reference=reference, cleanup_owner=owner, lingering_group=True)
        c.write(paths['receipt'], receipt)
        request = paths['receipt'].parent / 'request.json'
        c.write(request, dict(token=token, source=source, gate=gate['name'], checks=[gate['name']]))
        files.extend([request, log, status, cli])
        proof = dict(kind='native-cloud-cleanup-v1', receipt_sha256=c.sha_file(paths['receipt']),
            worker_result_sha256=c.sha_file(paths['adapter']), owner=copy.deepcopy(owner), request_token=token,
            source=source, controller_log=str(log), confirmed_at=time.time(), observed_by='private-fixture',
            files={str(p): c.sha_file(p) for p in files})
        return state, occurrence, paths, proof, hub

    def prelaunch_campaign_state(self, historical_inventory_mismatch=False):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, hub = self.native_recon_state()
        runs = hub.parent.parent
        for item in list(runs.iterdir()):
            shutil.rmtree(item) if item.is_dir() else item.unlink()
        producer = self.root / 'scripts/run-bench-campaign.py'
        producer.parent.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / 'scripts/run-bench-campaign.py', producer)
        inventory_sources = ('scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
            'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-machine-readiness.py', 'scripts/cloudbench-campaign-machines.py')
        for relative in inventory_sources:
            target = self.root / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        historical = self.root / 'scripts/lib/cloudbench-env.sh'
        if historical_inventory_mismatch:
            historical.write_bytes(historical.read_bytes() + b'\n# different receipt-head inventory source\n')
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=t@x','commit','-qm','producer'],check=True)
        if historical_inventory_mismatch:
            shutil.copyfile(ROOT / 'scripts/lib/cloudbench-env.sh', historical)
        source = c.source(self.root)
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        campaign.mkdir(parents=True)
        receipt = state['attempts'][-1]['results'][0]
        adapter = c.read(paths['adapter'])
        start,finish = receipt['started_at'],receipt['finished_at']
        job = dict(job_id='r001-j0001',task=occurrence['gate'],run=1,attempt=1,attempts=[],status='cancelled',
                   controller_exit_code=None,started_at=None,log=str(campaign/'r001-j0001.log'))
        summary = dict(campaign_id=campaign.name,runs=1,retry_infra=0,task_count=1,total_jobs=1,concurrency=1,
            peak_concurrency=0,status='failed',jobs=[job],shared_inventory_failed=True,
            started_at=datetime.fromtimestamp(start,timezone.utc).isoformat(),finished_at=datetime.fromtimestamp(finish,timezone.utc).isoformat())
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        c.write(campaign/'hub-group-publication-ack.private.json',dict(pid=2147483000,token='d'*32,record_sha256=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()))
        relay=Path(tempfile.mkdtemp(prefix='cb-relay-')); self.addCleanup(shutil.rmtree,relay)
        c.write(campaign/'shared-relay-location.json',dict(directory=str(relay)))
        inventory=campaign/'shared-inventory';inventory.mkdir()
        scripts=inventory/'scripts';scripts.mkdir()
        for name,relative in [('cloudbench-campaign-inventory.sh','scripts/cloudbench-campaign-inventory.sh'),('cloudbench-inventory.sh','scripts/lib/cloudbench-inventory.sh'),('cloudbench-env.sh','scripts/lib/cloudbench-env.sh'),('cloudbench-machine-readiness.py','scripts/cloudbench-machine-readiness.py'),('cloudbench-campaign-machines.py','scripts/cloudbench-campaign-machines.py')]:
            shutil.copyfile(ROOT/relative,scripts/name)
        (inventory/'publisher.private.log').write_text('')
        (inventory/'stop').touch()
        (inventory/'machines-refresh.lock').write_text('host=fixture\npid=2147483001\npid_start=proc-start:fixture:123\ntoken=2147483001.fixture\n')
        cli=runs.parent/'cli.log'
        cli.write_text(f"Campaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live\nCampaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')\nsummary={campaign}/summary.json\n")
        request=paths['receipt'].parent/'request.json';req=c.read(request);req['source']=source;c.write(request,req)
        receipt['source']=source;adapter['source']=source;adapter['fleet_directory']=str(campaign)
        c.write(paths['adapter'],adapter)
        reference=receipt['native_cleanup_reference'];reference.update(native_directory=str(campaign),result_sha256=c.sha_file(paths['adapter']))
        receipt['cleanup_owner']['native_cleanup_reference']=reference;c.write(paths['receipt'],receipt)
        files=[request,cli,producer,*campaign.rglob('*')]
        files=[f for f in files if f.is_file()]
        proof.update(layout='campaign-prelaunch-v1',campaign=str(campaign),producer_source=str(producer),source=source,owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time(),files={str(f):c.sha_file(f) for f in files})
        proof.pop('controller_log')
        return state,occurrence,paths,proof,campaign

    def write_reviewed_producer_fixture(self, name, expected):
        import hashlib
        raw = subprocess.check_output(['git', '-C', str(ROOT), 'show',
                                       'e88057acfe64e279bf50188e3938df315e94ee49:' + name])
        self.assertEqual(expected, hashlib.sha256(raw).hexdigest())
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        return raw

    def ref_preflight_campaign_state(self):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, campaign = self.prelaunch_campaign_state()
        from deploy_test_native_ref_preflight import REVIEWED_SOURCES, SOURCES
        sources = SOURCES
        for relative, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(relative, expected)
            target = campaign / 'shared-inventory/scripts' / Path(relative).name
            if target.exists():
                target.write_bytes((self.root / relative).read_bytes())
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'ref-producer'], check=True)
        source = c.source(self.root)
        receipt = state['attempts'][-1]['results'][0]
        checks = [occurrence['gate']] + ['task-' + str(i) for i in range(1, 10)]
        cases = dict.fromkeys(checks, 'UNVERIFIED')
        start, finish = receipt['started_at'], receipt['finished_at']
        iso = lambda value: datetime.fromtimestamp(value, timezone.utc).isoformat()
        jobs = []
        marker = f"FATAL: requested benchmark commit {source['head']} is not fetchable from origin and local patch shipping is disabled"
        for index, check in enumerate(checks, 1):
            log = campaign / f'r001-j{index:04d}.log'
            log.write_text(marker + '\n')
            jobs.append(dict(job_id=f'r001-j{index:04d}', task=check, run=1, attempt=1, attempts=[], status='failed',
                             controller_exit_code=1, controller_pid=2147483100 + index,
                             started_at=iso(start + .1), finished_at=iso(finish - .1), log=str(log)))
        summary = dict(campaign_id=campaign.name, runs=1, retry_infra=0, task_count=10, total_jobs=10,
                       concurrency=10, peak_concurrency=10, status='failed', jobs=jobs,
                       started_at=iso(start), finished_at=iso(finish))
        c.write(campaign/'summary.json', summary)
        native = runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json', group)
        c.write(campaign/'hub-group-publication-ack.private.json', dict(pid=2147483000, token='d'*32,
                record_sha256=hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        live = Path(c.read(campaign/'shared-relay-location.json')['directory'])
        archive = campaign/'shared-relay'; archive.mkdir()
        stamp = 'proc-start:00000000-0000-0000-0000-000000000000:123'
        owner = dict(pid='2147483003', pid_start=stamp, parent_pid='2147483002', parent_start=stamp,
                     token='synthetic-publisher', app='synthetic-app')
        authority = dict(schema='shared-relay-authority-v1', app='synthetic-app', org_slug='fixture', network='',
                         parent_pid=2147483002, parent_start=stamp,
                         source_sha256=c.sha_file(self.root/'scripts/cloudbench-shared-relay.py'),
                         agent_socket=str(live/'fly-agent.sock'), inventory_directory=str(campaign/'shared-inventory'),
                         inventory_owner=owner, allowed_remote_ports=[8000], deadline=1000.0)
        c.write(archive/'authority.private.json', authority)
        digest = c.sha_file(archive/'authority.private.json')
        ready = dict(pid=2147483005, birth=stamp, authority_sha256=digest,
                     agent=dict(pid=2147483004, birth=stamp, version='fixture', socket_identity=[1, 2]),
                     socket=str(live/'control.sock'), fd_limit=1000)
        c.write(archive/'ready.json', ready)
        c.write(archive/'serve.once.json', dict(pid=ready['pid'], birth=stamp, authority_sha256=digest))
        for name, pid in [('bootstrap-owner.json',2147483006), ('broker-owner.json',ready['pid'])]:
            c.write(archive/name, dict(pid=pid, birth=stamp, parent_pid=authority['parent_pid'], parent_start=stamp))
        (archive/'broker.private.log').write_text('{"stopped": true}\n')
        (archive/'bootstrap.private.log').write_text('synthetic isolated bootstrap\n')
        for path in archive.iterdir(): shutil.copyfile(path, live/path.name)
        (campaign/'shared-inventory/machines-refresh.lock').unlink()
        (campaign.parent.parent/'cli.log').write_text(f'summary={campaign}/summary.json\n')
        request_path = paths['receipt'].parent/'request.json'
        request = c.read(request_path); request.update(source=source, checks=checks); c.write(request_path, request)
        adapter = c.read(paths['adapter']); adapter.update(source=source, cases=cases); c.write(paths['adapter'], adapter)
        receipt.update(source=source, cases=cases)
        receipt['native_cleanup_reference']['result_sha256'] = c.sha_file(paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference'] = receipt['native_cleanup_reference']
        c.write(paths['receipt'], receipt)
        files = [request_path, campaign.parent.parent/'cli.log', *campaign.rglob('*'), *live.rglob('*'),
                 self.root/'scripts/run-bench-campaign.py', *(self.root/p for p in sources)]
        proof.update(layout='campaign-ref-preflight-v1', source=source, owner=copy.deepcopy(receipt['cleanup_owner']),
                     receipt_sha256=c.sha_file(paths['receipt']), worker_result_sha256=c.sha_file(paths['adapter']),
                     confirmed_at=time.time(), files={str(p):c.sha_file(p) for p in files if p.is_file()})
        return state, occurrence, paths, proof, campaign, live

    def test_ref_preflight_started_controllers_have_no_native_allocation_credit(self):
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        before = copy.deepcopy(state)
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before['attempts'], state['attempts'])
        self.assertEqual(before['failures'], state['failures'])
        entry = next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([], entry['participants'])
        self.assertEqual([], entry['retained_services'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))

    def test_ref_preflight_rejects_forged_lifecycle_source_and_prefix_without_state_mutation(self):
        import shutil
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        originals = {Path(p):Path(p).read_bytes() for p in proof['files']}
        log = campaign/'r001-j0001.log'
        for mutation in ('purpose', 'prefix', 'wrong-ref', 'native-handle', 'attempt', 'nonterminal', 'boolean-exit',
                         'source', 'no-shutdown', 'numeric-shutdown', 'live-agent', 'live-bootstrap', 'live-publisher',
                         'inventory-owner', 'no-stop', 'unacknowledged', 'foreign-hash'):
            with self.subTest(mutation=mutation):
                candidate = copy.deepcopy(proof)
                try:
                    if mutation=='purpose': candidate['purpose']='isolated-validation'
                    if mutation=='prefix': log.write_text('forged-prefix '+originals[log].decode())
                    if mutation=='wrong-ref': log.write_text(originals[log].decode().replace(proof['source']['head'],'a'*40))
                    if mutation=='native-handle': log.write_text(f'{self.root}/scripts/run-bench monitor /tmp/foreign\n'+originals[log].decode())
                    if mutation in ('attempt','nonterminal','boolean-exit'):
                        value=c.read(campaign/'summary.json')
                        if mutation=='attempt': value['jobs'][0]['attempts']=[{'run_dir':'foreign'}]
                        elif mutation=='nonterminal': value['jobs'][0]['controller_exit_code']=None
                        else: value['jobs'][0]['controller_exit_code']=True
                        c.write(campaign/'summary.json',value)
                    if mutation=='source': (self.root/'scripts/run-bench-fleet').write_text('changed producer')
                    if mutation in ('no-shutdown', 'numeric-shutdown'):
                        response='{}\n' if mutation=='no-shutdown' else '{"stopped": 1}\n'
                        (campaign/'shared-relay/broker.private.log').write_text(response)
                        (live/'broker.private.log').write_text(response)
                    if mutation.startswith('live-'):
                        from deploy_test_native_ref_preflight import process_birth
                        ready=c.read(campaign/'shared-relay/ready.json')
                        if mutation=='live-agent': ready['agent'].update(pid=os.getpid(),birth=process_birth(os.getpid()))
                        if mutation=='live-bootstrap':
                            value=c.read(campaign/'shared-relay/bootstrap-owner.json');value.update(pid=os.getpid(),birth=process_birth(os.getpid()))
                            c.write(campaign/'shared-relay/bootstrap-owner.json',value)
                        if mutation=='live-publisher':
                            authority=c.read(campaign/'shared-relay/authority.private.json')
                            authority['inventory_owner'].update(pid=str(os.getpid()),pid_start=process_birth(os.getpid()))
                            c.write(campaign/'shared-relay/authority.private.json',authority)
                            digest=c.sha_file(campaign/'shared-relay/authority.private.json')
                            ready['authority_sha256']=digest
                            once=c.read(campaign/'shared-relay/serve.once.json');once['authority_sha256']=digest
                            c.write(campaign/'shared-relay/serve.once.json',once)
                        c.write(campaign/'shared-relay/ready.json',ready)
                        for p in (campaign/'shared-relay').iterdir(): shutil.copyfile(p,live/p.name)
                    if mutation=='inventory-owner': (campaign/'shared-inventory/owner').write_text('live owner')
                    if mutation=='no-stop': (campaign/'shared-inventory/stop').unlink()
                    if mutation=='unacknowledged': (campaign/'hub-group-publication-ack.private.json').unlink()
                    candidate['files']={str(p):c.sha_file(p) for p in originals if p.exists()}
                    if mutation=='foreign-hash': candidate['files'][str(log)]='0'*64
                    snapshot=copy.deepcopy(state)
                    with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(snapshot,state)
                finally:
                    (campaign/'shared-inventory/owner').unlink(missing_ok=True)
                    for path,data in originals.items(): path.write_bytes(data)

    def test_ref_preflight_rejects_unreviewed_source_order_even_with_matching_receipts(self):
        import deploy_test_native_ref_preflight as ref
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        before = copy.deepcopy(state)
        with patch.dict(ref.REVIEWED_SOURCES, {'scripts/run-bench-fleet': '0'*64}):
            with self.assertRaisesRegex(ValueError, 'producer source changed'):
                c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_ref_preflight_requires_full_head_before_io(self):
        from deploy_test_native_ref_preflight import validate_ref_preflight
        for head in ('HEAD','a'*39,'--output=foreign',None):
            with self.subTest(head=head), patch('subprocess.check_output') as process:
                with self.assertRaisesRegex(ValueError,'ref preflight receipt head invalid'):
                    validate_ref_preflight({'source':{'head':head}},None,{},None,None,None,None,None,None)
                process.assert_not_called()

    def test_native_prelaunch_reconciliation_preserves_failure_and_grants_only_retry(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        before=copy.deepcopy(state['attempts'])
        c.reconcile(state,occurrence['id'],proof)
        self.assertEqual(before,state['attempts'])
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([],entry['participants'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

    def test_native_prelaunch_reconciliation_accepts_quiescent_stale_attempt_token(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        state.update(phase='stale',failures=[])
        state.pop('pending',None)
        state['attempts'][-1].update(stale=True)
        state['attempts'][-1].pop('interrupted',None)
        receipt=state['attempts'][-1]['results'][0]
        state['source']=receipt['source']
        before=copy.deepcopy(state['attempts'])
        c.reconcile(state,receipt['token'],proof)
        self.assertEqual(before,state['attempts'])
        self.assertEqual([],state['failures'])
        self.assertFalse(next(iter(state['reconciled_owners'].values()))['credit_granted'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

        for mutation in ('not-stale', 'running', 'live-failures', 'wrong-token'):
            with self.subTest(mutation=mutation):
                bad=copy.deepcopy(state)
                bad.pop('reconciled_owners',None)
                token=receipt['token']
                if mutation=='not-stale':bad['attempts'][-1]['stale']=False
                if mutation=='running':bad['running']={'gate':occurrence['gate']}
                if mutation=='live-failures':bad['live_failures']=[]
                if mutation=='wrong-token':token='unrelated-token'
                snapshot=copy.deepcopy(bad)
                with self.assertRaises(ValueError):c.reconcile(bad,token,proof)
                self.assertEqual(snapshot,bad)

    def test_native_prelaunch_inventory_must_match_receipt_head_not_only_checkout(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state(historical_inventory_mismatch=True)
        snapshot=copy.deepcopy(state)
        with self.assertRaises(ValueError):
            c.reconcile(state,occurrence['id'],proof)
        self.assertEqual(snapshot,state)

    def test_native_prelaunch_rejects_noncleanup_purpose_without_mutation(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        for purpose in ('isolated-validation', 'unexpected-purpose', {'unexpected': True}):
            with self.subTest(purpose=purpose):
                candidate=copy.deepcopy(proof); candidate['purpose']=purpose
                snapshot=copy.deepcopy(state)
                with self.assertRaises(ValueError):
                    c.reconcile(state,occurrence['id'],candidate)
                self.assertEqual(snapshot,state)

    def test_native_prelaunch_rejects_invalid_git_head_before_io(self):
        from deploy_test_native_prelaunch import validate_prelaunch
        for head in ('', 'HEAD', '--output=/tmp/untrusted', 'a' * 39, None):
            with self.subTest(head=head), patch('subprocess.check_output') as process:
                with self.assertRaisesRegex(ValueError, 'prelaunch receipt head invalid'):
                    validate_prelaunch({'source': {'head': head}}, None, {}, None,
                                       None, None, None, None, None)
                process.assert_not_called()

    def test_native_prelaunch_accepts_explicit_null_cleanup_purpose(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        proof['purpose']=None
        c.reconcile(state,occurrence['id'],proof)
        entry=state['reconciled_owners'][proof['receipt_sha256']]
        self.assertIsNone(entry.get('purpose'))
        self.assertFalse(entry['credit_granted'])
        self.assertTrue(entry['prelaunch_no_allocation'])

    def test_native_prelaunch_proof_rejects_started_job_or_missing_positive_failure(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        for mutation in ('started','no-failure','not-stopped','relay-created','live-publisher','changed-source','admitted-controller'):
            with self.subTest(mutation=mutation):
                summary=campaign/'summary.json';original=summary.read_bytes()
                stop=campaign/'shared-inventory/stop'
                relay=Path(c.read(campaign/'shared-relay-location.json')['directory'])
                cli=campaign.parent.parent/'cli.log';cli_original=cli.read_bytes()
                lock=campaign/'shared-inventory/machines-refresh.lock';lock_original=lock.read_bytes()
                producer=Path(proof['producer_source']);producer_original=producer.read_bytes()
                admitted=campaign.parent.parent/'runs/admitted'
                try:
                    if mutation=='started':
                        value=c.read(summary);value['jobs'][0]['controller_pid']=23456;c.write(summary,value)
                    if mutation=='no-failure': cli.write_text('generic inventory failure')
                    if mutation=='not-stopped':stop.unlink()
                    if mutation=='relay-created':(relay/'broker-owner.json').write_text('{}')
                    if mutation=='live-publisher':lock.write_text(f'host=fixture\npid={os.getpid()}\npid_start=proc-start:fixture:123\ntoken={os.getpid()}.fixture\n')
                    if mutation=='changed-source':producer.write_text('changed')
                    if mutation=='admitted-controller':admitted.mkdir()
                    bad=copy.deepcopy(proof)
                    bad['files']={path:c.sha_file(Path(path)) for path in proof['files'] if Path(path).is_file()}
                    snapshot=copy.deepcopy(state)
                    with self.assertRaises(ValueError):c.reconcile(state,occurrence['id'],bad)
                    self.assertEqual(snapshot,state)
                finally:
                    summary.write_bytes(original);cli.write_bytes(cli_original);stop.touch()
                    (relay/'broker-owner.json').unlink(missing_ok=True)
                    lock.write_bytes(lock_original);producer.write_bytes(producer_original)
                    if admitted.exists():admitted.rmdir()

    def test_native_cloud_cleanup_overlay_preserves_failed_execution_and_retained_hub(self):
        state, occurrence, paths, proof, hub = self.native_recon_state()
        before = copy.deepcopy(state['attempts'])
        original = {str(p): p.read_bytes() for p in [*paths.values(), *map(Path, proof['files'])]}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertFalse(entry['credit_granted']); self.assertEqual(proof['owner'], entry['owner'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual('live-transfer-required', entry['retained_services'][0]['owner']['status'])
        self.assertEqual(str(hub), entry['retained_services'][0]['path'])
        self.assertEqual('triage', state['phase']); self.assertEqual(before, state['attempts'])
        self.assertEqual(original, {str(p): p.read_bytes() for p in map(Path, original)})
        changed_owner = {**proof['owner'], 'native_cleanup_reference': {'changed': True}}
        self.assertFalse(c._reconciled(state, state['attempts'][-1]['results'][0], changed_owner))
        hub.write_text(hub.read_text().replace('pid=1234', 'pid=9999'))
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_native_cloud_cleanup_finds_fleet_audits_in_a_linked_worktrees_common_git_dir(self):
        """2026-11-07: a deploy worktree's .git is a file; the fleet keeps audits and ownership registries
        under the git common dir."""
        import deploy_test_native_cleanup as n
        main = self.root / 'main-checkout'
        main.mkdir()
        git = lambda *a: subprocess.run(['git', '-C', str(main), *a], check=True, capture_output=True)
        git('init', '-q')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
        linked = self.root / 'linked-worktree'
        git('worktree', 'add', '-q', '--detach', str(linked))
        common = (main / '.git').resolve() / 'cloudbench-fleet-audits'
        self.assertTrue((linked / '.git').is_file())
        self.assertEqual(common, n.fleet_audit_root(linked.resolve()))
        self.assertEqual(common, n.fleet_audit_root(main.resolve()))
        # The retained-registry refusal must look where the fleet writes it, or it passes vacuously.
        registries = common.parent / 'cloudbench-fleet-ownership'
        self.assertEqual(registries, n.fleet_ownership_root(linked.resolve()))
        self.assertEqual(registries, n.fleet_ownership_root(main.resolve()))
        for module in ('deploy_test_native_cleanup.py', 'deploy_test_interrupted_cleanup.py'):
            self.assertNotIn("'.git/cloudbench-fleet-", (ROOT / 'scripts' / module).read_text(), module)

    def test_native_cloud_cleanup_refuses_a_retained_fleet_registry_in_the_common_git_dir(self):
        """Negative control: a fleet ownership registry still present where run-bench-fleet keeps it
        (GIT_COMMON_DIR/cloudbench-fleet-ownership) refuses reconciliation; it is never vacuously absent."""
        import deploy_test_native_cleanup as n
        state, occurrence, paths, proof, hub = self.native_recon_state()
        lives = [Path(p) for p in proof['files'] if p.endswith('/_batch/lifecycle.json')]
        token = json.loads(lives[0].read_text())['fleet_owner_token']
        registry = n.fleet_ownership_root(self.root) / token
        registry.mkdir(parents=True)
        (registry / 'meta').write_text('fleet_owner_token=' + token + '\n')
        with self.assertRaisesRegex(ValueError, 'registry still retained'):
            c.reconcile(copy.deepcopy(state), occurrence['id'], proof)

    def test_native_cloud_cleanup_binds_a_fleet_run_record_beyond_the_receipt_cap(self):
        """2026-11-07: a mass-agent _batch/run.json (98 MB) exceeded the 64 MiB receipt cap, so a verified
        fleet cleanup could never be reconciled and every later smoke launch was refused."""
        import hashlib
        import deploy_test_native_cleanup as n
        state, occurrence, paths, proof, hub = self.native_recon_state()
        records = [Path(p) for p in proof['files'] if p.endswith('/_batch/run.json')]
        self.assertTrue(records)
        cap = max([Path(p).stat().st_size for p in proof['files'] if not p.endswith('/_batch/run.json')]
                  + [paths['receipt'].stat().st_size, paths['adapter'].stat().st_size])
        for record in records:
            value = json.loads(record.read_text())
            # Native run size comes from per-task log arrays, not retained metadata.
            value['tasks'] = [dict(logs={'worker_logs': ['x' * 512] * (cap // 512 + 1)})]
            record.write_text(json.dumps(value))
            proof['files'][str(record)] = hashlib.sha256(record.read_bytes()).hexdigest()
        with patch.object(c, 'MAX_RECEIPT_BYTES', cap):
            reconciled = copy.deepcopy(state)
            c.reconcile(reconciled, occurrence['id'], proof)
            self.assertEqual([], c.retained_owners(reconciled, [occurrence['gate']]))
            with patch.object(n, 'RUN_RECORD_MAX_BYTES', cap), self.assertRaisesRegex(ValueError, 'proof file too large'):
                c.reconcile(copy.deepcopy(state), occurrence['id'], proof)

    def campaign_recon_state(self):
        import hashlib
        import shutil
        import time
        from datetime import datetime, timezone
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, occurrence, paths, proof, hub = self.native_recon_state()
        runs = hub.parent.parent
        request_path = paths['receipt'].parent / 'request.json'
        request = c.read(request_path)
        names = [request['gate'], *['task-' + str(i) for i in range(2, 15)]]
        template = runs / 'parent'
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        campaign.mkdir(parents=True)
        parents, jobs = [], []
        for index, name in enumerate(names, 1):
            fleet = runs / ('20261103-080440-' + str(310000 + index))
            shutil.copytree(template, fleet)
            token = f'{index + getattr(self, "_renewal_campaign_offset", 10):032x}'
            audit = fleet / 'teardown-ownership'
            (audit / 'source-audit').unlink()
            meta = (audit / 'meta').read_text().replace('run_id=parent', 'run_id=' + fleet.name)
            meta = meta.replace('fleet_owner_token=' + str(getattr(self, '_renewal_owner_offset', 1)) * 32, 'fleet_owner_token=' + token)
            (audit / 'meta').write_text(meta)
            h = hashlib.sha256()
            for file in sorted(audit.rglob('*'), key=lambda q: str(q.relative_to(audit))):
                if file.is_file():
                    for value in (str(file.relative_to(audit)).encode(), file.read_bytes()):
                        h.update(len(value).to_bytes(8, 'big')); h.update(value)
            canonical = self.root / '.git/cloudbench-fleet-audits' / token
            shutil.copytree(audit, canonical)
            (audit / 'source-audit').write_text(f'path={canonical}\nsha256={h.hexdigest()}\n')
            life = c.read(fleet / '_batch/lifecycle.json')
            life.update(run_id=fleet.name, fleet_owner_token=token, audit_sha256=h.hexdigest())
            c.write(fleet / '_batch/lifecycle.json', life)
            disposable = c.read(fleet / '_batch/disposable-cleanup.json'); disposable['owner'] = token
            c.write(fleet / '_batch/disposable-cleanup.json', disposable)
            (fleet / '_batch/benches.json').write_text(json.dumps([dict(name=name, mode='REAL')]))
            matrix = build_task_matrix([name + '=real'])
            provenance = c.read(fleet / 'execution-provenance.json')
            provenance['config'] = build_config('cloudbench-fleet-config-v1',
                ['task_count=1', 'task_matrix_sha256=' + matrix['sha256']])
            c.write(fleet / 'execution-task-matrix.json', matrix)
            c.write(fleet / 'execution-provenance.json', provenance)
            log = campaign / f'r001-j{index:04d}.log'
            handles = [fleet] + ([runs / 'canary'] if index == 3 else [])
            log.write_text(''.join(f'{self.root}/scripts/run-bench monitor {f}\n' for f in handles))
            jobs.append(dict(job_id=log.stem, task=name, run=1, attempt=1, attempts=[],
                status='failed' if index == 6 else 'cancelled', controller_exit_code=1,
                controller_pid=310000 + index, log=str(log)))
            parents.append(fleet)
        shutil.rmtree(template)
        for f in runs.glob('detached-*'): f.unlink()
        summary = dict(campaign_id=campaign.name, runs=1, retry_infra=0, task_count=14,
            total_jobs=14, concurrency=14, peak_concurrency=14, status='failed', jobs=jobs, wall_clock_seconds=1,
            started_at=datetime.fromtimestamp(1793664472, timezone.utc).isoformat(),
            finished_at=datetime.fromtimestamp(1793664473, timezone.utc).isoformat())
        c.write(campaign / 'summary.json', summary)
        import runpy
        native = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(campaign / 'hub-group.json', group)
        c.write(campaign / 'hub-group-publication-ack.private.json', dict(pid=2147483000, token='d' * 32,
            record_sha256=hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        cli = runs.parent / 'cli.log'; cli.write_text(f'Native campaign {campaign}\n')
        request['checks'] = names; c.write(request_path, request)
        receipt = state['attempts'][-1]['results'][0]
        receipt['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        receipt['case_complete'] = dict.fromkeys(names, False)
        adapter = c.read(paths['adapter']); adapter['cases'] = receipt['cases']; c.write(paths['adapter'], adapter)
        reference = receipt['native_cleanup_reference']
        reference.update(native_directory=str(campaign), result_sha256=c.sha_file(paths['adapter']))
        receipt['cleanup_owner']['native_cleanup_reference'] = reference
        c.write(paths['receipt'], receipt)
        gate = next(g for g in state['plan']['gates'] if g['name'] == occurrence['gate']); gate['checks'] = names
        proof.update(layout='campaign-v1', campaign=str(campaign), owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']), worker_result_sha256=c.sha_file(paths['adapter']),
            confirmed_at=time.time())
        proof.pop('controller_log')
        files = [hub, request_path, cli, *campaign.glob('*.json'), *campaign.glob('*.log')]
        for fleet in [*parents, runs / 'canary']:
            files.extend(p for p in fleet.rglob('*') if p.is_file())
            token = c.read(fleet / '_batch/lifecycle.json')['fleet_owner_token']
            files.extend(p for p in (self.root / '.git/cloudbench-fleet-audits' / token).rglob('*') if p.is_file())
        proof['files'] = {str(p): c.sha_file(p) for p in files}
        return state, occurrence, paths, proof, parents

    def unlaunched_campaign_state(self):
        import shutil
        import runpy
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        campaign = Path(proof['campaign'])
        runs = parents[0].parent
        for child in runs.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        summary = c.read(campaign / 'summary.json')
        summary.update(peak_concurrency=0, shared_inventory_failed=True)
        for job in summary['jobs']:
            Path(job['log']).unlink()
            job.update(status='cancelled', controller_exit_code=None, started_at=None,
                       finished_at=None, wall_clock_seconds=None)
            job.pop('controller_pid', None)
        c.write(campaign / 'summary.json', summary)
        native = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(campaign / 'hub-group.json', group)
        import hashlib
        c.write(campaign / 'hub-group-publication-ack.private.json', dict(pid=2147483000,
            token='d' * 32, record_sha256=hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        inventory = campaign / 'shared-inventory'
        inventory.mkdir()
        (inventory / 'stop').touch()
        (inventory / 'publisher.private.log').write_text('read-only inventory startup failed\n')
        (campaign / 'hub-group-publication.private.log').write_text('published\n')
        cli = runs.parent / 'cli.log'
        cli.write_text(f"Native campaign {campaign}\nFileNotFoundError: [Errno 2] No such file or directory: 'flyctl'\n")
        proof['layout'] = 'campaign-unlaunched-v1'
        files = [paths['receipt'].parent / 'request.json', cli, *campaign.glob('*.json'),
                 inventory / 'stop', inventory / 'publisher.private.log',
                 campaign / 'hub-group-publication.private.log']
        proof['files'] = {str(p): c.sha_file(p) for p in files}
        return state, occurrence, paths, proof, campaign

    def inventory_init_failure_state(self):
        import hashlib
        # The validator supports only the exact producer that hit the original failure; read those
        # bytes from that source commit, not from the current tree (later syncs change producers).
        def original(relative):
            return subprocess.check_output(['git', '-C', str(ROOT), 'show',
                                            INVENTORY_INIT_PRODUCER_SOURCE + ':' + relative])
        state, occurrence, paths, proof, campaign = self.unlaunched_campaign_state()
        inventory = campaign / 'shared-inventory'
        for relative in ('scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
                         'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-campaign-machines.py',
                         'scripts/cloudbench-machine-readiness.py', 'scripts/run-bench-campaign.py',
                         'scripts/run-bench',
                         'scripts/cloudbench_catalog.py',
                         'scripts/cloudbench-timeout-policy.py',
                         'scripts/cloudbench-shard-coordinator.py',
                         'agents/benchmarks/benchmark_tasks.py',
                         'agents/benchmarks/fixtures.py',
                         'agents/benchmarks/live_fixtures.py',
                         'agents/benchmarks/polar_catalog.py',
                         'agents/benchmarks/timeout_history.py',
                         'agents/benchmarks/history_ledger.py',
                         'scripts/cloudbench-provider-capacity.py',
                         'scripts/cloudbench-production-only-tasks.py',
                         'scripts/cloudbench-campaign-seed.py',
                         'agents/benchmarks/hub_upload.py',
                         'scripts/cloudbench-scorecard.py',
                         'scripts/cloudbench_experiments.py',
                         'scripts/cloudbench-port-lease.py'):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(original(relative))
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts', 'agents'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'native publisher source'], check=True)
        head = c.source(self.root)['head']
        # The native source reader binds a real fixture commit; no git reader is mocked.
        source = dict(head=head, digest=c.source(self.root)['digest'])
        publisher = inventory / 'scripts'; publisher.mkdir()
        for relative in ('scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
                         'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-campaign-machines.py',
                         'scripts/cloudbench-machine-readiness.py'):
            (publisher / Path(relative).name).write_bytes(original(relative))
        log = inventory / 'publisher.private.log'
        log.write_text('[warn] FLY_COMPLETION_TIMEOUT shell_pid=2147483002 shell_start_ticks=18368956 fly_return_status=unknown fifo_read_status=142\n❌ shared inventory snapshot did not initialize\n')
        diagnostic = inventory / 'inventory-refresh-diagnostics'; diagnostic.mkdir()
        (diagnostic / 'latest').write_text('phase=volumes-list\nstatus=142\nepoch=1793664473\nelapsed_seconds=32\npid=2147483003\npublisher_token=fixture\n')
        (diagnostic / 'history').write_text('1793664473\tvolumes-list\t142\t32\n')
        (diagnostic / 'failure.raw.private').write_bytes(b'')
        cli = Path(paths['adapter']).parent  # the existing fixture owns all paths
        request = c.read(paths['receipt'].parent / 'request.json')
        receipt = c.read(paths['receipt']); adapter = c.read(paths['adapter'])
        request['source'] = source; receipt['source'] = source; adapter['source'] = source; proof['source'] = source
        c.write(paths['receipt'].parent / 'request.json', request)
        runs = Path(adapter['runner_log']).parent / 'runs'
        command = ['bash', 'scripts/run-bench', *request['checks'], '--runs', '1', '--concurrency', '4', '--retry-infra', '0', '--ref', request['source']['head']]
        adapter.update(native_exit=1, complete=False, cleanup_complete=False, native_command=command)
        c.write(paths['adapter'], adapter)
        receipt['native_cleanup_reference']['result_sha256'] = c.sha_file(paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference'] = receipt['native_cleanup_reference']
        c.write(paths['receipt'], receipt)
        Path(adapter['runner_log']).write_text(f'Campaign inventory did not initialize; see private publisher log\n{campaign}\n')
        c.write(runs.parent / 'cli.log.process.json', dict(supervisor_pid=2147483000, child_pid=2147483001,
            native_exit=1, cancelled=False, timed_out=False, quiescent=True, orphaned_children=False,
            reaped=[dict(pid=2147483001, status=256)], term_sent=[], kill_sent=[], remaining=[], error=None))
        proof.update(layout='campaign-inventory-init-failure-v1', owner=receipt['cleanup_owner'],
                     receipt_sha256=c.sha_file(paths['receipt']), worker_result_sha256=c.sha_file(paths['adapter']))
        proof['files'] = {str(path): c.sha_file(path) for path in
            [paths['receipt'].parent / 'request.json', Path(adapter['runner_log']), runs.parent / 'cli.log.process.json',
             *campaign.glob('*.json'), campaign / 'hub-group-publication.private.log',
             inventory / 'stop', log, *publisher.iterdir(), *diagnostic.iterdir()]}
        state['attempts'][-1]['results'][0] = receipt
        return state, occurrence, paths, proof, campaign

    def test_inventory_init_failure_retirement_keeps_every_outcome_unverified(self):
        import deploy_test_native_cleanup as native
        state, occurrence, paths, proof, campaign = self.inventory_init_failure_state()
        receipt = c.read(paths['receipt'])
        before = copy.deepcopy(receipt)
        original_attempts = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        result = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(state['attempts'], original_attempts)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(result['participants'], [])
        self.assertEqual(receipt, before)
        self.assertEqual(set(receipt['cases'].values()), {'UNVERIFIED'})

    def test_inventory_init_failure_rejects_changed_precampaign_entrypoints(self):
        import deploy_test_native_cleanup as native
        # The changed wrapper is committed as source evidence and never executed.
        target = self.root / 'scripts/run-bench'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('# Untrusted pre-campaign operation; never executed by this test.\n')
        state, occurrence, paths, proof, campaign = self.inventory_init_failure_state()
        receipt = c.read(paths['receipt'])
        committed = subprocess.check_output(['git', '-C', str(self.root), 'show',
                                             receipt['source']['head'] + ':scripts/run-bench'])
        self.assertEqual(committed, target.read_bytes())
        with self.assertRaisesRegex(ValueError, 'inventory init unsupported producer'):
            native.validate(receipt, receipt['cleanup_owner'], proof)

    def test_inventory_init_failure_refuses_admission_unknown_owner_and_changed_source(self):
        import deploy_test_native_cleanup as native
        state, occurrence, paths, proof, campaign = self.inventory_init_failure_state()
        adapter = c.read(paths['adapter']); runs = Path(adapter['runner_log']).parent / 'runs'
        original = {Path(path): Path(path).read_bytes() for path in proof['files']}
        original[paths['receipt']] = paths['receipt'].read_bytes()
        original[paths['adapter']] = paths['adapter'].read_bytes()
        supervisor = runs.parent / 'cli.log.process.json'
        def edit(path, **values):
            doc = c.read(path); doc.update(values); c.write(path, doc)
        changes = [
            ('participant', lambda: (runs / 'unexpected').mkdir()),
            ('owner', lambda: (campaign / 'shared-inventory/owner').write_text('live')),
            ('unknown-supervisor', lambda: edit(supervisor, quiescent=False)),
            ('orphan', lambda: edit(supervisor, orphaned_children=True)),
            ('live-process', lambda: edit(supervisor, supervisor_pid=os.getpid())),
            ('source-bytes', lambda: (campaign / 'shared-inventory/scripts/cloudbench-inventory.sh').write_text('changed')),
            ('source-identity', lambda: edit(paths['receipt'], source={'head': 'b' * 40})),
            ('native-outcome', lambda: edit(paths['adapter'], cases={'fixture': 'PASS'})),
        ]
        for name, change in changes:
            for path, data in original.items(): path.write_bytes(data)
            for added in (runs / 'unexpected', campaign / 'shared-inventory/owner'):
                if added.is_dir(): added.rmdir()
                elif added.exists(): added.unlink()
            change()
            current = copy.deepcopy(proof)
            if name == 'native-outcome':
                receipt = c.read(paths['receipt'])
                receipt['cases'] = c.read(paths['adapter'])['cases']
                receipt['native_cleanup_reference']['result_sha256'] = c.sha_file(paths['adapter'])
                receipt['cleanup_owner']['native_cleanup_reference'] = receipt['native_cleanup_reference']
                c.write(paths['receipt'], receipt)
                current['owner'] = receipt['cleanup_owner']
                current['worker_result_sha256'] = c.sha_file(paths['adapter'])
            current['files'] = {str(path): c.sha_file(path) for path in original if str(path) in proof['files']}
            current['receipt_sha256'] = c.sha_file(paths['receipt'])
            with self.subTest(case=name), self.assertRaises(ValueError):
                native.validate(c.read(paths['receipt']), c.read(paths['receipt'])['cleanup_owner'], current)
        for path, data in original.items(): path.write_bytes(data)
        log = campaign / 'shared-inventory/publisher.private.log'
        with log.open('ab'), self.assertRaisesRegex(ValueError, 'startup log writer'):
            native.validate(c.read(paths['receipt']), c.read(paths['receipt'])['cleanup_owner'], proof)

    def test_unlaunched_campaign_reconciles_without_test_credit(self):
        state, occurrence, paths, proof, campaign = self.unlaunched_campaign_state()
        original = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual(original, state['attempts'])
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([], entry['participants'])

    def test_unlaunched_campaign_rejects_admission_or_active_writer(self):
        state, occurrence, paths, proof, campaign = self.unlaunched_campaign_state()
        summary = campaign / 'summary.json'
        original = c.read(summary)
        for field, value in [('peak_concurrency', 1), ('startup_cohorts', [{'prepared': True}])]:
            changed = {**original, field: value}
            c.write(summary, changed); proof['files'][str(summary)] = c.sha_file(summary)
            with self.subTest(field=field), self.assertRaises(ValueError):
                c.reconcile(state, occurrence['id'], proof)
        c.write(summary, original); proof['files'][str(summary)] = c.sha_file(summary)
        with (campaign / 'shared-inventory/publisher.private.log').open('a'):
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        job = campaign / 'r001-j0001.log'
        job.write_text('controller was admitted\n')
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)

    def unlaunched_relay_state(self):
        import shutil
        state, occurrence, paths, proof, campaign = self.unlaunched_campaign_state()
        temporary = tempfile.TemporaryDirectory(prefix='cb-relay-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        prefix = 'proc-start:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':'
        authority = dict(parent_pid=2147483000, parent_start=prefix + '1',
            agent_socket=str(directory / 'fly-agent.sock'), inventory_directory=str(campaign / 'shared-inventory'))
        c.write(directory / 'authority.private.json', authority)
        c.write(directory / 'startup-cleanup.json', dict(bootstrap_joined=True, broker_joined=True,
            agent_shutdown_verified=False, agent_retirement_pending=True))
        for role in ('bootstrap', 'broker'):
            c.write(directory / (role + '-owner.json'), dict(pid=2147483001, birth=prefix + '2',
                parent_pid=authority['parent_pid'], parent_start=authority['parent_start']))
            (directory / (role + '.private.log')).write_text('unsupported Fly agent version\n')
        archive = campaign / 'shared-relay'
        shutil.copytree(directory, archive)
        c.write(campaign / 'shared-relay-location.json', dict(directory=str(directory)))
        cli = Path(c.read(paths['adapter'])['runner_log'])
        cli.write_text(f'Native campaign {campaign}\nValueError: shared transport broker did not initialize\n')
        proof.update(layout='campaign-unlaunched-relay-v1')
        proof['files'].update({str(p): c.sha_file(p) for p in [campaign / 'shared-relay-location.json',
            *directory.iterdir(), *archive.iterdir(), cli]})
        return state, occurrence, proof, directory

    def test_unlaunched_relay_reconciles_retired_startup_without_test_credit(self):
        state, occurrence, proof, directory = self.unlaunched_relay_state()
        original = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual(original, state['attempts'])
        self.assertFalse(state['reconciled_owners'][proof['receipt_sha256']]['credit_granted'])

    def test_unlaunched_relay_refuses_an_unsealed_live_agent(self):
        state, occurrence, proof, directory = self.unlaunched_relay_state()
        child = subprocess.Popen([sys.executable, '-c',
            "import ctypes,sys;ctypes.CDLL(None).prctl(15,b'flyctl',0,0,0);print('ready',flush=True);sys.stdin.read()"],
            env={**os.environ, 'FLY_AGENT_SOCKET_PATH': str(directory / 'fly-agent.sock')},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual('ready', child.stdout.readline().strip())
            with self.assertRaisesRegex(ValueError, 'unsealed startup agent remains'):
                c.reconcile(state, occurrence['id'], proof)
        finally:
            child.stdin.close();child.wait(timeout=10);child.stdout.close()
        c.reconcile(state, occurrence['id'], proof)

    def test_unlaunched_relay_refuses_wrong_host_or_live_parent(self):
        import runpy
        state, occurrence, proof, directory = self.unlaunched_relay_state()
        source = directory / 'authority.private.json'
        archive = Path(proof['campaign']) / 'shared-relay' / source.name
        original = c.read(source)
        native = runpy.run_path(str(ROOT / 'scripts/cloudbench-shared-relay.py'))
        for fields in [dict(parent_start='proc-start:foreign-host:1'),
                       dict(parent_pid=os.getpid(), parent_start=native['birth'](os.getpid()))]:
            for path in (source, archive):
                c.write(path, {**original, **fields});proof['files'][str(path)] = c.sha_file(path)
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, 'parent identity not retired'):
                c.reconcile(state, occurrence['id'], proof)

    def admission_campaign_state(self):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        runs = parents[0].parent
        for fleet in [*parents[10:], runs / 'canary']:
            token = c.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']
            shutil.rmtree(fleet)
            shutil.rmtree(self.root/'.git/cloudbench-fleet-audits'/token)
        parents = parents[:10]
        from deploy_test_native_admission import REVIEWED_SOURCES
        sources = list(REVIEWED_SOURCES)
        for relative, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(relative, expected)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','admission producer'],check=True)
        source = c.source(self.root)
        receipt = state['attempts'][-1]['results'][0]
        campaign = Path(proof['campaign'])
        summary = c.read(campaign/'summary.json')
        jobs = summary['jobs'][:10]
        iso = lambda v: datetime.fromtimestamp(v, timezone.utc).isoformat()
        start, end = receipt['started_at'], receipt['finished_at']
        for index, (fleet, job) in enumerate(zip(parents, jobs)):
            code = 1 if index == 9 else 143
            job.update(status='failed' if code==1 else 'cancelled', controller_exit_code=code,
                       started_at=iso(start+.1), finished_at=iso(end-.2 if code==1 else end-.1))
            text = (f'{self.root}/scripts/run-bench monitor {fleet}\n')
            if code==1:
                text += 'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers\n❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation\n'
            else:
                text += 'Terminated\n⚰️  controller received TERM (02:28:28)\n'
            Path(job['log']).write_text(text)
            life = c.read(fleet/'_batch/lifecycle.json'); life.update(status='failed',controller_exit_code=code)
            c.write(fleet/'_batch/lifecycle.json',life)
            c.write(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=code,
                tasks=[dict(name=job['task'],status='INFRA_ERROR',passed=False,lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            for name in ('execution-provenance.json','execution-task-matrix.json'): (fleet/name).unlink()
        for path in list(campaign.glob('*.log')):
            if path not in {Path(j['log']) for j in jobs}: path.unlink()
        summary.update(jobs=jobs,task_count=10,total_jobs=10,concurrency=10,peak_concurrency=10,started_at=iso(start),finished_at=iso(end))
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        c.write(campaign/'hub-group-publication-ack.private.json',dict(pid=2147483000,token='d'*32,
            record_sha256=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()))
        checks=[j['task'] for j in jobs]; cases=dict.fromkeys(checks,'UNVERIFIED')
        request_path=paths['receipt'].parent/'request.json'
        request=c.read(request_path); request.update(source=source,checks=checks); c.write(request_path,request)
        adapter=c.read(paths['adapter']); adapter.update(source=source,cases=cases); c.write(paths['adapter'],adapter)
        receipt.update(source=source,cases=cases,case_complete=dict.fromkeys(checks,False))
        receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference']
        c.write(paths['receipt'],receipt)
        proof.update(layout='campaign-admission-rejected-v1',source=source,owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time())
        files=[request_path,runs.parent/'cli.log',*campaign.rglob('*'),*runs.rglob('*'),
               *(self.root/p for p in sources),
               *(p for fleet in parents for p in (self.root/'.git/cloudbench-fleet-audits'/c.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']).rglob('*'))]
        proof['files']={str(p):c.sha_file(p) for p in files if p.is_file()}
        return state,occurrence,paths,proof,parents

    def test_admission_requires_full_source_before_git_io(self):
        from deploy_test_native_admission import validate_campaign
        for head in (None, '4f219', 'a'*39, 'g'*40, True):
            with self.subTest(head=head), patch('deploy_test_native_admission.subprocess.check_output') as io:
                with self.assertRaises(ValueError):
                    validate_campaign({'source':{'head':head}}, {}, self.root, None, {}, set(), None, None)
                io.assert_not_called()

    def test_historical_admission_source_survives_current_checkout_changes(self):
        from deploy_test_native_admission import REVIEWED_SOURCES
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        for relative in REVIEWED_SOURCES:
            (self.root / relative).write_text('# newer source after the recorded run\n')
        before = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state['attempts'])
        self.assertFalse(next(iter(state['reconciled_owners'].values()))['credit_granted'])

    def test_admission_rejection_retains_ten_parent_custody_without_credit(self):
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        before=copy.deepcopy(state)
        c.reconcile(state,occurrence['id'],proof)
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertEqual(before['attempts'],state['attempts'])
        self.assertEqual(before['failures'],state['failures'])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(10,len(entry['participants']))
        self.assertTrue(entry['retained_services'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

    def test_admission_rejection_fails_closed_on_malformed_or_nonempty_closure(self):
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        original={Path(p):Path(p).read_bytes() for p in proof['files']}
        campaign=Path(proof['campaign']); summary_path=campaign/'summary.json'
        before=copy.deepcopy(state)
        for mutation in ('purpose','source','prefix','boolean-pass','boolean-exit','false-root','executed','metadata','duplicate-pid','boolean-pid',
                         'reverse-clock','early-cancel','late-start','nonterminal','live-group','nonempty','unknown-record','unknown-audit','registry','foreign-hub'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof); added=[]
                try:
                    summary=c.read(summary_path)
                    if mutation=='purpose': candidate['purpose']='isolated-validation'
                    if mutation=='source': (self.root/'scripts/run-bench-fleet').write_text('changed producer')
                    if mutation=='prefix':
                        p=Path(summary['jobs'][-1]['log']); p.write_text(p.read_text().replace('cleanup reserve admission failed:','forged cleanup reserve admission failed:'))
                    if mutation in ('boolean-pass','executed'):
                        p=parents[0]/'_batch/run.json'; value=c.read(p); value['tasks'][0]['passed']=0 if mutation=='boolean-pass' else True; c.write(p,value)
                    if mutation in ('boolean-exit','false-root'):
                        p=parents[-1]/'_batch/run.json'; value=c.read(p)
                        if mutation=='boolean-exit': value['controller_exit_code']=True
                        else: value['tasks'][0]['owned_roots']=False
                        c.write(p,value)
                    if mutation=='unknown-record':
                        p=parents[0]/'teardown-ownership/unrecognized'; p.write_text('unknown'); added.append(p)
                    if mutation=='metadata':
                        p=parents[0]/'execution-provenance.json'; c.write(p,{}); added.append(p)
                    if mutation=='duplicate-pid': summary['jobs'][1]['controller_pid']=summary['jobs'][0]['controller_pid']
                    if mutation=='boolean-pid': summary['jobs'][0]['controller_pid']=True
                    if mutation=='reverse-clock': summary['jobs'][0]['started_at']=summary['jobs'][0]['finished_at']
                    if mutation=='early-cancel': summary['jobs'][0]['finished_at']=summary['jobs'][0]['started_at']
                    if mutation=='late-start': summary['jobs'][0]['started_at']=summary['jobs'][0]['finished_at']
                    if mutation=='nonterminal': summary['jobs'][0]['status']='running'
                    if mutation in ('duplicate-pid','boolean-pid','reverse-clock','early-cancel','late-start','nonterminal'): c.write(summary_path,summary)
                    if mutation=='nonempty':
                        p=parents[0]/'teardown-ownership/expected-fresh/x'; p.parent.mkdir(exist_ok=True); p.write_text('owned'); added.append(p)
                    if mutation=='unknown-audit':
                        p=parents[0]/'teardown-ownership/meta'; p.write_text(p.read_text().replace('provider-teardown-verified','unknown'))
                    if mutation=='registry':
                        owner=c.read(parents[0]/'_batch/lifecycle.json')['fleet_owner_token']; p=self.root/'.git/cloudbench-fleet-ownership'/owner; p.mkdir(parents=True); added.append(p)
                    if mutation=='foreign-hub':
                        p=next(p for p in original if p.name.endswith('.owner')); p.write_text(p.read_text().replace('live-transfer-required','unknown'))
                    candidate['files'].update({str(p):c.sha_file(p) for p in original if p.exists()})
                    candidate['files'].update({str(p):c.sha_file(p) for p in added if p.is_file()})
                    if mutation=='live-group':
                        from deploy_test_native_cleanup import subprocess as native_subprocess
                        actual=native_subprocess.check_output
                        def process_result(args, *a, **kw):
                            if args[:1]==['ps']: return '999999 310001 S\n'
                            return actual(args,*a,**kw)
                        with patch.object(native_subprocess,'check_output',side_effect=process_result):
                            with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    else:
                        with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                finally:
                    for p in added:
                        if p.is_dir(): p.rmdir()
                        elif p.exists(): p.unlink()
                    for p,raw in original.items(): p.write_bytes(raw)

    def independently_rejected_admission_campaign_state(self):
        import hashlib, runpy
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        campaign = Path(proof['campaign'])
        summary = c.read(campaign/'summary.json')
        for index in (0, 1):
            job = summary['jobs'][index]
            job['controller_exit_code'] = 1  # Keep original cancelled status.
            log = Path(job['log'])
            log.write_text(f'{self.root}/scripts/run-bench monitor {parents[index]}\n'
                'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers\n'
                '❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation\n')
            for name in ('lifecycle.json','run.json'):
                p=parents[index]/'_batch'/name; value=c.read(p); value['controller_exit_code']=1; c.write(p,value)
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        ack=c.read(campaign/'hub-group-publication-ack.private.json')
        ack['record_sha256']=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()
        c.write(campaign/'hub-group-publication-ack.private.json',ack)
        proof['files']={p:c.sha_file(Path(p)) for p in proof['files']}
        return state, occurrence, paths, proof, parents

    def test_independent_admission_rejections_preserve_cancelled_outcomes_and_custody(self):
        state, occurrence, paths, proof, parents = self.independently_rejected_admission_campaign_state()
        before=copy.deepcopy(state)
        originals={p:Path(p).read_bytes() for p in proof['files']}
        c.reconcile(state,occurrence['id'],proof)
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(10,len(entry['participants']))
        self.assertTrue(entry['retained_services'])
        self.assertEqual(before['attempts'],state['attempts'])
        self.assertEqual(before['failures'],state['failures'])
        self.assertEqual(originals,{p:Path(p).read_bytes() for p in proof['files']})

    def test_independent_admission_rejections_require_exact_positive_boundary(self):
        state, occurrence, paths, proof, parents = self.independently_rejected_admission_campaign_state()
        originals={Path(p):Path(p).read_bytes() for p in proof['files']}
        before=copy.deepcopy(state)
        campaign=Path(proof['campaign']); summary_path=campaign/'summary.json'
        for mutation in ('no-marker','no-refusal','prefixed-marker','duplicate-marker','duplicate-refusal','reversed-lines',
                         'wrong-exit','boolean-exit','finished-before-primary','started-after-primary','running-status'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof)
                try:
                    summary=c.read(summary_path);job=summary['jobs'][0];log=Path(job['log']);text=log.read_text()
                    marker='cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers'
                    refusal='❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation'
                    if mutation=='no-marker':text=text.replace(marker+'\n','')
                    if mutation=='no-refusal':text=text.replace(refusal+'\n','')
                    if mutation=='prefixed-marker':text=text.replace(marker,'forged '+marker)
                    if mutation=='duplicate-marker':text+=marker+'\n'
                    if mutation=='duplicate-refusal':text+=refusal+'\n'
                    if mutation=='reversed-lines':text=text.replace(marker+'\n'+refusal,refusal+'\n'+marker)
                    if mutation=='wrong-exit':job['controller_exit_code']=2
                    if mutation=='boolean-exit':job['controller_exit_code']=True
                    if mutation=='finished-before-primary':job['finished_at']=job['started_at']
                    if mutation=='started-after-primary':job['started_at']=job['finished_at']
                    if mutation=='running-status':job['status']='running'
                    log.write_text(text);c.write(summary_path,summary)
                    candidate['files']={str(p):c.sha_file(p) for p in originals}
                    with self.assertRaises(ValueError):c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                finally:
                    for p,raw in originals.items():p.write_bytes(raw)

    def cancelled_parent_campaign_state(self):
        import hashlib, shutil, time, runpy
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        from deploy_test_native_cancelled_parent import REVIEWED_SOURCES
        names = list(REVIEWED_SOURCES)
        for name, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(name, expected)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','cancel producer'],check=True)
        source=c.source(self.root);campaign=Path(proof['campaign']);summary=c.read(campaign/'summary.json');runs=parents[0].parent
        for index,fleet in enumerate(parents):
            if index in (0,1):continue
            bench=json.loads((fleet/'_batch/benches.json').read_text())[0]['name'];matrix=build_task_matrix([bench+'=real'])
            c.write(fleet/'execution-task-matrix.json',matrix)
            c.write(fleet/'execution-provenance.json',dict(schema_version='cloudbench-execution-provenance-v1',base_sha=source['head'],workspace_patch_sha256='none',config=build_config('cloudbench-fleet-config-v1',['task_count=1','task_matrix_sha256='+matrix['sha256']]),controller_snapshot=dict(schema_version='cloudbench-controller-snapshot-v1',sha256='d'*64)))
        for index in (2,8):
            fleet=runs/('20261103-080441-'+str(2147483000+index));shutil.copytree(parents[0],fleet)
            owner=('a' if index==2 else 'b')*32;life=c.read(fleet/'_batch/lifecycle.json');old=life['fleet_owner_token'];oldrun=life['run_id'];audit=fleet/'teardown-ownership';(audit/'source-audit').unlink()
            meta=(audit/'meta').read_text().replace('fleet_owner_token='+old,'fleet_owner_token='+owner).replace('run_id='+oldrun,'run_id='+fleet.name);(audit/'meta').write_text(meta)
            canonical=self.root/'.git/cloudbench-fleet-audits'/owner;shutil.copytree(audit,canonical)
            seal=hashlib.sha256()
            for p in sorted(audit.rglob('*'),key=lambda p:str(p.relative_to(audit))):
                if p.is_file():
                    for raw in(str(p.relative_to(audit)).encode(),p.read_bytes()):seal.update(len(raw).to_bytes(8,'big'));seal.update(raw)
            (audit/'source-audit').write_text(f'path={canonical}\nsha256={seal.hexdigest()}\n')
            life.update(fleet_owner_token=owner,run_id=fleet.name,audit_sha256=seal.hexdigest(),controller_exit_code=1,status='failed');c.write(fleet/'_batch/lifecycle.json',life)
            disp=c.read(fleet/'_batch/disposable-cleanup.json');disp['owner']=owner;c.write(fleet/'_batch/disposable-cleanup.json',disp)
            c.write(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=1,tasks=[dict(name='infra-probe',status='INFRA_ERROR',passed=False,lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            c.write(fleet/'_batch/benches.json',[dict(name='infra-probe',mode='REAL')])
            log=Path(summary['jobs'][index]['log']);log.write_text(log.read_text()+f'ref : {source["head"]}\nmode: --infra-probe (strict barrier, no LLM / run_benchmark)\n{self.root}/scripts/run-bench monitor {fleet}\nowner: {owner}; private controller diagnostics stay in this run directory.\n')
        request_path=paths['receipt'].parent/'request.json';request=c.read(request_path);request['source']=source;c.write(request_path,request)
        adapter=c.read(paths['adapter']);adapter.update(source=source,native_command=['bash','scripts/run-bench',*request['checks'],'--runs','1','--concurrency','10','--retry-infra','0','--ref',source['head']]);c.write(paths['adapter'],adapter)
        receipt=state['attempts'][-1]['results'][0];receipt['source']=source;receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter']);receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference'];c.write(paths['receipt'],receipt)
        proof.update(layout='campaign-v1',purpose='isolated-validation',validation_source=source,execution_quiescence={},cancelled_parent_admission=[str(p)for p in parents[:2]],source=source,owner=copy.deepcopy(receipt['cleanup_owner']),receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time())
        files=[request_path,runs.parent/'cli.log',*campaign.rglob('*'),*runs.rglob('*'),*(self.root/name for name in names),*(self.root/'.git/cloudbench-fleet-audits').rglob('*')]
        proof['files']={str(p):c.sha_file(p)for p in files if p.is_file()}
        return state,occurrence,paths,proof,parents

    def test_cancelled_parent_admission_isolated_preserves_all_twelve_and_no_credit(self):
        state,occurrence,paths,proof,parents=self.cancelled_parent_campaign_state();before=copy.deepcopy(state)
        c.reconcile(state,occurrence['id'],proof);entry=next(iter(state['reconciled_owners'].values()))
        self.assertEqual(12,len(entry['participants']));self.assertFalse(entry['credit_granted']);self.assertFalse(entry['cleanup_complete']);self.assertTrue(entry['obligations_preserved']);self.assertTrue(entry['retained_services'])
        self.assertEqual(before['attempts'],state['attempts']);self.assertEqual(before['failures'],state['failures'])

    def test_cancelled_parent_admission_strict_contract_negatives(self):
        state,occurrence,paths,proof,parents=self.cancelled_parent_campaign_state();originals={Path(p):Path(p).read_bytes()for p in proof['files']};before=copy.deepcopy(state);campaign=Path(proof['campaign']);rollback={**originals,paths['receipt']:paths['receipt'].read_bytes(),paths['adapter']:paths['adapter'].read_bytes()}
        for mutation in ('empty','malformed','duplicate','foreign','ordinary','partial','malformed-provenance','maintenance','wrong-pin','boolean-code','nonterminal','no-term','duplicate-term','nonzero-audit','foreign-owner','live-group'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof);added=[];case_state=copy.deepcopy(state)
                try:
                    if mutation=='empty':candidate['cancelled_parent_admission']=[]
                    if mutation=='malformed':candidate['cancelled_parent_admission']=True
                    if mutation=='duplicate':candidate['cancelled_parent_admission']*=2
                    if mutation=='foreign':candidate['cancelled_parent_admission']=[str(self.root/'foreign')]
                    if mutation=='ordinary':candidate.pop('purpose')
                    if mutation in ('partial','malformed-provenance'):
                        for name in (('execution-provenance.json',)if mutation=='partial'else('execution-provenance.json','execution-task-matrix.json')):
                            p=parents[0]/name;c.write(p,{});added.append(p)
                    if mutation=='maintenance':
                        value=c.read(paths['adapter']);value['native_command']+=['--provision-pool','1'];c.write(paths['adapter'],value)
                        receipt=c.read(paths['receipt']);receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter']);receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference'];c.write(paths['receipt'],receipt);candidate.update(owner=receipt['cleanup_owner'],receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']));case_state['attempts'][-1]['results'][0]=receipt
                    if mutation in ('boolean-code','nonterminal'):
                        value=c.read(campaign/'summary.json');value['jobs'][0]['controller_exit_code'if mutation=='boolean-code'else'status']=True if mutation=='boolean-code'else'running';c.write(campaign/'summary.json',value)
                    if mutation in ('no-term','duplicate-term'):
                        p=Path(c.read(campaign/'summary.json')['jobs'][0]['log']);text=p.read_text();line='⚰️  controller received TERM (02:28:28)\n';p.write_text(text.replace(line,'')if mutation=='no-term'else text+line)
                    if mutation=='nonzero-audit':p=parents[0]/'teardown-ownership/fresh/owned';p.parent.mkdir(exist_ok=True);p.write_text('owned');added.append(p)
                    if mutation=='foreign-owner':p=parents[0]/'_batch/lifecycle.json';value=c.read(p);value['fleet_owner_token']='f'*32;c.write(p,value)
                    candidate['files'].update({str(p):c.sha_file(p)for p in originals if p.exists()});candidate['files'].update({str(p):c.sha_file(p)for p in added})
                    case_before=copy.deepcopy(case_state)
                    if mutation=='wrong-pin':
                        import deploy_test_native_cancelled_parent as native_parent
                        with patch.dict(native_parent.REVIEWED_SOURCES,{'scripts/run-bench-fleet':'0'*64}):
                            with self.assertRaisesRegex(ValueError,'producer changed'):c.reconcile(case_state,occurrence['id'],candidate)
                    elif mutation=='live-group':
                        import deploy_test_native_cleanup as native
                        actual=native.subprocess.check_output
                        def observed(args,*a,**kw):
                            if args[:1]==['ps']:return '999999 310001 S\n'
                            return actual(args,*a,**kw)
                        with patch.object(native.subprocess,'check_output',side_effect=observed):
                            with self.assertRaises(ValueError):c.reconcile(case_state,occurrence['id'],candidate)
                    else:
                        with self.assertRaises(ValueError):c.reconcile(case_state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                    self.assertEqual(case_before,case_state)
                finally:
                    for p in added:p.unlink()
                    for p,raw in rollback.items():p.write_bytes(raw)

    def isolated_campaign_state(self):
        import time
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        gate = next(g for g in state['plan']['gates'] if g['name'] == occurrence['gate'])
        gate.update(command=[sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')], cwd='.')
        proof.update(purpose='isolated-validation', validation_source=dict(head='c' * 40, digest='d' * 64),
                     execution_quiescence={})
        # The original failed task and retained archive remain immutable; only execution admission differs.
        fleet = parents[0]
        life = c.read(fleet / '_batch/lifecycle.json')
        owner = life['fleet_owner_token']
        audit = self.root / '.git/cloudbench-fleet-audits' / owner
        meta = (audit / 'meta').read_text().replace('status=provider-teardown-verified', 'status=incomplete')
        (audit / 'meta').write_text(meta)
        (audit / 'fresh').mkdir(exist_ok=True)
        (audit / 'fresh/old').write_text('fleet_owner_token=' + owner + '\nrun_id=' + fleet.name
            + '\napp=fixture\nsource=fresh-clone\nmachine_id=old-machine\nvolume_id=old-volume\ndisposition=owned\n')
        registry = self.root / '.git/cloudbench-fleet-ownership' / owner
        registry.mkdir(parents=True)
        (registry / 'meta').write_text(meta + 'cleanup_policy=reap\n')
        (registry / 'runtime-evidence-unconfirmed').write_text('original archive debt\n')
        # Canary has a native provider-retired row; bind a real-shaped exact pair observation.
        runs = fleet.parent
        canary = runs / 'canary'
        replacement = runs / '20261103-080441-2147483001'
        # Rename only this synthetic canary and update its canonical native identity records/log handle.
        canary.rename(replacement)
        for base in [replacement, self.root / '.git/cloudbench-fleet-audits' / ('2' * 32)]:
            for file in base.rglob('*'):
                if file.is_file(): file.write_text(file.read_text().replace('run_id=canary', 'run_id=' + replacement.name))
        life2 = c.read(replacement / '_batch/lifecycle.json'); life2['run_id'] = replacement.name
        c.write(replacement / '_batch/lifecycle.json', life2)
        for log in Path(proof['campaign']).glob('*.log'):
            log.write_text(log.read_text().replace(str(canary), str(replacement)))
        observations = []
        for machine, volume, token in [('old-machine', 'old-volume', owner + '-0'), ('machine1', 'vol_fixture', '2' * 32 + '-0')]:
            for kind, mid in [('machine', machine), ('volume', volume)]:
                metadata = dict(id=mid, state='destroyed' if kind == 'machine' else 'pending_destroy')
                if kind == 'machine': metadata['source_binding'] = dict(REF=state['source']['head'], CLOUDBENCH_RUN_TOKEN=token)
                else: metadata['attached_machine_id'] = None
                observations.append(dict(kind=kind, id=mid, expected_machine=machine, expected_volume=volume,
                    method='GET', no_retry=True, http_status=200, response_sha256='e' * 64, metadata=metadata))
        packet = self.root / '.context/provider-pairs.json'
        c.write(packet, dict(endpoint_origin='https://api.machines.dev', app='fixture', rows=observations))
        proof['execution_quiescence'] = {m: dict(provider_pair=str(packet)) for m in ('old-machine', 'machine1')}
        proof['files'] = {str(f): c.sha_file(f) for base in [runs, Path(proof['campaign']),
            self.root / '.git/cloudbench-fleet-audits', self.root / '.git/cloudbench-fleet-ownership']
            for f in base.rglob('*') if f.is_file()}
        proof['files'][str(paths['receipt'].parent / 'request.json')] = c.sha_file(paths['receipt'].parent / 'request.json')
        proof['files'][str(runs.parent / 'cli.log')] = c.sha_file(runs.parent / 'cli.log')
        proof['files'][str(packet)] = c.sha_file(packet)
        return state, occurrence, paths, proof, gate, packet

    def test_failed_infra_canary_is_execution_only_and_requires_positive_release(self):
        import hashlib
        import shutil
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        runs = Path(proof['campaign']).parent.parent / 'runs'
        fleet = runs / '20261103-080441-2147483001'
        life_path = fleet / '_batch/lifecycle.json'
        life = c.read(life_path)
        life.update(status='failed', controller_exit_code=143)
        audit = fleet / 'teardown-ownership'
        (audit / 'source-audit').unlink()
        (audit / 'owned-clones.ids').write_text('')
        (audit / 'owned-clones.names').write_text('')
        shutil.rmtree(audit / 'fresh')
        canonical = self.root / '.git/cloudbench-fleet-audits' / life['fleet_owner_token']
        shutil.rmtree(canonical); shutil.copytree(audit, canonical)
        digest = hashlib.sha256()
        for path in sorted(audit.rglob('*'), key=lambda p: str(p.relative_to(audit))):
            if path.is_file():
                for raw in (str(path.relative_to(audit)).encode(), path.read_bytes()):
                    digest.update(len(raw).to_bytes(8, 'big')); digest.update(raw)
        life['audit_sha256'] = digest.hexdigest(); c.write(life_path, life)
        (audit / 'source-audit').write_text(f'path={canonical}\nsha256={digest.hexdigest()}\n')
        names = [b['name'] for b in json.loads((fleet / '_batch/benches.json').read_text())]
        c.write(fleet / '_batch/run.json', dict(run_id=fleet.name, controller_exit_code=143,
            status='failed', tasks=[dict(name=n, status='INFRA_ERROR', passed=False,
                lifecycle_stage='released', failure_reason='no current run artifact produced') for n in names]))
        for name in ('execution-provenance.json', 'execution-task-matrix.json'): (fleet / name).unlink()
        log = Path(proof['campaign']) / 'r001-j0003.log'
        text = log.read_text().replace(f'{self.root}/scripts/run-bench monitor {fleet}',
            f"ref    : {state['source']['head']}  (committed source)\n"
            'mode: --infra-probe (strict barrier, no LLM / run_benchmark)\n'
            f'{self.root}/scripts/run-bench monitor {fleet}\n'
            f"owner: {life['fleet_owner_token']}; private controller diagnostics stay in this run directory.")
        log.write_text(text)
        proof['execution_quiescence'].pop('machine1')
        def bind():
            proof['files'] = {p: c.sha_file(p) for p in proof['files'] if Path(p).is_file()}
        bind()
        original = copy.deepcopy(state)
        c.reconcile(state, failure['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertFalse(entry['credit_granted']); self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(original['attempts'], state['attempts'])
        self.assertEqual(15, len(entry['participants']))
        mutations = [
            (life_path, lambda v: dict(v, audit_sha256='0' * 64)),
            (canonical / 'meta', lambda v: v.replace('status=provider-teardown-verified', 'status=pending')),
            (log, lambda v: v.replace(state['source']['head'], 'f' * 40)),
            (log, lambda v: v.replace(life['fleet_owner_token'], 'e' * 32)),
            (log, lambda v: v.replace('mode: --infra-probe', 'mode: task')),
        ]
        for path, mutate in mutations:
            with self.subTest(path=path):
                raw = path.read_bytes()
                if path == life_path: c.write(path, mutate(c.read(path)))
                else: path.write_text(mutate(path.read_text()))
                bind(); candidate = copy.deepcopy(original)
                with self.assertRaises(ValueError): c.reconcile(candidate, failure['id'], proof)
                self.assertEqual(original, candidate)
                path.write_bytes(raw); bind()
        import deploy_test_native_cleanup as native
        actual_ps = native.subprocess.check_output
        def live(args, **kwargs):
            if args[:2] == ['ps', '-ax']: return '2147483001 2147483001 S\n'
            return actual_ps(args, **kwargs)
        with patch.object(native.subprocess, 'check_output', side_effect=live), self.assertRaises(ValueError):
            c.reconcile(copy.deepcopy(original), failure['id'], proof)
        ordinary = copy.deepcopy(proof); ordinary.pop('purpose')
        with self.assertRaises(ValueError): c.reconcile(copy.deepcopy(original), failure['id'], ordinary)

    def test_isolated_next_inventory_may_add_cases_without_releasing_original_debt(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        c.reconcile(state, failure['id'], proof)
        state['source'] = proof['validation_source']
        before = copy.deepcopy(state)
        extended = copy.deepcopy(gate)
        extended['checks'] += ['added-payment-' + str(i) for i in range(4)]
        request = dict(token='new-extended-isolated-token', source=state['source'],
                       checks=extended['checks'], skips={})
        bindings = c.isolated_request(state, extended, request, self.root, {})
        entry = next(iter(state['reconciled_owners'].values()))
        self.assertEqual(1, len(bindings))
        self.assertEqual(entry['excluded_resources'], bindings[0]['excluded_resources'])
        self.assertEqual(entry['token'], bindings[0]['original_request_token'])
        self.assertFalse(bindings[0]['credit_granted'])
        self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(before, state)
        # Every selected old and added case remains mandatory in the fresh request.
        for candidate in [dict(request, checks=gate['checks']),
                          dict(request, checks=extended['checks'][1:]),
                          dict(request, token=entry['token']),
                          dict(request, source=dict(head='e'*40, digest='f'*64))]:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                c.isolated_request(state, extended, candidate, self.root, {})
        # A coherently narrowed gate/request cannot silently omit an old case.
        narrowed = copy.deepcopy(extended); narrowed['checks'] = extended['checks'][1:]
        with self.assertRaisesRegex(ValueError, 'next source/inventory binding'):
            c.isolated_request(state, narrowed, dict(request, checks=narrowed['checks']), self.root, {})
        with self.assertRaisesRegex(ValueError, 'fresh native adapter'):
            c.isolated_request(state, extended, request, self.root, {'CLOUDBENCH_ARCHIVED_REUSE_REQUEST':'old'})
        self.assertEqual(before, state)

    def test_isolated_native_validation_preserves_original_debt_and_requires_new_full_request(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        before = copy.deepcopy(state['attempts'])
        self.assertEqual([gate['name']], c.retained_owners(state, [gate['name']]))
        c.reconcile(state, failure['id'], proof)
        self.assertEqual([], c.retained_owners(state, [gate['name']]))
        self.assertEqual(before, state['attempts'])
        state['source'] = proof['validation_source']
        request = dict(token='new-isolated-token', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual('new-isolated-token', c.isolated_request(state, gate, request, self.root, {})[0]['new_request_token'])
        self.assertIn('full coverage', c.pending_completion_block(state))
        entry = copy.deepcopy(state['reconciled_owners'])
        state['attempts'].append(dict(results=[dict(gate=gate['name'], source=state['source'], status='PASS',
            complete=True, cases=dict.fromkeys(gate['checks'], 'PASS'))]))
        self.assertIsNone(c.pending_completion_block(state))
        self.assertEqual(entry, state['reconciled_owners'])  # New PASS/source refresh never deletes old debt.
        self.assertFalse(next(iter(entry.values()))['cleanup_complete'])
        self.assertFalse(next(iter(entry.values()))['credit_granted'])
        packet.write_text(packet.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'obligation changed'):
            c.retained_owners(state, [gate['name']])
        self.assertIsNotNone(c.pending_completion_block(state))

    def renewal_state(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        receipt = state['attempts'][-1]['results'][0]
        state.update(phase='interrupted', resume_phase='focused')
        state['attempts'][-1]['interrupted'] = True
        state['failures'] = []
        receipt.update(executed=True)
        c.write(paths['receipt'], receipt); proof['receipt_sha256'] = c.sha_file(paths['receipt'])
        c.reconcile(state, receipt['token'], proof)
        # Ordinary source refresh + a completed quick phase leaves the original smoke latest.
        (self.root / 'new-source').write_text('next source')
        state.update(source=c.source(self.root), phase='triage', ready=False)
        state['plan']['source'] = state['source']
        state['attempts'].append(dict(phase='quick', results=[]))
        return state, paths, proof, gate, packet, receipt

    def test_existing_isolated_proof_can_renew_only_validation_source_after_refresh(self):
        state, paths, proof, gate, packet, receipt = self.renewal_state()
        key = proof['receipt_sha256']; original = copy.deepcopy(state)
        renewed = {**proof, 'validation_source': copy.deepcopy(state['source'])}
        c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(state['reconciled_owner_history'], [original['reconciled_owners'][key]])
        current = state['reconciled_owners'][key]
        self.assertEqual(current['validation_source'], state['source'])
        self.assertFalse(current['credit_granted']); self.assertFalse(current['cleanup_complete'])
        self.assertEqual(original['attempts'], state['attempts']); self.assertEqual(original['failures'], state['failures'])
        self.assertEqual(original['round'], state['round']); self.assertEqual(original['phase'], state['phase'])
        request = dict(token='fresh-after-source-refresh', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual(1, len(c.isolated_request(state, gate, request, self.root, {})))
        self.assertIn('full coverage', c.pending_completion_block(state))
        before = copy.deepcopy(state); c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(before, state)  # idempotent, no duplicate renewal record

    def clean_successor_renewal_state(self):
        state, paths, proof, gate, packet, original = self.renewal_state()
        prior = state['reconciled_owners'][proof['receipt_sha256']]
        folder = self.directory / 'successor'
        token, native_source = 'clean-full-successor', copy.deepcopy(prior['validation_source'])
        native_root = self.root / '.context/deploy-cloud' / __import__('hashlib').sha256(token.encode()).hexdigest()
        binding = dict(original_receipt_sha256=proof['receipt_sha256'], original_request_token=original['token'],
            new_request_token=token, source=native_source, new_native_root=str(native_root),
            excluded_resources=copy.deepcopy(prior['excluded_resources']), credit_granted=False)
        # A genuine complete failure is cleanup authority, never PASS credit. Exclusions remain SKIP.
        skip, *active = gate['checks']
        request = dict(token=token, source=native_source, gate=gate['name'], checks=active,
            skips={skip:dict(source=native_source)}, phase='focused', isolated_validation=[binding])
        worker = dict(token=token, source=native_source, gate=gate['name'],
            cases={name:('FAIL' if i == 0 else 'PASS') for i,name in enumerate(active)},
            complete=True, cleanup_complete=True, reused=False, evidence={},
            fleet_directory=str(native_root / 'campaigns' / ('deploy-' + native_root.name)),
            runner_log=str(native_root / 'cli.log'))
        leaf = folder / 'native-task.json'; c.write(leaf, dict(passed=False))
        worker['evidence'] = {name:dict(path=str(leaf), sha256=c.sha_file(leaf)) for name in active}
        c.write(folder / 'result.json', worker)
        successor = dict(gate=gate['name'], token=token, source=native_source, status='FAIL',
            executed=True, complete=True, native_exit=1, timed_out=False, cancelled=False,
            lingering_group=False, cleanup_owner=None, cases={skip:'SKIP', **worker['cases']},
            case_complete=dict.fromkeys(gate['checks'], True), command=gate['command'],
            log=str(folder/'output.log'), worker_result=str(folder/'result.json'),
            started_at=original['finished_at']+1, finished_at=original['finished_at']+2,
            execution_binding=dict(contract_digest=c.digest(gate), input_fingerprint='captured-input',
                                   environment=state['environment']), isolated_validation=[binding],
            native_cleanup_reference=dict(result=str(folder/'result.json'), native_directory=worker['fleet_directory'],
                cleanup_complete=True, result_sha256=c.sha_file(folder/'result.json'), native_evidence=worker['evidence']))
        c.write(folder/'request.json', request); c.write(folder/'receipt.json', successor)
        state['attempts'].append(dict(phase='focused', results=[successor]))
        return state, paths, proof, gate, packet, original, folder, successor

    def test_isolated_source_renewal_accepts_only_bound_clean_full_successor_without_credit(self):
        state, paths, proof, gate, packet, original, folder, successor = self.clean_successor_renewal_state()
        before = copy.deepcopy(state)
        raw = {p: c.sha_file(p) for p in [*paths.values(), *folder.glob('*.json')]}
        renewed = {**proof, 'validation_source':copy.deepcopy(state['source'])}
        c.reconcile(state, original['token'], renewed)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(state['source'], entry['validation_source'])
        self.assertFalse(entry['credit_granted']); self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(before['attempts'], state['attempts']); self.assertEqual(before['failures'], state['failures'])
        self.assertEqual(before['round'], state['round']); self.assertEqual(before['phase'], state['phase'])
        self.assertEqual(raw, {p:c.sha_file(p) for p in raw})
        request = dict(token='new-full-after-successor', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual(original['token'], c.isolated_request(state, gate, request, self.root, {})[0]['original_request_token'])
        self.assertIsNone(c.full_pass_binding(state, gate))  # Native FAIL has not become coverage credit.
        same = copy.deepcopy(state); c.reconcile(state, original['token'], renewed)
        self.assertEqual(same, state)  # Historical successor binding survives repeated source renewals.

    def committed_historical_successor_fixture(self):
        """Synthetic native custody uses the existing fixture; real retained records are replayed separately."""
        import deploy_test_historical_custody as h
        new = self.custody_fixture()
        proof = h.build(self.state, self.plan, new, self.root)
        c.refresh(self.state, self.plan, new, self.root, historical_no_retry_proof=proof)
        state = self.state; gate = state['plan']['gates'][1]
        skips = h.guard(state, gate, self.root)
        checks = [name for name in gate['checks'] if name not in skips]
        folder = self.directory / 'committed-successor'; token = 'committed-full-successor'
        native = self.root / '.context/deploy-cloud' / __import__('hashlib').sha256(token.encode()).hexdigest()
        prior = dict(gate=gate['name'], token='original-operation', owner={'worker_root':str(self.root)},
                     proof={'receipt_sha256':'a'*64}, excluded_resources=[])
        original = dict(token=prior['token'], finished_at=1000)
        isolated = dict(original_receipt_sha256='a'*64, original_request_token=prior['token'],
                        new_request_token=token, source=state['source'], new_native_root=str(native),
                        excluded_resources=[], credit_granted=False)
        request = dict(token=token, source=state['source'], gate=gate['name'], checks=checks, skips=skips,
                       phase='focused', isolated_validation=[isolated], custody_state_sha256=h.state_identity(state))
        leaf = folder/'native-task.json'; c.write(leaf, {'passed':True})
        worker = dict(token=token, source=state['source'], gate=gate['name'],
                      cases=dict.fromkeys(checks,'PASS'), complete=True, cleanup_complete=True, reused=False,
                      evidence={name:dict(path=str(leaf),sha256=c.sha_file(leaf)) for name in checks},
                      fleet_directory=str(native/'campaigns'/('deploy-'+native.name)),runner_log=str(native/'cli.log'))
        c.write(folder/'result.json',worker)
        successor = dict(gate=gate['name'], token=token, source=state['source'], status='PASS', executed=True,
                         complete=True, native_exit=0, timed_out=False, cancelled=False, lingering_group=False,
                         cleanup_owner=None, cases={**dict.fromkeys(skips,'SKIP'),**worker['cases']},
                         case_complete={**dict.fromkeys(skips,False),**dict.fromkeys(checks,True)}, command=gate['command'],
                         log=str(folder/'output.log'),worker_result=str(folder/'result.json'), started_at=1001,finished_at=1002,
                         execution_binding=dict(contract_digest=c.digest(gate),input_fingerprint=state['input_fingerprints'][gate['name']],environment=state['environment']),
                         isolated_validation=[isolated],native_cleanup_reference=dict(result=str(folder/'result.json'),
                         native_directory=worker['fleet_directory'],cleanup_complete=True,result_sha256=c.sha_file(folder/'result.json'),native_evidence=worker['evidence']))
        c.write(folder/'request.json',request);c.write(folder/'receipt.json',successor)
        state['attempts']=[dict(phase='focused',results=[successor])]
        return state, prior, original, successor, folder, request

    def test_clean_successor_preserves_committed_historical_incomplete_skip_without_credit(self):
        import deploy_test_native_cleanup as n
        state, prior, original, successor, folder, request = self.committed_historical_successor_fixture()
        before = copy.deepcopy(state); files={p:c.sha_file(p) for p in folder.glob('*.json')}
        self.assertIsNone(n.clean_isolated_successor(state,prior,original,successor))
        self.assertEqual(before,state);self.assertEqual(files,{p:c.sha_file(p) for p in files})
        for name,value in request['skips'].items():
            self.assertIs(successor['case_complete'][name],False);self.assertEqual('SKIP',successor['cases'][name])
            self.assertEqual({'test_execution':False,'assertions':False,'financial_release':False},value['credit'])
        current=copy.deepcopy(state);current['source']={'head':'f'*40,'digest':'e'*64};current['plan']['source']=current['source']
        self.assertIsNone(c.full_pass_binding(current,current['plan']['gates'][1],root=self.root))

    def test_clean_successor_historical_completion_and_authority_tampering_refuses(self):
        import deploy_test_native_cleanup as n
        state, prior, original, successor, folder, request = self.committed_historical_successor_fixture()
        skip=next(iter(request['skips']));active=request['checks'][0]
        mutations=[('historical-true',lambda s,q:s['case_complete'].update({skip:True})),
            ('historical-int',lambda s,q:s['case_complete'].update({skip:0})),
            ('active-false',lambda s,q:s['case_complete'].update({active:False})),
            ('ordinary-skip',lambda s,q:q['skips'][skip].update(disposition='ordinary')),
            ('kind',lambda s,q:q['skips'][skip].update(kind='ordinary')),
            ('credit',lambda s,q:q['skips'][skip]['credit'].update(test_execution=True)),
            ('source',lambda s,q:q['skips'][skip].update(source={'head':'f'*40,'digest':'e'*64})),
            ('binding',lambda s,q:q['skips'][skip]['current_binding'].update(plan_digest='0'*64)),
            ('commitment',lambda s,q:q.update(custody_state_sha256='0'*64))]
        for label,mutate in mutations:
            with self.subTest(label=label):
                candidate=copy.deepcopy(state);row=candidate['attempts'][0]['results'][0];q=copy.deepcopy(request)
                mutate(row,q);c.write(folder/'request.json',q);c.write(folder/'receipt.json',row);before=copy.deepcopy(candidate)
                with self.assertRaises(ValueError):n.clean_isolated_successor(candidate,prior,original,row)
                self.assertEqual(before,candidate)
        c.write(folder/'request.json',request);c.write(folder/'receipt.json',successor)

    def test_clean_successor_historical_retained_history_and_native_bytes_are_required(self):
        import deploy_test_native_cleanup as n
        state, prior, original, successor, folder, request = self.committed_historical_successor_fixture()
        for name in ['historical_custody_history','failures']:
            candidate=copy.deepcopy(state);candidate[name]=[];row=candidate['attempts'][0]['results'][0]
            with self.subTest(name=name),self.assertRaises(ValueError):n.clean_isolated_successor(candidate,prior,original,row)
        native=Path(state['historical_no_retry_custody'][0]['original_failure']['worker_evidence']['path']);raw=native.read_bytes()
        native.write_bytes(raw+b' ')
        with self.assertRaises(ValueError):n.clean_isolated_successor(state,prior,original,successor)
        native.write_bytes(raw)
        self.assertIsNone(n.clean_isolated_successor(state,prior,original,successor))

    def historical_clean_successor_contract_state(self):
        from deploy_test_historical_custody import state_identity
        state, paths, proof, gate, packet, original, folder, successor = self.clean_successor_renewal_state()
        gate['selection_evidence'] = ['original dependency explanation']
        successor['execution_binding']['contract_digest'] = c.digest(gate)
        snapshot = copy.deepcopy(state)
        snapshot['source'] = copy.deepcopy(successor['source'])
        snapshot['plan']['source'] = copy.deepcopy(successor['source'])
        snapshot['plan_digest'] = c.digest(snapshot['plan'])
        snapshot['input_fingerprints'][gate['name']] = successor['execution_binding']['input_fingerprint']
        path = self.directory / 'original-successor-custody.json'
        c.write(path, snapshot)
        request = c.read(folder / 'request.json')
        request.update(custody_state=str(self.directory / 'cycle.json'), custody_state_sha256=state_identity(snapshot))
        c.write(folder / 'request.json', request)
        c.write(folder / 'receipt.json', successor)
        gate['selection_evidence'] = ['refreshed dependency explanation']
        incoming = dict(proof, validation_source=copy.deepcopy(state['source']),
                        successor_custody_state=dict(path=str(path), sha256=c.sha_file(path)))
        return state, original, incoming, folder, path, successor

    def test_clean_successor_renewal_authenticates_original_selection_contract(self):
        state, original, incoming, folder, snapshot, successor = self.historical_clean_successor_contract_state()
        before = copy.deepcopy(state)
        files = {p:c.sha_file(p) for p in [snapshot, *folder.glob('*.json')]}
        c.reconcile(state, original['token'], incoming)
        entry = state['reconciled_owners'][incoming['receipt_sha256']]
        self.assertFalse(entry['credit_granted']); self.assertFalse(entry['cleanup_complete'])
        self.assertNotIn('successor_custody_state', entry['proof'])
        self.assertEqual(before['attempts'], state['attempts']); self.assertEqual(before['failures'], state['failures'])
        self.assertEqual(before['round'], state['round']); self.assertEqual(before['phase'], state['phase'])
        self.assertEqual(files, {p:c.sha_file(p) for p in files})
        self.assertIsNone(c.full_pass_binding(state, next(g for g in state['plan']['gates'] if g['name']==successor['gate'])))
        same=copy.deepcopy(state);c.reconcile(state,original['token'],incoming);self.assertEqual(same,state)

    def test_clean_successor_historical_contract_refusals_remain_atomic(self):
        state, original, incoming, folder, path, successor = self.historical_clean_successor_contract_state()
        original_snapshot = path.read_bytes()
        changes = [
            ('source',lambda d:d.update(source=dict(head='f'*40,digest='e'*64))),
            ('environment',lambda d:d.update(environment='0'*64)),
            ('fingerprint',lambda d:d['input_fingerprints'].update({successor['gate']:'foreign'})),
            ('plan-digest',lambda d:d.update(plan_digest='0'*64)),
            ('old-contract',lambda d:next(g for g in d['plan']['gates'] if g['name']==successor['gate']).update(command=['false'])),
        ]
        for name,change in changes:
            with self.subTest(name=name):
                doc=c.read(path);change(doc);c.write(path,doc)
                proof=copy.deepcopy(incoming);proof['successor_custody_state']['sha256']=c.sha_file(path)
                candidate=copy.deepcopy(state);before=copy.deepcopy(candidate)
                with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],proof)
                self.assertEqual(before,candidate);path.write_bytes(original_snapshot)
        for field,value in [('command',['false']),('checks',[]),('native_cloud',1),('worker_recipe',{'foreign':True}),('selection_evidence',[True])]:
            with self.subTest(field=field):
                candidate=copy.deepcopy(state);gate=next(g for g in candidate['plan']['gates'] if g['name']==successor['gate']);gate[field]=value
                before=copy.deepcopy(candidate)
                with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],incoming)
                self.assertEqual(before,candidate)
        request_path=folder/'request.json';request_raw=request_path.read_bytes()
        request=c.read(request_path);request['custody_state_sha256']='0'*64;c.write(request_path,request)
        candidate=copy.deepcopy(state);before=copy.deepcopy(candidate)
        with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],incoming)
        self.assertEqual(before,candidate);request_path.write_bytes(request_raw)
        # Even a resealed snapshot/request cannot choose a different old full contract.
        from deploy_test_historical_custody import state_identity
        snapshot=c.read(path);oldgate=next(g for g in snapshot['plan']['gates'] if g['name']==successor['gate'])
        oldgate['selection_evidence']=['invented old explanation'];snapshot['plan_digest']=c.digest(snapshot['plan'])
        c.write(path,snapshot);request=c.read(request_path);request['custody_state_sha256']=state_identity(snapshot);c.write(request_path,request)
        changed=copy.deepcopy(incoming);changed['successor_custody_state']['sha256']=c.sha_file(path)
        candidate=copy.deepcopy(state);before=copy.deepcopy(candidate)
        with self.assertRaisesRegex(ValueError,'successor contract'):c.reconcile(candidate,original['token'],changed)
        self.assertEqual(before,candidate);request_path.write_bytes(request_raw);path.write_bytes(original_snapshot)
        for proof in [dict(incoming,successor_custody_state=dict(path=str(path),sha256='0'*64)),
                      {k:v for k,v in incoming.items() if k!='successor_custody_state'}]:
            candidate=copy.deepcopy(state);before=copy.deepcopy(candidate)
            with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],proof)
            self.assertEqual(before,candidate)

    def test_isolated_successor_renewal_rejects_bad_or_tampered_successors_atomically(self):
        state, paths, proof, gate, packet, original, folder, successor = self.clean_successor_renewal_state()
        renewed = {**proof, 'validation_source':copy.deepcopy(state['source'])}
        changes = [
            ('incomplete', lambda r:r.update(complete=False)),
            ('not-executed', lambda r:r.update(executed=False)),
            ('owned', lambda r:r.update(cleanup_owner={'new':'owner'})),
            ('lingering', lambda r:r.update(lingering_group=True)),
            ('cancelled', lambda r:r.update(cancelled=True)),
            ('deadline', lambda r:r.update(timed_out=True)),
            ('wrong-command', lambda r:r.update(command=['false'])),
            ('wrong-contract', lambda r:r['execution_binding'].update(contract_digest='0'*64)),
            ('missing-check', lambda r:r['cases'].pop(next(iter(r['cases'])))),
            ('foreign-original', lambda r:r['isolated_validation'][0].update(original_request_token='foreign')),
            ('changed-exclusions', lambda r:r['isolated_validation'][0].update(excluded_resources={})),
            ('unbound-result', lambda r:r['native_cleanup_reference'].update(result_sha256='0'*64)),
        ]
        for name, mutate in changes:
            with self.subTest(name=name):
                candidate = copy.deepcopy(state); row=candidate['attempts'][-1]['results'][0]; mutate(row)
                c.write(folder/'receipt.json',row)
                before=copy.deepcopy(candidate)
                with self.assertRaises(ValueError): c.reconcile(candidate, original['token'], renewed)
                self.assertEqual(before,candidate)
        c.write(folder/'receipt.json',successor)
        for file in ('request.json','result.json','native-task.json'):
            path=folder/file; raw=path.read_bytes(); path.write_bytes(raw+b' ')
            # Request JSON whitespace does not change its meaning; tamper the bound original locator.
            if file=='request.json':
                doc=c.read(path); doc['isolated_validation'][0]['original_receipt_sha256']='0'*64; c.write(path,doc)
            before=copy.deepcopy(state)
            with self.subTest(file=file), self.assertRaises(ValueError): c.reconcile(state, original['token'], renewed)
            self.assertEqual(before,state); path.write_bytes(raw)
        candidate=copy.deepcopy(state)
        candidate['attempts'].append(dict(phase='focused',results=[dict(successor,token='newer-unknown',complete=False)]))
        before=copy.deepcopy(candidate)
        with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],renewed)
        self.assertEqual(before,candidate)

    def test_isolated_source_renewal_refusals_are_atomic(self):
        state, paths, proof, gate, packet, receipt = self.renewal_state()
        renewed = {**proof, 'validation_source': copy.deepcopy(state['source'])}
        changes = [('wrong-source', lambda s,p: p.update(validation_source=proof['validation_source'])),
            ('wrong-token', lambda s,p: p.update(request_token='foreign')),
            ('wrong-receipt', lambda s,p: p.update(receipt_sha256='0'*64)),
            ('new-confirmation', lambda s,p: p.update(confirmed_at=p['confirmed_at']+1)),
            ('running', lambda s,p: s.update(running={'gate':gate['name']})),
            ('live-failures', lambda s,p: s.update(live_failures=[])),
            ('wrong-phase', lambda s,p: s.update(phase='ready')),
            ('no-prior', lambda s,p: s.update(reconciled_owners={})),
            ('newer-receipt', lambda s,p: s['attempts'][-1]['results'].append({**receipt,'token':'new-owner'}))]
        for name, change in changes:
            with self.subTest(name=name):
                candidate, incoming = copy.deepcopy(state), copy.deepcopy(renewed)
                change(candidate, incoming); before = copy.deepcopy(candidate)
                with self.assertRaises(ValueError): c.reconcile(candidate, receipt['token'], incoming)
                self.assertEqual(before, candidate)
        before = copy.deepcopy(state); packet.write_text(packet.read_text()+' ')
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(before, state)

    def reconciled_failed_successor_renewal_state(self):
        from datetime import datetime, timezone
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        original = state['attempts'][-1]['results'][0]
        c.reconcile(state, failure['id'], proof)
        self._renewal_fixture_token, self._renewal_owner_offset = 'e' * 32, 3
        self._renewal_campaign_offset = 100
        old_directory = self.directory
        self.directory = old_directory / 'successor'
        try:
            normal, occurrence, native_paths, native_proof, parents = self.campaign_recon_state()
        finally:
            self.directory = old_directory
            del self._renewal_fixture_token, self._renewal_owner_offset, self._renewal_campaign_offset
        successor = normal['attempts'][-1]['results'][0]
        successor.update(command=gate['command'], started_at=original['started_at'] + 1000,
            finished_at=original['finished_at'] + 1001,
            execution_binding=dict(contract_digest=c.digest(gate), environment=state['environment'],
                                   input_fingerprint=c.digest('historical-source-input')))
        native_root = Path(native_proof['campaign']).parent.parent
        admission = dict(original_receipt_sha256=proof['receipt_sha256'],
            original_request_token=original['token'], new_request_token=successor['token'],
            source=successor['source'], new_native_root=str(native_root),
            excluded_resources=copy.deepcopy(state['reconciled_owners'][proof['receipt_sha256']]['excluded_resources']),
            credit_granted=False)
        successor['isolated_validation'] = [admission]
        request_path = native_paths['receipt'].parent / 'request.json'
        request = c.read(request_path); request.update(phase='focused', skips={}, isolated_validation=[admission])
        c.write(request_path, request)
        adapter = c.read(native_paths['adapter']); adapter['started_at'] += 1000
        c.write(native_paths['adapter'], adapter)
        successor['native_cleanup_reference']['result_sha256'] = c.sha_file(native_paths['adapter'])
        c.write(native_paths['receipt'], successor)
        summary_path = Path(native_proof['campaign']) / 'summary.json'
        summary = c.read(summary_path)
        for key in ('started_at', 'finished_at'):
            summary[key] = datetime.fromtimestamp(datetime.fromisoformat(summary[key]).timestamp()+1000, timezone.utc).isoformat()
        c.write(summary_path, summary)
        import runpy, hashlib
        native = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(summary_path.parent / 'hub-group.json', group)
        ack_path = summary_path.parent / 'hub-group-publication-ack.private.json'
        ack = c.read(ack_path); ack['record_sha256'] = hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()
        c.write(ack_path, ack)
        native_proof.update(owner=copy.deepcopy(successor['cleanup_owner']),
            receipt_sha256=c.sha_file(native_paths['receipt']), worker_result_sha256=c.sha_file(native_paths['adapter']))
        native_proof['files'] = {p:c.sha_file(p) for p in native_proof['files']}
        c.reconcile(normal, occurrence['id'], native_proof)
        entry = normal['reconciled_owners'][native_proof['receipt_sha256']]
        state['reconciled_owners'][native_proof['receipt_sha256']] = entry
        # Preserve the normal native failure occurrence as well as the original isolated failure.
        occurrence.update(command=successor['command'], finished_at=successor['finished_at'])
        state['failures'].append(occurrence)
        state['attempts'].append(dict(phase='focused', source=successor['source'], results=[successor]))
        (self.root / 'renewal-source').write_text('next repair')
        state.update(source=c.source(self.root), phase='needs-focused-plan', ready=False)
        state['plan']['source'] = state['source']
        state['plan_digest'] = c.digest(state['plan'])
        return state, original, proof, successor, native_proof

    def test_reconciled_failed_successor_renews_at_repair_boundary_without_credit(self):
        state, original, proof, successor, native_proof = self.reconciled_failed_successor_renewal_state()
        before = copy.deepcopy(state)
        incoming = dict(proof, validation_source=state['source'])
        c.reconcile(state, original['token'], incoming)
        key = proof['receipt_sha256']
        self.assertEqual(state['source'], state['reconciled_owners'][key]['validation_source'])
        self.assertEqual(before['reconciled_owners'][key]['occurrence'], state['reconciled_owners'][key]['occurrence'])
        for field in before:
            if field not in ('reconciled_owners', 'reconciled_owner_history'):
                self.assertEqual(before[field], state[field], field)
        self.assertEqual(before['reconciled_owners'][native_proof['receipt_sha256']],
                         state['reconciled_owners'][native_proof['receipt_sha256']])
        self.assertFalse(state['reconciled_owners'][key]['credit_granted'])
        self.assertFalse(state['reconciled_owners'][key]['cleanup_complete'])
        self.assertFalse(successor['complete'])
        self.assertIsNone(c.full_pass_binding(state, state['plan']['gates'][-1]))
        same = copy.deepcopy(state); c.reconcile(state, original['token'], incoming)
        self.assertEqual(same, state)

    def test_failed_successor_renewal_uses_sealed_historical_environment_without_carryover(self):
        state, original, proof, successor, native_proof = self.reconciled_failed_successor_renewal_state()
        historical = copy.deepcopy(successor['execution_binding'])
        state['environment'] = c.digest('new target environment with explicit operator limits')
        gate = next(g for g in state['plan']['gates'] if g['name'] == successor['gate'])
        gate['env'] = {'RENEWAL_TARGET_EPOCH': 'new'}
        state['plan_digest'] = c.digest(state['plan'])
        state['input_fingerprints'][gate['name']] = c.digest('new target full input')
        before = copy.deepcopy(state)
        c.reconcile(state, original['token'], dict(proof, validation_source=state['source']))
        self.assertEqual(historical, successor['execution_binding'])
        self.assertNotEqual(state['environment'], historical['environment'])
        self.assertNotEqual(c.digest(gate), historical['contract_digest'])
        for field in before:
            if field not in ('reconciled_owners', 'reconciled_owner_history'):
                self.assertEqual(before[field], state[field], field)
        self.assertIsNone(c.full_pass_binding(state, gate))
        self.assertFalse(state['reconciled_owners'][proof['receipt_sha256']]['credit_granted'])
        self.assertEqual(state['source'], state['reconciled_owners'][proof['receipt_sha256']]['validation_source'])

    def test_reconciled_failed_successor_rejects_untrusted_authority_atomically(self):
        state, original, proof, successor, native_proof = self.reconciled_failed_successor_renewal_state()
        incoming = dict(proof, validation_source=state['source'])
        normal_key = native_proof['receipt_sha256']
        mutations = [
            ('missing-normal', lambda s: s['reconciled_owners'].pop(normal_key)),
            ('isolated-only', lambda s: s['reconciled_owners'][normal_key].update(purpose='isolated-validation')),
            ('wrong-owner', lambda s: s['reconciled_owners'][normal_key]['owner'].update(request_token='foreign')),
            ('wrong-occurrence', lambda s: s['reconciled_owners'][normal_key].update(occurrence='foreign')),
            ('wrong-original-occurrence', lambda s: s['reconciled_owners'][proof['receipt_sha256']].update(occurrence='foreign')),
            ('wrong-contract', lambda s: s['plan']['gates'][-1].update(command=['false'])),
            ('wrong-environment', lambda s: s['attempts'][-1]['results'][0]['execution_binding'].update(environment='0'*64)),
            ('missing-environment', lambda s: s['attempts'][-1]['results'][0]['execution_binding'].pop('environment')),
            ('not-executed', lambda s: s['attempts'][-1]['results'][0].update(executed=False)),
            ('cancelled', lambda s: s['attempts'][-1]['results'][0].update(cancelled=True)),
            ('timed-out', lambda s: s['attempts'][-1]['results'][0].update(timed_out=True)),
            ('unknown-exit', lambda s: s['attempts'][-1]['results'][0].update(native_exit=None)),
            ('wrong-token', lambda s: s['attempts'][-1]['results'][0].update(token='foreign')),
            ('interrupted-attempt', lambda s: s['attempts'][-1].update(interrupted=True)),
            ('partial-attempt', lambda s: s['attempts'][-1].update(phase='quick')),
            ('missing-case', lambda s: s['attempts'][-1]['results'][0]['cases'].pop(next(iter(successor['cases'])))),
            ('foreign-isolation', lambda s: s['attempts'][-1]['results'][0]['isolated_validation'][0].update(original_request_token='foreign')),
            ('changed-exclusions', lambda s: s['attempts'][-1]['results'][0]['isolated_validation'][0].update(excluded_resources={})),
            ('unknown-latest', lambda s: s['attempts'].append(dict(phase='focused', results=[dict(successor, token='new-unknown')]))),
            ('running', lambda s: s.update(running={'gate':successor['gate']})),
            ('live-failures', lambda s: s.update(live_failures=[])),
            *[(phase, lambda s, phase=phase: s.update(phase=phase))
              for phase in ('interrupted', 'ready', 'quick', 'focused', 'initial', 'final', 'stale', 'unknown')]]
        for label, mutate in mutations:
            with self.subTest(label=label):
                candidate = copy.deepcopy(state); mutate(candidate); before = copy.deepcopy(candidate)
                with self.assertRaises(ValueError): c.reconcile(candidate, original['token'], incoming)
                self.assertEqual(before, candidate)
        files = [Path(successor['log']).parent/'receipt.json',
                 Path(successor['log']).parent/'request.json', Path(successor['worker_result'])]
        for paths, suffix in [(native_proof['files'], '/summary.json'),
                              (native_proof['files'], '/lifecycle.json'),
                              (native_proof['files'], '/meta'),
                              (native_proof['files'], '.owner'), (proof['files'], '/meta')]:
            files.append(next(Path(p) for p in paths if p.endswith(suffix)))
        for file in files:
            with self.subTest(file=file):
                raw = file.read_bytes(); file.write_bytes(raw+b' ')
                before = copy.deepcopy(state)
                try:
                    with self.assertRaises(ValueError): c.reconcile(state, original['token'], incoming)
                    self.assertEqual(before, state)
                finally: file.write_bytes(raw)

    def test_isolated_renewal_accepts_only_quiescent_repair_phases(self):
        state, paths, proof, gate, packet, original = self.renewal_state()
        incoming = dict(proof, validation_source=state['source'])
        for phase in ('triage', 'needs-focused-plan', 'failed-gates'):
            with self.subTest(phase=phase):
                candidate = copy.deepcopy(state); candidate['phase'] = phase
                c.reconcile(candidate, original['token'], incoming)
                self.assertEqual(phase, candidate['phase'])

    def test_isolated_native_validation_requires_current_os_payload_authority(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        fleet = next(p for p in Path(proof['campaign']).parent.parent.joinpath('runs').iterdir()
                     if p.is_dir() and p.name.endswith('310001'))
        life = c.read(fleet / '_batch/lifecycle.json')
        payloads = {}
        for key in ('run', 'backend', 'services'):
            path = self.root / '.context' / (key + '.body'); path.write_text(key)
            payloads[key] = str(path); proof['files'][str(path)] = c.sha_file(path)
        from datetime import datetime, timezone
        value = dict(kind='exact-original-current-os-read-only', result='QUIESCED_CURRENT_OS', identity_guards_pass=True,
            observed_at=datetime.now(timezone.utc).isoformat(),
            machine_id='old-machine', guest_run_token=life['fleet_owner_token']+'-0', source=state['source']['head'],
            driver_current_alive=False, socket_scan_readable=True, remote_effective_uid=0,
            kernel_exclusion_flag=0x00200000, unreadable_live_userland_errno_counts={},
            **dict.fromkeys(('original_service_pid_present_count', 'original_pid_identity_unproven_or_reused_count',
                'scoped_execution_process_count','owned_listening_port_count','unreadable_proc_count','financial_calls','mutations'), 0),
            **{k+'_sha256':c.sha_file(v) for k,v in payloads.items()})
        observed = self.root / '.context/current-os.json'
        data = dict(status='TERMINAL', native_exit=0, guard_identity_status='PASS',
                    protected_original_inputs_unchanged=True, native_result=value)
        c.write(observed, data)
        import time
        proof['confirmed_at'] = time.time()
        proof['execution_quiescence']['old-machine'] = dict(current_os=str(observed), **payloads)
        proof['files'][str(observed)] = c.sha_file(observed)
        c.reconcile(state, failure['id'], proof)
        for changed in [dict(value, unreadable_proc_count=1), dict(value, unreadable_proc_count=False),
                        {k:v for k,v in value.items() if k != 'observed_at'},
                        dict(value, observed_at='invalid'), dict(value, observed_at='2100-01-01T00:00:00+00:00'),
                        dict(value, observed_at='2000-01-01T00:00:00+00:00')]:
            with self.subTest(changed=changed):
                data['native_result'] = changed; c.write(observed, data)
                proof['files'][str(observed)] = c.sha_file(observed)
                before = copy.deepcopy(state)
                with self.assertRaises(ValueError):
                    c.reconcile(state, failure['id'], proof)
                self.assertEqual(before, state)

    def test_isolated_native_validation_refuses_active_or_reused_or_narrowed_resources_atomically(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        original = copy.deepcopy(state)
        data = c.read(packet); data['rows'][0]['metadata']['state'] = 'started'; c.write(packet, data)
        proof['files'][str(packet)] = c.sha_file(packet)
        with self.assertRaisesRegex(ValueError, 'not provider terminal'):
            c.reconcile(state, failure['id'], proof)
        self.assertEqual(original, state)
        data['rows'][0]['metadata']['state'] = 'destroyed'; c.write(packet, data)
        proof['files'][str(packet)] = c.sha_file(packet)
        c.reconcile(state, failure['id'], proof)
        state['source'] = proof['validation_source']
        request = dict(token='new', source=state['source'], checks=gate['checks'], skips={})
        for env, changed in [({'CLOUDBENCH_ARCHIVED_REUSE_REQUEST':'old'}, request),
                             ({}, dict(request, checks=gate['checks'][:-1])),
                             ({}, dict(request, source=dict(head='e'*40, digest='f'*64)))]:
            with self.subTest(env=env, changed=changed), self.assertRaises(ValueError):
                c.isolated_request(state, gate, changed, self.root, env)

    def recovered_campaign_state(self):
        import hashlib
        import shutil
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        fleet = parents[1]
        life_path = fleet / '_batch/lifecycle.json'
        life = c.read(life_path); owner = life['fleet_owner_token']
        life['audit_sha256'] = ''; c.write(life_path, life)
        disposable_path = fleet / '_batch/disposable-cleanup.json'
        disposable = c.read(disposable_path)
        disposable.update(guest_cleanup_missing=True, runtime_evidence_missing=True)
        c.write(disposable_path, disposable)
        bench = json.loads((fleet / '_batch/benches.json').read_text())[0]['name']
        out = fleet / bench; out.mkdir()
        machine, token = '48e7553f5dd4e8', owner + '-0'
        identity = 'linux:89e3de7f-53c5-4dc4-acdd-f64b80fd7bd2:44005'
        (out / '.cid').write_text('clone ' + machine + '\n')
        (out / 'guest-shutdown.confirmed').write_text(fleet.name + '\n')
        c.write(out / 'runtime-evidence.owner.json', dict(version=1, machine_id=machine, run_token=token))
        runtime = out / 'remote-logs/runtime-evidence'; (runtime / 'logs').mkdir(parents=True)
        for name in ('run.json', 'stack.log', 'logs/backend.log', 'logs/worker.log'):
            (runtime / name).write_text('{}\n')
        root = 'f7a07bad-5a1c-4e4a-83e5-5da46b0f655f'
        snapshot = dict(root_exists=True, root_deleted=False, root_user_id='1f85ff25-6e29-4c1b-8739-f917bd101a30',
            tree_agent_ids=[root], unsealed_tree_agent_ids=[root], browser_sessions=[], purchase_cleanup=[])
        final = {**snapshot, 'root_deleted': True, 'unsealed_tree_agent_ids': []}
        logs = dict(cloud_cleanup_evidence=dict(root_agent_id=root, before=snapshot, after=final, final=final,
                    payment_snapshot=final, provider_receipts=[], errors=[], warnings=[]),
                    cloud_provider_cleanup=dict(root_agent_id=root, root_deleted=True, tree_sealed=True, provider_receipts=[]),
                    cloud_payment_cleanup=dict(root_agent_id=root, purchases=[]))
        c.write(runtime / 'run.json', dict(tasks=[dict(name=bench, agent_id=root,
            graded_root_creation_outcome='allocated', logs=logs,
            owned_roots=[dict(root_agent_id=root, task_name=bench, role='graded',
                             creation=dict(source='create_agent_return', root_agent_id=root), logs=logs)])]))
        c.write(runtime / 'services.json', dict(status='stopped', run_sh_pid=2560, env=dict(worker_processes=1)))
        status = runtime / ('cloudbench-stack-cleanup-' + token + '.status')
        status.write_text('version=2\ntoken=' + token + '\nstate=clean\nstack_pid=2560\n'
                          'stack_birth=Tue Nov  3 08:23:40 2026\nstack_native_identity=' + identity + '\n')
        c.write(runtime / 'manifest.json', dict(version=1, machine_id=machine, run_token=token,
            files={str(p.relative_to(runtime)): dict(bytes=p.stat().st_size, sha256=c.sha_file(p))
                   for p in runtime.rglob('*') if p.is_file()}))
        audit = fleet / 'teardown-ownership'; (audit / 'source-audit').unlink()
        (audit / 'owned-clones.ids').write_text(machine + '\n')
        (audit / 'owned-clones.names').write_text('clone-j2\n')
        (audit / 'fresh').mkdir(exist_ok=True)
        (audit / 'fresh/clone-j2').write_text(''.join(f'{k}={v}\n' for k, v in dict(
            fleet_owner_token=owner, run_id=fleet.name, app='fixture', source='fresh-clone',
            disposition='destroyed-provider-retained', machine_id=machine, clone_name='clone-j2',
            volume_id='vol_fixture').items()))
        canonical = self.root / '.git/cloudbench-fleet-audits' / owner
        shutil.rmtree(canonical); shutil.copytree(audit, canonical)
        h = hashlib.sha256()
        for path in sorted(audit.rglob('*'), key=lambda p: str(p.relative_to(audit))):
            if path.is_file():
                for raw in (str(path.relative_to(audit)).encode(), path.read_bytes()):
                    h.update(len(raw).to_bytes(8, 'big')); h.update(raw)
        (audit / 'source-audit').write_text(f'path={canonical}\nsha256={h.hexdigest()}\n')
        proof['recovered_runtime'] = {str(fleet): {bench: identity}}
        for path in [*fleet.rglob('*'), *canonical.rglob('*')]:
            if path.is_file(): proof['files'][str(path)] = c.sha_file(path)
        return state, occurrence, paths, proof, fleet, runtime

    def test_campaign_recovered_v2_release_keeps_failed_missing_facts(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state['attempts'])
        originals = {p: p.read_bytes() for p in (fleet / '_batch').glob('*.json')}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        release = entry['recovered_release_evidence'][str(fleet)]
        self.assertEqual('', release['original_lifecycle']['audit_sha256'])
        self.assertTrue(release['original_disposable_cleanup']['runtime_evidence_missing'])
        self.assertFalse(release['credit_granted']); self.assertFalse(entry['credit_granted'])
        self.assertEqual(before, state['attempts'])
        self.assertEqual(originals, {p: p.read_bytes() for p in originals})
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        (runtime / 'logs/worker.log').write_text('changed')
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_campaign_recovered_v2_identity_and_seal_refusals_are_atomic(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state)
        bad = copy.deepcopy(proof); bad['recovered_runtime'][str(fleet)] = {'task-2': 'linux:' + '0' * 36 + ':1'}
        for variant in (bad, {**proof, 'source': {}}, {**proof, 'owner': {}}):
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        for path, raw in [(runtime / 'manifest.json', b'{}'),
                          (fleet / 'teardown-ownership/source-audit', b'path=/wrong\nsha256=bad\n'),
                          (fleet / 'task-2/guest-shutdown.confirmed', b'wrong\n'),
                          (runtime / 'logs/worker.log', b'changed')]:
            original = path.read_bytes(); path.write_bytes(raw)
            variant = copy.deepcopy(proof); variant['files'][str(path)] = c.sha_file(path)
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state); path.write_bytes(original)
        (runtime / 'unreported').write_text('extra')
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_campaign_shared_cleanup_and_publication_refusals_are_atomic(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        before = copy.deepcopy(state)
        campaign = Path(proof['campaign']); summary = campaign / 'summary.json'
        original = summary.read_bytes()
        for flag in ('shared_transport_cleanup_pending', 'cleanup_ticket_failure', 'shared_inventory_failed', 'startup_cohorts'):
            value = c.read(summary)
            value[flag] = [{'cleanup_budget_retirement_pending': True}] if flag == 'startup_cohorts' else True
            c.write(summary, value)
            variant = copy.deepcopy(proof); variant['files'][str(summary)] = c.sha_file(summary)
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, 'campaign .*pending'):
                c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state); summary.write_bytes(original)
        ack = campaign / 'hub-group-publication-ack.private.json'; raw = ack.read_bytes()
        ack.unlink()
        variant = copy.deepcopy(proof); variant['files'].pop(str(ack))
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); ack.write_bytes(raw)
        value = json.loads(raw); value['record_sha256'] = '0' * 64; c.write(ack, value)
        variant = copy.deepcopy(proof); variant['files'][str(ack)] = c.sha_file(ack)
        with self.assertRaisesRegex(ValueError, 'campaign publication'):
            c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); ack.write_bytes(raw)
        with patch('deploy_test_cloud.subprocess.check_output', return_value='123 2147483000 S\n'):
            with self.assertRaisesRegex(ValueError, 'publisher cleanup'):
                c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_campaign_recovered_root_provider_and_payment_refusals_are_atomic(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state)
        path, manifest = runtime / 'run.json', runtime / 'manifest.json'
        original, original_manifest = path.read_bytes(), manifest.read_bytes()
        variants = []
        for mode in ('missing', 'unowned', 'custody_role', 'primary_fixture_role', 'missing_creation', 'custody_creation', 'missing_outcome', 'graded_mismatch',
                     'unsealed', 'provider', 'provider_status', 'payment'):
            value = json.loads(original); task = value['tasks'][0]
            if mode == 'missing': task['logs'].pop('cloud_provider_cleanup')
            elif mode == 'unowned': task['owned_roots'] = []
            elif mode == 'custody_role': task['owned_roots'][0]['role'] = 'foreign'
            elif mode == 'primary_fixture_role': task['owned_roots'][0]['role'] = 'fixture_first_run'
            elif mode == 'missing_creation': task['owned_roots'][0].pop('creation')
            elif mode == 'custody_creation': task['owned_roots'][0]['creation']['source'] = 'unconfirmed'
            elif mode == 'missing_outcome': task.pop('graded_root_creation_outcome')
            elif mode == 'graded_mismatch':
                task['owned_roots'][0]['root_agent_id'] = '80c4dd2e-388a-45c4-9daf-ded6979266c8'
                task['owned_roots'][0]['creation']['root_agent_id'] = task['owned_roots'][0]['root_agent_id']
            else:
                for logs in (task['logs'], task['owned_roots'][0]['logs']):
                    evidence = logs['cloud_cleanup_evidence']
                    if mode == 'unsealed': evidence['final']['unsealed_tree_agent_ids'] = [task['agent_id']]
                    if mode in ('provider', 'provider_status'):
                        for phase in ('before', 'after', 'final', 'payment_snapshot'):
                            evidence[phase]['browser_sessions'] = [dict(agent_id=task['agent_id'], provider='tilion',
                                                                         session_id='sess_fixture_12345')]
                    if mode == 'provider_status':
                        receipt = dict(provider='tilion', session_id='sess_fixture_12345', status=401, response_sha256='0' * 64)
                        evidence['provider_receipts'] = [receipt]
                        logs['cloud_provider_cleanup']['provider_receipts'] = [receipt]
                    if mode == 'payment':
                        purchase = dict(purchase_id='33a666aa-dd56-4a71-a014-9330397ffd61', agent_id=task['agent_id'],
                            status='HELD', funding_status='RECLAIMING', total_cents=4396, card_id='card-fixture',
                            stripe_payment_intent_id=None, provider_transfer_id='transfer', reclaim_provider_transfer_id=None)
                        evidence['payment_snapshot']['purchase_cleanup'] = [purchase]
                        logs['cloud_payment_cleanup']['purchases'] = [purchase]
            variants.append((mode, value))
        for mode, value in variants:
            c.write(path, value); seal = json.loads(original_manifest)
            seal['files']['run.json'] = dict(bytes=path.stat().st_size, sha256=c.sha_file(path)); c.write(manifest, seal)
            variant = copy.deepcopy(proof)
            for changed in (path, manifest): variant['files'][str(changed)] = c.sha_file(changed)
            with self.subTest(mode=mode), self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        path.write_bytes(original); manifest.write_bytes(original_manifest)

    def test_large_native_result_binds_without_materializing_logs(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        path = parents[0] / '_batch/run.json'
        with path.open('wb') as stream:
            stream.write(b'{"native_log":"')
            for _ in range(65):
                stream.write(b'x' * (1024 * 1024))
            stream.write(b'","tasks":[],"status":"failed"}')
        proof['files'][str(path)] = c.sha_file(path)
        before = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state['attempts'])
        self.assertFalse(state['reconciled_owners'][proof['receipt_sha256']]['credit_granted'])

    def test_campaign_cleanup_membership_preserves_all_native_unknowns(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        original = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(15, len(entry['participants']))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(original, state['attempts'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual('live-transfer-required', entry['retained_services'][0]['owner']['status'])
        self.assertEqual({'UNVERIFIED'}, set(state['attempts'][-1]['results'][0]['cases'].values()))
        receipt = state['attempts'][-1]['results'][0]
        self.assertFalse(c._reconciled(state, receipt, {**proof['owner'], 'request_token': 'new'}))
        receipt['token'] = 'new'
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_campaign_unloaded_run_records_share_aggregate_raw_allowance(self):
        # Ordinary participants verify run.json without loading it, yet still charge
        # the proof's one aggregate raw-run allowance shared with the bounded reader.
        import deploy_test_native_cleanup as native
        import deploy_test_run_artifact as artifact
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        records = [Path(p) for p in proof['files'] if p.endswith('/_batch/run.json')]
        total = sum(p.stat().st_size for p in records)
        self.assertEqual(15, len(records))
        before = copy.deepcopy(state)
        with patch.object(native, 'MAX_RAW_FORENSIC_RUN_BYTES', total - 1), \
                self.assertRaisesRegex(ValueError, 'aggregate raw admission bound exceeded'):
            c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)
        with patch.object(native, 'MAX_RAW_FORENSIC_RUN_BYTES', total), \
                patch.object(artifact, 'read_run_artifact', side_effect=AssertionError('loaded ordinary run')):
            c.reconcile(state, occurrence['id'], proof)
        self.assertFalse(state['reconciled_owners'][proof['receipt_sha256']]['credit_granted'])

    def test_campaign_missing_cleanup_and_mutations_refuse_atomically(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        before = copy.deepcopy(state)
        for field, value in [('receipt_sha256', '0' * 64), ('worker_result_sha256', '0' * 64),
                             ('request_token', 'wrong'), ('source', {}), ('campaign', '/wrong')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                c.reconcile(state, occurrence['id'], {**proof, field: value})
            self.assertEqual(before, state)
        for path in [Path(proof['campaign']) / 'summary.json', parents[0] / '_batch/disposable-cleanup.json']:
            raw = path.read_bytes(); doc = json.loads(raw)
            if path.name == 'summary.json': doc['jobs'] = doc['jobs'][:-1]
            else: doc['runtime_evidence_missing'] = True
            c.write(path, doc)
            variant = copy.deepcopy(proof); variant['files'][str(path)] = c.sha_file(path)
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
            path.write_bytes(raw)
        summary_path = Path(proof['campaign']) / 'summary.json'
        raw = summary_path.read_bytes(); doc = json.loads(raw); doc['jobs'][0]['controller_pid'] += 1
        c.write(summary_path, doc)
        variant = copy.deepcopy(proof); variant['files'][str(summary_path)] = c.sha_file(summary_path)
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); summary_path.write_bytes(raw)
        log = Path(proof['campaign']) / 'r001-j0003.log'; raw = log.read_bytes()
        log.write_bytes(b''.join(reversed(raw.splitlines(keepends=True))))
        variant = copy.deepcopy(proof); variant['files'][str(log)] = c.sha_file(log)
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); log.write_bytes(raw)
        (parents[0].parent / 'unreported').mkdir()
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_native_cloud_cleanup_proof_refusals_are_atomic(self):
        state, occurrence, paths, proof, hub = self.native_recon_state()
        before = copy.deepcopy(state)
        variants = [{**proof, 'receipt_sha256': '0' * 64}, {**proof, 'worker_result_sha256': '0' * 64},
            {**proof, 'request_token': 'other'}, {**proof, 'source': {}},
            {**proof, 'owner': {**proof['owner'], 'native_cleanup_reference': {}}},
            {**proof, 'files': {k: v for k, v in proof['files'].items() if k != str(hub)}},
            {**proof, 'confirmed_at': 1}, {**proof, 'confirmed_at': float('inf')},
            {**proof, 'controller_log': str(self.root / 'foreign.log')}]
        for variant in variants:
            with self.subTest(proof=variant), self.assertRaises(ValueError):
                c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        unsupported = copy.deepcopy(state)
        next(g for g in unsupported['plan']['gates'] if g['name'] == occurrence['gate']).pop('native_cloud')
        with self.assertRaises(ValueError): c.reconcile(unsupported, occurrence['id'], proof)
        self.assertEqual(before, state)
        runs = Path(proof['controller_log']).parent
        (runs / 'unrecorded').mkdir()
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_reconciliation_refusals_are_atomic(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        before = copy.deepcopy(state)
        def altered(key, **changes):
            doc = json.loads(paths[key].read_text()); doc.update(changes)
            path = self.directory / f'altered-{key}.json'; path.write_text(json.dumps(doc)); return str(path)
        variants = {
            'wrong token': {**proof, 'request_token': 'other'},
            'owner field': {**proof, 'owner': {**proof['owner'], 'turn_id': 'turn-x'}},
            'receipt sha': {**proof, 'receipt_sha256': 'a' * 64},
            'adapter sha': {**proof, 'worker_result_sha256': 'a' * 64},
            'platform sha': {**proof, 'platform_result': {**proof['platform_result'], 'sha256': 'a' * 64}},
            'audit sha': {**proof, 'native_audit': {**proof['native_audit'], 'sha256': 'a' * 64}},
            'process sha': {**proof, 'process': {**proof['process'], 'sha256': 'a' * 64}},
            'platform host': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'], 'executionInstanceId': 'other'}), 'sha256': None}},
            'platform not completed': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'], 'status': 'running'}), 'sha256': None}},
            'audit not clean': {**proof, 'native_audit': {'path': altered('audit', cleanup_complete=False), 'sha256': None}},
            'process not quiescent': {**proof, 'process': {'path': altered('process', quiescent=False), 'sha256': None}},
            'process remaining': {**proof, 'process': {'path': altered('process', remaining=[1]), 'sha256': None}},
            'early confirmation': {**proof, 'confirmed_at': 1793664000.0},
            'non-finite confirmation': {**proof, 'confirmed_at': float('inf')},
            'missing observer': {**proof, 'observed_by': ''},
            'missing field': {k: v for k, v in proof.items() if k != 'process'},
            'missing proof file': {**proof, 'process': {'path': str(self.directory / 'nope.json'), 'sha256': shas['process']}},
            'with link': {**proof, 'repair_agent': 'https://boxes.dev/thread/thr_x'},
            'with resource flag': {**proof, 'resource_skip': {}},
            'with assigned flag': {**proof, 'assigned_repair': True},
            'wrong pgid': {**proof, 'owner': {**proof['owner'], 'pgid': 7}},
            'wrong message_id': {**proof, 'owner': {**proof['owner'], 'message_id': 'other'}},
            'wrong owner request_token': {**proof, 'owner': {**proof['owner'], 'request_token': 'other'}},
            'modified embedded evidence': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'],
                'output': {'text': json.loads(paths['platform'].read_text())['data']['output']['text'].replace('"tail": "ok"', '"tail": "edited"')}}), 'sha256': None}},
        }
        import hashlib
        for label, variant in variants.items():
            with self.subTest(variant=label):
                for key in ('platform_result', 'native_audit', 'process'):
                    if variant.get(key, {}).get('sha256') is None and isinstance(variant.get(key), dict):
                        variant[key]['sha256'] = hashlib.sha256(Path(variant[key]['path']).read_bytes()).hexdigest()
                with self.assertRaises(ValueError):
                    c.reconcile(state, occurrence['id'], variant)
                self.assertEqual(before, state)
        with self.assertRaises(ValueError):  # unknown occurrence
            c.reconcile(state, 'no-such-id', proof)
        self.assertEqual(before, state)
        # an unrelated same-token receipt on disk (different cases/identity) is refused; the recorded receipt is the binding
        unrelated = copy.deepcopy(json.loads(paths['receipt'].read_text())); unrelated['cases'] = {'cloudbench-controller': 'FAIL'}
        paths['receipt'].chmod(0o600); original_bytes = paths['receipt'].read_bytes(); c.write(paths['receipt'], unrelated)
        import hashlib
        with self.assertRaisesRegex(ValueError, 'differs from the recorded receipt|exact receipt'):
            c.reconcile(state, occurrence['id'], {**proof, 'receipt_sha256': hashlib.sha256(paths['receipt'].read_bytes()).hexdigest()})
        self.assertEqual(before, state); paths['receipt'].write_bytes(original_bytes)
        # malformed (non-object) or oversize adapter JSON fails closed in the legacy path
        for label, body in (('non-object', '[1, 2]'), ('oversize', '{"pad": "' + 'x' * (c.MAX_RECEIPT_BYTES + 1) + '"}')):
            with self.subTest(legacy=label):
                bad = self.directory / f'legacy-{label}.json'; bad.write_text(body)
                broken = copy.deepcopy(state); broken['attempts'][-1]['results'][0]['worker_result'] = str(bad)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
                    c.retained_owners(broken, ['cloudbench-controller'])
                bad.unlink()
        # a gate with no retained owner cannot be "reconciled"
        plain = copy.deepcopy(self.state); failure = self.failure.__func__(self) if False else None
        self.state['phase'] = 'initial'; c.advance(self.state, [self.result(a='FAIL', b='PASS')])
        with self.assertRaisesRegex(ValueError, 'no retained owner|latest incomplete'):
            c.reconcile(self.state, self.state['failures'][-1]['id'], proof)

    def test_quick_timeout_bound_is_120_seconds(self):
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(self.plan['gates'][0], self.state, self.directory, self.root)
            self.assertEqual(120, runner.call_args.kwargs['timeout'])

    def test_false_exit_zero_missing_protocol_is_not_a_pass(self):
        self.plan['gates'][1]['case_protocol'] = True
        result = c.execute(self.plan['gates'][1], self.state, self.directory, self.root)
        self.assertEqual('FAIL', result['status'])
        self.assertEqual({'a': 'UNVERIFIED', 'b': 'UNVERIFIED'}, result['cases'])

    def test_real_case_receipt_and_skip_omission(self):
        g=self.plan['gates'][1];g['case_protocol']=True
        self.state['skips']['api/a']={'source':self.state['source'], 'disposition':'external / waived'}
        g['command']=[sys.executable,'-c',
          "import os,json; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); "
          "assert q['checks']==['b']; assert 'a' in q['skips']; "
          "json.dump({**q,'complete':True,'cleanup_complete':True,'cases':{'b':'PASS'}},open(os.environ['DEPLOY_GATE_RESULT'],'w'))"]
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertEqual('PASS',result['status'])
        self.assertEqual({'a':'SKIP','b':'PASS'},result['cases'])

    def test_parallel_workers_are_launched_before_any_completes(self):
        barrier=self.root/'.context'/'barrier';barrier.mkdir(parents=True)
        script="""import os,pathlib,time
p=pathlib.Path(os.environ['BARRIER']); (p/os.environ['WORKER']).touch()
end=time.monotonic()+2
while len(list(p.iterdir()))<2 and time.monotonic()<end: time.sleep(.01)
assert len(list(p.iterdir()))==2
"""
        for g in self.plan['gates'][1:3]:
            g.update(command=[sys.executable,'-c',script],
                     env={**g['env'], 'BARRIER':str(barrier),'WORKER':g['name']})
        self.state=c.initialize(self.plan,self.root);self.state['phase']='initial'
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertTrue(self.state['ready'])

    def test_unrelated_repair_retains_skip_without_rerunning_it(self):
        self.plan['gates'][1]['input_paths'] = ['code']
        self.state = c.initialize(self.plan, self.root)
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL'), self.result('ui', c='FAIL')])
        report = {'failures': []}
        for f in self.state['failures']:
            if f['gate'] == 'api':
                e = self.report(f, 'NOT_INTRODUCED', external_provider={'name':'p','reason':'outage'})
            else:
                e = self.report(f)
            report['failures'].extend(e['failures'])
        c.adjudicate(self.state, report)
        (self.root/'unrelated').write_text('changed')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual(new['source'], self.state['skips']['api/a']['source'])
        self.assertNotIn('pending', self.state)

    def test_changed_skip_inputs_require_new_evidence_not_test_retry(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     external_provider={'name':'p','reason':'outage'}))
        self.state['phase'] = 'stale'
        (self.root/'code').write_text('changed')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual({}, self.state['skips'])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('triage', self.state['phase'])
        self.assertEqual('api/a', self.state['failures'][-1]['check'])

    def test_rca_dispatch_starts_while_other_gate_is_running(self):
        signal_file=self.root/'.context'/'rca-started'
        bad="import os,json,sys; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); json.dump({**q,'complete':True,'cleanup_complete':True,'cases':dict.fromkeys(q['checks'],'FAIL')},open(os.environ['DEPLOY_GATE_RESULT'],'w')); sys.exit(1)"
        wait="import pathlib,time; p=pathlib.Path(%r); e=time.monotonic()+3;\nwhile not p.exists() and time.monotonic()<e: time.sleep(.01)\nassert p.exists()" % str(signal_file)
        self.plan['gates'][1].update(command=[sys.executable,'-c',bad],case_protocol=True)
        self.plan['gates'][2]['command']=[sys.executable,'-c',wait]
        launcher=[sys.executable,'-c',"import pathlib,json; pathlib.Path(%r).touch(); print(json.dumps({'ok':True,'status':'delivered'}))" % str(signal_file)]
        self.state=c.initialize(self.plan,self.root);self.state['phase']='initial'
        c.run_phase(self.plan,self.state,self.directory,self.root,launcher)
        self.assertTrue(signal_file.exists())
        rows=self.state['attempts'][-1]['results']
        self.assertEqual('PASS',next(r['status'] for r in rows if r['gate']=='ui'))
        self.assertEqual(2,len(list((self.directory/'rca').glob('*.launch.json'))))

    def early_failure_fixture(self, final_case_a, launcher_exit=None):
        """api reports check a FAIL while still running, then blocks (5 s at most) until its early
        occurrence exists: the RCA request file without a launcher (the /deploy flow), or the
        cycle's own launch with one."""
        import contextlib, io
        signal_file = self.root / '.context' / 'rca-started'
        rca_dir = self.directory / 'rca'
        ready = ('any(pathlib.Path(%r).glob("*.json"))' % str(rca_dir) if launcher_exit is None
                 else 'pathlib.Path(%r).exists()' % str(signal_file))
        gate = ("import os,json,pathlib,sys,time; sys.path.insert(0,%r); import deploy_gate_progress as p\n"
                "p.report('a','FAIL',scope='test',case='a',detail='AssertionError: early')\n"
                "p.report('a','FAIL',scope='case',case='a')\n"  # a second row for the same check
                "e=time.monotonic()+5\n"
                "while not (%s) and time.monotonic()<e: time.sleep(.02)\n"
                "q=json.load(open(os.environ['DEPLOY_GATE_REQUEST']))\n"
                "json.dump({**q,'complete':True,'cleanup_complete':True,"
                "'cases':{'a':%r,'b':'PASS'},'rca_started_before_exit':bool(%s)},open(os.environ['DEPLOY_GATE_RESULT'],'w'))\n"
                "sys.exit(0 if %r=='PASS' else 1)") % (str(Path(c.__file__).resolve().parent), ready, final_case_a,
                                                       ready, final_case_a)
        self.plan['gates'][1].update(command=[sys.executable, '-c', gate], case_protocol=True)
        launcher = None if launcher_exit is None else [
            sys.executable, '-c', "import pathlib,json,sys; sys.exit(%d) if %d else None; "
            "pathlib.Path(%r).touch(); print(json.dumps({'ok':True,'status':'delivered'}))"
            % (launcher_exit, launcher_exit, str(signal_file))]
        self.state = c.initialize(self.plan, self.root); self.state['phase'] = 'initial'
        out = io.StringIO()
        with patch.object(c, 'EARLY_POLL_SECONDS', 0.05, create=True), contextlib.redirect_stdout(out):
            c.run_phase(self.plan, self.state, self.directory, self.root, launcher)
        worker = json.loads((self.directory / 'attempts' / '1' / 'initial' / 'api' / 'result.json').read_text())
        notices = [l for l in out.getvalue().splitlines() if l.startswith('DEPLOY_GATE_EARLY_FAILURE')]
        return out.getvalue(), notices, worker

    def test_failing_test_in_a_running_gate_starts_rca_before_the_gate_ends(self):
        printed, notices, worker = self.early_failure_fixture('FAIL')
        self.assertTrue(worker['rca_started_before_exit'], 'the RCA request must exist while the gate runs')
        self.assertEqual(1, len(notices), notices)  # one notice per failing check, not per row
        early = self.state['early_failures']
        request = self.directory / 'rca' / (early[0]['id'] + '.json')
        self.assertEqual('DEPLOY_GATE_EARLY_FAILURE gate=api test=a status=FAIL check=api/a '
                         f"id={early[0]['id']} rca={request} (start /RCA on this request now)", notices[0])
        # The rca= token, split on whitespace, is the request path itself (2026-11-07: a trailing ':' was not).
        self.assertTrue(Path(notices[0].split('rca=', 1)[1].split()[0]).is_file())
        self.assertTrue(request.is_file())
        self.assertEqual([('api/a', 'reused by final FAIL')], [(f['check'], f['settled']) for f in early])
        failure = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        self.assertEqual(early[0]['id'], failure['id'])  # the final failure keeps the early occurrence
        self.assertEqual([], list((self.directory / 'rca').glob('*.launch.json')))  # the agent owns it
        self.assertEqual('triage', self.state['phase'])

    def test_with_a_cycle_launcher_the_early_rca_launches_without_an_agent_notice(self):
        printed, notices, worker = self.early_failure_fixture('FAIL', launcher_exit=0)
        self.assertTrue(worker['rca_started_before_exit'], 'the cycle must launch the RCA while the gate runs')
        self.assertEqual([], notices)  # the cycle owns this RCA; nothing asks the agent to start one
        self.assertEqual(1, len(list((self.directory / 'rca').glob('*.launch.json'))))  # one RCA, not two
        failure = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        self.assertEqual(self.state['early_failures'][0]['id'], failure['id'])

    def test_with_a_cycle_launcher_a_passing_check_prints_no_stop_request(self):
        printed, notices, worker = self.early_failure_fixture('PASS', launcher_exit=0)
        self.assertEqual('superseded: final PASS', self.state['early_failures'][0]['settled'])
        self.assertNotIn('DEPLOY_GATE_EARLY_SUPERSEDED', printed)  # the agent started nothing to stop

    def test_early_occurrences_per_gate_are_capped_and_the_rest_wait_for_the_result(self):
        gate = {'name': 'backend', 'checks': [f'blackbox:d{i}' for i in range(15)]}
        self.state['round'] = 1
        rows = [progress.row(f'd{i}', 'FAIL', scope='domain') for i in range(12)]
        opened = c.early_failures(self.state, gate, rows, self.directory)
        self.assertEqual(c.EARLY_LIMIT, len(opened))
        self.assertEqual([f'backend/blackbox:d{i}' for i in range(c.EARLY_LIMIT)], [o['check'] for o, _p, _r in opened])
        self.assertEqual([], c.early_failures(self.state, gate, [progress.row('d14', 'FAIL', scope='domain')],
                                              self.directory))

    def test_a_failed_cycle_launch_is_kept_with_the_other_launch_errors(self):
        printed, notices, worker = self.early_failure_fixture('FAIL', launcher_exit=3)
        self.assertEqual([], notices)
        self.assertTrue(any('CalledProcessError' in e or 'exit status 3' in e
                            for e in self.state.get('rca_launch_errors', [])), self.state.get('rca_launch_errors'))

    def test_a_progress_row_naming_no_gate_check_opens_nothing(self):
        gate = {'name': 'api', 'checks': ['a', 'b']}
        self.state['round'] = 1
        row = progress.row('zzz', 'FAIL', case='zzz')
        self.assertEqual([], c.early_failures(self.state, gate, [row], self.directory))
        self.assertNotIn('early_failures', self.state)
        single = {'name': 'ui', 'checks': ['c']}
        [(occurrence, path, _row)] = c.early_failures(self.state, single, [row], self.directory)
        self.assertEqual('ui/c', occurrence['check'])  # a single-check gate owns every row
        self.assertTrue(path.is_file())

    def test_early_failure_whose_gate_then_passes_is_superseded_not_a_failure(self):
        printed, notices, worker = self.early_failure_fixture('PASS')
        self.assertEqual(1, len(notices))
        occurrence = self.state['early_failures'][0]
        self.assertEqual('superseded: final PASS', occurrence['settled'])
        self.assertIn(f"DEPLOY_GATE_EARLY_SUPERSEDED gate=api check=api/a id={occurrence['id']} "
                      'superseded: final PASS', printed)
        self.assertEqual([], [f for f in self.state['failures'] if f['gate'] == 'api'])
        self.assertTrue(self.state['ready'])

    def test_final_phase_rejects_pass_cache_configuration(self):
        self.plan['gates'][1]['command']=['run-deploy-stage','api','--reuse-passed']
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_remote_transport_cannot_run_without_its_original_deadline(self):
        self.plan['gates'][1]['result_transport']='stdout'
        with self.assertRaisesRegex(ValueError,'existing gate deadline'):
            c.validate_plan(self.plan)

    def test_plan_removal_at_repair_boundary_is_refused(self):
        self.failure();self.state['phase']='stale'
        (self.root/'code').write_text('fixed')
        new={**self.plan,'source':c.source(self.root),'gates':self.plan['gates'][:2]}
        with self.assertRaises(ValueError): c.refresh(self.state,self.plan,new,self.root)

    def test_forged_old_plan_cannot_shrink_final_selection(self):
        f=self.failure();c.adjudicate(self.state,self.report(f))
        (self.root/'code').write_text('fixed')
        forged={**self.plan,'gates':self.plan['gates'][:2]}
        new={**forged,'source':c.source(self.root)}
        with self.assertRaisesRegex(ValueError,'previous plan'):
            c.refresh(self.state,forged,new,self.root)

    def test_repair_cannot_swap_full_gate_command_for_a_green_command(self):
        f=self.failure();c.adjudicate(self.state,self.report(f))
        new=__import__('copy').deepcopy(self.plan)
        new['gates'][1]['command']=['echo','not the original tests']
        with self.assertRaisesRegex(ValueError,'full gate command'):
            c.refresh(self.state,self.plan,new,self.root)

    def test_repair_cannot_swap_the_worker_case_recipe(self):
        self.plan['gates'][1]['worker_recipe']={'cases':{'a':{'command':['true']},'b':{'command':['false']}}}
        self.plan['gates'][1]['case_protocol']=True
        self.state=c.initialize(self.plan,self.root)
        f=self.failure();c.adjudicate(self.state,self.report(f))
        new=__import__('copy').deepcopy(self.plan)
        new['gates'][1]['worker_recipe']['cases']['b']['command']=['true']
        with self.assertRaisesRegex(ValueError,'original case command'):
            c.refresh(self.state,self.plan,new,self.root)

    def test_worker_exit_zero_with_failed_case_blocks(self):
        g=self.plan['gates'][1];g['case_protocol']=True
        g['command']=[sys.executable,'-c',"import os,json; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); json.dump({**q,'complete':True,'cleanup_complete':True,'cases':dict.fromkeys(q['checks'],'FAIL')},open(os.environ['DEPLOY_GATE_RESULT'],'w'))"]
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertFalse(result['complete'])
        self.assertEqual('FAIL',result['status'])

    def test_parallel_rca_plan_keeps_unknown_peer_blocking(self):
        self.state['phase']='initial'
        c.advance(self.state,[self.result(a='FAIL'),self.result('ui',c='FAIL')])
        a,b=self.state['failures'];report={'failures':[self.report(a)['failures'][0],self.report(b,'UNKNOWN')['failures'][0]]}
        with self.assertRaises(ValueError): c.adjudicate(self.state,report)
        self.assertEqual(2,len(self.state['pending']))
        self.assertNotIn('disposition',self.state['failures'][0])

    def test_environment_change_invalidates_run(self):
        with patch.dict(os.environ,{'TEST_NEW_AUTH_CONTEXT':'different'}):
            with self.assertRaises(ValueError): c.run_phase(self.plan,self.state,self.directory,self.root)

    def test_initialized_gitlink_hashes_index_oid_without_descending(self):
        module = self.root / 'module'; module.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(module), *args]).decode().strip()
        git('init', '-q')
        (module / 'file').write_text('first')
        git('add', '.')
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first')
        first = git('rev-parse', 'HEAD')
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--add', '--cacheinfo',
                        '160000,' + first + ',module'], check=True)
        source = c.source(self.root)
        inputs = c.input_fingerprints(self.plan, self.root)
        (module / 'file').write_text('second')
        git('add', '.')
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second')
        self.assertEqual(source, c.source(self.root))
        self.assertEqual(inputs, c.input_fingerprints(self.plan, self.root))
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--cacheinfo',
                        '160000,' + git('rev-parse', 'HEAD') + ',module'], check=True)
        self.assertNotEqual(source, c.source(self.root))
        self.assertNotEqual(inputs, c.input_fingerprints(self.plan, self.root))

    def test_unmerged_index_refuses_both_fingerprint_functions(self):
        oid = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD:code']).decode().strip()
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--index-info'], check=True,
                       input=('0 ' + '0' * 40 + '\tcode\n100644 ' + oid + ' 2\tcode\n').encode())
        for name, invoke in [('source', lambda: c.source(self.root)),
                             ('inputs', lambda: c.input_fingerprints(self.plan, self.root))]:
            with self.subTest(function=name), self.assertRaisesRegex(ValueError, 'unambiguous merged index'):
                invoke()

    def test_benchmark_output_ledger_does_not_invalidate_source(self):
        history=self.root/'agents/benchmarks/history';history.mkdir(parents=True)
        (history/'task_attempts.jsonl').write_text('{"new":"result"}\n')
        self.assertEqual(self.state['source'],c.source(self.root))
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertTrue(self.state['ready'])

    def test_ignored_config_change_invalidates_running_and_saved_results(self):
        with (self.root/'.git/info/exclude').open('a') as stream: stream.write('.env\n')
        (self.root/'.env').write_text('TOKEN=first')
        self.state=c.initialize(self.plan,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        (self.root/'.env').write_text('TOKEN=second')
        self.assertEqual(5,c.verify_saved(self.directory,self.root))
        with self.assertRaises(ValueError): c.run_phase(self.plan,self.state,self.directory,self.root)

    def test_saved_verify_rejects_tampered_plan_and_wrong_head(self):
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(5,c.verify_saved(self.directory,self.root,'different-head'))
        saved=c.read(self.directory/'cycle.json');saved['plan']['gates'].pop()
        c.write(self.directory/'cycle.json',saved)
        self.assertEqual(5,c.verify_saved(self.directory,self.root))

    def test_ignored_frontend_env_invalidates_ready_receipt(self):
        with (self.root/'.git/info/exclude').open('a') as stream:
            stream.write('front-end/.env\n')
        config=self.root/'front-end/.env';config.parent.mkdir();config.write_text('VITE_ORIGIN=first')
        for gate in self.plan['gates']:
            gate['input_paths']=['code']
        state=c.initialize(self.plan,self.root)
        c.run_phase(self.plan,state,self.directory,self.root)
        c.run_phase(self.plan,state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        config.write_text('VITE_ORIGIN=second')
        self.assertEqual(5,c.verify_saved(self.directory,self.root))

    def test_ignored_benchmark_temporal_env_invalidates_ready_receipt(self):
        with (self.root/'.git/info/exclude').open('a') as stream:
            stream.write('agents/.env.benchmark-temporal\n')
        config = self.root/'agents/.env.benchmark-temporal'
        config.parent.mkdir()
        config.write_text('CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fixture-first\n')
        config.chmod(0o600)
        for gate in self.plan['gates']:
            gate['input_paths'] = ['code']
        state = c.initialize(self.plan, self.root)
        c.run_phase(self.plan, state, self.directory, self.root)
        c.run_phase(self.plan, state, self.directory, self.root)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        original_source = c.source(self.root)
        config.write_text('CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fixture-second\n')
        self.assertEqual(original_source, c.source(self.root))
        self.assertEqual(5, c.verify_saved(self.directory, self.root))
        config.unlink()
        self.assertEqual(5, c.verify_saved(self.directory, self.root))

    def test_cli_runs_real_commands_and_refuses_reinitialization(self):
        plan_path=self.root/'.context/plan.json';c.write(plan_path,self.plan)
        args=['--plan',str(plan_path),'--state-dir',str(self.directory),'--root',str(self.root)]
        self.assertEqual(0,c.main(['init',*args]))
        self.assertEqual(2,c.main(['init',*args]))
        self.assertEqual(0,c.main(['run',*args]))
        self.assertEqual(0,c.main(['verify',*args]))
        self.assertEqual(['quick','initial'],[a['phase'] for a in c.read(self.directory/'cycle.json')['attempts']])

    def test_existing_pipeline_verifies_exact_staged_evidence(self):
        import run_deploy_pipeline as pipeline
        c.run_phase(self.plan,self.state,self.directory,self.root)
        with patch.object(pipeline,'SOURCE_ROOT',self.root):
            self.assertNotEqual(0,pipeline.verify(self.directory))
            c.run_phase(self.plan,self.state,self.directory,self.root)
            self.assertEqual(0,pipeline.verify(self.directory,self.state['source']['head']))
            (self.root/'code').write_text('later source')
            self.assertEqual(5,pipeline.verify(self.directory))

    def test_required_staged_mode_refuses_a_legacy_green_receipt(self):
        import run_deploy_pipeline as pipeline
        c.write(self.directory/'receipt.json',{'status':'passed','source':self.state['source']})
        with patch.object(pipeline,'SOURCE_ROOT',self.root):
            self.assertEqual(2,pipeline.verify(self.directory,require_staged=True))

    def test_timeout_is_not_convertible_to_completed_case_skip(self):
        g=self.plan['gates'][1]
        g.update(command=[sys.executable,'-c','import time; time.sleep(3)'],timeout_seconds=.03)
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertTrue(result['timed_out'])
        self.assertFalse(result['complete'])
        self.assertFalse(result['lingering_group'])

    def test_refresh_cannot_rebind_unknown_occurrences_to_a_new_source(self):
        f=self.failure()
        original=copy.deepcopy(f)
        (self.root/'code').write_text('edit before triage')
        new={**self.plan,'source':c.source(self.root)}
        c.refresh(self.state,self.plan,new,self.root)
        self.assertEqual('quick',self.state['phase'])
        self.assertEqual('triage',self.state['next_after_quick'])
        self.assertEqual([f['id']],self.state['pending'])
        self.assertEqual(original,f)
        self.assertNotEqual(f['source'],self.state['source'])
        self.assertEqual(new['source'],self.state['source'])
        self.assertFalse(self.state['ready'])
        self.assertEqual({},self.state['skips'])

    def test_cancellation_is_interrupted_not_a_failed_gate_or_ready(self):
        timer=threading.Timer(.04,c.CANCEL.set)
        self.plan['gates'][0]['command']=[sys.executable,'-c','import time; time.sleep(3)']
        self.state=c.initialize(self.plan,self.root)
        timer.start()
        try: c.run_phase(self.plan,self.state,self.directory,self.root)
        finally: timer.join()
        self.assertEqual('interrupted',self.state['phase'])
        self.assertFalse(self.state['ready'])
        result=next(r for r in self.state['attempts'][-1]['results'] if r['gate']=='static')
        self.assertTrue(result['cancelled'])
        self.assertNotEqual(0,result['native_exit'])


    def test_focused_phase_launches_workers_only_after_its_quick_checks(self):
        # A focused repair of a quick check keeps that check's short budget on an idle host:
        # a worker it shares the phase with starts only after every quick check has returned.
        state=copy.deepcopy(self.state)
        state.update(phase='focused',repair_gates=['backend-structural','api'],
                     focused={'backend-structural':{'command':['true'],'checks':['backend-structural']},
                              'api':{'command':['true'],'checks':['a','b']}})
        import time
        events,lock=[],threading.Lock()
        def fake(gate,state,*_args,**_kwargs):
            with lock:events.append(('start',gate['name']))
            time.sleep(.2 if gate.get('quick') else 0)
            with lock:events.append(('end',gate['name']))
            return {**self.result(gate['name'],**{k:'PASS' for k in gate['checks']}),'gate':gate['name']}
        with patch.object(c,'execute',side_effect=fake):
            c.run_phase(self.plan,state,self.directory,self.root)
        self.assertLess(events.index(('end','backend-structural')),events.index(('start','api')))
        self.assertEqual({'backend-structural','api'},{r['gate'] for r in state['attempts'][-1]['results']})

    def test_cancel_during_quick_checks_never_launches_deferred_workers(self):
        state=copy.deepcopy(self.state)
        state.update(phase='focused',repair_gates=['backend-structural','api'],
                     focused={'backend-structural':{'command':['true'],'checks':['backend-structural']},
                              'api':{'command':['true'],'checks':['a','b']}})
        launched=[]
        def fake(gate,state,*_args,**_kwargs):
            launched.append(gate['name']);c.CANCEL.set()
            return {**self.result(gate['name'],**{k:'UNVERIFIED' for k in gate['checks']}),'gate':gate['name'],'cancelled':True}
        with patch.object(c,'execute',side_effect=fake):
            c.run_phase(self.plan,state,self.directory,self.root)
        self.assertEqual(['backend-structural'],launched)
        self.assertEqual('interrupted',state['phase'])

    def test_ambiguous_rca_submit_is_not_automatically_repeated(self):
        f=self.failure();paths=c.rca_requests(self.state,self.directory)
        count=self.root/'.context'/'submitted'
        launcher=[sys.executable,'-c',"import pathlib,sys; p=pathlib.Path(%r); p.write_text(p.read_text()+'x' if p.exists() else 'x'); sys.exit(1)" % str(count)]
        with self.assertRaises(subprocess.CalledProcessError): c.launch_rca(paths[0],launcher)
        with self.assertRaisesRegex(ValueError,'may have succeeded'): c.launch_rca(paths[0],launcher)
        self.assertEqual('x',count.read_text())

    def test_quick_failure_cannot_drop_pending_skip_revalidation(self):
        f=self.failure();c.adjudicate(self.state,self.report(f,'NOT_INTRODUCED',
            external_provider={'name':'p','reason':'outage'}));self.state['phase']='stale'
        (self.root/'code').write_text('changed');new={**self.plan,'source':c.source(self.root)}
        c.refresh(self.state,self.plan,new,self.root)
        c.advance(self.state,[self.result('static',lint='FAIL')])
        self.assertEqual(2,len(self.state['pending']))


KIND = 'local-supervisor-cleanup-v1'


class LocalCleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker'
        self.worker.mkdir()
        (self.worker / '.context').mkdir()
        (self.worker / '.context/native-worker-admission.lock').touch()
        self.folder = self.root / 'cycle/attempts/33/triage/backend-coverage-blackbox'
        self.folder.mkdir(parents=True)
        self.token = 'captured-setup-failure'
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        command = [sys.executable, str(ROOT / 'scripts/deploy_test_backend.py'), '--root', str(self.worker)]
        self.recipe = {'cases': {x: {'command': ['npm', 'run', 'test:coverage:sharded'], 'cwd': 'back-end'}
                                  for x in ['blackbox:browser-provider', 'teardown']},
                       'setup': {'command': ['bash', 'scripts/run-deploy-stage', '--start']},
                       'cleanup': {'command': ['bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']},
                       'services': True}
        self.gate = {'name': 'backend-coverage-blackbox', 'native_backend': True,
                     'worker_transport': 'local-isolated', 'worker_root': str(self.worker),
                     'cwd': str(self.worker), 'command': command, 'checks': list(self.recipe['cases']),
                     'worker_recipe': self.recipe, 'case_protocol': True, 'result_transport': 'file'}
        self.request = {'token': self.token, 'source': self.source, 'gate': self.gate['name'],
                        'checks': self.gate['checks'], 'skips': {}, 'phase': 'triage',
                        'worker_root': str(self.worker), 'worker_recipe': self.recipe}
        runner = self.worker / '.context/deploy-backend/native/runner.log'
        runner.parent.mkdir(parents=True)
        runner.write_text('No ready Postgres container owned by this worktree.\nNo services to kill\n')
        self.result = {k: self.request[k] for k in ['token', 'source', 'gate', 'worker_root']}
        self.result.update(cases={'blackbox:browser-provider': 'UNVERIFIED', 'teardown': 'FAIL'},
                           complete=False, cleanup_complete=False, reused=False, native_exit=1,
                           recipe_digest=c.digest(self.recipe), source_unchanged=True,
                           runner_log=str(runner), interrupted=False,
                           evidence={'teardown': {'exit': 1, 'recipe_cleanup_exit': 0},
                                     'artifacts': {'runner_log': c.sha_file(runner)}})
        self.receipt = {k: self.request[k] for k in ['token', 'source', 'gate']}
        self.receipt.update(command=command, cases=dict.fromkeys(self.gate['checks'], 'UNVERIFIED'),
                            native_exit=1, executed=True, complete=False, timed_out=False, cancelled=False,
                            lingering_group=False, lifecycle='owned', started_at=100, finished_at=200,
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            reason='worker result identity/inventory mismatch')
        self.receipt.update(execution_binding={'contract_digest': c.digest(self.gate)},
                            host_admission={'started': True, 'lock': str(self.worker / '.context/native-worker-admission.lock')})
        self.process = dict(supervisor_pid=123, child_pid=124, native_exit=1, cancelled=False,
                            timed_out=False, quiescent=True, orphaned_children=False,
                            reaped=[{'pid': 124, 'status': 256}], term_sent=[], kill_sent=[], remaining=[], error=None)
        self.paths = {n: self.folder / n for n in ['request.json', 'result.json', 'receipt.json', 'output.log.process.json']}
        for name, value in zip(self.paths, [self.request, self.result, self.receipt, self.process]):
            c.write(self.paths[name], value)
        (self.folder / 'output.log').write_text(json.dumps(self.result))
        self.failure = dict(id='occurrence', gate=self.gate['name'],
                            check=self.gate['name'] + '/blackbox:browser-provider', native_result='UNVERIFIED', complete=False)
        self.failure.update(source=self.source, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'], finished_at=200)
        self.state = dict(plan={'gates': [self.gate]}, attempts=[{'results': [self.receipt]}],
                          failures=[self.failure], phase='triage', pending=['occurrence'], repair_gates=[],
                          source=self.source, skips={}, ready=False)
        self.proof = dict(kind=KIND, files={n: c.sha_file(p) for n, p in self.paths.items()},
                          confirmed_at=201, observed_by='independent-native-review')
        self.original_bytes = {n: p.read_bytes() for n, p in self.paths.items()}

    def reconcile(self):
        c.reconcile(self.state, 'occurrence', self.proof)

    def test_quiescent_cleanup_allows_real_reexecute_without_credit_or_rewriting(self):
        with self.assertRaisesRegex(ValueError, 'cleanup state unknown'):
            c.reexecute(copy.deepcopy(self.state), 'occurrence')
        self.reconcile()
        self.assertEqual([], c.retained_owners(self.state, [self.gate['name']]))
        c.reexecute(self.state, 'occurrence')
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertEqual([self.gate['name']], self.state['repair_gates'])
        self.assertEqual('UNVERIFIED', self.failure['native_result'])
        self.assertEqual(self.original_bytes, {n: p.read_bytes() for n, p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_process_and_cleanup_unknowns_refuse(self):
        for field, value in [('quiescent', False), ('orphaned_children', True), ('remaining', [999]),
                             ('cancelled', True), ('timed_out', True), ('term_sent', [124]),
                             ('kill_sent', [124]), ('error', 'read failed'), ('native_exit', 0),
                             ('reaped', []), ('reaped', [{'pid': 999, 'status': 256}])]:
            with self.subTest(field=field, value=value):
                c.write(self.paths['output.log.process.json'], {**self.process, field: value})
                self.proof['files']['output.log.process.json'] = c.sha_file(self.paths['output.log.process.json'])
                with self.assertRaises(ValueError): self.reconcile()
                self.assertNotIn('reconciled_owners', self.state)
        c.write(self.paths['output.log.process.json'], self.process)
        self.proof['files']['output.log.process.json'] = c.sha_file(self.paths['output.log.process.json'])
        for value in [None, 1, '0']:
            self.result['evidence']['teardown']['recipe_cleanup_exit'] = value
            c.write(self.paths['result.json'], self.result)
            self.proof['files']['result.json'] = c.sha_file(self.paths['result.json'])
            with self.assertRaises(ValueError): self.reconcile()

    def test_identity_inventory_root_and_recipe_mismatches_refuse(self):
        changes = [('token', 'other'), ('source', {}), ('gate', 'other'), ('worker_root', str(self.root)),
                   ('recipe_digest', '0' * 64), ('cases', {}), ('cleanup_owner', {'unknown': True}),
                   ('reused', True), ('interrupted', True)]
        for field, value in changes:
            with self.subTest(field=field):
                c.write(self.paths['result.json'], {**self.result, field: value})
                self.proof['files']['result.json'] = c.sha_file(self.paths['result.json'])
                with self.assertRaises(ValueError): self.reconcile()
                self.assertNotIn('reconciled_owners', self.state)

    def test_missing_corrupt_or_changed_evidence_never_allows_launch(self):
        self.reconcile()
        for name, path in self.paths.items():
            original = path.read_bytes()
            for bad in [b'not-json', original + b' ']:
                with self.subTest(name=name, bad=bad[:10]):
                    path.write_bytes(bad)
                    with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])
                    path.write_bytes(original)
            path.unlink()
            with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])
            path.write_bytes(original)
        runner = Path(self.result['runner_log'])
        runner.write_text('changed cleanup evidence')
        with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])

    def test_only_current_owned_local_backend_and_independent_proof_are_eligible(self):
        for field, value in [('worker_transport', 'boxes-thread'), ('native_backend', False),
                             ('worker_root', str(self.root)), ('command', ['other'])]:
            old = self.gate[field]
            self.gate[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.reconcile()
            self.gate[field] = old
        for field, value in [('confirmed_at', 99), ('observed_by', ''), ('files', {})]:
            old = self.proof[field]
            self.proof[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.reconcile()
            self.proof[field] = old
        self.receipt['lingering_group'] = True
        c.write(self.paths['receipt.json'], self.receipt)
        self.proof['files']['receipt.json'] = c.sha_file(self.paths['receipt.json'])
        with self.assertRaises(ValueError): self.reconcile()

    def test_current_root_process_or_admission_owner_refuses(self):
        import fcntl
        with (self.worker / '.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(ValueError): self.reconcile()
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'], cwd=self.worker)
        try:
            with self.assertRaises(ValueError): self.reconcile()
        finally:
            proc.terminate()
            proc.wait(timeout=2)
        self.reconcile()
        c.write(self.worker / '.context/services.json', {'worktree': str(self.worker), 'status': 'running'})
        with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])

    def post55_fixture(self):
        import datetime
        import hashlib
        import shutil
        import time
        import deploy_test_backend_post_cleanup as post
        import deploy_test_backend_post_cleanup_audit as auditor
        self.post55_module = post
        self.post55_auditor = auditor
        self.enterContext(patch.object(auditor, 'DB_LOCK_ROOT', self.root / 'db-locks'))
        now = time.time()
        self.receipt.update(status='FAIL', started_at=now-100, finished_at=now-50,
                            lingering_group=False, native_cleanup_reference=None, cleanup_owner=None)
        self.process['reaped'] += [{'pid': 125, 'status': 7 << 8}, {'pid': 126, 'status': 9}]
        env = dict(CONDUCTOR_WORKSPACE_NAME='post55', CONDUCTOR_PORT='21530', ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME='1')
        names = ['blackbox:ok', 'blackbox:bad', 'blackbox:treasury-rails', 'units', 'fps', 'teardown', 'coverage-threshold']
        self.recipe = {'cases': {n: dict(command=['npm','run','test:coverage:sharded'], cwd='back-end', env=dict(env), aggregate=False, sweep='backend-coverage-blackbox') for n in names},
                       'execution_timeout_seconds': 14400}
        self.gate.update(checks=names, worker_recipe=self.recipe, env=dict(env), selection_evidence=['original selection'])
        skips = {'blackbox:treasury-rails': {'source': dict(self.source), 'rca': {'id': 'standing', 'attribution': 'NOT_INTRODUCED'}}}
        self.request.update(checks=[n for n in names if n not in skips], skips=skips, worker_recipe=self.recipe)
        self.receipt.update(cases={n: 'SKIP' if n in skips else 'UNVERIFIED' for n in names},
                            execution_binding={'contract_digest': c.digest(self.gate)})
        native = self.worker / '.context/deploy-backend' / hashlib.sha256(self.token.encode()).hexdigest()
        native.mkdir(parents=True)
        evidence = {'artifacts': {'summaries': {}}, 'shard_logs': {}, 'unknown_domains': []}
        def put(path, text):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text); return c.sha_file(path)
        evidence['artifacts']['runner_log'] = put(native/'runner.log', 'Started coverage shard 1/2\ncompleted failed sweep\n')
        for key, filename, role in [('units','units.log','units_log'), ('fps','units-probe.log','fps_log')]:
            f=self.worker/'back-end/coverage'/filename
            evidence[key]={'exit':0,'log':str(f)};evidence['artifacts'][role]=put(f,'PASS\n')
        for key, filename, role in [('teardown','teardown.log','teardown_log'), ('coverage-threshold','threshold.log','threshold_log')]:
            f=native/filename;evidence[key]={'log':str(f)};evidence['artifacts'][role]=put(f,'native failure retained\n')
        evidence['teardown'].update(exit=1, command=['bash','scripts/tests/blackbox-backend-teardown.test.sh'],
                                   recipe_cleanup_exit=None, recipe_setup_exit=None)
        evidence['coverage-threshold'].update(identity=None, reason='unverified native coverage')
        for i in (1,2):
            f=self.worker/'back-end/coverage'/('shard-%d.log'%i);evidence['shard_logs'][str(f)]=put(f,'native shard joined\n')
            f=self.worker/'back-end/coverage'/('blackbox-run-shard%d'%i)/'summary.json'
            evidence['artifacts']['summaries'][str(f)]=put(f,'{"results":[]}\n')
        for name,passed in [('blackbox:ok',True),('blackbox:bad',False)]:
            evidence[name]={'passed':passed,'aborted':False,'shard':next(iter(evidence['artifacts']['summaries']))}
        self.post55_fixture_row=dict(id='d'*64,name='/victoria-db-post55',image='sha256:'+'e'*64,image_name='pgvector/pgvector:pg16',
          owner=str(self.worker),running=True,status='running',paused=False,restarting=False,dead=False,
          ports={'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'21535'}]},
          mounts=[{'Name':'victoria-pgdata-post55','Destination':'/var/lib/postgresql/data','Type':'volume','RW':True}])
        for n in ['postgres-before.json','postgres-after.json']:c.write(native/n,self.post55_fixture_row)
        evidence['postgres_fixture']=dict(id='d'*64,name='victoria-db-post55',image='sha256:'+'e'*64,
            volume='victoria-pgdata-post55',port=21535,restored=False,
            before_sha256=c.sha_file(native/'postgres-before.json'),after_sha256=c.sha_file(native/'postgres-after.json'))
        self.result.update(worker_root=str(self.worker), recipe_digest=c.digest(self.recipe), native_command=['npm','run','test:coverage:sharded'],
            runner_log=str(native/'runner.log'), cases={'blackbox:ok':'PASS','blackbox:bad':'FAIL','units':'PASS','fps':'PASS','teardown':'FAIL','coverage-threshold':'UNVERIFIED'}, evidence=evidence,
            reused=False,interrupted=False,source_unchanged=True,native_exit=1,complete=False,cleanup_complete=False)
        self.receipt['worker_evidence']=copy.deepcopy(evidence)
        c.write(native/'result.json',self.result)
        self.failure.update(check=self.gate['name']+'/blackbox:bad',finished_at=self.receipt['finished_at'])
        self.state['skips']={self.gate['name']+'/'+k:copy.deepcopy(v)for k,v in skips.items()}
        self.proof.update(layout=post.LAYOUT,original_skips=copy.deepcopy(skips),artifacts={})
        _,expected=post.expected_artifacts(self.worker,self.receipt,self.result)
        for original in expected:
            original=Path(original);dest=self.root/'sealed'/hashlib.sha256(str(original).encode()).hexdigest()
            dest.parent.mkdir(exist_ok=True);shutil.copyfile(original,dest)
            self.proof['artifacts'][str(original)]={'path':str(dest),'sha256':c.sha_file(dest),'bytes':dest.stat().st_size}
        self.post55_spec=post.audit_spec(self.worker,self.receipt,self.gate,next(iter(self.recipe['cases'].values())),self.post55_fixture_row)
        for name in self.post55_spec['locks']:
            f=Path(name);f.parent.mkdir(parents=True,exist_ok=True);f.touch()
        (self.worker/'.context/test-runs/.port-locks').mkdir(parents=True,exist_ok=True)
        manifest=self.worker/'.context/test-runs/post55/manifest.json'
        c.write(manifest,{'base_url':'http://localhost:21552'})
        self.post55_docker={'snapshot':copy.deepcopy(self.post55_fixture_row),'runtime':{'pid':300,'started_at':'2020-01-01T00:00:00Z','ips':['172.17.0.2']}}
        self.post55_proxy={'pid':301,'birth':'12345','exe':'docker-proxy','inode':'99','binding':{
            '-proto':'tcp','-host-ip':'127.0.0.1','-host-port':'21535','-container-ip':'172.17.0.2','-container-port':'5432'}}
        self.enterContext(patch.object(auditor,'_call',side_effect=AssertionError('synthetic test must not invoke metadata commands')))
        self.post55_docker_mock=self.enterContext(patch.object(auditor,'_docker',return_value=self.post55_docker))
        self.post55_proxy_mock=self.enterContext(patch.object(auditor,'_proxy',return_value=self.post55_proxy))
        self.post55_process_mock=self.enterContext(patch.object(auditor,'_processes',return_value=([],[])))
        self.post55_listener_mock=self.enterContext(patch.object(auditor,'_listeners',return_value=[{'port':21535,'inode':'99','uid':0}]))
        # Pair this synthetic source identity with its own immutable fixture bytes.
        # Do not require a historical branch object in a fresh/shallow checkout.
        producer_blobs = {name: (ROOT / name).read_bytes() for name in post.PINS}
        producer_pins = {name: hashlib.sha256(raw).hexdigest()
                         for name, raw in producer_blobs.items()}
        self.enterContext(patch.object(post, 'PINS', producer_pins))
        def fixture_source_bytes(root, head, name):
            self.assertEqual((root, head), (self.worker, self.source['head']))
            return producer_blobs[name]
        self.enterContext(patch.object(post, 'source_bytes', side_effect=fixture_source_bytes))
        row=auditor.observe(self.post55_spec);self.post55_audit_path=self.root/'physical-audit.json';c.write(self.post55_audit_path,row)
        self.proof.update(audit={'path':str(self.post55_audit_path),'sha256':c.sha_file(self.post55_audit_path)},confirmed_at=time.time())
        self.post55_write_controls()
        self.original_bytes={n:p.read_bytes()for n,p in self.paths.items()}

    def post55_write_controls(self):
        for name,value in zip(self.paths,[self.request,self.result,self.receipt,self.process]):c.write(self.paths[name],value)
        self.proof['files']={n:c.sha_file(p)for n,p in self.paths.items()}

    def test_post55_cleanup_reconciles_launch_only_and_revalidates(self):
        self.post55_fixture()
        original=copy.deepcopy(self.state)
        self.reconcile()
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        entry=self.state['reconciled_owners'][self.proof['files']['receipt.json']]
        self.assertIs(entry['credit_granted'],False)
        self.assertFalse(self.result['cleanup_complete']);self.assertFalse(self.result['complete'])
        self.assertEqual(original['pending'],self.state['pending'])
        self.assertEqual(original['skips'],self.state['skips'])
        self.assertEqual(original['failures'],self.state['failures'])
        for name,path in self.paths.items():self.assertEqual(self.original_bytes[name],path.read_bytes())
        self.post55_process_mock.return_value=([{'pid':999}],[])
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    def test_post55_physical_observer_refuses_unknown_busy_and_foreign(self):
        self.post55_fixture()
        auditor=self.post55_auditor
        for matched,unknown in [([{'pid':999}],[]),([],[{'pid':999}])]:
            with self.subTest(processes=(matched,unknown)):
                self.post55_process_mock.return_value=(matched,unknown)
                with self.assertRaises(ValueError):self.reconcile()
        self.post55_process_mock.return_value=([],[])
        for port in [21530,21550,21551,21552,21553,21554,21555]:
            with self.subTest(listener=port):
                self.post55_listener_mock.return_value=[{'port':21535,'inode':'99','uid':0},{'port':port,'inode':'100','uid':1002}]
                with self.assertRaises(ValueError):self.reconcile()
        self.post55_listener_mock.return_value=[{'port':21535,'inode':'99','uid':0}]
        for path in [self.worker/'.context/native-worker-admission.lock', *map(Path,self.post55_spec['locks'])]:
            with self.subTest(busy=str(path)),path.open('r')as handle:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises((ValueError,BlockingIOError)):self.reconcile()
        reservation=self.worker/'.context/test-runs/.port-locks/21551';reservation.mkdir()
        with self.assertRaises(ValueError):self.reconcile()
        reservation.rmdir()
        unknown_lock=self.worker/'.context/test-runs/.port-locks/21551.lock';unknown_lock.touch()
        with self.assertRaises(ValueError):self.reconcile()
        unknown_lock.unlink()
        for key,value in [('id','f'*64),('owner',str(self.root/'foreign')),('status','exited')]:
            with self.subTest(fixture=key):
                mutated=copy.deepcopy(self.post55_docker);mutated['snapshot'][key]=value
                self.post55_docker_mock.return_value=mutated
                with self.assertRaises(ValueError):self.reconcile()
        mutated=copy.deepcopy(self.post55_docker);mutated['runtime']['started_at']='2099-01-01T00:00:00Z'
        self.post55_docker_mock.return_value=mutated
        with self.assertRaises(ValueError):self.reconcile()
        self.post55_docker_mock.return_value=self.post55_docker
        foreign=copy.deepcopy(self.post55_proxy);foreign['binding']['-container-ip']='172.17.0.99'
        self.post55_proxy_mock.return_value=foreign
        with self.assertRaises(ValueError):self.reconcile()
        self.post55_proxy_mock.return_value=self.post55_proxy
        c.write(self.worker/'.context/services.json',{'status':'running','worktree':str(self.worker),'ports':{'backend':21530}})
        with self.assertRaises(ValueError):self.reconcile()

    def test_post55_proof_native_wait_and_skip_negatives(self):
        self.post55_fixture()
        original_proof=copy.deepcopy(self.proof)
        mutations=[('missing-audit',lambda p:p.pop('audit')),('unknown-audit',lambda p:p['audit'].update(path=str(self.root/'missing.json'))),
          ('skip-removed',lambda p:p.update(original_skips={})),('skip-source',lambda p:p['original_skips']['blackbox:treasury-rails'].update(source={'head':'c'*40,'digest':'d'*64})),
          ('services-recipe',lambda p:p.update(layout='backend-prisma-preflight-v1')),
          ('wrong-audit-hash',lambda p:p['audit'].update(sha256='0'*64)),('confirmed-bool',lambda p:p.update(confirmed_at=True))]
        for label,mutate in mutations:
            with self.subTest(proof=label):
                self.proof=copy.deepcopy(original_proof);mutate(self.proof)
                with self.assertRaises(ValueError):self.reconcile()
        self.proof=original_proof
        pristine=copy.deepcopy(self.process)
        for rows in [[{'pid':124,'status':0}], [{'pid':124,'status':256},{'pid':124,'status':0}],
                     [{'pid':True,'status':256}], [{'pid':124,'status':True}], [{'pid':124,'status':256},{'pid':127,'status':4991}],
                     [{'pid':124,'status':256},{'pid':127,'status':65535}], [{'pid':124,'status':256},{'pid':123,'status':0}], []]:
            with self.subTest(waits=rows):
                self.process=copy.deepcopy(pristine);self.process['reaped']=rows;self.post55_write_controls()
                with self.assertRaises(ValueError):self.reconcile()
        self.process=pristine;self.post55_write_controls()
        for key,value in [('quiescent',1),('orphaned_children',True),('native_exit',True),('error','unknown'),('term_sent',[124])]:
            with self.subTest(supervisor=key):
                self.process=copy.deepcopy(pristine);self.process[key]=value;self.post55_write_controls()
                with self.assertRaises(ValueError):self.reconcile()
        self.process=pristine;self.post55_write_controls()
        for name,path in self.paths.items():
            with self.subTest(changed=name):
                before=path.read_bytes();path.write_bytes(before+b' ')
                with self.assertRaises(ValueError):self.reconcile()
                path.write_bytes(before)
        for row in self.proof['artifacts'].values():
            path=Path(row['path']);before=path.read_bytes();path.write_bytes(before+b' ')
            with self.assertRaises(ValueError):self.reconcile()
            path.write_bytes(before)
        native_verdict=self.result['cases']['blackbox:ok'];self.result['cases']['blackbox:ok']='FAIL';self.post55_write_controls()
        with self.assertRaisesRegex(ValueError,'native domain verdict'):self.reconcile()
        self.result['cases']['blackbox:ok']=native_verdict;self.post55_write_controls()
        self.reconcile()
        entry=self.state['reconciled_owners'][self.proof['files']['receipt.json']]
        entry['credit_granted']=True
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    def test_post55_current_contract_and_observer_are_typed(self):
        self.post55_fixture();self.reconcile()
        original_gate=copy.deepcopy(self.gate)
        for key,value in [('case_protocol',1),('native_backend',1)]:
            with self.subTest(contract=key):
                self.gate[key]=value
                with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
                self.gate.clear();self.gate.update(copy.deepcopy(original_gate))
        self.gate['worker_recipe']['services']=True
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.gate.clear();self.gate.update(copy.deepcopy(original_gate))
        with patch.object(self.post55_module,'AUDITOR_SHA256','0'*64):
            with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        original=c.read(self.post55_audit_path)
        for key,value in [('unknown',[{'pid':2}]),('matched',[{'pid':3}]),('observed_at',True),('services',{'status':'running'}),('ports',[True])]:
            with self.subTest(audit=key):
                row=copy.deepcopy(original);row[key]=value;c.write(self.post55_audit_path,row)
                entry=self.state['reconciled_owners'][self.proof['files']['receipt.json']]
                entry['proof']['audit']['sha256']=c.sha_file(self.post55_audit_path)
                with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        c.write(self.post55_audit_path,original)

    def test_post55_recipe_source_observer_and_original_skip_seals(self):
        import shutil
        self.post55_fixture()
        original_recipe=copy.deepcopy(self.recipe)
        for key,value in [('services',True),('setup',{'command':['true']}),('cleanup',{'command':['true']})]:
            with self.subTest(recipe=key):
                self.recipe[key]=value
                self.result['recipe_digest']=c.digest(self.recipe)
                self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
                self.post55_write_controls()
                with self.assertRaisesRegex(ValueError,'no-services recipe'):self.reconcile()
                self.recipe.clear();self.recipe.update(copy.deepcopy(original_recipe))
        self.result['recipe_digest']=c.digest(self.recipe)
        self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
        self.post55_write_controls()
        with patch.object(self.post55_module,'source_bytes',return_value=b'changed original producer'):
            with self.assertRaisesRegex(ValueError,'original producer changed'):self.reconcile()
        observer=Path(self.post55_auditor.__file__)
        alias=self.root/'observer.py';shutil.copyfile(observer,alias);alias.chmod(0o644)
        alias.write_bytes(alias.read_bytes()+b'\n# drift\n')
        with patch.object(self.post55_auditor,'__file__',str(alias)):
            with self.assertRaisesRegex(ValueError,'observer source/mode'):self.reconcile()
        shutil.copyfile(observer,alias);alias.chmod(0o600)
        with patch.object(self.post55_auditor,'__file__',str(alias)):
            with self.assertRaisesRegex(ValueError,'observer source/mode'):self.reconcile()
        original_skips=copy.deepcopy(self.request['skips'])
        self.request['skips']={};self.post55_write_controls()
        with self.assertRaisesRegex(ValueError,'original skips'):self.reconcile()
        self.request['skips']=original_skips;self.post55_write_controls()
        self.reconcile()
        self.gate['selection_evidence']=['renewed typed selection metadata']
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        self.gate['checks'].append('blackbox:new')
        self.gate['worker_recipe']['cases']['blackbox:new']=copy.deepcopy(next(iter(self.recipe['cases'].values())))
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.gate['checks'].remove('blackbox:new');self.gate['worker_recipe']['cases'].pop('blackbox:new')
        self.gate['worker_recipe']['execution_timeout_seconds']=14400.0
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])




class CardPreflightCleanup(unittest.TestCase):
    def setUp(self):
        import hashlib
        LocalCleanup.setUp(self)
        name = 'agentcard-lifecycle'
        self.folder = self.root / 'cycle/attempts/35/triage' / name
        self.folder.mkdir(parents=True)
        self.recipe['cases'] = {name: {'command': ['bash', str(self.worker / 'scripts/run-deploy-stage'),
            name, '--', 'bash', 'scripts/run-bench', '--local', 'agent-payment-test-shop'], 'aggregate': True}}
        command = [sys.executable, str(self.worker / 'scripts/deploy_test_worker.py'), '--root', str(self.worker), '--stdio']
        self.gate.update(name=name, category=name, command=command, checks=[name], result_transport='stdout')
        self.gate.pop('native_backend')
        self.request.update(gate=name, checks=[name], worker_recipe=self.recipe)
        native = self.worker / '.context/deploy-worker' / hashlib.sha256(self.token.encode()).hexdigest()
        native.mkdir(parents=True)
        self.run = self.worker / '.context/benchmarks/owned-preflight'
        self.run.mkdir(parents=True)
        case_log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
        case_log.write_text(f'RuntimeError: run.sh exited early with code 143; see {self.run}/services.log\n')
        case = dict(status='UNVERIFIED', native_exit=1, command=self.recipe['cases'][name]['command'],
                    started_at=110, finished_at=190, timed_out=False, cancelled=False, lingering_group=False,
                    log=str(case_log), sha256=c.sha_file(case_log))
        self.result = dict(token=self.token, source=self.source, gate=name, worker_root=str(self.worker),
                           cases={name: 'UNVERIFIED'}, complete=False, reused=False, cleanup_complete=True,
                           recipe_digest=c.digest(self.recipe), evidence={name: case})
        self.receipt.update(gate=name, command=command, cases={name:'UNVERIFIED'},
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            lifecycle='native-producer', lingering_group=True,
                            execution_binding={'contract_digest': c.digest(self.gate), 'environment': 'env', 'input_fingerprint':'fp'})
        self.benchmark = dict(version=1, run_id=self.run.name, state='not_started', pid=None, native_identity='',
                              token='', receipt=str(self.run / 'benchmark-cleanup.status'), signal=None)
        self.stack = dict(version=1, run_id=self.run.name, token='a'*32, pid=2000000000, birth='original birth',
                          native_identity='linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':123')
        self.cleanup = dict(version='2', state='clean', token=self.stack['token'], stack_pid=str(self.stack['pid']),
                            stack_birth=self.stack['birth'], stack_native_identity=self.stack['native_identity'])
        self.services = dict(worktree=str(self.worker), status='stopped', run_sh_pid=self.stack['pid'], ports={'backend':0})
        self.paths = {n:self.folder/n for n in ['request.json','result.json','receipt.json']}
        self.paths.update({'case.log':case_log, 'native-result.json':native/'result.json',
                          **{n:self.run/n for n in ['local-benchmark-owner.json','local-stack-owner.json',
                                                   'local-stack-cleanup.status','services.json']}})
        self.failure.update(gate=name, check=name+'/'+name, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'])
        self.state.update(plan={'gates':[self.gate]}, attempts=[{'results':[self.receipt]}],
                          environment='env', input_fingerprints={name:'fp'})
        self.write_native()

    def write_native(self):
        for key, value in [('request.json',self.request), ('result.json',self.result), ('native-result.json',self.result),
                           ('local-benchmark-owner.json',self.benchmark), ('local-stack-owner.json',self.stack), ('services.json',self.services)]:
            c.write(self.paths[key], value)
        self.paths['local-stack-cleanup.status'].write_text(''.join(k+'='+v+'\n' for k,v in self.cleanup.items()))
        reference=dict(result=str(self.paths['result.json']), native_directory=None, cleanup_complete=True,
                       result_sha256=c.sha_file(self.paths['result.json']), native_evidence=self.result['evidence'])
        self.receipt.update(native_cleanup_reference=reference, cleanup_owner=dict(request_token=self.token,
                            worker_root=str(self.worker), native_cleanup_reference=reference))
        c.write(self.paths['receipt.json'],self.receipt)
        self.proof=dict(kind=KIND, files={n:c.sha_file(p) for n,p in self.paths.items()}, confirmed_at=201, observed_by='native-review')

    reconcile = LocalCleanup.reconcile

    def test_never_admitted_card_releases_launch_only_preserving_native_failure(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        with self.assertRaisesRegex(ValueError, 'cleanup owner'):
            c.reexecute(copy.deepcopy(self.state),'occurrence')
        self.reconcile()
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        c.reexecute(self.state,'occurrence')
        self.assertEqual('needs-focused-plan',self.state['phase'])
        self.assertEqual('UNVERIFIED',self.failure['native_result'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.state['source'] = {'head':'c'*40, 'digest':'d'*64}
        self.state['input_fingerprints'][self.gate['name']] = 'new-inputs'
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        self.assertEqual(self.source,self.failure['source'])
        self.assertIsNone(c.full_pass_binding(self.state,self.gate))

    def test_admitted_or_unknown_benchmark_and_task_artifacts_refuse(self):
        for key,value in [('state','running'),('pid',123),('native_identity','other'),('token','other'),('signal',15)]:
            with self.subTest(key=key):
                old=self.benchmark[key];self.benchmark[key]=value;self.write_native()
                with self.assertRaises(ValueError):self.reconcile()
                self.assertNotIn('reconciled_owners',self.state)
                self.benchmark[key]=old
        self.write_native()
        for name in ['run.json','report-card.json','local-benchmark-results.json','benchmark-cleanup-other.status']:
            p=self.run/name;p.write_text('{}')
            with self.assertRaises(ValueError):self.reconcile()
            p.unlink()

    def test_foreign_stack_identity_or_incomplete_cleanup_refuses(self):
        for key,value in [('state','pending'),('token','foreign'),('stack_native_identity','other'),('stack_pid','1')]:
            old=self.cleanup[key];self.cleanup[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            self.cleanup[key]=old
        self.stack['pid']=os.getpid();self.cleanup['stack_pid']=str(os.getpid());self.services['run_sh_pid']=os.getpid();self.write_native()
        with self.assertRaises(ValueError):self.reconcile()

    def test_changed_source_recipe_or_native_bytes_refuse(self):
        for target,key,value in [(self.result,'source',{}),(self.gate,'worker_transport','boxes-thread'),
                                 (self.result,'cleanup_complete',False),(self.services,'status','running')]:
            old=target[key];target[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            target[key]=old
        self.write_native();self.reconcile()
        self.paths['local-stack-owner.json'].write_text('{}')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    def test_current_root_admission_and_listener_refuse(self):
        import fcntl,socket
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=self.worker)
        try:
            with self.assertRaises(ValueError):self.reconcile()
        finally:proc.terminate();proc.wait(timeout=2)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            self.services['ports']['backend']=listener.getsockname()[1];self.write_native()
            with self.assertRaises(ValueError):self.reconcile()


class StructuralSupervisorCleanup(unittest.TestCase):
    def setUp(self):
        import hashlib
        LocalCleanup.setUp(self)
        name = 'deploy-command-structural'
        self.folder = self.root / 'cycle/attempts/35/triage' / name
        self.folder.mkdir(parents=True)
        self.recipe['cases'] = {name: {'command': ['bash', str(self.worker / 'scripts/run-deploy-stage'),
            name, '--', 'python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '4'],
            'aggregate': True}}
        command = [sys.executable, str(self.worker / 'scripts/deploy_test_worker.py'), '--root', str(self.worker), '--stdio']
        self.gate.update(name=name, category=name, command=command, checks=[name], result_transport='stdout')
        self.gate.pop('native_backend')
        self.request.update(gate=name, checks=[name], worker_recipe=self.recipe)
        native = self.worker / '.context/deploy-worker' / hashlib.sha256(self.token.encode()).hexdigest()
        native.mkdir(parents=True)
        self.case_log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
        self.case_log.write_text('FAILED (errors=3)\n')
        case = dict(status='UNVERIFIED', native_exit=1, command=self.recipe['cases'][name]['command'],
                    started_at=110, finished_at=190, timed_out=False, cancelled=False, lingering_group=False,
                    log=str(self.case_log), sha256=c.sha_file(self.case_log))
        self.result = dict(token=self.token, source=self.source, gate=name, worker_root=str(self.worker),
                           cases={name:'UNVERIFIED'}, complete=False, reused=False, cleanup_complete=True,
                           recipe_digest=c.digest(self.recipe), evidence={name:case})
        self.receipt.update(gate=name, status='FAIL', command=command, cases={name:'UNVERIFIED'},
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            lingering_group=True, lifecycle='owned', native_cleanup_reference=None,
                            execution_binding={'contract_digest':c.digest(self.gate), 'environment':'env', 'input_fingerprint':'fp'})
        # Real native supervisor shape: the failed child exited1; adopted
        # descendants were TERM'd/reaped, including independent SIGPIPE exits.
        self.process.update(orphaned_children=True, term_sent=[125],
                            reaped=[{'pid':124,'status':256}, {'pid':125,'status':15}, {'pid':126,'status':13}])
        self.paths = {n:self.folder/n for n in ['request.json','result.json','receipt.json','output.log.process.json']}
        self.failure.update(gate=name, check=name+'/'+name, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'])
        self.state.update(plan={'gates':[self.gate]}, attempts=[{'results':[self.receipt]}],
                          environment='env', input_fingerprints={name:'fp'})
        self.write_native()

    def write_native(self):
        for name,value in zip(self.paths, [self.request,self.result,self.receipt,self.process]):
            c.write(self.paths[name],value)
        self.proof=dict(kind=KIND, files={n:c.sha_file(p) for n,p in self.paths.items()},
                        confirmed_at=201, observed_by='native-supervisor-review')

    reconcile = LocalCleanup.reconcile

    def metadata_drift_fixture(self):
        self.set_cases_only_recipe()
        self.gate['selection_evidence'] = ['dependency graph: 98 affected units']
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.write_native()
        original = copy.deepcopy(self.gate)
        self.gate['selection_evidence'] = ['dependency graph: 101 affected units']
        self.proof['original_gate'] = original
        return original

    def test_original_contract_witness_allows_selection_metadata_drift_without_credit(self):
        self.metadata_drift_fixture()
        native = {n: p.read_bytes() for n, p in self.paths.items()}
        pending = copy.deepcopy(self.state['pending'])
        failure = copy.deepcopy(self.failure)
        self.reconcile()
        self.assertEqual([], c.retained_owners(self.state, [self.gate['name']]))
        self.assertEqual(pending, self.state['pending'])
        self.assertEqual(failure, self.failure)
        self.assertFalse(self.state['ready'])
        self.assertIsNone(c.full_pass_binding(self.state, self.gate))
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.assertEqual(native, {n: p.read_bytes() for n, p in self.paths.items()})
        self.gate['selection_evidence'] = ['dependency graph: 102 affected units']
        self.assertEqual([], c.retained_owners(self.state, [self.gate['name']]))

    def test_original_contract_witness_rejects_forged_digest_and_execution_drift(self):
        self.metadata_drift_fixture()
        original_proof = copy.deepcopy(self.proof)
        original_gate = copy.deepcopy(self.gate)
        changes = [
            lambda: self.proof.pop('original_gate'),
            lambda: self.proof.update(original_gate='not a contract'),
            lambda: self.proof['original_gate'].update(selection_evidence=['forged old count']),
            lambda: self.proof['original_gate'].pop('command'),
            lambda: self.proof['original_gate'].update(extra='unbound'),
            lambda: self.proof['original_gate'].update(checks=['another-check']),
            lambda: self.proof['original_gate'].update(env={'UNBOUND': '1'}),
            lambda: self.proof['original_gate'].update(worker_root='/foreign'),
            lambda: self.proof['original_gate'].update(result_transport='file'),
            lambda: self.gate.update(env={'CHANGED': '1'}),
            lambda: self.proof['original_gate'].update(selection_evidence=[False]),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.proof = copy.deepcopy(original_proof)
                self.gate.clear(); self.gate.update(copy.deepcopy(original_gate))
                change()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before, self.state)

    def test_original_contract_witness_is_structural_only_and_sealed_on_recheck(self):
        import deploy_test_local_cleanup as local
        self.metadata_drift_fixture()
        for changes in ({'gate': 'backend-coverage-blackbox'}, {'gate': 'agentcard-lifecycle'},
                        {'cancelled': True}, {'lifecycle': 'interrupted'}):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, 'proof fields'):
                    local.validate(self.state, {**self.receipt, **changes}, self.proof)
        self.reconcile()
        baseline = copy.deepcopy(self.state)
        for field, value in [('command', ['foreign']), ('env', {'CHANGED': '1'}),
                             ('native_cloud', True), ('native_backend', True),
                             ('quick', True), ('unrecognized_option', True),
                             ('checks', ['foreign']), ('selection_evidence', [False])]:
            with self.subTest(field=field):
                state = copy.deepcopy(baseline)
                state['plan']['gates'][0][field] = value
                with self.assertRaises(ValueError):
                    c.retained_owners(state, [self.gate['name']])
        state = copy.deepcopy(baseline)
        next(iter(state['reconciled_owners'].values())).pop('execution_gate')
        with self.assertRaises(ValueError):
            c.retained_owners(state, [self.gate['name']])

    def test_original_contract_witness_rejects_boolean_numeric_execution_drift(self):
        self.metadata_drift_fixture()
        for field in ('aggregate', 'case_protocol'):
            for value in (1, 1.0):
                with self.subTest(field=field, value=value):
                    state = copy.deepcopy(self.state)
                    gate = state['plan']['gates'][0]
                    if field == 'aggregate':
                        gate['worker_recipe']['cases'][gate['name']]['aggregate'] = value
                    else:
                        gate[field] = value
                    with self.assertRaises(ValueError):
                        c.reconcile(state, 'occurrence', copy.deepcopy(self.proof))

    def test_original_contract_witness_recheck_rejects_boolean_numeric_execution_drift(self):
        self.metadata_drift_fixture()
        self.reconcile()
        for field in ('aggregate', 'case_protocol'):
            for value in (1, 1.0):
                with self.subTest(field=field, value=value):
                    state = copy.deepcopy(self.state)
                    gate = state['plan']['gates'][0]
                    if field == 'aggregate':
                        gate['worker_recipe']['cases'][gate['name']]['aggregate'] = value
                    else:
                        gate[field] = value
                    with self.assertRaises(ValueError):
                        c.retained_owners(state, [self.gate['name']])

    def test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        pending=copy.deepcopy(self.state['pending'])
        with self.assertRaisesRegex(ValueError,'cleanup owner'): c.reexecute(copy.deepcopy(self.state),'occurrence')
        self.reconcile()
        self.assertEqual(pending,self.state['pending'])
        self.assertFalse(self.state['ready'])
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        c.reexecute(self.state,'occurrence')
        self.assertEqual('needs-focused-plan',self.state['phase'])
        self.assertEqual('UNVERIFIED',self.failure['native_result'])
        self.assertTrue(self.receipt['lingering_group'])
        self.assertTrue(self.process['orphaned_children'])
        self.assertEqual([125],self.process['term_sent'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.assertIsNone(c.full_pass_binding(self.state,self.gate))
        self.state['source']={'head':'c'*40,'digest':'d'*64}
        self.state['input_fingerprints'][self.gate['name']]='changed-inputs'
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        self.assertEqual(self.source,self.failure['source'])

    def test_unreaped_unknown_signalled_or_foreign_supervisor_closure_refuses_atomically(self):
        original=copy.deepcopy(self.process)
        variants=[('quiescent',False),('remaining',[125]),('orphaned_children',False),('error','read failed'),
                  ('timed_out',True),('cancelled',True),('term_sent',[999]),
                  ('term_sent',[True]),('term_sent',[125,125]),('term_sent',[124]),
                  ('reaped',[]),('reaped',[{'pid':125,'status':15}]),
                  ('reaped',original['reaped']+[{'pid':125,'status':0}]),
                  ('reaped',original['reaped']+[{'pid':127,'status':127}]),
                  ('reaped',original['reaped']+[{'pid':123,'status':0}])]
        for key,value in variants:
            with self.subTest(key=key,value=value):
                self.process={**original,key:value};self.write_native()
                before=copy.deepcopy(self.state)
                with self.assertRaises(ValueError):self.reconcile()
                self.assertEqual(before,self.state)
        self.process=original;self.write_native()
        for key,value in [('cleanup_complete',False),('cases',{self.gate['name']:'FAIL'}),('worker_root',str(self.root)),('source',{})]:
            old=self.result[key];self.result[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            self.assertNotIn('reconciled_owners',self.state)
            self.result[key]=old

    def test_proof_mutation_new_receipt_and_live_root_reblock(self):
        import fcntl
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=self.worker)
        try:
            with self.assertRaises(ValueError):self.reconcile()
        finally:
            proc.terminate();proc.wait(timeout=2)
        self.reconcile()
        for path in self.paths.values():
            original=path.read_bytes();path.write_bytes(original+b' ')
            with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
            path.write_bytes(original)
        self.case_log.write_text('changed test evidence')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.case_log.write_text('FAILED (errors=3)\n')
        old=self.gate['command'];self.gate['command']=['other']
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.gate['command']=old
        newer={**self.receipt,'token':'new-unreconciled-owner'}
        self.state['attempts'].append({'results':[newer]})
        self.assertEqual([self.gate['name']],c.retained_owners(self.state,[self.gate['name']]))


    def set_cases_only_recipe(self):
        self.recipe.clear()
        self.recipe['cases'] = {'deploy-command-structural': {
            'command':['python3','scripts/run-deploy-structural-gates.py','--max-workers','5'],
            'cwd':'.', 'env':{'FIXTURE':'synthetic'}, 'aggregate':True}}
        self.result['recipe_digest'] = c.digest(self.recipe)
        self.result['evidence']['deploy-command-structural']['command'] = self.recipe['cases']['deploy-command-structural']['command']
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.write_native()

    def test_cases_only_structural_recipe_allows_launch_only(self):
        self.set_cases_only_recipe()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()

    def test_cases_only_recipe_rejects_unknown_services_extra_keys_and_wrong_command(self):
        import copy
        self.set_cases_only_recipe()
        original = copy.deepcopy(self.recipe)
        variants = [{**original,'services':False}, {**original,'unexpected':True}]
        for field, value in [('command',['python3','other.py']), ('cwd','elsewhere'), ('aggregate',False)]:
            changed = copy.deepcopy(original)
            changed['cases']['deploy-command-structural'][field] = value
            variants.append(changed)
        for recipe in variants:
            with self.subTest(recipe=recipe):
                self.recipe.clear()
                self.recipe.update(recipe)
                self.result['recipe_digest'] = c.digest(self.recipe)
                self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before,self.state)

    def test_file_transport_exact_command_allows_launch_only(self):
        self.gate['result_transport'] = 'file'
        self.gate['command'] = self.gate['command'][:-1]
        self.receipt['command'] = self.gate['command']
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.write_native()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()

    def test_transport_command_pairs_reject_mismatches(self):
        import copy
        original_gate, original_receipt = copy.deepcopy(self.gate), copy.deepcopy(self.receipt)
        command = original_gate['command']
        for transport, args in [('file', command), ('stdout', command[:-1]),
                                ('other', command), ('file', command[:-1] + ['extra']),
                                ('stdout', command + ['extra'])]:
            with self.subTest(transport=transport, args=args):
                self.gate.clear()
                self.gate.update(copy.deepcopy(original_gate), result_transport=transport, command=args)
                self.receipt = {**copy.deepcopy(original_receipt), 'command':args}
                self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before, self.state)

    def test_reaped_sigkill_allows_launch_only_with_all_failure_facts_preserved(self):
        import signal
        self.process['kill_sent'] = [125]
        self.process['reaped'][1]['status'] = signal.SIGKILL
        self.write_native()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()
        self.assertEqual([125], self.process['kill_sent'])
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertFalse(self.result['complete'])

    def test_kill_requires_unique_numeric_term_and_reaped_term_or_kill(self):
        import signal
        original = copy.deepcopy(self.process)
        original['kill_sent'] = [125]
        original['reaped'][1]['status'] = signal.SIGKILL
        variants = [('kill_sent', value) for value in
                    (None, [True], [125.0], ['125'], [-1], [125, 125], [999], [124])]
        variants += [('term_sent', []), ('term_sent', [126]), ('remaining', [125])]
        # Prior SIGTERM negative is explicitly promoted to the positive owning case below.
        # Other terminal signals and ordinary exits remain unsupported.
        for status in (0, signal.SIGINT, signal.SIGPIPE, 127, None, True, 9.0):
            rows = copy.deepcopy(original['reaped'])
            rows[1]['status'] = status
            variants.append(('reaped', rows))
        variants.append(('reaped', [row for row in original['reaped'] if row['pid'] != 125]))
        for key, value in variants:
            with self.subTest(key=key, value=value):
                self.process = {**original, key: value}
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before, self.state)

    def test_reaped_term_after_accepted_kill_request_allows_launch_only(self):
        # Real owned child: observe TERM exit without reaping, then request KILL.
        # This proves request-success != cause-of-exit; it does not attribute round41.
        import os, select, signal, time
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.write(write_fd, b'R')
            os.close(write_fd)
            while True:
                signal.pause()
        os.close(write_fd)
        reaped = False
        try:
            self.assertTrue(select.select([read_fd], [], [], 2)[0], 'owned child not ready')
            self.assertEqual(b'R', os.read(read_fd, 1))
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            observed = None
            while time.monotonic() < deadline:
                observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                if observed is not None:
                    break
                time.sleep(.01)
            self.assertIsNotNone(observed, 'TERM exit not observed within owning bound')
            self.assertEqual((pid, os.CLD_KILLED, signal.SIGTERM),
                             (observed.si_pid, observed.si_code, observed.si_status))
            raw = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
            self.assertEqual('Z', raw[0])
            os.kill(pid, signal.SIGKILL)  # Accepted for this unreaped exact owned zombie.
            joined, status = os.waitpid(pid, 0)
            reaped = True
            self.assertEqual(pid, joined)
            self.assertTrue(os.WIFSIGNALED(status))
            self.assertEqual(signal.SIGTERM, os.WTERMSIG(status))
            self.assertEqual(15, status)
        finally:
            os.close(read_fd)
            if not reaped:
                # Still our unreaped child: this PID cannot be reused before waitpid.
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
        self.process['term_sent'] = [pid]
        self.process['kill_sent'] = [pid]
        self.process['reaped'][1] = {'pid':pid, 'status':status}
        self.write_native()
        original = {n:p.read_bytes() for n,p in self.paths.items()}
        before_attempts = copy.deepcopy(self.state['attempts'])
        before_failures = copy.deepcopy(self.state['failures'])
        self.reconcile()
        self.assertEqual(original, {n:p.read_bytes() for n,p in self.paths.items()})
        self.assertEqual(before_attempts, self.state['attempts'])
        self.assertEqual(before_failures, self.state['failures'])
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertTrue(self.receipt['lingering_group'])
        self.assertTrue(self.process['orphaned_children'])
        self.assertFalse(self.result['complete'])
        self.assertIsNone(c.full_pass_binding(self.state, self.gate))
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_valid_reaped_kill_still_refuses_a_current_live_root(self):
        import signal
        self.process['kill_sent'] = [125]
        self.process['reaped'][1]['status'] = signal.SIGKILL
        self.write_native()
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(10)'], cwd=self.worker)
        try:
            before = copy.deepcopy(self.state)
            with self.assertRaises(ValueError):
                self.reconcile()
            self.assertEqual(before, self.state)
        finally:
            child.terminate()
            child.wait(timeout=2)

    def set_native_zero_inner_pass(self):
        self.receipt['native_exit'] = 0
        self.result.update(cases={self.gate['name']:'PASS'}, complete=True)
        self.result['evidence'][self.gate['name']].update(status='PASS', native_exit=0)
        self.process['native_exit'] = 0
        self.process['reaped'][0]['status'] = 0
        self.write_native()

    def test_native_zero_inner_pass_keeps_outer_failure_and_no_credit(self):
        self.set_native_zero_inner_pass()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertIs(self.receipt['complete'], False)
        self.assertEqual({self.gate['name']:'UNVERIFIED'}, self.receipt['cases'])
        self.assertEqual({self.gate['name']:'PASS'}, self.result['cases'])
        self.assertIs(self.result['complete'], True)

    def test_native_exit_pairs_refuse_crossed_outcomes_and_noninteger_exits(self):
        baseline = tuple(copy.deepcopy(row) for row in (self.receipt,self.result,self.process))
        for exit_code in (0, 1):
            variants = [('result_status', 'UNVERIFIED' if exit_code == 0 else 'PASS'),
                        ('result_complete', exit_code == 1),
                        ('case_status', 'UNVERIFIED' if exit_code == 0 else 'PASS'),
                        ('case_exit', 1 - exit_code), ('process_exit', 1 - exit_code),
                        ('child_status', (1 - exit_code) << 8)]
            for invalid in (True, False, 0.0, 1.0, -1, 2):
                variants.extend((field,invalid) for field in ('receipt_exit','case_exit','process_exit'))
            variants.extend([('child_status',False),('child_status',0.0),('child_status',15)])
            for field, value in variants:
                with self.subTest(native_exit=exit_code, field=field, value=value):
                    for row, original in zip((self.receipt,self.result,self.process),baseline):
                        row.clear();row.update(copy.deepcopy(original))
                    if exit_code == 0:
                        self.set_native_zero_inner_pass()
                    case = self.result['evidence'][self.gate['name']]
                    if field == 'result_status': self.result['cases'] = {self.gate['name']:value}
                    elif field == 'result_complete': self.result['complete'] = value
                    elif field == 'case_status': case['status'] = value
                    elif field == 'case_exit': case['native_exit'] = value
                    elif field == 'process_exit': self.process['native_exit'] = value
                    elif field == 'receipt_exit': self.receipt['native_exit'] = value
                    elif field == 'child_status': self.process['reaped'][0]['status'] = value
                    self.write_native()
                    before = copy.deepcopy(self.state)
                    with self.assertRaises(ValueError): self.reconcile()
                    self.assertEqual(before,self.state)


def listening_ports():
    """TCP ports in LISTEN state on this host, read the way the interrupted proof reads them."""
    ports = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A': ports.add(int(row[1].rsplit(':', 1)[1], 16))
    return ports


def interrupted_root_port():
    """A root base port no deploy-worktree claim can share, with no listener on its footprint now.

    The interrupted proof refuses while anything on the host listens on the root's
    LISTENER_OFFSETS footprint. This suite runs beside the other deploy gates, which listen on
    their claimed footprints, and every claimable footprint starts at FIRST_BASE_PORT: the
    hard-coded base 15000 shared ports with the live semantic-stack claim 15100 (RCA
    2026-11-05-interrupted-proof-fixture-port-inside-deploy-claim-range).
    """
    import socket
    from deploy_test_isolation import _ports
    listening = listening_ports()
    for base in range(1024, _ports.FIRST_BASE_PORT - _ports.FOOTPRINT_PORTS + 1, _ports.PORTS_PER_WORKTREE):
        if listening.isdisjoint(base + offset for offset in _ports.LISTENER_OFFSETS):
            with socket.socket() as probe:
                try: probe.bind(('127.0.0.1', base))
                except OSError: continue
            return base
    raise AssertionError('no listener-free root footprint lies below the deploy-worktree claim range')


class InterruptedLocalRecovery(unittest.TestCase):
    write_native = StructuralSupervisorCleanup.write_native

    def setUp(self):
        StructuralSupervisorCleanup.setUp(self)
        self.coordinator = self.root / 'coordinator';self.coordinator.mkdir()
        subprocess.run(['git','init','-q',str(self.coordinator)],check=True)
        (self.coordinator/'code').write_text('old')
        subprocess.run(['git','-C',str(self.coordinator),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.coordinator),'-c','user.name=test','-c','user.email=test@example.com','commit','-qm','old'],check=True)
        self.source=c.source(self.coordinator)
        self.gate.update(worker='independent-interrupted-worker',timeout_seconds=14400)
        self.port=interrupted_root_port()
        self.gate['env']={'CONDUCTOR_WORKSPACE_NAME':'interrupted-fixture','CONDUCTOR_PORT':str(self.port)}
        self.request['source']=self.source
        self.receipt.update(source=self.source,native_exit=-9,cancelled=True,worker_result=None,
                            execution_binding={'contract_digest':c.digest(self.gate),'environment':'env','input_fingerprint':'fp'})
        self.process.update(native_exit=-9,cancelled=True,orphaned_children=False,
                            reaped=[{'pid':124,'status':9},{'pid':125,'status':15}],term_sent=[124,125],kill_sent=[124])
        (self.folder/'result.json').unlink()
        self.paths={n:self.folder/n for n in ['request.json','receipt.json','output.log.process.json']}
        self.state.update(source=self.source,failures=[],phase='interrupted',resume_phase='focused',round=37,
                          repair_gates=[self.gate['name']],pending_post_merge=[],
                          focused={self.gate['name']:{'command':self.gate['command'],'checks':self.gate['checks'],'worker_recipe':self.recipe}})
        self.state.pop('pending')
        self.state['attempts']=[{'phase':'focused','interrupted':True,'results':[self.receipt]}]
        quick=[dict(name=n,category=n,quick=True,command=['true'],checks=[n]) for n in ['format','eslint','typescript','backend-structural']]
        self.plan={'source':self.source,'gates':[self.gate,*quick]}
        self.state.update(plan=self.plan,plan_digest=c.digest(self.plan),environment=c.environment_digest(),input_fingerprints=c.input_fingerprints(self.plan,self.coordinator))
        self.seal()

    def seal(self):
        for n,v in [('request.json',self.request),('receipt.json',self.receipt),('output.log.process.json',self.process)]:c.write(self.paths[n],v)
        self.proof=dict(kind=KIND,files={n:c.sha_file(p) for n,p in self.paths.items()},confirmed_at=201,observed_by='native-interrupted-review')

    def reconcile(self):c.reconcile(self.state,self.token,self.proof)

    def test_root_footprint_shares_no_port_with_any_claimable_deploy_worktree(self):
        # Concurrent deploy gates listen on their claims while this suite runs; a shared port makes every proof refuse.
        from deploy_test_isolation import _ports
        root=int(self.gate['env']['CONDUCTOR_PORT'])
        bases=range(_ports.FIRST_BASE_PORT,_ports.LAST_BASE_PORT+1,_ports.PORTS_PER_WORKTREE)
        shared=sorted(port for port in (root+o for o in _ports.LISTENER_OFFSETS)
                      if any(port-o in bases for o in _ports.LISTENER_OFFSETS))
        self.assertEqual([],shared)
        self.assertTrue(listening_ports().isdisjoint(root+o for o in _ports.LISTENER_OFFSETS))

    def test_token_reconcile_and_actual_resume_branch_preserve_interrupted_receipts(self):
        original=copy.deepcopy(self.state['attempts']);raw={n:p.read_bytes() for n,p in self.paths.items()}
        self.assertEqual([self.gate['name']],c.retained_owners(self.state,[self.gate['name']]))
        self.reconcile()
        c.interrupted_boundary(self.state)
        self.assertEqual([],self.state['failures'])
        self.assertEqual(original,self.state['attempts'])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        directory=self.root/'saved-cycle';directory.mkdir();plan=self.root/'plan.json'
        c.write(plan,self.plan);c.write(directory/'cycle.json',self.state)
        observed=[]
        def no_worker(_plan,state,*_args,**_kwargs):
            observed.append(state['phase']);state.update(phase='triage',ready=False)
        with patch.object(c,'run_phase',side_effect=no_worker):
            rc=c.main(['resume','--plan',str(plan),'--state-dir',str(directory),'--root',str(self.coordinator)])
        self.assertEqual(1,rc);self.assertEqual(['focused'],observed)
        saved=c.read(directory/'cycle.json')
        self.assertEqual(original,saved['attempts']);self.assertFalse(saved['ready']);self.assertNotIn('resume_phase',saved)
        self.assertEqual(raw,{n:p.read_bytes() for n,p in self.paths.items()})

    def term_cancelled(self):
        """The coordinator's TERM cancellation (-15): no KILL escalation, every TERM target reaped."""
        self.receipt.update(native_exit=-15)
        self.process.update(native_exit=-15,orphaned_children=True,kill_sent=[],term_sent=[124,125],
                            reaped=[{'pid':124,'status':15},{'pid':125,'status':15}])
        self.seal()

    def test_term_cancelled_worker_reconciles_from_supervisor_wait_records(self):
        self.term_cancelled();original=copy.deepcopy(self.state['attempts'])
        self.assertEqual([self.gate['name']],c.retained_owners(self.state,[self.gate['name']]))
        self.reconcile()
        c.interrupted_boundary(self.state)
        self.assertEqual(original,self.state['attempts'])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_term_cancelled_worker_refuses_unreaped_target_or_kill_escalation(self):
        for change in [dict(reaped=[{'pid':124,'status':15}]),dict(remaining=[125]),dict(quiescent=False),
                       dict(reaped=[{'pid':124,'status':9},{'pid':125,'status':15}]),dict(kill_sent=[124])]:
            self.term_cancelled();self.process.update(change);self.seal()
            with self.subTest(change=change),self.assertRaises(ValueError):self.reconcile()
            self.assertNotIn('reconciled_owners',self.state)

    def missing_supervisor_receipt(self,**teardown):
        """A TERM'd supervisor that exited before writing its wait records leaves only the coordinator teardown."""
        self.receipt.update(native_exit=-15);(self.folder/'output.log.process.json').unlink(missing_ok=True)
        name=f"teardown/attempt-{self.folder.parent.parent.name}-{self.gate['name']}.json"
        record=dict(attempt=int(self.folder.parent.parent.name),lane=self.gate['name'],token=self.receipt['token'],
                    outcome='clean',survivors=[],lingering=[],owned=[],foreign=[])
        record.update(teardown)
        (self.folder/'teardown').mkdir(exist_ok=True);c.write(self.folder/name,record)
        self.paths={n:self.folder/n for n in ['request.json','receipt.json']}
        for n,v in [('request.json',self.request),('receipt.json',self.receipt)]:c.write(self.paths[n],v)
        files={n:c.sha_file(p) for n,p in self.paths.items()};files[name]=c.sha_file(self.folder/name)
        self.proof=dict(kind=KIND,files=files,confirmed_at=201,observed_by='native-interrupted-review')

    def test_term_cancelled_worker_without_supervisor_receipt_needs_clean_teardown_and_quiet_root(self):
        self.missing_supervisor_receipt();original=copy.deepcopy(self.state['attempts'])
        proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=self.worker)
        try:
            with self.assertRaises(ValueError):self.reconcile()
        finally:
            proc.terminate();proc.wait(timeout=2)
        self.reconcile()
        c.interrupted_boundary(self.state)
        self.assertEqual(original,self.state['attempts'])

    def test_term_cancelled_worker_without_supervisor_receipt_refuses_unclean_or_foreign_teardown(self):
        for change in [dict(outcome='killed'),dict(survivors=[{'pid':126}]),dict(token='other'),dict(lingering=[126])]:
            self.state.pop('reconciled_owners',None)
            self.missing_supervisor_receipt(**change)
            with self.subTest(change=change),self.assertRaises(ValueError):self.reconcile()
            self.assertNotIn('reconciled_owners',self.state)
        self.receipt.update(native_exit=-9);c.write(self.paths['receipt.json'],self.receipt)
        self.proof['files']['receipt.json']=c.sha_file(self.paths['receipt.json'])
        with self.assertRaisesRegex(ValueError,'KILLed supervisor must leave its wait records'):self.reconcile()

    def test_refresh_requires_all_closure_and_preserves_original_source_and_clock(self):
        (self.coordinator/'code').write_text('new');new={**self.plan,'source':c.source(self.coordinator)}
        before=copy.deepcopy(self.state)
        with self.assertRaises(ValueError):c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual(before,self.state)
        self.reconcile();original=copy.deepcopy(self.state['attempts'])
        c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual('quick',self.state['phase']);self.assertFalse(self.state['ready'])
        self.assertNotIn('resume_phase',self.state);self.assertEqual(37,self.state['round'])
        self.assertEqual(original,self.state['attempts']);self.assertEqual(self.source,self.receipt['source'])
        self.assertEqual(new['source'],self.state['source']);self.assertEqual(self.plan['gates'],new['gates'])

    def test_backend_inventory_growth_keeps_old_cleanup_and_new_full_request(self):
        import deploy_test_backend as backend
        for root in [self.coordinator,self.worker]:
            folder=root/'back-end/src/tests/blackbox';folder.mkdir(parents=True)
            (folder/'browser-provider.blackbox.ts').write_text('// original registered domain\n')
        checks=backend.checks_for(backend.list_domains(self.worker))
        self.recipe['cases']={check:{'command':backend.RUNNER,'cwd':'back-end'} for check in checks}
        self.gate.update(name='backend-coverage-blackbox',category='backend-coverage-blackbox',native_backend=True,
                         result_transport='file',checks=checks,
                         command=[sys.executable,str(ROOT/'scripts/deploy_test_backend.py'),'--root',str(self.worker)])
        self.source=c.source(self.coordinator)
        self.request.update(source=self.source,gate=self.gate['name'],checks=checks)
        self.receipt.update(source=self.source,gate=self.gate['name'],command=self.gate['command'],cases=dict.fromkeys(checks,'UNVERIFIED'))
        self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
        self.plan['source']=self.source
        self.state.update(source=self.source,plan_digest=c.digest(self.plan),input_fingerprints=c.input_fingerprints(self.plan,self.coordinator))
        self.seal();self.reconcile()
        original=copy.deepcopy(self.state['attempts']);raw={n:p.read_bytes() for n,p in self.paths.items()}
        for root in [self.coordinator,self.worker]:
            (root/'back-end/src/tests/blackbox/cli-login.blackbox.ts').write_text('// genuine new registered domain\n')
        new_gate=copy.deepcopy(self.gate);new_checks=backend.checks_for(backend.list_domains(self.worker))
        self.assertIn('blackbox:cli-login',new_checks)
        new_gate['checks']=new_checks
        new_gate['worker_recipe']['cases']['blackbox:cli-login']={'command':backend.RUNNER,'cwd':'back-end'}
        new={**self.plan,'source':c.source(self.coordinator),'gates':[new_gate,*self.plan['gates'][1:]]}
        c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        observed=[]
        def observe(argv,**kwargs):
            request=c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']));observed.append(request)
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']),dict(token=request['token'],source=request['source'],gate=request['gate'],
                worker_root=str(self.worker),recipe_digest=c.digest(request['worker_recipe']),cases=dict.fromkeys(request['checks'],'UNVERIFIED'),
                complete=False,reused=False,cleanup_complete=True))
            return 1,False,False,False
        with patch.object(c,'run_command',side_effect=observe):
            result=c.execute(new_gate,self.state,self.root/'fresh-full-observation',self.coordinator)
        self.assertEqual(new_checks,observed[0]['checks'])
        self.assertEqual('UNVERIFIED',result['cases']['blackbox:cli-login'])
        self.assertEqual(original,self.state['attempts']);self.assertEqual(raw,{n:p.read_bytes() for n,p in self.paths.items()})
        path=self.paths['output.log.process.json'];path.write_bytes(raw['output.log.process.json']+b' ')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
    def test_unrelated_unreadable_host_process_refuses_production_scan_only(self):
        # PR #1762 Blacksmith failure: pid 211414, a same-user process outside this suite whose cwd stayed
        # unreadable, refused this class's reconcile ("worker root process 211414 is unverifiable").
        with unrelated_unreadable_process() as pid:
            self.assertIn(pid, {int(p.name) for p in production_process_entries()})
            self.assertNotIn(pid, {int(p.name) for p in own_process_entries()})
            before=copy.deepcopy(self.state)
            with patch.object(deploy_test_process,'process_entries',production_process_entries), \
                    self.assertRaisesRegex(ValueError,r'worker root process \d+ is unverifiable'):
                self.reconcile()
            self.assertEqual(before,self.state)
            # An earlier fixture's patch.stopall() can retire the module-wide
            # process scope; own this positive control at its actual import seam.
            with patch.object(deploy_test_process, 'process_entries', own_process_entries):
                self.reconcile()
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_original_exclusions_stay_skip_without_test_or_cleanup_credit(self):
        name='standing-original-exclusion'
        self.recipe['cases'][name]={'command':['true']}
        self.gate['checks'].append(name)
        self.request['skips']={name:{'source':self.source,'disposition':'skipped with warning'}}
        self.receipt['cases'][name]='SKIP'
        self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
        self.seal();original=copy.deepcopy(self.receipt)
        self.reconcile();c.interrupted_boundary(self.state)
        self.assertEqual(original,self.receipt);self.assertEqual('SKIP',self.receipt['cases'][name])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.request['checks'].append(name);self.seal()
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)

    def test_incomplete_foreign_changed_or_live_evidence_refuses_atomically(self):
        original=copy.deepcopy(self.process)
        for key,value in [('quiescent',False),('remaining',[125]),('error','unknown'),('kill_sent',[999]),
                          ('reaped',[{'pid':124,'status':9}]),('reaped',original['reaped']*2),('cancelled',False)]:
            self.process={**original,key:value};self.seal();before=copy.deepcopy(self.state)
            with self.subTest(key=key),self.assertRaises(ValueError):self.reconcile()
            self.assertEqual(before,self.state)
        self.process=original;self.seal()
        for name in ['result.json','output.log.process.json.watchdog.json']:
            path=self.folder/name;c.write(path,{})
            with self.assertRaises(ValueError):self.reconcile()
            path.unlink()
        import socket,fcntl
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',self.port));listener.listen()
            with self.assertRaises(ValueError):self.reconcile()
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        self.reconcile()
        for path in self.paths.values():
            raw=path.read_bytes();path.write_bytes(raw+b' ')
            with self.assertRaises(ValueError):c.interrupted_boundary(self.state)
            path.write_bytes(raw)
        self.state['attempts'].append({'phase':'focused','interrupted':True,'results':[{**self.receipt,'token':'new-owner'}]})
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)


class InterruptedCardRecovery(unittest.TestCase):
    write_native = CardPreflightCleanup.write_native

    def setUp(self):
        CardPreflightCleanup.setUp(self)
        self.receipt.update(native_exit=-9,cancelled=True,worker_result=None,native_cleanup_reference=None,
                            cleanup_owner={'request_token':self.token,'worker_root':str(self.worker),'native_cleanup_reference':None})
        for name in ['result.json','native-result.json']:
            self.paths[name].unlink();self.paths.pop(name)
        self.paths.pop('case.log').write_text(f'RuntimeError: cleanup remains unverified; retaining its recovery authority: {self.run}/local-stack-cleanup.status\n')
        import hashlib
        self.paths['case.log']=self.worker/'.context/deploy-worker'/hashlib.sha256(self.token.encode()).hexdigest()/(hashlib.sha256(b'agentcard-lifecycle').hexdigest()+'.log')
        self.cleanup['state']='failed'
        self.physical_path=self.root/'card-physical.json'
        self.physical=dict(observed_at=201,root=str(self.worker),run=str(self.run),source=self.source['head'],
                           physical={'matched':[],'unknown_live_userland':[]},ports=self.services['ports'],
                           listeners=[],database_status='ABSENT',canonical_reconcile_exit=1)
        self.state.update(failures=[],phase='interrupted',resume_phase='focused')
        self.state.pop('pending');self.state['attempts'][-1]['interrupted']=True
        self.seal()

    def seal(self):
        for n,v in [('request.json',self.request),('receipt.json',self.receipt),('local-benchmark-owner.json',self.benchmark),('local-stack-owner.json',self.stack),('services.json',self.services)]:c.write(self.paths[n],v)
        self.paths['local-stack-cleanup.status'].write_text(''.join(k+'='+v+'\n' for k,v in self.cleanup.items()))
        c.write(self.physical_path,self.physical)
        self.proof=dict(kind=KIND,files={**{n:c.sha_file(p) for n,p in self.paths.items()},str(self.physical_path):c.sha_file(self.physical_path)},confirmed_at=202,observed_by='native-physical-review')

    def test_no_admission_failed_card_can_resume_only_with_bound_physical_closure(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        c.reconcile(self.state,self.token,self.proof);c.interrupted_boundary(self.state)
        self.assertEqual([],self.state['failures']);self.assertEqual('failed',self.cleanup['state'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.physical['database_status']='UNKNOWN';self.seal()
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
    def test_transiently_unreadable_same_user_process_does_not_block_reconcile(self):
        # The Blacksmith failure (PR #1751): quiet() read /proc/<pid>/cwd of a same-user process that was
        # momentarily unreadable and the PermissionError aborted the proof as "missing or unknown evidence".
        # A real child that clears PR_SET_DUMPABLE is unreadable to its parent exactly like that process.
        body = ("import ctypes,time;libc=ctypes.CDLL(None);libc.prctl(4,0,0,0,0);print('ready',flush=True);"
                "time.sleep(.4);libc.prctl(4,1,0,0,0);time.sleep(60)")
        child = subprocess.Popen([sys.executable, '-c', body], stdout=subprocess.PIPE, text=True, cwd=self.root)
        self.addCleanup(lambda: (child.kill(), child.wait(), child.stdout.close()))
        self.assertEqual('ready', child.stdout.readline().strip())
        c.reconcile(self.state, self.token, self.proof)
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_card_admission_foreign_physical_and_unknowns_refuse(self):
        for key,value in [('source','other'),('observed_at',199),('run',str(self.root)),('listeners',[123]),('database_status','PRESENT'),('canonical_reconcile_exit',True)]:
            old=self.physical[key];self.physical[key]=value;self.seal();before=copy.deepcopy(self.state)
            with self.subTest(key=key),self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
            self.assertEqual(before,self.state);self.physical[key]=old
        self.physical['physical']['unknown_live_userland']=[123];self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
        self.physical['physical']['unknown_live_userland']=[];self.benchmark['state']='running';self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)


class NativeJsonEvidence(unittest.TestCase):
    def test_json_chunk_boundaries_and_original_scalar_forms(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            for length in range(65526, 65538):
                for suffix in ['\\', '"', '\n', '\x00', '雪']:
                    value = {'logs': 'x' * length + suffix, 'values': [1, -2, 1.5e-9, True, False, None]}
                    raw = json.dumps(value, ensure_ascii=False).encode()
                    path.write_bytes(raw)
                    verify_native_object(path, hashlib.sha256(raw).hexdigest())

    def test_malformed_or_nonobject_native_json_refuses(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            for raw in [b'[]', b'{', b'{"x":}', b'{}{}', b'{"x":"\\u12"}',
                        b'{"x":01}', b'{"x":true,}', b'{"x":[1,]}', b'{"x":"\xff"}']:
                path.write_bytes(raw)
                with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                    verify_native_object(path, hashlib.sha256(raw).hexdigest())

    def test_original_hash_and_physical_path_remain_required(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            path.write_bytes(b'{}')
            with self.assertRaises(ValueError):
                verify_native_object(path, '0' * 64)
            alias = Path(directory) / 'alias'
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                verify_native_object(alias, hashlib.sha256(b'{}').hexdigest())


class RelayStartupEvidence(unittest.TestCase):
    """Prospective startup custody; never upgrades an old unsealed attempt."""
    def setUp(self):
        import importlib.util
        self.temp = tempfile.TemporaryDirectory(prefix='relay-startup-proof-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.target = Path(os.environ.get('RELAY_SOURCE_ROOT', str(ROOT))) / 'scripts'
        spec = importlib.util.spec_from_file_location('startup_native', self.target/'deploy_test_native_cleanup.py')
        self.native = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.native)

    def test_refused_version_retains_authenticated_identity(self):
        import asyncio,runpy,socket,struct
        module=runpy.run_path(str(self.target/'cloudbench-shared-relay.py'))
        address=self.base/'fly-agent.sock'
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.bind(str(address));address.chmod(0o600);listener.listen(1);listener.settimeout(2)
        self.addCleanup(listener.close)
        broker=module['Broker']({'parent_pid':os.getpid(),'parent_start':module['birth'](os.getpid()),
                                'agent_socket':str(address)},'a'*64,self.base)
        def respond(value):
            errors=[]
            def serve():
                try:
                    stream,_=listener.accept()
                    with stream:
                        stream.settimeout(2)
                        header=stream.recv(2);size=int.from_bytes(header,'little');request=b''
                        while len(request)<size:request+=stream.recv(size-len(request))
                        self.assertEqual(request,b'ping')
                        body=b'ok '+json.dumps(value).encode()
                        stream.sendall(struct.pack('<H',len(body))+body)
                except BaseException as error:errors.append(error)
            thread=threading.Thread(target=serve);thread.start()
            return thread,errors
        def run(value,reason=None):
            thread,errors=respond(value)
            try:
                if reason:
                    with self.assertRaisesRegex(ValueError,reason):asyncio.run(broker.start_agent())
                else:asyncio.run(broker.start_agent())
            finally:
                thread.join(3);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        run({'Version':'v0.5.5','PID':os.getpid()},'unsupported Fly agent version')
        record=json.loads((self.base/'startup-agent.json').read_text())
        self.assertEqual(record['agent']['pid'],os.getpid())
        self.assertEqual(record['agent']['birth'],module['birth'](os.getpid()))
        self.assertEqual(record['agent']['version'],'0.5.5')
        self.assertEqual(record['agent']['socket_identity'],[address.stat().st_dev,address.stat().st_ino])
        self.assertEqual(record['authority_sha256'],'a'*64)
        self.assertEqual((self.base/'startup-agent.json').stat().st_mode&0o777,0o600)
        self.assertFalse((self.base/'ready.json').exists())
        (self.base/'startup-agent.json').unlink()
        run({'Version':'v0.5.5','PID':os.getpid()+1},'PING peer differs')
        self.assertFalse((self.base/'startup-agent.json').exists())
        run({'Version':'v0.4.115','PID':os.getpid()})
        self.assertEqual(json.loads((self.base/'startup-agent.json').read_text())['agent']['version'],'0.4.115')

    def test_owned_supervisor_retains_native_failure_and_quiescence(self):
        from deploy_test_process import run_command
        output=self.base/'native.log'
        with output.open('wb')as stream:
            result=run_command([sys.executable,'-c','raise SystemExit(1)'],cwd=self.base,
                               env=os.environ.copy(),output=stream,timeout=5,owned_lifecycle=True)
        self.assertEqual(result,(1,False,False,False))
        receipt=json.loads(Path(str(output)+'.process.json').read_text())
        self.assertIs(receipt['quiescent'],True);self.assertEqual(receipt['remaining'],[])
        self.assertFalse(Path('/proc',str(receipt['supervisor_pid'])).exists())
        self.assertFalse(Path('/proc',str(receipt['child_pid'])).exists())

    def fixture(self):
        import hashlib,time,runpy
        from datetime import datetime,timezone
        token='startup-owned-token';root=self.base;key=hashlib.sha256(token.encode()).hexdigest()
        runs=root/'.context/deploy-cloud'/key/'runs';runs.mkdir(parents=True)
        campaign=runs.parent/'campaigns'/('deploy-'+key);relay=campaign/'shared-relay';relay.mkdir(parents=True)
        def stamp(pid):
            return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
        rows=[]
        for _ in range(5):
            p=subprocess.run([sys.executable,'-c',"import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],capture_output=True,text=True,check=True)
            pid,start=p.stdout.split();rows.append({'pid':int(pid),'birth':'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+start})
        parent,bootstrap,broker,agent,publisher=rows;self.live_stamp=stamp
        source={'head':'a'*40,'digest':'b'*64};now=time.time()
        request={'token':token,'source':source,'gate':'smoke','checks':['browser-smoke'],'skips':{}}
        cases={'browser-smoke':'UNVERIFIED'}
        adapter={**request,'cases':cases,'native_exit':1,'started_at':now-5,'runner_log':str(runs.parent/'cli.log'),
                 'native_command':['bash','scripts/run-bench','browser-smoke','--runs','1','--concurrency','1','--retry-infra','0','--ref',source['head']]}
        folder=root/'attempt';folder.mkdir();adapter_path=folder/'result.json'
        def save(path,v):path.write_text(json.dumps(v));path.chmod(0o600)
        save(adapter_path,adapter)
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        reference={'result':str(adapter_path),'result_sha256':sha(adapter_path),'native_directory':str(campaign),'cleanup_complete':False}
        owner={'request_token':token,'worker_root':str(root),'native_cleanup_reference':reference}
        receipt={**request,'cases':cases,'lifecycle':'native-producer','complete':False,'timed_out':False,'cancelled':False,
                 'finished_at':now-1,'worker_result':str(adapter_path),'log':str(folder/'output.log'),'native_cleanup_reference':reference,
                 'cleanup_owner':owner,'lingering_group':True}
        save(folder/'receipt.json',receipt);save(folder/'request.json',request)
        (runs.parent/'cli.log').write_text(str(campaign))
        job={'job_id':'r001-j0001','task':'browser-smoke','run':1,'attempt':1,'attempts':[],'status':'cancelled','log':str(campaign/'r001-j0001.log')}
        summary={'campaign_id':campaign.name,'jobs':[job],'runs':1,'retry_infra':0,'status':'failed','peak_concurrency':0,
                 'shared_inventory_failed':True,'task_count':1,'total_jobs':1,
                 'started_at':datetime.fromtimestamp(now-4,timezone.utc).isoformat(),'finished_at':datetime.fromtimestamp(now-2,timezone.utc).isoformat()}
        save(campaign/'summary.json',summary)
        private='/tmp/cb-relay-abcdefgh'
        authority={'schema':'shared-relay-authority-v1','parent_pid':parent['pid'],'parent_start':parent['birth'],
                   'inventory_directory':str(campaign/'shared-inventory'),'agent_socket':private+'/fly-agent.sock',
                   'source_sha256':hashlib.sha256(b'original-broker').hexdigest()}
        authority['inventory_owner']={'app':'fixture','pid':str(publisher['pid']),'pid_start':publisher['birth'],
                                      'token':'b'*32,'parent_pid':str(parent['pid']),'parent_start':parent['birth']}
        inventory=campaign/'shared-inventory';inventory.mkdir()
        (inventory/'owner').write_text(''.join(k+'='+v+'\n'for k,v in authority['inventory_owner'].items()))
        save(relay/'authority.private.json',authority)
        for name,row in [('bootstrap',bootstrap),('broker',broker)]:
            save(relay/(name+'-owner.json'),{**row,'parent_pid':parent['pid'],'parent_start':parent['birth']})
        save(campaign/'shared-relay-location.json',{'directory':private})
        capture={'schema':'shared-relay-startup-agent-v1','authority_sha256':sha(relay/'authority.private.json'),
                 'parent':parent,'broker':broker,'uid':os.getuid(),'socket':authority['agent_socket'],
                 'agent':{**agent,'version':'0.5.5','socket_identity':[3,4]}}
        save(relay/'startup-agent.json',capture)
        cleanup={'schema':'shared-relay-startup-cleanup-v1','parent':parent,'bootstrap_joined':True,'broker_joined':True,
                 'bootstrap_exit':0,'broker_exit':1,'agent_identity_sha256':sha(relay/'startup-agent.json'),
                 'producer_sha256':hashlib.sha256(b'original-campaign').hexdigest(),
                 'agent_shutdown_verified':False,'agent_retirement_pending':True}
        save(relay/'startup-cleanup.json',cleanup)
        sidecar={'native_exit':1,'child_pid':parent['pid'],'supervisor_pid':999999,'quiescent':True,'orphaned_children':False,
                 'timed_out':False,'cancelled':False,'remaining':[],'term_sent':[],'kill_sent':[],'error':None,
                 'reaped':[{'pid':parent['pid'],'status':256}]}
        save(runs.parent/'cli.log.process.json',sidecar)
        save(campaign/'hub-group.json',{});save(campaign/'hub-group-publication-ack.private.json',{})
        proof={'kind':'native-cloud-cleanup-v1','owner':owner,'request_token':token,'source':source,
               'receipt_sha256':sha(folder/'receipt.json'),'worker_result_sha256':sha(adapter_path),'confirmed_at':now,
               'observed_by':'fixture','layout':'campaign-startup-v1','campaign':str(campaign)}
        self.reseal=lambda:proof.update(files={str(p):sha(p) for p in root.rglob('*')if p.is_file() and p.name not in ('receipt.json','result.json')})
        self.reseal();self.save=save;self.relay=relay;self.campaign=campaign;self.runs=runs;self.proof=proof
        return receipt,owner,proof

    def validate_fixture(self,receipt,owner,proof):
        import types,runpy
        retired_hub=runpy.run_path(str(self.target/'run-bench-campaign.py'))['native_hub_owner_retired']
        original_check_output=subprocess.check_output
        published=types.ModuleType('deploy_test_cloud');published.campaign_published=lambda *_a:True
        with patch.dict(sys.modules,deploy_test_cloud=published),patch.object(self.native.runpy,'run_path',return_value={'native_hub_owner_retired':retired_hub}),\
             patch.object(self.native.subprocess,'check_output',side_effect=lambda args,**kwargs:
                 original_check_output(args,**kwargs) if args[0]=='ps' else
                 original_check_output(['git','--no-replace-objects','-C',str(ROOT),'show',
                     '4df680391347ed9671734c9d8a6a067b279f2b5d:'+args[-1].split(':',1)[1]]) if proof.get('layout')=='campaign-dispatch-refusal-v1'
                    and args[-1].split(':',1)[-1] in {'scripts/run-bench','scripts/run-bench-fleet','scripts/lib/cloudbench-env.sh','scripts/run-bench-campaign.py'} else
                 b'original-broker' if args[-1].endswith('cloudbench-shared-relay.py') else
                 (ROOT/'scripts/cloudbench-campaign-inventory.sh').read_bytes() if args[-1].endswith('cloudbench-campaign-inventory.sh') else
                 (ROOT/'scripts'/args[-1].split(':scripts/',1)[1]).read_bytes() if args[-1].endswith((':scripts/lib/cloudbench-env.sh',':scripts/run-bench-fleet')) else b'original-campaign'):
            state={'plan':{'gates':[{'name':'smoke','native_cloud':True}]},
                   'attempts':[{'results':[receipt]}],
                   'failures':[{'id':'original-failure','gate':'smoke','check':'smoke/browser-smoke',
                                'native_result':'UNVERIFIED','complete':False}]}
            occurrence='original-failure'
            if getattr(self,'stale_operation',False):
                state.update(phase='stale',source=receipt['source'],failures=[])
                state['attempts'][-1]['stale']=True
                occurrence=receipt['token']
            self.native.reconcile(state,occurrence,proof)
            return next(iter(state['reconciled_owners'].values()))

    def dispatch_fixture(self):
        import time
        receipt,owner,proof=self.fixture()
        proof['layout']='campaign-dispatch-refusal-v1'
        adapter=json.loads(Path(receipt['worker_result']).read_text())
        adapter.update(complete=False,cleanup_complete=False,reused=False)
        self.save(Path(receipt['worker_result']),adapter)
        owner['native_cleanup_reference']['result_sha256']=c.sha_file(receipt['worker_result'])
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        proof.update(receipt_sha256=c.sha_file(Path(receipt['log']).parent/'receipt.json'),
                     worker_result_sha256=c.sha_file(receipt['worker_result']))
        summary=json.loads((self.campaign/'summary.json').read_text())
        summary.update(peak_concurrency=1,shared_inventory_failed=False)
        job=summary['jobs'][0]
        authority=json.loads((self.relay/'authority.private.json').read_text())
        job.update(status='failed',controller_pid=int(authority['inventory_owner']['pid']),controller_exit_code=1,
                   started_at=summary['started_at'],finished_at=summary['finished_at'],
                   controller_command=['bash',str(self.base/'scripts/run-bench'),job['task'],
                                       '--ref',receipt['source']['head'],'--foreground'])
        self.save(self.campaign/'summary.json',summary)
        Path(job['log']).write_text('FATAL: requested benchmark commit '+receipt['source']['head']+
            ' is not fetchable from origin and local patch shipping is disabled\n')
        broker=json.loads((self.relay/'broker-owner.json').read_text())
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        ready=dict(authority_sha256=c.sha_file(self.relay/'authority.private.json'),agent=capture['agent'],
                   pid=broker['pid'],birth=broker['birth'],socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json',ready)
        self.save(self.relay/'serve.once.json',ready)
        (self.relay/'broker.private.log').write_text('{"stopped": true}')
        (self.relay/'startup-cleanup.json').unlink()
        proof['confirmed_at']=time.time()
        self.reseal()
        return receipt,owner,proof

    def test_source_refusal_retirement_retains_unverified_outcomes_and_no_financial_credit(self):
        receipt,owner,proof=self.dispatch_fixture()
        original=copy.deepcopy(receipt)
        result=self.validate_fixture(receipt,owner,proof)
        self.assertEqual(receipt,original)
        self.assertFalse(result['credit_granted'])
        self.assertFalse(result['financial_cleanup_credit'])
        self.assertEqual(result['participants'],[])

    def test_source_refusal_refuses_other_errors_resources_and_ownership(self):
        for mutation in ('foreign-error','successful-child','retry','cleanup-pending','native-participant','live-child','changed-evidence'):
            with self.subTest(mutation=mutation):
                # Each fixture has its own namespace; the proof must not inherit a peer's closure.
                with tempfile.TemporaryDirectory(prefix='dispatch-negative-') as temporary:
                    self.base=Path(temporary)
                    receipt,owner,proof=self.dispatch_fixture()
                    summary_path=self.campaign/'summary.json'
                    summary=json.loads(summary_path.read_text())
                    job=summary['jobs'][0]
                    if mutation=='foreign-error':Path(job['log']).write_text('provider failed\n')
                    elif mutation=='successful-child':job['controller_exit_code']=0
                    elif mutation=='retry':job['attempt']=2
                    elif mutation=='cleanup-pending':summary['shared_transport_cleanup_pending']=True
                    elif mutation=='native-participant':(self.runs/'unexpected-fleet').mkdir()
                    elif mutation=='live-child':job['controller_pid']=os.getpid()
                    elif mutation=='changed-evidence':Path(job['log']).write_text(Path(job['log']).read_text()+'changed\n')
                    self.save(summary_path,summary)
                    if mutation!='changed-evidence':self.reseal()
                    with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)

    def test_native_adapter_requests_owned_supervision(self):
        import ast,contextlib,hashlib,time
        code=(self.target/'deploy_test_cloud.py').read_text()
        function=next(n for n in ast.parse(code).body if isinstance(n,ast.FunctionDef) and n.name=='execute')
        calls=[];requested={'checks':['browser-smoke'],'skips':{},'token':'owned','source':{'head':'a'*40},'gate':'smoke'}
        namespace=dict(NAME=__import__('re').compile(r'^[A-Za-z0-9_.-]+$'),source=lambda _r:requested['source'],
                       origin_fetchable=lambda _r,_h:True,
                       campaign_width=lambda _c:1,hashlib=hashlib,os=os,time=time,sys=sys,
                       cancellation_handlers=contextlib.nullcontext,write=lambda *_a:None,shared_canary_env=lambda _r:{},
                       capacity_admission_env=lambda _now:{'CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH':'fixture'},
                       run_command=lambda *a,**k:(calls.append((a,k)) or (1,False,False,False)),
                       collect_campaign=lambda *_a:({'browser-smoke':'UNVERIFIED'},{},False,'fixture'))
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(self.target/'deploy_test_cloud.py'),'exec'),namespace)
        namespace['execute'](requested,self.base)
        self.assertEqual(len(calls),1)
        self.assertIs(calls[0][1].get('owned_lifecycle'),True)
        self.assertEqual(calls[0][1]['env'].get('DEPLOY_NATIVE_HUB_JOIN'),'1')
        self.assertEqual(calls[0][1]['env'].get('CLOUDBENCH_CAPACITY_ADMISSION_DEADLINE_EPOCH'),'fixture')

    def test_startup_only_reconciliation_retains_unverified_bytes(self):
        receipt,owner,proof=self.fixture();before=json.dumps(receipt,sort_keys=True)
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted']);self.assertEqual(result['participants'],[])
        self.assertEqual(json.dumps(receipt,sort_keys=True),before)
        self.assertEqual(receipt['cases'],{'browser-smoke':'UNVERIFIED'})

    def test_startup_publisher_exit_removes_owner_without_losing_captured_identity(self):
        receipt,owner,proof=self.fixture()
        inventory=self.campaign/'shared-inventory'
        original=(inventory/'owner').read_bytes()
        (inventory/'owner').unlink()
        (inventory/'stop').write_bytes(b'')
        scripts=inventory/'scripts';scripts.mkdir()
        producer=scripts/'cloudbench-campaign-inventory.sh'
        producer.write_bytes((ROOT/'scripts/cloudbench-campaign-inventory.sh').read_bytes())
        self.reseal()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(result['startup_processes'][-1]['pid'],int(dict(
            line.split('=',1)for line in original.decode().splitlines())['pid']))
        (inventory/'owner').write_bytes(original.replace(b'app=fixture',b'app=foreign'))
        self.reseal()
        with self.assertRaisesRegex(ValueError,'publisher binding'):
            self.validate_fixture(receipt,owner,proof)
        (inventory/'owner').unlink();(inventory/'stop').unlink();self.reseal()
        with self.assertRaisesRegex(ValueError,'noncanonical proof file'):
            self.validate_fixture(receipt,owner,proof)
        (inventory/'stop').write_bytes(b'');producer.write_bytes(b'unsupported publisher');self.reseal()
        with self.assertRaisesRegex(ValueError,'publisher removal contract'):
            self.validate_fixture(receipt,owner,proof)

    def test_stale_full_attempt_reconciles_exact_startup_operation_without_credit(self):
        receipt,owner,proof=self.fixture();self.stale_operation=True
        receipt['executed']=True
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        import hashlib
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(result['occurrence'],receipt['token'])
        proof['request_token']='foreign'
        with self.assertRaisesRegex(ValueError,'stale operation identity'):
            self.validate_fixture(receipt,owner,proof)

    def test_original_fly_logs_allow_only_absent_same_boot_startup_agent(self):
        import ast,datetime,hashlib
        receipt,owner,proof=self.fixture()
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        (self.relay/'startup-agent.json').unlink();(self.runs.parent/'cli.log.process.json').unlink()
        self.save(self.relay/'startup-cleanup.json',dict(bootstrap_joined=True,broker_joined=True,
                                                       agent_shutdown_verified=False,agent_retirement_pending=True))
        (self.relay/'broker.private.log').write_text('unsupported Fly agent version\n')
        pid=capture['agent']['pid'];socket=capture['socket']
        native=self.base/'native';native.mkdir()
        bootstrap=native/'bootstrap.log';(native/'agent-logs').mkdir();agent=native/'agent-logs/123.log'
        when=datetime.datetime.fromisoformat(json.loads((self.campaign/'summary.json').read_text())['started_at'])+datetime.timedelta(seconds=.5)
        stamp=when.strftime('%Y/%m/%d %H:%M:%S.%f')
        def native_logs(logged):
            # Re-encode the length-prefixed PING frame for each PID: a text replace of a PID with a different
            # digit count breaks the frame length and refuses on framing before the identity under test.
            payload=('ok '+json.dumps({'PID':logged,'Version':'0.5.5'})+'\n').encode()
            quoted=json.dumps((len(payload).to_bytes(2,'little')+payload).decode('latin1'))
            return (f'DEBUG determined working directory: "{self.base}"\nDEBUG started agent process (pid: {logged}, log: {agent})\nDEBUG failed to connect to target: dial unix {socket}: operation was canceled\n',
                    f'{stamp} srv OK {logged}\n{stamp} #1 -> ({len(payload)+2}) {quoted}\n{stamp} srv parent process exited; shutting down\n{stamp} #1 failed writing: write unix {socket}->@: write: broken pipe\n{stamp} srv QUIT\n')
        original_bootstrap,original_agent=native_logs(pid)
        bootstrap.write_text(original_bootstrap);agent.write_text(original_agent)
        proof['fly_native_logs']={'bootstrap':str(bootstrap),'agent':str(agent),'timezone':'UTC'};self.reseal()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted']);self.assertTrue(result['startup_processes'][3]['native_log_identity'])
        self.assertNotIn('birth',result['startup_processes'][3])
        saved_logs=dict(proof['fly_native_logs'])
        for fields,reason in [({k:v for k,v in saved_logs.items() if k!='timezone'},'timezone required'),
                              ({**saved_logs,'timezone':'Unknown/Original'},'timezone unavailable'),
                              ({**saved_logs,'timezone':'America/New_York'},'log clock')]:
            proof['fly_native_logs']=fields
            with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        foreign=native/'foreign.log';foreign.write_bytes(agent.read_bytes())
        proof['fly_native_logs']={**saved_logs,'agent':str(foreign)};self.reseal()
        with self.assertRaisesRegex(ValueError,'bootstrap binding'):self.validate_fixture(receipt,owner,proof)
        foreign.unlink();proof['fly_native_logs']=saved_logs;self.reseal()
        prior=agent.read_text()
        for mutation,reason in [(native_logs(os.getpid())[1],'bootstrap|PING|shutdown'),
                                (prior.replace('srv QUIT','missing shutdown'),'shutdown chain'),
                                (prior.replace(socket,'/foreign/socket'),'shutdown chain')]:
            agent.write_text(mutation);self.reseal()
            with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        agent.write_text(prior);self.reseal()
        live_bootstrap,live_agent=native_logs(os.getpid())
        bootstrap.write_text(live_bootstrap);agent.write_text(live_agent);self.reseal()
        with self.assertRaisesRegex(ValueError,'PID present'):self.validate_fixture(receipt,owner,proof)

    def test_startup_reconciliation_rejects_missing_or_live_or_dispatched_evidence(self):
        receipt,owner,proof=self.fixture()
        paths=[self.relay/'startup-agent.json',self.runs.parent/'cli.log.process.json',self.campaign/'summary.json']
        original={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        def alter(path,**kwargs):self.save(path,{**json.loads(path.read_text()),**kwargs})
        def live_agent():
            import hashlib
            alter(paths[0],agent={'pid':os.getpid(),'birth':self.live_stamp(os.getpid()),'version':'0.5.5','socket_identity':[3,4]})
            alter(self.relay/'startup-cleanup.json',agent_identity_sha256=hashlib.sha256(paths[0].read_bytes()).hexdigest())
        def started_job():
            summary=json.loads(paths[2].read_text());summary['jobs'][0]['started_at']='2026-01-01';self.save(paths[2],summary)
        mutations=[('missing-capture',lambda:paths[0].unlink(),None),
                   ('missing-sidecar',lambda:paths[1].unlink(),None),
                   ('unjoined-supervisor',lambda:alter(paths[1],quiescent=False),'process closure'),
                   ('forced-cleanup',lambda:alter(paths[1],term_sent=[123]),'process closure'),
                   ('dispatched-job',lambda:alter(paths[2],peak_concurrency=1),'startup inventory'),
                   ('started-job',started_job,'dispatched job'),
                   ('live-agent',live_agent,'exact process remains live'),
                   ('reached-ready',lambda:self.save(self.relay/'ready.json',{}),'reached relay admission'),
                   ('bad-source',lambda:proof.update(source={'head':'f'*40,'digest':'b'*64}),'request identity')]
        for name,mutate,reason in mutations:
            with self.subTest(name=name):
                for p in self.base.rglob('*'):
                    if p.is_file() and p not in original:p.unlink()
                for p,raw in original.items():p.write_bytes(raw)
                proof['source']=receipt['source'];mutate();self.reseal()
                if reason is None:
                    with self.assertRaisesRegex(ValueError,'noncanonical proof file'):self.validate_fixture(receipt,owner,proof)
                else:
                    with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        for p,raw in original.items():p.write_bytes(raw)
        proof['source']=receipt['source'];self.reseal()
        proof['files'][str(paths[0])]='0'*64
        with self.assertRaisesRegex(ValueError,'hash mismatch'):
            self.validate_fixture(receipt,owner,proof)

    def test_native_campaign_joins_exact_hub_before_supervisor_exit(self):
        result=subprocess.run([sys.executable,str(ROOT/'scripts/tests/fixtures/native_campaign_hub_join.py'),
                               str(self.target/'run-bench-campaign.py')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_native_retired_hub_owner_refuses_foreign_paths_live_pids_and_reused_groups(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        runs=self.base/'.context/deploy-cloud'/('a'*64)/'runs';hub=runs/'_hub';hub.mkdir(parents=True)
        child=subprocess.run([sys.executable,'-c',
            "import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],
            start_new_session=True,capture_output=True,text=True,check=True)
        pid,ticks=child.stdout.split();token='b'*32;port='12345'
        owner=hub/f'agent-link-server.{port}.{token}.owner'
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        fields=dict(version='1',pid=pid,pgid=pid,pid_start=f'proc-start:{boot}:{ticks}',
            owner_token=token,command=str(self.base/'agents/benchmarks/agent_link_server.py'),
            argv_sha256='c'*64,root=str(runs),runs_root=str(runs),repo_root=str(self.base),
            context_dir=str(hub),host='127.0.0.1',port=port,status='starting')
        def save(values):
            owner.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));owner.chmod(0o644)
        retired=module['native_hub_owner_retired'];save(fields)
        self.assertTrue(retired(owner,runs,self.base))
        with patch.object(subprocess,'check_output',return_value=pid+'\n'):
            self.assertFalse(retired(owner,runs,self.base),'a reused or remaining group must not be skipped')
        for key,value in [('repo_root',str(self.base/'foreign')),('command','/foreign/hub.py'),
                          ('root','/foreign'),('owner_token','d'*32),('port','23456'),
                          ('pgid',str(int(pid)+1)),('pid_start','unknown'),('status','unknown')]:
            with self.subTest(key=key):
                save({**fields,key:value})
                with self.assertRaises(ValueError):retired(owner,runs,self.base)
        save({**fields,'pid':str(os.getpid()),'pgid':str(os.getpid())})
        live_owner=hub/f'agent-link-server.{port}.{token}.owner'
        self.assertFalse(retired(live_owner,runs,self.base),'live/reused PID must use original live protocol')
        save(fields);owner.unlink();owner.symlink_to(self.base/'foreign-owner')
        with self.assertRaises(ValueError):retired(owner,runs,self.base)

    def test_native_hub_join_attempts_later_owners_after_each_failure(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        runs=self.base/'.context/deploy-cloud'/('a'*64)/'runs'
        hub=runs/'_hub';hub.mkdir(parents=True)
        for index,content in enumerate(['missing=port\n','port=2\n','port=3\n']):
            (hub/f'agent-link-server.{index}.owner').write_text(content)
        calls=[]
        def terminate(command,**_kwargs):
            calls.append(command[-4])
            if command[-4]=='2':raise subprocess.CalledProcessError(1,command)
        with patch.dict(os.environ,{'DEPLOY_NATIVE_HUB_JOIN':'1','CLOUDBENCH_RUNS_ROOT':str(runs)}), \
             patch.object(subprocess,'run',side_effect=terminate), \
             patch.dict(module['join_native_hubs'].__globals__,native_hub_owner_retired=lambda *_:False):
            with self.assertRaisesRegex(ValueError,'native Hub join incomplete'):
                module['join_native_hubs'](self.base,runs.parent/'campaigns'/('deploy-'+runs.parent.name))
        self.assertEqual(calls,['2','3'])

    def campaign_hub_cleanup_failure(self, cancel):
        import runpy,signal
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        namespace=module['main'].__globals__
        scripts=self.base/'scripts';scripts.mkdir()
        (scripts/'run-bench').write_text('exit 0\n')
        fixture_module=runpy.run_path(str(self.target/'tests/fixtures/campaign_cleanup_fixture.py'))
        cleanup=fixture_module['CampaignCleanupFixture'](self.base,self.target.parent)
        self.addCleanup(cleanup.close)
        arguments=['campaign','--root',str(self.base),'--runs','1','--concurrency','2',
                   '--retry-infra','0','--task=fixture']
        published=[]
        def publish(_workspace,_directory,summary,**_kwargs):
            if _kwargs.get('live'):return True
            published.append(summary['status'])
            if cancel:
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
                return False
            return True
        def refuse_inventory(*_args,**_kwargs):
            raise RuntimeError('fixture refuses before controller admission')
        def refuse_join(*_args):raise ValueError('fixture Hub join failed')
        replacements=dict(campaign_workspace=lambda root,_forward:(root,None),provider_capacity_refusal=lambda _n:None,
            scorecard_hooks=lambda:None,start_shared_inventory=refuse_inventory,
            publish_campaign_group=publish,join_native_hubs=refuse_join,
            infra_stop_predicate=lambda:lambda *_args:False)
        handlers={number:signal.getsignal(number)for number in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
        try:
            with cleanup.scope(),patch.dict(namespace,replacements),patch.object(sys,'argv',arguments),patch.dict(os.environ,{
                'RUN_BENCH_CAMPAIGN_ROOT':str(self.base/'campaigns'),'RUN_BENCH_CAMPAIGN_ID':'hub-failure',
                'CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY':'1' if cancel else '0','CLOUDBENCH_STRICT_BARRIER':'0',
                'BENCHMARK_HUB_GROUP_RUN_ID':'','BENCHMARK_HUB_PARENT_RUN_ID':''}):
                code=module['main']()
        finally:
            for number,handler in handlers.items():signal.signal(number,handler)
        summary=json.loads((self.base/'campaigns/hub-failure/summary.json').read_text())
        return code,summary,published

    def test_publication_cancellation_stays_cancelled_when_hub_join_fails(self):
        code,summary,_published=self.campaign_hub_cleanup_failure(True)
        self.assertEqual(code,143)
        self.assertEqual(summary['status'],'cancelled')
        self.assertTrue(summary['shared_transport_cleanup_pending'])
        self.assertEqual(summary['peak_concurrency'],0)
        self.assertTrue(all(job.get('controller_pid')is None for job in summary['jobs']))

    def test_successful_campaign_still_fails_when_hub_join_fails(self):
        code,summary,published=self.campaign_hub_cleanup_failure(False)
        self.assertEqual(published,['passed'])
        self.assertNotEqual(code,0)
        self.assertEqual(summary['status'],'failed')
        self.assertTrue(summary['shared_transport_cleanup_pending'])

    def test_campaign_persists_fixed_commands_before_any_controller_admission(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        namespace=module['main'].__globals__
        tasks=['fixture-'+str(i)for i in range(600)]
        arguments=['campaign','--root',str(self.base),'--runs','1','--concurrency','600','--retry-infra','0',
                   '--forward-arg=--ref','--forward-arg='+'a'*40,*['--task='+name for name in tasks]]
        def refuse_inventory(*_args,**_kwargs):raise RuntimeError('fixture refuses before controller admission')
        replacements=dict(campaign_workspace=lambda root,_forward:(root,None),provider_capacity_refusal=lambda _n:None,
                          scorecard_hooks=lambda:None,start_shared_inventory=refuse_inventory,
                          publish_campaign_group=lambda *_a,**_kw:True)
        with patch.dict(namespace,replacements),patch.object(sys,'argv',arguments),             patch.dict(os.environ,{'RUN_BENCH_CAMPAIGN_ROOT':str(self.base/'campaigns'),'RUN_BENCH_CAMPAIGN_ID':'command-proof'}):
            self.assertEqual(module['main'](),1)
        summary=json.loads((self.base/'campaigns/command-proof/summary.json').read_text())
        self.assertEqual(summary['peak_concurrency'],0)
        self.assertEqual(len(summary['jobs']),600)
        for job in summary['jobs']:
            self.assertEqual(job.get('controller_command'),['bash',str(self.base/'scripts/run-bench'),job['task'],'--ref','a'*40,'--foreground'])
            self.assertIsNone(job.get('controller_pid'))

    def preallocation_fixture(self):
        import hashlib,shutil,time
        receipt,owner,proof=self.fixture()
        (self.relay/'startup-cleanup.json').unlink()
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        authority=json.loads((self.relay/'authority.private.json').read_text())
        ready=dict(agent=capture['agent'],authority_sha256=capture['authority_sha256'],
                   pid=capture['broker']['pid'],birth=capture['broker']['birth'],
                   socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json',ready)
        self.save(self.relay/'serve.once.json',{k:ready[k]for k in ('authority_sha256','pid','birth')})
        (self.relay/'broker.private.log').write_text('{"stopped": true}\n')
        def retired():
            r=subprocess.run([sys.executable,'-c',"import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],text=True,capture_output=True,check=True)
            pid,start=r.stdout.split();return dict(pid=int(pid),birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+start)
        controller,hub_process=retired(),retired()
        hub=self.runs/'_hub';hub.mkdir()
        hub_owner=hub/('agent-link-server.8765.'+'b'*32+'.owner')
        fields=dict(version='1',status='live-transfer-required',pid=str(hub_process['pid']),pgid=str(hub_process['pid']),
                    pid_start=hub_process['birth'],owner_token='b'*32,argv_sha256='c'*64,
                    root=str(self.runs),runs_root=str(self.runs),repo_root=str(self.base),context_dir=str(hub),
                    command=str(self.base/'agents/benchmarks/agent_link_server.py'))
        text=lambda p,v:p.write_text(''.join(k+'='+str(x)+'\n'for k,x in v.items()))
        text(hub_owner,fields)
        fleet=self.runs/('20261106-090000-'+str(controller['pid']));batch=fleet/'_batch';batch.mkdir(parents=True)
        audit=fleet/'teardown-ownership';audit.mkdir()
        token='c'*32
        text(audit/'meta',dict(version='1',fleet_owner_token=token,run_id=fleet.name,app='fixture',workspace_root=str(self.base),
            status='provider-teardown-verified',hub_disposition='retained-exact-owner-transfer-required',hub_owner_file=str(hub_owner),
            hub_owner_token='b'*32,hub_pid=fields['pid'],hub_pid_start=fields['pid_start'],hub_argv_sha256=fields['argv_sha256']))
        (audit/'provider-teardown-verified.epoch').write_text(str(time.time()-2.8))
        for name in ['owned-clones.ids','owned-clones.names']:(audit/name).write_bytes(b'')
        canonical=self.base/'.git/cloudbench-fleet-audits'/token;canonical.parent.mkdir(parents=True);shutil.copytree(audit,canonical)
        seal=hashlib.sha256()
        for path in sorted(audit.iterdir()):
            for raw in [path.name.encode(),path.read_bytes()]:seal.update(len(raw).to_bytes(8,'big'));seal.update(raw)
        text(audit/'source-audit',dict(path=str(canonical),sha256=seal.hexdigest()))
        self.save(batch/'lifecycle.json',dict(version=1,fleet_owner_token=token,run_id=fleet.name,workspace_root=str(self.base),
            status='failed',controller_exit_code=1,audit_sha256=seal.hexdigest(),hub_publication_failed=False))
        self.save(batch/'benches.json',[dict(name='browser-smoke',mode='REAL')])
        self.save(batch/'run.json',dict(run_id=fleet.name,controller_exit_code=1,status='failed',tasks=[dict(name='browser-smoke',
            status='INFRA_ERROR',passed=False,failure_reason='no current run artifact produced',lifecycle_stage='released')]))
        self.save(batch/'disposable-cleanup.json',dict(schema='disposable-cleanup-v1',owner=token,guest_cleanup_missing=False,runtime_evidence_missing=False))
        summary=json.loads((self.campaign/'summary.json').read_text())
        summary['jobs'][0].update(status='failed',controller_pid=controller['pid'],controller_exit_code=1,
            controller_command=['bash',str(self.base/'scripts/run-bench'),'browser-smoke','--ref',receipt['source']['head'],'--foreground'])
        summary['peak_concurrency']=1;summary.pop('shared_inventory_failed');self.save(self.campaign/'summary.json',summary)
        (self.campaign/'r001-j0001.log').write_text(f'{self.base}/scripts/run-bench monitor {fleet}\nowner: {token}; private controller diagnostics stay in this run directory.\n')
        sidecar=json.loads((self.runs.parent/'cli.log.process.json').read_text())
        sidecar.update(orphaned_children=True,term_sent=[hub_process['pid']],reaped=[*sidecar['reaped'],dict(pid=hub_process['pid'],status=15)])
        self.save(self.runs.parent/'cli.log.process.json',sidecar)
        adapter_path=Path(receipt['worker_result']);adapter=json.loads(adapter_path.read_text())
        receipt['started_at']=adapter['started_at']
        adapter.update(fleet_directory=None,reason='cloud command interrupted or source changed');self.save(adapter_path,adapter)
        reference=receipt['native_cleanup_reference'];reference['native_directory']=None
        reference['result_sha256']=hashlib.sha256(adapter_path.read_bytes()).hexdigest()
        proof['worker_result_sha256']=reference['result_sha256'];proof['layout']='campaign-preallocation-v1'
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest()
        self.reseal();return receipt,owner,proof,fleet

    def mixed_preallocation_fixture(self, graded_count=11):
        import hashlib, shutil
        from cloudbench_execution_provenance import build_config, build_task_matrix
        receipt, owner, proof, original = self.preallocation_fixture()
        seed = self.base / 'seed'; shutil.copytree(original, seed)
        shutil.rmtree(original)
        shutil.rmtree(self.base / '.git/cloudbench-fleet-audits' / ('c' * 32))
        jobs, fleets = [], []
        names = ['browser-smoke', 'zero-two'] + ['graded-' + str(i) for i in range(graded_count)]
        for index, name in enumerate([*names, 'infra-probe']):
            pid = 2100000000 + index
            fleet = self.runs / ('20261106-090000-' + str(pid)); shutil.copytree(seed, fleet)
            fleets.append(fleet); token = f'{index + 256:032x}'
            audit = fleet / 'teardown-ownership'; (audit / 'source-audit').unlink()
            meta = self.native.fields((audit / 'meta').read_bytes()); meta.update(fleet_owner_token=token, run_id=fleet.name)
            (audit / 'meta').write_text(''.join(k+'='+str(v)+'\n' for k,v in meta.items()))
            batch = fleet / '_batch'
            self.save(batch / 'benches.json', [dict(name=name, mode='REAL')])
            life = json.loads((batch / 'lifecycle.json').read_text())
            life.update(fleet_owner_token=token, run_id=fleet.name, status='failed' if index < 2 else 'verified', controller_exit_code=1 if index < 2 else 0)
            if index >= 2:
                matrix = build_task_matrix([name + '=real'])
                self.save(fleet / 'execution-task-matrix.json', matrix)
                self.save(fleet / 'execution-provenance.json', dict(schema_version='cloudbench-execution-provenance-v1',
                    base_sha=receipt['source']['head'], workspace_patch_sha256='none',
                    config=build_config('cloudbench-fleet-config-v1', ['task_count=1', 'task_matrix_sha256='+matrix['sha256']]),
                    controller_snapshot=dict(schema_version='cloudbench-controller-snapshot-v1', sha256='d'*64)))
            self.save(batch / 'run.json', dict(run_id=fleet.name, controller_exit_code=life['controller_exit_code'],
                status='failed' if index < 2 else 'passed', tasks=[dict(name=name, passed=index >= 2,
                status='INFRA_ERROR' if index < 2 else 'PASSED', lifecycle_stage='released',
                failure_reason='no current run artifact produced' if index < 2 else None)]))
            self.save(batch / 'disposable-cleanup.json', dict(schema='disposable-cleanup-v1', owner=token,
                guest_cleanup_missing=False, runtime_evidence_missing=False, successful_runtime_inferred=False))
            canonical=self.base/'.git/cloudbench-fleet-audits'/token; shutil.copytree(audit,canonical)
            seal=hashlib.sha256()
            for path in sorted(audit.rglob('*'), key=lambda p:str(p.relative_to(audit))):
                if path.is_file():
                    for raw in [str(path.relative_to(audit)).encode(),path.read_bytes()]:seal.update(len(raw).to_bytes(8,'big'));seal.update(raw)
            (audit/'source-audit').write_text('path='+str(canonical)+'\nsha256='+seal.hexdigest()+'\n')
            life['audit_sha256']=seal.hexdigest(); self.save(batch/'lifecycle.json',life)
            if index < len(names):
                log=self.campaign/f'r001-j{index+1:04d}.log'
                log.write_text(f'{self.base}/scripts/run-bench monitor {fleet}\nowner: {token}; private controller diagnostics stay in this run directory.\n')
                jobs.append(dict(job_id=log.stem,task=name,run=1,attempt=1,attempts=[],
                    status='cancelled' if index==0 else 'failed' if index==1 else 'passed',controller_exit_code=life['controller_exit_code'],
                    controller_pid=pid,log=str(log),controller_command=['bash',str(self.base/'scripts/run-bench'),name,'--ref',receipt['source']['head'],'--foreground']))
        shutil.rmtree(seed)
        with (self.campaign/'r001-j0001.log').open('a') as stream:
            stream.write(f'{self.base}/scripts/run-bench monitor {fleets[-1]}\n')
        summary=json.loads((self.campaign/'summary.json').read_text()); summary.update(jobs=jobs,task_count=len(names),total_jobs=len(names),concurrency=len(names),peak_concurrency=len(names))
        self.save(self.campaign/'summary.json',summary)
        request_path=Path(receipt['log']).parent/'request.json';request=json.loads(request_path.read_text());request['checks']=names;request['skips']={k:{'kind':'historical-agentcard-no-retry-v1','disposition':'NO_RETRY_CUSTODY','source':receipt['source'], 'current_binding':{'source':receipt['source']},'current_execution':'UNVERIFIED','current_financial_state':'UNVERIFIED','credit':{'test_execution':False,'assertions':False,'financial_release':False}} for k in ('old-one','old-two')};self.save(request_path,request)
        receipt['cases']={**dict.fromkeys(names,'UNVERIFIED'),**dict.fromkeys(request['skips'],'SKIP')};receipt['case_complete']=dict.fromkeys(receipt['cases'],False)
        adapter_path=Path(receipt['worker_result']);adapter=json.loads(adapter_path.read_text())
        adapter.update(checks=names,cases={name:'UNVERIFIED' if i<2 else 'PASS' for i,name in enumerate(names)},fleet_directory=str(self.campaign),
            native_command=['bash','scripts/run-bench',*names,'--runs','1','--concurrency',str(len(names)),'--retry-infra','0','--ref',receipt['source']['head']])
        self.save(adapter_path,adapter);reference=receipt['native_cleanup_reference'];reference.update(native_directory=str(self.campaign),result_sha256=c.sha_file(adapter_path))
        proof.update(worker_result_sha256=reference['result_sha256'],layout='campaign-mixed-preallocation-v1')
        self.save(Path(receipt['log']).parent/'receipt.json',receipt);proof['receipt_sha256']=c.sha_file(Path(receipt['log']).parent/'receipt.json')
        self.reseal();return receipt,owner,proof,fleets

    def test_mixed_preallocation_cleanup_preserves_all_unverified_without_credit(self):
        receipt,owner,proof,fleets=self.mixed_preallocation_fixture()
        before={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(14,len(result['participants']))
        self.assertEqual(2,len(result['preallocation_source_authorities']))
        self.assertEqual(['UNVERIFIED']*13+['SKIP']*2,list(receipt['cases'].values()))
        self.assertEqual(11,list(c.read(Path(receipt['worker_result']))['cases'].values()).count('PASS'))
        self.assertEqual(before,{p:p.read_bytes() for p in before})
        for layout in ('campaign-v1','campaign-preallocation-v1'):
            with self.assertRaises(ValueError): self.validate_fixture(receipt,owner,{**proof,'layout':layout})

    def test_mixed_preallocation_refuses_ambiguous_artifacts_source_and_ownership(self):
        import shutil
        receipt,owner,proof,fleets=self.mixed_preallocation_fixture()
        original={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        def edit(path, change):
            value=c.read(path); change(value); self.save(path,value)
        zero,normal=fleets[0],fleets[2]
        def dangling():
            for name in ('execution-provenance.json','execution-task-matrix.json'):
                (zero/name).symlink_to(zero/'absent')
        variants=[
            ('one-sided provenance',lambda:c.write(zero/'execution-provenance.json',{})),
            ('dangling provenance',dangling),
            ('zero task artifact',lambda:c.write(zero/'browser-smoke/cloudbench-run.json',{})),
            ('native agent',lambda:edit(zero/'_batch/run.json',lambda v:v['tasks'][0].update(agent_id='unexpected'))),
            ('inferred runtime',lambda:edit(zero/'_batch/disposable-cleanup.json',lambda v:v.update(successful_runtime_inferred=True))),
            ('invalid normal provenance',lambda:edit(normal/'execution-provenance.json',lambda v:v.update(base_sha='f'*40))),
            ('normal missing provenance',lambda:(normal/'execution-provenance.json').unlink()),
            ('foreign command',lambda:edit(self.campaign/'summary.json',lambda v:v['jobs'][0]['controller_command'].__setitem__(-2,'f'*40))),
            ('foreign skip kind',lambda:edit(Path(receipt['log']).parent/'request.json',lambda v:v['skips']['old-one'].update(kind='waiver'))),
            ('foreign skip source',lambda:edit(Path(receipt['log']).parent/'request.json',lambda v:v['skips']['old-one'].update(source={'head':'f'*40}))),
            ('unaccounted participant',lambda:(self.runs/'unknown-owner').mkdir()),
            ('unknown supervisor',lambda:edit(self.runs.parent/'cli.log.process.json',lambda v:v.update(quiescent=False))),
            ('allocation omitted from audit',lambda:(zero/'teardown-ownership/owned-clones.ids').write_text('unreconciled')),
        ]
        for name, mutate in variants:
            with self.subTest(case=name):
                for path in list(self.base.rglob('*')):
                    if path.is_symlink() or path.is_file() and path not in original: path.unlink()
                unknown=self.runs/'unknown-owner'
                if unknown.exists(): shutil.rmtree(unknown)
                for path,raw in original.items(): path.write_bytes(raw)
                mutate();self.reseal()
                with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)

    def test_mixed_preallocation_requires_a_graded_parent_not_just_a_canary(self):
        receipt,owner,proof,fleet=self.mixed_preallocation_fixture(graded_count=0)
        with self.assertRaisesRegex(ValueError,'requires both'):
            self.validate_fixture(receipt,owner,proof)

    def pending_hub_fixture(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        summary=json.loads((self.campaign/'summary.json').read_text())
        summary['shared_transport_cleanup_pending']=True;self.save(self.campaign/'summary.json',summary)
        side=self.runs.parent/'cli.log.process.json';value=json.loads(side.read_text())
        value.update(orphaned_children=False,term_sent=[]);self.save(side,value)
        owners=sorted((self.runs/'_hub').glob('*.owner'))
        for path in owners:
            fields=dict(line.split('=',1)for line in path.read_text().splitlines())
            fields.update(host='127.0.0.1',port='8765')
            path.write_text(''.join(k+'='+v+'\n'for k,v in fields.items()));path.chmod(0o444)
        proof['current_hub_retirement']={'kind':'current-native-hub-retirement-v1','owners':list(map(str,owners))}
        self.reseal();return receipt,owner,proof,fleet

    def test_pending_preallocation_hubs_require_current_exact_retirement_without_rewriting_summary(self):
        receipt,owner,proof,fleet=self.pending_hub_fixture()
        before=(self.campaign/'summary.json').read_bytes()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(before,(self.campaign/'summary.json').read_bytes())
        self.assertEqual(result['current_hub_retirement'],proof['current_hub_retirement'])

    def test_pending_preallocation_hubs_refuse_unbound_inventory_or_unknown_supervisor_termination(self):
        receipt,owner,proof,fleet=self.pending_hub_fixture()
        original=copy.deepcopy(proof['current_hub_retirement'])
        for marker in [None,{'kind':'foreign','owners':original['owners']},
                       {**original,'owners':[]},{**original,'owners':original['owners']*2}]:
            proof['current_hub_retirement']=marker
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)
        proof['current_hub_retirement']=original
        side=self.runs.parent/'cli.log.process.json';value=json.loads(side.read_text())
        for change in [dict(orphaned_children=True),dict(term_sent=[os.getpid()]),dict(quiescent=False)]:
            self.save(side,{**value,**change});self.reseal()
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)
        self.save(side,value);self.reseal()
        path=Path(original['owners'][0]);content=path.read_text();path.chmod(0o644)
        path.write_text(content.replace('repo_root='+str(self.base),'repo_root=/foreign'));path.chmod(0o444);self.reseal()
        with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)

    def test_preallocation_campaign_reconciliation_keeps_original_unverified(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        before=json.dumps(receipt,sort_keys=True)
        result=self.validate_fixture(receipt,owner,proof)
        self.assertEqual(result['participants'],[str(fleet)])
        self.assertFalse(result['credit_granted']);self.assertEqual(before,json.dumps(receipt,sort_keys=True))

    def test_preallocation_campaign_refuses_execution_live_or_changed_ownership(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        original={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        mutations=[('appended-foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text((self.campaign/'r001-j0001.log').read_text()+'ref : '+'f'*40+'\n'),'foreign log ref'),
                   ('masked-foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text('ref : '+'f'*40+'\nref : '+receipt['source']['head']+'\n'+(self.campaign/'r001-j0001.log').read_text()),'foreign log ref'),
                   ('foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text('ref : '+'f'*40+'\n'+(self.campaign/'r001-j0001.log').read_text()),'foreign log ref'),
                   ('missing-command',lambda:self.save(self.campaign/'summary.json',{**json.loads((self.campaign/'summary.json').read_text()),'jobs':[{k:v for k,v in json.loads((self.campaign/'summary.json').read_text())['jobs'][0].items()if k!='controller_command'}]}),'unsupported historical preallocation dispatch'),
                   ('execution',lambda:self.save(fleet/'execution-provenance.json',{}),'execution evidence present'),
                   ('owned-clone',lambda:(fleet/'teardown-ownership/owned-clones.ids').write_text('unknown\n'),'audit seal'),
                   ('live-relay',lambda:self.save(self.relay/'broker-owner.json',dict(pid=os.getpid(),birth=self.live_stamp(os.getpid()),parent_pid=1,parent_start='foreign')),'relay custody'),
                   ('unknown-drain',lambda:self.save(self.runs.parent/'cli.log.process.json',{**json.loads((self.runs.parent/'cli.log.process.json').read_text()),'term_sent':[os.getpid()]}),'unexpected supervised termination')]
        for name,change,reason in mutations:
            with self.subTest(name=name):
                for p in self.base.rglob('*'):
                    if p.is_file()and p not in original:p.unlink()
                for p,raw in original.items():p.write_bytes(raw)
                change();self.reseal()
                with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)



    def preflight_refusal_fixture(self,layout='campaign-preflight-refusal-v1'):
        """PR #1767: every dispatched job refused at run-bench preflight; runs/ empty; no monitor line."""
        import hashlib
        from datetime import datetime,timezone
        receipt,owner,proof=self.fixture()
        (self.relay/'startup-cleanup.json').unlink()
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        ready=dict(agent=capture['agent'],authority_sha256=capture['authority_sha256'],
                   pid=capture['broker']['pid'],birth=capture['broker']['birth'],
                   socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json',ready)
        self.save(self.relay/'serve.once.json',{k:ready[k]for k in ('authority_sha256','pid','birth')})
        (self.relay/'broker.private.log').write_text('{"stopped": true}\n')
        controller=subprocess.run([sys.executable,'-c','import os;print(os.getpid())'],capture_output=True,text=True,check=True)
        head=receipt['source']['head'];summary=json.loads((self.campaign/'summary.json').read_text())
        summary['jobs'][0].update(status='failed',controller_pid=int(controller.stdout),controller_exit_code=1,
            started_at=summary['started_at'],finished_at=summary['finished_at'],wall_clock_seconds=4.179,
            controller_command=['bash',str(self.base/'scripts/run-bench'),'browser-smoke','--ref',head,'--foreground'])
        summary['peak_concurrency']=1;summary.pop('shared_inventory_failed');self.save(self.campaign/'summary.json',summary)
        (self.campaign/'r001-j0001.log').write_text('\U0001f3af resolved 1 benchmark task(s): browser-smoke\n'
            'BENCHMARK PARENT AGENT INSTRUCTIONS \u00b7 FORMAT v8\n- `scripts/run-bench scorecard <run-dir> --html`\n'
            '- The assigned operational owner polls the exact CLI-printed monitor every\n'
            "Campaign summary.json and each child's printed monitor handle are distinct.\n"
            '  ref: the run source line is printed only after warm readiness\n'
            'controller GITHUB_TOKEN exported (len=40)\ncontroller GITHUB_TOKEN exported (len=40)\n'
            f'FATAL: requested benchmark commit {head} is not fetchable from origin and local patch shipping is disabled\n')
        adapter_path=Path(receipt['worker_result']);adapter=json.loads(adapter_path.read_text())
        adapter.update(complete=False,cleanup_complete=False,reason=None,fleet_directory=str(self.campaign),
                       evidence={'browser-smoke':{'unverified':'campaign job has no native fleet handle'}});self.save(adapter_path,adapter)
        reference=receipt['native_cleanup_reference']
        reference['result_sha256']=hashlib.sha256(adapter_path.read_bytes()).hexdigest()
        proof.update(worker_result_sha256=reference['result_sha256'],layout=layout)
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest()
        self.reseal();return receipt,owner,proof

    def test_preflight_refusal_campaign_retires_launch_owner_without_credit(self):
        receipt,owner,proof=self.preflight_refusal_fixture()
        before=json.dumps(receipt,sort_keys=True);originals={p:Path(p).read_bytes()for p in proof['files']}
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual((result['participants'],result['retained_services'],result['native_audit_seals']),([],[],{}))
        self.assertEqual(result['preflight_refusals'],{'r001-j0001':{'task':'browser-smoke','controller_exit_code':1}})
        self.assertEqual(json.dumps(receipt,sort_keys=True),before)
        self.assertEqual(receipt['cases'],{'browser-smoke':'UNVERIFIED'})
        self.assertEqual(originals,{p:Path(p).read_bytes()for p in proof['files']})

    def test_pr1767_preflight_shape_stays_refused_by_the_preallocation_layout(self):
        receipt,owner,proof=self.preflight_refusal_fixture('campaign-preallocation-v1')
        with self.assertRaisesRegex(ValueError,'campaign parent identity'):
            self.validate_fixture(receipt,owner,proof)

    def test_preflight_refusal_refuses_dispatch_foreign_source_live_or_changed_evidence(self):
        receipt,owner,proof=self.preflight_refusal_fixture()
        head=receipt['source']['head'];log=self.campaign/'r001-j0001.log'
        original={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        directories={p for p in self.base.rglob('*')if p.is_dir()}
        fatal=f'FATAL: requested benchmark commit {head} is not fetchable from origin and local patch shipping is disabled\n'
        def job(**change):
            summary=json.loads((self.campaign/'summary.json').read_text());summary['jobs'][0].update(change)
            self.save(self.campaign/'summary.json',summary)
        def summary(**change):
            value=json.loads((self.campaign/'summary.json').read_text());value.update(change)
            self.save(self.campaign/'summary.json',value)
        sidecar=self.runs.parent/'cli.log.process.json'
        mutations=[('monitor',lambda:log.write_text(f'{self.base}/scripts/run-bench monitor {self.runs}/x-1\n'+fatal),'dispatched a fleet'),
                   ('ref-banner',lambda:log.write_text('ref : '+head+'\n'+fatal),'dispatched a fleet'),
                   ('foreign-source',lambda:log.write_text(fatal.replace(head,'f'*40)),'bound source'),
                   ('not-last',lambda:log.write_text(fatal+'later output\n'),'bound source'),
                   ('second-fatal',lambda:log.write_text('FATAL: other\n'+fatal),'bound source'),
                   ('fleet-participant',lambda:(self.runs/'20261108-000340-1').mkdir(),'fleet participant present'),
                   ('hub',lambda:(self.runs/'_hub').mkdir(),'fleet participant present'),
                   ('controller-success',lambda:job(controller_exit_code=0),'preflight job'),
                   ('foreign-command',lambda:job(controller_command=['bash',str(self.base/'scripts/run-bench'),'browser-smoke','--ref','f'*40,'--foreground']),'preflight job'),
                   ('live-controller',lambda:job(controller_pid=os.getpid()),'controller PID present'),
                   ('passed-campaign',lambda:summary(status='passed'),'preflight inventory'),
                   ('pending-hub',lambda:summary(shared_transport_cleanup_pending=True),'additional ownership'),
                   ('live-relay',lambda:self.save(self.relay/'broker-owner.json',dict(pid=os.getpid(),birth=self.live_stamp(os.getpid()),parent_pid=1,parent_start='foreign')),'relay custody'),
                   ('supervised-term',lambda:self.save(sidecar,{**json.loads(sidecar.read_text()),'term_sent':[os.getpid()]}),'unexpected supervised termination')]
        for name,change,reason in mutations:
            with self.subTest(name=name):
                for path in sorted(self.base.rglob('*'),reverse=True):
                    if path.is_dir() and path not in directories:path.rmdir()
                for path,raw in original.items():path.write_bytes(raw)
                change();self.reseal()
                with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        for path in sorted(self.base.rglob('*'),reverse=True):
            if path.is_dir() and path not in directories:path.rmdir()
        for path,raw in original.items():path.write_bytes(raw)
        self.reseal();log.write_text(fatal)  # same text, different bytes (no prefix): unbound change
        with self.assertRaisesRegex(ValueError,'file hash mismatch'):self.validate_fixture(receipt,owner,proof)


    def test_preallocation_declared_skip_projection_retains_all_native_unknown_facts(self):
        import hashlib
        receipt,owner,proof,fleet=self.preallocation_fixture()
        path=Path(receipt['log']).parent/'request.json';request=json.loads(path.read_text())
        names=['agent-payment-test-shop','agent-payment-setup-resume','agent-payment-idempotent-abandonment',
               'agent-payment-abandonment','agent-payment-new-user-journey']
        request['skips']={name:{'disposition':'user / overridden','source':request['source']}for name in names}
        self.save(path,request)
        receipt['cases']={**receipt['cases'],**dict.fromkeys(names,'SKIP')}
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest();self.reseal()
        before={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted']);self.assertFalse(receipt['complete'])
        self.assertEqual(receipt['cases'],{'browser-smoke':'UNVERIFIED',**dict.fromkeys(names,'SKIP')})
        self.assertEqual(json.loads(Path(receipt['worker_result']).read_text())['cases'],{'browser-smoke':'UNVERIFIED'})
        self.assertEqual(before,{p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()})

    def test_preallocation_mixed_projection_refuses_wrong_skip_and_active_outcomes(self):
        import hashlib
        receipt,owner,proof,fleet=self.preallocation_fixture()
        folder=Path(receipt['log']).parent;request=json.loads((folder/'request.json').read_text())
        request['skips']={'agent-payment-test-shop':{'source':request['source'],'disposition':'user / overridden'}}
        self.save(folder/'request.json',request);receipt['cases']['agent-payment-test-shop']='SKIP'
        def seal():
            self.save(folder/'receipt.json',receipt)
            proof['receipt_sha256']=hashlib.sha256((folder/'receipt.json').read_bytes()).hexdigest();self.reseal()
        seal();self.validate_fixture(receipt,owner,proof)
        original=copy.deepcopy(receipt['cases'])
        for cases in [dict(original,**{'agent-payment-test-shop':'PASS'}),dict(original,**{'agent-payment-test-shop':'UNVERIFIED'}),
                      {'browser-smoke':'UNVERIFIED'},dict(original,extra='SKIP'),
                      {'browser-smoke':'PASS','agent-payment-test-shop':'SKIP'}]:
            receipt['cases']=cases;seal()
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)
        receipt['cases']=original
        for skips in [None,[],['agent-payment-test-shop'],{},
                      {'browser-smoke':{}}, {'not-declared-in-receipt':{}}]:
            request['skips']=skips;self.save(folder/'request.json',request);seal()
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)



class CleanupPrepareEvidence(unittest.TestCase):
    """Original zero-start ticket refusal keeps execution UNKNOWN and proof closure exact."""
    setUp = RelayStartupEvidence.setUp
    fixture = RelayStartupEvidence.fixture

    def prepare_fixture(self, producer_head='abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077'):
        import hashlib
        receipt, owner, proof = self.fixture()
        (self.relay / 'startup-cleanup.json').unlink()
        capture = json.loads((self.relay / 'startup-agent.json').read_text())
        ready = dict(agent=capture['agent'], authority_sha256=capture['authority_sha256'],
                     pid=capture['broker']['pid'], birth=capture['broker']['birth'],
                     socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json', ready)
        self.save(self.relay/'serve.once.json', {k: ready[k] for k in ('authority_sha256', 'pid', 'birth')})
        (self.relay/'broker.private.log').write_text('{"stopped": true}\n')
        folder = Path(receipt['log']).parent
        request = json.loads((folder/'request.json').read_text())
        tasks = ['fixture-task-%02d' % i for i in range(14)]
        request['checks'] = tasks
        self.save(folder/'request.json', request)
        cases = dict.fromkeys(tasks, 'UNVERIFIED')
        receipt.update(checks=tasks, cases=cases)
        adapter = json.loads(Path(receipt['worker_result']).read_text())
        adapter.update(checks=tasks, cases=cases, complete=False, cleanup_complete=False,
                       fleet_directory=str(self.campaign), native_command=['bash', 'scripts/run-bench', *tasks,
                       '--runs', '1', '--concurrency', '14', '--retry-infra', '0', '--ref', receipt['source']['head']])
        self.save(Path(receipt['worker_result']), adapter)
        reference = receipt['native_cleanup_reference']
        reference['result_sha256'] = hashlib.sha256(Path(receipt['worker_result']).read_bytes()).hexdigest()
        self.save(folder/'receipt.json', receipt)
        proof.update(receipt_sha256=hashlib.sha256((folder/'receipt.json').read_bytes()).hexdigest(),
                     worker_result_sha256=reference['result_sha256'], layout='campaign-cleanup-prepare-v1')
        summary = json.loads((self.campaign/'summary.json').read_text())
        summary.pop('shared_inventory_failed')
        summary.update(concurrency=14, task_count=14, total_jobs=14, cleanup_ticket_failure='prepare',
                       cleanup_cohorts=[dict(cohort_id='c001',status='queued',ready_count=0,expected_count=14,
                                            failed_count=0,released_count=0,released_at=None)],
                       jobs=[dict(job_id='r001-j%04d' % (i+1), task=task, run=1, attempt=1, attempts=[],
                           status='cancelled', controller_pid=None, controller_exit_code=None, started_at=None,
                           finished_at=None, wall_clock_seconds=None, log=str(self.campaign/('r001-j%04d.log' % (i+1))),
                           controller_command=['bash',str(self.base/'scripts/run-bench'),task,'--ref',receipt['source']['head'],'--foreground'])
                           for i,task in enumerate(tasks)])
        self.save(self.campaign/'summary.json',summary)
        cohort = self.campaign/'cleanup-cohorts/c001'
        (cohort/'cleanup-budget').mkdir(parents=True)
        (cohort/'ready').mkdir()
        (cohort.parent/'parent.lock').touch(); (cohort/'cleanup-budget/prepare.lock').touch()
        self.save(cohort/'manifest.json',dict(cohort_id='c001',jobs=dict.fromkeys(j['job_id'] for j in summary['jobs'])))
        (self.base/'.git/cloudbench-fleet-ownership').mkdir(parents=True,mode=0o700)
        scripts = self.base/'scripts'; scripts.mkdir()
        for name in ('run-bench-campaign.py','cloudbench-cleanup-tickets.py','run-bench','deploy_test_cloud.py'):
            data = subprocess.check_output(['git','-C',str(ROOT),'show',producer_head+':scripts/'+name])
            (scripts/name).write_bytes(data)
        self.reseal()
        return receipt,owner,proof

    def validate_prepare_fixture(self,receipt,owner,proof):
        import types
        original = subprocess.check_output
        published = types.ModuleType('deploy_test_cloud'); published.campaign_published=lambda *_a:getattr(self,'published',True)
        def source(args,**kwargs):
            if args[0]=='ps': return original(args,**kwargs)
            if args[-1].endswith('cloudbench-shared-relay.py'): return b'original-broker'
            return (self.base/'scripts'/args[-1].rsplit('/',1)[-1]).read_bytes()
        with patch.dict(sys.modules,deploy_test_cloud=published), patch.object(self.native.runpy,'run_path',return_value={}), \
             patch.object(self.native.subprocess,'check_output',side_effect=source):
            state={'plan':{'gates':[{'name':'smoke','native_cloud':True}]},'attempts':[{'results':[receipt]}],
                   'failures':[{'id':'prepare-failure','gate':'smoke','check':'smoke/'+receipt['checks'][0],
                                'native_result':'UNVERIFIED','complete':False}]}
            original_state=copy.deepcopy(state)
            self.native.reconcile(state,'prepare-failure',proof)
            self.assertEqual(original_state['attempts'],state['attempts'])
            self.assertEqual(original_state['failures'],state['failures'])
            return next(iter(state['reconciled_owners'].values()))

    def test_prepare_reconciliation_never_grants_execution_credit(self):
        receipt,owner,proof=self.prepare_fixture()
        entry=self.validate_prepare_fixture(receipt,owner,proof)
        self.assertEqual(entry['participants'],[]);self.assertEqual(entry['retained_services'],[])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(entry['native_audit_seals'],{})

    def test_prepare_rejects_started_or_partial_or_unretired_evidence(self):
        receipt,owner,proof=self.prepare_fixture()
        originals={p:p.read_bytes() for p in self.base.rglob('*')if p.is_file()}
        summary_path=self.campaign/'summary.json'
        mutations=[('pid',lambda v:v['jobs'][0].update(controller_pid=123)),
                   ('bool-exit',lambda v:v['jobs'][0].update(controller_exit_code=False)),
                   ('started-clock',lambda v:v['jobs'][0].update(started_at=v['started_at'])),
                   ('peak-bool',lambda v:v.update(peak_concurrency=False)),
                   ('wrong-reason',lambda v:v.update(cleanup_ticket_failure='assign')),
                   ('missing-job',lambda v:v['jobs'].pop()),
                   ('duplicate-task',lambda v:v['jobs'][0].update(task=v['jobs'][1]['task'])),
                   ('wrong-ref',lambda v:v['jobs'][0]['controller_command'].__setitem__(-2,'f'*40)),
                   ('bool-cohort',lambda v:v['cleanup_cohorts'][0].update(ready_count=False)),
                   ('task-ran',lambda v:v['jobs'][0].update(status='passed'))]
        for name,mutate in mutations:
            with self.subTest(name=name):
                try:
                    value=json.loads(summary_path.read_text());mutate(value);self.save(summary_path,value);self.reseal()
                    with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)
                finally:
                    for p,raw in originals.items():p.write_bytes(raw)
                    self.reseal()
        for path in [self.runs/'_hub/owned',self.campaign/'r001-j0001.log',
                     self.campaign/'cleanup-cohorts/c001/cleanup-budget/budget.json',
                     self.campaign/'cleanup-cohorts/c001/ready/member']:
            with self.subTest(path=path):
                path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}');self.reseal()
                try:
                    with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)
                finally:
                    path.unlink()
                    if path.parent==self.runs/'_hub':path.parent.rmdir()
                    self.reseal()
        broker=self.relay/'broker.private.log';broker.write_text('{"stopped": 1}');self.reseal()
        with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)

    def test_prepare_refuses_scope_pin_grant_live_role_and_publication(self):
        receipt,owner,proof=self.prepare_fixture()
        for key,value in [('purpose','isolated-validation'),('recovered_runtime',{'foreign':{}})]:
            with self.subTest(key=key):
                changed=copy.deepcopy(proof);changed[key]=value
                with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,changed)
        import deploy_test_native_prepare as prepare
        with patch.dict(prepare.REVIEWED_SOURCES,{'run-bench-campaign.py':'0'*64}):
            with self.assertRaisesRegex(ValueError,'producer changed'):self.validate_prepare_fixture(receipt,owner,proof)
        grant=self.base/'fixture-grant.json';grant.write_text('{}')
        try:
            with patch.object(prepare,'grant_path',return_value=grant),self.assertRaisesRegex(ValueError,'grant remains'):
                self.validate_prepare_fixture(receipt,owner,proof)
        finally:grant.unlink()
        capture_path=self.relay/'startup-agent.json';ready_path=self.relay/'ready.json'
        capture=json.loads(capture_path.read_text());ready=json.loads(ready_path.read_text())
        original_capture=copy.deepcopy(capture);original_ready=copy.deepcopy(ready)
        capture['agent'].update(pid=os.getpid(),birth=self.live_stamp(os.getpid()))
        ready['agent']=capture['agent'];self.save(capture_path,capture);self.save(ready_path,ready);self.reseal()
        try:
            with self.assertRaisesRegex(ValueError,'remains live'):self.validate_prepare_fixture(receipt,owner,proof)
        finally:
            self.save(capture_path,original_capture);self.save(ready_path,original_ready);self.reseal()
        self.published=False
        with self.assertRaisesRegex(ValueError,'terminal publication'):self.validate_prepare_fixture(receipt,owner,proof)


    def test_prepare_current_reviewed_pair_never_grants_credit(self):
        receipt,owner,proof=self.prepare_fixture('436576b7b05aa7421c597733c3df4f71f6f40eb7')
        before={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        entry=self.validate_prepare_fixture(receipt,owner,proof)
        self.assertEqual([],entry['participants']);self.assertEqual([],entry['retained_services'])
        self.assertEqual({},entry['native_audit_seals']);self.assertFalse(entry['credit_granted'])
        self.assertEqual(before,{p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()})

    def test_prepare_refuses_mixed_reviewed_pairs_and_any_altered_producer(self):
        receipt,owner,proof=self.prepare_fixture()
        names=('run-bench-campaign.py','cloudbench-cleanup-tickets.py','run-bench','deploy_test_cloud.py')
        heads=('abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077','436576b7b05aa7421c597733c3df4f71f6f40eb7')
        raw={head:{name:subprocess.check_output(['git','-C',str(ROOT),'show',head+':scripts/'+name])
                   for name in names} for head in heads}
        original={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        variants=[('old-campaign-new-tickets', {**raw[heads[0]],names[1]:raw[heads[1]][names[1]]}),
                  ('new-campaign-old-tickets', {**raw[heads[0]],names[0]:raw[heads[1]][names[0]]})]
        for head in heads:
            for name in names:
                variants.append((head[:5]+'-altered-'+name,{**raw[head],name:raw[head][name]+b'\n# changed producer\n'}))
        for label,producer in variants:
            with self.subTest(label=label):
                try:
                    for name,data in producer.items():(self.base/'scripts'/name).write_bytes(data)
                    self.reseal()
                    before={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
                    with self.assertRaisesRegex(ValueError,'producer changed'):
                        self.validate_prepare_fixture(receipt,owner,proof)
                    self.assertEqual(before,{p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()})
                finally:
                    for p,data in original.items():p.write_bytes(data)
                    self.reseal()


class RecoveredNativeReceiptGuard(unittest.TestCase):
    """Exercise actual full-pass admission on real files; never launch a worker."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        source = {'head': 'fixture', 'digest': 'fixture'}
        self.gate = {'name': 'api', 'command': ['native-fixture'], 'checks': ['case']}
        self.state = {'source': source, 'input_fingerprints': {'api': 'input'}, 'skips': {},
                      'environment': 'env', 'attempts': [], 'failures': []}
        self.request = {'token': 'original-token', 'source': source, 'gate': 'api', 'checks': ['case']}
        self.worker = {**self.request, 'cases': {'case': 'PASS'}, 'complete': True,
                       'cleanup_complete': True, 'reused': False}
        self.receipt = {**{k: self.request[k] for k in ('token', 'source', 'gate')},
            'status': 'PASS', 'complete': True, 'executed': True, 'native_exit': 0,
            'cancelled': False, 'timed_out': False, 'lingering_group': False,
            'cases': {'case': 'PASS'}, 'command': self.gate['command'],
            'log': str(self.folder / 'output.log'), 'worker_result': str(self.folder / 'result.json'),
            'execution_binding': {'input_fingerprint': 'input', 'contract_digest': c.digest(self.gate),
                                  'environment': 'env'}}
        c.write(self.folder / 'request.json', self.request)
        c.write(self.folder / 'result.json', self.worker)

    def tearDown(self): self.temp.cleanup()

    def admit(self, receipt):
        c.write(self.folder / 'receipt.json', receipt)
        self.state['attempts'] = [{'phase': 'final', 'source': self.state['source'], 'results': [receipt]}]
        return c.full_pass_binding(self.state, self.gate)

    def test_known_native_pass_is_still_admitted(self):
        self.assertIsNotNone(self.admit(self.receipt))

    def test_unknown_lifecycle_is_never_false(self):
        for field in ('cancelled', 'timed_out', 'lingering_group'):
            for value in ('MISSING', None, 0, ''):
                with self.subTest(field=field, value=value):
                    receipt = copy.deepcopy(self.receipt)
                    if value == 'MISSING': receipt.pop(field)
                    else: receipt[field] = value
                    self.assertIsNone(self.admit(receipt))

    def test_recovered_type_cannot_borrow_legacy_native_flags_for_pass(self):
        receipt = {**self.receipt, 'kind': 'recovered-native-execution-v1',
                   'original_coordinator': {'cancelled': 'UNKNOWN', 'timed_out': 'UNKNOWN'},
                   'native_evidence': {'cancelled': False, 'timed_out': False}}
        self.assertIsNone(self.admit(receipt))



class PendingSettlementJournalGuard(unittest.TestCase):
    def test_normal_coordinator_refuses_uncommitted_recovery_journal(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            c.write(root/'plan.json',{})
            c.write(root/'cycle.json',{'phase':'final','ready':False,'source':{},'round':30})
            c.write(root/'settlement-journal.json',{'kind':'native-settlement-journal-v1'})
            original=(root/'cycle.json').read_bytes()
            args=['status','--plan',str(root/'plan.json'),'--state-dir',str(root)]
            self.assertEqual(c.main(args),2)
            self.assertEqual((root/'cycle.json').read_bytes(),original)
            c.write(root/'settlement-committed.json',{'journal_sha256':'wrong'})
            self.assertEqual(c.main(args),2)
            self.assertEqual((root/'cycle.json').read_bytes(),original)
            c.write(root/'settlement-committed.json',{'journal_sha256':c.sha_file(root/'settlement-journal.json')})
            self.assertEqual(c.main(args),0)

@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
class LocalCleanupQuietScan(unittest.TestCase):
    """quiet(root) re-observes an unreadable same-user process instead of raising PermissionError."""

    def test_unreadable_same_user_process_is_reobserved_then_refused(self):
        import deploy_test_local_cleanup as local
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / '.context').mkdir()
            (root / '.context/native-worker-admission.lock').write_text('')
            # PR_SET_DUMPABLE=4: /proc/<pid> stays ours while cwd turns unreadable, as during a setuid exec.
            body = ("import ctypes,sys,time;ctypes.CDLL(None).prctl(4,0,0,0,0);print('ready',flush=True);"
                    "time.sleep(float(sys.argv[1]));ctypes.CDLL(None).prctl(4,1,0,0,0);time.sleep(30)")
            for hidden, refused in ((0.3, False), (60, True)):
                child = subprocess.Popen([sys.executable, '-c', body, str(hidden)], stdout=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                    if refused:
                        with self.assertRaisesRegex(ValueError, 'unverifiable'):
                            local.quiet(root)
                    else:
                        local.quiet(root)
                finally:
                    child.kill(); child.wait(); child.stdout.close()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc credential semantics')
    def test_setuid_process_first_seen_as_ours_is_skipped_not_refused(self):
        # The Blacksmith failure (PR #1760): a sibling suite's `sudo -n` was first seen while its euid
        # was still ours (pre-exec), then its cwd turned unreadable while its real uid stayed ours, and
        # quiet() refused it after the grace window. A real sudo is the fixture; only the first look at
        # /proc/<pid> is pinned to that pre-exec owner.
        import time
        import deploy_test_local_cleanup as local
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / '.context').mkdir()
            (root / '.context/native-worker-admission.lock').write_text('')
            child = subprocess.Popen(['sudo', '-n', 'sleep', '60'], cwd=root)
            proc_dir = Path(f'/proc/{child.pid}')

            def steady():
                # sudo runs the command: its real uid is ours and its euid root, with a root child.
                uids = (proc_dir / 'status').read_text().split('Uid:')[1].split()[:2]
                children = (proc_dir / 'task' / str(child.pid) / 'children').read_text().split()
                return uids == [str(os.getuid()), '0'] and bool(children)
            try:
                deadline = time.monotonic() + 10
                while not steady():
                    self.assertLess(time.monotonic(), deadline, 'sudo never ran its command as root')
                    time.sleep(0.05)
                with self.assertRaises(PermissionError):
                    (proc_dir / 'cwd').resolve(strict=True)
                real_stat, seen = Path.stat, []

                def first_look_ours(path, *args, **kwargs):
                    result = real_stat(path, *args, **kwargs)
                    if path != proc_dir or seen:
                        return result
                    seen.append(path)
                    return os.stat_result((result.st_mode, *result[1:4], os.geteuid(), *result[5:]))
                with patch.object(Path, 'stat', first_look_ours):
                    local.quiet(root)
                self.assertEqual(seen, [proc_dir])
            finally:
                deadline = time.monotonic() + 10
                while child.poll() is None:
                    try:
                        child.terminate()  # refused only while sudo briefly holds a root real uid
                    except PermissionError:
                        self.assertLess(time.monotonic(), deadline, 'sudo fixture could not be stopped')
                    time.sleep(0.05)


class BackendPrismaPreflightCleanup(unittest.TestCase):
    """Original guard refusal closes resources without changing failed results."""
    def setUp(self):
        import hashlib
        import deploy_test_backend_preflight_cleanup as b
        LocalCleanup.setUp(self)
        self.b = b
        self.gate['env'] = {'CONDUCTOR_WORKSPACE_NAME': 'fixture', 'CONDUCTOR_PORT': '12000',
                            'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1'}
        names = ['blackbox:browser-provider', 'units', 'fps', 'coverage-threshold', 'teardown']
        self.recipe.clear()
        self.recipe.update(cases={name: {'command': ['npm', 'run', 'test:coverage:sharded'],
                           'cwd': 'back-end', 'sweep': True, 'env': self.gate['env']} for name in names},
                           execution_timeout_seconds=14400)
        self.gate['checks'] = names
        self.request['checks'] = names
        self.result['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        self.result['cases'].update(units='FAIL', fps='FAIL', teardown='FAIL')
        self.result['recipe_digest'] = c.digest(self.recipe)
        self.result['native_command'] = ['npm', 'run', 'test:coverage:sharded']
        self.receipt['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.process['reaped'] = [{'pid': 124, 'status': 256}] + [{'pid': i, 'status': 0} for i in range(125, 135)]
        native = Path(self.result['runner_log']).parent
        coverage = self.worker / 'back-end/coverage'
        coverage.mkdir(parents=True)
        self.archive = self.root / 'archive'; self.archive.mkdir()
        self.proof.update(layout=b.LAYOUT, artifacts={})
        self.native = native
        self.evidence = self.result['evidence'] = {'artifacts': {'summaries': {}}, 'unknown_domains': []}
        def artifact(path, raw):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
            archived = self.archive / ('%02d-' % len(self.proof['artifacts']) + path.name)
            archived.write_bytes(raw); archived.chmod(0o600)
            row = {'path': str(archived), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            self.proof['artifacts'][str(path)] = row
            return row['sha256']
        self.artifact = artifact
        prefix = 'Using local Postgres (Docker container=victoria-db-fixture) at localhost:12005, database victoria_fixture'
        for role, filename, suffix in [('units', 'units.log', '_s0'), ('fps', 'units-probe.log', '_s0')]:
            path = coverage / filename
            h = artifact(path, (b.BROWSER+b.TRACE+prefix+suffix+'\n'+b.STALE).encode())
            self.evidence[role] = {'log': str(path), 'exit': 1}
            self.evidence['artifacts'][role+'_log'] = h
        self.evidence['shard_logs'] = {}
        for i in (1, 2):
            path = coverage / ('shard-%d.log' % i)
            self.evidence['shard_logs'][str(path)] = artifact(path, (b.BROWSER+b.TRACE+prefix+'_s%d\n'%i+b.STALE).encode())
        path = native / 'teardown.log'
        h = artifact(path, (b.TRACE+prefix+'\n'+b.STALE+'FAIL: the isolated backend never became ready\n').encode())
        self.evidence['teardown'] = {'log': str(path), 'exit': 1, 'recipe_cleanup_exit': None,
              'recipe_setup_exit': None, 'command': ['bash','scripts/tests/blackbox-backend-teardown.test.sh']}
        self.evidence['artifacts']['teardown_log'] = h
        path = native / 'threshold.log'
        self.evidence['coverage-threshold'] = {'log': str(path)}
        self.evidence['artifacts']['threshold_log'] = artifact(path, b'No coverage; threshold unverified\n')
        runner_rows = ['Started coverage shard 1/2', 'Started coverage shard 2/2', 'Started the unit pass beside the shards',
            '❌ Coverage shard 1/2 failed (exit 1)', '❌ Coverage shard 2/2 failed (exit 1)',
            '❌ Unit pass failed (exit 1)', '❌ fps probe pass failed (exit 1)']
        self.evidence['artifacts']['runner_log'] = artifact(Path(self.result['runner_log']), ('\n'.join(runner_rows)+'\n').encode())
        self.pg = {'id': 'c'*64, 'name': '/victoria-db-fixture', 'image': 'sha256:'+'d'*64,
            'image_name': 'pgvector/pgvector:pg16', 'owner': str(self.worker), 'running': True, 'status': 'running',
            'paused': False, 'restarting': False, 'dead': False,
            'ports': {'5432/tcp': [{'HostIp':'127.0.0.1','HostPort':'12005'}]},
            'mounts': [{'Type':'volume','Name':'victoria-pgdata-fixture','RW':True,'Destination':'/var/lib/postgresql/data'}]}
        hashes = [artifact(native / ('postgres-'+phase+'.json'), json.dumps(self.pg).encode()) for phase in ('before','after')]
        self.evidence['postgres_fixture'] = {'id': self.pg['id'], 'name': 'victoria-db-fixture', 'image': self.pg['image'],
              'volume':'victoria-pgdata-fixture', 'port':12005, 'restored':False,
              'before_sha256':hashes[0], 'after_sha256':hashes[1]}
        self.locks = []
        for port in (12020,12022,12024):
            path = self.worker / '.context/test-runs/.port-locks' / (str(port)+'.lock')
            artifact(path, b'999999999\n'); os.utime(path, (150,150)); self.locks.append(path)
        self.sync()
        self.original_bytes = {n:p.read_bytes() for n,p in self.paths.items()}
        # Historical source bytes are real; synthetic root has no Git repository.
        blobs = {name: subprocess.check_output(['git','--no-replace-objects','-C',str(ROOT),'show',
                    'abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077:'+name]) for name in b.PINS}
        self.addCleanup(patch.stopall)
        patch.object(b.subprocess, 'check_output', side_effect=lambda argv: blobs[argv[-1].split(':',1)[1]]).start()
        patch.object(b, 'docker_snapshot', side_effect=lambda machine: copy.deepcopy(self.pg)).start()
        patch.object(b, 'listeners', return_value={12005}).start()

    def sync(self):
        for name, value in zip(self.paths, [self.request,self.result,self.receipt,self.process]):
            c.write(self.paths[name], value)
        self.proof['files'] = {n:c.sha_file(p) for n,p in self.paths.items()}

    def reconcile(self):
        c.reconcile(self.state, 'occurrence', self.proof)

    def test_guard_refusal_closes_without_credit_or_rewriting(self):
        self.reconcile()
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.assertEqual(self.original_bytes, {n:p.read_bytes() for n,p in self.paths.items()})
        self.assertEqual('UNVERIFIED', self.failure['native_result'])
        self.assertFalse(self.result['cleanup_complete'])
        self.assertEqual([], c.retained_owners(self.state,[self.gate['name']]))

    def test_source_inventory_phase_and_supervisor_negatives(self):
        changes = [('process','orphaned_children',True), ('process','term_sent',[124]),
            ('process','reaped',self.process['reaped'][:-1]), ('process','reaped',[{'pid':124,'status':True}]+self.process['reaped'][1:]),
            ('result','complete',True), ('result','cleanup_complete',True), ('result','source_unchanged',False),
            ('result','native_exit',True), ('request','checks',['teardown'])]
        for owner,key,value in changes:
            with self.subTest(owner=owner,key=key):
                target = getattr(self,owner); old=target[key]; target[key]=value; self.sync()
                with self.assertRaises(ValueError): self.reconcile()
                target[key]=old; self.sync()
        old_head = self.source['head']; self.source['head'] = 'abc'; self.sync()
        with self.assertRaisesRegex(ValueError, 'full source'): self.reconcile()
        self.source['head'] = old_head; self.sync()
        with patch.object(self.b.subprocess,'check_output',return_value=b'changed historical source'):
            with self.assertRaises(ValueError): self.reconcile()
        for role in ('units', 'fps', 'teardown'):
            self.evidence[role]['exit'] = True; self.sync()
            with self.subTest(role=role), self.assertRaises(ValueError): self.reconcile()
            self.evidence[role]['exit'] = 1; self.sync()
        path = Path(self.evidence['units']['log']); row = self.proof['artifacts'][str(path)]
        raw = b'backend actually started\n'
        Path(row['path']).write_bytes(raw)
        import hashlib
        row.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
        self.evidence['artifacts']['units_log'] = row['sha256']; self.sync()
        with self.assertRaisesRegex(ValueError, 'guarded phase boundary'): self.reconcile()

    def test_current_app_fixture_lock_and_archive_negatives(self):
        for observer, value in [('listeners',{12005,12030}), ('docker_snapshot',{})]:
            with self.subTest(observer=observer), patch.object(self.b,observer,return_value=value):
                with self.assertRaises(ValueError): self.reconcile()
        import deploy_test_process
        fakeproc = self.root / 'fake-proc'; fakeproc.mkdir()
        (fakeproc / 'cwd').symlink_to(self.worker, target_is_directory=True)
        (fakeproc / 'cmdline').write_bytes(b'fixture\0')
        with patch.object(deploy_test_process, 'scan_same_user_processes',
                          side_effect=lambda inspect, unknown: inspect(fakeproc)):
            with self.assertRaisesRegex(ValueError, 'root still live'): self.reconcile()
        import fcntl
        for path in [self.worker/'.context/native-worker-admission.lock',self.locks[0]]:
            with path.open('r') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises((ValueError,OSError)): self.reconcile()
        self.locks[0].write_text(str(os.getpid())+'\n')
        with self.assertRaises(ValueError): self.reconcile()
        self.locks[0].write_bytes(b'999999999\n'); os.utime(self.locks[0],(150,150))
        row = self.proof['artifacts'].pop(str(self.locks[0]))
        with self.assertRaises(ValueError): self.reconcile()
        self.proof['artifacts'][str(self.locks[0])] = row
        Path(row['path']).chmod(0o666)
        with self.assertRaises(ValueError): self.reconcile()

class Round49NegativeLaunchAdmission(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.directory=Path(self.tmp.name);self.folder=self.directory/'attempts/49/triage/gate';self.folder.mkdir(parents=True)
        self.worker=self.directory/'worker';self.worker.mkdir()
        self.controller=self.directory/'deploy_test_cycle.py';self.controller.write_bytes(b'reviewed controller fixture\n');self.controller.chmod(0o700)
        self.controllerpatch=patch.object(c,'__file__',str(self.controller));self.controllerpatch.start();self.addCleanup(self.controllerpatch.stop)
        self.modules={}
        codes={'deploy_test_local_cleanup':"calls=[]\nrefuse=False\ndef quiet(root):\n    from deploy_test_process import scan_same_user_processes\n    calls.append(root)\n    if refuse: raise ValueError('live native root')\n    scan_same_user_processes(None, None)\n",
               'deploy_test_process':"def scan_same_user_processes(inspect, refuse):\n    return None\n",
               'deploy_test_result':"MAX_RECEIPT_BYTES=64*1024*1024\n",
               'deploy_test_cycle':"def bounded_read(path, label):\n    return {}\n"}
        for name, code in codes.items():
            file=self.controller if name=='deploy_test_cycle' else self.directory/(name+'.py');file.write_text(code);file.chmod(0o700 if name=='deploy_test_cycle' else 0o600)
            module=__import__('types').ModuleType(name);module.__file__=str(file)
            exec(compile(code,str(file),'exec'),module.__dict__);self.modules[name]=module
        self.modulepatch=patch.dict(__import__('sys').modules,self.modules);self.modulepatch.start();self.addCleanup(self.modulepatch.stop)
        self.native={'head':'0f23','digest':'native'};self.operator={'head':'reviewed-guard','digest':'operator'}
        self.gate={'name':'gate','worker_root':str(self.worker),'checks':['active','qualified'],
                   'worker_recipe':{'cases':{'active':{'command':['fixture']},'qualified':{'command':['qualified']}}}}
        self.request={'source':self.native,'gate':'gate','token':'original','worker_root':str(self.worker),
                      'worker_recipe':self.gate['worker_recipe'],'checks':['active'],'skips':{'qualified':{'source':self.native}}}
        self.request_path=self.folder/'request.json';self.put(self.request_path,self.request)
        self.process={'quiescent':True,'remaining':[],'orphaned_children':False,'error':None,
                      'cancelled':False,'timed_out':False,'term_sent':[],'kill_sent':[],'supervisor_pid':987654320,'child_pid':987654321}
        self.process_path=self.folder/'output.log.process.json';self.put(self.process_path,self.process)
        self.row={'kind':'recovered-native-execution-v1','gate':'gate','source':self.native,'token':'original',
                  'status':'FAIL','complete':False,'cancelled':'UNKNOWN','timed_out':'UNKNOWN',
                  'cases':{'active':'UNVERIFIED','qualified':'SKIP'}}
        self.after={'source':self.native,'plan':{'gates':[self.gate]},'attempts':[{'results':[self.row]}]}
        self.state=copy.deepcopy(self.after);self.state['source']=self.operator
        self.proposal={'round':49,'positive_credit':False,'source':self.native,'after_state':self.after,
                       'original_missing_outer_paths':[str(self.folder/'receipt.json')],
                       'input_artifacts':{str(p):self.sha(p)for p in [self.request_path,self.process_path]}}
        self.proposal_path=self.directory/'proposal.json';self.authorization_path=self.directory/'authorization.json'
        self.journal_path=self.directory/'settlement-round49-journal.json';self.marker_path=self.directory/'settlement-round49-committed.json'
        self.reseal()


    def put(self,p,obj):p.write_text(json.dumps(obj,sort_keys=True,indent=2)+'\n');p.chmod(0o600)
    def sha(self,p):
        import hashlib
        return hashlib.sha256(p.read_bytes()).hexdigest()
    def reseal(self):
        self.put(self.proposal_path,self.proposal)
        aftersha=__import__('hashlib').sha256((json.dumps(self.after,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()).hexdigest()
        auth={'native_source':self.native,'operator_source':self.operator,'operator_files':{'scripts/deploy_test_cycle.py':{'sha256':self.sha(self.controller),'mode':0o100100}, **{'scripts/'+name+'.py':{'sha256':self.sha(Path(module.__file__)),'mode':0o100100 if name=='deploy_test_cycle' else 0o100000}for name,module in self.modules.items()}},'proposal_sha256':self.sha(self.proposal_path),'after_state_sha256':aftersha}
        self.put(self.authorization_path,auth)
        self.put(self.journal_path,{'kind':'native-settlement-journal-v1','round':49,'positive_credit':False,
                 'native_source':self.native,'operator_source':self.operator,'proposal_path':str(self.proposal_path),
                 'authorization_path':str(self.authorization_path),'proposal_sha256':self.sha(self.proposal_path),
                 'authorization_sha256':self.sha(self.authorization_path),'after_state_sha256':aftersha})
        self.put(self.marker_path,{'journal_sha256':self.sha(self.journal_path)})
    def admit(self):return c.settled_round49_missing_request(self.state,self.directory,self.gate,self.request_path)

    def test_exact_negative_settlement_allows_launch_only_and_preserves_bytes(self):
        before={p:p.read_bytes()for p in self.directory.rglob('*')if p.is_file()};state=copy.deepcopy(self.state)
        self.assertTrue(self.admit());self.assertEqual(self.state,state)
        self.assertEqual(before,{p:p.read_bytes()for p in self.directory.rglob('*')if p.is_file()})
        self.assertFalse((self.folder/'receipt.json').exists());self.assertEqual(self.modules['deploy_test_local_cleanup'].calls,[self.worker])
        self.assertEqual(self.row['cases'],{'active':'UNVERIFIED','qualified':'SKIP'})

    def test_uncommitted_or_wrong_marker_refuses(self):
        self.marker_path.unlink()
        with self.assertRaises((ValueError,FileNotFoundError)):self.admit()
        self.put(self.marker_path,{'journal_sha256':'wrong'})
        with self.assertRaises(ValueError):self.admit()

    def test_row_source_recipe_contract_and_artifact_tamper_refuse(self):
        baseline=copy.deepcopy(self.state)
        for change in [lambda:self.state['attempts'][0]['results'][0].update(cancelled=False),
                       lambda:self.state['attempts'][0]['results'][0].update(source={'head':'wrong-native','digest':'wrong-native'}),
                       lambda:self.state['attempts'][0]['results'][0].update(cases={'active':'PASS','qualified':'SKIP'})]:
            self.state=copy.deepcopy(baseline);change()
            with self.assertRaises(ValueError):self.admit()
        self.state=copy.deepcopy(baseline)
        original=copy.deepcopy(self.gate)
        for change in [lambda:self.gate.update(checks=['different']),
                       lambda:self.gate['worker_recipe']['cases']['active'].update(command=['wrong'])]:
            self.gate=copy.deepcopy(original);change()
            with self.assertRaises(ValueError):self.admit()
        self.gate=original;self.request_path.write_bytes(self.request_path.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.admit()

    def test_later_fixture_or_ledger_head_keeps_cleanup_eligibility(self):
        self.state['source']={'head':'later-app-fixture-or-ledger','digest':'new-full-source'}
        self.assertTrue(self.admit())
        self.assertEqual(self.row['cases']['active'],'UNVERIFIED')

    def test_controller_bytes_mode_or_gate_environment_drift_refuse(self):
        before=self.controller.read_bytes()
        self.controller.write_bytes(before+b'# unreviewed\n')
        with self.assertRaisesRegex(ValueError,'controller bytes/mode'):self.admit()
        self.controller.write_bytes(before);self.controller.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'controller bytes/mode'):self.admit()
        self.controller.chmod(0o700);self.gate['env']={'CHANGED':'1'}
        with self.assertRaisesRegex(ValueError,'contract/recipe'):self.admit()

    def test_cleanup_process_and_result_dependency_bytes_modes_refuse(self):
        for name in ['deploy_test_local_cleanup','deploy_test_process','deploy_test_result']:
            with self.subTest(module=name):
                file=Path(self.modules[name].__file__);before=file.read_bytes()
                file.write_bytes(before+b'# changed dependency\n')
                with self.assertRaisesRegex(ValueError,'dependency bytes/mode'):self.admit()
                file.write_bytes(before);file.chmod(0o700)
                with self.assertRaisesRegex(ValueError,'dependency bytes/mode'):self.admit()
                file.chmod(0o600)

    def test_callable_replaced_outside_pinned_module_refuses(self):
        module=self.modules['deploy_test_process'];before=module.scan_same_user_processes
        module.scan_same_user_processes=lambda *args:None
        with self.assertRaisesRegex(ValueError,'not owned by pinned module'):self.admit()
        module.scan_same_user_processes=before
        module=self.modules['deploy_test_local_cleanup'];module.quiet=lambda *args:None
        with self.assertRaisesRegex(ValueError,'not owned by pinned module'):self.admit()

    def test_live_or_nonquiet_native_root_refuses(self):
        self.modules['deploy_test_local_cleanup'].refuse=True
        with self.assertRaises(ValueError):self.admit()
        self.modules['deploy_test_local_cleanup'].refuse=False
        self.process['supervisor_pid']=__import__('os').getpid();self.put(self.process_path,self.process)
        self.proposal['input_artifacts'][str(self.process_path)]=self.sha(self.process_path);self.reseal()
        with self.assertRaises(ValueError):self.admit()

    def test_unrelated_missing_path_or_fake_original_receipt_refuses(self):
        wrong=self.directory/'attempts/50/triage/gate/request.json'
        with self.assertRaises(ValueError):c.settled_round49_missing_request(self.state,self.directory,self.gate,wrong)
        self.put(self.folder/'receipt.json',{})
        with self.assertRaises(ValueError):self.admit()



class StrictRoundSettlementJournal(unittest.TestCase):
    def test_float_and_boolean_rounds_with_matching_marker_refuse(self):
        for name, value in [('49', 49.0), ('1', True)]:
            with self.subTest(name=name, value=value), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                c.write(directory / 'plan.json', {})
                c.write(directory / 'cycle.json', {'phase':'triage', 'ready':False, 'source':{}, 'pending':[]})
                journal = directory / ('settlement-round' + name + '-journal.json')
                c.write(journal, {'round':value})
                c.write(directory / ('settlement-round' + name + '-committed.json'), {'journal_sha256':c.sha_file(journal)})
                before = (directory / 'cycle.json').read_bytes()
                self.assertEqual(c.main(['status', '--plan', str(directory / 'plan.json'), '--state-dir', str(directory)]), 2)
                self.assertEqual(before, (directory / 'cycle.json').read_bytes())



class Round49RetirementFailClosed(Round49NegativeLaunchAdmission):
    def test_malformed_present_retirement_cannot_use_legacy_fallback(self):
        self.state['historical_launch_retirements'] = {str(self.request_path): {'kind': 'wrong'}}
        with self.assertRaisesRegex(ValueError, 'malformed present certificate'):
            self.admit()

    def test_no_certificate_preserves_original_legacy_behavior(self):
        self.assertTrue(self.admit())

    def test_unknown_missing_request_is_not_retired(self):
        self.state['historical_launch_retirements'] = {str(self.request_path): {'kind': 'wrong'}}
        with self.assertRaises(ValueError):
            c.settled_round49_missing_request(self.state, self.directory, self.gate,
                self.directory / 'attempts/50/triage/gate/request.json')

    def test_native_wait_bool_and_float_are_rejected(self):
        from deploy_test_round49_retirement import terminal
        process = dict(self.process, native_exit=1, reaped=[{'pid': self.process['child_pid'], 'status': 256}])
        terminal(process)
        for key, value in [('native_exit', True), ('native_exit', 1.0), ('child_pid', True), ('child_pid', 2.0)]:
            changed = copy.deepcopy(process)
            changed[key] = value
            with self.assertRaises(ValueError): terminal(changed)
        for field, value in [('pid', True), ('pid', 2.0), ('status', True), ('status', 256.0)]:
            changed = copy.deepcopy(process)
            changed['reaped'][0][field] = value
            with self.assertRaises(ValueError): terminal(changed)

    def test_native_closure_requires_no_signals_or_owners(self):
        from deploy_test_round49_retirement import terminal
        process = dict(self.process, native_exit=1, reaped=[{'pid': self.process['child_pid'], 'status': 256}])
        for key, value in [('quiescent', False), ('orphaned_children', True), ('remaining', [2]),
                           ('term_sent', [2]), ('kill_sent', [2]), ('cancelled', True), ('timed_out', True)]:
            changed = copy.deepcopy(process); changed[key] = value
            with self.assertRaises(ValueError): terminal(changed)


class Round49RetirementCertificates(unittest.TestCase):
    """Synthetic immutable source objects and native receipts; no native worker runs."""
    def setUp(self):
        import deploy_test_round49_retirement as retirement
        self.r = retirement
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.directory = self.repo / '.context/cycle'
        self.directory.mkdir(parents=True)
        self.native = {'head': '1' * 40, 'digest': 'a' * 64}
        self.operator = {'head': '2' * 40, 'digest': 'b' * 64}
        self.later = {'head': '3' * 40, 'digest': 'c' * 64}
        self.objects = {p: (p + '\n').encode() for p in set(self.r.OBSERVERS + self.r.PRODUCERS)}
        self.object_rows = {p: {'sha256': __import__('hashlib').sha256(v).hexdigest(), 'mode': 0o100000}
                            for p, v in self.objects.items()}
        self.git_calls = []
        self.object_overrides = {}
        def git(argv, **kwargs):
            self.git_calls.append(argv)
            args = argv[4:]
            if args[0] == 'show':
                head, path = args[1].split(':', 1)
                return self.object_overrides.get((head, path), self.objects[path])
            if args[0] == 'ls-tree':
                paths = args[args.index('--') + 1:]
                return ''.join('100644 blob ' + 'f' * 40 + '\t' + p + '\n' for p in paths).encode()
            raise AssertionError('unexpected external command')
        self.git_patch = patch.object(self.r.subprocess, 'check_output', side_effect=git)
        self.git_patch.start(); self.addCleanup(self.git_patch.stop)
        import deploy_test_process
        def scan(inspect, refuse):
            # The observer executes while the one exact admission fd remains locked.
            if inspect is not None:
                import fcntl
                lock = self.active_root / '.context/native-worker-admission.lock'
                with lock.open('r') as other:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.scan_patch = patch.object(deploy_test_process, 'scan_same_user_processes', side_effect=scan)
        self.scan_patch.start(); self.addCleanup(self.scan_patch.stop)
        self.gates = []
        self.old_rows = []
        self.later_rows = []
        self.proofs = {}
        self.seals = {}
        self.process = {'supervisor_pid': 900001, 'child_pid': 900002, 'native_exit': 1,
                        'quiescent': True, 'error': None, 'orphaned_children': False,
                        'cancelled': False, 'timed_out': False, 'remaining': [], 'term_sent': [], 'kill_sent': [],
                        'reaped': [{'pid': 900002, 'status': 256}, {'pid': 900003, 'status': 0}]}
        for name in sorted(self.r.GATES):
            worker = self.repo / 'workers' / name
            (worker / '.context').mkdir(parents=True)
            (worker / '.context/native-worker-admission.lock').write_text('')
            recipe = {'cases': {'active': {'command': ['fixture']}, 'qualified': {'command': ['qualified']}}}
            gate = {'name': name, 'worker_root': str(worker), 'cwd': str(worker),
                    'command': ['/usr/bin/python3', str(worker / 'scripts/deploy_test_worker.py'), '--root', str(worker)],
                    'worker_recipe': recipe, 'checks': ['active', 'qualified']}
            self.gates.append(gate)
            old = self.directory / 'attempts/49/triage' / name
            later = self.directory / 'attempts/53/triage' / name
            old.mkdir(parents=True); later.mkdir(parents=True)
            for folder, source, token in [(old, self.native, 'old-' + name), (later, self.later, 'later-' + name)]:
                request = {'token': token, 'gate': name, 'source': source, 'worker_root': str(worker),
                           'worker_recipe': recipe, 'checks': ['active'], 'skips': {'qualified': {'source': source}}, 'phase': 'triage'}
                result = {'token': token, 'gate': name, 'source': source, 'worker_root': str(worker),
                          'cases': {'active': 'FAIL'}, 'complete': True, 'cleanup_complete': True,
                          'reused': False, 'recipe_digest': self.r.contract_digest(recipe)}
                self.put(folder / 'request.json', request); self.put(folder / 'result.json', result)
                self.put(folder / 'output.log.process.json', self.process)
            row = {'kind': 'recovered-native-execution-v1', 'gate': name, 'source': self.native,
                   'token': 'old-' + name, 'status': 'FAIL', 'complete': False,
                   'cancelled': 'UNKNOWN', 'timed_out': 'UNKNOWN', 'recovered_at': 10,
                   'cases': {'active': 'UNVERIFIED', 'qualified': 'SKIP'}}
            self.old_rows.append(row)
            receipt = {'gate': name, 'source': self.later, 'token': 'later-' + name, 'status': 'FAIL',
                       'complete': True, 'executed': True, 'native_exit': 1, 'lifecycle': 'owned',
                       'command': gate['command'], 'log': str(later / 'output.log'),
                       'worker_result': str(later / 'result.json'), 'cases': {'active': 'FAIL', 'qualified': 'SKIP'},
                       'cancelled': False, 'timed_out': False, 'lingering_group': False, 'finished_at': 20,
                       'execution_binding': {'contract_digest': self.r.contract_digest(gate),
                                             'input_fingerprint': 'd' * 64, 'environment': 'e' * 64},
                       'host_admission': {'started': True, 'lock': str(worker / '.context/native-worker-admission.lock')}}
            self.put(later / 'receipt.json', receipt); self.later_rows.append(receipt)
            self.proofs[name] = {'kind': self.r.KIND, 'gate': name, 'old_request': str(old / 'request.json'),
                                 'later_request': str(later / 'request.json'), 'confirmed_at': 30, 'observed_by': 'independent fixture',
                                 'files': {n: self.r.sha(later / n) for n in self.r.NAMES}}
            for n in ('request.json', 'result.json', 'output.log.process.json'):
                self.seals[str(old / n)] = self.r.sha(old / n)
        self.after = {'source': self.native, 'plan': {'gates': self.gates}, 'attempts': [{'results': self.old_rows}]}
        self.state = copy.deepcopy(self.after)
        self.state.update(source=self.later, phase='triage', ready=False, pending=['preserved'])
        self.state['attempts'].append({'source': self.later, 'results': self.later_rows})
        for index in range(45):
            file = self.directory / ('sealed-extra-' + str(index))
            file.write_text('immutable ' + str(index)); self.seals[str(file)] = self.r.sha(file)
        self.seals[str(self.directory / 'cycle.json')] = '0' * 64
        self.proposal = {'source': self.native, 'round': 49, 'positive_credit': False, 'after_state': self.after,
                         'before_state_sha256': '0' * 64, 'native_files': self.object_rows,
                         'original_missing_outer_paths': [str(Path(p['old_request']).parent / 'receipt.json') for p in self.proofs.values()],
                         'input_artifacts': self.seals}
        self.reseal()
        self.gate = next(g for g in self.gates if g['name'] == 'backend-coverage-blackbox')
        self.proof = self.proofs[self.gate['name']]
        self.active_root = Path(self.gate['worker_root'])

    def put(self, path, value):
        path.write_bytes(self.r.encoded(value)); path.chmod(0o600)

    def reseal(self):
        proposal = self.directory / 'proposal.json'; auth = self.directory / 'authorization.json'
        self.put(proposal, self.proposal)
        self.put(auth, {'native_source': self.native, 'operator_source': self.operator,
                        'operator_files': self.object_rows, 'proposal_sha256': self.r.sha(proposal),
                        'after_state_sha256': self.r.digest(self.after)})
        journal = self.directory / 'settlement-round49-journal.json'
        self.put(journal, {'kind': 'native-settlement-journal-v1', 'round': 49, 'positive_credit': False,
                           'native_source': self.native, 'operator_source': self.operator,
                           'proposal_path': str(proposal), 'authorization_path': str(auth),
                           'proposal_sha256': self.r.sha(proposal), 'authorization_sha256': self.r.sha(auth),
                           'after_state_sha256': self.r.digest(self.after), 'before_state_sha256': '0' * 64})
        self.put(self.directory / 'settlement-round49-committed.json', {'journal_sha256': self.r.sha(journal)})

    def issue(self, proof=None, persist=None):
        proof = self.proof if proof is None else proof
        self.active_root = Path(next(g for g in self.gates if g['name'] == proof['gate'])['worker_root'])
        c.reconcile(self.state, 'old-' + proof['gate'], proof, persist=persist)

    def test_native_failed_later_receipt_retires_only_old_debt_and_is_idempotent(self):
        before = {p: p.read_bytes() for p in self.directory.rglob('*') if p.is_file()}
        original = copy.deepcopy(self.state)
        self.issue()
        cert = self.state['historical_launch_retirements'][self.proof['old_request']]
        self.assertIs(cert['credit_granted'], False)
        self.assertTrue(c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request'])))
        self.issue(); self.assertEqual(cert, self.state['historical_launch_retirements'][self.proof['old_request']])
        self.assertEqual(original['attempts'], self.state['attempts'])
        self.assertEqual(before, {p: p.read_bytes() for p in self.directory.rglob('*') if p.is_file()})
        self.assertTrue(all(not Path(v).exists() for v in self.proposal['original_missing_outer_paths']))
        self.assertTrue(any(argv[4] == 'show' for argv in self.git_calls))

    def test_normal_cli_persists_certificate_atomically_under_admission_lock(self):
        import fcntl
        self.put(self.directory / 'cycle.json', self.state)
        self.put(self.directory / 'plan.json', self.state['plan'])
        proof = self.directory / 'retire.json'; self.put(proof, self.proof)
        original_write = c.write
        def write(path, value):
            if path == self.directory / 'cycle.json' and value.get('historical_launch_retirements'):
                # The first certificate publication must happen under admission; later identical final write is harmless.
                if not hasattr(write, 'seen'):
                    with (self.active_root / '.context/native-worker-admission.lock').open('r') as other:
                        with self.assertRaises(BlockingIOError): fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    write.seen = True
            original_write(path, value)
        with patch.object(c, 'write', side_effect=write):
            result = c.main(['reconcile', '--plan', str(self.directory / 'plan.json'), '--state-dir', str(self.directory),
                             '--occurrence', 'old-' + self.gate['name'], '--proof', str(proof)])
        self.assertEqual(result, 0)
        self.assertIn(self.proof['old_request'], json.loads((self.directory / 'cycle.json').read_text())['historical_launch_retirements'])

    def test_every_original_seal_is_required(self):
        for name in self.seals:
            if Path(name).name == 'cycle.json': continue
            path = Path(name); before = path.read_bytes(); path.write_bytes(before + b'changed')
            with self.assertRaises(ValueError): self.issue()
            path.write_bytes(before)
        self.assertNotIn('historical_launch_retirements', self.state)

    def test_original_unknown_flags_and_six_missing_paths_remain_required(self):
        for flag in ('cancelled', 'timed_out'):
            self.old_rows[0][flag] = False; self.reseal()
            with self.assertRaises(ValueError): self.issue()
            self.old_rows[0][flag] = 'UNKNOWN'
        self.reseal()
        path = Path(self.proposal['original_missing_outer_paths'][0]); self.put(path, {})
        with self.assertRaises(ValueError): self.issue()
        path.unlink()

    def test_witness_cleanup_false_or_nonbool_cannot_retire(self):
        path = Path(self.proof['later_request']).parent / 'result.json'
        result = json.loads(path.read_text())
        for value in (False, 1, 1.0, None):
            changed = {**result, 'cleanup_complete': value}; self.put(path, changed)
            self.proof['files']['result.json'] = self.r.sha(path)
            with self.assertRaises(ValueError): self.issue()
        self.put(path, result)

    def test_unrecorded_reused_recovered_and_carried_witnesses_refuse(self):
        row = self.state['attempts'][1]['results'].pop()
        # Remove this gate's row explicitly, independent of sorted position.
        rows = self.state['attempts'][1]['results']; rows.append(row)
        match = next(v for v in rows if v['gate'] == self.gate['name']); rows.remove(match)
        with self.assertRaises(ValueError): self.issue()
        rows.append(match)
        folder = Path(self.proof['later_request']).parent
        for key, value in [('kind', 'recovered-native-execution-v1'), ('executed', False), ('lifecycle', 'carried')]:
            changed = {**match, key: value}; self.put(folder / 'receipt.json', changed)
            self.proof['files']['receipt.json'] = self.r.sha(folder / 'receipt.json')
            rows[rows.index(match)] = changed
            with self.assertRaises(ValueError): self.issue()
            rows[rows.index(changed)] = match
        result = json.loads((folder / 'result.json').read_text()); result['reused'] = True
        self.put(folder / 'result.json', result); self.proof['files']['result.json'] = self.r.sha(folder / 'result.json')
        with self.assertRaises(ValueError): self.issue()

    def test_wrong_order_source_token_root_recipe_and_bytes_refuse(self):
        original = copy.deepcopy(self.state)
        self.state['attempts'].reverse()
        with self.assertRaises(ValueError): self.issue()
        self.state = original
        folder = Path(self.proof['later_request']).parent
        request = json.loads((folder / 'request.json').read_text())
        for key, value in [('source', self.native), ('token', 'wrong'), ('worker_root', '/foreign'), ('worker_recipe', {})]:
            self.put(folder / 'request.json', {**request, key: value})
            self.proof['files']['request.json'] = self.r.sha(folder / 'request.json')
            with self.assertRaises(ValueError): self.issue()
        self.put(folder / 'request.json', request)
        self.proof['files']['request.json'] = 'f' * 64
        with self.assertRaises(ValueError): self.issue()

    def test_float_bool_round_and_observation_fields_refuse(self):
        for value in (True, 49.0):
            self.proposal['round'] = value; self.reseal()
            with self.assertRaises(ValueError): self.issue()
        self.proposal['round'] = 49; self.reseal()
        for value in (True, float('nan'), float('inf'), -1):
            proof = copy.deepcopy(self.proof); proof['confirmed_at'] = value
            with self.assertRaises(ValueError): self.issue(proof)

    def test_root_or_lock_replacement_invalidates_certificate(self):
        self.issue()
        lock = self.active_root / '.context/native-worker-admission.lock'
        lock.rename(lock.with_name('retired-lock')); lock.write_text('')
        with self.assertRaisesRegex(ValueError, 'root replaced'):
            c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request']))

    def test_new_unknown_missing_path_never_uses_old_certificate(self):
        self.issue()
        with self.assertRaises(ValueError):
            c.settled_round49_missing_request(self.state, self.directory, self.gate,
                self.directory / 'attempts/54/triage' / self.gate['name'] / 'request.json')

    def test_all_six_retirements_do_not_clear_current_backend55_cleanup_false(self):
        for proof in self.proofs.values(): self.issue(proof)
        folder = self.directory / 'attempts/55/triage' / self.gate['name']; folder.mkdir(parents=True)
        result = {'token': 'current55', 'gate': self.gate['name'], 'source': self.later, 'cleanup_complete': False}
        self.put(folder / 'result.json', result)
        row = {**result, 'complete': False, 'worker_result': str(folder / 'result.json')}
        self.state['attempts'].append({'results': [row]})
        with self.assertRaisesRegex(ValueError, 'cleanup state unknown'):
            c.retained_owners(self.state, [self.gate['name']])
        self.assertEqual(len(self.state['historical_launch_retirements']), 6)

    def test_failed_atomic_writer_rolls_back_certificate(self):
        original = copy.deepcopy(self.state)
        def fail(): raise OSError('synthetic failed write before replace')
        with self.assertRaises(OSError): self.issue(persist=fail)
        self.assertEqual(self.state, original)

    def test_later_producer_or_old_observer_object_drift_refuses(self):
        original = self.objects['scripts/deploy_test_worker.py']
        self.object_overrides[(self.later['head'], 'scripts/deploy_test_worker.py')] = b'changed producer'
        with self.assertRaises(ValueError): self.issue()
        self.object_overrides.clear()
        self.objects['scripts/deploy_test_cycle.py'] = b'changed historical observer'
        with self.assertRaises(ValueError): self.issue()

    def test_live_or_unverifiable_root_and_held_admission_refuse(self):
        import deploy_test_process, fcntl
        with patch.object(deploy_test_process, 'scan_same_user_processes', side_effect=ValueError('live root')):
            with self.assertRaises(ValueError): self.issue()
        with (self.active_root / '.context/native-worker-admission.lock').open('r') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.issue()


    def test_current_root_replacement_invalidates_certificate(self):
        self.issue()
        worker = self.active_root
        worker.rename(worker.with_name(worker.name + '-old'))
        (worker / '.context').mkdir(parents=True)
        (worker / '.context/native-worker-admission.lock').write_text('')
        with self.assertRaisesRegex(ValueError, 'root replaced'):
            c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request']))

    def test_certificate_has_real_issuance_time_and_changed_input_is_not_idempotent(self):
        import time
        before = time.time(); self.issue(); after = time.time()
        cert = self.state['historical_launch_retirements'][self.proof['old_request']]
        self.assertLessEqual(before, cert['issued_at']); self.assertLessEqual(cert['issued_at'], after)
        changed = copy.deepcopy(self.proof); changed['observed_by'] = 'different observer'
        with self.assertRaises(ValueError): self.issue(changed)
        cert['issued_at'] = True
        with self.assertRaises(ValueError):
            c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request']))

    def test_duplicate_original_token_and_changed_row_refuse(self):
        extra = copy.deepcopy(self.state['attempts'][0]['results'][0]); extra['cancelled'] = False
        self.state['attempts'][0]['results'].append(extra)
        with self.assertRaises(ValueError): self.issue()

    def test_crash_after_atomic_replace_keeps_only_valid_certificate(self):
        path = self.directory / 'cycle.json'
        def committed_then_crashed():
            c.write(path, self.state)
            raise OSError('synthetic failure after atomic replace')
        with self.assertRaises(OSError): self.issue(persist=committed_then_crashed)
        persisted = json.loads(path.read_text())
        self.assertTrue(c.settled_round49_missing_request(persisted, self.directory, self.gate, Path(self.proof['old_request'])))
        self.assertEqual(persisted['attempts'], self.state['attempts'])

    def test_current_source_guard_still_refuses_with_retirement(self):
        self.issue()
        plan = self.state['plan']
        with patch.object(c, 'source', return_value=self.native):
            with self.assertRaisesRegex(ValueError, 'source/plan changed'):
                c.run_phase(plan, self.state, self.directory, self.repo, independent=True)


    def test_original_cycle_anchor_marker_observer_modes_and_physical_closure_refuse(self):
        journal_path = self.directory / 'settlement-round49-journal.json'
        journal = json.loads(journal_path.read_text())
        self.proposal['before_state_sha256'] = 'f' * 64; self.reseal()
        with self.assertRaises(ValueError): self.issue()
        self.proposal['before_state_sha256'] = '0' * 64; self.reseal()
        self.put(self.directory / 'settlement-round49-committed.json', {'journal_sha256': 'f' * 64})
        with self.assertRaises(ValueError): self.issue()
        self.reseal()
        before = self.object_rows['scripts/deploy_test_cycle.py']['mode']
        for mode in (True, float(before), before | 0o100):
            self.object_rows['scripts/deploy_test_cycle.py']['mode'] = mode; self.reseal()
            with self.assertRaises(ValueError): self.issue()
        self.object_rows['scripts/deploy_test_cycle.py']['mode'] = before; self.reseal()
        old = Path(self.proof['old_request']).parent / 'result.json'
        native = json.loads(old.read_text()); native['cleanup_complete'] = False; self.put(old, native)
        self.proposal['input_artifacts'][str(old)] = self.r.sha(old); self.reseal()
        with self.assertRaises(ValueError): self.issue()

    def test_later_flags_wait_identity_qualified_skips_and_footprint_refuse(self):
        folder = Path(self.proof['later_request']).parent
        process = json.loads((folder / 'output.log.process.json').read_text())
        for key, value in [('native_exit', True), ('native_exit', 1.0), ('quiescent', 1),
                           ('cancelled', True), ('term_sent', [2]), ('reaped', []), ('child_pid', True)]:
            self.put(folder / 'output.log.process.json', {**process, key: value})
            self.proof['files']['output.log.process.json'] = self.r.sha(folder / 'output.log.process.json')
            with self.assertRaises(ValueError): self.issue()
        self.put(folder / 'output.log.process.json', process)
        self.proof['files']['output.log.process.json'] = self.r.sha(folder / 'output.log.process.json')
        request = json.loads((folder / 'request.json').read_text()); request['skips']['qualified']['source'] = self.native
        self.put(folder / 'request.json', request); self.proof['files']['request.json'] = self.r.sha(folder / 'request.json')
        with self.assertRaises(ValueError): self.issue()
        original = copy.deepcopy(self.gate); self.gate['worker_recipe'] = {}
        with self.assertRaises(ValueError): self.issue()
        self.gate.update(original)

    def test_changed_recorded_witness_hash_and_malformed_certificate_never_fallback(self):
        self.issue()
        folder = Path(self.proof['later_request']).parent
        path = folder / 'receipt.json'; before = path.read_bytes(); path.write_bytes(before + b' ')
        with self.assertRaises(ValueError):
            c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request']))
        path.write_bytes(before)
        self.state['historical_launch_retirements'][self.proof['old_request']]['credit_granted'] = 0
        with self.assertRaises(ValueError):
            c.settled_round49_missing_request(self.state, self.directory, self.gate, Path(self.proof['old_request']))


    def test_nonprimary_stopped_or_continued_wait_is_not_terminal_closure(self):
        process = copy.deepcopy(self.process)
        for status in (127, (19 << 8) | 127, 65535):
            process['reaped'][1]['status'] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.r.terminal(process)
        for status in (0, 256, 9, 15):
            process['reaped'][1]['status'] = status
            self.r.terminal(process)
        self.assertEqual(process['reaped'][0], {'pid': 900002, 'status': 256})



    def test_committed_retirement_survives_current_selection_refresh(self):
        self.issue()
        certificate = copy.deepcopy(self.state['historical_launch_retirements'])
        current = copy.deepcopy(self.gate); current['selection_evidence'] = ['new current source selection']
        self.state['plan'] = copy.deepcopy(self.state['plan'])
        self.state['plan']['gates'] = [current if g['name'] == current['name'] else g for g in self.state['plan']['gates']]
        self.assertTrue(c.settled_round49_missing_request(self.state, self.directory, current, Path(self.proof['old_request'])))
        self.assertEqual(certificate, self.state['historical_launch_retirements'])

    def test_committed_retirement_survives_added_current_backend_inventory_without_credit(self):
        self.issue()
        current = copy.deepcopy(self.gate)
        current['checks'].append('new-main-domain')
        current['worker_recipe']['cases']['new-main-domain'] = {'command': ['new-domain-command']}
        current['selection_evidence'] = ['refreshed backend inventory']
        self.state['plan'] = copy.deepcopy(self.state['plan'])
        self.state['plan']['gates'] = [current if g['name'] == current['name'] else g for g in self.state['plan']['gates']]
        before = copy.deepcopy(self.state)
        self.assertTrue(c.settled_round49_missing_request(self.state, self.directory, current, Path(self.proof['old_request'])))
        self.assertEqual(before, self.state)
        self.assertFalse(c.reusable_full_pass(self.state, current))
        with self.assertRaisesRegex(ValueError, 'same logical root and exact footprint'):
            self.issue()

    def test_changed_current_contract_without_certificate_cannot_issue_or_recognize(self):
        current = copy.deepcopy(self.gate); current['selection_evidence'] = ['new selection']
        self.state['plan'] = copy.deepcopy(self.state['plan'])
        self.state['plan']['gates'] = [current if g['name'] == current['name'] else g for g in self.state['plan']['gates']]
        self.assertFalse(self.r.recognized(self.state, self.directory, current, Path(self.proof['old_request'])))
        with self.assertRaisesRegex(ValueError, 'same logical root and exact footprint'):
            self.issue()
        self.assertNotIn('historical_launch_retirements', self.state)

    def test_refreshed_retirement_still_refuses_foreign_root_admission_and_bad_native_proof(self):
        self.issue()
        current = copy.deepcopy(self.gate); current['selection_evidence'] = ['new selection']
        for field, value in [('worker_root', str(self.repo / 'new-root')), ('cwd', '/foreign'),
                             ('worker_transport', 'foreign-transport'), ('result_transport', 'foreign-transport')]:
            changed = {**current, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.r.recognized(self.state, self.directory, changed, Path(self.proof['old_request']))
        certificate = self.state['historical_launch_retirements'][self.proof['old_request']]
        original = copy.deepcopy(certificate)
        for field, value in [('kind', 'wrong'), ('issued_at', True), ('credit_granted', 0)]:
            certificate[field] = value
            with self.subTest(certificate=field), self.assertRaises(ValueError):
                self.r.recognized(self.state, self.directory, current, Path(self.proof['old_request']))
            certificate.clear(); certificate.update(copy.deepcopy(original))
        self.object_overrides[(self.later['head'], 'scripts/deploy_test_worker.py')] = b'changed source'
        with self.assertRaises(ValueError):
            self.r.recognized(self.state, self.directory, current, Path(self.proof['old_request']))

    def test_refreshed_all_six_retirements_leave_new_backend_cleanup_debt_blocking(self):
        for proof in self.proofs.values(): self.issue(proof)
        self.active_root = Path(self.gate['worker_root'])
        current = copy.deepcopy(self.gate); current['checks'].append('new-domain')
        current['worker_recipe']['cases']['new-domain'] = {'command': ['new-domain']}
        self.assertTrue(self.r.recognized(self.state, self.directory, current, Path(self.proof['old_request'])))
        folder = self.directory / 'attempts/55/triage' / self.gate['name']; folder.mkdir(parents=True)
        result = {'token': 'newer-55', 'gate': self.gate['name'], 'source': self.later, 'cleanup_complete': False}
        self.put(folder / 'result.json', result)
        self.state['attempts'].append({'results': [{**result, 'complete': False, 'worker_result': str(folder / 'result.json')}]})
        with self.assertRaisesRegex(ValueError, 'cleanup state unknown'):
            c.retained_owners(self.state, [self.gate['name']])
        self.assertEqual(len(self.state['historical_launch_retirements']), 6)


class ExplicitAgentCardOverride(unittest.TestCase):
    def setUp(self):
        import deploy_failure_report as report
        self.report = report
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        self.native = {'head': 'c' * 40, 'digest': 'd' * 64}
        self.six = ['agentcard-lifecycle/agentcard-lifecycle'] + ['smoke/' + x for x in (
            'agent-payment-test-shop', 'agent-payment-setup-resume', 'agent-payment-idempotent-abandonment',
            'agent-payment-abandonment', 'agent-payment-new-user-journey')]
        self.other = ['smoke/required-' + str(i) for i in range(9)]
        self.state = {'source': self.source, 'phase': 'triage', 'ready': False, 'failure_phase': 'initial',
                      'repair_gates': [], 'skips': {}, 'input_fingerprints': {'smoke': 'e' * 64, 'agentcard-lifecycle': 'f' * 64},
                      'plan': {'gates': [{'name': 'smoke', 'checks': [s.split('/')[1] for s in self.six[1:] + self.other], 'command': ['never']},
                                        {'name': 'agentcard-lifecycle', 'checks': ['agentcard-lifecycle'], 'command': ['never']}]}}
        self.state['failures'] = [{'id': str(i), 'check': check, 'gate': check.split('/')[0], 'source': self.native,
                                  'native_result': 'UNVERIFIED', 'complete': False, 'command': ['never']}
                                 for i, check in enumerate(self.six + self.other)]
        self.state['pending'] = [f['id'] for f in self.state['failures']]
        self.entries = [{**f, 'description': 'explicit omission', 'evidence': 'retained original UNKNOWN', 'attribution': 'UNKNOWN',
                         'user_override': {'message': {'thread_id': 'ph7bsx6sqkqz9eap7w95xcs9t98gdv97',
                          'turn_id': 'turn:01a1bcfc-c96e-73c0-b344-d80486cd674c', 'reply': 'SKIP agentcard bs'},
                          'question_checks': list(self.six), 'source': self.source,
                          'input_fingerprint': self.state['input_fingerprints'][f['gate']]}}
                        for f in self.state['failures'][:6]]

    def qualify(self):
        c.adjudicate(self.state, {'partial': True, 'failures': self.entries})

    def test_incomplete_unknown_omits_exact_six_and_keeps_other_nine_pending(self):
        self.qualify()
        self.assertEqual(set(self.state['skips']), set(self.six))
        self.assertEqual(self.state['pending'], [str(i) for i in range(6, 15)])
        self.assertFalse(self.state['ready'])
        self.assertTrue(all(f['complete'] is False and f['native_result'] == 'UNVERIFIED' for f in self.state['failures']))
        gate = self.state['plan']['gates'][0]
        qualified = c.reuse_qualifications(self.state, gate)
        self.assertEqual([v for v in gate['checks'] if v not in qualified], [x.split('/')[1] for x in self.other])
        card = self.state['plan']['gates'][1]
        result = c._execute(card, self.state, Path('/unused'), Path('/unused'), host_admission={'started': True})
        self.assertEqual(result['cases'], {'agentcard-lifecycle': 'SKIP'})
        self.assertIs(result['executed'], False); self.assertIsNone(result['native_exit'])

    def test_exact_authority_scope_and_exclusive_flags_required(self):
        original = self.entries[0]
        for key in ('resource_skip', 'external_provider', 'repair_agent', 'post_merge', 'execute_unverified', 'assigned_repair', 'standing_policy'):
            with self.subTest(key=key), self.assertRaises(ValueError): self.report.decision({**original, key: False})
        for check in ['backend-coverage-blackbox/blackbox:iphone', 'smoke/browser-smoke', 'smoke/agent-payment-test-shop-extra']:
            with self.subTest(check=check), self.assertRaises(ValueError): self.report.decision({**original, 'check': check})
        for field, value in [('message', {'reply': 'SKIP everything'}), ('question_checks', self.six[:-1]), ('input_fingerprint', True)]:
            changed = copy.deepcopy(original); changed['user_override'][field] = value
            with self.assertRaises(ValueError): self.report.decision(changed)

    def test_reuse_and_request_reject_source_input_or_disposition_drift(self):
        self.qualify()
        for key, value in [('source', self.native), ('input_fingerprint', '0' * 64)]:
            entry = self.state['skips'][self.six[0]]; before = copy.deepcopy(entry)
            entry['rca']['user_override'][key] = value
            with self.assertRaises(ValueError): c.revalidate_standing_skips(self.state)
            entry.clear(); entry.update(before)
        self.state['skips'][self.six[0]]['rca']['user_override']['message']['reply'] = 'not approved'
        with self.assertRaises(ValueError): c.revalidate_standing_skips(self.state)

    def test_incomplete_generic_external_waiver_still_rejected(self):
        entry = copy.deepcopy(self.entries[0]); entry.pop('user_override')
        entry.update(attribution='NOT_INTRODUCED', external_provider={'name': 'test', 'reason': 'outage'})
        with self.assertRaises(ValueError): c.adjudicate(self.state, {'partial': True, 'failures': [entry]})
        self.assertEqual(self.state['skips'], {})

    def test_report_marks_override_and_preserves_financial_unknown(self):
        entry = {**self.entries[0], 'disposition': 'user / overridden'}
        text = self.report.render({'failures': [entry]})
        self.assertIn('⚠️ Overridden', text); self.assertIn('$43.96', text); self.assertIn('settlement UNKNOWN', text)
        self.assertIn('UNVERIFIED', text); self.assertNotIn('native PASS', text)


    def test_all_skipped_card_still_requires_native_admission_and_retained_owner_guard(self):
        self.qualify(); card = self.state['plan']['gates'][1]
        for admission in (None, {}, {'started': False}, {'started': 1}):
            with self.subTest(admission=admission), self.assertRaises(ValueError):
                c._execute(card, self.state, Path('/unused'), Path('/unused'), host_admission=admission)
        card.update(worker_transport='local-isolated', case_protocol=True)
        def refused(gate, root, admission, **kwargs):
            admission['started'] = False
            return kwargs['operation'](None)
        with patch.object(c, 'run_with_local_slot', side_effect=refused), self.assertRaises(ValueError):
            c.execute(card, self.state, Path('/unused'), Path('/unused'))
        self.state.update(phase='final', plan_digest=c.digest(self.state['plan']), environment='test')
        with patch.object(c, 'source', return_value=self.source), patch.object(c, 'environment_digest', return_value='test'), \
             patch.object(c, 'input_fingerprints', return_value=self.state['input_fingerprints']), \
             patch.object(c, 'reusable_full_pass', return_value=False), \
             patch.object(c, 'retained_owners', return_value=['agentcard-lifecycle']), patch.object(c, 'execute') as execute:
            with self.assertRaisesRegex(ValueError, 'unreconciled cleanup'):
                c.run_phase(self.state['plan'], self.state, Path('/unused'), Path('/unused'))
            execute.assert_not_called()

    def test_changed_source_even_same_inputs_requires_normal_explicit_renewal(self):
        import deploy_test_election
        self.qualify(); old = copy.deepcopy(self.state['plan']); old['source'] = self.source
        self.state.update(plan=old, plan_digest=c.digest(old), environment='test')
        new = copy.deepcopy(old); new['source'] = self.native
        with patch.object(c, 'validate_plan'), patch.object(c, 'source', return_value=self.native), \
             patch.object(c, 'input_fingerprints', return_value=self.state['input_fingerprints']), \
             patch.object(c, 'environment_digest', return_value='test'), \
             patch.object(deploy_test_election, 'prepare', return_value=None), patch.object(deploy_test_election, 'apply'):
            c.refresh(self.state, old, new, Path('/unused'))
        self.assertEqual(self.state['skips'], {})
        renewals = [f for f in self.state['failures'] if f.get('phase') == 'refresh']
        self.assertEqual(len(renewals), 6); self.assertTrue(all(f['complete'] is False for f in renewals))
        self.assertTrue(all(f['native_result'] == 'prior waived failure; changed inputs' for f in renewals))

    def test_normal_smoke_request_contains_nine_active_and_five_omissions(self):
        self.qualify(); gate = self.state['plan']['gates'][0]
        gate.update(case_protocol=True, result_transport='file', command=['python3', 'scripts/deploy_test_cloud.py'])
        self.state.update(round=58, environment='e' * 64)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); seen = {}
            def worker(argv, **kwargs):
                request = c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST'])); seen.update(request=request, argv=argv)
                c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), {**{k:request[k] for k in ('token','source','gate')},
                    'cases': dict.fromkeys(request['checks'], 'PASS'), 'complete': True, 'cleanup_complete': True, 'reused': False})
                return 0, False, False, False
            with patch.object(c, 'run_command', side_effect=worker), patch.object(c, 'isolated_request', return_value=None):
                c._execute(gate, self.state, root, root)
            self.assertEqual(seen['request']['checks'], [x.split('/')[1] for x in self.other])
            self.assertEqual(set(seen['request']['skips']), {x.split('/')[1] for x in self.six[1:]})
            self.assertEqual(seen['argv'], ['python3', 'scripts/deploy_test_cloud.py'])
            self.assertFalse(any('agent-payment-' in arg for arg in seen['argv']))


class IsolatedRunlessWitnesses(unittest.TestCase):
    """Launch-only typed witnesses: local fake native bytes, no network or resource effect."""
    def setUp(self):
        import hashlib, base64, time
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'.git').mkdir()
        self.owner='a'*32;self.mid='0123456789abcd';self.vid='vol_owned';self.ref='c'*40
        self.fleet=self.root/'.context/deploy-cloud'/('d'*64)/'runs/20261110-000000-2147483001';self.fleet.mkdir(parents=True)
        self.audit=self.root/'.git/cloudbench-fleet-audits'/self.owner;self.registry=self.root/'.git/cloudbench-fleet-ownership'/self.owner
        for p in [self.audit/'fresh',self.audit/'by-machine-id',self.registry]:p.mkdir(parents=True)
        self.meta='fleet_owner_token='+self.owner+'\nrun_id='+self.fleet.name+'\nworkspace_root='+str(self.root)+'\napp=fixture\nstatus=incomplete\n'
        self.save(self.audit/'meta',self.meta);self.save(self.registry/'meta',self.meta+'cleanup_policy=reap\n')
        self.save(self.registry/'runtime-evidence-unconfirmed','immutable original debt\n')
        self.row=dict(fleet_owner_token=self.owner,run_id=self.fleet.name,app='fixture',clone_name='cloudbench-owned',
            source='fresh-clone',source_machine_id='fedcba98765432',machine_id=self.mid,volume_id=self.vid,disposition='owned')
        self.save(self.audit/'fresh/cloudbench-owned',''.join(k+'='+v+'\n' for k,v in self.row.items()))
        self.save(self.audit/'by-machine-id'/self.mid,'cloudbench-owned\n')
        source=dict(machine_id=self.row['source_machine_id']);raw=json.dumps(source).encode()
        for p in [self.audit,self.registry,self.fleet]:self.save(p/'source-manifest.json',raw)
        import cloudbench_execution_provenance as prov
        values={'base_source_manifest_sha256':hashlib.sha256(raw).hexdigest()};config=dict(schema_version=prov.CONFIG_SCHEMA_VERSION,values=values)
        self.save(self.fleet/'execution-provenance.json',dict(schema_version=prov.EXECUTION_SCHEMA_VERSION,base_sha=self.ref,workspace_patch_sha256='none',
            controller_snapshot=dict(schema_version=prov.SNAPSHOT_SCHEMA_VERSION,sha256='b'*64),config=dict(config,sha256=prov.canonical_sha256(config))))
        self.save(self.fleet/'execution-task-matrix.json',dict(tasks=['fixture']))
        self.life=dict(fleet_owner_token=self.owner);self.receipt=dict(source=dict(head=self.ref),started_at=time.time()-30,finished_at=time.time()-20)
        self.proof=dict(purpose='isolated-validation',confirmed_at=time.time()+1,execution_quiescence={})
        self.native=__import__('deploy_test_native_cleanup');self.now=time.time()
        self.binding=dict(app='fixture',owner=self.owner,run_id=self.fleet.name,machine_id=self.mid,
            volume_id=self.vid,run_token=self.owner+'-0',source=self.ref)
        self.machine=dict(id=self.mid,name='cloudbench-owned',instance_id='known-instance',state='started',
            config=dict(image='image@sha256:'+'f'*64,env=dict(REF=self.ref,CLOUDBENCH_RUN_TOKEN=self.owner+'-0'),
                        mounts=[dict(volume=self.vid,path='/data')]))
        self.packet=self.root/'packet.json'

    def save(self,path,value):
        path=Path(path)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(value if isinstance(value,bytes) else value.encode() if isinstance(value,str) else json.dumps(value).encode())
        return str(path)

    def pair(self,name,absent=False):
        import hashlib
        rows=[]
        for kind,identifier,value in [('machine',self.mid,None if absent else self.machine),
                ('volume',self.vid,dict(id=self.vid,encrypted=True,state='pending_destroy' if absent else 'created',
                    attached_machine_id=None if absent else self.mid))]:
            raw=json.dumps(value).encode();path=self.root/(name+'-'+kind+'.raw')
            rows.append(dict(kind=kind,method='GET',path='/'+('machines/' if kind=='machine' else 'volumes/')+identifier,
                no_retry=True,http_status=404 if absent and kind=='machine' else 200,
                response_sha256=hashlib.sha256(raw).hexdigest(),body_path=self.save(path,raw),wire=str(self.root/(name+'-'+kind+'-wire'))))
            wire=Path(rows[-1]['wire'])
            self.save(wire/'request.json',dict(app='fixture',method='GET',path=rows[-1]['path'],body=None,headers={}))
            import base64
            self.save(wire/'0001-wire.json',dict(method='GET',path=rows[-1]['path'],status=rows[-1]['http_status'],
                body_b64=base64.b64encode(raw).decode(),sha256=hashlib.sha256(raw).hexdigest()))
        return dict(rows=rows,app='fixture')

    def absent(self):
        import hashlib,base64
        n=self.native;canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':')).encode()
        effect=self.root/'.git/cloudbench-native-effect-fences'/self.owner/self.fleet.name/self.mid/'destroy'
        fence=effect/hashlib.sha256(canonical([self.mid,self.machine['instance_id'],self.machine['config']])).hexdigest()
        self.save(fence/'intent.json',dict(machine=self.machine,operation='destroy'));self.save(fence/'ack.json',dict(ok=True))
        for kind,identifier in [('machine',self.mid),('volume',self.vid)]:
            self.save(self.registry/('disposable-delete-'+kind+'-'+identifier+'.json'),dict(owner=self.owner,app='fixture',kind=kind,identifier=identifier))
        nonce='original-lease';wire=None
        for i,(method,url,result,status) in enumerate([
                ('POST','/machines/'+self.mid+'/lease',{'data':{'nonce':nonce,'version':self.machine['instance_id']}},201),
                ('GET','/machines/'+self.mid,self.machine,200),
                ('DELETE','/machines/'+self.mid+'?force=true',{'ok':True},200),
                ('DELETE','/machines/'+self.mid+'/lease',{'data':{'ok':True}},200)]):
            d=effect/'wire'/str(i);raw=canonical(result)
            self.save(d/'request.json',dict(app='fixture',method=method,path=url,body=None,
                headers={} if method=='POST' else {'fly-machine-lease-nonce':nonce}))
            self.save(d/'0001-wire.json',dict(method=method,path=url,status=status,body_b64=base64.b64encode(raw).decode(),
                sha256=hashlib.sha256(raw).hexdigest(),monotonic_ns=i+1));self.save(d/'result.json',result)
            if i==2:wire=d
        packet=dict(self.pair('current',True),schema='original-absent-pair-v1',binding=self.binding,
            endpoint_origin='https://api.machines.dev',observed_epoch=self.now,delete_fence=str(fence),delete_wire=str(wire))
        self.save(self.packet,packet);return packet

    def runless(self):
        import base64,hashlib,shlex
        n=self.native;original=self.fleet.parent.parent/'campaigns'/('deploy-'+self.fleet.parent.parent.name)/'shared-inventory/machines.json'
        self.save(original,[self.machine]);task=self.fleet/'fixture'
        self.save(self.fleet/'_batch/benches.json',[dict(name='fixture')])
        self.save(task/'runtime-evidence.owner.json',dict(version=1,machine_id=self.mid,run_token=self.owner+'-0'))
        self.save(task/'.cid','clone '+self.mid+'\n')
        backend=task/'guest-cleanup.backend.log';self.save(backend,b'original log')
        services=dict(schema_version=1,status='stopped',benchmark_mode=True,worktree='/data/repo',run_sh_pid=300,
            services=[dict(name='backend',pid=301)],ports=dict(backend=3001,disabled=0))
        state=dict(machine_id=self.mid,guest_run_token=self.owner+'-0',services_status='stopped',live_service_pids=[],
            driver_pid=None,driver_state='exited',stopped_service_pids=[300,301]);self.save(task/'guest-cleanup.state.json',state)
        def process(pid,parent):
            values=['0']*50;values[0]='S';values[1]=str(parent);values[6]='0';values[19]='123'
            raw=str(pid)+' (fixture) '+' '.join(values)
            return dict(pid=pid,stat=raw,stat_after=raw,run_token='',cwd='/',exe='/bin/python3',
                cmdline_b64=base64.b64encode(b'python3\0').decode())
        empty='header\n';timewait='header\n0: 00000000:0BB9 00000000:0000 06 0 0 0 0 0 0\n'
        scan=dict(schema='original-runless-proc-scan-v1',binding=self.binding,uid=0,machine_id=self.mid,repo_head=self.ref,
            processes=[process(1,0),process(2,1),process(100,2)],ancestors=[100,2],self_pid=100,errors=[],run_present=False,
            services_b64=base64.b64encode(json.dumps(services).encode()).decode(),backend_sha256=hashlib.sha256(backend.read_bytes()).hexdigest(),
            sockets=dict(tcp=timewait,tcp6=empty,udp=empty,udp6=empty),finished_epoch=self.now)
        cmd=shlex.join(['timeout','--signal=TERM','10s','/usr/bin/python3','-I','-B','-c',n.RUNLESS_SCAN,json.dumps(self.binding,sort_keys=True,separators=(',',':'))])
        packet=dict(schema='original-runless-current-os-v1',binding=self.binding,endpoint_origin='https://api.machines.dev',observed_epoch=self.now,
            before=self.save(self.root/'before.json',self.pair('before')),after=self.save(self.root/'after.json',self.pair('after')),
            original_native=str(original),original_state=str(task/'guest-cleanup.state.json'),original_backend=str(backend),
            scan=self.save(self.root/'scan.json',scan),ssh_stdout=self.save(self.root/'stdout.json',scan),ssh_stderr=self.save(self.root/'stderr',b''),
            command=cmd,ssh_argv=['ssh','console','--quiet','-a','fixture','--machine',self.mid,'-C',cmd],ssh_exit=0,
            program_sha256=hashlib.sha256(n.RUNLESS_SCAN.encode()).hexdigest())
        self.save(self.packet,packet);return packet,scan

    def invoke(self,kind):
        self.proof['execution_quiescence']={self.mid:{kind:str(self.packet)}}
        bound=lambda p:Path(p).read_bytes();document=lambda p:json.loads(bound(p))
        with patch.object(self.native.subprocess,'check_output',return_value=''):
            return self.native.isolated_execution(self.fleet,self.life,self.root,self.receipt,self.proof,bound,document,lambda p:'sealed')

    def test_isolated_original_absent_pair_requires_original_authenticated_delete(self):
        packet=self.absent();self.assertEqual(self.invoke('original_absent_pair'),{self.mid:self.vid})
        original=copy.deepcopy(packet)
        for key,value in [('owner','f'*32),('source','d'*40),('machine_id','ffffffffffffff'),('volume_id','vol_foreign')]:
            packet=copy.deepcopy(original);packet['binding'][key]=value;self.save(self.packet,packet)
            with self.subTest(key=key),self.assertRaises(ValueError):self.invoke('original_absent_pair')
        self.save(self.packet,original)
        saved_purpose=self.proof['purpose'];self.proof['purpose']=None
        with self.assertRaises(ValueError):self.invoke('original_absent_pair')
        self.proof['purpose']=saved_purpose
        ack=Path(original['delete_fence'])/'ack.json';raw=ack.read_bytes();ack.unlink()
        with self.assertRaises((ValueError,OSError)):self.invoke('original_absent_pair')
        ack.write_bytes(raw);cross=copy.deepcopy(original);cross['delete_fence']=str(self.root/'foreign/intent')
        self.save(self.packet,cross)
        with self.assertRaises((ValueError,OSError)):self.invoke('original_absent_pair')
        self.assertEqual((self.registry/'runtime-evidence-unconfirmed').read_text(),'immutable original debt\n')

    def test_isolated_runless_requires_raw_quiescent_original_incarnation(self):
        packet,scan=self.runless();self.assertEqual(self.invoke('runless_current_os'),{self.mid:self.vid})
        # TIME_WAIT and disabled port0 above are legitimate; a live original listener is not.
        for mutation in ['active-process','repo-command','listener','wrong-source','reused-instance','missing-program','crossroot']:
            candidate=copy.deepcopy(packet);changed=copy.deepcopy(scan)
            if mutation=='active-process':changed['processes'][0]['run_token']=self.owner+'-0'
            if mutation=='repo-command':
                import base64
                changed['processes'][0]['cmdline_b64']=base64.b64encode(b'node\0/data/repo/back-end/dist/server.js\0').decode()
            if mutation=='listener':changed['sockets']['tcp']=changed['sockets']['tcp'].replace(' 06 ',' 0A ')
            if mutation=='wrong-source':changed['repo_head']='e'*40
            if mutation=='missing-program':candidate['program_sha256']='0'*64
            if mutation=='crossroot':candidate['binding']=dict(candidate['binding'],run_id='foreign')
            if mutation=='reused-instance':
                after=json.loads(Path(packet['after']).read_text());rawpath=Path(after['rows'][0]['body_path']);saved=rawpath.read_bytes()
                native=json.loads(saved);native['instance_id']='reused';self.save(rawpath,native)
                import hashlib
                import base64
                after['rows'][0]['response_sha256']=hashlib.sha256(rawpath.read_bytes()).hexdigest();self.save(packet['after'],after)
                wire=Path(after['rows'][0]['wire']);record=json.loads((wire/'0001-wire.json').read_text())
                record.update(body_b64=base64.b64encode(rawpath.read_bytes()).decode(),sha256=hashlib.sha256(rawpath.read_bytes()).hexdigest());self.save(wire/'0001-wire.json',record)
            self.save(packet['scan'],changed);self.save(packet['ssh_stdout'],changed);self.save(self.packet,candidate)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.invoke('runless_current_os')
            if mutation=='reused-instance':
                rawpath.write_bytes(saved);self.save(packet['after'],self.pair('after'))
        self.assertEqual((self.registry/'runtime-evidence-unconfirmed').read_text(),'immutable original debt\n')


    def test_runless_explicit_null_attachment_requires_positive_original_mount(self):
        import base64,hashlib,stat
        self.machine['region']='iad'
        self.machine['config']['mounts'][0].update(name='cbs_owned',size_gb=40,encrypted=True)
        packet,scan=self.runless()
        packet['attachment_observation']='explicit-null-original-quarantined-v1'
        filesystem=dict(mountinfo='1 0 8:0 / / rw - ext4 /dev/vda rw\n2 1 8:16 / /data rw - ext4 /dev/vdb rw\n3 2 0:25 / /data/repo/back-end/node_modules rw - overlay overlay rw\n',
            paths={p:dict(device=d,inode=10+i,mode=stat.S_IFDIR|0o755,realpath=p) for i,(p,d) in enumerate([('/',2048),('/data',2064),('/data/repo',2064)])},
            payloads={p:dict(device=2064,mode=stat.S_IFREG|0o600) for p in ('/data/repo/.context/cloudbench/services.json','/data/repo/.context/cloudbench/logs/backend.log')})
        filesystem['mountinfo_after']=filesystem['mountinfo'];scan['filesystem']=filesystem
        volume=dict(id=self.vid,name='cbs_owned',region='iad',size_gb=40,encrypted=True,state='created',attached_machine_id=None,attached_alloc_id=None)
        def reseal(phase,value,kind='volume'):
            pair=json.loads(Path(packet[phase]).read_text());row=next(x for x in pair['rows'] if x['kind']==kind)
            raw=json.dumps(value).encode();self.save(row['body_path'],raw);row['response_sha256']=hashlib.sha256(raw).hexdigest()
            wire=Path(row['wire'])/'0001-wire.json';record=json.loads(wire.read_text());record.update(body_b64=base64.b64encode(raw).decode(),sha256=row['response_sha256']);self.save(wire,record);self.save(packet[phase],pair)
        for phase in ('before','after'):reseal(phase,volume)
        def publish(value):self.save(packet['scan'],value);self.save(packet['ssh_stdout'],value);self.save(self.packet,packet)
        publish(scan);self.assertEqual(self.invoke('runless_current_os'),{self.mid:self.vid})
        for mutation in ('foreign','omitted','mount','payload-redirect','rootfs','payload-device','symlink','epoch','pid','socket'):
            changed=copy.deepcopy(scan);v=copy.deepcopy(volume);m=copy.deepcopy(self.machine)
            if mutation=='foreign':v['attached_machine_id']='foreign'
            if mutation=='omitted':del v['attached_alloc_id']
            if mutation=='mount':changed['filesystem']['mountinfo']=changed['filesystem']['mountinfo'].replace('/data rw','/elsewhere rw')
            if mutation=='payload-redirect':
                changed['filesystem']['mountinfo']+='4 2 0:26 / /data/repo/.context/cloudbench rw - overlay overlay rw\n'
                changed['filesystem']['mountinfo_after']=changed['filesystem']['mountinfo']
            if mutation=='rootfs':changed['filesystem']['paths']['/data']['device']=2048
            if mutation=='payload-device':changed['filesystem']['payloads']['/data/repo/.context/cloudbench/services.json']['device']=2048
            if mutation=='symlink':changed['filesystem']['paths']['/data/repo']['mode']=stat.S_IFLNK|0o777
            if mutation=='epoch':m['instance_id']='foreign-instance'
            if mutation=='pid':changed['processes'][0]['run_token']=self.owner+'-0'
            if mutation=='socket':changed['sockets']['tcp']=changed['sockets']['tcp'].replace(' 06 ',' 0A ')
            reseal('after',v);reseal('after',m,'machine');publish(changed)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.invoke('runless_current_os')
        self.assertEqual((self.registry/'runtime-evidence-unconfirmed').read_text(),'immutable original debt\n')

    def test_runless_pins_only_original_terminal_infrastructure(self):
        import base64,hashlib,shlex,stat,zlib
        # Exact original CBC injected programs and prior aa33 scanner; portable without old Git objects.
        capsules={'prior': 'eJyNV21v2zgS/q5foU8rCWUkO02drF0tkKZJG6zXLprs3fV8gaAXOuZWEgVRcuzt9r/vM6Qs27kcrgFMkcOZ4bzPRBSVrBs7iRUfnbFVrFa5SNgfSpZMKqaauGFqq1gjCs5Um1S1TLlS1rKWhV3FDWHbwvD4hKOVhETr5zLOlAtKP64f14vhgzfhZRYSG7+QpWxkKVLXe3VhxUpxEEvlP/KGtyJzvTAc2HGZEYyXa1GDH+5c52b6Jfrt8urj7ew6un3vAC9ZOEWcrkTJI5E5D1YiZROSHK4TkKgBJAi+8rrkeVCDpSwCQiFkz695nEUN3zSu56umFpXrWTWvZLTCRbhX1k9XPP0aybap2sZdOEGr6iARZfAoGoc5JykWFS+5n4map42st2GQxU0cEDNCuMJyBKn5+qSKa8Wx/3h9+d55YCRHeF+3XJsab4WnDMqH35xPl/cfnXH/6pgW0H24vY+u5rOb2w/Rh+n83eWUcDK+Dso2z4/vZ/O7L3f3178BY9jdzD/d385nl9NoOr/69Q4XA+f73gpVvCUHRuR+FX77bmV8aXdAl7zOclGIxhtbdmXMTUDPssXShm/tyucboRrleuOaN21d2jNZcsvufF3B9Erma06urrSrDZVQkdoWuSi/up4Ga9BS5MC07GUWIiJkxUu3QnD68+jz+/ls+uUvvZ/Nb+bT6fyfu9PsHakGsqbeQk474UtZc+KwJLXcZeZNOnno7N9Ft3efrz+4Bg+miAqZcSPGHqbEn/xtqLUHzyfRrChKl5mWapnBtYnD0lwqDmlv4lwRB4UXEGzFuI6fQrPVwedqPq+GENKOlw2vj6QjoJEvB2+QUrwfCaJlOxBYlJLtT4gFdox/cCwoyqJSgaern97R9wci7w+auj/1xBDxKFQWFAYPYSbSxgW9SHl4LA+ZNHxmYTDpggQ6wsuijPN8O4YptB21KQrZlo0ol/I4uXm+DPqr44yeHNiuR0E5SfGk63lvw9PBz+fDN6cWiaxjHELZZVxwW5Q2Xtjl7HHuUshrOSBerj1FJN5Ec1nQ/lh9/WqnPMyb7SFk7OIQQAcGDXLiRWHial01/z5hKENTUyg8z7OgIj2jwl1yHsga+KksyRgB7NhmCXRfBTsCn6q0w4aDs4s35yPUvbb8YR7A3ZG/Pjsdnp+fXnhWEqdfqcL/KJNcPqqgI0K3eHTY6Hw4uLgYnUEY+aTCxcPkEUWDvryuZU0Q7aOKHKTQcHjmHkQD3C8Qn6jBcO/4oBSRAVFGMoFyjYJEsoiy3Vej5z3pLSTqqwZlrFsFDrn6WYCtQ1z6tapy8HU8G+bw0Oh8A/Amyzx+VPBu464XI/S/SmT6ZCTSYS+fTLDQFX663RJXuoT8msNPg81gcDqgPxvarxeDBxOh/0Zk/gu/DYKSLObHFYpQ5mLvTfZamiJFOnS9FGroakWlShen5ZgazdKUpLPhz2evB2+8Q8K0yFCT+QuEuHmBMH3SlZrAupYTiyd03Anf8OcXADnPSh2kQX4afme6xhEUT+2hIFjHeYvA1/bbdEZPnJC8YFOYbMhKYNVf/WcAqWFVQqK7TecCv60QqtxFWEeNRDyGhrWeORLnajr//f2769nVx+jz77Pofv7r9cxhiQNrZFxXky480dWrPE6hDgNjbQT8GOmMH+uMGCWjs9BMWz62XUEi5XbsPB0GkWkIL8deJ/mRyy2bb1JeNfYN2uVMNjcoetk1iTamPNqhHkTgnsT9xOtCKCVkqSnY/M58/0GW0FvtcD42uu6Y9cF7wJVplLDZVrCM50cRQaMIryXb8Ntm4VQ0qY03eyeRJt8ncYmyhKyjhCeWZiCsaB60nlbQycb+l+F4P0WIjKiTrZkUhBkiANlxsvrdTl4g7fMw2S6wfVgY+z7870ym6dVSEqWqeaFRNGmFJMQ6wqfNKrOOdKfQGXTYsUreBM4rU9J1LnV51HHvGkiXUaZDvfasw+Q4wnyxn9WknB7Cs7aolHGSwgxbxKEja5RBNNgTRHuO2faExDpRaVyerDEbYrTMRPkYJqztXWBmcrafs8P/N5cj/vUgTgvbT9T9jlHjjp45mRlnUSbt3Ma6ARxpTjHCdD+ghXUpZz5s55vuy2iIgHJb1fDCFIj9/NDvWL/rUu1HJwtmJga9sq7d9Q3YzEFkgV2n1QlP4y/Vnh3QFkqPxDbHhGj/VznYoR3UBKpOFaYAXqJDtCUxoHAnJmRu00gjtYpP34z65zrw8Wvd/3i+wXU7HM9f8Q16JAyP1zCECbXiWQSXpSvzbxstiDQk8t/a7dqM', 'cloudbench-boot.sh': 'eJzlWt1u20iWvtdTVCtOIk9MKc5O9y7sSQ+UWImF2JZGlido9DRkiixJ3FAkh1W0ou0OMFeL3dvFAPsG+yL7Jv0k+51TVRRFyY77Zm8mGIzV/Dl1/s93zuGTbzqFyjvTKOnI5E5MfbVoPBG//v1v/wj/g6RBnBbhVCbBwpumqW6rhfj1b38XeiFFmuDSZ/FmMBgLmeh8naVRosUszfn2ys+X5nWBx9qNJ6B2Ed1JhRf5gU7oa1/8eXBxc9kTLaX9uQxxL5DC18LzlNRFdiRUKuSdzNdCJX6mFqkmmokUC1+BYKQP22IMYkEKDtI4lrnAiwo3hK/4mKUfLKJEPlfi1vOCdLn0k/BW4P9EKGPwk/NjoJXJ3MuLRGR+7i+lphsgYV+nl+EAt8Tb7SxeBzoubxUZJJG3QkdLeUTEElCDPLk2HJD4zCSpi26L7s144I1urq75fpgTG6QWUrFYRXohrgYVkUDu+vqcjvbjmPW/WkTBQkSG/mqRxlKw9k/4AklCZ8V+QYZTMNq0yJUGnRbzJV4IXPRy6Ydr/A5i6ece7oDMC8GWwF/zNt1Ok1kEY/76n/8h/pleFP/73+KKpJHqkET1dZFDA6F4F6+h50ujF+V1h31BN0QcLckgcI5YSpIwhIhkgk8R5AutBqBvYtGc2xZvoAzPMpHLLPYDSfKCCrwtyqWRyaiLPOK2Zg+SlmKWBGCrH+Ln1oOsi1tSF5uGFJukLCD9JP70lmuRk+CHElmeznOp4MpkOHoIkouz7rgrhhfdK7izdRE8+Hktfv33/+KHcJ4uFBw0p9emMk5XhyYw+klWwFtaZF/HHTvcEblzadDpWsBDPROPHFuHJ3hbiLcXg5uzN72rt+cTisfXx8L+G/X+dNMf9c6ETunVir+dCn+qoEnmLgph+haFbMeEl0qLPJCHdeLw2cl48KF3xcSZYPpJJjU9QQQdLGCtyNyJ0zkTGvXeib3/prkPiTpq4ROfeDX4JNKC3BRH1Hm4HnfHN9eT4WA0xo3+8O47q1iPFBsFFApwcf6PZG7TTCuUM7+ItfiXl8fHRqwXNrHY8IvIBKJlzhh3rz9cT9589/sjYQ/tX95cdMe9I/Hx8nxyOTjrXUyuupe9IyZV5280nrzpjkb93ugIrvQ/h+xPma8UfF3p3I/mCw3N5GkxX7DEmywLgZFkjVeMikS5NBYtEZUIrpxSxNvLM1FAQJNWrABhnmaKqN3mqUI6uot8MU9VgVyoZDxr/wPVLYoZr0hFFmUwexQ3IPsQAUuBV/PV5xSPSHyhp4I8yjQygDddaxmkoX3MDyq24krBaRo3EsWeNpWoeahayVrYKjZc6wXS+ULGlFtMKWg35Gd+fPjD+HxwdTa4Gn8c9ce9Nz+Me2/hT6+PGw3KIJOz/uh18+Dnike5yyceO/OXZuNi8B7PuOsddp02wqzZGPWGg9rrdMm8vnkDCTUFnUos1V6q3DnxKGjw9Nmo/+feaDLsn03e9S96VQ4qHmzcsZ1FYfkGEes94h2KYwmuzm/GZ4OPVxPKXr3r8UNvqkWhw3SVeNsiuzx1wrDlSzuXfy2k0s3G24te9+pmOOm+/fB1hjyqjF8j7Qefmo3hqHfRvWHF9boXD1HOcmnr8sNkjVc2G/2rcW80uhmOJ451a5oHzgASkHleZNoIUGRfO4vzZ7PRyIppHKnFxIg/YXu0DsXPDcpxcRr4MedaiXOPm0LLJTzaz9fkOzum/tLWy6x9cNDkl7McTM3E86fqL8lz0Twwphbf42dJpimePRPLO+HNtq9CyDrxZuMLAnFMxQcyFCjVKLXpzOADvQAy4iBVOs0yBKQNUaN4qgoUrEbII5Io+ARqAK7TPF2VeXW7XDNwI6OAtAs3l5wBMLIYkJHKFaFAEJN3UYjHJCNYesZAn8BPAGYYvtDFOTklSo/SgGIC/OOeHyXEYcRQmkpUuzRL6TsTYqRmmC1r7PHHh+3xkH/smOkvDVe57zPYnvPJZE4Q65YTKP4hKerB+v8qQv1w4p/UPllGSsFCkyj5VxkA9k5Mnq8JEvsAeCZOMl8v8OvVNts/soc+VT+Jdwjhi5NKUfIcadwW9jhyT7Cn16L1VB2ewlNmBV9nuIT6RYBpBgA5hVJJIRsJmwctQsQoieLF0/OTp5cnT68PSUTmkX4Qh1AR6QilxfD5RFylxtWXfv6pEh0UagGh3xXc3/ijDNnPrVmpMfFj7i4sJRcgbTE0HmADtRK/M6qzNk4pNFAt4yhAFMTRTAZrkLa0yAanIpoJCeRPuAfNxxTwdZVHkJHKvToSYOSuGmJ0mRAzEFib6eD9b8T+uBK//FK5V3HVU9PcObU+YMgiDgEktCNCoMJ2Mk5FIJekK2T4uVwChW8b7AGjbduIUTga5TwRx3xhFhkf25PHoVEoKIQXm2xaRwmImOu3o/4Q9b6zA0hR/d/1xgwm3tnHau/Xb29TmUlNtOTM0LIl7Lo34rS+j96+R7ZpVlA/4Y016DbIadFpVvyWjdOqTiQS6Zn2xrVaR+TceMfP6VJSmCqX60PqjWjKQN2R/AwHRZcXR5/kFiJP82geJXjnViHFw/nRLSeRXt8STG834Gg/1pITtWgnHnLSN69FE/nhp4pjyc8yENuEGjAquLCNDDeSdhbiIVoQ+uIujYulPOTqMkVjnEcSDagoEooJDo6cWw6EHKvDjnBAdInYQ4ih11WsNZoxzLRtam3f7ACs+AhqlHE29c8UxSiGB8drkOPoEy3qogmCS0DgHHy5VtpMKnjIkqdhQQ09ODZZDeRwgo+ApxoaG3FJ+Xgm0LAJBCrFsXkiTG0t11zUbU4pTO+p2w2aRU1W1IYetJT8qzgWx69eIneGqcsB/LSooKh2MF1pQori1fedUN51kiKOjX0E3IfLxNceniL1IVnYWDTGPG6EcDxuRGxOIMl3clw1A27jD2cEoG/TucN/I5qB+ctpNC9SPIlMWBYEVIMTwhBLpBslmpSMXKoWa6mbR5yfmq53jAA1qUMcIRGuFRvMAhYqSIFOc5rbwQQ6l4ywwKLMl8bvTWK5NdCQMBFjMVBjg6x84zVwTjpSFUEgKQuX2tzuKqgc7W0A9tbk+6DG3gRIvk+cIL8Ty7AJSXxzhVRzOYS5aJzkppuVaYaZ+dhBhp1v0ujNTD7Scj5mZ31kEuewdCIUjjqRVkd9rco8S4oUxYLGceTdGiQdR4cVHe10eu25TGTu6yhNIK2tRO5N7/GQiEsJWD5DtHlgKqn53Yn567KPGTwijMMKDD40c7Dz8Xho0S5NjjcKJCRQGZrRYOK2OiC7Fa2PQMTvCz8Pzazk32Sebs0RmaDSjDLs6JHtYh1LJJJjxE4iqxa0Qm3mkDRZBOAg90ydzZ4Te9EdPcMDpe+GV8IPQ2L3iNgPFpx2TARsZgHCLygx6Cig8SeNB0kcO5Eu0HwshZtJoW9IUTKAgqjcq+03qfQgZ5OmAA+UdAmTs77pRBcAJnqxmUjgh0LOD2kmuO2vtuR8IzxFobSnjG5XnIcwrdiqsfeS2wTUAyUso2Evu/MDNbz9O8/jKclBZQCxlV7pMJ0XkoY8KkLfx7OWf7qXN4OqLNXmNll3L4T3UY5bV0Jtc9cZZwefbMZ8XM3d8zSiNcnh3gAsn67I9er7Z8fiD5v/fkZh+YG0uFsMkN0hu/PzZUaOCl+QyZ2M04zGt6jmubRNROav49QPTTFNp0SD3ZlrO3e0RGcXozpna4tBHOJUWkLYIkKFZ0EQG6Xenco+tbYtLP2OaKoaRuiETTYsuxrrXNR1KOuuXl1bBJImw+4PF4OuKQystarjGghvzd+pbao8KzR8CoAiA9zm8nE/+eZWw3QvJ9fn3Vfffse8dDZgnI1Xaw8ejKsqi19lbDu87gsxC/8NWAQKZkg0y1NTmOwADMp38ABQl9cJFm9tzTGIPRpUZ5tEDmuRPSlRStobtMWlbUzt0NM9x5NTAzuS7QaSRqe2hQQNA8EhmNKK8zop7AUZatsbwSr4klx4GYQDeaBQpKtkO9MZHPEbcpstxps3H5XGqkfWe57fcHjZEHn2wj5qj2IIWn3jzOWVxjU2n5FeI5QbmveqiFMc2Yn2PpESZgG4gZyUIZbLwmDsfeMIqzLwi1eWJm/MKFmpdRJ0Mlr7ADemqzaAZKEkQ0B4k691LD1t/K+UXJiJ+5HdZk6LiFAFYX7rrJ4KUpreLbTO2vIzBEQVpETEXl2Jmff98fnNG5NcaWsjWnbZ4ht6Wyu13Yp56FZ/JmvbrdXN6ELYXTb3Jn2oET+iwMBuZbTkB3mqSJMzVY76XHsGVAEB1oAlM4n0x7ZRomIdRgqk9Jp+c0lFRIl5pCekWc7UBuKEQAhzYAbFZnUxRzq3cGajPtCjM9zeoaKv7nA4ubneGQG4yycebZDQTj8Rb2k1LMxqeE6NSkoiVIXkNBKgRFrcQ0jWRi7ld7QWocHLUCtYBs1mZd/cBG2ZnZp8aF9b+MruYVmjIXkwN5JmLStiOdMEOEGqDZ46qDHyc5s4I3vVhw7mRotdxheV+ODWhNmaxdwdr8zmfks4ekL78ApgXJo2rSKgs/Pu1ftrcUv6cPRuO7eUFvUtVTzJwUkm9xlnmj0jLXBJZpRb242XjbZhVHQJIzJKovG0E9M6RYejwAIlB6bGvdElQarnOwObX/BnUiZfVMFfTLSpjrlPuMbdfb4XX7neg9ZHnZqim1vXm78zSq5eo4DoULiq8rarr9XH9lprP94ra9LEKX2CQ8qpqwwWqWiaWdy+0dlPm6K2yZIHPyPdnnh/SNCbf//FzNTYrNTSzaGjeZxO0eJ6HroBjuN2FSuSHPuZtfjE4Ro+pQZf6B99T7Q38zva9PddszYapLKwkbYiWCW30iQGCaBlM0qZSVbkN4Bo+fqw6SADr1JoouXSUEAtqfssZZXYPM/9MQ9rvBDpBb0/dZ92XU8Zyqm1bdatzAwBBI7dFQ9FszQrYtOhIf6qZGwVoqxGQyefVTynlrBt2WN63O1RRIpllBTIg0cQlT6mWKd2yMRzC0q9dvVVm7SC2AqOnK6ODEp24+OO2yS69MnLI/6SqLKfccMMXLWC7iCt0rkojxG+Wkt9WsVg9rudpNLD0acgQDNubReBocmuv9c2DBkyK/Ejw9cvLeDQwlvyz/3BUgOsaDF4WByFrw++KSm8MBRQlKEVk2Ze0oogCmtjLjtF27i6vH90U3f8/fPzugmoIpqZ1sbFnTynZrlnjLE7PjeJ5pEjdPpXTaieaHo7Am/Ftvu3raV7Xnz2jEfAxlZN4cVavHpJKqlosOwaGN+9bH+7c8ea+qDVMr/EC3F8eLj1GI8Yd4X60L+4+C1C8fyyvGLHmLvMlacRP3s8pKT9Zd8Q/O3g4mwyHPUvu6MfuOm5Ho+6wxPvpZmLH2+3el+JDIuDR0X9U6Q6dDVjT/NMtnZQr0xcyDMR5R9Nn//RPDul2WiOjLdK8086l1Lc+XEUcso62f1ux32S5zZknOX8LIsj7pjpVpFRz8ddOdKZWZst/GReDrBn5FE0I2NCDKl52pgKkziRtGLN6Idypd2z0fm8Nq4iQvMNnfuQz2iCJ+4VkF/kuUmKrA8cv7v7wRlpMrfzhnKzzmjCfKdUDinsxA4vQNcVfGNLiVwSx2eDq54DvjtTVgOVjr/1ECBK4naoTrkHItlo9H1MzMsw8g2+4iOIItUFRuVpZj9D5IGlGf5VhuoJ+gg+60jQ2oz3B2Iuk4L4xuFhFGie11JqH4x61zcX451PTNH/KGpbTVYvEteoEJjiuQb39cqWTAMCOeO7gX+8NtWlY5Z3yijWqc/OJbM0jdF2zKoqDHIgBvYlKxPJflSfEqKqcpUn3M8VLKTyZXIVn6SKjOaSCu5NpiqHMI/M4PfvTSvt6p4Fav2JxxQAt+ox8pvjTvetUcNHLb23k/8De9LHNd9PTMao6DNS9oM7+BVgpfkWxw80RQRMF8OkHyO94AFMmlBLjr+hPBJvzLfl9sNhRKlPgG2Rpwnvdoz8/LXrdf99/2rcwZ8/3fTHIpon0FB4atJHlABuRWYcHUaK236GaWb9MiUYQmXedsGG7nPqgxLQhwPlmteAK+TXjD+PcW3lZpTj0pvb/FkWFIFFclI/CSAoJ8m2eB/ZTbwVgRpyPL2kLSvew58qmyUMLCeN5lsdqQIJVJjQh3QW51jw7KY3O9jGGtXCGwttNhcn+z5fcluozZcm9a9MNgTMAmUfQQfYK5+W7H9sd/u1f3PlsvvGJ23NrXDjRMuD1wd/vHe7tgGZEzNSnth5HjBkJVIrV380s64Hv0NDeiBh76V97KjsLvD4xX0nHzd284PLgjb63UdWOwe/fqqqNF8b4xmj3Ps1zH3c0709DFZzyb2c2lwCmzxFIaO9GfcKNKfYlBO7Y4X7P4LL0srV859slrAWgZTb2VJHnKIfWBuVi+mI4ACvujYVfJPgnlNZI8K0DKUvZelE20TZlur3xy+FrURQVYYjudaXazqkQ6CDhW2paBOW0mKfUyTSTzQzCy6nlPb+mNhJ0/tS9P8BxzGiQg==', 'cloudbench-status-server.py': 'eJztPWtz3DaS3/UraObDcpIZSnJs3UXJpEp25EQVW1LJindzWhdDDTEzXHFIhg/JE63++3Y3HgRJkMORnK2ru6U/WEMCjUaj0egXgC+e7ZZ5tnsdxrssvrXSdbFM4q93bNt+z7JbZs2ipAyuWTxbWn5WhHN/VuSWHweWP5uxtIA/Lb8sliwuwplfsMC69rMsZJmVsYj5OXMB0s7OPEtWlufNy6LMmOdZ4SpNMqwcJ4VfhEmc7+zId9ki9bOcyd9LP19G4bX6ufJn8u9/5Eks/05y+VemquZslrFCfcjDRexH6lcyu2GF+gVoyL8LtkrnYcQ41suiSN0caZFJtN/D/xH76fLy/IL9XrK8+AkIErFsbF0uM+YHYbzAj0TAjENJ/QJ7ISGcw0/+ocwieO9Sl+VX+uH9no/xa55GYbGzs/P+6M2x9+ro4uLk+MKaQi/dWbJKAU0ns6+OJv/jT/7Ym3zjepOPX9mjnXdHf/NeHZ++/sl7e/aj9/qnX05/9l79enn8Hqo+P3ju7b94sVN9P4I/zi5UgRfe3jcHBOLi+PXZh+OLX/GP45PzS1Xk4KX38utGmfeXR5fHqsS+t/fiv72X/9UE9MupKvJy/7n1pbW/9/yF+G/n7Pzy5Oz06C0Wuzx5d+wdfzj5AdA8htKOfbdaTmgkJlGycItPhT227AUOwCQI/UWc5MCEuYtsEQENdnYCNrdwQLysBP5cMW/FCj/wC9/B8TikYRhbK/9TuCpXh1YYFyNr8r11vS5YfrhjwRPOaejcjOVJdMucvMjCWTG9zEo2sp5N6SMviU/mhzCKH/yoZMdZlmSOXca5P2eWaN+S7QN2WD5g+SwL0yLJoH9J7iYpiwm1Mf468y5+ODt9+6v1T/7r9OzN2du3Z3+tfp++env2+mcO6y4slvh+HhCUCjTQKLu2R5afA8+X2YxV+F6zeZIx3vYcp4DDS7jI/nHijEaqKBAC5irNE/e9d/L+4vhHh1d388JbJQHQA7pRvcrDP5j1vSKuAtRLJ4CQwJzBukEX0Yhw8BPQFtjiEDuNlr+y9qvi/rxgSGIaSupnrWMR0gsg0og24ABGGuiA3Y61EmGcjBsV9N8r4rk4J7gOIaGAqF8EQ/3iINRPBWET/Zq0smZLP16wQKMZiMIyi4l0cmqIWcFuwwAkPPOQPrmTJUkh5wYU8YrkhsWHMPTASjMQ6nGZekhERu+ArDa9tWnuBDA9rqgoAvjI8YY14DguVyyDShYsFhaKrojBj7xI0hTGGuDNbsZWzFDMAvY+vfUXsK5MgBmBHPDzNmR3tJ5o3Wn1YZbEBftUaH2xdmEGsDTZdcW33WpRs7UuNno36qJSvQXx67MT7ChNozURK/dXilATIpSFjWawFFtFAhwaLkJY2JBVZ0kUsRkuwwKt3N0hgL/9VkNkas99mOKB/dtvVphTK5UEnYD4XBOxrWQOg8GbvFsmsCgjrOQuhjXSzwL8g8OxHOB5i33ycVihyl2S3cBABsCoUHbpw/pcFlF4CyVD0B8WgDsbuXwcy9jNl4gCDCabJVkAcgqEfDhjOckswSEAn7f1LaGLEgq+Z0iZMIrwHUcOcZ8l6Rpxx4IclV3eCVg3co4P+5RGHDlGcEEvcSXppeSvkYzEH1RwxOCBWBU0HG1YAMoUV3UcEw6PhCgTM1N0lZgJOEMMG7KsJAKtZ7ZeOIeC+NKNEj8AHjeucDrgsdW1UAsJP0ugOgpU0cCVDcqg/fHK5tTz0iyBtznL7Y9U3o+i5A56hKuyGCB7PGrTbKp43WIRUEYrXZFPkrtqHCuX0JakuWwOeKBYp8whdEfIubxAgV/wz33ru6noDPyBKkXf2HCeEFA0PhPcG8a3IH6SbI1F4IcfhRLbGKYkjsK9IBCMxAK69KUzly/uwwd6aeHECLETGQpkZ3/M8RuNHmS/71MX4VHJlFhM4wLkWHvkLqLk2hGwvyTAowdcVQiRvj6KvkCNZn+kDBZdkgNHqEytuV0JSS50JqLE5F7JuAdXjBRBIHmIREEQhxorq97RH9DBqwZzo4oCYkD+Tc0JkupojTk5dq/hM4sDRXT+1oY1P+bNYBs5zTmHCDQafeTU/gI0dEaMBiP913c//SUnaYbUcVKWQUdZagllH6YTKPIjkBRhDjKLBMsdSikpar4QklGAI6kXBRbqQpFrnRRIZslVpJ2RMOdyKLzhCyHolYWroUbarCaLc5T+KYo65/X5L7s44cfWD6+sNEmisZUuaJ55sBKEt2GxFsgKeDWMBZwM2ZA3iJRKUjS+YO0AgnXq3oe6rgSaImlRESeLxqoSVkNXIa64kh8/1mScfEsVCjAFI/i8p7AjmQiYEQj3Frk6dzTwYTxPpFYXtdW6jYq7lBo1pRaBKpV2oNoqtS+pImhaF+/VV1NLwkUNT858/vF7y2wh9U3rZosw8DPGYOnEJRS4d01GjDVjYQRMXJ/iQDJUOhz4AmoqmpeOPYWJtD8iquNrkledhlN+pc/Kj43VpWYqjtwAEAqYM+ItIfBc2hXVcuEuWEHyGMURDk99GUHNRi9IwocXrPStjYJedl8IfHgVJ3ewAqGa3Ld01Xig9tCa1oAehAGB57qM1C3ECAillYgo1Ms0Y5FfgpT1cuYDNj3qNzdOYeYrJRFFxjWquKBkoEQFoadEjjDuOHBgAsuP16CRgRIGuibHGQ22LLkDASbURE3mI1hUzO6yEKxhECGoJyIq8KWMQWNnqHKiiEliUuriZMLb4t0bE0CBBOn8gkBHr3+G9hN6R/VbvCw0UlAnQcMlbFDU19Uzah6Gn+v3tdVKUbS+UhF1eeUiW7ekCH5vSRExXk63hGgxB/rGujQyP+qdK8hzc1tD+u+x7UKXaP4YG0JGa0pkafJoFOGj7qaov3BAKC7SwnLO3tMUGWvTRVdnefff+MDnXdbQyo/DOSxavWbjykcWZNvYRIcNEdHWKJEAxtmjta91RiJqTdudIGui6sq9rbjOPpQ8pr17qFmNonOjVktXtkLPxoUPF58mbWXZQTZtjdbDzVqB4Lb2rWptg4lbG9xuYVl7tmABqVYOs8P77PktuYCLsc6RDoe6BnpQkppIrwov5WOlv9edO6058kyRss39V3y58mo1iDtrb3R2VCzawS8msh02/Rr9bNMYcm7cgyXxoHRBrv/XNUJYmFY1hVD5M02Ovs/pbMXnMQ5XfLA0mc6bna5idFs6KgdRc7xq78i/WP0kB2P1k3sYNQg1J+WTXZ2HLQEwQHkV/CzHD5dPu06FIFzwSSvCQaCZ+M9fHjSWxYyt/DBGXWfa6HGt2N0SKF0VbqN8HSWgHdX9y2AMOjzqMa6qjtrLshgvAtGGPJAgYN0COZifRWu73QQnhlumoFYwh1pqF6poMZmSh9tQrs8vLvryNLf1/wKeCsoMidDgKZIwV2S+kBuHQj6w1jfnic35zD6URF+yT/wvRzhwhJC8tylukYDMtfa5P4NLO1QgKvFvC6nngSp2WC3MNuEDb+j/B2kaUBzQzxYg5FBAytCoe4pOjdSXkoVe4jiqAkfZolzBYnFOX8So8mKuHwQIk7479mQShGCq4LKCSgP7vYSfAbeT+2qhS7NZYUzeuSmG0YQL4g2o96KTkzSMUe596cJ3lqHTgXvR0Id7cH5qnZzfHljQTEaORtd6FcYYSSUbQYCDIi8sZ8+lfyPgav8WAMyj9ayIQBVMPqHrF1ohD3jBTYwP76zrsrAYGcUYlhWwMh66RQ8MA+vlms38MicvLxlLEejSLEa3D0Eh5Lizy8Kuu320uQbMgTYwhH4ZFVP78NDupaUImetV+isAQ004cw2vAvy/xlAKM9RRZilV1dlOcCKKEs6DMHic6fA7iQ6tMMFC1XRKi76Dr13FXyPljOElZaYA8W3uip8yKMBnjPyoXghXEf8EKyiLb8Msiblf4PXbs19+4GFtESn3Ls9+Pj5Fp2KlLMl20X7Qo+ruvIyilV/Mlo4oQi7m0yRmTfXs/Rq4Y3X8CV0nwjOswKL8KcI5DqiuKIr+9DRaGS3bNAu1LOEP2dEdiSDHMkqtANaOkhjjHnxCgAEzpiWKTHrh7BQOfpfqkuEtYJH5n1lk8/swg2BZSXDShYWy7QGDGbQEk0ZZSN9aPpRMIxBRyICVuxTnj2gyYzDfROypzPxrWJLJxQcsBr30AwzgQAMzcl1YSCYOcs3nHrTiVZ2U8ZOWreZWZQy2fx0I1DdApeXfQ0UenVgF6HhOzYZ+A3PqNCneIIVoMeoBLzJSXBowD9YSZ//ApKGSgwZWL+mNlykp7uoGOSB1GspRNuV2L9ib8/DT1HZN/XcrT1bVpmhHkI9mrda05sfUyYZPn/p7x7VfjZCIfHsZbxRwidmcuX1fJxz6QdoKTrPyPCrzpcFPQmr2Op45rQpGfbvVUQEjCuMbR6PW2MQrdVAagxyTb6bBHvJ5EhfiM8f4b9TAW8PVLWNCfxXmOUwnL7nRFngUT0wXQ/bV3uQbfzL/eP/18we72c/tZCIljmF4RZuGQk7ly7LAELInV2KzN08WqznzRBW7FrnySWc3weD+Lx7AqsGBKjKbgLvNK6s2Clfo1QTlsCKzrblYJqTGZGVa9AXGDnv8feMOwDyjCfQqmFKISg0uxcgOO+O5/TDJtP8c4P5gWTLBqOyMhvRxIO3dLvfVrooGNuknYyODoLSChf3QHjo4oQANhDVYQXCZ4EM5Q3Fp5CLYsXft0aHMfqqomGS1Oir5jAdczDwo/RwCSfoPlTKN71Ugw2nECMQEp4BEO1LC+6v5eOXLlhDk0QxyW2jNcqFEtpNBKgnxJ1zMA1oVLzHFk5IbwTLwhLEl29fcSMozPqpIQvjw2c79WJwegNlhX9+4k7/bcS4CU70yeEBvMRPWhGkaBkq5tv7ZEK4tdKG0heHEwtnk6jfhW1+hYF27CaPIgeJja6/pTOFGQRg0+7ghaqBVxq5UfRbdBWGeY3QEW9WSLms8a9v2BfsH2A08/yhiu6QuBtb5yQ9S8eT5vBEPbVlljL52NPykLitDRUYqCrsBtVPMYiHFx97FqqC77CLHIHr4py2KSnoqdqfI6bX99z37CTzPPqXcXMXQj2a/oGwi22WqyVZDNEgA9eO1Y5o30L1sPVat8AgvvUSJoxFhJAOAfp5bIp/Z6Up01gYbx9XzwjgsPM/JWTQfW18ueSmyCg+t5BrHEV6r9zd3+hca/TrP40MRTSCzAl4DO7aUWTnFscKZMGq3IXqlGDDxzs/eXxKeHc1SHlI0p5CaTD+6xzWGstnRkNyVGgn9SMoCSM4maXkdhfmSBfZDW8EjiDmsQh4jb9WLvRcmhx2OpMn3a5DaZqjfAEb1bHxKFEwiGfOGn/NwUWas6V/tQABz16KQuJNaW8IEYFnOre0jaCnJwj+4VleZ2EbWfsWAKzPrXjCyqZsm/pUIaCw8hBBfDyVvNdYYWDSMZrs14c8yuB/evP3Ve3f0+qeT02Pv5AcDRUSjTm05llkoAq7RZYxh/Rb9/zZ5Xcn9izKeXBrSIh4J7p1w2p0EHJ6MfJk92mZOFMQUDpFiDdOP5aKrYGhw/wMppgYydQwZPjJ/qLL2O8OgrbpG6w4fMAUXZALjwtomzmuEHReTt1QMh3bPNjj/8RHcvGd9J4F+N7WAIgfmhqmjDXe2sSB3jtQyPwnPjIxZilHw9jrwAis94KGRjbmjnYhWqVs1+0pOG90MEM3JpD4kQAdiMz9OYpBXkUQtKFdp7lB/x5TH592wdS5czDkD+eCD4M+njj3GkTiEkehOkxBD4lStPKs1I/D8PA3hI5NUCX/OPTI0MGrmrJrKIH77fdC1SlWUoT7rG8W0oIM+mwc2IkzZUbUcpqAk1HJ4HzoEAz6DmJt0Odwc1g7xqYEb6cEXIxTdCYVusiRDl6XBfYYeMxWdV04zycZo2XSIpE75gc8Alxg0kZZFNwiiPpURzrCKMF9ZttEPZqja5QqrFZVuMVnH6A1r1JgtV0ngKNKCzZAcvDDoMloV4QbWK20hRdBBYwZv9HnpD6n0qtVRrw9Mf3qMnLF1VIAZdV0WRqNHPv3LYWsVxKAlNMFtF/RWbLkeVs1lLE+TOGfOc5OCSeWwmFjZDAxiaOExCyMKkIY1ybdZLfTdcjW8tFUMI+287JhS+NsJEQ2tTSnkbdj9vo82BfUB47nYEvggFbqDhtRGw93pFkk5WzqUtNfNjGGXm8fcEd31QZtEW+6QrvWxXhOoCogVRv23TbR+tsOHRc0maB3BHFNMT+bxckxWMFlPvQ0+72owN8Qb2pD4eL/c+xotJ43AAllLINvc/2F6OsZdtdc/83ogVF6ixpCS38jEMlqNlrPeAPnfzC6S5ntAc0FmXpsWUBCTKlVYGxH0UTyO+DweSlnS5PhIE1S+YBrn5aoRf5SRCOFgCosOgKCSiLxqy1cp1bCS4cJCAAVjT4pkIhjbwi1v7gbps5mvn8ZJQho2/XAVu2y1oImxQy5TaxrtDUS7DuBuJx87NSvpo6ywHAvXn/v+5MfL44t3nWu40Q3X1SkuBESnZkkZ8fTqa+Vo3FriDxzXx63LMs+MZx0M9Q41Tmd4rF/IMUbqCj8rJveiCQzScZ/ZaPNSN2QtMZCp6dz78bjXt0e5KihE5bEKjlIkWioGL+vKhFPH3hVW8kRt8kH3H7d/Jq1vJi/VU3xp2ojXnEb9PrOW223w/DY40DpYAZ8nusTkrjxM4Of7jkVamZDONCX/kvNlobkotGUqByc2JhM44PJqSx0llB1qkOXq48eBARYYhxR4oF3DjbZV1li1s09ujDZA4hjRzkC+z33l30AXW4xFHgQAePT6Zwv3wftZu4+NTRFqT0SDc0k9bjGn2LckbPf/Wx7KLmgdwVLMT+3aYGKeAhTBbUcZn1U60FaLKN/kpFL8xV5kvlfp86yf6MVasQKoqNL1fs8dwSWg76BFfsNY6l1Hfnzj8W2WHeYIPpzFBMhufY/MNNwNIIsSje4p09V+QDJGlH8vP1/xLx+5/6vfQ9JO/9Wy4eppwDJTpFt1/IxbjMzkF7uiN+0p6oTSb8vobfQc6LFpX4zp4YkPIj88v2qP1dXex4/9Cr9HyX5eK7XB4bCb2+FkQsZjjDpxJozm2u3fqzZki9TQ7UzU35r/eICj2Kj07A0pz6Vi5Xy5XKekjvi48POUnF3yuz8GmPLkYFxVHY3T4xc0gAJqsslrHntExOIEtMMkY5sQ2mzZqKJ3WsYgYbidI+9nthZ/IfG29+aZNq1WZyrQitM6gUc+Bgn+ReehYtYvF28nfBN1LvZ8ZiuQdX/Az4DWigWqInkDnMyRwOPVZvxojXjhWtWpMpTRy7MlimSWRDI9WORoBw14cr7yxGEAnDJKvaCtvICOj7m8DlAgKinKlK9X6G4FqT+jU94a4OY+ndmSJeViiS1jql0ZS5zmfH8OnxR15UdmTynZxFNWcYyKzI9zTAEhsedoetComXouHxK/HiY4KnhOWzR31TYuuSJbzFOgybFSR3rabhgPYxAbefG8H6SAOQxXhzVuQWpVMuakdlrGj0O/aT21oHTYp2J5qMDNlmV8U1NOBk0ftb7whvlOVZFKBR2gNCRjef3st57ymDUDfByEuONqQ9Ke6Ht7d6IicZemhgOvMWKPs6s5Hgq3Dk7VHxOnNZlKwTODeaTDpda9x3UCtcoKTMf+ujozWBrk/vJyWKetvE39uQb1/6bJ8M02hSJP/MRPBGi0oRUwRi30KTB0XUKHqjr/Qy1MyjcnT+y0COh21kUzjiJNwq2DKvX0JIXtU4MrT/WtDM5V0ojx6HwlM3W2c7n0a9dD5oVZt20yarvUI1OrVB4/jE0E+uXmWN2jeewzB+7+3/HWF9aRNY8YQxr6GW32ytX2thkQECewH4FAyZI8t/LwGjVBvnnMAAymfJLPfNRl/SAI+ZFPoIXy7Z/VSS94VBlmJQmrO1z52doATm07Y3zTGYUboLM8ruPnuPVMeLyEOo6bauh4FwM02piDYGTMaYae/ixXsSgG/wPmfNRpsyr6Aki1b8OTA4NhFSO/dHnEuiFVvtUtHGImtqrhpq9PdHJjo7Xe5QmfJ7p8BU7dOg62rmPcp8507KfUq6tdS31wam0OyJHq2ja1/wK3TTUhDUbBmMet9UX3PT0JlnJ6tE6w0Z8e/1a/afzovE98uvWQbfIhkmt+ON9jQtzNun9KTkSjkf9kRQyGIM9FaabViFOwtnLmNBSGOz8XR7gRyG0VhkdkVWydUfHnZVN0k7uFoeTO6syz2oam3tST3ug7duApsZA/PfJe6bYY99kV+0s7NVu5l0WEqIdtvRjIPohNJTtQaEj5MWQjyvOXFdWXgu15tGOo51K138uzrYb39+oNy9jZVk0+05hwc5s1FgPhy2ZrmBpDhJkBB6MT53NuzcOnb3ve8L14+GhJUNpRkYBEqsfYpW6NUWe+WSBsOJY5LMq9pW3d4pRLuhCkSFaYpg2avdg+Q35gOm6cj65J/z6yRELuboBnPuD2Pjy8l2rJ1Cl+HmTGcSNPhgFQwbIVoaUcHyg5vuVHTHIjA4MjYSEG3L8GOxc0EpOJ4QurTh5WT3GMiHIQeNePz97Is9bxYIXtWG+QdDNJhM+QJNPpMeBb93T3qeFijLY4V/fEkKNL9+3g2UCLMvLxLAug5ET69rmtx1dcCuHo2zTxMc4sGZXAZH7C0Xiwb2c1l/aGAvVBbeZ7BVtF1c0JqoXmYaD4yFnXOvRjbKmJeMH13yHT0rAxsMoJaHnyQoyR+Ld+GGG24mBZ2TayFDWfyc62RU8myRDmngjmmA7XMJygLClpPiN1EBW+2UQFPHZ5MAF0hPquJTHisv91Py7qvpJh6Mwjn85Nqh85CHT2iyJzkhwaqw4ftFHqN08g3DxZjCcdyjEfcxS2iwr9+Xxq7Mhjj1jsBSqfLc9hHEqqP4lkPaSTz0Z/St8Zkn2OhNrRkpRrpU0oeDWsbhgnzbrwalhdmrWNyq1jHftrf98b1NnaydE1kP3HDjafTdbxwOyQ7TJDklnB8CwYwG3VgdvA7JA6iTsmzNPTQwY7Cgad/imfjaeAyodi0o88DVQ+wltBoPpzudrhxRYp9NQXgtjHYI1TQA3lpU7zKkOX4nmYStXlNT9LEXjmAg9J7FJiBBOb9MxmYJ9rmTyoqc793aBVklHGNUqpQ+blfB5+kjf8cGtlIs+SR7ukpVSakyC3yH7sSmdM5nN4j0xMh/XwzEY8jaNFJqQ+B89THCmpgL/gRxpLyOqmi+31JjSqqzO3OOOqXGry9RO6ZK9xfActzryWJ3bd63mAovuYCVirQcBNFXirrfI+4EzqyoYgx9tkMTmisobAgvLXNQ/da4Bsdbndxo/VcWXYTn0kmoxBG18qEoHG7OezMHRGUj2ufwzYLFz5kclFuWlExfCtStqkZPkAPZ7EbEG2DZppbKGOndwwpgLvaqDaaNe+PQFrgqMhnSZ5+CiEBZdwd6M59nJAsRdesMcFuQll0VKF8/ufjibPXx6IY4AHY2xkyRb+bWDNM/hMcOpM+fi+apht6wUT/Mh9XhqXj9rCQBSqeKq9P5iKfTe19ig7nH7xu3GMN5lu7qhxVcTeGz/MOzn2mhV3jMUgsnHk7jsxgoFqQe4k42brhx9l1JWSSBYRWUGfwZKreq5idRRHGcYFZKZxbA3H5VR+FWVo8bI9hhZdjMT1doPSbzB4cXWGPmGOR4R3G3UoFm0qKOUa1Pqh+mtrtXgPWAmVuMJ8qDrcqbttWJXqx3KarZrPjgEq7WFchgWeFm7v25pU5puK9szXJQ1W7Fvl+oWo4cOz5vmpXSxQ45cOi6IrFiYE3/capz65GaN3nOYAmEuzG8uPUINDdzmmzfBTl9kE6DDJ2CJL7mjTFChaE6PJgzvZ1IHMSqSlSRTlrvWBZeF8DcucUcM2wKr5xHliIeWS40kq34qTpQt/nVtnzv7ISpk69rJjl10A6iHeLD5T/AWDmFdZOEAizO4GqVzIPdZ0IrS6F6oxPpwnzUPCv3m0XZXnejqwIIoRnVjma7HNIycEWc7YjaODNZcWJegAQTrnhiqTPala3wxFXFisAyODwgiiLw+kc9o3DuCptaSfwSP1rO09KpvnBD4bp990OmD+Dc/I+I+k/3dKelOxLkkINXGmhrFGdTVlv+LqWhuiOroGq09E8R6NSOOQgza0z+pkawM7IiE6uUD3YU5hfLqSZEBVIyUVcgTQxr3gXO7cczI8TO45VfYfdu8rohoyUrehRHPvmPk0ugHzrIf/H02Rz8LiQ3rz1s+LybskwEsg8JQ0KoEuLI+2I2LEMl7Uw2T4oYtS/dNGX4L40Jp09sozykelVWSQN1Tei6SvXNt4QjffjUStdHpAe+M5Lddox8VI+DzV5bkZ1a7rl2peUmTsFctzfyED8N4cd/cV4oq0Lweck6uLTH6zhscP8Z1al0scIcABdxWSQ5Uv1TAM9qFNF2vTxSthHFQweWW878ZQ3TG8a5BH3ODjzf1VGK3JbY5HmrlHb7yT0+PLg7pw55YbYY1o9J3egQ9oxHwTC94ENFn5dNHpLApxAySoAkl13fEyySnVBS/rya2gFJcM14HRkQ3f0i1FYYFNy+uDeFiXAIncWFBz0yy8xcwRpE1b6eze1UXygRMBrxqCv5IUg4305uT8/OLs8sw7Of9wMLbUyw8H3ocDDA638n7wGRKDxDMa2/JEJKLpJNd4ssE/HUygsZq4Ml7WcRzFUGPOW0h+0BPludGS/fidPnglUeNmkOpd7Q6h6vXIUBRvLMKTQFY3QZg5/Ic8xbPj0Bl+H7c8FhLv0wou5VGBb1p7LzFCOrXv7DG/aqXZsDpCcm6799pX3ODw4NJ9S7gpeFo/+Zui1yaviZCu6jIUTmE5ZkjR9oUo+mmXRDYBpHGJiyylTmVsElZvC2URnlMiL3biJ43v7ezshHjmN4L2PEr78zwUdp4nkvBa94Hw66NGO/8CVcMeWw=='}
        source=lambda name:zlib.decompress(base64.b64decode(capsules[name]))
        self.machine['config'].update(init=dict(cmd=['bash','/cloudbench-boot.sh']),files=[dict(guest_path='/'+name,raw_value=base64.b64encode(source(name)).decode()) for name in ('cloudbench-boot.sh','cloudbench-status-server.py')])
        self.machine['config']['env'].update(CLOUDBENCH_STATUS_PORT='8011',CLOUDBENCH_START_BARRIER=self.fleet.name)
        packet,scan=self.runless();scan['boot']='00000000-0000-0000-0000-000000000001'
        def role(pid,birth,argv,cwd,exe,group):
            row=copy.deepcopy(scan['processes'][0]);values=row['stat'].rsplit(') ',1)[1].split();values[1]='1';values[2]=str(group);values[19]=str(birth)
            raw=str(pid)+' (fixture) '+' '.join(values)
            row.update(pid=pid,stat=raw,stat_after=raw,cwd=cwd,exe=exe,run_token=self.owner+'-0',cmdline_b64=base64.b64encode(b'\0'.join(argv)+b'\0').decode());return row
        scan['processes'] += [role(613,56,[b'sleep',b'infinity'],'/app','/usr/bin/sleep',0),role(862,405,[b'python3',b'/cloudbench-status-server.py',b'--directory',b'/data',b'--port',b'8011',b'--barrier',self.fleet.name.encode(),b'--run-token',(self.owner+'-0').encode()],'/data/repo','/usr/bin/python3.11',862)]
        past=copy.deepcopy(scan);past['finished_epoch']-=1
        prior=copy.deepcopy(packet);prior['scan']=self.save(self.root/'prior-scan.json',past);prior['ssh_stdout']=self.save(self.root/'prior-stdout.json',past)
        prior['command']=shlex.join(['timeout','--signal=TERM','10s','/usr/bin/python3','-I','-B','-c',source('prior').decode(),json.dumps(self.binding,sort_keys=True,separators=(',',':'))]);prior['ssh_argv'][-1]=prior['command'];prior['program_sha256']=hashlib.sha256(source('prior')).hexdigest()
        packet['infrastructure_prior']=self.save(self.root/'prior-packet.json',prior)
        def identity(inode,digest='e'*64):return dict(device=2048,inode=inode,uid=0,mode=stat.S_IFREG|0o755,sha256=digest)
        roles={}
        for pid,path,inode in [(613,'/usr/bin/sleep',70),(862,'/usr/bin/python3.11',71)]:
            roles[str(pid)]=dict(uid_status='Uid:\t1001\t1001\t1001\t1001\n',exe_path=path,exe=identity(inode),proc_exe=identity(inode),fd_links={},unsafe_startup={})
        roles['862']['fd_links']={'3':'socket:[555]'};roles['862']['script']=identity(72,hashlib.sha256(source('cloudbench-status-server.py')).hexdigest())
        scan['infrastructure']=dict(roles=roles,driver_state='exited\n',driver_pid_b64=None)
        scan['sockets']['tcp6']='header\n0: 00000000000000000000000000000000:1F4B 00000000000000000000000000000000:0000 0A 0 0 0 0 0 555\n'
        def publish(value):self.save(packet['scan'],value);self.save(packet['ssh_stdout'],value);self.save(self.packet,packet)
        publish(scan);self.assertEqual(self.invoke('runless_current_os'),{self.mid:self.vid})
        for mutation in ('argv','script','exe','uid','startup','birth','child','state','pid','foreign-socket','missing-socket','extra-listener','unknown-scoped','sleeper'):
            changed=copy.deepcopy(scan);server=changed['infrastructure']['roles']['862']
            if mutation=='argv':changed['processes'][-1]['cmdline_b64']=base64.b64encode(b'python3\0/cloudbench-status-server.py\0--evil\0').decode()
            if mutation=='script':server['script']['sha256']='0'*64
            if mutation=='exe':server['proc_exe']['inode']=99
            if mutation=='uid':server['uid_status']='Uid: 1002 1002 1002 1002\n'
            if mutation=='startup':server['unsafe_startup']={'LD_AUDIT':'1'*64}
            if mutation=='birth':
                changed['processes'][-1]['stat']=changed['processes'][-1]['stat'].replace(' 405 ',' 999 ');changed['processes'][-1]['stat_after']=changed['processes'][-1]['stat']
            if mutation=='child':changed['processes'].append(role(900,99,[b'sleep',b'infinity'],'/','/usr/bin/sleep',0));changed['processes'][-1]['stat']=changed['processes'][-1]['stat'].replace(' S 1 ',' S 862 ')
            if mutation=='state':changed['infrastructure']['driver_state']='running\n'
            if mutation=='pid':changed['infrastructure']['driver_pid_b64']=base64.b64encode(b'999').decode()
            if mutation=='foreign-socket':server['fd_links']={'3':'socket:[999]'}
            if mutation=='missing-socket':changed['sockets']['tcp6']='header\n'
            if mutation=='extra-listener':changed['sockets']['tcp6']+='0: 00000000:1F4C 00000000:0000 0A 0 0 0 0 0 555\n'
            if mutation=='unknown-scoped':changed['processes'][0]['run_token']=self.owner+'-0'
            if mutation=='sleeper':changed['processes'][-2]['cmdline_b64']=base64.b64encode(b'sleep\0'.join([b'evil',b'infinity'])+b'\0').decode()
            publish(changed)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.invoke('runless_current_os')
        self.assertEqual((self.registry/'runtime-evidence-unconfirmed').read_text(),'immutable original debt\n')

    def test_runless_collector_performs_only_finite_exact_gets_and_one_ssh(self):
        import hashlib,base64
        packet,scan=self.runless();self.save(self.fleet/'_batch/lifecycle.json',self.life)
        receipt_path=self.root/'receipt.json';self.save(receipt_path,self.receipt)
        ledger=self.audit/'fresh/cloudbench-owned';outer=self;calls=[];unresolved=False
        class FakeFly:
            base='https://api.machines.dev'
            def flyctl(self,seconds,*argv):
                outer.assertEqual(seconds,20);outer.assertEqual(argv[:3],('ssh','console','--quiet'))
                outer.assertEqual(argv[argv.index('--machine')+1],outer.mid)
                calls.append(('SSH',outer.mid));return 0,json.dumps(scan),''
        class FakeAdapter:
            def __init__(self,fly,journal):self.journal=journal;self.sequence=0
            def request(self,method,path,timeout):
                outer.assertEqual(method,'GET');outer.assertEqual(timeout,15);calls.append((method,path))
                self.sequence+=1;folder=self.journal/str(self.sequence)
                data=outer.machine if path.startswith('/machines/') else dict(id=outer.vid,encrypted=True,state='created',attached_machine_id=outer.mid)
                if unresolved and path.startswith('/volumes/'):
                    data.update(name='cbs_owned',size_gb=40,region='iad',attached_machine_id=None,attached_alloc_id=None)
                raw=json.dumps(data).encode();outer.save(folder/'request.json',dict(app='fixture',method=method,path=path,body=None,headers={}))
                outer.save(folder/'0001-wire.json',dict(method=method,path=path,status=200,body_b64=base64.b64encode(raw).decode(),sha256=hashlib.sha256(raw).hexdigest()))
                return data
        plan=dict(schema='original-isolation-read-plan-v1',branch='runless-os',root=str(self.root),fleet=str(self.fleet),
            owner=self.owner,receipt=str(receipt_path),ledger=str(ledger),binding=self.binding,
            collector_sha256=hashlib.sha256(Path(self.native.__file__).read_bytes()).hexdigest(),
            original_native=packet['original_native'],original_state=packet['original_state'],original_backend=packet['original_backend'],
            files={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()})
        real=self.native.runpy.run_path
        def dependencies(path,*args,**kwargs):
            if str(path).endswith('cloudbench-archived-machine-reuse.py'):return {'NativeAdapter':FakeAdapter}
            return real(path,*args,**kwargs)
        output=self.root/'collection'
        with patch.object(self.native.runpy,'run_path',side_effect=dependencies):
            value=self.native.collect_isolated_witness(plan,output,fly_factory=lambda *args:FakeFly())
        self.assertEqual(calls,[('GET','/machines/'+self.mid),('GET','/volumes/'+self.vid),('SSH',self.mid),
                                ('GET','/machines/'+self.mid),('GET','/volumes/'+self.vid)])
        self.assertEqual(value['schema'],'original-runless-current-os-v1')
        self.assertFalse('qualified' in value)
        calls.clear();unresolved=True
        self.machine['region']='iad';self.machine['config']['mounts'][0].update(name='cbs_owned',size_gb=40,encrypted=True)
        self.save(packet['original_native'],[self.machine]);plan['files'][packet['original_native']]=hashlib.sha256(Path(packet['original_native']).read_bytes()).hexdigest()
        with patch.object(self.native.runpy,'run_path',side_effect=dependencies):
            value=self.native.collect_isolated_witness(plan,self.root/'null-collection',fly_factory=lambda *args:FakeFly())
        self.assertEqual(value['attachment_observation'],'explicit-null-original-quarantined-v1')
        self.assertEqual(calls,[('GET','/machines/'+self.mid),('GET','/volumes/'+self.vid),('SSH',self.mid),
                                ('GET','/machines/'+self.mid),('GET','/volumes/'+self.vid)])
        calls.clear();self.machine['state']='stopped'
        with patch.object(self.native.runpy,'run_path',side_effect=dependencies),self.assertRaises(ValueError):
            self.native.collect_isolated_witness(plan,self.root/'stopped-collection',fly_factory=lambda *args:FakeFly())
        self.assertEqual(calls,[('GET','/machines/'+self.mid),('GET','/volumes/'+self.vid)])



SOURCE_REFUSAL_FIXTURE = (
    'c-ri}33nq$dL{Z-FtVTRKGQ_SzNnA<MsAm<<>{7WNuKxSb@kziwF(vq&;VIdO;7#zcLNIvk^nNXXBDHg6bWQTMn-(w{q7eLfBj;d'
    '!e|^PUwrx3FZy9LyiLE}zKZGQYV_gaW^j|P2E+8q-QK3_o7>4N%3kGBxSOQ-YH~gLIlUUE|GZ0++x~w{M#C?@{Nk@~zPQE5!#7`i'
    '*?aSaF~Q5I9ifzq7`RK$8Y5B;#!Juhn=gKgt0tqnaY*G3-2E=OIJ;Rz@2pLRE6!=sA_PZLlG-QENV3^*M+4Py)<_(@MK@-5>gcF4'
    'iju4qQPkT&iDF54t{sn7$t<$O^Mh3+Fl_|4k_9wNd5~6%H(z`#O}=%vY1ZKMRcFr$?^5`AQa=7OUKNkLxOS7tg?pQZw-@8P;RRV-'
    '=kV1i&TpICxL<}BlRH1Vax(k$#*N+8Rl2&k9gVIo0)C!<;a&Lo?Ra!IjPsVS(`165E|z<8<?dp-2zbWqqWP`k(JzxUUcPeH#EtuK'
    'UH+bSdh%{`v+B!9y1l!(7^lhI^~#$E5ppoPEk8Q%hH*5!e)eQP7+t5^@gPhten~z;ygsaIYM6exxGUHH2j+j6K0I#3-QB*scw0p4'
    ';s)aJ&P~#a3$D|($Io#v2^g&9OaC$*^`8efleu6$e)yx#PrvV?6n>n_;mz!gN}F@tn+w3*<aQK4TuyH91@+ZC4E-xV`ZY~njYpI8'
    'YOO|x58*0JwRS~gmy>snNi}QJsT3LEDoN`tb5fJYvt&L?Z(=Yy(P%l-!ecmSR9a={6Twf(d7GJd+&)y~c5uBI=OX79X&7Ji)A0T5'
    'aZz%fQxr4_;e@j)D3yedIk-eH55YP^sCQ8@#)Ng0yG(>7BnD!AW=o<rS!$MW%!icL2$FcDjBAr!Bn+Plm6M5%2c@~tHf5P@^wb9#'
    'tdU*{eCeJw+xKZ0-d(%#&lkluj-bi2C&9dN!mTBk(PSO*PG`<NY+#a{2r7Nx6y5h3g5(r8L`cD$i_$^97B7&;n7AiH6B4tT28pg4'
    'PS8aLnF%TAl(WhtXrq)@QAiAZ@<eE(4NEa|M{<nH&h6S_D#E+LRlG#&gYknV;Oj`O3xY{%iPk~b=yc$bS!-F5;!KRDm;xsZCME}#'
    'nPW6k7YLI=>RJB>lhG9<DPF#JSA*zo2cxM^`14;re(~F9ekNRv?&2#ErGmFGnOPAbL&9?^(S75DAU-lKk~K+ao`WV1Qznv!B2j{0'
    'a-{iHxEl1YMsMMUzQqIIr(ST^H*WBD*lW~_L-k<(z{#TBeOr7pJmPR2y0fp~HJ}h5mV$xBGcE^ndwQsGnR(S)H!d>f=Az38Qx}xt'
    '-=7Hml9Mlq=^JjLVE>iim$_@sgW+KEZvAcIOJ@2?5-IHRZN)O)P3Csk4Xzeu7#3~%DV^%pXc+FsW0-~y)6Yct@YYR!zMML!rO!sU'
    '?&|VCMt<_}*-digx)m)fuKP2FbTEwR*ZT+JoBOdH6GAWkgW&(Oo|Wg$zS$6{;K%#MmR~WrVMtf^Z&^feJi_ne%k=Bu_A*REn}_>0'
    '&jV9^ZK#rLyLq6ruM`}PS-$NTgh`iBf$;O?1hK_1PCE==&_`(bq^sqs`Rf#&nVRg2hwm>I;(4KYbV*Wav}PByKfA9q27A)dwRTo3'
    'AH<?ReVeHxn+5duGq?!wXEyrDD25T#dKl+HuXmGovqqi`$s~*i1tk>mnvV5c4%bWH1!B#)GH(}YU0meRIL%_@d9=6G<C~dEPzskw'
    '>Aemv%l9|m{>u+vU%vj~hwpxvd#qs|yUU{4cjKvO-;VFnto!5Z!4TTI(5LLKCJC-|SsB?{Wn@p4@d-3IodRk?)HVvpza+9xBq7E&'
    'D<E{I&lEq10<zCk0oj=p@QK8oLh0lwl#Z`eI{sAYRs-;p>7E5t*(wNOC3c|(h^3A0!L)OG7~SKasqXPJ>E3F=JB13`Q>dU=tAgUG'
    '3a-s|olXli@c(upC?S0<2p6J72ugY13U&}J6rZUUiZf~9TG=~+A~JpoMU-n5Q9f0~HreHMI=PH|_f|+lxFmWTg`{5!ib$4GOPUo@'
    'i#{~|Ao?gjQ+<?Y(#JL;cnZ~2r%+9`RyEZ#Y`B`#IhBVr6o1HeajJxtL9zsG5vK~%C-yKJsXkMUROiBot0nIQO2|)=pwVlUP(SmJ'
    '&neW?DPSR2wo^bR`-&RT3Mf+3HwRHa{h6wtK9@s$E_0_)y_2MA%v#kmPgQSYslv&WkSU||c1lQfpHU;NYNLdt&+TDwqWMhK(40vP'
    'H_G2B6!IiV8@pB^?Pi61ULJHZo#b39vK>^ErmuzNwnb!WDS}va5S6r_sY=>TsN{1AJb_k<lSHVLtW!%$Hml{Ps=U)FsAb#Ii-Pop'
    'C6u;tnwIyKq=(`6$>*t})Au^Rif)p|Qz+|6(yerD^$n%#@Z{RU*pum~kd|$!qn!1rRNSx@I%;H}A4o+%(;6H~&x|kE%HSz9^Ca0;'
    'y0#RDvdwOEbw&Eglv6UR#dfGu$i6W|YTiOQx$P5nnB))rObc`<>x2VcEr%yiP<fg-cWv1Y<?CGM+T|dp(@sOSs~zB9GFI}rwpDnm'
    'W#6g;`OeR@gopAo`_8pOcna0jCsEC{<vdhuRL%7Zu}-R_MjNqZd`m?iI%?V!_)w+$oE#=`OFz>JA1b<_q?^U@1nR2TanyDC%rOG^'
    '50}$h%Qw@sQDW)xK}9ap&8Q4aaV%DFMbva93{^reE-tI^Mt8T%@;$t}x_bI``Zc5!Q@roOj4MuVcz1(2dp8>2-mgrV{d#XY!u>*&'
    '<stabyL5NIbSAm74sEeAX7(b#-lS08;>m)US>e%>i^mB)nXLbKruF5$W+OLw=f?PWFno_VYc&2aUxpY5V?1;I`=_jhv-i7LdcSG$'
    '+nv8ER&ZHFmF4>5g9J`)3&}AZjKkHCJ=Onab+{Q_4Z?gD($M*P*D&kl{c@@4Tn5<nyCM_QwNww1a(^veW3f_u`9-FZfR@tueRH9i'
    'W{=nd50MS;R_mB1^E;IJxS>i^+H%!G&(>dLsQvgUE&h9V=P!yx+$=5sgN;7U%D-ZsAW7FZ+bsNhSmKR|ykEV$7>W5ccZ0=Z>gh;d'
    '<g1i!AEbZDd6k!&zVKoN`I<7x7VF#)gHS4rZc$_m$j@dePMBvn&9qqHzP$SHS%2C_T2sMYUb=LkmiWP15(jHZHq2YgX4Jttqz~4T'
    'Iao{fP%RY>>p(3XOu*^E1e_jB!0BEBK5c3i{oaRVvtQS)5+1ti)Ml0N<?ybwv*_`LhS}4GpRagq-xz<|*xHp`?b{Sj+uXD?rG2yV'
    'X|pX0?b|;=Jsa7z^}_8N)z7-Uvi`AsgXU?2O;ug(o3@*qURj^gy7dLkzOMBKn!WvV=(-W##1OV`o^5`OwKPZjC-8MIuqjX5zIm~+'
    '`Nmw+qX+%v<EI%#UrbS3nC_f%0Xx#a84upO+q4v2FVGyrGv$o+e%N~p&6>!$)Y`|ar3=BD5Q8^V0R08IK;UKbuSfg+Xqt?ntnBMT'
    'sAmB;_(XF8S~1c9=ul^^*VM3}0~0zb{Nsc4B#EfFd-KI7HQ<k#Sq$tr<u7}!^FqTO{xs*Pde@`j0Eql#JJFO~NnRD8QC4(ZKw}9r'
    '7jqVN*6GnN!!-V~r-RO=ZZ!ubMdsX4DM;YLYZ-(i;di~c;PoD&j$RzNx5Lro7KW;aIORicFznsF8%%n5Z0|ms(tk62bH|h?Z|-s;'
    'xwqT`E=dF6@7_<ZfA~}H9~O}NH=ovqH;=d0cmcu#*R?D>o=B;crP^yFvayCbDRbHN%nMF5*-v=zoDwvC*}J%y=5#J@#v`A4|1c>Y'
    '^0w#Qcsxks-}Z*1-XH(?r{1g5z~w!#|IMc}yp%``uQi16N5jhvNs-tX6AL0TJirnm5Ep1kLlWtvy2*dD-7V}(u0Bz9p49=o0Ckp+'
    ')j4O8646P!<V9l2a-X86)EFtfQn~tq)=P+9fbeknNO)8%wY<iZ_Y#I>W3+cdO5+p)NS~_kwB8`$1qja*Pp6qfYr+c}5q{dT3K9-3'
    'AgCxiWM)={r}Z8;FChxGkAx>0i;n<FgN?wW!bYM(EcVEIm$a(F)4ICqCB!`Xk?=^$qUO3R-pqn~X=LQuX_AQ4G}?-P+wW}m5-iW-'
    'm?tGf$VzZ0lonY-Zfs881|SGSlap0=S}*o}2?6tCw-uB~N~TPx3PL5}q;tt-i5FE&WLt%&^|I8LkhXmc)hS~N!Lbxp2O)iQ%y5rZ'
    'gW*IV@TtPndi$%FfVQ6G{Id&=IvJP?LO^hIi~#DHp=HhEo@i@v@3eBNH!Hg8Jsbnjo7LES*_#aA&E(zawl|1rcsscL(7PT?CWGPI'
    '9>y%*-Avi9^odHAdMQ5bNd_?y6&<J9M2$wB%T#L?S+vZ@#7Q+vt!wCCfbb~xM0hfMTFAi*C%kkf2az<DnJDLcs8Fo^CIBxXAbOHP'
    '^gv=Z<Qxq}P-MKclDkMuIey1`@fiuvCVKYOrFXaCUAbmW9rik2_lupjdVSb!;lAFmRYBqAWdOM4$&!<41M_!StWzm7A1}wF(e0z<'
    'D_4V@rpH^AwFYnJU0Ey%dGp1`V;(`&W@_&Hw=_ZSE@D)d%W#->nVZaYWK<Y~Ho2rpmX#Y>N8>E#F>9ZN${}*}PivA1qh3;}xtkBO'
    'ySp7tf-CbjUqCZe<Fvd6YrdH0eHst);OR=A&GSAD@h+ztc)47A)KC^M>)X3Kf4NlTbh(hXrN{3rw|J?^{OGCaqLE)l<DVxtE~Kg0'
    'tX}SO)B>h90y3YXg?O~qsq6XVy!qmX*I)m!Ncwr-BMv4vqe)rCb1@gPC5fLF30^LQZyxzSn*6C)Z6i?gv*j++`+_Ji$E#W`%Z9Gq'
    'd`Zf)4qm)p2-IB&X)?)oSBoR-%7VKz9xqAgxx^&>n!??*F7ReNdY^`+IDBbjJ?vaDCA%D8h_}guw~Gq&=}=uR>CmG!u2bc|nB8$d'
    'ZoqkW_e)Y9AAI%Zi=~}$F0b9~c<}2ZlPB@+feM-#W0?t}M8xl01&cSAEC~mH9->T)iQo#mY&?xQGmdv)HqOttdt^m93j`8lyl2UB'
    '<9H;hBubQmF-5~EImxI~E@t7aP%?2Tl}*uUg~3`JnfG7@7pS$}7%i;>UflQ~VoUvud;VFx`sUuO5}f<)JebCtqP>r1W;hz2(JVf6'
    'yGYK(Omdb4zTvHxZdy6^`-|OfArJ=qDqa?&eRcU@y2q)kWjtSya+};Z!t`ED&F|#h;O5mVg@d;kB64|j)~~ynFTfkR_k)XH5INsK'
    '(y#7*eYCSQUTNy!Aw`SjcL_EpIU*d3nbXLk;8bTH9U($6J0GE$k4VG!mjSwShltJ(hH-Au|2l6uZQt(T8k2E3T?9TG^0$M@E#mxq'
    '^`So)y;}V;UoMH%FK&E&F&jZ*FBp}SO8jmZK*xWZ$<~)z1}-Gg-av{FzgYoXYZHvF$1f_SD2R2GTA59d)+4;*xHicwqe*5_#1Fx^'
    '%y{KA27Xx>Qo@3S2aLj6Z3&H(rO1P4S!CfXqlzc%l~ze4>T*Ha+GZ&Pd_lr!%$Jcoi`#N^oMdL0iVRjTC~JbVNe7K!)GwAt+<drw'
    'SHiVtoeI+Hlo>osFe&MXC(EExR6L_Wmos;sDPyfE`Jh0u5Sc5bxHO1o?eZechslw+&!I<w$lzoQ+yri8IZr7{nx(=RN8&A89NPR$'
    'WR_K3AX;X4lR!L&EAT-X!6X+n84`*0LJ=3xBxmTWjFBl8wAGYT3`SDysaQU!?G%e#%%6F0W*)A5=mq5V>;L}x+n;{CeEseJy!<C6'
    '=4JPIO@a7^dT*&B(UR%A@m%~;fZGa5XW#)0u#cE>?`4$IYFXr4vw1!LKYjiC|MB|Ue}2+5ESAF%0YAiOv@oz1(h`no;66xdgK{1p'
    'J3*Z(q8ALlP}Zqvlp~9wooUVT5yuCW^uZ88e2Ll?0Y9OC()5Sd?5Cgp&HS@g|MtKB>Fa-e{fGbWr*HplzH3GSbeHgCx1%t+dS>?L'
    'R%?3I{e)b*@NO`Cc!r5YM4l73iAVGJn&nkiPg`xLDKAcWizQun;DL+xzP4<-@O0>v;c!whOUTP&=;xQdA6?yDKU|4lFW>(%{BVuu'
    '{XEn^o9pZM^Xum^)x)KeOD4Y8SO1!BzW)BZA11&4DnIzEf4#X!gHwn*Ux{7T?K4A_)lZ<}banoUPK*;K=lX;GCH?Q~Uq(`#FC<#w'
    'rAtT$+%vwo|8DWR{pn5x@Ysuu3Z(8%x95iQ3K8a{KZp}_vvZNpG&_TiAuxXT)$`2f+rjOtXSis3&*W7javjc$=vRB^dxqT^w(E53'
    'FkEwu`ij08K1&pR)jTk><j+@Y*P$Tz{Ax|yIeeVwc{XQnhO>mxSL>DL&9LOBW*LG(317b&<E;ioSktdA+|FM2;&$wYlZ+q6=|ArV'
    '<HdcmH_d~q^wmi-<(GK)s~OU`8VrBFm~L`1?i;O4U%@wcnY9ijeo~sG9EjEUE)XX&?avY}OZ}hCRMUO4J8m#llp+FF`u>C2jzndU'
    '!^QN+FO|zSAXc~t2r@2&68gdcW?djYq1G|0yw6`!Wtd=M-i{l;U4&0xB`3TAif3iXm2ukPfht=M2PzO5c}R##2Jxcz4tgP!1GE>0'
    '!oz#vl*hc!!pjAgSu_k(2e}d{>kxI2c)<{?q(o}N12q{iB1n#C38A2wVnnSIv(i8}xi5u19kr+>h*{Xwee6^PffWQ+5LiKA1%VX='
    'RuH%X1n%Wrx5jRJJ#7u-+N;eP^4F06C5HTmQ^e&+z0>0ISj`^^!65|T=IwHe+ezho6XE9yINK`h)&1rWli4SiWe6_kLvZr}2IioW'
    'x6%+D(-=%G=;ZPo&xM~_XL#q&g=HO|-Za9Zj3&2VQKtI@{}hQGK|YJT-@AmX!TYqzte*wb%Uw(O<S|P4o^0Ls^2+w)c4d3Y7$K~n'
    'Br44T(3q11fYOoz*f@h9pk)^=t%w(1>&($7>zv{|6tG0kS+>`-n(=^Td-C%s+mo%z_MYfbM@seN;Y;<}3DL_a)svrXsh)Ez6Tt;>'
    'F(gfbg86cqkwCH|xg@ZXGq}KK&lDF3{5W@pk}MeojtwhH^`sQeD8i`7&ML{JFd<_YoE1Jwsu8OPDW!7Wq~MkIl4xzL6^VI4g{Y-^'
    'XD`*0$1c^|U+mh4I$bQ!leIjrGBcH#smx4eW-2pNnVF83=gB?G^9busx4TlFCy!H}*N9dZ<#~JOb%xy;wl-W{^T2H6>SX2WDp&X7'
    '%k$*H%JZ7kv4X$~0xJltAh3eK3IZz#+_F5c(YbDo-S&Fg4&`}`ZPt*#hWxcWZy!ZGQF-2){qA?I39`qi30i#u=gTV%vfGsgc}S;^'
    '2w;8CnIY05Ni&3cp2p~O39=AkL|;@bBka)DMxICzUgF^hFwR*T)O5tc0ZW7I=TjPFTa^Z_R;P|s2-(9|2(^=?mr)^PKi|!~R9UrN'
    'M$XF+08bJDjI$QVwiInJ613+mWe2dYs7Q=@6&=x$k+Qr!t*8(Zz(_s_2l(%`0sKlT*noJ$7Z9vX+2|{fNTMXM?A(NhTLI`3l?W8k'
    'L#+@xdxela`et5xi`~|NPZtY?Y%LV3IpUflt~uhGBd$5(nj`LLp^*JF3x#Z#3x(`)3WXX$>!MI-?<~)-JHyt7HE14~jjVyKtU+ZB'
    'UVNdDJy@YolR8!qSV3R~ffWQ+5LiKA1%X=@3N<>{gBA)kK5d6Wp~g0A$X`SLS}3%SBA&BQi18f@g&03Zq0o&RJKS@1aXT7aA)dOr'
    'da1QS4-?a_Rw$wq0^y@{ie!@Dw3UKWmn1UuN}D8=B?uaoW?D0=A?cRE(I?8Jkqc*io?0Qz9EM7GL8C;hNDUMxiC{!_isQWwS1Z&c'
    'wVzO}(1U<%tQA_TQQasPdU%V&l?$~Krx#H!gyH>M%Y`z4YDmD5nFOX80t8Be$1lbLrg$ANtb_wy5XWc&7RotCi632Jnh3k1Tu3RZ'
    'bdmsBj0zc;NRfr;i1JqZ91;aUGYPV!l1~KwJPIycETC2+7OCYzXD=6eB=1Kl7usL!b_stvSTTg5t`$QySzMFFHCbGf#Wh)6lf|8^'
    '7+US6J6|!hy4xM87}^;5>`^h)h+7vGLwo0XhTR#qHuORBz-*!q7_am}r4L?u#ZU{2+O}e-NgXQ)tRS$0zzPB@2&^Emg1{{+h8msg'
    'K`VwDpSDBAP-B}l<gX!rtr*%z5zksNq;{<sQae@*Z6M6N3qQXdkM4$Xw!r=Z<1)cd7n5rU=SwXeQrnddQG}3+p=oUpMH(77*IsB5'
    '6e10Wu-2szgZG{qW0@maA{Z;j>6A?ol<-F`9okellwE)h%fMU^!f>x6VqA<V22JyL$igA@`4kSRR)s@tRI4L3MCu4NM6D$2Wz-O<'
    'O7zzpPtEbv98b;h)ErOE@pP2vSNjqDO3UtayDLP$Iug;}6kINd{=Jdeusg%nD(lxcFdMUes%HIa*6+m={pxT;e}g(!5LiKA1%VX='
    'RuEW0U<HBO68%lib!+Ul*VA?(`kUIUA%6||E78A?BA%1z=X6J+pVMP(4HB*}g6X1MJR>AuD7*hKE$!HScwuOk4Mrrmaq1CQd1ZW-'
    'aI!>&P!67!IaB<HfVq612-L`NL#%<8pL1i7oQOj3LbHibO6y#vTC-T<3?CCGhvWB~WcCx{_a6jgBfq~!pSnTmKfJ@?DE)TA^dcyI'
    '4DaW<EeP;QU{plmr2~Khk`FL+7%E^Ct6<+G^PVBtK<vn*11zOHaUXN`_#)92+k(JeI!Y+z7SW0JK6*_gekYD72b9b#5do0c$>~`!'
    '#9C)^*4~P;43DI`Ey%gI1$iXzN7)u+f3e#>^y%QHAQ<RcD^%0OHBDU8#5GM^)5JAR+{s#@)n2;un}V$Fc1LQ3Hby>s)Cx7C)<vz*'
    '-g%y3cZRJEanL+4n}`EWD{)YXgO^?_)WV{+trcog#|i=~2&^Emg1`y_D+sJ0aLZbuM(29aO+gx;wnME@W1BVPuOWY}71~D;&sr-a'
    'cdZqY$EX$Z<IyjZLYKbaT|geDq-C9uqDJr#If=|0t*NChS#-xz7G*%F;cZMpGU=m_Tq}}@pixQgZIafUvred-tOeyZr5ZsPmW_dO'
    '3MmaV*(aY4SSKVupE@DgZXb~6y3~;xA$j;3p>~4wGHQh6XImo_oZzCwCz(k&)x;=JQq=IY0TwUt%(zFGf;UK%MjMjPRw>4^EbDGH'
    'TTvrKf$<|TK1pr}50YUTn6ili<75Wh!${PgdIQLVU<6TvB$5j>?5Ol9)Ec3)*9ggD*9h$|cH4zKU91n1wLYk(hHGlLriN>3xTc0{'
    'YPh5ILGshA50YK350b~J4{AiL_w_;h=68nO8MZcLLG!?DBnxCE3o2Rg;_HLt!RmvW)UkrV3IZz#tRS$0zzPB@2;8zhsL{C|v_7cu'
    'X*<*hHMUtp{u=Vv`k;Lj@vQYhcGvnKdyM*^nKa+H57*`ITTI#o4E)VYtrW7`RSM~>p-Y@Qn-kTD8!Tdpn52aBhKJYA!I!XTqJz(t'
    '<xFY-817<BN;(5wK4Ya&Py)S3nIP5{2!5P&F1aidM-(oyJz%Af{d_8gY^zG4jat=_njw4mnxS?g^)hOP>}Ojuq$CkQJ6t1b!C&Z@'
    'Aq>H?ksfh|PejrfM9#hpW0I69g^@9mg$Tr()QXxRL>bgZFF57{uNxRCb`wJlsOG6+kua|mQ27)!38lH^h>$q93Sm<=wPxt-HAD8;'
    'HADN0-L7F!7psSCtsbh0<C-|GiQ}3$u8HHCIPPfmko`2PhisRthwO2xhZ?c#qIziWoX@a3!`6mMXdal2RD!KkLZuR3eD#n$SoKho'
    'I#v)^L0|=e6$DlgSV3R~fm>D&H9FUWRu45kZHMZi#x`rnUqk*{J+zM^p0j#L?0OQJpvSKsnxxyi8z|f4?)s%}H6*q?k_;MaIFp&g'
    'Or4L0A|!ySWk+LxNXn!Fq6-3?<l%d*qKVRAtw4CFGop@j77$U!l*mpBt6?^P+L+-ULlz7Ne6#*=1w`WWIg(7!9SVq^D^@pZh{O@j'
    'CTk~EFQSG>)FXsyey8SlYJR8YcWQp8=65<u@{3RN2qDqsBZS0}ju2`LE*B*K-neYoondQ}@oOHKO&LE?_Y<!fzZXyPi^Clu)TE9T'
    '1Xd7OL0|=e6$DlgSV7>HB!8oGJt)cF__Q5J{>C<I$X`SLO7icch-W4F`K}~CKR(G1Wxc)`-IgDncf&XumXBX5-Osn9`+bg<BkHqI'
    '4n(>sbIBl%J_STxEV~@MHBc>S8B0<?)1)A{gb~j;LWXnF{o4DaY{)qp3LP>Yz>2#_U<ESwUL26_=bsPV&v&5vH>p@hh<|=~;=i4I'
    'y$s@?f3};4c%p%I1qHH~0-#F^0Q%zd1qYTvR4rAqk_bz(bje1i2{2jEjsa|i`<*_Pn`GSZ%pA{#Mj3L<Dkoq_P8l%>oiY<CDIrsk'
    'h?|%vUIL3ru2b-y<oo?d>gFNCGg`?bZyvJ0*c~K5>flZy82egeRP)O<zg+XnHNRZ*%Qe5;%_1ZIX%-prE*BZ`;}jV+0@+28(camh'
    'VRweD4dc)}FdG>MUKxkVIK22GBYv<Vqb7B%Ah3eK3IZz#tRS$0zzPDlEHY|zt_LkLYJA!bMMjNn){wu3{I$qvA4NQCk&)W9$VeTd'
    '$jFaJzd(#H`~Z4%J066|#V^Un6h<FjYHg9)uC~ZQW)p&A>8(I$Xe@yU#>7n`J_Q!NNC?hi(l%1`I3xz;iOeUfLfP=<thGe}F|M>K'
    '2PF|+a09I-2rfNh5#dNUU~Q55d}@nStJ<PQ&FV-=kvc+2Q7f@}86`#Pvn?q?ln^uw7@`4@Ws<-t@a%B8aOq00i0%VT;Y%HehI4iS'
    '{+?zfgp@9>EGaSuV{H@MxB!NAj#v`C$|5A5oa2aFoW|{?MGjaEP=|;@F&d3cjuuo@ON!21QlySuQnbI=?Gp}lv64vDN}`%Xu1VyY'
    'M6OBXnnbQi<c?MnsZX<#NOifANFAw?s0qI=Dv9>a{S3P^Y^`X8#(~*LE2v5<R9fN1R}!hiRT4F*V+DZ~1Xd7OL0|=e6$DlgxNRj-'
    'lXE?6B~jDUcBv$4YO{v?HRP|AMEfY>IV*|eu4fX-6P!sjOut;*6(;RJFp<ObQj3Y?mgf=?kvNei;(3rjs33=~#bmTo5<zqFRO8>|'
    'po~6iL5*e_QKSqMp>c@(oW(?lcT*xdX$K`vOj!<n*RVB4O0QHtTrrXSe9k43yPQk3TDiJWPb80UHc>mtdJ*+R7~apdo(NrWi8+!T'
    'Q-Q@Kh@lkY2i#8!PR4K$j?r;3P>Ywa@bENP28^S#W@JS@QOe0>u0vp)sz@B+%D{(HZh*~lVECA74oEEs_dwawGH)&HZITEnw5;_+'
    '=dLGuB=1M5C)!`^_6&+TSW+bG31~H&T(ikFn_RQWHJe<s$sH{zlAq=YXtK*EpvfbhfYu0M7bQh|XMl#?8MZe3Li50E;umB+4x#c3'
    'FTSKm9_|FRCUvYJu!6t}0xJltAh3eK3Iew*DQa}C2Q4XTeA*5rMU8FNkiUlfwWMetMLcUsk>0hWNFQ@^B6oND?qV7~UEE*}-?>t*'
    '@iOa)^mg?`nlq{?!Y+rXjxvg_1cb6N85K;h-l9o^P*4iZpez<)2EKusc>`??@tpNUlCr3|X4FV1p+`R>*A6xas!5|g;O0b4()%gZ'
    '6X~rsCt9mn9VsT#hc6~-Csr?`m`H!N#YCBS1&{5CBbi4=q9Q6&CtwJJ&jMHmNJ~o=z0}-0c>Sy_BAV=gOkMCRiivDwC3K+yvx$4*'
    '(ybCgc%3axFs8<(vh|=STM@dl4^0jc)1*B{O|U6IsKrF*Ehf^(E+*Pv?Dh$Vx>!l1Yb8-lBG)8xO(NGMa!n%FByvY9iS(ygNu;}6'
    'Nu-ZcNz{m67nMYN=YEFW8MZdGLi50Eq!o0f6)LUp;wy>t!77QG)UkrV3IZz#tRS$0zzPB@2;8!gsL{C|w34XtX**OBHMUtp{u=Vv'
    'N}_!f@tl=JitSiQw1|d|SV?r9u04K+T2A@omtIr!FjehpiUL9{>T?o^c{3G4tB7b9Ay<w8&evMR8HuM@`dCh8$q24FVh75tkxbdM'
    '?opJo5;<f<lCT2OnH)sYRA!=_^WlIsMNM-23Dp!m2uS;yqRl$ijq0L@_d4KKMXdzvMN}7Ict6+bBCj>9no7jOqDfy$fieKE5Y|PJ'
    'RrcO1nrT)6{#~bNvj<+)Bs$Brl&g+D)0vwrJu49dA`J)(qL{!m(};2yH<8&y0?#fx3XlY3Y2f!|^7x(y#cOrZxvPsF$@@{Ni}n}0'
    '!-Pm3tTV#k*E*w`Vy-FXnqsag=9*%zDdtYr8Ljrxov$-m-R+Ll8EuSw_Svzh3CS+%jP}k44ZAaJt(Gr04$LOf0j{``4wZCx;dMqW'
    'ENbf=iyG9ig1`y_D+sJ0u!6t}0xJmIcE_S7=X%&3i<+Lc%Z^1&ZPt*#hWxe8Xdgv9L!A*`7P@5(VSKwfqoo^<US~9M?=eWFWC$7_'
    'p>zn+&t7Bn+uq6!#}T^dCXj>C2z|bC!;81jgfzw+LKo2a@=7nOLTZJOwX2YF3Z6MB;k+W83!Q`E6yZ5ZgocO!1u?PYGJ1-D1Q9Ud'
    '(P<tG(}l`S{+tz3+>it;5o2OOM269`z@9!Pgz5n?-QE>atu?Uw6;dk%q<w|ddh774I_dyAd)A7p72|ZcimP@4`#D!!Ee~%kf~fhg'
    'n*XZ#ubTg=`LCM)>QWIzgO}bWktVv+?ei8vw2OT9D1vAVE*C`*dqciqcZRJ^MzncgR%Aq%p<m62){N-OEP~j^qP8u9Xi~=t0xJlt'
    'Ah3eK3IZz#tRQg9B8W!kx;1v&>uEa_K{U2mL;f1_*CL306meA%#LYO}xbZY_hO~tdCicUt$u;K4nBW&5U6j!G)i@#QxP3$%E|FZG'
    'NU4>j2ri7s#u^Imla*1_3l6I?vyG2vUNZe;7$2ERt|+Fg&kg)Ho6^8nqqmR3D?^$04AVp-th-D+1Sv5mAu1h=QPF1-Ma~G$but)!'
    'Od-<_J{U5`)SSD<piBzCpF$ek%qadpKWA%SoxJXx(pSqd#jE)g%%*WNWA)#B@s}Cnx-|YNai5gnPADy)SPt$yA*Le~&L=s!#rUH$'
    'eW5L5Mz0!wj=&937qw6Y1`MPi%7jHsG(j8&@y-N;qnza-c?$W|8Nmg#Slh^<ksTj@x!d?hV->ZCtYOg*Z~!=vB9Zt3b|Y!E&G=K^'
    '$NMPA@~ZLocsaz=9#J-zh^U-qNg=?r2$2w9dW6A-SWX?V1ym?&XNn+jmsNsLkdBYP-EI6eb9k)qf<}oEphg!H7+{N>;^^pB<8S*E'
    ')|i`>!!Oae6&gOm!Y5G8nO6cHf^w(50GvxoJG8+yoDzYD;HA~6lQH*!bytU<@g0Xhy8y>119L$L!@Z6Gj_4t}pn2SC_?hf$N~~OI'
    'eOz*yCr{v83EZlt5P5)YVc-CxbPnT@Wrz%8qB2|qfye{ez()oIEM2!gOzk%OIS~b9Mze{CIIMG-YRzH+Q3wb4Hr|(W+Sd?pY1yjr'
    '4={8x1KRVT2p*^rcbJ3-N2!<zRgN2>yeh{^X(gB>rBIXTVxgQ9tmEU)cl5r+&Les>Wgj4f8QB;_e*y}CP|+u!wi<uarwoI)TK;J$'
    'uayleu?{-!fRBN0VeGw@oVgUF5>SdDLKIXYPEA&mVj83IM#+wk|Bl`_zyd3oiU0<ol5nsD$z=qGOfiw|HsdcuzwAY$)ynZVCC1Xi'
    '5K^8N3?(cJn=Iur;)^6>utoz_LMON_M{7y%Jwa&9tc$VZ-k0y_eJNuKo>mI00mXcD3@!kV4-ip-5NMn6m!!{t)yV4TM+Zc?2zCgB'
    '8RPD(Og`fSp(J+^Knn1IBzU2uy+;J51+#G2CLnC}fOFj*f3c(e(d9@#8*+|@mLvWUq?F+xz_XcqFSZ(g)h}z`>FV&urKAHX3B}@c'
    'Q!)iLW4JjStO7_5+%gH-&%#I_2xq|~>S5Lgg@DzHj*tJY;ZHHi66zk56d5L*A_xs!z$ORbNZ4ll73;%TP_okeB%2UoWttdgfc*{_'
    '*mKWGWGoca7n$<}a4fOxZ1jl05>H0M4^4BxwBy6SYxvW2Ui&t~Z~I(n=+8>&N8pb)<9WIdpoeSah%}YWxu8D7iWq3dxud1hA~+4R'
    '1N%pHfo06`ZV$iQ(fYJIu(sXsYuQJ)gb*vozw9Z80N)z?5a4Wyz|d#qA=^M8LKX!C1}DZd7=0I$K=5g3Bq2vQjE;L>sdtV3+idCC'
    'Zu|}D8z>MFD|2sIV{!{87(E7`nP{X6CHkQv5&%9)3D?vC0=OUn(WHU%g)TbEW3;~G<FD9m<KM2pzvcMrK9!OQyE6Jw#381IOV5DG'
    'FfYa`UGmY!A-E&}+VHv|p##a6RCAV8Bm9w25~+a<x*7d1mz%U2|G(^-!XDt3;c{t7S(5S?-ogkb{7M{T+!9-k9rFY)$GlK6kcf!K'
    'Yn2%=hDYd+DAiIM;1M9;oX*L}cge+Fwv3(C*v#jnWk$VK-nU(LvRw|XU8<*DMxq^VZinvLVUTu_a=Uo0UD(miJGQgo&6Z}m>h5NA'
    'H3%PO68PP>zkl7kN#ov>V(d*t?03D%?dYaAUFg&s4SRVop4|4vDc?=p)$e-4Q7@0iQ_5#~LFoAQ8B=3y-vVKwpC5PC$tH1{^G-`j'
    'Thor`N;@8Hj)NPHhJ)a)`WSf3^5nzt_FcLigx>u(y;%=?i)Zy_a`Ct@@}Ql1<}J1syuvdttht*k7AJ>snfx*x%LR-V_q~IvU8Rfp'
    '!`fNgsn+}S7T)X`mBBFO+=!`v84unLhVJTeX%+KwbgeWsl(>*=pfJ)3o-0bYD?){bapR0KVSI+00Q!d~gtgAv+e{FCllXLP>sFJ|'
    'V3s#qftvj|Y4+o2lYAC4(A24oW}ubi9m)(eK5VTSC^=OvD5Ro=8SokgKp}jJ6d{F7h<Acwi8)C^G~8xrjY5P%jaLYaBqBY8w$|EG'
    'LmFe=!wfV<R2$7e%>tb?3v{$OK8F=(?9?VJ&`$6UWCfZZw$=(L*4JEeAdnVTK$lY+BH#{gurwK^0@IlipJ__K#aw2u6XTj97*+r`'
    'B+#I2)Dp7q3OwE2Pc)#f&A~uT#h)@2f3!J1ODxdTsg1EfE5SQdEYSF{^|1gVTx$uRWf&W*KroiWaoJJ?%e+g9NouF~7UCqh))w)t'
    'O?WmzK%yc`IUwi_g2X_C-UkviWwth2fm#lE+H%OFP4YR+Kx3yinSpkacOWy+{IGRqpcGldwHr;^K!O0dM5JN4kpTJ#bRp)&`DquV'
    'EQ+5Kvl&Q0NUI@;fG3)iQW(SyE=s$H8E8uWZZre6F6gv%K}Vb9bC`j~PHi#+?IiC&W}x|DYomcuZKw;+)FvA6vK*!1yq6MTZi4$a'
    'HfyG`P)flNQN*^A((Geo0f9(iD}%*lGU&kAUJ1emZfY|osKw!@EDk@~9G?XfG<9ktCTJyihr$Gn4_i+Y@IE(;wh09w%aj<P{J;};'
    'z`&*ul$vD)5syS>i9mp8Z>3E#6`2EO2n5mwZ^yOY!v-|5*c)v?U7&N?1v*EY<Z~E-#!hWA0_`O4Kt`bXVQY;5aIWNpnl_OD$!M2Y'
    'n}Go|@m|5$WGfgVUM@T%rPNwehL}LA>`0*Hv|yJ6KtyDg?_&j;>S8upfx1lfw98bFHp%C(0*#&8WChwu-hr$@^TXEX1xO#WObu&e'
    '1wx22Ym5KzFcOX7R1+#0;#{g20sN1NLEqyvB*-+{sNm@YQRtMWdsu;{YOjq}pe|QA?Q)f)P4YRcKx3yiS%G$vcOWa!{IIpLfDnCw'
    '3AeHpNk9b@Um6G&XI2tOFTr)jh*ShAK~z|ZiDV<-=yLMRY5_E0oh)9I?^7_)P-eQhV4$v=J?X01qfPQzDh8T5wXtHLmE;|&VxaM1'
    'Yt2BZiIq$m-X=3Zbnq#92Uw7}5>XN9gCi;>W^yJRpnwQZX$~rvau_EW3l>u3lxMOC`OXs3R7bwi4AjNjr(L{#v`IdP8EEX(CNt1Z'
    '@(yGMnjf~FB%po64HL?=FayP^@GOJZ4Bks|Wr*XM1o(faUDDb|Nra-Nlnbg-U?>WAuA^ekC`b2-1{zKU+Z+wlRdlCZMR&AGK2J2z'
    '(5cPQKpV+BSTxY|u(f8Otj&c}BGR@n1A^-aJ&;ZW;0Q{S4c?{5SOP52QUaGGKwpx$kTg>jyqPZGWj1<+Sa=UJ(6r)eqZz1+nNPcz'
    '`Dl}T4l~f$sZC~}o#Y+J3^YG%eHpRs3#!mSn=)eRMP?#E3%K&xD`!ke5kM)DGRc`380F3|s-@>SJLbH!fF*zm+6K8#8FAzGn48Q%'
    'UDJKqHQh&><a3yT#!hWA1MMX5KxUxjg5p(Xpv1Tq{)n}S23T~OIlzxxY>duXP{+7u8R1AMD`W7b%{G+Xet}66yqw51Yg#H}vX7@d'
    '32DQMI2S)GO<TBfgX_z;cWxXnBfh&Tdyij_hNIgeS@%X^dfD^CPbYWRX?(f$a<bXuejW_xdkn<8@$3}Hd5ag*$IW*l7+pm?!w<&g'
    'oXsz%2iOkper>;LvQ~>#i}R*#W_y)GxwX(!JUE0>yib?2o$}wMtH<vNr74H&?%o4#@3)noHFe*E=>$!`*lK(Jb?3e=&HAHLBHC={'
    'zj_bo#jNhR5p-8%e_^?A-hG%9yE!%CcjM)whIg0ha5uRf#SintD`rO)$H92@DY~1_#A^4zdqcJE5oZ|im4`Sl4vd(K*7DgH`-|2i'
    '+r2oW=8^c~ei0liSzIq*vrFlh$cb>De8_~OF_WpMG-^N<1GQzm@V;I~t7ym%hc--`-gZtO&K+tut@qpXuRVWxYRu3Xyf%dRvK*9t'
    '86ek#+ee0LZq`P=Y<NHQ`;)nF&JDus*N+d!ILtqoeloia5!v*7g-3+3MEFdM5%kg6&s@o)l_iNMpme;fVooynM2FGWM$=MzC(6%w'
    '&4kg4F)PWk=7|DJb73N<?&;(nYq9U#0LQy9Q+N!}&c@y<&KB+_UERQrJPIPLvN}gj%ECmFk_rL>nJ`E;p~-U63m^mZ5CfyMHCnK;'
    'jgQtOW`a?h_jT?*xKdDxkK1{KrSq4cyP5SC^5JCWnV)!mBD>GgmdyhSC+dSrnM-C1p%RkJEW3=CG=vao8B0<iDw2ZW5=K1ZZc!+3'
    'TsO4556pA1W_@Bf<$`t0TRq^6Ma))^QtA5b_-@Zotc4j_h{6JzJ+`gh1V=ctiFu9a8&KIn(+tEwAe>Y=dRSe|J-1~zyx`@eF;))C'
    'f$kBtML^SuS(zHSgM<qU5nsd$^^CZBMqE83uAUKB&xosM#J$Kf;ucd8=c@g4`tVd{F6Sog-s`q=weQ{4-CX|u`sU3ur;Sg(EdOh4'
    '4A=a2djDfLytu#7W8U9C&lHp!ryY7o7A)F2aK2#i<cE~O`UiC;Yq03_)5O8UeC>$`77tjPK3F_y?+n7?Nsp2UTh8?sd4$E|9#RSG'
    'o>e~kIK6h+X)LbZ;5Qy7=iU}A?t0=07FRx27Egkr25}x?hz^{F8JEc?D`6QCJotwpn_+{+ee2-C;__uXwzy}lDZ9UEHR?RLpv|B2'
    '*z7cVo5kG=vs!MXvrp~~>;0>)vaMx~=LYr^$?Vq2h~`Y!na&J9C1ui%EjuY?V&xjjgdvii?I?F-%0z3aR!iA*f(}QSEFYfwaw(G*'
    'WcQYoNjs@NAZ60-fnA|YmIu6xl!>syDyE&oOH!a2$)TFT3YnxAA*E9BmP)0k&#LSc833~qLSDdNngrJeqfFXOYv(BwqxxJ)t3?B2'
    ';zITaEfWF(o}><dhK?~ElPXn?##>>c0l1(x__Ap?(}X*foXpWCwt$I8FJ(9=V^VfyIu&E0@htvvJBM&I#>6Rr=CZ-6R|Eh<=U_Os'
    'UXVm+hyfPGBd(XxQw)-%m}*QM5AcpcSeMSvm>AaA)LPmxSG5~o($3QC%a@dMG|KGSK$MP_CCejKO88PZuO;LgwiT0OX^a6jI0}-L'
    'R)j(*ct~!GXr>dh(uOZ-H}aJ)seDQ0ODbPd`I5?)RK8?KzNDS2ZONB3Hr83bq;=0b#FsRu47$UY?43S1EML-kx;xC5(BO$Q+AzR@'
    'q>QpG!eGK^I}sQoxeZ^k3=b+_avHv*MJBs-Dxy<-$%dWOj>?y`+lK6<e2J2aJrJKQF=1@BX71=qOo&{|%29fRB_@>CB_^A85!{k5'
    'X(!bO<V)H;uyadHFyLL}OCk&KO40gctQJ6608S}-u8cE;qG^Dsa=xZXaN-K1qlJ^)W5n@FNga+aX*aE1=Swj9eJ)JNdo~azLD0-)'
    'l;yB8lYt<qF3Z9hCe}o2DKCqWrOG9If+*tavhaj4A4QNDlvaev{<}mTlrSNj*i#WEl0sTPZs!q>MwkFmWNtFokx^kv=@9ytB*m;i'
    'SB<kAGl20IDu>8nZ17f@FzO|hnmclC!h~7cM>vO&uw%|@H^!u$t=X3`!Mo{__$j4r<tQhQaZj1)!d6D$M-2l2_?V-BO7lRJ^#p%l'
    '7m}q+@h#$+PRvRh#-!cISH`3=CY3R%j7eooDq~U^lN}k8cCNN1W761IXBm^$J@4WQleI~M?l2~MClC(Hn6#emE;A;P8*VTW+-fr2'
    'QG!VlgDuFAI~%uJVFGwi8Ix13Flo$Xx6Va$lQDUIH1%;e<!W`V^NAS~E7vh5T-(!Z%0<_&V^YW1luK2{WYe+i+iuF$N~#aJDOalp'
    'c5hQI)k(&LIJ^+IF?$iDM8|bZQZgzCW5LrHIFVN1c}$VuM8Uv5@LY~40kl!{aGP?qn%2&*Fj2G*7|NO!n0Q5ubc{2|72#exmt6{i'
    'M+VD7s7u0f40{=kavZc*f*MGimR!@Aglol@1XB{V+H#^20}xhBQp-ai8lo$>*4FrF6NZ_TqqieV8Rpstf$)q7oesSvmt8DKI>DA)'
    '+A#KUJAZJz1tw6>WJ{Tq6@ZD;%}zy393aA{z@itJ?i7=@k;3?dvS}JnrB7Ccasu=Dx8y2^kq`h5-7#Oa<Ca{lOwGQ8i8sc&z_n5W'
    'dMi!Hip9c)N`Ya|N*Jj)Q=Vn!nRVQ<D5UpXU<8xmVvBI56SLB4ORiQUUkQ^+m{h`~5+;=}sf0--Om^LptCg#5yCqjsW8K}7t8LFa'
    'xh0qCJYlkT{@}n{a<!fAE^o<Yf-p8Rp&1M&fnhF{?Wr7l8vq#Sc3X0(N|>B(ORlC=cI#wBN0*q$lM*H=ai2>5ODHWe<{TkPLYzt{'
    '9BOj1YlMlRXJ29>kFmr=R>EYJ?C(gJw3F%s5+>~)*u5ntvXg`fSI%&FXk~INzR3o|JyA|`jTiQWx}YiZiIkr?2~kAiv?)u_4AD#-'
    'j4)|8t(_-K2<-#h8LMRjWkLgjA;1O=oS#Z)$BoX4B^70|j`JwIMXV%J3{oT1<P=~Q697R_5WaS&n1mFPDm!5rsY$ds1C0g%Q|%Dl'
    '7Lp`GUb0L?NUI_C0{<s62Ahm>2yPF(#KbOEt)5_s31`xN+|DB$jWSWj2w?>!QE321UyhLxida(eQk)r)sgXu#MLc4A4ROf9I;S`f'
    'B_~ABzr@7!Idq<I+c9so8)eeY*z8N0XyG#g2``9o7#9K=7D}0fke@;cEq633BMES3&eC{EJYxy=n3_N-&szjEotTw2lu5ghuarrp'
    'Oe$qkDU(W>RLZ1MCOc9l?Obh3%A~Qe&Qd0=d)~=4CbILC$=(@+!%`-#r@O<Hi3Vz?%0WSbU}Xz4z~7`XV9=ky7~5`*iL8`KC)SwA'
    't&$Plq)bkHiiu_py%k>2C=uLIqsz{E!HDb>$NQawGEs!Bqf7)n(XL!-t(3829Q@Ae!S5?&f7dl8t)%*pYfM@_uyd42M^7;Uq7~&V'
    '1><Ri(yC;W1fEaMX$?dLgbx_+lnID=9RO;1b1$^TH=OxJ{re%-n6#SK&Qm7T^f@s?TGO=3giFW`jhX}FN1_<8p(oNsr*ss?3zvy8'
    'aPY}9=45n~L&S`w$#@?mX+@csOerztC_bJzLXBXQb6&HoxYLoyEbVkVE-NwZsmQou5;zreOc3(=15+kU33)QgL^CNqZs!q>Mwvti'
    'u+Y>?r${CV@t;ybdPyRKiP0uWWr;5<+L_kOYN)qmNykK)H1a+vaK2S0RQ3rxwIr%z-fG8HCasLkzLZHopzq4*?-WDqRVi}gB6uG|'
    '#!zO#pm$Jo?rF$OMxGqh2$NXOh6f@DTLd(nn3YzmOj?b6rA#ViQYn*4nN-T8QYMu$*>#mkD_7fgl}S@$-CbqUw&z`>Og@2wO!m$o'
    '9C(#U+v)ByWnw9ZB+0`20Qg&NOiT(^k{ZMf(rrbV)Pqb;NtrYyvs))4x=ESv(;j4!6M+J7noWd=S?4m<n#B?t_?Y-P4l>cotXpNG'
    '`Kb;vF>9raALAesUJo)^Df>H8Ches9fRstQ2X>A!;oUsQL;}o5XA#dvhLDCU#I%v9<h?VJ0nY%pNM-~F4y8`x#WWXX^{s<@Q1Niv'
    'a<!Y*&Qm6w^p#bZCEGxmaF`dRjmP+V;l0F|tC$IfJm?&}_e^A;6;)I+ZzO>TDj;9WIcA$K&KPMr$V3O9fPsmHHB%xgB7JapRAMG)'
    '!ii5rcuI3nz^0Zu$yl(ES*JXc%pI6A;l_}YZOlbD*B`g@2uGt#fcG&V7J+-xDN}Ef@v7|a3ph_y2xVD`%$edpA!GSI0Z<6X4Y5Y)'
    'vma!_neKB88Rs2yR=Y7K?QG4yj7g?ec<Y4?#2X+v4P_>QVuFpIj=xQmO2A9}m7$|46Y8x_)&|Y}LQ`5vZzpD@4P(-7<SS!R8I#JG'
    'RK}z-CY3R%jLD9SNjq2Dk}+v)th0<s>z;R!G2z`m$Yk#X!eJSc*3;c##)KOs9b=p`gbqAUm-%ZcMRCH~$h;L}!s|gMCuB^Ta@nnO'
    '5glbr>`57uphQx#;9?a7B9*d7d2(4Mj*wYodmhF_uVYLE6{lfL?0PA)$6!osWlUDd{*H`EJE=Y(W76({-D6B_CmEB(w9$qjj8O(%'
    'b~F}XrD;}BSFQ*^4O7JxBn)uY*2%JM5Cgon#=FI#)CXWp+D&Wc856<#f)PZKO-GpsjA}5(8<mMv0^vY3lsN=>fUOWHV0_3{Ne3`V'
    'vxjt90h_E#I=!seZN->)8LS5g^|GvINL*`UGoseAKalcCQKyJ3`Pvu}*9JkHOu^zZ8FXOm&_|g_D%i;w6E1}LxSdBh8e@V;m*Hi&'
    'vpG?X-dmn*+3^>1LxR)}Giq5h(HUoDS$RS!;Vwp~gfmK?oiP!l&$xnQvyOSI-6)fG#%AwDCY(l9&Up8-5MfbeFBl`<aLl(O*#OvC'
    '=7h@tdCYm`xYJ5P$jbt6AGQc+Ix#D4D3f+0Un!GHnN-T8QYMu$sgy~jOm?J9+PT`6lu2V_ouy1#_q>yoiS0aPvUdjIu#`#b>FzRR'
    'LLeNltWXVjJXlPkF>lHQ0mMs_-HtM`l`=UUWzv+)Zk>$iC}ncmqf8W{7ebBU2=ats*%*i$G{QI~eDdim`*NvulnFEB{EJMEag+(K'
    'N13dY{T(Tjc2a#n%B0-`yGNOH^C%NThz{ihatrVYy#$V8&f`^pIEiCruThx{ycGkQ$tp(=piib-JO!>eKNw}wZd$v)$fQ)`GfYMk'
    'Wny9mHjS}t|LSr%Y6KyG1N_G*(Cnhg09v#p*u4xPBV3?NTSJ3W*(uFhQ6{CbhG!YPF1w&A1hvHROhO{rX_vJ2v7D(vP05!a)|5$D'
    'p`4D2IinmsFl8cyF(;!;AWLm2lcOJHBFhl-fR~HR8?C9OE?L+XOIegb%IIxOLNe(iW=t!Rh@eqPj+d9#oSib^ysryor#t4Xc4JK1'
    '*_wSB69Mcf1I5Iuq**lHQZMn=4nvws795jIB2*6o;TZJPs%#K-a89jvUT+c4bYfQ8FedFrzA`42F{zA6WlSn#QW=xVnC!@yv~#sB'
    '8I#7wI?I@}?s+E}lkT5nvUdXEu#8FT>FzLNVl^j93y6-g5F<n&T9mENgjEP8WY~@|sVA9qW08s6Di_gB#zdTUTQ16&64^;%H6{Sw'
    'f*J17>tHzChV|z;{9UX){9W3UFedj=)^jNn$Jmxj)NQ#|%KnawNjs@NAY;<*ft_PaL^rqPvN<Q{qUJFKKv3iH7^*~2l!yc{GgSx8'
    'fTx`aiC6+V=(z^?P22-=9gHz)H?7@YWMcbV3noS5K_(@Bgj6sBjOs}_uTB6=0@zVtNyjP6Az99Y2GWf-S>S$zm^tt=Rj%FH?^GBF'
    'uz?hF$OS<I1lJiOQjyvOxde_*BpYE;5d>xtsF6|#L`(2{=rtx<ijxs00#|(8&LJG{>~~EN!pn@VQlJS#5d>mjvZFC1B_&?A?D-2+'
    '>4EL7!pzWMt*}h$th74+8WYvWjaIXc`KsLrlXj+NZ^FcCC#-Yamvh}=RFjl|a=?=cur7siGCWU8$E-*WA#fIhl3uImT!H{>5zcgC'
    'R@x9I?MA*5CY3O$gh?e#Dq&IylS-KENSL&9wJiyg#>P5Jn6&PB7YP&5{av~C&L13>FljyAo!*rTjx)eYtC%1>$_eK&mC`5gpgMFb'
    '!bH?vxlTuzG^Vm!=OQ|K^t(Fk(eK#>N1Y7J1tFlwIwBgyi=pQ*IILsmm<Ym7v&2NNKP^Wc<LGx)36oW_zw6QOt)%*pN58jvVE2xG'
    'SDhqGG7~YQ|J?XwlxG-BbeaRvGs?;apq53igOb@PM7mT-mjuj1RMhe04|k49yJ_t_VZuZo;$Vc*4U7qmKoKfO;sIf!6PN-~Rx3+P'
    'U2;6Tn39hvijr)=w1l!FD*z{c@j3c-OH7#3)X;JepAC2*SJtK|Q<8)tgoTV?l7;b^IYzTjsTAa7?QJHJY7!5<D;H;6o$Tm$qfOhR'
    '-_@}h6H2{T41%Few8YTBc{%>D;0l(UlhLIR%i%S%j5<Md42-S4Oxa~6{Q1u@p?x$Zq~IO%Ry!X3-pbhQOPOeDeStaL%CcGvqpe^}'
    'qq71}7KtXOFiQmSf01yHd6$e5&qy+wIuo}DXgV<~t&V<gHS(1*sgy~jOe$qkDU(W>RLW%6qu*P(+O|i(H#OGXqu<;1ypu=2tIks<'
    'duI?1eDr(U>FzLPLNHjsgK(qDFv^po1c*Fjf}vJ9Z?`KKQ<X9~-5QgoWOnOhL^mlDsZUCoNXnw-no%PmNM0HlxptZ)h!>4EoMl%o'
    'x^`DCN%(2jn6R}{CiM|06R9g@vP$-Mq)ggL^#Li9b`R_vWr6|kB4tvd*Rlf>1!|7IyjzZeYs9yJyqN=U0fjn+iwGcB&Js_=7a>8z'
    '%if>|qfFXOYv(BwE&64Bp0Q1o32{27gxDw>TB;L#Ob82nO43k7McxH2c%mdZC5;Wvb5Rathgmh2rp0272FiqbfrvIxioW^ml{2QS'
    'HK9TzWs);7AR==J%e3@7=W?2YwCG79Lfat8fhiNi<jD>)(a;n7aXXK2yn{?QhL~D~$;6m23cC_yj1d?km|(p{CyXr9s+lm<CQ-iO'
    '7(j!e4e{)hiKcyO2!-f%%v<e7nY1%Dd#^H)0Xj!CF&aTX7ZDTfQ#PWUULvy3oB;)CnpuoC6-G2U!o7v?qbrPU5zusER@zV|?MA**'
    'CY3U&lu4ybDrHhBlS-NFNSU;AwJj-=#>P5JnY8YC7b%mqS%dCSCVOWP4ojJ|p6(7)CYe}FTY`@^E|VBVFgj`FlIAfxz8z%(cu*;m'
    'ldUpoN@llCMs$-hp{G6jJsOKgB3cbL!iggoCo06U^PWePve<m%#H&o?x^1~MRVO;gM6H!FdW^H*X+8UWrR?uWnY5GY15zgK9@sg`'
    'gm&}ncM5<4?<^S<QwddEvh~z?r(Bd;h3TfF+*ksnQ;?0NUI&5CBcnM<doaqR-L!U|GNG)`rI1>xrhU0o2_1d*lIoOTaGZ(wt(*d$'
    '9i}m|j8K7F<rHyR0XGsJ@^l9;Ar!H#C=-$~ip1IsWU7hx%4k{+NU_Os;TiD&$C@&qlvLS~Kr<<$EtJLlTJ8@_nNTTDc94k_n(&X?'
    'd4!`;CLUVpqxHfEof)-wKh5w4p2p~O$>&5KBBrODPH45ZHu6M*@Dkls9XR`)h`x}ND`Pt5t#+eK+8LXDDHG~>azsLzWXJ$PiPK0p'
    '9ziq4o@#vSv{uTHP&R+&TI#^PwU|d1osC-rG@Y20Hk3)bk*}0VrA#ViQYn*4nN-T8QYJf6Chc5pOUk6NvCdK^t$W@@%7k|R?DxGh'
    '2#2LiT2FVEDU+y#a0*b}31u8?qXYOCIs^=z<Z&y?gx0g)Pq@mYDVg0m8PU;ICZ|2g1W{>9L?`W%7l{E$`xG^$#z^Uv%4b<+Lg>0x'
    'CW6SbuQEBtNhY$MWU^BBcce_(N%a9KlXeg6-YS!Bo@8PqLYk<(bjAbfS_H9?N<6_(TJ~rP*$4;dD=AaX;D11?xQJ7XjRzP#7-iCK'
    'T02jfDAO0jaNTs03CBcP!)>5eM}(S!6Tyu%RBP*;Akk^UG(=8v5pn{O<<<z6O^7ln({7Oo`czUrFvMJ1nt+M})0q;VX-ZZYE;Hg-'
    '#x>P6DQYAM6j4dU9BYOS9GEfDQlD&JF368<xi6PI`bj24Bu=D>upKG~3>If)n_7c6fnw$4sm8y_Vc4K^f@1VF@T3gX(-0y*J7c0m'
    'UtpXJu^n?(yD=v1Y|XxmiNbuOEF$$zaIGRCT0y!!Avvo=yb387p2S+Nlr}U`3k1o_Mr_PDskew{Ix#D47?XA*Um26im{i83GA5NV'
    'sf<ZwOm<{U+PT`6j7ei-on=f~_q>yfOuB!R$=(Ts!!jnVr@PBXnMke-pt=O^H!d&^Tj?=<PD?Lgxwl(nQjap}#v&8CRWhQRjEQ2W'
    'WlR#la1I%Po)g8w<RFr!G85&T58*sVnUHmhOc2qZhB4u5rA)CSFeVE`^0FC|=d!;mW70~h56PIcdSK@m6AXA4855m6uoS>Mml_YS'
    'JOa}*V3?Fbh)I=FXc2QFRwLAvE)&E>OgoxVNxJ95F($31weyULA$`IrV@-?+tfR;486ko*iKxhRDA=E7ql8IXFpjp2%gHz=lm)B|'
    'A|~!>7E*_HjEUe71Vf}NXJ)|sCL4f<BV);6Y^BUjCQA}YTu7R!3Lb(k6{J5Ry7cPM+j7C&pKMz$rilEwokKVpV-hUvh)4XJS<X}l'
    't)gHhkCS5nqPI3#pEz_5_6ABwa^U5xcuBc65>fy8x8+iOOAF5<JLar*WK3Gwntd4)mkli`A}b@848jk&R)htCkq|6t9-?uEI|`$!'
    'h$WhN#fp>%=w`BPi+H9Jv(kz&X*KedF{zA6WlSn#QW=xVm{i7OSH`53t8L4eG&R;;#-we}yU3WVO&WBEG1)tTaA3xy?R0mTF;SW^'
    '50n7kNbonDa>&}jiIokyqtaV3CW=+Y<aCTlQ!cx8GUA+!NpROUZtxaHY2NPMEzUgd#W-EL53k%Ef`jqk_Cp_$!FxcfCCs>-gIT`m'
    ';{K-lAgdKB9F5;zPOk3W&aT7-c#^xC$4%+BjPmTOHS<>Xb6NUgnjo3CH6DeF>F@0YgpnuY!{bAxP1*US>@=YQW1^5Vy12|ty_D2N'
    'o~UsI(Rf*Z27!^vctpHzYUTX=*kJ_ErJtklbDDSb)$R4otKjG3I2c_`*stX36;SBK^x}TGco7`G#|NXC4Njr_blUX!(IoHw&7QvK'
    'eQu&{p5bPpzK{;B?-hO!_Z1F~H=Q-M6mE0bm%xsFJWN@x`(%}zPWw_M_0g9Hk=3bTbXQlSUl7lZ)Ai^USZFl9ohHNo%n6~t?cx9Y'
    'w>?8B{Y$xe!IVxls1IC=j#Dm-VwgIe{wpWu)3sgGLA<+}YtDn+n*RPgLB5k5n0plU;6C__aG&WlJP4i!TR5ErB}ri$1hs|``Ijdk'
    '1A$6kKz!t4E*Ez6k?jG522L~t{yAh91<No&CK?fd78CI-1&oX24tSnOL~lXjKVm#^JAm7KGb%rZ;EoS93ikOZC_<M!^<f_LV3QwP'
    '{f|#6fk*D>ksK@$06Ur8yZM6&VV|yMJT0E68qqtT66AP!HMpL!4-&C~G0#<_r34n~8jr5#^7jdw;=;i83vgPNx=&#;pIEd{b_V=t'
    'bPL4pZf5v<X&RQ^kWq4o!P5&C^duqrCp;%pAG~Qo=9c1c(p)EG!-QO1jlwh`x-=P2!PQDT{pkzgJ-ojfy`7``+tJO<13mvKzTiD_'
    'd^HK<!OiVtIT^Wl>cdt2$veFI-~5+Xca!leKN!AB!}mS!Chy)1|EBl*#pTn~es7%aCaE{dz1w%Gmwp{gZU@7+y=j88ci&*|=FVRY'
    'Chsu3y>Cao0?p>~^=3H1g%@|D-p$}9WjDBbGrYTYlb?G;>o>z6zWeT{%YXjnhp*mz@wW(9f7kn$KfZo_{|PIfeDm%9eEscD-~I5v'
    'E`R^^pT7V4oB#gp<@aCzfR8S}|K^{|RRFthhChDy??3$hb@}xlLhO~lAkT%xDnI}ApT7R_50|q`{!ISz@y!>%dGkf@@BXfL^Gp0q'
    'xqFuQD3{JIS{^=(4aTcn^{20Y|A%kBeSP`E>#zSAfB*R7<&VGr;hXP&`fBBU^E~TC2|-Kc)}(*)p|mo4!|(o|Z(sj#`G@a*oZkHp'
    '??#i`(%WfozW)CEuhzr;H^WsU^6&rj$8Uc8!|NZuqMP4lSq4g5v%y+S14iZl{GT$*w>`8o$i4s43#036H;lcD_n7n#;r6QckC5K?'
    'uZDM5S3UNRe@A~;BxCqy*ux*(@#o&fucgU9eD|l<uS!+HRKRApqWQnfF2^$pVDEkZ^-q8J>gm;A{%!fV%ze6=q*=@5PYUlwX!>8S'
    'KJ>!X0I$&-OnSr7ZO^@jT$Os{ULK97g1V6T-cpLC_m6+aes}+JrNKOSGc5o8%OC&O<=5YTbNSPE|Ks(y)A<;u$>{2Rx<rp=JmYj?'
    '@NUEMZjY`nFSR^s^EZ2ZO?kvW{06AwVVKa)-{9V_dJ^|T7N?)k=_iX~zojqO^b6?NEk1nn=3!747x3u?7jEeuG5rWXK%l0*TznyC'
    '*IpFkznGDS7H2dm?_K=3T7>TH$)cN6!G3s7x#`=lzyI+Mkf|SD|H}`rp?g1l^QYI}{rgX45T`TwXkO=Xh5P>7;({_OAEDKYcK-O?'
    'ci+$Ty<Cz9Ls*-K0WId{ss|r_dpG&&Z~yPvhb0E=UG!f6zu)|{^ugc%JuJ#ky`NtH@TcA%{{8#eH^l`^lWzA^?d0;Fm$({@ZpsAD'
    'o1e?h__}wIXTmVISg+<;yZI{?alqHJyUM3{pJ@+fouBt>)~A{52>!Hh)2L)amliU&OcG4x_aT*dp98$S9n7rZMuR#vjSrIkn0<IG'
    '=<~6k66v}3_wMHAtN&{P$;1=yf0#Xb_UlxS=HJ{$XODhgy7=!O3HeIdTFAtjk1v1x>FXbUTJ_~ZZJ#`$VO*XM2d1?5kB>#5KMQdY'
    'JIx%-|KHxX_QsVQS^gEFKM$pRMLxXP58iPP))=onuxA!Km;r>y$jBDm6v-i}wuM3e_dQWnl*kgvVz(&jiYyzJC9>+?jLdkPlNlND'
    '_NP03f0OcDonSbBxU~O(6F$)EA2xkmJJWHpmf^=kxZ?wNA34Gm2Y%&kE5~$AZQj}$uc@6a%deWD?dM+^<xR_Y$H>kBI8N;!<K!5w'
    '<J-n)SUupcFDS#&p~2gi#%v6DTsg^l2Q=~1;rYqgHEKkwQgiS!N8<*{w8=`h<yie@^;tW4K04aEU}P?4ygqq%Js<VI-W}?>Y&PC5'
    'Ghk27PT#OO+|^sp)<+8;z5>v+f#m;jl_y$~Vcg^due|DSUIfZN|HF%|5BYn1D7$ixCv7&c?*35B_xVu0$C&&*#+1uF##Dm4$A@U='
    'm_BZ4e)y2P{t-x4($;f4eJX!0J3jM4->#2mwNrYbXK!DhZ&c_%RzEUdvh|}geai^0>m1qjkM!*9WVQKkPUWj4B&T?pkbIe~aCK*J'
    'pG3S*BHkwv?~{o4NyPgk;%Ave{D>jhJ3>fq)rEaX-iPFUNZyC!eMsJi<b6o~iXr)97X!Z!$@`GJ56SzGybsCykh~Ac3kb<6??duF'
    'B=1A=J|yo$@;)T*L-G<>GVMe1J|yo$@;)T*L-IZ(??dteLh}ABc^{JZA$cE?_aS*7lJ_Bb5g|G5&yx2cc^{JZA$cE?_aS*7k{1z@'
    '+dd@kL-IZ(??duFB=1A=J|r(8B=66X_aS*7lJ_BbACmVWc^{G&k#W7>xZa24eMsJi<b6oqhva=oUPOA={u0zaB=1A=J|yo$@;)T*'
    'L-G<rGL?Nu-iPFUNZyC!eMsJi<b6n9!oB2ude=TA??duFB=1A=J|yo$@*-IB{w#SPlJ_BbACmVWc^{JZA$bWQIfs2n-iPFUNZyC!'
    'eMsJi<b6oq9g?kQ{1GI5#TOU)*81A}@M@mOyK^0{&fj9iUY)7v;px>#`U3*l#;EKQ8}UB$l>E={{^_^B|HCGpLZQz$o&*+od~tBf'
    '@88=0b7yNc`&KVk^)LVY`+r$~=>kTJ2!4Kku>J}H{()P6=->YMf4~3p@Biud-~Vp&{5On`e(-GDzdk?Zza1Z(zw7HKo!|VaQ$FLP'
    'BRx8}I5|0jUpzXx<%6B&#~;p4-W`w4$lmJtIsSIAnTH!kc*O699tg&`{?aXvK0Eo_IYRgyPr5#Tt4V@Bo!;le=X&w(^x#a--@U!p'
    '!w(0P;pF1Rb-Hcj{qW?iUYs4u`N7|`50#Vm_j%Q^{_WtMegCiUR>%7O?w9bpi#G?WNOf=u=k^Bbb&oH+)wdmgABX3H#k=dPKi}4l'
    'SO2c^?qc0B_p-yToV-0f(zPvIZLE8K=~n)Ba`vO1y|8&dx_E&}J-#@+c>n4{qv98D56@RUpf`GdV{>0Kq1RVmwab(~HVeMZjy^v7'
    's`-5Q=}lJi;g`1<%ZK0Zwvmr-zsWQ{K4{w_KK$kmL%8KL+xmaY$8J~qPeyf%w%_vLo0R;MN8X~_H-GLfm0o>grOEQ{Y}GA%t-YIw'
    'vD+1YViAZ37boNW>+>HEPw(Z<|N9agZ~pN{`7)FO8nmW0<`}(}gdpxzsdSA1VQtpP;6-H<kFO#)#Ce}<_HLH!vIo-iE(gs$7U1KS'
    '37~|iM`_tfC^f}KLGV}~f#ixsz@LA<y|wny3TEJs*QUOwR}FoMqHJRB*~K-85b-z{UlKX+VzSQwJsqCE+5S*1?xk}z()vSiFJR2;'
    'cHsZ{-K#gy?N|Ne?|S~~?BpEaVC4p0!E62W3as|k8kohkT%UaUT+R*+Nvt8pYqQVSD^&XO6pFuU8hv!~!+Ih<`SPy-C~%mk?=D`h'
    'p1Gctp=W2WAM_pTXMTLg6)an;fZh~#-p2&a$I7kNq*H3g63+D(K3L$^w!q;r#{Mb9<zgJGFazt3Tmh+Dnt=a}$JD8KUzXzH;4Tuz'
    'Y$3PqWB>uT1Yo_v-6rQ5%f&S!1h`$q74Uxwz{?6!HDneLv>7Ku5vw|8ZUdk5)8kihc+LbJ&oj>r+=D6{o?Z1BtRT6de8pixS|~A9'
    'ji6aN`T$Z7AdJaT85+1mm!cHbj^|Mc_=SP;HE}yXIbzf4pZMr-@TJdM_Zok50#)LHsCkKg|NG~)=}wjRa-^3VJQlwXz_!La(X$P|'
    'SqF7|h>zc$8fRCy#t&A#j?oXNFze^7K=ZZtk3-;Ti~aX})dTIB3BNt%!yk?>t@7Y=pLhvw*Ry#G60#|{wx{8<z(9)V#N&eRs+=?>'
    'qxkm1K_e!C17ij$&lrcVAySy|kty{wu1%%>WQgj+3f_u#@Vj@%mvm}Fk~h=w;;$$D#W)-<j!!OLT<F=`Lp)pYud}xRHt#Q^-&K_K'
    '*-yI(U48aLZ$V|B{oLJX?uJ*)!y|n$PV{{BY{2OAi{HF>EKR@jrqKs4Y|a7U%z(hgMt{B)k$(OpZX?;xe&QVn_<^6jjhr9&@wX%H'
    '2b=X<kop4)audRTFcEHH1`qrEyBNi1y=eowH=$y+7x*FQ{?}^L`4^+9HL-quc5-q{$lk~Neazp-{C&*d$NYWF-^cu~5%Yh(5~r_u'
    '?VmSsVtsc0aYym$7rtm@{?+GTAD*#32K&XRWvSbUH=gHRJ-OQ-$n6j0zUG14jZkw34mHcY_M@9l^)3m*we9cD=bHn$%bje~_bW+a'
    'x0u70`roYXx2pGj)cF?my+K{?RL@=Ncz^ZVsc!dCubt}j3)IIxdSDB(nNffFBl!FEVVG>*=+lQ!W7O{t4v*&<uYcq|{$}I3@9&~l'
    '`_y}uvS%rKma=CldzP|rmU2B|=lI>x(dx+jNcG~0?b^ZlSPtg>55*r!oTJ05C-XPvE7X_Kx19YQ=?b~MY`NB!!!`DHdZrd%R(=z!'
    '1;=^zeofbmksWN(Uk<JuR>QsODmnPo<uCDot3Q8vdUp5|^yCWB`^P{0>EC|$zrO$DKmPC6|NQ-*|M>kMUjNIV|MdU<{q;Zo+h6|m'
    'Prv*3%{J#Iso6gEe}4Pte|~NGjIUSO)BpI}KmYFapTGaZ_rLwi_pkr*ufP4nA2xZc>#zLrPrv*A^`HLbUw{9nKmKL?3qv0N^$z;?'
    'KR;O}3ww}fe8{rsNB9XoZ~)$Xj4+Gv@pr7=I$`If{B;9_{^hs-`oA|T|L*+EvN(QYe{8YghnP=!b9gjvpU$6Q;NM*y&A;yN5hA|('
    '&3}Iiwei{W_s17+^x{xnoB>hk-*mjV{Nit3e2UGFA;~8{J-D=|m#6Q4@guK(`Ig78e8n$+@ak*V9(hx?%zdAGW2Vj3hhI$!U;XId'
    'G8_39yyeb^-154QnP;!B;F@3a&fA`JtDIL->VKt>*Pn3Pi`F)ymmgo>^Z9jeyzNnU%lJ9c-SO~sPWi#x!yncT;n%(9hNs;2Ld5se'
    'lXLDz26K-u&Q3rZ&VJonZ+q0O6RAgt^`C1LpFHHY*Il}mgUvmI^I!MEn;vtkgsa;MaOy|={#S~3{Rul|`;g`Q^8C%`2zT{4*Is&b'
    '*sp#8LFpH~>BcXw9{<ZD?5=nIikN-8iIOMNg5!^e#{)0f<h8AaeX!a7I{3+B%&S9n`{cC~b$n&l#x%Zr<t!av*ajT<z-_1K>-X8F'
    '_zmCt%w77Aul)eS@AHzSVsMDFy<Pd;Z`M1L*N@C0<maB3f1J9@Z75r)8~32>7a!RZ-hEH%WXkzr>*;eIvc2Q<InTObqv>-VclZ9%'
    'Cr|zcca~PGxV^3PSyOg(H|cX8bjv2v!#(oq-qFK7_2w<3hnUeDc8VTu*xMUK4>8~y_JtnovA1mp{rVT!Y4xuOooftj@3qrheCNLB'
    '1o-ay92ejD+(X>&R%2h?(fk-hs*~uG#^Q$e<kO7Gc=xE2yK|JhBw<RW_+;0Ly_Ya3`q({{7>2uo3m!f^!3oa8v$v~Fp6`CM-r~tV'
    '_?M~F;DKg3*7_&>x?9jceN*%eU=@#pljEcJFHX)5f4~AB+4{T?K0Y}<gtLFKiLWnKpy>qy9kk@={r|u!zqsJ@A76k>jl&DP9q{$!'
    '-NhC4xTISjZyeac&%1LzT7#?0&wb+n#3IxxB0daMTN%scu1;pCZIIx(NlwsE3{e7eoUND2qm>MEC<Gl)*YcchlrmE2p=+gT>h{PR'
    'k{ERN8oJb=Jyl<M&YELMcJD^|^i%`8Dr7fR;00it7`^o9Vpe#7O8qeh{m}aG3X$(EgHvr55NlTLW{yTNzYx0X1>QjI!cmQp;53+p'
    '`>fq#rGpQ-d7oYCCEKn0Z+b4?0DrFT{9Vq5FVj2k6yDO+q9eN@;-mV|o63|q{VWQHK4z+J!XbMdoCzvYg3IM;%mxB$KZ0*vc|@S$'
    '?X6sv>>JM%tpI~kO)w>xMrkF4p%YF&S04)kkG4pz=03_md~mUlVq(APSvqshAN&=6_>DKA*y|)AS4Jo-0!8UkCU5|I72ic1lT{lT'
    'BNr8(p;kr2EhED96n+x3;Vx$bU+$@>=8}4L@cMuR3P<6Jdb~ib&e5m=8j*bkK+%{S^-=2}33%+&(2cN}joC(28NG9%in!+$o;6iy'
    '0lw;o1N?&`O$1P&&CIiu9O}%8w1o-R^E7m$Y-U5KR|)tI%%kIjqvP4?DK^;6470Y<pdpDz7@~z~LWvlYByc#PxTi52X)_yG?jbW5'
    ';fCqxGU|u{$et$?o;KqkH=Gc`ivlXOMqC|mG&v|ymG(4dBVJmHmzi>O5L1dIYCaYAAQGi|b^u?cm;qIeUD!MPqfCyNl^kYDDL)Or'
    'aXA}g0TY7v#$aF43J^&f!>w+8M~Nkj>0AJ>3&~0DRa@pk0JiwcjQwfo#-$ep?FA|W4=f!dcDkNJz!bnBdf-R|6we{gO89|qK})0z'
    '^bY-ySf?*fV>aq$HbQMP!B1M0kO0Rqxg-yAm0Ya|z8)&jVs$j&QOU<tTnL<M7gt=5PsDGu&1^UzPehAeO9TWjBS%STsJaw&(DZPs'
    'HOx6PW0v4@YwgN-dO}=rq57vW8?>1XFg8b2sZdBj;ibTItmd8VGa<-Ud^fcyKC3Sk*pw=sr@p5Mr@{I(yr|2Y*(lnmrvQ&w#{dQ&'
    'ErR5GC#n=@O8^#8`@~ax@>9Y1N{ytkfc)bfPs4BcOT6LJ!0M+7R1pMGBLZ~8adeQ7<}>I#yV*%x%oVJzjK(oE2Bl$51U~aLX2V_1'
    'hO|}j6tFc_fR6wqI@uQiL~k&X2~>)=2J@ckrnGGDXnkg1QhHP@dPj2@|LS$OGGg|bk6Usw;0eLA{g~u42w7`x<|)A0p{uk3uFgY;'
    '06{d6Fju31l1{EPSQjSQhY~NB@;MPWc6hc~vXO{dqc6@=7(smwuHi+B<&0LfvGnOj8@UO1W;TZ57bf2-4MEQ@r7KE|bphVZ(a4Yk'
    'fh+)hi0oL#PKe|@Vi}!SS%C}3zz+-%W&Bvf!lb*JkF(yV|FDdaqD5|xZ|NAL1)?S+La>Ja0>6b6j0cWHcy&#j8XUBAxNSwyT8f~z'
    'pR(GKN$U*c9(+!H#2kAN@r?>1bb&|7rROnVd}%nCXw+bbH^oZQ+A@db$!I4k2XFb}?C|fGLQ2S_Ov!_%lH}2AbA^@q1XVGLTVe=0'
    '1H%tF3=9#eBEp7HvnVjzQiQxvJ{u>0J3d(D)SSOLJiV=^IA{pI1d3kZX@#c1B{lL6>k4dDXNq1Zf~flFD+pRn1(w;U&I0{@R0RG@'
    'B{m&C9C~)};dhtEsxS5QWR;vdT#TGu6R2|nkSI0{grJ!0)U#w615swm;2K?(q?7_>UtOn(Kr|LC{iZ(l(TSzh9S+Oy(%79?RrWf?'
    'i%$(|Jd@bQ1N0d#3aSpum2zsm#U$`j)SB-w@zB9Ym#^LY&W=a1uCpqPvsVLyX#fKk@^gSGmBv0tkcvFnYQw4b5z$r}Oy6VF?4s{^'
    '!IHk!3${Hb=&I+z(mKA|YUsJT6w*w=X;gyM4yb8>@scm3%7x&GF%vGNk?C8}T&oHG#dP<F!;7o=ldF98wGN%X>L8y6$_gHl0Jf@U'
    'qG>q}V3@ABM|G&5HPEl+2S01jkLA8TYmi^k79Vc*zNiU(L6`CR&AYy?+Inzwc>LqRDxc=;Wi7eB%mK3u)>On=Q)IwQ7+Nd%oj6X@'
    'zuY7ff7jI(M|#dvOYS{Ezp(_)+9Eisw(l{0991|D0J~7TYVRd7MbOPwm*FSr25wA@vBP74UI1>_4irA|ngEf65zWHPxv6oG6rmuM'
    'Dh8BViPBp_m|K`+pKxPQK<XA-1i^5l%^7kPAnyXhfivw`(9kB9GEplS97HRQhJZ8M`9WKleB0dESxQPD9(V*?x0Yx}t?V^}>5HSt'
    'PQ4i>ICM4RMraU%nqwTWSYDWPw{zndZEv5`=pAGUtTEvGsWM_>vAzBb^`shzL#Y~5GNq*q4+_88G1{dFdKWjI;KQkh4hI8AoMW`@'
    '=(alLaUPm04$jAe7hCp-SIIEV6sBOf7(tQc$#?@dZU|ztgYG(Y)WCyVO%ODaj9OeK2j-t=Bb}Zs?vY3>P-fMFxL5L0gnVw?n0_TU'
    'b_BJp5(9<c$Bd;7Z}QI4f&MUt2KqGAn(JV}Q}aY>-IM@m+#~0E{8H(kEH|cmaAQAuX3q@VWalDKR1yrO%d8HvVH!f0hDFq>>c)^<'
    'YsJ!H!AH?i7cA)pk7sTUeyUXg(hk8j-z+r?*6YPNAcO{Rt{y+(*tJ*^TT8W%+UKw_ek+>$)wr?ZjhYjnXD$gKoB=(xHvxjFh<dab'
    'ZoG4#U&{}E)}WWbjdu?6OWNYY&EB`ljc;}t?WQACSNb50%^Fm=o?OB-2$z!aO?dSbYBBuQBcA9|vh))Va5p06A1Hibl6`uFI)}@y'
    'wP_iru4Bl>PbgJWtWyuJ>x4B1=!9+gI`I=9!eWA2j?f-8z3e{nZP7%SK`n#fUVyC=1>Z`K(TN62OrB8+0(WsvO9bgHoWd{$9IT6B'
    'XXh6t-R(5dh<k}#yf7HAHP7VXz^cIWQ}@$rP{=RIX^6f-{+{4e++c97#H}nv(7R|N;mKTibO0@DmkSyglJ%_t!;e15)M#uO!{Y`s'
    'q}h8_U#Yk3V7Ih98E-m5^#fiq2d0$kjMKI`TI<0OrwSgKqSEBhLtsg8tJ!4Dy;i3_(_$9#xzWV-tZ8C<Ry48QgC@3#cS?3SM<K0A'
    'W+v}PK&%0B3&2z*F_2x%BWO{Fs0y8)P7!!hrnq29H_#NzH}GV9N@@g#pqWRr4XaUopxUAa_+`M2s?iddq+>Sfggs}ORQ$K1xnGSY'
    'j@mFj7`wEQ%18}JO-9CF41txr7@D|qpi88QI|sc4nz(b2U(yyIZuXuOO$_k{n%K#;GQ<bY0)9Akv`8QxIRb`rOqGi@PxPE>BBdO9'
    'E2V=`v3i|(E=;mdXkwk-yIRQ7<Re3YY6i<FVP=qy0ez#kO0mUyDXEPl2eW7?-IZAS!sOeciPj`Ob@g5~gE2~|%|RZnSiwq_Mzmg-'
    'bvD;s@;OWa!$^_3=j?h~+Ung-6MY#orHoO#T7&iZY)Q!{c#J{Gfose%?K~AW>1EnIX0S#_mJtq?RhA;?otd_b^{GY>#U7^BQ_ERO'
    '43@-}dKd)yYn@edq!?!R8XLY4ic$%VmnY*5G?5FQKr;@ODUty(+r(lvypxBp57h<G{~+*6z79mv+-Yi}TC!V8Za9Q|W;F3;iJuEi'
    'yjl9EN)zwY?n|1e&{GC%n+&&PcT$vrs#@)-7B{pM%eIZvdHjX!!&7VJmRjLZa#*q*UuO4ZUz+!QcF7eV@8ku`g_zS@hg&YK1Ecn8'
    'p)~_JwFIXOFJ0Bj2)S=YbH5r*EP)|f>d9LOZ@vPQD_)o;=ZMKz3{BiQ&?VBuor7KiP24%iFKLSpH+xTuCgvMxVg;5SH3cy5nkfj#'
    'Venx9w{?h`n+Kb+yX#R~X90O+AhzCz22K++WMPthLK8zSzIw+3g@GAHyHpFft>k>dQgxFy)jpvXes*B<S~^S@*mZb|cMFqmizenA'
    'U7Aq50U5NFmPCWFvkdi#$jv<|KEZ()KMB63I!6X=^soV)OVi8SX(9qb12ZB(kpT8I5Ggd(8bceZ;1@7Oj(teaEHx%qL@=gND~V1a'
    'S&E>~ja}ql$u4peV~ti-)N`B7%66qyqVcpCTUKR0VZ+g41oU}=Sf<oKJ>j8ajtiFl$+C-l4|b7qiQYp&J2mH}B}<3L|7WQ%VnlS;'
    'M3MqdNl#-0tbPT4a#jOjX7vk}bc1L*52#}yD**&ZD49yhwUKjG2S%XyK75r_E4|Bc6pwcXcEO3`O!-^U+^@$jCJTEev2+8wfMDet'
    ';r0T=EO9J|UF;g@*Ybm(HRwgKi(P~KlD7D8v-hOfMZBrp3m~=K<iqF0cS|E^spLVcj8Ot0_p#gTl$@p&n*`SYudsYi0Z+z{7AD!J'
    'xr#-)0*pGaikQ>Ljym9XRt<Gd7hPAEy7yD^gjqr}poI-j<_xn9yfFE;ue8<RU8+Tk^D3^8_bn%}ZF{Q2#}Zr_G(gK^qUo)&#`Ji%'
    'L-?ND#=@k#<4PL@Xg&>>tblaW4%@c`Ob3Sx^P8?RL)h3l`P!s*@ZezgFh{{3zAr`4yAGkiay1W0!L?C_T`#s&L@vdOcD6in;R+Ag'
    '5NJBZW_;0Z*#@$GUpIMqGTv|q<-z%k9cDZ(7lC!km{|k@4E2Q(Il+_DOqP2<;$63h(1X@KqFYD?P<(dfUZQ`_hfwiZm3xW)URT<D'
    'ij-Slo%c%|pn=eGz~2sjIAZpok>ssH;AlO=e?=I$cxG|Aa$m5d8)zC~qS8ii?A(Yk^61dY2IK$~S`dK>$sD<lj*%3X1aN{dJos$}'
    'V5;AW=6*GrIMwCB(a$=HrRf8jloCc5E%c#rIptn<4s?l!P&)^`1e&;WkYCakA8z)Z7EQdd@(Hk~2QLh6_(nX*his)lK`5vvh|Qc7'
    '^bxGeb^~MTz_N)gXHl>mZefyrLKAIS4R3ak2n;*s>Nrj(3S5mvD|VsJrR=MPx120r5nP$e$boBSzcBf>Xd*nJ^EtpOq_MOXX9C9n'
    'cT9mMt+Los@*sxNLyNI!j!@RttVXEBUKb|a?KH81@Ag77wy5B^POZ9-Yh+z!)LF-nT;LTFi%^~tpvN^b2vkVj;Y~{s^e&oMvm1TX'
    ';anVeb+D_5Rzt7ONeTkR2qEBA*^dkWhOj~%zNK_T7t2u9<;i%{mA2T5Bn82*-8y`TFS*uehp1_c5`uIPe@lI`js_h{&2wU<6HqBe'
    'l$IjobEApRy7EbUR+UfUeJY>CAZ}>rRNI`R<qjSgIZNQ^N`dks7WE8TC<W0bLAJ)ZSbq-SJjZjvl5U_W<3EvVwLLq$Q`k3cUJ-AA'
    'PGgR)j>>l7IHgouC2k2E8NV*h`gQtmMRUIzO|%O_2;J2>p(0RE%l}~@`^q_W?YbD6xO1ROq=`ERy#$)LbC6%s79Vc*o)%5Ksq%?&'
    'JrDRjdx<HJsYwKKggIvS5k7y2?F{y)0)hpy4lTE|#hhIPEKduQ>=T;UNm`HGJ6RhPwXR}qmXK%4Id{!=w~M^DCWVH=lVbu)#>Whi'
    'hoB3SZ#!4fy8I-;N_p#mRX_<_sAWvf)&~cEw5umOb(*EAQ>ZA&WKbg;J<(X0bhp#QWHmlDkJy;Ta8Xk1Jwkfuq85#oo?)diDR{A@'
    ')ZoFJnySJr&$*DBQ1R}{Cpv4Yur)XBfEXSm!SzMz*2~Hv^d(DC={2S)_+KhK1tHPSjjg*;8OxLLrYmjTD)mfecoaAiJfV9gU`ooB'
    ')eaY@osKr>sSoO`ThD9(R+~+M7gDe`KD){%@mW_siO;I?NxV<xli_=a);`RNgXbO`1%`!Y^&Dq#Rzl1wHAlrTeJR6Dk}!N432(}6'
    '$?JLvO`WqWs!FMZp}EEe;bN#N(+z7{+AX7li<D$H;sg0$=IjuDYMpg_E1LV&Xrk@PXR=JTEGcVZVpg7{G31bDTMSLyInX82#GQj)'
    '0!`dG$S-M&4>x;HiYBI;l1^b{)dzU)?7B9#OUcARn<In)KWp;<*>=0D0GESev;j>wS}zK|F1#?wKJBAmW%vE6`$L4QaIjQog>-6C'
    'd$@H^4GQx#h^`<Mc9N00E1)Ajw1wP_Nw+1Pwu(`@7M&YujBKU$0j{TA;d9VH7MM$G0`3&J<2SW-7wZ_Xs2;;Y3S_2xB%SK&N^6y@'
    'mW?T;OvkZ+6;_6)sM%R-!CXu4-P<)7*qr)2Qk@hABF9n$eP-+;J?mV>^sI6f(|vLkvuB@snq`I&n{UZ7k9`#mgT2E7r&=-xD!>5L'
    'T<yf(>SK>$oo{r>cDz9}-jd&2z~VHSa93S`TeMN~32R7XNh_IM3ITx$o{XTbR+@YELS2XZRy6mku?rtUPLnBFS_1XKp~emot#n?('
    'OBTZ}b`Erj>|*Djm%uJ|4)ROd;=|3}(_$Al)>UlI&j4;0d9*6ES3D_DZp>^d9h_(lIaA6$<Ds^dq$5_v8)K8UFv&hWgesy9@v06i'
    'kCHNcN)8&BoD7iJ328EM^|j|}w&}9h0v2Vti(|}%$+w-WSQ#7wwh^kg=6T(V1LB^U#CyBKr&+9F1-w%l9lT>&CrvAxnXIjOT9|aV'
    'vx_`y6_=b+&Phhd6*fFdbcQ)1*+JW=SvnRE9=3GwMC+ql9Qb6(&MigIJIn7YsM44Pp&}7mnsypFW~irBxSOtap)^gxl2e!sqX^c_'
    '4bBn+=}gO$@rFaFz_3K{+J-1UCS)9hZ;OmvTy7wT4t}&1H$folkl|sxrH2US7-WvV6d|7*O?=jM71Oh-tC;RnS5Yh#AoCn;l@L&d'
    '_Nk)`aaOZh7-3klWLFwSnPS$deMAsTR|nzC3zqZ}npR7^fo_ffTHB|STvFG`nVUF-T2krau&7$RwHlyG2teS$n1r;D%kXK*brpNJ'
    '<|@D>)%yO{j<^OC>MEBRdr!-$e6nkxi>#}-YtW0Re6nkhU(yyIZuXuQO}weDVjnGIiaSkjHLdy#!XEGUPU5sC-y#xY4Zw88s-wU%'
    '6Isdkgf)X`3zO{AL#Wzf^QA?XHFVY-$Rn}|_=VOKi&YFBO_Re<z!V3llmw_;a;9KK7bf2pP1IgBR%q{F{1wD0_f>x@s~QPCoHP??'
    'lz>Fc>fxibMi51CW$)9}78fSn9bMWA?1>p(({`^xE+PqNd`)fUX)A0cUxKGB1x};d=@j%9>(@F1sf48ndKXPBW{9>MpIy^2q=Gla'
    ')LR*?jjEQ68d=HpSe;9v>jJSMIOk!qNtY+%P0hSVLR|NmeQ(N<C`343ufs~+BHV*H7HhBo@;FOty<`D<Zc5f&LS-=;``l<^e%3Vc'
    'Sry1k_bHIsMyw1K6|&Mxwl%4(1;;)+Uvehap>`{GW)MRcS}86$Th~_8h`uaX(#w+H))g4T_94y&wRK^1Vn+`8NvVM*E66Y469Q7Q'
    'Y6w`zIoWD40H-eGx_DZ0flMj05}q!Z(geu#1Q>>hS4a{&Sq@FyHPA)U#9f141WnvE$S-M&4>x;HiYC%cxr&&8RX@(IZA@xh6O4;_'
    'CM<;j!ueLfFRY7j?*q<XL_32-6@a>tykD4PpU}k864VH5OOfoZWX=)_C~=?O3c7$$%nm04L5tVyD>*E1Zlh2wfs0$1eA_fp*t(aw'
    '4y~KkRF1Q_oV99zHmd_9*O{di;*mq^UHZ`66w6oU7-eD7-Eo?jYL({LoP<l%J)S<RLv$!ZxODq*6Ap7!aVn_~X{?AFGp}lFEJe^e'
    'Y2x%17^}Nkh&VL6c3G_hQghPa`HHP;Mzre)hfb}&K=dOzm?##w@bYB5fhH191ir)}P!CpKXx;wNk!7TLSGt`l3f{poYU6BOBcZ$2'
    'W5KcX#c1p^qlxsalTPVbC7sfJl1`(;(A{J|5in~P*AZ4|AZVt@Ik(BK%vcLI9d6nk2L+4FFlg^I<RxqM<u#h=Mx7PjRb3m|O;v|C'
    '31f*NRsveeH5;O!GDDcK@QfHWrzCHo=v&d;uU8-wQwAiWcy3Ro6R{hv_jb{s=RB8FAamD17g->4*Ps_sAamCszoacb-0VFqnpke?'
    '(q^y7ITSp)_O3EZXfb#!iK_x-9Sz7ECYkEUaP-49km)p%!<Z<_!X*2ICi<RcNaB5pxzC=tR=e5eQ_@_O>yY3h*We3*cuWr5sewy@'
    'VwEQ37AD^oO(e%Py6nkWPYaivmGtqDG8rp`xGqc|B(rx=_EB7{sfVsDTE)S-wAH)gG;x#wJd&$jf&tUe(wHj<1yD&%!{<IGUMeX>'
    'OVaEED~t7pa|W-X?3W_woqZG<kyDy@$s`ZA;)iGU910vC0%1%}t-3%gc{Ud<&vaBbthWSP8vXKQyn!Zy?0MlBqBZ!nR={o|FoN9!'
    'Kf-N_t*>Bgj6cTo8i!CG5LMuz*ezxupBqgq&zdHdXGIgsecJ88N2L&C(6D5NSbQZV164V}V@b6gt?n}3+nlpjSUP9%I-A&Km9k(-'
    'H_$ZYU?p2p9zdXuWn^tbjOk9tKt3%ryeMR`ralsVP;UxLR=8btAtgZXp}Aj;CXxpti3M1b-~>D3^oWIvQ@BPCzpxmZxO1ROq=`ER'
    'y#$)LbC6%s79Vc*o)k^Y;Rc$RiK&1mV=lCTHigmca0-Cc`C>V6GrMAU4o0=i5i2ptz-@>NLcuMhuK7pFKB0*z!Z%b$K%m(-@3lcF'
    '9U)i|)?)2A2yslE#sstqh-wWxC}WTV?78QK$+vx)Sg4K2DZ@=xyaW+DjtHT&OpOwAO(jh%E&DNQZ`rHNFu)Q)qH^yGlkTp&iP?kE'
    'v*ws1!}LOe8)!b(E=9eYdFmwSrrC9~p7d4(w1nKUa3#MKLGPl8!*%l31tS-pN|chigfC$=tu!rkxOC|4ShZV#JJMDJY8!yPcnnI*'
    'lkujc(=<br%C&kp8EYX3-wUsk)qH-p1OMi$StwY3iml__DRV0x@c`s<DMCIons~Fs&xI!5Ed5iZiFa!EB~9$151NE{Iq=lLt!GsT'
    'n-PxGt{~c7MCDPf0y(H8Onxd;P0b37rL<s4FYiMYtRbMOSR+t?#zK)wY!euQtM%26JdzKodmfk#=r0Q#abVYiZOeWun)?;o?aiE~'
    'OzDYJC&qgL$vjQKf9@g+YPYvzpv!Exw`0)DXt%dxkYCakA8z)Z0!@Vdz-6@R!c8S?atb|>M%%adFf>|i@lW<SC94HO#X7T%={sOL'
    'XYt@vwvEVjs6_P(lk5|k7zP(Rg{af;XhDSX9AdZP`V%x`bwmL@gL|<n7NmZ-H2s8u)>vmB3zKh)CXVK4BnF~ZXj+CojvO@c&|)0d'
    'dyuQiG1c0@mO>t4>6zr}fD57;7AD>8G!cFkh7VU8CC3&AxNt7g3&DeSuPz2~dje%lsj~x%ED4k0iCcEDL|%%Z&x2j;koX=^wZXO2'
    'Dx+DMUQRx7v8x6)2?Uj{ZA^`zoW3weK~!xV1RkoFR)Pe-VCkP2ySSfre<+aImD5E0P@W(Zl?$alIAv-@tH7xJ^w4EHV2-`G(xZ&%'
    'q0dG(a#*mW8$>foK<pf~r0HUE(Yg^q#(<yo9DKF%OtC@Q+^o4IlU?YeIo+Jrn4o<tn)}t*MXXMTYh&2OiV+}fbMX2IdE`aYa=Ntb'
    '9O&2bgP%3%C9sQ~gZz@V_;9oLDD2|&Oi%fYSKGE{Dko5}_pi?1p8TlLt9~Hw&d&7s;y{moIy^f$ertcnR}SCu5Blozmw3R{pT9gk'
    'JN$_+KK2P_%&XYZ17%;CX7d;`t<t<knAXi)!|W7F3E+FxYpKDz#=UpZ9lgpPV*K*v@MzpV{5W07sk=J0Bn->QP611xmSW37*4z(&'
    '6nF~IMjs)I3TP-q$nNH9T<3CjcnXDpi#=HBiD_fz9HX@uU^O3XO@?zb;yF^PaM4tFSZX5)bkfC`vyXNk6Izji(|f(=K=|z`AO3Ls'
    '^7Os!=1Ifz5eyQ!LA96Oa;}}T^|JyO2+Vd}3r?kVojx{p3dHQeh2cIN-|w9(8(1B5Xtq>F!SYrhbjMZ6I=q42L+D_2&0uH>-L(`}'
    '+bEgM1<<Y>38eF`x2;3p>kD}F*DLc|3)pgJ2m)r{Cb(RQ#0BQp%k&Cu%m{fgORScRX9q?MvJd<3UaG5b?{~fOij}W_bZ~ymr{`}@'
    'F4pfxj35;V#nS=@yiDx@1A+%`Mv#e|wSr8Vrli@0f>_R{hG00S%l+Q{`opoy>nle~s{y#=Lx2+D^|^(}wi$~lhhKm#4w)Y6WG%@D'
    'EVRM9WZ^+zL)Pv>vV{8zzYeHiWapa~LrUn(u$w1?oN6}r6;(km6>*a$jV1&bQVQqN;D7_(JW6o`w&v?SU%a+`y&Qm?shRD1-8qwF'
    'DE7eW!!b7S_W~x!-LB%<K6P}#k0H@^dNAwO?$_Fs!%YQvre7rb`juK4^wUReoto|QVUfY2UFdMqkQREyIjPS?IRJp=)nRNbI>zvw'
    '<2_&b)5+1hw}3B)Kdimp`sD<dAzGbx7Tp6p6ns^l@UWbQ<_S366?W|_R=bkId8l{XWB}0IQmpodmtSSzaKL9LM@M?LS#wV`3*MA1'
    '(Yo}G$0E*!gaNcNd=-S)>N^0X6iX2mB1;PeFhTf=<GwSlM=INvRzc!rRiU;Df(To55f8ss9XaUVw6jD~Uj*@-t+H9o&F-wvp2>&%'
    '>f5F71a?Houn@gjc+zgCx6O$iYL=b`2uaFC9pnX+Zde%-^*VL*L=^}PIyfg>DaC$Y$=^WN2ZG!YzhA$2hT2y5;Z68pKp@w`E?I;k'
    '@;nS3vLgg4th@`A;M<+maI%ffuD?|5!(+IYi<7hWFV8JtDX<41)C>q5gL)vijRcS0Df$!{e%{iUy(I4h+TO<mFqu}yYy?-sohyEH'
    '*sl%&;d}kgh6U^19^k<XfoQqg{%l3uop7;2Wom5*zD_4lP)rT~@<p{^{o9U>o*h_X^P__kIM`Qbdj9U{;$uR_$S^=GXMvknpArF-'
    'V}UKdyQ-&<BOLIAI+AMw>@X4AnW#^@Y$x-<#&w9V9AA7)EwJ7<%?Ch3s2`UAph&$tGXcTBt>;w7unCV!vvDf|+EWq`4IpNJuwel~'
    '2zw@s2C<-8QB%Y}a8r=a5=Yp~=Z8xk-nxRqU@^K#H6bw0?z6|N0jsBAAq%UH=m8MPY!#cM-K~}wq}4hfZ`{JiC&!1vM=y^~ez5yb'
    'nAE74VDBAxWU-BN0K$ZEhC$3=;uE?Nz{c}j6~VK5TSf^4i_!S;Mt)sW08(0naavm;1a26y2kAv1fibrPhb04mtw{kqAF~M%CzL6;'
    'Y<o3S-NTK0S9QoOP07Ww`2f%{*V!WklmeavtOG#aD$QKs2s|vYBS6Ot7y>#4mjN0KuPu)^?oTyE3t%Zgn5l;%L^xluSP`lK>+E1m'
    'f$VH0RqAjpK|1_wXkGFcwWY@!`E^aHk*&<%XbCetl)*gPF#6`g1iBUn2pdQ2fc69aFGo0hif}xuGtCwrY}`9<{$1A;fst8l#?s)V'
    'hi#N#R^et`HpmCUf#_lI0mFsE%n@j{&YG;YNUb^P<Bj_hO~F*B5+hg`kVMy3Fr6LTaJG@am90=t2{B?Ra)Q;v4Z`H@^a?mPaD2Rx'
    'U)PjkQw<Q(J%ddJ_-X?y!2|sU0DY~9-^Ti-i}Vh@kUCgVokKL@H4o?uca;*lt|=)_SfU-nvw~u0nSd3RwbltfdbB>kQ$UMbgE!3+'
    'D5y%V@IhAm2m(FcxVJS$n;Piy8e#zWW^W9mM>hhvCCC;iaCguNaBXf7r%udtEft_0erU(J$b*i2%cpce<AB*7KIb$hlP4aw5l}0}'
    'Y!MS-E80#=x3Pn%;cwOKw&a{2ZpIbS0Y+r0wE%LMF@$IBO&nMP@Dpum3Jel63n~SukKmpXht45eHx0{-O5l^;(C;jwNi=%_?<yGm'
    'z~p$&k2mgZO^JfpbBfrW863@;en2k<BB--%D=56nG%~j+u-{>OK$vG^(QN<`@Z*jAx~AyFxK+tc=sjFspQ|k!qtGsO=oa8q)*N65'
    'Nj&&3a5my9I8w(?(!=4Dovl=_YYG50)<1^U@~|?i&UP9Q{zm~X5liqzxI{E+R@6BGs1;C21;Nt>k3Q1ljeA>Dtk6A|1bAX!k_sXT'
    'A_v<vpvXmO0CJb;9k5D-#RGF%s}Xp^(0GhTobfI015GUm=uRjg;>fVlS|b3L1OP=SMYL3EH`oCQn1_UcM#r#cp8<d$5YdKpnc(CH'
    'oM3}8+Gf9iZvh+uV{d6n&R{j(?mmxbHQplI&N-}5DRr*VI*m6(Cr%z%t<VUyfKhS<T5~z|#~b&yrT{p408_io+-mP&Zvj3~>$K)N'
    'Jz?@S7l!wUC6NOM?XjhZA=g*|ZS&)ed@K3{gl%yG$77r<=HgoQz85S4z)gqEcCvP=)^ZgxITz}x0vH6IB|IG41gwW<T9Xe0b_2ND'
    'Ds17+t#`P&yrn4=U9pT?@Zt_{X^ldR@BprQXVjCyb6^8XaatSW!o3nlcuX)RuMddCcaHlLO@ZYJff0-v2?ojqs^QWAcW00X2-T`<'
    'cFsV<3QiWT78BySP{4GLH}Wk_S?%XX0_r7c!CSeB29>v_yJ<jS3dQDToEeH|g~5|utA$H()XdvF*tokRU{OH)UZB+#>dItX7x5cG'
    'q_}OCY-RUdv=R~U&OTb5Z$w;Se0C1F61Wu6k_OMHsaO@e<a)_5PXt!+k2mg5qK^-~1ISiDS?G#J5!>3dMY21|2&U7GG$#lJ%vEQB'
    'bOAuur5bw3{qaVAT~m5?_)KP~0e65BU@1EcMC>U#G4?Ra5IZ9oh?S9DMbs}E!Kmhd{yZGM+S!zGEBb)-x7DVbb)7)OlmS;b)Fa?1'
    'l*261SvDP_eJv`<*^wk1k1`Y|)yEt6wx$4L=L8qxIuJ`!ZlrzU2PxZb1_+%G&4FY<&wJ0-L<3;VvL^tAK|lKAjr_W%%!ttf(^!R&'
    'Sb;w@c@LaDrNMc3g3feuv6)hLJ3T0)aV)mk($h>2$9<-{JlNXaV{QOD!6S<u&W{$l74+TGlnw_-E}LCCS1qlf%)psP%~9cGI=I<D'
    'n76j&b0n)6**Rhg48m!dk2mgZO|g2FG<8rEJIsb9h6>L<KqZHvO9t-B9e)Q1&j~_WQn)J?p}_G1Ki<f<_EUr=Lg1K#GGaS;6R=^#'
    '69f#+3X2xoNQ}T;SO!2?+YRS5JK(wXk{J&+Zi|l~RW*V^!p}~->%&G`7+?-Sbz4)w8&~HXUI0cga1S0FqU9UdDOkg^I80fAbVPlc'
    'jf8Ap9O%9_|A^z>))X(69XIQ${zY^F;W1BgfF%IlF|Z2d<PnsTl~|@~r@zG+_8b*%h#qg`*EPl0><sBbH5z<io&`ZNBH&od-v~rI'
    'i^Lv!jCNfMmdha(adstz>~6{fYWR-(6kE|})M1-NAbQa*$;brAnpP7E;S<i(z#6a>@NI)VMs-$Xu19BOq3y8s@y5NaDbw0wnX?|?'
    'Y2XK=QWj&$J`Fbrn8ih_gq|{6#t?MHQnYlik7Km%9&hB=HN_68dkoVx1R#KK{E0a>9E?%NQHHm&+?~OR;8<n==4Ci5M1F5gejd&j'
    '?kv!7T~h{pg=D+qj~Pd3G$EnzoO7*XL~9*Yfy#QdD?~gI;(Y=SoYw7TB1S#lxVJSWP*?8LGE(}=AEq|v%y8it>Z%5TWDpW($wF9>'
    'VTpYX@Yh+3R@n99jr_W%#7RKn4*y}yW$30dpiWo-AeL2>2g`6CS_i#O){!z*Z+qq4yBXZW`NEx9l-oW9EG(5=dP|l)7jj^XEO*VG'
    'EDx;1txo7i7}?-e@bK&yIrjlMojl&Sw>2d@2H}|ikKQ7A0aq;y?o+t|3zj%iC2P%u$+k@8NxlHm64Z%cpY(_`zU5QEF11>MG=M4~'
    'V5w0f9C|FNV~P=cvgLshF}$V#-HzVusFv7ShC*ISch9SdZBQy6??0R+>aa5w4whX5xI3nDv@(B^MF#v&K-6tO4w$bDI5ve6>}M*5'
    '18D3QD&cC$bsU_&d4FztXk$2kclNQ1cCW%NhNhtxsKE>g%)D1>&_Ny<4k}boogSMF1;lt2GZ3-E0J6>t7u%%$*tJmL-UI*&Qf1f^'
    'xUEn}T!be9hzcQ;n7gE6t#@s2r+c<`;nvEahNZNE+mcm|`0(uqhpu+U4Of`p5#hu=s7NmbWC5I5t?{rmfL8z-EMBHCOH@xDd=(%K'
    '!Y<`1%I#*_0C|BD!YZ|;gHrJD-T~_dfU=s~s@f(XZwn<raPK2^fCEQ%!PVELO1R5RtECk~cbhmMq!twOVCSmcplBh@@Yz(OG)sU@'
    '4cx-bT(a{B{ZW(`F7`DuZL^EF>Zz?+t_rZy006ct;RyAyOR(H>5kH{hK(Dq{M^zoilI^!?k+NPhQ<e$0o79+@Qjuw=%%Kd;2JOM+'
    'V2*WyQ#a|BU>1PX8Pu8PfS=}NbOZPPu4vl9qVsB>7rbu>ATewarU*D{_ZvC@C1noMqMr=@4GAZ_Q<v$0>f%Br+-0VCZmD53%d)cm'
    'solcH48`uAk3Q|LV{9GaCygW#whWqx|0F+km7uh6v9FowV5g#_>J34Hy&Exw=2DDOOVa9l%ng*&(qfwfZ7w~`YPFKF?r|<s)@x=e'
    'mVs=WwJ{p!W&s!ny$a$%NSjqG19}I!^U@v0g<o5Y4WVOkDf_;ZUWIp<X^M?%N>$-q5icEADG31vzQ^vZSgv=T>>xdSP-@_a&Fbxq'
    'Ie;g0sS@roQ_#c4;4TQDT!^a79EPnar8>*ZP~sdzhPnnYc8)EK1g0DlMh|zE7B2QRGwob*$YAhxpkrm|wHLLkU>&Fk^2g+Jh=BtL'
    'DI6Dr43>!iHfM)^S6QU2*UZ$;<%l5zUgH39nI|hW8{AC+npl&S(yz7&V`(ov+pZC4DMc&Ola|rC%hMfZ3J>H`cRVap%9JqZP;hVn'
    'UBnHBWqO28g0zF|6F`RE^xNAtfUuB0-JeRh%S=n^2%NDeR~cgh%$q6as?E~FEV<p1A*<cL2y;^H<gBP7*9f));6E2G_H}Lw9G`l('
    'tDhAT#ObUM62w+%-O}a+v|Ir%edw063)Gu@8zliUQdme4wryFjnW-0`zz9W6uBqjZ#tK&(G!Ihv*a-0vPFEKb0Esz8pX?k!tQj&!'
    'vW()1cXHEInssmHL9;u-`0;(vG`P}ity^?hR=QUQ{@NMuvU;}ofmn(iyzx>c+-0T`@?hIX@*~<Yd}0@q^ghHAPN!i87-x#z%M3K4'
    'as#p|$#$6vPg%Iw*UU5ryY2&hbxbfk1!IGfdTZT^|5g}nChvlDhLZ{&n#;52k%=bg&q4tHo!qort5)ZMbA2Nq1o#$cGeK-9G1e^c'
    'bQPW`E1WHpop#}U)vCSrzLaJ>@h)zvCE984fMo_NU?9K(1<r=NDxhG{5L!=Twh0*D>^`rDRRiZ!$z!CpPziUL>GTaAwx=epuiEQo'
    'pPl$bqxMzllcrEn!mGW9J6fd%_g1tuDX~|#aIvqMX;R<Xj9R%^WxHOpx^69)W|*xwXE)z?0^R3kvd%dN)S7`T)WL>jk+N>@^p0HM'
    'Lamx#2lUBmnJ!`4H4Ql54xHF0me{W<h5$jWvgTWic7LHP<G3QWyUer=r>2w6^3=3tU&xJ?vTM#c!wp=sfQSz24pFAon48p^EL(}f'
    'T&RRQqiM7oK0pi|p_9e{G)R{0UZeGyaueuww!m=1n1H}NGdN8qJB@0Nx-4AmYi1g;UJ0Z-6s%lRR}0kI^#WwrxQKPLW4m^aNCWm$'
    'FcWq$-b#eU%+hs{vR*UOlubrU9GZ@DLa-SX+ywxFQo_^KE~Q1MtIHxVSj){Q07r0H%DyZ_iSOd3AZOFr?M0$id<jYIPSK?9+hnfR'
    '$Y9uBLhNyN54Z;cqop^8iLeV_3zcw}ncAHm5->2$0D9Jt!HQ!fVA~WGFTm0|h?o#+3x^RWFn(<s;eT7_g|yO+_v5B;!x1jVld+iC'
    'ib39LHAa99{S;->V=DqQOYS*xNY(l^kWzMWDaRG@E^b=Kv{oWx03h%LEpeu+FiV6?Z@ERYS#t&t`AEcSrTYM~=Y_30N?FDROS%j6'
    '5?NsaYu*Ry4Yu7V0>N8K8zs9F<7Qzi$fRmHGnW525lZ2U>|nev#7xsK2EEC4G#lIXn2MzXYa#NrB7kOVdnUHS1bZ!GW;ZQ8K7gE4'
    '2he9s#Zt05?gx4)l3KHG2%(6on!5tTs|$T(4?^CW-6|`iP*;-76jMXU1)`u;z0F0+y2VZH9u7Ve+<+5xcF8mq5S5mERpn^gXK+?g'
    'iVnO`!C<SzJSD~<vW%VHaMyuMz{@y=;aI$9yJww}T~|-VvIf;#ztL<d!_ntt7l5XnK~=TVaTW8iPziVL^dcxiE1`sBel|49Vf2Au'
    '$|T9k+<>Zz-GH+!vu-(B!Mh%;G?U%fTDaKPK`$0K&x92lnc$0q%m^M69S?va+tnrO0_@1gGzNY+ytg`c?1G1d>mp^nzSBF@jtz&i'
    '%PfQKR3?=fZSSwcND)ufI*QmSsc&#dVwWVu5M$_;Z?=@KjCX+ED$;~19v^yMWgr6<ST_hrZFdVmM!U<EftH}x(ODQG5CNayy*Mva'
    '!ky8S#QIeiM2%4K>e0FtkpzbWA+`Mm%Q_Fm&oJP8ZBc;@BS4gDu_A~I7yFu-&gyLE%hF!E!pBBy%*}q<oy20r6vQEVs!L5EyzM2q'
    '8L{m64Mt7NT;gkHYK&Sn)11{uJPszA?J~Vmg_vL|62WD>gYzZpCeUN5)_4Gfws~DhlQMtT7ShB&Li6MhDrKgLCjhi3>q*X7%nHiw'
    'axZ{K%`zvOwZbh9W5VAI6E9T4U1ka}2fL%(BJ6e5S<Vj^Tkjsq8!StOxfBBo0>kamHdSDy%@-gKZe!tMU+1P1m^b^-01FH&Ost}`'
    'oST&*h}l_o4g*d_kQpnQ*^)pB0x6qwN_~;CZlyN}#oA{lD|#5A)8OBrtF}GFSkDpQd}?eN7>P>;m~bF(D|no2vve7b$lqzEGgv}K'
    '>sU5m_S{FArH&CC@PK8d`_M_L=K&-bdWDEu?K-oS<;${A33r)kF3IYcTBTUS_`|u95l*_Z17ka{5S?b6twpQT<JF2%HxM8I;L21M'
    'F7`Du4WZdhBnYaLLe=4A){b~-1wX}72&+{Mjul)yXEsn30IQg4w1DdtDeKmOOaQ@-O}v%H&B+opB9zqIl^I~*!3EF=1F*8x6Q((0'
    't0~MX15~{(rpMe}H)NoJoB`zumxM(FNFW!Z@1Zo8oQ?uQ(?d$u8!#fCRx3Rr)DU<k#f3_^%S;*Y$k{y+&=;s~4TD^EK@vuhf|e-5'
    'GIrQAz=U05h4KcghAnD^pu)n%z7BfZ5c9TVr!qvcVre<z3C;l<c##Y@)IFkU!z(aMaPbCNt0%i8wMbd7nQ4>Mt-5fs+VFN)KNhj$'
    '7e8xGRe^wFtj;=IR<<Kk$tr1RgbF9Xq{lSV%OcH}mGBQf`-xZUO~2xI7jI6^4lmwscSpc%Sao$+bhgfW@KIUp_HzQdN{CBA1y82P'
    '%|%C{un_*|YG-Hn!ur#hqVo$ryLfkcz&~8M3fYQXNC}A6D%@J>png7C=|Uccv14M`31j}|=w1L~oK+05i@_r4QQP2t;pw>+9UN!7'
    'ch(X@L`ha`(=KSYK6Q+&*0CU9GAcE-n&L9>3dJ0zX(hhlVV;oI=-E&D^5jZ8a6nh<Vh(TV0Ryb!h_`)|$uYpZn1Xn?BTj7j*sRf2'
    'E69g9;^A|Lw5KyS{p950{NjvH*G;BAz(e3d03vN!!>S^YYb827V^|gX*=H>vdK{{B@Ec1=i+C@Pady^d;t45FKRfx+?r2|~9RwZ?'
    '(Q(g|#0&iLu!~hx5t34D6HXe_GNC&WoPk0F=(GYMRv0!zkDkoz92}j<x<keXZmfRfLB^y4_i8;)tTBbL`~q@eR{-4fy%30_58lN&'
    'Cc-*UO%M+B)b!><DBsi$&Ui}m@VW$}!JO1d$tp`T#o$`RUxJkwf>LF;nPy2xm`^JRmMd|63e)qU!^PL`gYgYd+{MZ1x7D*!jt<QP'
    'U=Amu=jR_Uk5{OF4<XowH<;;k0ypWcKpw@C(&WmJ2@7dpt~ftwuyua{X~+x7t@~I2;Hfr{eS+fMaN+bxiuduN-qTz?deY)OaodYe'
    '+x9*tB0o*>p0@3!r>&gfX$OXni55>Y?mcbSLQmWFJ|2iXxOhMR!*}ae(XX$xV}5<vcNuT^ifyX@;k#8A=&v)fyBbjc!*}cDczyZs'
    '*MG&okNN0xMs>Biqb<wX$;rhH&%?{{Nj*HhxbtNj)jT~s)uY2>eZ?0S`qnm2e0Via<lVWB^}Anfp0<|k=l>5NY>H9'
)


class SourceValidationRefusalCleanup(unittest.TestCase):
    """Portable synthetic zero-effect filesystem/receipt model.

    No secret preimage, original task/model payload or provider calls. The real
    original88cb proof is separate. Git producer bytes and their expected policy hashes are explicitly synthetic
    test doubles; all metadata, receipt/hash and new authority guards execute.
    Real original17-blob custody is proved separately by actual88cb replay.
    """
    def setUp(self):
        import base64, zlib, hashlib, runpy
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        data=json.loads(zlib.decompress(base64.b85decode(SOURCE_REFUSAL_FIXTURE)).decode())
        original=data['root'];self.producers=data['producer_bytes']
        # Replace original process identities with values above Linux pid_max.
        process_ids=set()
        def collect(value,key=''):
            if isinstance(value,dict):
                for k,v in value.items():collect(v,k)
            elif isinstance(value,list):
                for v in value:collect(v,key)
            elif isinstance(value,int) and (key=='pid' or key.endswith('_pid') or key in {'child_pid','supervisor_pid'}):process_ids.add(value)
        for text in data['records'].values():
            try:collect(json.loads(text))
            except ValueError:pass
        replacements={str(n):str(2147000000+i)for i,n in enumerate(sorted(process_ids))if n>1}
        def rewrite(text):
            text=text.replace(original,str(self.root))
            for old,new in replacements.items():text=text.replace(old,new)
            return text
        for name,text in data['records'].items():
            p=self.root/rewrite(name);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(rewrite(text));p.chmod(0o600)
        self.proof=json.loads(rewrite(json.dumps(data['proof'])))
        self.receipt_path=Path(rewrite(data['receipt']));self.receipt=c.read(self.receipt_path)
        self.campaign=Path(self.proof['campaign']);self.runs=self.campaign.parents[1]/'runs'
        relay=self.campaign/'shared-relay';authority=c.read(relay/'authority.private.json')
        authority['source_sha256']=hashlib.sha256(self.producers['scripts/cloudbench-shared-relay.py'].encode()).hexdigest();c.write(relay/'authority.private.json',authority)
        owner_path=self.campaign/'shared-inventory/owner';owner_path.write_text(''.join(k+'='+v+'\n'for k,v in authority['inventory_owner'].items()))
        old_inventory=str(self.campaign/'shared-inventory/scripts/cloudbench-campaign-inventory.sh');self.proof['files'].pop(old_inventory);self.proof['files'].pop(str(self.campaign/'shared-inventory/stop'))
        self.proof['files'][str(owner_path)]=self.sha(owner_path)
        authority_sha=self.sha(relay/'authority.private.json')
        for name in ['startup-agent.json','ready.json','serve.once.json']:
            value=c.read(relay/name);value['authority_sha256']=authority_sha;c.write(relay/name,value)
        self.write=c.write
        from deploy_test_historical_custody import environment_identity
        from run_deploy_pipeline import LANE_TOKEN_ENV
        parent=c.read(Path(self.proof['parent_environment_preimage']))
        child={**parent,'DEPLOY_GATE_REQUEST':str(self.receipt_path.parent/'request.json'),
            'DEPLOY_GATE_RESULT':self.receipt['worker_result'],'DEPLOY_GATE_TOKEN':self.receipt['token'],
            progress.ENV:str(self.receipt_path.parent/'progress.jsonl'),'DEPLOY_LANE_SCOPED_REUSE':'0',
            'DEPLOY_CYCLE_FRESH':'1',LANE_TOKEN_ENV:self.receipt['token']}
        self.write(Path(self.proof['child_environment_preimage']),child)
        request=c.read(self.receipt_path.parent/'request.json');request['custody_child_environment']=environment_identity(child);request['custody_runtime']={}
        self.write(self.receipt_path.parent/'request.json',request)
        self.receipt['execution_binding']['environment']=environment_identity(parent)
        # Re-seal modeled canonical/local audits and semantic receipts after
        # changing only workspace/process fixture identities, not authority.
        def tree(path):
            h=hashlib.sha256()
            for p in sorted(path.rglob('*'),key=lambda p:str(p.relative_to(path))):
                if p.is_file()and p.name!='source-audit':
                    for value in [str(p.relative_to(path)).encode(),p.read_bytes()]:h.update(len(value).to_bytes(8,'big'));h.update(value)
            return h.hexdigest()
        recover=Path(self.proof['source_recovery_journal']);results=[]
        for fleet in self.runs.iterdir():
            if fleet.name=='_hub':continue
            life=c.read(fleet/'_batch/lifecycle.json');owner=life['fleet_owner_token'];canonical=self.root/'.git/cloudbench-fleet-audits'/owner
            manifest_sha=self.sha(fleet/'source-manifest.json')
            for directory in [canonical,fleet/'teardown-ownership']:
                meta=directory/'meta';values=dict(line.split('=',1)for line in meta.read_text().splitlines());values['source_manifest_sha256']=manifest_sha
                meta.write_text(''.join(k+'='+v+'\n'for k,v in values.items()))
            journal=fleet/'source-lease';claim=c.read(journal/'claim.json');value=json.loads(claim['owned']['value']);value['source_manifest_sha256']=manifest_sha;value['custody']['manifest_digest']=manifest_sha
            claim['owned']['value']=json.dumps(value,sort_keys=True,separators=(',',':'));self.write(journal/'claim.json',claim)
            ready=c.read(journal/'ready.json');ready['source_manifest_sha256']=manifest_sha;self.write(journal/'ready.json',ready)
            seal=tree(canonical);life['audit_sha256']=seal;self.write(fleet/'_batch/lifecycle.json',life)
            (fleet/'teardown-ownership/source-audit').write_text(f'path={canonical}\nsha256={seal}\n')
            journal=fleet/'source-lease';physical=c.read(journal/'recovered-physical-closure.json')
            physical['producer']['helper_sha256']=hashlib.sha256(self.producers['scripts/cloudbench-source-lease.py'].encode()).hexdigest()
            physical['source_manifest_sha256']=manifest_sha;physical['custody']['manifest_digest']=manifest_sha
            physical.update(source_audit_sha256=seal,original_claim_sha256=self.sha(journal/'claim.json'),
                original_lifecycle_sha256=self.sha(fleet/'_batch/lifecycle.json'))
            self.write(journal/'recovered-physical-closure.json',physical)
            closed=c.read(journal/'recovered-close.json');closed['physical_receipt_sha256']=hashlib.sha256((json.dumps(physical,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()).hexdigest();self.write(journal/'recovered-close.json',closed)
            intent=c.read(recover/owner/'intent.json');intent['original_lifecycle_sha256']=physical['original_lifecycle_sha256'];self.write(recover/owner/'intent.json',intent)
            result=c.read(recover/owner/'result.json');result['log_sha256']=self.sha(recover/owner/'canonical.log');self.write(recover/owner/'result.json',result);results.append(result)
        intent=c.read(recover/'intent.json');by_owner={v['owner']:v for v in results};self.write(recover/'results.json',[by_owner[x]for x in intent['owners']])
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'));summary=c.read(self.campaign/'summary.json');group=native['campaign_group_record'](summary);self.write(self.campaign/'hub-group.json',group)
        ack=c.read(self.campaign/'hub-group-publication-ack.private.json');ack['record_sha256']=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest();self.write(self.campaign/'hub-group-publication-ack.private.json',ack)
        adapter=Path(self.receipt['worker_result']);self.receipt['native_cleanup_reference']['result_sha256']=self.sha(adapter)
        self.receipt['cleanup_owner']['native_cleanup_reference']=copy.deepcopy(self.receipt['native_cleanup_reference']);self.write(self.receipt_path,self.receipt)
        self.proof.update(owner=copy.deepcopy(self.receipt['cleanup_owner']),receipt_sha256=self.sha(self.receipt_path),worker_result_sha256=self.sha(adapter))
        self.resign()
        import deploy_test_native_cleanup as native_cleanup
        self.native=native_cleanup
        self.policy=patch.object(native_cleanup,'SOURCE_REFUSAL_PRODUCERS',{k:hashlib.sha256(v.encode()).hexdigest()for k,v in self.producers.items()});self.policy.start();self.addCleanup(self.policy.stop)
        actual=subprocess.check_output
        def git_read(argv,*args,**kwargs):
            if argv[0]=='git'and 'show'in argv:
                name=argv[-1].split(':',1)[1]
                return self.producers[name].encode()
            return actual(argv,*args,**kwargs)
        self.git=patch.object(subprocess,'check_output',side_effect=git_read);self.git.start();self.addCleanup(self.git.stop)

    def resign(self):
        files={}
        for raw in self.proof['files']:
            p=Path(raw)
            if p.is_relative_to(self.root/'scripts'):
                name='scripts/'+p.relative_to(self.root/'scripts').as_posix();files[raw]=__import__('hashlib').sha256(self.producers[name].encode()).hexdigest()
            else:files[raw]=self.sha(p)
        self.proof['files']=files

    def validate(self):
        return self.native.validate(self.receipt,self.receipt['cleanup_owner'],self.proof)

    def test_source_refusal_keeps_original_signal_command_and_no_credit(self):
        original=self.receipt_path.read_bytes();entry=self.validate()
        self.assertEqual(len(entry['participants']),15)
        self.assertTrue(entry['source_validation_refusal_cleanup'])
        self.assertFalse(entry['credit_granted']);self.assertFalse(entry['financial_cleanup_credit'])
        self.assertEqual(self.receipt_path.read_bytes(),original)
        self.assertTrue(all(not row['original_cleanup_verified']for row in entry['original_status_facts'].values()))
        self.assertIn({'command_exit':1,'signal_lifecycle_exit':143,'original_cleanup_verified':False},entry['original_status_facts'].values())
        old=copy.deepcopy(self.proof);old['layout']='campaign-v1'
        with self.assertRaisesRegex(ValueError,'native terminal lifecycle'):self.native.validate(self.receipt,self.receipt['cleanup_owner'],old)

    def test_source_refusal_successor_rechecks_genuine_validator_and_flag(self):
        import hashlib
        successor=self.receipt
        prior={'gate':successor['gate'],'token':'e'*32,'owner':copy.deepcopy(successor['cleanup_owner']),
               'excluded_resources':{},'proof':{'receipt_sha256':'a'*64}}
        original={'token':prior['token'],'finished_at':successor['started_at']-1}
        expected=dict(original_receipt_sha256=prior['proof']['receipt_sha256'],original_request_token=prior['token'],
            new_request_token=successor['token'],source=successor['source'],new_native_root=str(self.runs.parent),
            excluded_resources={},credit_granted=False)
        request=c.read(self.receipt_path.parent/'request.json');request['isolated_validation']=[expected]
        self.write(self.receipt_path.parent/'request.json',request);successor['isolated_validation']=[expected]
        self.write(self.receipt_path,successor);self.proof['receipt_sha256']=self.sha(self.receipt_path);self.resign()
        entry=self.validate();entry['occurrence']=successor['token'];key=self.proof['receipt_sha256']
        state={'plan':{'gates':[{'name':successor['gate'],'command':successor['command'],'checks':list(successor['cases'])}]},
               'attempts':[{'phase':'focused','source':successor['source'],'results':[successor]}],
               'reconciled_owners':{key:entry}}
        before=copy.deepcopy(state)
        self.native.reconciled_failed_isolated_successor_v1(state,prior,original,successor)
        self.assertEqual(state,before)
        for defect in ['missing_flag','wrong_layout','altered_proof','altered_input']:
            with self.subTest(defect=defect):
                changed=copy.deepcopy(state);record=changed['reconciled_owners'][key]
                if defect=='missing_flag':record.pop('source_validation_refusal_cleanup')
                if defect=='wrong_layout':record['proof']['layout']='unknown'
                if defect=='altered_proof':record['proof']['files'][str(self.receipt_path.parent/'request.json')]='0'*64
                if defect=='altered_input':
                    path=Path(self.proof['child_environment_preimage']);raw=path.read_bytes();path.write_text('{}')
                try:
                    with self.assertRaises(ValueError):
                        self.native.reconciled_failed_isolated_successor_v1(changed,prior,original,changed['attempts'][0]['results'][0])
                finally:
                    if defect=='altered_input':path.write_bytes(raw)

    def test_source_refusal_changed_environment_or_lease_receipt_refuses(self):
        for defect in ['environment','coherent_override','physical','intent','recovery_exit','unknown_file','claim','source_policy']:
            with self.subTest(defect=defect):
                if defect=='environment':p=Path(self.proof['child_environment_preimage']);value=c.read(p);value['BASH_ENV']='fixture';self.write(p,value)
                elif defect=='coherent_override':
                    from deploy_test_historical_custody import environment_identity
                    for field in ['parent_environment_preimage','child_environment_preimage']:
                        p=Path(self.proof[field]);value=c.read(p);value['BASH_ENV']='fixture';self.write(p,value)
                    q=self.receipt_path.parent/'request.json';value=c.read(q);value['custody_child_environment']=environment_identity(c.read(Path(self.proof['child_environment_preimage'])));self.write(q,value)
                    self.receipt['execution_binding']['environment']=environment_identity(c.read(Path(self.proof['parent_environment_preimage'])));self.write(self.receipt_path,self.receipt);self.proof['receipt_sha256']=self.sha(self.receipt_path)
                else:
                    fleet=next(f for f in self.runs.iterdir()if f.name!='_hub')
                    if defect=='physical':p=fleet/'source-lease/recovered-physical-closure.json';value=c.read(p);value['native_observations']['machines']['foreign']={};self.write(p,value)
                    if defect=='intent':p=fleet/'teardown-ownership/expected-fresh/intent';p.parent.mkdir(exist_ok=True);p.write_text('ambiguous create')
                    if defect=='recovery_exit':p=Path(self.proof['source_recovery_journal'])/c.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']/'result.json';value=c.read(p);value['exit_code']=1;self.write(p,value)
                    if defect=='unknown_file':p=fleet/'teardown-ownership/unknown';p.write_text('unproven')
                    if defect=='claim':p=fleet/'source-lease/claim.json';value=c.read(p);value['consumer_owner']='0'*32;self.write(p,value)
                    if defect=='source_policy':p=None;name=next(iter(self.producers));prior=self.producers[name];self.producers[name]+='\n#changed'
                # Re-seal the external hash map: semantic tamper must still fail.
                self.resign()
                with self.assertRaises(ValueError):self.validate()
                self.tearDown();self.doCleanups();self.setUp()


if __name__ == '__main__': unittest.main()
