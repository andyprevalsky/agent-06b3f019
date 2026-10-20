#!/usr/bin/env python3
"""Incomplete native request ordering and one-shot admission controls, offline."""

import copy
import json
import runpy
import signal
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-incomplete-reservations.py"))
OLD = runpy.run_path(
    str(ROOT / "scripts/tests/cloudbench-reconcile-reservations.test.py")
)
H = M["H"]


class Incomplete(unittest.TestCase):
    def setUp(self):
        self.fixture = OLD["Reconcile"]()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.f = self.fixture.f
        self.directory = self.fixture.directory
        # Real fixture has canonical request records and leased config raw ACK.
        for ordinal in range(5):
            path = self.f.wire / str(ordinal)
            path.rename(self.f.wire / f"{ordinal:032x}")

    def partial(self):
        folder = self.f.wire / ("e" * 32)
        folder.mkdir()
        path = folder / "request.json"
        path.write_bytes(b"")
        path.chmod(0o600)
        return folder

    def closed_fixture(self):
        import shutil
        import time

        write = OLD["OLD"]["write"]
        root = self.f.outer
        shutil.rmtree(root / "launch-1")
        (root / "controller-launch.intent.json").unlink()
        (root / "archived-reuse-request.private.json").unlink()
        request = copy.deepcopy(self.f.original)
        other = copy.deepcopy(self.fixture.row)
        other.update(machine_id="f" * 14, volume_id="vol_other")
        other["predecessor"].update(
            id=other["machine_id"], volume_id=other["volume_id"]
        )
        request["candidates"].append(other)
        (root / "archived-reuse-reservations" / other["machine_id"]).mkdir(mode=0o700)
        failure_row = {
            "machine_id": other["machine_id"],
            "not_credited": True,
            "error_type": "TimeoutExpired",
            "error": "retained old read timeout",
        }
        closed = dict(
            request,
            candidates=self.f.request["candidates"],
            held_native_reservations=[failure_row],
        )
        base = root / "archived-reuse-reservations"
        write(base / "reserved-request.json", closed)
        epoch = time.time() - 10
        facts = {
            "app": H["APP"],
            "image_ref": request["image_ref"],
            "protected_machines": ["p1", "p2", "p3", "p4"],
            "protected_volumes": [],
        }
        values = {
            "tasks": request["task_names"],
            "facts": facts,
            "agents_env": {},
            "backend_env": {},
            "snapshot_inventory": [],
            "warm_deps": {},
        }
        bound = {}
        for name, value in values.items():
            path = write(root / (name + ".private"), value)
            bound[name] = {"path": str(path), "sha256": M["sha"](path.read_bytes())}
        # A real private input above the small receipt reader limit remains streamed.
        snapshot = Path(bound["snapshot_inventory"]["path"])
        with snapshot.open("r+b") as stream:
            stream.truncate(17 * 1024 * 1024)
        bound["snapshot_inventory"]["sha256"] = M["private_digest"](snapshot)
        admission = {
            "binding": {"source_ref": "a" * 40, "inputs": bound},
            "started_at_epoch": epoch,
            "deadline_epoch": epoch + 5400,
        }
        intent_path = write(root / "admission-intent.private.json", admission)
        original = write(
            root / "archived-reuse-original.private.json",
            {
                "schema": "original600-archived-admission-request-v1",
                "request": request,
                "sha256": M["sha"](
                    json.dumps(request, sort_keys=True, allow_nan=False).encode()
                ),
            },
        )
        old_membership = {
            key.removeprefix("archived-reuse-reservations/"): value
            for key, value in M["C"]["history_membership"](root).items()
        }
        observer = base / "acknowledged-holds-observation"
        observed_path = write(observer / "request.json", closed)
        identity = M["sha"](
            M["canonical"](
                {"request": request, "closed": closed, "deadline": epoch + 5400}
            )
        )
        write(
            observer / "intent.json",
            {
                "identity_sha256": identity,
                "original_deadline": epoch + 5400,
                "config_writes": 0,
            },
        )
        write(
            observer / "complete.json",
            {
                "identity_sha256": identity,
                "original_deadline": epoch + 5400,
                "config_writes": 0,
                "task_credit": 0,
                "cancelled_signals": [],
                "request_sha256": M["sha"](observed_path.read_bytes()),
                "added_machine_ids": [],
                "prior_failures": [failure_row],
                "old_membership": old_membership,
                "inputs": {},
            },
        )
        events = [
            {
                "status": "ADMISSION_STARTED",
                "source_ref": "a" * 40,
                "directory": str(root),
            },
            {
                "status": "ADMISSION_PENDING",
                "controller_started": False,
                "directory": str(root),
            },
        ]
        log = root / "execution.log"
        log.write_text(
            "\n".join(json.dumps(e) for e in events)
            + "\nValueError: fresh capacity after reserved native readback is insufficient\n"
        )
        log.chmod(0o600)
        failure = write(
            root / "observed-admission-failure.safe.json",
            {
                "schema": "original600-observed-admission-failure-v1",
                "source_ref": "a" * 40,
                "source_root": str(ROOT),
                "capture_kind": "original-process-stream",
                "admission_directory": str(root),
                "admission_intent_sha256": M["sha"](intent_path.read_bytes()),
                "original_request_sha256": M["sha"](original.read_bytes()),
                "joined_observed": True,
                "tool_reported_exit_code": 1,
                "controller_created": False,
                "request_output_absent": True,
                "launch_directories_absent": True,
                "observed_error": "fresh capacity after reserved native readback is insufficient",
                "log_path": str(log),
                "log_sha256": M["sha"](log.read_bytes()),
                "closed_request_sha256": M["sha"](
                    (base / "reserved-request.json").read_bytes()
                ),
                "observed_request_sha256": M["sha"](observed_path.read_bytes()),
            },
        )
        return root, failure, closed, other

    def test_closed_capacity_continuation_binds_carried_pool_and_large_inputs(self):
        root, failure, closed, other = self.closed_fixture()
        old_bytes = M["subprocess"].check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(ROOT),
                "show",
                M["CLOSED_SOURCE"] + ":scripts/cloudbench-incomplete-reservations.py",
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            scripts = Path(temporary)
            for dependency in (ROOT / "scripts").glob("*.py"):
                if dependency.name != "cloudbench-incomplete-reservations.py":
                    (scripts / dependency.name).symlink_to(dependency)
            old_path = scripts / "cloudbench-incomplete-reservations.py"
            old_path.write_bytes(old_bytes)
            old = runpy.run_path(str(old_path))
            with (
                mock.patch.dict(
                    old["plan"].__globals__, SOURCE="a" * 40, protocol=lambda: {}
                ),
                self.assertRaisesRegex(
                    ValueError, "positive original owner failure/join required"
                ),
            ):
                old["plan"](root, failure)
        globals_ = M["closed_plan"].__globals__
        with (
            mock.patch.dict(globals_, CLOSED_SOURCE="a" * 40, protocol=lambda *_: {}),
            mock.patch.object(M["subprocess"], "check_output", return_value="a" * 40),
        ):
            plan = M["plan"](root, failure)
            self.assertEqual(plan["retained_request"], closed)
            self.assertEqual(
                plan["classifications"][0]["machine_id"], other["machine_id"]
            )
            self.assertEqual(plan["classifications"][0]["lane"], "PRE_CONFIG")
            self.assertEqual(plan["deadline"], plan["started_at"] + 5400)
            # Both publication and an altered carried row are independently refused.
            launch = root / "launch-foreign"
            launch.mkdir()
            with self.assertRaises(ValueError):
                M["plan"](root, failure)
            launch.rmdir()
            reserved = self.directory / "reserved.json"
            value = json.loads(reserved.read_bytes())
            value["source_instance_id"] = "tampered"
            OLD["OLD"]["write"](reserved, value)
            with self.assertRaises(ValueError):
                M["plan"](root, failure)

    def test_typed77_capacity_family_preserves_carried_rows_and_original_clock(self):
        root, failure_path, closed, other = self.closed_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            scripts = Path(temporary)
            for dependency in (ROOT / "scripts").glob("*.py"):
                if dependency.name != "cloudbench-incomplete-reservations.py":
                    (scripts / dependency.name).symlink_to(dependency)
            old_path = scripts / "cloudbench-incomplete-reservations.py"
            old_path.write_bytes(
                M["subprocess"].check_output(
                    [
                        "git",
                        "--no-replace-objects",
                        "-C",
                        str(ROOT),
                        "show",
                        M["CLOSED77_SOURCE"]
                        + ":scripts/cloudbench-incomplete-reservations.py",
                    ]
                )
            )
            old = runpy.run_path(str(old_path))
            with (
                mock.patch.dict(
                    old["plan"].__globals__, SOURCE="a" * 40, protocol=lambda: {}
                ),
                self.assertRaisesRegex(
                    ValueError, "positive original owner failure/join required"
                ),
            ):
                old["plan"](root, failure_path)
        with (
            mock.patch.dict(
                M["closed_plan"].__globals__,
                CLOSED77_SOURCE="a" * 40,
                protocol=lambda *_: {},
            ),
            mock.patch.object(M["subprocess"], "check_output", return_value="a" * 40),
        ):
            value = M["plan"](root, failure_path)
            self.assertEqual(value["retained_request"], closed)
            self.assertEqual(value["source_ref"], "a" * 40)
            self.assertEqual(value["deadline"], value["started_at"] + 5400)
            self.assertEqual(
                value["classifications"][0]["machine_id"], other["machine_id"]
            )
            launch = root / "launch-foreign"
            launch.mkdir()
            with self.assertRaises(ValueError):
                M["plan"](root, failure_path)
            launch.rmdir()
            failure = json.loads(failure_path.read_bytes())
            failure["source_ref"] = "b" * 40
            OLD["OLD"]["write"](failure_path, failure)
            with self.assertRaises(ValueError):
                M["plan"](root, failure_path)

    def test_completed_observer_failed_read_is_bound_without_credit(self):
        root, failure_path, closed, other = self.closed_fixture()
        import shutil

        base = root / "archived-reuse-reservations"
        journal = base / "acknowledged-holds-observation"
        shutil.rmtree(journal)
        write = OLD["OLD"]["write"]
        request = json.loads(
            (root / "archived-reuse-original.private.json").read_bytes()
        )["request"]
        other = request["candidates"][1]
        before = json.loads((self.directory / "original-native.json").read_bytes())
        before["id"] = other["machine_id"]
        before["config"]["mounts"][0]["volume"] = other["volume_id"]
        other["source_config_sha256"] = H["config_sha"](before["config"])
        current = copy.deepcopy(before)

        class Transport:
            app = H["APP"]

            def api(self, method, path, body=None, **kwargs):
                self_test.assertIn(
                    (method, path),
                    (
                        ("POST", "/machines/" + other["machine_id"] + "/lease"),
                        ("GET", "/machines/" + other["machine_id"]),
                        ("POST", "/machines/" + other["machine_id"]),
                        ("DELETE", "/machines/" + other["machine_id"] + "/lease"),
                    ),
                )
                if method == "POST" and path.endswith("/lease"):
                    value = {"data": {"nonce": "failed-observer-nonce"}}
                elif method == "POST":
                    current.update(
                        config=body["config"], instance_id="old-positive-ACK"
                    )
                    value = current
                else:
                    value = current if method == "GET" else {}
                kwargs["observer"](
                    method,
                    path,
                    201 if method == "POST" else 200,
                    json.dumps(value).encode(),
                )
                return copy.deepcopy(value)

        class Adapter(H["NativeAdapter"]):
            def _run_wire(self, directory, method, url, body, timeout, headers, errors):
                H["NativeAdapter"](self.api, directory).perform_wire(
                    dict(
                        app=self.api.app,
                        method=method,
                        path=url,
                        body=body,
                        timeout=timeout,
                        headers=headers or {},
                    )
                )

        self_test = self
        original_envelope = json.loads(
            (root / "archived-reuse-original.private.json").read_bytes()
        )
        original_envelope.update(
            request=request,
            sha256=M["sha"](
                json.dumps(request, sort_keys=True, allow_nan=False).encode()
            ),
        )
        write(root / "archived-reuse-original.private.json", original_envelope)
        with tempfile.TemporaryDirectory() as generated:
            reserved = H["reserve_cohort"](
                lambda out: Adapter(Transport(), out / "wire"),
                dict(request, candidates=[other]),
                Path(generated) / "old-reservation",
            )
            self.assertEqual(len(reserved["candidates"]), 1)
            shutil.rmtree(base / other["machine_id"])
            shutil.move(
                str(Path(generated) / "old-reservation" / other["machine_id"]),
                base / other["machine_id"],
            )
        closed = dict(
            request,
            candidates=closed["candidates"],
            held_native_reservations=closed["held_native_reservations"],
        )
        write(base / "reserved-request.json", closed)
        current = before
        deadline = json.loads((root / "admission-intent.private.json").read_bytes())[
            "deadline_epoch"
        ]
        observed = M["C"]["observe_acknowledged_holds"](
            lambda out: Adapter(Transport(), out / "wire"),
            request,
            closed,
            journal,
            deadline,
        )
        self.assertEqual(observed["candidates"], closed["candidates"])
        self.assertEqual(
            observed["held_native_reservations"], closed["held_native_reservations"]
        )
        failure = json.loads(failure_path.read_bytes())
        failure.update(
            original_request_sha256=M["sha"](
                (root / "archived-reuse-original.private.json").read_bytes()
            ),
            closed_request_sha256=M["sha"](
                (base / "reserved-request.json").read_bytes()
            ),
            observed_request_sha256=M["sha"]((journal / "request.json").read_bytes()),
        )
        write(failure_path, failure)
        old_bytes = M["subprocess"].check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(ROOT),
                "show",
                "2477583b27e84d1213c099718528b29d1e7a3bb8:scripts/cloudbench-incomplete-reservations.py",
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            scripts = Path(temporary)
            for dependency in (ROOT / "scripts").glob("*.py"):
                if dependency.name != "cloudbench-incomplete-reservations.py":
                    (scripts / dependency.name).symlink_to(dependency)
            old_path = scripts / "cloudbench-incomplete-reservations.py"
            old_path.write_bytes(old_bytes)
            old = runpy.run_path(str(old_path))
            with (
                mock.patch.dict(
                    old["closed_plan"].__globals__,
                    CLOSED77_SOURCE="a" * 40,
                    protocol=lambda *_: {},
                ),
                mock.patch.object(
                    M["subprocess"], "check_output", return_value="a" * 40
                ),
                self.assertRaisesRegex(
                    ValueError, "unknown closed admission namespace"
                ),
            ):
                old["plan"](root, failure_path)
        with (
            mock.patch.dict(
                M["closed_plan"].__globals__,
                CLOSED77_SOURCE="a" * 40,
                protocol=lambda *_: {},
            ),
            mock.patch.object(M["subprocess"], "check_output", return_value="a" * 40),
        ):
            value = M["plan"](root, failure_path)
            self.assertEqual(
                value["retained_request"]["candidates"], closed["candidates"]
            )
            failed = journal / other["machine_id"]
            for path in failed.rglob("*"):
                if path.is_file():
                    self.assertIn(str(path), value["inputs"])
            raw = next(failed.glob("wire/*/*-wire.json"))
            original = raw.read_bytes()
            raw.write_bytes(b"{}")
            with self.assertRaises((ValueError, KeyError)):
                M["plan"](root, failure_path)
            raw.write_bytes(original)
            get_request = next(
                path
                for path in failed.glob("wire/*/request.json")
                if json.loads(path.read_bytes())["method"] == "GET"
            )
            saved_request = get_request.read_bytes()
            get_raw = next(get_request.parent.glob("*-wire.json"))
            saved_raw = get_raw.read_bytes()
            changed_request = json.loads(saved_request)
            changed_request.update(method="POST", body={"config": {}})
            write(get_request, changed_request)
            changed_raw = json.loads(saved_raw)
            changed_raw["method"] = "POST"
            write(get_raw, changed_raw)
            with self.assertRaises(ValueError):
                M["plan"](root, failure_path)
            get_request.write_bytes(saved_request)
            get_raw.write_bytes(saved_raw)
            extra = failed / "foreign-config-write.json"
            write(extra, {})
            with self.assertRaises(ValueError):
                M["plan"](root, failure_path)
            extra.unlink()
            complete = json.loads((journal / "complete.json").read_bytes())
            complete["diagnostics"] = []
            write(journal / "complete.json", complete)
            with self.assertRaisesRegex(ValueError, "diagnostic"):
                M["plan"](root, failure_path)

    def test_typed75_incomplete_config_failure_keeps_closed_rows_and_exact_stack(self):
        root, failure_path, closed, other = self.closed_fixture()
        write = OLD["OLD"]["write"]
        failure = json.loads(failure_path.read_bytes())
        log_path = Path(failure["log_path"])
        prefix = "\n".join(log_path.read_text().splitlines()[:-1])
        trace = (
            'File "'
            + str(ROOT / "scripts/run-original600-controller.py")
            + '", line 178, in verify_reuse_images\n'
            "    if current is None or image_identity(current['config'].get('image')) != identity:\n"
            "AttributeError: 'NoneType' object has no attribute 'get'\n"
        )
        log_path.write_text(prefix + "\n" + trace)
        failure.update(
            observed_error="AttributeError: 'NoneType' object has no attribute 'get' at verify_reuse_images current['config']",
            log_sha256=M["sha"](log_path.read_bytes()),
        )
        write(failure_path, failure)
        with (
            mock.patch.dict(
                M["closed_plan"].__globals__,
                CLOSED75_SOURCE="a" * 40,
                protocol=lambda *_: {},
            ),
            mock.patch.object(M["subprocess"], "check_output", return_value="a" * 40),
        ):
            plan = M["plan"](root, failure_path)
            self.assertEqual(plan["source_ref"], "a" * 40)
            self.assertEqual(plan["retained_request"], closed)
            self.assertEqual(
                plan["classifications"][0]["machine_id"], other["machine_id"]
            )
            self.assertEqual(plan["deadline"], plan["started_at"] + 5400)
            log_path.write_text(
                prefix + "\nAttributeError: 'NoneType' object has no attribute 'get'\n"
            )
            failure["log_sha256"] = M["sha"](log_path.read_bytes())
            write(failure_path, failure)
            with self.assertRaisesRegex(
                ValueError, "known incomplete-config image frame"
            ):
                M["plan"](root, failure_path)

    def test_positive_ack_survives_only_source_proven_unsent_partial_call(self):
        folder = self.partial()
        result = M["classify"](self.directory, self.fixture.row, self.f.request, {})
        self.assertEqual(result["lane"], "ACK")
        self.assertEqual(result["partial_calls"][0]["state"], "PRE_DISPATCH_INCOMPLETE")
        self.assertEqual((folder / "request.json").read_bytes(), b"")
        # A single later artifact removes the no-dispatch proof.
        (folder / "transport-start.json").write_bytes(b"")
        (folder / "transport-start.json").chmod(0o600)
        with self.assertRaises(ValueError):
            M["classify"](self.directory, self.fixture.row, self.f.request, {})

    def test_malformed_observation_response_does_not_hide_unknown_config_post(self):
        result = self.f.wire / f"{3:032x}" / "result.json"
        result.write_bytes(b"")
        result.chmod(0o600)
        raw = self.f.wire / f"{3:032x}" / "0001-wire.json"
        raw.write_bytes(b"")
        classified = M["classify"](self.directory, self.fixture.row, self.f.request, {})
        self.assertEqual(classified["lane"], "ACK")
        self.assertTrue(classified["unknown_observations"])
        # The same corruption at the config POST must never authorize a write retry.
        config_raw = self.f.wire / f"{2:032x}" / "0001-wire.json"
        config_raw.write_bytes(b"")
        with self.assertRaises(ValueError):
            M["classify"](self.directory, self.fixture.row, self.f.request, {})

    def test_preconfig_requires_no_dispatch_and_never_treats_empty_intent_as_absence(
        self,
    ):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            directory.chmod(0o700)
            wire = directory / "wire" / ("a" * 32)
            wire.mkdir(parents=True, mode=0o700)
            request = wire / "request.json"
            request.write_bytes(b'{"truncated":')
            request.chmod(0o600)
            result = M["classify"](directory, self.fixture.row, self.f.request, {})
            self.assertEqual(result["lane"], "PRE_CONFIG")
            intent = directory / "intent.json"
            intent.write_bytes(b"")
            intent.chmod(0o600)
            with self.assertRaises(ValueError):
                M["classify"](directory, self.fixture.row, self.f.request, {})

    def test_same_cohort_pending_read_requires_intended_new_version_and_never_409(self):
        raw_path = self.f.wire / f"{2:032x}" / "0001-wire.json"
        result_path = self.f.wire / f"{2:032x}" / "result.json"
        raw_path.unlink()
        if result_path.exists():
            result_path.unlink()
        OLD["OLD"]["write"](
            raw_path.parent / "transport-start.json",
            {"monotonic_ns": 2, "direct": False},
        )
        pending = M["classify"](self.directory, self.fixture.row, self.f.request, {})
        self.assertEqual(pending["lane"], "PENDING_READ")
        self.assertTrue(pending["proof"]["old_response_unknown"])
        import time

        calls = []
        current = copy.deepcopy(self.f.current)

        class API:
            @contextmanager
            def lease(self, mid):
                calls.append("lease")
                try:
                    yield
                finally:
                    calls.append("released")

            def request(self, method, *_args, **_kwargs):
                self_test.assertEqual(method, "GET")
                return copy.deepcopy(current)

        self_test = self
        with tempfile.TemporaryDirectory() as name:
            observed = M["observe_ack"](
                lambda _: API(),
                pending["proof"],
                Path(name) / "positive",
                time.time() + 500,
                [],
            )
            self.assertEqual(
                observed["source_instance_id"], self.f.current["instance_id"]
            )
            current["instance_id"] = self.fixture.row["source_instance_id"]
            with self.assertRaises(ValueError):
                M["observe_ack"](
                    lambda _: API(),
                    pending["proof"],
                    Path(name) / "same-version",
                    time.time() + 500,
                    [],
                )
            current = copy.deepcopy(self.f.current)
            current["config"]["metadata"][H["MARKER"]] = "foreign"
            with self.assertRaises(ValueError):
                M["observe_ack"](
                    lambda _: API(),
                    pending["proof"],
                    Path(name) / "wrong-marker",
                    time.time() + 500,
                    [],
                )
        self.assertEqual(calls.count("lease"), calls.count("released"))
        raw = H["canonical"]({"error": "conflict"})
        import base64

        OLD["OLD"]["write"](
            raw_path,
            {
                "method": "POST",
                "path": "/machines/" + self.f.mid,
                "status": 409,
                "body_b64": base64.b64encode(raw).decode(),
                "sha256": H["sha"](raw),
                "monotonic_ns": 2,
            },
        )
        with self.assertRaises(ValueError):
            M["classify"](self.directory, self.fixture.row, self.f.request, {})

    def test_git_protocol_order_is_checked_without_executing_old_source(self):
        proof = M["protocol"]()
        self.assertEqual(len(proof), 2)
        with (
            mock.patch.object(
                M["subprocess"], "check_output", return_value=b"def foreign(): pass\n"
            ),
            self.assertRaises(ValueError),
        ):
            M["protocol"]()

    def test_ack_reconcile_only_gets_under_joined_lease_and_never_replays_incomplete(
        self,
    ):
        import time

        root = self.f.outer
        request = self.f.request
        proof = M["C"]["positive"](self.directory, self.fixture.row, request, {})
        # The source row is the original candidate for this native ACK.
        request = dict(request, candidates=[self.fixture.row])
        import shutil

        shutil.rmtree(root / "launch-1")
        (root / "controller-launch.intent.json").unlink()
        membership = M["C"]["history_membership"](root)
        value = {
            "directory": str(root),
            "request": request,
            "classifications": [
                {"machine_id": self.f.mid, "lane": "ACK", "proof": proof}
            ],
            "held": [],
            "inputs": {},
            "membership": membership,
            "protocol_hashes": M["protocol"](),
            "deadline": time.time() + 500,
        }
        # Exercise the actual executor with more rows than its fixed bound.
        import threading

        lock = threading.Lock()
        active = maximum = joined = 0
        many = copy.deepcopy(value)
        many["request"]["candidates"] = [
            dict(self.fixture.row, machine_id=f"{index:014x}") for index in range(24)
        ]
        many["classifications"] = [
            {"machine_id": row["machine_id"], "lane": "ACK", "proof": row}
            for row in many["request"]["candidates"]
        ]

        def bounded(_factory, row, _out, _deadline, _cancelled):
            nonlocal active, maximum, joined
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                time.sleep(0.03)
                return row
            finally:
                with lock:
                    active -= 1
                    joined += 1

        with (
            mock.patch.dict(M["reconcile"].__globals__, observe_ack=bounded),
            mock.patch.dict(M["H"], validate_request=lambda _request: None),
        ):
            parallel = M["reconcile"](
                None, many, root / "parallel-recovery", many["deadline"]
            )
        self.assertGreater(maximum, 1)
        self.assertLessEqual(maximum, 16)
        self.assertEqual((active, joined), (0, 24))
        self.assertEqual(parallel["candidates"], many["request"]["candidates"])
        calls = []

        class API:
            @contextmanager
            def lease(self, mid):
                calls.append(("lease", mid))
                try:
                    yield
                finally:
                    calls.append(("joined", mid))

            def request(self, method, path, **_kwargs):
                calls.append((method, path))
                return copy.deepcopy(self_test.f.current)

        self_test = self
        journal = root / "incomplete-admission-recovery"
        # Fixture's launch artifacts belong the old unused test harness, not
        # this narrow observer; pin the helper's unchanged check via its inputs.
        with mock.patch.dict({}, {}):
            result = M["reconcile"](lambda _: API(), value, journal, value["deadline"])
            self.assertEqual(len(result["candidates"]), 1)
            self.assertEqual(
                calls,
                [
                    ("lease", self.f.mid),
                    ("GET", "/machines/" + self.f.mid),
                    ("joined", self.f.mid),
                ],
            )
            replay = M["reconcile"](
                lambda _: (_ for _ in ()).throw(AssertionError("no replay")),
                value,
                journal,
                value["deadline"],
            )
            self.assertEqual(replay, result)

            class Cancel(API):
                def request(self, *_args, **_kwargs):
                    signal.raise_signal(signal.SIGTERM)
                    return copy.deepcopy(self_test.f.current)

            with self.assertRaises(M["CancelledAdmission"]):
                M["reconcile"](
                    lambda _: Cancel(),
                    value,
                    root / "cancelled-recovery",
                    value["deadline"],
                )
            self.assertTrue((root / "cancelled-recovery/cancelled.json").exists())

            class NewCAS(API):
                def __init__(self):
                    self.current = json.loads(
                        (self_test.directory / "original-native.json").read_bytes()
                    )
                    self.posts = 0

                def request(self, method, path, body=None, **_kwargs):
                    if method == "POST":
                        self_test.assertEqual(
                            body["current_version"], self.current["instance_id"]
                        )
                        self_test.assertTrue(body["skip_launch"])
                        self.posts += 1
                        self.current = dict(
                            self.current,
                            config=body["config"],
                            instance_id="one-new-CAS",
                            state="created",
                        )
                    else:
                        self_test.assertEqual(method, "GET")
                    return copy.deepcopy(self.current)

            cas = NewCAS()
            preconfig = dict(
                value,
                classifications=[
                    {
                        "machine_id": self.f.mid,
                        "lane": "PRE_CONFIG",
                        "candidate": self.fixture.row,
                    }
                ],
            )
            reserved = M["reconcile"](
                lambda _: cas, preconfig, root / "preconfig-recovery", value["deadline"]
            )
            self.assertEqual(len(reserved["candidates"]), 1)
            self.assertEqual(cas.posts, 1)
            self.assertEqual(
                reserved["candidates"][0]["source_instance_id"], "one-new-CAS"
            )

            class LateOldCAS(NewCAS):
                def request(self, method, path, body=None, **kwargs):
                    if method == "POST":
                        self.posts += 1
                        # The old version-fenced request wins after our leased
                        # preGET. The NEW CAS must keep V0 and therefore fails.
                        old_version = self.current["instance_id"]
                        self.current["instance_id"] = "late-old-winner"
                        self_test.assertEqual(body["current_version"], old_version)
                        raise ValueError("HTTP 409 current_version changed")
                    return super().request(method, path, body, **kwargs)

            late = LateOldCAS()
            unknown = dict(
                preconfig,
                classifications=[
                    dict(preconfig["classifications"][0], lane="PRIOR_UNKNOWN_NEW_CAS")
                ],
            )
            with self.assertRaisesRegex(ValueError, "no newly verified"):
                M["reconcile"](
                    lambda _: late,
                    unknown,
                    root / "late-old-recovery",
                    value["deadline"],
                )
            self.assertEqual(late.posts, 1)
            self.assertFalse((root / "late-old-recovery/request.json").exists())
            visible = NewCAS()
            visible.current["instance_id"] = "already-old-winner"
            with self.assertRaisesRegex(ValueError, "no newly verified"):
                M["reconcile"](
                    lambda _: visible,
                    unknown,
                    root / "visible-old-recovery",
                    value["deadline"],
                )
            self.assertEqual(visible.posts, 0)
            broken = root / "broken-recovery"
            broken.mkdir()
            with self.assertRaises(FileNotFoundError):
                M["reconcile"](lambda _: API(), value, broken, value["deadline"])


if __name__ == "__main__":
    unittest.main()
