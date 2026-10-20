"""User tools domain data access - Temporal activities.

- ``resolve_user_tools_activity``: once per root workflow, read the user's active
  published version and pin its tool specs.
- ``run_user_tool_activity``: run one pinned tool's handler for that pinned
  version in a worker subprocess (executor ``local``).

Both are idempotent: resolution is a read, and v1 only runs side-effect-free
handlers (``side_effects: true`` is rejected at resolution and again here).
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
from typing import Any, Dict, List, Tuple

import httpx
import structlog
from temporalio import activity

from config import load_config
from utils.user_tool_models import llm_declarations

from .config import (
    BACKEND_HTTP_TIMEOUT_SECONDS,
    CACHE_DIR_ENV,
    HANDLER_PATH,
    resolve_executor_mode,
)
from .types import (
    MAX_DECLARATION_TOTAL_BYTES,
    MAX_HANDLER_FILE_BYTES,
    MAX_HANDLER_TOTAL_BYTES,
    MAX_STDOUT_BYTES,
    MAX_USER_TOOLS,
    SIDE_EFFECTS_UNSUPPORTED,
    STDERR_TAIL_BYTES,
    TOOL_NAME_RE,
    VERSION_ID_RE,
    PinnedUserTools,
    UserToolSpec,
    UserToolSpecError,
    build_inline_view,
    empty_pinned,
    normalize_tool_spec,
    parse_handler_output,
    safe_relative_path,
    tail_text,
    validate_tool_input,
)

logger = structlog.get_logger()


class UserToolFetchError(RuntimeError):
    """A pinned handler file could not be fetched (transport; Temporal may retry)."""


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


def _handler_env(workdir: Path, tool_name: str) -> Dict[str, str]:
    """Minimal environment: no worker variables, so no secrets reach user code."""
    return {
        "PATH": HANDLER_PATH,
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "ROSE_USER_TOOL": tool_name,
    }


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


def _error(kind: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"ok": False, "error_kind": kind, "error": message, **extra}


@activity.defn
async def run_user_tool_activity(
    agent_id: str,
    user_id: str,
    version_id: str,
    name: str,
    tool_input: Dict[str, Any],
    base_url: str,
    spec: UserToolSpec,
) -> Dict[str, Any]:
    """Run one pinned user tool. Handler failures return ``{"ok": False, ...}``.

    Only transport failures fetching the pinned handler files raise (retryable).
    """
    started = time.monotonic()
    log = logger.bind(agent_id=agent_id, user_id=user_id, version_id=version_id, tool=name)
    mode, disabled_reason = resolve_executor_mode()
    if mode is None:
        return _error("disabled", disabled_reason)
    if spec.get("source_name") != name or not VERSION_ID_RE.match(version_id or ""):
        return _error("invalid", f"pinned spec does not match tool {name!r} / version {version_id!r}")
    if spec.get("side_effects"):
        return _error("side_effects_unsupported", SIDE_EFFECTS_UNSUPPORTED)

    stdin_bytes, input_error = validate_tool_input(spec, tool_input)
    if input_error or stdin_bytes is None:
        return _error("input", input_error or "invalid input")

    version_root = await _ensure_handler_files(
        user_id=user_id,
        version_id=version_id,
        base_url=base_url,
        spec=spec,
    )
    timeout_s = int(spec.get("timeout_s") or 60)
    with tempfile.TemporaryDirectory(prefix="rose-user-tool-") as tmp:
        workdir = Path(tmp)
        for rel in spec.get("files") or [spec["entry"]]:
            target = workdir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(version_root / rel, target)
        try:
            argv = _runtime_argv(str(spec.get("runtime")), spec["entry"])
        except FileNotFoundError as exc:
            return _error("runtime", str(exc))
        log.info("[UserTools] handler start", runtime=spec.get("runtime"), timeout_s=timeout_s)
        outcome = await _run_handler_process(
            argv,
            cwd=workdir,
            env=_handler_env(workdir, name),
            stdin_bytes=stdin_bytes,
            timeout_s=timeout_s,
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    stderr_tail = tail_text(outcome["stderr"], STDERR_TAIL_BYTES)
    if outcome["timed_out"]:
        log.warning("[UserTools] handler timeout", duration_ms=duration_ms)
        return _error("timeout", f"handler timed out after {timeout_s}s", stderr_tail=stderr_tail)
    if outcome["overflow"]:
        return _error("output_too_large", f"handler output exceeds {MAX_STDOUT_BYTES} bytes")
    if outcome["returncode"] != 0:
        log.warning("[UserTools] handler failed", returncode=outcome["returncode"], stderr=stderr_tail[:200])
        message = f"handler exited with code {outcome['returncode']}"
        if stderr_tail:
            message += f": {stderr_tail}"
        return _error("exit", message, stderr_tail=stderr_tail)
    result, output_error = parse_handler_output(spec, outcome["stdout"])
    if output_error or result is None:
        log.warning("[UserTools] handler output rejected", error=(output_error or "")[:200])
        return _error("output", output_error or "invalid output")
    log.info("[UserTools] handler done", duration_ms=duration_ms, output_bytes=len(outcome["stdout"]))
    return {
        "ok": True,
        "result": result,
        "inline_view": build_inline_view(spec, version_id, result),
        "duration_ms": duration_ms,
    }
