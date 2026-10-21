"""Tree-aware evidence builders for declared benchmark semantic evaluators.

Single-turn judges receive root plus every sub-agent transcript. When the
serialized bundle exceeds the single-turn char budget, the harness auto-falls
back to the agentic Codex judge (see run_benchmark._run_declared_evaluators).
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from benchmarks.completion_evidence import completion_card, completion_messages, completion_payload, tree_completion_messages

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
    # completionSummary is normalized into a final_completion ASSISTANT row;
    # keep it out of raw tool metadata so judges see one rendered answer card.
    "toolCallId",
    "subAgentId",
    "task_id",
    "browser_url",
    "agentType",
)

# Lower rank = pack first when the full/slim evidence exceeds SINGLE_TURN_CHAR_BUDGET.
# web_* stay lowest so mass-agent root GP spam cannot crowd out coding-agent rows
# or re-inflate the compact_only bundle toward the old 35MB tree path.
_GROUNDING_TOOL_RANK: dict[str, int] = {
    "code_agent_sdk_events": 0,
    "claude_code_history": 1,
    "spawn_claude_code_agent": 2,
    "web_search": 4,
    "web_fetch": 5,
}
_LOW_PRIORITY_GROUNDING_TEXT_CAP = 2_000
_LOW_PRIORITY_GROUNDING_MAX_ROWS = 10
_EXPLORE_GROUNDING_RANK = 3


def _root_agent_id(data: dict) -> str:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    return str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "")


_OMISSION_MARKER = "\n[... {omitted} characters omitted ...]\n"


def _cap_text(text: str, text_cap: int | None) -> str:
    """Shorten ``text`` to ``text_cap`` chars: keep both ends, say what was dropped.

    A judge must be able to tell that evidence is missing, and the end of a
    tool result (status lines, totals, errors) is as likely to matter as its
    start. This is the shape the reference harnesses use for an LLM reader:
    Codex's transcript reviewer keeps a prefix and suffix around
    ``<truncated omitted_approx_tokens="N" />`` (codex-rs/guardian-context
    truncation.rs), and OpenClaw keeps head and tail around a
    "N more characters truncated" notice (tool-result-truncation.ts).
    """
    if text_cap is None or len(text) <= text_cap:
        return text
    # Sized for the widest count the marker could carry, so the result fits.
    keep = max(text_cap - len(_OMISSION_MARKER.format(omitted=len(text))), 0)
    head = keep // 2
    tail = keep - head
    marker = _OMISSION_MARKER.format(omitted=len(text) - keep)
    return text[:head] + marker + (text[-tail:] if tail else "")


def _message_text(message: dict, text_cap: int | None) -> str:
    text_value = message.get("text", message.get("message", message.get("content", "")))
    if not isinstance(text_value, str):
        text_value = json.dumps(text_value, default=str)
    return _cap_text(text_value, text_cap)


def _message_metadata(message: dict) -> dict[str, Any]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    return {key: metadata[key] for key in DECLARED_JUDGE_METADATA_KEYS if key in metadata}


def _evidence_rows_from_messages(
    messages: Iterable[dict],
    *,
    agent_id: str,
    parent_agent_id: str | None,
    goal: str,
    text_cap: int | None,
    skip_user_system: bool,
    message_tail: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    message_list = [message for message in messages if isinstance(message, dict)]
    for message in message_list[-message_tail:]:
        if completion_card(message.get("metadata")) is not None:
            continue  # Final cards have their own untruncated evidence projection.
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


def _append_completion_card(
    rows: list[dict[str, Any]], data: dict, text_cap: int | None
) -> None:
    for agent_id, message in tree_completion_messages(data):
        rows.append({
            "role": "ASSISTANT",
            "text": json.dumps(completion_payload(message), ensure_ascii=False, default=str),
            "metadata": {"evidence_type": "final_completion", "source_agent_id": agent_id},
        })


def _final_completion_summaries(data: dict) -> list[dict]:
    return [completion_card(message["metadata"]) for message in completion_messages(data.get("messages") or [])]

def build_single_turn_evidence(
    data: dict, *, text_cap: int | None = SINGLE_TURN_TEXT_CAP
) -> list[dict[str, Any]]:
    """Build single-turn judge evidence from root and optional tree transcripts.

    ``text_cap`` cuts each row's text; ``None`` keeps every row whole. The
    caller owns the overall budget and picks the cap that fits it.
    """
    root_id = _root_agent_id(data)
    rows = _evidence_rows_from_messages(
        data.get("messages") or [],
        agent_id=root_id,
        parent_agent_id=None,
        goal="",
        text_cap=text_cap,
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
                    text_cap=text_cap,
                    skip_user_system=True,
                    message_tail=SUBAGENT_MESSAGE_TAIL,
                )
            )

    _append_completion_card(rows, data, text_cap)
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

    completion_cards = [completion_payload(message) for _, message in tree_completion_messages(data)]

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


def single_turn_transport_char_count(evidence: list[dict[str, Any]]) -> int:
    # Account for the exact TOOL_RESULT JSON wrapping used by check_progress;
    # escaping can otherwise truncate a card that fit as an evidence list.
    payload = {"tool_name": "tool", "tool_call_id": None,
               "result": json.dumps(evidence, default=str)}
    return len("TOOL_RESULT " + json.dumps(payload, ensure_ascii=False, default=str))


def single_turn_evidence_exceeds_budget(evidence: list[dict[str, Any]]) -> bool:
    return single_turn_transport_char_count(evidence) > SINGLE_TURN_CHAR_BUDGET


def _grounding_tool_rank(metadata: dict[str, Any]) -> int | None:
    """Return pack priority for a tool row, or None when it is not grounding."""
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


def pack_grounding_priority_rows(
    data: dict,
    *,
    base_rows: list[dict[str, Any]],
    budget: int = SINGLE_TURN_CHAR_BUDGET,
) -> list[dict[str, Any]]:
    """Greedily pack high-value grounding tool rows under the single-turn budget.

    Used when full/slim transcripts exceed ``SINGLE_TURN_CHAR_BUDGET`` so
    compact_only keeps coding-agent / explore / search evidence instead of
    collapsing to completion + structured_output only.
    """
    root_id = _root_agent_id(data)
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    low_priority_kept = 0
    messages = [m for m in (data.get("messages") or []) if isinstance(m, dict)]
    for index, message in enumerate(messages):
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        rank = _grounding_tool_rank(metadata)
        if rank is None:
            continue
        tool_name = str(metadata.get("toolName") or "")
        text_cap = SINGLE_TURN_TEXT_CAP
        if rank >= _GROUNDING_TOOL_RANK["web_search"]:
            text_cap = _LOW_PRIORITY_GROUNDING_TEXT_CAP
        row_metadata = _message_metadata(message)
        if root_id:
            row_metadata["source_agent_id"] = root_id
        role = str(message.get("role") or "TOOL").upper()
        row = {
            "role": role or "TOOL",
            "text": _message_text(message, text_cap),
            "metadata": row_metadata,
        }
        # Negate index so more recent rows sort first within the same rank.
        candidates.append((rank, -index, row))

    candidates.sort(key=lambda item: (item[0], item[1]))
    packed = list(base_rows)
    for rank, _neg_index, row in candidates:
        if rank >= _GROUNDING_TOOL_RANK["web_search"]:
            if low_priority_kept >= _LOW_PRIORITY_GROUNDING_MAX_ROWS:
                continue
        trial = [*packed, row]
        if single_turn_transport_char_count(trial) > budget:
            continue
        packed.append(row)
        if rank >= _GROUNDING_TOOL_RANK["web_search"]:
            low_priority_kept += 1
    return packed
