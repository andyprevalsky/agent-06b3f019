#!/usr/bin/env python3
"""Actual shared broker with a local pinned-protocol Unix agent; no provider calls."""
import hashlib
import json
import os
import resource
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from test_quarantine import quarantine

ROOT=Path(__file__).resolve().parents[2]


def receive_exact(stream,count):
    result=bytearray()
    while len(result)<count:
        block=stream.recv(count-len(result))
        if not block:raise EOFError('short pinned-agent frame')
        result.extend(block)
    return bytes(result)


def frame(data):
    return struct.pack('<H',len(data))+data


class FakeUnixAgent:
    """Fly v0.4.115 framing. Payload behavior tests the broker, not WireGuard.

    In particular the delayed half-close response mode is a broker capability
    test; the pinned real agent closes both directions after copy EOF.
    """
    def __init__(self,directory,path=None):
        self.path=Path(path)if path else Path(directory)/'fake-agent.sock'
        self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.listener.bind(str(self.path));self.path.chmod(0o600);self.listener.listen(128);self.listener.settimeout(.1)
        self.stop=threading.Event();self.release=threading.Event()
        self.requests=[];self.errors=[];self.connections=[];self.threads=[]
        self.mode='echo';self.prefix=b'';self.lock=threading.Lock()
        self.acceptor=threading.Thread(target=self.accept,daemon=True);self.acceptor.start()

    def accept(self):
        while not self.stop.is_set():
            try:connection,_=self.listener.accept()
            except socket.timeout:continue
            except OSError:return
            self.connections.append(connection)
            thread=threading.Thread(target=self.serve,args=(connection,),daemon=True)
            self.threads.append(thread);thread.start()

    def serve(self,connection):
        try:
            connection.settimeout(8)
            length=struct.unpack('<H',receive_exact(connection,2))[0]
            command=receive_exact(connection,length).decode()
            if command=='ping':
                connection.sendall(frame(b'ok '+json.dumps(dict(Version='0.4.115',PID=os.getpid(),Background=True,TokenMode=False)).encode()));return
            fields=command.split(' ')
            if len(fields)!=5 or fields[0]!='connect' or not fields[3].isdigit():
                raise AssertionError('unexpected actual agent request: '+repr(command))
            with self.lock:self.requests.append(fields)
            if self.mode=='error':
                connection.sendall(frame(b'err fixture dial rejected'));return
            if self.mode=='stall-handshake':
                self.release.wait(5);return
            # Fragment the reply header and merge raw payload with the last
            # fragment to catch short-read and handshake over-read corruption.
            reply=frame(b'ok')
            connection.sendall(reply[:1]);connection.sendall(reply[1:]+self.prefix)
            if self.mode=='http':
                request=bytearray()
                while b'\r\n\r\n'not in request:
                    part=connection.recv(4096)
                    if not part:break
                    request.extend(part)
                if fields[2].endswith(':8011'):
                    connection.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                else:
                    connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
                connection.shutdown(socket.SHUT_WR);return
            if self.mode=='backpressure':self.release.wait(5)
            if self.mode=='half-close':
                data=bytearray()
                while True:
                    part=connection.recv(65536)
                    if not part:break
                    data.extend(part)
                connection.sendall(b'after-fin:'+bytes(data));connection.shutdown(socket.SHUT_WR);return
            while True:
                data=connection.recv(16384)
                if not data:
                    connection.shutdown(socket.SHUT_WR);return
                connection.sendall(data)
        except (ConnectionResetError,BrokenPipeError):
            pass  # Expected when a keyed lease is removed or handshake rejects.
        except Exception as error:
            if not self.stop.is_set():self.errors.append(repr(error))
        finally:
            connection.close()

    def close(self):
        self.stop.set();self.release.set();self.listener.close()
        for connection in self.connections:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        self.acceptor.join(timeout=2)
        for thread in self.threads:thread.join(timeout=2)


def kernel_socket_buffer_capacity():
    """Upper bound of bytes one TCP hop plus one Unix hop can hold in kernel buffers on this host."""
    def maximum(name):
        try:return int(Path('/proc/sys/net',name).read_text().split()[-1])
        except (OSError,ValueError):return 0
    return (maximum('ipv4/tcp_wmem')+maximum('ipv4/tcp_rmem')
            +maximum('core/wmem_max')+maximum('core/rmem_max'))


def birth(pid):
    return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[19]


def descendants(pid):
    """Targeted process tree observation: a few real broker processes only."""
    found=set();pending=[pid]
    while pending:
        current=pending.pop()
        try:children=Path('/proc',str(current),'task',str(current),'children').read_text().split()
        except FileNotFoundError:continue
        for child in map(int,children):
            if child not in found:found.add(child);pending.append(child)
    return found

# Production broker CLI and the integration entry are wired after the author
# supplies their agreed interface. No substitute relay is implemented here.


BROKER=Path(os.environ.get('CLOUDBENCH_TEST_SHARED_RELAY_SOURCE',str(ROOT/'scripts/cloudbench-shared-relay.py')))


class RelayFixture:
    def __init__(self,case,retiring_parent=False,start_broker=True,soft_fd_limit=None):
        self.case=case
        self.tmp=tempfile.TemporaryDirectory(prefix='shared-relay-')
        case.addCleanup(self.close)
        self.root=Path(self.tmp.name);self.root.chmod(0o700)
        self.agent=FakeUnixAgent(self.root)
        self.directory=self.root/'broker';self.directory.mkdir(mode=0o700)
        self.feed=self.root/'feed';self.feed.mkdir(mode=0o700)
        self.index=self.feed/'inventory'
        self.mid='abcd1234abcd12';self.ip='fd00::1234'
        self.inventory_owner=dict(app='fixture',pid=str(os.getpid()),pid_start=birth(os.getpid()),token='a'*32,parent_pid=str(os.getpid()),parent_start=birth(os.getpid()))
        (self.feed/'owner').write_text(''.join(k+'='+str(v)+'\n'for k,v in self.inventory_owner.items()));(self.feed/'owner').chmod(0o600)
        machines=self.root/'machines.json';volumes=self.root/'volumes.json'
        machines.write_text(json.dumps([dict(id=self.mid,name='cloudbench-fixture',state='started',instance_id='fixture-instance',private_ip=self.ip,config=dict(mounts=[],init=dict(cmd=['sleep','infinity']))) ]))
        volumes.write_text('[]')
        # Use the unchanged real publisher rather than fabricate health records.
        result=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-machine-readiness.py'),'--publish-index',str(machines),str(volumes),str(self.index)],env=dict(os.environ,CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN=self.inventory_owner['token']),capture_output=True,text=True,timeout=5)
        case.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.owners=[];self.leases=[];self.broker=None
        self.parent_owner=self.owner()if retiring_parent else None
        parent_pid=self.parent_owner.pid if self.parent_owner else os.getpid()
        self.authority=self.root/'authority.json'
        self.authority_value=dict(schema='shared-relay-authority-v1',app='fixture',org_slug='fixture-org',network='default',parent_pid=parent_pid,parent_start=birth(parent_pid),source_sha256=hashlib.sha256(BROKER.read_bytes()).hexdigest(),agent_socket=str(self.agent.path),inventory_directory=str(self.feed),inventory_owner=self.inventory_owner,allowed_remote_ports=[8011,3001,3003],deadline=time.monotonic()+120)
        self.authority.write_text(json.dumps(self.authority_value));self.authority.chmod(0o600)
        if not start_broker:return
        self.log=(self.root/'broker.log').open('wb')
        self.native_fd_hard=resource.getrlimit(resource.RLIMIT_NOFILE)[1]
        def set_child_fd_limit():resource.setrlimit(resource.RLIMIT_NOFILE,(soft_fd_limit,self.native_fd_hard))
        self.broker=subprocess.Popen([sys.executable,str(BROKER),'serve','--authority',str(self.authority),'--directory',str(self.directory)],stdout=self.log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=set_child_fd_limit if soft_fd_limit is not None else None)
        end=time.monotonic()+4
        while time.monotonic()<end:
            sockets=[p for p in self.directory.iterdir()if __import__('stat').S_ISSOCK(p.lstat().st_mode)]
            if sockets and (self.directory/'ready.json').exists():break
            if self.broker.poll()is not None:break
            time.sleep(.01)
        case.assertIsNone(self.broker.poll(),(self.root/'broker.log').read_text())
        case.assertTrue(sockets,'production broker did not create its control socket')

    def owner(self):
        worker='import json,subprocess,sys\nfor line in sys.stdin:\n request=json.loads(line); p=subprocess.run(request,capture_output=True,text=True);print(json.dumps(dict(returncode=p.returncode,stdout=p.stdout,stderr=p.stderr)),flush=True)\n'
        process=subprocess.Popen([sys.executable,'-u','-c',worker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.owners.append(process)
        return process

    def call(self,action,owner,token,extra=()):
        argv=[sys.executable,str(BROKER),action,'--authority',str(self.authority),'--directory',str(self.directory),'--owner-pid',str(owner.pid),'--owner-start',birth(owner.pid),'--token',token,*map(str,extra)]
        if owner in self.owners:
            import select
            owner.stdin.write(json.dumps(argv)+'\n');owner.stdin.flush()
            if not select.select([owner.stdout],[],[],6)[0]:raise TimeoutError('local owning CLI child did not return')
            value=json.loads(owner.stdout.readline())
            return subprocess.CompletedProcess(argv,value['returncode'],value['stdout'],value['stderr'])
        return subprocess.run(argv,capture_output=True,text=True,timeout=5)

    def acquire(self,owner,token,remote=8011,local=0,ip=None):
        if local==0:
            with socket.socket(socket.AF_INET,socket.SOCK_STREAM)as probe:
                probe.bind(('127.0.0.1',0));local=probe.getsockname()[1]
        result=self.call('acquire',owner,token,['--mid',self.mid,'--remote-ip',ip or self.ip,'--remote-port',remote,'--local-port',local])
        self.case.assertEqual(result.returncode,0,result.stdout+result.stderr)
        lease=json.loads(result.stdout)
        self.leases.append((owner,token,lease))
        return lease

    def connect(self,lease):
        return socket.create_connection(('127.0.0.1',lease['local_port']),timeout=4)

    def release(self,owner,token,lease):
        result=self.call('release',owner,token,['--lease',lease['lease']])
        self.case.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.leases=[item for item in self.leases if item[2]['lease']!=lease['lease']]

    def close(self):
        for owner,token,lease in list(getattr(self,'leases',[])):
            try:self.call('release',owner,token,['--lease',lease['lease']])
            except (OSError,subprocess.TimeoutExpired,FileNotFoundError):pass
        for process in getattr(self,'owners',[]):
            if process.poll()is None and process.pid>1:os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=2)
            for stream in (process.stdin,process.stdout,process.stderr):
                if stream:stream.close()
        process=getattr(self,'broker',None)
        if process and process.poll()is None:
            from types import SimpleNamespace
            try:self.call('shutdown',SimpleNamespace(pid=os.getpid()),'f'*32)
            except (OSError,subprocess.TimeoutExpired):pass
            try:process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if process.pid>1:os.killpg(process.pid,signal.SIGKILL)
                process.wait(timeout=2)
        if hasattr(self,'log'):self.log.close()
        if hasattr(self,'agent'):self.agent.close()
        self.tmp.cleanup()


class SharedRelay(unittest.TestCase):
    def test_actual_pinned_framing_preserves_fragmented_reply_and_raw_bytes(self):
        f=RelayFixture(self);owner=f.owner();f.agent.prefix=b'\x00preface\xff'
        lease=f.acquire(owner,'1'*32)
        with f.connect(lease)as client:
            self.assertEqual(receive_exact(client,len(f.agent.prefix)),f.agent.prefix)
            payload=bytes(range(256))*128
            client.sendall(payload);self.assertEqual(receive_exact(client,len(payload)),payload)
        self.assertEqual(f.agent.requests[-1][:3],['connect','fixture-org','[fd00::1234]:8011'])
        self.assertTrue(f.agent.requests[-1][3].isdigit())
        self.assertEqual(f.agent.requests[-1][4],'default')
        self.assertFalse(f.agent.errors)

    def test_broker_half_close_can_drain_delayed_fixture_response(self):
        f=RelayFixture(self);owner=f.owner();f.agent.mode='half-close'
        lease=f.acquire(owner,'2'*32)
        with f.connect(lease)as client:
            payload=b'request-before-fin'*1024
            client.sendall(payload);client.shutdown(socket.SHUT_WR)
            response=bytearray()
            while True:
                block=client.recv(65536)
                if not block:break
                response.extend(block)
        self.assertEqual(response,b'after-fin:'+payload)
        self.assertFalse(f.agent.errors)
        # Deliberately a broker-only capability, not a claim about real agent EOF.

    def test_keyed_owner_collision_and_release_do_not_touch_another_route(self):
        f=RelayFixture(self);owner=f.owner();foreign=f.owner();lease=f.acquire(owner,'3'*32)
        for action in ('check','release'):
            result=f.call(action,foreign,'4'*32,['--lease',lease['lease']])
            self.assertNotEqual(result.returncode,0)
        result=f.call('acquire',foreign,'5'*32,['--mid',f.mid,'--remote-ip',f.ip,'--remote-port',8011,'--local-port',lease['local_port']])
        self.assertEqual(result.returncode,98,result.stdout+result.stderr)
        with f.connect(lease)as client:
            client.sendall(b'still-owned');self.assertEqual(receive_exact(client,11),b'still-owned')
        f.release(owner,'3'*32,lease)
        self.assertIsNone(f.broker.poll(),'route cleanup terminated the shared broker')
        replacement=f.acquire(foreign,'6'*32,local=lease['local_port'])
        with f.connect(replacement)as client:
            client.sendall(b'reclaimed');self.assertEqual(receive_exact(client,9),b'reclaimed')

    def test_native_ip_and_stale_inventory_refuse_before_agent_connect(self):
        f=RelayFixture(self);owner=f.owner()
        with socket.socket()as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        result=f.call('acquire',owner,'7'*32,['--mid',f.mid,'--remote-ip','fd00::ffff','--remote-port',8011,'--local-port',port])
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(f.agent.requests,[])
        health=f.index/'current/health'
        text=health.read_text();health.write_text(__import__('re').sub(r'valid_until=[0-9]+','valid_until=1',text))
        result=f.call('acquire',owner,'8'*32,['--mid',f.mid,'--remote-ip',f.ip,'--remote-port',8011,'--local-port',port])
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(f.agent.requests,[])

    def test_agent_connect_failure_isolated_and_following_connection_recovers(self):
        f=RelayFixture(self);owner=f.owner();lease=f.acquire(owner,'9'*32)
        f.agent.mode='error'
        with f.connect(lease)as client:
            client.sendall(b'probe')
            try:response=client.recv(1024)
            except ConnectionResetError:response=b''
            self.assertEqual(response,b'','agent control error leaked into application stream')
        self.assertIsNone(f.broker.poll())
        f.agent.mode='echo'
        with f.connect(lease)as client:
            client.sendall(b'recovered');self.assertEqual(receive_exact(client,9),b'recovered')

    def test_many_ports_use_one_constant_process_and_release_all_listeners(self):
        f=RelayFixture(self,soft_fd_limit=1024);owner=f.owner()
        ready=json.loads((f.directory/'ready.json').read_bytes())
        self.assertGreater(ready['fd_limit'],1800)
        self.assertEqual(ready['fd_limit'],f.native_fd_hard)
        print('broker child soft FD limit 1024 restored to native hard',ready['fd_limit'],flush=True)
        baseline_children=descendants(f.broker.pid)
        baseline_threads=len(list(Path('/proc',str(f.broker.pid),'task').iterdir()))
        leases=[f.acquire(owner,format(index+100,'032x'),remote=(8011,3001,3003)[index%3])for index in range(64)]
        self.assertEqual(descendants(f.broker.pid),baseline_children,'one persistent process was created per route')
        self.assertLessEqual(len(list(Path('/proc',str(f.broker.pid),'task').iterdir())),baseline_threads+1,'one persistent thread was created per route')
        for lease in (leases[0],leases[31],leases[-1]):
            with f.connect(lease)as client:
                client.sendall(b'live');self.assertEqual(receive_exact(client,4),b'live')
        for owner,token,lease in list(f.leases):f.release(owner,token,lease)
        self.assertIsNone(f.broker.poll())
        for lease in leases:
            with self.assertRaises(OSError):socket.create_connection(('127.0.0.1',lease['local_port']),timeout=.2)
        print('shared broker: 64 listeners; descendant processes',len(baseline_children),'->',len(descendants(f.broker.pid)),flush=True)

    @quarantine(
        since='2026-11-11',
        repair='pending-handoff:3b413cb2a8a142df96b47f59afbcb9ee',
        error='TimeoutError: timed out',
        evidence='PR #1931 deploy-command-structural FLAKY occurrence 3b413cb2a8a142df96b47f59afbcb9ee',
    )
    def test_backpressure_bounds_memory_and_keeps_control_responsive(self):
        f=RelayFixture(self);owner=f.owner();lease=f.acquire(owner,'a'*32);f.agent.mode='backpressure'
        client=f.connect(lease);client.settimeout(8)
        # The kernel's own socket buffers on the client->broker and broker->agent hops can hold a
        # payload without any relay buffering (Blacksmith VMs tune tcp_[rw]mem far above 16 MiB), so
        # send more than those hops can absorb; the relay's RSS bound below is unchanged.
        payload=b'x'*(16*1024*1024+2*kernel_socket_buffer_capacity());finished=threading.Event();errors=[]
        def sender():
            try:client.sendall(payload)
            except OSError as error:errors.append(error)
            finally:finished.set()
        def rss():
            text=Path('/proc',str(f.broker.pid),'status').read_text()
            return int(next(line.split()[1]for line in text.splitlines()if line.startswith('VmRSS:')))*1024
        baseline=rss();thread=threading.Thread(target=sender,daemon=True);thread.start()
        try:
            time.sleep(.2)
            self.assertFalse(finished.is_set(),'relay consumed an unbounded blocked upstream stream')
            self.assertLess(rss()-baseline,8*1024*1024,'broker buffered the full blocked payload')
            start=time.monotonic();result=f.call('check',owner,'a'*32,['--lease',lease['lease']])
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertLess(time.monotonic()-start,2,'blocked stream stalled broker control')
            f.agent.release.set()
            response=bytearray()
            while len(response)<len(payload):
                block=client.recv(65536)
                if not block:break
                response.extend(block)
            thread.join(timeout=3)
            self.assertFalse(errors)
            self.assertEqual(len(response),len(payload))
            self.assertEqual(hashlib.sha256(response).digest(),hashlib.sha256(payload).digest())
        finally:
            f.agent.release.set();client.close();thread.join(timeout=2)


    def test_parent_death_retires_broker_and_listener_without_foreign_signals(self):
        f=RelayFixture(self,retiring_parent=True)
        owner=f.parent_owner;lease=f.acquire(owner,'b'*32)
        with f.connect(lease)as client:
            client.sendall(b'owned');self.assertEqual(receive_exact(client,5),b'owned')
            os.killpg(owner.pid,signal.SIGKILL);owner.wait(timeout=2)
            end=time.monotonic()+3
            while f.broker.poll()is None and time.monotonic()<end:time.sleep(.02)
            self.assertIsNotNone(f.broker.poll(),'dead campaign parent left a persistent broker behind')
            try:response=client.recv(1024)
            except ConnectionResetError:response=b''
            self.assertEqual(response,b'')
        with self.assertRaises(OSError):socket.create_connection(('127.0.0.1',lease['local_port']),timeout=.2)
        self.assertTrue(Path('/proc',str(os.getpid())).exists())



    def test_explicit_release_aborts_stalled_stream_and_removes_live_marker(self):
        f=RelayFixture(self);owner=f.owner();f.agent.mode='backpressure'
        lease=f.acquire(owner,'c'*32)
        marker=Path(lease['live_path'])
        self.assertEqual(marker.read_text().rstrip('\n'),lease['live_value'])
        self.assertEqual(__import__('stat').S_IMODE(marker.stat().st_mode),0o600)
        client=f.connect(lease);client.settimeout(5)
        finished=threading.Event()
        def sender():
            # More than the host's kernel socket buffers can absorb (see the backpressure test).
            try:client.sendall(b'x'*(16*1024*1024+2*kernel_socket_buffer_capacity()))
            except OSError:pass  # Explicit route release may interrupt delivery.
            finally:finished.set()
        thread=threading.Thread(target=sender,daemon=True);thread.start()
        try:
            time.sleep(.15)
            self.assertFalse(finished.is_set(),'fixture did not create a blocked application stream')
            start=time.monotonic();f.release(owner,'c'*32,lease)
            self.assertLess(time.monotonic()-start,3,'nonreading upstream stalled explicit route cleanup')
            self.assertFalse(marker.exists())
            self.assertIsNone(f.broker.poll())
            receipt=json.loads((f.directory/'leases'/(lease['lease']+'.json')).read_bytes())
            self.assertEqual(receipt['state'],'closed')
            thread.join(timeout=2)
            self.assertTrue(finished.is_set())
        finally:
            f.agent.release.set();client.close();thread.join(timeout=2)


class CallerIntegration(unittest.TestCase):
    def test_actual_three_roles_use_distinct_leases_and_cleanup_preserves_broker(self):
        f=RelayFixture(self);f.agent.mode='http'
        ports=[]
        for _ in range(3):
            with socket.socket()as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
        fleet=(ROOT/'scripts/run-bench-fleet').read_text()
        begin=fleet.index('    start_metrics_proxy() {')
        metrics=fleet[begin:fleet.index('\n    }\n',begin)+7]
        cloud=(ROOT/'scripts/run-bench-cloud').read_text()
        begin=cloud.index('start_data_plane_proxy() {')
        wrapper=cloud[begin:cloud.index('\n}\n',begin)+3]
        script=r'''set -euo pipefail
[ "${RELAY_TRACE:-0}" != 1 ] || set -x
source "$ENVLIB"
'''+wrapper+'\n'+metrics+r'''
mid="$MID";cid="$MID";pip="$REMOTE_IP";out="$CASE";BOX_HEALTH_PORT=3003
metrics_lease_owner_pid=$$;metrics_lease_token=metrics-fixture-token
status_pid="";backend_pid="";metrics_proxy_pid="";metrics_port="";metrics_url=""
release_autoscaler_metrics_owner(){ :; }
claim_autoscaler_metrics_port(){ printf -v "$1" '%s' "$METRICS_PORT"; }
start_data_plane_proxy "$STATUS_PORT" 8011 "$REMOTE_IP" "$CASE/status.log" status_pid status 3
start_data_plane_proxy "$BACKEND_PORT" 3001 "$REMOTE_IP" "$CASE/backend.log" backend_pid backend 3
start_metrics_proxy 3
[ -z "$status_pid$backend_pid$metrics_proxy_pid" ]
[ -n "$status_pid_LEASE" ] && [ -n "$backend_pid_LEASE" ] && [ -n "$metrics_proxy_pid_LEASE" ]
[ "$status_pid_LEASE" != "$backend_pid_LEASE" ] && [ "$status_pid_LEASE" != "$metrics_proxy_pid_LEASE" ] && [ "$backend_pid_LEASE" != "$metrics_proxy_pid_LEASE" ]
# All repeated probes must be Bash/native reads, never a Python/ps hot loop.
python3(){ echo forbidden-python >> "$CASE/hot-spawns";return 97; }
ps(){ echo forbidden-ps >> "$CASE/hot-spawns";return 97; }
for ((i=0;i<100;i++));do
 cloudbench_proxy_alive status_pid
 cloudbench_proxy_alive backend_pid
 cloudbench_proxy_alive metrics_proxy_pid
done
unset -f python3 ps
[ ! -e "$CASE/hot-spawns" ]
retired_backend_lease="$backend_pid_LEASE"
cloudbench_proxy_stop backend_pid
[ -z "$backend_pid_LEASE" ]
[ ! -e "$CLOUDBENCH_SHARED_RELAY_DIRECTORY/leases/$retired_backend_lease.live" ]
# Keep the exact old lease identity locally: absence of its producer marker,
# rather than merely clearing the shell variable, must make alive refuse.
backend_pid_LEASE="$retired_backend_lease"
python3(){ echo forbidden-python >> "$CASE/hot-spawns";return 97; }
ps(){ echo forbidden-ps >> "$CASE/hot-spawns";return 97; }
! cloudbench_proxy_alive backend_pid
unset -f python3 ps
backend_pid_LEASE=""
cloudbench_proxy_alive status_pid
cloudbench_proxy_alive metrics_proxy_pid
cloudbench_proxy_stop status_pid
cloudbench_proxy_stop metrics_proxy_pid
printf 'three roles released without a shared PID sentinel\n'
'''
        ready=json.loads((f.directory/'ready.json').read_bytes())
        env=dict(os.environ,CLOUDBENCH_SHARED_RELAY_PID=str(ready['pid']),CLOUDBENCH_SHARED_RELAY_BIRTH=ready['birth'],CLOUDBENCH_SHARED_RELAY_AGENT_PID=str(ready['agent']['pid']),CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH=ready['agent']['birth'],ENVLIB=str(ROOT/'scripts/lib/cloudbench-env.sh'),CASE=str(f.root),MID=f.mid,REMOTE_IP=f.ip,STATUS_PORT=str(ports[0]),BACKEND_PORT=str(ports[1]),METRICS_PORT=str(ports[2]),ROOT_DIR=str(ROOT),CLOUDBENCH_SCRIPT_SNAPSHOT=str(BROKER.parent),CLOUDBENCH_SHARED_RELAY_AUTHORITY=str(f.authority),CLOUDBENCH_SHARED_RELAY_DIRECTORY=str(f.directory),RUN_ID='fixture-run',RUN_LOG_TOKEN='fixture-token')
        result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('three roles released',result.stdout)
        self.assertFalse((f.root/'hot-spawns').exists())
        self.assertIsNone(f.broker.poll(),'one route cleanup signaled the shared owner')
        leases=[json.loads(path.read_bytes())for path in (f.directory/'leases').glob('*.json')]
        self.assertEqual(len(leases),3)
        self.assertEqual({lease['state']for lease in leases},{'closed'})
        self.assertEqual({lease['remote_port']for lease in leases},{8011,3001,3003})
        self.assertEqual(descendants(f.broker.pid),set())

    def test_unset_shared_mode_preserves_legacy_proxy_pid_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='legacy-relay-')as temporary:
            root=Path(temporary)
            env=dict(os.environ,ENVLIB=str(ROOT/'scripts/lib/cloudbench-env.sh'),CASE=str(root),CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS='0')
            for key in tuple(env):
                if key.startswith('CLOUDBENCH_SHARED_RELAY'):env.pop(key)
            script=r'''set -euo pipefail
[ "${RELAY_TRACE:-0}" != 1 ] || set -x
source "$ENVLIB"
APP=fixture
flyctl(){ printf '%s\n' "$*" > "$CASE/fly-args";exec sleep 30; }
curl(){ return 0; }
legacy_proxy_pid=""
cloudbench_start_data_plane_proxy 19001 3001 fd00::1234 "$CASE/proxy.log" legacy_proxy_pid backend 3
[ -n "$legacy_proxy_pid" ] && [ "$legacy_proxy_pid" -gt 1 ]
cloudbench_proxy_alive legacy_proxy_pid
cloudbench_proxy_stop legacy_proxy_pid
[ -z "$legacy_proxy_pid" ]
'''
            result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=10,start_new_session=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('proxy 19001:3001 fd00::1234',(root/'fly-args').read_text())


    def test_actual_campaign_parent_starts_one_bootstrap_and_joins_before_archive(self):
        import runpy,shutil
        from unittest.mock import patch
        from types import SimpleNamespace
        f=RelayFixture(self,start_broker=False)
        repo=f.root/'controller';(repo/'scripts/lib').mkdir(parents=True)
        for relative,source in [('scripts/cloudbench-shared-relay.py',BROKER),('scripts/cloudbench-cleanup-tickets.py',ROOT/'scripts/cloudbench-cleanup-tickets.py'),('scripts/lib/cloudbench-inventory.sh',ROOT/'scripts/lib/cloudbench-inventory.sh'),('scripts/run-bench-cloud',ROOT/'scripts/run-bench-cloud'),('scripts/run-bench-fleet',ROOT/'scripts/run-bench-fleet')]:
            shutil.copyfile(source,repo/relative)
        def git(*args):
            return subprocess.run(['git','-C',str(repo),*args],capture_output=True,text=True,check=True)
        git('init','-q');git('add','scripts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','exact local source fixture')
        bin_path=f.root/'bin';bin_path.mkdir()
        fake=bin_path/'flyctl'
        fake.write_text("""#!/usr/bin/env python3
import importlib.machinery,importlib.util,json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(os.environ['PARENT_RELAY_CASE'])
with (root/'fly-calls').open('a')as stream:stream.write(json.dumps(sys.argv[1:])+'\\n')
args=sys.argv[1:]
if args==['status','-a','fixture','--json']:
 print(json.dumps(dict(Name='fixture',Organization=dict(Slug='fixture-org'),Network='default')));raise SystemExit()
assert args==['proxy','0:1','::1','-a','fixture','--bind-addr','127.0.0.1','-q'],args
assert os.environ['FLY_AGENT_ISOLATED']=='1'
code="import importlib.machinery,importlib.util,os,sys;from pathlib import Path;l=importlib.machinery.SourceFileLoader('relay_fixture',os.environ['PARENT_RELAY_TEST']);s=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(s);l.exec_module(m);a=m.FakeUnixAgent(Path(os.environ['FLY_AGENT_SOCKET_PATH']).parent,path=os.environ['FLY_AGENT_SOCKET_PATH']);Path(os.environ['PARENT_RELAY_CASE'],'agent.pid').write_text(str(os.getpid()));sys.stdin.read();a.close();Path(os.environ['PARENT_RELAY_CASE'],'agent-eof-joined').write_text('true')"
agent=subprocess.Popen([sys.executable,'-u','-c',code],stdin=subprocess.PIPE)
signal.signal(signal.SIGTERM,lambda *args:sys.exit(0))
try:
 deadline=time.monotonic()+5
 while not Path(os.environ['FLY_AGENT_SOCKET_PATH']).is_socket():
  assert agent.poll()is None and time.monotonic()<deadline
  time.sleep(.01)
 print('Proxying localhost:fixture -> remote:1',flush=True)
 while True:time.sleep(.05)
finally:
 agent.stdin.close();agent.wait(timeout=3)
 (root/'bootstrap-agent-joined').write_text(str(agent.returncode))
""")
        fake.chmod(0o700)
        campaign=f.root/'campaign';campaign.mkdir()
        # A private HOME: the relay claims that HOME's single WireGuard peer.
        home=f.root/'home';home.mkdir(mode=0o700)
        module=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        environment=dict(os.environ,PATH=str(bin_path)+os.pathsep+os.environ['PATH'],HOME=str(home),FLY_BENCH_API_TOKEN='fixture-bench-token-over-twenty-characters',PARENT_RELAY_CASE=str(f.root),PARENT_RELAY_TEST=str(Path(__file__).resolve()))
        value=None
        try:
            with patch.dict(os.environ,environment,clear=True):
                value=module['start_shared_relay'](repo,campaign,repo,f.feed,time.monotonic()+15)
                f.directory=value['directory'];f.authority=value['authority'];f.broker=value['process']
                self.assertIsNone(value['bootstrap'].poll())
                self.assertIsNone(value['process'].poll())
                calls=[json.loads(line)for line in (f.root/'fly-calls').read_text().splitlines()]
                self.assertEqual(len(calls),2,calls)
                owner=f.owner();lease=f.acquire(owner,'d'*32)
                refusal=f.call('shutdown',SimpleNamespace(pid=os.getpid()),'campaign-shutdown')
                self.assertNotEqual(refusal.returncode,0,'parent stopped relay while a live child still owned a route')
                f.release(owner,'d'*32,lease)
                owner.stdin.close();owner.wait(timeout=2)
                self.assertTrue(module['stop_shared_relay'](value))
                self.assertIsNotNone(value['process'].poll())
                self.assertIsNotNone(value['bootstrap'].poll())
                self.assertEqual((f.root/'bootstrap-agent-joined').read_text(),'0')
                self.assertTrue((f.root/'agent-eof-joined').exists())
                self.assertTrue((campaign/'shared-relay/ready.json').exists())
                self.assertFalse(any(__import__('stat').S_ISSOCK(path.lstat().st_mode)for path in (campaign/'shared-relay').rglob('*')))
                old_count=len((f.root/'fly-calls').read_text().splitlines())
                with (repo/'scripts/cloudbench-shared-relay.py').open('a')as stream:stream.write('\n# fixture changed source\n')
                with self.assertRaisesRegex(ValueError,'reviewed controller'):
                    module['start_shared_relay'](repo,campaign,repo,f.feed,time.monotonic()+15)
                self.assertEqual(len((f.root/'fly-calls').read_text().splitlines()),old_count)
        finally:
            if value:
                for name in ('process','bootstrap'):
                    process=value[name]
                    if process.poll()is None:process.terminate();process.wait(timeout=4)
                for name in ('log','bootstrap_log'):
                    if not value[name].closed:value[name].close()


    def campaign_relay_fixture(self):
        """Real start_shared_relay against a fake flyctl that models v0.4.115 agent resolution."""
        import runpy,shutil
        f=RelayFixture(self,start_broker=False)
        repo=f.root/'controller';(repo/'scripts/lib').mkdir(parents=True)
        for relative,source in [('scripts/cloudbench-shared-relay.py',BROKER),('scripts/cloudbench-cleanup-tickets.py',ROOT/'scripts/cloudbench-cleanup-tickets.py'),('scripts/lib/cloudbench-inventory.sh',ROOT/'scripts/lib/cloudbench-inventory.sh'),('scripts/run-bench-cloud',ROOT/'scripts/run-bench-cloud'),('scripts/run-bench-fleet',ROOT/'scripts/run-bench-fleet')]:
            shutil.copyfile(source,repo/relative)
        def git(*args):
            return subprocess.run(['git','-C',str(repo),*args],capture_output=True,text=True,check=True)
        git('init','-q');git('add','scripts');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','exact local source fixture')
        bin_path=f.root/'bin';bin_path.mkdir();home=f.root/'home';home.mkdir(mode=0o700)
        fake=bin_path/'flyctl'
        fake.write_text("""#!/usr/bin/env python3
import json,os,signal,socket,struct,subprocess,sys,time
from pathlib import Path
root=Path(os.environ['PARENT_RELAY_CASE'])
args=sys.argv[1:]
agent_code="import importlib.machinery,importlib.util,os,sys,time;from pathlib import Path;l=importlib.machinery.SourceFileLoader('relay_fixture',os.environ['PARENT_RELAY_TEST']);s=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(s);l.exec_module(m);p=Path(sys.argv[1]);a=m.FakeUnixAgent(p.parent,path=p);mode=sys.argv[2]\\nif mode=='bootstrap':sys.stdin.read();a.close();Path(os.environ['PARENT_RELAY_CASE'],'agent-eof-joined').write_text('true')\\nelse:\\n while True:time.sleep(1)"
if args==['status','-a','fixture','--json']:
 print(json.dumps(dict(Name='fixture',Organization=dict(Slug='fixture-org'),Network='default')));raise SystemExit()
if args[:1]==['proxy']:
 assert args==['proxy','0:1','::1','-a','fixture','--bind-addr','127.0.0.1','-q'],args
 assert os.environ['FLY_AGENT_ISOLATED']=='1'
 with (root/'proxy-calls').open('a')as stream:stream.write(os.environ['FLY_AGENT_SOCKET_PATH']+'\\n')
 agent=subprocess.Popen([sys.executable,'-u','-c',agent_code,os.environ['FLY_AGENT_SOCKET_PATH'],'bootstrap'],stdin=subprocess.PIPE)
 signal.signal(signal.SIGTERM,lambda *args:sys.exit(0))
 try:
  deadline=time.monotonic()+5
  while not Path(os.environ['FLY_AGENT_SOCKET_PATH']).is_socket():
   assert agent.poll()is None and time.monotonic()<deadline
   time.sleep(.01)
  print('Proxying localhost:fixture -> remote:1',flush=True)
  while True:time.sleep(.05)
 finally:
  agent.stdin.close();agent.wait(timeout=3)
assert args[:2] in (['ssh','console'],['ssh','sftp']),args
def ask(path,payload):
 stream=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);stream.settimeout(3);stream.connect(path)
 stream.sendall(struct.pack('<H',len(payload))+payload)
 def exact(count):
  data=b''
  while len(data)<count:
   block=stream.recv(count-len(data));assert block,'short agent frame';data+=block
  return data
 reply=exact(struct.unpack('<H',exact(2))[0]);stream.close();return reply
# Pinned client agent resolution: isolated private agent, explicit socket,
# else the HOME default; a background agent starts where PING finds nobody.
isolated=os.environ.get('FLY_AGENT_ISOLATED')=='1'
path=os.environ.get('FLY_AGENT_SOCKET_PATH') or str(Path(os.environ['HOME'],'.fly','fly-agent.sock'))
started=False
try:
 assert not isolated
 reply=ask(path,b'ping')
except (OSError,AssertionError):
 started=True
 if isolated:path=str(root/('isolated-%d.sock'%os.getpid()))
 Path(path).parent.mkdir(parents=True,exist_ok=True)
 daemon=subprocess.Popen([sys.executable,'-c',agent_code,path,'daemon'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 with (root/'started-agent.pids').open('a')as stream:stream.write(str(daemon.pid)+'\\n')
 deadline=time.monotonic()+5
 while not Path(path).is_socket():
  assert daemon.poll()is None and time.monotonic()<deadline
  time.sleep(.01)
 reply=ask(path,b'ping')
assert reply.startswith(b'ok '),reply
assert ask(path,b'connect fixture-org [fd00::1234]:22 10000 ')==b'ok'
with (root/'wireguard-calls').open('a')as stream:
 stream.write(json.dumps(dict(args=args,agent_socket=path,agent_pid=json.loads(reply[3:])['PID'],started_agent=started))+'\\n')
""")
        fake.chmod(0o700)
        campaign=f.root/'campaign';campaign.mkdir()
        module=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        environment=dict(os.environ,PATH=str(bin_path)+os.pathsep+os.environ['PATH'],HOME=str(home),FLY_BENCH_API_TOKEN='fixture-bench-token-over-twenty-characters',PARENT_RELAY_CASE=str(f.root),PARENT_RELAY_TEST=str(Path(__file__).resolve()))
        for key in ('FLY_AGENT_SOCKET_PATH','FLY_AGENT_ISOLATED'):environment.pop(key,None)
        def retire_started_agents():
            # Fixture-owned exact PIDs only; never a pattern or process group.
            for line in ((f.root/'started-agent.pids').read_text().split()if(f.root/'started-agent.pids').exists()else[]):
                try:os.kill(int(line),signal.SIGKILL)
                except ProcessLookupError:pass
        self.addCleanup(retire_started_agents)
        return f,repo,home,module,environment

    def test_campaign_child_wireguard_flyctl_reuses_the_relay_agent(self):
        """Children's ssh/sftp must share the campaign agent, never start another.

        flyctl v0.4.115 clients use FLY_AGENT_SOCKET_PATH, else ~/.fly/fly-agent.sock,
        and start a background agent where no agent answers PING (FLY_AGENT_ISOLATED
        starts a private one). Every agent in HOME loads the same single
        wire_guard_state peer. In the 100-copy sharded diagnostic, autoscaler worker
        staging started a default agent on each controller, and its tunnel traffic on
        that peer made relay CONNECTs retransmit until guest collection timed out.
        """
        from unittest.mock import patch
        f,repo,home,module,environment=self.campaign_relay_fixture()
        value=None
        try:
            with patch.dict(os.environ,environment,clear=True):
                value=module['start_shared_relay'](repo,f.root/'campaign',repo,f.feed,time.monotonic()+15)
                relay_socket=json.loads(Path(value['authority']).read_text())['agent_socket']
                # A campaign child inherits the parent environment through its one binding.
                child=dict(os.environ)
                module['bind_shared_relay'](child,value)
                fleet=(ROOT/'scripts/run-bench-fleet').read_text()
                functions=[]
                for header in ('private_source_allows_provider_call() {','FLY() {','worker_operational() {'):
                    begin=fleet.index('\n'+header)+1;functions.append(fleet[begin:fleet.index('\n}\n',begin)+3])
                script='\n'.join([
                    'set -eo pipefail',
                    'source "$ROOT_DIR/scripts/lib/cloudbench-inventory.sh"',
                    'source "$ROOT_DIR/scripts/lib/cloudbench-archived-reuse.sh"',
                    *functions,
                    'APP=fixture;FLEET_WORKER_HEALTH_PORT=3103',
                    '# The autoscaler health probe and staging upload use the production wrapper.',
                    'worker_operational "$WORKER_ID" "$CASE"',
                    'fly_with_timeout 20 ssh sftp put -a "$APP" --machine "$WORKER_ID" -q -m 0755 "$CASE/payload" /data/payload',
                ])
                (f.root/'payload').write_text('fixture payload\n')
                child.update(ROOT_DIR=str(ROOT),CASE=str(f.root),WORKER_ID=f.mid,FLEET_DIR=str(f.root/'fleet'))
                result=subprocess.run(['bash','-c',script],cwd=repo,env=child,capture_output=True,text=True,timeout=60)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                calls=[json.loads(line)for line in (f.root/'wireguard-calls').read_text().splitlines()]
                self.assertEqual([call['args'][:2]for call in calls],[['ssh','console'],['ssh','sftp']],calls)
                for call in calls:
                    self.assertFalse(call['started_agent'],'a campaign child started a second Fly agent: %r'%call)
                    self.assertEqual(call['agent_socket'],relay_socket,call)
                    self.assertEqual(call['agent_pid'],value['agent']['pid'],call)
                self.assertFalse((f.root/'started-agent.pids').exists())
                self.assertFalse((home/'.fly/fly-agent.sock').exists(),'default HOME agent socket was created')
                # Stale inherited agent selection never outranks the campaign's agent.
                child=dict(os.environ,FLY_AGENT_ISOLATED='1',FLY_AGENT_SOCKET_PATH=str(f.root/'stale-agent.sock'))
                module['bind_shared_relay'](child,value)
                self.assertEqual(child.get('FLY_AGENT_SOCKET_PATH'),relay_socket)
                self.assertNotIn('FLY_AGENT_ISOLATED',child)
                self.assertTrue(module['stop_shared_relay'](value))
                self.assertTrue((f.root/'agent-eof-joined').exists())
        finally:
            if value:
                for name in ('process','bootstrap'):
                    process=value[name]
                    if process.poll()is None:process.terminate();process.wait(timeout=4)
                for name in ('log','bootstrap_log'):
                    if not value[name].closed:value[name].close()

    def test_relay_app_metadata_read_retries_a_transient_fly_stall(self):
        """PR #1826 gates r5: one `flyctl status -a <bench app> --json` stalled past its 30 s timeout
        (Fly answered in 2.5 s minutes later) and the whole 13-task deploy smoke campaign failed before
        allocating anything. The read-only metadata call retries within its bound; the relay still starts."""
        from unittest.mock import patch
        f,repo,home,module,environment=self.campaign_relay_fixture()
        bin_path=f.root/'bin';(bin_path/'flyctl').rename(bin_path/'flyctl-real')
        (bin_path/'flyctl').write_text('#!/usr/bin/env bash\n'
            'if [ "$1" = status ]; then echo "$*" >> "$PARENT_RELAY_CASE/status-calls"; fi\n'
            'if [ "$1" = status ] && [ ! -e "$PARENT_RELAY_CASE/stalled-once" ]; then\n'
            ' : > "$PARENT_RELAY_CASE/stalled-once"; exec sleep 20\nfi\n'
            'exec "$(dirname "$0")/flyctl-real" "$@"\n')
        (bin_path/'flyctl').chmod(0o700)
        relay_globals=module['read_relay_app_metadata'].__globals__
        value=None
        try:
            with patch.dict(os.environ,environment,clear=True),patch.dict(relay_globals,RELAY_METADATA_TIMEOUT=1):
                started=time.monotonic()
                value=module['start_shared_relay'](repo,f.root/'campaign',repo,f.feed,time.monotonic()+15)
                self.assertLess(time.monotonic()-started,12)
                self.assertEqual(len((f.root/'status-calls').read_text().splitlines()),2)
                self.assertIsNone(value['process'].poll())
                self.assertTrue(module['stop_shared_relay'](value))
            # The bound holds: a stall on every attempt still fails the campaign normally.
            (f.root/'status-calls').unlink()
            (bin_path/'flyctl').write_text('#!/usr/bin/env bash\necho "$*" >> "$PARENT_RELAY_CASE/status-calls"; exec sleep 20\n')
            with patch.dict(os.environ,environment,clear=True),patch.dict(relay_globals,RELAY_METADATA_TIMEOUT=1):
                with self.assertRaises(subprocess.TimeoutExpired):
                    module['read_relay_app_metadata']('fixture',repo,dict(os.environ),time.monotonic()+15)
            self.assertEqual(len((f.root/'status-calls').read_text().splitlines()),3)
        finally:
            if value:
                for name in ('process','bootstrap'):
                    process=value[name]
                    if process.poll()is None:process.terminate();process.wait(timeout=4)
                for name in ('log','bootstrap_log'):
                    if not value[name].closed:value[name].close()

    def test_second_campaign_in_one_home_refuses_a_second_agent_on_the_wireguard_peer(self):
        """One HOME has one wire_guard_state peer, so at most one campaign agent.

        descend-full69-20261023: two local campaigns and K5's proof campaign each
        started a private isolated agent in the same HOME on peer
        interactive-boxes-...-01M5JRRKX43EPAJ0RXSRA99882. From the second agents'
        start (06:20:47) 60-90% of the first relay's CONNECTs stalled, guest
        /shutdown replies were lost (HTTP 000) and passed browser copies retained
        their Machines. A second campaign must refuse before starting any agent,
        and the claim must end with the first campaign's agent.
        """
        from unittest.mock import patch
        f,repo,home,module,environment=self.campaign_relay_fixture()
        values=[]
        def stop(value):
            for name in ('process','bootstrap'):
                process=value[name]
                if process is not None and process.poll()is None:process.terminate();process.wait(timeout=4)
            for name in ('log','bootstrap_log'):
                if not value[name].closed:value[name].close()
        self.addCleanup(lambda:[stop(value)for value in values])
        proxies=lambda:(f.root/'proxy-calls').read_text().splitlines()if(f.root/'proxy-calls').exists()else[]
        with patch.dict(os.environ,environment,clear=True):
            first_dir=f.root/'campaign-a';first_dir.mkdir()
            values.append(module['start_shared_relay'](repo,first_dir,repo,f.feed,time.monotonic()+15))
            self.assertEqual(len(proxies()),1)
            second_dir=f.root/'campaign-b';second_dir.mkdir()
            with self.assertRaisesRegex(ValueError,'WireGuard peer'):
                values.append(module['start_shared_relay'](repo,second_dir,repo,f.feed,time.monotonic()+15))
            self.assertEqual(len(proxies()),1,'a second campaign started another Fly agent on the HOME peer: %r'%proxies())
            self.assertFalse((home/'.fly/fly-agent.sock').exists(),'default HOME agent socket was created')
            # The claim belongs to the first campaign's agent and ends with it.
            self.assertTrue(module['stop_shared_relay'](values.pop()))
            third_dir=f.root/'campaign-c';third_dir.mkdir()
            values.append(module['start_shared_relay'](repo,third_dir,repo,f.feed,time.monotonic()+15))
            self.assertEqual(len(proxies()),2)
            self.assertTrue(module['stop_shared_relay'](values.pop()))


if __name__=='__main__':unittest.main()
