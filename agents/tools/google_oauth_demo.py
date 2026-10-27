"""Root-only Google OAuth video tool backed by a pure in-memory fixture."""

from __future__ import annotations

from typing import Any

from providers.demo_cache.google_oauth_demo_fixture import matches_demo_goal, run_fixture
from domains.send_message_to_user.types import build_attention_metadata
from tools.base import EventType, MessageStatus, ToolEvent


async def google_oauth_demo(
    workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str
) -> dict[str, Any]:
    """Show each in-memory operation as a card without spawning an agent."""
    if not matches_demo_goal(getattr(workflow_instance, "goal", None)):
        raise ValueError("Google workspace tool is available only to its exact benchmark goal")

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
    rows = result["rows"]
    project_sync = rows[6]["result"]["events"][0]
    lunch = rows[7]["result"]["event"]
    reply = rows[2]["args"]["body"]
    renewal = rows[10]["args"]["line"]
    progress = {
        1: "I’ll check the connected account and read the unread messages first.",
        3: "I found Sam’s question and the Acme newsletter. I’ll prepare Sam’s reply and confirm it reaches Sent.",
        7: "The reply is in Sent and Acme is out of Inbox. I’ll check tomorrow’s calendar and add Friday lunch.",
        9: "Project Sync is at 10:00 AM and Friday lunch is on the calendar. I’ll open Lease in Drive next.",
        12: "Lease ends December 31, 2026, and the renewal line appears once. I’ll disconnect the account now.",
    }
    card_text = [
        (f"Connected: {rows[0]['result']['account']}", f"Connected: {rows[0]['result']['account']}."),
        ("Unread: Sam and Acme", rows[1]["result"]["summary"]),
        ("Drafted Sam’s reply", f'Drafted reply to Sam: "{reply}"'),
        ("Approved Sam’s reply", f'Approved Sam’s reply draft: "{reply}"'),
        ("Reply sent and in Sent", f'Sent reply to Sam: "{reply}" Confirmed in Sent.'),
        ("Acme archived; out of Inbox", "Archived the Acme newsletter; confirmed it is absent from Inbox."),
        ("Project Sync tomorrow at 10:00 AM", f"Tomorrow ({project_sync['date']}): {project_sync['title']} at {project_sync['time']}."),
        ("Lunch with Alex added Friday at noon", f"Added {lunch['title']} on {lunch['date']} at {lunch['time']}."),
        ("Found Lease in Drive", f"Found Drive document: {rows[8]['result']['title']}."),
        (f"Lease ends {rows[9]['result']['end_date']}", f"Lease end date: {rows[9]['result']['end_date']}."),
        ("Renew by Dec 1 added once", f'Added "{renewal}" to Lease; confirmed it appears exactly once.'),
        ("Google account disconnected", f"Disconnected {result['account']}; the account is no longer connected."),
    ]
    for index, row in enumerate(result["rows"], start=1):
        if index in progress:
            note = progress[index]
            await workflow_instance._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="FYI for User",
                    message=note,
                    status=MessageStatus.FINISHED,
                    metadata={
                        **build_attention_metadata(note, False, is_waiting=False),
                        "fixtureProgress": True,
                        "fixtureParentToolCallId": tool_call_id,
                    },
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
            message=(
                f"Connected account: {result['account']}.\n"
                + "\n".join(result["answers"])
                + "\nFinal state: Google account disconnected."
            ),
            status=MessageStatus.FINISHED,
            metadata={"fixtureSession": True, "fixtureResult": result},
        ),
        tool_call_id,
        "google_workspace_run",
    )
    return {"result": result}
