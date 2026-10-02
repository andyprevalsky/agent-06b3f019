"""Root-only Google OAuth video tool backed by a pure in-memory fixture."""

from __future__ import annotations

from typing import Any

from domains.api_request.google_oauth_demo_fixture import matches_demo_goal, run_fixture
from tools.base import EventType, MessageStatus, ToolEvent


async def google_oauth_demo(
    workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str
) -> dict[str, Any]:
    """Show each in-memory operation as a card without spawning an agent."""
    if not matches_demo_goal(getattr(workflow_instance, "goal", None)):
        raise ValueError("Google workspace tool is available only to its exact benchmark goal")

    progress = {
        1: "I’ll check the connected account and read the unread messages first.",
        3: "I found Sam’s question and the Acme newsletter. I’ll prepare Sam’s reply and confirm it reaches Sent.",
        7: "The reply is in Sent and Acme is out of Inbox. I’ll check tomorrow’s calendar and add Friday lunch.",
        9: "Project Sync is at 10:00 AM and Friday lunch is on the calendar. I’ll open Lease in Drive next.",
        12: "Lease ends December 31, 2026, and the renewal line appears once. I’ll disconnect the account now.",
    }
    card_text = [
        ("Connected Google account", "test@gmail.com is connected."),
        ("Read unread Gmail", "Sam asks whether Thursday works; Acme sent a newsletter."),
        ("Drafted Sam’s reply", "Draft: Thursday works."),
        ("Approved Sam’s draft", "The reply draft is approved."),
        ("Sent Sam’s reply", "The reply appears in Sent."),
        ("Archived Acme newsletter", "The newsletter is no longer in Inbox."),
        ("Read tomorrow’s calendar", "Project Sync is on October 2 at 10:00 AM."),
        ("Added Friday lunch", "Lunch with Alex is on October 2 at 12:00 PM."),
        ("Found Lease in Drive", "The Lease document is available."),
        ("Read Lease", "Lease ends December 31, 2026."),
        ("Updated Lease", "Renew by Dec 1 appears exactly once."),
        ("Disconnected Google account", "The account is disconnected."),
    ]

    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Google workspace tasks",
            message="Checking Gmail, Calendar, and Drive in order.",
            status=MessageStatus.IN_PROGRESS,
            metadata={"fixtureSession": True},
        ),
        tool_call_id,
        "google_workspace_run",
    )

    result = run_fixture()
    for index, row in enumerate(result["rows"], start=1):
        if index in progress:
            await workflow_instance._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Progress",
                    message=progress[index],
                    status=MessageStatus.FINISHED,
                    metadata={"fixtureProgress": True, "fixtureParentToolCallId": tool_call_id},
                ),
                f"{tool_call_id}-progress-{index}",
                "google_workspace_progress",
            )
        title, message = card_text[index - 1]
        await workflow_instance._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=title,
                message=message,
                status=MessageStatus.FINISHED,
                metadata={"fixtureRow": row, "fixtureParentToolCallId": tool_call_id},
            ),
            f"{tool_call_id}-operation-{index}",
            row["tool"],
        )

    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Google workspace tasks complete",
            message="Finished the requested Gmail, Calendar, Drive, and account steps.",
            status=MessageStatus.FINISHED,
            metadata={"fixtureSession": True, "fixtureResult": result},
        ),
        tool_call_id,
        "google_workspace_run",
    )
    return {"result": result}
