"""Resume a stopped browser agent when the person types to it and its owner cannot.

The owner's own workflow resumes a stopped BACKGROUND browser when it runs
(``receive_agent_message`` from_user: a paused one continues its conversation, a
finished one starts a fresh conversation that carries its earlier goal and result).
When it cannot (the Rose agent finished or is paused, or the browser ran as a
foreground spawn), the backend starts this workflow
(back-end/src/domains/agents/agentMessageResume.ts):

    request {agent, user, model, spawn tool call, inbox address, goal, start_url,
             mode: continue | fresh, message, previous_result}
      └─▶ SpawnBrowserAgentManagerV3.execute_tool (the browser spawn's own path)
          continue: the paused run's archived conversation and provider session are
                    restored (_resume_paused_conversation); the person's message is
                    on that run's inbox and is read at the first step
          fresh:    the browser tool's own recovery when no conversation was kept
                    (continue_conversation=false): a new conversation on the same
                    browser profile, goal = the message + the earlier goal and result

STATE MACHINE (this workflow is the browser spawn's ``workflow_instance``):
    [RUNNING] ── signal pause (the owner's pause, backend pauseAgent) ──▶ the spawn's
        pause path ends the activity ──▶ [DONE]
    [RUNNING] ── a deploy parks the browser task on a newer generation ──▶
        continue_as_new onto the live queue with the parked resume ──▶ [RUNNING]
    [RUNNING] ── any failure (bad request, fenced write, a saved conversation that
        is gone) ──▶ UI-only "Browser could not resume" ERROR row ──▶ non-retryable

The workflow id is ``code-resume:<agent>:browser:<turn row>``: the backend's worker
routes attribute that generation to the owner's live generation
(codeResumeGeneration.ts), exactly like a code-agent resume run.
Rows are UI-only (``excludeFromModel``): nothing enters the owner's planner context.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any, Dict, List, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from domains.spawn_browser_agent_v3.handler import get_manager
    from helpers.background_agents import build_background_wake_goal
    from helpers.fetch_queue_pointer import fetch_agent_queue_pointer
    from helpers.generation_handoff import GenerationHandoffRequested, should_handoff_to_generation
    from helpers.handle_tool_event import handle_tool_event
    from tools.base import EventType, MessageStatus, ToolEvent
    from workflows.resume_billing import ResumeBillingMixin

TOOL_NAME = "spawn_browser_agent"
REQUIRED_FIELDS = ("agent_id", "user_id", "tool_call_id", "inbox_address", "message")


def resume_browser_tool_call(request: Dict[str, Any]) -> Dict[str, Any]:
    """The browser spawn's arguments for the resumed run."""
    inbox_address = str(request["inbox_address"])
    tool_call: Dict[str, Any] = {
        "tool": TOOL_NAME,
        "start_url": request.get("start_url") or None,
        "inbox_address": inbox_address,
    }
    # The spawn's own output schema and files (the files resolve from this run's context).
    if isinstance(request.get("output_schema"), dict):
        tool_call["output_schema"] = request["output_schema"]
    names = [item.get("original_filename") for item in request.get("attachments") or [] if isinstance(item, dict)]
    if names:
        tool_call["attachments"] = [name for name in names if isinstance(name, str)]
    if request.get("mode") == "continue":
        # Same conversation: the paused run's transcript is restored and the person's
        # message (stored on this inbox) arrives as its next step.
        tool_call["goal"] = request.get("goal") or request["message"]
        tool_call["_resume_paused_conversation"] = {"inbox_address": inbox_address}
    else:
        tool_call["goal"] = build_background_wake_goal(
            message=str(request["message"]),
            base_goal=str(request.get("goal") or ""),
            previous_status=str(request.get("previous_status") or "completed"),
            previous_result=str(request.get("previous_result") or ""),
        )
    return tool_call


@workflow.defn
class BrowserAgentResumeWorkflow(ResumeBillingMixin):
    """One resumed run of a stopped browser agent, supervised outside its owner's workflow."""

    def __init__(self) -> None:
        self.is_paused = False
        self._user_pause_active = False
        self.agent_id = ""
        self.user_id = ""
        self.model = "rose-labs/rose-1-flash"
        self.fast_mode_cache_enabled = False
        self.world_model_mode = "real"
        self.context: List[Dict[str, Any]] = []
        self._interrupted_tool_calls: set = set()
        self._parked: Optional[Dict[str, Any]] = None
        self._resume: Optional[Dict[str, Any]] = None
        # Answers to the run's attention requests (sign-in, approvals), keyed by request id.
        self._signal_responses: Dict[str, Any] = {}
        self._pause_signal_sequence = 0

    @workflow.signal
    async def pause(self, data: Optional[Dict[str, Any]] = None) -> None:
        """The owner's pause (the user's control): stop this run through the spawn's pause path."""
        self.is_paused = True
        self._user_pause_active = True
        self._pause_signal_sequence += 1

    @workflow.signal
    async def resume(self) -> None:
        """The person resumed (the attention flow's resume, or the owner's resume control)."""
        self.is_paused = False
        self._user_pause_active = False

    @workflow.signal
    async def receive_user_response(self, response: str) -> None:
        """An answer to one of this run's attention requests ({request_id, response}, e.g. sign-in done)."""
        try:
            data = json.loads(response)
        except (ValueError, TypeError):
            return
        if isinstance(data, dict) and isinstance(data.get("request_id"), str):
            self._signal_responses[data["request_id"]] = data.get("response", "")

    async def _check_generation_handoff(self) -> Optional[str]:
        """The live generation queue when this run must move to it (else None)."""
        try:
            pointer = await workflow.execute_activity(
                fetch_agent_queue_pointer,
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as error:  # fail open like AgentWorkflow
            workflow.logger.warning(f"Generation pointer check failed (continuing): {error}")
            return None
        live_queue = (pointer or {}).get("task_queue")
        return live_queue if should_handoff_to_generation(workflow.info().task_queue, live_queue) else None

    def _park_pending_tool(self, tool_call_id: str, resume: Dict[str, Any]) -> bool:
        """Carry the parked browser task across the coming continue_as_new."""
        self._parked = dict(resume)
        return True

    def _take_tool_resume(self, tool_call_id: str) -> Optional[Dict[str, Any]]:
        resume, self._resume = self._resume, None
        return resume

    @workflow.run
    async def run(self, request: Dict[str, Any]) -> Dict[str, Any]:
        request = request or {}
        tool_call_id = str(request.get("tool_call_id") or "")
        # Known before validation so even a bad request can post its failure row.
        self.agent_id = str(request.get("agent_id") or "")
        self.user_id = str(request.get("user_id") or "")
        try:
            missing = [field for field in REQUIRED_FIELDS if not request.get(field)]
            if missing:
                raise ValueError(f"resume request is missing {', '.join(missing)}")
            self.model = request.get("model") or self.model
            self._init_billing(request)
            self.context = [
                {"filePointer": item} for item in request.get("attachments") or [] if isinstance(item, dict)
            ]
            if isinstance(request.get("signal_responses"), dict):
                self._signal_responses = dict(request["signal_responses"])
            self._pause_signal_sequence = int(request.get("pause_signal_sequence") or 0)
            if request.get("paused") is True:
                self.is_paused = True
                self._user_pause_active = True
            # An owner already at its cost limit stops the run before it spends.
            await self._check_owner_limit()
            parked = request.get("parked_tool_resume")
            self._resume = dict(parked) if isinstance(parked, dict) else None
            final = await self._run_spawn(request, tool_call_id)
        except GenerationHandoffRequested as handoff:
            workflow.continue_as_new(
                # A pause that arrived before the handoff still holds on the live queue.
                args=[
                    {
                        **request,
                        "parked_tool_resume": self._parked,
                        "paused": self.is_paused,
                        "signal_responses": dict(self._signal_responses),
                        "pause_signal_sequence": self._pause_signal_sequence,
                        # The run's billed spend: the live queue continues it (never re-bills or drops it).
                        "billing": self.billing_state(),
                    }
                ],
                task_queue=handoff.task_queue,
            )
        except Exception as error:
            reason = str(error) or type(error).__name__
            await self._post_failure(tool_call_id, reason)
            raise ApplicationError(f"browser agent resume failed: {reason}", non_retryable=True) from error
        return {"tool_call_id": tool_call_id, "message_id": request.get("message_id"), "result": final}

    async def _run_spawn(self, request: Dict[str, Any], tool_call_id: str) -> Optional[str]:
        final: Optional[str] = None
        async for event in get_manager().execute_tool(self, resume_browser_tool_call(request), tool_call_id):
            metadata = dict(getattr(event, "metadata", None) or {})
            metadata.setdefault("toolName", TOOL_NAME)
            metadata["excludeFromModel"] = True
            metadata["browserResume"] = "supervised"
            event.metadata = metadata
            final = getattr(event, "message", None) or final
            await handle_tool_event(
                event=event,
                agent_id=self.agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=workflow.execute_activity,
                user_id=self.user_id,
            )
            await self._bill_event(event, TOOL_NAME, "browser_agent")
        return final

    async def _post_failure(self, tool_call_id: str, reason: str) -> None:
        """The person's message reads "Couldn't resume: <reason>" (a UI-only ERROR row)."""
        if not self.agent_id or not tool_call_id:
            return
        try:
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Browser could not resume",
                    message=reason,
                    status=MessageStatus.ERROR,
                    metadata={"toolName": TOOL_NAME, "excludeFromModel": True, "browserResume": "failed"},
                ),
                agent_id=self.agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=workflow.execute_activity,
                user_id=self.user_id,
            )
        except Exception as error:  # the failure itself is raised by run()
            workflow.logger.warning(f"Could not record the failed browser resume: {error}")
