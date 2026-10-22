#!/usr/bin/env python3
"""Actual aggregator callsite: fresh ticks, import retry, publication order, owned stop."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
SOURCE=Path(os.environ.get('CLOUDBENCH_AGGREGATOR_SOURCE',str(ROOT/'scripts/run-bench-fleet')))
HUB=r'''
import json,os
from pathlib import Path
root=Path(os.environ['CASE'])
with (root/'imports').open('a') as stream:stream.write(str(os.getpid())+'\n')
if os.environ['FAIL_IMPORT']=='1' and not (root/'import-failed').exists():
 (root/'import-failed').touch();(root/'batch/benches.json').write_text('{broken')
 raise SystemExit('fixture import failure')
def publish_live_report_card(card,*,run_id,state_path):
 assert run_id=='parent-fixture' and state_path==root/'batch/hub-live-publication.json'
 print('publication-visible-'+str(card['metadata']['tokens_in']))
 with (root/'events').open('a') as stream:stream.write(json.dumps({'kind':'publish','pid':os.getpid(),'card':card})+'\n')
 return True
'''
ACK=r'''
import json,os
from pathlib import Path
def acknowledge_published(card,*,run_id,fleet_dir):
 root=Path(os.environ['CASE']);assert run_id=='parent-fixture' and fleet_dir==root/'fleet'
 with (root/'events').open('a') as stream:stream.write(json.dumps({'kind':'ack','pid':os.getpid(),'card':card})+'\n')
 events=[json.loads(line)for line in (root/'events').read_text().splitlines()]
 count=sum(row['kind']=='ack'for row in events)
 value={'per_task':[{'name':'task-fixture','status':['queued','running','passed'][min(count,2)],'tokens_in':count+1}],
        'metadata':{'tokens_in':count+1,'tokens_out':count},'elapsed_s':count,'cost':{'total_usd':count}}
 (root/'fleet/task-fixture/cloudbench-live/report-card.json').write_text(json.dumps(value))
'''


class PersistentAggregator(unittest.TestCase):
    def test_live_card_remains_readable_during_publish(self):
        """A final reader must never observe a partially written live card."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        batch = root / 'batch'
        batch.mkdir()
        (root / 'fleet/task-fixture/cloudbench-live').mkdir(parents=True)
        (batch / 'benches.json').write_text(json.dumps([dict(name='task-fixture', mode='REAL')]))
        (batch / 'code.txt').write_text('fixture-code')
        (root / 'fleet/task-fixture/cloudbench-live/report-card.json').write_text(
            json.dumps(dict(per_task=[dict(name='task-fixture', status='passed')]))
        )
        target = batch / 'report-card.json'
        prior = {'timestamp': '2026-10-21T00:00:00+00:00', 'per_task': []}
        target.write_text(json.dumps(prior))
        source = SOURCE.read_text()
        start = source.index('import json, os, sys', source.index('# ── ONE aggregated batch dashboard'))
        end = source.index('\nwhile True:\n', start)
        code = source[start:end] + '''
original_dump = json.dump
def paused_dump(value, stream, *args, **kwargs):
    Path(os.environ['CASE']).joinpath('dump-paused').touch()
    time.sleep(1)
    return original_dump(value, stream, *args, **kwargs)
json.dump = paused_dump
aggregate_tick()
'''
        env = dict(os.environ, CASE=str(root), FLEET_DIR=str(root / 'fleet'),
                   UNIFIED_DIR=str(batch), DASH_BASE='12345', ROOT_DIR=str(root),
                   SELF_MANAGED_HUB_RUN='0', FLEET_CONTROLLER_STARTED_EPOCH='1700000000')
        process = subprocess.Popen([sys.executable, '-c', code, str(target)], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 3
        while not (root / 'dump-paused').exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue((root / 'dump-paused').exists(), 'writer never reached the paused dump')
        self.assertEqual(json.loads(target.read_text()), prior)
        _, stderr = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(json.loads(target.read_text())['per_task'][0]['status'], 'passed')

    def run_fixture(self,fail_import=False):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        agents=root/'agents/benchmarks';agents.mkdir(parents=True)
        (agents/'__init__.py').touch();(agents/'hub_upload.py').write_text(HUB);(agents/'outcome_publication.py').write_text(ACK)
        (agents/'fleet_startup_phase.py').write_text('def startup_state(*args):return {"fixture":True}\n')
        (root/'fleet/task-fixture/cloudbench-live').mkdir(parents=True);(root/'batch').mkdir()
        manifest=json.dumps([dict(name='task-fixture',mode='REAL')]);(root/'batch/benches.json').write_text(manifest)
        (root/'batch/code.txt').write_text('fixture-code')
        (root/'fleet/task-fixture/cloudbench-live/report-card.json').write_text(json.dumps(dict(per_task=[dict(name='task-fixture',status='queued',tokens_in=1)],metadata=dict(tokens_in=1,tokens_out=0),cost=dict(total_usd=0),elapsed_s=0)))
        binary=Path(sys.executable).resolve();venv=root/'venv';(venv/'bin').mkdir(parents=True);(venv/'bin/python3').symlink_to(binary)
        (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
        packages=venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages';packages.mkdir(parents=True)
        (packages/'owning.pth').write_text('import os; f=os.open('+repr(str(root/'site-pids'))+',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600); os.write(f,(str(os.getpid())+"\\n").encode()); os.close(f)\n')
        source=SOURCE.read_text();start=source.index('(\n',source.index('HUB_URL="http://localhost:$DASH_BASE/"'))
        end=source.index(') & UNIFIED_AGG_PID=$!',start)+len(') & UNIFIED_AGG_PID=$!');chunk=source[start:end]
        old='    while :; do\n' in chunk
        if old:chunk=chunk.replace('    while :; do\n','    for _fixture_tick in 1 2 3; do\n',1)
        env=dict(os.environ,PATH=str(venv/'bin')+':'+os.environ['PATH'],CASE=str(root),FAIL_IMPORT=str(int(fail_import)),
                 FLEET_DIR=str(root/'fleet'),UNIFIED_DIR=str(root/'batch'),DASH_BASE='12345',ROOT_DIR=str(root),
                 SELF_MANAGED_HUB_RUN='1',FLEET_CONTROLLER_STARTED_EPOCH='1700000000',BENCHMARK_HUB_PARENT_RUN_ID='parent-fixture')
        stderr=(root/'stderr').open('w');self.addCleanup(stderr.close)
        stdout=(root/'stdout').open('w');self.addCleanup(stdout.close)
        script=chunk+'\nprintf "%s" "$UNIFIED_AGG_PID" > "$CASE/owner-pid"\nwait "$UNIFIED_AGG_PID"\n'
        process=subprocess.Popen(['bash','-c',script],env=env,stdout=stdout,stderr=stderr,start_new_session=True)
        def cleanup():
            if process.poll()is None:
                os.killpg(process.pid,signal.SIGTERM)
                process.wait(timeout=3)
        self.addCleanup(cleanup)
        target=1 if fail_import else 3;end=time.monotonic()+12;restored=False
        while time.monotonic()<end:
            if fail_import and not restored and (root/'stderr').read_text().count('⚠️ live benchmark publication failed')>=2:
                (root/'batch/benches.json').write_text(manifest);restored=True
            events=[json.loads(line)for line in (root/'events').read_text().splitlines()]if(root/'events').exists()else []
            if sum(row['kind']=='ack'for row in events)>=target:break
            if process.poll()is not None:break
            time.sleep(.01)
        else:self.fail('owned aggregator did not produce the expected ticks: '+(root/'stderr').read_text())
        self.assertEqual([row['kind']for row in events],['publish','ack']*target)
        self.assertTrue(all(events[i]['card']==events[i+1]['card']for i in range(0,len(events),2)))
        if fail_import:
            self.assertTrue(restored);self.assertGreaterEqual((root/'stderr').read_text().count('⚠️ live benchmark publication failed'),2)
        else:
            cards=[row['card']for row in events if row['kind']=='publish']
            self.assertEqual([card['per_task'][0]['status']for card in cards],['queued','running','passed'])
            self.assertEqual([card['metadata']['tokens_in']for card in cards],[1,2,3])
            self.assertEqual([card['cost']['total_usd']for card in cards],[0,1,2])
            self.assertTrue(all(card['timestamp']=='2023-11-14T22:13:20+00:00'for card in cards))
        owner=int((root/'owner-pid').read_text())
        if old:process.wait(timeout=4)
        else:
            self.assertEqual((root/'stdout').read_text().count('publication-visible-'),target,'persistent publication stdout remained buffered until owner stop')
            # The existing recorded owner is the Python process itself, with no sleep child.
            children=subprocess.check_output(['ps','-axo','pid=,ppid='],text=True)
            self.assertFalse(any(len(row.split())==2 and row.split()[1]==str(owner)for row in children.splitlines()))
            os.kill(owner,signal.SIGTERM);process.wait(timeout=3)
            self.assertEqual(process.returncode,143)
            with self.assertRaises(ProcessLookupError):os.kill(owner,0)
        sites={int(pid)for pid in (root/'site-pids').read_text().splitlines()}
        self.assertEqual(len(sites),1,'aggregator restarted Python/site for each iteration')
        self.assertEqual(sites,{owner},'recorded aggregator owner was a wrapper rather than the persistent Python process')
        self.assertEqual(len({row['pid']for row in events}),1,'publication process changed between ticks')
        imports=(root/'imports').read_text().splitlines()
        self.assertEqual(len(imports),2 if fail_import else 1,'successful Hub module imports were repeated')

    def test_three_fresh_iterations_share_one_interpreter_and_exact_owner(self):self.run_fixture()
    def test_failed_import_and_bad_tick_recover_without_losing_publication_order(self):self.run_fixture(True)


if __name__=='__main__':unittest.main()
