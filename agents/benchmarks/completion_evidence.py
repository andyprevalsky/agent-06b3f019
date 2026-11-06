"""Pure projection of actual final completion cards for benchmark consumers.

No judge, prompt, routing, budget or outcome policy belongs at this boundary.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Iterable


def completion_card(metadata: Any) -> dict | None:
    if not isinstance(metadata, dict):
        return None
    card = metadata.get("completionSummary")
    if (metadata.get("toolName") == "completion_summary"
            and str(metadata.get("toolStatus") or "").upper() == "FINISHED"
            and isinstance(card, dict)):
        return card
    return None


def completion_card_text(metadata: Any) -> str:
    card = completion_card(metadata)
    if card is None:
        return ""
    lines = [card["summary"]] if isinstance(card.get("summary"), str) and card["summary"] else []
    outputs = card.get("outputs")
    for output in outputs if isinstance(outputs, list) else []:
        if isinstance(output, dict):
            label = str(output.get("label") or output.get("key") or "")
            value = json.dumps(output.get("value"), ensure_ascii=False, default=str)
            lines.append(f"- {label}: {value}" if label else f"- {value}")
    return "\n".join(lines)


def completion_message_text(message: dict) -> str:
    text = str(message.get("text") or message.get("message") or message.get("content") or "")
    rendered = completion_card_text(message.get("metadata"))
    card = completion_card(message.get("metadata"))
    if card is not None and text == card.get("summary"):
        return rendered
    if not rendered or text == rendered:
        return text or rendered
    return f"{text}\n{rendered}" if text else rendered


def completion_messages(messages: Iterable[dict]) -> list[dict]:
    """Deduplicate only a repeated durable message/card identity with identical content."""
    result: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for message in messages:
        if not isinstance(message, dict) or completion_card(message.get("metadata")) is None:
            continue
        identity = message.get("message_id") or message.get("id")
        if identity:
            key = (str(identity), json.dumps(completion_payload(message), sort_keys=True, ensure_ascii=False))
            if key in seen:
                continue
            seen.add(key)
        result.append(message)
    return result


def completion_payload(message: dict) -> dict:
    card = completion_card(message.get("metadata"))
    if card is None:
        return {}
    payload = {"summary": card.get("summary", ""), "outputs": card.get("outputs", [])}
    text = message.get("text") or message.get("message") or message.get("content")
    if text and text not in (card.get("summary"), completion_card_text(message.get("metadata"))):
        payload["message_text"] = text
    return payload


def tree_completion_messages(data: dict) -> list[tuple[str, dict]]:
    agent = data.get("agent") or {}
    root_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "")
    sources = {root_id: list(data.get("messages") or [])}
    tree = data.get("_semantic_evaluator_tree") or {}
    if isinstance(tree, dict):
        for agent_id, info in tree.items():
            if isinstance(info, dict):
                sources.setdefault(str(agent_id), []).extend(info.get("messages") or [])
    result = [(agent_id, message) for agent_id, messages in sources.items()
              for message in completion_messages(messages)]
    # Never invent timestamps. If every card has a timestamp, stable-sort the
    # cross-agent projection; otherwise preserve collected source order.
    timestamps = []
    for _, message in result:
        raw = message.get("created_at") or message.get("createdAt") or message.get("timestamp")
        try:
            timestamps.append(datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp())
        except (ValueError, TypeError, OverflowError):
            return result
    return [item for _, item in sorted(zip(timestamps, result), key=lambda pair: pair[0])]
