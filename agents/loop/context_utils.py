"""Shared context utilities for run_agent and DAG executor."""

from datetime import datetime
from typing import Awaitable, Callable, Dict, List

from helpers.workflow_safe import context_logger
from helpers.context_pointers import annotate_with_pointer
from helpers.context_scope import filter_internal_subagent_messages

logger = context_logger()


def user_pause_recorded_at(message: Dict) -> str:
    pause = (message.get("metadata") or {}).get("userPause")
    if isinstance(pause, dict) and pause.get("reason") == "user":
        return str(pause.get("recordedAt") or "")
    return ""


def refresh_user_pause(context: List[Dict], incoming: Dict) -> None:
    """Apply the one supported in-place lifecycle annotation, never reorder it."""
    message_id = incoming.get("message_id") or incoming.get("id")
    updated = user_pause_recorded_at(incoming)
    if not message_id or not updated:
        return
    for index, previous in enumerate(context):
        if (previous.get("message_id") or previous.get("id")) != message_id:
            continue
        if updated <= user_pause_recorded_at(previous):
            return
        old_meta, new_meta = previous.get("metadata") or {}, incoming.get("metadata") or {}
        if (previous.get("timestamp") != incoming.get("timestamp") or
                old_meta.get("toolCallId") != new_meta.get("toolCallId") or
                old_meta.get("workflowGeneration") != new_meta.get("workflowGeneration")):
            return
        replacement = dict(incoming)
        annotate_with_pointer(replacement)
        context[index] = replacement
        return


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
            ts_str = max(msg.get("timestamp", ""), user_pause_recorded_at(msg))
            if ts_str:
                try:
                    msg_ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if msg_ts > last_checked:
                        last_checked = msg_ts
                except Exception:
                    pass

        new_msgs = filter_internal_subagent_messages(new_msgs)
        def _message_dedupe_key(msg: Dict) -> str:
            metadata = msg.get("metadata") or {}
            return "|".join(
                [
                    str(msg.get("role") or ""),
                    str(msg.get("timestamp") or ""),
                    str(metadata.get("toolCallId") or ""),
                    str(metadata.get("toolName") or ""),
                    str(msg.get("text") or "")[:256],
                ]
            )

        seen_message_ids = {
            msg.get("message_id") or msg.get("id")
            for msg in context
            if msg.get("message_id") or msg.get("id")
        }
        seen_message_keys = {
            _message_dedupe_key(msg)
            for msg in context
            if not (msg.get("message_id") or msg.get("id"))
        }
        for msg in new_msgs:
            message_id = msg.get("message_id") or msg.get("id")
            if message_id:
                if message_id in seen_message_ids:
                    refresh_user_pause(context, msg)
                    continue
                seen_message_ids.add(message_id)
            else:
                message_key = _message_dedupe_key(msg)
                if message_key in seen_message_keys:
                    continue
                seen_message_keys.add(message_key)
            annotate_with_pointer(msg)
            context.append(msg)
        context.sort(key=lambda x: x.get("timestamp", ""))

    return last_checked
