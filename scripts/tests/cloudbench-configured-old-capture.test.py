"""Non-releasing capture of a configured host-replaced primary; all native I/O is fake."""
import argparse
import base64
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import runpy
import socket
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(os.environ.get('R124_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
os.environ['R122_SOURCE_ROOT'] = str(ROOT)
fixture = runpy.run_path(str(ROOT/'scripts/tests/cloudbench-replaced-preconfig.test.py'))
OLD, CURRENT, OWNER = (fixture[k] for k in ('OLD', 'CURRENT', 'OWNER'))

class ConfiguredOldCapture(unittest.TestCase):
    write = fixture["ReplacedPreconfig"].write
    def setUp(self):
        fixture["ReplacedPreconfig"].setUp(self)
        self.h = runpy.run_path(str(ROOT/'scripts/cloudbench-original-volume-capture.py'))['main'].__globals__
        meta=self.module['fields'](self.registry/'meta')
        meta.update(host=socket.gethostname(),pid='9999999',pid_start='dead-birth',workspace_root=str(self.root))
        self.write(self.registry/'meta',''.join(f'{k}={v}\n' for k,v in meta.items()))
        self.args=argparse.Namespace(registry=self.registry,bench=self.task.name,machine_id=OLD,
            volume_id='vol_'+OLD,configured_old_member=True,undelivered_native_stop=False,
            isolate_services=False,capture_dir=self.root/'capture',preflight_only=False,
            wait_seconds=1,ssh_seconds=1,attempts=1)
        self.config=dict(init={'cmd':['bash','/cloudbench-boot.sh']},env={
            'CLOUDBENCH_RUN_TOKEN':OWNER+'-0','CLOUDBENCH_BOOT':'1','CLOUDBENCH_FRESH_VOLUME':'1',
            'BENCH_TASKS_B64':base64.b64encode(self.task.name.encode()).decode()},
            restart={'policy':'no'},image='fixture@sha256:'+'e'*64,
            mounts=[dict(volume='vol_'+OLD,path='/data')])
        self.state=dict(id=OLD,name='cloudbench-'+OLD,state='stopped',instance_id='instance0',config=copy.deepcopy(self.config))
        self.volume=dict(id='vol_'+OLD,state='created',attached_machine_id=OLD)
        self.mount=dict(schema='cloudbench-configured-data-mount-v1',machine_id=OLD,path='/data',
            device=os.makedev(8,1),root_device=os.makedev(0,1),inode=256,mount_device='8:1')
        self.calls=[];self.originals={};self.after_guest=None;self.fail_restore=False
        outer=self
        class FakeFly:
            def __init__(self,*args):pass
            def machine(self,mid):
                assert mid==OLD
                return copy.deepcopy(outer.state)
            def volume(self,vid):
                assert vid=='vol_'+OLD
                return copy.deepcopy(outer.volume)
            def api(self,method,path,body=None):
                outer.calls.append((method,path))
                if path.endswith('/start'):outer.state['state']='started'
                elif path.endswith('/stop'):outer.state['state']='stopped'
                elif path=='/machines/'+OLD:
                    if outer.fail_restore and body['config']==outer.config:raise outer.h['CaptureFailure']('fixture restore failure')
                    outer.state['config']=copy.deepcopy(body['config'])
                else:raise AssertionError(path)
                return {}
        self.h['Fly']=FakeFly
        self.h['pid_birth_state']=lambda *args:'absent'
        self.h['resolve_token']=lambda ident:'inert-offline-fixture'
        real_sibling=self.h['sibling']
        self.recipe_calls=[]
        def recipe(meta,config):
            self.recipe_calls.append(copy.deepcopy(config))
            if config.get('bad_recipe'):raise ValueError('bad fixture recipe')
            return 'd'*40,'e'*64,'f'*64
        self.h['sibling']=lambda name: {'native_recipe':recipe} if name=='cloudbench-prestack-recovery.py' else real_sibling(name)
        self.h['RecoveryLock']=type('Lock',(),{'__init__':lambda *args:None,'acquire':lambda *args:None,'release':lambda *args:None})
        def guest(fly,ident,directory,*args):
            self.assertEqual(fly.machine(OLD)['config']['init']['cmd'],['sleep','infinity'])
            self.assertEqual(fly.machine(OLD)['state'],'started')
            dest=directory/'download.tar.gz'
            with tarfile.open(dest,'w:gz') as tar:
                for name,data in self.originals.items():
                    info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
            inv=dict(version=1,run_token=OWNER+'-0',files={name:dict(bytes=len(data),sha256=self.h['sha'](data)) for name,data in self.originals.items()},
                missing=sorted(self.h['expected_names'](OWNER+'-0',True)-set(self.originals)),archive_bytes=dest.stat().st_size,archive_sha256=self.h['sha'](dest.read_bytes()),data_mount=copy.deepcopy(self.mount))
            if self.after_guest:self.after_guest(inv)
            return dest,inv
        self.h['guest_capture']=guest
    def run_capture(self):
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            return self.h['capture'](self.args)
    def test_owning_configured_capture_is_diagnostic_and_restores(self):
        self.assertEqual(self.run_capture(),0)
        self.assertEqual(self.state['config'],self.config);self.assertEqual(self.state['state'],'stopped')
        proof=json.loads((self.args.capture_dir/(OLD+'.provenance.json')).read_text())
        self.assertEqual(proof['admission'],'configured-old-member-diagnostic')
        for key in ('phase_consumption_authorized','runtime_evidence_complete','native_release_verified'):
            self.assertIs(proof[key],False)
        self.assertTrue(self.recipe_calls)
        self.assertEqual(proof['data_mount'],self.mount)
        for p in (self.old/'runtime-evidence.pending',self.task/'runtime-evidence.pending',self.registry/'guest-cleanup-unconfirmed',self.registry/'runtime-evidence-unconfirmed'):
            self.assertTrue(p.exists())
        self.assertFalse((self.old/'guest-shutdown.confirmed').exists())
        self.assertFalse((self.old/'failed-preconfig-runtime-archive/consumed.json').exists())
    def test_actual_runtime_files_are_preserved_without_classification(self):
        self.originals={'bench.log':b'other or partial log','cloudbench-driver.state':b'booting\n',
            'repo/.context/cloudbench/logs/backend.log':b'original provider evidence'}
        self.assertEqual(self.run_capture(),0)
        with tarfile.open(self.args.capture_dir/(OLD+'.tar.gz')) as tar:
            self.assertEqual({m.name:tar.extractfile(m).read() for m in tar},self.originals)
    def test_real_guest_collector_records_seals_without_inventing_missing_files(self):
        data=self.root/'original-volume';data.mkdir()
        (data/('cloudbench-prelaunch-'+OWNER+'-0.sealed')).write_text(OWNER+'-0\n')
        proc=self.root/'proc';(proc/'1').mkdir(parents=True)
        (proc/'1/cmdline').write_bytes(b'sleep\x00infinity\x00')
        out=self.root/'guest-originals.tar.gz';stdout=io.StringIO()
        self.h['configured_data_mount']=lambda *args:copy.deepcopy(self.mount) # mount boundary explicitly mocked
        with contextlib.redirect_stdout(stdout):
            rc=self.h['guest_collect'](['--data',str(data),'--run-token',OWNER+'-0','--output',str(out),
                '--proc',str(proc),'--configured-old-member','--machine-id',OLD])
        self.assertEqual(rc,0)
        inventory=json.loads(stdout.getvalue().split(self.h['INVENTORY_MARKER'],1)[1])
        ident=self.h['local_identity'](self.args)
        originals=self.h['verify_capture'](out,inventory,ident)
        self.assertEqual(set(originals),{'cloudbench-prelaunch-'+OWNER+'-0.sealed'})
        self.assertIn('bench.log',inventory['missing'])
        self.assertFalse((data/'bench.log').exists())
    def test_nonexistent_root_no_longer_produces_accepted_empty_capture(self):
        proc=self.root/'missing-root-proc';(proc/'1').mkdir(parents=True)
        (proc/'1/cmdline').write_bytes(b'sleep\x00infinity\x00')
        output=self.root/'must-not-publish.tar.gz';stdout=io.StringIO()
        with patch.dict(os.environ,{'FLY_MACHINE_ID':OLD}),contextlib.redirect_stdout(stdout):
            rc=self.h['guest_collect'](['--data',str(self.root/'absent'),'--proc',str(proc),
                '--run-token',OWNER+'-0','--output',str(output),'--configured-old-member'])
        self.assertEqual(rc,3);self.assertFalse(output.exists())
    def test_missing_forged_and_swapped_mount_attestations_refuse(self):
        variants=[None,{**self.mount,'machine_id':CURRENT},{**self.mount,'path':'/'},
            {**self.mount,'device':self.mount['root_device']},{**self.mount,'mount_device':'8:99'},
            {**self.mount,'inode':True}]
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):self.h['validate_configured_data_mount'](value,OLD)
    def test_mount_identity_change_prevents_guest_inventory_publication(self):
        data=self.root/'data';data.mkdir();proc=self.root/'mount-proc';(proc/'1').mkdir(parents=True)
        (proc/'1/cmdline').write_bytes(b'sleep\x00infinity\x00')
        out=self.root/'changed.tar.gz';observations=iter([self.mount,{**self.mount,'inode':257}])
        self.h['configured_data_mount']=lambda *args:next(observations)
        with contextlib.redirect_stdout(io.StringIO()):
            rc=self.h['guest_collect'](['--data',str(data),'--proc',str(proc),'--run-token',OWNER+'-0',
                '--output',str(out),'--configured-old-member','--machine-id',OLD])
        self.assertEqual(rc,3)
    def test_mount_primitive_is_reused_and_device_is_checked(self):
        original=self.h['original_file_contract'];calls=[]
        def contract():
            actual=original()
            def mount(data):
                calls.append(str(data));return {k:self.mount[k] for k in ('device','inode','mount_device')}
            return {**actual,'current_cold_mount':mount}
        self.h['original_file_contract']=contract
        with patch.dict(os.environ,{'FLY_MACHINE_ID':OLD}):
            value=self.h['configured_data_mount'](Path('/data'),OLD)
        self.assertEqual(calls,['/data']);self.assertEqual(value['mount_device'],'8:1')
        with patch.dict(os.environ,{'FLY_MACHINE_ID':CURRENT}),self.assertRaises(self.h['GuestRefusal']):
            self.h['configured_data_mount'](Path('/data'),OLD)
    def test_no_mode_keeps_legacy_refusal(self):
        self.args.configured_old_member=False
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.assertEqual(self.calls,[])
    def test_live_owner_and_conflicting_old_worker_refuse(self):
        self.h['pid_birth_state']=lambda *args:'alive'
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.h['pid_birth_state']=lambda *args:'absent'
        self.write(self.old/'worker-clones.ids','foreign\n')
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.assertEqual(self.calls,[])
    def test_native_source_task_volume_and_state_refuse_before_mutation(self):
        variants=[('state','started'),('id',CURRENT)]
        for key,value in variants:
            old=self.state[key];self.state[key]=value
            with self.assertRaises(self.h['Refusal']):self.run_capture()
            self.state[key]=old
        for key,value in [('BENCH_TASKS_B64','wrong'),('CLOUDBENCH_DATA_DIR','/elsewhere')]:
            self.state['config']['env'][key]=value
            with self.assertRaises(self.h['Refusal']):self.run_capture()
            self.state['config']['env'].pop(key)
            self.state['config']['env']['BENCH_TASKS_B64']=self.config['env']['BENCH_TASKS_B64']
        self.state['config']['bad_recipe']=True
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.state['config'].pop('bad_recipe');self.volume['attached_machine_id']=CURRENT
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.assertEqual(self.calls,[])
    def test_same_token_current_and_old_artifacts_cannot_be_swapped(self):
        for attr,value in [('machine_id',CURRENT),('volume_id','vol_'+CURRENT)]:
            before=getattr(self.args,attr);setattr(self.args,attr,value)
            with self.assertRaises((self.h['Refusal'],OSError)):self.run_capture()
            setattr(self.args,attr,before)
        old=(self.old/'.cid').read_bytes()
        self.write(self.old/'.cid','clone '+CURRENT+'\n')
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        (self.old/'.cid').write_bytes(old)
        self.assertEqual(self.calls,[])
    def test_cancel_after_inert_start_restores_and_keeps_latches(self):
        def cancel(*args):raise KeyboardInterrupt()
        self.h['guest_capture']=cancel
        self.assertEqual(self.run_capture(),1)
        self.assertEqual(self.state['config'],self.config)
        self.assertEqual(self.state['state'],'stopped')
        self.assertTrue((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertFalse((self.args.capture_dir/(OLD+'.provenance.json')).exists())
    def test_recovery_lock_refusal_prevents_native_mutations(self):
        def refuse(*args):raise self.h['Refusal']('held fixture guard')
        self.h['RecoveryLock']=type('Held',(),{'__init__':lambda *args:None,'acquire':refuse})
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.assertEqual(self.calls,[])
    def test_capture_directory_cannot_change_original_custody(self):
        self.args.capture_dir=self.old/'capture'
        with self.assertRaises(self.h['Refusal']):self.run_capture()
        self.assertEqual(self.calls,[])
    def test_incomplete_inventory_restores_without_publishing(self):
        self.after_guest=lambda inv:inv['missing'].pop()
        self.assertEqual(self.run_capture(),1)
        self.assertEqual(self.state['config'],self.config)
        self.assertFalse((self.args.capture_dir/(OLD+'.provenance.json')).exists())
    def test_changed_local_custody_restores_without_publishing(self):
        self.after_guest=lambda inv:self.write(self.task/'.cid','clone '+'9'*14+'\n')
        self.assertEqual(self.run_capture(),1)
        self.assertEqual(self.state['config'],self.config)
        self.assertFalse((self.args.capture_dir/(OLD+'.provenance.json')).exists())
    def test_restore_failure_cannot_publish(self):
        self.fail_restore=True
        self.assertEqual(self.run_capture(),1)
        self.assertFalse((self.args.capture_dir/(OLD+'.provenance.json')).exists())
    def test_failed_restore_hint_reenters_same_mode_and_restores_only(self):
        self.fail_restore=True
        stderr=io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(stderr):
            self.assertEqual(self.h['capture'](self.args),1)
        self.assertIn('--restore-original-config --configured-old-member',stderr.getvalue())
        self.assertEqual(self.state['config']['init']['cmd'],['sleep','infinity'])
        self.fail_restore=False
        start_count=sum(path.endswith('/start') for _,path in self.calls)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.h['restore_only'](self.args),0)
        self.assertEqual(self.state['config'],self.config)
        self.assertEqual(self.state['state'],'stopped')
        self.assertEqual(sum(path.endswith('/start') for _,path in self.calls),start_count)
        self.assertTrue((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertFalse((self.args.capture_dir/(OLD+'.provenance.json')).exists())
    def test_diagnostic_does_not_publish_recovery_inputs(self):
        with contextlib.redirect_stderr(io.StringIO()):
            rc=self.h['main'](['--registry',str(self.registry),'--bench',self.task.name,'--machine-id',OLD,
                '--volume-id','vol_'+OLD,'--configured-old-member','--publish-recovery-inputs'])
        self.assertEqual(rc,3);self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
