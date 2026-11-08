"""Type definitions for the agent-messaging domain.

No ``from __future__ import annotations`` here: these shapes document activity
results, and stringified TypedDict fields fail to decode inside the workflow
sandbox. Activities themselves return plain ``Dict[str, Any]``.
"""

from typing import Optional, TypedDict


class AgentMessageDelivery(TypedDict, total=False):
    """send_agent_message_activity / send_agent_message_to_address_activity result."""

    delivered: bool
    message_id: Optional[str]
    task_running: Optional[bool]
    queued: bool  # a code agent still starting accepted it: its next turn once the CLI runs
    error: str
    status: int
