
import os,json,time,pathlib,hashlib,stat
P=pathlib.Path('/proc');own=os.getpid();rows=[];errors=[];sockets={};targets=[]
needles=[b'cloudbench-fetch-ref',b'cloudbench-warm-fetch-token.3934342',b'/data/repo',b'run-bench',b'git-sync',b'npm',b'pip',b'uv sync']
for p in P.iterdir():
 if not p.name.isdigit() or int(p.name)==own:continue
 try:
  raw=(p/'stat').read_text();st=raw.rsplit(') ',1)[1].split();args=(p/'cmdline').read_bytes();comm=(p/'comm').read_text().strip();cwd=os.readlink(p/'cwd');exe=os.readlink(p/'exe');fds=[]
  for f in (p/'fd').iterdir():
   try:
    v=os.readlink(f)
    if v.startswith('socket:['):sockets.setdefault(v[8:-1],[]).append(int(p.name))
    if 'cloudbench-warm-fetch-token.3934342' in v:fds.append(v)
   except FileNotFoundError:pass
  matched=any(n in args for n in needles) or cwd.startswith('/data/repo') or bool(fds)
  row={'pid':int(p.name),'ppid':int(st[1]),'state':st[0],'start_ticks':st[19],'comm':comm,'exe':exe,'cwd':cwd,'cmdline_sha256':hashlib.sha256(args).hexdigest(),'refresh_scope_match':matched,'token_path_fds':fds};rows.append(row)
  if matched:targets.append(int(p.name))
 except FileNotFoundError:pass
 except (OSError,ValueError) as e:
  try:
   st=(p/'stat').read_text().rsplit(') ',1)[1].split()
   if st[0] not in ['Z','X']:errors.append({'pid':int(p.name),'error':type(e).__name__})
  except FileNotFoundError:pass
changed=True
while changed:
 changed=False
 for r in rows:
  if r['ppid'] in targets and r['pid'] not in targets:targets.append(r['pid']);changed=True
net=[]
for name in ['tcp','tcp6','udp','udp6']:
 for line in (P/'net'/name).read_text().splitlines()[1:]:
  a=line.split();owners=sockets.get(a[9],[])
  net.append({'family':name,'state':a[3],'local':a[1],'remote':a[2],'inode':a[9],'pids':owners,'refresh_scope':bool(set(owners)&set(targets))})
p=pathlib.Path('/tmp/cloudbench-warm-fetch-token.3934342')
try:
 s=p.lstat();token={'path':str(p),'exists':True,'mode':oct(stat.S_IMODE(s.st_mode)),'uid':s.st_uid,'gid':s.st_gid,'size':s.st_size,'mtime_ns':s.st_mtime_ns,'inode':s.st_ino,'symlink':stat.S_ISLNK(s.st_mode)}
except FileNotFoundError:token={'path':str(p),'exists':False}
print(json.dumps({'observed_at':time.time(),'boot_id':(P/'sys/kernel/random/boot_id').read_text().strip(),'uid':os.geteuid(),'hostname':os.uname().nodename,'processes':rows,'refresh_scope_pids':sorted(targets),'unreadable':errors,'sockets':net,'token_path_metadata':token,'mutations':0,'token_contents_read':False}))
