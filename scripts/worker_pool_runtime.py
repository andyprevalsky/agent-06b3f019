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
