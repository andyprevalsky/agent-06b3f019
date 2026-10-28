"""Identify browser cancellation before allocation or task actions.

These transcript checks do not establish provider ownership on their own;
callers must bind them to the exact root's ownership and terminal snapshots.
"""

from __future__ import annotations

import json


def preparation_cancelled_task_receipts(messages: list[dict] | None, agent_id: str) -> dict[str, dict]:
    """Require a positive owner acknowledgment before accepting a pre-action exit."""
    rows = []
    unsafe_task_ids: set[str] = set()
    unsafe_tool_call_ids: set[str] = set()
    for message in messages or []:
        if not isinstance(message, dict):
            return {}
        meta = message.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except ValueError:
                return {}
        if not isinstance(meta, dict):
            return {}
        rows.append(meta)
        if meta.get("action_type") not in ("session_starting", "task_complete"):
            task_id = meta.get("task_id")
            tool_call_id = meta.get("toolCallId")
            if isinstance(task_id, str):
                unsafe_task_ids.add(task_id)
            if isinstance(tool_call_id, str):
                unsafe_tool_call_ids.add(tool_call_id)
    receipts = {}
    for meta in rows:
        receipt = meta.get("browser_preparation_cancellation")
        if not isinstance(receipt, dict):
            continue
        task_id = meta.get("task_id")
        if not (
            (meta.get("toolName") == "spawn_browser_agent" or meta.get("agentType") == "browser")
            and isinstance(task_id, str) and task_id
            and meta.get("action_type") == "task_complete"
            and meta.get("toolStatus") == "FINISHED"
            and meta.get("excludeFromModel") is True
            and type(receipt.get("version")) is int and receipt["version"] == 1
            and receipt.get("agent_id") == agent_id and receipt.get("task_id") == task_id
            and isinstance(receipt.get("tool_call_id"), str) and receipt["tool_call_id"]
            and receipt["tool_call_id"] == meta.get("toolCallId")
            and isinstance(receipt.get("session_id"), str) and receipt["session_id"]
            and receipt.get("provider") in {"tilion", "kernel", "steel", "browser-use"}
            and receipt.get("phase") == "initial_session_preparation"
            and receipt.get("init_acknowledged") is True
            and receipt.get("task_actions_started") is False
        ):
            return {}
        if task_id in unsafe_task_ids or receipt["tool_call_id"] in unsafe_tool_call_ids:
            continue
        prior = receipts.get(task_id)
        if prior is not None and prior != receipt:
            return {}
        receipts[task_id] = receipt
    return receipts


def preparation_receipts_match_sessions(receipts: dict[str, dict], snapshot: dict) -> bool:
    """Bind each acknowledged task handle to the exact root's captured inventory."""
    sessions = snapshot.get("browser_sessions") if isinstance(snapshot, dict) else None
    if not isinstance(sessions, list) or any(not isinstance(row, dict) for row in sessions):
        return False
    session_counts: dict[tuple[str, str, str], int] = {}
    for row in sessions:
        key = (row.get("agent_id"), row.get("provider"), row.get("session_id"))
        if all(isinstance(value, str) for value in key):
            session_counts[key] = session_counts.get(key, 0) + 1
    return all(
        session_counts.get((receipt["agent_id"], receipt["provider"], receipt["session_id"]), 0) == 1
        for receipt in receipts.values()
    )


def cancelled_before_session_task_ids(messages: list[dict] | None) -> set[str]:
    browser_rows = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        meta = message.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except ValueError:
                return set()
        if not isinstance(meta, dict):
            return set()
        if meta.get("toolName") == "spawn_browser_agent" or meta.get("agentType") == "browser":
            browser_rows.append((message, meta))
    starts = [meta for _, meta in browser_rows if meta.get("action_type") == "session_starting"]
    terminals = [(message, meta) for message, meta in browser_rows if meta.get("action_type") == "task_complete"]
    if not starts or len(starts) != len(terminals) or len(browser_rows) != len(starts) + len(terminals):
        return set()
    if any(meta.get("task_id") or meta.get("session_id") or meta.get("toolStatus") != "IN_PROGRESS" for meta in starts):
        return set()
    ids: set[str] = set()
    for message, meta in terminals:
        task_id = meta.get("task_id")
        if (
            not isinstance(task_id, str) or not task_id or task_id in ids
            or meta.get("toolStatus") != "ERROR"
            or meta.get("session_id")
            or (message.get("message") or message.get("text")) != "User paused the browser agent"
        ):
            return set()
        ids.add(task_id)
    return ids
