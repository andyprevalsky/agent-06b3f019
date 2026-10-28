#!/usr/bin/env python3
"""Run the production pool state machine with native and database boundaries replaced."""

import copy
import importlib.util
import json
import io
import runpy
import threading
from types import SimpleNamespace
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("worker_pool_cutover", ROOT / "scripts/worker_pool_cutover.py")
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)
pool = cutover.pool


def spare(index):
    machine = {
        "id": f"{index:014x}",
        "instance_id": f"version-{index}",
        "state": "created",
        "config": {
            "image": "registry.fly.io/prod:spare",
            "env": {
                "TEMPORAL_WORKER_SURFACE_HASH": pool.SPARE_SURFACE,
                "TEMPORAL_WORKER_BUILD_ID": "pool-bootstrap",
                "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "pool-bootstrap",
                "TEMPORAL_WORKER_POOL_SPARE": "1",
            },
            "metadata": {},
            "rootfs": {"persist": "never"},
        },
    }
    source = pool.record(machine, "prod")
    machine["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(
        {
            "version": 1,
            **{k: source[k] for k in ("app", "id", "instance_id", "config_sha256")},
            "rootfs_disposition": "stateless",
            "evidence_ref": "https://example.test/pool-release",
        }
    )
    machine["config"]["metadata"][pool.POOL_KEY] = json.dumps(
        {
            "version": 1,
            "phase": "idle",
            "origin": "preallocated",
            "source": source,
            "drained_queue": "navi-agent-tasks@" + pool.SPARE_SURFACE,
            "retired_by": {"build": "pool-bootstrap", "token": "pool-bootstrap"},
        }
    )
    return machine


class Ledger:
    job_id = "new-deployment"
    owner_id = "controller-one"

    def __init__(self):
        self.job = {
            "jobId": self.job_id,
            "identity": {
                "app": "prod",
                "sourceCommit": "a" * 40,
                "buildId": "a" * 40,
                "surfaceHash": "b" * 12,
                "attempt": "attempt-one",
                "imageRef": "registry.fly.io/prod@sha256:" + "d" * 64,
            },
            "stage": "QUEUED",
            "candidateMachineIds": [],
            "evidence": {},
        }
        self.transitions = []
        self.released = []

    def read(self):
        return copy.deepcopy(self.job)

    def assert_owned(self):
        return None

    def assert_mutable(self, machine_id):
        if machine_id in {
            row["id"]
            for row in self.job.get("evidence", {}).get("PREPARING", {}).get("retainedRouteMismatchRecords", [])
        }:
            raise ValueError("Machine has a durable mutation hold")

    def retained_status(self):
        return {"held": True}

    def prepare(self, pointer, ids, evidence):
        self.job.update(
            stage="PREPARING",
            priorPointer=pointer,
            candidateMachineIds=ids,
            evidence={"PREPARING": copy.deepcopy(evidence)},
        )
        return self.read()

    def stage(self, prior, following, evidence):
        assert self.job["stage"] == prior
        self.transitions.append((prior, following))
        self.job["stage"] = following
        self.job["evidence"].update(evidence)
        return self.read()

    def release(self, previous_job, machines, evidence):
        self.released.append((previous_job, machines, evidence))

    def abandon(self, machines):
        self.job["stage"] = "ABORTED"
        self.job["evidence"]["abandonedMachines"] = machines
        return self.read()


class Native:
    app = "prod"

    def __init__(self, count=8, managed=False):
        self.machines = [spare(i + 1) for i in range(count)]
        old = spare(99)
        old["state"] = "started"
        old["config"]["env"]["TEMPORAL_WORKER_SURFACE_HASH"] = "old"
        old["config"]["metadata"] = {}
        if managed:
            old["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"] = "navi-agent-tasks@old"
            old["config"]["metadata"][pool.POOL_KEY] = json.dumps(
                {
                    "phase": "active",
                    "job": "old-deployment",
                }
            )
        self.machines.append(old)
        self.prepared = set()
        self.retired = []
        self.fail_after_prepare = False
        self.health_reads = 0
        self.fail_final_health = False
        self.fail_health_after = None

    def list(self):
        return copy.deepcopy(self.machines)

    def prepare(self, expected, previous):
        self.prepared.add(expected["id"])
        if self.fail_after_prepare:
            self.fail_after_prepare = False
            raise RuntimeError("native response was lost after configuration")

    def observe_route(self, expected, expected_queue):
        return {
            "machineId": expected["id"],
            "instanceId": expected["instanceId"],
            "configSHA256": expected["configSHA256"],
            "pid": 635,
            "started": 100.0,
            "namespace": "fixture.namespace",
            "expectedQueue": expected_queue,
            "actualQueue": expected_queue,
            "buildId": "old-build",
            "surfaceHash": "old",
            "attempt": "old-attempt",
            "identity": "635@fixture-host",
            "autoscalerActuate": "0",
        }

    def native_pollers_ready(self, machine_ids):
        return True

    def revalidate_retained_routes(self, records):
        self.revalidated = copy.deepcopy(records)

    def healthy(self, machine_id):
        self.health_reads += 1
        if self.fail_health_after is not None and self.health_reads > self.fail_health_after:
            return False
        return not self.fail_final_health or self.health_reads <= 8

    def retire(self, expected, previous):
        self.retired.append(expected["id"])
        return expected

    def abandon(self, expected, previous):
        self.retired.append(expected["id"])
        return expected


class WorkerPoolCutoverTests(unittest.TestCase):
    def setUp(self):
        self.commands = []
        self.pointer = {"taskQueue": "navi-agent-tasks@old", "surfaceHash": "old"}

    def command(self, script, *args, timeout=60):
        self.commands.append((script, args))
        if "--read" in args:
            return json.dumps(self.pointer)
        return ""

    def run_job(self, ledger, native):
        with (
            patch.object(cutover, "backend_command", self.command),
            patch.object(cutover.subprocess, "run", side_effect=AssertionError("Unexpected unmocked subprocess")),
        ):
            return cutover.run(ledger, lambda identity, owner: native)

    def runtime_native(self):
        ledger = Ledger()
        native = cutover.NativePool(ledger.job["identity"], ledger)
        value = spare(1)
        value["state"] = "started"
        queue = cutover.deployment_queue(native.identity, ledger.job_id)
        value["config"]["image"] = native.identity["imageRef"]
        value["config"]["env"].update(
            TEMPORAL_WORKER_SURFACE_HASH=native.identity["surfaceHash"],
            TEMPORAL_WORKER_BUILD_ID=native.identity["buildId"],
            TEMPORAL_WORKER_DEPLOYMENT_TOKEN=native.identity["attempt"],
            TEMPORAL_WORKER_POOL_QUEUE=queue,
            AUTOSCALER_ACTUATE="0",
            PEOPLE_CREDENTIAL_BROKER_URL="https://navi-j9a9.onrender.com",
        )
        value["config"]["init"] = {
            "exec": ["/usr/bin/env", "TEMPORAL_TASK_QUEUE=" + queue.rsplit("@", 1)[0], "python", "worker.py"]
        }
        value["config"]["metadata"][pool.POOL_KEY] = json.dumps(
            {
                "job": ledger.job_id,
                "phase": "active",
                "build": native.identity["buildId"],
                "token": native.identity["attempt"],
                "configSHA256": pool.config_digest(value["config"]),
            }
        )
        health = {
            "healthy": True,
            "phase": "running",
            "started_at": "fixture-boot",
            "build_id": native.identity["buildId"],
            "runtime": {
                "pid": 635,
                "hostname": "fixture-host",
                "identity": "635@fixture-host",
                "started": 100.0,
                "pidAfter": 635,
                "startedAfter": 100.0,
                "queue": queue,
                "baseQueue": queue.rsplit("@", 1)[0],
                "surfaceHash": native.identity["surfaceHash"],
                "poolQueue": queue,
                "namespace": "fixture.namespace",
                "autoscalerActuate": "0",
                "buildId": native.identity["buildId"],
                "attempt": native.identity["attempt"],
            },
        }
        return native, value, health

    def test_runtime_queue_identity_is_required_even_when_native_config_and_health_match(self):
        for field, wrong in (
            ("queue", "navi-agent-tasks@wrong"),
            ("namespace", "foreign"),
            ("pidAfter", 636),
            ("identity", "foreign"),
            ("startedAfter", 101.0),
            ("buildId", "stale"),
            ("surfaceHash", "foreign"),
            ("autoscalerActuate", "1"),
            ("attempt", "foreign"),
        ):
            with self.subTest(field=field):
                native, value, health = self.runtime_native()
                health["runtime"][field] = wrong
                client = type("Client", (), {"request": lambda *args: {"exit_code": 0, "stdout": json.dumps(health)}})()
                with (
                    patch.object(native, "get", return_value=value),
                    patch.object(native, "client", return_value=client),
                    patch.dict(cutover.os.environ, {"TEMPORAL_NAMESPACE": "fixture.namespace"}),
                ):
                    self.assertFalse(native.healthy(value["id"]))

    def test_runtime_queue_positive_and_native_version_change(self):
        native, value, health = self.runtime_native()
        client = type("Client", (), {"request": lambda *args: {"exit_code": 0, "stdout": json.dumps(health)}})()
        with (
            patch.object(native, "get", return_value=value),
            patch.object(native, "client", return_value=client),
            patch.dict(cutover.os.environ, {"TEMPORAL_NAMESPACE": "fixture.namespace"}),
        ):
            self.assertTrue(native.healthy(value["id"]))
        changed = copy.deepcopy(value)
        changed["instance_id"] = "foreign-native-version"
        with (
            patch.object(native, "get", side_effect=[value, changed]),
            patch.object(native, "client", return_value=client),
            patch.dict(cutover.os.environ, {"TEMPORAL_NAMESPACE": "fixture.namespace"}),
        ):
            self.assertFalse(native.healthy(value["id"]))

    def test_matching_old_metadata_without_startup_binding_is_not_a_target(self):
        native, value, _ = self.runtime_native()
        value["config"]["init"] = {}
        marker = pool.metadata(value, pool.POOL_KEY)
        marker["configSHA256"] = pool.config_digest(value["config"])
        value["config"]["metadata"][pool.POOL_KEY] = json.dumps(marker)
        self.assertFalse(native.target(value))
        with patch.object(native, "get", return_value=value), patch.object(native, "client") as client:
            self.assertFalse(native.healthy(value["id"]))
            client.assert_not_called()

    def test_actual_probe_binds_health_listener_and_rejects_ambiguous_or_foreign_process(self):
        native, _, health = self.runtime_native()
        runtime = health["runtime"]
        environment = {
            "TEMPORAL_TASK_QUEUE": runtime["baseQueue"],
            "TEMPORAL_WORKER_SURFACE_HASH": runtime["surfaceHash"],
            "TEMPORAL_WORKER_POOL_QUEUE": runtime["poolQueue"],
            "TEMPORAL_NAMESPACE": runtime["namespace"],
            "AUTOSCALER_ACTUATE": "0",
            "TEMPORAL_WORKER_BUILD_ID": runtime["buildId"],
            "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": runtime["attempt"],
        }
        resolver = runpy.run_path(str(ROOT / "agents/helpers/worker_generation.py"))
        for fault in ("", "ambiguous", "foreign-command", "process-replaced"):
            with self.subTest(fault=fault):
                calls = []
                process = SimpleNamespace(
                    pid=635,
                    create_time=lambda: 100.0,
                    environ=lambda: environment,
                    cmdline=lambda: ["python", "foreign.py" if fault == "foreign-command" else "worker.py"],
                )

                def connections(**kwargs):
                    calls.append(True)
                    pids = [635, 636] if fault == "ambiguous" else [635]
                    return [SimpleNamespace(pid=pid, status="LISTEN", laddr=SimpleNamespace(port=8080)) for pid in pids]

                def get_process(pid):
                    if fault == "process-replaced" and len(calls) > 1:
                        return SimpleNamespace(pid=636, create_time=lambda: 101.0)
                    return process

                fake_psutil = SimpleNamespace(CONN_LISTEN="LISTEN", net_connections=connections, Process=get_process)
                captured = io.StringIO()
                with (
                    patch.dict(sys.modules, {"psutil": fake_psutil}),
                    patch.object(runpy, "run_path", return_value=resolver),
                    patch("socket.gethostname", return_value="fixture-host"),
                ):
                    with (
                        patch(
                            "urllib.request.urlopen",
                            side_effect=lambda *args, **kwargs: io.BytesIO(json.dumps(health).encode()),
                        ),
                        patch("sys.stdout", captured),
                    ):
                        if fault in ("ambiguous", "foreign-command"):
                            with self.assertRaises(ValueError):
                                exec(compile(cutover.RUNTIME_QUEUE_PROBE, "<runtime-queue-probe>", "exec"), {})
                            continue
                        exec(compile(cutover.RUNTIME_QUEUE_PROBE, "<runtime-queue-probe>", "exec"), {})
                observed = json.loads(captured.getvalue())
                with patch.dict(cutover.os.environ, {"TEMPORAL_NAMESPACE": "fixture.namespace"}):
                    self.assertEqual(
                        cutover.runtime_queue_matches(observed, native.identity, native.ledger.job_id), fault == ""
                    )

    def test_native_mutation_hold_precedes_effect_but_exact_runtime_probe_remains_read_only(self):
        ledger = Ledger()
        ledger.assert_mutable = lambda mid: (_ for _ in ()).throw(ValueError("held"))
        native = cutover.NativePool(ledger.job["identity"], ledger)
        with patch.object(pool.Fly, "request", return_value={}) as request:
            client = native.client("held-machine")
            with self.assertRaisesRegex(ValueError, "held"):
                client.request("POST", "/stop")
            with self.assertRaisesRegex(ValueError, "held"):
                client.request("POST", "/exec", {"command": ["arbitrary"]})
            request.assert_not_called()
            client.request("GET")
            client.request(
                "POST", "/exec", {"command": ["python", "-I", "-B", "-c", cutover.RUNTIME_QUEUE_PROBE], "timeout": 10}
            )
            self.assertEqual(request.call_count, 2)

    def test_unreachable_host_null_config_blocks_preparation_and_retirement_cleanly(self):
        # Fly returns "config": null for a Machine on an unreachable host (2026-10-26).
        native, value, _ = self.runtime_native()
        broken = {**copy.deepcopy(value), "config": None}
        self.assertFalse(native.target(broken))
        with patch.object(native, "get", return_value=broken):
            with self.assertRaisesRegex(ValueError, "config is unavailable"):
                native.prepare(cutover.machine_identity(value), {"taskQueue": "q", "surfaceHash": "old"})
        value["state"] = "stopped"
        expected = {**cutover.machine_identity(value), "managedJobId": "old"}

        class Client:
            @contextmanager
            def lease(self):
                yield

            def request(self, method, suffix="", data=None):
                if method == "GET":
                    return {**copy.deepcopy(value), "config": None}
                raise AssertionError((method, suffix))

        with patch.object(native, "get", return_value=copy.deepcopy(value)), patch.object(
            native, "client", return_value=Client()
        ):
            with self.assertRaisesRegex(ValueError, "Old bank changed before its certified retirement"):
                native.retire(expected, {"taskQueue": "expected", "surfaceHash": "old"})

    def test_null_nested_config_sections_are_not_targets_and_block_preparation_cleanly(self):
        # A partially unavailable Machine can carry "init" or "env" as null inside a dict config.
        native, value, _ = self.runtime_native()
        self.assertTrue(native.target(value))
        for section in ("init", "env", "metadata"):
            broken = copy.deepcopy(value)
            broken["config"][section] = None
            self.assertFalse(native.target(broken), section)
            with patch.object(native, "get", return_value=broken), patch.object(native, "operation") as operation:
                with self.assertRaisesRegex(ValueError, "config is unavailable"):
                    native.prepare(cutover.machine_identity(value), {"taskQueue": "q", "surfaceHash": "old"})
                operation.assert_not_called()

    def test_matched_bank_retirement_checks_runtime_before_lease_or_stop(self):
        native, value, _ = self.runtime_native()
        expected = {**cutover.machine_identity(value), "managedJobId": "old"}
        with (
            patch.object(native, "get", return_value=value),
            patch.object(native, "observe_route", return_value={"actualQueue": "foreign"}),
            patch.object(native, "client") as client,
        ):
            with self.assertRaisesRegex(ValueError, "different actual queue"):
                native.retire(expected, {"taskQueue": "expected", "surfaceHash": "old"})
            client.assert_not_called()

    def test_initial_partial_native_pollers_wait_in_existing_budget_then_complete(self):
        ledger, native = Ledger(), Native()
        with (
            patch.object(native, "native_pollers_ready", side_effect=[False, True, True, True]),
            patch.object(cutover.time, "sleep") as sleep,
        ):
            result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        sleep.assert_called_once_with(5)

    def test_native_poller_transport_error_is_not_converted_to_not_ready(self):
        ledger, native = Ledger(), Native()
        with (
            patch.object(native, "native_pollers_ready", side_effect=RuntimeError("transport")),
            patch.object(cutover.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "transport"):
                self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "PREPARING")
        sleep.assert_not_called()
        self.assertFalse(
            any(name == "set-agent-queue-pointer.ts" and "--queue" in args for name, args in self.commands)
        )

    def mismatched_bank(self):
        ledger, native = Ledger(), Native(managed=True)
        old = native.machines[-1]
        old_queue = "navi-agent-tasks-pool-" + "c" * 12 + "@" + "d" * 12
        old["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"] = old_queue
        self.pointer = {"taskQueue": old_queue, "surfaceHash": "d" * 12, "updatedBy": "old-deployment"}
        for index in range(7):
            extra = copy.deepcopy(old)
            extra["id"] = f"{100 + index:014x}"
            native.machines.append(extra)
        return ledger, native

    def test_positive_route_mismatch_holds_old_managed_bank_without_retirement(self):
        ledger, native = self.mismatched_bank()
        original = native.observe_route

        def mismatch(expected, expected_queue):
            return {**original(expected, expected_queue), "actualQueue": "navi-agent-tasks@" + "d" * 12}

        with patch.object(native, "observe_route", side_effect=mismatch):
            result = self.run_job(ledger, native)
        proof = result["evidence"]["PREPARING"]["retainedRouteMismatchRecords"]
        self.assertEqual(len(proof), 8)
        self.assertEqual(result["evidence"]["priorDisposition"], "RETAINED_ROUTE_MISMATCH")
        self.assertEqual(set(result["evidence"]["retainedRouteMismatchMachineIds"]), {row["id"] for row in proof})
        self.assertEqual(native.revalidated, proof)
        self.assertFalse(native.retired)
        self.assertFalse(ledger.released)
        self.assertEqual(
            [
                args[0]
                for name, args in self.commands
                if name == "retire-agent-queue.ts" and args[0] in ("--begin", "--retire")
            ],
            ["--begin", "--retire"],
        )

    def test_actual_native_poller_payload_uses_current_target_versions_and_exact_identity_set(self):
        native, value, _ = self.runtime_native()
        machines = {}
        for index in range(8):
            current = copy.deepcopy(value)
            current["id"] = f"{index + 1:014x}"
            current["instance_id"] = f"target-version-{index}"
            identity = f"{635 + index}@fixture-host"
            machines[current["id"]] = current
            native.runtime_observations[current["id"]] = {
                "identity": identity,
                "machineRecord": {**cutover.machine_identity(current), "identity": identity},
            }
        ids = list(machines)
        captured = []

        def verify(identities, records):
            captured.append((identities, records))
            return {
                "ready": True,
                "queue": cutover.deployment_queue(native.identity, native.ledger.job_id),
                "identities": identities,
            }

        with (
            patch.object(native, "get", side_effect=lambda mid: copy.deepcopy(machines[mid])),
            patch.object(native.ledger, "verify_native_pollers", create=True, side_effect=verify),
        ):
            self.assertTrue(native.native_pollers_ready(ids))
        self.assertEqual(len(captured[0][0]), 8)
        self.assertEqual(
            {record["instanceId"] for record in captured[0][1]}, {f"target-version-{index}" for index in range(8)}
        )
        for wrong in (
            {"ready": False, "queue": "foreign"},
            {
                "ready": True,
                "queue": cutover.deployment_queue(native.identity, native.ledger.job_id),
                "identities": ["foreign"],
            },
            {"ready": "false"},
        ):
            with (
                self.subTest(wrong=wrong),
                patch.object(native, "get", side_effect=lambda mid: copy.deepcopy(machines[mid])),
                patch.object(native.ledger, "verify_native_pollers", create=True, return_value=wrong),
                self.assertRaises(ValueError),
            ):
                native.native_pollers_ready(ids)
        machines[ids[0]]["instance_id"] = "changed-after-health"
        with (
            patch.object(native, "get", side_effect=lambda mid: copy.deepcopy(machines[mid])),
            patch.object(native.ledger, "verify_native_pollers", create=True) as verify_mock,
            self.assertRaisesRegex(ValueError, "changed"),
        ):
            native.native_pollers_ready(ids)
        verify_mock.assert_not_called()

    def test_retained_route_revalidation_keeps_original_proof_and_rejects_changed_pid(self):
        native, _, _ = self.runtime_native()
        record = {"id": "old", "routeEvidence": {"expectedQueue": "expected", "actualQueue": "shared", "pid": 635}}
        original = copy.deepcopy(record)
        with (
            patch.object(native, "observe_route", return_value={**record["routeEvidence"], "pid": 636}),
            self.assertRaisesRegex(ValueError, "changed"),
        ):
            native.revalidate_retained_routes([record])
        self.assertEqual(record, original)

    def test_retained_physical_bank_cannot_ignore_unretired_declared_queue(self):
        ledger, native = self.mismatched_bank()
        original_route = native.observe_route

        def mismatch(expected, queue):
            return {**original_route(expected, queue), "actualQueue": "navi-agent-tasks@" + "d" * 12}

        original_command = self.command

        def command(script, *args, **_kwargs):
            if script == "retire-agent-queue.ts" and "--retire" in args:
                raise cutover.subprocess.CalledProcessError(1, [script, *args])
            return original_command(script, *args)

        self.command = command
        with (
            patch.object(native, "observe_route", side_effect=mismatch),
            patch.object(cutover.time, "monotonic", side_effect=[0, 0, 2701]),
            patch.object(cutover.time, "sleep") as sleep,
        ):
            with self.assertRaises(cutover.PoolCapacityPending):
                self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "DRAINING")
        self.assertFalse(native.retired)
        self.assertFalse(ledger.released)
        sleep.assert_not_called()

    def test_actual_route_observation_distinguishes_runtime_mismatch_from_unknown(self):
        native, value, health = self.runtime_native()
        expected_queue = cutover.deployment_queue(native.identity, native.ledger.job_id)
        health["runtime"]["baseQueue"] = "navi-agent-tasks"
        health["runtime"]["queue"] = "navi-agent-tasks@" + native.identity["surfaceHash"]
        expected = cutover.machine_identity(value)
        client = type("Client", (), {"request": lambda *args: {"exit_code": 0, "stdout": json.dumps(health)}})()
        with (
            patch.object(native, "get", return_value=value),
            patch.object(native, "client", return_value=client),
            patch.dict(cutover.os.environ, {"TEMPORAL_NAMESPACE": "fixture.namespace"}),
        ):
            proof = native.observe_route(expected, expected_queue)
            self.assertEqual(proof["actualQueue"], health["runtime"]["queue"])
            self.assertEqual(proof["expectedQueue"], expected_queue)
            self.assertEqual(proof["autoscalerActuate"], "0")
            health["runtime"]["autoscalerActuate"] = "1"
            with self.assertRaisesRegex(ValueError, "unknown"):
                native.observe_route(expected, expected_queue)

    def unhealthy_candidate_retirement(
        self, certificate_error=False, managed_job=None, published=False, stage="PREPARING"
    ):
        native, value, _ = self.runtime_native()
        queue = cutover.deployment_queue(native.identity, native.ledger.job_id)
        previous = {"taskQueue": queue, "surfaceHash": native.identity["surfaceHash"]}
        live = {"taskQueue": "navi-agent-tasks@old", "surfaceHash": "old"}
        proof = pool.metadata(value, pool.CUSTODY_KEY)
        proof.update(
            {
                key: item
                for key, item in pool.record(value, "prod").items()
                if key in ("app", "id", "instance_id", "config_sha256")
            }
        )
        value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
        expected = {**cutover.machine_identity(value), "managedJobId": managed_job or native.ledger.job_id}
        effects = []
        self.retirement_effects = effects

        class Client:
            def assert_managed_mutable(self):
                native.ledger.assert_mutable(value["id"])

            @contextmanager
            def lease(self):
                effects.append("lease")
                yield

            def request(self, method, suffix="", data=None):
                if method == "GET":
                    return copy.deepcopy(value)
                effects.append(suffix)
                if suffix.startswith("/metadata/"):
                    value["config"]["metadata"][suffix.rsplit("/", 1)[1]] = data["value"]
                elif suffix == "/stop":
                    value["state"] = "stopped"
                else:
                    raise AssertionError((method, suffix))
                return {}

        native.ledger.job.update(stage=stage, candidateMachineIds=[value["id"]], priorPointer=live)

        def certificate(script, *args):
            if script == "set-agent-queue-pointer.ts":
                return json.dumps(previous if published else live)
            self.assertEqual((script, args), ("retire-agent-queue.ts", ("--verify-retired", "--queue", queue)))
            if certificate_error:
                raise ValueError("candidate queue not certified")
            return ""

        with (
            patch.object(native, "get", side_effect=lambda mid: copy.deepcopy(value)),
            patch.object(native, "client", return_value=Client()),
            patch.object(
                native, "observe_route", side_effect=ValueError("unhealthy worker has no HTTP listener")
            ) as route,
            patch.object(cutover, "backend_command", side_effect=certificate) as verify,
        ):
            result = native.retire(expected, previous, live)
        return result, effects, route.call_count, verify.call_count

    def test_unpublished_owned_unhealthy_candidate_can_retire_only_after_queue_certificate(self):
        result, effects, routes, certificates = self.unhealthy_candidate_retirement()
        self.assertEqual(result["id"], "00000000000001")
        self.assertIn("/stop", effects)
        self.assertEqual(routes, 0)
        self.assertEqual(certificates, 2)

    def test_unpublished_retirement_rejects_missing_certificate_published_or_foreign_bank(self):
        for options, error in (
            ({"certificate_error": True}, "not certified"),
            ({"published": True}, "published"),
            ({"managed_job": "foreign"}, "unpublished candidate"),
            ({"stage": "ACTIVATED"}, "unpublished candidate"),
        ):
            with self.subTest(options=options):
                with self.assertRaisesRegex(ValueError, error):
                    self.unhealthy_candidate_retirement(**options)
                self.assertEqual(self.retirement_effects, [])

    def test_started_unknown_and_partial_stopped_mismatch_block_preparation(self):
        for state, unknown in (("started", True), ("stopped", False), ("replacing", False)):
            with self.subTest(state=state, unknown=unknown):
                ledger, native = self.mismatched_bank()
                native.machines[8]["state"] = state
                original = native.observe_route

                def mismatch(record, queue):
                    return {**original(record, queue), "actualQueue": "navi-agent-tasks@wrong"}

                context = patch.object(
                    native, "observe_route", side_effect=ValueError("unknown runtime") if unknown else mismatch
                )
                with context, self.assertRaises(ValueError):
                    self.run_job(ledger, native)
                self.assertEqual(ledger.job["stage"], "QUEUED")
                self.assertFalse(native.prepared)
                self.assertFalse(native.retired)

    def test_stopped_old_managed_bank_needs_no_runtime_health_probe(self):
        ledger, native = self.mismatched_bank()
        for machine in native.machines:
            if machine["id"] not in {row["id"] for row in native.machines[:8]}:
                machine["state"] = "stopped"
        with patch.object(
            native, "observe_route", side_effect=AssertionError("Stopped workers have no health server")
        ) as observe:
            result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(len(native.retired), 8)
        observe.assert_not_called()

    def test_incomplete_bank_waits_without_mutating_any_machine(self):
        ledger, native = Ledger(), Native(count=7)
        with self.assertRaises(cutover.PoolCapacityPending):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "QUEUED")
        self.assertFalse(native.prepared)
        self.assertFalse(native.retired)

    def test_old_archive_is_not_selected_for_a_repeatable_stateless_bank(self):
        ledger, native = Ledger(), Native()
        machine = native.machines[0]
        custody = pool.metadata(machine, pool.CUSTODY_KEY)
        custody["rootfs_disposition"] = "archived"
        machine["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(custody)
        with self.assertRaises(cutover.PoolCapacityPending):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "QUEUED")
        self.assertFalse(native.prepared)
        self.assertFalse(native.retired)

    def test_incomplete_managed_predecessor_cannot_be_mislabeled_as_legacy_retention(self):
        ledger, native = Ledger(), Native(managed=True)
        self.pointer = {
            "taskQueue": "navi-agent-tasks-pool-0123456789ab@" + "c" * 12,
            "surfaceHash": "c" * 12,
            "updatedBy": "old-deployment",
        }
        native.machines[-1]["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"] = self.pointer["taskQueue"]
        with self.assertRaisesRegex(ValueError, "complete native ownership"):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "QUEUED")
        self.assertFalse(native.prepared)

    def test_crashed_preparation_resumes_the_same_reserved_bank(self):
        ledger, native = Ledger(), Native()
        native.fail_after_prepare = True
        with self.assertRaisesRegex(RuntimeError, "response was lost"):
            self.run_job(ledger, native)
        reserved = ledger.job["candidateMachineIds"][:]
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(result["candidateMachineIds"], reserved)
        self.assertEqual(native.prepared, set(reserved))

    def test_legacy_workers_remain_served_and_are_never_released_as_spares(self):
        ledger, native = Ledger(), Native()
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(result["evidence"]["retainedLegacyMachineIds"], [f"{99:014x}"])
        self.assertFalse(native.retired)
        self.assertFalse(ledger.released)
        self.assertEqual(len(result["evidence"]["activeMachineIds"]), 8)

    def test_fresh_health_is_required_immediately_before_switching(self):
        ledger, native = Ledger(), Native()
        native.fail_final_health = True
        with self.assertRaisesRegex(ValueError, "changed before pointer"):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "READY")
        self.assertFalse(any("--expected-current-queue" in args for _, args in self.commands))

    def test_lost_pointer_reply_resumes_the_same_job_without_repreparing_its_bank(self):
        ledger, native = Ledger(), Native()
        flipped = False

        def command(script, *args, **_kwargs):
            nonlocal flipped
            if script == "set-agent-queue-pointer.ts" and "--expected-current-queue" in args:
                self.pointer = {
                    "taskQueue": cutover.deployment_queue(ledger.job["identity"], ledger.job_id),
                    "surfaceHash": ledger.job["identity"]["surfaceHash"],
                }
                if not flipped:
                    flipped = True
                    raise RuntimeError("Pointer commit succeeded but its reply was lost")
                return ""
            return self.command(script, *args)

        with patch.object(cutover, "backend_command", command):
            with self.assertRaisesRegex(RuntimeError, "reply was lost"):
                cutover.run(ledger, lambda identity, owner: native)
            self.assertEqual(ledger.job["stage"], "READY")
            prepared = native.prepared.copy()
            result = cutover.run(ledger, lambda identity, owner: native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(native.prepared, prepared)
        self.assertEqual(self.pointer["taskQueue"], cutover.deployment_queue(ledger.job["identity"], ledger.job_id))

    def test_draining_broadcasts_generation_handoff_from_the_prior_queue_once_per_stage_entry(self):
        ledger, native = Ledger(), Native(managed=True)
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        live = cutover.deployment_queue(ledger.job["identity"], ledger.job_id)
        broadcasts = [args for name, args in self.commands if name == "broadcast-generation-handoff.ts"]
        self.assertEqual(
            broadcasts,
            [("--from-queue", "navi-agent-tasks@old", "--live-queue", live, "--deadline-ms", "120000")],
        )
        names = [name for name, _ in self.commands]
        flip = next(
            i for i, (name, args) in enumerate(self.commands)
            if name == "set-agent-queue-pointer.ts" and "--expected-current-queue" in args
        )
        self.assertLess(flip, names.index("broadcast-generation-handoff.ts"), "broadcast must follow the flip")
        self.assertLess(names.index("broadcast-generation-handoff.ts"), names.index("retire-agent-queue.ts"))

    def test_failed_generation_handoff_broadcast_never_blocks_the_deploy(self):
        ledger, native = Ledger(), Native(managed=True)

        def command(script, *args, timeout=60):
            if script == "broadcast-generation-handoff.ts":
                self.commands.append((script, args))
                raise cutover.subprocess.CalledProcessError(1, script)
            return self.command(script, *args)

        with (
            patch.object(cutover, "backend_command", command),
            patch.object(cutover.subprocess, "run", side_effect=AssertionError("Unexpected unmocked subprocess")),
        ):
            result = cutover.run(ledger, lambda identity, owner: native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(native.retired, [f"{99:014x}"])

    def test_managed_old_bank_is_certified_before_any_stop_or_release(self):
        ledger, native = Ledger(), Native(managed=True)
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(native.retired, [f"{99:014x}"])
        self.assertEqual(ledger.released[0][0], "old-deployment")
        self.assertTrue(any("--begin" in args for _, args in self.commands))
        self.assertFalse(result["evidence"]["retainedLegacyMachineIds"])

    def test_new_bank_health_loss_after_queue_retirement_preserves_old_machines(self):
        ledger, native = Ledger(), Native(managed=True)
        native.fail_health_after = 24
        with self.assertRaisesRegex(cutover.PoolCapacityPending, "remaining old workers"):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "DRAINING")
        self.assertFalse(native.retired)
        self.assertFalse(ledger.released)
        native.fail_health_after = None
        self.assertEqual(self.run_job(ledger, native)["stage"], "SUCCEEDED")

    def managed_bank_native(self):
        """Eight released spares replacing an eight-Machine managed bank."""
        native = Native(managed=True)
        template = native.machines.pop()
        for index in range(8):
            old = copy.deepcopy(template)
            old["id"] = f"{100 + index:014x}"
            old["instance_id"] = f"old-version-{index}"
            native.machines.append(old)
        return native

    def test_bank_machines_are_prepared_and_retired_concurrently(self):
        # A serial controller cannot pass an eight-party barrier: the first
        # Machine would wait for seven operations that have not started.
        ledger, native = Ledger(), self.managed_bank_native()
        prepare_barrier = threading.Barrier(8, timeout=5)
        retire_barrier = threading.Barrier(8, timeout=5)
        prepare, retire = native.prepare, native.retire

        def concurrent_prepare(expected, previous):
            prepare(expected, previous)
            if ledger.job["stage"] == "PREPARING":
                prepare_barrier.wait()

        def concurrent_retire(expected, previous):
            retire_barrier.wait()
            return retire(expected, previous)

        native.prepare, native.retire = concurrent_prepare, concurrent_retire
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(len(native.prepared), 8)
        old_ids = [f"{100 + index:014x}" for index in range(8)]
        self.assertEqual(sorted(native.retired), old_ids)
        self.assertEqual([row["id"] for row in result["evidence"]["retiredMachines"]], old_ids)
        self.assertEqual(sorted(ledger.released[0][1]), old_ids)

    def test_concurrent_preparation_failure_completes_siblings_and_resumes_same_bank(self):
        ledger, native = Ledger(), Native()
        prepare, failed = native.prepare, []

        def flaky_prepare(expected, previous):
            if not failed and expected["id"] == ledger.job["candidateMachineIds"][3]:
                failed.append(expected["id"])
                raise RuntimeError("native response was lost after configuration")
            prepare(expected, previous)

        native.prepare = flaky_prepare
        with self.assertRaisesRegex(RuntimeError, "response was lost"):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "PREPARING")
        reserved = ledger.job["candidateMachineIds"][:]
        self.assertEqual(native.prepared, set(reserved) - set(failed))
        result = self.run_job(ledger, native)
        self.assertEqual(result["stage"], "SUCCEEDED")
        self.assertEqual(result["candidateMachineIds"], reserved)
        self.assertEqual(native.prepared, set(reserved))

    def test_concurrent_retirement_failure_releases_nothing_and_hard_error_wins(self):
        ledger, native = Ledger(), self.managed_bank_native()
        retire = native.retire

        def failing_retire(expected, previous):
            if expected["id"] == f"{101:014x}":
                raise cutover.PoolCapacityPending("Certified old bank is still stopping")
            if expected["id"] == f"{106:014x}":
                raise ValueError("Old bank changed before its certified retirement")
            return retire(expected, previous)

        native.retire = failing_retire
        with self.assertRaisesRegex(ValueError, "changed before its certified retirement"):
            self.run_job(ledger, native)
        self.assertEqual(ledger.job["stage"], "DRAINING")
        self.assertEqual(len(native.retired), 6)
        self.assertFalse(ledger.released)
        native.retire = retire
        self.assertEqual(self.run_job(ledger, native)["stage"], "SUCCEEDED")
        self.assertEqual(len(ledger.released[0][1]), 8)

    def test_unhealthy_serving_bank_retires_no_old_machine(self):
        ledger, native = Ledger(), self.managed_bank_native()
        native.fail_health_after = 24
        with self.assertRaisesRegex(cutover.PoolCapacityPending, "remaining old workers"):
            self.run_job(ledger, native)
        self.assertFalse(native.retired)
        self.assertFalse(ledger.released)

    def test_every_deployment_has_a_stable_distinct_queue_even_for_identical_code(self):
        identity = Ledger().job["identity"]
        first = cutover.deployment_queue(identity, "first")
        self.assertEqual(first, cutover.deployment_queue(identity, "first"))
        self.assertNotEqual(first, cutover.deployment_queue(identity, "second"))
        self.assertTrue(first.endswith("@" + identity["surfaceHash"]))

    def test_native_committed_update_recovers_custody_before_start_without_rewriting_image(self):
        ledger = Ledger()
        native = cutover.NativePool(ledger.job["identity"], ledger)
        value = spare(1)
        expected = cutover.machine_identity(value)
        updates = []

        class Client:
            def assert_managed_mutable(self):
                ledger.assert_mutable(value["id"])

            @contextmanager
            def lease(self):
                yield

            def request(self, method, suffix="", data=None):
                if method == "GET":
                    return copy.deepcopy(value)
                if suffix.startswith("/metadata/"):
                    value["config"]["metadata"][suffix.rsplit("/", 1)[1]] = data["value"]
                elif suffix == "/start":
                    if not pool.custody_ready(value, "prod"):
                        raise AssertionError("Worker started before its custody record was repaired")
                    value["state"] = "started"
                elif suffix == "/stop":
                    value["state"] = "stopped"
                elif suffix == "":
                    self.assert_version(data)
                    value.update(config=copy.deepcopy(data["config"]), instance_id="updated-version")
                    updates.append(copy.deepcopy(data))
                    raise URLError("Reply lost after the native image update committed")
                else:
                    raise AssertionError((method, suffix))
                return {}

            def assert_version(self, data):
                if data["current_version"] != value["instance_id"]:
                    raise AssertionError("Unbound native update")

        previous = {"taskQueue": "navi-agent-tasks@old", "surfaceHash": "old"}
        with patch.object(native, "client", return_value=Client()):
            with self.assertRaises(URLError):
                native.prepare(expected, previous)
            self.assertFalse(pool.custody_ready(value, "prod"))
            native.prepare(expected, previous)
        self.assertEqual(len(updates), 1)
        self.assertEqual(value["state"], "started")
        self.assertTrue(pool.custody_ready(value, "prod"))
        ledger.job.update(stage="PREPARING", candidateMachineIds=[value["id"]], priorPointer=previous)
        with (
            patch.object(native, "client", return_value=Client()),
            patch.object(
                cutover,
                "backend_command",
                side_effect=lambda script, *args: (
                    json.dumps(previous) if script == "set-agent-queue-pointer.ts" else ""
                ),
            ),
        ):
            with patch.object(native, "observe_route", side_effect=lambda record, queue: {"actualQueue": queue}):
                retired = native.abandon(expected, previous)
        self.assertEqual(retired["id"], expected["id"])
        self.assertTrue(pool.eligible(value, "prod", previous["surfaceHash"], previous["taskQueue"]))
        self.assertEqual(len(updates), 1)

    def test_recycled_bank_checks_its_exact_unique_queue_certificate(self):
        ledger, native = Ledger(), Native()
        source_queue = "navi-agent-tasks-pool-previous@" + "c" * 12
        for machine in native.machines[:8]:
            machine["state"] = "stopped"
            machine["config"]["env"].update(
                TEMPORAL_WORKER_SURFACE_HASH="c" * 12,
                TEMPORAL_WORKER_POOL_QUEUE=source_queue,
            )
            marker = pool.metadata(machine, pool.POOL_KEY)
            marker.update(source=pool.record(machine, "prod"), drained_queue=source_queue)
            machine["config"]["metadata"][pool.POOL_KEY] = json.dumps(marker)
            custody = pool.metadata(machine, pool.CUSTODY_KEY)
            custody["config_sha256"] = pool.config_digest(machine["config"])
            machine["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(custody)
        self.run_job(ledger, native)
        checks = [args for _, args in self.commands if "--verify-retired" in args]
        self.assertEqual(checks, [("--verify-retired", "--queue", source_queue)])

    def test_abandonment_requires_unpublished_pointer_and_closed_queue_before_releasing_bank(self):
        ledger, native = Ledger(), Native()
        ledger.prepare(
            self.pointer,
            [m["id"] for m in native.machines[:8]],
            {
                "candidateRecords": [cutover.machine_identity(m) for m in native.machines[:8]],
                "previousRecords": [],
            },
        )
        with patch.object(cutover, "backend_command", self.command):
            result = cutover.abandon(ledger, lambda identity, owner: native)
        self.assertEqual(result["stage"], "ABORTED")
        self.assertEqual(len(native.retired), 8)
        self.assertEqual(
            [args[0] for name, args in self.commands if name == "retire-agent-queue.ts"], ["--begin", "--retire"]
        )

    def test_failed_retirement_certificate_or_live_pointer_keeps_abandoned_candidate_owned(self):
        for failure in ("certificate", "pointer"):
            ledger, native = Ledger(), Native()
            ledger.prepare(
                self.pointer.copy(),
                [m["id"] for m in native.machines[:8]],
                {
                    "candidateRecords": [cutover.machine_identity(m) for m in native.machines[:8]],
                    "previousRecords": [],
                },
            )

            def command(script, *args, **_kwargs):
                if failure == "pointer" and "--read" in args:
                    return json.dumps({"taskQueue": "foreign", "surfaceHash": "foreign"})
                if failure == "certificate" and "--retire" in args:
                    raise RuntimeError("Retirement remains unqualified")
                return self.command(script, *args)

            with patch.object(cutover, "backend_command", command), self.assertRaises((RuntimeError, ValueError)):
                cutover.abandon(ledger, lambda identity, owner: native)
            self.assertEqual(ledger.job["stage"], "PREPARING")
            self.assertFalse(native.retired)


if __name__ == "__main__":
    unittest.main()
