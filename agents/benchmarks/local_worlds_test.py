#!/usr/bin/env python3
"""Actual local launcher ownership probe. All HTTP/services/agent work are private fixtures."""

from __future__ import annotations

import asyncio
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
import uuid
from dataclasses import replace
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve()
IDENTITY = runpy.run_path(str(REPO / "scripts/process-identity.py"))
PAIR = ["agent-payment-abandonment", "agent-payment-idempotent-abandonment"]
EXCLUSIVE_PAIR = ["agent-payment-abandonment", "agent-payment-setup-resume"]
# Host breathing room for observing the fixture controller (cancel readiness and
# exit), matching the deploy fixture-observation policy. A busy deploy host (load
# ~50 during parallel coverage, 2026-10-20) missed the former 12 s/15 s deadlines
# although every task finished; outcome and ownership assertions are unchanged.
FIXTURE_OBSERVATION_S = 60
USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


def independent_fixture_task(name):
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name(name)
    # These worlds use separate private HTTP servers, not the shared external
    # AgentCard sandbox. Preserve every task field except that resource claim.
    return replace(task, tags=[tag for tag in task.tags if tag != "agentcard-lifecycle-sandbox"])


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".pending")
    temporary.write_text(json.dumps(value) + "\n")
    temporary.replace(path)


def event(folder, name, **values):
    atomic(
        folder / "events" / f"{time.monotonic_ns()}-{os.getpid()}-{uuid.uuid4().hex}.json",
        {"event": name, "at": time.monotonic(), "pid": os.getpid(), **values},
    )


def identify(folder, role):
    value = {"pid": os.getpid(), "native_identity": IDENTITY["current_identity"](os.getpid()), "role": role}
    atomic(folder / "identities" / f"{os.getpid()}.json", value)
    return value


def exact_signal(value, name):
    return IDENTITY["main"](["identity", "--expect", value["native_identity"], "--signal", name, str(value["pid"])])


def live(value):
    try:
        return IDENTITY["current_identity"](value["pid"]) == value["native_identity"]
    except (OSError, ValueError, IndexError):
        return False


def wait_file(path, seconds=8):
    until = time.monotonic() + seconds
    while not path.exists():
        if time.monotonic() >= until:
            raise TimeoutError(f"fixture barrier absent: {path.name}")
        time.sleep(0.01)
    return json.loads(path.read_text())


def spawn(folder, args, **kwargs):
    log = (folder / "processes.private.log").open("ab")
    try:
        return subprocess.Popen(
            [sys.executable, str(SELF), *args], stdout=log, stderr=subprocess.STDOUT, start_new_session=True, **kwargs
        )
    finally:
        log.close()


def serve(folder, world):
    ident = identify(folder, "stack-server")
    state = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, value):
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/api/test-payment/lifecycle/agentcard-setup":
                self.send_error(404)
                return
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert value["userId"] == USER
            action = value["action"]
            assert action in {"reset", "complete"}
            state[value["userId"]] = "connect_required" if action == "reset" else "connected"
            event(folder, "fixture_write", world=str(world), action=action, user_id=value["userId"])
            atomic(folder / f"{action}.ready", {"pid": os.getpid()})
            self.reply({"status": state[value["userId"]]})

        def do_GET(self):
            self.reply({"status": state.get(USER), "world": str(world), "server_pid": os.getpid()})

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:

        def stop(sig, _frame):
            event(folder, "stack_stop", world=str(world), signal=sig)
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        atomic(world / "server.ready", {"port": server.server_port, **ident})
        server.serve_forever(poll_interval=0.02)
    return 0


def local_driver(folder, argv):
    sys.path.insert(0, str(REPO / "agents"))
    from benchmarks import local, local_worlds

    identify(folder, "local-controller")
    local_worlds.get_task_by_name = independent_fixture_task
    local.BENCHMARK_CONTEXT_ROOT = folder / "worlds"
    # No Docker, provider, database, tunnel, or web builds. The real stack allocator's
    # run/context identity remains; its port availability boundary is modeled.
    local.allocate_port_range = lambda preferred_base=None: 24000
    local.validate_agentcard_org_credentials = lambda _tasks: None
    local._owned_shutdown_timeout = lambda: 5
    local._benchmark_python = lambda: str(SELF)
    local.dashboard_enabled = lambda **_kw: False
    local.seed_payment_fixture = lambda _manifest: None
    local.needs_frontend_tunnel = lambda _tasks: False
    local.needs_imessage_relay = lambda _tasks: False
    local.diagnostic_log_env = lambda _stack: {}
    processes = {}

    def start(stack, **kwargs):
        stack.context_dir.mkdir(parents=True, exist_ok=True)
        process = spawn(folder, ["server", str(folder), str(stack.context_dir)], env=dict(os.environ))
        ready = wait_file(stack.context_dir / "server.ready")
        processes[stack.run_id] = (process, ready)
        kwargs.get("on_process", lambda _p: None)(process)
        local._record_stack_cleanup_owner(stack, process, "fixture-" + stack.run_id)
        manifest = {
            "status": "running",
            "run_sh_pid": process.pid,
            "ports": {"backend": ready["port"], "frontend": ready["port"], "health": ready["port"]},
            "database": {"name": "fixture-" + stack.run_id},
            "temporal_task_queue": "fixture-" + stack.run_id,
        }
        atomic(stack.manifest_path, manifest)
        event(
            folder,
            "world_created",
            world=str(stack.context_dir),
            run_id=stack.run_id,
            server_pid=process.pid,
            native_identity=ready["native_identity"],
            backend_port=ready["port"],
            database=manifest["database"]["name"],
            queue=manifest["temporal_task_queue"],
            tasks=list(kwargs.get("tasks", [])),
        )
        kwargs.get("on_owner_ready", lambda: None)()
        return process, manifest

    def stop(process, *, stack):
        if stack.run_id not in processes:
            return
        owned, ident = processes[stack.run_id]
        owner = json.loads((stack.context_dir / "local-benchmark-owner.json").read_text())
        event(folder, "before_stack_stop", world=str(stack.context_dir), owner_state=owner["state"])
        if owned.poll() is None:
            assert exact_signal(ident, "TERM") == 0
        owned.wait(timeout=10)
        stack_owner = json.loads((stack.context_dir / "local-stack-owner.json").read_text())
        receipt = stack.context_dir / "local-stack-cleanup.status"
        receipt.write_text(
            f"version=1\ntoken={stack_owner['token']}\nstate=clean\nstack_pid={stack_owner['pid']}\nstack_birth={stack_owner['birth']}\n"
        )
        event(folder, "stack_joined", world=str(stack.context_dir), exit=owned.returncode)

    local.start_services = start
    local.stop_services = stop
    return local.main(argv)


class BoundaryReached(BaseException):
    pass


async def benchmark(folder, argv):
    from contextlib import ExitStack
    from unittest.mock import patch

    sys.path.insert(0, str(REPO / "agents"))
    import httpx

    from benchmarks import run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    # Keep the real shared-sandbox contract covered: independent fixture
    # admission must not conceal a removed production payment semaphore.
    active = peak = 0

    async def observe_admission(_task):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1

    await asyncio.gather(*bench._parallel_task_runners([get_task_by_name(n) for n in PAIR], 2, observe_admission))
    assert peak == 1, "shared external sandbox tasks must remain serialized"

    identify(folder, "benchmark")
    task_names = [argv[i + 1] for i, arg in enumerate(argv) if arg == "--task"]
    port = int(argv[argv.index("--port") + 1])
    width = int(argv[argv.index("--max-concurrency") + 1]) if "--max-concurrency" in argv else 1
    base = f"http://127.0.0.1:{port}"
    context = Path(os.environ["BENCHMARK_CONTEXT_DIR"])
    interrupted = False

    def stop(sig, _frame):
        nonlocal interrupted
        interrupted = True
        event(folder, "benchmark_interrupt", signal=sig, world=str(context))

    signal.signal(signal.SIGINT, stop)

    async def headers():
        return {"X-API-Key": "fixture-only"}

    async def fixtures(task, url):
        # Exercise opposing same-user writes through the real HTTP helper in
        # ordinary independent worlds. Setup/resume itself remains exclusive.
        if task.name == "agent-payment-idempotent-abandonment":
            await bench.configure_benchmark_agentcard_setup(url, "reset")
        names = json.loads(os.environ["WORLD_TEST_TASKS"])
        atomic(folder / f"{task.name}.fixture-ready", {"pid": os.getpid()})
        ordinary_pair = task.name in PAIR and set(PAIR).issubset(names)
        until = time.monotonic() + 8
        while ordinary_pair and not all((folder / f"{name}.fixture-ready").exists() for name in PAIR):
            if time.monotonic() >= until:
                raise TimeoutError("fixture writer barrier")
            await asyncio.sleep(0.01)
        return []

    async def empty(*_args):
        return []

    async def create(url, task):
        async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
            response = await client.get(url + "/fixture/state")
        event(
            folder,
            "task_observed",
            task=task.name,
            user_id=bench._current_benchmark_user_id(),
            backend_port=port,
            **response.json(),
        )
        if os.environ.get("WORLD_TEST_CANCEL") == "1" and task.name in PAIR:
            event(folder, "benchmark_awaiting_signal", world=str(context))
            until = time.monotonic() + 8
            while not interrupted and time.monotonic() < until:
                await asyncio.sleep(0.01)
            if not interrupted:
                raise TimeoutError("no controller cancellation received")
        raise BoundaryReached

    async def run(task):
        event(folder, "task_start", task=task.name, world=str(context))
        reached = False
        try:
            await bench.run_single_task(base, task)
        except BoundaryReached:
            reached = True
        finally:
            event(folder, "task_end", task=task.name, world=str(context))
        assert reached, "fixture did not reach create_agent boundary"

    with ExitStack() as stack:
        for name, value in {
            "_api_headers": headers,
            "_apply_live_fixtures": fixtures,
            "_apply_memory_fixtures": empty,
            "_restore_live_fixture_scenarios_async": empty,
            "create_agent": create,
        }.items():
            stack.enter_context(patch.object(bench, name, value))
        await asyncio.wait_for(
            asyncio.gather(*bench._parallel_task_runners([independent_fixture_task(n) for n in task_names], width, run)), 10
        )
    event(folder, "root_cleanup_complete", world=str(context))
    receipt = Path(os.environ["BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE"])
    receipt.write_text(f"version=1\ntoken={os.environ['BENCHMARK_INTERRUPT_CLEANUP_TOKEN']}\nstate=clean\n")
    result = context / "fixture-result.json"
    atomic(result, {"tasks": [{"name": n, "passed": True, "status": "PASSED"} for n in task_names]})
    print(f"Results saved: {result}", flush=True)
    return 130 if interrupted else 0


def clean_fixture(folder, direct):
    identities = [json.loads(p.read_text()) for p in (folder / "identities").glob("*.json")]
    for ident in identities:
        if live(ident):
            exact_signal(ident, "TERM")
    until = time.monotonic() + 10
    while any(live(i) for i in identities) and time.monotonic() < until:
        for process in direct:
            process.poll()
        time.sleep(0.02)
    for ident in identities:
        if live(ident):
            exact_signal(ident, "KILL")
    for process in direct:
        process.wait(timeout=10)
    until = time.monotonic() + 10
    while any(live(i) for i in identities) and time.monotonic() < until:
        time.sleep(0.02)
    alive = [i for i in identities if live(i)]
    atomic(folder / "fixture-cleanup.json", {"state": "verified" if not alive else "failed", "alive": alive})
    assert not alive


def run_case(folder, names, cancel=False, overlap=True):
    folder.mkdir(parents=True)
    env = {
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
        "HOME": os.environ["HOME"],
        "PYTHONUNBUFFERED": "1",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
        "WORLD_TEST_ROOT": str(folder),
        "WORLD_TEST_TASKS": json.dumps(names),
        "WORLD_TEST_CANCEL": str(int(cancel)),
    }
    process = spawn(folder, ["local", str(folder), *names, "--max-concurrency", "2", "--no-dashboard"], env=env)
    try:
        if cancel:
            until = time.monotonic() + FIXTURE_OBSERVATION_S
            while sum(
                json.loads(p.read_text())["event"] == "task_observed" for p in (folder / "events").glob("*.json")
            ) < len(names):
                if process.poll() is not None:
                    raise RuntimeError("controller exited before cancel barrier")
                if time.monotonic() >= until:
                    raise TimeoutError("cancel readiness")
                time.sleep(0.02)
            ident = next(
                json.loads(p.read_text())
                for p in (folder / "identities").glob("*.json")
                if json.loads(p.read_text())["pid"] == process.pid
            )
            assert exact_signal(ident, "TERM") == 0
        code = process.wait(timeout=FIXTURE_OBSERVATION_S)
        events = sorted([json.loads(p.read_text()) for p in (folder / "events").glob("*.json")], key=lambda e: e["at"])
        worlds = [e for e in events if e["event"] == "world_created"]
        observations = [e for e in events if e["event"] == "task_observed"]
        starts = [e["at"] for e in events if e["event"] == "task_start"]
        ends = [e["at"] for e in events if e["event"] == "task_end"]
        expected = {
            "agent-payment-setup-resume": "connect_required",
            "agent-payment-abandonment": "connected",
            "agent-payment-idempotent-abandonment": "connect_required",
        }
        task_events = [e for e in events if e["event"] in {"task_start", "task_end"}]
        ordinary_starts = [e["at"] for e in task_events if e["event"] == "task_start" and e["task"] in PAIR]
        ordinary_ends = [e["at"] for e in task_events if e["event"] == "task_end" and e["task"] in PAIR]
        exclusive_ends = [e["at"] for e in task_events if e["event"] == "task_end" and e["task"] == EXCLUSIVE_PAIR[1]]
        expected_overlap = (
            len(ordinary_starts) == len(ordinary_ends) == 2
            and max(ordinary_starts) < min(ordinary_ends)
            and len(exclusive_ends) == 1 and exclusive_ends[0] < min(ordinary_starts)
        ) if len(names) > 1 else max(starts) < min(ends)
        assertions = {
            "expected_controller_exit": code == (143 if cancel else 0),
            "all_tasks_observed": sorted(e["task"] for e in observations) == sorted(names),
            "distinct_owned_worlds": len(worlds) == len(names) and len({e["server_pid"] for e in worlds}) == len(names),
            "distinct_backend_database_and_queue": all(
                len({e[key] for e in worlds}) == len(names) for key in ("backend_port", "database", "queue")
            ),
            "original_cohort_config_preserved": len(worlds) == len(names) and all(e["tasks"] == names for e in worlds),
            "same_user_fixture_preserved": len(observations) == len(names)
            and all(e["user_id"] == USER and e["status"] == expected[e["task"]] for e in observations),
            "task_lifetime_contract": len(starts) == len(names)
            and len(ends) == len(names)
            and (
                expected_overlap if overlap else
                [(e["event"], e["task"]) for e in task_events] == [
                    ("task_start", "agent-payment-setup-resume"),
                    ("task_end", "agent-payment-setup-resume"),
                    ("task_start", "agent-payment-abandonment"),
                    ("task_end", "agent-payment-abandonment"),
                ]
            ),
            "cleanup_verified_before_stack_stop": len(worlds) > 0
            and all(e["owner_state"] == "cleanup_verified" for e in events if e["event"] == "before_stack_stop")
            and len([e for e in events if e["event"] == "stack_joined"]) == len(worlds),
        }
        return {
            "controller_exit": code,
            "assertions": assertions,
            "worlds": worlds,
            "observations": observations,
            "events": events,
        }
    finally:
        clean_fixture(folder, [process])


def replay(folder):
    folder.mkdir(parents=True, exist_ok=False)
    cases = {}
    for name, names, cancel, overlap in [
        ("single-control", [EXCLUSIVE_PAIR[1]], False, True),
        ("exclusive-pair", EXCLUSIVE_PAIR, False, False),
        ("pair", [EXCLUSIVE_PAIR[1], *PAIR], False, True),
        ("cancel-pair", [EXCLUSIVE_PAIR[1], *PAIR], True, True),
    ]:
        try:
            cases[name] = run_case(folder / name, names, cancel, overlap)
        except Exception as error:
            cases[name] = {"fixture_error": type(error).__name__, "message": str(error)}
    result = {
        "source_sha256": hashlib.sha256((REPO / "agents/benchmarks/local.py").read_bytes()).hexdigest(),
        "fixture_sha256": hashlib.sha256(SELF.read_bytes()).hexdigest(),
        "cases": cases,
        "scope": "Real local main/args/stack identity/benchmark command/LocalBenchmarkOwner and real HTTP/reset helper/task scheduler; no real database, provider, agent creation, production task evaluation, or canonical stack service internals.",
    }
    atomic(folder / "result.json", result)
    print(
        json.dumps(
            {"artifact": str(folder / "result.json"), "cases": {k: v.get("assertions", v) for k, v in cases.items()}},
            indent=2,
        )
    )
    return 0 if all("assertions" in v and all(v["assertions"].values()) for v in cases.values()) else 1


def test_local_parallel_fixture_worlds():
    artifact_root = REPO / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-fixture-worlds-", dir=artifact_root))
    folder.rmdir()
    assert replay(folder) == 0, f"Local fixture world isolation failed; evidence: {folder}"


if __name__ == "__main__":
    os.umask(0o077)
    args = sys.argv[1:]
    while args and args[0] == "-u":
        args = args[1:]
    if args[0] == "server":
        code = serve(Path(args[1]), Path(args[2]))
    elif args[0] == "local":
        code = local_driver(Path(args[1]), args[2:])
    elif args[0] == "replay":
        code = replay(Path(args[1]).resolve())
    elif Path(args[0]).name in {"local.py", "run_benchmark.py"}:
        folder = Path(os.environ["WORLD_TEST_ROOT"])
        code = (
            local_driver(folder, args[1:])
            if Path(args[0]).name == "local.py"
            else asyncio.run(benchmark(folder, args[1:]))
        )
    else:
        raise RuntimeError("Unsupported fixture child entrypoint")
    raise SystemExit(code)
