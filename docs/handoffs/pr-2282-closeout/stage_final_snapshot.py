"""Run only after parent explicitly confirms gates/production have finished."""
import argparse,datetime,hashlib,json,os,shutil,stat
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--parent-confirmed-frozen',action='store_true',required=True);args=p.parse_args()
repo=Path('/home/boxes/rose');prep=repo/'.context/b82-closeout-prep';stage=prep/'final-staging'
if stage.exists():raise SystemExit('Refusing to overwrite prior staging; inspect it before a new capture')
roots=[repo/'.context',repo/'.llm-dumps',*sorted(Path('/tmp').glob('rca-b82*')),*sorted(Path('/tmp').glob('b82*')),*[repo/n for n in ['agents/navi-worker-log.txt','back-end/backend-logs.log','front-end/frontend-logs.log','hub-poller-logs.log','front-end/playwright-report']]]
def excluded(path):
 return path.name in {'.cloud-env','.env.npm','.env'} or path.name.startswith('.env.') or path.suffix in {'.pem','.key','.p12'} or path.name.startswith('id_rsa') or (path.name.startswith('credentials') and path.suffix=='.json')
files=[];skipped=[]
for root in roots:
 for path in ([root] if root.is_file() else sorted(root.rglob('*')) if root.is_dir() else []):
  if path.is_relative_to(prep):continue
  if path.is_symlink():skipped.append({'path':str(path),'reason':'symlink recorded; no dereference','target':os.readlink(path),'resolved_target':str(path.resolve())});continue
  if not path.is_file():continue
  if excluded(path):skipped.append({'path':str(path),'reason':'secret-named file remains managed/private outside archive'});continue
  files.append(path)
stage.mkdir(mode=0o700)
records=[]
for source in files:
 before=source.stat();name=Path('absolute')/source.relative_to('/');dest=stage/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest);os.chmod(dest,0o600)
 digest=hashlib.sha256(dest.read_bytes()).hexdigest();after=source.stat()
 if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or digest!=hashlib.sha256(source.read_bytes()).hexdigest():raise SystemExit('Source changed during capture: '+str(source))
 records.append({'source':str(source),'staged':str(dest),'bytes':before.st_size,'mtime_ns':before.st_mtime_ns,'sha256':digest})
for row in records:
 source=Path(row['source']);s=source.stat()
 if (s.st_size,s.st_mtime_ns)!=(row['bytes'],row['mtime_ns']):raise SystemExit('Source changed before snapshot completed: '+str(source))
manifest=stage/'SOURCE_MANIFEST.json';manifest.write_text(json.dumps({'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':records,'excluded':skipped,'notes':'Only immutable staged copies are supplied to encrypted uploader; original absolute source paths retained for restore.'},indent=2));os.chmod(manifest,0o600)
(prep/'final-files.json').write_text(json.dumps([row['staged'] for row in records]+[str(manifest)],indent=2))
(prep/'final-capture-summary.json').write_text(json.dumps({'files':len(records),'bytes':sum(r['bytes'] for r in records),'excluded':skipped,'stage':str(stage),'status':'staged; NOT yet encrypted/uploaded'},indent=2))
print(json.dumps({'files':len(records),'bytes':sum(r['bytes'] for r in records),'file_list':str(prep/'final-files.json')}))
