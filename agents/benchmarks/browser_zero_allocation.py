"""Identify a browser tool cancelled before any session was allocated.

This only recognizes the observed pre-allocation cancellation transcript. It
does not establish provider ownership on its own; callers must bind it to the
exact root's before/archive/terminal database snapshots.
"""

from __future__ import annotations

import json


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
