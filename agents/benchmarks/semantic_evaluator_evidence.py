"""Tree-aware evidence builders for declared benchmark semantic evaluators.

Single-turn judges receive root plus every sub-agent transcript. When the
serialized bundle exceeds the single-turn char budget, the harness auto-falls
back to the agentic Codex judge (see run_benchmark._run_declared_evaluators).
"""

from __future__ import annotations

import json
from typing import Any, Iterable

# Match wait_for's evidence budget — single-turn judges share one context window.
SINGLE_TURN_CHAR_BUDGET = 320_000

ROOT_MESSAGE_TAIL = 120
SUBAGENT_MESSAGE_TAIL = 500
SINGLE_TURN_TEXT_CAP = 12_000
AGENTIC_TEXT_CAP = 50_000
AGENTIC_ROOT_MESSAGE_TAIL = 500

DECLARED_JUDGE_METADATA_KEYS = (
    "action_type",
    "toolName",
    "toolStatus",
    "url",
    "title",
    "browser_session_metadata",
    "requestUserApproval",
    "completionSummary",
    "toolCallId",
    "subAgentId",
    "task_id",
    "browser_url",
)


def _root_agent_id(data: dict) -> str:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    return str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "")


def _message_text(message: dict, text_cap: int) -> str:
    text_value = message.get("text", message.get("message", message.get("content", "")))
    if not isinstance(text_value, str):
        text_value = json.dumps(text_value, default=str)
    return text_value[:text_cap]


def _message_metadata(message: dict) -> dict[str, Any]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    return {key: metadata[key] for key in DECLARED_JUDGE_METADATA_KEYS if key in metadata}


def _evidence_rows_from_messages(
    messages: Iterable[dict],
    *,
    agent_id: str,
    parent_agent_id: str | None,
    goal: str,
    text_cap: int,
    skip_user_system: bool,
    message_tail: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    message_list = [message for message in messages if isinstance(message, dict)]
    for message in message_list[-message_tail:]:
        role = str(message.get("role") or "").upper()
        if skip_user_system and role in {"USER", "SYSTEM"}:
            continue
        row_metadata = _message_metadata(message)
        if agent_id:
            row_metadata["source_agent_id"] = agent_id
        if parent_agent_id:
            row_metadata["source_parent_agent_id"] = parent_agent_id
        if goal:
            row_metadata["source_goal"] = goal[:200]
        rows.append(
            {
                "role": role or "UNKNOWN",
                "text": _message_text(message, text_cap),
                "metadata": row_metadata,
            }
        )
    return rows


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


def _append_completion_card(rows: list[dict[str, Any]], data: dict, text_cap: int) -> None:
    summaries = _final_completion_summaries(data)
    if not summaries:
        return
    completion = summaries[-1]
    outputs = completion.get("outputs")
    payload = {
        "summary": str(completion.get("summary") or "")[:text_cap],
        "outputs": outputs[:200] if isinstance(outputs, list) else [],
    }
    rows.append(
        {
            "role": "ASSISTANT",
            "text": json.dumps(payload, default=str),
            "metadata": {"evidence_type": "final_completion"},
        }
    )


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
    """Build bounded single-turn judge evidence from root and optional tree transcripts."""
    root_id = _root_agent_id(data)
    rows = _evidence_rows_from_messages(
        data.get("messages") or [],
        agent_id=root_id,
        parent_agent_id=None,
        goal="",
        text_cap=SINGLE_TURN_TEXT_CAP,
        skip_user_system=True,
        message_tail=ROOT_MESSAGE_TAIL,
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
                    text_cap=SINGLE_TURN_TEXT_CAP,
                    skip_user_system=True,
                    message_tail=SUBAGENT_MESSAGE_TAIL,
                )
            )

    _append_completion_card(rows, data, SINGLE_TURN_TEXT_CAP)
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
        text_cap=AGENTIC_TEXT_CAP,
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
                text_cap=AGENTIC_TEXT_CAP,
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
                "summary": str(completion.get("summary") or "")[:AGENTIC_TEXT_CAP],
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


def single_turn_evidence_char_count(evidence: list[dict[str, Any]]) -> int:
    return len(json.dumps(evidence, default=str))


def single_turn_evidence_exceeds_budget(evidence: list[dict[str, Any]]) -> bool:
    return single_turn_evidence_char_count(evidence) > SINGLE_TURN_CHAR_BUDGET
