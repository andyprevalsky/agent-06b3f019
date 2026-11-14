"""Resume a stopped code agent when the person types to it and its owner cannot.

The owner's own workflow resumes a stopped BACKGROUND code task when it runs
(``receive_agent_message`` from_user). When it cannot (the Rose agent finished
or is paused, or the code agent ran as a foreground spawn with no wake record),
the backend starts this workflow (back-end/src/providers/codeAgentResumeWorkflow.ts):

    request {agent, user, model, spawn tool call, task name, code session,
             provider, message, attachments, cli_settings}
      └─▶ SpawnClaudeCodeAgentManager.execute_tool (the spawn's own path) on the
          stopped session's code_session_id: the persistent session's sandbox
          resumes and the CLI continues its conversation (--resume) with the
          message as its next turn; rows land on the owner under the same tool
          call id, so the code-agent view folds this run into the conversation.

STATE MACHINE (this workflow is the spawn's ``workflow_instance``):
    [RUNNING] ── signal pause (the owner's pause, backend pauseAgent) ──▶
        tool_stop_requested → the spawn's own pause path closes the activity
        ("Code session paused" row) ──▶ [DONE]
    [RUNNING] ── a deploy drains the code activity and the live generation moved ──▶
        _park_pending_tool keeps the drained session ──▶ continue_as_new onto the
        live queue; the next run reattaches it (take_tool_resume) ──▶ [RUNNING]
    [RUNNING] ── any failure (bad request, a fenced write, an activity error) ──▶
        UI-only "Code agent could not resume" ERROR row ──▶ non-retryable failure

Its activities write under the generation ``code-resume:<agent>:<turn row>``,
which the backend attributes to the owner's live generation (codeResumeGeneration.ts).
Rows are UI-only (``excludeFromModel``): nothing enters the owner's planner context.
"""

from __future__ import annotations

import copy
import json
from datetime import timedelta
from typing import Any, Dict, List, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from domains.spawn_claude_code_agent.handler import get_manager
    from helpers.code_agent_resume_context import fetch_code_agent_resume_context
    from helpers.fetch_queue_pointer import fetch_agent_queue_pointer
    from helpers.generation_handoff import GenerationHandoffRequested, should_handoff_to_generation
    from helpers.handle_tool_event import handle_tool_event
    from tools.base import EventType, MessageStatus, ToolEvent
    from utils.error_utils import extract_error_message
    from workflows.resume_billing import ResumeBillingMixin

TOOL_NAME = "spawn_claude_code_agent"
REQUIRED_FIELDS = ("agent_id", "user_id", "tool_call_id", "message")


def resume_tool_call(request: Dict[str, Any], saved: Dict[str, Any]) -> Dict[str, Any]:
    """The code spawn's arguments for the resumed run (the message is its next turn)."""
    original = saved.get("spawn_args")
    if not isinstance(original, dict) or not isinstance(original.get("output_schema"), dict) or not original["output_schema"]:
        raise ValueError("The original code-task output_schema is unavailable; refusing to replace it with a default.")
    tool_call = copy.deepcopy(original)
    execution = saved.get("execution")
    if isinstance(execution, dict):
        for key in ("github_repo_link", "target", "code_session_id"):
            if key in execution:
                tool_call[key] = execution[key]
    # Like the owner's background wake, only the next conversation input changes.
    tool_call["goal"] = request["message"]
    if not tool_call.get("task_name") and request.get("task_name"):
        tool_call["task_name"] = request["task_name"]
    if request.get("code_session_id"):
        tool_call["code_session_id"] = request["code_session_id"]
    provider = saved.get("code_provider") or request.get("code_provider")
    if provider in ("claude", "codex"):
        tool_call["_resume_code_provider"] = provider
    settings = dict(saved.get("cli_settings") or {})
    settings.update(request.get("cli_settings") or {})
    if not all(settings.get(key) for key in ("model", "reasoning_effort", "speed")):
        raise ValueError(
            "This historical code task has no complete saved CLI settings. Choose model, effort and speed "
            "to continue; Rose will not guess different resume settings."
        )
    tool_call["_resume_cli_settings"] = settings
    tool_call["_resume_attachments"] = copy.deepcopy(saved.get("attachments") or [])
    tool_call["_user_attachments"] = copy.deepcopy(request.get("attachments") or [])
    return tool_call


@workflow.defn
class CodeAgentResumeWorkflow(ResumeBillingMixin):
    """One resumed run of a stopped code agent, supervised outside its owner's workflow."""

    def __init__(self) -> None:
        self.is_paused = False
        self._user_pause_active = False
        self.agent_id = ""
        # Tree root for archive records (helpers/archive_identity.py headers).
        self.root_agent_id = ""
        self.user_id = ""
        self.model = "rose-labs/rose-1-flash"
        self.fast_mode_cache_enabled = False
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

    # ── the spawn's workflow-instance hooks ─────────────────────────────────

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
        """Carry the drained code session across the coming continue_as_new."""
        self._parked = dict(resume)
        return True

    def _take_tool_resume(self, tool_call_id: str) -> Optional[Dict[str, Any]]:
        resume, self._resume = self._resume, None
        return resume

    # ── run ─────────────────────────────────────────────────────────────────

    @workflow.run
    async def run(self, request: Dict[str, Any]) -> Dict[str, Any]:
        request = request or {}
        tool_call_id = str(request.get("tool_call_id") or "")
        # Known before validation so even a bad request can post its failure row.
        self.agent_id = str(request.get("agent_id") or "")
        self.root_agent_id = str(request.get("root_agent_id") or "")
        self.user_id = str(request.get("user_id") or "")
        try:
            missing = [field for field in REQUIRED_FIELDS if not request.get(field)]
            if missing:
                raise ValueError(f"resume request is missing {', '.join(missing)}")
            self.model = request.get("model") or self.model
            # The person's turn attachments, resolved like a parent's context files.
            self.context = [
                {"filePointer": item} for item in request.get("attachments") or [] if isinstance(item, dict)
            ]
            self._init_billing(request)
            if isinstance(request.get("signal_responses"), dict):
                self._signal_responses = dict(request["signal_responses"])
            self._pause_signal_sequence = int(request.get("pause_signal_sequence") or 0)
            if request.get("paused") is True:
                self.is_paused = True
            # An owner already at its cost limit stops the run before it spends.
            await self._check_owner_limit()
            parked = request.get("parked_tool_resume")
            self._resume = dict(parked) if isinstance(parked, dict) else None
            final = await self._run_spawn(request, tool_call_id)
        except GenerationHandoffRequested as handoff:
            # Mirror AgentWorkflow: the drained session continues on the live generation.
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
            reason = extract_error_message(error) or type(error).__name__
            await self._post_failure(tool_call_id, reason)
            raise ApplicationError(f"code agent resume failed: {reason}", non_retryable=True) from error
        return {"tool_call_id": tool_call_id, "message_id": request.get("message_id"), "result": final}

    async def _run_spawn(self, request: Dict[str, Any], tool_call_id: str) -> Optional[str]:
        final: Optional[str] = None
        saved = await workflow.execute_activity(
            fetch_code_agent_resume_context,
            args=[self.agent_id, tool_call_id],
            start_to_close_timeout=timedelta(seconds=40),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        self.model = saved.get("model") or self.model
        if isinstance(saved.get("fast_mode_cache_enabled"), bool):
            self.fast_mode_cache_enabled = saved["fast_mode_cache_enabled"]
        async for event in get_manager().execute_tool(self, resume_tool_call(request, saved), tool_call_id):
            metadata = dict(getattr(event, "metadata", None) or {})
            metadata.setdefault("toolName", TOOL_NAME)
            metadata["excludeFromModel"] = True
            metadata["codeAgentResume"] = "supervised"
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
            await self._bill_event(event, TOOL_NAME, "code_agent")
        return final

    async def _post_failure(self, tool_call_id: str, reason: str) -> None:
        """The person's turn reads "Couldn't resume: <reason>" (a UI-only ERROR row)."""
        if not self.agent_id or not tool_call_id:
            return
        try:
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Code agent could not resume",
                    message=reason,
                    status=MessageStatus.ERROR,
                    metadata={"toolName": TOOL_NAME, "excludeFromModel": True, "codeAgentResume": "failed"},
                ),
                agent_id=self.agent_id,
                tool_call_id=tool_call_id,
                tool_name=TOOL_NAME,
                execute_activity=workflow.execute_activity,
                user_id=self.user_id,
            )
        except Exception as error:  # the failure itself is raised by run()
            workflow.logger.warning(f"Could not record the failed code agent resume: {error}")
