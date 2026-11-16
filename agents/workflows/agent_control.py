"""kill_agent for AgentWorkflow (mixin).

Kill (signal ``kill`` {by_agent_id, by_agent_path[, task_id]}) is a failure,
not a status of its own: everything reports FAILED with "Killed by <killer>"::

    task_id ──▶ own background task: activity-backed → cancel it and finish it
                failed (the normal background-failure notification); durable
                general_purpose/for_each → forward ``kill`` to its children, which
                fail and report through child_completed like any failed child
    else    ──▶ _kill_request + _abort_run("Killed by K") ──▶ _cancel_current_step()
                │  every LLM-turn tool call in flight ──▶ _interrupted_tool_calls
                │       explore / browser / code waits see tool_stop_requested()
                │       (helpers/tool_interrupts.py) and cancel their activity like a
                │       pause; anything else still running after INTERRUPT_TOOL_GRACE
                │       is task-cancelled and gets one ERROR row
                │  tool calls of a turn not yet run are skipped (one ERROR row each,
                │  so tool_use/tool_result pairing stays valid)
                ▼
                run_agent aborts ──▶ _mark_failed(reason="Killed by K") stops our
                background agents and children (parent_finished cascade: "Killed by K
                (parent P was killed)"); the parent gets child_completed {failed}.

10k agents: per-agent state and one signal per action; nothing is shared.

CRITICAL: imported inside the Temporal workflow sandbox (module-level imports only).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Dict, List, Optional, Set

from temporalio import workflow

from helpers.background_agents import (
    CHILD_WORKFLOW_AGENT_TYPES,
    agent_notification_metadata,
    build_agent_notification_text,
)
from tools.base import EventType, MessageStatus, ToolEvent

# How long an interrupted tool may take to wind down by itself (activity-backed
# tools cancel their activity like a pause) before its task is cancelled.
INTERRUPT_TOOL_GRACE = timedelta(seconds=30)
MAX_SEEN_CONTROL_IDS = 200
# Quick bookkeeping tools finish on their own; cancelling them could leave a
# delivery or verifier decision ambiguous.
INTERRUPT_EXEMPT_TOOLS = frozenset(
    {
        "attempt_completion",
        "attempt_completion_with_result",
        "set_plan",
        "send_message_to_agent",
        "kill_agent",
    }
)
_FAILED_CHILD_STATUSES = frozenset({"failed", "error", "max_iterations"})


def child_result_status(result: Dict[str, Any]) -> str:
    """completed / failed for one child_completed result."""
    status = str(result.get("status") or "completed").strip().lower()
    if status in _FAILED_CHILD_STATUSES or result.get("success") is False:
        return "failed"
    return "completed"


class AgentControlMixin:
    """Kill state + behavior; AgentWorkflow calls these hooks."""

    agent_id: str
    parent_agent_id: Optional[str]
    child_tool_ids: Dict[str, str]
    pending_children: Set[str]
    child_workflow_ids: Dict[str, str]
    is_paused: bool
    _paused_by_parent: bool
    _has_new_messages: bool
    _orphaned: bool
    _is_finished: bool
    _background_tasks: Dict[str, Dict[str, Any]]
    _background_finished: Dict[str, Dict[str, Any]]
    _background_handles: Dict[str, "asyncio.Task[Any]"]

    # Provided earlier in AgentWorkflow's MRO (AgentWorkflow / BackgroundAgentsMixin).
    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        raise NotImplementedError

    async def _execute_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        raise NotImplementedError

    async def _post_message(
        self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None, **_: Any
    ) -> None:
        raise NotImplementedError

    def _note_wait_wake(self, kind: str, **detail: Any) -> None:
        raise NotImplementedError

    async def _finish_background_task(self, task_id: str, result: Any, **_: Any) -> None:
        raise NotImplementedError

    def _background_child_ids_for(self, task_id: str, record: Dict[str, Any]) -> List[str]:
        raise NotImplementedError

    def _spawn_runs_in_background(self, tool_name: str, tool_args: Dict[str, Any]) -> bool:
        raise NotImplementedError

    async def _notification_recipient(self) -> str:
        raise NotImplementedError

    def _init_agent_control_state(self) -> None:
        self._interrupted_tool_calls: Set[str] = set()
        self._interruptible_tool_tasks: Dict[str, "asyncio.Task[Any]"] = {}
        self._seen_control_ids: List[str] = []
        self._kill_request: Optional[Dict[str, Any]] = None
        # Why this run is aborting ({message, killed_by?}); travels in the continuation.
        self._abort_info: Optional[Dict[str, str]] = None
        self._rewake_notification_count: int = 0

    # ------------------------------------------------- cancel the current step

    def _control_id_seen(self, key: Any) -> bool:
        """Dedupe retried control signals by message id / idempotency key."""
        if not isinstance(key, str) or not key:
            return False
        if key in self._seen_control_ids:
            return True
        self._seen_control_ids.append(key)
        del self._seen_control_ids[:-MAX_SEEN_CONTROL_IDS]
        return False

    def _cancel_current_step(self) -> None:
        """Cancel every LLM-turn tool call in flight (kill)."""
        self._interrupted_tool_calls.update(self._interruptible_tool_tasks.keys())

    def _killed_by_text(self) -> str:
        by = (self._kill_request or {}).get("by_agent_path") or (self._kill_request or {}).get("by_agent_id")
        return f"this agent was killed by {by or 'another agent'}"

    async def _post_interrupted_tool_result(self, tool_name: str, tool_call_id: str, text: str) -> None:
        await self._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"{tool_name.replace('_', ' ').title()} interrupted",
                message=text,
                status=MessageStatus.ERROR,
                metadata={"interrupted": True},
            ),
            tool_call_id,
            tool_name,
        )

    async def _execute_interruptible_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """run_agent's execute_tool: ``_execute_tool`` that a kill can cancel."""
        # A background spawn's start returns at once (its agent is ended by the
        # kill cascade, never by cancelling this call).
        if tool_name in INTERRUPT_EXEMPT_TOOLS or self._spawn_runs_in_background(tool_name, tool_args):
            return await self._execute_tool(tool_name, tool_args, tool_call_id)
        if self._kill_request is not None:
            text = f"Not run: {self._killed_by_text()} while this step was being decided."
            await self._post_interrupted_tool_result(tool_name, tool_call_id, text)
            return {"error": True, "message": text, "interrupted": True}
        task = asyncio.create_task(self._execute_tool(tool_name, tool_args, tool_call_id))
        self._interruptible_tool_tasks[tool_call_id] = task
        hard_cancelled = False
        try:
            # cutover-class: primitive — joined companion of the wrapped tool call, which
            # observes cutover itself (its parks / handoffs end the task)
            await workflow.wait_condition(lambda: task.done() or tool_call_id in self._interrupted_tool_calls)
            if not task.done():
                try:
                    # Activity-backed tools cancel their own activity (like a pause).
                    # cutover-class: bounded — INTERRUPT_TOOL_GRACE, then the task is cancelled
                    await workflow.wait_condition(task.done, timeout=INTERRUPT_TOOL_GRACE)
                except asyncio.TimeoutError:
                    pass
            if not task.done():
                task.cancel()
                hard_cancelled = True
            try:
                result = await task
            except asyncio.CancelledError:
                result = None
        finally:
            self._interruptible_tool_tasks.pop(tool_call_id, None)
            interrupted = tool_call_id in self._interrupted_tool_calls
            self._interrupted_tool_calls.discard(tool_call_id)
        if not interrupted:
            return result
        text = f"Cancelled: {self._killed_by_text()} while this call was running."
        if hard_cancelled:
            await self._post_interrupted_tool_result(tool_name, tool_call_id, text)
        workflow.logger.info(f"Tool {tool_name} ({tool_call_id}) interrupted (hard={hard_cancelled})")
        return {"error": True, "message": text, "interrupted": True}

    # ----------------------------------------------------------------- kill

    async def _accept_kill_signal(self, data: Any) -> None:
        data = data if isinstance(data, dict) else {}
        if self._is_finished or self._control_id_seen(f"kill:{data.get('idempotency_key')}"):
            return
        by = {key: data[key] for key in ("by_agent_id", "by_agent_path") if isinstance(data.get(key), str)}
        task_id = data.get("task_id")
        if isinstance(task_id, str) and task_id:
            await self._kill_own_background_task(task_id, by=by)
            return
        if self._kill_request is not None:
            return
        self._kill_request = {**by}
        killer = by.get("by_agent_path") or by.get("by_agent_id") or "another agent"
        workflow.logger.warning(f"⏹️ Kill requested by {killer}")
        # The orphan abort: run_agent's next checkpoint ends the run and
        # _mark_failed stops background agents and children.
        self._abort_run(
            f"Killed by {killer}",
            killed_by=killer,
            from_agent_id=by.get("by_agent_id"),
            from_agent_path=by.get("by_agent_path"),
        )
        self._cancel_current_step()

    def _abort_run(self, message: Optional[str] = None, *, killed_by: Optional[str] = None, **wake: Any) -> None:
        """Stop this run at the next checkpoint (kill, or the parent finished): it fails as orphaned."""
        if not self._orphaned:
            workflow.logger.warning(f"Run aborting: {message or 'parent finished'}")
        self._orphaned = True
        self.is_paused = False
        self._paused_by_parent = False
        if message and self._abort_info is None:
            self._abort_info = {"message": message, **({"killed_by": killed_by} if killed_by else {})}
        self._has_new_messages = True
        self._note_wait_wake("aborted", **wake)

    def _abort_reason(self) -> tuple:
        """(reason, message) for an aborted run: "Killed by …" (also for the cascade), or orphaned."""
        message = (self._abort_info or {}).get("message")
        if message:
            return message, message
        return "orphaned", "Parent agent ended; orphaned sub-agent stopped."

    def _killed_by(self) -> Optional[str]:
        """Address of the agent whose kill_agent ended this run (directly or via an ancestor)."""
        return (self._abort_info or {}).get("killed_by")

    def _reports_finish_to_parent(self) -> bool:
        """Orphans stay silent (their parent is gone); a killed agent reports its failure."""
        return self._kill_request is not None or not self._orphaned

    def _own_record_for(self, address: str) -> Optional[str]:
        for task_id, record in self._background_tasks.items():
            if address in (task_id, record.get("address"), record.get("path")):
                return task_id
        return None

    async def _kill_own_background_task(self, address: str, *, by: Dict[str, Any]) -> Optional[str]:
        """Kill one running own background task through the normal failure path.

        Activity-backed tasks are cancelled and finished failed here (one FAILED
        notification, like any failed background task). Durable children get
        ``kill`` and fail themselves; their child_completed finishes the record.
        Returns the task's address, or None if it is not running.
        """
        task_id = self._own_record_for(address)
        if task_id is None:
            return None
        record = self._background_tasks[task_id]
        killer_path = by.get("by_agent_path") or await self._notification_recipient()
        reason = f"Killed by {killer_path}"
        delivered = 0
        if record.get("agent_type") in CHILD_WORKFLOW_AGENT_TYPES:
            kill_payload = {
                "by_agent_id": by.get("by_agent_id") or self.agent_id,
                "by_agent_path": killer_path,
                "idempotency_key": f"{self.agent_id}:{task_id}:kill",
            }
            for child_agent_id in self._background_child_ids_for(task_id, record):
                child_wf_id = self.child_workflow_ids.get(child_agent_id, child_agent_id)
                try:
                    await workflow.get_external_workflow_handle(child_wf_id).signal("kill", kill_payload)
                    delivered += 1
                except Exception as exc:
                    workflow.logger.warning(f"[agent_control] kill signal to {child_agent_id} failed: {exc}")
        if not delivered:
            # The executor usually absorbs the cancellation (Temporal surfaces it as
            # ActivityError) and finishes the record itself first: it must report this reason.
            record["kill_reason"] = reason
            handle = self._background_handles.pop(task_id, None)
            if handle is not None and not handle.done():
                handle.cancel()
                await asyncio.gather(handle, return_exceptions=True)
            await self._finish_background_task(task_id, None, summary=reason, failed=True)
        workflow.logger.info(f"[agent_control] killed own task {task_id} ({record.get('agent_type')}) by {killer_path}")
        return str(record.get("address"))

    # ---------------------------------------------------- rewoken children

    async def _on_rewoken_child_completed(self, child_agent_id: str, result: Dict[str, Any]) -> bool:
        """A child that already reported finished again (an agent message woke it).

        Its original spawn result is never rewritten: one new notification (FINAL_ANSWER / FAILED)
        row is appended instead. Returns False for a first completion.
        """
        if child_agent_id in self.pending_children or child_agent_id not in self.child_tool_ids:
            return False
        tool_id = self.child_tool_ids[child_agent_id]
        base_id = tool_id.split(":", 1)[0]
        if base_id in self._background_tasks:
            return False  # a carried record still waits for this child
        record = self._background_finished.get(base_id) or {}
        status = child_result_status(result)
        address = str(record.get("address") or child_agent_id) if ":" not in tool_id else child_agent_id
        agent_type = str(record.get("agent_type") or "general_purpose")
        if agent_type == "for_each":
            agent_type = "general_purpose"
        summary = str(result.get("summary") or result.get("best_effort_response") or result.get("message") or "")
        structured = result.get("structured_response") or result.get("partial_structured_response")
        self._rewake_notification_count += 1
        try:
            run_id = workflow.info().run_id
        except Exception:
            run_id = "run"
        key = f"{self.agent_id}:{child_agent_id}:rewake:{run_id}:{self._rewake_notification_count}"
        await self._post_message(
            build_agent_notification_text(
                recipient=await self._notification_recipient(),
                sender=str(record.get("path") or address) if ":" not in tool_id else address,
                agent_type=agent_type,
                status=status,
                summary=summary,
                structured_response=structured,
            ),
            "USER",
            # The parent's only copy of the new result: the same parent-visible
            # metadata as a first-run notification. A ``subAgentId`` stamp would mark
            # it as the child's internal work and drop it from the parent's context.
            metadata=agent_notification_metadata(
                address=address,
                agent_type=agent_type,
                status=status,
                background_task_id=base_id,
                idempotency_key=key,
            ),
        )
        self._has_new_messages = True
        self._note_wait_wake(
            "agent_notification",
            background_task_id=base_id if base_id in self._background_finished else None,
            address=address,
            path=record.get("path"),
            child_agent_ids=[child_agent_id],
            status=status,
        )
        workflow.logger.info(f"[agent_control] rewoken child {child_agent_id[:8]} finished again ({status})")
        return True
