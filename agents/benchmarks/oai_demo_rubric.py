"""OAi mass-agent-0 Hub rubric (T1–T9). T10 is the durable FE link.

System context:

    test-mass-agent-run-0 (smoke)
            │
            ▼
    run_benchmark.py → logs.tree + all_agents
            │
            ▼
    grade_oai_demo_rubric()  ← this file (fail-closed static_check)

T1 Andy-only   T2 50 real first-level GPs   T3 every explore full traj
T4 every GP full traj   T5 honest FM replay   T6 no nested GP
T7 clean tree   T8 real deliverable   T9 schema/Task Complete
"""

from __future__ import annotations

import json
import re
from typing import Any

from domains.spawn_agent.oai_demo_july import JULY_FOR_EACH_ITEMS

STUB_MARKERS = (
    "fast mode cache trajectory ended",
    "fm_cold_namespace_passthrough",
    "fm_trajectory_end_passthrough",
    "the task completed successfully based on prior tool evidence",
)
RESEARCH_TOOLS = frozenset(
    {
        "web_search",
        "web_fetch",
        "grep",
        "browser_use",
        "spawn_browser_agent",
        "spawn_agent",
    }
)
IN_PROGRESS = frozenset({"ACTIVE", "STARTING", "STARTING_UP", "IN_PROGRESS", "QUEUED"})
GP_STUB_MAX_MESSAGES = 12
JULY_CREATOR_NAMES = tuple(str(item["name"]) for item in JULY_FOR_EACH_ITEMS)
DELIVERABLE_NEEDLES = (
    "positioning",
    "90-day",
    "hook",
    "engage",
)


def _lower(text: Any) -> str:
    return str(text or "").lower()


def _blob(value: Any) -> str:
    try:
        return json.dumps(value, default=str)
    except TypeError:
        return str(value)


def _messages(node: dict) -> list[dict]:
    raw = node.get("messages")
    return raw if isinstance(raw, list) else []


def _tool_names(messages: list[dict]) -> list[str]:
    names: list[str] = []
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except json.JSONDecodeError:
                metadata = None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        auxiliary = metadata.get("auxiliary")
        if isinstance(auxiliary, dict):
            candidates.append(auxiliary)
        for candidate in candidates:
            name = candidate.get("toolName") or candidate.get("tool_name")
            if isinstance(name, str) and name.strip():
                names.append(name.strip())
    return names


def _has_error_chip(messages: list[dict]) -> bool:
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except json.JSONDecodeError:
                continue
        if not isinstance(metadata, dict):
            continue
        status = str(metadata.get("toolStatus") or metadata.get("status") or "").upper()
        if status == "ERROR":
            return True
    return False


def _text_blob(node: dict) -> str:
    parts = [_lower(node.get("goal")), _blob(node.get("structured_output")), _blob(node.get("response_schema"))]
    for message in _messages(node):
        parts.append(_lower(message.get("message") or message.get("text")))
        parts.append(_blob(message.get("metadata")))
    return "\n".join(parts)


def _is_stub_text(text: str) -> bool:
    lowered = _lower(text)
    return any(marker in lowered for marker in STUB_MARKERS)


def _from_fast_cache(node: dict) -> bool:
    blob = _text_blob(node)
    return "from_fast_cache" in blob and "true" in blob


def _agent_type(agent_id: str, node: dict, raw_by_id: dict[str, dict]) -> str:
    raw = raw_by_id.get(agent_id) or {}
    for source in (raw, node):
        for key in ("agent_type", "agentType", "type"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    for key in ("agentType", "agent_type"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    goal = _lower(node.get("goal") or raw.get("goal"))
    if "analyzing one creator" in goal or "creator:" in goal:
        return "general_purpose"
    if raw.get("output_schema") or node.get("response_schema"):
        return "general_purpose"
    if "explore" in goal or goal.startswith("research "):
        return "explore"
    return "general_purpose"


def _root_id(data: dict, tree: dict[str, dict]) -> str:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
    if root_id and root_id in tree:
        return root_id
    for agent_id, node in tree.items():
        if not node.get("parent_agent_id"):
            return agent_id
    return root_id


def _tree_from_data(data: dict) -> dict[str, dict]:
    benchmark = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    tree = benchmark.get("tree")
    if isinstance(tree, dict) and tree:
        return {str(key): value for key, value in tree.items() if isinstance(value, dict)}
    return {}


def _raw_by_id(data: dict) -> dict[str, dict]:
    benchmark = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    raw_agents = benchmark.get("all_agents")
    out: dict[str, dict] = {}
    if isinstance(raw_agents, list):
        for item in raw_agents:
            if not isinstance(item, dict):
                continue
            agent_id = str(item.get("agent_id") or item.get("agentId") or item.get("id") or "").strip()
            if agent_id:
                out[agent_id] = item
    return out


def grade_oai_demo_rubric(data: dict) -> tuple[bool, str]:
    """Return (passed, reason) for T1–T9. One FAIL fails the smoke."""
    tree = _tree_from_data(data)
    if not tree:
        return False, "T10/T2 FAIL: logs.tree missing; cannot grade Hub-visible trajectories"
    raw_by_id = _raw_by_id(data)
    root_id = _root_id(data, tree)
    root = tree.get(root_id) or {}
    rows: list[tuple[str, bool, str]] = []

    whole = "\n".join(_text_blob(node) for node in tree.values())
    if "aman gottumukkala" in whole or re.search(r"\baman's\b", whole):
        rows.append(("T1", False, "Aman Gottumukkala / Aman's still present"))
    elif "andy prevalsky" not in whole and "andy's" not in whole:
        rows.append(("T1", False, "Andy Prevalsky not present on the tree"))
    else:
        rows.append(("T1", True, "Andy-only"))

    children = [
        (agent_id, node)
        for agent_id, node in tree.items()
        if agent_id != root_id and str(node.get("parent_agent_id") or "") == root_id
    ]
    first_level_gps = [
        (agent_id, node)
        for agent_id, node in children
        if _agent_type(agent_id, node, raw_by_id) != "explore"
    ]
    explores = [
        (agent_id, node)
        for agent_id, node in tree.items()
        if agent_id != root_id and _agent_type(agent_id, node, raw_by_id) == "explore"
    ]
    if len(first_level_gps) < 50:
        rows.append(("T2", False, f"{len(first_level_gps)} first-level GPs; expected 50 real children"))
    elif any(len(_messages(node)) == 0 for _, node in first_level_gps):
        empty = sum(1 for _, node in first_level_gps if not _messages(node))
        rows.append(("T2", False, f"{empty} first-level GPs have empty transcripts (mocked/spinning-up)"))
    else:
        rows.append(("T2", True, f"{len(first_level_gps)} first-level GPs"))

    explore_fails: list[str] = []
    for agent_id, node in explores:
        tools = set(_tool_names(_messages(node)))
        if _is_stub_text(_text_blob(node)):
            explore_fails.append(f"{agent_id[:8]} stub")
        elif not (tools & RESEARCH_TOOLS):
            explore_fails.append(f"{agent_id[:8]} tools={sorted(tools) or ['none']}")
        elif len(_messages(node)) < 3:
            explore_fails.append(f"{agent_id[:8]} {len(_messages(node))} msgs")
    if not explores:
        rows.append(("T3", False, "no explore children"))
    elif explore_fails:
        rows.append(("T3", False, f"{len(explore_fails)}/{len(explores)} explores incomplete: {explore_fails[:5]}"))
    else:
        rows.append(("T3", True, f"{len(explores)} explores replayed research tools"))

    gp_fails: list[str] = []
    for agent_id, node in first_level_gps:
        tools = set(_tool_names(_messages(node)))
        msg_count = len(_messages(node))
        spawned_explore = any(
            str(child.get("parent_agent_id") or "") == agent_id
            and _agent_type(child_id, child, raw_by_id) == "explore"
            for child_id, child in tree.items()
        )
        if _is_stub_text(_text_blob(node)):
            gp_fails.append(f"{agent_id[:8]} traj-end stub")
        elif msg_count <= GP_STUB_MAX_MESSAGES and not (tools & RESEARCH_TOOLS) and not spawned_explore:
            gp_fails.append(f"{agent_id[:8]} {msg_count} msgs tools={sorted(tools) or ['none']}")
        elif not (tools & RESEARCH_TOOLS) and not spawned_explore:
            gp_fails.append(f"{agent_id[:8]} no research tools")
    if gp_fails:
        rows.append(("T4", False, f"{len(gp_fails)}/{len(first_level_gps)} GPs incomplete: {gp_fails[:6]}"))
    else:
        rows.append(("T4", True, f"{len(first_level_gps)} GPs have full trajectories"))

    if any(_is_stub_text(_text_blob(node)) for _, node in first_level_gps + explores):
        rows.append(("T5", False, "traj-end / cold-passthrough stub present (soft-as-hit)"))
    elif first_level_gps and not any(_from_fast_cache(node) for _, node in first_level_gps):
        rows.append(("T5", False, "no from_fast_cache replay evidence on first-level GPs"))
    else:
        rows.append(("T5", True, "honest Fast Mode replay"))

    nested_gps = []
    for agent_id, node in tree.items():
        if agent_id == root_id:
            continue
        if _agent_type(agent_id, node, raw_by_id) == "explore":
            continue
        parent_id = str(node.get("parent_agent_id") or "")
        if parent_id in {root_id, ""}:
            continue
        parent = tree.get(parent_id) or {}
        if _agent_type(parent_id, parent, raw_by_id) in {"general_purpose", "for_each", "explore"}:
            nested_gps.append(agent_id[:8])
    if nested_gps:
        rows.append(("T6", False, f"nested GPs: {nested_gps[:8]}"))
    else:
        rows.append(("T6", True, "no nested GP"))

    leftover = []
    error_agents = []
    for agent_id, node in tree.items():
        status = str(node.get("status") or raw_by_id.get(agent_id, {}).get("status") or "").upper()
        if status in IN_PROGRESS:
            leftover.append(f"{agent_id[:8]}:{status}")
        if status in {"FAILED", "ERROR", "OUT_OF_CREDITS"}:
            error_agents.append(f"{agent_id[:8]}:{status}")
        if _has_error_chip(_messages(node)):
            error_agents.append(f"{agent_id[:8]}:ERROR_CHIP")
    if leftover or error_agents:
        rows.append(("T7", False, f"leftover={leftover[:6]} errors={error_agents[:6]}"))
    else:
        rows.append(("T7", True, "clean tree"))

    root_blob = _text_blob(root) + _blob(data.get("agent"))
    outputs = []
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    structured = agent.get("structured_output") or root.get("structured_output")
    if isinstance(structured, dict):
        outputs.append(_blob(structured))
    if _is_stub_text(root_blob):
        rows.append(("T8", False, "root final is a traj-end stub"))
    else:
        missing = [needle for needle in DELIVERABLE_NEEDLES if needle not in _lower(root_blob + "\n".join(outputs))]
        creators_found = sum(1 for name in JULY_CREATOR_NAMES if name.lower() in _lower(root_blob + "\n".join(outputs)))
        if missing:
            rows.append(("T8", False, f"missing deliverable markers: {missing}"))
        elif creators_found < 10:
            rows.append(("T8", False, f"only {creators_found} July creator names in the final"))
        else:
            rows.append(("T8", True, f"deliverable present ({creators_found} creators referenced)"))

    schema = agent.get("response_schema") or root.get("response_schema")
    structured_out = agent.get("structured_output") or root.get("structured_output")
    schema_fields = []
    if isinstance(schema, dict):
        fields = schema.get("fields")
        if isinstance(fields, list):
            schema_fields = fields
    if not schema_fields and not structured_out:
        rows.append(("T9", False, "schema/outputs empty"))
    else:
        rows.append(("T9", True, "schema/Task Complete populated"))

    failed = [f"{row_id} FAIL: {reason}" for row_id, passed, reason in rows if not passed]
    passed_ids = [row_id for row_id, passed, _ in rows if passed]
    if failed:
        return False, "; ".join(failed)
    return True, f"{', '.join(passed_ids)} PASS"
