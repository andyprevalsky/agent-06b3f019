#!/usr/bin/env python3
"""One campaign relay process; pinned Fly agent RPC, no per-route processes.

The agent's internal protocol is coupled to official flyctl v0.4.115. Local
half-closes are forwarded; the upstream agent closes both directions on EOF,
so this adapter cannot promise stronger end-to-end FIN semantics than flyctl.

Parent integration resolves app organization/network once using canonical FLY
status JSON, then owns one standard ``flyctl proxy 0:1 ::1 -a APP -q`` process
and an explicit shared FLY_AGENT_SOCKET_PATH. That establishes the tunnel; this
module neither creates peers nor queries provider APIs. It verifies the agent
PING peer/version and uses the exact v0.4.115 agent/internal/proto wire format:
uint16 little-endian length, ``connect ORG [IP]:PORT 10000 NETWORK``, framed
``ok``, then raw bytes. Empty NETWORK requires its final space.

The original campaign deadline limits new route admission only. Existing
streams remain available during joined cleanup. A retired parent never causes
live/unknown child-owned routes to be discarded. Cold orphan cleanup waits for
exact owner retirement; normal acquire/check/release touch only selected keys.
Authority and lease records are evidence, never pool/task readiness credit.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import socket
import stat
import struct
import sys
import time
import uuid

VERSION = '0.4.115'
MAX_CONTROL = 65536
BUFFER = 65536
IO_TIMEOUT = 10

class Refusal(ValueError): pass
class Collision(Refusal): pass

def need(value, message):
    if not value: raise Refusal(message)

def birth(pid):
    try:
        fields=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
        if fields[0] in ('Z','X'):return None
        return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
    except (FileNotFoundError,ProcessLookupError): return None

def ancestor(pid, target):
    seen=set()
    while pid>1 and pid not in seen:
        if pid==target:return True
        seen.add(pid)
        try:pid=int(Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[1])
        except (FileNotFoundError,ProcessLookupError):return False
    return False

def parent_of(pid):
    try:return int(Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[1])
    except FileNotFoundError:return None

def physical(path, directory=False, sock=False):
    path=Path(path);info=path.lstat()
    kind=stat.S_ISDIR(info.st_mode) if directory else stat.S_ISSOCK(info.st_mode) if sock else stat.S_ISREG(info.st_mode)
    need(kind and info.st_uid==os.getuid() and not info.st_mode&0o022,'unsafe relay path')
    need(path.resolve(strict=True)==path.absolute(),'redirected relay path')
    if not directory:need(info.st_nlink==1,'aliased relay path')
    return info

def private_json(path):
    physical(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as stream:
        info=os.fstat(stream.fileno());need(info.st_size<=MAX_CONTROL,'oversized relay record');raw=stream.read(MAX_CONTROL+1)
    need(len(raw)<=MAX_CONTROL,'oversized relay record')
    return json.loads(raw),hashlib.sha256(raw).hexdigest()

def save(path, value, replace=False):
    path=Path(path);path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);physical(path.parent,True)
    target=path.with_name('.'+path.name+'.'+uuid.uuid4().hex)if replace else path
    raw=value if isinstance(value,bytes)else(json.dumps(value,sort_keys=True)+'\n').encode()
    with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    if replace:os.replace(target,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def authority(path):
    value,digest=private_json(path)
    required={'schema','app','org_slug','network','parent_pid','parent_start','source_sha256','agent_socket','inventory_directory','inventory_owner','allowed_remote_ports','deadline'}
    need(set(value)==required and value['schema']=='shared-relay-authority-v1','unknown relay authority')
    need(value['source_sha256']==hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'relay source differs from approved authority')
    for key in ['app','org_slug']:
        need(isinstance(value[key],str)and re.fullmatch(r'[A-Za-z0-9_.-]+',value[key]),'unsafe relay organization/app')
    need(isinstance(value['network'],str)and re.fullmatch(r'[A-Za-z0-9_.-]*',value['network']),'unsafe relay network')
    need(type(value['parent_pid'])is int and value['parent_pid']>1 and isinstance(value['parent_start'],str),'invalid relay parent')
    need(type(value['deadline'])in(int,float)and math.isfinite(value['deadline']),'invalid original relay deadline')
    need(isinstance(value['allowed_remote_ports'],list)and value['allowed_remote_ports']and all(type(p)is int and 1<=p<=65535 for p in value['allowed_remote_ports']),'invalid allowed relay ports')
    return value,digest

async def frame_read(reader, width=2):
    header=await reader.readexactly(width);size=int.from_bytes(header,'little'if width==2 else'big')
    need(0<size<=MAX_CONTROL,'invalid relay frame length')
    return await reader.readexactly(size)

async def frame_write(writer, payload, width=2):
    need(0<len(payload)<=min(MAX_CONTROL,65535 if width==2 else MAX_CONTROL),'invalid relay frame size')
    writer.write(len(payload).to_bytes(width,'little'if width==2 else'big')+payload);await writer.drain()

async def closed(writer):
    writer.close()
    try:
        async with asyncio.timeout(.5):await writer.wait_closed()
    except TimeoutError:writer.transport.abort()
    except (OSError,ConnectionError):pass

class Broker:
    def __init__(self, auth, digest, directory):
        self.auth=auth;self.digest=digest;self.directory=Path(directory);self.routes={};self.ports={};self.stop=asyncio.Event();self.agent=None
    def parent_live(self):
        need(birth(self.auth['parent_pid'])==self.auth['parent_start'],'relay campaign parent retired')
    def requester(self, request, peer, *, closing=False):
        need(request.get('authority_sha256')==self.digest,'foreign relay authority')
        pid=request.get('owner_pid');stamp=request.get('owner_start')
        need(type(pid)is int and pid>1 and isinstance(stamp,str),'invalid relay owner')
        direct=peer==self.auth['parent_pid']or parent_of(peer)==self.auth['parent_pid']
        owner_live=birth(pid)==stamp
        need((owner_live and ancestor(peer,pid)and(closing or ancestor(pid,self.auth['parent_pid'])))or(closing and direct and not owner_live),'foreign/reused relay caller')
        need(isinstance(request.get('token'),str)and 1<=len(request['token'])<=256 and re.fullmatch(r'[A-Za-z0-9_.:-]+',request['token']),'invalid relay lease token')
        return pid,stamp,direct
    def inventory(self, mid, address):
        directory=Path(self.auth['inventory_directory']);physical(directory,True)
        owner_path=directory/'owner';physical(owner_path)
        need(owner_path.stat().st_size<=MAX_CONTROL,'oversized publisher owner')
        pairs=[line.split('=',1)for line in owner_path.read_text().splitlines()];owner=dict(pairs)
        need(len(owner)==len(pairs)and owner==self.auth['inventory_owner']and owner.get('app')==self.auth['app'],'foreign relay inventory owner')
        for p,b in [('pid','pid_start'),('parent_pid','parent_start')]:
            need(birth(int(owner[p]))==owner[b],'retired relay inventory publisher')
        target=os.readlink(directory/'inventory/current');need(re.fullmatch(r'[.]generation-[A-Za-z0-9._-]+',target),'unsafe relay inventory generation')
        generation=directory/'inventory'/target;physical(generation,True);health=generation/'health';physical(health)
        need(health.stat().st_size<=MAX_CONTROL,'oversized publisher health')
        hp=[line.split('=',1)for line in health.read_text().splitlines()];h=dict(hp)
        need(len(h)==len(hp),'duplicate publisher health fields')
        need(h.get('publisher_token')==owner['token']and h.get('generation')==target and float(h['valid_until'])>=time.time(),'stale relay inventory')
        record=generation/'machines'/mid;physical(record)
        need(record.stat().st_size<=MAX_CONTROL,'oversized native index record')
        fp=[line.split('=',1)for line in record.read_text().splitlines()];fields=dict(fp)
        need(len(fields)==len(fp),'duplicate native index fields')
        need(fields.get('private_ip')==address and fields.get('instance_id'),'foreign relay Machine/IP binding')
        need(os.readlink(directory/'inventory/current')==target,'relay inventory changed during admission')
        return fields['instance_id']
    def agent_current(self):
        info=physical(self.auth['agent_socket'],sock=True)
        need(self.agent and(info.st_dev,info.st_ino)==tuple(self.agent['socket_identity'])and birth(self.agent['pid'])==self.agent['birth'],'relay Fly agent identity changed')
    async def start_agent(self):
        self.parent_live();info=physical(self.auth['agent_socket'],sock=True)
        async with asyncio.timeout(IO_TIMEOUT):
            reader,writer=await asyncio.open_unix_connection(self.auth['agent_socket'],limit=BUFFER)
            try:
                await frame_write(writer,b'ping');raw=await frame_read(reader)
                need(raw.startswith(b'ok '),'invalid Fly agent PING response');ping=json.loads(raw[3:])
                need(str(ping.get('Version','')).removeprefix('v')==VERSION,'unsupported Fly agent version')
                pid=ping.get('PID');need(type(pid)is int and pid>1,'invalid Fly agent PID')
                peer,uid,_=struct.unpack('3i',writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                need(peer==pid and uid==os.getuid(),'Fly agent PING peer differs')
                stamp=birth(pid)
                need(stamp and Path('/proc',str(pid)).stat().st_uid==os.getuid(),'foreign Fly agent process')
                self.agent=dict(pid=pid,birth=stamp,version=VERSION,socket_identity=[info.st_dev,info.st_ino]);self.agent_current()
            finally:await closed(writer)
    async def dial(self, route):
        self.agent_current()
        async with asyncio.timeout(IO_TIMEOUT):
            reader,writer=await asyncio.open_unix_connection(self.auth['agent_socket'],limit=BUFFER)
            try:
                payload=f"connect {self.auth['org_slug']} [{route['remote_ip']}]:{route['remote_port']} 10000 {self.auth['network']}".encode()
                await frame_write(writer,payload);reply=await frame_read(reader)
                need(reply==b'ok','Fly agent CONNECT refused')
                writer.transport.set_write_buffer_limits(high=BUFFER,low=BUFFER//4)
                return reader,writer
            except BaseException:
                await closed(writer);raise
    async def stream(self, lease, reader, writer):
        route=self.routes.get(lease);task=asyncio.current_task()
        if not route or route['record']['state']!='active':await closed(writer);return
        route['tasks'].add(task)
        remote=None
        try:
            record=route['record'];need(birth(record['owner_pid'])==record['owner_start'],'relay listener owner retired')
            writer.transport.set_write_buffer_limits(high=BUFFER,low=BUFFER//4)
            remote_reader,remote=await self.dial(record)
            async def pump(source,destination):
                while True:
                    chunk=await source.read(BUFFER)
                    if not chunk:
                        if destination.can_write_eof():destination.write_eof();await destination.drain()
                        return
                    destination.write(chunk);await destination.drain()
            tasks=[asyncio.create_task(pump(reader,remote)),asyncio.create_task(pump(remote_reader,writer))]
            try:await asyncio.gather(*tasks)
            finally:
                for p in tasks:p.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
        except (OSError,Refusal,asyncio.IncompleteReadError,TimeoutError):pass
        finally:
            if remote:await closed(remote)
            await closed(writer);route['tasks'].discard(task)
    async def acquire(self, request, peer):
        self.parent_live();pid,stamp,_=self.requester(request,peer)
        need(time.monotonic()<self.auth['deadline'],'original campaign admission deadline exhausted')
        mid=request.get('mid');ip=request.get('remote_ip');remote=request.get('remote_port');local=request.get('local_port')
        need(isinstance(mid,str)and re.fullmatch('[0-9a-f]{14}',mid),'invalid relay Machine ID')
        try:address=ipaddress.IPv6Address(ip)
        except (ValueError,TypeError):raise Refusal('relay target is not a private IPv6 address')
        need(not address.is_loopback and not address.is_unspecified and address.is_private,'invalid private relay target')
        need(type(remote)is int and remote in self.auth['allowed_remote_ports'],'unauthorized relay remote port')
        need(type(local)is int and 0<=local<=65535,'invalid relay local port')
        instance=self.inventory(mid,ip);self.agent_current()
        fields=dict(owner_pid=pid,owner_start=stamp,token=request['token'],mid=mid,instance_id=instance,remote_ip=ip,remote_port=remote,local_port=local)
        if local in self.ports:
            old=self.routes[self.ports[local]]['record']
            if not all(old[k]==v for k,v in fields.items()):raise Collision('relay local port already owned')
            await self.routes[self.ports[local]]['ready'].wait()
            need(old['state']=='active','relay route admission failed')
            return self.grant(old)
        lease=uuid.uuid4().hex
        try:server=await asyncio.start_server(lambda r,w:self.stream(lease,r,w),'127.0.0.1',local,limit=BUFFER,start_serving=False)
        except OSError as exc:
            if exc.errno==98:raise Collision('relay local bind collision')
            raise
        port=server.sockets[0].getsockname()[1];record=dict(fields,local_port=port,lease=lease,state='active',authority_sha256=self.digest)
        record['state']='preparing'
        lock=asyncio.Lock();await lock.acquire()
        self.routes[lease]=dict(record=record,server=server,tasks=set(),ready=asyncio.Event(),lock=lock);self.ports[port]=lease
        try:
            record['state']='active'
            await asyncio.to_thread(save,self.directory/'leases'/(lease+'.json'),dict(record))
            self.parent_live()
            need(time.monotonic()<self.auth['deadline'],'original campaign admission deadline exhausted')
            await server.start_serving()
            await asyncio.to_thread(save,self.directory/'leases'/(lease+'.live'),self.live(record).encode())
            self.routes[lease]['ready'].set()
        except BaseException:
            record['state']='failed';self.routes[lease]['ready'].set()
            server.close()
            tasks=list(self.routes[lease]['tasks'])
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            await server.wait_closed();self.ports.pop(port,None)
            (self.directory/'leases'/(lease+'.live')).unlink(missing_ok=True)
            raise
        finally:lock.release()
        return self.grant(record)
    def live(self, record):
        return f"{record['owner_pid']}|{record['owner_start']}|{record['token']}|{record['lease']}\n"
    def grant(self, record):
        return dict(lease=record['lease'],local_port=record['local_port'],live_path=str(self.directory/'leases'/(record['lease']+'.live')),live_value=self.live(record).rstrip('\n'))
    async def route_action(self, request, peer):
        pid,stamp,_=self.requester(request,peer,closing=True)
        lease=request.get('lease');need(isinstance(lease,str)and re.fullmatch('[0-9a-f]{32}',lease),'invalid relay lease')
        route=self.routes.get(lease);need(route,'unknown relay lease');record=route['record']
        need((record['owner_pid'],record['owner_start'],record['token'])==(pid,stamp,request['token']),'foreign relay lease owner')
        async with route['lock']:
            if request['op']=='check':
                need(record['state']=='active','relay lease not active');self.agent_current();return dict(lease=lease,active=True,local_port=record['local_port'])
            await self.retire(route,'closed')
            return dict(lease=lease,released=True)
    async def retire(self, route, terminal):
        record=route['record']
        if record['state'] in ('closed','abandoned'):return
        (self.directory/'leases'/(record['lease']+'.live')).unlink(missing_ok=True)
        record['state']='closing';await asyncio.to_thread(save,self.directory/'leases'/(record['lease']+'.json'),dict(record),True)
        route['server'].close()
        pending=list(route['tasks'])
        for task in pending:task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        await route['server'].wait_closed()
        record['state']=terminal;await asyncio.to_thread(save,self.directory/'leases'/(record['lease']+'.json'),dict(record),True)
        self.ports.pop(record['local_port'],None)
    async def parent_watch(self):
        while birth(self.auth['parent_pid'])==self.auth['parent_start']:
            await asyncio.sleep(1)
        # Parent retirement closes admission, never interrupts surviving cleanup.
        # Only this cold orphan path walks leases; normal admission stays keyed.
        while True:
            pending=False
            for route in list(self.routes.values()):
                record=route['record']
                if record['state'] in ('closed','abandoned'):continue
                try:alive=birth(record['owner_pid'])==record['owner_start']
                except (OSError,ValueError,IndexError):pending=True;continue
                if alive:pending=True;continue
                async with route['lock']:await self.retire(route,'abandoned')
            if not pending:self.stop.set();return
            await asyncio.sleep(1)
    async def control(self, reader, writer):
        try:
            async with asyncio.timeout(20):
                sock=writer.get_extra_info('socket');pid,uid,_=struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                need(uid==os.getuid(),'foreign relay control UID')
                request=json.loads(await frame_read(reader,4));need(isinstance(request,dict),'invalid relay control')
                op=request.get('op')
                if op=='acquire':result=await self.acquire(request,pid)
                elif op in ('check','release'):result=await self.route_action(request,pid)
                elif op=='shutdown':
                    owner,stamp,direct=self.requester(request,pid)
                    need(direct and owner==self.auth['parent_pid']and stamp==self.auth['parent_start'],'only campaign parent stops relay')
                    for route in list(self.routes.values()):
                        record=route['record']
                        if record['state'] not in ('closed','abandoned'):
                            need(birth(record['owner_pid'])!=record['owner_start'],'relay routes still owned')
                            async with route['lock']:await self.retire(route,'abandoned')
                    result=dict(stopped=True)
                else:raise Refusal('unknown relay control operation')
                await frame_write(writer,json.dumps(dict(ok=True,result=result)).encode(),4)
                if op=='shutdown':self.stop.set()
        except Exception as exc:
            try:await frame_write(writer,json.dumps(dict(ok=False,code=98 if isinstance(exc,Collision)else 1,error=str(exc)if isinstance(exc,Refusal)else type(exc).__name__)).encode(),4)
            except (OSError,RuntimeError):pass
        finally:await closed(writer)
    async def serve(self):
        self.directory.mkdir(mode=0o700,parents=True,exist_ok=True);physical(self.directory,True)
        await self.start_agent()
        await asyncio.to_thread(save,self.directory/'serve.once.json',dict(pid=os.getpid(),birth=birth(os.getpid()),authority_sha256=self.digest))
        soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft<hard:resource.setrlimit(resource.RLIMIT_NOFILE,(hard,hard))
        path=self.directory/'control.sock';need(not path.exists()and not path.is_symlink(),'relay control socket already exists')
        server=await asyncio.start_unix_server(self.control,path=path,limit=MAX_CONTROL)
        os.chmod(path,0o600)
        await asyncio.to_thread(save,self.directory/'ready.json',dict(pid=os.getpid(),birth=birth(os.getpid()),authority_sha256=self.digest,agent=self.agent,socket=str(path),fd_limit=resource.getrlimit(resource.RLIMIT_NOFILE)[0]))
        watch=asyncio.create_task(self.parent_watch())
        try:
            await self.stop.wait()
        finally:
            watch.cancel();await asyncio.gather(watch,return_exceptions=True)
            server.close();await server.wait_closed()
            for route in self.routes.values():
                route['server'].close()
                for task in list(route['tasks']):task.cancel()
            pending=[task for route in self.routes.values()for task in route['tasks']]
            await asyncio.gather(*pending,return_exceptions=True)
            path.unlink(missing_ok=True)

async def client(args, auth, digest):
    physical(args.directory,True);ready,_=private_json(args.directory/'ready.json')
    need(ready['authority_sha256']==digest and birth(ready['pid'])==ready['birth'],'relay broker identity changed')
    request=dict(op=args.action,authority_sha256=digest,owner_pid=args.owner_pid,owner_start=args.owner_start,token=args.token)
    if args.action=='acquire':request.update(mid=args.mid,remote_ip=args.remote_ip,remote_port=args.remote_port,local_port=args.local_port)
    if args.action in('check','release'):request['lease']=args.lease
    physical(args.directory/'control.sock',sock=True)
    async with asyncio.timeout(25):
        reader,writer=await asyncio.open_unix_connection(args.directory/'control.sock',limit=MAX_CONTROL)
        try:
            peer,uid,_=struct.unpack('3i',writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            need(peer==ready['pid']and uid==os.getuid(),'foreign relay broker peer')
            await frame_write(writer,json.dumps(request).encode(),4);reply=json.loads(await frame_read(reader,4))
        finally:await closed(writer)
    if not reply.get('ok'):
        print(reply.get('error','relay refusal'),file=sys.stderr);return 98 if reply.get('code')==98 else 1
    print(json.dumps(reply['result'],sort_keys=True));return 0

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['serve','acquire','check','release','shutdown']);p.add_argument('--authority',type=Path,required=True);p.add_argument('--directory',type=Path,required=True)
    p.add_argument('--owner-pid',type=int);p.add_argument('--owner-start');p.add_argument('--token');p.add_argument('--mid');p.add_argument('--remote-ip');p.add_argument('--remote-port',type=int);p.add_argument('--local-port',type=int);p.add_argument('--lease')
    args=p.parse_args();value,digest=authority(args.authority)
    return asyncio.run(Broker(value,digest,args.directory).serve())if args.action=='serve'else asyncio.run(client(args,value,digest))

if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError,TimeoutError,asyncio.IncompleteReadError)as exc:
        print(str(exc)if isinstance(exc,Refusal)else type(exc).__name__,file=sys.stderr);raise SystemExit(1)
