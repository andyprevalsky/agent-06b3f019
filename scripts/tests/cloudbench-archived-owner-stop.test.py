#!/usr/bin/env python3
"""Offline archive ownership plan + actual once-only canonical stop semantics."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import tarfile
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
S=runpy.run_path(str(ROOT/'scripts/cloudbench-archived-owner-stop.py'))


def write(path,value):
    path.write_text(json.dumps(value));path.chmod(0o600)
    return path


class ArchivedStop(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.run=self.root/'run';self.run.mkdir(mode=0o700)
        export=self.run/'export';export.mkdir(mode=0o700)
        self.out=self.root/'stops';self.out.mkdir(mode=0o700)
        self.mid='aaaabbbbccccdd';host='11112222333344';ref='a'*40;token='b'*32
        self.row=dict(id=self.mid,name='cloudbench-exact',instance_id='native-instance',created_at='original-created',state='started',
                      config=dict(mounts=[dict(volume='vol_owned',path='/data')],env=dict(FIXTURE='original')))
        protected=['0000000000000'+str(i) for i in range(4)]
        self.inventory=write(self.root/'inventory.json',[self.row]+[dict(id=x,state='started') for x in protected])
        authority=write(self.run/'authority.private.json',dict(app='navi-whisper-lux-bench',source_ref=ref,
                        protected_machines=protected,protected_volumes=['vol_protected']))
        record=dict(app='navi-whisper-lux-bench',host=host,machine_id=host,source_ref=ref)
        write(export/'launch.json',record);write(export/'caller.json',dict(original=True))
        prefix='git-common/cloudbench-fleet-ownership/'+token
        members={prefix+'/meta':f'host={host}\napp=navi-whisper-lux-bench\nfleet_owner_token={token}\ncleanup_policy=retain\n'.encode(),
                 prefix+'/clones/cloudbench-exact':f'name=cloudbench-exact\nid={self.mid}\nvolume_id=vol_owned\n'.encode(),
                 prefix+'/clones/unsealed':b'name=unsealed\n',
                 'context/original600-supervisor.token.terminal.json':json.dumps(dict(machine=host,source_ref=ref,supervisor_joined=True,parent_joined=True)).encode()}
        files={}
        with tarfile.open(export/'originals.tar.gz','w:gz') as t:
            for name,data in members.items():
                info=tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
                files[name]=dict(kind='file',bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
        (export/'originals.tar.gz').chmod(0o600)
        write(export/'manifest.json',dict(version=1,resource_release_verified=False,record=record,files=files,
                                         archive_sha256=S['digest_file'](export/'originals.tar.gz')))
        write(export/'disposable-export.verified.json',dict(machine_id=host,authority_sha256=S['digest_file'](authority),
              files={name:S['digest_file'](export/name) for name in ['caller.json','launch.json','manifest.json','originals.tar.gz']}))
        write(self.run/'cleanup-call.intent.json',dict(gate_joined=True,supervisor_joined=True,machine=host,
              export_verified_file=S['digest_file'](export/'disposable-export.verified.json')))
        write(self.run/'terminal.json',dict(status='CONTROLLER_RELEASE_VERIFIED',machine=host,source_ref=ref,release=dict(machine_deleted=True)))

    def test_archive_plan_excludes_protected_and_unsealed_and_refuses_changed_ownership(self):
        plan=S['prepare'](self.run,self.inventory)
        self.assertEqual([x['machine']['id'] for x in plan['targets']],[self.mid])
        self.assertEqual(plan['unsealed_intents_skipped'],1)
        self.assertFalse(plan['benchmark_success_inferred'])
        for changed in [dict(name='foreign'),dict(config=dict(mounts=[dict(volume='vol_other')]))]:
            write(self.inventory,[dict(self.row,**changed)]+[dict(id=x,state='started') for x in plan['protected_machines']])
            with self.assertRaises(ValueError):S['prepare'](self.run,self.inventory)
        write(self.inventory,[self.row]+[dict(id=x,state='started') for x in plan['protected_machines']])
        terminal=json.loads((self.run/'terminal.json').read_text());terminal['release']['machine_deleted']=False
        write(self.run/'terminal.json',terminal)
        with self.assertRaises(ValueError):S['prepare'](self.run,self.inventory)

    def test_exact_preget_ambiguous_stop_reconciles_and_resume_never_reposts(self):
        row=copy.deepcopy(self.row);calls=[]
        class API:
            def api(inner,method,path,body=None,timeout=0):
                calls.append((method,path))
                self.assertEqual(path,'/machines/'+self.mid+('/stop' if method=='POST' else ''))
                self.assertIn(method,['GET','POST'])
                if method=='POST':
                    row['state']='stopped';raise TimeoutError('lost response')
                return copy.deepcopy(row)
        api=API()
        first=S['stop_owned'](api,self.row,self.out,time.monotonic()+2)
        self.assertEqual(first['status'],'STOPPED_CONFIRMED')
        self.assertEqual(calls,[('GET','/machines/'+self.mid),('POST','/machines/'+self.mid+'/stop'),('GET','/machines/'+self.mid)])
        self.assertTrue((self.out/self.mid/'stop-intent.json').exists())
        self.assertEqual(S['stop_owned'](api,self.row,self.out,time.monotonic()+2)['status'],'STOPPED_CONFIRMED')
        self.assertEqual(sum(method=='POST' for method,path in calls),1)
        self.assertEqual(self.row['config'],row['config'])
        self.assertNotIn('claims_released',first)

    def test_changed_identity_or_unknown_resume_retains_pending_without_stop(self):
        for change in [dict(instance_id='replacement'),dict(config=dict(mounts=[]))]:
            calls=[]
            class API:
                def api(inner,method,path,body=None,timeout=0):
                    calls.append(method);return dict(self.row,**change)
            value=S['stop_owned'](API(),self.row,self.out,time.monotonic()+2)
            self.assertEqual(value['status'],'PENDING');self.assertEqual(calls,['GET'])
        directory=self.out/self.mid;directory.mkdir(mode=0o700)
        write(directory/'stop-intent.json',dict(ambiguous=True))
        class Unknown:
            def api(inner,method,path,body=None,timeout=0):
                self.assertEqual(method,'GET');raise TimeoutError('unknown')
        value=S['stop_owned'](Unknown(),self.row,self.out,time.monotonic()+1)
        self.assertEqual(value['status'],'PENDING')
        self.assertFalse((directory/'terminal.json').exists())


    def test_final_observation_is_one_inventory_and_keeps_unknown_pending(self):
        row=copy.deepcopy(self.row);row['state']='stopped'
        trace=self.root/'api.calls'
        class API:
            def api(inner,method,path,body=None,timeout=0):
                with trace.open('a') as f:f.write(method+' '+path+'\n')
                self.assertEqual(method,'GET')
                if path=='/machines':
                    # Replacement config must not turn the old owned identity
                    # into a stopped confirmation, even when state is stopped.
                    return [dict(row,instance_id='replacement')]
                self.assertEqual(path,'/machines/'+self.mid)
                return copy.deepcopy(row)
        plan=dict(schema='cloudbench-archived-owner-stop-plan-v1',inputs={},
                  protected_machines=['00000000000000'],targets=[dict(machine=row)])
        result=S['execute'](API(),plan,self.out,seconds=60,workers=1)
        self.assertFalse(result['all_owned_stopped'])
        self.assertEqual(result['results'][0]['status'],'PENDING')
        calls=trace.read_text().splitlines()
        self.assertEqual(calls.count('GET /machines'),1)
        self.assertTrue(all(line.startswith('GET ') for line in calls))
        self.assertFalse(result['claims_released'])


if __name__=='__main__':unittest.main()
