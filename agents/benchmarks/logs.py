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
  The Supabase Management API only exposes gateway-level HTTP logs (method/status/URL)
  via the logs.all endpoint. Edge function console output (console.log/slog() calls
  from completions/index.ts) is NOT available via REST API — only visible in the
  Supabase Logs Explorer UI. In local mode, console output goes to research-logs.log.
  In prod, the worker logs are the best proxy: they log the HTTP status and error body
  received back from the completions endpoint.
"""

import asyncio
import json
import os
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

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


async def fetch_flyio_logs_snapshot(agent_id: str) -> List[str]:
    """
    Fetch a one-shot snapshot of Fly.io logs via `flyctl logs --no-tail`.

    This supplements the streaming collector by capturing any logs still in
    the Fly buffer after a task completes. The streaming collector can miss
    logs if the connection goes idle or drops during long runs.
    """
    if not FLY_API_TOKEN:
        return []
    try:
        env = {**os.environ, "FLY_API_TOKEN": FLY_API_TOKEN}
        proc = await asyncio.create_subprocess_exec(
            "flyctl", "logs", "-a", FLY_APP_NAME, "--no-tail",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
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

    # Fly.io logs: merge streaming collector + one-shot snapshot (deduped)
    stream_logs = get_flyio_logs_for_agent(agent_id)
    snapshot_logs = await fetch_flyio_logs_snapshot(agent_id)
    # Deduplicate: use set of raw strings, preserving order from stream first
    seen = set()
    worker_logs = []
    # Skip the "[fly.io] 0 logs..." placeholder messages
    for log in stream_logs + snapshot_logs:
        if log.startswith("[fly.io]"):
            continue
        if log not in seen:
            seen.add(log)
            worker_logs.append(log)
    if not worker_logs:
        stream_total = _fly_collector.total_lines if _fly_collector else 0
        worker_logs = [f"[fly.io] 0 logs for agent {agent_id[:12]} ({stream_total} streamed + {len(snapshot_logs)} snapshot)"]

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


# ---------------------------------------------------------------------------
# Collect logs for an entire agent tree (root + all descendants)
# ---------------------------------------------------------------------------

async def collect_tree_logs(
    root_agent_id: str,
    tree_agents: List[dict],
    start_time: datetime,
    get_agent_fn=None,
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

        logs = await collect_logs(aid, agent_data, start_time)

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
                anomalies.append(
                    f"INFINITE LOOP: message repeated {count}x (total): {text[:80]}"
                )

    # 2. Detect tools stuck IN_PROGRESS without FINISHED
    # Spawn tools are inherently long-running (sub-agents have their own anomaly detection)
    _LONG_RUNNING_TOOLS = {
        "spawn_agent", "spawn_sub_agent", "spawn_sub_agent_for_each",
        "spawn_claude_code_agent", "spawn_browser_agent",
        "set_plan", "message_person", "request_user_approval", "check_progress",
    }
    in_progress = {}  # tool_call_id → metadata
    for m in msgs:
        meta = m.get("metadata", {})
        if not isinstance(meta, dict):
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
                from datetime import datetime, timezone
                # Handle both "2026-03-20T20:28:51.907Z" and other ISO formats
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                timestamps.append(dt)
            except (ValueError, TypeError):
                pass
    if len(timestamps) >= 2:
        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i - 1]).total_seconds()
            if gap > 180:  # 3+ minute gap
                anomalies.append(
                    f"TIME GAP: {gap:.0f}s ({gap/60:.1f}min) between messages {i-1} and {i}"
                )

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

    def _scan_log_errors(log_list: List, source_name: str) -> List[str]:
        found = []
        for log_line in log_list:
            lower = log_line.lower() if isinstance(log_line, str) else ""
            if any(kw in lower for kw in (
                '"level":"error"', '"event":"error"', 'traceback',
                'exception', 'error:', 'failed', '500 ', '502 ', '503 ',
            )):
                found.append(f"[{source_name}] {log_line[:200]}")
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
        icon = {"COMPLETED": "✅", "FAILED": "❌", "PAUSED": "⏸",
                "COST_LIMIT_REACHED": "💸", "OUT_OF_CREDITS": "💸"}.get(status, "🔄")

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

        all_log_errors = (
            _scan_log_errors(worker, "worker")
            + _scan_log_errors(backend, "backend")
            + _scan_log_errors(research, "research")
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
            error_tools = [m for m in tool_msgs
                           if isinstance(m.get("metadata"), dict) and m["metadata"].get("toolStatus") == "ERROR"]
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
            tool_names = [m.get("metadata", {}).get("toolName", "?")
                          for m in tool_msgs if isinstance(m.get("metadata"), dict)]
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
    failed = [aid for aid, info in tree_logs.items()
              if info.get("status") in ("FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED")]
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
