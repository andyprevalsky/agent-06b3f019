#!/usr/bin/env python3
"""Actual cohort shell reconciliation: one scan, held owner, durable outcome."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import tempfile
import subprocess
import time
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
MODULE=ROOT/'scripts/cloudbench-cohort-reconcile.py'
loader=importlib.machinery.SourceFileLoader('ticket_fixture',str(ROOT/'scripts/tests/cloudbench-cleanup-admission-tickets.test.py'))
spec=importlib.util.spec_from_loader(loader.name,loader)
tickets=importlib.util.module_from_spec(spec);loader.exec_module(tickets)


def function(source,name):
    match=re.search(r'^'+re.escape(name)+r'\(\).*?^}\n',source,re.M|re.S)
    if not match:raise AssertionError('missing production function '+name)
    return match.group()


class ReconciliationFixture:
    def __init__(self,case,kind='clean',width=3,barrier=False,campaign=False,mutated=False):
        self.case=case
        self.campaign=campaign
        self.mutated=mutated
        self.ticket=tickets.TicketFixture(case,width)
        self.root=self.ticket.root
        self.ownership=self.ticket.reserve_root
        self.calls=self.root/'metadata-calls'
        self.barrier=barrier
        for name,host,policy in [('foreign','foreign-host','reap'),('retained','fixture','retain'),('live','fixture','reap')]:
            directory=self.ownership/name;directory.mkdir()
            (directory/'meta').write_text('version=2\napp=fixture\nhost='+host+'\ncleanup_policy='+policy+'\n')
        if kind in ('unknown','failure'):
            directory=self.ownership/'unknown';directory.mkdir()
            (directory/'meta').write_text('version=2\napp=fixture\nhost=fixture\ncleanup_policy=' + ('unknown' if kind=='failure' else 'reap')+'\n')
        self.before={str(p):(p.stat().st_ino,p.read_bytes())for p in self.ownership.glob('*/meta')}
        case.assertEqual(self.ticket.prepare().returncode,0)
        source=Path(os.environ.get('CLOUDBENCH_TEST_RECONCILE_SOURCE',str(ROOT/'scripts/run-bench-fleet'))).read_text()
        # Wrapper and original full scanner are both production functions.
        self.functions=(function(source,'reconcile_stale_fleet_registries_full')if 'reconcile_stale_fleet_registries_full()'in source else '')+function(source,'reconcile_stale_fleet_registries')
        start=source.index('reconcile_stale_fleet_registries || exit 1\n')
        end=source.index('# Recovery may have removed active machines.',start)
        self.callsite=source[start:end]
        if campaign:
            end=source.index('# ── App-wide capacity guard',end)
            self.callsite=source[start:end]
        if campaign:
            inventory=(ROOT/'scripts/lib/cloudbench-inventory.sh').read_text()
            self.functions += function(inventory,'machines_snapshot_identity')+function(inventory,'inventory_index_healthy')+function(inventory,'inventory_borrowed_generation_wait_seconds')+function(inventory,'refresh_machines_snapshot_after')
            index=self.root/'inventory';index.mkdir()
            self.index=index
            self.publish('.generation-before',0)
        if mutated:
            self.functions=self.functions.replace('reconcile_stale_fleet_registries_full()', 'reconcile_stale_fleet_registries_original()')
            self.functions+='\nreconcile_stale_fleet_registries_full(){ reconcile_stale_fleet_registries_original || return; FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED=1; }\n'
        self.body=r'''
registry_meta_value(){
 printf '%s %s %s\n' "$$" "$1" "$2" >> "$CASE/metadata-calls"
 if [ "$BARRIER" = 1 ] && [ "$2" = version ];then
  printf '%s\n' "$$" > "$CASE/entered-$$"
  while [ ! -e "$CASE/release-scan" ];do sleep .01;done
 fi
 sed -n "s/^$2=//p" "$1"
}
fleet_registry_cleanup_state(){ printf '%s' "$2"; }
registry_owner_alive(){ case "$1" in */unknown/meta)return 2;;*)return 0;;esac; }
release_cleanup_disk_reserve(){ echo FORBIDDEN >> "$CASE/provider-calls";return 1; }
acquire_registry_recovery_lock(){ echo FORBIDDEN >> "$CASE/provider-calls";return 1; }
FLY(){ echo FORBIDDEN >> "$CASE/provider-calls";return 1; }
reap_orphaned_fleet_proxies(){
 printf '%s\n' "$$" >> "$CASE/proxy-sweeps"
 if [ -n "${RUN_BENCH_CLEANUP_COHORT_DIR:-}" ] && [ -e "$RUN_BENCH_CLEANUP_COHORT_DIR/stale-reconcile.completed.json" ];then
  echo late >> "$CASE/proxy-after-completion"
 fi
 return 1  # Existing app-scoped best-effort cleanup never aborts provisioning.
}
campaign_inventory_capture(){ inventory_index_healthy; }
inventory_refresh_wait_tick(){
 [ -z "${PUBLISH_HOST_DELAY:-}" ] || sleep "$PUBLISH_HOST_DELAY"
 if [ "${NO_PUBLISH:-0}" = 1 ];then SECONDS=$((SECONDS+1));echo "$SECONDS" >> "$CASE/logical-ticks";return 0;fi
 echo tick >> "$CASE/refresh-ticks"
 mkdir -p "$INVENTORY_INDEX/.generation-after"
 date +%s > "$INVENTORY_INDEX/.generation-after/published_at"
 printf 'publisher_token=publisher\nvalid_until=4102444800\ngeneration=.generation-after\n' > "$INVENTORY_INDEX/.generation-after/health"
 ln -s .generation-after "$INVENTORY_INDEX/next-$$"
 mv -Tf "$INVENTORY_INDEX/next-$$" "$INVENTORY_INDEX/current"
}
read -r ready
FLEET_OWNER_PID_START="$(cat "$CASE/birth-$$")"
__STARTUP_CALLSITE__
status=0
printf 'status=%s mutated=%s\n' "$status" "${FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED:-unset}"
exit "$status"
'''.replace('__STARTUP_CALLSITE__',self.callsite)
        self.children=[]

    def publish(self,name,stamp):
        path=self.index/name;path.mkdir(exist_ok=True)
        (path/'health').write_text('publisher_token=publisher\nvalid_until=4102444800\ngeneration='+name+'\n')
        (path/'published_at').write_text(str(stamp//1000000000 if stamp else int(time.time())))
        current=self.index/'current'
        if current.is_symlink():current.unlink()
        current.symlink_to(name)

    def spawn(self,index,sealed=True,extra=None):
        env=dict(self.ticket.env,CASE=str(self.root),BARRIER=str(int(self.barrier)),APP='fixture',FLEET_OWNER_HOST='fixture',FLEET_OWNERSHIP_ROOT=str(self.ownership),FLEET_REGISTRY_DIR=str(self.ownership/('current-'+str(index))),POOL_REUSE_ONLY='0',ROOT_DIR=str(ROOT),CLOUDBENCH_SCRIPT_SNAPSHOT=os.environ.get('CLOUDBENCH_TEST_RECONCILE_HELPER_DIR',str(ROOT/'scripts')),RUN_BENCH_CLEANUP_COHORT_DIR=str(self.ticket.cohort)if sealed else '',RUN_BENCH_CLEANUP_COHORT_ID='c001'if sealed else '',RUN_BENCH_CLEANUP_JOB=self.ticket.jobs[index]if sealed else '',RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(self.ticket.cohort)if sealed else '',RUN_BENCH_CAMPAIGN_COHORT='c001'if sealed else '',RUN_BENCH_CAMPAIGN_JOB_ID=self.ticket.jobs[index]if sealed else '',RUN_BENCH_CAMPAIGN_JOB_GENERATION='1')
        if self.campaign:
            env.update(CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=str(self.index),INVENTORY_INDEX=str(self.index),SNAPSHOT_LOOP_TOKEN='publisher',SNAPSHOT_LOOP_PID=str(os.getpid()),INVENTORY_PUBLISHER_BORROWED='1',INVENTORY_CAMPAIGN_PARENT_PID=str(os.getpid()),INVENTORY_CAMPAIGN_PARENT_START='test',INVENTORY_CLOCK_EPOCH=str(int(time.time())),INVENTORY_CLOCK_SECONDS='0',SNAPSHOT_REFRESH_TIMEOUT='1',CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS='1',CAPACITY_ADMISSION_DEADLINE='10',FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED='0')
            # The fixture publisher is immediate, so the 1 s borrowed wait must not
            # be spent by the host: as in cloudbench_campaign_inventory_test.py,
            # unsetting SECONDS removes bash's whole-second wall-clock binding (a
            # SECONDS+1 deadline can expire microseconds after it is set).
            self_body='inventory_pid_matches_start(){ return 0; }\nunset SECONDS; SECONDS=0\n'+self.body
        else:self_body=self.body
        env.update(extra or {})
        child=subprocess.Popen(['bash','-c',self.functions+self_body],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.children.append(child);self.ticket.children.append(child)
        (self.root/('birth-'+str(child.pid))).write_text(tickets.birth(child.pid))
        if sealed:
            result=self.ticket.assign(index,child)
            self.case.assertEqual(result.returncode,0,result.stdout+result.stderr)
        child.stdin.write('go\n');child.stdin.flush()
        return child

    def metadata(self):
        return self.calls.read_text().splitlines()if self.calls.exists()else []

    def wait_entered(self,count=1):
        end=time.monotonic()+4
        while time.monotonic()<end:
            if len(list(self.root.glob('entered-*')))>=count:return
            time.sleep(.01)
        self.case.fail('actual full scanner did not reach fixture metadata boundary')

    def release(self):
        (self.root/'release-scan').touch()

    def join(self,child):
        stdout,stderr=child.communicate(timeout=8)
        return child.returncode,stdout,stderr

    def assert_records_preserved(self):
        self.case.assertEqual({str(p):(p.stat().st_ino,p.read_bytes())for p in self.ownership.glob('*/meta')},self.before)
        self.case.assertFalse((self.root/'provider-calls').exists())


class CohortReconciliation(unittest.TestCase):
    def test_actual_checked_in_dependency_pair_reaches_reconciliation(self):
        # Run the real fleet shell against its actual checked-in sibling pair;
        # no fixture-rewritten hash, alternate dependency, or fake loader.
        fixture = ReconciliationFixture(self, width=1)
        with mock.patch.dict(os.environ, CLOUDBENCH_TEST_RECONCILE_HELPER_DIR=str(MODULE.parent)):
            code, out, err = fixture.join(fixture.spawn(0))
        self.assertEqual(code, 0, out + err)
        self.assertTrue((fixture.ticket.cohort / 'stale-reconcile.completed.json').exists())
        self.assertTrue(fixture.metadata())
        fixture.assert_records_preserved()

    def test_canonical_snapshot_loads_reviewed_tickets_and_rejects_any_other_bytes(
        self,
    ):
        with tempfile.TemporaryDirectory() as name:
            snapshot = Path(name)
            old = subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(ROOT),
                    "show",
                    "25404879508f9026c720bb97526efc5479fcabcb:scripts/cloudbench-cohort-reconcile.py",
                ]
            )
            (snapshot / MODULE.name).write_bytes(old)
            for dependency in ("cloudbench-cleanup-tickets.py", "run-bench-fleet"):
                (snapshot / dependency).write_bytes(
                    (ROOT / "scripts" / dependency).read_bytes()
                )
            before = ReconciliationFixture(self, width=1)
            with mock.patch.dict(
                os.environ, CLOUDBENCH_TEST_RECONCILE_HELPER_DIR=str(snapshot)
            ):
                code, out, err = before.join(before.spawn(0))
            self.assertNotEqual(code, 0)
            self.assertIn("cleanup reconciliation dependency source changed", err)
            self.assertEqual(before.metadata(), [])
            self.assertFalse(
                (before.ticket.cohort / "stale-reconcile.completed.json").exists()
            )
            before.assert_records_preserved()
            # The exact failed It15 source stays refused against the reviewed
            # helper; only its consumer pin is repaired below.
            # Same canonical fleet shell and actual adjacent ticket module;
            # only the reviewed consumer pin changes, with no fake loader.
            (snapshot / MODULE.name).write_bytes(MODULE.read_bytes())
            after = ReconciliationFixture(self, width=1)
            with mock.patch.dict(
                os.environ, CLOUDBENCH_TEST_RECONCILE_HELPER_DIR=str(snapshot)
            ):
                code, out, err = after.join(after.spawn(0))
            self.assertEqual(code, 0, out + err)
            self.assertTrue(
                (after.ticket.cohort / "stale-reconcile.completed.json").exists()
            )
            self.assertTrue(after.metadata())
            after.assert_records_preserved()
            # Arbitrary drift is still rejected before executing dependency or
            # reading ownership; this repair is a single exact reviewed hash.
            (snapshot / "cloudbench-cleanup-tickets.py").write_bytes(
                (snapshot / "cloudbench-cleanup-tickets.py").read_bytes()
                + b"\n# unreviewed drift\n"
            )
            foreign = ReconciliationFixture(self, width=1)
            with mock.patch.dict(
                os.environ, CLOUDBENCH_TEST_RECONCILE_HELPER_DIR=str(snapshot)
            ):
                code, out, err = foreign.join(foreign.spawn(0))
            self.assertNotEqual(code, 0)
            self.assertIn("cleanup reconciliation dependency source changed", err)
            self.assertEqual(foreign.metadata(), [])
            foreign.assert_records_preserved()

    def test_three_controllers_share_one_complete_scan(self):
        f=ReconciliationFixture(self,barrier=True,width=8)
        first=f.spawn(0);f.wait_entered()
        peers=[f.spawn(1),f.spawn(2)]
        try:
            time.sleep(.12)
            self.assertEqual(len(f.metadata()),1,'peers entered the historical registry scan while a live winner owns it')
            self.assertTrue(all(p.poll()is None for p in [first,*peers]))
            self.assertFalse((f.ticket.cohort/'stale-reconcile.completed.json').exists(),'completion published before full scanner finished')
        finally:f.release()
        for p in [first,*peers]:
            code,out,err=f.join(p);self.assertEqual(code,0,out+err)
            self.assertIn('mutated=0',out,'no-op cohort was falsely marked mutated')
        self.assertTrue((f.ticket.cohort/'stale-reconcile.completed.json').exists())
        self.assertEqual(len((f.root/'proxy-sweeps').read_text().splitlines()),1)
        self.assertFalse((f.root/'proxy-after-completion').exists(),'proxy sweep followed completion publication')
        self.assertEqual(len(f.metadata()),12,'cohort repeated the full registry walk')
        done=f.ticket.cohort/'stale-reconcile.completed.json'
        failed=f.ticket.cohort/'stale-reconcile.failed.json'
        baseline=json.loads(done.read_bytes())
        malformed=[]
        malformed.append(dict(baseline,status=1))
        missing=dict(baseline);missing.pop('owner_pid');malformed.append(missing)
        malformed.append(dict(baseline,owner_pid=999999))
        malformed.append(dict(baseline))
        for index,value in enumerate(malformed,3):
            done.write_text(json.dumps(value))
            if index==6:failed.write_text(json.dumps(dict(baseline,status=1)))
            code,out,err=f.join(f.spawn(index))
            self.assertNotEqual(code,0,'malformed or contradictory cached terminal authorized success: '+out+err)
            self.assertEqual(len(f.metadata()),12,'malformed cache triggered another historical scan')
            if failed.exists():failed.unlink()
        lease=f.ticket.cohort/'stale-reconcile.owner.json'
        winner=json.loads(lease.read_bytes())
        done.unlink()
        invalid_winner=dict(winner,owner_pid=0,owner_start='')
        lease.write_text(json.dumps(invalid_winner))
        identity=lease.stat().st_ino;contents=lease.read_bytes()
        code,out,err=f.join(f.spawn(7))
        self.assertNotEqual(code,0,'unknown malformed winner was overwritten as a recoverable dead owner')
        self.assertEqual((lease.stat().st_ino,lease.read_bytes()),(identity,contents))
        self.assertEqual(len(f.metadata()),12)
        self.assertFalse(done.exists())
        lease.write_text(json.dumps(winner));done.write_text(json.dumps(baseline))
        f.assert_records_preserved()

    def test_campaign_noop_and_mutation_share_the_completed_barrier(self):
        for mutated in (False,True):
            with self.subTest(mutated=mutated):
                f=ReconciliationFixture(self,width=600,campaign=True,mutated=mutated)
                for index in range(3):
                    code,out,err=f.join(f.spawn(index));self.assertEqual(code,0,out+err)
                    self.assertIn('mutated='+str(int(mutated)),out)
                ticks=f.root/'refresh-ticks'
                self.assertEqual(len(ticks.read_text().splitlines())if ticks.exists()else 0,int(mutated))
                receipt=json.loads((f.ticket.cohort/'stale-reconcile.completed.json').read_text())
                self.assertEqual(receipt['may_have_mutated'],int(mutated))
                self.assertEqual(len(f.ticket.jobs),600)
                self.assertEqual(len(f.metadata()),12,'sealed 600-member cohort rescanned historical registries')
                if mutated:
                    self.assertEqual(receipt['inventory']['prior'],'.generation-before')
                    # A later healthy generation is reusable, never arrival-relative.
                    f.publish('.generation-later',time.time_ns()+3000000000000)
                    code,out,err=f.join(f.spawn(3));self.assertEqual(code,0,out+err)
                    self.assertEqual(len(ticks.read_text().splitlines()),1)
                    done=f.ticket.cohort/'stale-reconcile.completed.json'
                    for index,(key,value) in enumerate([('generation',None),('generation',42),('prior',['bad']),('prior',42)],9):
                        malformed=json.loads(json.dumps(receipt));malformed['inventory'][key]=value
                        done.write_text(json.dumps(malformed))
                        code,out,err=f.join(f.spawn(index));self.assertNotEqual(code,0,out+err)
                    done.write_text(json.dumps(receipt))
                    # Rollback, foreign publisher, stale and absent proof fail closed.
                    f.publish('.generation-same-second',receipt['inventory']['published_at']*1000000000)
                    code,out,err=f.join(f.spawn(8));self.assertNotEqual(code,0,out+err)
                    f.publish('.generation-before',1)
                    code,out,err=f.join(f.spawn(4));self.assertNotEqual(code,0,out+err)
                    f.publish('.generation-after',time.time_ns()+3000000000)
                    (f.index/'.generation-after/health').write_text('publisher_token=foreign\nvalid_until=4102444800\ngeneration=.generation-after\n')
                    code,out,err=f.join(f.spawn(5));self.assertNotEqual(code,0,out+err)
                    (f.index/'.generation-after/health').write_text('publisher_token=publisher\nvalid_until=1\ngeneration=.generation-after\n')
                    code,out,err=f.join(f.spawn(6));self.assertNotEqual(code,0,out+err)
                    (f.index/'.generation-after/health').unlink()
                    code,out,err=f.join(f.spawn(7));self.assertNotEqual(code,0,out+err)
                else:self.assertIsNone(receipt['inventory'])
                f.assert_records_preserved()

    def test_campaign_wait_is_spent_by_the_logical_clock_not_host_time(self):
        # Host delay before publication does not consume the 1-tick borrowed wait.
        f=ReconciliationFixture(self,width=3,campaign=True,mutated=True)
        code,out,err=f.join(f.spawn(0,extra={'PUBLISH_HOST_DELAY':'1.05'}));self.assertEqual(code,0,out+err)
        self.assertIn('mutated=1',out)
        self.assertEqual(len((f.root/'refresh-ticks').read_text().splitlines()),1)
        receipt=json.loads((f.ticket.cohort/'stale-reconcile.completed.json').read_text())
        self.assertEqual((receipt['may_have_mutated'],receipt['inventory']['generation']),(1,'.generation-after'))
        f.assert_records_preserved()
        # Negative control: the logical clock still expires an unpublished wait, fail closed.
        f=ReconciliationFixture(self,width=3,campaign=True,mutated=True)
        code,out,err=f.join(f.spawn(0,extra={'NO_PUBLISH':'1'}));self.assertNotEqual(code,0,out+err)
        self.assertIn('timed out waiting for a new healthy parent inventory generation',err)
        self.assertFalse((f.root/'refresh-ticks').exists())
        # One tick reaches the local 1 s deadline; the caller cap (10) never fires.
        self.assertEqual((f.root/'logical-ticks').read_text().splitlines(),['1'])
        self.assertFalse((f.ticket.cohort/'stale-reconcile.completed.json').exists())
        self.assertNotEqual(json.loads((f.ticket.cohort/'stale-reconcile.failed.json').read_bytes())['status'],0)
        f.assert_records_preserved()

    def test_dead_winner_without_completion_is_recovered_by_successor(self):
        f=ReconciliationFixture(self,barrier=True)
        first=f.spawn(0);f.wait_entered()
        second=f.spawn(1)
        time.sleep(.1)
        os.killpg(first.pid,signal.SIGKILL)
        end=time.monotonic()+3
        while time.monotonic()<end:
            state=Path('/proc/'+str(first.pid)+'/stat').read_text().rsplit(')',1)[1].split()[0]
            if state=='Z':break
            time.sleep(.01)
        self.assertEqual(state,'Z','fixture must retain unreaped killed winner')
        f.wait_entered(2)
        self.assertEqual(len(f.metadata()),2)
        f.release()
        code,out,err=f.join(second);self.assertEqual(code,0,out+err)
        self.assertEqual(Path('/proc/'+str(first.pid)+'/stat').read_text().rsplit(')',1)[1].split()[0],'Z')
        first.wait(timeout=3)
        third=f.spawn(2);code,out,err=f.join(third);self.assertEqual(code,0,out+err)
        self.assertEqual(len(f.metadata()),13)
        f.assert_records_preserved()

    def test_completed_failure_is_not_cached_as_success_or_rescanned(self):
        f=ReconciliationFixture(self,kind='failure')
        first=f.spawn(0);code,out,err=f.join(first);self.assertNotEqual(code,0,out+err)
        count=len(f.metadata());self.assertGreater(count,0)
        self.assertFalse((f.ticket.cohort/'stale-reconcile.completed.json').exists())
        self.assertNotEqual(json.loads((f.ticket.cohort/'stale-reconcile.failed.json').read_bytes())['status'],0)
        for index in (1,2):
            code,out,err=f.join(f.spawn(index));self.assertNotEqual(code,0,out+err)
        self.assertEqual(len(f.metadata()),count)
        self.assertFalse((f.root/'proxy-sweeps').exists(),'failed scanner ran orphan sweep')
        f.assert_records_preserved()

    def test_unknown_same_host_owner_remains_refused_and_untouched(self):
        f=ReconciliationFixture(self,kind='unknown')
        code,out,err=f.join(f.spawn(0));self.assertNotEqual(code,0,out+err)
        self.assertIn('invalid controller identity',err)
        f.assert_records_preserved()

    def test_standalone_keeps_original_independent_scan(self):
        f=ReconciliationFixture(self)
        for index in range(3):
            code,out,err=f.join(f.spawn(index,sealed=False));self.assertEqual(code,0,out+err)
        self.assertEqual(len(f.metadata()),36)
        self.assertEqual(len((f.root/'proxy-sweeps').read_text().splitlines()),3)
        f.assert_records_preserved()


if __name__=='__main__':unittest.main()
