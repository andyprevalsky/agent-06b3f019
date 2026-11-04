"""Give concurrent mutable fixtures independent canonical local stacks.

Local selection -> bounded coordinator -> local.py child -> owned stack -> task
                                  TERM -> local.py -> task drain -> stack drain

The coordinator owns child processes and their result index. Each existing
local.py child retains responsibility for its backend, database, worker, browser
and payment cleanup. No fixture identity or task contract changes here.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from types import ModuleType

from benchmarks.benchmark_tasks import get_task_by_name


def _progress(*args, **kwargs) -> None:
    # Console consumers may disappear during cancellation. The durable child
    # log and ownership journal survive; console output must never abort drain.
    try:
        print(*args, **kwargs)
    except (OSError, ValueError):
        pass


def _relay_child_output(reader) -> None:
    if reader is None:
        return
    try:
        chunk = reader.read(65536)
    except (OSError, ValueError):
        return
    if chunk:
        _progress(chunk, end="", flush=True)


def _log_bytes(path: str) -> int | None:
    try:
        return Path(path).stat().st_size
    except OSError:
        return None


def needs_independent_worlds(task_names: list[str], max_concurrency: int) -> bool:
    """A reset must survive until its own task completes the onboarding flow."""
    if max_concurrency <= 1:
        return False
    from benchmarks.run_benchmark import _agentcard_setup_fixture_action

    actions = [_agentcard_setup_fixture_action(get_task_by_name(name), "http://localhost") for name in task_names]
    return "reset" in actions and sum(action is not None for action in actions) > 1


def _child_command(api: ModuleType, args, task: str, run_id: str, cohort: list[str], ordinal: int) -> list[str]:
    command = [
        api._benchmark_python(),
        "-u",
        str(api.AGENTS_DIR / "benchmarks/local.py"),
        task,
        "--run-id",
        run_id,
        "--max-concurrency",
        str(args.max_concurrency),
    ]
    for name in cohort:
        command.extend(["--cohort-task", name])
    for name in ("bootstrap", "anon", "simulate", "keep_services", "no_clean", "no_dashboard"):
        if getattr(args, name, False):
            command.append("--" + name.replace("_", "-"))
    if args.world_model_name:
        command.extend(["--world-model-name", args.world_model_name])
    if args.base_port is not None:
        preferred = args.base_port + ordinal * 10
        if preferred > 65525:
            raise ValueError("per-task preferred port range exceeds 65535")
        command.extend(["--base-port", str(preferred)])
    return command


def _verify_child_cleanup(api: ModuleType, row: dict, *, keep_services: bool, allow_not_started: bool = False) -> None:
    context = Path(row["context_dir"])
    benchmark = json.loads((context / "local-benchmark-owner.json").read_text())
    never_started = (
        allow_not_started
        and benchmark.get("state") == "not_started"
        and benchmark.get("pid") is None
        and benchmark.get("native_identity") == ""
        and benchmark.get("token") == ""
    )
    if (
        benchmark.get("version") != 1
        or benchmark.get("run_id") != row["run_id"]
        or (benchmark.get("state") != "cleanup_verified" and not never_started)
    ):
        raise RuntimeError("child benchmark cleanup remains unverified")
    if not never_started:
        api._read_cleanup_receipt(Path(benchmark["receipt"]), benchmark["token"])
    if not keep_services:
        owner = json.loads((context / "local-stack-owner.json").read_text())
        if owner.get("version") != 1 or owner.get("run_id") != row["run_id"]:
            raise RuntimeError("child stack owner does not match its world")
        receipt = api._read_cleanup_receipt(context / "local-stack-cleanup.status", owner["token"])
        if receipt.get("stack_pid") != str(owner["pid"]) or receipt.get("stack_birth") != owner["birth"]:
            raise RuntimeError("child stack cleanup receipt changed ownership")
        try:
            identity = api._process_identity_tools()["current_identity"](owner["pid"])
        except (OSError, ValueError, IndexError):
            if api._pid_is_alive(owner["pid"]):
                raise RuntimeError("child stack is live with unreadable native identity")
        else:
            if identity == owner["native_identity"]:
                raise RuntimeError("child stack survived its completed local controller")


def _read_child_results(api: ModuleType, row: dict, *, keep_services: bool) -> list[str]:
    _verify_child_cleanup(api, row, keep_services=keep_services)
    context = Path(row["context_dir"])
    index = json.loads((context / "local-benchmark-results.json").read_text())
    if index.get("version") != 1 or index.get("run_id") != row["run_id"]:
        raise RuntimeError("local result index does not belong to its child world")
    paths = index.get("results")
    if not isinstance(paths, list) or len(paths) != 1:
        raise RuntimeError("a child world must publish exactly one benchmark result")
    result_path = Path(paths[0]["path"])
    payload = result_path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != paths[0]["sha256"]:
        raise RuntimeError("child benchmark result changed after publication")
    tasks = json.loads(payload).get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or tasks[0].get("name") != row["task"]:
        raise RuntimeError("child benchmark result does not match its selected task occurrence")
    if row["exit_code"] == 0 and api.failed_tasks_from_run(result_path):
        raise RuntimeError("child reported success with a failed benchmark result")
    return [str(result_path)]


def run_task_worlds(api: ModuleType, args, task_names: list[str]) -> int:
    """Preserve the existing task scheduler while giving each occurrence a world."""
    from benchmarks.run_benchmark import _parallel_task_phases, _parallel_task_runners

    if args.use_existing or args.shared_stack:
        raise ValueError("concurrent mutable fixtures require independently owned local stacks")
    parent_id = api.make_run_id(args.run_id) + "-worlds"
    context = api.BENCHMARK_CONTEXT_ROOT / parent_id
    context.mkdir(mode=0o700, parents=True, exist_ok=False)
    rows = [
        {
            "ordinal": i,
            "task": name,
            "run_id": f"{parent_id}-{i}",
            "context_dir": str(api.BENCHMARK_CONTEXT_ROOT / f"{parent_id}-{i}"),
            "log": str(context / f"task-{i}.log"),
            "status": "queued",
        }
        for i, name in enumerate(task_names)
    ]
    # The child drains its benchmark and then its stack using this same owner
    # deadline. Include the existing two five-second tunnel/relay joins. This
    # bounds coordinator cancellation without inventing a shorter task timeout.
    shutdown_timeout = 2 * api._owned_shutdown_timeout() + 15
    stop_signal: int | None = None
    report = {
        "version": 1,
        "run_id": parent_id,
        "pid": os.getpid(),
        "native_identity": api._process_identity_tools()["current_identity"](os.getpid()),
        "max_concurrency": args.max_concurrency,
        "status": "running",
        "tasks": rows,
    }

    def save() -> None:
        api._write_owner_record(context / "local-worlds.json", report)

    def request_stop(signum, _frame) -> None:
        nonlocal stop_signal
        if stop_signal is None:
            stop_signal = signum

    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    previous_profiles = os.environ.get("BENCHMARK_ISOLATED_BROWSER_PROFILES")

    async def run(task):
        nonlocal stop_signal
        row = next(row for row in rows if row["task"] == task.name and row["status"] == "queued")
        if stop_signal is not None:
            row["status"] = "cancelled-before-start"
            save()
            return row
        row["status"] = "launching"
        save()
        process = None
        log_reader = None
        sent = False
        deadline = None
        ready_read = ready_write = None
        try:
            ready_read, ready_write = os.pipe()
            command = _child_command(api, args, task.name, row["run_id"], task_names, row["ordinal"])
            command.extend(["--world-ready-fd", str(ready_read)])
            with Path(row["log"]).open("xb") as output:
                os.chmod(row["log"], 0o600)
                process = subprocess.Popen(
                    command,
                    cwd=api.AGENTS_DIR,
                    # Child launchers start their own stacks; give them the parent's launch env.
                    env=api.service_base_environ(),
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    pass_fds=(ready_read,),
                )
            os.close(ready_read)
            ready_read = None
            log_reader = Path(row["log"]).open(encoding="utf-8", errors="replace")
            row["pid"] = process.pid
            row["native_identity"] = api._process_identity_tools()["current_identity"](process.pid)
            row["status"] = "running"
            save()
            os.write(ready_write, b"1")
            os.close(ready_write)
            ready_write = None
            next_progress = 0.0
            while process.poll() is None:
                _relay_child_output(log_reader)
                if stop_signal is not None and not sent:
                    api._signal_owned_process(process, row["native_identity"], signal.SIGTERM)
                    sent = True
                    deadline = time.monotonic() + shutdown_timeout
                    row["stop_signal"] = stop_signal
                    save()
                now = time.monotonic()
                if deadline is not None and now >= deadline:
                    raise TimeoutError("local child cleanup deadline expired; ownership retained")
                if now >= next_progress:
                    _progress(
                        f"Local world {row['ordinal']}: {task.name} pid={process.pid} "
                        f"log_bytes={_log_bytes(row['log'])}",
                        flush=True,
                    )
                    next_progress = now + 10
                await asyncio.sleep(0.05)
            row["exit_code"] = process.wait()
            _relay_child_output(log_reader)
            if row["exit_code"] in (0, 1) and not sent:
                row["results"] = _read_child_results(api, row, keep_services=args.keep_services)
                row["status"] = "passed" if row["exit_code"] == 0 else "failed"
            else:
                _verify_child_cleanup(api, row, keep_services=args.keep_services, allow_not_started=sent)
                row["status"] = "interrupted" if sent else "failed"
                if stop_signal is None:
                    stop_signal = signal.SIGTERM
            _progress(
                f"Local world {row['ordinal']}: {task.name} {row['status']} exit={row['exit_code']} log={row['log']}",
                flush=True,
            )
        except BaseException as error:
            row["status"] = "failed-retained"
            row["error"] = str(error)
            if stop_signal is None:
                stop_signal = signal.SIGTERM
        finally:
            for descriptor in (ready_read, ready_write):
                if descriptor is not None:
                    os.close(descriptor)
            if process is not None and process.poll() is None:
                # Keep this controller and its journal alive while the canonical
                # child's existing root/worker cleanup deadlines drain it.
                if row.get("native_identity") and not sent:
                    try:
                        api._signal_owned_process(process, row["native_identity"], signal.SIGTERM)
                    except Exception as error:
                        row["cleanup_error"] = str(error)
                if deadline is None:
                    deadline = time.monotonic() + shutdown_timeout
                next_progress = 0.0
                while process.poll() is None and time.monotonic() < deadline:
                    _relay_child_output(log_reader)
                    if time.monotonic() >= next_progress:
                        _progress(
                            f"Draining local world {row['ordinal']}: pid={process.pid} "
                            f"log_bytes={_log_bytes(row['log'])}",
                            flush=True,
                        )
                        next_progress = time.monotonic() + 10
                    await asyncio.sleep(0.05)
                row["exit_code"] = process.poll()
                if row["exit_code"] is None:
                    row["status"] = "failed-retained"
                    row["cleanup_error"] = "child remains live; exact ownership retained in journal"
            if log_reader is not None:
                _relay_child_output(log_reader)
                try:
                    log_reader.close()
                except OSError:
                    pass
            save()
        return row

    async def execute():
        tasks = [get_task_by_name(name) for name in task_names]
        phases = _parallel_task_phases(tasks)
        for task in phases[0][1]:
            await run(task)
        await asyncio.gather(*_parallel_task_runners(phases[1][1], args.max_concurrency, run))

    try:
        for sig in previous:
            signal.signal(sig, request_stop)
        os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = "true"
        save()
        _progress(f"Independent local task worlds: {context} (concurrency={args.max_concurrency})", flush=True)
        asyncio.run(execute())
        failed = any(row["status"] != "passed" for row in rows)
        report["status"] = "failed" if failed else "passed"
        report["stop_signal"] = stop_signal
        save()
        if stop_signal is not None:
            return 128 + stop_signal
        return 1 if failed else 0
    finally:
        if previous_profiles is None:
            os.environ.pop("BENCHMARK_ISOLATED_BROWSER_PROFILES", None)
        else:
            os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = previous_profiles
        for sig, handler in previous.items():
            signal.signal(sig, handler)
