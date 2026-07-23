"""Data access for spawn-browser-agent-v3 domain.

All HTTP calls to backend, browser providers, and Rose API.
Typed args in, typed results out.
"""

from __future__ import annotations

import uuid as uuid_module
from typing import Any, Dict, List, Optional

import httpx
import structlog

from domains.spawn_browser_agent_v3.config import (
    EXTRACT_LLM_MAX_TOKENS,
    EXTRACT_LLM_MODEL,
    EXTRACT_LLM_TEMPERATURE,
    EXTRACT_MAX_CONTENT_LENGTH,
    MIME_TYPE_MAP,
)
from tools.base import MessageStatus
from utils.error_utils import extract_error_message

logger = structlog.get_logger()


# ========================================
# CLAUDE AUTH TOKEN
# ========================================


async def fetch_claude_token(
    config: Any,
    user_id: str,
    force_pool: bool = False,
    exclude_pool_ids: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch a Claude OAuth token from the backend.

    Returns dict with {accessToken, source, poolTokenId?} or None.
    """
    backend_url = config.backend.api_url.rstrip("/")
    backend_api_key = config.backend.api_key
    if not backend_api_key:
        logger.warning("[ClaudeAuth] BACKEND_API_KEY not configured")
        return None

    headers: Dict[str, str] = {
        "X-API-Key": backend_api_key,
        "X-User-Id": user_id,
    }
    if force_pool:
        headers["X-Force-Pool"] = "true"
    if exclude_pool_ids:
        headers["X-Exclude-Pool-Tokens"] = ",".join(exclude_pool_ids)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{backend_url}/api/integrations/claude-code/credentials/token",
                headers=headers,
            )
            if resp.status_code != 200:
                logger.info(f"[ClaudeAuth] Token fetch returned {resp.status_code}", user_id=user_id)
                return None
            return resp.json()
    except Exception as e:
        logger.error(f"[ClaudeAuth] Token fetch failed: {e}", user_id=user_id)
        return None


async def report_claude_token_rate_limited(
    config: Any,
    *,
    user_id: str,
    source: Optional[str],
    pool_token_id: Optional[str] = None,
    rate_limited_until: Optional[str] = None,
) -> None:
    """Report Claude token rate-limit status to backend (pool or user token)."""
    backend_url = config.backend.api_url.rstrip("/")
    backend_api_key = config.backend.api_key
    if not backend_api_key or not source:
        return

    payload: Dict[str, Any] = {
        "source": source,
    }
    if source == "pool" and pool_token_id:
        payload["poolTokenId"] = pool_token_id
    elif source == "user":
        payload["userId"] = user_id
    else:
        return

    if rate_limited_until:
        payload["rateLimitedUntil"] = rate_limited_until

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{backend_url}/api/integrations/claude-code/token/rate-limited",
                headers={"X-API-Key": backend_api_key, "X-User-Id": user_id, "Content-Type": "application/json"},
                json=payload,
            )
            logger.info(
                f"[ClaudeAuth] Marked {source} token rate-limited",
                source=source,
                pool_token_id=pool_token_id,
                rate_limited_until=rate_limited_until,
            )
    except Exception as e:
        logger.error(f"[ClaudeAuth] Failed to report token rate limit: {e}")


# ========================================
# BROWSER SESSION MESSAGES
# ========================================


async def save_browser_action_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    browser_url: str = "",
    action_type: str = "default",
    auxiliary: Optional[dict] = None,
    tool_call_id: Optional[str] = None,
    is_init_message: bool = False,
    is_completion_message: bool = False,
    output_schema: Optional[dict] = None,
    steps_taken: Optional[int] = None,
    total_steps: Optional[int] = None,
    tool_name_override: Optional[str] = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Save browser sub-action message directly to DB.

    Args:
        is_init_message: If True, don't set subAgentId (shows in main chat as init)
        is_completion_message: If True, don't set subAgentId (shows in main chat as completion/error)
        tool_name_override: Override the default `toolName` ("spawn_browser_agent")
            with a different tool — e.g. set to "attempt_completion" so verifier
            feedback appears as the natural TOOL result of the agent's
            attempt_completion call.
        extra_metadata: Additional metadata fields to merge into the message
            metadata (e.g. verifierMessage flag for verifier-feedback messages).
    """
    from config import load_config

    try:
        config = load_config()
        unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

        metadata: Dict[str, Any] = {
            "toolCallId": unique_tool_call_id,
            "toolName": tool_name_override or "spawn_browser_agent",
            "toolStatus": status.value,
            "title": title,
            "task_id": task_id,
            "browser_url": browser_url,
            "action_type": action_type,
            "auxiliary": auxiliary or {},
        }
        if extra_metadata:
            metadata.update(extra_metadata)

        # Include step progress for FE display
        if steps_taken is not None:
            metadata["steps_taken"] = steps_taken
        if total_steps is not None:
            metadata["total_steps"] = total_steps

        # Include output schema in init message for FE display
        if output_schema:
            metadata["output_schema"] = output_schema

        # Only set subAgentId for intermediate messages (not init or completion)
        # This ensures init and completion messages show in main chat
        if not is_init_message and not is_completion_message:
            metadata["subAgentId"] = task_id

        if status == MessageStatus.ERROR:
            metadata["error"] = True

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                json={"message": message, "role": "TOOL", "metadata": metadata},
            )
    except Exception as e:
        logger.error("Failed to save browser action message", error=extract_error_message(e))


async def save_browser_assistant_message(
    agent_id: str,
    message: str,
    task_id: str,
    *,
    stream_id: str | None = None,
) -> None:
    """Save browser ASSISTANT message directly to DB."""
    from config import load_config

    try:
        config = load_config()
        metadata = {"subAgentId": task_id}
        if stream_id:
            metadata["streamId"] = stream_id

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                json={"message": message, "role": "ASSISTANT", "metadata": metadata},
            )
    except Exception as e:
        logger.error("Failed to save browser assistant message", error=extract_error_message(e))


def build_credential_ref_metadata(kind: str, credential_id: str) -> Dict[str, Any]:
    """Build standard Message metadata for credential outcome propagation."""
    return {"credential_ref": {"kind": kind, "id": credential_id}}


async def save_browser_credential_ref_message(
    *,
    agent_id: str,
    task_id: str,
    message: str,
    credential_ref: Dict[str, Any],
    role: str = "TOOL",
    tool_name: str = "credential_ref",
    browser_url: str = "",
) -> bool:
    """Save a Message row carrying metadata.credential_ref.

    Returns whether the backend accepted the message so callers that deduplicate
    credential outcomes can retry a transient persistence failure.
    """
    from config import load_config

    try:
        config = load_config()
        metadata: Dict[str, Any] = {
            "subAgentId": task_id,
            "credential_ref": credential_ref,
        }
        if browser_url:
            metadata["browser_url"] = browser_url
        if role == "TOOL":
            metadata.update(
                {
                    "toolCallId": str(uuid_module.uuid4()),
                    "toolName": tool_name,
                    "toolStatus": MessageStatus.FINISHED.value,
                    "title": "Credential referenced",
                    "task_id": task_id,
                    "action_type": "credential_ref",
                    "auxiliary": {},
                }
            )

        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                json={"message": message, "role": role, "metadata": metadata},
            )
            if response.is_error:
                logger.error(
                    "Failed to save credential ref message",
                    status_code=response.status_code,
                )
                return False
        return True
    except Exception as e:
        logger.error("Failed to save credential ref message", error=extract_error_message(e))
        return False


async def propagate_browser_run_credentials(
    config: Any,
    *,
    agent_id: str,
    task_id: str,
    status: str,
    success: bool,
    message: str,
) -> Dict[str, Any]:
    """Synchronously apply credential liveness updates for a completed browser run."""
    backend_url = config.backend.api_url.rstrip("/")
    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(
            f"{backend_url}/api/credential-propagation/browser-run",
            headers={"X-API-Key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={
                "agentId": agent_id,
                "taskId": task_id,
                "status": status,
                "success": success,
                "message": message,
            },
        )
        response.raise_for_status()
        return response.json()


# ========================================
# BROWSER SESSION FILES
# ========================================


async def list_session_files(config: Any, session_id: str) -> List[Dict[str, Any]]:
    """List all files in a browser session through the provider-neutral backend."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/browser-session/{session_id}/files/list",
                headers={"x-api-key": config.backend.api_key or ""},
            )
            if response.status_code == 200:
                data = response.json()
                files = data.get("files", []) if isinstance(data, dict) else []
                return files if isinstance(files, list) else []
            logger.warning("Failed to list browser session files", session_id=session_id, status=response.status_code)
            return []
    except Exception as e:
        logger.warning("Error listing browser session files", session_id=session_id, error=extract_error_message(e))
        return []


async def download_session_file(config: Any, session_id: str, file_path: str) -> Optional[Dict[str, Any]]:
    """Download a file through the provider-neutral backend.

    Returns Dict with content (bytes), filename, mime_type, or None on failure.
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/browser-session/{session_id}/files/content",
                params={"path": file_path},
                headers={"x-api-key": config.backend.api_key or ""},
            )
            if response.status_code == 200:
                filename = file_path.split("/")[-1] or "download"
                ext = filename.split(".")[-1].lower() if "." in filename else ""
                mime_type = MIME_TYPE_MAP.get(ext, "application/octet-stream")

                logger.info(
                    f"[Browser] Downloaded {filename} ({len(response.content)} bytes)",
                    session_id=session_id,
                )
                return {
                    "content": response.content,
                    "filename": filename,
                    "mime_type": mime_type,
                }
            else:
                logger.warning(
                    "[Browser] Failed to download file",
                    session_id=session_id,
                    path=file_path,
                    status=response.status_code,
                    response=response.text[:200],
                )
                return None
    except Exception as e:
        logger.warning(
            "[Browser] Error downloading file",
            session_id=session_id,
            path=file_path,
            error=extract_error_message(e),
        )
        return None


# ========================================
# BROWSER SESSION INIT / CLOSE / TASK
# ========================================

# Substrings that mark a browser-provider (Kernel/Steel) session-init failure as
# TRANSIENT — an unhealthy proxy/machine was allocated, and a fresh init request
# reallocates a different one. These are infra hiccups, not bad requests, so they
# are retried (bounded) rather than surfaced to the agent as a fatal failure.
_TRANSIENT_INIT_FAILURE_MARKERS = (
    "proxy is marked unavailable",
    "health check",
    "no healthy",
    "temporarily unavailable",
    "try again",
)


def is_transient_session_init_failure(status_code: int, body: str) -> bool:
    """Classify a non-2xx/429 init response as retryable-transient vs. fatal.

    5xx from the provider is always transient. A 4xx is transient only when its
    body matches a known infra-hiccup marker (e.g. Kernel's
    ``400 Proxy is marked unavailable from the last health check``); an ordinary
    4xx (bad request) stays fatal so real errors are not masked by retries.
    """
    if status_code >= 500:
        return True
    text = (body or "").lower()
    return any(marker in text for marker in _TRANSIENT_INIT_FAILURE_MARKERS)


async def init_browser_session(
    config: Any,
    user_id: str,
    agent_id: str,
    start_url: str,
) -> Dict[str, Any]:
    """Initialize a browser session via backend. Returns session data dict."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/init",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={"user_id": user_id, "agent_id": agent_id, "start_url": start_url},
        )
    if response.status_code in [200, 201]:
        return response.json()
    if response.status_code == 429:
        return {"rate_limited": True, "status_code": 429}
    if is_transient_session_init_failure(response.status_code, response.text):
        return {
            "transient_init_failure": True,
            "status_code": response.status_code,
            "detail": response.text[:300],
        }
    raise Exception(f"Failed to init session: {response.text}")


async def resume_browser_session(config: Any, task_id: str) -> Dict[str, Any]:
    """Resume a paused browser session by asking backend/Steel for a fresh session."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/resume",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={"task_id": task_id},
        )
    if response.status_code in [200, 201]:
        return response.json()
    if response.status_code == 429:
        return {"rate_limited": True, "status_code": 429}
    raise Exception(f"Failed to resume session: {response.text}")


async def fetch_browser_captcha_telemetry(config: Any, task_id: str) -> Dict[str, Any]:
    """Read provider-native CAPTCHA solver state for the current browser task."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/browser-session/{task_id}/captcha-telemetry",
            headers={"x-api-key": config.backend.api_key or ""},
        )
    if response.status_code == 200:
        return response.json()
    raise RuntimeError(f"Failed to read CAPTCHA telemetry: {response.text}")


async def recover_browser_challenge(
    config: Any,
    task_id: str,
    current_url: str,
    storage_state: Dict[str, Any],
    user_agent: str = "",
) -> Dict[str, Any]:
    """Run the backend's parallel Kernel/Steel browser-configuration search."""
    # A challenged candidate can spend up to two 45s navigations plus two 45s
    # provider-solver windows. The six candidates run concurrently, so this is
    # a bounded wall-clock allowance for one search rather than six serial waits.
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/recover-challenge",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={
                "task_id": task_id,
                "current_url": current_url,
                "storage_state": storage_state,
                **({"user_agent": user_agent} if user_agent else {}),
            },
        )
    if response.status_code in [200, 201]:
        return response.json()
    if response.status_code == 429:
        return {"rate_limited": True, "status_code": 429}
    raise Exception(f"Failed to recover from browser challenge: {response.text}")


async def fetch_auth_options(config: Any, user_id: str, realm: str) -> Dict[str, Any]:
    """Fetch single-realm authentication options for a browser agent spawn."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/auth-options",
            params={"realm": realm},
            headers={"x-api-key": config.backend.api_key or "", "x-user-id": user_id},
        )
    if response.status_code == 200:
        data = response.json()
        return data if isinstance(data, dict) else {}
    raise RuntimeError(f"Failed to fetch auth options for {realm}: HTTP {response.status_code} {response.text[:200]}")


async def prepare_browser_auth(
    config: Any,
    *,
    user_id: str,
    session_id: str,
    target_url: str,
) -> Dict[str, Any]:
    """Prepare all saved browser credentials before entering a new auth realm."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/{session_id}/prepare-auth",
            headers={
                "x-api-key": config.backend.api_key or "",
                "x-user-id": user_id,
                "Content-Type": "application/json",
            },
            json={"target_url": target_url},
        )
    if response.status_code in (200, 201):
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("Browser credential preparation returned a non-object payload")
        return data
    raise RuntimeError(
        f"Failed to prepare browser credentials for {target_url}: HTTP {response.status_code} {response.text[:300]}"
    )


async def mark_steel_session_auth_failed(
    config: Any,
    user_id: str,
    steel_session_auth_id: str,
    reason: str,
) -> Dict[str, Any]:
    """Disable a stale Steel auth marker so the next session can fall through to cookies."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/auth-options/steel-sessions/{steel_session_auth_id}/auth-failed",
            headers={
                "x-api-key": config.backend.api_key or "",
                "x-user-id": user_id,
                "Content-Type": "application/json",
            },
            json={"reason": reason},
        )
    if response.status_code in (200, 204):
        return response.json() if response.content else {"ok": True}
    raise RuntimeError(
        f"Failed to mark Steel session auth failed for {steel_session_auth_id}: "
        f"HTTP {response.status_code} {response.text[:200]}"
    )


async def create_user_auth_assistance_request(
    config: Any,
    *,
    agent_id: str,
    user_id: str,
    auth_realm: str,
    browser_session_id: str,
    steel_session_id: str,
    browser_url: str,
    current_url: str,
    mode: str = "live_view",
) -> Dict[str, Any]:
    """Create the backend row/notification for blocking auth assistance."""
    payload = {
        "agentId": agent_id,
        "userId": user_id,
        "authRealm": auth_realm,
        "browserSessionId": browser_session_id,
        "steelSessionId": steel_session_id,
        "browserUrl": browser_url,
        "currentUrl": current_url,
        "mode": mode,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/auth-assistance",
            headers={
                "x-api-key": config.backend.api_key or "",
                "x-user-id": user_id,
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if response.status_code in (200, 201):
        data = response.json()
        return data if isinstance(data, dict) else {}
    raise RuntimeError(f"Failed to create auth assistance request: HTTP {response.status_code} {response.text[:200]}")


async def fetch_session_info(config: Any, task_id: str, validate_live: bool = False) -> Dict[str, Any]:
    """Fetch session info for a resumed task."""
    params = {"validateLive": "true"} if validate_live else None
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/browser-session/task/{task_id}",
            headers={"x-api-key": config.backend.api_key or ""},
            params=params,
        )
        if response.status_code == 200:
            return response.json()
        raise RuntimeError(f"Failed to fetch session info: HTTP {response.status_code}")


async def fetch_browser_control_state(config: Any, task_id: str) -> str:
    """Read agent/user ownership without reserving credentials or passkey counters."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/browser-session/task/{task_id}/control",
            headers={"x-api-key": config.backend.api_key or ""},
        )
    if response.status_code == 200:
        return str(response.json().get("state") or "agent")
    raise RuntimeError(f"Failed to fetch browser control state: HTTP {response.status_code}")


async def acknowledge_browser_user_control(config: Any, task_id: str) -> str:
    """Acknowledge ownership at an action boundary before user input is enabled."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/task/{task_id}/control",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
            json={"mode": "acknowledge"},
        )
    if response.status_code == 200:
        return str(response.json().get("state") or "agent")
    raise RuntimeError(f"Failed to acknowledge browser control: HTTP {response.status_code}")


async def close_browser_session(config: Any, session_id: str, pause: bool = False, current_url: str = "") -> None:
    """Close or pause a browser session."""
    payload: Dict[str, Any] = {"session_id": session_id, "pause": pause}
    if current_url:
        payload["current_url"] = current_url
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/browser-session/close",
                headers={"x-api-key": config.backend.api_key or ""},
                json=payload,
            )
    except Exception as e:
        logger.warning(f"Failed to close/pause session: {e}")


async def inject_local_storage(config: Any, session_id: str, origin: str) -> Optional[Dict[str, Any]]:
    """Inject localStorage for an origin into a browser session."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            inject_response = await client.post(
                f"{config.backend.api_url}/api/browser-session/{session_id}/inject-localStorage",
                headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                json={"origin": origin},
            )
            if inject_response.status_code == 200:
                return inject_response.json()
            else:
                logger.warning(f"Failed to inject localStorage: HTTP {inject_response.status_code}")
                return None
    except Exception as e:
        logger.warning(f"Failed to inject localStorage: {e}")
        return None


async def upload_file_to_session(
    config: Any,
    session_id: str,
    filename: str,
    file_content: bytes,
    mime_type: str = "application/octet-stream",
) -> Optional[Dict[str, Any]]:
    """Upload a file to a Steel browser session."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/browser-session/{session_id}/files",
                headers={"x-api-key": config.backend.api_key or ""},
                files={"file": (filename, file_content, mime_type)},
            )
            if response.status_code in [200, 201]:
                return response.json()
            else:
                logger.error(f"Failed to upload {filename}: HTTP {response.status_code} - {response.text[:200]}")
                return None
    except Exception as e:
        logger.error(f"Failed to upload file {filename}: {e}")
        return None


async def take_browser_computer_screenshot(config: Any, session_id: str) -> Dict[str, Any]:
    """Capture the browser window through the active provider."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/browser-session/{session_id}/screenshot",
            headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
        )
        response.raise_for_status()
        result = response.json()

    screenshot_b64 = result.get("base64_image")
    if not screenshot_b64:
        details = result.get("error") or result.get("output") or result.get("system") or "missing base64_image"
        raise RuntimeError(f"Browser screenshot did not return an image: {details}")
    return result


# ========================================
# EXTRACT LLM CALL (gpt-4.1-mini)
# ========================================


async def call_extract_llm(
    instruction: str,
    page_content: str,
    current_url: str,
) -> str:
    """Call gpt-4.1-mini via OpenRouter to extract structured data from page."""
    from config import load_config

    config = load_config()

    truncated_content = page_content[:EXTRACT_MAX_CONTENT_LENGTH]
    if len(page_content) > EXTRACT_MAX_CONTENT_LENGTH:
        truncated_content += f"\n\n... [truncated {len(page_content) - EXTRACT_MAX_CONTENT_LENGTH} chars]"

    system_prompt = """You are a data extraction assistant. Extract information from the provided web page content according to the user's instruction.

Be precise and only extract what is asked for. If the requested information is not found, say so clearly.

Return the extracted data in a clear, structured format."""

    user_prompt = f"""URL: {current_url}

PAGE CONTENT:
{truncated_content}

EXTRACTION INSTRUCTION:
{instruction}

Extract the requested information from the page content above."""

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                config.openrouter.base_url + "/chat/completions",
                headers={
                    "Authorization": f"Bearer {config.openrouter.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://roselabs.ai",
                    "X-Title": "Rose Browser Agent Extract",
                },
                json={
                    "model": EXTRACT_LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "max_tokens": EXTRACT_LLM_MAX_TOKENS,
                    "temperature": EXTRACT_LLM_TEMPERATURE,
                },
            )

            if response.status_code != 200:
                logger.error(f"Extract LLM error: {response.status_code} - {response.text[:500]}")
                return f"Extraction failed: HTTP {response.status_code}"

            result = response.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            return content or "No content extracted"

    except Exception as e:
        logger.error(f"Extract LLM call failed: {e}")
        return f"Extraction failed: {e!s}"


# ========================================
# OTP FETCH
# ========================================


async def fetch_recent_emails(user_id: str, api_url: str, api_key: str, since: str, limit: int = 20) -> List[Dict]:
    """Fetch recent emails for OTP extraction. Returns list of email dicts or empty list."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{api_url}/api/integrations/email/messages",
                params={"since": since, "limit": limit},
                headers={
                    "X-API-Key": api_key,
                    "x-user-id": user_id,
                },
            )

            if response.status_code == 404:
                return []  # Gmail not connected

            if response.status_code != 200:
                logger.warning("Failed to fetch emails for OTP", status=response.status_code)
                return []

            data = response.json()
            return data.get("emails", [])
    except Exception as e:
        logger.warning("Failed to fetch emails", error=str(e))
        return []


async def fetch_recent_sms_messages(
    user_id: str, api_url: str, api_key: str, since: str, limit: int = 20
) -> List[Dict]:
    """Fetch recent agent-phone SMS messages for OTP extraction."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{api_url}/api/agentphone/messages",
                params={"since": since, "limit": limit},
                headers={
                    "X-API-Key": api_key,
                    "x-user-id": user_id,
                },
            )

            if response.status_code == 404:
                return []

            if response.status_code != 200:
                logger.warning("Failed to fetch SMS messages for OTP", status=response.status_code)
                return []

            data = response.json()
            return data.get("messages", [])
    except Exception as e:
        logger.warning("Failed to fetch SMS messages", error=str(e))
        return []


async def fetch_recent_imessages(user_id: str, api_url: str, api_key: str, since: str, limit: int = 20) -> List[Dict]:
    """Fetch recent inbound iMessages (synced from the user's Mac) for OTP extraction.

    Returns the same ``{id, from, to, body, date}`` shape as the agent-phone SMS
    endpoint so callers can treat both as a single SMS-style source.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{api_url}/api/imessage/recent-inbound",
                params={"since": since, "limit": limit, "channel": "IMESSAGE"},
                headers={
                    "X-API-Key": api_key,
                    "x-user-id": user_id,
                },
            )

            if response.status_code == 404:
                return []

            if response.status_code != 200:
                logger.warning("Failed to fetch iMessages for OTP", status=response.status_code)
                return []

            data = response.json()
            return data.get("messages", [])
    except Exception as e:
        logger.warning("Failed to fetch iMessages", error=str(e))
        return []
