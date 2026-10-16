#!/usr/bin/env python3
"""Run the production pool state machine with native and database boundaries replaced."""

import copy
import importlib.util
import json
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

    def command(self, script, *args):
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

        def command(script, *args):
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
        with patch.object(native, "client", return_value=Client()):
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

            def command(script, *args):
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
