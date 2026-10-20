#!/usr/bin/env python3
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import runpy
import tempfile
import unittest
import os
import subprocess
from unittest import mock

H = runpy.run_path(
    os.environ.get(
        "CLOUDBENCH_TEST_REUSE_MODULE",
        str(Path(__file__).resolve().parents[1] / "cloudbench-archived-machine-reuse.py"),
    )
)


@contextmanager
def native_read_server(expected, *, drip=False):
    import http.server
    import threading
    import time
    lease_requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            lease_requests.append(("POST", self.path, json.loads(body)))
            self.lease_response({"data": {"nonce": "fixture-nonce"}})

        def do_DELETE(self):
            lease_requests.append(("DELETE", self.path, self.headers.get("fly-machine-lease-nonce")))
            self.lease_response({})

        def lease_response(self, value):
            data = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            body = expected if isinstance(expected, bytes) else json.dumps(expected).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                if drip:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.03)
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    api = object.__new__(H["module"]("cloudbench-original-volume-capture.py")["Fly"])
    api.app = H["APP"]
    api.base = f"http://127.0.0.1:{server.server_port}"
    api.authorization = "Bearer private-fixture"
    api.loopback = True
    api.env = dict(os.environ)
    api.lease_requests = lease_requests
    try:
        yield api
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def fixture(count=1):
    machines = []
    rows = []
    for i in range(count):
        m = dict(
            id=f"{i + 1:014x}",
            name=f"old-native-{i}",
            instance_id=f"old-version-{i}",
            created_at="2026-10-01",
            region="iad",
            state="stopped",
            config=dict(
                image="registry.fly.io/navi-whisper-lux-bench:fixture@sha256:" + "1" * 64,
                persist_rootfs="never",
                mounts=[dict(volume=f"vol_old{i}", path="/data")],
                init=dict(cmd=["bash", "/cloudbench-boot.sh"]),
                guest=dict(cpus=2, memory_mb=4096, cpu_kind="shared"),
            ),
        )
        machines.append(m)
        rows.append(H["target_from"](m, dict(volume_id=f"vol_old{i}", owner_token="a" * 32), "b" * 64))
    request = dict(
        image_ref="registry.fly.io/navi-whisper-lux-bench@sha256:" + "1" * 64,
        schema=H["SCHEMA"],
        storage_mode=H["STORAGE"],
        app=H["APP"],
        cohort="c" * 32,
        harness_ref="d" * 40,
        task_ref=H["TASK_REF"],
        archives=[dict(archive_sha256="b" * 64)],
        candidates=rows,
    )
    successor = dict(
        controller_id="f" * 14,
        harness_ref="d" * 40,
        task_ref=H["TASK_REF"],
        owner_token="e" * 32,
        ordinal=0,
        run_id="new-run",
        task="original-name",
    )
    return request, machines, successor


class Tests(unittest.TestCase):
    def test_indexed_allocation_preserves_proof_and_never_falls_back(self):
        indexer = runpy.run_path(str(Path(__file__).resolve().parents[1] / "cloudbench-reuse-index.py"))
        request, _, successor = fixture(2)
        request["task_names"] = json.loads((Path(__file__).parent / "fixtures/original600-tasks.json").read_bytes())
        for row in request["candidates"]:
            row["reservation"] = {"cohort": request["cohort"]}
        successor.update(task=request["task_names"][0], campaign_job_id="r001-j0001",
                         campaign_total_jobs=600, campaign_attempt=1)
        golden = H["canonical"](H["proof_for"](request, request["candidates"][0], successor))

        class HeldLease(Exception):
            pass

        class API:
            @contextmanager
            def lease(inner, mid):
                self.assertEqual(mid, request["candidates"][0]["machine_id"])
                saved = json.loads((root / "archived-reuse-journal/source-exclusion.json").read_bytes())
                self.assertEqual(H["canonical"](saved["proof"]), golden)
                raise HeldLease()
                yield

        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            path, index = root / "request.json", root / "index.json"
            raw = indexer["encoded"](request)
            path.write_bytes(raw); path.chmod(0o600)
            index.write_bytes(indexer["build"](raw, H["sha"](raw), request["harness_ref"], H["validate_request"]))
            index.chmod(0o600)
            factory = mock.Mock(return_value=API())
            with (
                mock.patch.dict(os.environ, CLOUDBENCH_ARCHIVED_REUSE_INDEX=str(index),
                                CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256=H["sha"](index.read_bytes())),
                mock.patch.dict(H["allocate"].__globals__, NativeAdapter=factory,
                                validate_request=mock.Mock(side_effect=AssertionError("worker reparsed cohort"))),
            ):
                with self.assertRaises(HeldLease):
                    H["allocate"](path, H["sha"](raw), 0, successor, root, "no-provider")
                factory.reset_mock()
                os.environ["CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256"] = "0" * 64
                with self.assertRaises(ValueError):
                    H["allocate"](path, H["sha"](raw), 0, successor, root, "no-provider")
                factory.assert_not_called()
                del os.environ["CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256"]
                with self.assertRaisesRegex(ValueError, "incomplete reuse index"):
                    H["allocate"](path, H["sha"](raw), 0, successor, root, "no-provider")

    def test_allocate_releases_full_cohort_before_held_lease_without_changing_proof(self):
        import tracemalloc

        request, _, successor = fixture(555)
        request["task_names"] = json.loads(
            (Path(__file__).parent / "fixtures/original600-tasks.json").read_bytes()
        )
        for row in request["candidates"]:
            row["reservation"] = {"cohort": request["cohort"]}
        successor.update(task=request["task_names"][0], campaign_job_id="r001-j0001",
                         campaign_total_jobs=600, campaign_attempt=1)
        golden = H["canonical"](H["proof_for"](request, request["candidates"][0], successor))
        measured = {}
        test = self

        class HeldLease(Exception):
            pass

        class API:
            @contextmanager
            def lease(self, _mid):
                measured["retained_traced_bytes"] = tracemalloc.get_traced_memory()[0]
                exclusion = json.loads((root / "archived-reuse-journal/source-exclusion.json").read_bytes())
                test.assertEqual(H["canonical"](exclusion["proof"]), golden)
                raise HeldLease()
                yield

        original_module = H["module"]
        factory = mock.Mock(return_value=API())
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            path = root / "request.json"
            raw = H["canonical"](request)
            path.write_bytes(raw)
            path.chmod(0o600)
            original_sha = H["sha"](raw)
            with mock.patch.dict(H["allocate"].__globals__, NativeAdapter=factory,
                module=lambda name: {"Fly": lambda *_: None} if name == "cloudbench-original-volume-capture.py" else original_module(name)):
                tracemalloc.start()
                try:
                    with self.assertRaises(HeldLease):
                        H["allocate"](path, original_sha, 0, successor, root, "no-provider")
                finally:
                    tracemalloc.stop()
                self.assertLess(measured["retained_traced_bytes"], len(raw))
                factory.reset_mock()
                with self.assertRaisesRegex(ValueError, "request bytes changed"):
                    H["allocate"](path, "0" * 64, 0, successor, root, "no-provider")
                # Invalid nonselected rows still fail full validation before effects.
                request["candidates"][-1]["source_config_sha256"] = "invalid"
                changed = H["canonical"](request)
                path.write_bytes(changed)
                with self.assertRaises(ValueError):
                    H["allocate"](path, H["sha"](changed), 0, successor, root, "no-provider")
                factory.assert_not_called()


    def test_main_thread_lease_avoids_slow_child_and_keeps_raw_receipts(self):
        with native_read_server({}) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            with mock.patch.object(adapter, "_run_wire", side_effect=subprocess.TimeoutExpired("slow child startup", 25)) as child:
                with adapter.lease("a" * 14):
                    self.assertEqual(adapter.nonce, "fixture-nonce")
                child.assert_not_called()
            self.assertIsNone(adapter.nonce)
            self.assertEqual([r[0] for r in api.lease_requests], ["POST", "DELETE"])
            for folder in Path(directory).iterdir():
                request = json.loads((folder / "request.json").read_bytes())
                raw = json.loads((folder / "0001-wire.json").read_bytes())
                self.assertEqual(request["timeout"], 20)
                self.assertTrue(json.loads((folder / "transport-start.json").read_bytes())["direct"])
                self.assertEqual(raw["status"], 200)
                self.assertTrue((folder / "result.json").is_file())

    def test_direct_lease_deadline_retains_unknown_and_restores_timer(self):
        import signal
        import time

        with native_read_server({}) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            real_api = api.api
            window = adapter._lease_wire.__globals__["native_wire_window"]

            def delayed_result(*args, **kwargs):
                value = real_api(*args, **kwargs)
                time.sleep(0.3)
                return value

            prior_handler = signal.getsignal(signal.SIGALRM)
            prior_timer = signal.getitimer(signal.ITIMER_REAL)
            sentinel = lambda *args: self.fail("longer caller alarm fired")
            signal.signal(signal.SIGALRM, sentinel)
            signal.setitimer(signal.ITIMER_REAL, 2)
            try:
                with (
                    mock.patch.object(api, "api", side_effect=delayed_result),
                    mock.patch.dict(adapter._lease_wire.__globals__, native_wire_window=lambda _: window(time.monotonic() + 0.05)),
                    self.assertRaises(H["NativeWireDeadline"]),
                    adapter.lease("a" * 14),
                ):
                    self.fail("late lease was accepted")
                self.assertIs(signal.getsignal(signal.SIGALRM), sentinel)
                self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 1)
                self.assertIsNone(adapter.nonce)
                self.assertEqual([r[0] for r in api.lease_requests], ["POST"])
                self.assertEqual(len(list(Path(directory).glob("*/0001-wire.json"))), 1)
                self.assertFalse(list(Path(directory).glob("*/result.json")))
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, prior_handler)
                signal.setitimer(signal.ITIMER_REAL, *prior_timer)

    def test_worker_thread_lease_keeps_bounded_child_transport(self):
        from concurrent.futures import ThreadPoolExecutor

        with native_read_server({}) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            with mock.patch.object(adapter, "_run_wire", wraps=adapter._run_wire) as child:
                def operation():
                    with adapter.lease("a" * 14):
                        self.assertEqual(adapter.nonce, "fixture-nonce")
                with ThreadPoolExecutor(max_workers=1) as workers:
                    workers.submit(operation).result(timeout=5)
                self.assertEqual(child.call_count, 2)
            self.assertTrue(all(
                json.loads(path.read_bytes())["direct"] is False
                for path in Path(directory).glob("*/transport-start.json")
            ))

    def test_direct_observation_does_not_reload_private_io(self):
        import time

        _, machines, _ = fixture()
        original = H["runpy"].run_path
        for phase in ("result-save", "result-read"):
            with (
                self.subTest(phase=phase),
                native_read_server(machines[0]) as api,
                tempfile.TemporaryDirectory() as directory,
            ):
                state = {"http_returned": False, "reloads": 0}
                call = api.api

                def observed_http(*args, _call=call, _state=state, **kwargs):
                    result = _call(*args, **kwargs)
                    _state["http_returned"] = True
                    return result

                def slow_reload(path, *args, _state=state, _phase=phase, **kwargs):
                    if (
                        Path(path).name == "cloudbench-original600-runner.py"
                        and _state["http_returned"]
                    ):
                        _state["reloads"] += 1
                        if _state["reloads"] == (1 if _phase == "result-save" else 2):
                            time.sleep(
                                1
                            )  # Same post-HTTP reload boundaries as the retained failures.
                    return original(path, *args, **kwargs)

                adapter = H["NativeAdapter"](api, directory)
                with (
                    mock.patch.object(api, "api", side_effect=observed_http),
                    mock.patch.object(H["runpy"], "run_path", side_effect=slow_reload),
                ):
                    observed = adapter.observe_inactive(
                        "/machines/" + machines[0]["id"], time.monotonic() + 0.75
                    )
                self.assertEqual(observed, machines[0])
                self.assertTrue(state["http_returned"])
                self.assertEqual(state["reloads"], 0)
                raw = json.loads(
                    next(Path(directory).glob("*/0001-wire.json")).read_bytes()
                )
                self.assertEqual(raw["status"], 200)
                self.assertTrue(next(Path(directory).glob("*/result.json")).is_file())

    def test_private_io_keeps_exclusive_write_and_private_read_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            H["save"](path, {"receipt": "original"})
            self.assertEqual(json.loads(H["private"](path)), {"receipt": "original"})
            with self.assertRaises(FileExistsError):
                H["save"](path, {"receipt": "replacement"})
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private current-owner"):
                H["private"](path)
            path.chmod(0o600)
            alias = Path(directory) / "alias.json"
            alias.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "physical private input"):
                H["private"](alias)

    def test_claim_observation_avoids_slow_child_startup(self):
        import time

        _, machines, _ = fixture()
        expected = machines[0]
        with native_read_server(expected) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            original = adapter._run_wire
            starts = []

            def delayed_start(*args):
                starts.append(True)
                time.sleep(10.05)  # Scheduling before the old child's first HTTP request.
                return original(*args)

            with mock.patch.object(adapter, "_run_wire", side_effect=delayed_start):
                observed = H["wait_inactive"](adapter, "/machines/" + expected["id"], expected)
            self.assertEqual(observed, expected)
            self.assertEqual(starts, [])
            wire = json.loads(next(Path(directory).glob("*/0001-wire.json")).read_bytes())
            self.assertEqual(wire["status"], 200)
            http = json.loads(next(Path(directory).glob("*/http-start.json")).read_bytes())
            self.assertLessEqual(http["monotonic_ns"], wire["monotonic_ns"])

    def test_direct_observation_bounds_drip_and_restores_caller_alarm(self):
        import signal
        import time

        _, machines, _ = fixture()
        with native_read_server(machines[0], drip=True) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            prior = signal.getsignal(signal.SIGALRM)
            signal.signal(signal.SIGALRM, lambda *args: self.fail("longer caller alarm fired"))
            handler = signal.getsignal(signal.SIGALRM)
            signal.setitimer(signal.ITIMER_REAL, 2)
            start = time.monotonic()
            try:
                with self.assertRaises(H["ObservationDeadline"]):
                    adapter.observe_inactive("/machines/" + machines[0]["id"], start + 0.15)
                self.assertLess(time.monotonic() - start, 1)
                self.assertIs(signal.getsignal(signal.SIGALRM), handler)
                self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 0.5)
                self.assertFalse(list(Path(directory).glob("*/result.json")))
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, prior)

    def test_thread_observation_keeps_owned_child_transport(self):
        import time
        from concurrent.futures import ThreadPoolExecutor

        _, machines, _ = fixture()
        with native_read_server(machines[0]) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            with (
                mock.patch.object(adapter, "_run_wire", wraps=adapter._run_wire) as launch,
                ThreadPoolExecutor(max_workers=1) as workers,
            ):
                result = workers.submit(
                    adapter.observe_inactive, "/machines/" + machines[0]["id"], time.monotonic() + 10
                ).result()
            self.assertEqual(result, machines[0])
            self.assertEqual(launch.call_count, 1)

    def test_direct_observation_never_retries_malformed_success(self):
        with native_read_server(b"invalid-json") as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            with (
                mock.patch.object(adapter, "_run_wire", side_effect=AssertionError("no fallback")),
                self.assertRaises(json.JSONDecodeError),
            ):
                adapter.observe_inactive("/machines/" + "a" * 14, __import__("time").monotonic() + 10)
            records = list(Path(directory).glob("*/0001-wire.json"))
            self.assertEqual(len(records), 1)
            self.assertEqual(json.loads(records[0].read_bytes())["status"], 200)
            self.assertFalse(list(Path(directory).glob("*/result.json")))

    def test_direct_observation_refuses_periodic_caller_before_io(self):
        import signal
        import time

        _, machines, _ = fixture()
        with native_read_server(machines[0]) as api, tempfile.TemporaryDirectory() as directory:
            adapter = H["NativeAdapter"](api, directory)
            before = signal.getsignal(signal.SIGALRM)
            signal.signal(signal.SIGALRM, lambda *args: None)
            signal.setitimer(signal.ITIMER_REAL, 5, 5)
            try:
                with self.assertRaisesRegex(ValueError, "periodic"):
                    adapter.observe_inactive("/machines/" + machines[0]["id"], time.monotonic() + 10)
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[1], 5)
                self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, before)

    def test_capacity_all376_preserves_original600(self):
        request, machines, _ = fixture(376)
        result = H["capacity_demand"](request, machines, {"f" * 14})
        self.assertEqual(result["new_machine_demand"], 225)
        self.assertEqual(result["qualified_reuse_count"], 376)
        self.assertEqual(result["original_tasks"], 600)
        self.assertEqual(len({r["name"] for r in machines}), 376)

    def test_stale_foreign_protected_or_duplicate_never_get_capacity_credit(self):
        for change in ("running", "version", "config", "volume", "protected", "duplicate", "marker"):
            request, machines, _ = fixture()
            protected = set()
            if change == "running":
                machines[0]["state"] = "started"
            if change == "version":
                machines[0]["instance_id"] = "changed"
            if change == "config":
                machines[0]["config"]["extra"] = "changed"
            if change == "volume":
                machines[0]["config"]["mounts"][0]["volume"] = "vol_foreign"
            if change == "protected":
                protected.add(machines[0]["id"])
            if change == "duplicate":
                request["candidates"].append(request["candidates"][0])
            if change == "marker":
                machines[0]["config"]["metadata"] = {H["MARKER"]: "foreign"}
            with self.subTest(change=change), self.assertRaises(ValueError):
                H["capacity_demand"](request, machines, protected)

    def claim_deadline_fixture(self, mode="success"):
        import io
        import signal
        import time

        request, machines, successor = fixture()
        request["task_names"] = json.loads(
            (Path(__file__).parent / "fixtures/original600-tasks.json").read_bytes()
        )
        request["candidates"][0]["reservation"] = {"cohort": request["cohort"]}
        successor.update(
            task=request["task_names"][0],
            campaign_job_id="r001-j0001",
            campaign_total_jobs=600,
            campaign_attempt=1,
        )
        state = dict(
            current=copy.deepcopy(machines[0]),
            posts=0,
            leases=0,
            releases=0,
            faulted=False,
        )
        test = self

        class Transport:
            app = H["APP"]

            def __init__(self, *_args):
                pass

            def api(self, method, path, body=None, **kwargs):
                if path.endswith("/lease"):
                    if method == "POST":
                        state["leases"] += 1
                        value = {"data": {"nonce": "nonce-" + str(state["leases"])}}
                    else:
                        state["releases"] += 1
                        if mode == "release-failure" and state["leases"] == 1:
                            raise ValueError("original lease release unknown")
                        value = {}
                elif method == "POST":
                    state["posts"] += 1
                    test.assertEqual(state["posts"], 1)
                    state["current"] = dict(
                        state["current"],
                        config=body["config"],
                        instance_id="claim-ACK",
                        state="stopped",
                    )
                    value = state["current"]
                else:
                    test.assertEqual(method, "GET")
                    value = copy.deepcopy(state["current"])
                    if state["leases"] == 2:
                        if mode == "changed-instance":
                            value["instance_id"] = "later-same-config"
                        if mode == "changed-config":
                            value["config"]["extra"] = "foreign"
                        if mode == "changed-marker":
                            value["config"]["metadata"][H["MARKER"]] = "foreign"
                        if mode == "started":
                            value["state"] = "started"
                        if mode == "evidence-drift":
                            original = (
                                root / "archived-reuse-journal/original-native.json"
                            )
                            original.write_bytes(original.read_bytes() + b"\n")
                        if mode == "cancel":
                            signal.raise_signal(signal.SIGTERM)
                        if mode == "expired":
                            raise H["ObservationDeadline"]("fresh read unknown")
                status = 201 if method == "POST" and path.endswith("/lease") else 200
                if (
                    mode == "lease-200"
                    and state["leases"] == 1
                    and path.endswith("/lease")
                ):
                    status = 200
                kwargs["observer"](method, path, status, H["canonical"](value))
                return copy.deepcopy(value)

        def direct(adapter, directory, method, path, body, timeout, headers, errors):
            H["NativeAdapter"](adapter.api, directory).perform_wire(
                dict(
                    app=adapter.api.app,
                    method=method,
                    path=path,
                    body=body,
                    timeout=timeout,
                    headers=headers or {},
                )
            )

        original_save = H["_PRIVATE_IO"]["save"]

        def interrupted_save(path, value):
            original_save(path, value)
            if mode == "complete-cancel" and Path(path).name == "complete.json":
                signal.raise_signal(signal.SIGTERM)
            if (
                str(path).endswith("-wire.json")
                and value.get("method") == "GET"
                and state["posts"] == 1
                and not state["faulted"]
            ):
                state["faulted"] = True
                raise H["ObservationDeadline"]("inactive native observation deadline")

        original_module = H["module"]

        def modules(name):
            return (
                {"Fly": Transport}
                if name == "cloudbench-original-volume-capture.py"
                else original_module(name)
            )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "request.json"
            raw = H["canonical"](request)
            path.write_bytes(raw)
            path.chmod(0o600)
            deadline = str(
                time.monotonic() - 1
                if mode == "expired-deadline"
                else time.monotonic() + 120
            )
            with (
                mock.patch.dict(H["allocate"].__globals__, module=modules),
                mock.patch.object(H["NativeAdapter"], "_run_wire", direct),
                mock.patch.dict(H["_PRIVATE_IO"], save=interrupted_save),
                mock.patch("sys.stderr", io.StringIO()) as captured,
                mock.patch.dict(
                    os.environ, RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC=deadline
                ),
            ):
                if mode == "success":
                    proof = H["allocate"](
                        path, H["sha"](raw), 0, successor, root, "fixture"
                    )
                    self.assertEqual(proof["machine_id"], machines[0]["id"])
                    receipt = json.loads(
                        (
                            root / "archived-reuse-read-reconciliation/complete.json"
                        ).read_bytes()
                    )
                    self.assertTrue(receipt["original_failure_retained"])
                    self.assertFalse(receipt["timely_original_read"])
                else:
                    with self.assertRaises(
                        (ValueError, H["ObservationDeadline"], H["ClaimReadCancelled"])
                    ):
                        H["allocate"](
                            path, H["sha"](raw), 0, successor, root, "fixture"
                        )
                    self.assertFalse((root / "archived-reuse-proof.json").exists())
                self.assertEqual(state["posts"], 1)
                self.assertEqual(
                    state["leases"],
                    1
                    if mode in ("release-failure", "lease-200", "expired-deadline")
                    else 2,
                )
                if mode != "release-failure":
                    self.assertEqual(
                        state["releases"],
                        1 if mode in ("lease-200", "expired-deadline") else 2,
                    )
                    pending = root / "archived-reuse-read-reconciliation/pending.json"
                    pending_value = json.loads(pending.read_bytes())
                    self.assertTrue(pending_value["original_failure_retained"])
                    error_path = pending.parent/"original-error.json"
                    self.assertEqual(pending_value["original_error_sha256"], H["sha"](error_path.read_bytes()))
                    original_error = json.loads(error_path.read_bytes())
                    self.assertEqual(original_error["error_type"], "ObservationDeadline")
                    self.assertIn("claim_native", original_error["traceback"])
                    self.assertIn("wait_inactive", original_error["traceback"])
                    self.assertIn('"event": "CLAIM_OBSERVATION_DEADLINE"', captured.getvalue())
                    self.assertIn('"timely_original_read": false', captured.getvalue())
                    expected_event = "READ_RECONCILED_AFTER_RECORDED_DEADLINE" if mode == "success" else "CLAIM_READ_RECONCILIATION_FAILED"
                    self.assertIn('"event": "'+expected_event+'"', captured.getvalue())
                    previous = dict(state)
                    with self.assertRaises(FileExistsError):
                        H["reconcile_claim_read"](
                            H["NativeAdapter"](Transport(), root / "unused-wire"),
                            request,
                            request["candidates"][0],
                            successor,
                            root,
                            H["ObservationDeadline"]("old"),
                            H["sha"](raw),
                        )
                    self.assertEqual(state, previous)

    def test_allocate_deadline_retains_failure_and_reconciles_once_without_cas_replay(
        self,
    ):
        self.claim_deadline_fixture()

    def test_allocate_deadline_refuses_changed_unknown_cancelled_or_unclosed_claim(
        self,
    ):
        for mode in (
            "changed-instance",
            "changed-config",
            "changed-marker",
            "started",
            "cancel",
            "complete-cancel",
            "expired",
            "release-failure",
            "lease-200",
            "expired-deadline",
            "evidence-drift",
        ):
            with self.subTest(mode=mode):
                self.claim_deadline_fixture(mode)

    def test_native_claim_preserves_id_volume_and_oldname_and_is_idempotent(self):
        request, machines, successor = fixture()
        current = copy.deepcopy(machines[0])
        effects = []

        class API:
            @contextmanager
            def lease(self, mid):
                effects.append(("lease", mid))
                yield

            def request(self, method, url, body=None, *, timeout=30):
                nonlocal current
                if method == "GET":
                    if "/wait?state=created" in url:
                        raise ValueError("HTTP400 invalid wait state: created")
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                effects.append((method, url, body))
                self.assert_version(body)
                current = dict(current, config=body["config"], instance_id="new-version", state="created")
                return copy.deepcopy(current)

            def assert_version(self, body):
                assert body["current_version"] == "old-version-0" and body["skip_launch"] is True

        with tempfile.TemporaryDirectory() as tmp:
            result = H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "journal")
            again = H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "journal")
            self.assertEqual(result, again)
            self.assertEqual(current["id"], machines[0]["id"])
            self.assertEqual(current["name"], "old-native-0")
            self.assertEqual(current["config"]["mounts"], machines[0]["config"]["mounts"])
            self.assertEqual(sum(e[0] == "POST" for e in effects), 1)
            self.assertNotIn("fresh-clone", json.dumps(result))
            self.assertIn("UNRESOLVED", result["old_liabilities"])
            self.assertEqual(result["guest"]["data_dir"], "/data/.cloudbench-generations/" + result["claim_id"])
            self.assertTrue((Path(tmp) / "journal/source-exclusion.json").exists())

    def test_lost_ack_or_foreign_claim_never_reposts_or_releases(self):
        request, machines, successor = fixture()
        current = copy.deepcopy(machines[0])
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                nonlocal current
                if method == "GET":
                    if "/wait?state=created" in url:
                        raise ValueError("HTTP400 invalid wait state: created")
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                posts.append(body)
                current = dict(current, config=body["config"], instance_id="new-version")
                raise TimeoutError("lost ACK")

        with tempfile.TemporaryDirectory() as tmp:
            journal = Path(tmp) / "journal"
            with self.assertRaises(TimeoutError):
                H["claim_native"](API(), request, request["candidates"][0], successor, journal)
            H["claim_native"](API(), request, request["candidates"][0], successor, journal)
            self.assertEqual(len(posts), 1)
            successor["owner_token"] = "9" * 32
            with self.assertRaises(ValueError):
                H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "foreign")
            self.assertEqual(len(posts), 1)


class IntegratedControls(unittest.TestCase):
    def test_actual_fly_mutation_grammar_and_owner_journals(self):
        import shlex

        root = Path(__file__).resolve().parents[2]
        source = (root / "scripts/run-bench-fleet").read_text()
        function = "FLY() {" + source.split("FLY() {", 1)[1].split("\nis_sim_on()", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "calls"
            prefix = (
                "source "
                + shlex.quote(str(root / "scripts/lib/cloudbench-archived-reuse.sh"))
                + "\n"
                + "APP=navi-whisper-lux-bench; ROOT_DIR="
                + shlex.quote(str(root))
                + "\n"
                + "GIT_COMMON_DIR="
                + shlex.quote(tmp)
                + "; FLEET_OWNER_TOKEN="
                + "a" * 32
                + "; RUN_ID=first; CAPTURE="
                + shlex.quote(str(capture))
                + "\n"
                + "private_source_allows_provider_call(){ return 0; }\n"
                + 'python3(){ printf "%s\\n" "$*" >> "$CAPTURE"; }\n'
                + function
            )
            for args in (
                "machine destroy --force 1234567890abcd -a navi-whisper-lux-bench",
                "machines destroy 1234567890abcd --app=navi-whisper-lux-bench -f",
                "machine stop 1234567890abcd -a navi-whisper-lux-bench",
            ):
                result = subprocess.run(["bash", "-c", prefix + "\nFLY " + args], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            lines = capture.read_text().splitlines()
            self.assertTrue(all("--machine 1234567890abcd --operation" in line for line in lines))
            self.assertTrue(all("/" + "a" * 32 + "/first/" in line for line in lines))
            capture.unlink()
            for args in (
                "machine destroy --force 1234567890abcd 1234567890abce -a navi-whisper-lux-bench",
                "machine stop 1234567890abcd --unknown -a navi-whisper-lux-bench",
                "machine stop 1234567890abcd -a navi-whisper-lux",
            ):
                result = subprocess.run(["bash", "-c", prefix + "\nFLY " + args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            self.assertFalse(capture.exists())
            script = (
                prefix
                + "\nFLY machine stop 1234567890abcd -a navi-whisper-lux-bench\nFLEET_OWNER_TOKEN="
                + "b" * 32
                + "; RUN_ID=second\nFLY machine stop 1234567890abcd -a navi-whisper-lux-bench"
            )
            subprocess.run(["bash", "-c", script], check=True)
            first, second = capture.read_text().splitlines()
            self.assertNotEqual(first, second)

    def test_predecessor_effect_reconciles_stop_but_never_replays_unknown(self):
        _, machines, _ = fixture()
        current = copy.deepcopy(machines[0])
        current["state"] = "started"
        posts = []
        lost = False

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                if method == "GET":
                    return copy.deepcopy(current)
                posts.append((method, url))
                if lost:
                    raise TimeoutError("lost ACK")
                current["state"] = "stopped"
                return {"ok": True}

        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first"
            second = Path(tmp) / "second"
            H["fenced_native_effect"](API(), current["id"], "stop", first)
            H["fenced_native_effect"](API(), current["id"], "stop", first)
            self.assertEqual(len(posts), 1)
            current["state"] = "started"
            H["fenced_native_effect"](API(), current["id"], "stop", second)
            self.assertEqual(len(posts), 2)
            current["state"] = "started"
            lost = True
            unknown = Path(tmp) / "unknown"
            with self.assertRaises(TimeoutError):
                H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            with self.assertRaises(ValueError):
                H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            self.assertEqual(len(posts), 3)
            current["state"] = "stopped"
            H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            self.assertEqual(len(posts), 3)
            current["config"]["metadata"] = {H["MARKER"]: "successor"}
            with self.assertRaises(ValueError):
                H["fenced_native_effect"](API(), current["id"], "stop", Path(tmp) / "foreign")
            self.assertEqual(len(posts), 3)

    def test_rate_limited_predecessor_stop_is_retried_but_unknown_is_not(self):
        import http.server
        import threading

        mid = "4dae154ae13c40"
        machine = {"id": mid, "instance_id": "01FIXTURE", "state": "started", "config": {}}
        answers, stops = [], []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, value):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self.reply(200, machine)

            def do_DELETE(self):
                self.reply(200, {})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path.endswith("/lease"):
                    return self.reply(200, {"data": {"nonce": "fixture-nonce"}})
                stops.append(self.headers.get("fly-machine-lease-nonce"))
                status = answers.pop(0)
                if status == 200:
                    machine["state"] = "stopped"
                self.reply(status, {"error": "fixture"} if status != 200 else {"ok": True})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        api = object.__new__(H["module"]("cloudbench-original-volume-capture.py")["Fly"])
        api.app, api.authorization, api.loopback = H["APP"], "Bearer private-fixture", True
        api.base, api.env = f"http://127.0.0.1:{server.server_port}", dict(os.environ)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                journal = Path(tmp) / "limited"
                answers[:] = [429, 200]
                with self.assertRaises(H["NativeRejected"]):
                    H["fenced_native_effect"](H["NativeAdapter"](api, journal / "wire"), mid, "stop", journal)
                H["fenced_native_effect"](H["NativeAdapter"](api, journal / "wire"), mid, "stop", journal)
                self.assertEqual(stops, ["fixture-nonce", "fixture-nonce"])
                (incarnation,) = [path for path in journal.iterdir() if path.name != "wire"]
                rejected = incarnation / "rejected-0001"
                self.assertEqual(json.loads((rejected / "receipt.json").read_bytes())["status"], 429)
                self.assertEqual(json.loads((rejected / "intent.json").read_bytes())["operation"], "stop")
                self.assertTrue((incarnation / "ack.json").is_file())
                machine["state"], stops[:] = "started", []
                unknown = Path(tmp) / "unknown"
                answers[:] = [500, 200]
                with self.assertRaises(Exception) as failure:
                    H["fenced_native_effect"](H["NativeAdapter"](api, unknown / "wire"), mid, "stop", unknown)
                self.assertNotIsInstance(failure.exception, H["NativeRejected"])
                with self.assertRaises(ValueError):
                    H["fenced_native_effect"](H["NativeAdapter"](api, unknown / "wire"), mid, "stop", unknown)
                self.assertEqual(len(stops), 1)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_actual600_single_task_children_and_retry_indices(self):
        request, machines, successor = fixture(376)
        names = json.loads((Path(__file__).parent / "fixtures/original600-tasks.json").read_text())
        request["task_names"] = names
        for index in (0, 199, 200, 599):
            child = dict(
                successor,
                campaign_job_id=f"r{index // 200 + 1:03d}-j{index + 1:04d}",
                campaign_total_jobs=600,
                campaign_attempt=1,
                task=names[index % 200],
            )
            self.assertEqual(H["campaign_candidate_index"](request, child), index)
            for key, value in [
                ("ordinal", index + 1),
                ("task", "wrong"),
                ("campaign_total_jobs", 599),
                ("campaign_job_id", "r999-j0001"),
            ]:
                with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                    H["campaign_candidate_index"](request, dict(child, **{key: value}))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            for row in request["candidates"]:
                row["reservation"] = {"cohort": request["cohort"]}
            H["save"](path, request)
            env = dict(
                os.environ,
                CLOUDBENCH_ARCHIVED_REUSE_REQUEST=str(path),
                CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=H["sha"](path.read_bytes()),
                RUN_BENCH_CAMPAIGN_JOB_ID="r002-j0201",
                RUN_BENCH_CAMPAIGN_TOTAL_JOBS="600",
            )
            command = [
                "python3",
                "-S",
                str(Path(__file__).resolve().parents[1] / "cloudbench-archived-machine-reuse.py"),
                "capacity-credit",
                "--task",
                names[0],
            ]
            self.assertEqual(subprocess.check_output(command, env=env, text=True).strip(), "1")
            env["RUN_BENCH_CAMPAIGN_ATTEMPT"] = "2"
            self.assertEqual(subprocess.check_output(command, env=env, text=True).strip(), "0")

    def test_reservation_before_credit_created_resume_and_foreign_cohort(self):
        request, machines, _ = fixture()
        current = copy.deepcopy(machines[0])
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                nonlocal current
                if method == "GET":
                    if "/wait?state=created" in url:
                        raise ValueError("HTTP400 invalid wait state: created")
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                posts.append(body)
                current = dict(current, config=body["config"], instance_id="reserved-version", state="created")
                return copy.deepcopy(current)

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                H["capacity_demand"](request, machines, set(), require_reserved=True)
            reserved = H["reserve_cohort"](lambda out: API(), request, Path(directory) / "first")
            self.assertEqual(
                H["capacity_demand"](reserved, [current], set(), require_reserved=True)["new_machine_demand"], 600
            )
            self.assertEqual(H["reserve_cohort"](lambda out: API(), request, Path(directory) / "first"), reserved)
            self.assertEqual(len(posts), 1)
            with self.assertRaises(ValueError):
                H["reserve_cohort"](lambda out: API(), dict(request, cohort="f" * 32), Path(directory) / "foreign")
            self.assertEqual(len(posts), 1)

    def test_unknown_candidate_is_held_while_others_finish_and_plan_closes(self):
        request, machines, _ = fixture(2)
        current = {m["id"]: copy.deepcopy(m) for m in machines}
        first, second = [m["id"] for m in machines]
        calls = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                mid = url.split("/")[-1]
                calls.append((mid, method))
                if mid == first:
                    raise TimeoutError("read-only timeout")
                if method == "POST":
                    current[mid] = dict(current[mid], config=body["config"], instance_id="reserved", state="created")
                return copy.deepcopy(current[mid])

        with tempfile.TemporaryDirectory() as directory:
            resolved = H["reserve_cohort"](lambda out: API(), request, directory)
            self.assertEqual([r["machine_id"] for r in resolved["candidates"]], [second])
            self.assertEqual([r["machine_id"] for r in resolved["held_native_reservations"]], [first])
            self.assertTrue(resolved["held_native_reservations"][0]["not_credited"])
            self.assertEqual(
                H["capacity_demand"](resolved, list(current.values()), set(), require_reserved=True)[
                    "new_machine_demand"
                ],
                600,
            )
            before = list(calls)
            again = H["reserve_cohort"](
                lambda out: self.fail("closed plan must not replay held operations"), request, directory
            )
            self.assertEqual(again, resolved)
            self.assertEqual(calls, before)

    def test_cancelled_before_dispatch_records_receipt_and_resumes_once(self):
        import threading

        request, machines, _ = fixture()
        current = copy.deepcopy(machines[0])
        posts = []
        events = []
        original_event = threading.Event

        def event_factory():
            value = original_event()
            events.append(value)
            return value

        class API:
            cancel = True

            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                nonlocal current
                if method == "GET":
                    if self.cancel:
                        events[0].set()
                    return copy.deepcopy(current)
                posts.append(body)
                current = dict(current, config=body["config"], instance_id="reserved", state="created")
                return copy.deepcopy(current)

        api = API()
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(threading, "Event", side_effect=event_factory):
                with self.assertRaisesRegex(ValueError, "interrupted before native update"):
                    H["reserve_cohort"](lambda out: api, request, directory)
            out = Path(directory) / current["id"]
            before = (out / "intent.json").read_bytes()
            self.assertTrue((out / "not-dispatched.json").is_file())
            self.assertFalse((out / "dispatch-entered.json").exists())
            self.assertEqual(posts, [])
            api.cancel = False
            H["reserve_cohort"](lambda out: api, request, directory)
            self.assertEqual((out / "intent.json").read_bytes(), before)
            self.assertEqual(len(posts), 1)

    def test_inactive_version_observation_is_bounded_and_exact(self):
        _, machines, _ = fixture()
        expected = copy.deepcopy(machines[0])
        expected["state"] = "created"
        calls = []

        class API:
            def request(self, method, url, body=None, *, timeout=30):
                calls.append((method, url, timeout))
                return dict(expected, instance_id="wrong-incarnation")

        clock = H["wait_inactive"].__globals__["time"]
        with mock.patch.object(clock, "monotonic", side_effect=[0, 0, 0, 0, 11]), mock.patch.object(clock, "sleep"):
            with self.assertRaisesRegex(ValueError, "observation deadline"):
                H["wait_inactive"](API(), "/machines/" + expected["id"], expected)
        self.assertEqual(calls, [("GET", "/machines/" + expected["id"], 10)])

    def test_claim_observation_uses_twenty_seconds_without_extending_reservation(self):
        _, machines, _ = fixture()
        expected = copy.deepcopy(machines[0])
        calls = []

        class API:
            def request(self, method, url, body=None, *, timeout=30):
                calls.append(timeout)
                return expected

        clock = H["wait_inactive"].__globals__["time"]
        with mock.patch.object(clock, "monotonic", side_effect=[0, 0, 15]):
            self.assertEqual(H["wait_inactive"](API(), "/machines/x", expected, timeout=20), expected)
        self.assertEqual(calls, [20])
        with mock.patch.object(clock, "monotonic", side_effect=[0, 0, 21]):
            with self.assertRaisesRegex(ValueError, "late inactive"):
                H["wait_inactive"](API(), "/machines/x", expected, timeout=20)
        with mock.patch.object(clock, "monotonic", side_effect=[0, 0, 11]):
            with self.assertRaisesRegex(ValueError, "late inactive"):
                H["wait_inactive"](API(), "/machines/x", expected)
        self.assertEqual(calls, [20, 20, 10])
        for invalid in (0, -1, 21, float("inf"), float("nan"), True):
            with self.assertRaisesRegex(ValueError, "invalid inactive"):
                H["wait_inactive"](API(), "/machines/x", expected, timeout=invalid)

    def test_lost_reservation_ack_with_old_visibility_never_reposts(self):
        request, machines, _ = fixture()
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                if method == "GET":
                    return copy.deepcopy(machines[0])
                posts.append(body)
                raise TimeoutError("unknown provider effect")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TimeoutError):
                H["reserve_cohort"](lambda out: API(), request, directory)
            with self.assertRaises(ValueError):
                H["reserve_cohort"](lambda out: API(), request, directory)
            self.assertEqual(len(posts), 1)

    def test_actual_archive_parser_and_current_marker_exclusion(self):
        previous = runpy.run_path(str(Path(__file__).with_name("cloudbench-archived-owner-stop.test.py")))[
            "ArchivedStop"
        ]()
        previous.setUp()
        try:
            inventory = json.loads(previous.inventory.read_text())
            inventory[0]["state"] = "stopped"
            inventory[0]["region"] = "iad"
            previous.inventory.write_text(json.dumps(inventory))
            previous.inventory.chmod(0o600)
            request = H["prepare_request"]([previous.run], previous.inventory, "c" * 32, "d" * 40)
            self.assertEqual([r["machine_id"] for r in request["candidates"]], [previous.mid])
            inventory[0]["config"]["metadata"] = {H["MARKER"]: "new-successor"}
            previous.inventory.write_text(json.dumps(inventory))
            previous.inventory.chmod(0o600)
            with self.assertRaises(ValueError):
                H["prepare_request"]([previous.run], previous.inventory, "e" * 32, "d" * 40)
            with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                H["prepare_request"]([previous.run], previous.inventory, "e" * 32, "d" * 40, [previous.mid])
            terminal = previous.run / "terminal.json"
            invalid = json.loads(terminal.read_text())
            invalid["release"]["machine_deleted"] = False
            terminal.write_text(json.dumps(invalid))
            with self.assertRaisesRegex(ValueError, "joined released original controller"):
                H["prepare_request"]([previous.run], previous.inventory, "e" * 32, "d" * 40, [previous.mid])
        finally:
            previous.doCleanups()

    def test_unused_rows_merge_before_nonempty_without_weakening_original_archive(self):
        previous = runpy.run_path(str(Path(__file__).with_name("cloudbench-archived-owner-stop.test.py")))[
            "ArchivedStop"
        ]()
        previous.setUp()
        try:
            inventory = json.loads(previous.inventory.read_text())
            inventory[0].update(state="stopped", region="iad")
            previous.inventory.write_text(json.dumps(inventory))
            original = H["prepare_request"]([previous.run], previous.inventory, "c" * 32, "d" * 40)
            row = copy.deepcopy(original["candidates"][0])
            legacy = row["archive_sha256"]
            inventory[0]["config"]["metadata"] = {H["MARKER"]: "reserved-prior-cohort"}
            previous.inventory.write_text(json.dumps(inventory))
            row.update(
                prior_marker="reserved-prior-cohort",
                legacy_archive_sha256=legacy,
                archive_sha256="f" * 64,
                source_config_sha256=H["config_sha"](inventory[0]["config"]),
            )
            carried = dict(candidates=[row], archive=dict(controller="9" * 14, archive_sha256="f" * 64, inputs={}))
            load = H["prepare_request"].__globals__["module"]

            def modules(name):
                return (
                    {"prepare": lambda run, path: copy.deepcopy(carried)}
                    if name == "cloudbench-unused-reservations.py"
                    else load(name)
                )

            with mock.patch.dict(H["prepare_request"].__globals__, module=modules):
                merged = H["prepare_request"](
                    [previous.run],
                    previous.inventory,
                    "c" * 32,
                    "d" * 40,
                    unused_runs=[previous.root / "closed-admission"],
                )
                self.assertEqual(merged["candidates"], [row])
                self.assertNotIn("reservation", merged["candidates"][0])
                self.assertEqual({a["archive_sha256"] for a in merged["archives"]}, {legacy, "f" * 64})
                with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                    H["prepare_request"](
                        [previous.run],
                        previous.inventory,
                        "c" * 32,
                        "d" * 40,
                        [previous.mid],
                        [previous.root / "closed-admission"],
                    )
                with self.assertRaisesRegex(ValueError, "duplicate unused Machine/Volume"):
                    H["prepare_request"](
                        [previous.run],
                        previous.inventory,
                        "c" * 32,
                        "d" * 40,
                        unused_runs=[previous.root / "one", previous.root / "two"],
                    )
                prior = copy.deepcopy(carried["candidates"][0]["predecessor"])
                carried["candidates"][0]["predecessor"]["volume_id"] = "vol_forged"
                with self.assertRaisesRegex(ValueError, "original ownership differs"):
                    H["prepare_request"](
                        [previous.run],
                        previous.inventory,
                        "c" * 32,
                        "d" * 40,
                        unused_runs=[previous.root / "closed-admission"],
                    )
                carried["candidates"][0]["predecessor"] = prior
                carried["candidates"][0]["legacy_archive_sha256"] = "e" * 64
                with self.assertRaisesRegex(ValueError, "original archive not supplied"):
                    H["prepare_request"](
                        [previous.run],
                        previous.inventory,
                        "c" * 32,
                        "d" * 40,
                        unused_runs=[previous.root / "closed-admission"],
                    )
                terminal = previous.run / "terminal.json"
                invalid = json.loads(terminal.read_text())
                invalid["release"]["machine_deleted"] = False
                terminal.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(ValueError, "joined released original controller"):
                    H["prepare_request"](
                        [previous.run],
                        previous.inventory,
                        "c" * 32,
                        "d" * 40,
                        unused_runs=[previous.root / "closed-admission"],
                    )
        finally:
            previous.doCleanups()

    def test_claimed_rows_skip_only_older_archive_and_keep_latest_native_checks(self):
        import tarfile

        owner = runpy.run_path(str(Path(__file__).with_name("cloudbench-archived-owner-stop.test.py")))[
            "ArchivedStop"
        ]
        previous, latest = owner(), owner()
        previous.setUp()
        latest.setUp()
        try:
            host = "77778888999900"
            token = "b" * 32
            prefix = "git-common/cloudbench-fleet-ownership/" + token
            proof = {"schema": H["SCHEMA"], "machine_id": previous.mid, "volume_id": "vol_owned",
                     "native_name": "cloudbench-exact", "native_marker": {"generation": "current"},
                     "successor": {"owner_token": token, "controller_id": host, "run_id": "latest-run"},
                     "predecessor_archive_sha256s": [H["sha"]((previous.run / "export/originals.tar.gz").read_bytes())]}
            with tarfile.open(latest.run / "export/originals.tar.gz") as archive:
                members = {m.name: archive.extractfile(m).read() for m in archive}
            members[prefix + "/meta"] = (
                f"host={host}\napp=navi-whisper-lux-bench\nfleet_owner_token={token}\n"
                "cleanup_policy=retain\nrun_id=latest-run\n").encode()
            members[prefix + "/archived-reuse/" + previous.mid + ".json"] = json.dumps(proof).encode()
            member = "context/original600-supervisor.token.terminal.json"
            terminal = json.loads(members[member]); terminal["machine"] = host
            members[member] = json.dumps(terminal).encode()
            export = latest.run / "export"
            for path in (export / "launch.json", latest.run / "terminal.json", latest.run / "cleanup-call.intent.json",
                         export / "disposable-export.verified.json"):
                value = json.loads(path.read_text())
                for key in ("machine", "machine_id", "host"):
                    if key in value:
                        value[key] = host
                path.write_text(json.dumps(value))
            manifest = json.loads((export / "manifest.json").read_text())
            manifest["record"] = json.loads((export / "launch.json").read_text())
            (export / "manifest.json").write_text(json.dumps(manifest))
            latest.reseal(members)
            inventory = json.loads(previous.inventory.read_text())
            inventory[0].update(state="stopped", region="iad")
            inventory[0]["config"]["metadata"] = {H["MARKER"]: H["canonical"](proof["native_marker"]).decode()}
            previous.inventory.write_text(json.dumps(inventory))
            original_hash = H["sha"]((previous.run / "export/originals.tar.gz").read_bytes())
            latest_hash = H["sha"]((export / "originals.tar.gz").read_bytes())
            partition = {"candidates": [], "held_machine_ids": [previous.mid],
                         "archive": {"controller": host, "archive_sha256": latest_hash, "inputs": {}}}
            load = H["prepare_request"].__globals__["module"]

            def modules(name):
                return {"prepare": lambda *args: copy.deepcopy(partition)} if name == "cloudbench-unused-reservations.py" else load(name)

            with mock.patch.dict(H["prepare_request"].__globals__, module=modules):
                result = H["prepare_request"]([previous.run, latest.run], previous.inventory,
                                              "c" * 32, "d" * 40, unused_runs=[previous.root / "admission"])
                self.assertEqual([r["machine_id"] for r in result["candidates"]], [previous.mid])
                self.assertEqual(result["candidates"][0]["archive_sha256"], latest_hash)
                self.assertEqual({r["archive_sha256"] for r in result["archives"]}, {original_hash, latest_hash})
                self.assertFalse(result["held_prior_reservations"][0]["reuse_credit"])
                self.assertEqual(result["excluded_machine_ids"], [])
                inherited = copy.deepcopy(partition)
                inherited["held_machine_ids"] = []
                inherited["archive"]["archive_sha256"] = "f" * 64
                inherited["inherited_held_scopes"] = [{"archive_sha256": latest_hash,
                     "machine_ids": [previous.mid], "reuse_credit": False}]
                with mock.patch.dict(H["prepare_request"].__globals__, module=lambda name:
                        {"prepare": lambda *args: inherited} if name == "cloudbench-reconcile-reservations.py" else load(name)):
                    inherited_result = H["prepare_request"]([previous.run, latest.run], previous.inventory,
                        "c" * 32, "d" * 40, expired_runs=[previous.root / "expired"])
                self.assertEqual([r["machine_id"] for r in inherited_result["candidates"]], [previous.mid])
                self.assertEqual(inherited_result["candidates"][0]["archive_sha256"], latest_hash)
                both = copy.deepcopy(inherited)
                both["inherited_held_scopes"].append({
                    "archive_sha256": original_hash,
                    "machine_ids": [previous.mid],
                    "reuse_credit": False,
                })
                with mock.patch.dict(
                    H["prepare_request"].__globals__,
                    module=lambda name: {"prepare": lambda *args: both}
                    if name == "cloudbench-reconcile-reservations.py" else load(name),
                ):
                    for archives in ([previous.run, latest.run], [latest.run, previous.run]):
                        newer = H["prepare_request"](
                            archives, previous.inventory, "c" * 32, "d" * 40,
                            expired_runs=[previous.root / "expired"],
                        )
                        self.assertEqual(len(newer["candidates"]), 1)
                        candidate = newer["candidates"][0]
                        self.assertEqual(candidate["archive_sha256"], latest_hash)
                        self.assertEqual(
                            candidate["historical_hold_revalidation"]["held_archive_sha256"],
                            [original_hash],
                        )
                        self.assertFalse(candidate["historical_hold_revalidation"]["old_hold_released"])
                        self.assertEqual(candidate["historical_hold_revalidation"]["capacity_credit"], 0)
                        self.assertEqual(len(newer["held_prior_reservations"]), 2)
                    with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                        H["prepare_request"](
                            [previous.run, latest.run], previous.inventory,
                            "c" * 32, "d" * 40, excluded=[previous.mid],
                            expired_runs=[previous.root / "expired"],
                        )
                    changed = copy.deepcopy(inventory)
                    changed[0]["name"] = "foreign"
                    previous.inventory.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                        H["prepare_request"](
                            [previous.run, latest.run], previous.inventory,
                            "c" * 32, "d" * 40,
                            expired_runs=[previous.root / "expired"],
                        )
                    previous.inventory.write_text(json.dumps(inventory))
                unlinked = copy.deepcopy(both)
                unlinked["inherited_held_scopes"].append({
                    "archive_sha256": "e" * 64,
                    "machine_ids": [previous.mid],
                    "reuse_credit": False,
                })
                with mock.patch.dict(
                    H["prepare_request"].__globals__,
                    module=lambda name: {"prepare": lambda *args: unlinked}
                    if name == "cloudbench-reconcile-reservations.py" else load(name),
                ):
                    with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                        H["prepare_request"](
                            [previous.run, latest.run], previous.inventory,
                            "c" * 32, "d" * 40,
                            expired_runs=[previous.root / "expired"],
                        )
                with self.assertRaisesRegex(ValueError, "no exact archived candidates"):
                    H["prepare_request"]([previous.run], previous.inventory, "c" * 32, "d" * 40,
                                         unused_runs=[previous.root / "admission"])
                inventory[0]["config"]["metadata"][H["MARKER"]] = "unknown-later-claim"
                previous.inventory.write_text(json.dumps(inventory))
                with self.assertRaisesRegex(ValueError, "predecessor superseded"):
                    H["prepare_request"]([previous.run, latest.run], previous.inventory,
                                         "c" * 32, "d" * 40, unused_runs=[previous.root / "admission"])
        finally:
            previous.doCleanups()
            latest.doCleanups()

    def test_parked_mode_uses_guarded_carried_merge_and_rejects_duplicate_mode(self):
        previous = runpy.run_path(str(Path(__file__).with_name("cloudbench-archived-owner-stop.test.py")))[
            "ArchivedStop"
        ]()
        previous.setUp()
        try:
            inventory = json.loads(previous.inventory.read_text())
            inventory[0].update(state="stopped", region="iad")
            previous.inventory.write_text(json.dumps(inventory))
            original = H["prepare_request"]([previous.run], previous.inventory, "c" * 32, "d" * 40)
            row = copy.deepcopy(original["candidates"][0])
            row["legacy_archive_sha256"] = row["archive_sha256"]
            row["archive_sha256"] = "f" * 64
            response = {"candidates": [row], "held_machine_ids": [],
                        "archive": {"controller": "9" * 14, "archive_sha256": "f" * 64, "inputs": {}}}
            load = H["module"]
            calls = []

            def modules(name):
                if name in ("cloudbench-parked-reservations.py", "cloudbench-reconcile-reservations.py"):
                    calls.append(name)
                    return {"prepare": lambda *_: response}
                return load(name)

            run = previous.root / "parked-admission"
            with mock.patch.dict(H["prepare_request"].__globals__, module=modules):
                result = H["prepare_request"]([previous.run], previous.inventory, "c" * 32,
                                              "d" * 40, parked_runs=[run])
                self.assertEqual(result["candidates"], [row])
                self.assertEqual(calls, ["cloudbench-parked-reservations.py"])
                result = H["prepare_request"]([previous.run], previous.inventory, "c" * 32,
                                              "d" * 40, expired_runs=[run])
                self.assertEqual(result["candidates"], [row])
                self.assertEqual(calls[-1], "cloudbench-reconcile-reservations.py")
                with self.assertRaisesRegex(ValueError, "overlapping reservation"):
                    H["prepare_request"]([previous.run], previous.inventory, "c" * 32,
                                         "d" * 40, parked_runs=[run], expired_runs=[run])
                with self.assertRaisesRegex(ValueError, "overlapping reservation"):
                    H["prepare_request"]([previous.run], previous.inventory, "c" * 32,
                                         "d" * 40, unused_runs=[run], parked_runs=[run])
        finally:
            previous.doCleanups()

    def test_native_wire_reuses_auth_and_unique_durable_journals_on_resume(self):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.respond(dict(data=dict(nonce="fixture-nonce")))

            def do_DELETE(self):
                self.respond({})

            def do_GET(self):
                self.respond(dict(id="exact-fixture"))

            def respond(self, value):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                api = object.__new__(H["module"]("cloudbench-original-volume-capture.py")["Fly"])
                api.app = H["APP"]
                api.base = f"http://127.0.0.1:{server.server_port}"
                api.authorization = "Bearer already-resolved"
                api.loopback = True
                api.env = dict(os.environ, FLY_API_TOKEN="unused-original")
                for attempt in range(2):
                    adapter = H["NativeAdapter"](api, directory)
                    with adapter.lease("a" * 14):
                        self.assertEqual(adapter.request("GET", "/machines/" + "a" * 14), dict(id="exact-fixture"))
                records = list(Path(directory).glob("*/0001-wire.json"))
                self.assertEqual(len(records), 6)
                for record in records:
                    wire = json.loads(record.read_bytes())
                    self.assertEqual(wire["status"], 200)
                    self.assertEqual(H["sha"](__import__("base64").b64decode(wire["body_b64"])), wire["sha256"])
                self.assertFalse(
                    any(b"already-resolved" in path.read_bytes() for path in Path(directory).rglob("*.json"))
                )
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_lost_stop_ack_resume_and_terminal_reentry_do_not_repeat_stop(self):
        request, machines, successor = fixture()
        proof = H["proof_for"](request, request["candidates"][0], successor)
        current = copy.deepcopy(machines[0])
        current["state"] = "started"
        current["config"]["metadata"] = {H["MARKER"]: H["canonical"](proof["native_marker"]).decode()}
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None, *, timeout=30):
                if method == "GET":
                    return copy.deepcopy(current)
                posts.append(url)
                current["state"] = "stopped"
                raise TimeoutError("STOP accepted but ACK lost")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TimeoutError):
                H["retire_native"](API(), proof, directory)
            H["retire_native"](API(), proof, directory)
            H["retire_native"](API(), proof, directory)
            self.assertEqual(posts, ["/machines/" + proof["machine_id"] + "/stop"])
            terminal = json.loads((Path(directory) / "retained-terminal.json").read_bytes())
            self.assertTrue(terminal["machine_retained"])
            self.assertTrue(terminal["volume_retained"])
            self.assertEqual(terminal["old_liabilities"], "UNRESOLVED")

    def test_actual_fleet_hook_credit_and_nested_canary_scope(self):
        root = Path(__file__).resolve().parents[2]
        library = root / "scripts/lib/cloudbench-archived-reuse.sh"
        output = subprocess.check_output(
            [
                "bash",
                "-c",
                'source "$1"; CLOUDBENCH_ARCHIVED_REUSE_REQUEST=/missing; CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE=1; archived_reuse_allocate task /missing; archived_reuse_capacity_credit',
                "fixture",
                str(library),
            ],
            text=True,
        )
        self.assertEqual(output, "0")
        source = (root / "scripts/run-bench-fleet").read_text()
        start = source.index("provision_primary_machine() {")
        function = source[start : source.index("\n}\n", start) + 3]
        script = (
            function
            + "\narchived_reuse_allocate() { printf retained-mid; }; primary_vm_size_for_bench() { exit 99; }; clone_machine_target() { exit 98; }; provision_primary_machine task /unused"
        )
        subprocess.run(["bash", "-c", script], check=True)
        start = source.index("    local archived_reuse_count", source.index("enforce_app_capacity_guard()"))
        end = source.index('    if [ "${POOL_REUSE_ONLY:-0}"', start)
        fragment = source[start:end]
        script = (
            "test_guard() { requested_machines=1; available_pool_machines=0; replacement_slots=3; requested_shared=2; archived_reuse_capacity_credit() { printf 1; }; "
            + fragment
            + '\nreservation_machine_slots=$((requested_fresh_machines+replacement_slots)); printf "%s %s %s" "$requested_fresh_machines" "$reservation_machine_slots" "$requested_shared"; }; test_guard'
        )
        self.assertEqual(subprocess.check_output(["bash", "-c", script], text=True), "0 3 2")

    def test_successor_chain_binds_current_marker_and_excludes_predecessor(self):
        request, machines, successor = fixture()
        first = H["proof_for"](request, request["candidates"][0], successor)
        current = copy.deepcopy(machines[0])
        current["instance_id"] = "second-version"
        current["config"]["metadata"] = {H["MARKER"]: H["canonical"](first["native_marker"]).decode()}
        row = H["target_from"](current, dict(volume_id=first["volume_id"], archived_reuse_proof=first), "9" * 64)
        later = dict(request, cohort="8" * 32, archives=[dict(archive_sha256="9" * 64)], candidates=[row])
        second = H["proof_for"](later, row, dict(successor, owner_token="7" * 32, controller_id="6" * 14))
        self.assertNotEqual(first["generation_id"], second["generation_id"])
        self.assertEqual(first["volume_id"], second["volume_id"])
        self.assertEqual(
            second["native_marker"]["prior_marker_sha256"], H["sha"](H["canonical"](first["native_marker"]))
        )
        with self.assertRaises(ValueError):
            H["same_source"](request["candidates"][0], current)
        current["config"]["metadata"][H["MARKER"]] = H["canonical"](second["native_marker"]).decode()
        with self.assertRaises(ValueError):
            H["target_from"](current, dict(volume_id=first["volume_id"], archived_reuse_proof=first), "9" * 64)

    def test_concrete_fly_raw_observer_before_parse_and404(self):
        import io
        import urllib.error

        source = H["module"]("cloudbench-original-volume-capture.py")
        api = object.__new__(source["Fly"])
        api.app = H["APP"]
        api.base = "https://fixture.invalid"
        api.authorization = "Bearer private-fixture"
        api.loopback = False

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, size):
                return b"not-json"

        records = []
        opener = mock.Mock()
        opener.open.return_value = Response()
        with mock.patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(json.JSONDecodeError):
                api.api("GET", "/machines/a", observer=lambda *args: records.append(args))
        self.assertEqual(records[0][2:], (200, b"not-json"))
        opener.open.side_effect = urllib.error.HTTPError("fixture", 404, "missing", {}, io.BytesIO(b"actual404"))
        with mock.patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(source["NotFound"]):
                api.api("GET", "/machines/a", observer=lambda *args: records.append(args))
        self.assertEqual(records[1][2:], (404, b"actual404"))


if __name__ == "__main__":
    unittest.main()
