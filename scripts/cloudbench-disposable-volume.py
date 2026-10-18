#!/usr/bin/env python3
"""Disable scheduled backups only for a newly allocated, exact run-owned Volume."""
import argparse,base64,json,os,random,re,runpy,signal,stat,time
from contextlib import contextmanager
from pathlib import Path

class Deadline(Exception): pass

class Rejected(ValueError):
    """The bounded native CLI completed and rejected one call (not a deadline)."""

# Fly can transiently reject a call during a clone burst, e.g. a Volume PUT
# answering "volume not found" 240 ms after GET showed the same exact Volume
# attached. Every call here is a read or the absolute, idempotent backup
# setting, so a completed rejection is retried a bounded number of times.
ATTEMPTS=3

def pause(attempt):
    # Exponential backoff with jitter keeps a burst's retries from realigning.
    time.sleep(random.uniform(1,2)*2**attempt)

def retried(call):
    for attempt in range(ATTEMPTS):
        try:return call()
        except Rejected:
            if attempt+1==ATTEMPTS:raise
            pause(attempt)

def need(value,message):
    if not value: raise ValueError(message)

@contextmanager
def bounded(seconds):
    prior=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM)
    need(not prior[1], 'periodic alarm refused')
    start=time.monotonic();seconds=min(seconds,prior[0]) if prior[0] else seconds
    def expire(*unused): raise Deadline('disposable Volume deadline')
    signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,seconds)
    try:
        yield
        need(time.monotonic()-start<seconds,'late disposable Volume completion')
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if prior[0]:signal.setitimer(signal.ITIMER_REAL,max(.000001,prior[0]-(time.monotonic()-start)))

def read(path):
    need(path.resolve(strict=True)==path,'physical path required')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        info=os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_size<1048576,'unsafe owner file')
        return stream.read(info.st_size+1)

def fields(path):
    pairs=[line.split('=',1) for line in read(path).decode().splitlines()]
    value=dict(pairs);need(len(value)==len(pairs),'duplicate fields');return value

def save(path,value):
    raw=(json.dumps(value,sort_keys=True)+'\n').encode()
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)

def configure(registry,owner,app,name,mid,vid,protected,command,*,audit,run):
    registry=Path(registry).absolute()
    with bounded(60):
        need(registry.resolve(strict=True)==registry and registry.name==owner,'wrong registry')
        need(re.fullmatch('[0-9a-f]{32}',owner) and re.fullmatch('cloudbench-[A-Za-z0-9._-]+',name),'wrong owner/name')
        need(re.fullmatch('[0-9a-f]{8,32}',mid) and re.fullmatch('vol_[A-Za-z0-9_-]+',vid),'wrong resource ID')
        need(mid!='820224f7e069e8' and mid not in protected and vid not in protected,'protected seed resource')
        need(read(registry/'disposable-resources-v1')==(owner+'\n'+app+'\n').encode(),'not current disposable registry')
        meta=fields(registry/'meta')
        need(all(meta.get(k)==v for k,v in dict(version='2',fleet_owner_token=owner,run_id=run,app=app).items()),'registry owner changed')
        audit=Path(audit).absolute()
        expected=fields(audit/'expected-fresh'/name);actual=fields(audit/'fresh'/name)
        need(set(expected)=={'clone_name','source_machine_id'} and expected['clone_name']==name,'wrong expected clone')
        need(re.fullmatch('[0-9a-f]+',expected['source_machine_id']),'wrong clone source')
        need(actual==dict(version='1',fleet_owner_token=owner,run_id=run,app=app,clone_name=name,source='fresh-clone',source_machine_id=expected['source_machine_id'],machine_id=mid,volume_id=vid,disposition='owned'),'audit ownership changed')
        row=fields(registry/'clones'/name)
        need(row==dict(name=name,id=mid,volume_id=vid),'resource ownership changed')
        parent=audit/'volume-backups'
        if not parent.exists():parent.mkdir(mode=0o700)
        need(parent.resolve(strict=True)==parent and parent.is_dir(),'linked backup receipt root')
        directory=parent/vid
        if not directory.exists():directory.mkdir(mode=0o700)
        need(directory.resolve(strict=True)==directory and directory.is_dir(),'linked evidence directory')
        def inspect():
            config=retried(lambda:command(['machine','status',mid,'-a',app,'-d']))
            mounts=config.get('mounts',[])
            need(len(mounts)==1 and mounts[0].get('volume')==vid,'native mount changed')
            value=retried(lambda:command(['volumes','show',vid,'-a',app,'--json']))
            need(value.get('id')==vid and value.get('state')=='created','Volume identity/state changed')
            need(type(value.get('auto_backup_enabled')) is bool,'backup setting missing')
            need(value.get('attached_machine_id')==mid,'Volume not attached to the exact owned Machine')
            need(fields(registry/'clones'/name)==row,'ownership changed during read')
            return value
        before=inspect()
        if before['auto_backup_enabled'] is False:
            if not (directory/'verified.json').exists():save(directory/'verified.json',dict(owner=owner,app=app,run_id=run,machine=mid,volume=vid,auto_backup_enabled=False,native=before))
            return
        def unchanged(value):
            for key in ('id','name','region','size_gb','snapshot_retention','encrypted','created_at'):
                need(value.get(key)==before.get(key),'Volume properties changed: '+key)
            return value
        save(directory/'intent.json',dict(machine=mid,volume=vid,app=app,auto_backup_enabled=False,before=before))
        # A completed CLI rejection is decided by a fresh exact read: replay the
        # idempotent setting only while the same owned, attached, unchanged
        # Volume still reports backups enabled. An ambiguous transport failure
        # or deadline leaves the intent intact and refuses boot without replay.
        after=None
        for attempt in range(ATTEMPTS):
            try:command(['volumes','update',vid,'-a',app,'--scheduled-snapshots=false','--json'])
            except Rejected:
                if attempt+1==ATTEMPTS:raise
                pause(attempt)
                current=unchanged(inspect())
                if current['auto_backup_enabled'] is False:after=current;break
                continue
            after=inspect();break
        need(after['auto_backup_enabled'] is False,'scheduled snapshots still enabled')
        unchanged(after)
        save(directory/'verified.json',dict(owner=owner,app=app,run_id=run,machine=mid,volume=vid,auto_backup_enabled=False,native=after))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('registry','owner','app','name','machine','volume','audit','run'):parser.add_argument('--'+key,required=True)
    parser.add_argument('--protected',action='append',default=[])
    args=parser.parse_args()
    with bounded(60):
        helper=runpy.run_path(str(Path(__file__).resolve().with_name('cloudbench-original-volume-capture.py')))
        def command(argv):
            # Native config JSON can contain secrets: retain lossless diagnostics
            # privately, never interpolate provider output into the traceback.
            directory=Path(args.audit).absolute()/'volume-backups'/args.volume/'commands'
            directory.mkdir(mode=0o700,exist_ok=True)
            info=directory.lstat()
            need(directory.resolve(strict=True)==directory and stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'unsafe command evidence directory')
            stem='command-'+str(time.time_ns())+'-'+str(os.getpid())
            intent=directory/(stem+'.intent.json');result=directory/(stem+'.result.json')
            started=time.monotonic()
            save(intent,dict(argv=argv,started_monotonic=started))
            status,out,err=helper['run_bounded'](['bash','-c','FLY "$@"','disposable-volume',*argv],20,dict(os.environ))
            save(result,dict(argv=argv,status=status,stdout_base64=base64.b64encode(out).decode(),stderr_base64=base64.b64encode(err).decode(),started_monotonic=started,finished_monotonic=time.monotonic()))
            if status!=0:
                # 142 is the bounded child's deadline: that request may still be in flight.
                raise (ValueError if status==142 else Rejected)('Volume configuration CLI failed (exit '+str(status)+'; private receipt '+str(result)+')')
            value=json.loads(out);need(isinstance(value,dict),'invalid native JSON');return value
        configure(args.registry,args.owner,args.app,args.name,args.machine,args.volume,args.protected,command,audit=args.audit,run=args.run)
if __name__=='__main__':main()
