#!/usr/bin/env python3
"""Local benchmark orchestrator.

Owns local service startup/teardown, benchmark invocation, and post-failure
diagnostics. Benchmark definitions remain in tasks.json.
"""

from __future__ import annotations

import argparse
import codecs
import contextlib
import fcntl
import functools
import hashlib
import importlib.util
import json
import os
import random
import re
import runpy
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence, TextIO
from urllib.parse import urlsplit

AGENTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_DIR.parent
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.benchmark_tasks import (
    RUNNABLE_TASK_RUNNERS,
    all_tasks,
    get_task_by_name,
)
from benchmarks.polar_catalog import is_polar_bench_task


def apply_owned_wmh_recording(
    env: dict[str, str],
    *,
    isolated: bool,
    simulate: bool,
    tasks: Sequence[object],
    workspace: str | None,
    fixture_database: str,
) -> bool:
    """Admit explicitly selected recording only into its retained owned cache."""
    recording = env.get("FAST_MODE_CACHE_RECORD_DEMO", "").strip().lower()
    if not (isolated and simulate and recording in {"1", "true", "yes", "on"}):
        return False
    if not tasks or not all(getattr(task, "fast_cache", None) == "on" for task in tasks):
        return False
    manifest_path = env.get("WMH_OWNED_RECORDING_CACHE_MANIFEST", "")
    retained_url = env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL", "")
    if not manifest_path and not retained_url:
        return False
    if not manifest_path:
        raise ValueError("Selected isolated WMH recording requires a retained owned cache manifest")
    manifest_file = Path(manifest_path)
    if manifest_file.is_symlink() or not manifest_file.is_file():
        raise ValueError("Owned recording manifest must be a regular private file")
    manifest = json.loads(manifest_file.read_text())
    url = env.get("WMH_OWNED_RECORDING_CACHE_DATABASE_URL", "")
    parsed = urlsplit(url)
    database = parsed.path.removeprefix("/")
    owned = (
        parsed.scheme in {"postgres", "postgresql"}
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        and database.startswith("victoria_wmh_recording_")
        and database != fixture_database
        and manifest.get("checkout") == str(REPO_ROOT.resolve())
        and manifest.get("owner_workspace") == workspace
        and manifest.get("database") == database
        and manifest.get("host") == parsed.hostname
        and manifest.get("url_sha256") == hashlib.sha256(url.encode()).hexdigest()
        and manifest.get("retained_across_iterations") is True
    )
    if not owned:
        raise ValueError("WMH recording cache must be a retained loopback owner separate from the fixture")
    env["FAST_MODE_CACHE_DATABASE_URL"] = url
    env.pop("FAST_MODE_CACHE_USE_LOCAL", None)
    env["FAST_MODE_CACHE_DISABLE_WRITE_THROUGH"] = "0"
    return True


def selected_tasks_need_shared_fast_cache(task_names: Sequence[str]) -> bool:
    """True when a selected task must read the shared July Fast Mode cache."""
    selected = set(task_names)
    return any(task.fast_cache == "on" and task.name in selected for task in all_tasks())


def _dotenv_fast_mode_cache_database_url() -> str:
    """Read the shared July cache URL the same way scripts/run.sh does.

    Prefer an explicit FAST_MODE_CACHE_DATABASE_URL, then fall back to the
    prod DATABASE_URL in back-end/.env. Isolated mass-agent smokes require
    that shared cache; requiring a separately named key silently failed
    every cloud VM that only has DATABASE_URL.
    """
    env_path = REPO_ROOT / "back-end" / ".env"
    if not env_path.is_file():
        return ""
    found: dict[str, str] = {}
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in {"FAST_MODE_CACHE_DATABASE_URL", "DATABASE_URL"}:
            continue
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        found[key] = value
    return found.get("FAST_MODE_CACHE_DATABASE_URL") or found.get("DATABASE_URL") or ""


from benchmarks.dashboard import DashboardServer, dashboard_enabled, maybe_launch_dashboard
from benchmarks.results import bounded_path_component
from benchmarks.seed_cache_path import canonical_base_dump_path, seed_dump_path

SERVICES_MANIFEST = REPO_ROOT / ".context" / "services.json"
SERVICE_LOG = REPO_ROOT / ".context" / "local-benchmark-services.log"
TUNNEL_LOG = REPO_ROOT / ".context" / "local-benchmark-ngrok.log"
BENCHMARK_CONTEXT_ROOT = REPO_ROOT / ".context" / "benchmarks"
# Port reservations must coordinate sibling Conductor worktrees on this host.
# Persistent empty lock files are harmless; flock ownership ends with the process.
PORT_RANGE_LOCK_ROOT = Path(tempfile.gettempdir()) / f"rose-benchmark-port-locks-{os.getuid()}"
PORT_RANGE_OFFSETS = (0, 1, 2, 3, 4, 5, 6, 9)
# Keep automatically selected listener ports below the default Linux ephemeral
# client range (32768-60999). A probed-but-not-yet-bound health port in that
# range can otherwise be claimed by an outbound connection before the worker
# starts, despite our cross-process file locks.
FALLBACK_PORT_BASE_START = 22000
FALLBACK_PORT_BASE_END = 30000
CHECKPOINT_ROOT = REPO_ROOT / ".context" / "benchmark-checkpoints"
RUNS_DIR = AGENTS_DIR / "benchmarks" / "runs"
# A fresh isolated stack syncs the production-backed benchmark fixture before
# run.sh can publish services.json. That fixture currently includes 10k messages
# and 20k+ browser cookies, so a healthy first start can exceed three minutes.
SERVICE_START_TIMEOUT_SECONDS = 600
# An explicitly opted-in cold seed can spend the entire warm-start budget
# copying browser state before run.sh starts the public tunnel and publishes its
# manifest. Keep the normal bound for cached starts, but give that one-time
# bootstrap enough room to finish cleanly.
COLD_SEED_SERVICE_START_TIMEOUT_SECONDS = 1200
# A simulate stack with NO prebuilt World Model must list the R2 trace archive
# (~80k bundles) and export/build the capped corpus before run.sh publishes its
# manifest. That first build is a one-time cost per machine; give it an honest
# budget instead of killing a healthy build at the warm-start bound.
WMH_FIRST_BUILD_SERVICE_START_TIMEOUT_SECONDS = 1800
DOCKER_CLEANUP_TIMEOUT_SECONDS = 5
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
NEW_USER_PAYMENT_JOURNEY_TASK_NAME = "agent-payment-new-user-journey"
# Tasks whose user starts with no subscription and pays through Stripe test Checkout.
NEW_USER_PAYMENT_TASK_NAMES = {
    NEW_USER_PAYMENT_JOURNEY_TASK_NAME,
    "browser-auth-signup-purchase-no-subscription",
}
# Hosted Rose Shop purchases settle through the same sandbox AgentCard fixture
# as the test-payment portal, as the same seeded user.
ROSE_SHOP_PAYMENT_TASK_NAMES = {
    "browser-auth-guest-purchase",
    "browser-auth-member-discount-purchase",
    "browser-auth-member-discount-signup-fails-purchase",
    "browser-auth-paid-membership-purchase",
    "browser-auth-signup-purchase",
    "browser-auth-session-expires-at-checkout",
}
AGENT_PAYMENT_TASK_NAMES = {
    AGENT_PAYMENT_TEST_SHOP_TASK_NAME,
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
    "agent-payment-setup-resume",
} | ROSE_SHOP_PAYMENT_TASK_NAMES
BENCHMARK_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
TEST_PAYMENT_FRONTEND_TASK_NAMES = AGENT_PAYMENT_TASK_NAMES | {
    NEW_USER_PAYMENT_JOURNEY_TASK_NAME,
    "gate-subscription-card-mint",
    "gate-subscription-webhook-resume",
    "gate-kyc-card-mint",
    # Must include admin-bypass so needs_frontend_tunnel still publishes
    # BENCHMARK_FRONTEND_URL for /test_payment. Bundling itself now follows
    # needs_public_tunnel (any Kernel-reachable FE), not this allowlist alone.
    "gate-subscription-card-mint-admin-bypass",
}
# Sandbox lifecycle benches run as the default admin account so credit checks
# stay unlimited. BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH (set below, honored
# only in benchmark/isolated mode) forces chargeAndIssueCard so stripeHold
# stays reachable. Must equal run_benchmark.AGENT_PAYMENT_LIFECYCLE_USER_ID and
# BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID in purchases/config.ts.
AGENT_PAYMENT_LIFECYCLE_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
# Same identity, reached through the harness-wide env override so `run_benchmark` and this launcher
# cannot drift: `configure_task_environment` publishes it and `seed_payment_fixture` reads it back.
# Must equal run_benchmark.AGENT_PAYMENT_BENCHMARK_USER_ID.
AGENT_PAYMENT_BENCHMARK_USER_ID = AGENT_PAYMENT_LIFECYCLE_USER_ID
AGENT_PAYMENT_BENCHMARK_USER_ID_ENV = "BENCHMARK_AGENT_PAYMENT_USER_ID"
# Counterpart to the above: the ADMIN funding path keeps its own benchmark, run as a synthetic
# admin. Must equal run_benchmark.ADMIN_SUBSCRIPTION_BYPASS_USER_ID.
ADMIN_BYPASS_TASK_NAME = "gate-subscription-card-mint-admin-bypass"
ADMIN_BYPASS_USER_ID = "00000000-0000-4000-8000-000000000105"
_PORT_RANGE_RESERVATIONS: dict[int, tuple[TextIO, ...]] = {}
_RESERVED_PORTS: set[int] = set()


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
    use_system_postgres: bool = False


def _write_owner_record(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _process_identity_tools() -> dict:
    return runpy.run_path(str(REPO_ROOT / "scripts/process-identity.py"))


def _signal_owned_process(process: subprocess.Popen, native_identity: str, signum: int) -> None:
    if process.poll() is not None:
        return
    tools = _process_identity_tools()
    code = tools["main"](
        [
            "process-identity",
            "--expect",
            native_identity,
            "--signal",
            signal.Signals(signum).name,
            str(process.pid),
        ]
    )
    if code != 0 and process.poll() is None:
        raise RuntimeError("owned process identity could not be verified before signalling")


def _owned_shutdown_timeout() -> int:
    """Use the stack owner's existing activity/recording deadline, not another grace."""
    result = subprocess.run(
        [_benchmark_python(), str(AGENTS_DIR / "scripts/local_worker_supervisor.py"), "--shutdown-timeout"],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )
    seconds = int(result.stdout.strip())
    if seconds <= 0:
        raise RuntimeError("invalid owned worker shutdown deadline")
    return seconds


def _record_stack_cleanup_owner(stack: ServiceStack, process: subprocess.Popen, token: str) -> None:
    native_identity = _process_identity_tools()["current_identity"](process.pid)
    birth = subprocess.run(
        ["ps", "-p", str(process.pid), "-o", "lstart="],
        capture_output=True,
        text=True,
        timeout=3,
        check=True,
    ).stdout.strip()
    if not birth:
        raise RuntimeError("owned stack birth could not be captured")
    _write_owner_record(
        stack.context_dir / "local-stack-owner.json",
        {
            "version": 1,
            "run_id": stack.run_id,
            "token": token,
            "pid": process.pid,
            "native_identity": native_identity,
            "birth": birth,
        },
    )


def _read_cleanup_receipt(
    path: Path, token: str, *, allowed_versions: tuple[str, ...] = ("1",)
) -> dict[str, str]:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"cleanup receipt is missing or unsafe: {path}")
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in values:
            raise RuntimeError(f"cleanup receipt is malformed: {path}")
        values[key] = value
    if values.get("version") not in allowed_versions or values.get("token") != token or values.get("state") != "clean":
        raise RuntimeError(f"cleanup remains unverified; retaining its recovery authority: {path}")
    return values


class LocalBenchmarkOwner:
    """Own child cancellation before allowing the dependent local stack to stop."""

    def __init__(self, stack: ServiceStack):
        self.stack = stack
        self.process: subprocess.Popen | None = None
        self.native_identity = ""
        self.signum: int | None = None
        self.signalled = False
        self.starting = False
        self.started = False
        self.verified = True
        self.token = ""
        self.receipt = stack.context_dir / "benchmark-cleanup.status"
        self.deadline: float | None = None
        self.shutdown_timeout = _owned_shutdown_timeout()

    def environment(self, env: dict[str, str]) -> dict[str, str]:
        if self.signum is not None:
            raise SystemExit(128 + self.signum)
        self.token = uuid.uuid4().hex
        self.receipt = self.stack.context_dir / f"benchmark-cleanup-{self.token}.status"
        self.stack.context_dir.mkdir(parents=True, exist_ok=True)
        return {
            **env,
            "BENCHMARK_CONTEXT_DIR": str(self.stack.context_dir.resolve()),
            "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(self.receipt.resolve()),
            "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": self.token,
            "BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT": "true",
            **(
                {"BENCHMARK_CLOUD_BATCH_CLEANUP": "true", "BENCHMARK_ISOLATED_RUN": "true"}
                if self.stack.isolated
                else {}
            ),
        }

    def bind(self, process: subprocess.Popen) -> None:
        self.native_identity = ""
        self.process = process
        self.started = True
        self.verified = False
        self.signalled = False
        self.native_identity = _process_identity_tools()["current_identity"](process.pid)
        self.record("running")
        if self.signum is not None:
            self.interrupt(self.signum)

    def record(self, state: str) -> None:
        _write_owner_record(
            self.stack.context_dir / "local-benchmark-owner.json",
            {
                "version": 1,
                "run_id": self.stack.run_id,
                "state": state,
                "pid": self.process.pid if self.process else None,
                "native_identity": self.native_identity,
                "token": self.token,
                "receipt": str(self.receipt),
                "signal": self.signum,
            },
        )

    def interrupt(self, signum: int) -> None:
        if self.signum is None:
            self.signum = signum
            self.deadline = time.monotonic() + self.shutdown_timeout
        if self.process is not None and self.native_identity and not self.signalled:
            self.signalled = True
            _signal_owned_process(self.process, self.native_identity, signal.SIGINT)

    def drain(self, *, echo: bool = True) -> tuple[int, str]:
        assert self.process is not None and self.process.stdout is not None
        output: list[str] = []
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while True:
                if self.deadline is not None and time.monotonic() >= self.deadline:
                    self.record("failed_retained")
                    raise RuntimeError("benchmark cleanup deadline expired; owned stack retained")
                events = selector.select(0.1)
                if not events:
                    if self.process.poll() is not None:
                        break
                    continue
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                text = decoder.decode(chunk)
                output.append(text)
                if echo:
                    print(text, end="", flush=True)
        tail = decoder.decode(b"", final=True)
        output.append(tail)
        if echo and tail:
            print(tail, end="", flush=True)
        # EOF can precede process exit. Keep observing a deadline armed by a
        # later signal instead of entering an unbounded wait at that boundary.
        while self.process.poll() is None:
            if self.deadline is not None and time.monotonic() >= self.deadline:
                self.record("failed_retained")
                raise RuntimeError("benchmark cleanup deadline expired; owned stack retained")
            time.sleep(0.1)
        code = self.process.wait()
        if self.stack.isolated or self.signum is not None:
            _read_cleanup_receipt(self.receipt, self.token)
        self.verified = True
        self.record("cleanup_verified")
        self.process.stdout.close()
        self.process = None
        return code, "".join(output)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-")
    return slug or "bench"


def isolated_workspace_name(base_name: str, run_id: str, max_len: int = 60) -> str:
    """Build a CONDUCTOR_WORKSPACE_NAME that stays unique under the length cap.

    Naive ``slugify(f"{base}-{run_id}")[:60]`` truncates the uniqueness suffix, so
    two isolated stacks started in the same second (e.g. /deploy smoke + AgentCard)
    can collapse onto one Temporal task queue and steal each other's workflows.
    Keep the ``bench-<run_id>`` suffix intact and truncate only the human prefix.
    """
    suffix = slugify(f"bench-{run_id}")
    if len(suffix) >= max_len:
        digest = hashlib.sha1(run_id.encode("utf-8")).hexdigest()[:12]
        suffix = f"b{digest}"
    prefix_budget = max_len - len(suffix) - 1
    prefix = slugify(base_name)[: max(1, prefix_budget)].strip("-") or "ws"
    return f"{prefix}-{suffix}"


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


def _linux_ephemeral_port_range() -> tuple[int, int] | None:
    """Return the kernel-managed outbound port range when Linux exposes it."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        lower_text, upper_text = Path("/proc/sys/net/ipv4/ip_local_port_range").read_text().split()
        lower, upper = int(lower_text), int(upper_text)
    except (OSError, ValueError):
        return None
    if not (0 < lower <= upper < 65536):
        return None
    return lower, upper


def _overlaps_port_range(base: int, occupied: tuple[int, int]) -> bool:
    lower, upper = occupied
    return base <= upper and base + max(PORT_RANGE_OFFSETS) >= lower


def _reserve_port_range(base: int) -> bool:
    """Hold every occupied port across processes until the stack is ready."""
    ports = tuple(base + offset for offset in PORT_RANGE_OFFSETS)
    if base in _PORT_RANGE_RESERVATIONS or _RESERVED_PORTS.intersection(ports):
        return False
    PORT_RANGE_LOCK_ROOT.mkdir(parents=True, exist_ok=True)
    handles: list[TextIO] = []
    for port in ports:
        handle = open(PORT_RANGE_LOCK_ROOT / f"{port}.lock", "a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            for acquired in reversed(handles):
                fcntl.flock(acquired.fileno(), fcntl.LOCK_UN)
                acquired.close()
            return False
        except BaseException:
            handle.close()
            for acquired in reversed(handles):
                with contextlib.suppress(OSError):
                    fcntl.flock(acquired.fileno(), fcntl.LOCK_UN)
                acquired.close()
            raise
        handles.append(handle)
    _PORT_RANGE_RESERVATIONS[base] = tuple(handles)
    _RESERVED_PORTS.update(ports)
    return True


def _release_port_range(base: int | None) -> None:
    if base is None:
        return
    handles = _PORT_RANGE_RESERVATIONS.pop(base, None)
    if handles is None:
        return
    _RESERVED_PORTS.difference_update(base + offset for offset in PORT_RANGE_OFFSETS)
    for handle in reversed(handles):
        with contextlib.suppress(OSError):
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def workspace_preferred_base(conductor_port: str | None) -> int | None:
    """Prefer the workspace-adjacent range unless the kernel can hand it out.

    An explicit --base-port is the caller's own range. This derived preference
    is not, so it obeys the same ephemeral-range exclusion as automatic ranges.
    """
    if not conductor_port or not conductor_port.isdigit():
        return None
    base = int(conductor_port) + 200
    ephemeral_range = _linux_ephemeral_port_range()
    if ephemeral_range is not None and _overlaps_port_range(base, ephemeral_range):
        return None
    return base


def allocate_port_range(preferred_base: int | None = None) -> int:
    docker_ports = _docker_ports_snapshot()
    candidates: list[int] = []
    if preferred_base:
        candidates.append(preferred_base)
    seed = int(hashlib.sha1(f"{time.time()}:{os.getpid()}".encode()).hexdigest()[:8], 16)
    # Main moved the fallback window into FALLBACK_PORT_BASE_* constants; keep
    # those, and keep this branch's exclusion of the kernel's ephemeral range.
    # A connect-based availability probe cannot reserve a port against the
    # kernel's next outbound connection. On Linux, choosing inside
    # ip_local_port_range therefore leaves a check-to-bind race: an unrelated
    # HTTPS request can claim the worker metrics port after this function
    # returns and make the primary Temporal worker fail readiness. File locks
    # still coordinate Rose launchers; excluding the kernel-managed range
    # coordinates with ephemeral sockets as well. Explicit --base-port values
    # remain first so callers that own their range keep the existing contract.
    candidate_count = (FALLBACK_PORT_BASE_END - FALLBACK_PORT_BASE_START) // 20
    start = FALLBACK_PORT_BASE_START + (seed % candidate_count) * 20
    automatic_candidates = [
        *range(start, FALLBACK_PORT_BASE_END, 20),
        *range(FALLBACK_PORT_BASE_START, start, 20),
    ]
    ephemeral_range = _linux_ephemeral_port_range()
    if ephemeral_range is not None:
        automatic_candidates = [
            base for base in automatic_candidates if not _overlaps_port_range(base, ephemeral_range)
        ]
    candidates.extend(automatic_candidates)
    for base in candidates:
        if base < 1024 or base + max(PORT_RANGE_OFFSETS) >= 65535:
            continue
        if not _reserve_port_range(base):
            continue
        if all(_port_is_available(base + offset, docker_ports) for offset in PORT_RANGE_OFFSETS):
            return base
        _release_port_range(base)
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
    workspace_name = isolated_workspace_name(base_name, run_id)
    preferred_base = args.base_port
    if preferred_base is None:
        preferred_base = workspace_preferred_base(os.environ.get("CONDUCTOR_PORT"))
    return ServiceStack(
        run_id=run_id,
        context_dir=context_dir,
        manifest_path=context_dir / "services.json",
        service_log=context_dir / "services.log",
        isolated=True,
        workspace_name=workspace_name,
        base_port=allocate_port_range(preferred_base),
        use_system_postgres=(
            sys.platform.startswith("linux")
            or os.environ.get("ROSE_USE_SYSTEM_PG", "").lower() in {"1", "true", "yes"}
        ),
    )


def known_task_names(*, include_polar: bool = False) -> list[str]:
    """First-party ready catalog names by default; polar-bench is opt-in."""
    tasks = all_tasks()
    if not include_polar:
        tasks = [task for task in tasks if not is_polar_bench_task(task)]
    return [task.name for task in tasks]


def validate_task_names(names: Sequence[str]) -> list[str]:
    """Validate task names and preserve intentional repeats.

    Repeating a task name N times runs it N times (pass@k). Matching
    ``run_benchmark.py --task`` / cloudbench-run behavior. Callers that want a
    unique set must dedupe themselves.
    """
    # Allow explicit polar-bench names even though --full / --suite all omit them.
    known = set(known_task_names(include_polar=True))
    unknown = sorted(set(names) - known)
    if unknown:
        raise ValueError(f"Unknown benchmark task(s): {', '.join(unknown)}")
    return list(names)


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
    wmh_initial_state_file: str | None = None,
    timeout_seconds: int | None = None,
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
    if wmh_initial_state_file:
        args.extend(["--wmh-initial-state-file", wmh_initial_state_file])
    if timeout_seconds is not None:
        args.extend(["--timeout-seconds", str(timeout_seconds)])
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


def services_manifest_saved_browser_auth_disabled(manifest: dict) -> bool:
    env = manifest.get("env") if isinstance(manifest, dict) else None
    if not isinstance(env, dict):
        return False
    return env.get("benchmark_disable_saved_browser_auth") is True


def services_manifest_anon_enabled(manifest: dict) -> bool:
    env = manifest.get("env") if isinstance(manifest, dict) else None
    if not isinstance(env, dict):
        return False
    return env.get("benchmark_anon_steel_profile") is True and env.get("benchmark_disable_saved_browser_auth") is True


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
            str(tsx),
            str(entry),
            "--base-url",
            f"http://localhost:{port}",
            "--expected-user-id",
            IMESSAGE_RELAY_USER_ID,
            "--expected-phone",
            IMESSAGE_RELAY_EXPECTED_PHONE,
            "--expected-message",
            IMESSAGE_RELAY_EXPECTED_MESSAGE,
            "--marker-file",
            str(marker),
            "--timeout-seconds",
            str(run_timeout_seconds),
            "--auto-login-phone",
            IMESSAGE_RELAY_EXPECTED_PHONE,
            "--auto-login-otp",
            IMESSAGE_RELAY_AUTOLOGIN_OTP,
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
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
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
    # Always issue the docker teardown argv (tests assert the calls). Catch
    # FileNotFoundError so hosts without a docker binary still tear down cleanly.
    if isinstance(container, str) and container:
        try:
            subprocess.run(
                ["docker", "rm", "-f", container],
                cwd=REPO_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=DOCKER_CLEANUP_TIMEOUT_SECONDS,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    volume = database.get("volume")
    if not isinstance(volume, str) or not volume:
        if isinstance(container, str) and container.startswith("victoria-db-"):
            volume = f"victoria-pgdata-{container[len('victoria-db-') :]}"
    if isinstance(volume, str) and volume:
        try:
            subprocess.run(
                ["docker", "volume", "rm", volume],
                cwd=REPO_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=DOCKER_CLEANUP_TIMEOUT_SECONDS,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass


def _stop_owned_db_from_stack_identity(stack: ServiceStack) -> None:
    """Remove the exact isolated DB when startup failed before its manifest."""
    if not stack.isolated or not stack.workspace_name or stack.use_system_postgres:
        return
    container = f"victoria-db-{stack.workspace_name}"
    volume = f"victoria-pgdata-{stack.workspace_name}"
    try:
        subprocess.run(
            ["docker", "rm", "-f", container],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=DOCKER_CLEANUP_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    try:
        subprocess.run(
            ["docker", "volume", "rm", volume],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=DOCKER_CLEANUP_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


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


# Runner subprocesses (run_benchmark.py and other streamed commands) this
# controller launched. A signalled controller stops them before tearing the
# stack down, so a run_benchmark.py (and its flyctl log stream) can never be
# orphaned to launchd polling services that no longer exist.
_ACTIVE_CHILD_PROCESSES: set[subprocess.Popen] = set()


def stop_active_child_processes(grace_seconds: float = 10.0) -> None:
    """TERM every tracked child and its descendants, then KILL survivors."""
    for process in list(_ACTIVE_CHILD_PROCESSES):
        if process.poll() is None:
            tree = _descendant_pids(process.pid)
            for pid in tree:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + grace_seconds
            while process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
            for pid in tree:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)
        _ACTIVE_CHILD_PROCESSES.discard(process)


def _port_listener_pids(port: int) -> set[int]:
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=3, check=False
        ).stdout
    except Exception:
        return set()
    pids: set[int] = set()
    for line in out.split():
        with contextlib.suppress(ValueError):
            pids.add(int(line))
    return pids


def _environment_entry_pids(entry: str) -> set[int]:
    """PIDs whose launch environment contains exactly ``entry`` (``NAME=value``)."""
    pids: set[int] = set()
    proc_root = Path("/proc")
    if proc_root.is_dir():
        wanted = entry.encode()
        for proc_dir in proc_root.iterdir():
            if not proc_dir.name.isdigit():
                continue
            with contextlib.suppress(OSError):
                if wanted in (proc_dir / "environ").read_bytes().split(b"\0"):
                    pids.add(int(proc_dir.name))
        return pids
    # macOS has no /proc; `ps -E` appends each process's launch environment.
    with contextlib.suppress(Exception):
        out = subprocess.run(
            ["ps", "-axwwE", "-o", "pid=,command="], capture_output=True, text=True, timeout=5, check=False
        ).stdout
        for line in out.splitlines():
            pid_text, _, command = line.strip().partition(" ")
            if entry in command.split():
                with contextlib.suppress(ValueError):
                    pids.add(int(pid_text))
    return pids


def _ancestor_pids() -> set[int]:
    """This process and every ancestor: the controller that is tearing the run down."""
    pids: set[int] = set()
    pid = os.getpid()
    while pid > 1 and pid not in pids:
        pids.add(pid)
        try:
            pid = int(
                subprocess.run(
                    ["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=2, check=False
                ).stdout.strip()
            )
        except (ValueError, OSError, subprocess.SubprocessError):
            break
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

    Use the manifest's recorded services and their descendants, listeners on
    its service ports for reparented backend/vite processes, and an exact
    ``BENCHMARK_RUN_ID=<run_id>`` launch-environment entry (the only signal left
    for a reparented worker that binds no port). A command merely mentioning the
    run ID may be an observer or the caller waiting for our exit; it is never
    evidence that the process belongs to this stack. Gate candidates on
    cwd-under-this-worktree so a sibling worktree's stack is never touched, and
    never signal the controller doing the teardown.
    """
    if not stack.isolated or not stack.run_id or stack.run_id == "existing":
        return

    targets: set[int] = set()

    # Manifest PIDs and their process trees, plus service-port listeners.
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

    # Exact run-scoped launch environment (reparented, portless workers).
    targets |= _environment_entry_pids(f"BENCHMARK_RUN_ID={stack.run_id}")

    targets -= _ancestor_pids()
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
    return bool(TEST_PAYMENT_FRONTEND_TASK_NAMES & set(tasks)) and not os.environ.get("BENCHMARK_FRONTEND_URL")


def sms_web_search_fixture_path(stack: "ServiceStack") -> str:
    """The single absolute path the backend reads and run_benchmark.py writes.

    Defined once because the two sides are a contract: if they ever disagree the
    fixture silently no-ops and the SMS benchmarks score live search while
    reporting green.
    """
    return str((stack.context_dir / "sms-web-search-fixture.json").resolve())


def needs_public_tunnel(tasks: Sequence[str]) -> bool:
    """True when some selected task actually needs a publicly reachable frontend.

    run.sh opens a trycloudflare quick tunnel on every benchmark stack. Real
    browser agents need it — they drive a hosted page and must reach it from the
    provider's network — but a bench that never opens a browser does not, and
    trycloudflare rate-limits per IP: back-to-back local runs start getting 429s,
    run.sh exits 1, and a task that never wanted a tunnel is recorded as failed.
    Only pay that dependency when a task's own contract asks for it. A phone
    hold-line task needs it too: wait_for_human parks the call on the backend,
    so Twilio must reach the hold webhooks and media stream from outside.
    """
    selected = set(tasks)
    if os.environ.get("BENCHMARK_PUBLIC_TUNNEL") == "1":
        return True
    if selected & TEST_PAYMENT_FRONTEND_TASK_NAMES:
        return True
    for task in all_tasks():
        if task.name not in selected:
            continue
        if task.requires_browser_agent:
            return True
        if "{frontend_url}" in task.prompt:
            return True
        if isinstance(task.phone_persona, dict) and task.phone_persona.get("hold_line"):
            return True
    return False


def apply_public_tunnel_env(env: dict[str, str], tasks: Sequence[str]) -> bool:
    """Make BENCHMARK_SKIP_PUBLIC_TUNNEL match selected tasks; return skip flag.

    Task selection is authoritative. A parent /deploy shell may export
    BENCHMARK_SKIP_PUBLIC_TUNNEL=1 for the Step-5 semantic stack (or to avoid
    ngrok contention across Group 4 lanes). That ambient skip must not leak
    into an isolated browser/payment stack — Kernel cannot reach localhost, so
    {frontend_url} would be ERR_CONNECTION_REFUSED for the entire timeout.
    """
    skip_public_tunnel = bool(tasks) and not needs_public_tunnel(tasks)
    if skip_public_tunnel:
        env["BENCHMARK_SKIP_PUBLIC_TUNNEL"] = "1"
        env["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = "0"
    else:
        env.pop("BENCHMARK_SKIP_PUBLIC_TUNNEL", None)
    return skip_public_tunnel


def needs_imessage_relay(tasks: Sequence[str]) -> bool:
    return "message-person" in set(tasks) and sys.platform == "darwin"


def needs_payment_fixture(tasks: Sequence[str]) -> bool:
    return bool(AGENT_PAYMENT_TASK_NAMES & set(tasks))


def _dotenv_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def validate_agentcard_org_credentials(
    tasks: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    env_path: Path | None = None,
) -> None:
    if not ((AGENT_PAYMENT_TASK_NAMES | NEW_USER_PAYMENT_TASK_NAMES) & set(tasks)):
        return
    configured = _dotenv_values(env_path or REPO_ROOT / "back-end" / ".env")
    configured.update(os.environ if env is None else env)
    client_id = configured.get("AGENTCARD_ORG_OAUTH_CLIENT_ID", "").strip()
    client_secret = configured.get("AGENTCARD_ORG_OAUTH_CLIENT_SECRET", "").strip()
    direct = configured.get("AGENTCARD_ORG_MCP_ACCESS_TOKEN", "").strip()
    if direct.startswith("sk_"):
        direct = ""
    if direct or (client_id and client_secret):
        return
    raise RuntimeError(
        "AgentCard Organization MCP credentials are missing. API keys (sk_*) are retired; "
        "run `agentcard companies credentials create`, then set "
        "AGENTCARD_ORG_OAUTH_CLIENT_ID and AGENTCARD_ORG_OAUTH_CLIENT_SECRET."
    )


def validate_benchmark_archive_environment() -> None:
    """Reject a capture-disabled environment before creating benchmark resources."""
    # Match the backend's JavaScript String.trim(): Python's default strip()
    # omits BOM and additionally removes control characters JavaScript retains.
    trim_characters = (
        "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
        "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    )
    configured = os.environ.get("TRACE_ARCHIVE_ENABLED", "").strip(trim_characters).lower()
    if configured in {"0", "false", "no", "off", "disabled"}:
        raise RuntimeError(
            "Local benchmarks require trace capture; TRACE_ARCHIVE_ENABLED is disabled. "
            "Set TRACE_ARCHIVE_ENABLED=1 before running benchmarks."
        )


@functools.cache
def _cloudbench_catalog():
    """Load the stdlib-only catalog helper that owns the per-task worker env."""
    spec = importlib.util.spec_from_file_location(
        "cloudbench_catalog", REPO_ROOT / "scripts" / "cloudbench_catalog.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load scripts/cloudbench_catalog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure_task_environment(tasks: Sequence[str], *, isolated: bool = False) -> None:
    # The local runner owns both the isolated stack and the later benchmark
    # subprocesses. Keep their isolation view aligned so credential refreshes
    # can safely enable synthetic-user pooling only for the per-run database.
    if isolated:
        os.environ["BENCHMARK_ISOLATED_RUN"] = "true"
    else:
        os.environ.pop("BENCHMARK_ISOLATED_RUN", None)
    # Any publicly tunneled frontend must be a production bundle. Vite DEV's
    # unbundled module graph cannot mount reliably through Kernel+ngrok; tying
    # bundling to a hand-maintained allowlist caused blank-SPA budget burns when
    # a new tunnel task was omitted (admin-bypass). needs_public_tunnel already
    # decides who pays for a tunnel — the bundle follows that same gate. Skip
    # when the run points at an external BENCHMARK_FRONTEND_URL (nothing local
    # to build).
    if needs_public_tunnel(tasks) and not os.environ.get("BENCHMARK_FRONTEND_URL"):
        os.environ["BENCHMARK_BUNDLED_FRONTEND"] = "true"
    selected = set(tasks)
    if (AGENT_PAYMENT_TASK_NAMES | NEW_USER_PAYMENT_TASK_NAMES) & selected:
        # Keep the consolidated isolated lane behaviorally equivalent to the
        # former per-task lifecycle launcher. Payment tasks share one fixture,
        # must execute uncached, and need the allowlisted hosted callback even
        # though the checkout itself runs against the local bundled frontend.
        os.environ["ALLOW_TEMPORAL_CLEANUP"] = "true"
        os.environ["BENCHMARK_FAST_MODE_CACHE"] = "false"
        os.environ["SEED_ALLOW_MISSING_GPT_CODE"] = "1"
        # The lifecycle agents run as the admin account with the forced customer
        # mint path. Make the dev-owned compute
        # token pool-eligible only after stack selection proves this run owns an isolated database;
        # never let shared-stack/use-existing modes mutate credential-pool eligibility.
        if isolated:
            os.environ["SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS"] = "1"
        else:
            os.environ.pop("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", None)
        os.environ.setdefault(
            AGENT_PAYMENT_BENCHMARK_USER_ID_ENV,
            AGENT_PAYMENT_BENCHMARK_USER_ID,
        )
        os.environ["BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH"] = "1"
        if not os.environ.get("AGENTCARD_ONBOARDING_RETURN_URL"):
            os.environ["AGENTCARD_ONBOARDING_RETURN_URL"] = (
                "https://navi-j9a9.onrender.com/api/agentcard/onboarding/callback"
            )
    if ADMIN_BYPASS_TASK_NAME in selected:
        # The admin-bypass gate benchmark runs as a SYNTHETIC admin so it can prove
        # issueAdminCompanyCard without touching a real admin's account. isAdminUser() only honors
        # extra ids from ADMIN_USER_IDS_EXTRA, which nothing else sets — so without this the task
        # ran as an ordinary user and silently exercised the charged path instead of the bypass.
        # Additive by construction: it grants admin ONLY to the synthetic id, never to a real one,
        # and only on this local isolated stack.
        configured = [entry.strip() for entry in os.environ.get("ADMIN_USER_IDS_EXTRA", "").split(",") if entry.strip()]
        if ADMIN_BYPASS_USER_ID not in configured:
            configured.append(ADMIN_BYPASS_USER_ID)
        os.environ["ADMIN_USER_IDS_EXTRA"] = ",".join(configured)
    # Agent-behavior flags come from the one policy cloud guests also export
    # (scripts/cloudbench-run.sh resolve_task_gate), so a local pass and a cloud
    # run of the same task get the same worker environment.
    worker_env = _cloudbench_catalog().task_worker_environment(
        [vars(task) for task in all_tasks() if task.name in selected], os.environ
    )
    for key, value in worker_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def seed_payment_fixture(manifest: dict) -> None:
    database_url = manifest_database_url(manifest)
    env = {
        **os.environ,
        "DATABASE_URL": database_url,
        "DIRECT_URL": database_url,
    }
    # `configure_task_environment` publishes the payment identity on
    # AGENT_PAYMENT_BENCHMARK_USER_ID_ENV. Prefer that, else the dedicated
    # synthetic lifecycle id — never BENCHMARK_USER_ID / the admin operator,
    # which would seed the no-charge admin path instead of the customer fixture.
    payment_user_id = os.environ.get(AGENT_PAYMENT_BENCHMARK_USER_ID_ENV, "").strip() or AGENT_PAYMENT_LIFECYCLE_USER_ID
    print(f"Seeding Stripe test billing fixture for the payment-lifecycle user {payment_user_id}")
    subprocess.run(
        [
            "npx",
            "tsx",
            "scripts/setup-benchmark-payment.ts",
            "--user-id",
            payment_user_id,
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


def print_scorecard_instruction(run_dir: Path) -> None:
    """Print the mandatory CLI scorecard command for this run's report card directory."""
    renderer = REPO_ROOT / "scripts" / "cloudbench-scorecard.py"
    if not renderer.is_file():
        return
    try:
        runpy.run_path(str(renderer))["print_instruction"](run_dir)
    except Exception:  # a reporting aid never blocks the benchmark
        return


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


def local_seed_dump_path(
    schema_path: Path | None = None,
    cache_root: Path | None = None,
    cache_day: str | None = None,
) -> Path:
    """Resolve the canonical base artifact used by an isolated benchmark.

    An explicit day retains the legacy synchronized-prod materialization path
    used by setup tooling. Normal benchmark launches use the immutable base
    revision shared with cloud runners.
    """
    resolved_schema = schema_path or REPO_ROOT / "back-end" / "prisma" / "schema.prisma"
    resolved_root = cache_root or BENCHMARK_CONTEXT_ROOT / "seed-cache"
    if cache_day is not None:
        return seed_dump_path(resolved_schema, resolved_root, cache_day)
    return canonical_base_dump_path(resolved_schema, resolved_root)


def _seed_dump_pair_is_usable(seed_dump: Path, schema_hash: str) -> bool:
    sidecar = Path(f"{seed_dump}.schemahash")
    try:
        return seed_dump.stat().st_size > 0 and sidecar.read_text().strip() == schema_hash
    except OSError:
        return False


def _pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@contextlib.contextmanager
def _benchmark_seed_publish_lock(
    seed_dump: Path,
    *,
    attempts: int = 600,
    retry_seconds: float = 0.1,
):
    """Interop with scripts/lib/seed-cache.sh's per-pair symlink lock."""
    lock_path = Path(f"{seed_dump}.publish.lock")
    owner = str(os.getpid())
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    acquired = False
    for attempt in range(attempts):
        try:
            lock_path.symlink_to(owner)
            acquired = True
            break
        except FileExistsError:
            try:
                current_owner = os.readlink(lock_path)
            except OSError:
                current_owner = ""
            if current_owner.isdigit() and not _pid_is_alive(int(current_owner)):
                try:
                    if os.readlink(lock_path) == current_owner:
                        lock_path.unlink()
                        continue
                except OSError:
                    pass
            if attempt + 1 < attempts:
                time.sleep(retry_seconds)
    if not acquired:
        raise TimeoutError(f"timed out acquiring benchmark seed lock: {seed_dump}")
    try:
        yield
    finally:
        try:
            if os.readlink(lock_path) == owner:
                lock_path.unlink()
        except OSError:
            pass


def _promote_previous_utc_day_seed_dump(
    seed_dump: Path,
    *,
    schema_hash: str,
    now: datetime,
) -> bool:
    """Promote yesterday's pair while the caller holds today's publish lock."""
    current_time = now
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    current_time = current_time.astimezone(timezone.utc)
    if current_time.hour >= 2:
        return False

    match = re.fullmatch(r"([0-9a-f]{40})-(\d{8})\.dump", seed_dump.name)
    if match is None or match.group(1) != schema_hash or match.group(2) != current_time.strftime("%Y%m%d"):
        return False
    previous_day = (current_time - timedelta(days=1)).strftime("%Y%m%d")
    previous_dump = seed_dump.with_name(f"{schema_hash}-{previous_day}.dump")
    previous_sidecar = Path(f"{previous_dump}.schemahash")
    seed_dump.parent.mkdir(parents=True, exist_ok=True)
    temp_token = f"{os.getpid()}-{time.monotonic_ns()}"
    temp_dump = seed_dump.with_name(f".{seed_dump.name}.rollover-{temp_token}")
    temp_sidecar = Path(f"{temp_dump}.schemahash")
    try:
        with _benchmark_seed_publish_lock(previous_dump):
            try:
                previous_stat = previous_dump.stat()
                if previous_stat.st_size <= 0 or previous_sidecar.read_text().strip() != schema_hash:
                    return False
            except OSError:
                return False

            age_seconds = current_time.timestamp() - previous_stat.st_mtime
            if age_seconds < 0 or age_seconds > 26 * 60 * 60:
                return False

            try:
                os.link(previous_dump, temp_dump)
            except OSError:
                shutil.copy2(previous_dump, temp_dump)
            temp_sidecar.write_text(schema_hash)

        if not _seed_dump_pair_is_usable(temp_dump, schema_hash):
            return False
        os.replace(temp_dump, seed_dump)
        os.replace(temp_sidecar, Path(f"{seed_dump}.schemahash"))
        return _seed_dump_pair_is_usable(seed_dump, schema_hash)
    finally:
        temp_dump.unlink(missing_ok=True)
        temp_sidecar.unlink(missing_ok=True)


def _prime_local_seed_dump_from_shared_stack(seed_dump: Path) -> bool:
    """Snapshot a healthy shared stack when today's isolated seed cache is cold."""
    schema = REPO_ROOT / "back-end" / "prisma" / "schema.prisma"
    schema_hash = hashlib.sha1(schema.read_bytes()).hexdigest()
    sidecar = Path(f"{seed_dump}.schemahash")
    seed_dump.parent.mkdir(parents=True, exist_ok=True)

    def current_dump_exists() -> bool:
        return _seed_dump_pair_is_usable(seed_dump, schema_hash)

    if current_dump_exists():
        return True

    try:
        with _benchmark_seed_publish_lock(seed_dump):
            if current_dump_exists():
                return True
            if _promote_previous_utc_day_seed_dump(
                seed_dump,
                schema_hash=schema_hash,
                now=datetime.now(timezone.utc),
            ):
                print(f"Promoted recent previous-day benchmark seed dump: {seed_dump}")
                return current_dump_exists()
            manifest = json.loads(SERVICES_MANIFEST.read_text())
            if manifest.get("status") != "running":
                return False
            manifest_worktree = manifest.get("worktree")
            if manifest_worktree and Path(str(manifest_worktree)).resolve() != REPO_ROOT.resolve():
                return False
            ports = manifest.get("ports") if isinstance(manifest.get("ports"), dict) else {}
            backend_port = ports.get("backend")
            if not backend_port or not http_ok(f"http://localhost:{backend_port}/health"):
                return False
            database = manifest.get("database") if isinstance(manifest.get("database"), dict) else {}
            database_name = database.get("name")
            database_port = database.get("port") or ports.get("local_db")
            if not database_name or not database_port:
                return False
            command = [
                "bash",
                str(REPO_ROOT / "scripts" / "save-seed-dump.sh"),
                str(seed_dump),
                "localhost",
                str(database_port),
                "postgres",
                str(database_name),
            ]
            container = database.get("container")
            if not database.get("use_system_postgres") and isinstance(container, str) and container:
                command.append(container)
            subprocess.run(command, cwd=REPO_ROOT, check=True)
            sidecar_tmp = Path(f"{sidecar}.tmp-{os.getpid()}")
            sidecar_tmp.write_text(schema_hash)
            os.replace(sidecar_tmp, sidecar)
            print(f"Primed isolated benchmark seed dump from shared stack: {seed_dump}")
            return current_dump_exists()
    except Exception as exc:
        print(
            f"Warning: could not prime isolated benchmark seed dump from shared stack: {exc}",
            file=sys.stderr,
        )
        return False


def apply_isolated_postgres_default(
    env: dict[str, str], host_platform: str | None = None, *, use_system_postgres: bool = False
) -> None:
    """Prefer system Postgres on Linux while preserving explicit benchmark overrides."""
    if use_system_postgres:
        env["ROSE_USE_SYSTEM_PG"] = "true"
        return
    if (host_platform or sys.platform).startswith("linux"):
        env.setdefault("ROSE_USE_SYSTEM_PG", "true")


def benchmark_runner_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """Environment for the run_benchmark.py process a local run launches."""
    env = {**(os.environ if base is None else base), "PYTHONUNBUFFERED": "1"}
    # Disable fast-cache for local benchmark runs so trajectories are actually executed
    # rather than replayed from cache. This is required for payment-lifecycle tasks (real
    # side effects must not be cache-replayed) and also ensures the world model is exercised
    # during simulate runs. run_benchmark reads this and sets fast_mode_cache_enabled=false
    # on the created agent. (Sim-scoped caching can be re-enabled once the worker-simulate
    # path is validated.)
    env.setdefault("BENCHMARK_FAST_MODE_CACHE", "false")
    return env


def start_services(
    stack: ServiceStack,
    clean_first: bool = True,
    *,
    anon_steel_profile: bool = False,
    simulate: bool = False,
    world_model_name: str | None = None,
    tasks: Sequence[str] = (),
    on_process: Callable[[subprocess.Popen], None] | None = None,
    on_owner_ready: Callable[[], None] | None = None,
) -> tuple[subprocess.Popen, dict]:
    stack.context_dir.mkdir(parents=True, exist_ok=True)
    if clean_first and not stack.isolated:
        subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=True)
    env = {**os.environ, "DISABLE_GMAIL_SYNC": "1"}
    stack_cleanup_token = uuid.uuid4().hex
    if stack.isolated:
        env["RUN_STACK_CLEANUP_STATUS_FILE"] = str((stack.context_dir / "local-stack-cleanup.status").resolve())
        env["RUN_STACK_CLEANUP_TOKEN"] = stack_cleanup_token
    skip_public_tunnel = apply_public_tunnel_env(env, tasks)
    # Guest-checkout benches (e.g. Blue Bottle) need the kill-switch on the
    # backend/worker process, not just in run_benchmark's harness os.environ —
    # otherwise cookie_bundle auth is still injected and the semantic judge
    # correctly fails "guest checkout not demonstrated".
    from benchmarks.spawn_contract import tasks_require_disabled_saved_browser_auth

    if anon_steel_profile or tasks_require_disabled_saved_browser_auth(tasks):
        env["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = "true"
    if anon_steel_profile:
        env["BENCHMARK_ANON_STEEL_PROFILE"] = "true"
    if stack.isolated:
        assert stack.workspace_name
        assert stack.base_port
        env["BENCHMARK_ISOLATED_RUN"] = "true"
        env["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = "true"
        # Cloud/Linux VMs often cannot create Docker overlay mounts. macOS can
        # isolate each stack in Docker; forcing every stack onto the 100-client
        # host Postgres starves concurrent mass-agent benchmarks.
        apply_isolated_postgres_default(env, use_system_postgres=stack.use_system_postgres)
        env["BENCHMARK_CONTEXT_DIR"] = _context_dir_env_value(stack.context_dir)
        env["BENCHMARK_RUN_ID"] = stack.run_id
        env["CONDUCTOR_WORKSPACE_NAME"] = stack.workspace_name
        env["CONDUCTOR_PORT"] = str(stack.base_port)
        env["ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME"] = "1"
        # Default isolated stacks keep Fast Mode cache on the local Postgres so
        # Tokyo / other smokes cannot write through Andy into the shared pooler.
        # fast_cache:on tasks read the shared July cache. Ordinary agent
        # write-through stays disabled; recognized DEMO WHM completions are
        # allowed to populate their scoped keys via _WMHFastCacheContext.
        owned_recording = apply_owned_wmh_recording(
            env,
            isolated=stack.isolated,
            simulate=resolve_simulate_mode(simulate, tasks),
            tasks=[get_task_by_name(name) for name in tasks],
            workspace=stack.workspace_name,
            fixture_database=(
                f"victoria_bench_{re.sub(r'[^a-zA-Z0-9]', '_', stack.run_id)}"
                if stack.use_system_postgres
                else f"victoria_{stack.workspace_name}"
            ),
        )
        if owned_recording:
            pass
        elif selected_tasks_need_shared_fast_cache(tasks):
            shared_url = (
                env.get("FAST_MODE_CACHE_DATABASE_URL") or ""
            ).strip() or _dotenv_fast_mode_cache_database_url()
            if not shared_url:
                raise RuntimeError(
                    "fast_cache:on isolated benches require FAST_MODE_CACHE_DATABASE_URL "
                    "(shared July cache). Set it in back-end/.env."
                )
            env["FAST_MODE_CACHE_DATABASE_URL"] = shared_url
            env.pop("FAST_MODE_CACHE_USE_LOCAL", None)
            # This exact, synthetic DEMO needs one live seed run before it can
            # replay its own tool trajectory. Other shared-cache benches stay read-only.
            if set(tasks) == {"google-oauth"}:
                env.pop("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", None)
            else:
                env["FAST_MODE_CACHE_DISABLE_WRITE_THROUGH"] = "1"
        else:
            env.pop("FAST_MODE_CACHE_DATABASE_URL", None)
            env["FAST_MODE_CACHE_USE_LOCAL"] = "1"
        # resolve_temporal_task_queue() preserves an inherited TEMPORAL_TASK_QUEUE.
        # /deploy's configure_deploy_local_env mints a Step-5 semantic queue in the
        # parent shell; if that leaks into an isolated run, every local smoke /
        # AgentCard stack collapses onto one shared queue (and often the wrong
        # backend). Force run.sh to derive the queue from this stack's workspace.
        env.pop("TEMPORAL_TASK_QUEUE", None)
        # Isolated stacks can start in the same second and share a long
        # workspace-name prefix. Stable ngrok domains truncate that prefix,
        # which can collapse distinct runs onto one public endpoint. Give each
        # isolated stack a provider-assigned quick tunnel instead; the shared
        # dev stack keeps its stable ngrok domain.
        env["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = "0" if skip_public_tunnel else "1"
        # One short attempt bounds how long a quick tunnel that cannot route
        # delays the ngrok fallback (the run.sh default is ~3 minutes). Quick
        # tunnels on Cloud VMs began routing 4-10s after their hostname printed
        # (measured 2026-10-01), so this deadline leaves little margin.
        env.setdefault("CLOUDFLARE_TUNNEL_MAX_ATTEMPTS", "1")
        env.setdefault("CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS", "10")
        # Every isolated run starts with an empty per-run database and restores
        # the same immutable canonical base artifact from the shared cache. Do
        # NOT snapshot the developer's shared DB here: it is mutable and may not
        # contain the fixture rows the cloud runner depends on.
        seed_dump = Path(env.get("BENCHMARK_SEED_DUMP") or local_seed_dump_path())
        seed_dump.parent.mkdir(parents=True, exist_ok=True)
        env["BENCHMARK_SEED_DUMP"] = str(seed_dump)
        # The canonical fixture is published explicitly after validation. A cache
        # miss must fail rather than silently substituting a fresh prod sync with
        # different fixture contents.
        env["BENCHMARK_REQUIRE_SEED_DUMP"] = os.environ.get("BENCHMARK_REQUIRE_SEED_DUMP", "1")
        if not simulate:
            # Real-mode local benches never use the World Model Harness, so skip its
            # slow R2-corpus + GEPA cold build. Left unset, that build runs
            # synchronously during startup and can hang stack readiness (the manifest
            # is never published → wait_for_services blocks forever). Mirrors the
            # cloud-bench real-mode path, which sets the same flag for this reason.
            env.setdefault("BENCHMARK_SKIP_WMH_BUILD", "1")
        if simulate:
            # Put the worker into simulate mode. run.sh forks the agents worker from this
            # env, so these must be set here (the worker's WMH adapter + fast-cache scope
            # read them from its process env). WMH_PORT mirrors run.sh's +6 offset.
            apply_local_simulate_wmh_env(
                env,
                base_port=stack.base_port,
                world_model_name=world_model_name,
            )
    # The SMS benchmarks stub web_search through a file the backend re-reads per
    # call. The path has to be in the BACKEND's env at boot — it is already
    # running by the time a task selects its fixture — so publish it here.
    env["BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE"] = sms_web_search_fixture_path(stack)
    # A/B the SMS supervisor against another model with everything else held
    # fixed. Read from the caller's env so `BENCHMARK_SMS_SUPERVISOR_MODEL=x
    # scripts/run-bench --local <task>` just works; the backend needs it at boot.
    for key in (
        "BENCHMARK_SMS_SUPERVISOR_MODEL",
        "BENCHMARK_SMS_SUPERVISOR_ROUTE",
        "BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE",
    ):
        if os.environ.get(key):
            env[key] = os.environ[key]

    if skip_public_tunnel:
        # No selected task drives a browser or a hosted page, so nothing in this
        # run needs to be reachable from the public internet. Skip the quick
        # tunnel (and, with it, the ephemeral-URL publish that would otherwise
        # have nothing to publish) rather than take a per-IP-rate-limited
        # external dependency for nothing. See needs_public_tunnel() /
        # apply_public_tunnel_env() (already applied above; keep EPHEMERAL
        # pinned off here for the non-isolated path).
        env["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = "0"

    try:
        with open(stack.service_log, "w") as service_log:
            process = subprocess.Popen(
                ["bash", "scripts/run.sh", "--benchmark"],
                cwd=REPO_ROOT,
                stdout=service_log,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
        try:
            # Publish the Popen handle before fallible identity/journal writes.
            if on_process is not None:
                on_process(process)
            if stack.isolated:
                _record_stack_cleanup_owner(stack, process, stack_cleanup_token)
            if on_owner_ready is not None:
                on_owner_ready()
            service_start_timeout = service_start_timeout_seconds(
                isolated=stack.isolated, env=env, simulate=simulate
            )
            if service_start_timeout == WMH_FIRST_BUILD_SERVICE_START_TIMEOUT_SECONDS:
                print(
                    "🌍 First World Model build for this machine — extending the stack readiness "
                    f"budget to {service_start_timeout}s"
                )
            manifest = wait_for_services(
                stack.manifest_path,
                process=process,
                service_log=stack.service_log,
                timeout_seconds=service_start_timeout,
            )
        except BaseException:
            # Ownership transfers to the caller only after readiness succeeds.
            # Drain the exact stack owner while its handle is still available.
            try:
                stop_services(process, stack=stack)
            except Exception as cleanup_exc:
                # Cleanup diagnostics must not replace the readiness failure.
                print(
                    f"Warning: failed to clean up benchmark services: {cleanup_exc}",
                    file=sys.stderr,
                )
            raise
        return process, manifest
    finally:
        # A port that is merely checked is still racy. Keep the file lock until
        # every service has bound and passed readiness (or startup has rolled back).
        _release_port_range(stack.base_port)


def _validate_stack_cleanup_receipt(receipt: dict[str, str], owner: dict, *, verified_native_identity: str | None = None) -> None:
    """Prefer OS-native process identity; legacy wall-clock birth stays a strict fallback."""
    if receipt.get("stack_pid") != str(owner["pid"]):
        raise RuntimeError("stack cleanup receipt does not match its original process")
    if receipt.get("version") not in {"1", "2"}:
        raise RuntimeError("stack cleanup receipt schema is unsupported")
    recorded_native = receipt.get("stack_native_identity")
    if receipt.get("version") == "2" and not recorded_native:
        raise RuntimeError("stack cleanup receipt requires its native identity")
    if recorded_native is not None:
        if recorded_native != owner["native_identity"]:
            raise RuntimeError("stack cleanup receipt native identity does not match its original process")
        return
    if receipt.get("stack_birth") == owner["birth"]:
        return
    # Only the invocation that actually verified, signalled and joined this
    # exact native owner may resolve wall-clock drift in a legacy receipt.
    if verified_native_identity == owner["native_identity"]:
        return
    raise RuntimeError("legacy stack cleanup receipt birth is unverified")


def stop_services(process: subprocess.Popen | None = None, *, stack: ServiceStack | None = None) -> None:
    if stack is None or not stack.isolated:
        subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=False)
        return
    owner_path = stack.context_dir / "local-stack-owner.json"
    if owner_path.is_symlink() or not owner_path.is_file():
        if process is None:
            return  # No stack was launched by this invocation.
        raise RuntimeError(f"stack ownership is unverified; retaining recovery authority: {owner_path}")
    owner = json.loads(owner_path.read_text())
    if (
        owner.get("version") != 1
        or owner.get("run_id") != stack.run_id
        or not isinstance(owner.get("pid"), int)
        or owner["pid"] <= 0
        or not isinstance(owner.get("token"), str)
        or not owner["token"]
        or not isinstance(owner.get("native_identity"), str)
        or not owner["native_identity"]
        or not isinstance(owner.get("birth"), str)
        or not owner["birth"]
        or (process is not None and process.pid != owner["pid"])
    ):
        raise RuntimeError("stack cleanup owner does not match this invocation")
    timeout = _owned_shutdown_timeout()
    verified_native_identity = None
    if process is not None:
        was_live = process.poll() is None
        if was_live and _process_identity_tools()["current_identity"](owner["pid"]) != owner["native_identity"]:
            raise RuntimeError("stack PID was replaced; refusing cleanup")
        _signal_owned_process(process, owner["native_identity"], signal.SIGTERM)
        process.wait(timeout=timeout)
        if was_live:
            verified_native_identity = owner["native_identity"]
    else:
        tools = _process_identity_tools()
        try:
            current = tools["current_identity"](owner["pid"])
        except (OSError, ValueError, IndexError):
            if _pid_is_alive(owner["pid"]):
                raise RuntimeError("live stack identity is unreadable; retaining recovery authority")
            current = None
        if current is not None:
            if current != owner["native_identity"]:
                raise RuntimeError("stack PID was replaced; refusing cleanup")
            code = tools["main"](
                [
                    "process-identity",
                    "--expect",
                    owner["native_identity"],
                    "--signal",
                    "TERM",
                    str(owner["pid"]),
                ]
            )
            if code != 0 or not _wait_for_pid_exit(owner["pid"], timeout):
                raise RuntimeError("owned stack shutdown remains unverified")
            verified_native_identity = owner["native_identity"]
    try:
        receipt = _read_cleanup_receipt(
            stack.context_dir / "local-stack-cleanup.status", owner["token"], allowed_versions=("1", "2")
        )
    except RuntimeError as error:
        # An owner that died inside its EXIT trap leaves state=pending forever.
        # The supported recovery re-verifies the real leftovers and rewrites it.
        raise RuntimeError(
            f"{error}. If the stack owner exited, run: scripts/run-bench --local --run-id {stack.run_id} "
            "--reconcile-cleanup"
        ) from error
    _validate_stack_cleanup_receipt(receipt, owner, verified_native_identity=verified_native_identity)


# Isolated --benchmark Prisma pool. Must stay in lockstep with run.sh
# `LOCAL_DB_CONNECTION_LIMIT:-80` (50-child mass-agent fan-out + parent).
BENCHMARK_DB_CONNECTION_LIMIT = 80


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
        # Must stay above the 50-child mass-agent fan-out (see run.sh
        # LOCAL_DB_CONNECTION_LIMIT:-80). A 50-conn pool P2028s under
        # concurrent post_agent_message interactive txs and the tree stalls.
        os.environ["DATABASE_URL"] = f"{database_url}?connection_limit={BENCHMARK_DB_CONNECTION_LIMIT}&pool_timeout=30"
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
    wmh_url = (urls.get("wmh") if isinstance(urls, dict) else "") or external_wmh_base_url()
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
        env=dict(os.environ if env is None else env),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _ACTIVE_CHILD_PROCESSES.add(process)
    output_lines: list[str] = []
    try:
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="")
            output_lines.append(line)
        code = process.wait()
    finally:
        _ACTIVE_CHILD_PROCESSES.discard(process)
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


def diagnostic_log_env(stack: ServiceStack | None) -> dict[str, str]:
    """
    Point the file-reading diagnostics at THIS run's logs.

    An isolated stack writes `<context_dir>/logs/backend.log` and one `worker.N.log` per worker
    process, never the default `agents/navi-worker-log.txt` / `back-end/backend-logs.log`. Without
    this, `agent_latency.py` and `agent_cache.py` reported "No log lines found" for every failed
    benchmark and the collected diagnostics were empty — the failure looked undiagnosable.
    """
    env = dict(os.environ)
    if stack is None or not stack.isolated:
        return env
    log_dir = stack.context_dir / "logs"
    if not log_dir.is_dir():
        return env
    worker_logs = sorted(str(path) for path in log_dir.glob("worker*.log"))
    backend_log = log_dir / "backend.log"
    if worker_logs:
        env["NAVI_WORKER_LOGS"] = ",".join(worker_logs)
    if backend_log.exists():
        env["NAVI_BACKEND_LOGS"] = str(backend_log)
    return env


def run_diagnostics(
    failures: Sequence[FailedTask],
    *,
    port: int,
    result_path: Path,
    stack: ServiceStack | None = None,
    timeout_seconds: float = 180,
) -> Path | None:
    runnable = [failure for failure in failures if failure.agent_id]
    if not runnable:
        return None
    out_root = result_path.with_suffix("")
    diag_root = out_root.parent / bounded_path_component(
        out_root.name,
        suffix="_diagnostics",
        identity=result_path.name,
    )
    diag_root.mkdir(parents=True, exist_ok=True)
    diag_env = diagnostic_log_env(stack)
    for failure in runnable:
        task_dir = diag_root / f"{failure.name}_{failure.agent_id[:12]}"
        task_dir.mkdir(exist_ok=True)
        processes: list[tuple[subprocess.Popen, object]] = []
        for command in diagnostic_commands(failure.agent_id, task_name=failure.name, port=port):
            label = Path(command[1]).stem
            outfile = open(task_dir / f"{label}.txt", "w")
            outfile.write(f"$ {' '.join(command)}\n\n")
            outfile.flush()
            processes.append(
                (
                    subprocess.Popen(command, cwd=AGENTS_DIR, stdout=outfile, stderr=subprocess.STDOUT, env=diag_env),
                    outfile,
                )
            )
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


def checkpoint_source_out_paths(
    stack: ServiceStack, task_name: str, args: argparse.Namespace
) -> tuple[Path, Path | None]:
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
    wmh_initial_state_file: str | None = None,
    timeout_seconds: int | None = None,
    owner: LocalBenchmarkOwner | None = None,
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
        wmh_initial_state_file=wmh_initial_state_file,
        timeout_seconds=timeout_seconds,
    )
    print(f"\n== Running {invocation.label}: {', '.join(invocation.tasks)}")
    print("$ " + " ".join(command))
    env = benchmark_runner_env()
    if owner is not None:
        env = owner.environment(env)
    process = subprocess.Popen(
        command,
        cwd=AGENTS_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=owner is not None,
    )
    if owner is not None:
        try:
            owner.bind(process)
            code, output = owner.drain()
        except BaseException as error:
            if process.poll() is None:
                try:
                    owner.interrupt(signal.SIGTERM)
                    owner.drain(echo=False)
                except BaseException as cleanup_error:
                    error.add_note(f"Owned benchmark cleanup remains unverified: {cleanup_error}")
            raise
        if owner.signum is not None:
            raise SystemExit(128 + owner.signum)
    else:
        _ACTIVE_CHILD_PROCESSES.add(process)
        output_lines: list[str] = []
        try:
            assert process.stdout is not None
            for line in process.stdout:
                print(line, end="")
                output_lines.append(line)
            code = process.wait()
        finally:
            _ACTIVE_CHILD_PROCESSES.discard(process)
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


def wmh_model_prebuilt(env: dict[str, str] | None = None) -> bool:
    """True when run.sh will serve an existing World Model instead of cold-building one."""
    env = env or os.environ
    build_dir = Path(env.get("WMH_BUILD_DIR") or (REPO_ROOT / ".context" / "world-model"))
    model_name = env.get("WMH_MODEL_NAME") or "rose-archive"
    return (build_dir / "build.manifest.json").is_file() and (build_dir / "models" / model_name).is_dir()


def service_start_timeout_seconds(*, isolated: bool, env: dict[str, str], simulate: bool) -> int:
    """Readiness budget for an isolated stack, by the slowest step it must complete."""
    if isolated and env.get("BENCHMARK_REQUIRE_SEED_DUMP") == "0":
        return COLD_SEED_SERVICE_START_TIMEOUT_SECONDS
    if simulate and env.get("BENCHMARK_SKIP_WMH_BUILD") != "1" and not wmh_model_prebuilt(env):
        return WMH_FIRST_BUILD_SERVICE_START_TIMEOUT_SECONDS
    return SERVICE_START_TIMEOUT_SECONDS


def resolve_simulate_mode(simulate_flag: bool, task_names: Sequence[str]) -> bool:
    """CLI --simulate or any catalog world_model_mode=simulate enables the WMH.

    The fleet already honors the catalog mode; local must match so a bench that
    declares simulate (wait-for-trigger, raise-5m-rose-labs-brex) never places
    a real call / contacts a real person just because --simulate was omitted.
    """
    if simulate_flag:
        return True
    for name in task_names:
        try:
            task = get_task_by_name(name)
        except Exception:
            continue
        mode = (getattr(task, "world_model_mode", None) or "").strip().lower()
        if mode == "simulate":
            return True
    return False


def external_wmh_base_url() -> str:
    """Opt-in loopback URL of an already-served WMH (WMH_EXTERNAL_BASE_URL)."""
    value = (os.environ.get("WMH_EXTERNAL_BASE_URL") or "").strip().rstrip("/")
    if value and not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):[1-9][0-9]{1,4}", value):
        raise ValueError("WMH_EXTERNAL_BASE_URL must be a loopback http://host:port URL")
    return value


def apply_local_simulate_wmh_env(
    env: dict[str, str],
    *,
    base_port: int,
    world_model_name: str | None = None,
) -> dict[str, str]:
    """Env overrides so a local simulate stack serves the complete eligible WHM corpus.

    run.sh forks the agents worker from this env, so the worker's WMH adapter and
    fast-cache scope read these from its process env. WMH_PORT mirrors run.sh's
    +6 offset.
    """
    env["BENCHMARK_WORLD_MODEL_MODE"] = "simulate"
    external = external_wmh_base_url()
    if external:
        # An operator-owned WMH that is already healthy (for example a native
        # model loaded in a RAM-bounded scope whose cold load exceeds run.sh's
        # readiness bound). run.sh neither serves nor owns it.
        env["WMH_BASE_URL"] = external
        env["BENCHMARK_SKIP_WMH_BUILD"] = "1"
    else:
        env["WMH_BASE_URL"] = f"http://localhost:{base_port + 6}"
    # The worker's WMH adapter (helpers/world_model_runtime.py:from_env) needs
    # WMH_MODEL_NAME at fork time or the first simulated boundary tool raises
    # "WMH simulation requires WMH_BASE_URL and WMH_MODEL_NAME". run.sh only
    # exports the name after the WMH answers /healthz, which is after the
    # workers fork, so pin the default here (matches run.sh + run_benchmark).
    env["WMH_MODEL_NAME"] = world_model_name or os.environ.get("WMH_MODEL_NAME") or "rose-archive"
    # No implicit bundle cap: every eligible archived trajectory participates.
    # An operator can still set WMH_MAX_BUNDLES for a deliberately scoped run.
    env.setdefault("WMH_MAX_BUNDLES", os.environ.get("WMH_MAX_BUNDLES") or "0")
    # Skip GEPA for local simulate cold builds — serve a corpus-backed model
    # without the multi-hour prompt-optimize pass (cloudbench does the same).
    env.setdefault("WMH_GEPA_BUDGET", os.environ.get("WMH_GEPA_BUDGET") or "0")
    return env


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
        return known_task_names(include_polar=False)
    if args.suite:
        if args.suite == "all":
            selected = [
                task
                for task in all_tasks()
                if task.runner in RUNNABLE_TASK_RUNNERS and task.status == "ready" and not is_polar_bench_task(task)
            ]
        elif args.suite in ("rose-bench", "pipeline-e2e"):
            selected = [
                task
                for task in all_tasks()
                if task.runner in RUNNABLE_TASK_RUNNERS
                and task.status == "ready"
                and task.bench == args.suite
                and not is_polar_bench_task(task)
            ]
        else:
            selected = [
                task
                for task in all_tasks()
                if task.runner in RUNNABLE_TASK_RUNNERS and task.status == "ready" and args.suite in task.tags
            ]
            # Non-polar tag suites (browser, smoke, …) must not inherit the
            # Odysseys/BU flood just because those tasks also carry `browser`.
            if args.suite != "polar-bench":
                selected = [task for task in selected if not is_polar_bench_task(task)]
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
    parser.add_argument(
        "--eval-suite", action="store_true", help="Run benchmarks/run_eval_suite.py against isolated services"
    )
    parser.add_argument("--rerun-failed", metavar="RUN", help="Rerun failed tasks from a result JSON or 'latest'")
    parser.add_argument("--only", help="Comma-separated eval task names for --eval-suite")
    parser.add_argument(
        "--bench",
        choices=["rose-bench", "pipeline-e2e"],
        help="Pass --bench through to run_eval_suite.py",
    )
    parser.add_argument("--bootstrap", action="store_true", help="Pass --bootstrap through to run_benchmark.py")
    parser.add_argument("--timeout-seconds", type=int, help="Override the selected task timeout for this run")
    parser.add_argument(
        "--anon",
        action="store_true",
        help="Pass --anon through to run_benchmark.py so minted-auth benchmarks start without saved auth",
    )
    parser.add_argument("--max-concurrency", type=int, default=5, help="Max concurrent non-load benchmark tasks")
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Run in world-model simulate mode (provider boundaries and specialized "
        "explore/browser/code subagents hit WMH; general-purpose and for-each loops stay real)",
    )
    parser.add_argument(
        "--world-model-name",
        help="World model to simulate against (defaults to the model run.sh served, i.e. WMH_MODEL_NAME)",
    )
    parser.add_argument(
        "--wmh-initial-state-file",
        help="Override the WHM initial state for one simulate-mode benchmark task.",
    )
    parser.add_argument("--keep-services", action="store_true", help="Leave local services running after benchmarks")
    parser.add_argument("--use-existing", action="store_true", help="Use services from .context/services.json")
    parser.add_argument(
        "--shared-stack",
        action="store_true",
        help="Use the default .context/services.json stack instead of a per-run isolated stack",
    )
    parser.add_argument("--run-id", help="Stable id for the isolated benchmark stack")
    parser.add_argument(
        "--reconcile-cleanup",
        action="store_true",
        help="Verify an exited --run-id stack left nothing behind and resolve its pending cleanup receipt",
    )
    parser.add_argument("--cohort-task", action="append", dest="cohort_tasks", default=[], help=argparse.SUPPRESS)
    parser.add_argument("--world-ready-fd", type=int, help=argparse.SUPPRESS)
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
            "Run one benchmark until root message index TURN_N, pause/export it, clone the checkpoint, and resume it"
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
    if args.reconcile_cleanup:
        # Recovery of an exited stack's receipt: no benchmark selection, no services.
        if not args.run_id or args.tasks or args.suite or args.full or args.rerun_failed or args.eval_suite:
            parser.error("--reconcile-cleanup takes only --run-id <stack-run-id>")
        return args
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
    if args.timeout_seconds is not None and args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
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
    if (
        args.checkpoint_source_json or args.checkpoint_tree_json or args.checkpoint_no_tree
    ) and not checkpoint_requested(args):
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


def enforce_provider_capacity(benches: int) -> None:
    """Refuse a local width above the shared provider rate-limit cap (the cloud registry)."""
    capacity = runpy.run_path(str(REPO_ROOT / "scripts/cloudbench-provider-capacity.py"))
    try:
        refused = capacity["check"](benches)
    except capacity["RegistryError"] as error:
        raise SystemExit(f"❌ {error}; no local benchmark stack started") from None
    if refused:
        raise SystemExit(refused)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if getattr(args, "reconcile_cleanup", False):
        from benchmarks import local_cleanup_reconcile

        return local_cleanup_reconcile.main(sys.modules[__name__], args)
    world_ready_fd = getattr(args, "world_ready_fd", None)
    if bool(getattr(args, "cohort_tasks", [])) != (world_ready_fd is not None):
        raise ValueError("a child world requires its coordinator ownership handshake")
    if world_ready_fd is not None:
        # Never allocate services before the coordinator has captured this
        # process's native identity and durably journaled its ownership. EOF
        # (including a parent crash) fails before any stack is created.
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(world_ready_fd, selectors.EVENT_READ)
                if not selector.select(30) or os.read(world_ready_fd, 2) != b"1":
                    raise RuntimeError("coordinator did not confirm local child ownership")
        finally:
            os.close(world_ready_fd)
    selected_tasks = tasks_from_args(args)
    if getattr(args, "wmh_initial_state_file", None) and len(selected_tasks) != 1:
        raise ValueError("--wmh-initial-state-file requires exactly one benchmark task")
    if not getattr(args, "cohort_tasks", []) and not args.eval_suite:
        # Before any stack, child world or provider call; child worlds belong
        # to this already-admitted parent width.
        enforce_provider_capacity(min(args.max_concurrency, len(selected_tasks)))
    validate_agentcard_org_credentials(selected_tasks)
    if checkpoint_requested(args) and len(selected_tasks) != 1:
        raise ValueError("--checkpoint requires exactly one resolved benchmark task")
    # Catalog world_model_mode=simulate wins even without an explicit --simulate.
    args.simulate = resolve_simulate_mode(bool(args.simulate), selected_tasks)
    if args.simulate:
        print("World-model simulate mode ON (CLI --simulate and/or catalog world_model_mode)")
    validate_benchmark_archive_environment()
    cohort_tasks = getattr(args, "cohort_tasks", []) or selected_tasks
    if getattr(args, "cohort_tasks", []):
        validate_task_names(cohort_tasks)
        if len(selected_tasks) != 1 or selected_tasks[0] not in cohort_tasks:
            raise ValueError("a child world must select one task from its original cohort")
    elif len(selected_tasks) > 1 and not args.eval_suite:
        from benchmarks.local_worlds import needs_independent_worlds, run_task_worlds

        if needs_independent_worlds(selected_tasks, args.max_concurrency):
            return run_task_worlds(sys.modules[__name__], args, selected_tasks)
    stack = build_service_stack(args)
    configure_task_environment(cohort_tasks, isolated=stack.isolated)
    process: subprocess.Popen | None = None
    frontend_tunnel: FrontendTunnel | None = None
    imessage_relay: IMessageRelay | None = None
    dashboard: DashboardServer | None = None
    result_paths: list[Path] = []
    benchmark_owner = LocalBenchmarkOwner(stack)
    if stack.isolated:
        benchmark_owner.record("not_started")
    previous_isolated_browser_profiles = os.environ.get("BENCHMARK_ISOLATED_BROWSER_PROFILES")
    # Isolated stacks and --use-existing local stacks both key browser-provider
    # profiles per agent. Without this flag, run_benchmark serializes every
    # requires_browser_agent task through a one-writer semaphore (concurrency=1),
    # which makes a 300-task polar-bench run effectively sequential.
    if stack.isolated or args.use_existing:
        # Both the service stack and run_benchmark.py inherit this. Provider
        # profiles are keyed per agent, so browser benchmarks can use the same
        # concurrency width as non-browser tasks without cross-run state writes.
        os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = "true"

    def handle_shutdown(signum: int, _frame: object) -> None:
        print(f"\nReceived signal {signum}; draining owned benchmark before services...", file=sys.stderr)
        stop_active_child_processes()
        benchmark_owner.interrupt(signum)
        if benchmark_owner.process is None and not benchmark_owner.starting:
            raise SystemExit(128 + signum)

    def remember_stack_process(started_process: subprocess.Popen) -> None:
        nonlocal process
        process = started_process

    def stack_owner_ready() -> None:
        benchmark_owner.starting = False
        if benchmark_owner.signum is not None:
            raise SystemExit(128 + benchmark_owner.signum)

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
            from benchmarks.spawn_contract import tasks_require_disabled_saved_browser_auth

            if tasks_require_disabled_saved_browser_auth(selected_tasks) and not (
                services_manifest_saved_browser_auth_disabled(manifest)
            ):
                raise RuntimeError(
                    "Existing local stack was not started with saved browser auth disabled, "
                    "but a guest-checkout task was selected. Run without --use-existing so "
                    "local.py can restart the stack with BENCHMARK_DISABLE_SAVED_BROWSER_AUTH."
                )
        else:
            benchmark_owner.starting = True
            try:
                process, manifest = start_services(
                    stack,
                    clean_first=not args.no_clean,
                    anon_steel_profile=args.anon,
                    simulate=args.simulate,
                    world_model_name=args.world_model_name,
                    tasks=cohort_tasks,
                    on_process=remember_stack_process,
                    on_owner_ready=stack_owner_ready,
                )
            finally:
                benchmark_owner.starting = False
            if benchmark_owner.signum is not None:
                raise SystemExit(128 + benchmark_owner.signum)
        apply_manifest_environment(manifest)
        if stack.isolated:
            # Child processes (run_benchmark.py, diagnostics, eval suite) inherit this
            # process's os.environ. They resolve the isolated stack's services.json via
            # BENCHMARK_CONTEXT_DIR; without it they default to the top-level ".context"
            # (a stale manifest from a prior run) and route DB fixtures to the wrong
            # database — e.g. the grep fixture's direct agent lookup hits system Postgres
            # instead of the isolated container and fails with "root agent not found".
            os.environ["BENCHMARK_CONTEXT_DIR"] = str(stack.context_dir.resolve())
            # Point collect_logs / agent_latency / agent_cache at THIS stack's
            # worker*.log files for the whole run (not only post-fail diagnostics).
            # Without this, run JSON kept ClickHouse/Fly placeholders and dropped
            # Claude Code tool_use progress that only lived in the isolated logs.
            for key, value in diagnostic_log_env(stack).items():
                if key in {"NAVI_WORKER_LOGS", "NAVI_BACKEND_LOGS"} and value:
                    os.environ[key] = value
            # The SMS web_search stub is a two-process contract: the backend was
            # given this absolute path at boot, and run_benchmark.py must write
            # the file there. Exporting it to the backend alone leaves the runner
            # writing somewhere the backend never reads — the fixture no-ops and
            # the run scores live search. Both sides get the same string.
            os.environ["BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE"] = sms_web_search_fixture_path(stack)
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
        print_scorecard_instruction(_dashboard_context_dir(stack))
        if needs_payment_fixture(cohort_tasks):
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
            benchmark_owner.starting = True
            try:
                result_path = run_benchmark_invocation(
                    invocation,
                    port=port,
                    bootstrap=args.bootstrap,
                    anon=args.anon,
                    max_concurrency=args.max_concurrency,
                    simulate=args.simulate,
                    world_model_name=args.world_model_name,
                    wmh_initial_state_file=getattr(args, "wmh_initial_state_file", None),
                    timeout_seconds=getattr(args, "timeout_seconds", None),
                    owner=benchmark_owner,
                )
            finally:
                benchmark_owner.starting = False
            result_paths.append(result_path)
            _write_owner_record(
                stack.context_dir / "local-benchmark-results.json",
                {
                    "version": 1,
                    "run_id": stack.run_id,
                    "results": [
                        {"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                        for path in result_paths
                    ],
                },
            )
            failures = failed_tasks_from_run(result_path)
            if failures:
                diag_dir = run_diagnostics(failures, port=port, result_path=result_path, stack=stack)
                if diag_dir:
                    print(f"Diagnostics saved: {diag_dir}")
        all_failures = [failure for path in result_paths for failure in failed_tasks_from_run(path)]
        print_scorecard_instruction(_dashboard_context_dir(stack))
        if all_failures:
            print("\nFailed tasks:")
            for failure in all_failures:
                print(f"- {failure.name}: {failure.failure_reason or 'no reason'}")
            return 1
        print("\nAll requested benchmarks passed.")
        return 0
    finally:
        if previous_isolated_browser_profiles is None:
            os.environ.pop("BENCHMARK_ISOLATED_BROWSER_PROFILES", None)
        else:
            os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = previous_isolated_browser_profiles
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            if benchmark_owner.started and not benchmark_owner.verified:
                benchmark_owner.record("failed_retained")
                print(
                    f"Owned cleanup is unverified; retaining services and database: {stack.context_dir}",
                    file=sys.stderr,
                )
            else:
                stop_imessage_relay(imessage_relay)
                stop_frontend_tunnel(frontend_tunnel)
                if dashboard is not None:
                    dashboard.stop()
                keep_paused_checkpoint_stack = checkpoint_requested(args) and args.checkpoint_no_start
                if keep_paused_checkpoint_stack and not args.keep_services and not args.use_existing:
                    print("Keeping benchmark services running so the paused checkpoint FE link remains valid.")
                if not args.keep_services and not args.use_existing and not keep_paused_checkpoint_stack:
                    stop_services(process, stack=stack)
        finally:
            signal.signal(signal.SIGTERM, previous_sigterm)
            signal.signal(signal.SIGINT, previous_sigint)


if __name__ == "__main__":
    raise SystemExit(main())
