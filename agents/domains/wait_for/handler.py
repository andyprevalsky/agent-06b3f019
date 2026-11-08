"""Wait-for domain handler: runtime entry point.

Thin orchestration layer -- parses tool_call input, delegates to service
functions, and yields ToolEvent objects for the workflow.

Uses legacy (event-driven) pattern like spawn_agent since it needs
workflow_instance for pause/cost-limit state and workflow.start_activity.

Every mode ends early on a wake event (helpers/wait_wake.py)::

    wait_for(until_timestamp | condition | agents)
        mark = wait_baseline(wi)                   the LLM context snapshot (poll)
                                                   events after it are unseen:
                                                   one already recorded ends the
                                                   wait at once ("received before
                                                   the wait started")
        sleep slices = wait_condition(first_wake(wi, mark, ...) or timeout)
        ├─ timestamp / condition: user message, agent message, background
        │  notification, interrupt, parent finished  → "Woken early by …" row
        └─ agents: user message / interrupt / parent finished, or a listed
           agent ("any" = any agent) finishing or messaging us → status of
           the listed agents; timeout → same status, no LLM checks
    handoff mid-wait: agents mode parks (deadline carried) when parking is
    enabled, else every mode closes its chip with DEPLOY_INTERRUPTED.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.wait_for.config import (
    DEFAULT_CHECK_INTERVAL_SECONDS,
    DEFAULT_MAX_CHECKS,
    DEFAULT_MODEL,
    MAX_CHECK_INTERVAL_SECONDS,
    MAX_CHECKS,
    MAX_WAIT_SECONDS,
    MIN_CHECK_INTERVAL_SECONDS,
    MIN_CHECKS,
)
from domains.wait_for.service import cap_evidence, evaluate_condition_activity, format_duration
from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
    park_pending_tool,
    take_tool_resume,
)
from helpers.source_connect_gates import raise_source_connect_gates
from helpers.wait_condition_or_handoff import sleep_until_woken_or_generation_handoff
from helpers.wait_on_world_clock import _wait_on_world_clock
from helpers.wait_wake import (
    ALWAYS_WAKE_KINDS,
    describe_wake,
    first_wake,
    wait_baseline,
    wake_mark,
    wake_source_id,
    wake_source_path,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from utils.oai_demo import is_oai_demo_mass_agent_task
from utils.simulated_clock import (
    advance_simulated_clock,
    simulated_now,
    simulated_skip_metadata,
    simulated_time_skip_enabled,
)
from utils.wait_for_bounds import resolve_wait_for_agents_timeout
from utils.wait_phrase import wait_target

# Agents-mode wait: most addresses resolved / reported per call.
MAX_WAIT_AGENTS = 20
# Agent statuses that mean "finished" (backend AgentStatus + background records).
FINISHED_AGENT_STATUSES = frozenset(
    {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED", "STOPPED", "CANCELLED", "CANCELED"}
)
_AGENT_EVENT_KINDS = frozenset({"agent_message", "agent_notification", "child_completed"})


def _utc_now() -> datetime:
    now = workflow.now()
    return now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _woke_before_start(event: dict[str, Any], started: Optional[int]) -> bool:
    """True when ``event`` was recorded before the wait began (after the context snapshot)."""
    return started is not None and int(event.get("seq") or 0) <= started


def _woken_early_text(
    event: dict[str, Any],
    *,
    woke_at: datetime,
    waited_seconds: int,
    started: Optional[int] = None,
    source_path: Optional[str] = None,
) -> str:
    label = describe_wake(event, source_path)
    if _woke_before_start(event, started):
        return f"Woken early by {label}, received before the wait started."
    return f"Woken early by {label} at {_iso(woke_at)} after waiting {format_duration(max(0, waited_seconds))}."


async def _wake_source_task_path(
    workflow_instance: Any, event: dict[str, Any], targets: Optional[list[dict[str, Any]]] = None
) -> Optional[str]:
    """Task path of the agent behind a wake event; None leaves describe_wake on its id.

    Order: the event's own path, the wait's resolved targets, this agent's
    background records, then one bounded tree read (Agent.taskPath).
    """
    known = wake_source_path(event)
    if known or event.get("kind") not in _AGENT_EVENT_KINDS | {"aborted"}:
        return known
    agent_id = wake_source_id(event)
    if not agent_id:
        return None
    records: list[Any] = list(targets or [])
    for source_name in ("_background_tasks", "_background_finished"):
        records.extend((getattr(workflow_instance, source_name, None) or {}).values())
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str) or not record["path"]:
            continue
        if agent_id in (record.get("agent_ids") or []) or agent_id in (record.get("child_agent_ids") or []):
            return record["path"]
    node = await _read_tree_node(workflow_instance, agent_id)
    if isinstance(node, dict) and node.get("agent_id") == agent_id and isinstance(node.get("path"), str):
        return node["path"] or None
    return None


def skip_wait_wall_clock_for_fast_mode_replay(workflow_instance: Any) -> bool:
    """True only for DEMO-prompt cache replay (test-mass-agent-run-0).

    Live agents may enable the Fast Mode *button* for LLM speed, but wait_for
    must still honor until_timestamp / check_interval_seconds so external state
    (email, SMS, web) has wall-clock time to change. Skipping sleeps is only
    for DEMO cache replay trees where the prompt matches a DEMO-tagged task.
    """
    return is_oai_demo_mass_agent_task(workflow_instance)


# =============================================================================
# WAIT_FOR MANAGER
# =============================================================================


class WaitForManager(ToolManager):
    """Manager for wait-for operations (timestamp or condition polling)."""

    tool_name = "wait_for"

    async def execute_tool(
        self, workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Dispatch to timestamp, condition or agents mode."""
        # Wake events after the LLM context snapshot end the wait, including
        # ones recorded before it started (helpers/wait_wake.py).
        mark = wait_baseline(workflow_instance)
        started = wake_mark(workflow_instance)
        until_timestamp = tool_call.get("until_timestamp")
        condition = tool_call.get("condition")
        raw_description = tool_call.get("description")
        # The UI composes "Waiting for <description>"; a model-written phrase that
        # already says "Waiting for …" must not read "Waiting for Waiting for …".
        description = wait_target(raw_description) if isinstance(raw_description, str) else raw_description
        # resume=True (deploy-migration re-arm): an already-elapsed target
        # completes immediately instead of erroring "in the past". Require a
        # strict boolean True so only the internal _resume_interrupted_wait path
        # enables it — a truthy string (e.g. an LLM-forwarded "false") must not.
        resume = tool_call.get("resume") is True

        agents = tool_call.get("agents")
        modes = [
            name
            for name, value in (("until_timestamp", until_timestamp), ("condition", condition), ("agents", agents))
            if value
        ]
        error: Optional[str] = None
        if len(modes) > 1:
            error = f"{' and '.join(modes)} are mutually exclusive: pass exactly one of until_timestamp, condition or agents."
        elif tool_call.get("timeout_seconds") is not None and not agents:
            error = "timeout_seconds is only valid with agents."
        if error is not None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE, title="wait_for failed", message=error, status=MessageStatus.ERROR
            )
            return

        if agents:
            async for event in self._agents_mode(
                workflow_instance, agents, tool_call.get("timeout_seconds"), description, tool_call_id, mark, started
            ):
                yield event
        elif until_timestamp:
            async for event in self._timestamp_mode(
                workflow_instance, until_timestamp, tool_call_id, resume=resume, mark=mark, started=started
            ):
                yield event
        elif condition:
            if not isinstance(raw_description, str) or not 3 <= len(raw_description) <= 80:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="wait_for failed",
                    message="Must provide 'description' with 'condition'.",
                    status=MessageStatus.ERROR,
                )
                return
            check_interval = tool_call.get("check_interval_seconds", DEFAULT_CHECK_INTERVAL_SECONDS)
            max_checks = tool_call.get("max_checks", DEFAULT_MAX_CHECKS)
            context_gates = getattr(workflow_instance, "context_gates", None) or {}
            async for event in self._condition_mode(
                workflow_instance,
                description,
                condition,
                check_interval,
                max_checks,
                tool_call_id,
                context_gates,
                mark=mark,
                started=started,
            ):
                yield event
        else:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message="Must provide one of 'until_timestamp', 'condition' or 'agents'.",
                status=MessageStatus.ERROR,
            )

    async def _timestamp_mode(
        self,
        workflow_instance: Any,
        until_timestamp: str,
        tool_call_id: str,
        resume: bool = False,
        mark: int = 0,
        started: Optional[int] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Wait until a specific timestamp (ends early on a wake event)."""
        try:
            target = datetime.fromisoformat(until_timestamp.replace("Z", "+00:00"))
            if target.tzinfo is None:
                target = target.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError) as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message=f"Invalid timestamp '{until_timestamp}': {e}",
                status=MessageStatus.ERROR,
            )
            return

        now = workflow.now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        # Simulate runs keep a logical clock: earlier skipped waits move "now"
        # forward so a follow-up target is measured from the advanced clock.
        now = simulated_now(workflow_instance, now)

        delta_seconds = int((target - now).total_seconds())
        if delta_seconds <= 0:
            fast_mode_replay = skip_wait_wall_clock_for_fast_mode_replay(workflow_instance)
            if resume or fast_mode_replay:
                # resume=True: deploy migration re-armed a wait whose target
                # elapsed during downtime. OAi-demo Fast Mode: July demo
                # timestamps (e.g. 2026-07-17T07:03Z) are already past on
                # replay — treat them as satisfied so children continue
                # instead of ERROR. Live Fast Mode must still error.
                reason = (
                    "target already elapsed during deploy" if resume else "target already elapsed (Fast Mode replay)"
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Wait complete",
                    message=f"Reached {until_timestamp} ({reason})",
                    status=MessageStatus.FINISHED,
                    metadata={"waitForMode": "timestamp", "resumed": bool(resume)},
                )
                return
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message=f"Timestamp {until_timestamp} is in the past.",
                status=MessageStatus.ERROR,
            )
            return

        if delta_seconds > MAX_WAIT_SECONDS:
            fast_mode_replay = skip_wait_wall_clock_for_fast_mode_replay(workflow_instance)
            if resume or fast_mode_replay:
                # Live path caps waits at 31 days. OAi-demo Fast Mode replay of
                # a July timestamp that was legal then (e.g. +60d from
                # 2026-07-17) is now >31d in the future — treat it as already
                # waited. Live Fast Mode must still enforce the cap.
                reason = (
                    "target already elapsed during deploy" if resume else "target already elapsed (Fast Mode replay)"
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Wait complete",
                    message=f"Reached {until_timestamp} ({reason})",
                    status=MessageStatus.FINISHED,
                    metadata={"waitForMode": "timestamp", "resumed": bool(resume)},
                )
                return
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message="Cannot wait more than 31 days.",
                status=MessageStatus.ERROR,
            )
            return

        duration = format_duration(delta_seconds)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Waiting until {until_timestamp}",
            message=f"Sleeping for {duration}",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "waitForMode": "timestamp",
                "untilTimestamp": until_timestamp,
                "durationSeconds": delta_seconds,
            },
        )

        # World-model simulate: the world is served by the WMH, so wall-clock
        # waiting changes nothing — skip the sleep and advance the simulated
        # clock instead (time skipping). Recorded in metadata for audit.
        if simulated_time_skip_enabled(workflow_instance):
            world_ms = await _wait_on_world_clock(
                workflow_instance,
                f"{workflow_instance.agent_id}:{tool_call_id}",
                until_ms=int(target.timestamp() * 1000),
            )
            if world_ms is not None:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Wait complete",
                    message=f"Reached {until_timestamp} on the shared world clock (wall-clock wait skipped)",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "timestamp",
                        "untilTimestamp": until_timestamp,
                        "worldClock": True,
                        "worldTimeMs": world_ms,
                    },
                )
                return
            advance_simulated_clock(workflow_instance, delta_seconds)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Wait complete",
                message=f"Reached {until_timestamp} (simulated clock advanced {duration}; wall-clock wait skipped)",
                status=MessageStatus.FINISHED,
                metadata={
                    "waitForMode": "timestamp",
                    "untilTimestamp": until_timestamp,
                    **simulated_skip_metadata(workflow_instance, delta_seconds),
                },
            )
            return

        # OAi-demo Fast Mode: a recorded run already waited out the real time,
        # so on replay the wait is pure dead wall-clock — skip it. Live Fast
        # Mode still sleeps so until_timestamp remains a real wall-clock wait.
        if not skip_wait_wall_clock_for_fast_mode_replay(workflow_instance):
            try:
                woken = await sleep_until_woken_or_generation_handoff(
                    workflow_instance,
                    delta_seconds,
                    lambda: first_wake(workflow_instance, mark) is not None,
                    workflow_mod=workflow,
                )
            except GenerationHandoffRequested:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Waiting until {until_timestamp}",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "timestamp",
                        "untilTimestamp": until_timestamp,
                        "durationSeconds": delta_seconds,
                    },
                )
                raise
            wake = first_wake(workflow_instance, mark) if woken else None
            if wake is not None:
                woke_at = _utc_now()
                remaining = max(0, int((target - woke_at).total_seconds()))
                text = (
                    _woken_early_text(
                        wake,
                        woke_at=woke_at,
                        waited_seconds=int((woke_at - now).total_seconds()),
                        started=started,
                        source_path=await _wake_source_task_path(workflow_instance, wake),
                    )
                    + f" Deadline was {until_timestamp} ({format_duration(remaining)} remaining);"
                    " call wait_for again to keep waiting."
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Wait ended early",
                    message=text,
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "timestamp",
                        "untilTimestamp": until_timestamp,
                        "wokenEarly": True,
                        "wokenBy": wake.get("kind"),
                    },
                    data={"wait_result": text},
                )
                return

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Wait complete",
            message=f"Reached {until_timestamp}",
            status=MessageStatus.FINISHED,
            metadata={"waitForMode": "timestamp"},
        )

    async def _condition_mode(  # noqa: C901
        self,
        workflow_instance: Any,
        description: str,
        condition: str,
        check_interval_seconds: int,
        max_checks_param: int,
        tool_call_id: str,
        context_gates: Optional[dict[str, bool]] = None,
        mark: int = 0,
        started: Optional[int] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Poll with explore agents until condition is satisfied.

        Delegates explore agent lifecycle to SpawnAgentManager._spawn_explore(),
        routing explore events as spawn_agent messages so the FE groups them
        correctly. wait_for events reference the explore via exploreTaskId.
        """
        from tools.spawn_agent import SpawnAgentManager

        # Validate
        check_interval_seconds = max(
            MIN_CHECK_INTERVAL_SECONDS, min(MAX_CHECK_INTERVAL_SECONDS, check_interval_seconds)
        )
        max_checks_param = max(MIN_CHECKS, min(MAX_CHECKS, max_checks_param))

        interval_str = format_duration(check_interval_seconds)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Waiting for {description}",
            message=f"Checking every {interval_str}, up to {max_checks_param} checks",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "waitForMode": "condition",
                "description": description,
                "condition": condition,
                "checkIntervalSeconds": check_interval_seconds,
                "maxChecks": max_checks_param,
            },
        )

        # Contact + message-thread context is now fetched on-demand by the
        # explore agent via the grep tool's network / agent_network_* /
        # messages source modes — no need to prefetch.
        context_gates = context_gates or {}

        model = getattr(workflow_instance, "model", DEFAULT_MODEL)
        claude_token = None  # wait_for uses cheap lite waterfall, no claudeAuth
        spawn_mgr = SpawnAgentManager()
        all_usage: dict[str, list[Any]] = {"llm": [], "service": []}
        started_at = _utc_now()
        last_reasoning = ""

        for check_num in range(1, max_checks_param + 1):
            # Sleep between checks (skip before the first check - check immediately).
            # OAi-demo Fast Mode replay may skip the inter-check wait — recorded
            # condition evaluations already replay from cache. Live Fast Mode
            # must still sleep so external state (email/SMS) can change between
            # polls (agent 515c4894 burned max_checks in ~2m with FM skip-sleep).
            if check_num > 1:
                if simulated_time_skip_enabled(workflow_instance):
                    # Simulate: wait one interval on the shared world clock (the
                    # next check sees the world at that time) instead of sleeping.
                    world_ms = await _wait_on_world_clock(
                        workflow_instance,
                        f"{workflow_instance.agent_id}:{tool_call_id}:check-{check_num}",
                        duration_ms=check_interval_seconds * 1000,
                    )
                    if world_ms is None:
                        advance_simulated_clock(workflow_instance, check_interval_seconds)
                elif not skip_wait_wall_clock_for_fast_mode_replay(workflow_instance):
                    try:
                        woken = await sleep_until_woken_or_generation_handoff(
                            workflow_instance,
                            check_interval_seconds,
                            lambda: first_wake(workflow_instance, mark) is not None,
                            workflow_mod=workflow,
                        )
                    except GenerationHandoffRequested:
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=f"Waiting for {description}",
                            message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                            status=MessageStatus.FINISHED,
                            metadata={
                                "waitForMode": "condition",
                                "description": description,
                                "condition": condition,
                                "checkIntervalSeconds": check_interval_seconds,
                                "maxChecks": max_checks_param,
                            },
                        )
                        raise
                    wake = first_wake(workflow_instance, mark) if woken else None
                    if wake is not None:
                        woke_at = _utc_now()
                        text = (
                            _woken_early_text(
                                wake,
                                woke_at=woke_at,
                                waited_seconds=int((woke_at - started_at).total_seconds()),
                                started=started,
                                source_path=await _wake_source_task_path(workflow_instance, wake),
                            )
                            + f' Last check ({check_num - 1}/{max_checks_param}): "{condition}" not yet met'
                            + (f" — {last_reasoning}" if last_reasoning else "")
                            + ". Call wait_for again to keep waiting."
                        )
                        yield ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=f"Stopped waiting for {description}",
                            message=text,
                            status=MessageStatus.FINISHED,
                            metadata={
                                "waitForMode": "condition",
                                "description": description,
                                "condition": condition,
                                "maxChecks": max_checks_param,
                                "checkNum": check_num - 1,
                                "wokenEarly": True,
                                "wokenBy": wake.get("kind"),
                            },
                            data={
                                "condition_met": False,
                                "checks_completed": check_num - 1,
                                "usage": all_usage,
                                "wait_result": text,
                            },
                        )
                        return

            # Check pause / cost limit
            await workflow_instance._check_parent_state()
            if workflow_instance.is_paused or getattr(workflow_instance, "_cost_limit_reached", False):
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling paused (check {check_num}/{max_checks_param})",
                    message="Agent paused or cost limit reached",
                    status=MessageStatus.ERROR,
                    metadata={
                        "waitForMode": "condition",
                        "description": description,
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                    },
                    data={"condition_met": False, "checks_completed": check_num - 1},
                )
                return

            # Spawn explore agent via SpawnAgentManager
            task_id = str(workflow.uuid4())
            explore_tool_call_id = str(workflow.uuid4())
            explore_goal = (
                f'Gather evidence for whether this is currently true: "{condition}". '
                f"Try to complete your task in as few tool calls as possible."
            )

            check_metadata: dict[str, Any] = {
                "waitForMode": "condition",
                "description": description,
                "condition": condition,
                "checkNum": check_num,
                "maxChecks": max_checks_param,
                "checkIntervalSeconds": check_interval_seconds,
                "exploreTaskId": task_id,
            }
            if check_num > 1 and simulated_time_skip_enabled(workflow_instance):
                check_metadata.update(simulated_skip_metadata(workflow_instance, check_interval_seconds))
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Check {check_num}/{max_checks_param}: checking...",
                message="Verifying condition",
                status=MessageStatus.IN_PROGRESS,
                metadata=check_metadata,
            )

            # Delegate to _spawn_explore. Pass a local list for raw tool results
            # so the ~150 KB sub-agent trace stays in-process and never gets
            # persisted into ToolEvent.data / shipped across activity boundaries.
            # Fast Mode does not change this wait — cache only mocks the
            # explore's external LLM / web_search / web_fetch calls.
            explore_tool_call_results: list[str] = []
            explore_usage: dict[str, list[Any]] = {}
            explore_unavailable_sources: list[dict] = []

            async for event in spawn_mgr._spawn_explore(
                workflow_instance,
                {"type": "explore", "goal": explore_goal},
                explore_tool_call_id,
                task_id=task_id,
                display_goal=condition,
                capture_tool_results=explore_tool_call_results,
            ):
                # Route explore events as spawn_agent messages (correct toolName for FE grouping)
                await workflow_instance._handle_tool_event(event, explore_tool_call_id, "spawn_agent")

                # Usage is FINISHED-only; unavailable_sources can also arrive on
                # ERROR when an explore had connector gaps plus another failure.
                if event.data:
                    if event.status == MessageStatus.FINISHED:
                        explore_usage = event.data.get("usage", {})
                    if "unavailable_sources" in event.data:
                        explore_unavailable_sources = event.data.get("unavailable_sources") or []

            # Direct _spawn_explore callers must raise source_connect gates the
            # same way execute_tool does; wait_for previously dropped them.
            # Skip when already paused so we reach the pause branch below instead
            # of parking on raise_gate_direct's response wait.
            if explore_unavailable_sources and not workflow_instance.is_paused:
                await raise_source_connect_gates(workflow_instance, explore_unavailable_sources)

            # Check if explore was cancelled (paused during explore / gate wait)
            if workflow_instance.is_paused:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling cancelled (check {check_num}/{max_checks_param})",
                    message="Explore agent cancelled due to pause",
                    status=MessageStatus.ERROR,
                    metadata={
                        "waitForMode": "condition",
                        "description": description,
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                        "exploreTaskId": task_id,
                    },
                    data={"condition_met": False, "checks_completed": check_num - 1},
                )
                return

            # Aggregate usage from explore agent
            all_usage["llm"].extend(explore_usage.get("llm", []))
            all_usage["service"].extend(explore_usage.get("service", []))

            # Use raw tool call results as evidence (not the explore agent's summary)
            # to prevent the explore agent from influencing the condition verdict
            evidence = "\n\n".join(explore_tool_call_results) if explore_tool_call_results else "No evidence gathered."
            evidence = cap_evidence(evidence)

            # Evaluate condition with cheap LLM judge
            try:
                eval_result = await workflow.execute_activity(
                    evaluate_condition_activity,
                    args=[condition, evidence, model, claude_token],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.error(f"[wait_for] Condition eval failed: {e}")
                eval_result = {"satisfied": False, "reasoning": f"Evaluation error: {e}"}

            satisfied = eval_result.get("satisfied", False)
            reasoning = eval_result.get("reasoning", "")
            last_reasoning = str(reasoning or "")[:500]

            if satisfied:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Condition met (check {check_num}/{max_checks_param})",
                    message=f"Condition: {condition}\n\nEvidence: {evidence}\n\n{reasoning}",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "condition",
                        "description": description,
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                        "exploreTaskId": task_id,
                        "conditionMet": True,
                    },
                    data={
                        "condition_met": True,
                        "checks_completed": check_num,
                        "evidence": evidence,
                        "usage": all_usage,
                    },
                )
                return

            # Post check result (FINISHED = this individual check is done)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Check {check_num}/{max_checks_param}: not yet met",
                message=reasoning,
                status=MessageStatus.FINISHED,
                metadata={
                    "waitForMode": "condition",
                    "description": description,
                    "condition": condition,
                    "checkNum": check_num,
                    "maxChecks": max_checks_param,
                    "checkIntervalSeconds": check_interval_seconds,
                    "exploreTaskId": task_id,
                    "conditionMet": False,
                },
            )

            # Re-establish overall IN_PROGRESS so the representative message
            # reflects the actual state (still waiting, sleeping until next check)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Waiting for {description}",
                message=f"Next check in {interval_str}",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "waitForMode": "condition",
                    "description": description,
                    "condition": condition,
                    "checkIntervalSeconds": check_interval_seconds,
                    "maxChecks": max_checks_param,
                    "checkNum": check_num,
                    "exploreTaskId": task_id,
                    "conditionMet": False,
                },
            )

        # Exhausted all checks -- signal failure so DAG exits
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Condition not met after {max_checks_param} checks",
            message=(
                f"Checked every {interval_str} for {format_duration(check_interval_seconds * max_checks_param)}. "
                f'Condition "{condition}" was never satisfied.'
            ),
            status=MessageStatus.ERROR,
            metadata={
                "waitForMode": "condition",
                "description": description,
                "condition": condition,
                "maxChecks": max_checks_param,
            },
            data={
                "condition_met": False,
                "checks_completed": max_checks_param,
                "usage": all_usage,
            },
        )

    # ------------------------------------------------------------------ agents

    async def _agents_mode(
        self,
        workflow_instance: Any,
        agents: Any,
        timeout_seconds: Any,
        description: Any,
        tool_call_id: str,
        mark: int,
        started: Optional[int] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Block until a listed agent finishes or messages us (or a user message / interrupt / timeout).

        No LLM checks: wakes are signal-driven (helpers/wait_wake.py). Own
        background agents report status from workflow state; other agents
        from one backend tree read each.
        """
        any_agent = agents == "any" or agents == ["any"]
        addresses: list[str] = []
        if not any_agent:
            if isinstance(agents, str):
                agents = [agents]
            if not isinstance(agents, list):
                agents = []
            addresses = list(dict.fromkeys(str(a).strip() for a in agents if isinstance(a, str) and a.strip()))
        if not any_agent and not addresses:
            yield _wait_for_error(
                'agents must list at least one address (a path, "parent" or an agent id), or be ["any"].'
            )
            return
        if len(addresses) > MAX_WAIT_AGENTS:
            yield _wait_for_error(f'agents can list at most {MAX_WAIT_AGENTS} addresses; use ["any"] for more.')
            return
        try:
            # Codex floor: below the minimum is clamped (and noted), above the maximum rejected.
            timeout, clamp_note = resolve_wait_for_agents_timeout(timeout_seconds)
        except ValueError as exc:
            yield _wait_for_error(str(exc))
            return
        label = description if isinstance(description, str) and description.strip() else "other agents"
        base_meta: dict[str, Any] = {
            "waitForMode": "agents",
            "description": label,
            "agents": "any" if any_agent else addresses,
            "timeoutSeconds": int(timeout),
        }

        targets: list[dict[str, Any]] = []
        for address in addresses:
            target, error = await _resolve_wait_target(workflow_instance, address)
            if error is not None:
                yield _wait_for_error(f"Cannot wait on {address}: {error}")
                return
            targets.append(target)
        # Name the waited-on agents by their task names ("Waiting for chase_balances"),
        # the same names the agents panel shows; the model's description is the fallback.
        # targetTypes (same order) picks each target's icon on the work row.
        names = [_wait_target_name(target) for target in targets]
        if not any_agent and names and all(names):
            label = ", ".join(str(name) for name in names)
            base_meta["description"] = label
            base_meta["targetNames"] = names
            base_meta["targetTypes"] = [_wait_target_type(target) for target in targets]

        now = _utc_now()
        resume = take_tool_resume(workflow_instance, tool_call_id)
        deadline = now + timedelta(seconds=int(timeout))
        started_at = now
        if isinstance(resume, dict) and resume.get("mode") == "agents":
            # Re-entered after a generation handoff: keep the original deadline.
            try:
                deadline = datetime.fromisoformat(str(resume["deadline"]).replace("Z", "+00:00"))
                started_at = datetime.fromisoformat(str(resume["started_at"]).replace("Z", "+00:00"))
            except (KeyError, TypeError, ValueError):
                pass
        else:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Waiting for {label}",
                message=f"Waiting up to {format_duration(int(timeout))} for "
                + ("any of your agents" if any_agent else ", ".join(addresses)),
                status=MessageStatus.IN_PROGRESS,
                metadata=dict(base_meta),
            )

        already = [t for t in targets if _is_finished_status(t.get("status"))]
        wake: Optional[dict[str, Any]] = None

        def _matches(event: dict[str, Any]) -> bool:
            return _agent_event_matches(event, None if any_agent else targets)

        # "any" with nothing running has nothing to wait for (tree-feedback-routing
        # a1f51afd: the lead waited 6 minutes after all of its drafters had finished).
        none_running = any_agent and not _running_own_agents(workflow_instance)
        if none_running:
            wake = first_wake(workflow_instance, mark, (), _matches)
        elif not already:
            remaining = (deadline - _utc_now()).total_seconds()
            try:
                woken = await sleep_until_woken_or_generation_handoff(
                    workflow_instance,
                    max(0.0, remaining),
                    lambda: first_wake(workflow_instance, mark, (), _matches) is not None,
                    workflow_mod=workflow,
                )
            except GenerationHandoffRequested as exc:
                if park_pending_tool(
                    workflow_instance,
                    tool_call_id,
                    {"mode": "agents", "deadline": _iso(deadline), "started_at": _iso(started_at)},
                ):
                    raise GenerationHandoffRequested(exc.task_queue, parked=True) from exc
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Waiting for {label}",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                    metadata=dict(base_meta),
                )
                raise
            wake = first_wake(workflow_instance, mark, (), _matches) if woken else None

        ended_at = _utc_now()
        waited = format_duration(max(0, int((ended_at - started_at).total_seconds())))
        if already:
            headline = f"{', '.join(t['address'] for t in already)} already finished."
            woken_by = "already_finished"
        elif wake is None and none_running:
            headline = "None of your agents is running, so there is nothing to wait for."
            woken_by = "none_running"
        elif wake is not None and _woke_before_start(wake, started):
            label = describe_wake(wake, await _wake_source_task_path(workflow_instance, wake, targets))
            headline = f"Woken by {label} received before the wait started."
            woken_by = wake.get("kind")
        elif wake is not None:
            label = describe_wake(wake, await _wake_source_task_path(workflow_instance, wake, targets))
            headline = f"Woken by {label} after {waited}."
            woken_by = wake.get("kind")
        else:
            headline = (
                f"Timed out after {waited}: no listed agent finished or messaged you. "
                "Call wait_for again to keep waiting."
            )
            woken_by = "timeout"
        status_lines = await _agent_status_lines(workflow_instance, targets, any_agent)
        text = headline + ("\nAgents:\n" + "\n".join(status_lines) if status_lines else "")
        if clamp_note:
            text += f"\n\n{clamp_note}"
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Wait timed out" if woken_by == "timeout" else "Wait ended",
            message=text,
            status=MessageStatus.FINISHED,
            metadata={**base_meta, "wokenBy": woken_by},
            data={"wait_result": text},
        )


def _running_own_agents(workflow_instance: Any) -> list[str]:
    pending = getattr(workflow_instance, "_pending_background_ids", None)
    return list(pending()) if callable(pending) else []


def _wait_for_error(message: str) -> ToolEvent:
    return ToolEvent(type=EventType.POST_MESSAGE, title="wait_for failed", message=message, status=MessageStatus.ERROR)


def _is_finished_status(status: Any) -> bool:
    return isinstance(status, str) and status.upper() in FINISHED_AGENT_STATUSES


async def _read_tree_node(workflow_instance: Any, node: str) -> Optional[dict[str, Any]]:
    """One bounded backend tree read for ``node`` (AgentWorkflow._read_agent_tree_node)."""
    reader = getattr(workflow_instance, "_read_agent_tree_node", None)
    return await reader(node) if callable(reader) else None


async def _resolve_wait_target(workflow_instance: Any, address: str) -> tuple[dict[str, Any], Optional[str]]:
    """Address → {address, agent_ids, background_task_id, path, agent_type, code_provider, own, status}
    (or an error)."""
    finder = getattr(workflow_instance, "_background_task_for_address", None)
    own = finder(address) if callable(finder) else None
    if own is not None:
        children = [c for c in own.get("child_agent_ids") or [] if isinstance(c, str) and c]
        return {
            "address": address,
            "agent_ids": children,
            "background_task_id": own.get("background_task_id"),
            "path": own.get("path"),
            "task_name": own.get("task_name"),
            "agent_type": own.get("agent_type"),
            "code_provider": own.get("code_provider"),
            "own": True,
            "status": own.get("status"),
        }, None
    resolver = getattr(workflow_instance, "_resolve_wait_target_id", None)
    target_id, error = resolver(address) if callable(resolver) else (None, None)
    if error is not None:
        return {}, error
    node = await _read_tree_node(workflow_instance, target_id or address)
    if isinstance(node, dict) and node.get("error"):
        return {}, str(node["error"])
    node = node or {}
    agent_id = target_id or node.get("agent_id")
    return {
        "address": address,
        "agent_ids": [agent_id] if isinstance(agent_id, str) and agent_id else [],
        "background_task_id": None,
        "path": node.get("path")
        if isinstance(node.get("path"), str)
        else (address if address.startswith("/") else None),
        "own": False,
        "status": node.get("status"),
        "node": target_id or address,
        "agent_type": node.get("type"),
        "code_provider": node.get("code_provider") or node.get("provider"),
    }, None


_GENERAL_PURPOSE_TYPES = {"agent", "general_purpose", "for_each"}
# The kinds the FE maps to an icon as-is (waitAgentKinds.ts agentKind; 'code' alone lets
# the transcript pick the CLI).
_PLAIN_TARGET_TYPES = {"code", "browser", "explore"}


def _wait_target_type(target: dict[str, Any]) -> Optional[str]:
    """A waited-on agent's kind for its icon: code[:claude|:codex] | browser | explore | general_purpose.

    None when the type is unknown (a failed tree read, a path-only fallback, a type outside
    that set): the FE then derives the icon from its transcript instead of showing a wrong one.
    """
    kind = target.get("agent_type")
    if not isinstance(kind, str):
        return None
    if kind in _GENERAL_PURPOSE_TYPES:
        return "general_purpose"
    if kind not in _PLAIN_TARGET_TYPES:
        return None
    provider = target.get("code_provider")
    if kind == "code" and provider in ("claude", "codex"):
        return f"code:{provider}"
    return kind


def _wait_target_name(target: dict[str, Any]) -> Optional[str]:
    """A waited-on agent's task name: its spawn task_name, else its path's last segment."""
    name = target.get("task_name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    path = target.get("path")
    if isinstance(path, str) and "/" in path:
        segment = path.rstrip("/").rsplit("/", 1)[-1]
        return segment or None
    return None


def _agent_event_matches(event: dict[str, Any], targets: Optional[list[dict[str, Any]]]) -> bool:
    """Agents-mode wake predicate; ``targets=None`` means "any"."""
    kind = event.get("kind")
    if kind in ALWAYS_WAKE_KINDS:
        return True
    if kind not in _AGENT_EVENT_KINDS:
        return False
    if targets is None:
        return True
    for target in targets:
        names = {value for value in (target.get("address"), target.get("path")) if value}
        ids = set(target.get("agent_ids") or [])
        if kind == "agent_message":
            sender_id, sender_path = event.get("from_agent_id"), event.get("from_agent_path")
            if not sender_id and not sender_path:
                return True  # sender unknown: let the model read the message
            if sender_id in ids or sender_path in names:
                return True
        elif kind == "agent_notification":
            if (
                (target.get("background_task_id") and event.get("background_task_id") == target["background_task_id"])
                or event.get("address") in names
                or event.get("path") in names
                or ids & set(event.get("child_agent_ids") or [])
            ):
                return True
        elif kind == "child_completed" and event.get("agent_id") in ids:
            return True
    return False


async def _agent_status_lines(workflow_instance: Any, targets: list[dict[str, Any]], any_agent: bool) -> list[str]:
    """Current status per listed agent (own: workflow state; others: one tree read each)."""
    lines: list[str] = []
    if any_agent:
        for source_name in ("_background_tasks", "_background_finished"):
            records = getattr(workflow_instance, source_name, None) or {}
            for record in list(records.values())[-MAX_WAIT_AGENTS:]:
                if isinstance(record, dict):
                    lines.append(f"- {record.get('address')}: {record.get('status')}")
        return lines[: MAX_WAIT_AGENTS * 2]
    finder = getattr(workflow_instance, "_background_task_for_address", None)
    for target in targets:
        status = target.get("status")
        if target.get("own") and callable(finder):
            record = finder(target["address"]) or {}
            status = record.get("status", status)
        elif target.get("node"):
            node = await _read_tree_node(workflow_instance, target["node"])
            if isinstance(node, dict) and not node.get("error"):
                status = node.get("status", status)
        lines.append(f"- {target['address']}: {str(status or 'unknown').lower()}")
    return lines


# =============================================================================
# SINGLETON
# =============================================================================

_manager: WaitForManager | None = None


def get_manager() -> WaitForManager:
    """Return the singleton WaitForManager instance."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = WaitForManager()
    return _manager


# =============================================================================
# WORKFLOW HELPER (called from TOOL_EXECUTORS - legacy signature)
# =============================================================================


async def wait_for(workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str) -> tuple[Any, str]:
    """Workflow helper for wait_for tool.

    Legacy event-driven pattern (like spawn_agent). Returns (last_status, result_text).
    """
    manager = get_manager()
    last_status = None
    last_result = ""
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "wait_for")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Track usage from condition polling
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="wait_for", call_site="wait_for")
        # Capture result for context
        if isinstance(event, ToolEvent) and event.data and event.data.get("wait_result"):
            last_result = str(event.data["wait_result"])
        elif isinstance(event, ToolEvent) and event.data and event.data.get("condition_met") is not None:
            met = event.data["condition_met"]
            checks = event.data.get("checks_completed", 0)
            evidence = event.data.get("evidence", "")
            last_result = f"condition_met={met}, checks_completed={checks}"
            if evidence:
                last_result += f", evidence={evidence}"
    return last_status, last_result
