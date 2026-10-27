"""
Fetch production logs for benchmark agents.

Log sources:
  1. Render   — backend HTTP logs (REST API, needs RENDER_API_KEY in back-end/.env)
  2. ClickHouse — retained Fly.io worker logs (needs CLICKHOUSE_* in agents/.env)
  3. Fly.io   — live agent worker logs (real-time stream via flyctl, needs FLY_API_TOKEN in agents/.env)
  4. Supabase — edge function gateway logs (Management API, needs SUPABASE_ACCESS_TOKEN in agents/.env)
  5. Realtime — Supabase websocket/broadcast frames captured live during benchmarks
  6. Messages — full agent message transcript (from agent GET response, always available)

Token locations:
  - RENDER_API_KEY:        back-end/.env
  - CLICKHOUSE_ENDPOINT:   agents/.env
  - CLICKHOUSE_USER:       agents/.env
  - CLICKHOUSE_PASSWORD:   agents/.env
  - FLY_API_TOKEN:         agents/.env  (generate: flyctl tokens create deploy -a navi-whisper-lux)
  - SUPABASE_ACCESS_TOKEN: agents/.env  (generate: https://supabase.com/dashboard/account/tokens)

Fly.io / ClickHouse note:
  flyctl logs --no-tail only returns ~30s of buffered logs (mostly health checks).
  Retained worker logs are stored in ClickHouse observability.fly_logs for 7 days.
  FlyLogCollector still streams live logs during benchmark runs, then we merge
  stream, snapshot, and ClickHouse rows by agent_id.

Supabase note:
  The Supabase Management API only exposes gateway-level HTTP logs (method/status/URL)
  via the logs.all endpoint. Edge function console output (console.log/slog() calls
  from completions/index.ts) is NOT available via REST API — only visible in the
  Supabase Logs Explorer UI. In local mode, console output goes to research-logs.log.
  In prod, the worker logs are the best proxy: they log the HTTP status and error body
  received back from the completions endpoint.
"""

import asyncio
import heapq
import ipaddress
import json
import os
import shutil
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx


def _find_flyctl() -> str:
    """Locate flyctl binary — check PATH, then common install locations."""
    found = shutil.which("flyctl")
    if found:
        return found
    for candidate in [
        os.path.expanduser("~/.fly/bin/flyctl"),
        "/root/.fly/bin/flyctl",
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "flyctl"


# ---------------------------------------------------------------------------
# Config — load from env, fall back to .env files
# ---------------------------------------------------------------------------

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")


def load_env_var(
    name: str,
    *env_files: str,
    include_process_env: bool = True,
) -> str:
    """Load a var from process state and then the requested ``.env`` files.

    Callers resolving a remote source while the current process targets an
    isolated local database can disable the process lookup explicitly.
    """
    if include_process_env:
        val = os.environ.get(name, "")
        if val:
            return val
    for path in env_files:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{name}="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    # Strip inline comments (e.g. KEY=value # comment)
                    if " #" in val:
                        val = val[: val.index(" #")].rstrip()
                    return val
    return ""


# Render (backend on Render)
RENDER_API_KEY = load_env_var("RENDER_API_KEY", _BACKEND_ENV)
RENDER_SERVICE_ID = load_env_var("RENDER_SERVICE_ID", _BACKEND_ENV) or "srv-d3jga77diees73cgrvk0"
RENDER_OWNER_ID = load_env_var("RENDER_OWNER_ID", _BACKEND_ENV) or "tea-csppgi56l47c73djvpig"

# Fly.io (agent worker on Fly.io)
FLY_API_TOKEN = load_env_var("FLY_API_TOKEN", _AGENTS_ENV)
FLY_APP_NAME = "navi-whisper-lux"
DISABLE_FLY_LOG_STREAM = os.environ.get("BENCHMARK_DISABLE_FLY_LOG_STREAM", "").lower() in {
    "1",
    "true",
    "yes",
}

# ClickHouse (retained Fly.io worker logs)
CLICKHOUSE_ENDPOINT = load_env_var("CLICKHOUSE_ENDPOINT", _AGENTS_ENV, _BACKEND_ENV)
CLICKHOUSE_USER = load_env_var("CLICKHOUSE_USER", _AGENTS_ENV, _BACKEND_ENV)
CLICKHOUSE_PASSWORD = load_env_var("CLICKHOUSE_PASSWORD", _AGENTS_ENV, _BACKEND_ENV)
CLICKHOUSE_DATABASE = load_env_var("CLICKHOUSE_DATABASE", _AGENTS_ENV, _BACKEND_ENV) or "observability"
CLICKHOUSE_TABLE = load_env_var("CLICKHOUSE_TABLE", _AGENTS_ENV, _BACKEND_ENV) or "fly_logs"

# Supabase (edge functions — completions, cost, etc.)
SUPABASE_ACCESS_TOKEN = load_env_var("SUPABASE_ACCESS_TOKEN", _AGENTS_ENV)
SUPABASE_URL = load_env_var("SUPABASE_URL", _AGENTS_ENV, _BACKEND_ENV)


def _supabase_project_ref_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    suffix = ".supabase.co"
    return host[: -len(suffix)] if host.endswith(suffix) else ""


# Explicit configuration, else the project the configured SUPABASE_URL names.
# Never a hard-coded production project: Management API reads spend that
# project's shared rate limit.
SUPABASE_PROJECT_REF = load_env_var("SUPABASE_PROJECT_REF", _AGENTS_ENV) or _supabase_project_ref_from_url(SUPABASE_URL)
SUPABASE_ANON_KEY = load_env_var("SUPABASE_ANON_KEY", _AGENTS_ENV, _BACKEND_ENV) or load_env_var(
    "VITE_SUPABASE_ANON_KEY",
    os.path.join(os.path.dirname(__file__), "..", "..", "front-end", ".env"),
)


# ---------------------------------------------------------------------------
# Which backend served the agents
# ---------------------------------------------------------------------------


def prod_log_sources_enabled(backend_url: str) -> bool:
    """Whether production log stores can contain agents created via ``backend_url``.

    Render, the Supabase Management API, ClickHouse ``fly_logs`` and
    ``flyctl logs`` index agents served by the deployed backend and its Fly
    workers. A loopback backend (``run-bench --local``, ``scripts/run.sh`` or an
    isolated cloudbench guest) runs its own backend, worker and in-process
    completions; its worker logs are read from local files and the rest stay in
    its stack archive. Querying production for those agents cannot find them
    and spends shared production API budgets once per benchmark copy.
    """
    raw = (backend_url or "").strip()
    host = (urlparse(raw if "://" in raw else f"http://{raw}").hostname or "").lower()
    if not host or host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (address.is_loopback or address.is_unspecified)


def _prod_logs_skipped_note(backend_url: str) -> str:
    return f"prod log query skipped: agents ran on local backend {backend_url}; see its stack logs"


# ---------------------------------------------------------------------------
# Render backend logs
# ---------------------------------------------------------------------------


async def fetch_render_logs(
    agent_id: str,
    start_time: datetime,
    end_time: Optional[datetime] = None,
    limit: int = 200,
) -> List[str]:
    if not RENDER_API_KEY:
        return ["[render] RENDER_API_KEY not set in back-end/.env"]

    if end_time is None:
        end_time = datetime.now(timezone.utc)

    params = {
        "ownerId": RENDER_OWNER_ID,
        "resource": RENDER_SERVICE_ID,
        "limit": str(limit),
        "direction": "backward",
        "startTime": start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endTime": end_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    headers = {"Authorization": f"Bearer {RENDER_API_KEY}"}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get("https://api.render.com/v1/logs", headers=headers, params=params)
            if resp.status_code != 200:
                return [f"[render] API {resp.status_code}: {resp.text[:200]}"]

            data = resp.json()
            logs = data.get("logs", data) if isinstance(data, dict) else data
            if not isinstance(logs, list):
                return ["[render] Unexpected response format"]

            filtered = []
            for entry in logs:
                msg = entry.get("message", "") if isinstance(entry, dict) else str(entry)
                if agent_id in msg or agent_id[:12] in msg:
                    filtered.append(msg)

            if not filtered:
                return [f"[render] 0 logs for agent {agent_id[:12]} ({len(logs)} total in window)"]
            return filtered

    except Exception as e:
        return [f"[render] Error: {e}"]


# ---------------------------------------------------------------------------
# Fly.io worker logs — real-time streaming collector
# ---------------------------------------------------------------------------


def _local_worker_log_paths() -> List[str]:
    """Resolve local worker log files for isolated / cloud-local benchmark stacks.

    Isolated ``run-bench`` / ``local.py`` stacks write ``<context>/logs/worker*.log``
    (never the default ``agents/navi-worker-log.txt``). Diagnostics already point
    ``NAVI_WORKER_LOGS`` at those files; ``collect_logs`` must read the same
    paths so run JSON retains Claude Code / tool progress instead of an empty
    ClickHouse/Fly placeholder.
    """
    paths: List[str] = []
    seen: set[str] = set()

    def _add(path: str) -> None:
        if not path or path in seen:
            return
        if os.path.isfile(path):
            seen.add(path)
            paths.append(path)

    for raw in (os.environ.get("NAVI_WORKER_LOGS") or "").split(","):
        _add(raw.strip())

    context_dir = (os.environ.get("BENCHMARK_CONTEXT_DIR") or "").strip()
    if context_dir:
        log_dir = os.path.join(context_dir, "logs")
        if os.path.isdir(log_dir):
            for name in sorted(os.listdir(log_dir)):
                if name.startswith("worker") and name.endswith(".log"):
                    _add(os.path.join(log_dir, name))

    agents_dir = os.path.join(os.path.dirname(__file__), "..")
    _add(os.path.join(agents_dir, "navi-worker-log.txt"))
    _add(os.path.join(os.getcwd(), "navi-worker-log.txt"))
    _add(os.path.join(os.getcwd(), "agents", "navi-worker-log.txt"))
    return paths


def _line_mentions_agent(line: str, agent_id: str) -> bool:
    if not agent_id:
        return False
    if agent_id in line:
        return True
    short = agent_id[:12]
    return bool(short) and short in line


def fetch_local_worker_logs(
    agent_id: str,
    start_time: Optional[datetime] = None,
    *,
    limit: int = 20000,
    newest: bool = False,
) -> List[str]:
    """Read agent-scoped lines from local worker log files.

    Returns JSONL/text lines that mention ``agent_id`` (full or 12-char prefix).
    When ``start_time`` is set and a line parses as JSON with a timestamp, lines
    before the window are skipped. Errors reading a file are returned as a
    single placeholder line so callers can see the failure mode.
    ``newest`` retains the latest ``limit`` lines across files, ordered by JSON
    timestamp (file modification time for unstructured lines). It scans all
    files up to their opening byte size, keeping at most ``limit`` rows in memory,
    so an early busy worker cannot hide another worker's later cleanup or extend
    the read indefinitely. Default prefix reads are unchanged.
    """
    paths = _local_worker_log_paths()
    if not paths or limit <= 0:
        return []

    start_ts = start_time.astimezone(timezone.utc) if start_time is not None else None
    matched: List[str] = []
    recent: list[tuple[float, int, str]] = []
    sequence = 0

    def retain(line: str, timestamp: float) -> None:
        nonlocal sequence
        sequence += 1
        item = (timestamp, sequence, line)
        if len(recent) < limit:
            heapq.heappush(recent, item)
        else:
            heapq.heappushpop(recent, item)

    for path in paths:
        try:
            with open(path, "rb" if newest else "r", errors=None if newest else "replace") as handle:
                stat = os.fstat(handle.fileno()) if newest else None
                file_timestamp = stat.st_mtime if stat is not None else 0
                remaining = stat.st_size if stat is not None else -1
                while raw_line := handle.readline(remaining):
                    if newest:
                        remaining -= len(raw_line)
                    line = raw_line.decode(errors="replace") if isinstance(raw_line, bytes) else raw_line
                    line = line.rstrip("\n")
                    if not line or not _line_mentions_agent(line, agent_id):
                        continue
                    timestamp = file_timestamp
                    if start_ts is not None or newest:
                        try:
                            payload = json.loads(line)
                        except json.JSONDecodeError:
                            payload = None
                        if isinstance(payload, dict):
                            raw_ts = payload.get("timestamp") or payload.get("time")
                            if isinstance(raw_ts, str) and raw_ts:
                                try:
                                    ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
                                    if ts.tzinfo is None:
                                        ts = ts.replace(tzinfo=timezone.utc)
                                    if start_ts is not None and ts < start_ts:
                                        continue
                                    timestamp = ts.timestamp()
                                except ValueError:
                                    pass
                    if newest:
                        retain(line, timestamp)
                        continue
                    matched.append(line)
                    if len(matched) >= limit:
                        return matched
        except OSError as exc:
            error_line = f"[local-worker] Error reading {path}: {exc}"
            if newest:
                retain(error_line, datetime.now(timezone.utc).timestamp())
            else:
                matched.append(error_line)
    if newest:
        return [line for _, _, line in sorted(recent)]
    return matched


def _is_remote_worker_log_placeholder(line: str) -> bool:
    """True for non-content placeholders from Fly/ClickHouse collectors."""
    return line.startswith("[fly.io]") or line.startswith("[clickhouse]")


async def fetch_clickhouse_worker_logs(
    agent_id: str,
    start_time: datetime,
    end_time: Optional[datetime] = None,
    limit: int = 2000,
) -> List[str]:
    """Fetch retained Fly.io worker logs from ClickHouse for an agent_id."""
    if not (CLICKHOUSE_ENDPOINT and CLICKHOUSE_USER and CLICKHOUSE_PASSWORD):
        return []

    if end_time is None:
        end_time = datetime.now(timezone.utc)

    table = f"{CLICKHOUSE_DATABASE}.{CLICKHOUSE_TABLE}"
    query = f"""
SELECT raw
FROM {table}
WHERE ingested_at >= parseDateTime64BestEffort({{start:String}}, 3)
  AND ingested_at <= parseDateTime64BestEffort({{end:String}}, 3)
  AND (
    agent_id = {{agent_id:String}}
    OR raw LIKE concat('%', {{agent_id:String}}, '%')
    OR raw LIKE concat('%', {{short_id:String}}, '%')
  )
ORDER BY ingested_at ASC
LIMIT {{limit:UInt32}}
FORMAT JSONEachRow
"""

    params = {
        "param_start": start_time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "param_end": end_time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "param_agent_id": agent_id,
        "param_short_id": agent_id[:12],
        "param_limit": str(limit),
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                CLICKHOUSE_ENDPOINT,
                params=params,
                content=query,
                auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
            )
        if resp.status_code != 200:
            return [f"[clickhouse] API {resp.status_code}: {resp.text[:200]}"]

        logs: List[str] = []
        for line in resp.text.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            raw = row.get("raw")
            if isinstance(raw, str) and raw:
                logs.append(raw)
        return logs
    except Exception as e:
        return [f"[clickhouse] Error: {e}"]


async def _close_subprocess_transport(process: asyncio.subprocess.Process) -> None:
    """Close an exited subprocess's pipes while its event loop is still running.

    A cancelled reader leaves a full StreamReader paused, so the pipe never reads
    EOF and the transport stays open; garbage collection after ``asyncio.run``
    then closes it on a closed loop ("RuntimeError: Event loop is closed").
    """
    transport = getattr(process, "_transport", None)
    if transport is not None and not transport.is_closing():
        transport.close()
        await asyncio.sleep(0)


class FlyLogCollector:
    """
    Streams flyctl logs as a background process, captures all output.

    Uses the default (non-JSON) format which outputs one log entry per line:
        2026-03-17T20:10:11Z app[instance] region [level]{"event":"...","agent_id":"..."}

    This is more reliable than --json which outputs multi-line pretty-printed
    JSON, making line-by-line filtering unreliable.

    Usage:
        collector = FlyLogCollector()
        await collector.start()
        # ... run benchmark tasks ...
        logs = collector.get_logs_for_agent(agent_id)
        await collector.stop()

    Why streaming instead of --no-tail:
        flyctl logs --no-tail only returns the last ~30s of buffered logs,
        which is all health checks. By streaming for the duration of the
        benchmark run, we capture all worker logs including agent execution.
    """

    def __init__(self):
        self._process: Optional[asyncio.subprocess.Process] = None
        self._lines: List[str] = []  # raw log lines (one per entry)
        self._lock = threading.Lock()
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None

    async def start(self) -> str:
        """Start streaming flyctl logs in the background. Returns status message."""
        if not FLY_API_TOKEN:
            return "[fly.io] FLY_API_TOKEN not set in agents/.env — generate: flyctl tokens create deploy -a navi-whisper-lux"
        try:
            # Inject FLY_API_TOKEN into subprocess env so flyctl can authenticate
            env = {**os.environ, "FLY_API_TOKEN": FLY_API_TOKEN}
            # Use default format (not --json) — gives one line per log entry
            self._process = await asyncio.create_subprocess_exec(
                _find_flyctl(),
                "logs",
                "-a",
                FLY_APP_NAME,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            self._reader_task = asyncio.create_task(self._read_loop())
            self._stderr_task = asyncio.create_task(self._drain_stderr())
            return "fly.io log streaming started"
        except FileNotFoundError:
            return "[fly.io] flyctl not found — install: https://fly.io/docs/flyctl/install/"
        except Exception as e:
            return f"[fly.io] Failed to start log stream: {e}"

    async def _read_loop(self):
        """Read stdout lines into the buffer."""
        if not self._process or not self._process.stdout:
            return
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    break
                decoded = line.decode().strip()
                if decoded:
                    with self._lock:
                        self._lines.append(decoded)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def _drain_stderr(self):
        """Drain stderr to prevent pipe buffer from blocking the process."""
        if not self._process or not self._process.stderr:
            return
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    def get_logs_for_agent(self, agent_id: str, limit: Optional[int] = None) -> List[str]:
        """Filter captured logs for a specific agent_id.

        ``limit`` is accepted for backwards compatibility with older callers,
        but intentionally ignored. Benchmark diagnostics should preserve the
        full live stream so latency analysis is not biased by truncation.
        """
        with self._lock:
            snapshot = list(self._lines)

        filtered = []
        for raw_line in snapshot:
            if agent_id in raw_line or agent_id[:12] in raw_line:
                json_start = raw_line.find("{")
                if json_start >= 0:
                    json_part = raw_line[json_start:]
                    try:
                        parsed = json.loads(json_part)
                        filtered.append(json.dumps(parsed))
                    except (json.JSONDecodeError, TypeError):
                        filtered.append(raw_line)
                else:
                    filtered.append(raw_line)

        if not filtered:
            return [f"[fly.io] 0 logs for agent {agent_id[:12]} ({len(snapshot)} total captured)"]
        return filtered

    async def stop(self):
        """Stop the background flyctl process."""
        for task in (self._reader_task, self._stderr_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        if self._process:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self._process.kill()
                except ProcessLookupError:
                    pass
            await _close_subprocess_transport(self._process)
            self._process = None

    @property
    def total_lines(self) -> int:
        with self._lock:
            return len(self._lines)


# Module-level singleton — started/stopped by the benchmark harness
_fly_collector: Optional[FlyLogCollector] = None


async def start_fly_log_collector(*, backend_url: str) -> str:
    """Start the global Fly.io log collector. Call once before running tasks."""
    global _fly_collector
    if DISABLE_FLY_LOG_STREAM:
        _fly_collector = None
        return "[fly.io] disabled by BENCHMARK_DISABLE_FLY_LOG_STREAM"
    if not prod_log_sources_enabled(backend_url):
        _fly_collector = None
        return f"[fly.io] {_prod_logs_skipped_note(backend_url)}"
    _fly_collector = FlyLogCollector()
    return await _fly_collector.start()


async def fetch_flyio_logs_snapshot(agent_id: str) -> List[str]:
    """
    Fetch a one-shot snapshot of Fly.io logs via `flyctl logs --no-tail`.

    This supplements the streaming collector by capturing any logs still in
    the Fly buffer after a task completes. The streaming collector can miss
    logs if the connection goes idle or drops during long runs.
    """
    if DISABLE_FLY_LOG_STREAM or not FLY_API_TOKEN:
        return []
    try:
        env = {**os.environ, "FLY_API_TOKEN": FLY_API_TOKEN}
        proc = await asyncio.create_subprocess_exec(
            _find_flyctl(),
            "logs",
            "-a",
            FLY_APP_NAME,
            "--no-tail",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        finally:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
            await _close_subprocess_transport(proc)
        lines = stdout.decode().strip().splitlines()
        filtered = []
        for raw_line in lines:
            if agent_id in raw_line or agent_id[:12] in raw_line:
                json_start = raw_line.find("{")
                if json_start >= 0:
                    json_part = raw_line[json_start:]
                    try:
                        parsed = json.loads(json_part)
                        filtered.append(json.dumps(parsed))
                    except (json.JSONDecodeError, TypeError):
                        filtered.append(raw_line)
                else:
                    filtered.append(raw_line)
        return filtered
    except Exception:
        return []


def get_flyio_logs_for_agent(agent_id: str) -> List[str]:
    """Get Fly.io logs for an agent from the streaming collector."""
    if _fly_collector is None:
        if DISABLE_FLY_LOG_STREAM:
            return ["[fly.io] disabled by BENCHMARK_DISABLE_FLY_LOG_STREAM"]
        return ["[fly.io] Log collector not started — call start_fly_log_collector() first"]
    return _fly_collector.get_logs_for_agent(agent_id)


async def stop_fly_log_collector():
    """Stop the global Fly.io log collector. Call after all tasks complete."""
    global _fly_collector
    if _fly_collector:
        total = _fly_collector.total_lines
        await _fly_collector.stop()
        _fly_collector = None
        return total
    return 0


# ---------------------------------------------------------------------------
# Supabase Realtime broadcast frames — real-time streaming collector
# ---------------------------------------------------------------------------


def _record_from_realtime_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    body = payload.get("payload", payload)
    if not isinstance(body, dict):
        return {}
    record = body.get("record", body)
    return record if isinstance(record, dict) else {}


class SupabaseRealtimeLogCollector:
    """Capture agent:{id} broadcast frames during benchmark runs."""

    EVENTS = ("INSERT", "UPDATE", "DELETE", "ASSISTANT_STREAM", "TOOL_STREAM", "PLAN_STREAM", "ATTENTION_STREAM")

    def __init__(self, *, private: bool):
        self.private = private
        self._client: Any = None
        self._channels: Dict[str, Any] = {}
        self._frames: List[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._startup_error: Optional[str] = None

    async def start(self) -> str:
        if not SUPABASE_URL or not SUPABASE_ANON_KEY:
            self._startup_error = "SUPABASE_URL and SUPABASE_ANON_KEY are required"
            return f"[supabase-realtime] {self._startup_error}"

        try:
            from realtime import AsyncRealtimeClient

            try:
                from tests.e2e.test_helpers import authenticate

                auth = await authenticate()
                access_token = auth.get("access_token") or SUPABASE_ANON_KEY
            except Exception:
                access_token = SUPABASE_ANON_KEY

            realtime_url = f"{SUPABASE_URL.rstrip('/')}/realtime/v1"
            self._client = AsyncRealtimeClient(realtime_url, token=SUPABASE_ANON_KEY, timeout=10)
            await self._client.set_auth(access_token)
            return "supabase realtime frame collector started"
        except Exception as exc:
            self._startup_error = str(exc)
            return f"[supabase-realtime] Failed to start frame collector: {exc}"

    async def subscribe_agent(self, agent_id: str) -> str:
        if not agent_id:
            return "[supabase-realtime] empty agent_id"
        if self._startup_error:
            return f"[supabase-realtime] {self._startup_error}"
        if self._client is None:
            return "[supabase-realtime] collector not started"
        if agent_id in self._channels:
            return f"already subscribed to agent:{agent_id[:12]}"

        from realtime import RealtimeSubscribeStates

        subscribed = asyncio.Event()
        error_holder: dict[str, str] = {}
        channel = self._client.channel(
            f"agent:{agent_id}",
            {"config": {"private": self.private}},
        )

        for event_name in self.EVENTS:
            channel.on_broadcast(
                event_name,
                lambda payload, name=event_name, aid=agent_id: self.record_broadcast(aid, name, payload),
            )

        def on_subscribe(status: RealtimeSubscribeStates, error: Optional[Exception]) -> None:
            if status == RealtimeSubscribeStates.SUBSCRIBED:
                subscribed.set()
                return
            error_holder["error"] = str(error or f"subscription status {status.value}")
            subscribed.set()

        await channel.subscribe(on_subscribe)
        await asyncio.wait_for(subscribed.wait(), timeout=15)
        if error_holder:
            return f"[supabase-realtime] subscribe agent:{agent_id[:12]} failed: {error_holder['error']}"
        self._channels[agent_id] = channel
        return f"subscribed to agent:{agent_id[:12]}"

    def record_broadcast(self, agent_id: str, event: str, payload: Any) -> None:
        record = _record_from_realtime_payload(payload)
        frame_agent_id = str(record.get("agentId") or agent_id)
        frame = {
            "received_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": frame_agent_id,
            "topic": f"agent:{agent_id}",
            "event": event,
            "record": record,
        }
        with self._lock:
            self._frames.append(frame)

    def get_logs_for_agent(self, agent_id: str) -> List[str]:
        with self._lock:
            frames = [
                frame
                for frame in self._frames
                if frame.get("agent_id") == agent_id or str(frame.get("agent_id", "")).startswith(agent_id[:12])
            ]
            total = len(self._frames)

        if not frames:
            return [f"[supabase-realtime] 0 frames for agent {agent_id[:12]} ({total} total captured)"]
        return [json.dumps(frame, default=str, separators=(",", ":")) for frame in frames]

    async def stop(self) -> int:
        for channel in list(self._channels.values()):
            try:
                await channel.unsubscribe()
            except Exception:
                pass
        self._channels.clear()
        with self._lock:
            return len(self._frames)


_supabase_realtime_collector: Optional[SupabaseRealtimeLogCollector] = None


async def start_supabase_realtime_collector(*, private: bool) -> str:
    global _supabase_realtime_collector
    _supabase_realtime_collector = SupabaseRealtimeLogCollector(private=private)
    return await _supabase_realtime_collector.start()


async def subscribe_supabase_realtime_agent(agent_id: str) -> str:
    if _supabase_realtime_collector is None:
        return "[supabase-realtime] collector not started"
    return await _supabase_realtime_collector.subscribe_agent(agent_id)


def get_supabase_realtime_logs_for_agent(agent_id: str) -> List[str]:
    if _supabase_realtime_collector is None:
        return ["[supabase-realtime] collector not started"]
    return _supabase_realtime_collector.get_logs_for_agent(agent_id)


async def stop_supabase_realtime_collector() -> int:
    global _supabase_realtime_collector
    if _supabase_realtime_collector is None:
        return 0
    total = await _supabase_realtime_collector.stop()
    _supabase_realtime_collector = None
    return total


# ---------------------------------------------------------------------------
# Supabase edge function logs (Management API — gateway-level)
# ---------------------------------------------------------------------------


async def fetch_supabase_logs(
    agent_id: str,
    start_time: datetime,
    end_time: Optional[datetime] = None,
    limit: int = 200,
) -> List[str]:
    """
    Fetch Supabase gateway logs for completions edge function invocations.

    Note: The completions function doesn't log agent_id. We filter for
    requests to /functions/v1/completions within the time window. These
    are correlated by timestamp, not by agent_id.
    """
    if not SUPABASE_ACCESS_TOKEN:
        return [
            "[supabase] SUPABASE_ACCESS_TOKEN not set in agents/.env — generate: https://supabase.com/dashboard/account/tokens"
        ]
    if not SUPABASE_PROJECT_REF:
        return ["[supabase] SUPABASE_PROJECT_REF not set and SUPABASE_URL names no Supabase project"]

    if end_time is None:
        end_time = datetime.now(timezone.utc)

    headers = {
        "Authorization": f"Bearer {SUPABASE_ACCESS_TOKEN}",
    }

    params = {
        "iso_timestamp_start": start_time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "iso_timestamp_end": end_time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all",
                headers=headers,
                params=params,
            )
            if resp.status_code != 200:
                return [f"[supabase] API {resp.status_code}: {resp.text[:200]}"]

            data = resp.json()
            results = data.get("result", data) if isinstance(data, dict) else data
            if not isinstance(results, list):
                return [f"[supabase] Unexpected response: {str(data)[:200]}"]

            # Filter for completions-related requests (gateway-level)
            filtered = []
            for entry in results:
                msg = ""
                if isinstance(entry, dict):
                    msg = entry.get("event_message", "") or entry.get("message", "") or json.dumps(entry)
                else:
                    msg = str(entry)

                # Match completions edge function invocations and REST API queries
                # that are related to Rose model infrastructure
                if any(kw in msg for kw in ("completions", "RoseApiKey", "functions/v1")):
                    filtered.append(msg)

            if not filtered:
                return [f"[supabase] 0 completions logs in window ({len(results)} total gateway entries)"]
            return filtered[:limit]

    except Exception as e:
        return [f"[supabase] Error: {e}"]


# ---------------------------------------------------------------------------
# Canonical logs.tree (agent-id → parent/goal/status/messages)
# ---------------------------------------------------------------------------

# `/api/tool-usage/tree` returns a cost-rollup object. A previous Hub upload
# stuffed that shape into `logs.tree`, so getRunAgent keyed nodes as
# `agent_count` / `tool_usage_count` and every for_each child rendered as
# "spinning up..." with message_count=0.
TOOL_USAGE_TREE_KEYS = frozenset(
    {
        "root_agent_id",
        "agent_count",
        "tool_usage_count",
        "llm_call_count",
        "tokens_in",
        "tokens_out",
        "total_cost_cents",
        "total_cost_dollars",
        "total_tokens_from_tools",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    }
)


def canonicalize_agent_tree(raw: Any) -> Dict[str, dict]:
    """Keep only agent-id-keyed nodes with parent/goal/status/messages.

    Drops tool-usage rollup keys and any non-dict values so archive/Hub
    adapters never invent empty chips from `/api/tool-usage/tree`.
    """
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, dict] = {}
    for key, value in raw.items():
        if not key or key in TOOL_USAGE_TREE_KEYS or not isinstance(value, dict):
            continue
        if not (
            isinstance(value.get("messages"), list)
            or "parent_agent_id" in value
            or isinstance(value.get("goal"), str)
            or isinstance(value.get("status"), str)
        ):
            continue
        out[str(key)] = value
    return out


def tree_child_transcript_count(tree: Any, root_id: Optional[str]) -> int:
    """How many non-root tree nodes carry at least one message."""
    canonical = canonicalize_agent_tree(tree)
    return sum(
        1
        for agent_id, info in canonical.items()
        if agent_id != root_id and isinstance(info.get("messages"), list) and info["messages"]
    )


# ---------------------------------------------------------------------------
# Message transcript (from agent GET response)
# ---------------------------------------------------------------------------


def extract_message_transcript(agent_data: dict) -> List[dict]:
    messages = agent_data.get("messages", [])
    transcript = []
    for msg in messages:
        entry = {
            "role": msg.get("role", "UNKNOWN"),
            "message": msg.get("text") or msg.get("message", ""),
            "created_at": msg.get("timestamp") or msg.get("createdAt") or msg.get("created_at", ""),
        }
        metadata = msg.get("metadata")
        if metadata:
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except Exception:
                    pass
            entry["metadata"] = metadata
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        if file_pointer:
            entry["file_pointer"] = file_pointer
        transcript.append(entry)
    return transcript


def _infer_output_schema_type(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, list):
        if value and all(isinstance(item, dict) for item in value):
            return "list[object]"
        if value and all(isinstance(item, int) and not isinstance(item, bool) for item in value):
            return "list[int]"
        return "list[str]"
    if isinstance(value, dict):
        return "object"
    return "str"


def completion_outputs_from_messages(messages: Optional[List[dict]]) -> List[dict]:
    """Last Task Complete `outputs[]` from a transcript (Hub/archive hydrate)."""
    for message in reversed(messages or []):
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        summary = metadata.get("completionSummary") or metadata.get("completion_summary") or {}
        if not isinstance(summary, dict):
            continue
        outputs = summary.get("outputs")
        if isinstance(outputs, list) and outputs:
            return [row for row in outputs if isinstance(row, dict)]
    return []


def schema_from_completion_outputs(outputs: List[dict]) -> Optional[dict]:
    fields: List[dict] = []
    for row in outputs:
        name = str(row.get("key") or row.get("name") or "")
        if not name:
            continue
        label = str(row.get("label") or name.replace("_", " "))
        fields.append(
            {
                "name": name,
                "type": _infer_output_schema_type(row.get("value")),
                "required": True,
                "description": label,
            }
        )
    return {"fields": fields} if fields else None


def structured_from_completion_outputs(outputs: List[dict]) -> Optional[dict]:
    populated: Dict[str, Any] = {}
    for row in outputs:
        name = str(row.get("key") or row.get("name") or "")
        if name:
            populated[name] = row.get("value")
    return populated or None


# ---------------------------------------------------------------------------
# Collect all logs for a single agent
# ---------------------------------------------------------------------------


async def collect_logs(
    agent_id: str,
    agent_data: dict,
    start_time: datetime,
    research_logs: Optional[List[str]] = None,
    *,
    backend_url: str,
) -> dict:
    """
    Collect all available logs for a benchmark agent.

    ``backend_url`` is the backend that served the agent. Production log APIs
    are queried only when it is not a loopback stack (see
    ``prod_log_sources_enabled``).

    Returns:
        {
            "messages":       [...],  # Full message transcript
            "backend_logs":   [...],  # Render backend HTTP logs
            "worker_logs":    [...],  # Fly.io agent worker logs (ClickHouse + live stream)
            "research_logs":  [...],  # Supabase completions gateway logs (by time window)
            "realtime_logs":  [...],  # Supabase Realtime frames captured live
        }
    """
    messages = extract_message_transcript(agent_data)
    realtime_logs = get_supabase_realtime_logs_for_agent(agent_id)

    # Local isolated stacks write worker*.log under BENCHMARK_CONTEXT_DIR / NAVI_WORKER_LOGS.
    # Prefer those over remote placeholders so Claude Code tool_use / SDK progress is retained
    # in the run JSON (prod ClickHouse/Fly often empty or DNS-fail on cloud VMs).
    local_worker_logs = fetch_local_worker_logs(agent_id, start_time)

    if not prod_log_sources_enabled(backend_url):
        skipped = _prod_logs_skipped_note(backend_url)
        return {
            "messages": messages,
            "backend_logs": [f"[render] {skipped}"],
            "worker_logs": local_worker_logs or [f"[local-worker] 0 logs for agent {agent_id[:12]}"],
            "research_logs": research_logs if research_logs is not None else [f"[supabase] {skipped}"],
            "realtime_logs": realtime_logs,
        }

    # Fly.io logs: merge retained ClickHouse rows + streaming collector + one-shot snapshot (deduped)
    stream_logs = get_flyio_logs_for_agent(agent_id)
    snapshot_logs, clickhouse_logs = await asyncio.gather(
        fetch_flyio_logs_snapshot(agent_id),
        fetch_clickhouse_worker_logs(agent_id, start_time),
    )
    # Deduplicate: local first (authoritative for local/cloudbench), then remote.
    seen = set()
    worker_logs = []
    for log in local_worker_logs + clickhouse_logs + stream_logs + snapshot_logs:
        if _is_remote_worker_log_placeholder(log):
            continue
        if log not in seen:
            seen.add(log)
            worker_logs.append(log)
    if not worker_logs:
        if local_worker_logs:
            # Local read returned only error placeholders — keep them visible.
            worker_logs = list(local_worker_logs)
        else:
            stream_total = _fly_collector.total_lines if _fly_collector else 0
            remote_errors = [
                log
                for log in clickhouse_logs + snapshot_logs
                if _is_remote_worker_log_placeholder(log)
            ]
            worker_logs = remote_errors or [
                f"[fly.io] 0 logs for agent {agent_id[:12]} "
                f"(0 local + {len(clickhouse_logs)} clickhouse + {stream_total} streamed "
                f"+ {len(snapshot_logs)} snapshot)"
            ]

    # Render logs are agent-filtered. Supabase gateway logs are only
    # time-window scoped, so tree diagnostics may prefetch and reuse them.
    if research_logs is None:
        backend_logs, research_logs = await asyncio.gather(
            fetch_render_logs(agent_id, start_time),
            fetch_supabase_logs(agent_id, start_time),
        )
    else:
        backend_logs = await fetch_render_logs(agent_id, start_time)

    return {
        "messages": messages,
        "backend_logs": backend_logs,
        "worker_logs": worker_logs,
        "research_logs": research_logs,
        "realtime_logs": realtime_logs,
    }


async def collect_tree_messages(
    root_agent_id: str,
    tree_agents: List[dict],
    get_agent_fn,
    max_concurrency: int = 8,
) -> Dict[str, dict]:
    """Per-agent MESSAGES + structure for an entire tree — for archive rendering
    of the fan-out (root + all spawned sub-agents).

    This is the lightweight sibling of ``collect_tree_logs``: the archive only
    needs each agent's message thread + parent link + goal/status to render the
    spawn tree, NOT the per-agent backend/worker/realtime log fetches (which cost
    4 API round-trips × N agents — prohibitive for a 50-100 agent fan-out).

    Args:
        root_agent_id: The tree root (busId).
        tree_agents: Agent dicts from GET /api/agents/tree?busId=root (each has
                     agent_id, parent_agent_id, goal, status).
        get_agent_fn: Async callable(agent_id) -> agent_data (for the transcript).
        max_concurrency: Cap on concurrent per-agent fetches.

    Returns:
        {"<agent_id>": {"parent_agent_id", "goal", "status", "messages"}, ...}
        keyed by EVERY agent in the tree (including the root).
    """
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(agent_info: dict):
        aid = str(agent_info.get("agent_id") or "")
        if not aid:
            return None
        async with sem:
            try:
                agent_data = await get_agent_fn(aid)
            except Exception:
                agent_data = {}
        agent_obj = agent_data.get("agent", agent_data) if isinstance(agent_data, dict) else {}
        messages = extract_message_transcript(agent_data)
        outputs = completion_outputs_from_messages(messages)
        return aid, {
            "parent_agent_id": agent_info.get("parent_agent_id"),
            "goal": (agent_info.get("goal") or "")[:200],
            "status": agent_info.get("status") or agent_obj.get("status") or "UNKNOWN",
            "messages": messages,
            "response_schema": agent_obj.get("response_schema")
            or schema_from_completion_outputs(outputs),
            "structured_output": agent_obj.get("structured_output")
            or structured_from_completion_outputs(outputs),
            "tokens_in": agent_obj.get("tokens_in") or agent_obj.get("tokensIn") or 0,
            "tokens_out": agent_obj.get("tokens_out") or agent_obj.get("tokensOut") or 0,
            "context_size": agent_obj.get("context_size") or agent_obj.get("contextSize") or 0,
        }

    results = await asyncio.gather(*[_one(a) for a in tree_agents], return_exceptions=True)
    tree: Dict[str, dict] = {}
    for r in results:
        if isinstance(r, BaseException) or not r:
            continue
        aid, info = r
        tree[aid] = info
    return tree


# ---------------------------------------------------------------------------
# Collect logs for an entire agent tree (root + all descendants)
# ---------------------------------------------------------------------------


async def collect_tree_logs(
    root_agent_id: str,
    tree_agents: List[dict],
    start_time: datetime,
    get_agent_fn=None,
    *,
    backend_url: str,
) -> Dict[str, dict]:
    """
    Collect logs for every agent in a tree.

    Args:
        root_agent_id: The root agent ID (also used as busId).
        tree_agents: List of agent dicts from GET /api/agents/tree?busId=X.
                     Each has: agent_id, parent_agent_id, goal, status.
        start_time: When the benchmark started (for time-window log queries).
        get_agent_fn: Async callable(agent_id) -> agent_data dict.
                      Used to fetch full message transcripts per agent.
        backend_url: Backend that served the tree (gates production log APIs).

    Returns:
        {
            "<agent_id>": {
                "parent_agent_id": str | None,
                "goal": str,
                "status": str,
                "logs": { messages, backend_logs, worker_logs, research_logs }
            },
            ...
        }
    """
    if prod_log_sources_enabled(backend_url):
        tree_research_logs = await fetch_supabase_logs(root_agent_id, start_time)
    else:
        tree_research_logs = [f"[supabase] {_prod_logs_skipped_note(backend_url)}"]
    child_research_logs = [
        f"[supabase] Gateway logs are tree-scoped; see root agent {root_agent_id[:12]} research logs"
    ]

    async def _collect_one(agent_info: dict) -> tuple:
        aid = agent_info.get("agent_id", "")
        if not aid:
            return None, None

        agent_data = {}
        if get_agent_fn:
            try:
                agent_data = await get_agent_fn(aid)
            except Exception:
                pass

        logs = await collect_logs(
            aid,
            agent_data,
            start_time,
            research_logs=tree_research_logs if aid == root_agent_id else child_research_logs,
            backend_url=backend_url,
        )

        # Extract agent state from the full agent response
        agent_obj = agent_data.get("agent", agent_data) if isinstance(agent_data, dict) else {}
        agent_state = {
            "tokens_in": agent_obj.get("tokens_in") or agent_obj.get("tokensIn", 0),
            "tokens_out": agent_obj.get("tokens_out") or agent_obj.get("tokensOut", 0),
            "token_count": agent_obj.get("token_count") or agent_obj.get("tokenCount", 0),
            "context_size": agent_obj.get("context_size") or agent_obj.get("contextSize", 0),
            "tree_cost_cents": agent_info.get("tree_cost_cents", 0),
            "status_message": agent_obj.get("status_message") or agent_obj.get("statusMessage", ""),
            "tools_in_use": agent_info.get("tools_in_use", []),
            "structured_output": agent_info.get("structured_output"),
        }

        return aid, {
            "parent_agent_id": agent_info.get("parent_agent_id"),
            "goal": (agent_info.get("goal") or "")[:200],
            "status": agent_info.get("status", "UNKNOWN"),
            "agent_state": agent_state,
            "logs": logs,
        }

    # Fetch all agent logs in parallel — return_exceptions so one failure doesn't kill all
    results = await asyncio.gather(*[_collect_one(a) for a in tree_agents], return_exceptions=True)

    result: Dict[str, dict] = {}
    for r in results:
        if isinstance(r, BaseException):
            continue
        aid, info = r
        if aid is not None:
            result[aid] = info

    return result


def _detect_anomalies(msgs: List[dict]) -> List[str]:
    """Detect message patterns that indicate bugs (infinite loops, repeated content, stalls, etc.)."""
    from collections import Counter

    anomalies = []

    # 1. Detect repeated identical messages (infinite loop) — scan ALL messages, not just last 20
    all_texts = [m.get("message", "") for m in msgs if m.get("message")]
    if len(all_texts) >= 5:
        counts = Counter(all_texts)
        for text, count in counts.most_common(3):
            if count >= 4:
                anomalies.append(f"INFINITE LOOP: message repeated {count}x (total): {text[:80]}")

    # 2. Detect tools stuck IN_PROGRESS without FINISHED
    # Spawn tools are inherently long-running (sub-agents have their own anomaly detection).
    # Verifier-feedback rows are tagged metadata.verifierMessage=True (and now
    # ride under toolName="attempt_completion"); skip those instead of relying
    # on the old check_progress toolName.
    _LONG_RUNNING_TOOLS = {
        "spawn_agent",
        "spawn_sub_agent",
        "spawn_sub_agent_for_each",
        "spawn_claude_code_agent",
        "spawn_browser_agent",
        "set_plan",
        "message_person",
        "request_user_approval",
    }
    in_progress = {}  # tool_call_id → metadata
    for m in msgs:
        meta = m.get("metadata", {})
        if not isinstance(meta, dict):
            continue
        # Verifier rows post IN_PROGRESS + FINISHED in tight succession; ignore
        # them entirely so they never get flagged as stuck.
        if meta.get("verifierMessage"):
            continue
        tcid = meta.get("toolCallId") or meta.get("tool_call_id", "")
        status = meta.get("toolStatus", "")
        tool_name = meta.get("toolName", "")
        if status == "IN_PROGRESS" and tcid and tool_name not in _LONG_RUNNING_TOOLS:
            in_progress[tcid] = meta
        elif status in ("FINISHED", "ERROR") and tcid:
            in_progress.pop(tcid, None)
    if in_progress:
        for tcid, meta in list(in_progress.items())[:5]:
            tool = meta.get("toolName", "?")
            anomalies.append(f"STUCK: {tool} (call {tcid[:12]}) still IN_PROGRESS")

    # 3. Detect large time gaps between messages (stalled LLM calls, hung activities)
    timestamps = []
    for m in msgs:
        ts = m.get("created_at", "")
        if ts:
            try:
                from datetime import datetime

                # Handle both "2026-03-20T20:28:51.907Z" and other ISO formats
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                timestamps.append(dt)
            except (ValueError, TypeError):
                pass
    if len(timestamps) >= 2:
        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i - 1]).total_seconds()
            if gap > 180:  # 3+ minute gap
                anomalies.append(f"TIME GAP: {gap:.0f}s ({gap / 60:.1f}min) between messages {i - 1} and {i}")

    # 4. Detect abnormal tool distribution (one tool called way too many times)
    tool_names = []
    for m in msgs:
        meta = m.get("metadata", {})
        if isinstance(meta, dict) and meta.get("toolStatus") == "FINISHED":
            tool_names.append(meta.get("toolName", "?"))
    if tool_names:
        tool_counts = Counter(tool_names)
        for tool, count in tool_counts.most_common(3):
            if count >= 15:
                anomalies.append(f"HIGH TOOL COUNT: {tool} called {count}x")

    return anomalies


def format_tree_diagnostics(
    tree_logs: Dict[str, dict],
    root_agent_id: str,
) -> str:
    """
    Format tree logs into a human-readable diagnostic string.
    Shows agent hierarchy with status, errors, anomalies, and agent state.
    """
    lines = []
    lines.append("=" * 60)
    lines.append("  AGENT TREE DIAGNOSTICS")
    lines.append("=" * 60)

    # Build parent→children map
    children_map: Dict[Optional[str], List[str]] = {}
    for aid, info in tree_logs.items():
        parent = info.get("parent_agent_id")
        children_map.setdefault(parent, []).append(aid)

    visited: set = set()

    def _normalized_log_text(log_line: Any) -> str:
        if not isinstance(log_line, str):
            return ""
        try:
            outer = json.loads(log_line)
        except json.JSONDecodeError:
            return log_line

        if not isinstance(outer, dict):
            return log_line

        message = outer.get("message")
        if isinstance(message, str) and message.startswith("{"):
            try:
                inner = json.loads(message)
            except json.JSONDecodeError:
                return message
            if isinstance(inner, dict):
                return json.dumps(inner, separators=(",", ":"), default=str)
        return json.dumps(outer, separators=(",", ":"), default=str)

    def _scan_log_errors(log_list: List, source_name: str) -> List[str]:
        found = []
        for log_line in log_list:
            text = _normalized_log_text(log_line)
            lower = text.lower()
            if any(
                kw in lower
                for kw in (
                    '"level":"error"',
                    '"event":"error"',
                    "traceback",
                    "exception",
                    "error:",
                    "failed",
                    '"status":500',
                    '"status":502',
                    '"status":503',
                    " status=500",
                    " status=502",
                    " status=503",
                )
            ):
                found.append(f"[{source_name}] {text[:200]}")
        return found

    def _walk(agent_id: str, depth: int = 0):
        if agent_id in visited:
            indent = "  " * (depth + 1)
            lines.append(f"{indent}⚠ cycle detected: {agent_id[:12]} already visited")
            return
        visited.add(agent_id)
        info = tree_logs.get(agent_id, {})
        status = info.get("status", "?")
        goal = info.get("goal", "")[:80]
        indent = "  " * (depth + 1)
        prefix = "└─" if depth > 0 else "●"

        # Status icon
        icon = {
            "COMPLETED": "✅",
            "FAILED": "❌",
            "PAUSED": "⏸",
            "COST_LIMIT_REACHED": "💸",
            "OUT_OF_CREDITS": "💸",
        }.get(status, "🔄")

        # Agent state line (tokens, cost)
        state = info.get("agent_state", {})
        tokens_in = state.get("tokens_in", 0)
        tokens_out = state.get("tokens_out", 0)
        cost = state.get("tree_cost_cents", 0)
        status_msg = state.get("status_message", "")

        lines.append(f"{indent}{prefix} {icon} {agent_id[:12]}  [{status}]  {goal}")
        state_parts = []
        if tokens_in or tokens_out:
            state_parts.append(f"tokens={tokens_in}in/{tokens_out}out")
        if cost:
            state_parts.append(f"cost={cost}c")
        if status_msg:
            state_parts.append(f"status_msg={status_msg[:80]}")
        tools_in_use = state.get("tools_in_use", [])
        if tools_in_use:
            state_parts.append(f"active_tools=[{', '.join(tools_in_use)}]")
        if state_parts:
            lines.append(f"{indent}   📊 {', '.join(state_parts)}")

        logs = info.get("logs", {})

        worker = logs.get("worker_logs", [])
        backend = logs.get("backend_logs", [])
        research = logs.get("research_logs", [])
        realtime = logs.get("realtime_logs", [])

        all_log_errors = (
            _scan_log_errors(worker, "worker")
            + _scan_log_errors(backend, "backend")
            + _scan_log_errors(research, "research")
            + _scan_log_errors(realtime, "realtime")
        )
        if all_log_errors:
            lines.append(f"{indent}   ⚠ {len(all_log_errors)} error(s) in prod logs:")
            for err in all_log_errors[:5]:
                lines.append(f"{indent}     {err}")

        # Show message breakdown
        msgs = logs.get("messages", [])
        if msgs:
            from collections import Counter

            tool_msgs = [m for m in msgs if m.get("role") == "TOOL"]
            error_tools = [
                m
                for m in tool_msgs
                if isinstance(m.get("metadata"), dict) and m["metadata"].get("toolStatus") == "ERROR"
            ]
            assistant_msgs = [m for m in msgs if m.get("role") == "ASSISTANT"]
            file_msgs = [m for m in msgs if m.get("file_pointer")]

            parts = [f"{len(msgs)} messages"]
            parts.append(f"{len(tool_msgs)} tool")
            parts.append(f"{len(error_tools)} errors")
            if assistant_msgs:
                parts.append(f"{len(assistant_msgs)} assistant")
            if file_msgs:
                parts.append(f"{len(file_msgs)} files")
            lines.append(f"{indent}   📨 {', '.join(parts)}")

            # Tool distribution breakdown (spot abnormal patterns)
            tool_names = [
                m.get("metadata", {}).get("toolName", "?") for m in tool_msgs if isinstance(m.get("metadata"), dict)
            ]
            if tool_names:
                tool_dist = Counter(tool_names).most_common()
                dist_str = ", ".join(f"{name}={cnt}" for name, cnt in tool_dist)
                lines.append(f"{indent}   🔧 Tools: {dist_str}")

            # Show ALL tool errors with full text
            for et in error_tools:
                tool_name = et.get("metadata", {}).get("toolName", "?")
                msg_text = (et.get("message") or "")[:200]
                lines.append(f"{indent}     ❌ {tool_name}: {msg_text}")

            # Show last assistant message (agent's reasoning/status)
            if assistant_msgs:
                last_asst = assistant_msgs[-1].get("message", "")
                if last_asst:
                    lines.append(f"{indent}   💬 Last assistant: {last_asst[:200]}")

            # Show recent activity tail (last 5 messages for live context)
            recent = msgs[-5:]
            lines.append(f"{indent}   📋 Recent activity:")
            for m in recent:
                role = m.get("role", "?")
                text = (m.get("message") or "")[:120]
                meta = m.get("metadata", {})
                tool_tag = ""
                if isinstance(meta, dict):
                    tn = meta.get("toolName", "")
                    ts = meta.get("toolStatus", "")
                    if tn:
                        tool_tag = f" [{tn}/{ts}]"
                lines.append(f"{indent}     {role}{tool_tag}: {text}")

            # Detect anomalies (infinite loops, stuck tools, time gaps, high tool counts)
            anomalies = _detect_anomalies(msgs)
            for a in anomalies:
                lines.append(f"{indent}   🚨 {a}")

        for child_id in children_map.get(agent_id, []):
            _walk(child_id, depth + 1)

    # Start from root
    _walk(root_agent_id)

    lines.append("")
    lines.append(f"  Total agents in tree: {len(tree_logs)}")
    failed = [
        aid
        for aid, info in tree_logs.items()
        if info.get("status") in ("FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED")
    ]
    if failed:
        lines.append(f"  Failed agents: {', '.join(a[:12] for a in failed)}")

    verdict_reasons = []
    for aid, info in tree_logs.items():
        short = aid[:12]
        status = info.get("status", "")
        if status in ("FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"):
            verdict_reasons.append(f"{short} status={status}")

        logs = info.get("logs", {})
        log_errors = (
            _scan_log_errors(logs.get("worker_logs", []), "worker")
            + _scan_log_errors(logs.get("backend_logs", []), "backend")
            + _scan_log_errors(logs.get("research_logs", []), "research")
        )
        for err in log_errors[:3]:
            verdict_reasons.append(f"{short} {err}")

        msgs = logs.get("messages", [])
        for m in msgs:
            meta = m.get("metadata", {})
            if isinstance(meta, dict) and meta.get("toolStatus") == "ERROR":
                tool = meta.get("toolName", "?")
                verdict_reasons.append(f"{short} ❌ {tool} ERROR")

        for anomaly in _detect_anomalies(msgs):
            verdict_reasons.append(f"{short} {anomaly}")

    lines.append("")
    if verdict_reasons:
        lines.append(f"  🔴 ACTION REQUIRED — {'; '.join(verdict_reasons[:5])}")
    else:
        lines.append("  🟢 HEALTHY")
    lines.append("=" * 60)

    return "\n".join(lines)
