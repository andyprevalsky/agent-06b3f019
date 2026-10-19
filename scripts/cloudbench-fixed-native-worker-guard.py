"""Exact current-custody worker subtype; original admission validator is unchanged."""
from pathlib import Path
import hashlib,json,os,re,runpy,stat
D=Path(__file__).resolve().parent
BASELINE_SHA='3488c13d869bbb560d7c36d0940c3179f25ff114e77b29a146138d5ebb97d0e2'
def require(ok,why):
 if not ok:raise ValueError(why)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def baseline():
 p=D/'cloudbench-fixed-native-worker-baseline.json';fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  a=os.fstat(f.fileno());raw=f.read(65537);b=os.fstat(f.fileno())
 require(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and len(raw)<65537 and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns),'unsafe baseline')
 require(sha(raw)==BASELINE_SHA,'wrong fixed baseline');return json.loads(raw)
def native_pair(before,after,resource,reader):
 require(before['path']!=after['path']and(before['device'],before['inode'])!=(after['device'],after['inode']),'native pair reused one read')
 a,b=reader(before),reader(after);require(a==b,'native pair differs');base=baseline();c=a.get('config',{})
 require(a.get('id')==base['machine']==resource['machine_id']and a.get('name')==base['name']==resource['name'],'fixed native identity')
 require(a.get('state')=='stopped'and a.get('instance_id')==resource['instance_id'],'fixed native stopped instance')
 require(sha(canonical(c))==base['config_sha256']==resource['config_sha256'],'fixed native configuration changed')
 require(sha(canonical(c.get('env')))==base['env_sha256']and sorted(c.get('env',{}))==base['env_keys'],'fixed native environment changed')
 require(sha(canonical(c.get('files')))==base['files_sha256'],'fixed native boot files changed')
 require(c.get('init')=={'cmd':['sleep','infinity']}and c.get('restart')=={'policy':'no'}and c.get('auto_destroy')in(None,False),'unsafe fixed startup')
 require(not any(c.get(k)for k in('containers','processes','standbys','schedule')),'additional startup mechanism')
 require(c.get('guest')==base['shape']==resource['shape']and c.get('image')==base['image'],'fixed native shape/image')
 require((a.get('image_ref')or{}).get('digest')==resource['image_digest']==base['image'].rpartition('@')[2],'resolved fixed image')
 mounts=c.get('mounts');require(len(mounts)==1 and mounts[0].get('path')=='/data'and mounts[0].get('volume')==base['volume']==resource['volume_id'],'fixed native Volume')
 return a
def cleared_worker_environment(inherited):
 """Pure child environment construction; never changes native config or os.environ."""
 base=baseline();require(isinstance(inherited,dict)and all(isinstance(k,str)and isinstance(v,str)for k,v in inherited.items()),'environment types')
 return{k:v for k,v in inherited.items()if k not in base['env_keys']}
def worker_entry_argv():
 # This is the required future call-site contract, not an invoked command.
 return['env',*[part for key in baseline()['env_keys']for part in('-u',key)],'bash','/tmp/rbw.sh']
