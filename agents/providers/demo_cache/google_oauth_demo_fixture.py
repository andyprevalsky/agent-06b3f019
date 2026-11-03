"""In-memory Google OAuth video fixture, gated to the single DEMO catalog task."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from providers.demo_cache.normalize import (
    GOOGLE_OAUTH_DEMO_GOAL_HASH,
    GOOGLE_OAUTH_DEMO_PROMPT_PREFIX,
    goal_hash,
)

DEMO_URL = "https://google-oauth-demo.invalid/run"
DEMO_LABEL = "DEMO fixture, no live Google data changed"


def matches_demo_goal(goal: str | None) -> bool:
    if not goal or not goal.startswith(GOOGLE_OAUTH_DEMO_PROMPT_PREFIX):
        return False
    return goal_hash(goal) == GOOGLE_OAUTH_DEMO_GOAL_HASH


def normalize_completion_notice(
    goal: str | None, outputs: dict[str, Any] | None, summary: str
) -> tuple[dict[str, Any] | None, str]:
    """Keep this DEMO's disclosure literal after the verifier paraphrases it."""
    if not isinstance(outputs, dict) or "demo_notice" not in outputs or not matches_demo_goal(goal):
        return outputs, summary
    normalized = {**outputs, "demo_notice": DEMO_LABEL}
    if DEMO_LABEL not in summary:
        summary = f"{DEMO_LABEL}\n\n{summary}" if summary else DEMO_LABEL
    return normalized, summary


def run_fixture() -> dict[str, Any]:
    """Run the fixed video scenario; every operation checks or changes local state."""
    today = date(2026, 10, 1)
    tomorrow = today + timedelta(days=1)
    days_until_friday = (4 - today.weekday()) % 7 or 7
    friday = today + timedelta(days=days_until_friday)
    assert friday.weekday() == 4

    state: dict[str, Any] = {
        "connected": True,
        "account": "test@gmail.com",
        "emails": {
            "sam": {"from": "sam@example.com", "unread": True, "inbox": True},
            "acme": {"from": "news@acme.example", "unread": True, "inbox": True},
        },
        "draft": None,
        "sent": [],
        "events": [{"title": "Project Sync", "date": tomorrow.isoformat(), "time": "10:00 AM"}],
        "doc": {"title": "Lease", "end_date": "December 31, 2026", "lines": []},
    }
    rows: list[dict[str, Any]] = []

    def record(tool: str, args: dict[str, Any], result: dict[str, Any], delta: dict[str, Any]) -> None:
        rows.append({"tool": tool, "args": args, "result": result, "delta": delta})

    assert state["connected"] and state["account"] == "test@gmail.com"
    record("google_connection_status", {}, {"connected": True, "account": state["account"]}, {})

    unread = [mail for mail in state["emails"].values() if mail["unread"] and mail["inbox"]]
    assert len(unread) == 2
    summary = "Sam asks whether Thursday works; Acme sent a newsletter."
    record("gmail_list_unread", {}, {"summary": summary}, {})

    state["draft"] = {"to": "sam@example.com", "body": "Thursday works.", "approved": False}
    record(
        "gmail_create_reply_draft",
        {"to": "Sam", "body": "Thursday works."},
        {"drafted": True},
        {"draft": "Thursday works."},
    )

    assert state["draft"]["body"] == "Thursday works."
    state["draft"]["approved"] = True
    record("gmail_approve_draft", {"to": "Sam"}, {"approved": True}, {"draft_approved": True})

    assert state["draft"]["approved"]
    state["sent"].append(state["draft"].copy())
    state["draft"] = None
    assert any(mail["to"] == "sam@example.com" and mail["body"] == "Thursday works." for mail in state["sent"])
    record("gmail_send_draft", {"to": "Sam"}, {"sent": True, "in_sent": True}, {"sent_to": "sam@example.com"})

    state["emails"]["acme"]["inbox"] = False
    assert not state["emails"]["acme"]["inbox"]
    record("gmail_archive", {"from": "Acme"}, {"archived": True, "in_inbox": False}, {"acme_inbox": False})

    tomorrow_events = [event for event in state["events"] if event["date"] == tomorrow.isoformat()]
    assert tomorrow_events == [{"title": "Project Sync", "date": tomorrow.isoformat(), "time": "10:00 AM"}]
    record("calendar_list_tomorrow", {"date": tomorrow.isoformat()}, {"events": tomorrow_events}, {})

    lunch = {"title": "Lunch with Alex", "date": friday.isoformat(), "time": "12:00 PM"}
    state["events"].append(lunch)
    assert date.fromisoformat(lunch["date"]) == friday and lunch in state["events"]
    record("calendar_create_event", lunch, {"created": True, "event": lunch}, {"event_added": lunch["title"]})

    assert state["doc"]["title"] == "Lease"
    record("drive_search", {"name": "Lease"}, {"found": True, "title": "Lease"}, {})
    record("drive_read", {"name": "Lease"}, {"end_date": state["doc"]["end_date"]}, {})

    line = "Renew by Dec 1"
    state["doc"]["lines"].append(line)
    assert state["doc"]["lines"].count(line) == 1
    record("drive_append_line", {"name": "Lease", "line": line}, {"appended": True, "count": 1}, {"line_added": line})

    state["connected"] = False
    assert not state["connected"]
    record("google_disconnect", {"account": "test@gmail.com"}, {"connected": False}, {"connected": False})

    assert len(rows) == 12
    assert [row["tool"] for row in rows] == [
        "google_connection_status",
        "gmail_list_unread",
        "gmail_create_reply_draft",
        "gmail_approve_draft",
        "gmail_send_draft",
        "gmail_archive",
        "calendar_list_tomorrow",
        "calendar_create_event",
        "drive_search",
        "drive_read",
        "drive_append_line",
        "google_disconnect",
    ]
    answers = [
        summary,
        "Thursday works. drafted, approved, and sent to Sam; present in Sent.",
        "Acme newsletter archived and absent from Inbox.",
        "Project Sync tomorrow at 10:00 AM.",
        "Lunch with Alex Friday at 12:00 PM.",
        "Lease ends December 31, 2026.",
        "Renew by Dec 1 appended once to Lease.",
    ]
    return {
        "account": "test@gmail.com",
        "fixture_date": today.isoformat(),
        "rows": rows,
        "answers": answers,
        "checks": {
            "sent": True,
            "acme_absent_from_inbox": True,
            "friday_lunch": True,
            "lease_line_once": True,
            "disconnected": True,
        },
    }
