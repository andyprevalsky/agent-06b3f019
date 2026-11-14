"""Read-only worker-process routing and native poller readiness boundary."""

from __future__ import annotations

import json
import os
import retained_agent_machine as pool

# Inspect the process owning the health listener, not this diagnostic exec's env.
RUNTIME_QUEUE_PROBE = """
import json, pathlib, psutil, runpy, socket, urllib.request

def health():
    with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2) as response:
        return json.load(response)

def listener():
    owners = {connection.pid for connection in psutil.net_connections(kind='tcp')
              if connection.status == psutil.CONN_LISTEN and connection.laddr.port == 8080}
    if len(owners) != 1 or None in owners:
        raise ValueError('Worker health process is ambiguous')
    return psutil.Process(owners.pop())

process = listener()
started = process.create_time()
command = process.cmdline()
if len(command) != 2 or pathlib.Path(command[0]).name not in ('python', 'python3', 'python3.11') or command[1] not in ('worker.py', '/app/worker.py'):
    raise ValueError('Health listener is not the canonical worker')
environment = process.environ()
status = health()
resolve = runpy.run_path('/app/helpers/worker_generation.py')['resolve_production_task_queue']
after = listener()
status_after = health()
if not isinstance(status.get('started_at'), str) or not status['started_at'] or any(
    status.get(key) != status_after.get(key) for key in ('healthy', 'phase', 'build_id', 'started_at')
):
    raise ValueError('Worker changed during its runtime queue probe')
status['runtime'] = {
    'pid': process.pid, 'hostname': socket.gethostname(), 'identity': f'{process.pid}@{socket.gethostname()}',
    'started': started, 'pidAfter': after.pid, 'startedAfter': after.create_time(),
    'baseQueue': environment.get('TEMPORAL_TASK_QUEUE'),
    'surfaceHash': environment.get('TEMPORAL_WORKER_SURFACE_HASH'),
    'queue': resolve(environment.get('TEMPORAL_TASK_QUEUE'), environment.get('TEMPORAL_WORKER_SURFACE_HASH')),
    'poolQueue': environment.get('TEMPORAL_WORKER_POOL_QUEUE'),
    'namespace': environment.get('TEMPORAL_NAMESPACE'),
    'buildId': environment.get('TEMPORAL_WORKER_BUILD_ID'),
    'attempt': environment.get('TEMPORAL_WORKER_DEPLOYMENT_TOKEN'),
    'autoscalerActuate': environment.get('AUTOSCALER_ACTUATE'),
}
print(json.dumps(status))
"""


def runtime_queue_matches(health, identity, queue, pool_queue=None):
    runtime = health.get("runtime", {})
    namespace = os.environ.get("TEMPORAL_NAMESPACE")
    return (
        bool(namespace)
        and runtime.get("autoscalerActuate") == "0"
        and runtime.get("namespace") == namespace
        and runtime.get("queue") == queue
        and runtime.get("poolQueue") == (pool_queue or queue)
        and runtime.get("baseQueue") == queue.rsplit("@", 1)[0]
        and runtime.get("surfaceHash") == identity["surfaceHash"]
        and runtime.get("buildId") == identity["buildId"]
        and runtime.get("attempt") == identity["attempt"]
        and type(runtime.get("pid")) is int
        and runtime["pid"] > 0
        and isinstance(runtime.get("hostname"), str)
        and bool(runtime["hostname"])
        and runtime.get("identity") == f"{runtime['pid']}@{runtime['hostname']}"
        and runtime.get("pidAfter") == runtime["pid"]
        and isinstance(runtime.get("started"), (int, float))
        and runtime["started"] > 0
        and runtime.get("startedAfter") == runtime["started"]
    )


def machine_identity(machine):
    return {
        "id": machine["id"],
        "instanceId": machine["instance_id"],
        "configSHA256": pool.config_digest(machine["config"]),
    }


class WorkerRuntime:
    """NativePool supplies get/client, identity, ledger and runtime_queue."""

    def read_runtime(self, machine):
        reply = self.client(machine["id"]).request(
            "POST",
            "/exec",
            {
                "command": ["python", "-I", "-B", "-c", RUNTIME_QUEUE_PROBE],
                "timeout": 10,
            },
        )
        if reply.get("exit_code") != 0 or reply.get("exit_signal"):
            return None
        health = json.loads(reply["stdout"])
        if machine_identity(self.get(machine["id"])) != machine_identity(machine):
            return None
        return health

    def healthy(self, machine_id):
        machine = self.get(machine_id)
        if machine["state"] != "started" or not self.target(machine):
            return False
        health = self.read_runtime(machine)
        ready = bool(
            health
            and health.get("healthy") is True
            and health.get("phase") == "running"
            and health.get("build_id") == self.identity["buildId"]
            and runtime_queue_matches(health, self.identity, self.runtime_queue())
        )
        if ready:
            self.runtime_observations[machine_id] = {
                **health["runtime"],
                "machineRecord": {
                    **machine_identity(machine),
                    "identity": health["runtime"]["identity"],
                    "namespace": health["runtime"]["namespace"],
                },
            }
        else:
            self.runtime_observations.pop(machine_id, None)
        return ready

    def native_pollers_ready(self, machine_ids):
        identities = [self.runtime_observations[mid]["identity"] for mid in machine_ids]
        if len(identities) != 8 or len(set(identities)) != 8:
            raise ValueError("The complete bank needs eight distinct actual runtime identities")
        records = [self.runtime_observations[mid]["machineRecord"] for mid in machine_ids]
        for record in records:
            if machine_identity(self.get(record["id"])) != {
                key: record[key] for key in ("id", "instanceId", "configSHA256")
            }:
                raise ValueError("Candidate changed between runtime proof and native poller check")
        result = self.ledger.verify_native_pollers(identities, records)
        if not isinstance(result, dict) or type(result.get("ready")) is not bool:
            raise ValueError("Native poller verification returned no typed readiness result")
        if result.get("queue") != self.runtime_queue():
            raise ValueError("Native poller verification used a foreign queue")
        if result["ready"] and set(result.get("identities", [])) != set(identities):
            raise ValueError("Native poller verification changed the runtime identity set")
        return result["ready"]

    def observe_route(self, expected, expected_queue):
        machine = self.get(expected["id"])
        if machine_identity(machine) != {key: expected[key] for key in ("id", "instanceId", "configSHA256")}:
            raise ValueError("Old bank changed before actual route observation")
        health = self.read_runtime(machine)
        runtime = health.get("runtime", {}) if health else {}
        env = machine["config"].get("env", {})
        identity = {
            "buildId": env.get("TEMPORAL_WORKER_BUILD_ID"),
            "surfaceHash": env.get("TEMPORAL_WORKER_SURFACE_HASH"),
            "attempt": env.get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN"),
        }
        actual = runtime.get("queue")
        if not (
            health
            and health.get("healthy") is True
            and health.get("phase") == "running"
            and health.get("build_id") == identity["buildId"]
            and isinstance(actual, str)
            and actual
            and runtime.get("poolQueue") == expected_queue
            and runtime_queue_matches(health, identity, actual, pool_queue=expected_queue)
        ):
            raise ValueError("Old bank actual process route is unknown")
        return {
            "machineId": expected["id"],
            "instanceId": expected["instanceId"],
            "configSHA256": expected["configSHA256"],
            **{
                key: runtime[key]
                for key in (
                    "pid",
                    "started",
                    "namespace",
                    "buildId",
                    "surfaceHash",
                    "attempt",
                    "identity",
                    "autoscalerActuate",
                )
            },
            "expectedQueue": expected_queue,
            "actualQueue": actual,
        }

    def certify_unpublished_retirement(self, expected, previous, live, machine, command):
        job = self.ledger.read()
        queue = self.runtime_queue()
        if (
            job["stage"] not in ("PREPARING", "READY")
            or expected.get("managedJobId") != self.ledger.job_id
            or expected["id"] not in job["candidateMachineIds"]
            or previous["taskQueue"] != queue
            or live != job["priorPointer"]
            or not self.target(machine, draining=True)
        ):
            raise ValueError("Only this job's unpublished candidate may bypass runtime health")
        pointer = json.loads(command("set-agent-queue-pointer.ts", "--read").strip().splitlines()[-1])
        if (
            not pointer
            or pointer.get("taskQueue") == queue
            or any(pointer.get(key) != live[key] for key in ("taskQueue", "surfaceHash"))
        ):
            raise ValueError("Candidate routing is published or unknown")
        command("retire-agent-queue.ts", "--verify-retired", "--queue", queue)

    def revalidate_retained_routes(self, records):
        self.ledger.retained_status()
        for record in records:
            proof = self.observe_route(record, record["routeEvidence"]["expectedQueue"])
            if proof != record["routeEvidence"]:
                raise ValueError("Held old bank process route changed since PREPARING")


def previous_route_mismatches(native, previous, machines, pointer, minimum):
    mismatch_records = []
    managed = [record for record in previous if record.get("managedJobId")]
    states = {machine["id"]: machine["state"] for machine in machines}
    if any(states[record["id"]] not in ("started", "stopped") for record in managed):
        raise ValueError("Old managed bank has an unknown native lifecycle")
    observations = [
        (record, native.observe_route(record, pointer["taskQueue"]))
        for record in managed
        if states[record["id"]] == "started"
    ]
    if any(proof["actualQueue"] != pointer["taskQueue"] for _, proof in observations):
        if len(observations) != minimum or any(
            proof["actualQueue"] == pointer["taskQueue"] for _, proof in observations
        ):
            raise ValueError("Mixed or incomplete old-bank route mismatch evidence")
        mismatch_records = [{**record, "routeEvidence": proof} for record, proof in observations]
    return mismatch_records


# Initial-exec provider plus the installed non-overwriting dotenv contract, not Python heap state.
RUNTIME_BROWSER_PROVIDER_PROBE = r'''
import ast, hashlib, json, os, pathlib, psutil, sys

def need(value, reason):
    if not value:
        raise ValueError(reason)

def source_contract(path):
    data = path.read_bytes()
    tree = ast.parse(data)
    loaders = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
               and (getattr(node.func, 'id', None) == 'load_dotenv'
                    or getattr(node.func, 'attr', None) == 'load_dotenv')]
    need(loaders and all(any(k.arg == 'override' and isinstance(k.value, ast.Constant)
                            and k.value.value is False for k in call.keywords) for call in loaders),
         'Installed dotenv contract is not explicitly non-overwriting')
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.Delete)):
            targets = getattr(node, 'targets', [getattr(node, 'target', None)])
            for target in targets:
                if isinstance(target, ast.Subscript) and getattr(target.value, 'attr', None) == 'environ':
                    key = target.slice
                    need(isinstance(key, ast.Constant) and key.value != 'BROWSER_PROVIDER',
                         'Installed source may replace the provider')
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == 'putenv':
                need(node.args and isinstance(node.args[0], ast.Constant)
                     and node.args[0].value != 'BROWSER_PROVIDER', 'Installed source may replace the provider')
            if getattr(node.func.value, 'attr', None) == 'environ':
                need(node.func.attr not in ('update', 'clear'), 'Installed source may replace the provider')
                if node.func.attr in ('pop', 'setdefault'):
                    need(node.args and isinstance(node.args[0], ast.Constant)
                         and node.args[0].value != 'BROWSER_PROVIDER', 'Installed source may replace the provider')
    return hashlib.sha256(data).hexdigest()

def snapshot():
    workers = []
    for process in psutil.process_iter(['cmdline', 'status']):
        if process.info['status'] == psutil.STATUS_ZOMBIE:
            continue
        command = process.info['cmdline']
        need(command is not None, 'Process command is unreadable')
        if any(pathlib.Path(arg).name == 'worker.py' for arg in command[1:]):
            workers.append(process)
    need(len(workers) == 1, 'Running worker process is absent or ambiguous')
    process = workers[0]
    command = process.cmdline()
    need(len(command) == 2 and pathlib.Path(command[0]).name in ('python', 'python3', 'python3.11')
         and command[1] in ('worker.py', '/app/worker.py') and process.cwd() == '/app',
         'Running process is not the canonical worker')
    def birth():
        fields = pathlib.Path('/proc', str(process.pid), 'stat').read_text().rsplit(') ', 1)[1].split()
        need(fields[0] != 'Z', 'Worker is a zombie')
        return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + str(process.pid) + ':' + fields[19]
    before = birth()
    values = [item.split(b'=', 1)[1].decode() for item in pathlib.Path('/proc', str(process.pid), 'environ').read_bytes().split(b'\0')
              if item.startswith(b'BROWSER_PROVIDER=')]
    need(len(values) == 1, 'Worker initial-exec BROWSER_PROVIDER is missing or ambiguous')
    row = {'pid': process.pid, 'birth': before, 'provider': values[0].strip().lower(),
           'worker_sha256': source_contract(pathlib.Path('/app/worker.py')),
           'config_sha256': source_contract(pathlib.Path('/app/config.py')),
           'dotenv_nonoverwriting': True}
    need(birth() == before, 'Worker birth changed while observing provider')
    return row

need(os.environ.get('FLY_MACHINE_ID') == sys.argv[1]
     and os.environ.get('FLY_MACHINE_VERSION') == sys.argv[2], 'Native Machine instance mismatch')
before = snapshot()
after = snapshot()
need(before == after, 'Worker identity, provider or source changed during observation')
print(json.dumps({'machine_id': sys.argv[1], 'instance_id': sys.argv[2], 'before': [before], 'after': [after]}))
'''


def resolve_browser_provider(app):
    """Read every currently started worker; never wake a stopped Machine or infer its runtime."""
    import re
    import subprocess
    import time

    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', app):
        raise ValueError('Invalid production app')
    deadline = time.monotonic() + 120

    def read(arguments):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('Production worker observation deadline exceeded')
        reply = subprocess.run(['flyctl', *arguments], text=True, capture_output=True,
                               timeout=min(20, remaining), check=False)
        if reply.returncode:
            raise ValueError('Production worker observation command failed')
        return json.loads(reply.stdout)

    def active():
        inventory = read(['machines', 'list', '-a', app, '--json'])
        if not isinstance(inventory, list) or not inventory:
            raise ValueError('Production inventory is empty or malformed')
        result, seen = {}, set()
        for machine in inventory:
            mid = machine.get('id') if isinstance(machine, dict) else None
            if not isinstance(mid, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', mid) or mid in seen:
                raise ValueError('Production Machine identity is invalid or duplicated')
            seen.add(mid)
            if machine.get('state') not in ('started', 'stopped', 'suspended'):
                raise ValueError('Production Machine lifecycle is uncertain')
            if machine['state'] == 'started':
                if not isinstance(machine.get('instance_id'), str) or not machine['instance_id'] or not isinstance(machine.get('config'), dict):
                    raise ValueError('Production Machine instance/config is missing')
                result[mid] = machine_identity(machine)
        if not result:
            raise ValueError('No already-started production worker is observable')
        return result

    before = active()
    providers = set()
    for mid, identity in before.items():
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise ValueError('Production worker observation deadline exceeded')
        # flyctl JSON reserializes exit_code with omitempty and drops exit_signal.
        # Keep the raw Machines response and require explicit normal completion.
        reply = pool.Fly(app, mid).request('POST', '/exec', {
            'command': ['python3', '-I', '-B', '-c', RUNTIME_BROWSER_PROVIDER_PROBE, mid, identity['instanceId']],
            'timeout': min(15, int(remaining)),
        }, timeout=min(20, remaining))
        if (not isinstance(reply, dict) or type(reply.get('exit_code')) is not int or reply['exit_code'] != 0
                or type(reply.get('exit_signal')) is not int or reply['exit_signal'] != 0
                or not isinstance(reply.get('stdout'), str)):
            raise ValueError('Running worker provider probe has no verified normal completion')
        observation = json.loads(reply['stdout'])
        rows = observation.get('before')
        if (observation.get('machine_id') != mid or observation.get('instance_id') != identity['instanceId']
                or not isinstance(rows, list) or len(rows) != 1 or rows != observation.get('after')):
            raise ValueError('Worker or native Machine binding is missing, ambiguous or changed')
        row = rows[0]
        pid = row.get('pid')
        if (type(pid) is not int or pid <= 1
                or not isinstance(row.get('birth'), str)
                or not re.fullmatch(r'[0-9a-f-]{36}:' + str(pid) + r':[1-9][0-9]*', row['birth'])
                or row.get('dotenv_nonoverwriting') is not True
                or any(not re.fullmatch(r'[0-9a-f]{64}', str(row.get(key, ''))) for key in ('worker_sha256', 'config_sha256'))
                or row.get('provider') not in ('tilion', 'kernel', 'steel', 'browser-use')):
            raise ValueError('Worker provider, native birth or source contract is unverified')
        providers.add(row['provider'])
    if active() != before:
        raise ValueError('Active production Machine instances changed during observation')
    if len(providers) != 1:
        raise ValueError('Active production workers have mixed providers')
    return next(iter(providers))


if __name__ == '__main__':
    import sys

    try:
        if len(sys.argv) != 3 or sys.argv[1] != '--browser-provider':
            raise ValueError('Expected --browser-provider APP')
        print(resolve_browser_provider(sys.argv[2]))
    except Exception as error:
        print('FATAL: could not read production Fly worker configuration/runtime: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
