#!/usr/bin/env python3
"""Native setup functions, real lease/PID/descriptor, synthetic provider GETs only."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import cloudbench_maintenance as m
import deploy_test_cycle as c
import deploy_test_round19_isolation as r19
import deploy_test_round16_isolation as r16


def function(name):
    text=(ROOT/'scripts/run-bench-cloud').read_text()
    start=text.index(name+'() {')
    return text[start:text.index('\n}\n',start)+3]


class NativeTransition(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.context=self.root/'.context';self.context.mkdir()
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        for rel in (*m.SCRIPTS,'scripts/process-identity.py','Dockerfile.cloudbench-warm','fly.cloudbench-warm.toml'):
            target=self.root/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/rel,target)
        (self.root/'.git/info/exclude').write_text('.context/\n')
        self.phase=self.context/'phase';self.phase.write_text('before')
        digest='sha256:'+'b'*64
        self.image='registry.fly.io/navi-whisper-lux-bench@'+digest
        config={'image':'registry.fly.io/navi-whisper-lux-bench@sha256:'+'a'*64,
                'guest':{'cpu_kind':'shared','cpus':1,'memory_mb':2048},'init':{'cmd':['sleep','infinity']},
                'env':{'PRESENT':'unchanged'},'mounts':[{'volume':'vol-owned','path':'/data'}]}
        old={'id':'warm','instance_id':'before-instance','name':'cloudbench-warm','state':'stopped',
             'config':config,'image_ref':{'digest':'sha256:'+'a'*64}}
        new=copy.deepcopy(old);new['config']['image']=self.image;new['image_ref']['digest']=digest;new['instance_id']='after-instance'
        self.provider={'before':old,'after':new};c.write(self.context/'provider.json',self.provider)
        # This is a synthetic old-admission grant, not a claim about historical
        # production provenance. Real seven-debt checks remain in the cycle suite.
        self.fixture=self.context/'fixture';self.fixture.mkdir()
        (self.fixture/'sitecustomize.py').write_text('''import io,json,os,sys,urllib.error,urllib.request,socket
from pathlib import Path
import deploy_test_cycle as c
import cloudbench_maintenance as m
import deploy_test_round16_isolation as r16
root=Path(os.environ['MAINTENANCE_FIXTURE_ROOT'])
# Synthetic process inventory for quiescence only. Parent incarnation, script
# FD and both real lock descriptors are still checked against native /proc.
# Unrelated healthy workers must not affect this isolated owning regression.
original_iterdir=Path.iterdir
def fixture_iterdir(path):
 if path==Path('/proc'):return iter([path/str(os.getpid()),path/str(os.getppid())])
 return original_iterdir(path)
Path.iterdir=fixture_iterdir
def get(app,resource):
 value=json.loads((root/'.context/provider.json').read_text())[(root/'.context/phase').read_text()]
 if resource=='machines':return [value]
 if resource=='machines/warm':return value
 if resource=='volumes/vol-owned':return {'id':'vol-owned','state':'created','attached_machine_id':'warm'}
 raise urllib.error.HTTPError(resource,404,'absent',{},None)
def no_network(*args,**kwargs):raise AssertionError('fixture prohibits network sockets')
socket.socket.connect=no_network
socket.create_connection=no_network
def response(request,**kwargs):
 if request.get_method()!='GET':raise AssertionError('fixture forbids provider mutation')
 resource=request.full_url.split('/apps/navi-whisper-lux-bench/',1)[1]
 handle=io.BytesIO(json.dumps(get('navi-whisper-lux-bench',resource)).encode());handle.status=200
 return handle
urllib.request.urlopen=response
m.get=get
c.isolated_admissions=lambda state,gate:list(state['reconciled_owners'].values())
r16.hub_socket=lambda **kw:{'pid':777,'port':1777,'inodes':['88']}
''')
        functions='\n'.join(function(n) for n in ('maintenance_begin','maintenance_targets','maintenance_prestart','setup_release'))
        script='''#!/usr/bin/env bash
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/cloudbench-app-env-lock.sh"
APP_ENV_LOCK_FILE="$ROOT_DIR/.git/cloudbench-app-env.lock"
OUT_DIR="$ROOT_DIR/.context/output"
mkdir -p "$OUT_DIR"
MAINTENANCE_STATE="$ROOT_DIR/.context/cycle.json"
MAINTENANCE_GATE=smoke
MAINTENANCE_BUILD="$ROOT_DIR/.context/build.json"
MAINTENANCE_POINTER=""
WARM_IMAGE_REF="'''+self.image+'''"
BENCH_REF="$(git -C "$ROOT_DIR" rev-parse HEAD)"
APP=navi-whisper-lux-bench
WARM_PARKED_VM_SIZE=shared-cpu-1x
WARM_PARKED_VM_MEMORY=2048
environment_activation_targets() { printf 'warm\\twarm\\n'; }
'''+functions+'''
acquire_app_environment_lock || exit 1
trap 'native_status=$?; setup_release "$native_status"; exit "$?"' EXIT
maintenance_begin || exit 1
maintenance_targets "$(environment_activation_targets)" || exit 1
# Mutation is synthetic; only the original shell can proceed past intent.
printf after > "$ROOT_DIR/.context/phase"
maintenance_prestart || exit 1
printf started > "$ROOT_DIR/.context/start-marker"
exit "${FIXTURE_NATIVE_EXIT:-0}"
'''
        (self.root/'scripts/run-bench-cloud').write_text(script)
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=fixture','-c','user.email=fixture@example.com','commit','-qm','native fixture'],check=True)
        self.source=c.source(self.root)
        self.pin={k:m.machine(old)[k] for k in ('id','instance_id','name','state','config_sha256')}
        self.entry={'token':'old','gate':'smoke','purpose':'isolated-validation','owner':{'worker_root':str(self.root)},
                    'proof':{'compatibility':r19.MODE,'guest_observation':{'warm':self.pin,'hub_socket':{'pid':777,'port':1777,'inodes':['88']}},'inherited_admissions':[]},
                    'cleanup_complete':False,'credit_granted':False,'obligations_preserved':True}
        self.state={'source':self.source,'plan':{'source':self.source,'gates':[{'name':'smoke','native_cloud':True}]},
                    'ready':False,'phase':'needs-focused-plan','reconciled_owners':{'old':self.entry}}
        self.build={'schema':'cloudbench-image-build-v1','image_ref':self.image,'published_digest':digest,
                    'source_sha':self.source['head'],'source_dirty':False,'publication_verified':True,
                    'registry_handoff_verified':True,'publisher_exit_code':0,'build_attempts':1,
                    'dockerfile_sha256':hashlib.sha256((self.root/'Dockerfile.cloudbench-warm').read_bytes()).hexdigest(),
                    'config_sha256':hashlib.sha256((self.root/'fly.cloudbench-warm.toml').read_bytes()).hexdigest()}
        c.write(self.context/'build.json',self.build);c.write(self.context/'cycle.json',self.state)
        self.env={**os.environ,'PYTHONPATH':str(self.fixture)+os.pathsep+str(ROOT/'scripts'),
                  'MAINTENANCE_FIXTURE_ROOT':str(self.root),'PYTHONDONTWRITEBYTECODE':'1'}

    def run_native(self,status=0):
        return subprocess.run(['bash',str(self.root/'scripts/run-bench-cloud'),'--setup'],env={**self.env,'FIXTURE_NATIVE_EXIT':str(status)},
                              text=True,capture_output=True,timeout=15)

    def consumer(self,state=None):
        state=state or c.read(self.context/'cycle.json')
        def get(app,resource):
            value=self.provider['after']
            if resource=='machines':return [value]
            if resource=='machines/warm':return value
            if resource=='volumes/vol-owned':return {'id':'vol-owned','state':'created','attached_machine_id':'warm'}
            import urllib.error
            raise urllib.error.HTTPError(resource,404,'absent',{},None)
        with patch.object(m,'get',side_effect=get),patch.object(r16,'hub_socket',return_value={'pid':777,'port':1777,'inodes':['88']}), \
             patch.object(m,'quiescent',return_value={'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'uid':os.getuid(),'observed_at':time.time(),'scanned':0}):
            return m.validate_current(state,[self.entry],self.entry,r19)

    def prospective_fixture(self):
        failed=self.run_native(17);self.assertEqual(failed.returncode,17,failed.stderr)
        saved=c.read(self.context/'cycle.json')['native_maintenance'][0]
        self.phase.write_text('before');(self.context/'output/cloudbench-maintenance.json').unlink()
        (self.context/'start-marker').unlink()
        self.provider['before']['instance_id']='legitimate-current-peer-instance'
        self.provider['before']['config']['guest']={'cpu_kind':'shared','cpus':4,'memory_mb':8192}
        c.write(self.context/'provider.json',self.provider)
        site=self.fixture/'sitecustomize.py'
        site.write_text(site.read_text()+"\nimport deploy_test_native_cleanup as n\nc.bound_isolated_owner_roots=lambda *a:([],[])\nn.inherited_native_sources=lambda *a,**kw:{} if kw.get('_historical_only') else (_ for _ in ()).throw(ValueError('old guest pin'))\n")
        return saved

    def test_prospective_changed_guest_uses_real_native_capture_not_old_pin(self):
        saved=self.prospective_fixture()
        completed=self.run_native();self.assertEqual(completed.returncode,0,completed.stderr)
        with patch.object(m,'historical_debt_audit',return_value=[self.entry]):
            self.assertTrue(self.consumer())
        state=c.read(self.context/'cycle.json')
        self.assertEqual(state['native_maintenance'][0],saved)
        self.assertEqual(state['reconciled_owners'],self.state['reconciled_owners'])
        self.assertFalse(saved['qualified']);self.assertTrue(state['native_maintenance'][1]['qualified'])
        prestart=Path(state['native_maintenance'][1]['directory'])/'prestart.json'
        self.assertEqual(m.read(prestart)['producer'],state['native_maintenance'][1]['producer'])
        original_read=m.read
        def tampered(path):return {} if Path(path)==prestart else original_read(path)
        with patch.object(m,'read',side_effect=tampered),patch.object(m,'historical_debt_audit',return_value=[self.entry]),self.assertRaises((ValueError,KeyError)):
            self.consumer()

    def test_prospective_fresh_scope_fail_closed_before_mutation(self):
        saved=self.prospective_fixture();provider=copy.deepcopy(self.provider)
        original_state=(self.context/'cycle.json').read_bytes()
        for label,change in (
            ('live guest',lambda: self.provider['before'].update(state='started')),
            ('private machine',lambda: self.provider['before'].update(id='private')),
            ('foreign volume',lambda: self.provider['before']['config']['mounts'][0].update(volume='private')),
            ('foreign env',lambda: self.provider['before']['config']['env'].update(PRESENT='foreign')),
            ('foreign command',lambda: self.provider['before']['config']['init'].update(cmd=['unowned'])),
        ):
            with self.subTest(label=label):
                self.provider=copy.deepcopy(provider);change();c.write(self.context/'provider.json',self.provider)
                denied=self.run_native();self.assertNotEqual(denied.returncode,0,denied.stderr)
                self.assertEqual(self.phase.read_text(),'before')
                self.assertEqual((self.context/'cycle.json').read_bytes(),original_state)
        self.assertEqual(c.read(self.context/'cycle.json')['native_maintenance'][0],saved)

    def test_prestart_replacement_cannot_become_new_native_authority(self):
        saved=self.prospective_fixture()
        script=self.root/'scripts/run-bench-cloud'
        attack="""python3 - "$ROOT_DIR" <<'PY_TAMPER'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);pointer=json.loads((root/'.context/output/cloudbench-maintenance.json').read_text())
path=pathlib.Path(pointer['directory'])/'prestart.json';value=json.loads(path.read_text())
value['observation']['warm']['instance_id']='forged-after-capture'
value['observation']['inventory']['warm']['instance_id']='forged-after-capture'
replacement=path.with_name('replacement.json');replacement.write_text(json.dumps(value));replacement.replace(path)
PY_TAMPER
"""
        script.write_text(script.read_text().replace('maintenance_prestart || exit 1\n','maintenance_prestart || exit 1\n'+attack))
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=fixture','-c','user.email=fixture@example.com','commit','-qm','synthetic replacement control'],check=True)
        state=c.read(self.context/'cycle.json');state['source']=state['plan']['source']=c.source(self.root)
        c.write(self.context/'cycle.json',state)
        result=self.run_native();self.assertNotEqual(result.returncode,0,result.stderr)
        state=c.read(self.context/'cycle.json');record=state['native_maintenance'][-1]
        self.assertEqual(record['native_exit'],0);self.assertFalse(record['qualified'])
        self.assertNotEqual(record['prestart_sha256'],m.digest(m.read(Path(record['directory'])/'prestart.json')))
        self.assertEqual(state['native_maintenance'][0],saved)
        with patch.object(m,'historical_debt_audit',return_value=[self.entry]),self.assertRaises(ValueError):self.consumer()

    def test_prospective_cli_zero_stale_image_rejected_before_first_start(self):
        self.prospective_fixture()
        self.provider['after']['config']['image']=self.provider['before']['config']['image']
        self.provider['after']['image_ref']=self.provider['before']['image_ref']
        c.write(self.context/'provider.json',self.provider)
        denied=self.run_native();self.assertNotEqual(denied.returncode,0,denied.stderr)
        self.assertIn('prestart desired immutable image',denied.stderr)
        self.assertFalse((self.context/'start-marker').exists())
        self.assertFalse(c.read(self.context/'cycle.json')['native_maintenance'][-1]['qualified'])

    def test_single_native_cache_addition_keeps_exact_old_protected_digest(self):
        import datetime
        app='navi-whisper-lux-bench';old=copy.deepcopy(self.provider['before'])
        old['config']['metadata']={'owner':'original-protected-owner'}
        original=m.machine(old);current=copy.deepcopy(old)
        epoch=int(time.time())-10;node='a'*64;python='c'*64
        key='rose_cloudbench_deps_'+hashlib.sha256((node+'\0'+python).encode()).hexdigest()[:32]
        current['config']['metadata'][key]=f'{node} {python} {epoch} snapshot_one vol-owned warm {app}'
        snapshot={'id':'snapshot_one','status':'created','size':123,'created_at':datetime.datetime.fromtimestamp(epoch+1,datetime.timezone.utc).isoformat()}
        with patch.object(m,'get',return_value=[snapshot]) as query:
            proof=m.owned_scope(m.machine(current),original,app=app)
            self.assertEqual(proof['without_key_sha256'],original['stable_sha256'])
            self.assertFalse(proof['dependency_reuse_credit'])
            query.assert_called_once_with(app,'volumes/vol-owned/snapshots')
        for label,mutate in (
            ('owner',lambda v:v['config']['metadata'].update(owner='foreign')),
            ('env',lambda v:v['config']['env'].update(PRESENT='foreign')),
            ('file',lambda v:v['config'].update(files=[{'guest_path':'/foreign','raw_value':'foreign'}])),
            ('mount',lambda v:v['config']['mounts'][0].update(volume='foreign')),
            ('unknown metadata',lambda v:v['config']['metadata'].update(unrecognized='foreign')),
            ('cache key',lambda v:v['config']['metadata'].update({key:'malformed'})),
            ('wrong app',lambda v:v['config']['metadata'].update({key:current['config']['metadata'][key].replace(app,'foreign-app')})),
            ('wrong metadata volume',lambda v:v['config']['metadata'].update({key:current['config']['metadata'][key].replace(' vol-owned ',' foreign ')})),
            ('wrong key',lambda v:v['config']['metadata'].update({'rose_cloudbench_deps_'+'f'*32:v['config']['metadata'].pop(key)})),
            ('extra metadata',lambda v:v['config']['metadata'].update({'rose_cloudbench_deps_unknown':'unproven'})),
        ):
            value=copy.deepcopy(current);mutate(value)
            with self.subTest(label=label),patch.object(m,'get',return_value=[snapshot]),self.assertRaises(ValueError):
                m.owned_scope(m.machine(value),original,app=app)
        for change in ({'status':'pending'},{'size':0},{'id':'other'},{'created_at':'2000-01-01T00:00:00+00:00'}):
            with self.subTest(snapshot=change),patch.object(m,'get',return_value=[{**snapshot,**change}]),self.assertRaises(ValueError):
                m.owned_scope(m.machine(current),original,app=app)
        # An existing advisory value is still protected; this is addition only.
        altered=copy.deepcopy(current);altered['config']['metadata'][key]+='x'
        with self.assertRaises(ValueError):m.owned_scope(m.machine(altered),m.machine(current),app=app)

    def test_original_pin_rejects_then_native_transition_qualifies(self):
        # The exact original match body rejects the new config/incarnation.
        import ast
        tree=ast.parse((ROOT/'scripts/deploy_test_round16_isolation.py').read_text())
        observer=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='observe_partition')
        match=next(n for n in observer.body if isinstance(n,ast.FunctionDef) and n.name=='match')
        def check(value,message):
            if not value:raise ValueError(message)
        namespace={'expected':self.pin,'check':check,'json':json,'hashlib':hashlib}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[match],type_ignores=[])),'native-pin','exec'),namespace)
        with self.assertRaisesRegex(ValueError,'warm identity/state changed'):namespace['match'](self.provider['after'])
        result=self.run_native();self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(self.consumer())
        state=c.read(self.context/'cycle.json');self.assertEqual(state['reconciled_owners'],self.state['reconciled_owners'])
        record=state['native_maintenance'][0];intent=m.read(Path(record['directory'])/'intent.json')
        self.assertNotEqual(intent['producer']['pid'],os.getpid());self.assertTrue(intent['producer']['start'])
        self.assertFalse((self.root/'.git/cloudbench-app-env.lock').exists())

    def test_direct_or_wrong_lease_capture_rejected_before_provider_read(self):
        with patch.object(m,'get',side_effect=AssertionError('provider must not run')):
            with self.assertRaisesRegex(ValueError,'direct native setup child'):
                m.native_owner(self.root,os.getpid())
        source=(self.root/'scripts/run-bench-cloud').read_text().replace('acquire_app_environment_lock || exit 1','true')
        (self.root/'scripts/run-bench-cloud').write_text(source)
        result=self.run_native();self.assertNotEqual(result.returncode,0)
        self.assertNotIn('native_maintenance',c.read(self.context/'cycle.json'))

    def test_failed_native_exit_never_qualifies_and_is_preserved(self):
        result=self.run_native(17);self.assertEqual(result.returncode,17,result.stderr)
        state=c.read(self.context/'cycle.json');record=state['native_maintenance'][0]
        self.assertEqual(record['native_exit'],17)
        self.assertEqual(m.read(Path(record['directory'])/'result.json')['native_exit'],17)
        with self.assertRaises(ValueError):self.consumer()

    def test_failed_attempt_then_new_nonce_success_preserves_history(self):
        failed=self.run_native(17);self.assertEqual(failed.returncode,17,failed.stderr)
        first=c.read(self.context/'cycle.json')['native_maintenance'][0]
        original_bytes=(Path(first['directory'])/'result.json').read_bytes()
        # A fresh attempt is permitted only after the old pinned partition is
        # independently qualified again; the synthetic provider restores it here.
        self.phase.write_text('before')
        (self.context/'output/cloudbench-maintenance.json').unlink()
        completed=self.run_native();self.assertEqual(completed.returncode,0,completed.stderr)
        self.assertTrue(self.consumer())
        records=c.read(self.context/'cycle.json')['native_maintenance']
        self.assertEqual(len(records),2);self.assertEqual(records[0],first)
        self.assertNotEqual(records[0]['nonce'],records[1]['nonce'])
        self.assertEqual((Path(first['directory'])/'result.json').read_bytes(),original_bytes)

    def test_invalid_zero_then_qualified_zero_retains_failed_transition(self):
        self.provider['after']['config']['env']['PRESENT']='foreign'
        c.write(self.context/'provider.json',self.provider)
        bad=self.run_native();self.assertNotEqual(bad.returncode,0)
        first=c.read(self.context/'cycle.json')['native_maintenance'][0]
        self.assertEqual(first['native_exit'],0);self.assertFalse(first['qualified'])
        self.provider['after']['config']['env']['PRESENT']='unchanged'
        c.write(self.context/'provider.json',self.provider);self.phase.write_text('before')
        (self.context/'output/cloudbench-maintenance.json').unlink()
        good=self.run_native();self.assertEqual(good.returncode,0,good.stderr)
        self.assertTrue(self.consumer())
        records=c.read(self.context/'cycle.json')['native_maintenance']
        self.assertEqual(records[0],first);self.assertTrue(records[1]['qualified'])

    def test_nonce_owner_source_debt_seals_and_live_partition_refusals(self):
        result=self.run_native();self.assertEqual(result.returncode,0,result.stderr)
        original=c.read(self.context/'cycle.json')
        for key,value in [('nonce','0'*32),('producer',{'pid':1,'start':'fake'}),('source',{}),
                          ('result_sha256','0'*64),('intent_sha256','0'*64),('native_exit',1)]:
            state=copy.deepcopy(original);state['native_maintenance'][0][key]=value
            with self.subTest(key=key),self.assertRaises((ValueError,KeyError,OSError)):self.consumer(state)
        state=copy.deepcopy(original);state['source']={'head':'foreign','digest':'wrong'}
        with self.assertRaisesRegex(ValueError,'root/debt/source'):self.consumer(state)
        state=copy.deepcopy(original);state['native_maintenance'][0]['debt_sha256']='wrong'
        with self.assertRaises(ValueError):self.consumer(state)
        provider=copy.deepcopy(self.provider)
        for mutate in (lambda v:v.update(instance_id='foreign'),lambda v:v['config']['mounts'][0].update(volume='foreign'),
                       lambda v:v['config']['env'].update(PRESENT='foreign'),lambda v:v.update(state='started')):
            self.provider=copy.deepcopy(provider);mutate(self.provider['after'])
            with self.subTest(mutation=mutate),self.assertRaises((ValueError,KeyError,OSError)):self.consumer()
        self.provider=provider

    def test_native_source_change_rejected_before_intent(self):
        (self.root/'scripts/cloudbench_maintenance.py').write_text((self.root/'scripts/cloudbench_maintenance.py').read_text()+'\n# changed\n')
        result=self.run_native();self.assertNotEqual(result.returncode,0)
        self.assertNotIn('native_maintenance',c.read(self.context/'cycle.json'))

    def test_changed_native_target_or_config_is_not_qualified(self):
        self.provider['after']['config']['env']['PRESENT']='changed'
        c.write(self.context/'provider.json',self.provider)
        result=self.run_native();self.assertNotEqual(result.returncode,0)
        with self.assertRaisesRegex(ValueError,'unique successful'):self.consumer()

    def test_declared_pool_extra_target_is_refused_before_intent(self):
        (self.context/'cloudbench-pool.ids').write_text('foreign-machine\n')
        result=self.run_native();self.assertNotEqual(result.returncode,0)
        self.assertNotIn('native_maintenance',c.read(self.context/'cycle.json'))
        self.assertEqual(self.phase.read_text(),'before')

    def test_recipe_inputs_allow_new_harness_head_but_reject_changed_dependency(self):
        original=self.source['head']
        (self.root/'harness-only').write_text('new harness')
        subprocess.run(['git','-C',str(self.root),'add','harness-only'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=fixture','-c','user.email=fixture@example.com','commit','-qm','harness only'],check=True)
        current=m.git(self.root,'rev-parse','HEAD')
        evidence=m.image_inputs(self.root,original,current)
        self.assertNotEqual(evidence['build_source'],evidence['current_source'])
        m.image_build(self.context/'build.json',self.image,self.root,{'head':current})
        (self.root/'package.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'uncommitted image'):m.image_inputs(self.root,original,current)
        (self.root/'package.json').unlink()
        recipe=self.root/'Dockerfile.cloudbench-warm';recipe.write_text(recipe.read_text()+'\nRUN unknown-build-input\n')
        with self.assertRaises(ValueError):m.image_inputs(self.root,original,current)

    def test_orphan_registry_cannot_supply_authority(self):
        result=self.run_native();self.assertEqual(result.returncode,0,result.stderr)
        state=c.read(self.context/'cycle.json');state.pop('native_maintenance')
        with self.assertRaisesRegex(ValueError,'unique successful'):self.consumer(state)

class Quiescence(unittest.TestCase):
    def test_actual_campaign_and_fleet_and_ancestor_are_not_quiescent(self):
        with tempfile.TemporaryDirectory() as td:
            proc=Path(td)/'proc';(proc/'sys/kernel/random').mkdir(parents=True)
            (proc/'sys/kernel/random/boot_id').write_text('fixture-boot')
            for pid in (11,77):
                folder=proc/str(pid);folder.mkdir();(folder/'stat').write_text(f'{pid} (fixture) S 1 0 0')
                (folder/'cmdline').write_bytes(b'')
            real=Path
            def paths(*args):
                value=real(*args)
                return proc/value.relative_to('/proc') if value==real('/proc') or real('/proc') in value.parents else value
            with patch.object(m,'Path',paths),patch.object(m.os,'getpid',return_value=11):
                for name in ('run-bench-campaign.py','run-bench-fleet','run-bench-cloud'):
                    (proc/'77/cmdline').write_bytes(b'python3\0/scripts/'+name.encode()+b'\0')
                    with self.subTest(name=name),self.assertRaisesRegex(ValueError,'another native consumer'):m.quiescent()
                # Only the already verified native owner may be exempt. No
                # blanket ancestor exemption can hide a launching campaign.
                self.assertTrue(m.quiescent(native_pid=77))
                (proc/'77/cmdline').write_bytes(b'python3\0/scripts/run-bench-campaign.py\0')
                with self.assertRaises(ValueError):m.quiescent(native_pid=77)

if __name__=='__main__':unittest.main()
