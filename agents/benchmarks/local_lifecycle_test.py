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
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import os,signal,time; signal.signal(signal.SIGINT,lambda *a:None); os.close(1); os.close(2); time.sleep(1.2)",
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
        assert fields["version"] == "1" and fields["token"] == "fixture-token" and fields["state"] == "clean"
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
