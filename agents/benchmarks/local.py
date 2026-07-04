#!/usr/bin/env python3
"""Local benchmark orchestrator.

Owns local service startup/teardown, benchmark invocation, load-test isolation,
and post-failure diagnostics. Benchmark definitions remain in tasks.json.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

AGENTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_DIR.parent
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.benchmark_tasks import all_tasks

LOAD_TEST_TASKS = {"load-test-sias"}
SERVICES_MANIFEST = REPO_ROOT / ".context" / "services.json"
SERVICE_LOG = REPO_ROOT / ".context" / "local-benchmark-services.log"
TUNNEL_LOG = REPO_ROOT / ".context" / "local-benchmark-ngrok.log"
BENCHMARK_CONTEXT_ROOT = REPO_ROOT / ".context" / "benchmarks"
RUNS_DIR = AGENTS_DIR / "benchmarks" / "runs"
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
BENCHMARK_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


@dataclass(frozen=True)
class BenchmarkInvocation:
    label: str
    tasks: list[str]
    is_load: bool = False


@dataclass(frozen=True)
class FailedTask:
    name: str
    agent_id: str
    failure_reason: str


@dataclass(frozen=True)
class FrontendTunnel:
    process: subprocess.Popen
    public_url: str


@dataclass(frozen=True)
class ServiceStack:
    run_id: str
    context_dir: Path
    manifest_path: Path
    service_log: Path
    isolated: bool
    workspace_name: str | None = None
    base_port: int | None = None


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-")
    return slug or "bench"


def make_run_id(explicit: str | None = None) -> str:
    if explicit:
        return slugify(explicit)
    return f"{int(time.time())}-{os.getpid()}-{random.randrange(10000, 99999)}"


def _port_is_available(port: int, docker_ports: str) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.1)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            return False
    return f":{port}->" not in docker_ports


def _docker_ports_snapshot() -> str:
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Ports}}"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except Exception:
        return ""
    return result.stdout if result.returncode == 0 else ""


def allocate_port_range(preferred_base: int | None = None) -> int:
    offsets = (0, 1, 2, 3, 4, 5, 9)
    docker_ports = _docker_ports_snapshot()
    candidates: list[int] = []
    if preferred_base:
        candidates.append(preferred_base)
    seed = int(hashlib.sha1(f"{time.time()}:{os.getpid()}".encode()).hexdigest()[:8], 16)
    start = 55000 + (seed % 400) * 20
    candidates.extend(range(start, 65500, 20))
    candidates.extend(range(55000, start, 20))
    for base in candidates:
        if base < 1024 or base + max(offsets) >= 65535:
            continue
        if all(_port_is_available(base + offset, docker_ports) for offset in offsets):
            return base
    raise RuntimeError("Could not find a free benchmark port range")


def build_service_stack(args: argparse.Namespace) -> ServiceStack:
    if args.use_existing:
        return ServiceStack(
            run_id="existing",
            context_dir=SERVICES_MANIFEST.parent,
            manifest_path=SERVICES_MANIFEST,
            service_log=SERVICE_LOG,
            isolated=False,
        )
    isolated = not args.shared_stack
    run_id = make_run_id(args.run_id)
    if not isolated:
        return ServiceStack(
            run_id=run_id,
            context_dir=SERVICES_MANIFEST.parent,
            manifest_path=SERVICES_MANIFEST,
            service_log=SERVICE_LOG,
            isolated=False,
        )
    context_dir = BENCHMARK_CONTEXT_ROOT / run_id
    base_name = os.environ.get("CONDUCTOR_WORKSPACE_NAME") or REPO_ROOT.name
    workspace_name = slugify(f"{base_name}-bench-{run_id}")[:60].strip("-")
    preferred_base = args.base_port
    if preferred_base is None:
        env_base = os.environ.get("CONDUCTOR_PORT")
        if env_base and env_base.isdigit():
            preferred_base = int(env_base) + 200
    return ServiceStack(
        run_id=run_id,
        context_dir=context_dir,
        manifest_path=context_dir / "services.json",
        service_log=context_dir / "services.log",
        isolated=True,
        workspace_name=workspace_name,
        base_port=allocate_port_range(preferred_base),
    )


def known_task_names() -> list[str]:
    return [task.name for task in all_tasks()]


def validate_task_names(names: Sequence[str]) -> list[str]:
    known = set(known_task_names())
    unknown = sorted(set(names) - known)
    if unknown:
        raise ValueError(f"Unknown benchmark task(s): {', '.join(unknown)}")
    deduped: list[str] = []
    for name in names:
        if name not in deduped:
            deduped.append(name)
    return deduped


def split_load_tasks(tasks: Sequence[str]) -> tuple[list[str], list[str]]:
    non_load = [name for name in tasks if name not in LOAD_TEST_TASKS]
    load = [name for name in tasks if name in LOAD_TEST_TASKS]
    return non_load, load


def plan_invocations(tasks: Sequence[str]) -> list[BenchmarkInvocation]:
    non_load, load = split_load_tasks(tasks)
    invocations: list[BenchmarkInvocation] = []
    if non_load:
        invocations.append(BenchmarkInvocation("non-load", list(non_load), is_load=False))
    for name in load:
        invocations.append(BenchmarkInvocation(name, [name], is_load=True))
    return invocations


def build_task_selector_args(selected_tasks: Sequence[str], all_names: Sequence[str]) -> list[str]:
    selected = list(selected_tasks)
    if len(selected) == 1:
        return ["--task", selected[0]]
    excluded = [name for name in all_names if name not in set(selected)]
    args = ["--suite", "all"]
    if excluded:
        args.extend(["--exclude-task", ",".join(excluded)])
    return args


def build_benchmark_args(
    selected_tasks: Sequence[str],
    *,
    port: int,
    bootstrap: bool = False,
    anon: bool = False,
    max_concurrency: int = 5,
    keep_failed_agents: bool = True,
) -> list[str]:
    args = [sys.executable, "-u", "benchmarks/run_benchmark.py"]
    args.extend(build_task_selector_args(selected_tasks, known_task_names()))
    args.extend(["--port", str(port), "--ci"])
    if bootstrap:
        args.append("--bootstrap")
    if anon:
        args.append("--anon")
    if keep_failed_agents:
        args.append("--keep-failed-agents")
    if len(selected_tasks) > 1:
        args.extend(["--parallel", "--max-concurrency", str(max_concurrency)])
    return args


def load_services_manifest(path: Path = SERVICES_MANIFEST) -> dict:
    with open(path) as f:
        data = json.load(f)
    ports = data.get("ports") if isinstance(data, dict) else None
    if not isinstance(ports, dict) or not ports.get("backend") or not ports.get("health"):
        raise ValueError(f"Invalid services manifest: missing backend/health ports in {path}")
    return data


def services_manifest_anon_enabled(manifest: dict) -> bool:
    env = manifest.get("env") if isinstance(manifest, dict) else None
    if not isinstance(env, dict):
        return False
    return (
        env.get("benchmark_anon_steel_profile") is True
        and env.get("benchmark_disable_saved_browser_auth") is True
    )


def http_ok(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def _ngrok_public_url_for_port(port: int) -> str | None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1.0) as response:
            data = json.load(response)
    except Exception:
        return None
    for tunnel in data.get("tunnels", []) or []:
        if not isinstance(tunnel, dict):
            continue
        public_url = tunnel.get("public_url")
        config = tunnel.get("config") if isinstance(tunnel.get("config"), dict) else {}
        addr = str(config.get("addr") or "")
        if isinstance(public_url, str) and public_url.startswith("https://") and addr.endswith(f":{port}"):
            return public_url.rstrip("/")
    return None


def start_frontend_tunnel(port: int, timeout_seconds: int = 45) -> FrontendTunnel:
    if not shutil.which("ngrok"):
        raise RuntimeError("agent-payment-test-shop requires ngrok so the cloud browser can reach the local test site")
    existing = _ngrok_public_url_for_port(port)
    if existing:
        return FrontendTunnel(process=subprocess.Popen(["true"]), public_url=existing)

    (REPO_ROOT / ".context").mkdir(exist_ok=True)
    tunnel_log = open(TUNNEL_LOG, "w")
    process = subprocess.Popen(
        ["ngrok", "http", str(port), "--log=stdout", "--log-format=json"],
        cwd=REPO_ROOT,
        stdout=tunnel_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    tunnel_log.close()

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ngrok exited early with code {process.returncode}; see {TUNNEL_LOG}")
        public_url = _ngrok_public_url_for_port(port)
        if public_url:
            return FrontendTunnel(process=process, public_url=public_url)
        time.sleep(1)

    process.terminate()
    raise TimeoutError(f"Timed out waiting for ngrok test-site tunnel; see {TUNNEL_LOG}")


def stop_frontend_tunnel(tunnel: FrontendTunnel | None) -> None:
    if tunnel is None or tunnel.process.poll() is not None:
        return
    tunnel.process.terminate()
    try:
        tunnel.process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        tunnel.process.kill()
        tunnel.process.wait()


def _manifest_run_sh_pid(stack: ServiceStack) -> int | None:
    try:
        manifest = load_services_manifest(stack.manifest_path)
    except Exception:
        return None
    pid = manifest.get("run_sh_pid")
    return pid if isinstance(pid, int) and pid > 1 else None


def _wait_for_pid_exit(pid: int, timeout_seconds: float) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(0.2)
    return False


def _manifest_status(stack: ServiceStack) -> str | None:
    try:
        with open(stack.manifest_path) as f:
            data = json.load(f)
    except Exception:
        return None
    status = data.get("status")
    return status if isinstance(status, str) else None


def _stop_owned_db_from_manifest(stack: ServiceStack) -> None:
    try:
        with open(stack.manifest_path) as f:
            manifest = json.load(f)
    except Exception:
        return
    database = manifest.get("database") if isinstance(manifest, dict) else None
    if not isinstance(database, dict):
        return
    if database.get("use_system_postgres") or not database.get("owned_by_run_sh"):
        return
    container = database.get("container")
    if isinstance(container, str) and container:
        subprocess.run(["docker", "rm", "-f", container], cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    volume = database.get("volume")
    if not isinstance(volume, str) or not volume:
        if isinstance(container, str) and container.startswith("victoria-db-"):
            volume = f"victoria-pgdata-{container[len('victoria-db-'):]}"
    if isinstance(volume, str) and volume:
        subprocess.run(["docker", "volume", "rm", volume], cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _kill_scoped_processes_by_run_id(stack: ServiceStack) -> None:
    if not stack.isolated or not stack.run_id or stack.run_id == "existing":
        return
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except Exception:
        return
    current_pid = os.getpid()
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == current_pid or stack.run_id not in command:
            continue
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
    time.sleep(1)
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == current_pid or stack.run_id not in command:
            continue
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)


def needs_frontend_tunnel(tasks: Sequence[str]) -> bool:
    return AGENT_PAYMENT_TEST_SHOP_TASK_NAME in set(tasks) and not os.environ.get("BENCHMARK_FRONTEND_URL")


def needs_payment_fixture(tasks: Sequence[str]) -> bool:
    return AGENT_PAYMENT_TEST_SHOP_TASK_NAME in set(tasks)


def seed_payment_fixture(manifest: dict) -> None:
    db_port = manifest.get("ports", {}).get("local_db")
    if not db_port:
        raise ValueError("Invalid services manifest: missing local_db port")
    database_url = f"postgresql://postgres:postgres@localhost:{db_port}/victoria"
    env = {
        **os.environ,
        "DATABASE_URL": database_url,
        "DIRECT_URL": database_url,
    }
    print("Seeding Stripe test billing fixture for agent-payment-test-shop")
    subprocess.run(
        [
            "npx",
            "tsx",
            "scripts/setup-benchmark-payment.ts",
            "--user-id",
            os.environ.get("BENCHMARK_USER_ID", BENCHMARK_USER_ID),
        ],
        cwd=REPO_ROOT / "back-end",
        env=env,
        check=True,
    )


def wait_for_services(
    manifest_path: Path = SERVICES_MANIFEST,
    *,
    process: subprocess.Popen | None = None,
    service_log: Path = SERVICE_LOG,
    timeout_seconds: int = 180,
) -> dict:
    deadline = time.time() + timeout_seconds
    last_error = ""
    while time.time() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"run.sh exited early with code {process.returncode}; see {service_log}")
        try:
            manifest = load_services_manifest(manifest_path)
            ports = manifest["ports"]
            backend_ok = http_ok(f"http://localhost:{ports['backend']}/health")
            worker_ok = http_ok(f"http://localhost:{ports['health']}/health")
            if manifest.get("status") == "running" and backend_ok and worker_ok:
                return manifest
            last_error = f"status={manifest.get('status')} backend={backend_ok} worker={worker_ok}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(2)
    raise TimeoutError(f"Timed out waiting for benchmark services ({last_error}); see {service_log}")


def _context_dir_env_value(context_dir: Path) -> str:
    try:
        return str(context_dir.relative_to(REPO_ROOT))
    except ValueError:
        return str(context_dir)


def start_services(
    stack: ServiceStack,
    clean_first: bool = True,
    *,
    anon_steel_profile: bool = False,
) -> tuple[subprocess.Popen, dict]:
    stack.context_dir.mkdir(parents=True, exist_ok=True)
    if clean_first and not stack.isolated:
        subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=True)
    service_log = open(stack.service_log, "w")
    env = {**os.environ, "DISABLE_GMAIL_SYNC": "1"}
    if anon_steel_profile:
        env["BENCHMARK_ANON_STEEL_PROFILE"] = "true"
        env["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = "true"
    if stack.isolated:
        assert stack.workspace_name
        assert stack.base_port
        env["BENCHMARK_ISOLATED_RUN"] = "true"
        env["BENCHMARK_CONTEXT_DIR"] = _context_dir_env_value(stack.context_dir)
        env["BENCHMARK_RUN_ID"] = stack.run_id
        env["CONDUCTOR_WORKSPACE_NAME"] = stack.workspace_name
        env["CONDUCTOR_PORT"] = str(stack.base_port)
        env["ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME"] = "1"
    process = subprocess.Popen(
        ["bash", "scripts/run.sh", "--benchmark"],
        cwd=REPO_ROOT,
        stdout=service_log,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    service_log.close()
    manifest = wait_for_services(stack.manifest_path, process=process, service_log=stack.service_log)
    return process, manifest


def stop_services(process: subprocess.Popen | None = None, *, stack: ServiceStack | None = None) -> None:
    if stack is None or not stack.isolated:
        subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=False)
    elif _manifest_status(stack) == "stopped":
        _stop_owned_db_from_manifest(stack)
        _kill_scoped_processes_by_run_id(stack)
        return
    target_pid: int | None = None
    if process is not None and process.poll() is None:
        target_pid = process.pid
    elif stack is not None and stack.isolated:
        target_pid = _manifest_run_sh_pid(stack)

    if target_pid is not None:
        try:
            os.killpg(target_pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        if process is not None and process.pid == target_pid:
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(target_pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        elif not _wait_for_pid_exit(target_pid, 20):
            try:
                os.killpg(target_pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            _wait_for_pid_exit(target_pid, 5)

    if stack is not None and stack.isolated:
        if _manifest_status(stack) != "stopped":
            _stop_owned_db_from_manifest(stack)
        _kill_scoped_processes_by_run_id(stack)


def apply_manifest_environment(manifest: dict) -> None:
    ports = manifest.get("ports") if isinstance(manifest, dict) else {}
    urls = manifest.get("urls") if isinstance(manifest, dict) else {}
    db_port = ports.get("local_db") if isinstance(ports, dict) else None
    if db_port:
        database_url = f"postgresql://postgres:postgres@localhost:{db_port}/victoria"
        os.environ["DATABASE_URL"] = f"{database_url}?connection_limit=50&pool_timeout=30"
        os.environ["DIRECT_URL"] = database_url
    task_queue = manifest.get("temporal_task_queue")
    if task_queue:
        os.environ["TEMPORAL_TASK_QUEUE"] = str(task_queue)
        prefix = "navi-agent-tasks-"
        if str(task_queue).startswith(prefix):
            os.environ["CONDUCTOR_WORKSPACE_NAME"] = str(task_queue)[len(prefix) :]
            os.environ["ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME"] = "1"
    public_url = (urls.get("public") if isinstance(urls, dict) else "") or ""
    if public_url:
        os.environ["PUBLIC_BASE_URL"] = str(public_url).rstrip("/")
        os.environ.setdefault("BENCHMARK_FRONTEND_URL", str(public_url).rstrip("/"))


def extract_results_path(output: str) -> Path | None:
    marker = "Results saved:"
    for line in output.splitlines():
        if marker in line:
            candidate = line.split(marker, 1)[1].strip()
            if candidate:
                return Path(candidate)
    return None


def latest_result_file(after_timestamp: float | None = None) -> Path | None:
    if not RUNS_DIR.exists():
        return None
    candidates = sorted(RUNS_DIR.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        if after_timestamp is None or path.stat().st_mtime >= after_timestamp:
            return path
    return None


def failed_tasks_from_run(path: Path) -> list[FailedTask]:
    with open(path) as f:
        data = json.load(f)
    failed: list[FailedTask] = []
    for task in data.get("tasks", data.get("task_results", [])):
        if task.get("passed") or task.get("status") == "SKIPPED":
            continue
        failed.append(
            FailedTask(
                name=str(task.get("name", "")),
                agent_id=str(task.get("agent_id", "")),
                failure_reason=str(task.get("failure_reason", "") or ""),
            )
        )
    return failed


def resolve_run_path(value: str) -> Path:
    if value == "latest":
        latest = latest_result_file()
        if latest is None:
            raise FileNotFoundError("No benchmark result files found")
        return latest
    path = Path(value)
    if not path.is_absolute():
        path = AGENTS_DIR / path
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def diagnostic_commands(agent_id: str, *, task_name: str, port: int) -> list[list[str]]:
    return [
        [sys.executable, "benchmarks/agent_latency.py", agent_id, "--benchmark", task_name, "--environment", "local"],
        [
            sys.executable,
            "benchmarks/agent_logs.py",
            agent_id,
            "--tree",
            "--diagnostics",
            "--url",
            f"http://localhost:{port}",
        ],
        [sys.executable, "benchmarks/agent_cache.py", agent_id],
    ]


def run_diagnostics(
    failures: Sequence[FailedTask],
    *,
    port: int,
    result_path: Path,
    timeout_seconds: float = 180,
) -> Path | None:
    runnable = [failure for failure in failures if failure.agent_id]
    if not runnable:
        return None
    out_root = result_path.with_suffix("")
    diag_root = out_root.parent / f"{out_root.name}_diagnostics"
    diag_root.mkdir(parents=True, exist_ok=True)
    for failure in runnable:
        task_dir = diag_root / f"{failure.name}_{failure.agent_id[:12]}"
        task_dir.mkdir(exist_ok=True)
        processes: list[tuple[subprocess.Popen, object]] = []
        for command in diagnostic_commands(failure.agent_id, task_name=failure.name, port=port):
            label = Path(command[1]).stem
            outfile = open(task_dir / f"{label}.txt", "w")
            outfile.write(f"$ {' '.join(command)}\n\n")
            outfile.flush()
            processes.append((subprocess.Popen(command, cwd=AGENTS_DIR, stdout=outfile, stderr=subprocess.STDOUT), outfile))
        for process, outfile in processes:
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                outfile.write(f"\n[diagnostic timed out after {timeout_seconds:g} seconds]\n")
            outfile.close()
    return diag_root


def run_benchmark_invocation(
    invocation: BenchmarkInvocation,
    *,
    port: int,
    bootstrap: bool,
    anon: bool,
    max_concurrency: int,
) -> Path:
    started = time.time()
    command = build_benchmark_args(
        invocation.tasks,
        port=port,
        bootstrap=bootstrap,
        anon=anon,
        max_concurrency=max_concurrency,
        keep_failed_agents=True,
    )
    print(f"\n== Running {invocation.label}: {', '.join(invocation.tasks)}")
    print("$ " + " ".join(command))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen(
        command,
        cwd=AGENTS_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    output_lines: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="")
        output_lines.append(line)
    code = process.wait()
    output = "".join(output_lines)
    result_path = extract_results_path(output)
    if result_path is None:
        latest = latest_result_file(started)
        latest_hint = f"; newest result after start was {latest}" if latest else ""
        raise RuntimeError(f"Benchmark command did not print a result file marker (exit {code}){latest_hint}")
    if code != 0:
        print(f"Benchmark invocation failed with exit code {code}; result: {result_path}")
    return result_path


def tasks_from_args(args: argparse.Namespace) -> list[str]:
    if args.eval_suite:
        if args.only:
            return validate_task_names([name.strip() for name in args.only.split(",") if name.strip()])
        selected = [task for task in all_tasks() if task.status == "ready"]
        if args.bench:
            selected = [task for task in selected if task.bench == args.bench]
        if args.agent_only:
            selected = [task for task in selected if task.runner == "agent"]
        return validate_task_names([task.name for task in selected if task.runner == "agent"])
    if args.rerun_failed:
        run_path = resolve_run_path(args.rerun_failed)
        failures = failed_tasks_from_run(run_path)
        names = [failure.name for failure in failures if failure.name]
        if not names:
            raise ValueError(f"No failed tasks found in {run_path}")
        return validate_task_names(names)
    if args.full:
        return known_task_names()
    if args.suite:
        if args.suite == "all":
            selected = [task for task in all_tasks() if task.runner == "agent" and task.status == "ready"]
        elif args.suite in ("rose-bench", "pipeline-e2e"):
            selected = [
                task
                for task in all_tasks()
                if task.runner == "agent" and task.status == "ready" and task.bench == args.suite
            ]
        else:
            selected = [
                task
                for task in all_tasks()
                if task.runner == "agent" and task.status == "ready" and args.suite in task.tags
            ]
        if not selected:
            raise ValueError(f"No ready agent benchmark tasks matched suite/tag: {args.suite}")
        return validate_task_names([task.name for task in selected])
    if args.tasks:
        return validate_task_names(args.tasks)
    raise ValueError("Specify benchmark task names, --suite, --full, or --rerun-failed latest")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local benchmarks with managed services and diagnostics")
    parser.add_argument("tasks", nargs="*", help="Benchmark task names, e.g. browser-agent cache-coverage")
    parser.add_argument("--suite", help="Benchmark suite/tag to run, e.g. smoke, rose-bench, pipeline-e2e, all")
    parser.add_argument("--full", action="store_true", help="Run every benchmark; load-test-sias runs by itself")
    parser.add_argument("--eval-suite", action="store_true", help="Run benchmarks/run_eval_suite.py against isolated services")
    parser.add_argument("--rerun-failed", metavar="RUN", help="Rerun failed tasks from a result JSON or 'latest'")
    parser.add_argument("--only", help="Comma-separated eval task names for --eval-suite")
    parser.add_argument("--agent-only", action="store_true", help="Pass --agent-only through to run_eval_suite.py")
    parser.add_argument(
        "--bench",
        choices=["rose-bench", "pipeline-e2e"],
        help="Pass --bench through to run_eval_suite.py",
    )
    parser.add_argument("--bootstrap", action="store_true", help="Pass --bootstrap through to run_benchmark.py")
    parser.add_argument(
        "--anon",
        action="store_true",
        help="Pass --anon through to run_benchmark.py so minted-auth benchmarks start without saved auth",
    )
    parser.add_argument("--max-concurrency", type=int, default=5, help="Max concurrent non-load benchmark tasks")
    parser.add_argument("--keep-services", action="store_true", help="Leave local services running after benchmarks")
    parser.add_argument("--use-existing", action="store_true", help="Use services from .context/services.json")
    parser.add_argument(
        "--shared-stack",
        action="store_true",
        help="Use the default .context/services.json stack instead of a per-run isolated stack",
    )
    parser.add_argument("--run-id", help="Stable id for the isolated benchmark stack")
    parser.add_argument("--base-port", type=int, help="Preferred base port for an isolated benchmark stack")
    parser.add_argument("--no-clean", action="store_true", help="Do not call scripts/kill-services.sh before startup")
    args = parser.parse_args(argv)
    selected_modes = sum(
        1
        for enabled in (bool(args.tasks), bool(args.suite), args.full, bool(args.rerun_failed), args.eval_suite)
        if enabled
    )
    if selected_modes != 1:
        parser.error("specify exactly one benchmark selection: tasks, --suite, --full, --rerun-failed, or --eval-suite")
    if not args.eval_suite and (args.only or args.agent_only or args.bench):
        parser.error("--only, --agent-only, and --bench require --eval-suite")
    if args.eval_suite and (args.bootstrap or args.anon):
        parser.error("--bootstrap and --anon are task-runner options, not --eval-suite options")
    if args.max_concurrency < 1:
        parser.error("--max-concurrency must be >= 1")
    if args.use_existing and (args.shared_stack or args.run_id or args.base_port or args.no_clean):
        parser.error("--use-existing cannot be combined with --shared-stack, --run-id, --base-port, or --no-clean")
    if args.base_port is not None and args.base_port < 1024:
        parser.error("--base-port must be >= 1024")
    return args


def run_eval_suite_invocation(*, port: int, args: argparse.Namespace) -> int:
    command = [sys.executable, "-u", "benchmarks/run_eval_suite.py", "--port", str(port)]
    if args.only:
        command.extend(["--only", args.only])
    if args.agent_only:
        command.append("--agent-only")
    if args.bench:
        command.extend(["--bench", args.bench])
    print("\n== Running eval suite")
    print("$ " + " ".join(command))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    return subprocess.run(command, cwd=AGENTS_DIR, env=env).returncode


def promote_direct_external_runner_tasks(args: argparse.Namespace) -> None:
    if args.eval_suite or not args.tasks:
        return
    by_name = {task.name: task for task in all_tasks()}
    selected = [by_name[name] for name in validate_task_names(args.tasks)]
    external = [task.name for task in selected if task.runner != "agent"]
    if not external:
        return
    args.eval_suite = True
    args.only = ",".join(task.name for task in selected)
    print(
        "Routing through eval suite because the selection includes external runner task(s): "
        + ", ".join(external)
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    promote_direct_external_runner_tasks(args)
    selected_tasks = tasks_from_args(args)
    process: subprocess.Popen | None = None
    frontend_tunnel: FrontendTunnel | None = None
    result_paths: list[Path] = []
    stack = build_service_stack(args)

    def handle_shutdown(signum: int, _frame: object) -> None:
        print(f"\nReceived signal {signum}; tearing down benchmark services...", file=sys.stderr)
        stop_frontend_tunnel(frontend_tunnel)
        if not args.keep_services and not args.use_existing:
            stop_services(process, stack=stack)
        raise SystemExit(128 + signum)

    previous_sigterm = signal.getsignal(signal.SIGTERM)
    previous_sigint = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)
    try:
        if args.use_existing:
            manifest = wait_for_services(stack.manifest_path, service_log=stack.service_log)
            if args.anon and not services_manifest_anon_enabled(manifest):
                raise RuntimeError(
                    "Existing local stack was not started with anon browser auth disabled. "
                    "Run without --use-existing so local.py can restart the stack with --anon."
                )
        else:
            process, manifest = start_services(
                stack,
                clean_first=not args.no_clean,
                anon_steel_profile=args.anon,
            )
        apply_manifest_environment(manifest)
        if stack.isolated:
            ports = manifest.get("ports", {})
            print(
                "Isolated benchmark stack: "
                f"run_id={stack.run_id} "
                f"context={stack.context_dir.relative_to(REPO_ROOT)} "
                f"backend={ports.get('backend')} "
                f"frontend={ports.get('frontend')} "
                f"db={ports.get('local_db')} "
                f"queue={manifest.get('temporal_task_queue')}"
            )
        if needs_payment_fixture(selected_tasks):
            seed_payment_fixture(manifest)
        if needs_frontend_tunnel(selected_tasks):
            # Prefer the stable public URL run.sh assigned at startup (reserved ngrok domain →
            # frontend port, where /test_payment is now served). Only spin an ad-hoc tunnel if
            # run.sh did not publish one.
            stable_public = ((manifest.get("urls") or {}).get("public") or "").strip()
            if stable_public:
                os.environ["BENCHMARK_FRONTEND_URL"] = stable_public.rstrip("/")
                print(f"Test payment public URL (run.sh): {stable_public}")
            else:
                frontend_tunnel = start_frontend_tunnel(int(manifest["ports"]["frontend"]))
                os.environ["BENCHMARK_FRONTEND_URL"] = frontend_tunnel.public_url.rstrip("/")
                print(f"Test payment tunnel (fallback): {frontend_tunnel.public_url}")
        port = int(manifest["ports"]["backend"])
        if args.eval_suite:
            return run_eval_suite_invocation(port=port, args=args)
        for invocation in plan_invocations(selected_tasks):
            result_path = run_benchmark_invocation(
                invocation,
                port=port,
                bootstrap=args.bootstrap,
                anon=args.anon,
                max_concurrency=args.max_concurrency,
            )
            result_paths.append(result_path)
            failures = failed_tasks_from_run(result_path)
            if failures:
                diag_dir = run_diagnostics(failures, port=port, result_path=result_path)
                if diag_dir:
                    print(f"Diagnostics saved: {diag_dir}")
        all_failures = [failure for path in result_paths for failure in failed_tasks_from_run(path)]
        if all_failures:
            print("\nFailed tasks:")
            for failure in all_failures:
                print(f"- {failure.name}: {failure.failure_reason or 'no reason'}")
            return 1
        print("\nAll requested benchmarks passed.")
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        signal.signal(signal.SIGINT, previous_sigint)
        stop_frontend_tunnel(frontend_tunnel)
        if not args.keep_services and not args.use_existing:
            stop_services(process, stack=stack)


if __name__ == "__main__":
    raise SystemExit(main())
