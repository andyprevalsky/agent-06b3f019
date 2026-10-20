"""Codex-style task paths for agents and their background tasks.

    root agent                      /root
    child spawned with task_name    <parent path>/<task_name>      (Agent.taskPath, backend-owned)
    in-activity background task     <owner path>/<task_name>       (Agent.backgroundTasks[].path)

Resolution of any address (path, "parent", "/root", agent id) lives in one
place: the backend's agentAddressResolver (GET /api/agents/:id/resolve-address
and POST /api/agents/:id/send-agent-message). Workflow-side code only builds
paths for what it spawns and recognizes its own background tasks.

Pure functions; safe inside the Temporal workflow sandbox.
"""

import re
from typing import Any, Dict, Iterable, List, Optional

ROOT_TASK_PATH = "/root"
TASK_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"
_TASK_NAME_RE = re.compile(TASK_NAME_PATTERN)
_TASK_PATH_RE = re.compile(r"^/root(/[a-z][a-z0-9_]{0,59})*$")
BACKGROUND_TREE_GOAL_LEN = 200


def task_name_error(task_name: Any) -> Optional[str]:
    """Actionable validation error for a spawn ``task_name`` (None when valid)."""
    if not isinstance(task_name, str) or not task_name:
        return (
            "spawn_agent requires 'task_name': a short lowercase slug naming this child, "
            "unique among the agents you spawn (e.g. 'venue_research'). Its address becomes "
            "<your path>/<task_name>."
        )
    if not _TASK_NAME_RE.match(task_name):
        return (
            f"spawn_agent task_name={task_name!r} is invalid: use 1-40 chars of a-z, 0-9 and _, "
            "starting with a letter (e.g. 'draft_email')."
        )
    return None


def planned_task_name(goal: Any, task_index: int) -> str:
    """Deterministic task_name for a DAG-planned spawn: ``<goal slug>_<n>`` (≤ 40 chars).

    The index keeps it unique among one plan's tasks; e.g. "Analyze one
    creator" as task 3 → ``analyze_one_creator_3``.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", str(goal or "").lower()).strip("_")
    if not slug or not slug[0].isalpha():
        slug = f"task_{slug}" if slug else "task"
    suffix = f"_{task_index + 1}"
    return slug[: 40 - len(suffix)].rstrip("_") + suffix


def ensure_planned_task_name(params: Dict[str, Any], task_index: int) -> Dict[str, Any]:
    """DAG-planned spawns keep a valid populator task_name, else get ``planned_task_name``."""
    if task_name_error(params.get("task_name")):
        params["task_name"] = planned_task_name(params.get("goal"), task_index)
    return params


def is_task_path(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 400 and bool(_TASK_PATH_RE.match(value))


def child_task_path(parent_path: Optional[str], task_name: Optional[str]) -> Optional[str]:
    """``<parent path>/<task_name>``, or None when either part is unknown."""
    if not parent_path or not task_name:
        return None
    return f"{parent_path}/{task_name}"


def task_name_in_use(records: Iterable[Dict[str, Any]], task_name: str) -> bool:
    """True when one of this agent's background records already uses ``task_name``."""
    return any(isinstance(record, dict) and record.get("task_name") == task_name for record in records)


# Finished activity-backed tasks persisted per owner so their paths stay resolvable.
MAX_FINISHED_TREE_ENTRIES = 10


def background_tree_entries(
    records: Dict[str, Dict[str, Any]],
    child_workflow_types: Iterable[str],
    finished: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Activity-backed tasks persisted as Agent.backgroundTasks for list_agents, grep and messaging.

    Running tasks first, then the newest ``MAX_FINISHED_TREE_ENTRIES`` finished
    ones (status completed/failed) so a finished task's path still resolves.
    ``address`` is the inbox of the task's current run (a message to it lands
    there). Durable children (general_purpose / for_each) are Agent rows of
    their own and are listed from the tree, so they are excluded here.
    """
    excluded = set(child_workflow_types)

    def _entry(task_id: str, record: Dict[str, Any], status: str) -> Dict[str, Any]:
        inbox = record.get("inbox_address")
        return {
            "address": inbox if isinstance(inbox, str) and inbox else task_id,
            "type": str(record.get("agent_type") or "agent"),
            "goal": str(record.get("goal") or "")[:BACKGROUND_TREE_GOAL_LEN],
            "status": status,
            "started_at": record.get("started_at"),
            "task_name": record.get("task_name"),
            "path": record.get("path"),
        }

    entries = [
        _entry(task_id, record, "running")
        for task_id, record in records.items()
        if record.get("status") == "running" and record.get("agent_type") not in excluded
    ]
    done = [
        _entry(task_id, record, str(record.get("status") or "completed"))
        for task_id, record in (finished or {}).items()
        if task_id not in records and record.get("agent_type") not in excluded
    ]
    return entries + done[-MAX_FINISHED_TREE_ENTRIES:]
