"""Background spawn_agent execution for AgentWorkflow (mixin).

    LLM turn ── spawn_agent(run_in_background=true, id=T) ──▶ _start_background_spawn
        │  1. posts FINISHED "Started … Address: A" under T {runInBackground, hidden}
        │     — the model's tool_result for T forever; the FE hides it
        │  2. asyncio task: _execute_tool("spawn_agent", args, T)  (unchanged executor)
        │     every row it posts under T / T:<n> gets {excludeFromModel: true}
        │     (_background_row_metadata here; activity-side writers get the same
        │     stamp from the backend lifecycle lock), so the FE sees exactly a
        │     foreground spawn's rows and the model's context never changes
        ▼
    the model keeps working; to wait it calls wait_for(agents=[...]) (a tool-less
    turn gets the normal no-tool handling — nothing here blocks it)
        ▲                                         │ wakes wait_for on notification / message / signal
        │                                         ▼
    task done (or child_completed for a       ONE USER row {agentNotification}: Codex
    resumed general_purpose/for_each) ──────▶ FINAL_ANSWER / FAILED body
                                              (_finish_background_task, deduped by key)

    attempt_completion while tasks run ──▶ normal verifier; its evidence ends with a
        factual "still running" status block (_pending_background_status_text)
        ├─ verifier rejects ──▶ normal feedback loop
        └─ parent finishes (_mark_complete / _mark_failed) ──▶
           _stop_pending_background_agents: cancel live asyncio tasks (their
           activities get cancellation), signal parent_finished to pending
           general_purpose/for_each children (they stop as orphaned), record
           each as "failed"; late child_completed signals are ignored.

Planned (DAG) spawns run in the background too (``_planned_dag_background``)::

    DAG task T ── spawn_agent ──▶ _start_background_spawn (same "started" row)
        │  then DagInterrupts.await_background(T) ─▶ _await_dag_background_spawn
        │      wait_condition: T finished (completed → True, failed → False)
        │      or its executor returned generation_handoff (payload)
        ▼
    DAG marks T complete; the notification row is polled into the DAG context
    before dependents populate their params (they read the child's result).
    A mid-plan message ends only the DAG's wait; T keeps running and
    notifies once like any background spawn.

Records are keyed by the spawn's tool-call id T (internal id; addresses are
task paths). park/resume, notifications and inbox addressing use
the record, never row ids.

Wake log: user / agent messages, notifications, child completions, kills
and parent_finished go through ``_note_wait_wake``,
which ends in-tool waits (wait_for, helpers/wait_wake.py) and the DAG wait.

Durability: records live in ``_background_tasks`` and travel in the
continuation snapshot. On resume, activity-backed types (explore/browser/code)
relaunch in the background (with any resume hint they parked); child-workflow
types (general_purpose/for_each) are not re-spawned — their durable children
report through ``child_completed``, which posts the notification.

10k agents: per-agent state only — no shared channel; one notification row per
background task; waits are signal-driven wait_conditions, never polling loops.

CRITICAL: imported inside the Temporal workflow sandbox (module-level imports only).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Dict, Iterator, List, Optional, Set

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.agent_messaging.config import ACTIVITY_TIMEOUT as AGENT_TREE_ACTIVITY_TIMEOUT
from domains.agent_messaging.handler import resolve_message_target, resolve_own_task_path
from domains.agent_messaging.service import list_agent_tree_activity
from domains.spawn_agent.service import validate_spawn_params
from helpers.agent_addressing import child_task_path, task_name_in_use
from helpers.background_agents import (
    CHILD_WORKFLOW_AGENT_TYPES,
    PAUSED_TASK_STATUS,
    RESUMABLE_TASK_TYPES,
    RESUME_CONVERSATION_KEYS,
    background_message_refusal,
    agent_notification_metadata,
    background_execution_metadata,
    build_agent_notification_text,
    build_background_wake_goal,
    build_background_wake_result,
    build_pending_background_status_text,
    is_background_started_metadata,
)
from helpers.generation_handoff import GenerationHandoffRequested
from helpers.wait_condition_or_handoff import note_generation_handoff, wait_condition_or_generation_handoff
from helpers.wait_wake import first_wake, record_wake, wait_baseline
from loop.dag_executor import DagInterrupts
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent
from workflows.agent_control import child_result_status

BACKGROUND_GOAL_RECORD_LEN = 500
# Wake kinds whose row can interrupt a DAG (loop/dag_executor.py is_dag_interrupt_message).
DAG_MESSAGE_WAKE_KINDS = frozenset({"user_message", "agent_message"})
# Finished tasks kept for addressing (send_message_to_agent / kill_agent / rewake); bounded so a long run cannot grow it.
MAX_FINISHED_BACKGROUND_TASKS = 50
# task_names of evicted finished records stay reserved: their addresses (and durable
# child rows) still exist, so a later spawn must not reuse them. Names only, bounded.
MAX_RETIRED_TASK_NAMES = 1000
# Activity-backed types a message can wake for another run (durable children wake via the backend).
WAKEABLE_TASK_TYPES = frozenset({"explore", "browser", "code"})
# Finished explore/browser/code tasks that keep what a wake needs (args + previous result).
MAX_WAKEABLE_FINISHED_TASKS = 10
FINISHED_RECORD_KEYS = (
    "browser_verified",
    "browser_instruction_receipt",
    "tool_call_id",
    "agent_type",
    "address",
    "goal",
    "status",
    "task_name",
    "path",
    "run",
    "inbox_address",
    "started_at",
    "finished_at",
    "wake_message_ids",
)
MAX_SEEN_AGENT_MESSAGE_IDS = 200


class BackgroundAgentsMixin:
    """Background-task state + behavior; AgentWorkflow calls these hooks."""

    # Attributes provided by AgentWorkflow (declared for type checkers).
    agent_id: str
    is_paused: bool
    child_results: Dict[str, Dict]
    child_tool_ids: Dict[str, str]
    pending_children: Set[str]
    child_workflow_ids: Dict[str, str]
    _has_new_messages: bool

    # Implemented by AgentWorkflow (which overrides these in the MRO).
    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        raise NotImplementedError

    async def _execute_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        raise NotImplementedError

    async def _post_message(
        self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None, **_: Any
    ) -> None:
        raise NotImplementedError

    def _init_background_state(self) -> None:
        # spawn tool-call id -> record (durable; carried across continue_as_new)
        self._background_tasks: Dict[str, Dict[str, Any]] = {}
        # spawn tool-call id -> compact summary of finished tasks (durable, bounded)
        self._background_finished: Dict[str, Dict[str, Any]] = {}
        # task_names of finished records evicted from that bounded registry (durable)
        self._retired_task_names: List[str] = []
        # Notification idempotency keys already posted (durable)
        self._background_notified: Set[str] = set()
        # Agent.backgroundTasks writes run one at a time, each with the snapshot
        # current when it starts, so an older snapshot never lands after a newer one.
        self._background_tasks_write_lock = asyncio.Lock()
        # Live asyncio tasks (this generation only)
        self._background_handles: Dict[str, "asyncio.Task[Any]"] = {}
        # Terminal outcome observed through _handle_tool_event (this generation only)
        self._background_outcomes: Dict[str, Dict[str, Any]] = {}
        self._background_resume_hints: Dict[str, Dict[str, Any]] = {}
        # Bumped by every event that should end a background wait.
        self._background_wake_seq: int = 0
        # Background spawning is on for LLM turns and planned DAG tasks (never resumed parks).
        self._background_spawns_enabled: bool = False
        # task id -> live queue its executor handed off to (this generation only).
        self._background_handoffs: Dict[str, Optional[str]] = {}
        # task ids whose finish (incl. the notification post) is in flight / done
        # (this generation only; a planned DAG task waits for "done").
        self._background_finishing: Set[str] = set()
        self._background_settled: Set[str] = set()
        # receive_agent_message ids already accepted (a retried send re-signals).
        self._seen_agent_message_ids: List[str] = []
        # Wake log for in-tool waits (helpers/wait_wake.py; this generation only).
        self._wait_wake_seq: int = 0
        self._wait_wake_events: List[Dict[str, Any]] = []
        # wake mark read before the last successful context poll (wait baseline).
        self._context_wake_mark: Optional[int] = None

    # ------------------------------------------------------------------ state

    def _background_state_snapshot(self) -> Dict[str, Any]:
        return {
            "tasks": {key: dict(value) for key, value in self._background_tasks.items()},
            "finished": {key: dict(value) for key, value in self._background_finished.items()},
            "notified": sorted(self._background_notified),
            "retired_task_names": list(self._retired_task_names),
            "seen_agent_message_ids": list(self._seen_agent_message_ids),
        }

    def _restore_background_state(self, snapshot: Any) -> None:
        if not isinstance(snapshot, dict):
            return
        tasks = snapshot.get("tasks")
        if isinstance(tasks, dict):
            self._background_tasks = {str(key): dict(value) for key, value in tasks.items() if isinstance(value, dict)}
        finished = snapshot.get("finished")
        if isinstance(finished, dict):
            self._background_finished = {str(k): dict(v) for k, v in finished.items() if isinstance(v, dict)}
        retired = snapshot.get("retired_task_names")
        if isinstance(retired, list):
            self._retired_task_names = [value for value in retired if isinstance(value, str)][-MAX_RETIRED_TASK_NAMES:]
        notified = snapshot.get("notified")
        if isinstance(notified, list):
            self._background_notified = {value for value in notified if isinstance(value, str)}
        seen = snapshot.get("seen_agent_message_ids")
        if isinstance(seen, list):
            self._seen_agent_message_ids = [value for value in seen if isinstance(value, str)][
                -MAX_SEEN_AGENT_MESSAGE_IDS:
            ]

    def _pending_background_ids(self) -> List[str]:
        return [key for key, record in self._background_tasks.items() if record.get("status") == "running"]

    def _pending_background_addresses(self) -> List[str]:
        return [self._background_tasks[key]["address"] for key in self._pending_background_ids()]

    def _is_background_execution_id(self, tool_call_id: Any) -> bool:
        """T (or a for_each child's T:<n>) of an own background spawn."""
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return False
        base_id = tool_call_id.split(":", 1)[0]
        return base_id in self._background_tasks or base_id in self._background_finished

    def _background_row_metadata(
        self, tool_call_id: Any, metadata: Optional[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """Stamp rows the background executor posts under its spawn's id as FE-only.

        The "started" row (runInBackground) stays the model-visible result.
        """
        if is_background_started_metadata(metadata) or not self._is_background_execution_id(tool_call_id):
            return metadata
        stamped = background_execution_metadata(metadata)
        run = self._background_run(str(tool_call_id).split(":", 1)[0])
        if run > 1:
            stamped["backgroundRun"] = run  # a woken task's rows form a new run (FE chip/dock)
        return stamped

    def _background_run(self, task_id: str) -> int:
        record = self._background_tasks.get(task_id) or self._background_finished.get(task_id) or {}
        run = record.get("run")
        return run if isinstance(run, int) and run > 0 else 1

    def _background_inbox_address(self, task_id: str) -> str:
        """Inbox of the task's current run: its spawn id, or ``<id>.run<n>`` after a wake."""
        record = self._background_tasks.get(task_id) or self._background_finished.get(task_id) or {}
        inbox = record.get("inbox_address")
        return inbox if isinstance(inbox, str) and inbox else task_id

    def _background_task_for_address(self, address: str) -> Optional[Dict[str, Any]]:
        for source in (self._background_tasks, self._background_finished):
            for key, record in source.items():
                if address in (key, record.get("address"), record.get("inbox_address")):
                    summary = dict(record)
                    summary["background_task_id"] = key
                    summary["child_workflow"] = record.get("agent_type") in CHILD_WORKFLOW_AGENT_TYPES
                    return summary
        return None

    def _wake_background_waiters(self) -> None:
        self._background_wake_seq += 1

    def _note_wait_wake(self, kind: str, **detail: Any) -> None:
        """Record one wake event (helpers/wait_wake.py) and wake every waiter."""
        record_wake(self, kind, **detail)
        self._wake_background_waiters()

    def _resolve_wait_target_id(self, address: str) -> tuple:
        """wait_for(agents=...) address → (agent id or None, error) via the shared resolver."""
        target_id, _task_id, error = resolve_message_target(self, address)
        return target_id, error

    async def _read_agent_tree_node(self, node: str) -> Optional[Dict[str, Any]]:
        """One bounded tree read for ``node``: its row (status/path/id), ``{"error"}``, or None."""
        try:
            view = await workflow.execute_activity(
                list_agent_tree_activity,
                args=[self.agent_id, getattr(self, "user_id", None), {"node": node, "depth": "1"}],
                start_to_close_timeout=AGENT_TREE_ACTIVITY_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as exc:
            workflow.logger.warning(f"[background] tree read for {node} failed: {exc}")
            return None
        if not isinstance(view, dict):
            return None
        if view.get("error"):
            return {"error": str(view["error"])}
        for entry in [*(view.get("node_path") or [])[-1:], *(view.get("nodes") or [])]:
            if isinstance(entry, dict) and node in (entry.get("agent_id"), entry.get("path")):
                return entry
        path = view.get("node_path") or []
        return path[-1] if path and isinstance(path[-1], dict) else None

    # ------------------------------------------------------- planned (DAG)

    def _dag_interrupts_enabled(self) -> bool:
        # Fast Mode replays and simulate mode keep planned spawns foreground
        # (same reason _spawn_runs_in_background refuses them).
        return not (
            getattr(self, "fast_mode_cache_enabled", False) or getattr(self, "world_model_mode", "real") == "simulate"
        )

    def _dag_interrupt_seq(self) -> int:
        return self._background_wake_seq

    async def _wait_for_dag_interrupt(self, seq: int) -> None:
        # cutover-class: activity-bound — raced against the DAG's in-flight tasks, which observe cutover
        await workflow.wait_condition(lambda: self._background_wake_seq != seq)

    def _dag_hooks(self) -> Optional[DagInterrupts]:
        if not self._dag_interrupts_enabled():
            return None
        return DagInterrupts(
            seq=self._dag_interrupt_seq,
            wait=self._wait_for_dag_interrupt,
            await_background=self._await_dag_background_spawn,
            message_pending=self._dag_message_pending,
        )

    def _dag_message_pending(self) -> bool:
        """A user / agent message signalled after the last context poll (helpers/wait_wake.py)."""
        return first_wake(self, wait_baseline(self), DAG_MESSAGE_WAKE_KINDS) is not None

    @contextlib.contextmanager
    def _planned_dag_background(self) -> Iterator[Optional[DagInterrupts]]:
        """execute_dag scope: planned spawns start in the background (when hooks exist)."""
        hooks = self._dag_hooks()
        self._background_spawns_enabled = hooks is not None
        try:
            yield hooks
        finally:
            self._background_spawns_enabled = False

    async def _await_dag_background_spawn(self, task_id: str) -> Any:
        """A planned spawn's DAG dependency wait (deterministic wait_condition).

        True when the background spawn completed, False when it failed, or a
        ``generation_handoff`` payload when its executor handed
        off (the record stays running and travels in the continuation).
        """

        def _settled() -> bool:
            # Settled = finished with its notification posted, or handed off.
            return (
                task_id in self._background_settled
                or task_id in self._background_handoffs
                or (
                    task_id not in self._background_tasks
                    and task_id not in self._background_finishing
                    and task_id not in self._background_handles
                )
            )

        if task_id in self._background_tasks and task_id not in self._background_handles:
            # Carried record without a live executor (a durable child reporting
            # through child_completed): this wait observes cutover itself.
            try:
                await wait_condition_or_generation_handoff(_settled, self, workflow_mod=workflow)
            except GenerationHandoffRequested as exc:
                return {"generation_handoff": True, "handoff_task_queue": exc.task_queue}
        else:
            # The live executor observes cutover (like a foreground spawn)
            # and reports it through _background_handoffs.
            # cutover-class: activity-bound
            await workflow.wait_condition(_settled)
        if task_id in self._background_tasks:
            return {"generation_handoff": True, "handoff_task_queue": self._background_handoffs.get(task_id)}
        return (self._background_finished.get(task_id) or {}).get("status") == "completed"

    def _accept_agent_message_signal(self, data: Any) -> bool:
        """Dedupe receive_agent_message by message_id; True when it is new."""
        message_id = data.get("message_id") if isinstance(data, dict) else None
        if isinstance(message_id, str) and message_id:
            if message_id in self._seen_agent_message_ids:
                return False
            self._seen_agent_message_ids.append(message_id)
            del self._seen_agent_message_ids[:-MAX_SEEN_AGENT_MESSAGE_IDS]
        self._has_new_messages = True
        sender = data if isinstance(data, dict) else {}
        self._note_wait_wake(
            "agent_message",
            from_agent_id=sender.get("from_agent_id") if isinstance(sender.get("from_agent_id"), str) else None,
            from_agent_path=sender.get("from_agent_path") if isinstance(sender.get("from_agent_path"), str) else None,
        )
        return True

    # ------------------------------------------------------------- start/run

    def _spawn_runs_in_background(self, tool_name: str, tool_args: Dict[str, Any]) -> bool:
        if tool_name != "spawn_agent" or not self._background_spawns_enabled:
            return False
        if tool_args.get("run_in_background", True) is False:
            return False
        # PLAN-phase research must finish before set_plan: planner spawns stay foreground.
        if getattr(self, "current_phase", None) == "PLAN":
            return False
        # Fast Mode replays recorded foreground trajectories; simulate mode
        # holds the parent's world clock on its children. Both stay foreground.
        if getattr(self, "fast_mode_cache_enabled", False) or getattr(self, "world_model_mode", "real") == "simulate":
            return False
        try:
            validate_spawn_params({"tool": "spawn_agent", **tool_args, "_phase": getattr(self, "current_phase", None)})
        except ValueError:
            return False  # the foreground path posts the validation error
        return True

    async def _start_background_spawn(self, tool_args: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        from helpers.browser_budget_stop import budget_stop_pending
        if budget_stop_pending(self):
            return {"error": True, "message": "Browser action budget stop is finalizing; new work is not admitted"}
        task_id = tool_call_id
        args = {key: value for key, value in tool_args.items() if key != "run_in_background"}
        agent_type = str(args.get("type") or "agent")
        record = self._background_tasks.get(task_id) or self._background_finished.get(task_id)
        if record is None:
            task_name = args.get("task_name")
            # Address = task path (<own path>/<task_name>). Resolve it first: the
            # lookup can suspend on an activity, and the uniqueness check below
            # must run with the record insertion (no await between them) so
            # concurrent same-turn spawns cannot both claim one task_name.
            path = child_task_path(await resolve_own_task_path(self), task_name)
            if task_name and (
                task_name in self._retired_task_names
                or task_name_in_use([*self._background_tasks.values(), *self._background_finished.values()], task_name)
            ):
                error = (
                    f"task_name '{task_name}' is already used by another agent you spawned; "
                    "choose a different task_name."
                )
                await self._handle_tool_event(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="spawn_agent failed",
                        message=error,
                        status=MessageStatus.ERROR,
                    ),
                    tool_call_id,
                    "spawn_agent",
                )
                return {"error": True, "message": error}
            # A general_purpose child's agent id is minted here so the executor spawns it under it.
            child_agent_id = str(workflow.uuid4()) if agent_type == "general_purpose" else None
            address = path or child_agent_id or task_id
            record = {
                "tool_call_id": tool_call_id,
                "tool_args": args,
                "agent_type": agent_type,
                "address": address,
                "task_name": task_name,
                "path": path,
                "started_at": workflow.now().isoformat(),
                "goal": str(args.get("goal") or "")[:BACKGROUND_GOAL_RECORD_LEN],
                "status": "running",
                "child_agent_ids": [child_agent_id] if child_agent_id else [],
            }
            self._background_tasks[task_id] = record
        address = record["address"]
        text = (
            f"Started {agent_type} agent in background. Address: {address}. "
            "You will receive a notification when it completes."
        )
        await self._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Started {agent_type} agent in background",
                message=text,
                status=MessageStatus.FINISHED,
                metadata={
                    "runInBackground": True,
                    # FE-neutral: the FE renders the executor's rows (same id) exactly
                    # like a foreground spawn; this row is only the model's result.
                    "hidden": True,
                    "backgroundTaskId": task_id,
                    "backgroundAddress": address,
                    "backgroundAgentType": agent_type,
                    "backgroundPath": record.get("path"),
                    "backgroundGoal": str(record.get("goal") or "")[:200],
                },
            ),
            tool_call_id,
            "spawn_agent",
        )
        # Launch only after the started row exists: every executor row under the
        # same id lands after it (the backend stamps them FE-only by that row).
        if task_id in self._background_tasks:
            self._launch_background_task(task_id)
        # After the started row: persist in-flight tasks for other agents' list_agents
        # (no-op when unchanged, e.g. a retried start).
        await self._update_tree_state()
        return {"success": True, "message": text, "background_task_id": task_id, "address": address}

    def _launch_background_task(self, task_id: str) -> None:
        if task_id in self._background_handles:
            return
        from helpers.browser_budget_stop import budget_stop_pending
        if budget_stop_pending(self):
            raise RuntimeError("Browser action budget stop is finalizing; new work is not admitted")
        # A user pause from this launch on ends the run as "paused" (workflow state,
        # never result text). Read now: a pause handled before the task's first
        # step still belongs to this run.
        pause_sequence = getattr(self, "_pause_signal_sequence", 0)
        self._background_handles[task_id] = asyncio.create_task(self._run_background_task(task_id, pause_sequence))

    def _preassigned_child_agent_id(self, tool_call_id: str) -> Optional[str]:
        """Child agent id minted at background start (general_purpose only)."""
        record = self._background_tasks.get(tool_call_id)
        if record is None or record.get("agent_type") != "general_purpose":
            return None
        children = [child for child in record.get("child_agent_ids") or [] if isinstance(child, str) and child]
        return children[0] if children else None

    async def _run_background_task(self, task_id: str, pause_sequence: int) -> None:
        record = self._background_tasks.get(task_id)
        if record is None:
            return
        args = dict(record.get("tool_args") or {})
        args["run_in_background"] = False
        resume = record.pop("resume", None)
        if isinstance(resume, dict):
            self._background_resume_hints[task_id] = resume
        result: Any = None
        try:
            result = await self._execute_tool("spawn_agent", args, task_id)
        except Exception as exc:  # the record must still finish (one failed notification)
            workflow.logger.error(f"[background] {task_id} executor raised: {exc}")
            result = {"error": True, "message": str(exc)}
        finally:
            self._background_handles.pop(task_id, None)
            self._background_resume_hints.pop(task_id, None)
        if isinstance(result, dict) and result.get("generation_handoff"):
            # Parked or interrupted for cutover: the record stays running and
            # the next generation resumes it (or its children report).
            workflow.logger.info(f"[background] {task_id} carried across generation handoff")
            queue = result.get("handoff_task_queue")
            # A planned (DAG) task waiting on this spawn hands off with it.
            self._background_handoffs[task_id] = queue if isinstance(queue, str) else None
            self._wake_background_waiters()
            # Wake an idle parent wait so it continues as new now (no poll needed).
            note_generation_handoff(self, result.get("handoff_task_queue"))
            return
        paused = (
            record.get("agent_type") in RESUMABLE_TASK_TYPES
            and getattr(self, "_pause_signal_sequence", 0) != pause_sequence
        )
        await self._finish_background_task(task_id, result, paused=paused)

    def _relaunch_background_tasks(self) -> None:
        """Resume records carried by a continuation without blocking the turn."""
        for task_id in self._pending_background_ids():
            if task_id in self._background_handles:
                continue
            record = self._background_tasks[task_id]
            if record.get("agent_type") in CHILD_WORKFLOW_AGENT_TYPES:
                continue  # durable children report through child_completed
            workflow.logger.info(f"[background] relaunching {task_id} after continuation")
            self._launch_background_task(task_id)

    def _record_background_event(self, event: Any, tool_call_id: str) -> None:
        """Remember the terminal outcome a background executor posted under its id."""
        if tool_call_id not in self._background_tasks:
            return
        if isinstance(event, ToolEvent) and is_background_started_metadata(event.metadata):
            return  # the "started" row is the model's result, not the task's outcome
        outcome = self._background_outcomes.setdefault(tool_call_id, {"file_pointers": []})
        if isinstance(event, AssistantEvent):
            if isinstance(event.file_pointer, dict):
                outcome["file_pointers"].append(event.file_pointer)
            return
        if not isinstance(event, ToolEvent) or event.status not in (MessageStatus.FINISHED, MessageStatus.ERROR):
            return
        metadata = event.metadata or {}
        data = event.data or {}
        if metadata.get("toolName") == "spawn_browser_agent" and metadata.get("action_type") == "task_complete":
            outcome["browser_verified"] = metadata.get("success") is True
            outcome["browser_instruction_receipt"] = metadata.get("browser_instruction_receipt")
        outcome["status"] = event.status
        outcome["message"] = event.message or ""
        if isinstance(data.get("result"), str) and data["result"].strip():
            outcome["result"] = data["result"]
        structured = metadata.get("structured_response") or metadata.get("structuredResponse")
        if structured is not None:
            outcome["structured_response"] = structured
        # The provider session a browser ending names (paused, never torn down,
        # until the root finishes); every ending reports it for continuation.
        session_id = metadata.get("session_id")
        if isinstance(session_id, str) and session_id:
            outcome["session_id"] = session_id

    # ----------------------------------------------------------- completion

    async def _finish_background_task(
        self,
        task_id: str,
        result: Any,
        *,
        summary: Optional[str] = None,
        failed: Optional[bool] = None,
        structured_response: Any = None,
        paused: bool = False,
    ) -> None:
        record = self._background_tasks.get(task_id)
        if record is None:
            return
        run = record.get("run")
        if not isinstance(run, int) or run < 1:
            run = 1
        self._background_finishing.add(task_id)
        outcome = self._background_outcomes.pop(task_id, {})
        kill_reason = record.get("kill_reason")
        if isinstance(kill_reason, str) and kill_reason:
            # kill_agent cancelled this task: whichever path finishes it reports the kill.
            failed, summary = True, kill_reason
        if failed is None:
            failed = (isinstance(result, dict) and bool(result.get("error"))) or outcome.get(
                "status"
            ) == MessageStatus.ERROR
        if summary is None:
            summary = str(
                outcome.get("result")
                or outcome.get("message")
                or (result.get("message") if isinstance(result, dict) else "")
                or ""
            )
        if structured_response is None:
            structured_response = outcome.get("structured_response")
        # A user pause / cost limit cancels activity-backed work exactly like a
        # foreground spawn (helpers/tool_interrupts.py): it reports failed.
        status = "failed" if failed else "completed"
        if failed and paused and not kill_reason:
            status = PAUSED_TASK_STATUS
        record["status"] = status
        if record.get("agent_type") == "browser":
            record["browser_verified"] = outcome.get("browser_verified") is True
            record["browser_instruction_receipt"] = outcome.get("browser_instruction_receipt")
        record["finished_at"] = workflow.now().isoformat()
        self._background_tasks.pop(task_id, None)
        finished = {key: record.get(key) for key in FINISHED_RECORD_KEYS}
        if record.get("agent_type") in WAKEABLE_TASK_TYPES:
            # What send_message_to_agent needs to wake this task for another run.
            finished["wake"] = {
                "tool_args": dict(record.get("tool_args") or {}),
                "base_goal": str(record.get("base_goal") or (record.get("tool_args") or {}).get("goal") or ""),
                "result": build_background_wake_result(summary, structured_response),
            }
        self._remember_finished_background_task(task_id, finished)
        if record.get("agent_type") not in CHILD_WORKFLOW_AGENT_TYPES:
            await self._update_tree_state()  # the persisted tree state lists it as finished

        key = f"{self.agent_id}:{task_id}:notification" + (f":run{run}" if run > 1 else "")
        if key not in self._background_notified:
            self._background_notified.add(key)
            text = build_agent_notification_text(
                recipient=await self._notification_recipient(),
                sender=str(record.get("path") or record["address"]),
                agent_type=record["agent_type"],
                status=status,
                summary=summary,
                structured_response=structured_response,
                file_pointers=outcome.get("file_pointers"),
                session_id=outcome.get("session_id"),
            )
            try:
                await self._post_message(
                    text,
                    "USER",
                    metadata=agent_notification_metadata(
                        address=record["address"],
                        agent_type=record["agent_type"],
                        status=status,
                        background_task_id=task_id,
                        idempotency_key=key,
                        run=run,
                        session_id=outcome.get("session_id"),
                    ),
                )
            except Exception as exc:
                workflow.logger.error(f"[background] notification post failed for {task_id}: {exc}")
        self._background_finishing.discard(task_id)
        self._background_settled.add(task_id)
        self._has_new_messages = True
        self._note_wait_wake(
            "agent_notification",
            background_task_id=task_id,
            address=record.get("address"),
            path=record.get("path"),
            child_agent_ids=list(self._background_child_ids_for(task_id, record)),
            status=status,
        )

    def _evict_finished_overflow(self) -> None:
        """Drop the oldest finished records past the bound, keeping their task_names reserved."""
        while len(self._background_finished) > MAX_FINISHED_BACKGROUND_TASKS:
            evicted = self._background_finished.pop(next(iter(self._background_finished)))
            name = evicted.get("task_name")
            if isinstance(name, str) and name and name not in self._retired_task_names:
                self._retired_task_names.append(name)
                del self._retired_task_names[:-MAX_RETIRED_TASK_NAMES]

    def _remember_finished_background_task(self, task_id: str, finished: Dict[str, Any]) -> None:
        """Keep a finished record (bounded); only the newest few keep their wake context."""
        self._background_finished.pop(task_id, None)
        self._background_finished[task_id] = finished
        self._evict_finished_overflow()
        wakeable = [key for key, value in self._background_finished.items() if isinstance(value.get("wake"), dict)]
        for stale in wakeable[:-MAX_WAKEABLE_FINISHED_TASKS]:
            self._background_finished[stale].pop("wake", None)

    def _background_wake_refusal(self) -> Optional[str]:
        """Why this agent cannot start another run of a finished task right now (None when it can)."""
        if getattr(self, "_is_finished", False) or getattr(self, "_orphaned", False):
            return "its owner agent is finishing"
        if getattr(self, "_kill_request", None) is not None:
            return "its owner agent was killed"
        if getattr(self, "is_paused", False):
            return "its owner agent is paused"
        if getattr(self, "_cost_limit_reached", False) or getattr(self, "_has_credits", True) is False:
            return "its owner agent reached its cost limit"
        return None

    async def _wake_background_task(
        self,
        task_id: str,
        message: str,
        *,
        message_id: Optional[str],
        sender: Optional[str],
        continue_conversation: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """send_message_to_agent to a finished explore/browser/code task: start its next run.

        Same task id, path and task_name; the new run's goal is the message plus
        the previous run's goal and result, its inbox is ``<id>.run<n>`` (earlier
        runs' messages are never re-read) and it posts a new notification when it
        finishes. Idempotent per message id (a retried send or a duplicate signal
        never starts a second run). The message was already stored by the
        backend, which applies the per-sender rate and unread guards first.
        """
        from helpers.browser_budget_stop import budget_stop_pending
        if budget_stop_pending(self):
            return {"woke": False, "reason": "Browser action budget stop is finalizing; resume after parking"}
        if task_id in self._background_tasks:
            return {"woke": True, "already_running": True}
        record = self._background_finished.get(task_id)
        if record is None:
            return {"woke": False, "reason": "no such background task"}
        if message_id and message_id in (record.get("wake_message_ids") or []):
            return {"woke": True, "already_running": True}
        wake = record.get("wake")
        refusal = background_message_refusal(record, continue_conversation)
        if refusal is not None:
            return {"woke": False, "reason": refusal}
        if record.get("agent_type") not in WAKEABLE_TASK_TYPES or not isinstance(wake, dict):
            return {"woke": False, "reason": "it is too old to continue; spawn a new one"}
        refusal = self._background_wake_refusal()
        if refusal is not None:
            return {"woke": False, "reason": refusal}
        run = self._background_run(task_id) + 1
        base_goal = str(wake.get("base_goal") or record.get("goal") or "")
        args = {
            key: value for key, value in (wake.get("tool_args") or {}).items() if key not in RESUME_CONVERSATION_KEYS
        }
        inbox_address = f"{task_id}.run{run}"
        if continue_conversation is True and record.get("agent_type") == "browser":
            # Same LLM conversation: the paused run's transcript is restored and
            # this message (stored on that run's inbox) arrives as its next step.
            inbox_address = str(record.get("inbox_address") or task_id)
            args["_resume_paused_conversation"] = {"inbox_address": inbox_address}
        elif continue_conversation is True:
            # Code: the CLI resumes its own conversation; the message is its next turn.
            args["goal"] = message
        else:
            args["goal"] = build_background_wake_goal(
                message=message,
                base_goal=base_goal,
                previous_status=str(record.get("status") or "completed"),
                previous_result=str(wake.get("result") or ""),
            )
            if continue_conversation is False and record.get("agent_type") == "code":
                args["_fresh_conversation"] = True
        self._background_finished.pop(task_id, None)
        self._background_tasks[task_id] = {
            **{key: record.get(key) for key in FINISHED_RECORD_KEYS if key not in ("status", "finished_at")},
            "tool_call_id": task_id,
            "tool_args": args,
            "base_goal": base_goal,
            "status": "running",
            "run": run,
            "inbox_address": inbox_address,
            "started_at": workflow.now().isoformat(),
            "goal": str(message)[:BACKGROUND_GOAL_RECORD_LEN],
            "child_agent_ids": [],
            "wake_message_ids": [*(record.get("wake_message_ids") or []), *([message_id] if message_id else [])][-20:],
        }
        self._background_settled.discard(task_id)
        self._background_outcomes.pop(task_id, None)
        workflow.logger.info(
            f"[background] woke {task_id} ({record.get('agent_type')}, {record.get('path') or record.get('address')}) "
            f"for run {run} with a message from {sender or 'an agent'}"
        )
        self._launch_background_task(task_id)
        await self._update_tree_state()
        return {"woke": True, "run": run}

    async def _wake_background_task_from_signal(self, data: Dict[str, Any]) -> None:
        """receive_agent_message for a finished own task (sent by another agent through the backend)."""
        address = data.get("wake_task_id")
        message = data.get("message")
        if not isinstance(address, str) or not isinstance(message, str) or not message.strip():
            return
        message_id = data.get("message_id")
        if isinstance(message_id, str) and message_id and message_id in self._seen_agent_message_ids:
            return  # a retried send re-signals the same row
        record = self._background_task_for_address(address)
        if record is None or record.get("child_workflow"):
            return
        continue_conversation = data.get("continue_conversation")
        result = await self._wake_background_task(
            record["background_task_id"],
            message,
            message_id=message_id if isinstance(message_id, str) else None,
            sender=data.get("from_agent_path") if isinstance(data.get("from_agent_path"), str) else None,
            continue_conversation=continue_conversation if isinstance(continue_conversation, bool) else None,
        )
        if not result.get("woke"):
            # Refused (paused / killed / cost limit): the id stays unseen so a retry after the owner recovers wakes it.
            workflow.logger.warning(f"[background] did not wake {address}: {result.get('reason')}")
        elif isinstance(message_id, str) and message_id:
            # _wake_background_task is itself idempotent per message id (it changes state before its only await).
            self._seen_agent_message_ids.append(message_id)
            del self._seen_agent_message_ids[:-MAX_SEEN_AGENT_MESSAGE_IDS]

    async def _notification_recipient(self) -> str:
        """ "Task name" of a notification this agent receives: its own task path."""
        return await resolve_own_task_path(self) or self.agent_id

    async def _on_background_child_completed(self, child_agent_id: str) -> None:
        """child_completed hook: finish a carried general_purpose/for_each record."""
        for task_id in list(self._pending_background_ids()):
            if task_id in self._background_handles:
                continue  # the live task owns the notification
            record = self._background_tasks[task_id]
            if record.get("agent_type") not in CHILD_WORKFLOW_AGENT_TYPES:
                continue
            children = self._background_child_ids(task_id)
            if child_agent_id not in children:
                continue
            if any(child not in self.child_results for child in children):
                return
            results = [self.child_results.pop(child) for child in children]
            statuses = [child_result_status(item) for item in results]
            failed_flags = [item_status != "completed" for item_status in statuses]
            if record.get("agent_type") == "general_purpose":
                only = results[0]
                summary = str(only.get("summary") or only.get("best_effort_response") or only.get("message") or "")
                structured = only.get("structured_response") or only.get("partial_structured_response")
            else:
                summary = (
                    f"{sum(failed_flags)}/{len(results)} children failed."
                    if any(failed_flags)
                    else (f"Completed for_each delegation for {len(results)} items.")
                )
                structured = {
                    "items": [
                        {
                            "agent_id": child,
                            "status": "failed" if flag else "completed",
                            "summary": str(item.get("summary") or ""),
                            "structured_response": item.get("structured_response"),
                        }
                        for child, item, flag in zip(children, results, failed_flags)
                    ]
                }
            await self._finish_background_task(
                task_id,
                None,
                summary=summary,
                failed=any(failed_flags),
                structured_response=structured,
            )
            return

    def _background_child_ids(self, task_id: str) -> List[str]:
        return self._background_child_ids_for(task_id, self._background_tasks.get(task_id) or {})

    def _background_child_ids_for(self, task_id: str, record: Dict[str, Any]) -> List[str]:
        children = [child for child in record.get("child_agent_ids") or [] if isinstance(child, str)]
        children.extend(
            child
            for child, tool_id in self.child_tool_ids.items()
            if (tool_id == task_id or tool_id.startswith(f"{task_id}:")) and child not in children
        )
        return children

    # ----------------------------------------------------------------- waits

    def _pending_background_status_text(self) -> Optional[str]:
        """Verifier evidence for attempt_completion: own background agents still running."""
        return build_pending_background_status_text(
            [self._background_tasks[key] for key in self._pending_background_ids()]
        )

    async def _parent_finished_payload(self) -> Dict[str, Any]:
        """parent_finished body: when this agent was killed, who killed it and which parent."""
        killed_by = self._killed_by()
        if not killed_by:
            return {}
        return {"killed_by": killed_by, "killed_parent": await self._notification_recipient()}

    async def _stop_pending_background_agents(self) -> None:
        """Parent is finishing: stop every background agent still running.

        Activity-backed tasks are cancelled (Temporal cancels their in-flight
        activity); durable general_purpose/for_each children receive
        ``parent_finished`` and stop through the orphan path, which does not
        signal back. Each record is kept as "failed" for the tree listing;
        no model-visible row is posted because the parent is done. When this
        agent was killed, the children's failure says so (``killed_by``).
        """
        pending = self._pending_background_ids()
        if not pending:
            return
        stop_payload = await self._parent_finished_payload()
        handles = []
        for task_id in pending:
            record = self._background_tasks.pop(task_id)
            children = self._background_child_ids_for(task_id, record)
            record["status"] = "failed"
            record["finished_at"] = workflow.now().isoformat()
            self._background_finished[task_id] = {key: record.get(key) for key in FINISHED_RECORD_KEYS}
            self._background_outcomes.pop(task_id, None)
            self._background_settled.add(task_id)
            handle = self._background_handles.pop(task_id, None)
            if handle is not None and not handle.done():
                handle.cancel()
                handles.append(handle)
            for child_agent_id in children:
                child_wf_id = self.child_workflow_ids.get(child_agent_id, child_agent_id)
                self.pending_children.discard(child_agent_id)
                self.child_tool_ids.pop(child_agent_id, None)
                try:
                    await workflow.get_external_workflow_handle(child_wf_id).signal("parent_finished", stop_payload)
                except Exception as exc:
                    workflow.logger.warning(f"[background] parent_finished signal to {child_agent_id} failed: {exc}")
            workflow.logger.info(
                f"[background] stopped {task_id} ({record.get('agent_type')}, address={record.get('address')}, "
                f"children={len(children)}) because the parent finished"
            )
        self._evict_finished_overflow()
        if handles:
            # Let the cancelled tasks settle (their outcomes are discarded).
            await asyncio.gather(*handles, return_exceptions=True)
        self._wake_background_waiters()
