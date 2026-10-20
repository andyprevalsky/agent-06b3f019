"""User tools domain data access - Temporal activities.

- ``resolve_user_tools_activity``: once per root workflow, read the user's active
  published version and pin its tool specs.
- ``run_user_tool_activity``: run one pinned tool's handler for that pinned
  version with the selected executor:

    local         worker subprocess (dev default; never on Fly unless explicit)
    code_session  POST /api/user-ui/tools/run → the backend resumes/leases the
                  calling user's own persistent code session sandbox and runs
                  the handler there under the per-call timeout

Both are idempotent. Resolution is a read. A read-only handler may run again on
a Temporal retry. A ``side_effects: true`` handler runs at most once per tool
call: the activity claims the call's idempotency key in the backend record
(POST /api/user-ui/tool-calls/claim) before the handler starts and stores the
run record (…/complete) before returning; a retry or concurrent duplicate gets
the stored record back instead of running the handler again.

    claim ─┬─ claimed ──► run handler ──► complete (first write wins) ──► shape
           ├─ done ─────► stored run record ─────────────────────────────► shape
           ├─ running ──► poll until done, or outcome_unknown once stale
           └─ conflict ─► idempotency_conflict (same key, different call)
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import httpx
import structlog
from temporalio import activity

from config import load_config
from utils.user_tool_models import llm_declarations

from .config import (
    BACKEND_HTTP_TIMEOUT_SECONDS,
    CACHE_DIR_ENV,
    CLAIM_POLL_SECONDS,
    CLAIM_STALE_GRACE_SECONDS,
    CODE_SESSION_BUSY_WAIT_SECONDS,
    CODE_SESSION_HTTP_MARGIN_SECONDS,
    COMPLETE_MAX_ATTEMPTS,
    EXECUTOR_LOCAL,
    HANDLER_PATH,
    resolve_executor_mode,
)
from .types import (
    IDEMPOTENCY_KEY_ENV,
    IDEMPOTENCY_KEY_RE,
    MAX_DECLARATION_TOTAL_BYTES,
    MAX_HANDLER_FILE_BYTES,
    MAX_HANDLER_TOTAL_BYTES,
    MAX_STDOUT_BYTES,
    MAX_USER_TOOLS,
    STDERR_TAIL_BYTES,
    TOOL_NAME_RE,
    USER_TOOL_DEFAULT_TIMEOUT_S,
    VERSION_ID_RE,
    HandlerRun,
    PinnedUserTools,
    UserToolSpec,
    UserToolSpecError,
    empty_pinned,
    handler_run_record,
    normalize_tool_spec,
    outcome_error,
    safe_relative_path,
    shape_handler_run,
    tail_text,
    validate_tool_input,
)

logger = structlog.get_logger()


class UserToolFetchError(RuntimeError):
    """A pinned handler file could not be fetched (transport; Temporal may retry)."""


class UserToolRecordError(RuntimeError):
    """The backend side-effect record could not be read or written (Temporal retries;
    claim and complete are idempotent, so a retry never runs the handler twice)."""


# ── backend access ──


def _backend() -> Tuple[str, str]:
    config = load_config()
    return config.backend.api_url.rstrip("/"), config.backend.api_key or ""


def _backend_headers(api_key: str, user_id: str) -> Dict[str, str]:
    return {"X-API-Key": api_key, "X-User-Id": user_id}


def _absolute_base_url(base_url: str, backend_url: str) -> str:
    if base_url.startswith("/"):
        return backend_url + base_url
    return base_url


def _file_headers(url: str, backend_url: str, api_key: str, user_id: str) -> Dict[str, str]:
    # Credentials only go to our own backend; a CDN/usercontent baseUrl gets none.
    if url.startswith(backend_url + "/"):
        return _backend_headers(api_key, user_id)
    return {}


def _manifest_files(manifest: Dict[str, Any]) -> List[str]:
    files = manifest.get("files")
    if isinstance(files, dict):
        return sorted(str(path) for path in files)
    if isinstance(files, list):
        return sorted(str(path) for path in files if isinstance(path, str))
    return []


@activity.defn
async def resolve_user_tools_activity(agent_id: str, user_id: str) -> PinnedUserTools:
    """Pin the user's active published tool set for this run.

    Returns an empty pin when the executor is disabled or the user has no
    active version. Invalid tools are skipped with a reason (never declared).
    Transport/5xx failures raise so Temporal retries the read.
    """
    mode, disabled_reason = resolve_executor_mode()
    if mode is None:
        logger.info("[UserTools] disabled", agent_id=agent_id, reason=disabled_reason)
        return empty_pinned(disabled_reason)

    backend_url, api_key = _backend()
    async with httpx.AsyncClient(timeout=BACKEND_HTTP_TIMEOUT_SECONDS) as client:
        started = time.monotonic()
        response = await client.get(
            f"{backend_url}/api/user-ui/active",
            headers=_backend_headers(api_key, user_id),
        )
        logger.info(
            "[UserTools] GET /api/user-ui/active",
            agent_id=agent_id,
            user_id=user_id,
            status=response.status_code,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        if response.status_code == 404:
            return empty_pinned("no active user UI version")
        response.raise_for_status()
        payload = response.json() if response.content else None
        if not isinstance(payload, dict) or not payload.get("versionId"):
            return empty_pinned("no active user UI version")

        version_id = str(payload.get("versionId"))
        base_url = payload.get("baseUrl")
        manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else {}
        if not VERSION_ID_RE.match(version_id) or not isinstance(base_url, str) or not base_url:
            return empty_pinned(f"active version payload is malformed (versionId={version_id!r})")
        base_url = _absolute_base_url(base_url, backend_url)

        tools_map = manifest.get("tools") if isinstance(manifest.get("tools"), dict) else {}
        inline_views = manifest.get("inline") if isinstance(manifest.get("inline"), dict) else None
        manifest_files = _manifest_files(manifest)
        specs: List[UserToolSpec] = []
        skipped: List[Dict[str, str]] = []
        declaration_bytes = 0
        for name in sorted(tools_map):
            if len(specs) >= MAX_USER_TOOLS:
                skipped.append({"name": str(name), "reason": f"more than {MAX_USER_TOOLS} user tools"})
                continue
            try:
                if not TOOL_NAME_RE.match(str(name)):
                    raise UserToolSpecError(f"tool name {name!r} must match [a-z0-9_]+")
                entry = tools_map[name]
                manifest_path = entry.get("manifest") if isinstance(entry, dict) else None
                manifest_path = safe_relative_path(manifest_path, prefix=f"tools/{name}/")
                url = base_url + manifest_path
                tool_response = await client.get(url, headers=_file_headers(url, backend_url, api_key, user_id))
                if 400 <= tool_response.status_code < 500:
                    raise UserToolSpecError(f"tool.json fetch returned HTTP {tool_response.status_code}")
                tool_response.raise_for_status()
                try:
                    raw = json.loads(tool_response.content.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise UserToolSpecError(f"tool.json is not valid JSON: {exc}") from exc
                spec = normalize_tool_spec(raw, source_name=str(name), manifest_files=manifest_files)
                view = spec.get("render_view")
                if view and inline_views is not None and view not in inline_views:
                    raise UserToolSpecError(f"render.view {view!r} is not an inline view in this version")
                size = len(json.dumps(llm_declarations([spec]), separators=(",", ":")))
                if declaration_bytes + size > MAX_DECLARATION_TOTAL_BYTES:
                    raise UserToolSpecError(
                        f"declared tool schemas would exceed {MAX_DECLARATION_TOTAL_BYTES} bytes in total"
                    )
                declaration_bytes += size
                specs.append(spec)
            except UserToolSpecError as exc:
                skipped.append({"name": str(name), "reason": str(exc)})

    for item in skipped:
        logger.warning("[UserTools] tool skipped", agent_id=agent_id, tool=item["name"], reason=item["reason"][:200])
    logger.info(
        "[UserTools] pinned",
        agent_id=agent_id,
        user_id=user_id,
        version_id=version_id,
        tools=[spec["name"] for spec in specs],
        skipped=len(skipped),
    )
    return {"version_id": version_id, "base_url": base_url, "tools": specs, "skipped": skipped}


# ── handler files (worker-disk cache by version) ──


def _cache_root() -> Path:
    configured = os.environ.get(CACHE_DIR_ENV)
    return Path(configured) if configured else Path(tempfile.gettempdir()) / "rose-user-tools"


def _version_dir(user_id: str, version_id: str) -> Path:
    digest = hashlib.sha256(f"{user_id}\0{version_id}".encode("utf-8")).hexdigest()[:32]
    return _cache_root() / digest


async def _ensure_handler_files(
    *,
    user_id: str,
    version_id: str,
    base_url: str,
    spec: UserToolSpec,
) -> Path:
    """Download the pinned version's handler files once; published versions are immutable."""
    root = _version_dir(user_id, version_id)
    prefix = f"tools/{spec['source_name']}/"
    paths = [safe_relative_path(path, prefix=prefix) for path in spec.get("files") or [spec["entry"]]]
    missing = [path for path in paths if not (root / path).is_file()]
    if not missing:
        return root
    backend_url, api_key = _backend()
    total = sum((root / path).stat().st_size for path in paths if (root / path).is_file())
    async with httpx.AsyncClient(timeout=BACKEND_HTTP_TIMEOUT_SECONDS) as client:
        for path in missing:
            url = base_url + path
            response = await client.get(url, headers=_file_headers(url, backend_url, api_key, user_id))
            if response.status_code != 200:
                raise UserToolFetchError(f"GET {path} for version {version_id} returned HTTP {response.status_code}")
            data = response.content
            if len(data) > MAX_HANDLER_FILE_BYTES:
                raise UserToolFetchError(f"{path} exceeds {MAX_HANDLER_FILE_BYTES} bytes")
            total += len(data)
            if total > MAX_HANDLER_TOTAL_BYTES:
                raise UserToolFetchError(f"handler files exceed {MAX_HANDLER_TOTAL_BYTES} bytes")
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".partial-")
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp_name, target)
    return root


# ── handler process ──


def _handler_env(workdir: Path, tool_name: str, idempotency_key: Optional[str] = None) -> Dict[str, str]:
    """Minimal environment: no worker variables, so no secrets reach user code."""
    env = {
        "PATH": HANDLER_PATH,
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "ROSE_USER_TOOL": tool_name,
    }
    if idempotency_key:
        env[IDEMPOTENCY_KEY_ENV] = idempotency_key
    return env


def _runtime_argv(runtime: str, entry: str) -> List[str]:
    if runtime == "python":
        # -I: isolated mode (ignores PYTHON* env vars and the user site dir).
        return [sys.executable, "-I", entry]
    node = shutil.which("node")
    if not node:
        raise FileNotFoundError("node runtime is not installed on this worker")
    return [node, entry]


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


async def _run_handler_process(
    argv: List[str],
    *,
    cwd: Path,
    env: Dict[str, str],
    stdin_bytes: bytes,
    timeout_s: int,
) -> Dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    stdout = bytearray()
    stderr = bytearray()
    overflow = False

    async def _read_stdout() -> None:
        nonlocal overflow
        if proc.stdout is None:
            return
        while chunk := await proc.stdout.read(65536):
            stdout.extend(chunk)
            if len(stdout) > MAX_STDOUT_BYTES:
                overflow = True
                _kill_group(proc)
                return

    async def _read_stderr() -> None:
        if proc.stderr is None:
            return
        while chunk := await proc.stderr.read(65536):
            stderr.extend(chunk)
            if len(stderr) > STDERR_TAIL_BYTES * 2:
                del stderr[: len(stderr) - STDERR_TAIL_BYTES]

    async def _write_stdin() -> None:
        if proc.stdin is None:
            return
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            proc.stdin.write(stdin_bytes)
            await proc.stdin.drain()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            proc.stdin.close()

    async def _drive() -> None:
        await asyncio.gather(_write_stdin(), _read_stdout(), _read_stderr())
        await proc.wait()

    timed_out = False
    driver = asyncio.ensure_future(_drive())
    try:
        await asyncio.wait_for(asyncio.shield(driver), timeout=timeout_s)
    except asyncio.TimeoutError:
        timed_out = True
        _kill_group(proc)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(driver, timeout=5)
    finally:
        _kill_group(proc)
        if not driver.done():
            driver.cancel()
            with contextlib.suppress(BaseException):
                await driver
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)
    return {
        "returncode": proc.returncode,
        "stdout": bytes(stdout),
        "stderr": bytes(stderr),
        "timed_out": timed_out,
        "overflow": overflow,
    }


# ── executors: each returns {"run": HandlerRun} or {"error": outcome, "started": bool|None} ──
#    started False = the handler certainly never started (a side-effect claim is released);
#    started None  = unknown (the claim stays STARTED, so the call is never run twice).

Execution = Dict[str, Any]

# Backend code for "every one of this user's tool sessions is running another call".
SESSION_BUSY_CODE = "USER_TOOL_SESSION_BUSY"


def _timeout_s(spec: UserToolSpec) -> int:
    value = spec.get("timeout_s")
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return USER_TOOL_DEFAULT_TIMEOUT_S


async def _prepare_local(
    *, user_id: str, version_id: str, base_url: str, spec: UserToolSpec
) -> Tuple[Optional[Path], List[str], Optional[Dict[str, Any]]]:
    """Fetch handler files and resolve the runtime (no side effects; may raise on transport)."""
    version_root = await _ensure_handler_files(user_id=user_id, version_id=version_id, base_url=base_url, spec=spec)
    try:
        argv = _runtime_argv(str(spec.get("runtime")), spec["entry"])
    except FileNotFoundError as exc:
        return None, [], outcome_error("runtime", str(exc))
    return version_root, argv, None


async def _execute_local(
    *,
    version_root: Path,
    argv: List[str],
    name: str,
    spec: UserToolSpec,
    stdin_bytes: bytes,
    idempotency_key: Optional[str],
) -> Execution:
    """Executor ``local``: a worker subprocess in a fresh temp dir, minimal env."""
    with tempfile.TemporaryDirectory(prefix="rose-user-tool-") as tmp:
        workdir = Path(tmp)
        for rel in spec.get("files") or [spec["entry"]]:
            target = workdir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(version_root / rel, target)
        try:
            process = await _run_handler_process(
                argv,
                cwd=workdir,
                env=_handler_env(workdir, name, idempotency_key),
                stdin_bytes=stdin_bytes,
                timeout_s=_timeout_s(spec),
            )
        except OSError as exc:
            return {"error": outcome_error("runtime", f"handler could not start: {exc}"), "started": False}
    return {
        "run": handler_run_record(
            returncode=process["returncode"],
            stdout=process["stdout"],
            stderr_tail=tail_text(process["stderr"], STDERR_TAIL_BYTES),
            timed_out=process["timed_out"],
            overflow=process["overflow"],
            executor=EXECUTOR_LOCAL,
        )
    }


def _coerce_run(raw: Any, *, executor: str) -> Optional[HandlerRun]:
    """A run record from the backend, bounded to the documented shape."""
    if not isinstance(raw, dict):
        return None
    returncode = raw.get("returncode")
    if returncode is not None and (isinstance(returncode, bool) or not isinstance(returncode, int)):
        return None
    stdout_b64 = raw.get("stdout_b64")
    if not isinstance(stdout_b64, str) or len(stdout_b64) > (MAX_STDOUT_BYTES * 4) // 3 + 4:
        return None
    return {
        "returncode": returncode,
        "stdout_b64": stdout_b64,
        "stderr_tail": str(raw.get("stderr_tail") or "")[-STDERR_TAIL_BYTES:],
        "timed_out": raw.get("timed_out") is True,
        "overflow": raw.get("overflow") is True,
        "executor": str(raw.get("executor") or executor),
        "code_session_id": raw.get("code_session_id") if isinstance(raw.get("code_session_id"), str) else None,
    }


def _response_json(response: httpx.Response) -> Dict[str, Any]:
    try:
        payload = response.json() if response.content else {}
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


async def _execute_code_session(
    *,
    agent_id: str,
    user_id: str,
    version_id: str,
    name: str,
    spec: UserToolSpec,
    stdin_bytes: bytes,
    idempotency_key: Optional[str],
) -> Execution:
    """Executor ``code_session``: the backend runs the handler in the user's own session.

    The worker never names a session or sandbox: the backend resolves the session
    from the authenticated user (X-User-Id), so another user's is never reachable.
    """
    backend_url, api_key = _backend()
    timeout_s = _timeout_s(spec)
    body: Dict[str, Any] = {
        "agent_id": agent_id,
        "version_id": version_id,
        "tool": name,
        "runtime": spec.get("runtime"),
        "entry": spec.get("entry"),
        "files": list(spec.get("files") or [spec.get("entry")]),
        "timeout_s": timeout_s,
        "input_json": stdin_bytes.decode("utf-8"),
    }
    if idempotency_key:
        body["idempotency_key"] = idempotency_key
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(float(timeout_s + CODE_SESSION_HTTP_MARGIN_SECONDS), connect=10.0)
        ) as client:
            busy_waits = 0
            while True:
                response = await client.post(
                    f"{backend_url}/api/user-ui/tools/run",
                    json=body,
                    headers=_backend_headers(api_key, user_id),
                )
                busy = response.status_code == 503 and _response_json(response).get("code") == SESSION_BUSY_CODE
                if not busy or time.monotonic() - started >= CODE_SESSION_BUSY_WAIT_SECONDS:
                    break
                # Every tool session of this user is running another call: wait for one.
                await asyncio.sleep(CLAIM_POLL_SECONDS[min(busy_waits, len(CLAIM_POLL_SECONDS) - 1)])
                busy_waits += 1
    except httpx.HTTPError as exc:
        message = f"code session run failed: {type(exc).__name__}: {exc}"[:500]
        logger.warning("[UserTools] code session run transport error", agent_id=agent_id, tool=name, error=message)
        return {"error": outcome_error("executor", message), "started": None}
    payload = _response_json(response)
    logger.info(
        "[UserTools] POST /api/user-ui/tools/run",
        agent_id=agent_id,
        user_id=user_id,
        tool=name,
        status=response.status_code,
        code_session_id=payload.get("code_session_id"),
        resumed_from=payload.get("resumed_from"),
        duration_ms=int((time.monotonic() - started) * 1000),
    )
    error_text = str(payload.get("error") or f"HTTP {response.status_code}")[:500]
    if response.status_code == 200:
        run = _coerce_run(payload.get("run"), executor="code_session")
        if run is None:
            return {"error": outcome_error("executor", "code session returned a malformed run record"), "started": None}
        return {"run": run}
    if response.status_code == 503:
        kind = "session_busy" if payload.get("code") == SESSION_BUSY_CODE else "sandbox_unavailable"
        return {"error": outcome_error(kind, error_text), "started": False}
    if 400 <= response.status_code < 500:
        return {"error": outcome_error("invalid", error_text), "started": False}
    return {"error": outcome_error("executor", error_text), "started": None}


# ── side-effect record (backend ToolSideEffect via /api/user-ui/tool-calls) ──


async def _record_call(path: str, user_id: str, body: Dict[str, Any]) -> httpx.Response:
    backend_url, api_key = _backend()
    try:
        async with httpx.AsyncClient(timeout=BACKEND_HTTP_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{backend_url}/api/user-ui/tool-calls/{path}",
                json=body,
                headers=_backend_headers(api_key, user_id),
            )
    except httpx.HTTPError as exc:
        raise UserToolRecordError(f"tool-call {path} failed: {type(exc).__name__}: {exc}") from exc
    if response.status_code >= 500:
        raise UserToolRecordError(f"tool-call {path} returned HTTP {response.status_code}")
    return response


async def _complete_record(user_id: str, key: str, run: HandlerRun) -> HandlerRun:
    """Store the run record (first write wins) and return the stored one."""
    last_error: Optional[Exception] = None
    for attempt in range(COMPLETE_MAX_ATTEMPTS):
        try:
            response = await _record_call("complete", user_id, {"idempotency_key": key, "run": run})
        except UserToolRecordError as exc:
            last_error = exc
            await asyncio.sleep(0.5 * (attempt + 1))
            continue
        payload = _response_json(response)
        stored = _coerce_run(payload.get("run"), executor=str(run.get("executor") or ""))
        if response.status_code == 200 and stored is not None:
            return stored
        raise UserToolRecordError(f"tool-call complete returned HTTP {response.status_code}: {payload.get('error')}")
    raise UserToolRecordError(f"tool-call complete failed after {COMPLETE_MAX_ATTEMPTS} attempts: {last_error}")


async def _release_record(user_id: str, key: str, reason: str) -> None:
    """Re-open a claim whose handler never started (best effort)."""
    try:
        await _record_call("release", user_id, {"idempotency_key": key, "error": reason[:500]})
    except UserToolRecordError as exc:
        logger.warning("[UserTools] releasing a never-started claim failed", key=key[:12], error=str(exc)[:200])


async def _claim_or_settle(
    *, user_id: str, key: str, request: Dict[str, Any], stale_after_s: int
) -> Optional[Execution]:
    """None when this attempt now holds the claim; else the call's settled execution
    (stored record, conflict, or outcome_unknown once a STARTED claim is stale)."""
    polls = 0
    while True:
        response = await _record_call("claim", user_id, {"idempotency_key": key, **request})
        payload = _response_json(response)
        status = payload.get("status")
        if response.status_code == 409 or status == "conflict":
            return {
                "error": outcome_error(
                    "idempotency_conflict",
                    str(payload.get("error") or "this tool call's idempotency key was used by a different call"),
                ),
                "started": None,
            }
        if response.status_code != 200:
            raise UserToolRecordError(f"tool-call claim returned HTTP {response.status_code}: {payload.get('error')}")
        if status == "done":
            stored = _coerce_run(payload.get("run"), executor="")
            if stored is None:
                return {"error": outcome_error("executor", "stored run record is malformed"), "started": None}
            return {"run": stored, "replayed": True}
        if status == "claimed":
            return None
        if status == "running":
            age_s = float(payload.get("age_ms") or 0) / 1000.0
            if age_s >= stale_after_s:
                return {
                    "error": outcome_error(
                        "outcome_unknown",
                        "an earlier attempt of this side-effecting call started but never recorded a result; "
                        "it is not run again so its side effect cannot repeat",
                    ),
                    "started": None,
                }
            await asyncio.sleep(CLAIM_POLL_SECONDS[min(polls, len(CLAIM_POLL_SECONDS) - 1)])
            polls += 1
            continue
        raise UserToolRecordError(f"tool-call claim returned unexpected status {status!r}")


async def _run_at_most_once(
    *,
    user_id: str,
    key: str,
    request: Dict[str, Any],
    stale_after_s: int,
    execute: Callable[[], Awaitable[Execution]],
) -> Execution:
    """Claim → execute → store, or replay the stored record (see module docstring)."""
    settled = await _claim_or_settle(user_id=user_id, key=key, request=request, stale_after_s=stale_after_s)
    if settled is not None:
        return settled
    executed = await execute()
    if "run" in executed:
        stored = await _complete_record(user_id, key, executed["run"])
        return {"run": stored, "replayed": False}
    if executed.get("started") is False:
        await _release_record(user_id, key, str((executed.get("error") or {}).get("error") or "not started"))
        return executed
    # Unknown whether the handler ran (e.g. the run response was lost). The
    # code-session runner stores the record before it answers, so the record
    # decides: its stored result, or outcome_unknown once the claim is stale.
    # The handler is never started again from here.
    settled = await _claim_or_settle(user_id=user_id, key=key, request=request, stale_after_s=stale_after_s)
    return settled if settled is not None else executed


@activity.defn
async def run_user_tool_activity(
    agent_id: str,
    user_id: str,
    version_id: str,
    name: str,
    tool_input: Dict[str, Any],
    base_url: str,
    spec: UserToolSpec,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Run one pinned user tool. Handler failures return ``{"ok": False, ...}``.

    Only transport failures before the handler starts (handler file fetches,
    side-effect record reads/writes) raise, so Temporal retries them.
    """
    started = time.monotonic()
    log = logger.bind(agent_id=agent_id, user_id=user_id, version_id=version_id, tool=name)
    mode, disabled_reason = resolve_executor_mode()
    if mode is None:
        return outcome_error("disabled", disabled_reason)
    if spec.get("source_name") != name or not VERSION_ID_RE.match(version_id or ""):
        return outcome_error("invalid", f"pinned spec does not match tool {name!r} / version {version_id!r}")
    side_effects = spec.get("side_effects") is True
    key = idempotency_key if side_effects else None
    if side_effects and not IDEMPOTENCY_KEY_RE.match(key or ""):
        return outcome_error("invalid", "a side-effecting user tool call needs its idempotency key")

    stdin_bytes, input_error = validate_tool_input(spec, tool_input, key)
    if input_error or stdin_bytes is None:
        return outcome_error("input", input_error or "invalid input")
    payload_bytes: bytes = stdin_bytes

    if mode == EXECUTOR_LOCAL:
        version_root, argv, prepare_error = await _prepare_local(
            user_id=user_id, version_id=version_id, base_url=base_url, spec=spec
        )
        if prepare_error is not None or version_root is None:
            return prepare_error or outcome_error("runtime", "handler files unavailable")
        local_root: Path = version_root

        async def execute() -> Execution:
            return await _execute_local(
                version_root=local_root,
                argv=argv,
                name=name,
                spec=spec,
                stdin_bytes=payload_bytes,
                idempotency_key=key,
            )

    else:

        async def execute() -> Execution:
            return await _execute_code_session(
                agent_id=agent_id,
                user_id=user_id,
                version_id=version_id,
                name=name,
                spec=spec,
                stdin_bytes=payload_bytes,
                idempotency_key=key,
            )

    log.info("[UserTools] tool call start", executor=mode, side_effects=side_effects, timeout_s=_timeout_s(spec))
    if key is None:
        executed = await execute()
    else:
        executed = await _run_at_most_once(
            user_id=user_id,
            key=key,
            request={
                "agent_id": agent_id,
                "tool": name,
                "version_id": version_id,
                "input_sha256": hashlib.sha256(payload_bytes).hexdigest(),
            },
            stale_after_s=_timeout_s(spec) + CODE_SESSION_HTTP_MARGIN_SECONDS + CLAIM_STALE_GRACE_SECONDS,
            execute=execute,
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    run = executed.get("run")
    if run is None:
        error = executed.get("error") or outcome_error("executor", "user tool did not run")
        log.warning(
            "[UserTools] handler not run", error_kind=error.get("error_kind"), error=str(error.get("error"))[:200]
        )
        return {**error, "executor": mode, "duration_ms": duration_ms}
    outcome = shape_handler_run(spec, version_id, run)
    outcome.update(
        {
            "executor": str(run.get("executor") or mode),
            "duration_ms": duration_ms,
            **({"replayed": True} if executed.get("replayed") else {}),
            **({"code_session_id": run["code_session_id"]} if run.get("code_session_id") else {}),
        }
    )
    if outcome.get("ok"):
        log.info(
            "[UserTools] handler done",
            executor=outcome["executor"],
            replayed=bool(executed.get("replayed")),
            duration_ms=duration_ms,
            output_bytes=outcome.get("output_bytes"),
        )
    else:
        log.warning(
            "[UserTools] handler failed",
            executor=outcome["executor"],
            error_kind=outcome.get("error_kind"),
            error=str(outcome.get("error"))[:200],
        )
    return outcome
