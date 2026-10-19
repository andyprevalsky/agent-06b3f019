#!/usr/bin/env python3
"""Resume a durable deployment against leased, explicitly released Machines."""

from __future__ import annotations

import json
import hashlib
import os
import re
import sys
import subprocess
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote
from urllib.request import Request, urlopen

import retained_agent_machine as pool
from worker_pool_runtime import RUNTIME_QUEUE_PROBE, WorkerRuntime, machine_identity, previous_route_mismatches
from worker_pool_runtime import runtime_queue_matches as _runtime_queue_matches


ROOT = Path(__file__).resolve().parents[1]
QUEUE_CLI = ROOT / "back-end/scripts/worker-deployment-queue.ts"
DRAIN_TIMEOUT_SECONDS = 2700
MACHINE_STOP_TIMEOUT_SECONDS = 120


def runtime_queue_matches(health, identity, job_id, expected_queue=None, pool_queue=None):
    return _runtime_queue_matches(health, identity, expected_queue or deployment_queue(identity, job_id), pool_queue)


class PoolCapacityPending(Exception):
    """No complete idle bank exists; no native mutation has been admitted."""


class Ledger:
    def __init__(self):
        self.job_id = os.environ["WORKER_DEPLOYMENT_JOB_ID"]
        self.owner_id = os.environ["WORKER_DEPLOYMENT_OWNER_ID"]

    def call(self, action, payload=None, **arguments):
        command = ["node", "--import", "tsx", str(QUEUE_CLI), action, "--job-id", self.job_id]
        if action != "read":
            command += ["--owner-id", self.owner_id]
        for name, value in arguments.items():
            command += ["--" + name.rstrip("_").replace("_", "-"), value]
        with tempfile.TemporaryDirectory(prefix="worker-pool-command-") as directory:
            if payload is not None:
                path = Path(directory) / "request.json"
                path.write_text(json.dumps(payload), encoding="utf-8")
                path.chmod(0o600)
                command += ["--plan", str(path)]
            result = subprocess.run(
                command, cwd=ROOT / "back-end", check=True, capture_output=True, text=True, timeout=60
            )
        return json.loads(result.stdout)

    def read(self):
        return self.call("read")

    def assert_owned(self):
        self.call("assert")

    def assert_mutable(self, machine_id):
        return self.call("assert-mutable", machine_id=machine_id)

    def verify_native_pollers(self, identities, machine_records):
        return self.call("verify-native-pollers", {"identities": identities, "machineRecords": machine_records})

    def retained_status(self):
        return self.call("retained-status")

    def prepare(self, pointer, ids, evidence):
        return self.call(
            "prepare",
            {
                "priorPointer": pointer,
                "candidateMachineIds": ids,
                "evidence": evidence,
            },
        )

    def stage(self, prior, following, evidence):
        return self.call("stage", evidence, from_=prior, to=following)

    def release(self, previous_job, machines, evidence):
        return self.call(
            "release",
            {
                "previousJobId": previous_job,
                "machineIds": machines,
                "retirementEvidence": evidence,
            },
        )

    def abandon(self, machines):
        return self.call("abandon", {"machineRecords": machines, "reason": "Explicit unpublished candidate retirement"})


def deployment_queue(identity, job_id):
    suffix = hashlib.sha256(job_id.encode()).hexdigest()[:12]
    return f"navi-agent-tasks-pool-{suffix}@{identity['surfaceHash']}"


class NativePool(WorkerRuntime):
    def __init__(self, identity, ledger):
        self.identity = identity
        self.ledger = ledger
        self.app = identity["app"]
        self.runtime_observations = {}

    def runtime_queue(self):
        return deployment_queue(self.identity, self.ledger.job_id)

    def client(self, machine_id):
        ledger = self.ledger

        class OwnedFly(pool.Fly):
            def assert_managed_mutable(self):
                ledger.assert_owned()
                ledger.assert_mutable(machine_id)

            def request(self, method, suffix="", data=None):
                if method != "GET":
                    ledger.assert_owned()
                    if not (
                        method == "POST"
                        and suffix == "/exec"
                        and data == {"command": ["python", "-I", "-B", "-c", RUNTIME_QUEUE_PROBE], "timeout": 10}
                    ):
                        ledger.assert_mutable(machine_id)
                return super().request(method, suffix, data)

        return OwnedFly(self.app, machine_id)

    def list(self):
        request = Request(
            f"{pool.API}/apps/{quote(self.app, safe='')}/machines",
            headers={"Authorization": "Bearer " + os.environ["FLY_API_TOKEN"]},
        )
        with urlopen(request, timeout=30) as response:
            values = json.load(response)
        if not isinstance(values, list) or len({m["id"] for m in values}) != len(values):
            raise ValueError("Native inventory is not a complete distinct Machine list")
        return values

    def get(self, machine_id):
        value = self.client(machine_id).request("GET")
        if value.get("id") != machine_id or not value.get("instance_id"):
            raise ValueError("Native Machine identity is incomplete")
        return value

    def operation(self, action, machine, previous):
        identity = self.identity
        arguments = SimpleNamespace(
            action=action,
            app=self.app,
            id=machine["id"],
            live_hash=previous["surfaceHash"],
            live_queue=previous["taskQueue"],
            hash=identity["surfaceHash"],
            build=identity["buildId"],
            token=identity["attempt"],
            image=identity["imageRef"],
            queue=deployment_queue(identity, self.ledger.job_id),
            job=self.ledger.job_id,
        )
        pool.operate(arguments, machine, self.client(machine["id"]))

    def target(self, machine, draining=False):
        marker = pool.metadata(machine, pool.POOL_KEY)
        env = machine["config"].get("env", {})
        return (
            marker.get("job") == self.ledger.job_id
            and (marker.get("phase") == "active" or (draining and marker.get("phase") == "draining"))
            and marker.get("build") == self.identity["buildId"]
            and marker.get("token") == self.identity["attempt"]
            and env.get("TEMPORAL_WORKER_SURFACE_HASH") == self.identity["surfaceHash"]
            and env.get("TEMPORAL_WORKER_BUILD_ID") == self.identity["buildId"]
            and env.get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN") == self.identity["attempt"]
            and env.get("TEMPORAL_WORKER_POOL_QUEUE") == deployment_queue(self.identity, self.ledger.job_id)
            and machine["config"].get("init", {}).get("exec")
            == pool.managed_worker_command(deployment_queue(self.identity, self.ledger.job_id))
            and env.get("AUTOSCALER_ACTUATE") == "0"
            and env.get("PEOPLE_CREDENTIAL_BROKER_URL") == "https://navi-j9a9.onrender.com"
            and machine["config"].get("image") == self.identity["imageRef"]
            and marker.get("configSHA256") == pool.config_digest(machine["config"])
        )

    def prepare(self, expected, previous, start=True):
        machine = self.get(expected["id"])
        if not self.target(machine):
            if pool.metadata(machine, pool.CUSTODY_KEY).get("rootfs_disposition") != "stateless":
                raise ValueError("Managed banks require renewable stateless custody before image changes")
            if machine_identity(machine) != expected:
                raise ValueError("Reserved Machine changed outside this deployment")
            self.operation("reserve", machine, previous)
            machine = self.get(machine["id"])
            self.operation("reuse", machine, previous)
            machine = self.get(machine["id"])
        client = self.client(machine["id"])
        with client.lease():
            current = client.request("GET")
            if not self.target(current):
                raise ValueError("Prepared Machine no longer belongs to this deployment")
            source = pool.metadata(current, pool.POOL_KEY).get("source", {})
            if {
                "id": source.get("id"),
                "instanceId": source.get("instance_id"),
                "configSHA256": source.get("config_sha256"),
            } != expected or source.get("app") != self.app:
                raise ValueError("Prepared Machine does not match its durable source reservation")
            if not pool.custody_ready(current, self.app):
                custody = pool.metadata(current, pool.CUSTODY_KEY)
                if custody.get("rootfs_disposition") != "stateless" or any(
                    custody.get(key) != source.get(key) for key in ("app", "id", "instance_id", "config_sha256")
                ):
                    raise ValueError("Prepared Machine has no matching stateless source custody")
                refreshed = {
                    **custody,
                    **{
                        key: value
                        for key, value in pool.record(current, self.app).items()
                        if key in ("app", "id", "instance_id", "config_sha256")
                    },
                }
                client.request("POST", "/metadata/" + pool.CUSTODY_KEY, {"value": json.dumps(refreshed)})
                current = client.request("GET")
                if not self.target(current) or not pool.custody_ready(current, self.app):
                    raise ValueError("Prepared Machine custody recovery was not verified")
            if not start:
                return
            if current["state"] in ("stopped", "created"):
                client.request("POST", "/start")
            elif current["state"] not in ("started", "starting"):
                raise ValueError("Prepared Machine is in an unresolved native state")

    def retire(self, expected, previous, live=None):
        self.ledger.assert_mutable(expected["id"])
        before = self.get(expected["id"])
        allow_created = live is not None
        if allow_created:
            self.certify_unpublished_retirement(expected, previous, live, before, backend_command)
        elif (
            before["state"] == "started"
            and self.observe_route(expected, previous["taskQueue"])["actualQueue"] != previous["taskQueue"]
        ):
            raise ValueError("Old bank serves a different actual queue and cannot be retired")
        client = self.client(expected["id"])
        live = live or {
            "taskQueue": deployment_queue(self.identity, self.ledger.job_id),
            "surfaceHash": self.identity["surfaceHash"],
        }
        with client.lease():
            current = client.request("GET")
            marker = pool.metadata(current, pool.POOL_KEY)
            destination = live["taskQueue"]
            if (
                marker.get("phase") == "idle"
                and marker.get("retired_by")
                == {
                    "build": self.identity["buildId"],
                    "token": self.identity["attempt"],
                }
                and marker.get("drained_queue") == previous["taskQueue"]
                and pool.eligible(current, self.app, live["surfaceHash"], destination)
            ):
                return machine_identity(current)
            if (
                machine_identity(current) != {k: expected[k] for k in ("id", "instanceId", "configSHA256")}
                or marker.get("job") != expected["managedJobId"]
                or marker.get("phase") not in ("active", "draining")
                or (marker.get("phase") == "draining" and marker.get("retiringBy") != self.ledger.job_id)
                or current["config"].get("env", {}).get("TEMPORAL_WORKER_POOL_QUEUE") != previous["taskQueue"]
                or current["config"].get("metadata", {}).get("rose_worker_reuse_protected")
            ):
                raise ValueError("Old bank changed before its certified retirement")
            draining = {**marker, "phase": "draining", "retiringBy": self.ledger.job_id}
            if marker != draining:
                client.request("POST", "/metadata/" + pool.POOL_KEY, {"value": json.dumps(draining, sort_keys=True)})
            if current["state"] == "started":
                client.request("POST", "/stop")
            elif current["state"] not in ("stopped", "stopping") and not (
                allow_created and current["state"] == "created"
            ):
                raise ValueError("Old bank has an unresolved native lifecycle")
        deadline = time.monotonic() + MACHINE_STOP_TIMEOUT_SECONDS
        while True:
            self.ledger.assert_owned()
            current = self.get(expected["id"])
            if current["state"] == "stopped" or (allow_created and current["state"] == "created"):
                break
            if time.monotonic() >= deadline:
                raise PoolCapacityPending("Certified old bank is still stopping")
            time.sleep(2)
        identity = self.identity
        arguments = SimpleNamespace(
            action="retire",
            app=self.app,
            id=current["id"],
            hash=previous["surfaceHash"],
            live_hash=live["surfaceHash"],
            queue=previous["taskQueue"],
            live_queue=live["taskQueue"],
            build=identity["buildId"],
            token=identity["attempt"],
            job=self.ledger.job_id,
            allow_created=allow_created,
        )
        pool.operate(arguments, current, client)
        retired = self.get(current["id"])
        if not pool.eligible(retired, self.app, live["surfaceHash"], arguments.live_queue):
            raise ValueError("Stopped old bank lacks reusable custody")
        return machine_identity(retired)

    def abandon(self, expected, previous):
        """Return only this unpublished job's reservation or retired candidate."""
        current = self.get(expected["id"])
        if machine_identity(current) == expected:
            if pool.eligible(current, self.app, previous["surfaceHash"], previous["taskQueue"]):
                return machine_identity(current)
            self.operation("release-reservation", current, previous)
            restored = self.get(expected["id"])
            if not pool.eligible(restored, self.app, previous["surfaceHash"], previous["taskQueue"]):
                raise ValueError("Unchanged reservation did not return to its original idle bank")
            return machine_identity(restored)
        marker = pool.metadata(current, pool.POOL_KEY)
        target_queue = deployment_queue(self.identity, self.ledger.job_id)
        if (
            marker.get("phase") == "idle"
            and current["config"].get("env", {}).get("TEMPORAL_WORKER_POOL_QUEUE") == target_queue
            and pool.eligible(current, self.app, previous["surfaceHash"], previous["taskQueue"])
        ):
            return machine_identity(current)
        if self.target(current):
            self.prepare(expected, previous, start=False)
        elif not (
            self.target(current, draining=True)
            and marker.get("retiringBy") == self.ledger.job_id
            and pool.custody_ready(current, self.app)
        ):
            raise ValueError("Unpublished candidate changed outside its owning deployment")
        # retire() owns its own native lease and requires this exact job marker.
        current = self.get(current["id"])
        prior = {**machine_identity(current), "managedJobId": self.ledger.job_id}
        destination = {"taskQueue": target_queue, "surfaceHash": self.identity["surfaceHash"]}
        return self.retire(prior, destination, previous)


def backend_command(script, *arguments, timeout=60):
    result = subprocess.run(
        ["node", "--import", "tsx", "scripts/" + script, *arguments],
        cwd=ROOT / "back-end",
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout


def broadcast_generation_handoff(previous_queue, live_queue):
    """Push the pointer flip to workflows idling on the old queue; never blocks the deploy.

    Idle parks no longer poll the pointer every 30s; this signal wakes them
    (agents/helpers/wait_condition_or_handoff.py). Re-running it on a resumed
    DRAINING stage is harmless: the workflow signal handler is idempotent.
    """
    if not previous_queue or previous_queue == live_queue:
        return
    try:
        # 200 signals/s for up to 120s covers 24k workflows (10k-agent target).
        output = backend_command(
            "broadcast-generation-handoff.ts",
            "--from-queue",
            previous_queue,
            "--live-queue",
            live_queue,
            "--deadline-ms",
            "120000",
            timeout=180,
        )
        lines = output.strip().splitlines()
        print(f"Generation handoff broadcast: {lines[-1] if lines else '{}'}", flush=True)
    except Exception as error:  # best-effort: agents still hand off at their next re-check
        print(f"Generation handoff broadcast failed; agents hand off at their next re-check: {error}", flush=True)


def prepare_bank(job, ledger, native, minimum):
    output = backend_command("set-agent-queue-pointer.ts", "--read")
    pointer = json.loads(output.strip().splitlines()[-1])
    if not pointer or not pointer.get("surfaceHash") or not pointer.get("taskQueue"):
        raise ValueError("An exact live queue pointer is required")
    machines = native.list()
    candidates = sorted(
        (
            m
            for m in machines
            if pool.eligible(m, native.app, pointer["surfaceHash"], pointer["taskQueue"])
            and pool.metadata(m, pool.CUSTODY_KEY).get("rootfs_disposition") == "stateless"
        ),
        key=lambda value: value["id"],
    )
    selected = []
    qualified = set()
    for machine in candidates:
        source = pool.record(machine, native.app)
        source_queue = source.get("queue", "navi-agent-tasks@" + source["hash"])
        if not pool.initial_spare(machine, native.app, pointer["surfaceHash"]):
            if source_queue not in qualified:
                backend_command("retire-agent-queue.ts", "--verify-retired", "--queue", source_queue)
                qualified.add(source_queue)
        selected.append(machine_identity(machine))
        if len(selected) == minimum:
            break
    if len(selected) != minimum:
        raise PoolCapacityPending(f"Waiting for {minimum} released pool Machines; found {len(selected)}")
    previous = []
    for machine in machines:
        env = (machine.get("config") or {}).get("env", {})
        queue = env.get("TEMPORAL_WORKER_POOL_QUEUE") or (
            "navi-agent-tasks@" + env.get("TEMPORAL_WORKER_SURFACE_HASH", "")
        )
        if queue == pointer["taskQueue"]:
            prior = machine_identity(machine)
            marker = pool.metadata(machine, pool.POOL_KEY)
            if marker.get("phase") == "active" and marker.get("job"):
                prior["managedJobId"] = marker["job"]
            previous.append(prior)
    if re.fullmatch(r"navi-agent-tasks-pool-[a-f0-9]{12}@[a-f0-9]{12}", pointer["taskQueue"]):
        if (
            len(previous) != minimum
            or not pointer.get("updatedBy")
            or any(record.get("managedJobId") != pointer["updatedBy"] for record in previous)
        ):
            raise ValueError("Current managed bank does not match its complete native ownership set")
    mismatch_records = previous_route_mismatches(native, previous, machines, pointer, minimum)
    return ledger.prepare(
        {key: pointer[key] for key in ("taskQueue", "surfaceHash")},
        [m["id"] for m in selected],
        {
            "candidateRecords": selected,
            "previousRecords": previous,
            "retainedRouteMismatchRecords": mismatch_records,
        },
    )


def initialize_queue(job, ledger, retirement=False):
    identity = job["identity"]
    return backend_command(
        "initialize-managed-worker-queue.ts",
        "--queue",
        deployment_queue(identity, ledger.job_id),
        "--surface-hash",
        identity["surfaceHash"],
        "--job-id",
        ledger.job_id,
        "--source-commit",
        identity["sourceCommit"],
        "--owner-id",
        ledger.owner_id,
        *(["--for-retirement"] if retirement else []),
    )


def run(ledger=None, native_factory=NativePool):
    ledger = ledger or Ledger()
    job = ledger.read()
    native = native_factory(job["identity"], ledger)
    if job["stage"] == "QUEUED":
        job = prepare_bank(job, ledger, native, minimum=8)
    if job["stage"] == "PREPARING":
        initialize_queue(job, ledger)
        for expected in job["evidence"]["PREPARING"]["candidateRecords"]:
            native.prepare(expected, job["priorPointer"])
        deadline = time.monotonic() + 300
        while not (
            all(native.healthy(mid) for mid in job["candidateMachineIds"])
            and native.native_pollers_ready(job["candidateMachineIds"])
        ):
            ledger.assert_owned()
            if time.monotonic() >= deadline:
                raise TimeoutError("The complete reserved bank did not become healthy")
            time.sleep(5)
        job = ledger.stage("PREPARING", "READY", {"healthyMachineIds": job["candidateMachineIds"]})
    if job["stage"] == "READY":
        ledger.assert_owned()
        if not all(native.healthy(mid) for mid in job["candidateMachineIds"]):
            raise ValueError("The reserved bank changed before pointer publication")
        if not native.native_pollers_ready(job["candidateMachineIds"]):
            raise PoolCapacityPending("Native candidate pollers are not ready for pointer publication")
        identity = job["identity"]
        backend_command(
            "set-agent-queue-pointer.ts",
            "--queue",
            deployment_queue(identity, ledger.job_id),
            "--surface-hash",
            identity["surfaceHash"],
            "--by",
            ledger.job_id,
            "--expected-current-queue",
            job["priorPointer"]["taskQueue"],
        )
        job = ledger.stage("READY", "ACTIVATED", {"pointerPublished": True})
    if job["stage"] == "ACTIVATED":
        job = ledger.stage("ACTIVATED", "DRAINING", {})
    if job["stage"] == "DRAINING":
        previous = job["priorPointer"]
        broadcast_generation_handoff(previous["taskQueue"], deployment_queue(job["identity"], ledger.job_id))
        prior_records = job["evidence"]["PREPARING"]["previousRecords"]
        mismatch_records = job["evidence"]["PREPARING"].get("retainedRouteMismatchRecords", [])
        held_ids = {record["id"] for record in mismatch_records}
        managed = [record for record in prior_records if record.get("managedJobId") and record["id"] not in held_ids]
        retained = [record["id"] for record in prior_records if not record.get("managedJobId")]
        retired = []
        for expected in job["evidence"]["PREPARING"]["candidateRecords"]:
            native.prepare(expected, previous)
        if not all(native.healthy(mid) for mid in job["candidateMachineIds"]):
            raise PoolCapacityPending("Serving bank is not ready; every old worker is retained")
        if managed or mismatch_records:
            backend_command(
                "retire-agent-queue.ts", "--begin", "--queue", previous["taskQueue"], "--owner", ledger.job_id
            )
            deadline = time.monotonic() + DRAIN_TIMEOUT_SECONDS
            while True:
                ledger.assert_owned()
                try:
                    backend_command(
                        "retire-agent-queue.ts",
                        "--retire",
                        "--queue",
                        previous["taskQueue"],
                        "--owner",
                        ledger.job_id,
                    )
                    break
                except subprocess.CalledProcessError:
                    pass
                if time.monotonic() >= deadline:
                    raise PoolCapacityPending("Old bank remains served until its queue is certified retired")
                print("Old bank is still draining; retaining every Machine", flush=True)
                time.sleep(30)
            for record in managed:
                if not all(native.healthy(mid) for mid in job["candidateMachineIds"]):
                    raise PoolCapacityPending("Serving bank lost health; remaining old workers are retained")
                retired.append(native.retire(record, previous))
            for owner in {record["managedJobId"] for record in managed}:
                ids = [record["id"] for record in managed if record["managedJobId"] == owner]
                ledger.release(
                    owner,
                    ids,
                    {
                        row["id"]: {
                            "instanceId": row["instanceId"],
                            "configSHA256": row["configSHA256"],
                            "retiredQueue": previous["taskQueue"],
                            "certificateRef": "agent-queue-admission:" + previous["taskQueue"],
                        }
                        for row in retired
                        if row["id"] in ids
                    },
                )
        if not all(native.healthy(mid) for mid in job["candidateMachineIds"]) or not native.native_pollers_ready(
            job["candidateMachineIds"]
        ):
            raise ValueError("New bank lost health or native pollers before deployment completion")
        if mismatch_records:
            native.revalidate_retained_routes(mismatch_records)
        job = ledger.stage(
            "DRAINING",
            "SUCCEEDED",
            {
                "retainedLegacyMachineIds": retained,
                "retiredMachines": retired,
                "activeMachineIds": job["candidateMachineIds"],
                "candidateHealthy": True,
                "priorDisposition": "RETAINED_ROUTE_MISMATCH"
                if mismatch_records
                else ("RETIRED" if managed else "RETAINED_LEGACY"),
                "retainedRouteMismatchMachineIds": sorted(held_ids),
            },
        )
    return job


def abandon(ledger=None, native_factory=NativePool):
    ledger = ledger or Ledger()
    job = ledger.read()
    if job["stage"] not in ("PREPARING", "READY"):
        raise ValueError("Only an unpublished prepared deployment can be abandoned")
    ledger.assert_owned()
    pointer = json.loads(backend_command("set-agent-queue-pointer.ts", "--read").strip().splitlines()[-1])
    if pointer != job["priorPointer"]:
        # Ignore metadata fields in the native pointer response, but require its routing identity.
        if not pointer or any(pointer.get(k) != job["priorPointer"].get(k) for k in ("taskQueue", "surfaceHash")):
            raise ValueError("Live routing changed; candidate cannot be abandoned")
    queue = deployment_queue(job["identity"], ledger.job_id)
    initialize_queue(job, ledger, retirement=True)
    backend_command("retire-agent-queue.ts", "--begin", "--queue", queue, "--owner", ledger.job_id)
    backend_command("retire-agent-queue.ts", "--retire", "--queue", queue, "--owner", ledger.job_id)
    native = native_factory(job["identity"], ledger)
    restored = [
        native.abandon(expected, job["priorPointer"]) for expected in job["evidence"]["PREPARING"]["candidateRecords"]
    ]
    return ledger.abandon(restored)


if __name__ == "__main__":
    try:
        if sys.argv[1:] not in ([], ["--abort"]):
            raise ValueError("Only the explicit --abort operation is supported")
        result = abandon() if sys.argv[1:] else run()
        print(json.dumps({"jobId": result["jobId"], "stage": result["stage"]}))
    except PoolCapacityPending as error:
        print(str(error), flush=True)
        raise SystemExit(75)
