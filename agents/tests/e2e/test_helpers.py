"""
E2E Test Helpers

Reusable functions for spawning agents via the API and verifying results.
Uses Supabase authentication with test credentials.

NOTE: Tests cannot run in parallel - each test spawns a real agent that
consumes resources and may interfere with other tests.
"""

import asyncio
import json
import os
import shlex
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse
import httpx

# Configuration
BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:3001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://kzlurqihzaolhzsbkctf.supabase.co")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp")
TEST_PHONE = os.environ.get("TEST_PHONE", "+19729777432")
TEST_OTP = os.environ.get("TEST_OTP", "181818")

DEFAULT_TIMEOUT = 300  # 5 minutes default timeout
DEFAULT_POLL_INTERVAL = 2  # Poll every 2 seconds
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INTERNAL_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

# Global auth state (cached after first authentication)
_auth_state: dict = {}


@dataclass
class AgentResult:
    """Result of an agent execution."""
    agent_id: str
    status: str
    messages: list
    progress: float
    duration_seconds: float
    error: Optional[str] = None


@dataclass(frozen=True)
class AuthHandoffStateExpectation:
    """Live browser state that must survive automation/user/automation handoff."""

    input_selector: str
    automation_value: str
    interactive_value: str
    timeout_ms: int = 15_000


@dataclass(frozen=True)
class CredentialBackpropExpectation:
    """Expected credential state transition after post-run credential propagation."""

    credential_ref_kind: str
    credential_ref_id: str
    expected_terminal_status: str
    expected_before_disabled: bool
    expected_after_disabled: bool
    expected_propagation_outcome: str
    expected_failure_reason: str | None = None
    state_timeout_seconds: int = 90
    state_poll_interval_seconds: int = 2


@dataclass(frozen=True)
class CredentialBackpropFixture:
    """Concrete credential fixture provisioned for a live backprop E2E case."""

    run_id: str
    target_url: str
    credential_ref_kind: str
    credential_ref_id: str


class TestTimeoutError(Exception):
    """Raised when a test times out."""
    pass


class AgentFailedError(Exception):
    """Raised when an agent fails."""
    pass


class AuthenticationError(Exception):
    """Raised when authentication fails."""
    pass


async def authenticate() -> dict:
    """
    Authenticate with Supabase using test credentials.
    Returns dict with access_token and user_id.
    Caches result for subsequent calls.
    """
    global _auth_state

    if _auth_state.get("access_token"):
        return _auth_state

    backend_api_key = _read_backend_api_key()
    if backend_api_key:
        user_id = os.environ.get("E2E_INTERNAL_USER_ID", DEFAULT_INTERNAL_USER_ID)
        _auth_state = {
            "access_token": None,
            "api_key": backend_api_key,
            "user_id": user_id,
            "auth_mode": "internal_api_key",
        }
        print(f"  Authenticated via internal API key as user {user_id[:8]}...")
        return _auth_state

    print("  Authenticating with Supabase...")

    async with httpx.AsyncClient() as client:
        # Send OTP
        otp_response = await client.post(
            f"{SUPABASE_URL}/auth/v1/otp",
            headers={
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "apikey": SUPABASE_ANON_KEY,
                "Content-Type": "application/json",
                "X-Supabase-Api-Version": "2024-01-01",
            },
            json={
                "phone": TEST_PHONE,
                "create_user": True,
                "channel": "sms",
            },
        )

        if otp_response.status_code != 200:
            raise AuthenticationError(f"OTP send failed: {otp_response.status_code} - {otp_response.text}")

        # Verify OTP
        verify_response = await client.post(
            f"{SUPABASE_URL}/auth/v1/verify",
            headers={
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "apikey": SUPABASE_ANON_KEY,
                "Content-Type": "application/json",
                "X-Supabase-Api-Version": "2024-01-01",
            },
            json={
                "phone": TEST_PHONE,
                "token": TEST_OTP,
                "type": "sms",
            },
        )

        if verify_response.status_code != 200:
            raise AuthenticationError(f"OTP verify failed: {verify_response.status_code} - {verify_response.text}")

        data = verify_response.json()
        _auth_state = {
            "access_token": data["access_token"],
            "user_id": data["user"]["id"],
        }

        print(f"  Authenticated as user {_auth_state['user_id'][:8]}...")
        return _auth_state


def get_auth_headers() -> dict:
    """Get authorization headers for API requests."""
    if _auth_state.get("api_key"):
        return {
            "x-api-key": _auth_state["api_key"],
            "x-user-id": _auth_state["user_id"],
            "Content-Type": "application/json",
        }
    if not _auth_state.get("access_token"):
        raise AuthenticationError("Not authenticated. Call authenticate() first.")
    return {
        "Authorization": f"Bearer {_auth_state['access_token']}",
        "Content-Type": "application/json",
    }


def _read_env_file_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        if name.strip() != key:
            continue
        value = value.strip().strip('"').strip("'")
        return value or None
    return None


def _read_backend_api_key() -> str | None:
    return (
        os.environ.get("BACKEND_API_KEY")
        or _read_env_file_value(REPO_ROOT / "agents" / ".env", "BACKEND_API_KEY")
        or _read_env_file_value(REPO_ROOT / "back-end" / ".env", "BACKEND_API_KEY")
    )


async def spawn_agent(
    goal: str,
    model: str = "rose-labs/rose-1-lite",
    timeout: int = DEFAULT_TIMEOUT,
    task_queue: Optional[str] = None,
    start_phase: Optional[str] = None,
) -> str:
    """
    Spawn a new agent via the API.

    Args:
        goal: The goal/prompt for the agent
        model: The model to use (default: rose-1-lite)
        timeout: Timeout in seconds (not used here, just for reference)
        task_queue: The Temporal task queue to use
        start_phase: Optional "plan" or "execute" workflow phase to bypass chat mode

    Returns:
        The agent_id of the spawned agent
    """
    # Ensure authenticated
    await authenticate()
    resolved_task_queue = task_queue or os.environ.get("E2E_TASK_QUEUE", "navi-agent-tasks-test")
    payload = {
        "goal": goal,
        "model": model,
        "task_queue": resolved_task_queue,
        "source": "WEB",
        "verifier": {
            "type": "FLOAT_LLM_JUDGE",
        },
    }
    if start_phase:
        payload["start_phase"] = start_phase

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{BASE_URL}/api/agents",
            headers=get_auth_headers(),
            json=payload,
        )
        if response.status_code != 201:
            raise Exception(f"Failed to spawn agent: {response.status_code} - {response.text}")

        data = response.json()
        return data["agent_id"]


async def get_agent_status(agent_id: str) -> dict:
    """
    Get the current status and messages of an agent.

    Args:
        agent_id: The agent ID to check

    Returns:
        Dict with agent status and messages
    """
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{BASE_URL}/api/agents/{agent_id}",
            headers=get_auth_headers(),
        )
        if response.status_code != 200:
            raise Exception(f"Failed to get agent status: {response.status_code} - {response.text}")

        return response.json()


async def get_browser_task_info(task_id: str, *, validate_live: bool = False) -> dict:
    """Fetch browser-session task info from the backend."""
    params = {"validateLive": "true"} if validate_live else None
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{BASE_URL}/api/browser-session/task/{task_id}",
            headers=get_auth_headers(),
            params=params,
        )
        if response.status_code != 200:
            raise Exception(f"Failed to get browser task info: {response.status_code} - {response.text}")
        data = response.json()
        if not isinstance(data, dict):
            raise Exception("Browser task info response was not an object")
        return data


async def complete_auth_assistance_request(request_id: str) -> dict:
    """Mark an auth-assistance request complete, which resumes the paused workflow."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{BASE_URL}/api/attention-requests/{request_id}/respond",
            headers=get_auth_headers(),
            json={"response": "Authentication complete"},
        )
        if response.status_code != 200:
            raise Exception(
                f"Failed to complete auth assistance request: {response.status_code} - {response.text}"
            )
        data = response.json()
        if not isinstance(data, dict):
            raise Exception("Auth assistance completion response was not an object")
        return data


def _get_nested_dict(value: object, key: str) -> dict | None:
    if isinstance(value, dict):
        nested = value.get(key)
        return nested if isinstance(nested, dict) else None
    return None


def _extract_auth_request_metadata(message: dict) -> dict | None:
    metadata = message.get("metadata", {})
    auth_request = _get_nested_dict(metadata, "requestUserAuthentication")
    if auth_request is None:
        return None
    request_id = auth_request.get("requestId") or auth_request.get("request_id")
    if isinstance(request_id, str) and request_id:
        return auth_request
    return None


def _extract_browser_task_id(auth_request: dict, messages: list[dict]) -> str | None:
    for key in ("taskId", "task_id", "subAgentId", "sub_agent_id"):
        value = auth_request.get(key)
        if isinstance(value, str) and value:
            return value

    steel_session_id = auth_request.get("steelSessionId") or auth_request.get("steel_session_id")
    for message in reversed(messages):
        metadata = message.get("metadata", {})
        if not isinstance(metadata, dict):
            continue
        metadata_session_id = metadata.get("steelSessionId") or metadata.get("steel_session_id")
        if steel_session_id and metadata_session_id and metadata_session_id != steel_session_id:
            continue
        for key in ("task_id", "taskId", "subAgentId", "sub_agent_id"):
            value = metadata.get(key)
            if isinstance(value, str) and value:
                return value

    return None


def _assert_automation_value_observed(expected_value: str, observed_value: str) -> None:
    """Validate the page kept the automation-entered value before user mutation."""
    if observed_value == expected_value or observed_value.rstrip(" \t\r\n") == expected_value:
        return
    raise AssertionError(
        "Interactive handoff did not observe the automation-entered input value. "
        f"Expected {expected_value!r}, got {observed_value!r}"
    )


def _assert_single_live_auth_handoff_request(request_id: str, handled_request_ids: set[str]) -> None:
    if handled_request_ids:
        raise AssertionError(
            "Browser agent requested authentication assistance more than once during live handoff state e2e. "
            f"Already handled {sorted(handled_request_ids)}; new request {request_id!r}"
        )


async def _drive_live_auth_handoff_state(
    *,
    auth_request: dict,
    messages: list[dict],
    expectation: AuthHandoffStateExpectation,
) -> None:
    """Act as the live-view user by attaching to the still-running Steel CDP session."""
    request_id = auth_request.get("requestId") or auth_request.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        raise AssertionError("Auth assistance metadata is missing requestId")

    task_id = _extract_browser_task_id(auth_request, messages)
    if not task_id:
        raise AssertionError("Auth assistance metadata is missing browser taskId")

    task_info = await get_browser_task_info(task_id, validate_live=True)
    steel_session_id = auth_request.get("steelSessionId") or auth_request.get("steel_session_id")
    if steel_session_id and task_info.get("session_id") != steel_session_id:
        raise AssertionError(
            "Auth assistance task resolved to a different Steel session. "
            f"Expected {steel_session_id}, got {task_info.get('session_id')}"
        )
    if task_info.get("same_session_available") is not True:
        raise AssertionError(
            "Steel session was not live for auth assistance handoff. "
            f"Reason: {task_info.get('same_session_unavailable_reason')}"
        )

    ws_url = task_info.get("ws_url")
    if not isinstance(ws_url, str) or not ws_url:
        raise AssertionError("Live Steel session did not expose a CDP ws_url")

    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover - environment failure is surfaced in e2e output
        raise AssertionError("Playwright is required for auth handoff live-state e2e") from exc

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(ws_url)
        deadline = time.monotonic() + (expectation.timeout_ms / 1000)
        page = None
        while time.monotonic() < deadline and page is None:
            pages = [p for context in browser.contexts for p in context.pages]
            non_blank_pages = [p for p in pages if p.url and p.url != "about:blank"]
            page = (non_blank_pages or pages or [None])[-1]
            if page is None:
                await asyncio.sleep(0.25)

        if page is None:
            raise AssertionError("No page was available in the live Steel session")

        locator = page.locator(expectation.input_selector).first
        await locator.wait_for(state="visible", timeout=expectation.timeout_ms)
        url_before = page.url
        automation_value = await locator.input_value(timeout=expectation.timeout_ms)
        _assert_automation_value_observed(expectation.automation_value, automation_value)

        await locator.fill(expectation.interactive_value, timeout=expectation.timeout_ms)
        interactive_value = await locator.input_value(timeout=expectation.timeout_ms)
        if interactive_value != expectation.interactive_value:
            raise AssertionError(
                "Interactive handoff failed to mutate the live input value. "
                f"Expected {expectation.interactive_value!r}, got {interactive_value!r}"
            )
        if page.url != url_before:
            raise AssertionError(
                "Interactive handoff changed the page URL. "
                f"Before: {url_before}; after: {page.url}"
            )

    await complete_auth_assistance_request(request_id)


async def _maybe_drive_auth_handoff(
    *,
    messages: list[dict],
    expectation: AuthHandoffStateExpectation | None,
    handled_request_ids: set[str],
) -> bool:
    if expectation is None:
        return False
    for message in messages:
        auth_request = _extract_auth_request_metadata(message)
        if auth_request is None:
            continue
        request_id = auth_request.get("requestId") or auth_request.get("request_id")
        if not isinstance(request_id, str) or request_id in handled_request_ids:
            continue
        _assert_single_live_auth_handoff_request(request_id, handled_request_ids)
        await _drive_live_auth_handoff_state(
            auth_request=auth_request,
            messages=messages,
            expectation=expectation,
        )
        handled_request_ids.add(request_id)
        return True
    return False


async def poll_until_complete(
    agent_id: str,
    timeout: int = DEFAULT_TIMEOUT,
    poll_interval: int = DEFAULT_POLL_INTERVAL,
    auth_handoff_state: AuthHandoffStateExpectation | None = None,
) -> AgentResult:
    """
    Poll an agent until it completes or fails (for agent mode workflows).

    Args:
        agent_id: The agent ID to poll
        timeout: Maximum time to wait in seconds
        poll_interval: Time between polls in seconds

    Returns:
        AgentResult with final status and messages

    Raises:
        TestTimeoutError: If the agent doesn't complete within timeout
    """
    start_time = time.time()
    terminal_statuses = {"COMPLETED", "FAILED", "OUT_OF_CREDITS"}
    handled_auth_request_ids: set[str] = set()

    while True:
        elapsed = time.time() - start_time
        if elapsed > timeout:
            raise TestTimeoutError(
                f"Agent {agent_id} did not complete within {timeout}s (last check at {elapsed:.1f}s)"
            )

        try:
            data = await get_agent_status(agent_id)
            agent = data.get("agent", {})
            status = agent.get("status", "UNKNOWN")
            progress = agent.get("progress", 0)
            messages = data.get("messages", [])

            if await _maybe_drive_auth_handoff(
                messages=messages,
                expectation=auth_handoff_state,
                handled_request_ids=handled_auth_request_ids,
            ):
                print(f"  Completed live auth handoff for {agent_id[:8]}...")
                await asyncio.sleep(poll_interval)
                continue

            if status in terminal_statuses:
                return AgentResult(
                    agent_id=agent_id,
                    status=status,
                    messages=messages,
                    progress=progress,
                    duration_seconds=time.time() - start_time,
                    error=agent.get("status_message") if status == "FAILED" else None,
                )

            # Log progress periodically
            if int(elapsed) % 10 == 0 and elapsed > 0:
                print(f"  ... {agent_id[:8]} - {status} - {progress:.0%} ({elapsed:.0f}s)")

        except AssertionError:
            raise
        except Exception as e:
            print(f"  Warning: Error polling agent {agent_id}: {e}")

        await asyncio.sleep(poll_interval)


async def poll_until_response(
    agent_id: str,
    timeout: int = DEFAULT_TIMEOUT,
    poll_interval: int = DEFAULT_POLL_INTERVAL,
    min_assistant_messages: int = 1,
) -> AgentResult:
    """
    Poll an agent until it has assistant response messages (for chat mode).

    Chat mode agents stay ACTIVE but produce ASSISTANT messages. This polls
    until we have at least min_assistant_messages from the assistant.

    Args:
        agent_id: The agent ID to poll
        timeout: Maximum time to wait in seconds
        poll_interval: Time between polls in seconds
        min_assistant_messages: Minimum number of ASSISTANT messages to wait for

    Returns:
        AgentResult with status and messages

    Raises:
        TestTimeoutError: If no response within timeout
    """
    start_time = time.time()

    while True:
        elapsed = time.time() - start_time
        if elapsed > timeout:
            raise TestTimeoutError(
                f"Agent {agent_id} did not respond within {timeout}s (last check at {elapsed:.1f}s)"
            )

        try:
            data = await get_agent_status(agent_id)
            agent = data.get("agent", {})
            status = agent.get("status", "UNKNOWN")
            progress = agent.get("progress", 0)
            messages = data.get("messages", [])

            # Check for failure
            if status in {"FAILED", "OUT_OF_CREDITS"}:
                return AgentResult(
                    agent_id=agent_id,
                    status=status,
                    messages=messages,
                    progress=progress,
                    duration_seconds=time.time() - start_time,
                    error=agent.get("status_message"),
                )

            # Count assistant messages
            assistant_messages = [m for m in messages if m.get("role") == "ASSISTANT"]

            if len(assistant_messages) >= min_assistant_messages:
                return AgentResult(
                    agent_id=agent_id,
                    status=status,
                    messages=messages,
                    progress=progress,
                    duration_seconds=time.time() - start_time,
                )

            # Log progress periodically
            if int(elapsed) % 10 == 0 and elapsed > 0:
                print(f"  ... {agent_id[:8]} - {status} - {len(assistant_messages)} responses ({elapsed:.0f}s)")

        except Exception as e:
            print(f"  Warning: Error polling agent {agent_id}: {e}")

        await asyncio.sleep(poll_interval)


async def cleanup_agent(agent_id: str) -> bool:
    """
    Delete an agent to clean up after a test.

    Args:
        agent_id: The agent ID to delete

    Returns:
        True if deleted successfully
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.delete(
                f"{BASE_URL}/api/agents/{agent_id}",
                headers=get_auth_headers(),
            )
            return response.status_code == 204
    except Exception as e:
        print(f"  Warning: Failed to cleanup agent {agent_id}: {e}")
        return False


def _local_database_url_from_services_file() -> str | None:
    services_path = REPO_ROOT / ".context" / "services.json"
    if not services_path.exists():
        return None
    try:
        data = json.loads(services_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    ports = data.get("ports") if isinstance(data, dict) else None
    local_db_port = ports.get("local_db") if isinstance(ports, dict) else None
    if not isinstance(local_db_port, int):
        return None
    return f"postgresql://postgres:postgres@localhost:{local_db_port}/victoria"


def _credential_backprop_helper_env() -> dict[str, str]:
    parsed_base_url = urlparse(BASE_URL)
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if (
        not os.environ.get("E2E_CREDENTIAL_BACKPROP_STATE_COMMAND")
        and parsed_base_url.hostname not in local_hosts
    ):
        raise AssertionError(
            "Credential backprop DB assertions require a local TEST_BASE_URL when using the "
            "default DB helper. Set E2E_CREDENTIAL_BACKPROP_STATE_COMMAND for a backend with a "
            "different database."
        )

    env = dict(os.environ)
    if not env.get("DATABASE_URL"):
        local_database_url = _local_database_url_from_services_file()
        if local_database_url:
            env["DATABASE_URL"] = local_database_url
            env.setdefault("DIRECT_URL", local_database_url)
    return env


async def _run_credential_backprop_helper(args: list[str]) -> dict:
    configured_command = os.environ.get("E2E_CREDENTIAL_BACKPROP_STATE_COMMAND")
    if configured_command:
        command_args = shlex.split(configured_command)
        cwd = REPO_ROOT
    else:
        npx = shutil.which("npx")
        if npx is None:
            raise AssertionError("npx is required to run the credential backprop DB helper")
        command_args = [
            npx,
            "tsx",
            "scripts/e2e-credential-backprop-state.ts",
        ]
        cwd = REPO_ROOT / "back-end"

    process = await asyncio.create_subprocess_exec(
        *command_args,
        *args,
        cwd=str(cwd),
        env=_credential_backprop_helper_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        raise AssertionError(
            "Credential backprop DB helper failed. "
            f"Exit {process.returncode}. Stderr: {stderr.decode('utf-8', errors='replace')[:1000]}"
        )

    try:
        data = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AssertionError(
            "Credential backprop DB helper returned invalid JSON: "
            f"{stdout.decode('utf-8', errors='replace')[:1000]}"
        ) from exc

    if not isinstance(data, dict):
        raise AssertionError("Credential backprop DB helper returned non-object JSON")
    return data


async def prepare_credential_backprop_fixture(case_name: str) -> CredentialBackpropFixture:
    """Seed the local backend DB with a real saved-password fixture for an E2E case."""
    auth_state = await authenticate()
    user_id = str(auth_state["user_id"])
    data = await _run_credential_backprop_helper(["setup", "--case", case_name, "--user-id", user_id])
    fixture = data.get("fixture")
    if not isinstance(fixture, dict):
        raise AssertionError(f"Credential backprop setup returned no fixture object: {data}")
    return CredentialBackpropFixture(
        run_id=str(fixture["runId"]),
        target_url=str(fixture["targetUrl"]),
        credential_ref_kind=str(fixture["credentialRefKind"]),
        credential_ref_id=str(fixture["credentialRefId"]),
    )


async def cleanup_credential_backprop_fixture(fixture: CredentialBackpropFixture | None) -> None:
    if fixture is None:
        return
    try:
        auth_state = await authenticate()
        await _run_credential_backprop_helper(
            ["cleanup", "--run-id", fixture.run_id, "--user-id", str(auth_state["user_id"])]
        )
    except Exception as exc:
        print(f"  Warning: Failed to cleanup credential backprop fixture {fixture.run_id}: {exc}")


def assert_agent_completed(result: AgentResult) -> None:
    """
    Assert that an agent completed successfully.

    Args:
        result: The AgentResult to check

    Raises:
        AgentFailedError: If the agent did not complete successfully
    """
    if result.status != "COMPLETED":
        raise AgentFailedError(
            f"Agent {result.agent_id} did not complete. "
            f"Status: {result.status}, Error: {result.error}"
        )


def assert_messages_contain(result: AgentResult, patterns: list[str]) -> None:
    """
    Assert that agent messages contain certain patterns.

    Args:
        result: The AgentResult to check
        patterns: List of substrings that should appear in messages

    Raises:
        AssertionError: If any pattern is not found
    """
    all_text = " ".join(
        msg.get("text", "") for msg in result.messages if msg.get("text")
    ).lower()

    for pattern in patterns:
        if pattern.lower() not in all_text:
            raise AssertionError(
                f"Pattern '{pattern}' not found in agent messages. "
                f"Agent ID: {result.agent_id}"
            )


def assert_has_tool_calls(result: AgentResult, tool_names: list[str]) -> None:
    """
    Assert that the agent made calls to specific tools.

    Args:
        result: The AgentResult to check
        tool_names: List of tool names that should have been called

    Raises:
        AssertionError: If any tool was not called
    """
    # Look for tool call evidence in messages
    all_text = " ".join(
        str(msg.get("metadata", {})) + " " + msg.get("text", "")
        for msg in result.messages
    ).lower()

    for tool_name in tool_names:
        if tool_name.lower() not in all_text:
            raise AssertionError(
                f"Tool '{tool_name}' does not appear to have been called. "
                f"Agent ID: {result.agent_id}"
            )


def _collect_credential_ref_kinds(value: object) -> set[str]:
    kinds: set[str] = set()
    if isinstance(value, dict):
        credential_ref = value.get("credential_ref") or value.get("credentialRef")
        if isinstance(credential_ref, dict):
            kind = credential_ref.get("kind")
            if isinstance(kind, str):
                kinds.add(kind)
        for nested in value.values():
            kinds.update(_collect_credential_ref_kinds(nested))
    elif isinstance(value, list):
        for item in value:
            kinds.update(_collect_credential_ref_kinds(item))
    return kinds


def assert_has_credential_refs(result: AgentResult, credential_ref_kinds: list[str]) -> None:
    """Assert that browser-agent messages logged expected credential refs."""
    observed: set[str] = set()
    for message in result.messages:
        observed.update(_collect_credential_ref_kinds(message.get("metadata", {})))

    for kind in credential_ref_kinds:
        if kind not in observed:
            raise AssertionError(
                f"Credential ref kind '{kind}' not found in agent messages. "
                f"Observed: {sorted(observed)}. Agent ID: {result.agent_id}"
            )


def _normalize_credential_ref_kind(kind: str) -> str:
    normalized = "".join(
        f"_{char.lower()}" if char.isupper() else char
        for char in kind
    ).strip("_").lower()
    aliases = {
        "cookie": "cookie_bundle",
        "browser_password": "password",
        "steel": "steel_session",
        "steel_auth": "steel_session",
        "email": "email_otp",
        "otp": "email_otp",
        "minted_account": "minted",
    }
    return aliases.get(normalized, normalized)


def _collect_credential_refs(value: object) -> set[tuple[str, str]]:
    refs: set[tuple[str, str]] = set()
    if isinstance(value, dict):
        credential_ref = value.get("credential_ref") or value.get("credentialRef")
        raw_refs = credential_ref if isinstance(credential_ref, list) else [credential_ref]
        for raw_ref in raw_refs:
            if not isinstance(raw_ref, dict):
                continue
            kind = raw_ref.get("kind")
            credential_id = raw_ref.get("id")
            if isinstance(kind, str) and isinstance(credential_id, str) and credential_id:
                refs.add((_normalize_credential_ref_kind(kind), credential_id))
        for nested in value.values():
            refs.update(_collect_credential_refs(nested))
    elif isinstance(value, list):
        for item in value:
            refs.update(_collect_credential_refs(item))
    return refs


def assert_has_credential_ref(result: AgentResult, credential_ref_kind: str, credential_ref_id: str) -> None:
    """Assert browser-agent messages logged the exact credential ref under test."""
    observed: set[tuple[str, str]] = set()
    for message in result.messages:
        observed.update(_collect_credential_refs(message.get("metadata", {})))

    expected = (_normalize_credential_ref_kind(credential_ref_kind), credential_ref_id)
    if expected not in observed:
        raise AssertionError(
            "Expected credential ref not found in agent messages. "
            f"Expected: {expected}. Observed: {sorted(observed)}. Agent ID: {result.agent_id}"
        )


async def read_credential_backprop_state(
    credential_ref_kind: str,
    credential_ref_id: str,
    *,
    agent_id: str | None = None,
) -> dict:
    """Read credential and agent propagation state from the backend database."""
    if not credential_ref_kind.strip() or not credential_ref_id.strip():
        raise AssertionError("Credential backprop state lookup requires kind and id")

    args = ["state", "--kind", credential_ref_kind, "--id", credential_ref_id]
    if agent_id:
        args.extend(["--agent-id", agent_id])
    return await _run_credential_backprop_helper(args)


def _credential_state_from_snapshot(snapshot: dict) -> dict:
    credential = snapshot.get("credential")
    if not isinstance(credential, dict):
        raise AssertionError("Credential backprop state snapshot is missing credential object")
    if credential.get("exists") is not True:
        raise AssertionError(
            "Credential backprop state snapshot did not find the credential. "
            f"Credential: {credential}"
        )
    return credential


def _is_disabled_credential_state(credential: dict) -> bool:
    return credential.get("disabledAt") is not None


def _assert_credential_disabled_state(credential: dict, expected_disabled: bool, phase: str) -> None:
    disabled = _is_disabled_credential_state(credential)
    if disabled != expected_disabled:
        raise AssertionError(
            f"Credential {phase} disabledAt state mismatch. "
            f"Expected disabled={expected_disabled}, got disabledAt={credential.get('disabledAt')!r}, "
            f"disabledReason={credential.get('disabledReason')!r}"
        )
    if expected_disabled is False and credential.get("disabledReason") is not None:
        raise AssertionError(
            f"Credential {phase} should have cleared disabledReason, got "
            f"{credential.get('disabledReason')!r}"
        )


def assert_credential_backprop_initial_state(
    snapshot: dict,
    expectation: CredentialBackpropExpectation,
) -> None:
    credential = _credential_state_from_snapshot(snapshot)
    if _normalize_credential_ref_kind(str(credential.get("kind", ""))) != _normalize_credential_ref_kind(
        expectation.credential_ref_kind
    ):
        raise AssertionError(
            "Credential backprop state helper returned the wrong credential kind. "
            f"Expected {expectation.credential_ref_kind}, got {credential.get('kind')}"
        )
    if credential.get("id") != expectation.credential_ref_id:
        raise AssertionError(
            "Credential backprop state helper returned the wrong credential id. "
            f"Expected {expectation.credential_ref_id}, got {credential.get('id')}"
        )
    _assert_credential_disabled_state(credential, expectation.expected_before_disabled, "initial")


def _classifier_messages(snapshot: dict) -> list[dict]:
    agent = snapshot.get("agent")
    if not isinstance(agent, dict):
        return []
    messages = agent.get("classifierMessages")
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict)]


def assert_credential_backprop_final_state(
    snapshot: dict,
    expectation: CredentialBackpropExpectation,
) -> None:
    credential = _credential_state_from_snapshot(snapshot)
    _assert_credential_disabled_state(credential, expectation.expected_after_disabled, "final")

    agent = snapshot.get("agent")
    if not isinstance(agent, dict):
        raise AssertionError("Credential backprop final snapshot is missing agent object")
    if agent.get("status") != expectation.expected_terminal_status:
        raise AssertionError(
            "Credential backprop final snapshot has unexpected agent status. "
            f"Expected {expectation.expected_terminal_status}, got {agent.get('status')}"
        )
    if agent.get("propagationApplied") is not True:
        raise AssertionError("Credential propagation marker was not present for the completed agent run")

    expected_ref = (
        _normalize_credential_ref_kind(expectation.credential_ref_kind),
        expectation.credential_ref_id,
    )
    observed_refs = {
        (_normalize_credential_ref_kind(str(ref.get("kind"))), str(ref.get("id")))
        for ref in agent.get("credentialRefs", [])
        if isinstance(ref, dict) and ref.get("kind") and ref.get("id")
    }
    if expected_ref not in observed_refs:
        raise AssertionError(
            "Credential propagation DB messages did not include the expected credential ref. "
            f"Expected {expected_ref}. Observed: {sorted(observed_refs)}"
        )

    if expectation.expected_failure_reason is None:
        return

    classifier_messages = _classifier_messages(snapshot)
    matching_messages = [
        message
        for message in classifier_messages
        if message.get("failureReason") == expectation.expected_failure_reason
        and message.get("credentialPropagationOutcome") == expectation.expected_propagation_outcome
    ]
    if not matching_messages:
        raise AssertionError(
            "Credential failure classifier did not expose the expected failureReason. "
            f"Expected failureReason={expectation.expected_failure_reason!r}, "
            f"outcome={expectation.expected_propagation_outcome!r}. "
            f"Observed classifier messages: {classifier_messages}"
        )

    disabled_reason = credential.get("disabledReason")
    if not isinstance(disabled_reason, str) or expectation.expected_failure_reason not in disabled_reason:
        raise AssertionError(
            "Credential disabledReason did not include the classifier failureReason. "
            f"Expected {expectation.expected_failure_reason!r}, got {disabled_reason!r}"
        )


async def wait_for_credential_backprop_final_state(
    expectation: CredentialBackpropExpectation,
    *,
    agent_id: str,
) -> dict:
    """Poll DB state until asynchronous post-run credential propagation is visible."""
    deadline = time.monotonic() + expectation.state_timeout_seconds
    last_snapshot: dict | None = None
    last_error: AssertionError | None = None

    while time.monotonic() < deadline:
        last_snapshot = await read_credential_backprop_state(
            expectation.credential_ref_kind,
            expectation.credential_ref_id,
            agent_id=agent_id,
        )
        try:
            assert_credential_backprop_final_state(last_snapshot, expectation)
            return last_snapshot
        except AssertionError as exc:
            last_error = exc
            await asyncio.sleep(expectation.state_poll_interval_seconds)

    raise AssertionError(
        "Timed out waiting for credential backprop DB state. "
        f"Last assertion: {last_error}. Last snapshot: {last_snapshot}"
    )


def _collect_keyed_dicts(value: object, key: str) -> list[dict]:
    matches: list[dict] = []
    if isinstance(value, dict):
        keyed_value = value.get(key)
        if isinstance(keyed_value, dict):
            matches.append(keyed_value)
        for nested in value.values():
            matches.extend(_collect_keyed_dicts(nested, key))
    elif isinstance(value, list):
        for item in value:
            matches.extend(_collect_keyed_dicts(item, key))
    return matches


def _collect_steel_session_ids(value: object) -> set[str]:
    session_ids: set[str] = set()
    if isinstance(value, dict):
        for key in ("steelSessionId", "steel_session_id", "session_id"):
            session_id = value.get(key)
            if isinstance(session_id, str) and session_id:
                session_ids.add(session_id)
        for nested in value.values():
            session_ids.update(_collect_steel_session_ids(nested))
    elif isinstance(value, list):
        for item in value:
            session_ids.update(_collect_steel_session_ids(item))
    return session_ids


def _metadata_fallback_markers(value: object, path: str = "metadata") -> list[str]:
    markers: list[str] = []
    blocked_key_parts = (
        "fallback",
        "new_session",
        "newsession",
        "cookie_bundle",
    )
    blocked_value_parts = (
        "restart_auth_with_cookie_bundle",
        "restart_after_auth_failure",
        "fallback",
        "new session",
        "new_session",
        "newsession",
        "cookie_bundle",
    )

    if isinstance(value, dict):
        for key, nested in value.items():
            nested_path = f"{path}.{key}"
            normalized_key = key.lower()
            if any(part in normalized_key for part in blocked_key_parts):
                markers.append(nested_path)
            if isinstance(nested, str):
                normalized_value = nested.lower()
                if any(part in normalized_value for part in blocked_value_parts):
                    markers.append(f"{nested_path}={nested}")
            markers.extend(_metadata_fallback_markers(nested, nested_path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            markers.extend(_metadata_fallback_markers(item, f"{path}[{index}]"))
    return markers


def _is_user_assistance_received_message(message: dict) -> bool:
    metadata = message.get("metadata", {})
    if not isinstance(metadata, dict):
        return False
    title = str(metadata.get("title") or message.get("title") or "")
    action_type = str(metadata.get("action_type") or "")
    auth_request = metadata.get("requestUserAuthentication")
    if title == "User Assistance Received":
        return True
    return action_type == "auth_assistance" and isinstance(auth_request, dict) and not (
        auth_request.get("liveViewUrl") or auth_request.get("live_view_url")
    )


def _post_handoff_navigation_marker(message: dict) -> str | None:
    metadata = message.get("metadata", {})
    if not isinstance(metadata, dict):
        return None

    action_type = str(metadata.get("action_type") or "").lower()
    blocked_action_parts = ("goto", "navigate", "navigation", "refresh", "reload")
    if any(part in action_type for part in blocked_action_parts):
        return f"action_type={action_type}"

    title = str(metadata.get("title") or message.get("title") or "").lower()
    blocked_title_parts = ("navigating", "navigated", "refresh", "reload")
    if any(part in title for part in blocked_title_parts):
        return f"title={title}"

    return None


def _assert_interactive_live_view_url(live_view_url: str, agent_id: str) -> None:
    parsed = urlparse(live_view_url)
    query = parse_qs(parsed.query)
    interactive = query.get("interactive", [])
    show_controls = query.get("showControls", [])

    if "true" not in [value.lower() for value in interactive]:
        raise AssertionError(
            f"Auth assistance liveViewUrl is not interactive=true: {live_view_url}. "
            f"Agent ID: {agent_id}"
        )
    if "true" not in [value.lower() for value in show_controls]:
        raise AssertionError(
            f"Auth assistance liveViewUrl is not showControls=true: {live_view_url}. "
            f"Agent ID: {agent_id}"
        )


def assert_same_steel_session_auth_handoff(result: AgentResult) -> None:
    """Assert auth assistance handed off and resumed in the same Steel session."""
    auth_requests: list[dict] = []
    steel_session_ids: set[str] = set()
    live_view_urls: list[str] = []
    fallback_markers: list[str] = []
    resume_modes: list[str] = []
    post_handoff_navigation_markers: list[str] = []
    after_user_assistance = False

    for message in result.messages:
        metadata = message.get("metadata", {})
        if after_user_assistance:
            marker = _post_handoff_navigation_marker(message)
            if marker:
                post_handoff_navigation_markers.append(marker)
        if _is_user_assistance_received_message(message):
            after_user_assistance = True

        message_auth_requests = _collect_keyed_dicts(metadata, "requestUserAuthentication")
        auth_requests.extend(message_auth_requests)
        if message_auth_requests:
            steel_session_ids.update(_collect_steel_session_ids(metadata))
            for auth_request in message_auth_requests:
                resume_mode = auth_request.get("resumeMode") or auth_request.get("resume_mode")
                if isinstance(resume_mode, str) and resume_mode:
                    resume_modes.append(resume_mode)
        fallback_markers.extend(_metadata_fallback_markers(metadata))

    for auth_request in auth_requests:
        live_view_url = auth_request.get("liveViewUrl") or auth_request.get("live_view_url")
        if isinstance(live_view_url, str) and live_view_url:
            live_view_urls.append(live_view_url)

    if not auth_requests:
        raise AssertionError(
            "No requestUserAuthentication metadata found in agent messages. "
            f"Agent ID: {result.agent_id}"
        )
    if not live_view_urls:
        raise AssertionError(
            "No auth assistance liveViewUrl found in requestUserAuthentication metadata. "
            f"Agent ID: {result.agent_id}"
        )
    for live_view_url in live_view_urls:
        _assert_interactive_live_view_url(live_view_url, result.agent_id)

    if len(steel_session_ids) != 1:
        raise AssertionError(
            "Auth assistance did not use exactly one stable Steel session. "
            f"Observed Steel session IDs: {sorted(steel_session_ids)}. Agent ID: {result.agent_id}"
        )
    if fallback_markers:
        raise AssertionError(
            "Auth assistance metadata indicates fallback or new-session resume. "
            f"Markers: {fallback_markers}. Agent ID: {result.agent_id}"
        )
    if "same_steel_session" not in resume_modes:
        raise AssertionError(
            "Auth assistance completion did not report resumeMode=same_steel_session. "
            f"Observed resume modes: {resume_modes}. Agent ID: {result.agent_id}"
        )
    if post_handoff_navigation_markers:
        raise AssertionError(
            "Auth assistance resumed with a navigation/refresh action after user handoff. "
            f"Markers: {post_handoff_navigation_markers}. Agent ID: {result.agent_id}"
        )


def assert_agent_terminal_status(result: AgentResult, expected_status: str) -> None:
    if result.status != expected_status:
        raise AgentFailedError(
            f"Agent {result.agent_id} reached unexpected terminal status. "
            f"Expected: {expected_status}, Actual: {result.status}, Error: {result.error}"
        )


async def run_e2e_test(
    name: str,
    goal: str,
    timeout: int = DEFAULT_TIMEOUT,
    model: str = "rose-labs/rose-1-lite",
    expected_patterns: Optional[list[str]] = None,
    expected_tools: Optional[list[str]] = None,
    expected_credential_ref_kinds: Optional[list[str]] = None,
    expected_same_steel_session_auth_handoff: bool = False,
    auth_handoff_state: AuthHandoffStateExpectation | None = None,
    credential_backprop_expectation: CredentialBackpropExpectation | None = None,
    expected_terminal_status: str | None = None,
    start_phase: Optional[str] = None,
    cleanup: bool = True,
    is_chat_mode: bool = False,
) -> tuple[bool, str, float]:
    """
    Run a complete e2e test: spawn agent, wait for completion/response, verify, cleanup.

    Args:
        name: Test name for logging
        goal: The goal/prompt for the agent
        timeout: Maximum time to wait
        model: Model to use
        expected_patterns: Patterns to look for in messages
        expected_tools: Tools that should have been called
        expected_credential_ref_kinds: Credential ref metadata kinds that should appear
        expected_same_steel_session_auth_handoff: Assert auth assistance stayed on one Steel session
        auth_handoff_state: Optional live-state driver for auth assistance handoff
        credential_backprop_expectation: Optional DB-backed credential propagation assertion
        expected_terminal_status: Optional terminal status to accept instead of requiring COMPLETED
        start_phase: Optional "plan" or "execute" workflow phase to bypass chat mode
        cleanup: Whether to delete the agent after the test
        is_chat_mode: If True, poll for response messages instead of COMPLETED status

    Returns:
        Tuple of (passed, message, duration_seconds)
    """
    agent_id = None
    start_time = time.time()

    try:
        if credential_backprop_expectation:
            print("  Reading initial credential state...")
            initial_state = await read_credential_backprop_state(
                credential_backprop_expectation.credential_ref_kind,
                credential_backprop_expectation.credential_ref_id,
            )
            assert_credential_backprop_initial_state(initial_state, credential_backprop_expectation)

        print(f"  Spawning agent for: {name}")
        agent_id = await spawn_agent(goal, model=model, timeout=timeout, start_phase=start_phase)
        print(f"  Agent spawned: {agent_id[:8]}...")

        if is_chat_mode:
            print(f"  Waiting for chat response (timeout: {timeout}s)...")
            result = await poll_until_response(agent_id, timeout=timeout)
        else:
            print(f"  Waiting for completion (timeout: {timeout}s)...")
            result = await poll_until_complete(
                agent_id,
                timeout=timeout,
                auth_handoff_state=auth_handoff_state,
            )
            # Verify completion only for agent mode
            if expected_terminal_status:
                assert_agent_terminal_status(result, expected_terminal_status)
            else:
                assert_agent_completed(result)

        # Verify patterns if specified
        if expected_patterns:
            assert_messages_contain(result, expected_patterns)

        # Verify tools if specified
        if expected_tools:
            assert_has_tool_calls(result, expected_tools)

        if expected_credential_ref_kinds:
            assert_has_credential_refs(result, expected_credential_ref_kinds)

        if credential_backprop_expectation:
            assert_has_credential_ref(
                result,
                credential_backprop_expectation.credential_ref_kind,
                credential_backprop_expectation.credential_ref_id,
            )
            print("  Waiting for credential backprop DB state...")
            await wait_for_credential_backprop_final_state(
                credential_backprop_expectation,
                agent_id=result.agent_id,
            )

        if expected_same_steel_session_auth_handoff:
            assert_same_steel_session_auth_handoff(result)

        duration = time.time() - start_time
        mode = "chat response" if is_chat_mode else "completed"
        return (True, f"Got {mode} in {duration:.1f}s", duration)

    except TestTimeoutError as e:
        duration = time.time() - start_time
        return (False, f"Timeout: {e}", duration)

    except AgentFailedError as e:
        duration = time.time() - start_time
        return (False, f"Agent failed: {e}", duration)

    except AssertionError as e:
        duration = time.time() - start_time
        return (False, f"Assertion failed: {e}", duration)

    except Exception as e:
        duration = time.time() - start_time
        return (False, f"Error: {e}", duration)

    finally:
        if cleanup and agent_id:
            await cleanup_agent(agent_id)
