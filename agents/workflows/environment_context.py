"""Environment context for AgentWorkflow (mixin; renderers in helpers/environment_context.py).

    run_agent turn ── sync_environment_context(context) ──▶ _sync_environment_context
        │  render <environment> from workflow state (date + zone, own path/parent,
        │  running background agents); differs from the newest environment row in
        │  ``context`` (or none survived compaction)? ──▶ ONE hidden USER row
        │  {environmentContext} (idempotent key) ──▶ run_agent's poll loads it
        ▼
    each LLM call ── get_environment_tail() ──▶ _environment_tail_seed
           {now, tz, agents} (deterministic workflow state) ──▶ call_llm_activity
           renders <environment-status> after the cached prefix (never persisted)

A root also renders its user's connected GitHub repos: one live inventory
activity (GET /api/integrations/github/repos) per sync, nothing cached; a
failed fetch keeps the listing of the latest environment row, and a list that
empties after it was shown is retracted explicitly.

Sources (no other workflow I/O): ``_background_tasks`` records (path, type,
started_at, child ids), ``_environment_activity`` (latest IN_PROGRESS title a
background executor posted under its bg id), ``pending_children``. Time is the
agent's clock (``simulated_now``: its world clock in simulate mode). Zone: a
known user IANA zone (``user_timezone``), else UTC. Fast Mode replays skip both
parts (their position keys include every user turn).

10k agents: per-agent state only; a row is written only when this agent's own
environment changes (child start/finish, date), never per turn.

CRITICAL: imported inside the Temporal workflow sandbox (module-level imports only).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from temporalio import workflow

from domains.agent_messaging.handler import resolve_own_task_path
from domains.github_repo_inventory.handler import fetch_root_github_repos
from helpers.environment_context import (
    environment_context_metadata,
    latest_environment_block_text,
    render_environment_block,
)
from tools.base import MessageStatus, ToolEvent
from utils.simulated_clock import simulated_now

ENVIRONMENT_ACTIVITY_TITLE_LEN = 120


class EnvironmentContextMixin:
    """Environment block + tail; AgentWorkflow wires these into run_agent."""

    async def _post_message(
        self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None, **_: Any
    ) -> None:
        raise NotImplementedError

    def _note_environment_activity(self, event: Any, tool_call_id: str) -> None:
        """Remember the latest in-progress title of a running background task (this generation)."""
        if tool_call_id not in (getattr(self, "_background_tasks", None) or {}):
            return
        if not isinstance(event, ToolEvent) or event.status != MessageStatus.IN_PROGRESS:
            return
        title = " ".join(str(event.title or "").split())
        if title:
            activity = self.__dict__.setdefault("_environment_activity", {})
            activity[tool_call_id] = title[:ENVIRONMENT_ACTIVITY_TITLE_LEN]

    def _environment_timezone(self) -> Optional[str]:
        zone = getattr(self, "user_timezone", None)
        return zone if isinstance(zone, str) and zone.strip() else None

    def _environment_running_agents(self) -> List[Dict[str, Any]]:
        """Own running background agents, oldest first (records are insertion-ordered)."""
        tasks = getattr(self, "_background_tasks", None) or {}
        activity = getattr(self, "_environment_activity", None) or {}
        pending = set(getattr(self, "pending_children", None) or ())
        agents: List[Dict[str, Any]] = []
        for task_id, record in tasks.items():
            if not isinstance(record, dict) or record.get("status") != "running":
                continue
            agent_type = str(record.get("agent_type") or "agent")
            entry: Dict[str, Any] = {
                "path": record.get("path") or record.get("address") or task_id,
                "type": agent_type,
                "status": "running",
                "started_at": record.get("started_at"),
            }
            children = self._background_child_ids(task_id) if hasattr(self, "_background_child_ids") else []
            if agent_type == "general_purpose" and children:
                entry["agent_id"] = children[0]
            elif agent_type == "for_each" and children:
                entry["child_count"] = len(children)
                entry["active_child_count"] = sum(1 for child in children if child in pending)
            if activity.get(task_id):
                entry["activity"] = activity[task_id]
            agents.append(entry)
        return agents

    def _environment_enabled(self) -> bool:
        # Fast Mode replays recorded trajectories keyed by every user turn.
        return not getattr(self, "fast_mode_cache_enabled", False)

    async def _sync_environment_context(self, context: List[Dict[str, Any]]) -> None:
        """Append the <environment> row when it differs from the newest one in ``context``."""
        if not self._environment_enabled():
            return
        own_path = await resolve_own_task_path(self)
        is_root = not int(getattr(self, "depth", 0) or 0)
        latest = latest_environment_block_text(context)
        text = render_environment_block(
            now=simulated_now(self, workflow.now()),
            tz_name=self._environment_timezone(),
            own_path=own_path,
            is_root=is_root,
            agents=self._environment_running_agents(),
            github_repos=await fetch_root_github_repos(self) if is_root else [],
            previous_block=latest,
        )
        if latest == text:
            return
        await self._post_message(
            text,
            "USER",
            metadata=environment_context_metadata(f"environment:{workflow.uuid4()}"),
            update_tree=False,
        )

    def _environment_tail_seed(self) -> Optional[Dict[str, Any]]:
        """Deterministic inputs of the unsaved <environment-status> tail for this LLM call."""
        if not self._environment_enabled():
            return None
        return {
            "now": simulated_now(self, workflow.now()).isoformat(),
            "tz": self._environment_timezone(),
            "agents": self._environment_running_agents(),
        }
