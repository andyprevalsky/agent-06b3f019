"""Agent-to-agent messaging activities and the explore agent's list_agents tree view.

list_agents      ──▶ explore_list_agents (inside the explore activity)
  (explore only)       ──▶ GET /api/agents/<owner>/tree?node&depth&cursor&q&path_prefix
                       ──▶ explore_tree_view (re-rooted at the explore task) ──▶ render_agent_view
wait_for node    ──▶ list_agent_tree_activity               ──▶ GET  /api/agents/<self>/tree?node&depth=1
send_message_to_agent     ──▶ send_agent_message_to_address_activity  ──▶ POST /api/agents/<self>/send-agent-message {to}
  (own bg task)  ──▶ send_agent_message_activity             ──▶ POST /api/agents/<self>/agent-messages {recipient_task_id}
own task path    ──▶ resolve_agent_address_activity          ──▶ GET  /api/agents/<self>/resolve-address
kill_agent       ──▶ kill_agent_activity                     ──▶ POST /api/agents/<self>/kill-agent {to}

The backend owns address resolution (agentAddressResolver.ts) and bounds every
read; render_agent_view turns one bounded view into a table of contents the
model drills into with list_agents(node=..., cursor=...).

Activity return annotations stay plain ``Dict[str, Any]``: the workflow
sandbox decodes results with get_type_hints (see structural test
activity_return_types_decode_in_sandbox).
"""

from typing import Any, Dict, List, Optional, Tuple

from temporalio import activity

from domains.agent_messaging.config import HEADER_GOAL_LEN, RENDER_GOAL_LEN
from domains.agent_messaging.repo import (
    fetch_agent_tree,
    post_agent_message,
    post_agent_message_to_address,
    post_kill_agent,
    resolve_agent_address,
)
from helpers.agent_addressing import child_task_path
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent


def _snippet(goal: Any, limit: int = RENDER_GOAL_LEN) -> str:
    text = " ".join(str(goal or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _address(entry: Dict[str, Any]) -> str:
    return str(entry.get("path") or entry.get("agent_id"))


def _children_label(count: int, active: int) -> str:
    return f"({count} {'child' if count == 1 else 'children'}, {active} active)"


class _Relations:
    """Relationship of any listed agent to the caller, from the view's parent links."""

    def __init__(self, view: Dict[str, Any], self_agent_id: str) -> None:
        self.self_id = self_agent_id
        self.root_id = view.get("root_agent_id")
        self.parent_of: Dict[str, Optional[str]] = {}
        for chain_key in ("caller_path", "node_path"):
            chain = [str(e.get("agent_id")) for e in view.get(chain_key) or [] if isinstance(e, dict)]
            for index, agent_id in enumerate(chain):
                self.parent_of.setdefault(agent_id, chain[index - 1] if index else None)
        for node in view.get("nodes") or []:
            if isinstance(node, dict) and node.get("agent_id"):
                self.parent_of[str(node["agent_id"])] = node.get("parent_agent_id")
        for match in view.get("matches") or []:
            if isinstance(match, dict) and match.get("agent_id"):
                ancestors = [str(a) for a in match.get("ancestor_ids") or []]
                for index, agent_id in enumerate(ancestors):
                    self.parent_of.setdefault(agent_id, ancestors[index - 1] if index else None)
                self.parent_of[str(match["agent_id"])] = ancestors[-1] if ancestors else None
        self.caller_chain = [str(e.get("agent_id")) for e in view.get("caller_path") or [] if isinstance(e, dict)]

    def _ancestors(self, agent_id: str) -> List[str]:
        chain: List[str] = []
        current = self.parent_of.get(agent_id)
        while current and current not in chain:
            chain.append(current)
            current = self.parent_of.get(current)
        return chain

    def of(self, agent_id: str) -> str:
        if agent_id == self.self_id:
            return "you"
        if agent_id in self.caller_chain:
            label = "your parent" if self.caller_chain[-2:-1] == [agent_id] else "your ancestor"
        elif self.self_id in self._ancestors(agent_id):
            label = "your child" if self.parent_of.get(agent_id) == self.self_id else "your descendant"
        elif self.parent_of.get(agent_id) and self.parent_of.get(agent_id) == self.parent_of.get(self.self_id):
            label = "your sibling"
        else:
            label = "other branch"
        return f"{label} (root)" if agent_id == self.root_id else label

    def of_task(self, owner_id: str) -> str:
        return "your task" if owner_id == self.self_id else f"task of {self.of(owner_id).replace(' (root)', '')}"


def _header(view: Dict[str, Any], self_agent_id: str) -> List[str]:
    caller_path = [e for e in view.get("caller_path") or [] if isinstance(e, dict)]
    me = caller_path[-1] if caller_path else {"agent_id": self_agent_id}
    crumbs = [f'{_address(e)} "{_snippet(e.get("goal"), HEADER_GOAL_LEN)}"' for e in caller_path[:-1]]
    crumbs.append(f"YOU {_address(me)}")
    depth = me.get("depth", len(caller_path) - 1)
    return [
        f"You are {_address(me)} (depth {depth}). Path: {' › '.join(crumbs)}",
        'Address = first column (or "parent"). Drill in: list_agents(node="<address>"). '
        'Read an agent\'s messages: grep(sources=["agent_network"], trace_path="<address>").',
    ]


def _drill(address: str, cursor: Optional[str] = None) -> str:
    return f'list_agents(node="{address}", cursor="{cursor}")' if cursor else f'list_agents(node="{address}")'


def _render_tree(view: Dict[str, Any], rel: _Relations, *, paged: bool) -> List[str]:
    nodes = [n for n in view.get("nodes") or [] if isinstance(n, dict) and n.get("agent_id")]
    self_id = rel.self_id
    listed = {n["agent_id"] for n in nodes}
    children: Dict[Optional[str], List[Dict[str, Any]]] = {}
    for node in nodes:
        parent = node.get("parent_agent_id")
        children.setdefault(parent if parent in listed else None, []).append(node)
    node_path = [e for e in view.get("node_path") or [] if isinstance(e, dict)]
    focus_id = str(node_path[-1]["agent_id"]) if node_path else self_id
    caller_parent = rel.caller_chain[-2] if len(rel.caller_chain) > 1 else None
    lines: List[str] = []

    def more_line(node: Dict[str, Any], indent: int, shown: int) -> None:
        count = int(node.get("child_count") or 0)
        address = _address(node)
        cursor = None
        if node["agent_id"] == focus_id:
            cursor = view.get("next_cursor")
        elif node["agent_id"] == caller_parent and focus_id == self_id:
            cursor = view.get("sibling_next_cursor")
        is_page = paged and node["agent_id"] == focus_id
        if not cursor and (is_page or shown >= count):
            return  # a cursor page with no next cursor is the last page
        remaining = "more" if is_page else str(max(count - shown, 0))
        lines.append(f"{'  ' * indent}… {remaining} children not shown → {_drill(address, cursor)}")

    def emit(node: Dict[str, Any], indent: int) -> None:
        agent_id = str(node["agent_id"])
        kind = str(node.get("type") or "agent")
        address = _address(node)
        goal = _snippet(node.get("goal"))
        pad = "  " * indent
        if agent_id == self_id:
            line = f"{pad}▶ {address} [YOU ARE HERE] {kind} {node.get('status')}: {goal}"
        elif kind != "agent":
            label = rel.of_task(str(node.get("parent_agent_id")))
            line = f"{pad}- {address} [{label}] {kind} {node.get('status')}: {goal}"
        else:
            line = f"{pad}- {address} [{rel.of(agent_id)}] {kind} {node.get('status')}: {goal}"
        agent_kids = [c for c in children.get(agent_id, []) if str(c.get("type") or "agent") == "agent"]
        count = int(node.get("child_count") or 0)
        if kind == "agent" and count and not agent_kids and agent_id != focus_id:
            line += f" {_children_label(count, int(node.get('active_child_count') or 0))} → {_drill(address)}"
        lines.append(line)
        for child in children.get(agent_id, []):
            emit(child, indent + 1)
        if kind == "agent" and (agent_kids or agent_id == focus_id):
            more_line(node, indent + 1, len(agent_kids))

    for top in children.get(None, []):
        emit(top, 0)
    return lines


def _render_matches(view: Dict[str, Any], rel: _Relations, query: Dict[str, Any]) -> List[str]:
    matches = [m for m in view.get("matches") or [] if isinstance(m, dict) and m.get("agent_id")]
    what = " ".join(
        part
        for part in (
            f'"{query["q"]}"' if query.get("q") else "",
            f"under {query['path_prefix']}" if query.get("path_prefix") else "",
        )
        if part
    )
    if not matches:
        return [f"No agents in this tree match {what}."]
    lines = [f"Matches for {what} (shallowest first):"]
    for match in matches:
        address = _address(match)
        line = (
            f"- {address} [{rel.of(str(match['agent_id']))}] agent {match.get('status')}: {_snippet(match.get('goal'))}"
        )
        if not match.get("path"):
            line += f" (under {' › '.join(str(a) for a in match.get('ancestor_ids') or [])})"
        count = int(match.get("child_count") or 0)
        if count:
            line += f" {_children_label(count, int(match.get('active_child_count') or 0))} → {_drill(address)}"
        lines.append(line)
    if len(matches) >= int(query.get("limit") or 20):
        lines.append(f"Showing the first {len(matches)}; narrow the query or path_prefix for more.")
    return lines


def render_agent_view(
    view: Dict[str, Any],
    *,
    self_agent_id: str,
    query: Optional[Dict[str, Any]] = None,
) -> str:
    """Deterministic, compact table-of-contents text for one tree view."""
    query = query or {}
    rel = _Relations(view, self_agent_id)
    lines = _header(view, self_agent_id)
    if query.get("q") or query.get("path_prefix"):
        return "\n".join(lines + _render_matches(view, rel, query))
    paged = bool(query.get("cursor"))
    node_path = [e for e in view.get("node_path") or [] if isinstance(e, dict)]
    if node_path and str(node_path[-1].get("agent_id")) != self_agent_id or paged:
        focus = node_path[-1] if node_path else {}
        crumbs = " › ".join(_address(e) for e in node_path)
        lines.append(f"Viewing {_address(focus)}{' (next page)' if paged else ''}: {crumbs}")
    return "\n".join(lines + _render_tree(view, rel, paged=paged))


def tree_query_params(tool_call: Dict[str, Any]) -> Tuple[Dict[str, str], Optional[str]]:
    """list_agents tool args → backend query params (or a validation error)."""
    params: Dict[str, str] = {}
    for arg, param in (("node", "node"), ("cursor", "cursor"), ("query", "q"), ("path_prefix", "path_prefix")):
        value = tool_call.get(arg)
        if value is None or value == "":
            continue
        if not isinstance(value, str):
            return {}, f"list_agents `{arg}` must be a string."
        params[param] = value.strip()
    depth = tool_call.get("depth")
    if depth is not None:
        if isinstance(depth, bool) or not isinstance(depth, (int, float, str)) or not str(depth).strip().isdigit():
            return {}, "list_agents `depth` must be an integer from 1 to 3."
        params["depth"] = str(int(depth))
    return params, None


@activity.defn
async def list_agent_tree_activity(
    agent_id: str, user_id: Optional[str], params: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """One bounded tree view for ``agent_id`` (see GET /api/agents/:id/tree); wait_for reads nodes with it."""
    activity.heartbeat(f"Listing agent tree for {agent_id}")
    return await fetch_agent_tree(agent_id, user_id, params or {})


@activity.defn
async def resolve_agent_address_activity(agent_id: str, address: str, user_id: Optional[str]) -> Dict[str, Any]:
    """Resolve ``address`` relative to ``agent_id`` (4xx answers come back as ``{"error"}``)."""
    activity.heartbeat(f"Resolving {address} for {agent_id}")
    return await resolve_agent_address(agent_id, address, user_id)


@activity.defn
async def send_agent_message_activity(
    target_agent_id: str,
    from_agent_id: str,
    message: str,
    idempotency_key: str,
    recipient_task_id: Optional[str],
    user_id: Optional[str],
) -> Dict[str, Any]:
    """Deliver one message by agent id. The backend dedupes on ``idempotency_key`` (retry-safe).

    Returns a plain dict (``AgentMessageDelivery`` shape). Activity return
    annotations must stay plain: the workflow sandbox decodes results with
    ``get_type_hints``, and a stringified TypedDict from a pass-through module
    raised NameError there, retrying the workflow task forever.
    """
    activity.heartbeat(f"Sending agent message to {target_agent_id}")
    payload: Dict[str, Any] = {
        "from_agent_id": from_agent_id,
        "message": message,
        "idempotency_key": idempotency_key,
    }
    if recipient_task_id:
        payload["recipient_task_id"] = recipient_task_id
    return await post_agent_message(target_agent_id, payload, user_id)


@activity.defn
async def send_agent_message_to_address_activity(
    from_agent_id: str, to: str, message: str, idempotency_key: str, user_id: Optional[str]
) -> Dict[str, Any]:
    """Deliver one message to a tree address; the backend resolves it (retry-safe by key)."""
    activity.heartbeat(f"Sending agent message to {to}")
    payload = {"to": to, "message": message, "idempotency_key": idempotency_key}
    return await post_agent_message_to_address(from_agent_id, payload, user_id)


@activity.defn
async def kill_agent_activity(
    from_agent_id: str, to: str, idempotency_key: str, user_id: Optional[str]
) -> Dict[str, Any]:
    """Ask the backend to kill ``to`` and its subtree (descendants only; idempotent)."""
    activity.heartbeat(f"Killing {to}")
    return await post_kill_agent(from_agent_id, {"to": to, "idempotency_key": idempotency_key}, user_id)


def explore_tree_view(
    view: Dict[str, Any],
    *,
    owner_agent_id: str,
    explore_address: str,
    explore_path: Optional[str],
    explore_goal: str,
    default_view: bool,
) -> Dict[str, Any]:
    """Re-root one owner tree view at the explore task calling list_agents.

    The explore task is the caller (YOU ARE HERE) and its owner is its parent:
    caller_path gains the explore entry, and a listed owner always lists the
    explore task under it (even before the owner persisted its tasks). The
    default (owner's own) view becomes the explore's own view: its siblings
    page with the owner's child cursor.
    """
    view = dict(view)
    caller_path = [e for e in view.get("caller_path") or [] if isinstance(e, dict)]
    owner_depth = caller_path[-1].get("depth") if caller_path else 0
    me = {
        "agent_id": explore_address,
        "path": explore_path,
        "goal": explore_goal,
        "status": "running",
        "depth": (owner_depth if isinstance(owner_depth, int) else 0) + 1,
    }
    view["caller_path"] = [*caller_path, me]
    nodes = [n for n in view.get("nodes") or [] if isinstance(n, dict)]
    if any(n.get("agent_id") == owner_agent_id for n in nodes) and not any(
        n.get("agent_id") == explore_address for n in nodes
    ):
        nodes.append({**me, "type": "explore", "parent_agent_id": owner_agent_id})
    view["nodes"] = nodes
    if default_view:
        view["node_path"] = view["caller_path"]
        view["sibling_next_cursor"] = view.get("next_cursor")
        view["next_cursor"] = None
    return view


async def explore_list_agents(
    *,
    execute_activity: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    owner_agent_id: str,
    user_id: Optional[str],
    explore_task_id: str,
    explore_task_name: Optional[str],
    explore_goal: str,
) -> Dict[str, Any]:
    """list_agents for an explore task (runs inside its activity; no workflow).

    Reads the owner's tree view (the explore shares its owner's agent id),
    re-roots it at the explore task, renders it like every tree view, and posts
    the result row with ``metadata.agentTree`` for the FE.
    """
    params, error = tree_query_params(tool_call)
    if params.get("node") == "parent":
        params.pop("node")  # the owner is the backend caller: its own view
    view: Dict[str, Any] = {}
    if error is None:
        try:
            view = await fetch_agent_tree(owner_agent_id, user_id, params)
        except Exception as exc:
            error = f"Could not list agents: {exc}"
        else:
            if view.get("error"):
                error = f"Could not list agents: {view['error']}"
    if error is not None:
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE, title="list_agents failed", message=error, status=MessageStatus.ERROR
            ),
            agent_id=owner_agent_id,
            tool_call_id=tool_call_id,
            tool_name="list_agents",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        return {"error": True, "message": error}
    caller_path = [e for e in view.get("caller_path") or [] if isinstance(e, dict)]
    explore_path = child_task_path(caller_path[-1].get("path") if caller_path else None, explore_task_name)
    explore_address = explore_path or f"{owner_agent_id}/{explore_task_id}"
    view = explore_tree_view(
        view,
        owner_agent_id=owner_agent_id,
        explore_address=explore_address,
        explore_path=explore_path,
        explore_goal=explore_goal,
        default_view=not any(key in params for key in ("node", "cursor", "q", "path_prefix")),
    )
    text = render_agent_view(view, self_agent_id=explore_address, query=params)
    metadata: Dict[str, Any] = {
        key: tool_call.get(key)
        for key in ("query", "node", "path_prefix", "depth", "cursor")
        if tool_call.get(key) not in (None, "")
    }
    # FE-only structured copy of this bounded view (the model reads `text`).
    metadata["agentTree"] = {
        "self_agent_id": explore_address,
        "own_tasks": [],
        **{
            key: view[key]
            for key in ("root_agent_id", "caller_path", "node_path", "nodes", "matches", "next_cursor")
            if view.get(key) is not None
        },
    }
    nodes = len(view.get("nodes") or view.get("matches") or [])
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Listed {nodes} agents",
            message=text,
            status=MessageStatus.FINISHED,
            metadata=metadata,
        ),
        agent_id=owner_agent_id,
        tool_call_id=tool_call_id,
        tool_name="list_agents",
        execute_activity=execute_activity,
        user_id=user_id,
    )
    return {"result": text, "usage": {"llm": [], "service": []}}
