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
            broken = root / "broken-recovery"
            broken.mkdir()
            with self.assertRaises(FileNotFoundError):
                M["reconcile"](lambda _: API(), value, broken, value["deadline"])


if __name__ == "__main__":
    unittest.main()
