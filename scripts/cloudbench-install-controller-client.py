#!/usr/bin/env python3
"""Install the pinned controller CLI into its disposable workspace, never a VM config."""
import argparse,hashlib,io,os,signal,stat,tarfile,urllib.request
from pathlib import Path
VERSION='0.4.115'
URL='https://github.com/superfly/flyctl/releases/download/v'+VERSION+'/flyctl_'+VERSION+'_Linux_x86_64.tar.gz'
BINARY_SHA256='5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83'
BINARY_SIZE=113733507

def digest(path):
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as f:
  info=os.fstat(f.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_mode&0o022:raise ValueError('unsafe controller CLI')
  h=hashlib.sha256()
  while b:=f.read(1048576):h.update(b)
  return h.hexdigest()
def download():
 with urllib.request.urlopen(URL,timeout=20)as response:
  raw=response.read(64*1024*1024+1)
 if len(raw)>64*1024*1024:raise ValueError('controller CLI archive too large')
 return raw

def install(directory,fetch=download):
 directory=Path(directory).absolute()
 if directory.parent.resolve(strict=True)!=directory.parent:raise ValueError('physical controller workspace required')
 directory.mkdir(mode=0o755,exist_ok=True)
 if directory.resolve(strict=True)!=directory:raise ValueError('linked controller toolchain refused')
 target=directory/'flyctl'
 if os.path.lexists(target):
  if digest(target)!=BINARY_SHA256:raise ValueError('existing controller CLI differs from pinned release')
  return
 with tarfile.open(fileobj=io.BytesIO(fetch()),mode='r:gz')as archive:
  members=archive.getmembers()
  if len(members)!=1 or members[0].name!='flyctl' or not members[0].isfile() or members[0].size!=BINARY_SIZE:raise ValueError('unexpected controller CLI archive')
  candidate=directory/'flyctl.pending'
  h=hashlib.sha256();count=0
  with archive.extractfile(members[0])as source,os.fdopen(os.open(candidate,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as output:
   while block:=source.read(1048576):h.update(block);count+=len(block);output.write(block)
   output.flush();os.fsync(output.fileno())
  if count!=BINARY_SIZE or h.hexdigest()!=BINARY_SHA256:raise ValueError('controller CLI checksum changed')
  candidate.chmod(0o755);os.link(candidate,target,follow_symlinks=False);candidate.unlink()
  fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)

def main():
 p=argparse.ArgumentParser();p.add_argument('--directory',type=Path,required=True);args=p.parse_args()
 def deadline(*unused):raise TimeoutError('controller CLI installation exceeded120seconds')
 signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,120)
 install(args.directory)
 print('GATE_CONTROLLER_CLIENT version='+VERSION+' sha256='+BINARY_SHA256,flush=True)
if __name__=='__main__':main()
