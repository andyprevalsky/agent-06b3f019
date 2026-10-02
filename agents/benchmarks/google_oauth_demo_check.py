"""Deterministic grading of the Google OAuth DEMO transcript."""

from __future__ import annotations

import json
from typing import Any


EXPECTED_TOOLS = [
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
DEMO_LABEL = "DEMO fixture, no live Google data changed"


def check_google_oauth_demo_trace(data: dict[str, Any]) -> tuple[bool, str]:
    """Grade observed cards and answers without an evaluator model call."""
    try:
        messages = data.get("messages")
        if not isinstance(messages, list):
            raise ValueError("root transcript is missing")

        calls = [
            call.get("tool")
            for message in messages
            if isinstance(message, dict) and message.get("role") == "ASSISTANT"
            for call in (message.get("metadata") or {}).get("tool_calls", [])
        ]
        if calls != ["google_oauth_demo", "attempt_completion"]:
            raise ValueError(f"root tool calls were {calls!r}")

        cards = [
            message
            for message in messages
            if isinstance(message, dict)
            and isinstance(message.get("metadata"), dict)
            and str(message["metadata"].get("title") or "").startswith("DEMO · ")
            and message["metadata"].get("toolName") != "google_oauth_demo"
        ]
        if len(cards) != len(EXPECTED_TOOLS):
            raise ValueError(f"expected 12 visible DEMO cards, observed {len(cards)}")
        parent_ids = {card["metadata"].get("demoParentToolCallId") for card in cards}
        if len(parent_ids) != 1 or None in parent_ids:
            raise ValueError("DEMO cards do not share one root tool call")

        rows = []
        for index, (card, expected_tool) in enumerate(zip(cards, EXPECTED_TOOLS), start=1):
            meta = card["metadata"]
            if (
                card.get("role") != "TOOL"
                or meta.get("demoFixture") is not True
                or meta.get("toolStatus") != "FINISHED"
                or meta.get("toolName") != expected_tool
                or meta.get("title") != f"DEMO · {expected_tool}"
                or meta.get("toolCallId") != f"{next(iter(parent_ids))}-demo-{index}"
            ):
                raise ValueError(f"DEMO card {index} has wrong identity or order")
            try:
                row = json.loads(card.get("message") or "")
            except (TypeError, ValueError) as exc:
                raise ValueError(f"DEMO card {index} has invalid JSON") from exc
            if row.get("tool") != expected_tool:
                raise ValueError(f"DEMO card {index} has wrong operation")
            rows.append(row)

        result = [row["result"] for row in rows]
        args = [row["args"] for row in rows]
        if result[0] != {"connected": True, "account": "test@gmail.com"}:
            raise ValueError("connection card is incorrect")
        if result[1].get("summary") != "Sam asks whether Thursday works; Acme sent a newsletter.":
            raise ValueError("unread summary is incorrect")
        if args[2] != {"to": "Sam", "body": "Thursday works."} or result[2].get("drafted") is not True:
            raise ValueError("Sam reply draft is incorrect")
        if result[3].get("approved") is not True or result[4] != {"sent": True, "in_sent": True}:
            raise ValueError("Sam reply approval or Sent proof is missing")
        if result[5] != {"archived": True, "in_inbox": False}:
            raise ValueError("Acme archive proof is missing")
        if result[6].get("events") != [{"title": "Project Sync", "date": "2026-10-02", "time": "10:00 AM"}]:
            raise ValueError("tomorrow's Project Sync is missing")
        lunch = {"title": "Lunch with Alex", "date": "2026-10-02", "time": "12:00 PM"}
        if args[7] != lunch or result[7] != {"created": True, "event": lunch}:
            raise ValueError("Friday lunch proof is missing")
        if result[8] != {"found": True, "title": "Lease"} or result[9].get("end_date") != "December 31, 2026":
            raise ValueError("Lease search or end date is missing")
        if args[10] != {"name": "Lease", "line": "Renew by Dec 1"} or result[10] != {"appended": True, "count": 1}:
            raise ValueError("Lease renewal line was not appended exactly once")
        if result[11] != {"connected": False}:
            raise ValueError("disconnect card is incorrect")

        parent = [
            message
            for message in messages
            if isinstance(message, dict)
            and (meta := message.get("metadata") or {}).get("toolName") == "google_oauth_demo"
            and meta.get("toolStatus") == "FINISHED"
        ]
        if len(parent) != 1 or parent[0]["metadata"].get("toolCallId") not in parent_ids:
            raise ValueError("root DEMO tool result is missing")
        try:
            summary = json.loads(parent[0].get("message") or "")
        except (TypeError, ValueError) as exc:
            raise ValueError("root DEMO tool result has invalid JSON") from exc
        if summary.get("rows") != rows or summary.get("label") != DEMO_LABEL or summary.get("account") != "test@gmail.com":
            raise ValueError("root DEMO tool result does not match its visible cards")
        if summary.get("checks") != {
            "sent": True,
            "acme_absent_from_inbox": True,
            "friday_lunch": True,
            "lease_line_once": True,
            "disconnected": True,
        }:
            raise ValueError("fixture state assertions are incomplete")
        if len(summary.get("answers") or []) != 7:
            raise ValueError("fixture does not provide all seven answers")

        complete = [
            (message.get("metadata") or {}).get("completionSummary")
            for message in messages
            if isinstance(message, dict)
            and (message.get("metadata") or {}).get("toolName") == "completion_summary"
            and (message.get("metadata") or {}).get("toolStatus") == "FINISHED"
        ]
        if len(complete) != 1 or not isinstance(complete[0], dict):
            raise ValueError("one final completion card was not observed")
        outputs = complete[0].get("outputs") or []
        values = {item.get("key"): item.get("value") for item in outputs if isinstance(item, dict)}
        expected_keys = {
            "demo_notice", "connected_account", "unread_email_summary", "reply_to_sam",
            "archive_acme_newsletter", "tomorrow_calendar", "friday_lunch",
            "lease_end_date", "lease_renewal", "final_disconnected",
        }
        if set(values) != expected_keys:
            raise ValueError("final completion does not contain all ten fields")
        if values["demo_notice"] != DEMO_LABEL or DEMO_LABEL not in str(complete[0].get("summary") or ""):
            raise ValueError("final DEMO disclosure is missing")
        if values["connected_account"] != "test@gmail.com" or values["final_disconnected"] is not True:
            raise ValueError("final account state is incorrect")
        if values["unread_email_summary"] != result[1]["summary"]:
            raise ValueError("final unread answer does not match the card")
        answer_terms = {
            "reply_to_sam": ("Thursday works.", "approv", "sent"),
            "archive_acme_newsletter": ("archiv", "inbox"),
            "tomorrow_calendar": ("Project Sync", "10:00 AM"),
            "friday_lunch": ("Lunch with Alex", "12:00 PM"),
            "lease_end_date": ("December 31, 2026",),
            "lease_renewal": ("Renew by Dec 1", "append", "once"),
        }
        for key, terms in answer_terms.items():
            value = str(values[key]).lower()
            if not all(term.lower() in value for term in terms):
                raise ValueError(f"final {key} answer is incomplete")
        return True, "All twelve DEMO cards and seven final answers passed deterministic checks"
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        return False, str(exc)
