#!/usr/bin/env python3
"""Local benchmark orchestrator.

Owns local service startup/teardown, benchmark invocation, and post-failure
diagnostics. Benchmark definitions remain in tasks.json.
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
from benchmarks.dashboard import DashboardServer, dashboard_enabled, maybe_launch_dashboard

SERVICES_MANIFEST = REPO_ROOT / ".context" / "services.json"
SERVICE_LOG = REPO_ROOT / ".context" / "local-benchmark-services.log"
TUNNEL_LOG = REPO_ROOT / ".context" / "local-benchmark-ngrok.log"
BENCHMARK_CONTEXT_ROOT = REPO_ROOT / ".context" / "benchmarks"
CHECKPOINT_ROOT = REPO_ROOT / ".context" / "benchmark-checkpoints"
RUNS_DIR = AGENTS_DIR / "benchmarks" / "runs"
# A fresh isolated stack syncs the production-backed benchmark fixture before
# run.sh can publish services.json. That fixture currently includes 10k messages
# and 20k+ browser cookies, so a healthy first start can exceed three minutes.
SERVICE_START_TIMEOUT_SECONDS = 600
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
AGENT_PAYMENT_TASK_NAMES = {
    AGENT_PAYMENT_TEST_SHOP_TASK_NAME,
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
    "agent-payment-setup-resume",
}
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
class IMessageRelay:
    process: subprocess.Popen


# message-person relay constants — mirror scripts/run-bench-cloud so the local
# isolated run exercises the same authenticated-Mac path the cloud fleet does.
IMESSAGE_RELAY_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
IMESSAGE_RELAY_EXPECTED_PHONE = "+19729777432"
IMESSAGE_RELAY_EXPECTED_MESSAGE = "Hi! This is the Rose iMessage send bench."
IMESSAGE_RELAY_AUTOLOGIN_OTP = "181818"


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


def plan_invocations(tasks: Sequence[str]) -> list[BenchmarkInvocation]:
    return [BenchmarkInvocation("benchmarks", list(tasks), is_load=False)] if tasks else []


def build_task_selector_args(selected_tasks: Sequence[str], _all_names: Sequence[str]) -> list[str]:
    """Pass an exact ordered task list through to run_benchmark.py."""
    args: list[str] = []
    for task in selected_tasks:
        args.extend(["--task", task])
    return args


def _benchmark_python() -> str:
    """Interpreter for the run_benchmark.py subprocess.

    Prefer the agents venv so the subprocess inherits the full dependency set
    (e.g. boto3 for R2 world-model/trace-archive reads under --simulate), regardless
    of which interpreter launched local.py. Fall back to the current interpreter.
    """
    venv_python = AGENTS_DIR / "venv" / "bin" / "python"
    return str(venv_python) if venv_python.exists() else sys.executable


def build_benchmark_args(
    selected_tasks: Sequence[str],
    *,
    port: int,
    bootstrap: bool = False,
    anon: bool = False,
    max_concurrency: int = 5,
    keep_failed_agents: bool = True,
    simulate: bool = False,
    world_model_name: str | None = None,
) -> list[str]:
    args = [_benchmark_python(), "-u", "benchmarks/run_benchmark.py"]
    args.extend(build_task_selector_args(selected_tasks, known_task_names()))
    args.extend(["--port", str(port), "--ci"])
    if bootstrap:
        args.append("--bootstrap")
    if anon:
        args.append("--anon")
    if keep_failed_agents:
        args.append("--keep-failed-agents")
    if simulate:
        # World-model simulate mode. run.sh serves the WMH and exports WMH_BASE_URL
        # into the manifest; local.py injects it into this subprocess env. The name
        # defaults to the served model (WMH_MODEL_NAME) when not overridden here.
        args.append("--simulate")
        if world_model_name:
            args.extend(["--world-model-name", world_model_name])
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


def start_imessage_relay(port: int, run_timeout_seconds: int, heartbeat_wait_seconds: int = 240) -> IMessageRelay:
    """Run the authenticated-Mac iMessage relay against the isolated local backend.

    message-person only passes when a Mac polling this exact backend runs the
    Messages AppleScript. The cloud fleet (run-bench-cloud) starts this relay;
    the local isolated stack must do the same or message-person can never pass
    locally. The relay auto-logs-in the installed Rose app if it has no usable
    session (dev SMS OTP bypass), so a signed-out app doesn't block the run.
    """
    tsx = REPO_ROOT / "mac-app" / "node_modules" / ".bin" / "tsx"
    entry = REPO_ROOT / "mac-app" / "scripts" / "cloudbench-imessage-relay.ts"
    if not tsx.exists() or not entry.exists():
        raise RuntimeError("message-person requires mac-app tsx + cloudbench-imessage-relay.ts")
    (REPO_ROOT / ".context").mkdir(exist_ok=True)
    marker = REPO_ROOT / ".context" / f"local-imessage-relay-markers-{port}.json"
    if marker.exists():
        marker.unlink()
    log_path = REPO_ROOT / ".context" / f"local-imessage-relay-{port}.log"
    log = open(log_path, "w")
    process = subprocess.Popen(
        [
            str(tsx), str(entry),
            "--base-url", f"http://localhost:{port}",
            "--expected-user-id", IMESSAGE_RELAY_USER_ID,
            "--expected-phone", IMESSAGE_RELAY_EXPECTED_PHONE,
            "--expected-message", IMESSAGE_RELAY_EXPECTED_MESSAGE,
            "--marker-file", str(marker),
            "--timeout-seconds", str(run_timeout_seconds),
            "--auto-login-phone", IMESSAGE_RELAY_EXPECTED_PHONE,
            "--auto-login-otp", IMESSAGE_RELAY_AUTOLOGIN_OTP,
        ],
        cwd=str(REPO_ROOT / "mac-app"),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()
    deadline = time.time() + heartbeat_wait_seconds
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"iMessage relay exited before its heartbeat (code {process.returncode}); see {log_path}"
            )
        try:
            if "bridge heartbeat established" in log_path.read_text():
                print("Authenticated Mac iMessage relay is polling this benchmark backend.")
                return IMessageRelay(process=process)
        except FileNotFoundError:
            pass
        time.sleep(1)
    process.terminate()
    raise TimeoutError(f"iMessage relay did not establish a heartbeat in {heartbeat_wait_seconds}s; see {log_path}")


def stop_imessage_relay(relay: IMessageRelay | None) -> None:
    if relay is None or relay.process.poll() is not None:
        return
    relay.process.terminate()
    try:
        relay.process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        relay.process.kill()
        relay.process.wait()


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


def _descendant_pids(root: int) -> set[int]:
    """Every descendant of root (inclusive), captured now via pgrep -P."""
    seen: set[int] = set()
    frontier = [root]
    while frontier:
        pid = frontier.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            out = subprocess.run(
                ["pgrep", "-P", str(pid)], capture_output=True, text=True, timeout=2, check=False
            ).stdout
        except Exception:
            continue
        for line in out.split():
            with contextlib.suppress(ValueError):
                frontier.append(int(line))
    return seen


def _port_listener_pids(port: int) -> set[int]:
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True, timeout=3, check=False
        ).stdout
    except Exception:
        return set()
    pids: set[int] = set()
    for line in out.split():
        with contextlib.suppress(ValueError):
            pids.add(int(line))
    return pids


def _pid_cwd_under_worktree(pid: int) -> bool:
    """True iff pid's cwd is inside this worktree. Safety gate: guarantees the
    isolated teardown can never reach a process owned by a sibling worktree,
    even if a PID/port were somehow reused."""
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        ).stdout
    except Exception:
        return False
    root = str(REPO_ROOT)
    for line in out.splitlines():
        if line.startswith("n"):
            cwd = line[1:]
            return cwd == root or cwd.startswith(root + os.sep)
    return False


def _kill_scoped_processes_by_run_id(stack: ServiceStack) -> None:
    """Reap an isolated stack's processes scoped strictly to THIS run.

    The run_id only appears in run.sh's (and ngrok's) command line — the backend
    (`tsx src/server.ts`) and worker (`python worker.py`) carry it only in their
    environment, and they routinely reparent to launchd, so a command-line match
    alone leaks them. We instead union three run-specific signals — command-line
    run_id match, the manifest's recorded PIDs + their process trees, and the
    listeners on this run's unique service ports — then gate every candidate on
    cwd-under-this-worktree so a sibling worktree's stack is never touched.
    """
    if not stack.isolated or not stack.run_id or stack.run_id == "existing":
        return

    targets: set[int] = set()

    # 1) command-line run_id match (run.sh, ngrok)
    with contextlib.suppress(Exception):
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=3, check=False
        )
        for line in result.stdout.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            pid_text, _, command = stripped.partition(" ")
            with contextlib.suppress(ValueError):
                if stack.run_id in command:
                    targets.add(int(pid_text))

    # 2) manifest PIDs (run_sh + recorded services) and their process trees, plus
    #    3) listeners on this run's unique ports (catches reparented backend/vite).
    with contextlib.suppress(Exception):
        with open(stack.manifest_path) as f:
            manifest = json.load(f)
        if isinstance(manifest, dict):
            manifest_pids: list[int] = []
            run_sh_pid = manifest.get("run_sh_pid")
            if isinstance(run_sh_pid, int) and run_sh_pid > 0:
                manifest_pids.append(run_sh_pid)
            for service in manifest.get("services") or []:
                pid = service.get("pid") if isinstance(service, dict) else None
                if isinstance(pid, int) and pid > 0:
                    manifest_pids.append(pid)
            for pid in manifest_pids:
                targets |= _descendant_pids(pid)
            ports = manifest.get("ports") or {}
            for key in ("backend", "frontend", "health", "sdk_metrics", "mac_app", "ngrok_api"):
                port = ports.get(key) if isinstance(ports, dict) else None
                if isinstance(port, int) and port > 0:
                    targets |= _port_listener_pids(port)

    current_pid = os.getpid()
    targets.discard(current_pid)
    # Safety gate: only reap processes whose cwd is inside THIS worktree.
    scoped = {pid for pid in targets if _pid_cwd_under_worktree(pid)}
    if not scoped:
        return
    for pid in scoped:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
    time.sleep(1)
    for pid in scoped:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)


def needs_frontend_tunnel(tasks: Sequence[str]) -> bool:
    return bool(AGENT_PAYMENT_TASK_NAMES & set(tasks)) and not os.environ.get("BENCHMARK_FRONTEND_URL")


def needs_imessage_relay(tasks: Sequence[str]) -> bool:
    return "message-person" in set(tasks) and sys.platform == "darwin"


def needs_payment_fixture(tasks: Sequence[str]) -> bool:
    return bool(AGENT_PAYMENT_TASK_NAMES & set(tasks))


def configure_task_environment(tasks: Sequence[str]) -> None:
    if needs_frontend_tunnel(tasks):
        os.environ["BENCHMARK_BUNDLED_FRONTEND"] = "true"
    selected = set(tasks)
    if any(task.name in selected and task.requires_claude_code for task in all_tasks()):
        os.environ["ROSE_CODE_AGENT_PROVIDER"] = "claude"


def seed_payment_fixture(manifest: dict) -> None:
    database_url = manifest_database_url(manifest)
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
    timeout_seconds: int = SERVICE_START_TIMEOUT_SECONDS,
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


def _dashboard_context_dir(stack: ServiceStack) -> Path:
    """Absolute dir where run_benchmark.py's report_card.py writes report-card.json.

    The report-card emitter (run_benchmark.py) is constructed with the raw
    BENCHMARK_CONTEXT_DIR env value and resolves it against ITS cwd, which is
    AGENTS_DIR (run_benchmark_invocation launches it there). For isolated stacks
    BENCHMARK_CONTEXT_DIR is a REPO_ROOT-relative path, so it lands under
    AGENTS_DIR — we mirror that exact resolution so the dashboard serves the same
    directory the report card is written to. The dashboard asset + report card
    then live side by side and the page can fetch it over HTTP.
    """
    raw = os.environ.get("BENCHMARK_CONTEXT_DIR")
    if raw:
        candidate = Path(raw)
        return candidate if candidate.is_absolute() else (AGENTS_DIR / candidate)
    return stack.context_dir


def local_seed_dump_path() -> Path:
    """Schema- and day-scoped cache path for isolated local benchmark databases."""
    schema = REPO_ROOT / "back-end" / "prisma" / "schema.prisma"
    schema_hash = hashlib.sha1(schema.read_bytes()).hexdigest()
    day = time.strftime("%Y%m%d", time.gmtime())
    return BENCHMARK_CONTEXT_ROOT / "seed-cache" / f"{schema_hash}-{day}.dump"


def start_services(
    stack: ServiceStack,
    clean_first: bool = True,
    *,
    anon_steel_profile: bool = False,
    simulate: bool = False,
    world_model_name: str | None = None,
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
        # Every isolated run starts with an empty per-run database. Opt into
        # run.sh's schema/day-keyed R2 seed cache so startup restores the same
        # prod snapshot in seconds instead of row-syncing tens of thousands of
        # records before services.json can be published.
        seed_dump = Path(env.get("BENCHMARK_SEED_DUMP") or local_seed_dump_path())
        seed_dump.parent.mkdir(parents=True, exist_ok=True)
        env["BENCHMARK_SEED_DUMP"] = str(seed_dump)
        env["BENCHMARK_REQUIRE_SEED_DUMP"] = "1"
        if simulate:
            # Put the worker into simulate mode. run.sh forks the agents worker from this
            # env, so these must be set here (the worker's WMH adapter + fast-cache scope
            # read them from its process env). WMH_PORT mirrors run.sh's +6 offset.
            env["BENCHMARK_WORLD_MODEL_MODE"] = "simulate"
            env["WMH_BASE_URL"] = f"http://localhost:{stack.base_port + 6}"
            resolved_model = world_model_name or os.environ.get("WMH_MODEL_NAME")
            if resolved_model:
                env["WMH_MODEL_NAME"] = resolved_model
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
    urls = manifest.get("urls") if isinstance(manifest, dict) else {}
    ports = manifest.get("ports") if isinstance(manifest, dict) else {}
    database = manifest.get("database") if isinstance(manifest, dict) else {}
    # Real benchmark manifests always carry a DB port; partial manifests (e.g. the
    # WMH-only gated-off path) do not — tolerate their absence instead of raising.
    has_db_port = bool(
        (isinstance(database, dict) and (database.get("port") or database.get("use_system_postgres")))
        or (isinstance(ports, dict) and ports.get("local_db"))
    )
    if has_db_port:
        database_url = manifest_database_url(manifest)
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
    # World Model Harness: when run.sh served the WMH (benchmark/simulate builds),
    # the manifest carries its URL. Inject WMH_BASE_URL/WMH_MODEL_NAME so the
    # benchmark subprocess (run_benchmark.py) resolves the auto-served server.
    wmh_url = (urls.get("wmh") if isinstance(urls, dict) else "") or ""
    if wmh_url:
        os.environ["WMH_BASE_URL"] = str(wmh_url).rstrip("/")
        wmh_model = manifest.get("wmh_model_name") if isinstance(manifest, dict) else None
        os.environ.setdefault("WMH_MODEL_NAME", str(wmh_model) if wmh_model else "rose-archive")


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


def resolve_repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO_ROOT / path


def checkpoint_requested(args: argparse.Namespace) -> bool:
    return args.checkpoint is not None or bool(args.checkpoint_start_agent_id)


def checkpoint_source_path(task_name: str, args: argparse.Namespace) -> Path:
    if args.checkpoint_source_json:
        path = resolve_repo_path(args.checkpoint_source_json)
    else:
        raise ValueError("checkpoint_source_path requires --checkpoint-source-json")
    if not path.exists():
        raise FileNotFoundError(f"Checkpoint source JSON not found: {path}")
    return path


def checkpoint_tree_path(task_name: str, args: argparse.Namespace) -> Path | None:
    if args.checkpoint_no_tree:
        return None
    if args.checkpoint_tree_json:
        path = resolve_repo_path(args.checkpoint_tree_json)
    else:
        return None
    if not path.exists():
        raise FileNotFoundError(f"Checkpoint tree JSON not found: {path}")
    return path


def _finished_for_each_checkpoint_index(source_json: Path, requested_index: int) -> int | None:
    try:
        with source_json.open() as f:
            data = json.load(f)
    except Exception:
        return None
    messages = data.get("messages") or data.get("agent", {}).get("messages") or []
    if not isinstance(messages, list):
        return None
    for index in range(min(requested_index, len(messages) - 1), -1, -1):
        message = messages[index]
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if (
            metadata.get("toolName") == "spawn_general_purpose_agent_for_each"
            and metadata.get("toolStatus") == "FINISHED"
        ):
            return index
    return None


def checkpoint_through_index(source_json: Path, args: argparse.Namespace) -> int:
    if args.checkpoint_boundary == "for-each-finished":
        boundary_index = _finished_for_each_checkpoint_index(source_json, args.checkpoint)
        if boundary_index is not None:
            return boundary_index
    return args.checkpoint


def manifest_backend_url(manifest: dict) -> str:
    ports = manifest.get("ports") if isinstance(manifest, dict) else {}
    urls = manifest.get("urls") if isinstance(manifest, dict) else {}
    if isinstance(urls, dict):
        value = urls.get("backend_api") or urls.get("backend")
        if value:
            return str(value).rstrip("/")
    return f"http://localhost:{ports.get('backend', 3001)}"


def manifest_frontend_url(manifest: dict) -> str:
    ports = manifest.get("ports") if isinstance(manifest, dict) else {}
    urls = manifest.get("urls") if isinstance(manifest, dict) else {}
    if isinstance(urls, dict):
        value = urls.get("frontend") or urls.get("public")
        if value:
            return str(value).rstrip("/")
    return f"http://localhost:{ports.get('frontend', 3000)}"


def manifest_database_url(manifest: dict) -> str:
    ports = manifest.get("ports") if isinstance(manifest, dict) else {}
    database = manifest.get("database") if isinstance(manifest, dict) else {}
    name = database.get("name") if isinstance(database, dict) else None
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Services manifest is missing database name")
    port = database.get("port") if isinstance(database, dict) else None
    if not port:
        port = 5432 if isinstance(database, dict) and database.get("use_system_postgres") else ports.get("local_db")
    if not port:
        raise ValueError("Services manifest is missing local_db port")
    return f"postgresql://postgres:postgres@localhost:{port}/{name}"


def manifest_task_queue(manifest: dict) -> str:
    task_queue = manifest.get("temporal_task_queue") if isinstance(manifest, dict) else None
    if not task_queue:
        raise ValueError("Services manifest is missing temporal_task_queue")
    return str(task_queue)


def run_streamed_command(
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> tuple[int, str]:
    print("$ " + " ".join(str(part) for part in command))
    process = subprocess.Popen(
        list(command),
        cwd=cwd,
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
    if check and code != 0:
        raise RuntimeError(f"Command exited with {code}: {' '.join(str(part) for part in command)}")
    return code, output


def parse_key_output(output: str, key: str) -> str | None:
    prefix = f"{key}="
    for line in output.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return None


def sync_compute_tokens() -> None:
    print("Syncing local compute tokens")
    script = "from benchmarks.run_benchmark import _sync_compute_tokens; _sync_compute_tokens()"
    run_streamed_command([sys.executable, "-c", script], cwd=AGENTS_DIR, env={**os.environ}, check=True)


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


def checkpoint_out_path(stack: ServiceStack, task_name: str, args: argparse.Namespace) -> Path:
    if args.checkpoint_manifest:
        return resolve_repo_path(args.checkpoint_manifest)
    root = stack.context_dir / "checkpoints" if stack.isolated else CHECKPOINT_ROOT
    return root / f"{slugify(task_name)}.json"


def checkpoint_source_out_paths(stack: ServiceStack, task_name: str, args: argparse.Namespace) -> tuple[Path, Path | None]:
    root = stack.context_dir / "checkpoint-source" if stack.isolated else CHECKPOINT_ROOT / "sources"
    source_json = root / f"{slugify(task_name)}-source.json"
    tree_json = None if args.checkpoint_no_tree else root / f"{slugify(task_name)}-tree.json"
    return source_json, tree_json


def create_checkpoint_source_from_task(
    *,
    task_name: str,
    backend_port: int,
    stack: ServiceStack,
    args: argparse.Namespace,
) -> tuple[Path, Path | None]:
    source_json, tree_json = checkpoint_source_out_paths(stack, task_name, args)
    command = [
        sys.executable,
        "-u",
        "benchmarks/run_benchmark.py",
        "--task",
        task_name,
        "--port",
        str(backend_port),
        "--checkpoint-source-index",
        str(args.checkpoint),
        "--checkpoint-source-boundary",
        args.checkpoint_boundary,
        "--checkpoint-source-price-limit-cents",
        str(args.checkpoint_price_limit_cents),
        "--timeout-seconds",
        str(args.checkpoint_timeout_seconds),
        "--checkpoint-source-out",
        str(source_json),
        "--keep-agents",
    ]
    if tree_json is not None:
        command.extend(["--checkpoint-tree-out", str(tree_json)])
    if args.bootstrap:
        command.append("--bootstrap")
    if args.anon:
        command.append("--anon")
    print("Creating checkpoint source from benchmark task")
    code, _ = run_streamed_command(command, cwd=AGENTS_DIR, env={**os.environ, "PYTHONUNBUFFERED": "1"}, check=False)
    if code != 0:
        raise RuntimeError(f"Checkpoint source benchmark exited with {code}")
    if not source_json.exists():
        raise RuntimeError(f"Checkpoint source benchmark did not write {source_json}")
    if tree_json is not None and not tree_json.exists():
        raise RuntimeError(f"Checkpoint source benchmark did not write {tree_json}")
    return source_json, tree_json


def run_checkpoint_invocation(
    *,
    task_name: str,
    manifest: dict,
    stack: ServiceStack,
    args: argparse.Namespace,
    backend_port: int,
) -> int:
    backend_url = manifest_backend_url(manifest)
    frontend_url = manifest_frontend_url(manifest)
    database_url = manifest_database_url(manifest)
    task_queue = manifest_task_queue(manifest)
    env = {
        **os.environ,
        "DATABASE_URL": database_url,
        "DIRECT_URL": database_url,
        "TEMPORAL_TASK_QUEUE": task_queue,
    }

    print(f"\n== Running checkpointed benchmark: {task_name}")
    print(f"Backend: {backend_url}")
    sync_compute_tokens()

    checkpoint_manifest: Path | None = None
    agent_id = args.checkpoint_start_agent_id
    checkpoint_count = args.checkpoint_count

    if agent_id:
        if args.checkpoint_manifest:
            checkpoint_manifest = resolve_repo_path(args.checkpoint_manifest)
        print(f"Starting existing checkpoint {agent_id}")
        run_streamed_command(
            [
                "npx",
                "tsx",
                "scripts/start-agent-checkpoint.ts",
                "--agent-id",
                agent_id,
                "--task-queue",
                task_queue,
            ],
            cwd=REPO_ROOT / "back-end",
            env=env,
            check=True,
        )
    else:
        if args.checkpoint_source_json:
            source_json = checkpoint_source_path(task_name, args)
            tree_json = checkpoint_tree_path(task_name, args)
        else:
            source_json, tree_json = create_checkpoint_source_from_task(
                task_name=task_name,
                backend_port=backend_port,
                stack=stack,
                args=args,
            )
        out_path = checkpoint_out_path(stack, task_name, args)
        through_index = checkpoint_through_index(source_json, args)
        create_args = [
            "npx",
            "tsx",
            "scripts/create-agent-checkpoint.ts",
            "--source-json",
            str(source_json),
            "--through-index",
            str(through_index),
            "--task-name",
            task_name,
            "--fast-mode-cache",
            str(args.checkpoint_fast_mode_cache).lower(),
            "--price-limit-cents",
            str(args.checkpoint_price_limit_cents),
            "--task-queue",
            task_queue,
            "--out",
            str(out_path),
        ]
        if tree_json is not None:
            create_args.extend(["--tree-json", str(tree_json)])
        if args.checkpoint_no_start:
            create_args.append("--no-start")

        print("Creating checkpoint clone")
        _, output = run_streamed_command(create_args, cwd=REPO_ROOT / "back-end", env=env, check=True)
        parsed_agent_id = parse_key_output(output, "agent_id")
        parsed_manifest = parse_key_output(output, "manifest")
        if not parsed_agent_id or not parsed_manifest:
            raise RuntimeError("Could not parse checkpoint agent_id/manifest from create-agent-checkpoint output")
        agent_id = parsed_agent_id
        checkpoint_manifest = Path(parsed_manifest)

    assert agent_id
    print(f"Frontend: {frontend_url}/?agent-id={agent_id}")
    if checkpoint_manifest:
        print(f"Checkpoint manifest: {checkpoint_manifest}")

    if args.checkpoint_no_start:
        print("Checkpoint created PAUSED. Resume with:")
        print(
            "scripts/run-bench "
            f"{task_name} --checkpoint-start-agent-id {agent_id} "
            f"--checkpoint-manifest {checkpoint_manifest}"
        )
        return 0

    poll_args = [
        sys.executable,
        "benchmarks/run_checkpoint_agent.py",
        "--task",
        task_name,
        "--url",
        backend_url,
        "--frontend-url",
        frontend_url,
        "--timeout-seconds",
        str(args.checkpoint_timeout_seconds),
    ]
    if checkpoint_manifest and checkpoint_manifest.exists():
        poll_args.extend(["--manifest", str(checkpoint_manifest)])
    else:
        if checkpoint_count is None:
            raise ValueError("--checkpoint-count is required when starting an existing checkpoint without a manifest")
        poll_args.extend(["--agent-id", agent_id, "--checkpoint-count", str(checkpoint_count)])

    print("Polling resumed checkpoint")
    code, _ = run_streamed_command(poll_args, cwd=AGENTS_DIR, env={**os.environ, "PYTHONUNBUFFERED": "1"}, check=False)
    return code


def run_benchmark_invocation(
    invocation: BenchmarkInvocation,
    *,
    port: int,
    bootstrap: bool,
    anon: bool,
    max_concurrency: int,
    simulate: bool = False,
    world_model_name: str | None = None,
) -> Path:
    started = time.time()
    command = build_benchmark_args(
        invocation.tasks,
        port=port,
        bootstrap=bootstrap,
        anon=anon,
        max_concurrency=max_concurrency,
        keep_failed_agents=True,
        simulate=simulate,
        world_model_name=world_model_name,
    )
    print(f"\n== Running {invocation.label}: {', '.join(invocation.tasks)}")
    print("$ " + " ".join(command))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    # Disable fast-cache for local benchmark runs so trajectories are actually executed
    # rather than replayed from cache. This is required for payment-lifecycle tasks (real
    # side effects must not be cache-replayed) and also ensures the world model is exercised
    # during simulate runs. run_benchmark reads this and sets fast_mode_cache_enabled=false
    # on the created agent. (Sim-scoped caching can be re-enabled once the worker-simulate
    # path is validated.)
    env.setdefault("BENCHMARK_FAST_MODE_CACHE", "false")
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
        # The saved run artifact records task outcomes, but post-run gates such
        # as cache and memory ratchets execute after that save. Never infer
        # success by re-reading an all-task-pass artifact when the owning runner
        # exited non-zero. Ordinary task failures still return their artifact so
        # the caller can run all three per-agent diagnostics before failing.
        if not failed_tasks_from_run(result_path):
            raise RuntimeError(f"Benchmark invocation failed with exit code {code}; result: {result_path}")
        print(f"Benchmark tasks failed with exit code {code}; collecting diagnostics from: {result_path}")
    return result_path


def tasks_from_args(args: argparse.Namespace) -> list[str]:
    if args.eval_suite:
        if args.only:
            return validate_task_names([name.strip() for name in args.only.split(",") if name.strip()])
        selected = [task for task in all_tasks() if task.status == "ready"]
        if args.bench:
            selected = [task for task in selected if task.bench == args.bench]
        return validate_task_names([task.name for task in selected])
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
    parser.add_argument("--full", action="store_true", help="Run every benchmark")
    parser.add_argument("--eval-suite", action="store_true", help="Run benchmarks/run_eval_suite.py against isolated services")
    parser.add_argument("--rerun-failed", metavar="RUN", help="Rerun failed tasks from a result JSON or 'latest'")
    parser.add_argument("--only", help="Comma-separated eval task names for --eval-suite")
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
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Run in world-model simulate mode (run.sh serves the WMH; env boundaries hit the world model)",
    )
    parser.add_argument(
        "--world-model-name",
        help="World model to simulate against (defaults to the model run.sh served, i.e. WMH_MODEL_NAME)",
    )
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
    parser.add_argument(
        "--no-dashboard",
        action="store_true",
        help="Do not serve the live benchmark dashboard (also via BENCHMARK_NO_DASHBOARD=1); no browser window is ever auto-opened",
    )
    parser.add_argument(
        "--checkpoint",
        "--through-index",
        dest="checkpoint",
        type=int,
        metavar="TURN_N",
        help=(
            "Run one benchmark until root message index TURN_N, pause/export it, "
            "clone the checkpoint, and resume it"
        ),
    )
    parser.add_argument(
        "--checkpoint-boundary",
        choices=["for-each-finished", "message-index"],
        default="for-each-finished",
        help=(
            "Durable boundary to prefer when it appears before the requested root message index. "
            "Use message-index to require the raw index exactly."
        ),
    )
    parser.add_argument(
        "--checkpoint-source-json",
        "--source-json",
        dest="checkpoint_source_json",
        help="Optional pre-exported root-agent transcript JSON to checkpoint instead of generating one",
    )
    parser.add_argument(
        "--checkpoint-tree-json",
        "--tree-json",
        dest="checkpoint_tree_json",
        help="Optional exported agent tree JSON to clone with the checkpoint",
    )
    parser.add_argument(
        "--checkpoint-no-tree",
        "--no-tree",
        dest="checkpoint_no_tree",
        action="store_true",
        help="Do not clone child Agent rows from the tree export",
    )
    parser.add_argument(
        "--checkpoint-no-start",
        "--no-start",
        dest="checkpoint_no_start",
        action="store_true",
        help="Create the checkpoint as PAUSED and keep the local FE stack available for inspection",
    )
    parser.add_argument(
        "--checkpoint-start-agent-id",
        "--start-agent-id",
        dest="checkpoint_start_agent_id",
        help="Start an existing PAUSED checkpoint instead of creating one",
    )
    parser.add_argument(
        "--checkpoint-manifest",
        help="Checkpoint manifest path. Used as create output path or existing checkpoint metadata.",
    )
    parser.add_argument(
        "--checkpoint-count",
        type=int,
        help="Number of pre-checkpoint messages when starting an existing checkpoint without a manifest",
    )
    parser.add_argument("--checkpoint-timeout-seconds", type=int, default=900, help="Checkpoint poll timeout")
    parser.add_argument(
        "--checkpoint-price-limit-cents",
        type=int,
        default=5000,
        help="Price limit for a created checkpoint agent",
    )
    parser.add_argument(
        "--checkpoint-fast-mode-cache",
        choices=["true", "false"],
        default="false",
        help="Fast Mode cache flag for the resumed checkpoint agent",
    )
    args = parser.parse_args(argv)
    selected_modes = sum(
        1
        for enabled in (bool(args.tasks), bool(args.suite), args.full, bool(args.rerun_failed), args.eval_suite)
        if enabled
    )
    if selected_modes != 1:
        parser.error("specify exactly one benchmark selection: tasks, --suite, --full, --rerun-failed, or --eval-suite")
    if not args.eval_suite and (args.only or args.bench):
        parser.error("--only and --bench require --eval-suite")
    if args.eval_suite and (args.bootstrap or args.anon):
        parser.error("--bootstrap and --anon are task-runner options, not --eval-suite options")
    if args.max_concurrency < 1:
        parser.error("--max-concurrency must be >= 1")
    if args.use_existing and (args.shared_stack or args.run_id or args.base_port or args.no_clean):
        parser.error("--use-existing cannot be combined with --shared-stack, --run-id, --base-port, or --no-clean")
    if args.base_port is not None and args.base_port < 1024:
        parser.error("--base-port must be >= 1024")
    if args.checkpoint is not None and args.checkpoint < 0:
        parser.error("--checkpoint must be a non-negative message index")
    if args.checkpoint_count is not None and args.checkpoint_count < 0:
        parser.error("--checkpoint-count must be non-negative")
    if args.checkpoint_start_agent_id and args.checkpoint is not None:
        parser.error("--checkpoint-start-agent-id cannot be combined with --checkpoint")
    if checkpoint_requested(args) and args.eval_suite:
        parser.error("--checkpoint is only supported for benchmark task selections, not --eval-suite")
    if checkpoint_requested(args) and args.checkpoint_no_start and args.checkpoint_start_agent_id:
        parser.error("--checkpoint-no-start cannot be combined with --checkpoint-start-agent-id")
    if (args.checkpoint_source_json or args.checkpoint_tree_json or args.checkpoint_no_tree) and not checkpoint_requested(args):
        parser.error("checkpoint source/tree options require --checkpoint or --checkpoint-start-agent-id")
    if args.checkpoint_price_limit_cents <= 0:
        parser.error("--checkpoint-price-limit-cents must be positive")
    if args.checkpoint_timeout_seconds <= 0:
        parser.error("--checkpoint-timeout-seconds must be positive")
    return args


def run_eval_suite_invocation(*, port: int, args: argparse.Namespace) -> int:
    command = [sys.executable, "-u", "benchmarks/run_eval_suite.py", "--port", str(port)]
    if args.only:
        command.extend(["--only", args.only])
    if args.bench:
        command.extend(["--bench", args.bench])
    print("\n== Running eval suite")
    print("$ " + " ".join(command))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    return subprocess.run(command, cwd=AGENTS_DIR, env=env).returncode


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    selected_tasks = tasks_from_args(args)
    configure_task_environment(selected_tasks)
    if checkpoint_requested(args) and len(selected_tasks) != 1:
        raise ValueError("--checkpoint requires exactly one resolved benchmark task")
    process: subprocess.Popen | None = None
    frontend_tunnel: FrontendTunnel | None = None
    imessage_relay: IMessageRelay | None = None
    dashboard: DashboardServer | None = None
    result_paths: list[Path] = []
    stack = build_service_stack(args)

    def handle_shutdown(signum: int, _frame: object) -> None:
        print(f"\nReceived signal {signum}; tearing down benchmark services...", file=sys.stderr)
        stop_imessage_relay(imessage_relay)
        stop_frontend_tunnel(frontend_tunnel)
        # The dashboard URL stays valid until the server stops here.
        if dashboard is not None:
            dashboard.stop()
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
                simulate=args.simulate,
                world_model_name=args.world_model_name,
            )
        apply_manifest_environment(manifest)
        if stack.isolated:
            # Child processes (run_benchmark.py, diagnostics, eval suite) inherit this
            # process's os.environ. They resolve the isolated stack's services.json via
            # BENCHMARK_CONTEXT_DIR; without it they default to the top-level ".context"
            # (a stale manifest from a prior run) and route DB fixtures to the wrong
            # database — e.g. the grep fixture's direct agent lookup hits system Postgres
            # instead of the isolated container and fails with "root agent not found".
            os.environ["BENCHMARK_CONTEXT_DIR"] = _context_dir_env_value(stack.context_dir)
            ports = manifest.get("ports", {})
            print(
                "Isolated benchmark stack: "
                f"run_id={stack.run_id} "
                f"context={stack.context_dir.relative_to(REPO_ROOT)} "
                f"backend={ports.get('backend')} "
                f"frontend={ports.get('frontend')} "
                f"db={(manifest.get('database') or {}).get('port') or ports.get('local_db')} "
                f"db_name={(manifest.get('database') or {}).get('name') or 'victoria'} "
                f"queue={manifest.get('temporal_task_queue')}"
            )
        # Live dashboard: serve the run's context dir (where run_benchmark.py's
        # report_card.py writes report-card.json); the URL is printed, no
        # browser window is opened (view runs in the in-app Benchmarks tab). Gated
        # off under CI / headless / opt-out so deploy+smoke automation never pops
        # a browser. run_benchmark.py resolves the same dir via BENCHMARK_CONTEXT_DIR.
        if dashboard_enabled(ci=args.no_dashboard):
            dashboard = maybe_launch_dashboard(_dashboard_context_dir(stack), enabled=True)
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
        if needs_imessage_relay(selected_tasks):
            # Bridge the isolated local backend to this Mac's Messages app, exactly
            # like the cloud fleet does. The relay's run deadline spans the whole
            # invocation so it keeps polling until the agent enqueues its message.
            imessage_relay = start_imessage_relay(port, run_timeout_seconds=1_200)
        if checkpoint_requested(args):
            return run_checkpoint_invocation(
                task_name=selected_tasks[0],
                manifest=manifest,
                stack=stack,
                args=args,
                backend_port=port,
            )
        if args.eval_suite:
            return run_eval_suite_invocation(port=port, args=args)
        for invocation in plan_invocations(selected_tasks):
            result_path = run_benchmark_invocation(
                invocation,
                port=port,
                bootstrap=args.bootstrap,
                anon=args.anon,
                max_concurrency=args.max_concurrency,
                simulate=args.simulate,
                world_model_name=args.world_model_name,
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
        stop_imessage_relay(imessage_relay)
        stop_frontend_tunnel(frontend_tunnel)
        # Stop the dashboard HTTP server; anyone viewing the URL keeps the
        # final report card remains visible after teardown.
        if dashboard is not None:
            dashboard.stop()
        keep_paused_checkpoint_stack = checkpoint_requested(args) and args.checkpoint_no_start
        if keep_paused_checkpoint_stack and not args.keep_services and not args.use_existing:
            print("Keeping benchmark services running so the paused checkpoint FE link remains valid.")
        if not args.keep_services and not args.use_existing and not keep_paused_checkpoint_stack:
            stop_services(process, stack=stack)


if __name__ == "__main__":
    raise SystemExit(main())
