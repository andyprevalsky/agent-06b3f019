"""Tree-aware evidence builders for declared benchmark semantic evaluators.

Single-turn judges receive root plus every sub-agent transcript. The grader
has no cutoffs of its own: each tool result is bounded by the runtime's
``hard_cap_tool_result_text`` (the cap agents apply before a tool result enters
their context), and a judge prompt that would overflow the runtime compaction
trigger falls back to the agentic judge (see
run_benchmark._call_declared_llm_judge).
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from helpers.summarize import hard_cap_tool_result_text

SUBAGENT_MESSAGE_TAIL = 500
AGENTIC_ROOT_MESSAGE_TAIL = 500

DECLARED_JUDGE_METADATA_KEYS = (
    "action_type",
    "toolName",
    "toolStatus",
    "url",
    "title",
    "browser_session_metadata",
    "requestUserApproval",
    # completionSummary is rendered as each agent's final_completion ASSISTANT row
    # (_completion_card_payload); keep it out of raw tool metadata so judges see
    # one rendered answer card per completion.
    "toolCallId",
    "subAgentId",
    "task_id",
    "browser_url",
    "agentType",
)

# Coding-agent tool rows whose Claude Code sessions are hydrated for judges.
_GROUNDING_TOOL_RANK: dict[str, int] = {
    "code_agent_sdk_events": 0,
    "claude_code_history": 1,
    "spawn_claude_code_agent": 2,
    "web_search": 4,
    "web_fetch": 5,
}
_EXPLORE_GROUNDING_RANK = 3


def _root_agent_id(data: dict) -> str:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    return str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "")


def _message_text(message: dict, role: str) -> str:
    """Row text, with tool results bounded exactly as the runtime bounds them."""
    text_value = message.get("text", message.get("message", message.get("content", "")))
    if not isinstance(text_value, str):
        text_value = json.dumps(text_value, default=str)
    return hard_cap_tool_result_text(text_value) if role == "TOOL" else text_value


def _message_metadata(message: dict) -> dict[str, Any]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    return {key: metadata[key] for key in DECLARED_JUDGE_METADATA_KEYS if key in metadata}


def _evidence_rows_from_messages(
    messages: Iterable[dict],
    *,
    agent_id: str,
    parent_agent_id: str | None,
    goal: str,
    skip_user_system: bool,
    message_tail: int | None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    message_list = [message for message in messages if isinstance(message, dict)]
    if message_tail is not None:
        message_list = message_list[-message_tail:]
    for message in message_list:
        role = str(message.get("role") or "").upper()
        if skip_user_system and role in {"USER", "SYSTEM"}:
            continue
        row_metadata = _message_metadata(message)
        card = _completion_card_payload(message)
        if card is not None:
            row_metadata["evidence_type"] = "final_completion"
        if agent_id:
            row_metadata["source_agent_id"] = agent_id
        if parent_agent_id:
            row_metadata["source_parent_agent_id"] = parent_agent_id
        if goal:
            row_metadata["source_goal"] = goal[:200]
        rows.append(
            {
                # The rendered Task Complete card is the agent's answer, shown as assistant evidence.
                "role": "ASSISTANT" if card is not None else (role or "UNKNOWN"),
                "text": json.dumps(card, default=str) if card is not None else _message_text(message, role),
                "metadata": row_metadata,
            }
        )
    return rows


def _completion_card_payload(message: dict) -> dict[str, Any] | None:
    """The Task Complete card a FINISHED completion_summary row shows: its summary and outputs.

    The row's own text is empty; the card lives in metadata.completionSummary,
    which the metadata allowlist drops. Render it for every agent, so a judge
    reading a sub-agent's transcript sees the outputs that agent displayed.
    """
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    completion = metadata.get("completionSummary")
    if (
        metadata.get("toolName") != "completion_summary"
        or str(metadata.get("toolStatus") or "").upper() != "FINISHED"
        or not isinstance(completion, dict)
    ):
        return None
    outputs = completion.get("outputs")
    return {
        "summary": str(completion.get("summary") or ""),
        "outputs": outputs[:200] if isinstance(outputs, list) else [],
    }


def _sorted_tree_agent_ids(tree: dict[str, dict], root_id: str) -> list[str]:
    """Depth-first ordering: root first, then children by parent link."""
    if not tree:
        return []
    children_by_parent: dict[str, list[str]] = {}
    for agent_id, info in tree.items():
        parent = str(info.get("parent_agent_id") or "")
        children_by_parent.setdefault(parent, []).append(agent_id)

    ordered: list[str] = []

    def _walk(agent_id: str) -> None:
        if agent_id in ordered:
            return
        ordered.append(agent_id)
        for child_id in sorted(children_by_parent.get(agent_id, [])):
            _walk(child_id)

    if root_id and root_id in tree:
        _walk(root_id)
    for agent_id in sorted(tree):
        if agent_id not in ordered:
            ordered.append(agent_id)
    return ordered


def _final_completion_summaries(data: dict) -> list[dict]:
    summaries: list[dict] = []
    for message in data.get("messages", []) or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        completion = metadata.get("completionSummary")
        if (
            metadata.get("toolName") == "completion_summary"
            and str(metadata.get("toolStatus") or "").upper() == "FINISHED"
            and isinstance(completion, dict)
        ):
            summaries.append(completion)
    return summaries


def build_single_turn_evidence(data: dict) -> list[dict[str, Any]]:
    """Build single-turn judge evidence from root and optional tree transcripts.

    Every message is kept. Tool results carry the runtime per-result cap; the
    caller falls back to the agentic judge when the prompt would overflow.
    """
    root_id = _root_agent_id(data)
    rows = _evidence_rows_from_messages(
        data.get("messages") or [],
        agent_id=root_id,
        parent_agent_id=None,
        goal="",
        skip_user_system=True,
        message_tail=None,
    )

    tree = data.get("_semantic_evaluator_tree")
    if isinstance(tree, dict) and tree:
        for agent_id in _sorted_tree_agent_ids(tree, root_id):
            if agent_id == root_id:
                continue
            info = tree.get(agent_id) or {}
            rows.extend(
                _evidence_rows_from_messages(
                    info.get("messages") or [],
                    agent_id=agent_id,
                    parent_agent_id=str(info.get("parent_agent_id") or "") or None,
                    goal=str(info.get("goal") or ""),
                    skip_user_system=True,
                    message_tail=None,
                )
            )

    rows.append({"benchmark_state": data.get("_benchmark", {})})
    return rows


def build_agentic_evidence(data: dict) -> dict[str, Any]:
    """Build a full trajectory bundle for the agentic Codex judge."""
    root_id = _root_agent_id(data)
    messages: list[dict[str, Any]] = _evidence_rows_from_messages(
        data.get("messages") or [],
        agent_id=root_id,
        parent_agent_id=None,
        goal="",
        skip_user_system=False,
        message_tail=AGENTIC_ROOT_MESSAGE_TAIL,
    )

    tree = data.get("_semantic_evaluator_tree")
    tree_agents: list[dict[str, Any]] = []
    if isinstance(tree, dict) and tree:
        for agent_id in _sorted_tree_agent_ids(tree, root_id):
            info = tree.get(agent_id) or {}
            agent_messages = _evidence_rows_from_messages(
                info.get("messages") or [],
                agent_id=agent_id,
                parent_agent_id=str(info.get("parent_agent_id") or "") or None,
                goal=str(info.get("goal") or ""),
                skip_user_system=False,
                message_tail=SUBAGENT_MESSAGE_TAIL,
            )
            if agent_id != root_id:
                messages.extend(agent_messages)
            tree_agents.append(
                {
                    "agent_id": agent_id,
                    "parent_agent_id": info.get("parent_agent_id"),
                    "goal": (info.get("goal") or "")[:200],
                    "status": info.get("status"),
                    "message_count": len(agent_messages),
                }
            )

    completion_cards: list[dict[str, Any]] = []
    summaries = _final_completion_summaries(data)
    if summaries:
        completion = summaries[-1]
        outputs = completion.get("outputs")
        completion_cards.append(
            {
                "summary": str(completion.get("summary") or ""),
                "outputs": outputs[:200] if isinstance(outputs, list) else [],
            }
        )

    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    return {
        "agent": {
            key: agent.get(key)
            for key in ("agent_id", "id", "status", "progress")
            if agent.get(key) is not None
        },
        "messages": messages,
        "tree_agents": tree_agents,
        "completion_cards": completion_cards,
        "benchmark_state": data.get("_benchmark", {}),
    }


def _grounding_tool_rank(metadata: dict[str, Any]) -> int | None:
    """Return the grounding rank of a tool row, or None when it is not grounding."""
    tool_name = str(metadata.get("toolName") or "")
    if tool_name in _GROUNDING_TOOL_RANK:
        return _GROUNDING_TOOL_RANK[tool_name]
    if tool_name == "spawn_agent":
        agent_type = str(metadata.get("agentType") or "").lower()
        if agent_type == "explore":
            return _EXPLORE_GROUNDING_RANK
        if agent_type == "code":
            # Code sub-agents are the same grounding class as spawn_claude_code_agent.
            return _GROUNDING_TOOL_RANK["spawn_claude_code_agent"]
    return None


def messages_have_code_agent_grounding(data: dict) -> bool:
    """True when root messages include coding-agent tool rows judges need to see."""
    for message in data.get("messages") or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        rank = _grounding_tool_rank(metadata)
        if rank is not None and rank <= _GROUNDING_TOOL_RANK["spawn_claude_code_agent"]:
            return True
    return False
