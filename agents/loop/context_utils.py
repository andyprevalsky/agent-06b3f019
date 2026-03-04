"""Shared context utilities for run_agent and DAG executor."""

from datetime import datetime
from typing import Callable, Awaitable, List, Dict

import structlog

logger = structlog.get_logger()


async def poll_and_update_context(
    poll_messages: Callable[[datetime], Awaitable[List[Dict]]],
    context: List[Dict],
    last_checked: datetime,
) -> datetime:
    """Poll DB for new messages and merge into context.

    Args:
        poll_messages: Callback that takes last_checked timestamp, returns new messages.
        context: Mutable context list to update in-place.
        last_checked: Timestamp of last poll.

    Returns:
        Updated last_checked timestamp.
    """
    new_msgs = await poll_messages(last_checked)

    if new_msgs:
        for msg in new_msgs:
            if msg not in context:
                context.append(msg)
        context.sort(key=lambda x: x.get("timestamp", ""))
        for msg in context:
            ts_str = msg.get("timestamp", "")
            if ts_str:
                try:
                    msg_ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                    if msg_ts > last_checked:
                        last_checked = msg_ts
                except Exception:
                    pass

    return last_checked
