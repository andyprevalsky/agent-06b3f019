"""Mid-run feedback triggers and tree-routing static checks.

Two things live here, both benchmark-side (grading/driving), never harness code:

1. ``mid_run_feedback`` trigger contract shared by the catalog validator and the
   poll loop in ``run_benchmark.py``. A task declares exactly one trigger:

   - ``after_root_message_count: N`` (legacy) — fire once when the root has at
     least N messages.
   - ``when: {"active_depth_at_least": N}`` — fire once when the agent tree has
     an *unbroken chain of N active layers counted from the root*: the root
     (depth 0) plus descendants down to depth N-1, where every agent on the
     chain is active (``STARTING_UP``/``ACTIVE``). ``N=3`` therefore means
     root + child + grandchild are all running at the same moment. PAUSED and
     terminal agents break the chain.

   Depth is derived from ``parent_agent_id`` links in
   ``GET /api/agents/tree?busId=<root>`` (one indexed per-tree query).
   - ``when: {"background_task_active": "explore"|"browser"}`` — fire once when
     the ROOT owns an activity-backed background task of that type that is
     running right now. Detection reads only the root transcript (see
     ``background_tasks``): a FINISHED ``runInBackground`` "started" row names
     ``backgroundTaskId=<id>`` (the spawn's own tool-call id) +
     ``backgroundAgentType``; the task is running once a later IN_PROGRESS row
     under ``toolCallId=<id>`` exists (the executor's FE-only rows: the activity
     really launched) and until its single ``agentNotification`` row
     (``backgroundTaskId=<id>``) is appended on completion.

2. Static checks for ``tree-feedback-routing`` (grading over the run record):

   - ``mid_run_feedback_active_layers`` — the feedback was actually posted to
     the root while >= ``min_layers`` active layers existed.
   - ``agent_message_routed_to_subtree`` — a non-root agent in the target
     subtree received an ``agentMessage`` row containing ``marker``.
   - ``agent_message_not_routed_to_subtree`` — no agent in the other subtree(s)
     received an ``agentMessage`` row containing ``marker`` (precision).
   - ``structured_output_signature`` — every item of a structured-output list
     contains ``required`` (and matches ``required_pattern``) and none contains
     ``forbidden`` (word boundary).
   - ``list_agents_listed`` — some agent's FINISHED list_agents result listed
     >= ``min_other_entries`` entries besides the caller (and, with
     ``required_types``, an entry of every listed type, e.g. ``explore``).
   - ``mid_run_feedback_background_task_active`` — the feedback was posted
     while a root background task of ``agent_type`` was running.
   - ``background_task_message_routed`` — after the feedback, the root's
     send_message_to_agent addressed its background task and the owner stored
     the inbox row (``agentMessage`` + ``recipientTaskId``), with >=
     ``min_task_rows_after_message`` subsequent task progress rows. By default
     the inbox must precede completion. ``allow_resume_after_completion`` also
     accepts a verified second run of that same task when it completed during
     the root's response to the mid-run follow-up.

Addresses: agents may be addressed by id, by the task id, by the tree-wide
``<owner>/<task id>`` form or by a Codex-style task path (``/root/research``).
Checks match recipients structurally on ``backgroundTaskId`` and accept any of
those address forms carried in metadata (``backgroundAddress``/``path``/
``taskPath``/``toAgentAddress``/``recipientTaskId``); task names are model-chosen
and never hard-coded.

Subtree classification rule (documented, deterministic): every first-level
child of the root heads one subtree; descendants inherit their head's label.
A head is ``outreach`` when its goal (plus its task-path name when the tree
carries ``taskPath``) mentions outreach/draft/email and not
research/market/facts; ``research`` for the converse. When both or neither
vocabulary appears, structure breaks the tie: a head that spawned descendants
is ``outreach`` (the task requires one drafting agent per investor under the
outreach agent), a childless head is ``research``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

ACTIVE_STATUSES = frozenset({"STARTING_UP", "ACTIVE"})
MID_RUN_TRIGGER_KEYS = frozenset({"active_depth_at_least", "background_task_active"})
BACKGROUND_TASK_TYPES = ("explore", "browser")
# Rows a task of this type posts on its owner's transcript besides <id> rows.
_TYPE_PROGRESS_TOOL_NAMES = {"explore": frozenset(), "browser": frozenset({"spawn_browser_agent"})}
_LIST_AGENTS_LINE_RE = re.compile(r"^\s*-\s+(?P<address>\S+)\s+\[(?P<relationship>[^\]]*)\]\s+(?P<type>\S+)")

OUTREACH_GOAL_RE = re.compile(r"\b(outreach|draft\w*|e-?mails?)\b", re.IGNORECASE)
RESEARCH_GOAL_RE = re.compile(r"\b(research\w*|market|facts?)\b", re.IGNORECASE)

SUBTREE_LABELS = ("outreach", "research")

TREE_ROUTING_CHECK_TYPES = frozenset(
    {
        "mid_run_feedback_active_layers",
        "agent_message_routed_to_subtree",
        "agent_message_not_routed_to_subtree",
        "structured_output_signature",
        "list_agents_listed",
        "mid_run_feedback_background_task_active",
        "background_task_message_routed",
    }
)


# ---------------------------------------------------------------------------
# Trigger contract
# ---------------------------------------------------------------------------


def validate_mid_run_feedback(raw: Any, item_id: str) -> None:
    """Fail-closed catalog validation for ``mid_run_feedback``."""
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise ValueError(f"{item_id}: mid_run_feedback must be an object")
    message = raw.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ValueError(f"{item_id}: mid_run_feedback.message must be a non-empty string")
    unknown = set(raw) - {"message", "after_root_message_count", "when", "non_goal"}
    if unknown:
        raise ValueError(f"{item_id}: mid_run_feedback has unknown keys {sorted(unknown)}")
    if "non_goal" in raw and not isinstance(raw["non_goal"], bool):
        raise ValueError(f"{item_id}: mid_run_feedback.non_goal must be a boolean")
    has_count = "after_root_message_count" in raw
    has_when = "when" in raw
    if has_count == has_when:
        raise ValueError(f"{item_id}: mid_run_feedback requires exactly one of after_root_message_count or when")
    if has_count:
        count = raw["after_root_message_count"]
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise ValueError(f"{item_id}: mid_run_feedback.after_root_message_count must be a positive integer")
        return
    when = raw["when"]
    if not isinstance(when, dict) or len(when) != 1 or not set(when) <= MID_RUN_TRIGGER_KEYS:
        raise ValueError(
            f"{item_id}: mid_run_feedback.when must be exactly one of "
            "{'active_depth_at_least': N} or {'background_task_active': 'explore'|'browser'}"
        )
    if "background_task_active" in when:
        if when["background_task_active"] not in BACKGROUND_TASK_TYPES:
            raise ValueError(
                f"{item_id}: mid_run_feedback.when.background_task_active must be one of {BACKGROUND_TASK_TYPES}"
            )
        return
    depth = when["active_depth_at_least"]
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 2:
        raise ValueError(f"{item_id}: mid_run_feedback.when.active_depth_at_least must be an integer >= 2")


def _when(config: Optional[dict]) -> dict:
    when = config.get("when") if isinstance(config, dict) else None
    return when if isinstance(when, dict) else {}


def trigger_uses_tree(config: Optional[dict]) -> bool:
    return "active_depth_at_least" in _when(config)


def trigger_uses_background_task(config: Optional[dict]) -> bool:
    return "background_task_active" in _when(config)


def tree_depths(agents: Iterable[dict], root_id: str) -> Dict[str, int]:
    """Depth per agent id from parent links (root=0). Unreachable agents are omitted."""
    parents: Dict[str, Optional[str]] = {}
    for agent in agents or []:
        if not isinstance(agent, dict):
            continue
        aid = str(agent.get("agent_id") or agent.get("id") or "")
        if aid:
            parent = agent.get("parent_agent_id")
            parents[aid] = str(parent) if parent else None
    depths: Dict[str, int] = {root_id: 0}

    def resolve(aid: str, seen: set[str]) -> Optional[int]:
        if aid in depths:
            return depths[aid]
        parent = parents.get(aid)
        if not parent or aid in seen:
            return None
        seen.add(aid)
        parent_depth = resolve(parent, seen)
        if parent_depth is None:
            return None
        depths[aid] = parent_depth + 1
        return depths[aid]

    for aid in parents:
        resolve(aid, set())
    return depths


def deepest_active_chain(agents: Iterable[dict], root_id: str) -> List[dict]:
    """Longest root-anchored chain whose every member is active (root first)."""
    by_id: Dict[str, dict] = {}
    children: Dict[str, List[str]] = {}
    for agent in agents or []:
        if not isinstance(agent, dict):
            continue
        aid = str(agent.get("agent_id") or agent.get("id") or "")
        if not aid:
            continue
        by_id[aid] = agent
        parent = agent.get("parent_agent_id")
        if parent:
            children.setdefault(str(parent), []).append(aid)
    root = by_id.get(root_id)
    if root is None or str(root.get("status") or "").upper() not in ACTIVE_STATUSES:
        return []

    best: List[str] = [root_id]
    stack: List[Tuple[str, List[str]]] = [(root_id, [root_id])]
    while stack:
        aid, path = stack.pop()
        if len(path) > len(best):
            best = path
        for child in children.get(aid, []):
            if child in path:
                continue
            if str(by_id[child].get("status") or "").upper() in ACTIVE_STATUSES:
                stack.append((child, path + [child]))
    return [
        {
            "agent_id": aid,
            "depth": depth,
            "status": by_id[aid].get("status"),
            "goal": str(by_id[aid].get("goal") or "")[:240],
        }
        for depth, aid in enumerate(best)
    ]


def tree_trigger_ready(config: dict, agents: Iterable[dict], root_id: str) -> Tuple[bool, List[dict]]:
    """Return (ready, active_chain) for a ``when`` trigger."""
    required = int((config.get("when") or {}).get("active_depth_at_least") or 0)
    chain = deepest_active_chain(agents, root_id)
    return bool(required) and len(chain) >= required, chain


def _address_forms(*values: Any) -> set[str]:
    """Every equivalent spelling of an address: as given and the task-id tail of ``<owner>/<task id>``."""
    forms: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        value = value.strip()
        forms.add(value)
        if "/" in value and not value.startswith("/"):
            forms.add(value.rstrip("/").rsplit("/", 1)[-1])
    return forms


def background_tasks(messages: Iterable[dict]) -> List[dict]:
    """Activity-backed background tasks owned by this transcript, in start order.

    Pure function over the owner's rows (indexes are transcript positions):
    ``started_index`` (FINISHED runInBackground row), ``first_in_progress_index``
    (first IN_PROGRESS row under ``toolCallId=<id>`` after the started row),
    ``notification_index``
    (the completion ``agentNotification`` row) and ``running`` (launched and
    not yet notified). Child-workflow spawns (general_purpose/for_each) are
    excluded: they are agents, not inbox-addressed tasks.
    """
    tasks: Dict[str, dict] = {}
    pending_progress: Dict[str, List[Tuple[int, str]]] = {}
    pending_notifications: Dict[str, Tuple[int, Any]] = {}
    for index, message in enumerate(messages or []):
        if not isinstance(message, dict):
            continue
        metadata = _metadata(message)
        bg_id = metadata.get("backgroundTaskId")
        tool_call_id = metadata.get("toolCallId")
        if (
            metadata.get("runInBackground") is True
            and isinstance(bg_id, str)
            and bg_id
            and metadata.get("toolStatus") == "FINISHED"
        ):
            agent_type = str(metadata.get("backgroundAgentType") or "")
            if agent_type not in BACKGROUND_TASK_TYPES or bg_id in tasks:
                continue
            tasks[bg_id] = {
                "background_task_id": bg_id,
                "agent_type": agent_type,
                "address": metadata.get("backgroundAddress") or bg_id,
                "path": metadata.get("backgroundPath") or metadata.get("taskPath") or metadata.get("path"),
                "started_index": index,
                "first_in_progress_index": None,
                "progress_indexes": [],
                "notification_index": None,
                "notification_status": None,
            }
            continue
        if metadata.get("agentNotification") is True and isinstance(bg_id, str):
            pending_notifications.setdefault(bg_id, (index, metadata.get("status")))
            continue
        if isinstance(tool_call_id, str) and tool_call_id:
            pending_progress.setdefault(tool_call_id, []).append((index, str(metadata.get("toolStatus") or "")))
    for bg_id, task in tasks.items():
        for index, status in pending_progress.get(bg_id, []):
            if index < task["started_index"]:
                continue  # e.g. a planned task's early chip, before the executor ran
            task["progress_indexes"].append(index)
            if status == "IN_PROGRESS" and task["first_in_progress_index"] is None:
                task["first_in_progress_index"] = index
        if bg_id in pending_notifications:
            task["notification_index"], task["notification_status"] = pending_notifications[bg_id]
        task["running"] = task["first_in_progress_index"] is not None and task["notification_index"] is None
    return sorted(tasks.values(), key=lambda t: t["started_index"])


def _task_addresses(task: dict) -> set[str]:
    return _address_forms(task.get("background_task_id"), task.get("address"), task.get("path"))


def background_trigger_ready(config: dict, messages: Iterable[dict]) -> Tuple[bool, Optional[dict]]:
    """Return (ready, task) for ``when.background_task_active``: first running task of that type."""
    agent_type = _when(config).get("background_task_active")
    for task in background_tasks(messages):
        if task["agent_type"] == agent_type and task["running"]:
            return True, {
                key: task[key] for key in ("background_task_id", "agent_type", "address", "path", "started_index")
            }
    return False, None


def tree_snapshot(agents: Iterable[dict], root_id: str) -> List[dict]:
    depths = tree_depths(agents, root_id)
    rows = []
    for agent in agents or []:
        if not isinstance(agent, dict):
            continue
        aid = str(agent.get("agent_id") or agent.get("id") or "")
        rows.append(
            {
                "agent_id": aid,
                "parent_agent_id": agent.get("parent_agent_id"),
                "depth": depths.get(aid),
                "status": agent.get("status"),
                "goal": str(agent.get("goal") or "")[:240],
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------


def _metadata(message: dict) -> dict:
    metadata = message.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            return {}
    return metadata if isinstance(metadata, dict) else {}


def _message_text(message: dict) -> str:
    return str(message.get("message") or message.get("text") or "")


def _tree_nodes(data: dict) -> Dict[str, dict]:
    tree = (data.get("_benchmark") or {}).get("tree")
    return {str(k): v for k, v in tree.items() if isinstance(v, dict)} if isinstance(tree, dict) else {}


def _root_id(data: dict, nodes: Dict[str, dict]) -> Optional[str]:
    agent = data.get("agent") or {}
    rid = agent.get("agent_id") or agent.get("id")
    if rid:
        return str(rid)
    roots = [aid for aid, node in nodes.items() if not node.get("parent_agent_id")]
    return roots[0] if len(roots) == 1 else None


def _full_goals(data: dict) -> Dict[str, str]:
    """Prefer untruncated tree-API goals; fall back to the 200-char tree copies."""
    goals: Dict[str, str] = {}
    for agent in (data.get("_benchmark") or {}).get("all_agents") or []:
        if isinstance(agent, dict):
            aid = str(agent.get("agent_id") or agent.get("id") or "")
            if aid and isinstance(agent.get("goal"), str):
                goals[aid] = agent["goal"]
    for aid, node in _tree_nodes(data).items():
        goals.setdefault(aid, str(node.get("goal") or ""))
    return goals


def _task_paths(data: dict) -> Dict[str, str]:
    """Codex-style task path per agent id when the tree carries one (else empty)."""
    paths: Dict[str, str] = {}
    sources = [*((data.get("_benchmark") or {}).get("all_agents") or [])]
    sources += [dict(node, agent_id=aid) for aid, node in _tree_nodes(data).items()]
    for agent in sources:
        if not isinstance(agent, dict):
            continue
        aid = str(agent.get("agent_id") or agent.get("id") or "")
        path = agent.get("taskPath") or agent.get("task_path") or agent.get("path")
        if aid and isinstance(path, str) and path.strip():
            paths.setdefault(aid, path.strip())
    return paths


def _path_name_words(path: Optional[str]) -> str:
    """Last path segment as words (``/root/market_research`` -> ``market research``)."""
    if not path:
        return ""
    return re.sub(r"[_\-]+", " ", path.rstrip("/").rsplit("/", 1)[-1])


def classify_subtrees(data: dict) -> Tuple[Dict[str, str], Optional[str]]:
    """Label every non-root agent with its first-level subtree (see module rule)."""
    nodes = _tree_nodes(data)
    root_id = _root_id(data, nodes)
    if not root_id or root_id not in nodes:
        return {}, "agent tree was not captured"
    goals = _full_goals(data)
    parents = {aid: (str(n["parent_agent_id"]) if n.get("parent_agent_id") else None) for aid, n in nodes.items()}
    heads = [aid for aid, parent in parents.items() if parent == root_id]
    if not heads:
        return {}, "root spawned no first-level sub-agents"

    def head_of(aid: str) -> Optional[str]:
        seen: set[str] = set()
        while aid and aid not in seen:
            seen.add(aid)
            parent = parents.get(aid)
            if parent == root_id:
                return aid
            aid = parent or ""
        return None

    has_descendants = {head: False for head in heads}
    for aid in nodes:
        head = head_of(aid)
        if head and head != aid:
            has_descendants[head] = True

    paths = _task_paths(data)
    head_labels: Dict[str, str] = {}
    for head in heads:
        goal = f"{_path_name_words(paths.get(head))} {goals.get(head, '')}".strip()
        outreach = bool(OUTREACH_GOAL_RE.search(goal))
        research = bool(RESEARCH_GOAL_RE.search(goal))
        if outreach and not research:
            head_labels[head] = "outreach"
        elif research and not outreach:
            head_labels[head] = "research"
        else:
            head_labels[head] = "outreach" if has_descendants[head] else "research"

    labels: Dict[str, str] = {}
    for aid in nodes:
        if aid == root_id:
            continue
        head = head_of(aid)
        if head:
            labels[aid] = head_labels[head]
    return labels, None


def _marker_rows(node: dict, marker: str) -> List[dict]:
    needle = marker.lower()
    rows = []
    for message in node.get("messages") or []:
        if not isinstance(message, dict):
            continue
        metadata = _metadata(message)
        if metadata.get("agentMessage") is True and needle in _message_text(message).lower():
            rows.append(
                {
                    "role": message.get("role"),
                    "from_agent_id": metadata.get("fromAgentId"),
                    "from_agent_path": metadata.get("fromAgentPath"),
                    "recipient_task_id": metadata.get("recipientTaskId"),
                    "text": _message_text(message)[:300],
                }
            )
    return rows


def routing_trace(data: dict, marker: str) -> dict:
    """Compact, judge-visible trace: which agents received the marker and their subtree."""
    labels, error = classify_subtrees(data)
    nodes = _tree_nodes(data)
    goals = _full_goals(data)
    paths = _task_paths(data)
    recipients = []
    for aid, node in nodes.items():
        rows = _marker_rows(node, marker)
        if rows:
            recipients.append(
                {
                    "agent_id": aid,
                    "task_path": paths.get(aid),
                    "subtree": labels.get(aid, "root"),
                    "goal": goals.get(aid, "")[:240],
                    "agent_messages": rows[:5],
                }
            )
    return {
        "marker": marker,
        "classification_error": error,
        "subtree_labels": {aid: {"subtree": label, "goal": goals.get(aid, "")[:160]} for aid, label in labels.items()},
        "marker_recipients": recipients,
    }


def _signature_items(structured: Any, field: str) -> Optional[list]:
    if not isinstance(structured, dict):
        return None
    value = structured.get(field)
    return value if isinstance(value, list) else None


def check_tree_feedback_routing(data: dict, check: dict) -> Tuple[bool, str]:
    check_type = check.get("type")
    benchmark = data.get("_benchmark") or {}

    if check_type == "mid_run_feedback_active_layers":
        minimum = int(check.get("min_layers", 3))
        evidence = benchmark.get("mid_run_feedback") or {}
        if not evidence.get("posted"):
            return False, "Mid-run feedback was never posted"
        layers = int(evidence.get("active_layers") or 0)
        if layers < minimum:
            return False, f"Mid-run feedback posted with {layers} active layer(s); expected >= {minimum}"
        message = str(evidence.get("message") or "")
        root_rows = [
            m
            for m in data.get("messages") or []
            if isinstance(m, dict) and m.get("role") == "USER" and _message_text(m).strip() == message.strip()
        ]
        if not message or not root_rows:
            return False, "Mid-run feedback row is missing from the root transcript"
        return True, f"Feedback posted to the root while {layers} layers were active"

    if check_type in {"agent_message_routed_to_subtree", "agent_message_not_routed_to_subtree"}:
        marker = str(check.get("marker") or "")
        subtree = str(check.get("subtree") or "")
        if not marker or subtree not in SUBTREE_LABELS:
            return False, f"{check_type}: requires marker and subtree in {SUBTREE_LABELS}"
        labels, error = classify_subtrees(data)
        if error:
            return False, f"{check_type}: {error}"
        members = [aid for aid, label in labels.items() if label == subtree]
        if check_type == "agent_message_routed_to_subtree":
            if not members:
                return False, f"No {subtree} subtree was identified among first-level sub-agents"
            nodes = _tree_nodes(data)
            hits = [aid for aid in members if _marker_rows(nodes.get(aid, {}), marker)]
            if not hits:
                return False, f"No {subtree}-subtree agent received an agentMessage containing {marker!r}"
            return True, f"{len(hits)} {subtree}-subtree agent(s) received the routed correction"
        nodes = _tree_nodes(data)
        leaks = [aid for aid in members if _marker_rows(nodes.get(aid, {}), marker)]
        if leaks:
            return False, (
                f"{len(leaks)} {subtree}-subtree agent(s) received an agentMessage containing {marker!r}: "
                + ", ".join(aid[:8] for aid in leaks[:5])
            )
        return True, f"No {subtree}-subtree agent received the correction ({len(members)} checked)"

    if check_type == "structured_output_signature":
        field = str(check.get("field") or "")
        required = str(check.get("required") or "")
        forbidden = str(check.get("forbidden") or "")
        required_pattern = str(check.get("required_pattern") or "")
        minimum = int(check.get("min_items", 1))
        structured = (data.get("agent") or {}).get("structured_output")
        items = _signature_items(structured, field)
        if items is None:
            return False, f"structured_output.{field} is missing or not a list"
        if len(items) < minimum:
            return False, f"structured_output.{field} has {len(items)} item(s); expected >= {minimum}"
        forbidden_re = re.compile(rf"\b{re.escape(forbidden)}\b", re.IGNORECASE) if forbidden else None
        pattern_re = re.compile(required_pattern, re.IGNORECASE) if required_pattern else None
        for index, item in enumerate(items):
            blob = json.dumps(item, ensure_ascii=False) if not isinstance(item, str) else item
            if required and required.lower() not in blob.lower():
                return False, f"{field}[{index}] does not contain {required!r}"
            if pattern_re and not pattern_re.search(blob):
                return False, f"{field}[{index}] does not match {required_pattern!r}"
            if forbidden_re and forbidden_re.search(blob):
                return False, f"{field}[{index}] still contains {forbidden!r}"
        wanted = " and ".join(repr(v) for v in (required, required_pattern) if v) or "the signature"
        return True, f"All {len(items)} {field} contain {wanted}" + (
            f" and none contain {forbidden!r}" if forbidden else ""
        )

    if check_type == "list_agents_listed":
        return _check_list_agents_listed(data, check)

    if check_type == "mid_run_feedback_background_task_active":
        agent_type = str(check.get("agent_type") or "")
        evidence = benchmark.get("mid_run_feedback") or {}
        if not evidence.get("posted"):
            return False, "Mid-run feedback was never posted"
        task = evidence.get("background_task") or {}
        if task.get("agent_type") != agent_type:
            return False, f"Mid-run feedback was not posted while a background {agent_type} task was running"
        message = str(evidence.get("message") or "").strip()
        if not message or _feedback_index(data, message) is None:
            return False, "Mid-run feedback row is missing from the root transcript"
        return True, f"Feedback posted while background {agent_type} task {task.get('background_task_id')} ran"

    if check_type == "background_task_message_routed":
        return _check_background_task_message_routed(data, check)

    return False, f"Unsupported tree routing check: {check_type}"


def _feedback_index(data: dict, message: str) -> Optional[int]:
    for index, row in enumerate(data.get("messages") or []):
        if isinstance(row, dict) and row.get("role") == "USER" and _message_text(row).strip() == message.strip():
            if not _metadata(row).get("agentMessage") and not _metadata(row).get("agentNotification"):
                return index
    return None


def list_agents_results(data: dict) -> List[dict]:
    """Every FINISHED list_agents result in the run, parsed into listed entries."""
    nodes = _tree_nodes(data)
    root_id = _root_id(data, nodes)
    transcripts: List[Tuple[str, list]] = []
    if root_id:
        transcripts.append((root_id, list(data.get("messages") or [])))
    transcripts += [(aid, list(node.get("messages") or [])) for aid, node in nodes.items() if aid != root_id]
    results = []
    for agent_id, rows in transcripts:
        for row in rows:
            if not isinstance(row, dict):
                continue
            metadata = _metadata(row)
            if metadata.get("toolName") != "list_agents" or metadata.get("toolStatus") != "FINISHED":
                continue
            entries = []
            for line in _message_text(row).splitlines():
                match = _LIST_AGENTS_LINE_RE.match(line)
                if match:
                    entries.append(
                        {
                            "address": match.group("address"),
                            "relationship": match.group("relationship").strip(),
                            "type": match.group("type").strip().lower(),
                        }
                    )
            results.append({"agent_id": agent_id, "entries": entries})
    return results


def _check_list_agents_listed(data: dict, check: dict) -> Tuple[bool, str]:
    minimum = int(check.get("min_other_entries", 1))
    required_types = [str(t).lower() for t in check.get("required_types") or []]
    results = list_agents_results(data)
    if not results:
        return False, "No agent called list_agents successfully"
    best = 0
    for result in results:
        others = [e for e in result["entries"] if e["relationship"].split(" ", 1)[0] != "you"]
        best = max(best, len(others))
        listed_types = {e["type"] for e in others}
        if len(others) >= minimum and all(t in listed_types for t in required_types):
            types = f" including {', '.join(required_types)}" if required_types else ""
            return True, f"list_agents by {result['agent_id'][:8]} listed {len(others)} other agent(s){types}"
    if required_types:
        return False, (
            f"No list_agents result listed >= {minimum} other agent(s) including type(s) {required_types} "
            f"({len(results)} call(s), most others listed: {best})"
        )
    return False, f"No list_agents result listed >= {minimum} agent(s) besides the caller (most: {best})"


def background_routing_trace(data: dict, agent_type: str) -> dict:
    """Judge-visible: the root's background tasks of a type, messages routed to them, list_agents hits."""
    messages = list(data.get("messages") or [])
    tasks = [t for t in background_tasks(messages) if t["agent_type"] == agent_type]
    addresses = set().union(*(_task_addresses(t) for t in tasks)) if tasks else set()
    inbox_rows, send_rows = [], []
    for index, row in enumerate(messages):
        if not isinstance(row, dict):
            continue
        metadata = _metadata(row)
        if metadata.get("agentMessage") is True and _address_forms(metadata.get("recipientTaskId")) & addresses:
            inbox_rows.append(
                {"index": index, "recipient_task_id": metadata.get("recipientTaskId"), "text": _message_text(row)[:300]}
            )
        if metadata.get("toolName") == "send_message_to_agent":
            send_rows.append(
                {
                    "index": index,
                    "status": metadata.get("toolStatus"),
                    "to": metadata.get("toAgentAddress"),
                    "recipient_task_id": metadata.get("recipientTaskId"),
                    "text": _message_text(row)[:200],
                }
            )
    return {
        "agent_type": agent_type,
        "tasks": [
            {k: t[k] for k in ("background_task_id", "address", "path", "started_index", "notification_index")}
            for t in tasks
        ],
        "inbox_rows": inbox_rows[:10],
        "send_message_rows": send_rows[:10],
        "list_agents": [
            {"agent_id": r["agent_id"], "entries": r["entries"][:20]} for r in list_agents_results(data)[:5]
        ],
    }


def _check_background_task_message_routed(data: dict, check: dict) -> Tuple[bool, str]:
    agent_type = str(check.get("agent_type") or "")
    if agent_type not in BACKGROUND_TASK_TYPES:
        return False, f"background_task_message_routed: agent_type must be one of {BACKGROUND_TASK_TYPES}"
    markers = [str(m).lower() for m in check.get("marker_any") or [] if str(m).strip()]
    min_after = int(check.get("min_task_rows_after_message", 0))
    allow_resume = check.get("allow_resume_after_completion", False)
    if not isinstance(allow_resume, bool):
        return False, "background_task_message_routed: allow_resume_after_completion must be a boolean"
    messages = list(data.get("messages") or [])
    tasks = [t for t in background_tasks(messages) if t["agent_type"] == agent_type]
    if not tasks:
        return False, f"Root started no background {agent_type} task"
    feedback = str(((data.get("_benchmark") or {}).get("mid_run_feedback") or {}).get("message") or "")
    feedback_index = _feedback_index(data, feedback) if feedback.strip() else None
    if feedback_index is None:
        return False, "Mid-run feedback row is missing from the root transcript"

    send_targets: List[Tuple[int, set[str], dict]] = []
    for index, row in enumerate(messages):
        metadata = _metadata(row) if isinstance(row, dict) else {}
        if metadata.get("toolName") == "send_message_to_agent" and metadata.get("toolStatus") == "FINISHED":
            send_targets.append(
                (index, _address_forms(metadata.get("recipientTaskId"), metadata.get("toAgentAddress")), metadata)
            )

    problems: List[str] = []
    for task in tasks:
        addresses = _task_addresses(task)
        sends = [(i, metadata) for i, forms, metadata in send_targets if i > feedback_index and forms & addresses]
        if not sends:
            problems.append(f"{task['background_task_id']}: no send_message_to_agent from the root addressed it after feedback")
            continue
        for index, row in enumerate(messages):
            if index <= feedback_index or not isinstance(row, dict):
                continue
            metadata = _metadata(row)
            if metadata.get("agentMessage") is not True:
                continue
            if not (_address_forms(metadata.get("recipientTaskId")) & addresses):
                continue
            text = _message_text(row).lower()
            if markers and not any(marker in text for marker in markers):
                problems.append(f"{task['background_task_id']}: inbox row lacks any of {markers}")
                continue
            notified = task["notification_index"]
            resumed = False
            woke_sends = [i for i, send_metadata in sends if i > index and send_metadata.get("woke") is True]
            if allow_resume and notified is not None and woke_sends:
                second_notification = next(
                    (
                        i
                        for i in range(max(index, notified) + 1, len(messages))
                        if isinstance(messages[i], dict)
                        and (notice := _metadata(messages[i])).get("agentNotification") is True
                        and notice.get("backgroundTaskId") == task["background_task_id"]
                        and isinstance(notice.get("backgroundRun"), int)
                        and notice["backgroundRun"] >= 2
                        and any(send_index < i for send_index in woke_sends)
                    ),
                    None,
                )
                if second_notification is None:
                    problems.append(f"{task['background_task_id']}: resumed task has no second completion notification")
                    continue
                end = second_notification
                resumed = True
            elif notified is not None and notified < index:
                if not allow_resume:
                    problems.append(f"{task['background_task_id']}: message stored after the task had completed")
                    continue
                problems.append(f"{task['background_task_id']}: message stored after the task had completed without a verified wake")
                continue
            else:
                end = notified if notified is not None else len(messages)
            type_tools = _TYPE_PROGRESS_TOOL_NAMES[agent_type]
            later = [
                i
                for i in range(index + 1, end)
                if isinstance(messages[i], dict)
                and (i in task["progress_indexes"] or _metadata(messages[i]).get("toolName") in type_tools)
            ]
            if len(later) < min_after:
                problems.append(
                    f"{task['background_task_id']}: {len(later)} task progress row(s) after the message; "
                    f"expected >= {min_after}"
                )
                continue
            return True, (
                f"Root routed the feedback to {'resumed' if resumed else 'running'} {agent_type} "
                f"task {task['background_task_id']} (inbox row #{index}, "
                f"{len(later)} progress row(s) before completion)"
            )
        if not any(p.startswith(task["background_task_id"]) for p in problems):
            problems.append(f"{task['background_task_id']}: no inbox row stored on the owner after feedback")
    return False, f"No message reached a running background {agent_type} task: " + "; ".join(problems[:4])
