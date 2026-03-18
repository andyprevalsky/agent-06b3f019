"""
Fetch production logs for benchmark agents.

Log sources:
  1. Render   — backend HTTP logs (REST API, needs RENDER_API_KEY in back-end/.env)
  2. Fly.io   — agent worker logs (real-time stream via flyctl, needs FLY_API_TOKEN in agents/.env)
  3. Supabase — edge function gateway logs (Management API, needs SUPABASE_ACCESS_TOKEN in agents/.env)
  4. Messages — full agent message transcript (from agent GET response, always available)

Token locations:
  - RENDER_API_KEY:        back-end/.env
  - FLY_API_TOKEN:         agents/.env  (generate: flyctl tokens create deploy -a navi-whisper-lux)
  - SUPABASE_ACCESS_TOKEN: agents/.env  (generate: https://supabase.com/dashboard/account/tokens)

Fly.io note:
  flyctl logs --no-tail only returns ~30s of buffered logs (mostly health checks).
  Instead, FlyLogCollector streams flyctl logs --json as a background process for
  the entire benchmark run, capturing all worker logs in real-time, then filters
  by agent_id after each task completes.

Supabase note:
  The completions edge function doesn't log agent_id. The Management API logs.all
  endpoint returns gateway-level HTTP logs (method/status/URL). We filter for
  requests to /functions/v1/completions within the agent's time window.
"""

import asyncio
import json
import os
import threading
from datetime import datetime, timezone
from typing import List, Optional

import httpx

# ---------------------------------------------------------------------------
# Config — load from env, fall back to .env files
# ---------------------------------------------------------------------------

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")


def load_env_var(name: str, *env_files: str) -> str:
    """Load a var from os.environ, falling back to .env files."""
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
                        val = val[:val.index(" #")].rstrip()
                    return val
    return ""


# Render (backend on Render)
RENDER_API_KEY = load_env_var("RENDER_API_KEY", _BACKEND_ENV)
RENDER_SERVICE_ID = load_env_var("RENDER_SERVICE_ID", _BACKEND_ENV) or "srv-d3jga77diees73cgrvk0"
RENDER_OWNER_ID = load_env_var("RENDER_OWNER_ID", _BACKEND_ENV) or "tea-csppgi56l47c73djvpig"

# Fly.io (agent worker on Fly.io)
FLY_API_TOKEN = load_env_var("FLY_API_TOKEN", _AGENTS_ENV)
FLY_APP_NAME = "navi-whisper-lux"

# Supabase (edge functions — completions, cost, etc.)
SUPABASE_ACCESS_TOKEN = load_env_var("SUPABASE_ACCESS_TOKEN", _AGENTS_ENV)
SUPABASE_PROJECT_REF = load_env_var("SUPABASE_PROJECT_REF", _AGENTS_ENV) or "kzlurqihzaolhzsbkctf"


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
            resp = await client.get(
                "https://api.render.com/v1/logs", headers=headers, params=params
            )
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
                "flyctl", "logs", "-a", FLY_APP_NAME,
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

    def get_logs_for_agent(self, agent_id: str, limit: int = 200) -> List[str]:
        """Filter captured logs for a specific agent_id."""
        with self._lock:
            snapshot = list(self._lines)

        filtered = []
        for raw_line in snapshot:
            # Default format: "timestamp app[instance] region [level]{structlog JSON}"
            # The structlog JSON contains "agent_id": "<uuid>" when an agent is running.
            # We search the entire line for the agent_id.
            if agent_id in raw_line or agent_id[:12] in raw_line:
                # Extract the JSON portion from the line for cleaner output
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
        return filtered[:limit]

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
            # Drain pipes to prevent ResourceWarning on GC
            if self._process.stdout:
                self._process.stdout.feed_eof()
            if self._process.stderr:
                self._process.stderr.feed_eof()
            self._process = None

    @property
    def total_lines(self) -> int:
        with self._lock:
            return len(self._lines)


# Module-level singleton — started/stopped by the benchmark harness
_fly_collector: Optional[FlyLogCollector] = None


async def start_fly_log_collector() -> str:
    """Start the global Fly.io log collector. Call once before running tasks."""
    global _fly_collector
    _fly_collector = FlyLogCollector()
    return await _fly_collector.start()


def get_flyio_logs_for_agent(agent_id: str) -> List[str]:
    """Get Fly.io logs for an agent from the streaming collector."""
    if _fly_collector is None:
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
        return ["[supabase] SUPABASE_ACCESS_TOKEN not set in agents/.env — generate: https://supabase.com/dashboard/account/tokens"]

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
# Message transcript (from agent GET response)
# ---------------------------------------------------------------------------

def extract_message_transcript(agent_data: dict) -> List[dict]:
    messages = agent_data.get("messages", [])
    transcript = []
    for msg in messages:
        entry = {
            "role": msg.get("role", "UNKNOWN"),
            "message": msg.get("message", ""),
            "created_at": msg.get("createdAt") or msg.get("created_at", ""),
        }
        metadata = msg.get("metadata")
        if metadata:
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except Exception:
                    pass
            entry["metadata"] = metadata
        transcript.append(entry)
    return transcript


# ---------------------------------------------------------------------------
# Collect all logs for a single agent
# ---------------------------------------------------------------------------

async def collect_logs(
    agent_id: str,
    agent_data: dict,
    start_time: datetime,
) -> dict:
    """
    Collect all available logs for a benchmark agent.

    Returns:
        {
            "messages":       [...],  # Full message transcript
            "backend_logs":   [...],  # Render backend HTTP logs
            "worker_logs":    [...],  # Fly.io agent worker logs (from streaming collector)
            "research_logs":  [...],  # Supabase completions gateway logs (by time window)
        }
    """
    messages = extract_message_transcript(agent_data)

    # Fly.io logs come from the streaming collector (sync call)
    worker_logs = get_flyio_logs_for_agent(agent_id)

    # Render and Supabase logs fetched via HTTP
    backend_logs, research_logs = await asyncio.gather(
        fetch_render_logs(agent_id, start_time),
        fetch_supabase_logs(agent_id, start_time),
    )

    return {
        "messages": messages,
        "backend_logs": backend_logs,
        "worker_logs": worker_logs,
        "research_logs": research_logs,
    }
