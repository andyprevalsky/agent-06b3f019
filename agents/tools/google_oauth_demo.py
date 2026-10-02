"""Root-only Google OAuth video tool backed by a pure in-memory fixture."""

from __future__ import annotations

import json
from typing import Any

from domains.api_request.google_oauth_demo_fixture import matches_demo_goal, run_fixture
from tools.base import EventType, MessageStatus, ToolEvent


async def google_oauth_demo(
    workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str
) -> dict[str, Any]:
    """Show each synthetic operation as a card without spawning an agent."""
    if not matches_demo_goal(getattr(workflow_instance, "goal", None)):
        raise ValueError("Google OAuth DEMO tool is available only to its exact benchmark goal")

    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title="DEMO · Google tools",
            message="Running the in-memory Gmail, Calendar, Drive, and disconnect fixture.",
            status=MessageStatus.IN_PROGRESS,
            metadata={"demoFixture": True},
        ),
        tool_call_id,
        "google_oauth_demo",
    )

    result = run_fixture()
    for index, row in enumerate(result["rows"], start=1):
        await workflow_instance._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"DEMO · {row['tool']}",
                message=json.dumps(row, indent=2),
                status=MessageStatus.FINISHED,
                metadata={"demoFixture": True, "demoParentToolCallId": tool_call_id},
            ),
            f"{tool_call_id}-demo-{index}",
            row["tool"],
        )

    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title="DEMO · Google tools complete",
            message=json.dumps(result),
            status=MessageStatus.FINISHED,
            metadata={"demoFixture": True},
        ),
        tool_call_id,
        "google_oauth_demo",
    )
    return {"result": result}
