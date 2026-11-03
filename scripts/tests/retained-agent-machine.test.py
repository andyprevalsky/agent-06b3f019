#!/usr/bin/env python3
"""Exercise the real pool helper with only its native HTTP boundary replaced."""

import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("retained_agent_machine", ROOT / "scripts/retained_agent_machine.py")
pool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pool)


def machine():
    return {
        "id": "1234",
        "instance_id": "native-version-1",
        "state": "stopped",
        "name": "immutable-old-name",
        "config": {
            "image": "registry.fly.io/prod:old",
            "env": {
                "TASK_QUEUE": "navi-agent-tasks",
                "TEMPORAL_WORKER_SURFACE_HASH": "old",
                "TEMPORAL_WORKER_BUILD_ID": "old-build",
                "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "old-attempt",
                "OTHER_SETTING": "keep",
            },
            "mounts": [{"volume": "vol-retained", "path": "/evidence"}],
            "guest": {"cpu_kind": "performance", "cpus": 1, "memory_mb": 2048},
            "rootfs": {"persist": "never"},
            "services": [{"internal_port": 8080}],
            "metadata": {"fly_process_group": "app", "unrelated": "keep"},
        },
    }


def args(action, **overrides):
    values = {
        "action": action,
        "app": "prod",
        "id": "1234",
        "live_hash": "live",
        "hash": "new",
        "build": "new-build",
        "token": "new-attempt",
        "image": "registry.fly.io/prod:new",
        "queue": "navi-agent-tasks@new",
        "job": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def custody(value):
    source = pool.record(value, "prod")
    payload = {key: source[key] for key in ("app", "id", "instance_id", "config_sha256")}
    payload.update(
        version=1,
        rootfs_disposition="archived",
        evidence_ref="https://evidence.example/retained-worker",
    )
    value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(payload)


class NativeHTTP:
    def __init__(self, value, app="prod", token="fixture-token"):
        self.machine = copy.deepcopy(value)
        self.requests = []
        self.leased = False
        self.lose_update_ack = False
        self.update_count = 0
        self.on_lease = None
        self.app = app
        self.token = token

    def __call__(self, request, timeout):
        self.requests.append(
            (
                request.method,
                request.full_url,
                json.loads(request.data) if request.data else None,
            )
        )
        base = f"https://api.machines.dev/v1/apps/{self.app}/machines/{self.machine['id']}"
        suffix = request.full_url.removeprefix(base)
        assert request.full_url.startswith(base), "foreign app or ID"
        assert request.get_header("Authorization") == "Bearer " + self.token
        assert timeout == 30
        data = self.requests[-1][2]
        if suffix == "/lease" and request.method == "POST":
            assert not self.leased
            self.leased = True
            if self.on_lease:
                self.on_lease(self.machine)
            return io.BytesIO(json.dumps({"data": {"nonce": "owned-native-nonce"}}).encode())
        assert self.leased and request.get_header("Fly-machine-lease-nonce") == "owned-native-nonce"
        if suffix == "/lease" and request.method == "DELETE":
            self.leased = False
            return io.BytesIO(b"{}")
        if request.method == "GET" and suffix.startswith("/wait?"):
            from urllib.parse import parse_qs, urlsplit

            query = parse_qs(urlsplit(suffix).query)
            assert query["instance_id"] == [self.machine["instance_id"]]
            assert query["state"] == ["stopped"]
            assert 0 < int(query["timeout"][0]) <= 30
            self.machine["state"] = "stopped"
            return io.BytesIO(b'{"ok":true}')
        if request.method == "GET" and not suffix:
            return io.BytesIO(json.dumps(self.machine).encode())
        if request.method == "POST" and suffix in (
            "/metadata/" + pool.POOL_KEY,
            "/metadata/" + pool.CUSTODY_KEY,
        ):
            key = suffix.removeprefix("/metadata/")
            self.machine["config"].setdefault("metadata", {})[key] = data["value"]
            return io.BytesIO(b"")
        if request.method == "POST" and not suffix:
            assert data["current_version"] == self.machine["instance_id"]
            assert data["skip_launch"] is True
            assert data["config"]["mounts"] == self.machine["config"]["mounts"]
            self.machine["config"] = data["config"]
            self.update_count += 1
            self.machine["instance_id"] = f"native-version-{self.update_count + 1}"
            if self.lose_update_ack:
                self.lose_update_ack = False
                raise URLError("fixture lost update acknowledgment")
            return io.BytesIO(json.dumps(self.machine).encode())
        raise AssertionError((request.method, suffix))


class CapturedReplacingHTTP(NativeHTTP):
    """Sanitized native ordering from 2026-10-16 capture: POST new, GET old."""

    def __init__(self, value):
        super().__init__(value)
        self.old = None
        self.waited = False

    def __call__(self, request, timeout):
        base = f"https://api.machines.dev/v1/apps/{self.app}/machines/{self.machine['id']}"
        suffix = request.full_url.removeprefix(base)
        if suffix.startswith("/wait?"):
            self.assert_wait(request, suffix)
            self.waited = True
            return io.BytesIO(b'{"ok":true}')
        if request.method == "GET" and not suffix and self.old is not None and not self.waited:
            self.requests.append((request.method, request.full_url, None))
            stale = copy.deepcopy(self.old)
            stale["state"] = "replacing"
            return io.BytesIO(json.dumps(stale).encode())
        old = copy.deepcopy(self.machine)
        response = super().__call__(request, timeout)
        if request.method == "POST" and not suffix:
            self.old = old
            self.machine["state"] = "stopped"
            acknowledged = copy.deepcopy(self.machine)
            acknowledged["state"] = "created"
            return io.BytesIO(json.dumps(acknowledged).encode())
        return response

    def assert_wait(self, request, suffix):
        from urllib.parse import parse_qs, urlsplit

        assert self.leased and request.method == "GET"
        query = parse_qs(urlsplit(suffix).query)
        assert query["instance_id"] == [self.machine["instance_id"]]
        assert query["state"] == ["stopped"]
        assert 0 < int(query["timeout"][0]) <= 30
        self.requests.append((request.method, request.full_url, None))


class RetainedWorkerTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"FLY_API_TOKEN": "fixture-token"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_operation(self, native, parameters, expected):
        class OwnedFixtureFly(pool.Fly):
            def assert_managed_mutable(self):
                return None

        with patch.object(pool, "urlopen", native):
            return pool.operate(parameters, expected, OwnedFixtureFly(parameters.app, parameters.id))

    def retire(self, value):
        native = NativeHTTP(value)
        self.run_operation(native, args("retire", hash="old", queue="navi-agent-tasks@old"), value)
        return native

    def released(self):
        value = machine()
        custody(value)
        return self.retire(value).machine

    def test_managed_startup_overrides_app_secret_without_changing_other_environment(self):
        value = self.released()
        native = NativeHTTP(value)
        full_queue = "navi-agent-tasks-pool-fixture@new"
        self.run_operation(native, args("reserve", job="route-job", queue=full_queue), value)
        self.run_operation(native, args("reuse", job="route-job", queue=full_queue), copy.deepcopy(native.machine))
        config = native.machine["config"]
        # Native app secrets override Machine config.env, as observed on the failed bank.
        effective = {
            **os.environ,
            **config["env"],
            "TEMPORAL_TASK_QUEUE": "navi-agent-tasks",
            "UNRELATED_SECRET": "keep",
        }
        command = config.get("init", {}).get("exec", ["python", "worker.py"])
        self.assertEqual(command[-2:], ["python", "worker.py"])
        probe = (
            "import importlib.util,json,os,sys; "
            "s=importlib.util.spec_from_file_location('generation',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "print(json.dumps([m.resolve_production_task_queue(os.environ['TEMPORAL_TASK_QUEUE'], "
            "os.environ['TEMPORAL_WORKER_SURFACE_HASH']),os.environ['UNRELATED_SECRET']]))"
        )
        result = subprocess.run(
            [*command[:-2], sys.executable, "-I", "-c", probe, str(ROOT / "agents/helpers/worker_generation.py")],
            env=effective,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(json.loads(result.stdout), [full_queue, "keep"])
        self.assertEqual(effective["TEMPORAL_TASK_QUEUE"], "navi-agent-tasks")
        self.assertEqual(config["env"]["TEMPORAL_TASK_QUEUE"], full_queue.rsplit("@", 1)[0])
        self.assertFalse(native.leased)

    def test_managed_startup_rejects_foreign_init_before_native_configuration_update(self):
        for init in (
            {"exec": ["sh", "-c", "python worker.py"]},
            {"cmd": ["foreign"]},
            {"entrypoint": ["foreign"]},
            None,
            [],
        ):
            with self.subTest(init=init):
                value = self.released()
                value["config"]["init"] = init
                # The source reservation and custody bind this exact donor config.
                source = pool.record(value, "prod")
                marker = pool.metadata(value, pool.POOL_KEY)
                marker["source"] = source
                value["config"]["metadata"][pool.POOL_KEY] = json.dumps(marker)
                proof = pool.metadata(value, pool.CUSTODY_KEY)
                proof["config_sha256"] = source["config_sha256"]
                value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
                native = NativeHTTP(value)
                self.run_operation(native, args("reserve", job="route-job"), value)
                with self.assertRaisesRegex(ValueError, "startup contract|init.exec|init layout"):
                    self.run_operation(native, args("reuse", job="route-job"), copy.deepcopy(native.machine))
                self.assertFalse(any(method == "POST" and url.endswith("/1234") for method, url, _ in native.requests))
                self.assertFalse(native.leased)

    def test_managed_startup_rejects_container_or_process_override(self):
        for field in ("containers", "processes"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "layout"):
                pool.bind_managed_worker_startup({field: [{"command": "foreign"}]}, "unique@hash")

    def test_standalone_mutation_cannot_relabel_a_held_managed_machine(self):
        value = machine()
        custody(value)
        value["config"]["metadata"][pool.POOL_KEY] = json.dumps({"job": "retained-original", "phase": "active"})
        native = NativeHTTP(value)
        with patch.object(pool, "urlopen", native), self.assertRaisesRegex(ValueError, "canonical controller"):
            pool.operate(args("retire", hash="old", queue="navi-agent-tasks@old"), value, pool.Fly("prod", "1234"))
        self.assertFalse(native.requests)
        self.assertEqual(pool.metadata(native.machine, pool.POOL_KEY)["job"], "retained-original")

    def test_managed_startup_is_bound_to_the_canonical_image_command(self):
        instructions = (ROOT / "agents/Dockerfile").read_text().splitlines()
        self.assertEqual([line for line in instructions if line.startswith("CMD ")], ['CMD ["python", "worker.py"]'])
        self.assertFalse(any(line.startswith("ENTRYPOINT ") for line in instructions))

    def test_retirement_only_updates_metadata_and_keeps_machine_data_and_version(self):
        value = machine()
        custody(value)
        native = self.retire(value)
        self.assertEqual(pool.record(native.machine, "prod"), pool.record(value, "prod"))
        self.assertEqual(native.machine["state"], "stopped")
        self.assertTrue(pool.eligible(native.machine, "prod", "live"))
        self.assertFalse(any(method == "POST" and url.endswith("/1234") for method, url, _ in native.requests))
        self.assertFalse(native.leased)

    def test_without_bound_custody_retirement_preserves_machine_but_does_not_release_it(
        self,
    ):
        native = self.retire(machine())
        self.assertFalse(pool.eligible(native.machine, "prod", "live"))
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reuse"), native.machine)
        self.assertFalse(native.leased)

    def test_persistent_rootfs_is_retained_but_not_consumed_even_with_bound_custody(
        self,
    ):
        for field, mode in (
            ("rootfs", "always"),
            ("rootfs", "restart"),
            ("guest", "always"),
        ):
            value = machine()
            value["config"][field]["persist" if field == "rootfs" else "persist_rootfs"] = mode
            custody(value)
            native = self.retire(value)
            self.assertFalse(pool.eligible(native.machine, "prod", "live"))
            self.assertEqual(native.machine["state"], "stopped")

    def test_captured_update_ack_version_precedes_old_replacing_read(self):
        # Native 0031 ACK: new instance/created/target; 0034 GET 254ms later:
        # old instance/replacing/source. IDs/config values are sanitized here.
        value = self.released()
        native = CapturedReplacingHTTP(value)
        self.run_operation(native, args("reuse"), value)
        self.assertTrue(native.waited)
        self.assertEqual(native.machine["instance_id"], "native-version-2")
        self.assertFalse(native.leased)
        self.assertEqual(
            sum(method == "POST" and url.endswith("/machines/1234") for method, url, _ in native.requests),
            1,
        )

    def test_update_ack_wait_and_postwait_fail_closed(self):
        for fault in (
            "no-ack",
            "wrong-id",
            "missing-version",
            "old-version",
            "wrong-config",
            "wrong-marker",
            "wait-false",
            "wait-timeout",
            "postwait-version",
            "postwait-config",
        ):
            with self.subTest(fault=fault):
                value = self.released()

                class FaultHTTP(CapturedReplacingHTTP):
                    def __call__(self, request, timeout):
                        result = super().__call__(request, timeout)
                        suffix = request.full_url.split("/machines/1234", 1)[1]
                        if request.method == "POST" and not suffix:
                            if fault == "no-ack":
                                return io.BytesIO(b"null")
                            ack = json.loads(result.read())
                            if fault == "wrong-id":
                                ack["id"] = "foreign"
                            elif fault == "missing-version":
                                ack.pop("instance_id")
                            elif fault == "old-version":
                                ack["instance_id"] = value["instance_id"]
                            elif fault == "wrong-config":
                                ack["config"]["env"]["OTHER_SETTING"] = "changed"
                            elif fault == "wrong-marker":
                                ack["config"]["metadata"][pool.POOL_KEY] = "{}"
                            return io.BytesIO(json.dumps(ack).encode())
                        if suffix.startswith("/wait?"):
                            if fault == "wait-false":
                                return io.BytesIO(b'{"ok":false}')
                            if fault == "wait-timeout":
                                raise URLError("fixture native wait timeout")
                        if request.method == "GET" and not suffix and self.waited:
                            actual = json.loads(result.read())
                            if fault == "postwait-version":
                                actual["instance_id"] = "foreign-version"
                            elif fault == "postwait-config":
                                actual["config"]["env"]["OTHER_SETTING"] = "changed"
                            return io.BytesIO(json.dumps(actual).encode())
                        return result

                native = FaultHTTP(value)
                with self.assertRaises((ValueError, URLError)):
                    self.run_operation(native, args("reuse"), value)
                self.assertFalse(native.leased)
                self.assertEqual(
                    sum(method == "POST" and url.endswith("/machines/1234") for method, url, _ in native.requests),
                    1,
                )
                if fault in (
                    "no-ack",
                    "wrong-id",
                    "missing-version",
                    "old-version",
                    "wrong-config",
                    "wrong-marker",
                ):
                    self.assertFalse(native.waited)

    def test_stopped_wait_retries_native_408_until_the_exact_version_settles(self):
        """2026-10-18: a new-image reuse took ~20s; one 10s wait failed the cutover."""
        from urllib.error import HTTPError

        for pending, succeeds in ((2, True), (pool.STOPPED_WAIT_ATTEMPTS, False)):
            with self.subTest(pending=pending):
                value = self.released()
                waits = []

                class SlowStopHTTP(CapturedReplacingHTTP):
                    def __call__(self, request, timeout):
                        suffix = request.full_url.split("/machines/1234", 1)[1]
                        if suffix.startswith("/wait?") and len(waits) < pending:
                            self.assert_wait(request, suffix)
                            waits.append(suffix)
                            raise HTTPError(request.full_url, 408, "Request Timeout", {}, io.BytesIO(b""))
                        return super().__call__(request, timeout)

                native = SlowStopHTTP(value)
                if succeeds:
                    self.run_operation(native, args("reuse"), value)
                    self.assertTrue(native.waited)
                else:
                    with self.assertRaises(HTTPError):
                        self.run_operation(native, args("reuse"), value)
                    self.assertEqual(len(waits), pool.STOPPED_WAIT_ATTEMPTS)
                self.assertFalse(native.leased)
                self.assertEqual(
                    sum(method == "POST" and url.endswith("/machines/1234") for method, url, _ in native.requests),
                    1,
                )
        # Any other native error is not a wait result and still fails closed at once.
        value = self.released()
        calls = []

        class ForbiddenWaitHTTP(CapturedReplacingHTTP):
            def __call__(self, request, timeout):
                suffix = request.full_url.split("/machines/1234", 1)[1]
                if suffix.startswith("/wait?"):
                    calls.append(suffix)
                    raise HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b""))
                return super().__call__(request, timeout)

        with self.assertRaises(HTTPError):
            self.run_operation(ForbiddenWaitHTTP(value), args("reuse"), value)
        self.assertEqual(len(calls), 1)

    def test_lost_ack_retry_rejects_empty_or_nonstring_version_before_wait(self):
        for version in ("", None, 7):
            with self.subTest(version=version):
                value = self.released()
                native = NativeHTTP(value)
                native.lose_update_ack = True
                with self.assertRaises(URLError):
                    self.run_operation(native, args("reuse"), value)
                native.machine["instance_id"] = version
                before = len(native.requests)
                with self.assertRaises(ValueError):
                    self.run_operation(native, args("reuse"), value)
                requests = native.requests[before:]
                self.assertFalse(any("/wait?" in url for _, url, _ in requests))
                self.assertFalse(any(method == "POST" and not url.endswith("/lease") for method, url, _ in requests))
                self.assertEqual(native.update_count, 1)
                self.assertFalse(native.leased)

    def test_lost_ack_retry_waits_exact_version_before_verification_and_custody(self):
        for fault in ("", "wait-error", "foreign-version", "still-starting"):
            with self.subTest(fault=fault):
                value = machine()
                custody(value)
                grant = pool.metadata(value, pool.CUSTODY_KEY)
                grant["rootfs_disposition"] = "stateless"
                value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(grant)
                value = self.retire(value).machine

                class LostAckHTTP(NativeHTTP):
                    def __call__(self, request, timeout):
                        suffix = request.full_url.split("/machines/1234", 1)[1]
                        if request.method == "POST" and not suffix:
                            self.machine["state"] = "replacing"
                        if suffix.startswith("/wait?") and fault == "wait-error":
                            raise URLError("fixture wait failed")
                        response = super().__call__(request, timeout)
                        if suffix.startswith("/wait?"):
                            if fault == "foreign-version":
                                self.machine["instance_id"] = "foreign-version"
                            elif fault == "still-starting":
                                self.machine["state"] = "starting"
                        return response

                native = LostAckHTTP(value)
                native.lose_update_ack = True
                with self.assertRaises(URLError):
                    self.run_operation(native, args("reuse"), value)
                self.assertEqual(native.update_count, 1)
                self.assertEqual(native.machine["state"], "replacing")
                self.assertEqual(pool.metadata(native.machine, pool.CUSTODY_KEY), grant)
                if fault:
                    with self.assertRaises((ValueError, URLError)):
                        self.run_operation(native, args("reuse"), value)
                    self.assertEqual(pool.metadata(native.machine, pool.CUSTODY_KEY), grant)
                else:
                    result = self.run_operation(native, args("reuse"), value)
                    self.assertTrue(result["verified"])
                    self.assertEqual(native.machine["state"], "stopped")
                    self.assertEqual(pool.metadata(native.machine, pool.CUSTODY_KEY)["instance_id"], "native-version-2")
                self.assertEqual(native.update_count, 1, "retry issued another config POST")
                waits = [url for method, url, _ in native.requests if "/wait?" in url]
                if fault != "wait-error":
                    self.assertEqual(len(waits), 1)
                    self.assertIn("instance_id=native-version-2", waits[0])
                self.assertFalse(native.leased)
                self.assertFalse(any(url.endswith(("/stop", "/start")) for _, url, _ in native.requests))

    def test_reuse_keeps_id_volumes_config_and_unrelated_env(self):
        value = self.released()
        native = NativeHTTP(value)
        self.run_operation(native, args("reuse"), value)
        self.assertEqual(native.machine["id"], value["id"])
        before, after = value["config"], native.machine["config"]
        for key in ("mounts", "rootfs", "services", "guest"):
            self.assertEqual(before[key], after[key])
        self.assertEqual(after["env"]["OTHER_SETTING"], "keep")
        self.assertEqual(after["env"]["TEMPORAL_WORKER_DEPLOYMENT_TOKEN"], "new-attempt")
        self.assertEqual(native.machine["state"], "stopped")
        self.assertEqual(pool.metadata(native.machine, pool.POOL_KEY)["phase"], "active")
        self.assertFalse(native.leased)

    def test_stateless_pool_custody_survives_a_complete_generation_cycle(self):
        value = machine()
        custody(value)
        proof = pool.metadata(value, pool.CUSTODY_KEY)
        proof["rootfs_disposition"] = "stateless"
        value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
        native = self.retire(value)
        self.run_operation(native, args("reuse"), native.machine)
        native.machine["state"] = "stopped"
        self.run_operation(
            native,
            args(
                "retire",
                live_hash="next",
                hash="new",
                build="next-build",
                token="next-attempt",
                queue="navi-agent-tasks@new",
            ),
            copy.deepcopy(native.machine),
        )
        self.assertTrue(
            pool.eligible(native.machine, "prod", "next"),
            "an explicitly stateless reusable machine must return to the spare pool",
        )

    def test_an_old_archive_does_not_certify_the_next_runtime(self):
        value = self.released()
        original_proof = pool.metadata(value, pool.CUSTODY_KEY)
        native = NativeHTTP(value)
        self.run_operation(native, args("reuse"), value)
        self.assertEqual(pool.metadata(native.machine, pool.CUSTODY_KEY), original_proof)
        self.assertFalse(pool.custody_ready(native.machine, "prod"))

    def test_same_code_banks_can_be_reused_after_each_distinct_queue_retires(self):
        value = machine()
        value["config"]["env"]["TEMPORAL_WORKER_SURFACE_HASH"] = "same"
        value["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"] = "navi-agent-tasks-pool-first@same"
        custody(value)
        proof = pool.metadata(value, pool.CUSTODY_KEY)
        proof["rootfs_disposition"] = "stateless"
        value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
        native = NativeHTTP(value)
        for index in (2, 3):
            prior_queue = native.machine["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"]
            current_queue = f"navi-agent-tasks-pool-{index}@same"
            parameters = dict(
                hash="same",
                live_hash="same",
                live_queue=current_queue,
                queue=prior_queue,
                build=f"build-{index}",
                token=f"attempt-{index}",
            )
            self.run_operation(native, args("retire", **parameters), copy.deepcopy(native.machine))
            self.assertFalse(pool.eligible(native.machine, "prod", "same", prior_queue))
            self.assertTrue(pool.eligible(native.machine, "prod", "same", current_queue))
            parameters.update(queue=current_queue, live_queue=f"navi-agent-tasks-pool-live-{index}@same")
            self.run_operation(native, args("reserve", job=f"job-{index}", **parameters), copy.deepcopy(native.machine))
            self.run_operation(native, args("reuse", job=f"job-{index}", **parameters), copy.deepcopy(native.machine))
            self.assertTrue(pool.custody_ready(native.machine, "prod"))
            self.assertEqual(native.machine["config"]["env"]["TEMPORAL_WORKER_POOL_QUEUE"], current_queue)
            self.assertEqual(native.machine["config"]["env"]["AUTOSCALER_ACTUATE"], "0")
            self.assertEqual(native.machine["config"]["mounts"], value["config"]["mounts"])

    def test_reserved_machine_cannot_be_claimed_by_a_second_deployment(self):
        value = self.released()
        native = NativeHTTP(value)
        parameters = args("reserve", job="deploy-one")
        self.run_operation(native, parameters, value)
        saved = copy.deepcopy(native.machine)
        self.assertTrue(pool.reserved(saved, parameters))
        self.assertFalse(pool.eligible(saved, "prod", "live"))
        self.run_operation(native, parameters, value)
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reserve", job="deploy-two"), saved)
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reuse", job="deploy-two"), saved)
        self.run_operation(native, args("reuse", job="deploy-one"), saved)
        self.assertEqual(pool.metadata(native.machine, pool.POOL_KEY)["job"], "deploy-one")

    def test_unmodified_reservation_returns_only_to_its_original_verified_idle_state(self):
        value = self.released()
        native = NativeHTTP(value)
        self.run_operation(native, args("reserve", job="abandoned-job"), value)
        reserved = copy.deepcopy(native.machine)
        with self.assertRaises(ValueError):
            self.run_operation(native, args("release-reservation", job="other-job"), reserved)
        self.run_operation(native, args("release-reservation", job="abandoned-job"), reserved)
        self.assertEqual(pool.record(native.machine, "prod"), pool.record(value, "prod"))
        self.assertEqual(pool.metadata(native.machine, pool.POOL_KEY), pool.metadata(value, pool.POOL_KEY))
        self.assertTrue(pool.eligible(native.machine, "prod", "live"))

    def test_reserved_generation_and_native_identity_cannot_change_before_reuse(self):
        value = self.released()
        native = NativeHTTP(value)
        self.run_operation(native, args("reserve", job="deploy-one"), value)
        saved = copy.deepcopy(native.machine)
        for updates in ({"hash": "other"}, {"token": "other"}):
            with self.assertRaises(ValueError):
                self.run_operation(native, args("reuse", job="deploy-one", **updates), saved)
        native.machine["instance_id"] = "another-native-version"
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reuse", job="deploy-one"), saved)

    def test_explicit_preallocation_can_be_enrolled_without_booting_a_worker(self):
        value = machine()
        value["state"] = "created"
        value["config"]["env"].update(
            TEMPORAL_WORKER_SURFACE_HASH=pool.SPARE_SURFACE,
            TEMPORAL_WORKER_POOL_SPARE="1",
        )
        custody(value)
        proof = pool.metadata(value, pool.CUSTODY_KEY)
        proof["rootfs_disposition"] = "stateless"
        value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
        native = NativeHTTP(value)
        self.run_operation(native, args("enroll"), value)
        self.assertTrue(pool.initial_spare(native.machine, "prod", "live"))
        saved = copy.deepcopy(native.machine)
        self.run_operation(native, args("reserve", job="first-deploy"), saved)
        self.run_operation(native, args("reuse", job="first-deploy"), copy.deepcopy(native.machine))
        self.assertNotIn("TEMPORAL_WORKER_POOL_SPARE", native.machine["config"]["env"])
        self.assertFalse(any(url.endswith("/start") for _, url, _ in native.requests))

    def test_preallocation_does_not_relabel_live_or_unknown_data_as_idle(self):
        for mode in ("running", "archived", "old-surface", "unmarked", "persistent-overlay"):
            value = machine()
            value["config"]["env"].update(
                TEMPORAL_WORKER_SURFACE_HASH=pool.SPARE_SURFACE,
                TEMPORAL_WORKER_POOL_SPARE="1",
            )
            custody(value)
            proof = pool.metadata(value, pool.CUSTODY_KEY)
            proof["rootfs_disposition"] = "archived" if mode == "archived" else "stateless"
            value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
            if mode == "running":
                value["state"] = "started"
            if mode == "old-surface":
                value["config"]["env"]["TEMPORAL_WORKER_SURFACE_HASH"] = "old"
            if mode == "unmarked":
                value["config"]["env"].pop("TEMPORAL_WORKER_POOL_SPARE")
            if mode == "persistent-overlay":
                value["config"]["rootfs"]["persist"] = "always"
                custody(value)
                proof = pool.metadata(value, pool.CUSTODY_KEY)
                proof["rootfs_disposition"] = "stateless"
                value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(proof)
            native = NativeHTTP(value)
            with self.assertRaises(ValueError):
                self.run_operation(native, args("enroll"), value)
            self.assertFalse(any("/metadata/" in url for _, url, _ in native.requests))

    def test_selection_refuses_busy_live_foreign_unmarked_protected_and_changed_data(
        self,
    ):
        good = self.released()
        self.assertTrue(pool.eligible(good, "prod", "live"))
        self.assertFalse(pool.eligible(good, "other-app", "live"))
        self.assertFalse(pool.eligible(good, "prod", "old"))
        self.assertFalse(pool.eligible(machine(), "prod", "live"))
        # Fly returned a stopped gen Machine with "config": null (2026-10-26
        # cutover); it must be skipped, not abort bank preparation.
        for broken in (
            {**good, "config": None},
            {**good, "config": {**good["config"], "metadata": None}},
            {**good, "config": "malformed"},
            {**good, "config": {**good["config"], "metadata": "malformed"}},
        ):
            self.assertEqual(pool.metadata(broken, pool.POOL_KEY), {})
            self.assertFalse(pool.eligible(broken, "prod", "live"))
        for change in (
            lambda m: m.update(state="started"),
            lambda m: m.update(instance_id="replaced"),
            lambda m: m["config"]["env"].update(TEMPORAL_WORKER_DEPLOYMENT_TOKEN="foreign-attempt"),
            lambda m: m["config"]["mounts"].append({"volume": "foreign", "path": "/foreign"}),
            lambda m: m["config"]["metadata"].update(rose_worker_reuse_protected="true"),
        ):
            value = copy.deepcopy(good)
            change(value)
            self.assertFalse(pool.eligible(value, "prod", "live"))

    def test_custody_must_bind_owner_native_version_config_and_rootfs_disposition(self):
        for key, wrong in (
            ("app", "foreign"),
            ("instance_id", "stale"),
            ("config_sha256", "stale"),
            ("rootfs_disposition", "unknown"),
            ("evidence_ref", "file:///ephemeral"),
        ):
            value = self.released()
            record = pool.metadata(value, pool.CUSTODY_KEY)
            record[key] = wrong
            value["config"]["metadata"][pool.CUSTODY_KEY] = json.dumps(record)
            self.assertFalse(pool.eligible(value, "prod", "live"))

    def test_protected_flag_alone_excludes_an_otherwise_consistent_release(self):
        value = machine()
        value["config"]["metadata"]["rose_worker_reuse_protected"] = "true"
        custody(value)
        native = NativeHTTP(value)
        with self.assertRaises(ValueError):
            self.run_operation(native, args("retire", hash="old", queue="navi-agent-tasks@old"), value)
        self.assertFalse(any("/metadata/" in url for _, url, _ in native.requests))
        marker = {
            "version": 1,
            "phase": "idle",
            "source": pool.record(value, "prod"),
            "drained_queue": "navi-agent-tasks@old",
            "retired_by": {"build": "retiring", "token": "retiring-attempt"},
        }
        value["config"]["metadata"][pool.POOL_KEY] = json.dumps(marker)
        self.assertTrue(pool.custody_ready(value, "prod"))
        self.assertEqual(
            pool.metadata(value, pool.POOL_KEY)["source"],
            pool.record(value, "prod"),
        )
        self.assertFalse(pool.eligible(value, "prod", "live"))

    def test_malformed_retirement_owner_skips_donor_without_aborting_other_candidates(
        self,
    ):
        good = self.released()
        for invalid in (None, [], "not-an-owner"):
            value = copy.deepcopy(good)
            marker = pool.metadata(value, pool.POOL_KEY)
            marker["retired_by"] = invalid
            value["config"]["metadata"][pool.POOL_KEY] = json.dumps(marker)
            self.assertEqual(
                [m["id"] for m in (value, good) if pool.eligible(m, "prod", "live")],
                [good["id"]],
            )

    def test_native_lease_refuses_a_machine_changed_after_selection(self):
        value = self.released()
        native = NativeHTTP(value)
        native.on_lease = lambda current: current.update(instance_id="foreign-version")
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reuse"), value)
        self.assertFalse(any(method == "POST" and url.endswith("/1234") for method, url, _ in native.requests))
        self.assertFalse(native.leased)

    def test_committed_update_with_lost_ack_reconciles_same_attempt_without_second_write(
        self,
    ):
        value = self.released()
        native = NativeHTTP(value)
        native.lose_update_ack = True
        with self.assertRaises(URLError):
            self.run_operation(native, args("reuse"), value)
        self.run_operation(native, args("reuse"), value)
        self.assertEqual(
            sum(method == "POST" and url.endswith("/1234") for method, url, _ in native.requests),
            1,
        )
        self.assertFalse(native.leased)

    def test_another_attempt_cannot_claim_a_committed_reuse(self):
        value = self.released()
        native = NativeHTTP(value)
        self.run_operation(native, args("reuse"), value)
        with self.assertRaises(ValueError):
            self.run_operation(native, args("reuse", token="other-attempt"), value)
        self.assertFalse(native.leased)

    def test_scoped_rolling_activation_only_refreshes_metadata(self):
        value = machine()
        value["state"] = "started"
        native = NativeHTTP(value)
        parameters = args(
            "activate",
            live_hash="old",
            hash="old",
            build="old-build",
            token="old-attempt",
        )
        self.run_operation(native, parameters, value)
        self.assertEqual(pool.record(native.machine, "prod"), pool.record(value, "prod"))
        self.assertEqual(pool.metadata(native.machine, pool.POOL_KEY)["phase"], "active")
        self.assertFalse(any(method == "POST" and url.endswith("/1234") for method, url, _ in native.requests))
        self.assertFalse(native.leased)

    def test_rolling_intent_recovers_only_the_pinned_native_target(self):
        value = machine()
        value["state"] = "started"
        native = NativeHTTP(value)
        parameters = args("prepare-roll", live_hash="old", hash="old")
        self.run_operation(native, parameters, value)
        self.assertTrue(pool.active_owner(native.machine, "prod"))
        native.machine["config"]["env"].update(
            TEMPORAL_WORKER_BUILD_ID="new-build",
            TEMPORAL_WORKER_DEPLOYMENT_TOKEN="foreign",
        )
        self.assertFalse(pool.active_owner(native.machine, "prod"))
        native.machine["config"]["env"]["TEMPORAL_WORKER_DEPLOYMENT_TOKEN"] = "new-attempt"
        self.assertTrue(pool.active_owner(native.machine, "prod"))
        parameters.action = "activate"
        self.run_operation(native, parameters, copy.deepcopy(native.machine))
        self.assertNotIn("rolling", pool.metadata(native.machine, pool.POOL_KEY))
        self.assertFalse(native.leased)

    def test_rolling_activation_rejects_idle_foreign_protected_and_changed_source(self):
        parameters = args(
            "activate",
            live_hash="old",
            hash="old",
            build="old-build",
            token="old-attempt",
        )
        for mode in (
            "idle",
            "foreign",
            "protected",
            "changed",
            "stopped",
            "wrong-attempt",
        ):
            with self.subTest(mode=mode):
                value = machine()
                value["state"] = "started"
                if mode in ("idle", "foreign"):
                    value["config"]["metadata"][pool.POOL_KEY] = json.dumps(
                        {
                            "version": 1,
                            "phase": "idle" if mode == "idle" else "active",
                            "app": "foreign",
                            "id": value["id"],
                            "hash": "old",
                        }
                    )
                if mode == "protected":
                    value["config"]["metadata"]["rose_worker_reuse_protected"] = "true"
                if mode == "stopped":
                    value["state"] = "stopped"
                native = NativeHTTP(value)
                if mode == "changed":
                    native.on_lease = lambda m: m["config"]["env"].update(OTHER_SETTING="changed")
                call_args = copy.copy(parameters)
                if mode == "wrong-attempt":
                    call_args.token = "foreign"
                with self.assertRaises(ValueError):
                    self.run_operation(native, call_args, value)
                self.assertFalse(any("/metadata/" in url for _, url, _ in native.requests))
                self.assertFalse(native.leased)

    def test_retirement_refuses_busy_changed_or_live_generation(self):
        for parameters, mutation in (
            (
                args("retire", hash="old", queue="navi-agent-tasks@old"),
                lambda m: m.update(state="started"),
            ),
            (
                args("retire", hash="old", queue="navi-agent-tasks@old"),
                lambda m: m["config"]["env"].update(TEMPORAL_WORKER_DEPLOYMENT_TOKEN="foreign"),
            ),
            (
                args("retire", hash="old", live_hash="old", queue="navi-agent-tasks@old"),
                lambda m: None,
            ),
        ):
            value = machine()
            native = NativeHTTP(value)
            native.on_lease = mutation
            with self.assertRaises(ValueError):
                self.run_operation(native, parameters, value)
            self.assertFalse(any("/metadata/" in url for _, url, _ in native.requests))
            self.assertFalse(native.leased)


if __name__ == "__main__":
    unittest.main()
