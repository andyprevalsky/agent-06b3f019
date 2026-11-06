from __future__ import annotations

import hashlib
import http.server
import json
import os
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import warnings
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve()
REPO = SCRIPT.parents[2]
IDENTITY = runpy.run_path(str(REPO / "scripts/process-identity.py"))


def atomic(path, value):
    path = Path(path)
    temp = path.with_name(path.name + f".{os.getpid()}.pending")
    temp.write_text(json.dumps(value) + "\n")
    temp.replace(path)


def record(folder, event, **extra):
    with (folder / "events.jsonl").open("a") as f:
        f.write(json.dumps({"at": time.monotonic(), "pid": os.getpid(), "event": event, **extra}) + "\n")


def publish_identity(folder, role):
    data = {"pid": os.getpid(), "identity": IDENTITY["current_identity"](os.getpid()), "role": role}
    atomic(folder / f"{role}.identity.json", data)
    return data


def exact_signal(identity, name):
    return IDENTITY["main"](["identity", "--expect", identity["identity"], "--signal", name, str(identity["pid"])])


def wait_path(path, timeout=10):
    end = time.monotonic() + timeout
    while not path.is_file():
        if time.monotonic() >= end:
            raise TimeoutError(f"missing readiness: {path.name}")
        time.sleep(0.01)
    return json.loads(path.read_text())


def spawn(folder, mode, *args, new_session=False, extra_env=None):
    log = (folder / f"{mode}.log").open("ab")
    try:
        return subprocess.Popen(
            [sys.executable, str(SCRIPT), mode, str(folder), *args],
            cwd=folder,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=new_session,
            env={
                "PATH": os.environ["PATH"],
                "PYTHONUNBUFFERED": "1",
                "NO_PROXY": "127.0.0.1,localhost",
                **(extra_env or {}),
            },
        )
    finally:
        log.close()


def server(folder):
    publish_identity(folder, "backend")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_DELETE(self):
            if self.path != "/api/agents/fixture-root":
                self.send_error(404)
                return
            record(folder, "root_delete")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def do_GET(self):
            record(folder, "worker_compensation_http")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    with http.server.HTTPServer(("127.0.0.1", 0), Handler) as http_server:

        def stop(sig, frame):
            record(folder, "backend_stop", signal=sig)
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        atomic(folder / "backend.ready", {"port": http_server.server_port})
        http_server.serve_forever(poll_interval=0.05)


def request(folder, method):
    port = wait_path(folder / "backend.ready")["port"]
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/agents/fixture-root", method=method)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as response:
        return response.status


def benchmark(folder, outcome="interrupted"):
    normal = outcome == "normal"
    publish_identity(folder, "benchmark")
    interrupted = False

    def stop(sig, frame):
        nonlocal interrupted
        interrupted = True
        record(folder, "benchmark_interrupt", signal=sig)

    signal.signal(signal.SIGINT, stop)
    atomic(folder / "benchmark.ready", {"pid": os.getpid()})
    print("fixture benchmark ready", flush=True)
    deadline = time.monotonic() + 5
    while not interrupted and not normal and time.monotonic() < deadline:
        time.sleep(0.01)
    if not interrupted and not normal:
        record(folder, "benchmark_uninterrupted_deadline")
        return 71
    if outcome == "repeat":
        time.sleep(0.15)
    request(folder, "DELETE")
    receipt_path = Path(os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE", str(folder / "root-cleanup.status")))
    receipt_token = os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_TOKEN", "fixture-token")
    temporary = receipt_path.with_suffix(".pending")
    if outcome != "missing":
        written_token = "wrong-token" if outcome == "wrong" else receipt_token
        state = "pending" if outcome == "pending" else "clean"
        temporary.write_text(f"version=1\ntoken={written_token}\nstate={state}\n")
        temporary.replace(receipt_path)
    atomic(folder / "root-cleanup.json", {"state": "clean", "token": receipt_token})
    atomic(
        folder / "result.json",
        {"tasks": [{"name": "fixture", "passed": normal, "status": "PASSED" if normal else "CANCELLED"}]},
    )
    record(folder, "benchmark_cleanup_complete")
    print(f"Results saved: {folder / 'result.json'}", flush=True)
    return 0 if normal else 130


def load_local():
    sys.path.insert(0, str(REPO / "agents"))
    from benchmarks import local

    return local


def test_local_launchers_preserve_inherited_proxy_configuration():
    from unittest.mock import patch

    local = load_local()
    keys = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy")
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        stack = local.ServiceStack(
            "proxy-fixture", folder, folder / "services.json", folder / "services.log", True,
            workspace_name="proxy-fixture", base_port=22001,
        )
        for configured in (False, True):
            inherited = {key: "fixture-proxy-setting" for key in keys} if configured else {}
            base = {"PATH": os.environ["PATH"], "BENCHMARK_SEED_DUMP": str(folder / "fixture.dump"), **inherited}
            expected = {key: base[key] for key in keys if key in base}
            assert {key: value for key, value in local.benchmark_runner_env(base).items() if key in keys} == expected

            for launch in ("streamed", "stack"):
                captured = []

                def capture(_command, **kwargs):
                    captured.append({key: value for key, value in kwargs["env"].items() if key in keys})
                    raise RuntimeError("fixture captured launch")

                with (
                    patch.dict(os.environ, base, clear=True),
                    patch.object(local.subprocess, "Popen", capture),
                    patch.object(local, "_release_port_range"),
                ):
                    try:
                        if launch == "streamed":
                            local.run_streamed_command(["fixture-command"], cwd=folder)
                        else:
                            local.start_services(stack, clean_first=False)
                    except RuntimeError as error:
                        assert str(error) == "fixture captured launch"
                    else:
                        raise AssertionError("fixture did not observe launch")
                assert captured == [expected], f"{launch} changed inherited proxy settings"


def driver(folder, outcome="interrupted"):
    local = load_local()
    publish_identity(folder, "controller")
    manifest = {"ports": {"backend": 1}}
    stack = local.ServiceStack("fixture", folder, folder / "services.json", folder / "services.log", False)
    args = SimpleNamespace(
        use_existing=False,
        keep_services=False,
        no_clean=False,
        anon=False,
        simulate=False,
        world_model_name=None,
        no_dashboard=True,
        eval_suite=False,
        bootstrap=False,
        max_concurrency=1,
        checkpoint_no_start=False,
        owned_recording_preparation_seconds=None,
        owned_recording_preparation_price_limit_cents=None,
    )
    backend = None
    local.parse_args = lambda _: args
    local.tasks_from_args = lambda _: ["fixture"]
    local.validate_agentcard_org_credentials = lambda _: None
    local.checkpoint_requested = lambda _: False
    local.build_service_stack = lambda _: stack
    local.configure_task_environment = lambda *a, **k: None

    def start(*a, **k):
        nonlocal backend
        backend = spawn(folder, "server", new_session=True)
        manifest["ports"]["backend"] = wait_path(folder / "backend.ready")["port"]
        return backend, manifest

    def stop(*a, **k):
        record(folder, "stack_stop", benchmark_alive=_live_role(folder, "benchmark"))
        if backend and backend.poll() is None:
            exact_signal(wait_path(folder / "backend.identity.json"), "TERM")
            backend.wait(timeout=10)

    local.start_services = start
    local.stop_services = stop
    local.apply_manifest_environment = lambda _: None
    local.dashboard_enabled = lambda **k: False
    local.needs_payment_fixture = lambda _: False
    local.needs_frontend_tunnel = lambda _: False
    local.needs_imessage_relay = lambda _: False
    local.build_benchmark_args = lambda *a, **k: [
        sys.executable,
        str(SCRIPT),
        "benchmark",
        str(folder),
        outcome,
    ]
    local.failed_tasks_from_run = lambda p: []
    return local.main(["fixture"])


def _live_role(folder, role):
    p = folder / f"{role}.identity.json"
    if not p.is_file():
        return False
    d = json.loads(p.read_text())
    try:
        return IDENTITY["current_identity"](d["pid"]) == d["identity"]
    except (OSError, ValueError, IndexError):
        return False


def worker(folder):
    publish_identity(folder, "worker")
    stop_requested = False

    def stop(sig, frame):
        nonlocal stop_requested
        stop_requested = True
        record(folder, "worker_stop_requested")

    signal.signal(signal.SIGTERM, stop)
    atomic(folder / "worker.ready", {"pid": os.getpid()})
    end = time.monotonic() + 6
    while not stop_requested and time.monotonic() < end:
        time.sleep(0.01)
    if not stop_requested:
        return 72
    time.sleep(0.15)
    try:
        assert request(folder, "GET") == 200
        record(folder, "worker_compensation_complete")
        return 0
    except Exception as error:
        record(folder, "worker_compensation_failed", error_type=type(error).__name__)
        return 7


def stack_owner(folder):
    stack_identity = publish_identity(folder, "stack")
    stack_token = os.environ.get("RUN_STACK_CLEANUP_TOKEN", "fixture-stack-token")
    stack_birth = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip()
    atomic(
        folder / "local-stack-owner.json",
        {
            "version": 1,
            "run_id": "fixture",
            "token": stack_token,
            "pid": os.getpid(),
            "native_identity": stack_identity["identity"],
            "birth": stack_birth,
        },
    )
    backend = spawn(folder, "server")
    backend_id = wait_path(folder / "backend.identity.json")
    wait_path(folder / "backend.ready")
    worker_process = spawn(folder, "worker", new_session=True)
    worker_id = wait_path(folder / "worker.identity.json")
    wait_path(folder / "worker.ready")
    stopped = False

    def stop(sig, frame):
        nonlocal stopped
        if stopped:
            return
        stopped = True
        record(folder, "stack_owner_stop")

    signal.signal(signal.SIGTERM, stop)
    atomic(folder / "stack.ready", {"pid": os.getpid()})
    atomic(folder / "services.json", {"status": "running", "run_sh_pid": os.getpid(), "services": [], "ports": {}})
    end = time.monotonic() + 6
    try:
        while not stopped and time.monotonic() < end:
            time.sleep(0.01)
        if not stopped:
            return 73
        exact_signal(worker_id, "TERM")
        code = worker_process.wait(timeout=10)
        if backend.poll() is None:
            exact_signal(backend_id, "TERM")
        backend.wait(timeout=10)
        cleanup_state = "clean" if code == 0 else "failed"
        status_path = folder / "local-stack-cleanup.status"
        pending = status_path.with_suffix(".pending")
        pending.write_text(
            f"version=1\ntoken={stack_token}\nstate={cleanup_state}\nstack_pid={os.getpid()}\nstack_birth={stack_birth}\n"
        )
        pending.replace(status_path)
        atomic(folder / "stack-cleanup.json", {"state": cleanup_state})
        atomic(folder / "services.json", {"status": "stopped", "run_sh_pid": os.getpid(), "services": [], "ports": {}})
        return code
    finally:
        for p, ident in [(worker_process, worker_id), (backend, backend_id)]:
            if p.poll() is None:
                exact_signal(ident, "TERM")
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                exact_signal(ident, "KILL")
                p.wait(timeout=10)


def cleanup(folder, direct):
    # Every identity was recorded by that exact private child, never inferred by argv/port.
    for path in folder.glob("*.identity.json"):
        ident = json.loads(path.read_text())
        exact_signal(ident, "TERM")
    end = time.monotonic() + 10
    while time.monotonic() < end and any(
        _live_role(folder, p.name.split(".")[0]) for p in folder.glob("*.identity.json")
    ):
        for p in direct:
            p.poll()
        time.sleep(0.01)
    for path in folder.glob("*.identity.json"):
        exact_signal(json.loads(path.read_text()), "KILL")
    for p in direct:
        p.wait(timeout=10)
    # Reparented grandchildren are reaped by init; an absent native identity is the retirement proof.
    end = time.monotonic() + 10
    while time.monotonic() < end and any(
        _live_role(folder, p.name.split(".")[0]) for p in folder.glob("*.identity.json")
    ):
        time.sleep(0.02)
    alive = [p.name for p in folder.glob("*.identity.json") if _live_role(folder, p.name.split(".")[0])]
    atomic(folder / "fixture-cleanup.json", {"state": "verified" if not alive else "failed", "alive": alive})
    if alive:
        raise RuntimeError(f"fixture cleanup incomplete: {alive}")


def replay(output):
    output.mkdir(parents=True, exist_ok=False)
    result = []
    for name in ["normal", "term", "int", "stack-direct-control", "stack-local-stop"]:
        folder = output / name
        folder.mkdir()
        direct = []
        started = time.monotonic()
        try:
            sentinel = spawn(folder, "sentinel", new_session=True)
            direct.append(sentinel)
            wait_path(folder / "sentinel.identity.json")
            if name in ["normal", "term", "int"]:
                p = spawn(folder, "driver", *(["normal"] if name == "normal" else []), new_session=True)
                direct.append(p)
                wait_path(folder / "benchmark.ready")
                if name != "normal":
                    controller = wait_path(folder / "controller.identity.json")
                    assert exact_signal(controller, "TERM" if name == "term" else "INT") == 0
                code = p.wait(timeout=10)
                events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()]
                sequence = [e["event"] for e in events]
                cleanup_before_stack = "benchmark_cleanup_complete" in sequence and sequence.index(
                    "benchmark_cleanup_complete"
                ) < sequence.index("stack_stop")
                observed = {
                    "exit": code,
                    "cleanup_before_stack": cleanup_before_stack,
                    "benchmark_still_alive": _live_role(folder, "benchmark"),
                    "sequence": sequence,
                }
                expected_exit = {"normal": 0, "term": 143, "int": 130}[name]
                passed = cleanup_before_stack and not observed["benchmark_still_alive"] and code == expected_exit
            else:
                p = spawn(folder, "stack-owner", new_session=True)
                direct.append(p)
                wait_path(folder / "stack.ready")
                identity = wait_path(folder / "stack.identity.json")
                if name == "stack-direct-control":
                    assert exact_signal(identity, "TERM") == 0
                    p.wait(timeout=10)
                else:
                    local = load_local()
                    stack = local.ServiceStack(
                        "fixture", folder, folder / "services.json", folder / "services.log", True
                    )
                    # No DB exists; all real subprocess/signal/wait paths remain production code.
                    local.stop_services(p, stack=stack)
                state = wait_path(folder / "stack-cleanup.json")["state"]
                sequence = [json.loads(line)["event"] for line in (folder / "events.jsonl").read_text().splitlines()]
                observed = {"exit": p.returncode, "stack_cleanup_state": state, "sequence": sequence}
                passed = (
                    state == "clean" and sequence.index("worker_compensation_complete") < sequence.index("backend_stop")
                    if state == "clean"
                    else False
                )
            observed["unrelated_sentinel_alive"] = sentinel.poll() is None
            passed = passed and observed["unrelated_sentinel_alive"]
            result.append(
                {"case": name, "assertion_passed": passed, "seconds": round(time.monotonic() - started, 3), **observed}
            )
        finally:
            cleanup(folder, direct)
    report = {
        "source_sha256": hashlib.sha256((REPO / "agents/benchmarks/local.py").read_bytes()).hexdigest(),
        "results": result,
        "scope": "Real local.main/run_benchmark_invocation and real local.stop_services; paid setup and benchmark task command are fixture boundaries. Real exact child signals, HTTP requests and parent waits. No cloud/provider/real database calls.",
        "expected_assertion": "All cases require execution cleanup before dependency teardown; unchanged baseline expected to fail interrupted local owner and group-signalled stack.",
    }
    atomic(output / "result.json", report)
    print(json.dumps(report, indent=2))
    return 0 if all(r["assertion_passed"] for r in result) else 1


def test_local_controller_preserves_owned_cleanup_order():
    artifact_root = REPO / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-lifecycle-", dir=artifact_root))
    # replay reserves its own directory and retains diagnostics on every result.
    folder.rmdir()
    assert replay(folder) == 0, f"Local lifecycle contract failed; evidence: {folder}"


def test_local_controller_retains_stack_until_matching_root_receipt():
    artifact_root = REPO / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="local-receipt-", dir=artifact_root))
    for outcome in ("missing", "wrong", "pending", "repeat"):
        folder = root / outcome
        folder.mkdir()
        direct = []
        try:
            process = spawn(folder, "driver", outcome, new_session=True)
            direct.append(process)
            wait_path(folder / "benchmark.ready")
            identity = wait_path(folder / "controller.identity.json")
            assert exact_signal(identity, "TERM") == 0
            if outcome == "repeat":
                deadline = time.monotonic() + 10
                while (
                    not (folder / "events.jsonl").is_file()
                    or "benchmark_interrupt" not in (folder / "events.jsonl").read_text()
                ):
                    assert time.monotonic() < deadline, "first interrupt was not delivered"
                    time.sleep(0.01)
                assert exact_signal(identity, "TERM") == 0
            code = process.wait(timeout=10)
            events = [json.loads(line)["event"] for line in (folder / "events.jsonl").read_text().splitlines()]
            assert events.count("benchmark_interrupt") == 1, events
            assert not _live_role(folder, "benchmark"), "interrupted benchmark child was not joined"
            owner = json.loads((folder / "local-benchmark-owner.json").read_text())
            if outcome == "repeat":
                assert code == 143 and owner["state"] == "cleanup_verified"
                assert "stack_stop" in events and not _live_role(folder, "backend")
            else:
                assert code != 0 and owner["state"] == "failed_retained"
                assert "stack_stop" not in events, "missing cleanup proof stopped the owned dependencies"
                assert _live_role(folder, "backend"), "unverified root cleanup lost its backend"
        finally:
            cleanup(folder, direct)


def test_local_benchmark_cleanup_deadline_survives_stdout_eof():
    import threading
    from unittest.mock import patch

    local = load_local()
    artifact_root = REPO / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-eof-", dir=artifact_root))
    stack = local.ServiceStack("fixture", folder, folder / "services.json", folder / "services.log", False)
    with patch.object(local, "_owned_shutdown_timeout", return_value=0.2):
        owner = local.LocalBenchmarkOwner(stack)
    owner.token = "fixture-eof-token"
    # Interpreter startup under load can exceed the timer; arm the interrupt
    # only after the child ignores SIGINT and has closed stdout, otherwise the
    # default handler exits it early and drain reports a missing receipt.
    ready = folder / "child.ready"
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import os,signal,sys,time; signal.signal(signal.SIGINT,lambda *a:None); os.close(1); os.close(2); "
            "open(sys.argv[1],'w').close(); time.sleep(1.2)",
            str(ready),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    timer = threading.Timer(0.15, lambda: owner.interrupt(signal.SIGTERM))
    started = time.monotonic()
    error = ""
    try:
        owner.bind(child)
        ready_deadline = time.monotonic() + 10
        while not ready.exists():
            assert child.poll() is None, "EOF fixture child exited before arming"
            assert time.monotonic() < ready_deadline, "EOF fixture child never became ready"
            time.sleep(0.01)
        started = time.monotonic()
        timer.start()
        try:
            owner.drain(echo=False)
        except RuntimeError as failure:
            error = str(failure)
        elapsed = time.monotonic() - started
        atomic(folder / "result.json", {"elapsed_seconds": elapsed, "error": error})
        if not (elapsed < 0.7):
            warnings.warn(
                "stdout EOF bypassed the cancellation deadline",
                RuntimeWarning,
                stacklevel=2,
            )
        assert "deadline expired" in error, error
        assert not owner.verified, "unjoined child cleanup was acknowledged"
        assert json.loads((folder / "local-benchmark-owner.json").read_text())["state"] == "failed_retained"
    finally:
        timer.cancel()
        if timer.ident is not None:
            timer.join(timeout=10)
        if child.poll() is None:
            local._signal_owned_process(child, owner.native_identity, signal.SIGTERM)
        child.wait(timeout=10)
        if child.stdout:
            child.stdout.close()


def test_local_startup_failure_drains_owner_before_backend():
    from unittest.mock import patch

    local = load_local()
    artifact_root = REPO / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-startup-", dir=artifact_root))
    stack = local.ServiceStack(
        "fixture",
        folder,
        folder / "services.json",
        folder / "services.log",
        True,
        workspace_name="fixture",
        base_port=22001,
    )
    direct = []
    real_popen = subprocess.Popen

    def launch(command, **kwargs):
        if command != ["bash", "scripts/run.sh", "--benchmark"]:
            return real_popen(command, **kwargs)
        child_env = {
            "PATH": os.environ["PATH"],
            "PYTHONUNBUFFERED": "1",
            **{key: value for key, value in kwargs["env"].items() if key.startswith("RUN_STACK_CLEANUP_")},
        }
        process = real_popen(
            [sys.executable, str(SCRIPT), "stack-owner", str(folder)],
            cwd=folder,
            stdout=kwargs["stdout"],
            stderr=kwargs["stderr"],
            env=child_env,
            start_new_session=True,
        )
        direct.append(process)
        return process

    def failed_readiness(*args, **kwargs):
        wait_path(folder / "stack.ready")
        raise TimeoutError("fixture readiness rejected")

    try:
        sentinel = spawn(folder, "sentinel", new_session=True)
        direct.append(sentinel)
        wait_path(folder / "sentinel.identity.json")
        with (
            patch.object(local.subprocess, "Popen", launch),
            patch.dict(os.environ, {"BENCHMARK_SEED_DUMP": str(folder / "fixture.dump")}),
            patch.object(local, "wait_for_services", failed_readiness),
            patch.object(local, "_release_port_range") as release_port,
        ):
            try:
                local.start_services(stack, clean_first=False)
            except TimeoutError as error:
                assert str(error) == "fixture readiness rejected"
            else:
                raise AssertionError("startup failure was swallowed")
        assert direct[-1].poll() == 0, "startup rollback failed to drain exact stack owner"
        assert sentinel.poll() is None, "startup rollback retired an unrelated process"
        assert not _live_role(folder, "backend") and not _live_role(folder, "worker")
        release_port.assert_called_once_with(stack.base_port)
        events = [json.loads(line)["event"] for line in (folder / "events.jsonl").read_text().splitlines()]
        assert events.index("worker_compensation_complete") < events.index("backend_stop"), events
        assert wait_path(folder / "stack-cleanup.json")["state"] == "clean"
    finally:
        cleanup(folder, direct)


def test_local_startup_publication_failure_preserves_live_handle():
    from unittest.mock import patch

    local = load_local()
    root = REPO / ".context/test-runs"
    root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-publication-", dir=root))
    stack = local.ServiceStack(
        "fixture",
        folder,
        folder / "services.json",
        folder / "services.log",
        True,
        workspace_name="fixture",
        base_port=22001,
    )
    children = []
    published = []
    real_popen = subprocess.Popen

    def launch(command, **kwargs):
        child = real_popen(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            stdout=kwargs["stdout"],
            stderr=kwargs["stderr"],
            start_new_session=True,
        )
        children.append(child)
        return child

    try:
        with (
            patch.object(local.subprocess, "Popen", launch),
            patch.object(local, "_record_stack_cleanup_owner", side_effect=OSError("fixture journal refused")),
            patch.object(local, "_release_port_range"),
            patch.dict(os.environ, {"BENCHMARK_SEED_DUMP": str(folder / "fixture.dump")}),
        ):
            try:
                local.start_services(stack, clean_first=False, on_process=published.append)
            except OSError as error:
                assert str(error) == "fixture journal refused"
            else:
                raise AssertionError("startup journal failure was swallowed")
        assert published == children, "post-spawn publication failure lost the exact child handle"
        assert children[0].poll() is None, "unverified startup was implicitly force-stopped"
        assert not (folder / "local-stack-cleanup.status").exists()
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()  # The unreaped direct Popen still owns this exact child.
            child.wait(timeout=10)


def test_local_child_signal_waits_for_its_new_native_identity():
    from unittest.mock import Mock, patch

    local = load_local()
    root = REPO / ".context/test-runs"
    root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-bind-", dir=root))
    stack = local.ServiceStack("fixture", folder, folder / "services.json", folder / "services.log", False)
    with patch.object(local, "_owned_shutdown_timeout", return_value=1):
        owner = local.LocalBenchmarkOwner(stack)
    owner.native_identity = "previous-child"
    child = Mock(pid=12345)
    calls = []

    def capture(pid):
        assert pid == child.pid
        owner.interrupt(signal.SIGTERM)
        assert not calls, "signal used an identity before the new child was captured"
        return "new-child"

    def send(process, identity, signum):
        assert process is child and identity == "new-child" and signum == signal.SIGINT
        calls.append(signum)

    with (
        patch.object(local, "_process_identity_tools", return_value={"current_identity": capture}),
        patch.object(local, "_signal_owned_process", side_effect=send),
    ):
        owner.bind(child)
        owner.interrupt(signal.SIGTERM)
    assert calls == [signal.SIGINT], "latched interruption was not delivered exactly once"


def test_local_stack_cleanup_rejects_wrong_receipts_and_unknown_identity():
    from unittest.mock import Mock, patch

    local = load_local()
    root = REPO / ".context/test-runs"
    root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-stack-receipt-", dir=root))
    stack = local.ServiceStack("fixture", folder, folder / "services.json", folder / "services.log", True)
    owner = {
        "version": 1,
        "run_id": "fixture",
        "pid": 12345,
        "token": "fixture-token",
        "native_identity": "fixture-native",
        "birth": "fixture-birth",
    }
    atomic(folder / "local-stack-owner.json", owner)
    receipt_path = folder / "local-stack-cleanup.status"
    good = "version=1\ntoken=fixture-token\nstate=clean\nstack_pid=12345\nstack_birth=fixture-birth\n"
    for case in ("clean", "missing", "token", "pid", "birth", "failed", "duplicate", "symlink"):
        receipt_path.unlink(missing_ok=True)
        text = good
        if case in {"token", "birth"}:
            text = text.replace("fixture-" + case, "foreign-" + case)
        elif case == "pid":
            text = text.replace("12345", "12346")
        elif case == "failed":
            text = text.replace("state=clean", "state=failed")
        elif case == "duplicate":
            text += "token=fixture-token\n"
        if case == "symlink":
            target = folder / "foreign.status"
            target.write_text(good)
            receipt_path.symlink_to(target)
        elif case != "missing":
            receipt_path.write_text(text)
        child = Mock(pid=12345)
        child.poll.return_value = 0
        child.wait.return_value = 0
        with (
            patch.object(local, "_owned_shutdown_timeout", return_value=1),
            patch.object(local, "_process_identity_tools") as tools,
        ):
            try:
                local.stop_services(child, stack=stack)
            except RuntimeError:
                assert case != "clean", "matching terminal stack receipt was rejected"
            else:
                assert case == "clean", f"unsafe stack receipt was accepted: {case}"
            tools.assert_not_called()
    receipt_path.unlink(missing_ok=True)
    receipt_path.write_text(good)
    for case in ("unknown", "replacement"):
        tools = {
            "current_identity": Mock(side_effect=OSError("unreadable"))
            if case == "unknown"
            else Mock(return_value="foreign"),
            "main": Mock(),
        }
        with (
            patch.object(local, "_owned_shutdown_timeout", return_value=1),
            patch.object(local, "_process_identity_tools", return_value=tools),
            patch.object(local, "_pid_is_alive", return_value=True),
        ):
            try:
                local.stop_services(stack=stack)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"unverified live stack identity accepted: {case}")
            tools["main"].assert_not_called()


def test_local_stack_cleanup_uses_native_receipt_identity_and_strict_legacy_proof():
    """Wall-clock drift cannot replace process identity or authorize a recycled owner."""
    from unittest.mock import Mock, patch
    local = load_local()
    cases = {
        "native-drift": True, "native-wrong": False, "token": False, "pid": False,
        "failed": False, "legacy-good": True, "legacy-drift": False,
        "legacy-proof": True, "legacy-wrongproof": False, "recycled": False,
    }
    with tempfile.TemporaryDirectory(prefix="native-stack-receipt-") as temporary:
        folder = Path(temporary)
        stack = local.ServiceStack("fixture", folder, folder/"services.json", folder/"services.log", True)
        owner = {"version": 1, "run_id": "fixture", "pid": 12345, "token": "fixture-token",
                 "native_identity": "fixture-native", "birth": "old-wall-clock"}
        atomic(folder/"local-stack-owner.json", owner)
        for case, expected in cases.items():
            token = "foreign" if case == "token" else "fixture-token"
            pid = "12346" if case == "pid" else "12345"
            state = "failed" if case == "failed" else "clean"
            birth = "old-wall-clock" if case in {"legacy-good", "native-wrong", "token", "pid", "failed", "recycled"} else "shifted-wall-clock"
            text = f"version=1\ntoken={token}\nstate={state}\nstack_pid={pid}\nstack_birth={birth}\n"
            if case not in {"legacy-good", "legacy-drift", "legacy-proof", "legacy-wrongproof"}:
                native = "foreign-native" if case == "native-wrong" else "fixture-native"
                text += f"stack_native_identity={native}\n"
            (folder/"local-stack-cleanup.status").write_text(text)
            def identify(_pid):
                if case == "recycled":
                    return "foreign-native"
                if case in {"legacy-proof", "legacy-wrongproof"}:
                    return "fixture-native"
                raise ProcessLookupError()
            signal_boundary = Mock(return_value=3 if case == "legacy-wrongproof" else 0)
            tools = {"current_identity": identify, "main": signal_boundary}
            with patch.object(local, "_owned_shutdown_timeout", return_value=1), \
                 patch.object(local, "_pid_is_alive", return_value=False), \
                 patch.object(local, "_wait_for_pid_exit", return_value=True), \
                 patch.object(local, "_process_identity_tools", return_value=tools):
                try:
                    local.stop_services(None, stack=stack)
                except (RuntimeError, OSError, ValueError):
                    accepted = False
                else:
                    accepted = True
            assert accepted == expected, f"unsafe/misclassified native receipt: {case}"
            if case not in {"legacy-proof", "legacy-wrongproof"}:
                signal_boundary.assert_not_called()
            else:
                signal_boundary.assert_called_once()
                args = signal_boundary.call_args.args[0]
                assert args == ["process-identity", "--expect", "fixture-native", "--signal", "TERM", "12345"]


def test_native_stack_cleanup_writer_binds_stable_identity_despite_wall_birth_drift():
    """The actual shell publisher records its own OS-native identity, not only ps lstart."""
    with tempfile.TemporaryDirectory(prefix="native-stack-writer-") as temporary:
        folder = Path(temporary)
        receipt = folder/"cleanup.status"
        env = dict(os.environ, REVIEW_WRITER_RECEIPT=str(receipt), REVIEW_REPO=str(REPO))
        command = r"""
        SCRIPT_DIR="$REVIEW_REPO/scripts"
        RUN_STACK_CLEANUP_STATUS_FILE="$REVIEW_WRITER_RECEIPT"
        RUN_STACK_CLEANUP_TOKEN=fixture-token
        ps() { printf '%s\n' 'synthetic-shifted-wall-birth'; }
        . "$SCRIPT_DIR/lib/run-process-cleanup.sh"
        expected=$(python3 "$SCRIPT_DIR/process-identity.py" "$$") || exit 1
        run_publish_stack_cleanup_status clean || exit 1
        printf '%s\n' "$expected"
        """
        result = subprocess.run(["bash", "-c", command], env=env, text=True, capture_output=True, check=True)
        fields = dict(line.split("=", 1) for line in receipt.read_text().splitlines())
        assert fields["version"] == "2" and fields["token"] == "fixture-token" and fields["state"] == "clean"
        assert fields["stack_native_identity"] == result.stdout.strip()
        assert fields["stack_birth"] == "synthetic-shifted-wall-birth"
        old = receipt.read_bytes()
        failure = r"""
        SCRIPT_DIR="$REVIEW_REPO/scripts"
        RUN_STACK_CLEANUP_STATUS_FILE="$REVIEW_WRITER_RECEIPT"
        RUN_STACK_CLEANUP_TOKEN=fixture-token
        ps() { printf '%s\n' 'synthetic-shifted-wall-birth'; }
        python3() { return 1; }
        . "$SCRIPT_DIR/lib/run-process-cleanup.sh"
        if run_publish_stack_cleanup_status clean; then exit 9; fi
        """
        subprocess.run(["bash", "-c", failure], env=env, check=True, capture_output=True)
        assert receipt.read_bytes() == old, "unreadable identity overwrote the verified receipt"


def test_stack_native_schema_requires_identity_and_keeps_interrupt_schema_strict():
    """A v2 stack cannot use legacy fallback, including after verified termination."""
    from unittest.mock import patch
    local = load_local()
    owner = {"pid": 12345, "native_identity": "fixture-native", "birth": "same-birth"}
    for version, native, expected in [("2", None, False), ("2", "", False), ("2", "foreign", False),
                                      ("2", "fixture-native", True), ("1", None, True), ("9", "fixture-native", False)]:
        receipt = {"version": version, "stack_pid": "12345", "stack_birth": "same-birth"}
        if native is not None:
            receipt["stack_native_identity"] = native
        try:
            local._validate_stack_cleanup_receipt(receipt, owner, verified_native_identity="fixture-native")
        except RuntimeError:
            accepted = False
        else:
            accepted = True
        assert accepted == expected, (version, native)
    with tempfile.TemporaryDirectory(prefix="native-schema-read-") as temporary:
        receipt = Path(temporary) / "receipt"
        receipt.write_text("version=2\ntoken=fixture\nstate=clean\nstack_native_identity=fixture-native\n")
        try:
            local._read_cleanup_receipt(receipt, "fixture")
        except RuntimeError:
            pass
        else:
            raise AssertionError("stack schema2 must not authorize benchmark interrupt cleanup")
        assert local._read_cleanup_receipt(receipt, "fixture", allowed_versions=("1", "2"))["version"] == "2"


def test_local_stack_cleanup_accepts_only_complete_native_schema_two_receipts():
    """The public stack boundary accepts matching v2 owners, never missing/foreign native fields."""
    from unittest.mock import patch
    local = load_local()
    with tempfile.TemporaryDirectory(prefix="native-v2-public-") as temporary:
        folder=Path(temporary);stack=local.ServiceStack("fixture",folder,folder/"services.json",folder/"log",True)
        owner={"version":1,"run_id":"fixture","pid":12345,"token":"fixture-token","native_identity":"fixture-native","birth":"old-wall"}
        atomic(folder/"local-stack-owner.json",owner)
        for native,birth,expected in [("fixture-native","shifted-wall",True),("fixture-native","old-wall",True),
                                       (None,"old-wall",False),("","old-wall",False),("foreign","old-wall",False)]:
            text=f"version=2\ntoken=fixture-token\nstate=clean\nstack_pid=12345\nstack_birth={birth}\n"
            if native is not None:text+=f"stack_native_identity={native}\n"
            (folder/"local-stack-cleanup.status").write_text(text)
            def absent(_pid):raise ProcessLookupError()
            with patch.object(local,"_process_identity_tools",return_value={"current_identity":absent}), \
                 patch.object(local,"_pid_is_alive",return_value=False):
                try:local.stop_services(None,stack=stack)
                except RuntimeError:accepted=False
                else:accepted=True
            assert accepted==expected,(native,birth)


def _seed_bootstrap_workspace(folder):
    """Copy the unchanged bootstrap, replacing only external executables."""
    import shutil
    (folder / "scripts").mkdir()
    shutil.copytree(REPO / "scripts/lib", folder / "scripts/lib")
    for name in ("run.sh", "process-identity.py"):
        shutil.copy2(REPO / "scripts" / name, folder / "scripts" / name)
    (folder / "agents/benchmarks").mkdir(parents=True)
    shutil.copy2(REPO / "agents/benchmarks/seed_cache_path.py", folder / "agents/benchmarks/seed_cache_path.py")
    (folder / "back-end/prisma").mkdir(parents=True)
    shutil.copy2(REPO / "back-end/prisma/schema.prisma", folder / "back-end/prisma/schema.prisma")
    (folder / "back-end/.env").write_text("R2_BUCKET_TRACE_ARCHIVE=fixture-only\n")
    binary = folder / "bin"
    binary.mkdir()
    fake = r"""#!/usr/bin/env python3
import os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
state=Path(os.environ['BOOTSTRAP_DB_STATE'])
with open(os.environ['BOOTSTRAP_EXTERNAL_LOG'],'a') as log:log.write(name+' '+' '.join(sys.argv[1:])+'\n')
if name in ('docker','lsof','pgrep'):sys.exit(1)
if name=='pg_isready':sys.exit(0)
if name=='pg_dump':print('pg_dump (PostgreSQL) 16.4');sys.exit(0)
if name=='createdb':state.write_text('owned');sys.exit(0)
if name=='dropdb':
 if state.exists() and os.environ.get('BOOTSTRAP_DROP_FAIL')=='1':sys.exit(7)
 state.unlink(missing_ok=True);sys.exit(0)
if name=='readlink':
 if os.environ.get('BOOTSTRAP_READ_FAIL')=='1' and sys.argv[1].endswith('.publish.lock'):sys.exit(7)
 try:print(os.readlink(sys.argv[1]));sys.exit(0)
 except OSError:sys.exit(1)
if name=='rm':
 if os.environ.get('BOOTSTRAP_LOCK_FAIL')=='1' and any(x.endswith('.publish.lock') for x in sys.argv[1:]):sys.exit(7)
 for arg in sys.argv[1:]:
  if not arg.startswith('-'):Path(arg).unlink(missing_ok=True)
 sys.exit(0)
if name=='npx':
 if 'scripts/ensure-fast-mode-cache-schema.ts' in sys.argv:sys.exit(0)
 if 'scripts/seed-dump-cache.ts' in sys.argv and 'get' in sys.argv:sys.exit(1)
sys.exit(99)
"""
    for name in ("docker", "lsof", "pgrep", "pg_isready", "pg_dump", "createdb", "dropdb", "npx", "rm", "readlink"):
        path = binary / name
        path.write_text(fake)
        path.chmod(0o700)
    return binary


def _run_native_seed_bootstrap(folder, *, drop_fail=False, lock_fail=False, read_fail=False):
    local = load_local()
    binary = _seed_bootstrap_workspace(folder)
    stack = local.ServiceStack("fixture-bootstrap", folder, folder/"services.json", folder/"services.log", True)
    env = {
        "PATH": f"{binary}:{os.environ['PATH']}", "CONDUCTOR_PORT": "24101",
        "CONDUCTOR_WORKSPACE_NAME": "fixture-bootstrap", "BENCHMARK_ISOLATED_RUN": "true",
        "BENCHMARK_RUN_ID": stack.run_id, "BENCHMARK_CONTEXT_DIR": str(folder),
        "ROSE_USE_SYSTEM_PG": "true", "FAST_MODE_CACHE_USE_LOCAL": "1",
        "BENCHMARK_SKIP_WMH_BUILD": "1", "BENCHMARK_REQUIRE_SEED_DUMP": "1",
        "BENCHMARK_SEED_DUMP": str(folder/"seed.dump"),
        "RUN_STACK_CLEANUP_STATUS_FILE": str(folder/"local-stack-cleanup.status"),
        "RUN_STACK_CLEANUP_TOKEN": "fixture-bootstrap-token", "OWNER_READY": str(folder/"owner-ready"),
        "BOOTSTRAP_DB_STATE": str(folder/"database.state"),
        "BOOTSTRAP_EXTERNAL_LOG": str(folder/"external.log"), "BOOTSTRAP_DROP_FAIL": str(int(drop_fail)),
        "BOOTSTRAP_LOCK_FAIL": str(int(lock_fail)), "BOOTSTRAP_READ_FAIL": str(int(read_fail)),
    }
    command = 'while [ ! -f "$OWNER_READY" ]; do sleep 0.01; done; exec bash scripts/run.sh --benchmark'
    with stack.service_log.open("w") as output:
        child = subprocess.Popen(["bash", "-c", command], cwd=folder, env=env, stdout=output, stderr=subprocess.STDOUT)
    try:
        local._record_stack_cleanup_owner(stack, child, env["RUN_STACK_CLEANUP_TOKEN"])
        (folder/"owner-ready").touch()
        assert child.wait(timeout=30) == 1, "cache miss must retain the original startup failure"
    finally:
        if child.poll() is None:
            child.terminate()  # Only this unreaped direct native fixture owner.
            child.wait(timeout=10)
    text = stack.service_log.read_text()
    assert "canonical base fixture is unavailable" in text, text
    assert "refusing a slow production cold-sync substitute" in text, text
    assert not stack.manifest_path.exists(), "no services may start after failed seed admission"
    assert (folder/"seed.dump.publish.lock").is_symlink() == (lock_fail or read_fail), "seed lock cleanup did not match the external outcome"
    calls = (folder/"external.log").read_text().splitlines()
    assert all(line.split()[0] in {"docker", "lsof", "pgrep", "pg_isready", "pg_dump", "createdb", "dropdb", "npx", "rm", "readlink"} for line in calls)
    assert all("npx" != line.split()[0] or "ensure-fast-mode-cache-schema.ts" in line or "seed-dump-cache.ts get" in line for line in calls)
    return local, stack


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_bootstrap_miss():
    """An actual pre-service seed miss must seal its native owner before exiting 1."""
    with tempfile.TemporaryDirectory(prefix="native-seed-miss-") as directory:
        folder = Path(directory)
        local, stack = _run_native_seed_bootstrap(folder)
        assert not (folder/"database.state").exists(), "owned bootstrap database leaked"
        local.stop_services(None, stack=stack)  # Actual unchanged receiver; no signal owner remains.
        owner = json.loads((folder/"local-stack-owner.json").read_text())
        receipt = folder/"local-stack-cleanup.status"
        fields = local._read_cleanup_receipt(receipt, owner["token"], allowed_versions=("1", "2"))
        assert fields["version"] == "2" and fields["stack_native_identity"] == owner["native_identity"]
        assert fields["stack_pid"] == str(owner["pid"]) and fields["stack_birth"] == owner["birth"]
        original = receipt.read_text()
        for field, wrong in (("token", "foreign-token"), ("stack_native_identity", "foreign-native")):
            receipt.write_text(original.replace(f"{field}={fields[field]}", f"{field}={wrong}"))
            try:
                local.stop_services(None, stack=stack)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"foreign {field} authorized cleanup")
        receipt.unlink()
        try:
            local.stop_services(None, stack=stack)
        except RuntimeError:
            pass
        else:
            raise AssertionError("missing receipt authorized cleanup")


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_cleanup_failure():
    """Failed owned PostgreSQL teardown must never produce a clean receipt."""
    with tempfile.TemporaryDirectory(prefix="native-seed-drop-fail-") as directory:
        folder = Path(directory)
        local, stack = _run_native_seed_bootstrap(folder, drop_fail=True)
        assert (folder/"database.state").exists(), "negative control did not fail owned teardown"
        try:
            local.stop_services(None, stack=stack)
        except RuntimeError:
            pass
        else:
            raise AssertionError("failed database cleanup authorized a clean receipt")


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_lock_failure():
    """A retained owned seed lock cannot accompany a clean stack receipt."""
    with tempfile.TemporaryDirectory(prefix="native-seed-lock-fail-") as directory:
        folder = Path(directory)
        local, stack = _run_native_seed_bootstrap(folder, lock_fail=True)
        assert not (folder/"database.state").exists()
        fields = dict(line.split("=", 1) for line in (folder/"local-stack-cleanup.status").read_text().splitlines())
        assert fields["state"] == "failed"
        try:
            local.stop_services(None, stack=stack)
        except RuntimeError:
            pass
        else:
            raise AssertionError("retained seed lock authorized a clean receipt")


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_container_cleanup():
    """Bootstrap Docker teardown acts on the immutable owner and preserves failures."""
    import re
    source = (REPO/"scripts/run.sh").read_text()
    function = re.search(r"^cleanup_seed_bootstrap_database\(\) \{.*?^\}", source, re.M | re.S).group()
    command = r"""
    docker() {
        printf '%s\n' "$*"
        [ "$*" != "$FAIL_COMMAND" ]
    }
    USE_SYSTEM_PG=false
    SYSTEM_DB_OWNED_BY_US=false
    DB_OWNED_BY_US=true
    DB_OWNED_CONTAINER_ID=immutable-owned-id
    DB_CONTAINER=replaced-foreign-name
    DB_VOLUME=owned-volume
    """ + function + r"""
    status=0
    cleanup_seed_bootstrap_database || status=$?
    printf 'result=%s owner=%s\n' "$status" "$DB_OWNED_CONTAINER_ID"
    """
    for failure in ("none", "rm -f immutable-owned-id", "volume rm owned-volume"):
        result = subprocess.run(["bash", "-c", command], env={**os.environ, "FAIL_COMMAND": failure},
                                capture_output=True, text=True, check=True)
        assert "replaced-foreign-name" not in result.stdout
        if failure == "none":
            assert result.stdout.endswith("result=0 owner=\n")
        else:
            assert result.stdout.endswith("result=1 owner=immutable-owned-id\n")


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_readlink_error():
    """Only a readlink I/O fault retains our lock; it cannot authorize clean."""
    with tempfile.TemporaryDirectory(prefix="native-seed-read-fail-") as directory:
        folder = Path(directory)
        local, stack = _run_native_seed_bootstrap(folder, read_fail=True)
        owner = json.loads((folder/"local-stack-owner.json").read_text())
        assert os.readlink(folder/"seed.dump.publish.lock") == str(owner["pid"])
        assert not (folder/"database.state").exists()
        fields = dict(line.split("=", 1) for line in (folder/"local-stack-cleanup.status").read_text().splitlines())
        assert fields["state"] == "failed", "readlink uncertainty certified a retained native-owned lock as clean"
        try:
            local.stop_services(None, stack=stack)
        except RuntimeError:
            pass
        else:
            raise AssertionError("readlink uncertainty authorized cleanup")


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_native_lock_observation():
    """Only native absence or a successfully read foreign owner clears held state."""
    import re
    source = (REPO/"scripts/run.sh").read_text()
    function = re.search(r"^release_seed_lock_if_held\(\) \{.*?^\}", source, re.M | re.S).group()
    with tempfile.TemporaryDirectory(prefix="native-lock-observation-") as directory:
        folder = Path(directory)
        (folder/"sitecustomize.py").write_text(
            "import errno,os\noriginal=os.readlink\n"
            "def readlink(path,*args,**kwargs):\n"
            " if os.fspath(path)==os.environ['LOCK_FAULT_PATH'] and os.environ['LOCK_MODE'] in ('io','permission','io-absent'):\n"
            "  raise OSError(errno.EACCES if os.environ['LOCK_MODE']=='permission' else errno.EIO,'fixture native observation fault')\n"
            " return original(path,*args,**kwargs)\nos.readlink=readlink\n")
        command = '. "$REVIEW_REPO/scripts/lib/seed-cache.sh"\n' + function + r"""
        _SEED_DUMP="$LOCK_DUMP"
        _SEED_LOCK_HELD=1
        case "$LOCK_MODE" in
            foreign) ln -s "$FOREIGN_PID" "${_SEED_DUMP}.publish.lock" ;;
            ours|io|permission) ln -s "$$" "${_SEED_DUMP}.publish.lock" ;;
        esac
        readlink() {
            case "$LOCK_MODE" in ours|io|permission|io-absent) return 7 ;; esac
            command readlink "$@"
        }
        status=0
        release_seed_lock_if_held || status=$?
        printf 'status=%s held=%s\n' "$status" "$_SEED_LOCK_HELD"
        """
        for mode in ("absent", "foreign", "ours", "io", "permission", "io-absent"):
            dump = folder/mode
            env = {**os.environ, "REVIEW_REPO": str(REPO), "LOCK_MODE": mode,
                   "LOCK_DUMP": str(dump), "LOCK_FAULT_PATH": str(dump)+".publish.lock",
                   "PYTHONPATH": str(folder), "FOREIGN_PID": str(os.getpid())}
            result = subprocess.run(["bash", "-c", command], env=env, capture_output=True, text=True, check=True)
            good = mode in {"absent", "foreign"}
            assert result.stdout.strip() == ("status=0 held=0" if good else "status=1 held=1"), (mode, result.stdout, result.stderr)
            if mode == "foreign":
                assert os.readlink(str(dump)+".publish.lock") == str(os.getpid())


def _docker_absence_boundary(folder, scenario, owned_id, volume):
    """Only Docker is fake; state is the native boundary's authoritative fixture."""
    binary = folder/"bin"
    binary.mkdir()
    state = {"container": scenario in {"removed", "removal-error"}, "volume": scenario != "volume-absent", "foreign": True}
    (folder/"state.json").write_text(json.dumps(state))
    executable = binary/"docker"
    executable.write_text(r"""#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
folder=Path(os.environ['DOCKER_FIXTURE']);scenario=os.environ['DOCKER_SCENARIO']
args=sys.argv[1:];owned=os.environ['DOCKER_OWNED_ID'];volume=os.environ['DOCKER_OWNED_VOLUME']
p=folder/'state.json';state=json.loads(p.read_text())
with (folder/'calls.jsonl').open('a') as log:log.write(json.dumps(args)+'\n')
if args==['rm','-f',owned]:
 if scenario=='removed':state['container']=False;p.write_text(json.dumps(state));sys.exit(0)
 print('Error response from daemon: no such container or removal refused',file=sys.stderr);sys.exit(1)
if args==['container','ls','--all','--no-trunc','--filter','id='+owned,'--format','{{.ID}}']:
 if scenario in ('daemon-error','permission-error','read-error'):sys.exit(1)
 if scenario=='foreign-result':print('b'*64)
 elif state['container']:print(owned)
 sys.exit(0)
if args==['volume','rm',volume]:
 if scenario in ('volume-error','volume-api-error') or not state['volume']:sys.exit(1)
 state['volume']=False;p.write_text(json.dumps(state));sys.exit(0)
if args==['volume','ls','--filter','name='+volume,'--format','{{.Name}}']:
 if scenario=='volume-api-error':sys.exit(1)
 if state['volume']:print(volume)
 sys.exit(0)
sys.exit(99)
""")
    executable.chmod(0o700)
    return binary


def _native_docker_bootstrap_receipt(folder, scenario):
    """Execute actual run.sh bootstrap functions, writer and unchanged consumer."""
    import re
    local = load_local()
    source = (REPO/"scripts/run.sh").read_text()
    functions = '\n'.join(re.search(r'^'+name+r'\(\) \{.*?^\}', source, re.M|re.S).group()
                          for name in ('cleanup_seed_bootstrap_database', 'fail_required_seed_dump', 'release_seed_lock_if_held'))
    owned = "a"*64 if scenario != "unknown-id" else "unverified-id"
    volume = "victoria-pgdata-native-fixture"
    binary = _docker_absence_boundary(folder, scenario, owned, volume)
    stack = local.ServiceStack("native-docker-bootstrap", folder, folder/"services.json", folder/"services.log", True)
    env = {"PATH": f"{binary}:{os.environ['PATH']}", "DOCKER_FIXTURE": str(folder), "DOCKER_SCENARIO": scenario,
           "DOCKER_OWNED_ID": owned, "DOCKER_OWNED_VOLUME": volume, "REVIEW_REPO": str(REPO),
           "RUN_STACK_CLEANUP_STATUS_FILE": str(folder/"local-stack-cleanup.status"),
           "RUN_STACK_CLEANUP_TOKEN": "native-docker-fixture-token"}
    command = r"""
    while [ ! -f "$DOCKER_FIXTURE/owner-ready" ]; do sleep 0.01; done
    SCRIPT_DIR="$REVIEW_REPO/scripts"
    . "$SCRIPT_DIR/lib/run-process-cleanup.sh"
    . "$SCRIPT_DIR/lib/seed-cache.sh"
    """ + functions + r"""
    USE_SYSTEM_PG=false; SYSTEM_DB_OWNED_BY_US=false; DB_OWNED_BY_US=true
    DB_OWNED_CONTAINER_ID="$DOCKER_OWNED_ID"; DB_CONTAINER=foreign-replacement-mutable-name
    DB_VOLUME="$DOCKER_OWNED_VOLUME"; _SEED_CACHE_TOKEN=fixture-token
    _SEED_DUMP="$DOCKER_FIXTURE/seed.dump"; _SEED_LOCK_HELD=1
    acquire_benchmark_seed_lock "$_SEED_DUMP"
    trap release_seed_lock_if_held EXIT
    fail_required_seed_dump 'required canonical base fixture unavailable'
    """
    with stack.service_log.open("w") as output:
        child = subprocess.Popen(["bash", "-c", command], env=env, cwd=folder, stdout=output, stderr=subprocess.STDOUT)
    try:
        local._record_stack_cleanup_owner(stack, child, env["RUN_STACK_CLEANUP_TOKEN"])
        (folder/"owner-ready").touch()
        assert child.wait(timeout=15) == 1, "startup outcome changed"
    finally:
        if child.poll() is None:
            child.terminate(); child.wait(timeout=10)  # Only this direct unreaped fixture owner.
    owner = json.loads((folder/"local-stack-owner.json").read_text())
    fields = dict(line.split('=',1) for line in (folder/"local-stack-cleanup.status").read_text().splitlines())
    assert fields['stack_native_identity'] == owner['native_identity'] and fields['stack_pid'] == str(owner['pid'])
    assert fields['stack_birth'] == owner['birth'] and fields['token'] == owner['token']
    assert not stack.manifest_path.exists() and not (folder/"seed.dump.publish.lock").is_symlink()
    calls = [json.loads(line) for line in (folder/"calls.jsonl").read_text().splitlines()]
    assert all('foreign-replacement-mutable-name' not in call for call in calls)
    try:local.stop_services(None, stack=stack)
    except RuntimeError:accepted=False
    else:accepted=True
    state = json.loads((folder/"state.json").read_text())
    assert state['foreign'] is True
    proof = {"scenario":scenario,"startupExit":1,"receiptState":fields['state'],"consumerAccepted":accepted,
             "nativeOwnerPid":owner['pid'],"nativeIdentity":owner['native_identity'],"birth":owner['birth'],
             "calls":calls,"remaining":state,"noTasksStarted":True}
    if os.environ.get('BOOTSTRAP_ABSENT_PROOF_LOG'):
        with open(os.environ['BOOTSTRAP_ABSENT_PROOF_LOG'],'a') as out:out.write(json.dumps(proof)+'\n')
    return proof


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_absent_container():
    """A proven absent exact container must not strand its present owned volume."""
    with tempfile.TemporaryDirectory(prefix="native-container-absent-") as directory:
        proof = _native_docker_bootstrap_receipt(Path(directory), 'absent')
        assert ['volume','rm','victoria-pgdata-native-fixture'] in proof['calls'], 'absent exact container stranded owned volume'
        assert proof['remaining']['volume'] is False
        assert proof['receiptState']=='clean' and proof['consumerAccepted'] is True


def test_driver_cleanup_requires_current_stack_receipt_on_normal_completion_after_seed_container_absence_inverses():
    for scenario in ('removed','volume-absent','daemon-error','permission-error','read-error','removal-error',
                     'foreign-result','unknown-id','volume-error','volume-api-error'):
        with tempfile.TemporaryDirectory(prefix='native-docker-inverse-') as directory:
            proof = _native_docker_bootstrap_receipt(Path(directory), scenario)
            good = scenario in {'removed','volume-absent'}
            assert proof['consumerAccepted'] is good and proof['receiptState']==('clean' if good else 'failed'), scenario
            volume_call = ['volume','rm','victoria-pgdata-native-fixture'] in proof['calls']
            assert volume_call is (good or scenario.startswith('volume-')), scenario
            if good:assert not proof['remaining']['volume']


if __name__ == "__main__":
    mode = sys.argv[1]
    folder = Path(sys.argv[2]).resolve()
    if mode == "server":
        server(folder)
        rc = 0
    elif mode == "benchmark":
        rc = benchmark(folder, sys.argv[3] if len(sys.argv) > 3 else "interrupted")
    elif mode == "driver":
        rc = driver(folder, sys.argv[3] if len(sys.argv) > 3 else "interrupted")
    elif mode == "worker":
        rc = worker(folder)
    elif mode == "stack-owner":
        rc = stack_owner(folder)
    elif mode == "sentinel":
        publish_identity(folder, "sentinel")
        time.sleep(10)
        rc = 0
    elif mode == "replay":
        rc = replay(folder)
    else:
        raise ValueError(mode)
    raise SystemExit(rc)


def test_process_table_reads_same_user_entry_with_unreadable_environ_by_argv():
    """A same-user process mid setuid exec must not make the whole table unobservable."""
    import tempfile

    from benchmarks import local_cleanup_reconcile as reconcile

    with tempfile.TemporaryDirectory() as raw:
        _assert_unreadable_environ_entry(reconcile, Path(raw))


def _assert_unreadable_environ_entry(reconcile, tmp_path):
    entry = tmp_path / "12345"
    entry.mkdir()
    (entry / "cmdline").write_bytes(b"node\0server.js\0")
    environ = entry / "environ"
    environ.write_bytes(b"RUN_STACK_CLEANUP_TOKEN=x\0")
    os.symlink(str(tmp_path), entry / "cwd")
    os.chmod(environ, 0)
    try:
        if os.access(environ, os.R_OK):
            return  # running as root: permission bits are not enforced
        assert reconcile._read_proc_entry(entry, os.getuid()) == (12345, "node server.js ", "", "")
        assert reconcile._read_proc_entry(entry, os.getuid() + 1) is None
        assert reconcile._read_proc_entry(tmp_path / "99999", os.getuid()) is None
    finally:
        os.chmod(environ, 0o600)


def test_local_stack_reconcile_resolves_pending_receipt_only_when_nothing_is_left():
    import socket

    local = load_local()
    from benchmarks import local_cleanup_reconcile as reconcile

    root = REPO / ".context/test-runs"
    root.mkdir(parents=True, exist_ok=True)

    def fixture(owner_alive=False):
        folder = Path(tempfile.mkdtemp(prefix="local-stack-reconcile-", dir=root))
        run_id = folder.name
        owner_process = subprocess.Popen(["sleep", "300"])
        identity = IDENTITY["current_identity"](owner_process.pid)
        if not owner_alive:
            owner_process.kill()
            owner_process.wait()
        owner = {
            "version": 1,
            "run_id": run_id,
            "pid": owner_process.pid,
            "token": f"tok-{run_id}",
            "native_identity": identity,
            "birth": "fixture-birth",
        }
        atomic(folder / "local-stack-owner.json", owner)
        pending = (
            f"version=2\ntoken={owner['token']}\nstate=pending\nstack_pid={owner['pid']}\n"
            f"stack_birth=fixture-birth\nstack_native_identity={identity}\n"
        )
        (folder / "local-stack-cleanup.status").write_text(pending)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        atomic(
            folder / "services.json",
            {
                "ports": {"backend": port, "local_db": 5432, "wmh": 0},
                "database": {"name": f"victoria_bench_{run_id}", "owned_by_run_sh": True, "use_system_postgres": True},
            },
        )
        stack = local.ServiceStack(run_id, folder, folder / "services.json", folder / "services.log", True)
        return stack, owner, owner_process, pending, port

    def absent(database):
        return None

    # The supported CLI form selects no benchmark and requires the exact stack.
    cli = local.parse_args(["--run-id", "a2-probe", "--reconcile-cleanup"])
    assert cli.reconcile_cleanup and cli.run_id == "a2-probe" and not cli.tasks
    for bad in (["--reconcile-cleanup"], ["chat-mode", "--run-id", "x", "--reconcile-cleanup"]):
        try:
            local.parse_args(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"accepted {bad}")

    # Owner gone and nothing left: a clean receipt the normal reader accepts.
    stack, owner, _, _, port = fixture()
    result = reconcile.reconcile_stack_cleanup(local, stack, database_present=absent)
    assert result.state == "clean", result.failures
    fields = dict(line.split("=", 1) for line in (stack.context_dir / "local-stack-cleanup.status").read_text().splitlines())
    assert fields["state"] == "clean" and fields["token"] == owner["token"]
    assert fields["stack_pid"] == str(owner["pid"]) and fields["stack_native_identity"] == owner["native_identity"]
    assert fields["reconciled_from_state"] == "pending" and fields["reconciled_ports"] == f"free:{port}"
    assert fields["reconciled_database"] == f"absent:victoria_bench_{stack.run_id}"
    local.stop_services(stack=stack)  # no longer "cleanup remains unverified"
    assert reconcile.reconcile_stack_cleanup(local, stack, database_present=absent).state == "already_clean"

    def assert_stays_pending(stack, pending, expected, db=absent, owner_alive=False):
        result = reconcile.reconcile_stack_cleanup(local, stack, database_present=db)
        assert result.state == "pending" and any(expected in failure for failure in result.failures), result.failures
        assert (stack.context_dir / "local-stack-cleanup.status").read_text() == pending
        if owner_alive:
            return  # stop_services would legitimately signal the live owner
        try:
            local.stop_services(stack=stack)
        except RuntimeError as error:
            assert "--reconcile-cleanup" in str(error)
        else:
            raise AssertionError("a pending receipt was accepted")

    # Owner still running.
    stack, _, owner_process, pending, _ = fixture(owner_alive=True)
    try:
        assert_stays_pending(stack, pending, "is still running", owner_alive=True)
    finally:
        owner_process.kill()
        owner_process.wait()

    # A leftover process still carrying the stack token.
    stack, owner, _, pending, _ = fixture()
    leftover = subprocess.Popen(["sleep", "300"], env={**os.environ, "RUN_STACK_CLEANUP_TOKEN": owner["token"]})
    try:
        assert_stays_pending(stack, pending, str(leftover.pid))
    finally:
        leftover.kill()
        leftover.wait()

    # A leftover process running from the stack's run dir.
    stack, _, _, pending, _ = fixture()
    leftover = subprocess.Popen(["sleep", "300"], cwd=stack.context_dir)
    try:
        assert_stays_pending(stack, pending, str(leftover.pid))
    finally:
        leftover.kill()
        leftover.wait()

    # A recorded service port still listening.
    stack, _, _, pending, port = fixture()
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen()
        assert_stays_pending(stack, pending, f"[{port}]")

    # The recorded database still exists, or its absence cannot be proven.
    stack, _, _, pending, _ = fixture()
    assert_stays_pending(stack, pending, "database still exists", db=lambda database: "system database x")

    def unreachable(database):
        raise RuntimeError("connection refused")

    stack, _, _, pending, _ = fixture()
    assert_stays_pending(stack, pending, "database absence unverifiable", db=unreachable)


def test_seed_bootstrap_fixture_does_not_enumerate_ambient_worker_processes():
    """The pre-service seed proof must not scan a sibling host's worker inventory."""
    from unittest.mock import patch
    import shlex

    with tempfile.TemporaryDirectory(prefix="native-seed-inventory-") as directory:
        folder = Path(directory)
        ambient = folder / "ambient"
        ambient.mkdir()
        observed = folder / "ambient-pgrep.log"
        probe = ambient / "pgrep"
        # A large unrelated inventory must never reach the copied bootstrap.
        # Values exceed the native PID ceiling, so no actual process is targeted.
        probe.write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$*" >> {shlex.quote(str(observed))}\n'
            'case "$*" in *worker*) seq 4294967296 4294968295; exit 0;; esac\n'
            "exit 1\n"
        )
        probe.chmod(0o700)
        with patch.dict(os.environ, {"PATH": f"{ambient}:{os.environ['PATH']}",
                                    "AMBIENT_PGREP_LOG": str(observed)}):
            local, stack = _run_native_seed_bootstrap(folder)
        assert not observed.exists(), "seed fixture consulted ambient process discovery"
        assert not (folder / "database.state").exists(), "owned fixture database leaked"
        local.stop_services(None, stack=stack)
