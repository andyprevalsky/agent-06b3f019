#!/usr/bin/env python3
import copy,json,os,re,runpy,subprocess,tempfile,time,unittest
from pathlib import Path
MODULE=Path(__file__).resolve().parents[1]/'cloudbench-disposable-volume.py'
class Backup(unittest.TestCase):
 def setUp(self):
  self.mod=runpy.run_path(str(MODULE));self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.owner='a'*32;self.reg=Path(self.tmp.name)/self.owner;(self.reg/'clones').mkdir(parents=True)
  (self.reg/'disposable-resources-v1').write_text(self.owner+'\nfixture\n')
  (self.reg/'clones/cloudbench-fixture').write_text('name=cloudbench-fixture\nid=abcd1234\nvolume_id=vol_owned\n')
  (self.reg/'meta').write_text('version=2\nfleet_owner_token='+self.owner+'\nrun_id=run\napp=fixture\n')
  self.audit=Path(self.tmp.name)/'audit'
  for directory in ('expected-fresh','fresh'):(self.audit/directory).mkdir(parents=True)
  (self.audit/'expected-fresh/cloudbench-fixture').write_text('clone_name=cloudbench-fixture\nsource_machine_id=1234abcd\n')
  (self.audit/'fresh/cloudbench-fixture').write_text(''.join(k+'='+v+'\n' for k,v in dict(version='1',fleet_owner_token=self.owner,run_id='run',app='fixture',clone_name='cloudbench-fixture',source='fresh-clone',source_machine_id='1234abcd',machine_id='abcd1234',volume_id='vol_owned',disposition='owned').items()))
  self.volume=dict(id='vol_owned',state='created',auto_backup_enabled=True,snapshot_retention=5,size_gb=40,name='fork',attached_machine_id='abcd1234')
  self.calls=[];self.ambiguous=False;self.drift=False;self.rejections=[]
  self.pauses=[];self.mod['configure'].__globals__['pause']=self.pauses.append
 def rejected(self,args):
  # Observed run600c shard-16 r002-j0277: Fly returned "volume not found"
  # (CLI exit 1) for the PUT 240 ms after GET showed the exact attached Volume.
  if self.rejections and args[:2]==self.rejections[0]:
   self.rejections.pop(0);raise self.mod['Rejected']('Volume configuration CLI failed (exit 1; private receipt fixture)')
 def command(self,args):
  self.calls.append(args);self.rejected(args)
  if args[:2]==['machine','status']:return dict(mounts=[dict(volume='vol_owned')])
  if args[:2]==['volumes','show']:return copy.deepcopy(self.volume)
  if args[:2]==['volumes','update']:
   if self.ambiguous:raise TimeoutError('ambiguous update')
   self.volume['auto_backup_enabled']=False
   if self.drift:self.volume['size_gb']=41
   return copy.deepcopy(self.volume)
  raise AssertionError(args)
 def run_config(self,protected=()):
  self.mod['configure'](self.reg,self.owner,'fixture','cloudbench-fixture','abcd1234','vol_owned',protected,self.command,audit=self.audit,run='run')
 def test_exact_owned_before_boot_and_second_revision_no_update(self):
  self.run_config();self.run_config()
  self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),1)
  self.assertFalse(self.volume['auto_backup_enabled']);self.assertEqual(self.volume['size_gb'],40);self.assertEqual(self.volume['snapshot_retention'],5)
 def test_warm_seed_has_zero_calls(self):
  with self.assertRaises(ValueError):self.run_config(['vol_owned'])
  self.assertEqual(self.calls,[])
 def test_foreign_marker_has_zero_calls(self):
  (self.reg/'disposable-resources-v1').write_text('b'*32+'\nfixture\n')
  with self.assertRaises(ValueError):self.run_config()
  self.assertEqual(self.calls,[])
 def test_mount_drift_no_update(self):
  original=self.command
  def changed(args):
   if args[:2]==['machine','status']:return dict(mounts=[dict(volume='vol_foreign')])
   return original(args)
  self.command=changed
  with self.assertRaises(ValueError):self.run_config()
  self.assertEqual(self.calls,[])
 def test_ambiguous_update_not_replayed(self):
  self.ambiguous=True
  with self.assertRaises(TimeoutError):self.run_config()
  with self.assertRaises(FileExistsError):self.run_config()
  self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),1)
 def test_transient_update_rejection_replays_after_exact_read(self):
  self.rejections=[['volumes','update']]
  self.run_config()
  self.assertEqual([c[:2] for c in self.calls],[['machine','status'],['volumes','show'],['volumes','update'],['machine','status'],['volumes','show'],['volumes','update'],['machine','status'],['volumes','show']])
  self.assertFalse(json.loads((self.audit/'volume-backups/vol_owned/verified.json').read_text())['auto_backup_enabled'])
  self.assertEqual(self.pauses,[0])
 def test_rejected_update_that_applied_is_verified_without_replay(self):
  original=self.command
  def applied_then_rejected(args):
   if args[:2]==['volumes','update'] and not self.rejections:
    self.calls.append(args);self.volume['auto_backup_enabled']=False;self.rejections=[['never']]
    raise self.mod['Rejected']('Volume configuration CLI failed (exit 1; private receipt fixture)')
   return original(args)
  self.command=applied_then_rejected;self.run_config()
  self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),1)
  self.assertTrue((self.audit/'volume-backups/vol_owned/verified.json').exists())
 def test_persistent_update_rejection_is_bounded_and_unverified(self):
  self.rejections=[['volumes','update']]*10
  with self.assertRaises(ValueError):self.run_config()
  self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),3)
  self.assertFalse((self.audit/'volume-backups/vol_owned/verified.json').exists())
  self.assertTrue((self.audit/'volume-backups/vol_owned/intent.json').exists())
 def test_rejected_update_never_replays_after_attachment_drift(self):
  self.rejections=[['volumes','update']];original=self.command
  def detached(args):
   value=original(args)
   if args[:2]==['volumes','show'] and sum(c[:2]==['volumes','update'] for c in self.calls):value['attached_machine_id']='foreign1234'
   return value
  self.command=detached
  with self.assertRaises(ValueError):self.run_config()
  self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),1)
  self.assertFalse((self.audit/'volume-backups/vol_owned/verified.json').exists())
 def test_transient_read_rejection_retries_read_before_update(self):
  self.rejections=[['volumes','show']]
  self.run_config()
  self.assertEqual([c[:2] for c in self.calls][:4],[['machine','status'],['volumes','show'],['volumes','show'],['volumes','update']])
  self.assertTrue((self.audit/'volume-backups/vol_owned/verified.json').exists())
 def test_already_disabled_needs_no_update(self):
  self.volume['auto_backup_enabled']=False;self.run_config();self.assertEqual(sum(c[:2]==['volumes','update'] for c in self.calls),0)
 def test_setting_update_cannot_resize(self):
  self.drift=True
  with self.assertRaises(ValueError):self.run_config()
  self.assertFalse((self.audit/'volume-backups/vol_owned/verified.json').exists())
 def test_foreign_full_audit_has_zero_provider_calls(self):
  p=self.audit/'fresh/cloudbench-fixture';p.write_text(p.read_text().replace('app=fixture','app=foreign'))
  with self.assertRaises(ValueError):self.run_config()
  self.assertEqual(self.calls,[])
 def test_missing_attachment_never_updates(self):
  self.volume['attached_machine_id']=None
  with self.assertRaises(ValueError):self.run_config()
  self.assertFalse(any(c[:2]==['volumes','update'] for c in self.calls))
 def test_native_classifiers_block_protected_and_outgoing_volume_update(self):
  source=MODULE.with_name('run-bench-fleet').read_text()
  script='set -eu\n'+''.join(re.search(r'^'+name+r'\(\).*?^}\n',source,re.M|re.S).group() for name in ('private_source_allows_provider_call','FLY'))+r'''
PRIVATE_SOURCE_ID=abcd1234;PRIVATE_SOURCE_VOLUME_ID=vol_private
SHARED_WARM_ID=1234abcd;SHARED_WARM_VOLUME_ID=vol_shared
GIT_COMMON_DIR="$CASE/common";mkdir -p "$GIT_COMMON_DIR/cloudbench-cold-handoffs/outgoing"
touch "$GIT_COMMON_DIR/cloudbench-cold-handoffs/outgoing/vol_outgoing"
flyctl(){ echo called >> "$CASE/calls"; }
for noun in volume volumes;do
 for vid in vol_private vol_shared vol_outgoing;do
  if FLY "$noun" update "$vid" --scheduled-snapshots=false;then exit 90;fi
 done
done
test ! -e "$CASE/calls"
'''
  result=subprocess.run(['bash','-c',script],env=dict(os.environ,CASE=self.tmp.name),capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
 def test_parent_fly_dependency_exports_survive_actual_volume_helper_child(self):
  import shlex
  root=MODULE.parents[1]
  source=Path(os.environ.get('CLOUDBENCH_TEST_EXPORT_CLOSURE_SOURCE',str(root/'scripts/run-bench-fleet'))).read_text()
  functions='\n'.join(re.search(r'^'+name+r'\(\).*?^}\n',source,re.M|re.S).group() for name in ('private_source_allows_provider_call','FLY','fleet_disable_disposable_volume_snapshots'))
  bindir=Path(self.tmp.name)/'bin';bindir.mkdir();state=Path(self.tmp.name)/'native-disabled';trace=Path(self.tmp.name)/'native-calls'
  fake=bindir/'flyctl';fake.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nargs=sys.argv[1:];state=Path(os.environ['FIXTURE_DISABLED'])\nwith Path(os.environ['FIXTURE_TRACE']).open('a') as out:out.write(json.dumps(args)+'\\n')\nif args[:2]==['machine','status']:value={'mounts':[{'volume':'vol_owned'}]}\nelif args[:2]==['volumes','update']:\n state.write_text('disabled');value={}\nelif args[:2]==['volumes','show']:value={'id':'vol_owned','state':'created','auto_backup_enabled':not state.exists(),'attached_machine_id':'abcd1234','size_gb':40,'snapshot_retention':5,'name':'fork'}\nelse:raise SystemExit(91)\nprint(json.dumps(value))\n");fake.chmod(0o700)
  values=dict(ROOT_DIR=str(root),CLOUDBENCH_SCRIPT_SNAPSHOT=str(root/'scripts'),DISPOSABLE_LIFECYCLE='1',
              APP='fixture',GIT_COMMON_DIR=self.tmp.name,FLEET_REGISTRY_DIR=str(self.reg),FLEET_OWNER_TOKEN=self.owner,
              FLEET_TEARDOWN_OWNERSHIP_DIR=str(self.audit),RUN_ID='run',FIXTURE_DISABLED=str(state),FIXTURE_TRACE=str(trace),
              PRIVATE_SOURCE_ID='protected-source',PRIVATE_SOURCE_VOLUME_ID='protected-volume',SHARED_WARM_ID='shared-source',SHARED_WARM_VOLUME_ID='shared-volume')
  setup='\n'.join(key+'='+shlex.quote(value) for key,value in values.items())
  script='set -eu\nsource '+shlex.quote(str(root/'scripts/lib/cloudbench-env.sh'))+'\nsource '+shlex.quote(str(root/'scripts/lib/cloudbench-archived-reuse.sh'))+'\n'+functions+'\n'+setup+'\nexport FIXTURE_DISABLED FIXTURE_TRACE\nfleet_current_disposable_registry(){ return 0; }\nfleet_disable_disposable_volume_snapshots cloudbench-fixture abcd1234 vol_owned\n'
  result=subprocess.run(['bash','-c',script],env=dict(os.environ,PATH=str(bindir)+os.pathsep+os.environ['PATH']),capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr+result.stdout)
  receipt=self.audit/'volume-backups/vol_owned/verified.json'
  self.assertFalse(json.loads(receipt.read_text())['auto_backup_enabled'])
  calls=[json.loads(line) for line in trace.read_text().splitlines()]
  self.assertEqual([row[:2] for row in calls],[['machine','status'],['volumes','show'],['volumes','update'],['machine','status'],['volumes','show']])

 def test_actual_clone_waits_for_restored_storage_before_backup_update(self):
  root=Path(self.tmp.name)/'sources';(root/'scripts/lib').mkdir(parents=True)
  fleet=Path(os.environ.get('CLOUDBENCH_TEST_OLD_STORAGE_SOURCE',str(MODULE.with_name('run-bench-fleet'))))
  (root/'scripts/run-bench-fleet').write_bytes(fleet.read_bytes())
  (root/'scripts/lib/cloudbench-inventory.sh').write_bytes(MODULE.with_name('lib').joinpath('cloudbench-inventory.sh').read_bytes())
  fixture=MODULE.with_name('tests').joinpath('cloudbench-multi-workstream.test.sh').read_text()
  loader=fixture[fixture.index('fleet_production_function() {'):fixture.index('\n}\n',fixture.index('fleet_production_function() {'))+3]
  contract=fixture[fixture.index('clone_source_read_rate_limit_contract() ('):fixture.index('\n)\n',fixture.index('clone_source_read_rate_limit_contract() ('))+3]
  script=loader+contract+'\nclone_source_read_rate_limit_contract\n'
  result=subprocess.run(['bash','-c',script],env=dict(os.environ,ROOT_DIR=str(root),TMP_ROOT=self.tmp.name,FLEET_BENCH_APP='fixture'),capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
 def test_slow_read_absolute_bound_before_update(self):
  original=self.mod['bounded'];self.mod['configure'].__globals__['bounded']=lambda seconds:original(.03)
  def delayed(args):time.sleep(.08);return self.command(args)
  with self.assertRaises(self.mod['Deadline']):self.mod['configure'](self.reg,self.owner,'fixture','cloudbench-fixture','abcd1234','vol_owned',[],delayed,audit=self.audit,run='run')
  self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
