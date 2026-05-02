"""
E2E Test Helpers

Reusable functions for spawning agents via the API and verifying results.
Uses Supabase authentication with test credentials.

NOTE: Tests cannot run in parallel - each test spawns a real agent that
consumes resources and may interfere with other tests.
"""

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Optional
import httpx

# Configuration
BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:3001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://kzlurqihzaolhzsbkctf.supabase.co")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp")
TEST_PHONE = os.environ.get("TEST_PHONE", "+19729777432")
TEST_OTP = os.environ.get("TEST_OTP", "181818")

DEFAULT_TIMEOUT = 300  # 5 minutes default timeout
DEFAULT_POLL_INTERVAL = 2  # Poll every 2 seconds

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
    if not _auth_state.get("access_token"):
        raise AuthenticationError("Not authenticated. Call authenticate() first.")
    return {
        "Authorization": f"Bearer {_auth_state['access_token']}",
        "Content-Type": "application/json",
    }


async def spawn_agent(
    goal: str,
    model: str = "rose-labs/rose-1-lite",
    timeout: int = DEFAULT_TIMEOUT,
    task_queue: str = "navi-agent-tasks-test",
) -> str:
    """
    Spawn a new agent via the API.

    Args:
        goal: The goal/prompt for the agent
        model: The model to use (default: rose-1-lite)
        timeout: Timeout in seconds (not used here, just for reference)
        task_queue: The Temporal task queue to use

    Returns:
        The agent_id of the spawned agent
    """
    # Ensure authenticated
    await authenticate()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{BASE_URL}/api/agents",
            headers=get_auth_headers(),
            json={
                "goal": goal,
                "model": model,
                "task_queue": task_queue,
                "source": "WEB",
                "verifier": {
                    "type": "FLOAT_LLM_JUDGE",
                },
            },
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


async def poll_until_complete(
    agent_id: str,
    timeout: int = DEFAULT_TIMEOUT,
    poll_interval: int = DEFAULT_POLL_INTERVAL,
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


async def run_e2e_test(
    name: str,
    goal: str,
    timeout: int = DEFAULT_TIMEOUT,
    model: str = "rose-1-lite",
    expected_patterns: Optional[list[str]] = None,
    expected_tools: Optional[list[str]] = None,
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
        cleanup: Whether to delete the agent after the test
        is_chat_mode: If True, poll for response messages instead of COMPLETED status

    Returns:
        Tuple of (passed, message, duration_seconds)
    """
    agent_id = None
    start_time = time.time()

    try:
        print(f"  Spawning agent for: {name}")
        agent_id = await spawn_agent(goal, model=model, timeout=timeout)
        print(f"  Agent spawned: {agent_id[:8]}...")

        if is_chat_mode:
            print(f"  Waiting for chat response (timeout: {timeout}s)...")
            result = await poll_until_response(agent_id, timeout=timeout)
        else:
            print(f"  Waiting for completion (timeout: {timeout}s)...")
            result = await poll_until_complete(agent_id, timeout=timeout)
            # Verify completion only for agent mode
            assert_agent_completed(result)

        # Verify patterns if specified
        if expected_patterns:
            assert_messages_contain(result, expected_patterns)

        # Verify tools if specified
        if expected_tools:
            assert_has_tool_calls(result, expected_tools)

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
