"""Read-only, positive custody proof for a protected foreign tunnel's metrics socket."""
import hashlib
import json
import os
from pathlib import Path
import time


def need(value, message):
    if not value:
        raise ValueError('foreign listener: ' + message)


def process(pid):
    p=Path('/proc')/str(pid)
    stat=(p/'stat').read_text().rsplit(') ',1)[1].split()
    need(stat[0] not in ('Z','X'), 'process not live')
    return dict(pid=pid,ppid=int(stat[1]),uid=p.stat().st_uid,
                identity='linux:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+stat[19],
                cwd=os.readlink(p/'cwd'),argv_sha256=hashlib.sha256((p/'cmdline').read_bytes()).hexdigest())


def snapshot(port, pid, owner_path):
    need(type(port) is int and 0<port<65536 and type(pid) is int and pid>1, 'numeric socket/process identity required')
    owner_path=Path(owner_path)
    need(owner_path.is_absolute() and owner_path.resolve(strict=True)==owner_path
         and not owner_path.is_symlink() and owner_path.name=='local-stack-owner.json', 'canonical native owner required')
    need(len(owner_path.parents)>=4, 'native owner path too short')
    run=owner_path.parent;foreign=owner_path.parents[3]
    need(run.parent.name=='benchmarks' and run.parent.parent.name=='.context', 'native benchmark owner scope')
    paths=[owner_path,run/'local-benchmark-owner.json',run/'services.json']
    docs=[];hashes={}
    for p in paths:
        need(p.resolve(strict=True)==p and not p.is_symlink() and p.stat().st_size<=1024*1024, 'unsafe owner evidence')
        raw=p.read_bytes();hashes[str(p)]=hashlib.sha256(raw).hexdigest();docs.append(json.loads(raw))
    owner,benchmark,services=docs
    need(owner.get('version')==benchmark.get('version')==1 and owner.get('run_id')==benchmark.get('run_id')==run.name
         and benchmark.get('state')=='failed_retained' and owner.get('token')
         and type(owner.get('pid')) is int and owner['pid']>1, 'explicit original retained owner required')
    parent=process(owner['pid']);child=process(pid)
    need(parent['identity']==owner.get('native_identity') and services.get('run_sh_pid')==parent['pid']
         and services.get('worktree')==str(foreign) and services.get('status')=='running'
         and child['ppid']==parent['pid'] and parent['uid']==child['uid']==os.geteuid()
         and parent['cwd']==child['cwd']==str(foreign), 'native incarnation/ancestry/root mismatch')
    argv=(Path('/proc')/str(pid)/'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    target=services.get('ports',{}).get('frontend')
    need(type(target) is int and 0<target<65536 and Path(argv[0]).name=='cloudflared'
         and argv[1:]==['tunnel','--no-autoupdate','--url',f'http://127.0.0.1:{target}'], 'protected tunnel consumer mismatch')
    log=run/'cloudflared.log'
    need(log.resolve(strict=True)==log and not log.is_symlink()
         and all(os.readlink(Path('/proc')/str(pid)/'fd'/str(fd))==str(log) for fd in (1,2)), 'native tunnel log custody mismatch')
    sockets=[]
    for table in ('/proc/net/tcp','/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row=line.split()
            if row[3]=='0A' and int(row[1].rsplit(':',1)[1],16)==port:
                need(row[1].split(':')[0] in ('0100007F','00000000000000000000000001000000')
                     and int(row[7])==child['uid'], 'non-loopback/foreign-uid listener')
                sockets.append(dict(table=table,local=row[1],inode=row[9],uid=int(row[7])))
    need(sockets, 'listening socket missing')
    owned=set()
    for fd in (Path('/proc')/str(pid)/'fd').iterdir():
        try:owned.add(os.readlink(fd))
        except FileNotFoundError:pass
    need(all('socket:['+s['inode']+']' in owned for s in sockets), 'port has an unproved socket owner')
    # Re-read process incarnations after the socket and evidence observation.
    need(process(pid)==child and process(parent['pid'])==parent, 'process changed during observation')
    return dict(port=port,listener=child,parent=parent,foreign_root=str(foreign),owner_path=str(owner_path),
                evidence=hashes,sockets=sockets,target_frontend=target)


def validate(gate, receipt, proof, blocked):
    from deploy_test_isolation import _ports
    packet=proof.get('foreign_listeners')
    need(isinstance(packet,dict) and set(packet)=={'schema','token','source','worker_root','receipt_sha256','observed_at','listeners'}, 'typed observation required')
    root=Path(gate['worker_root']).resolve(strict=True)
    need(packet['schema']=='protected-foreign-listener-v1' and packet['token']==receipt['token']
         and packet['source']==receipt['source'] and packet['worker_root']==str(root)
         and packet['receipt_sha256']==proof['files']['receipt.json']
         and type(packet['observed_at']) in (int,float)
         and receipt['finished_at']<=packet['observed_at']<=proof['confirmed_at']<=time.time(), 'original receipt/observation binding')
    base=int(gate['env']['CONDUCTOR_PORT'])
    need(blocked and all(_ports.HUB_PORT_OFFSET<=p-base<=_ports.HUB_PORT_OFFSET+_ports.HUB_PORT_SEARCH for p in blocked), 'only dynamic Hub search-window conflicts may be excluded')
    rows=packet['listeners'];need(isinstance(rows,list) and len(rows)==len(blocked)
         and {r['port'] for r in rows}==blocked, 'listener observation closure')
    for row in rows:
        foreign=Path(row['foreign_root'])
        need(root!=foreign and root not in foreign.parents and foreign not in root.parents, 'listener root overlaps interrupted worker')
        need(snapshot(row['port'],row['listener']['pid'],row['owner_path'])==row, 'foreign listener identity/evidence changed')
