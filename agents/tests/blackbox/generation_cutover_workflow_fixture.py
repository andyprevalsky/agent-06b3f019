"""Temporal fixture workflow for in-tool cooperative cutover e2e.

Drives the REAL production park helpers (wait_seconds, approval, gate, signup)
inside a Temporal workflow. A live AgentQueuePointer flip must
``continue_as_new`` onto the new queue with a DEPLOY_INTERRUPTED FINISHED chip
and must not fail the workflow.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from domains.gate.service import build_subscription_gate, raise_gate_direct
    from domains.request_user_approval.service import request_user_approval_direct
    from domains.request_user_signup.handler import request_user_signup
    from domains.wait_seconds.handler import wait_seconds
    from helpers.generation_handoff import GenerationHandoffRequested, should_handoff_to_generation
    from helpers.wait_condition_or_handoff import GENERATION_HANDOFF_SIGNAL, note_generation_handoff


def _event_payload(event: Any, tool_call_id: str, tool_name: str) -> dict[str, str]:
    status = getattr(event, "status", None)
    status_value = str(getattr(status, "value", status) or "")
    return {
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "status": status_value,
        "message": str(getattr(event, "message", "") or ""),
        "title": str(getattr(event, "title", "") or ""),
    }


@workflow.defn
class InToolCutoverWorkflow:
    def __init__(self) -> None:
        self.agent_id = "cutover-agent"
        self.user_id = "cutover-user"
        self.context: list[dict[str, Any]] = []
        self._signal_responses: dict[str, str] = {}
        self._has_new_messages = False
        self._signup_completed = False
        self._signup_dismissed = False
        self.is_paused = False
        self.world_model_mode = "real"
        self.events: list[dict[str, str]] = []
        self._generation_handoff_hint: str | None = None
        self._generation_handoff_hint_seq = 0

    @workflow.signal(name=GENERATION_HANDOFF_SIGNAL)
    def generation_handoff_available(self, task_queue: str) -> None:
        """Same contract as AgentWorkflow.generation_handoff_available."""
        note_generation_handoff(self, task_queue)

    @workflow.query
    def tool_event_count(self) -> int:
        return len(self.events)

    async def _check_generation_handoff(self) -> str | None:
        """Same contract as AgentWorkflow._check_generation_handoff."""
        try:
            pointer = await workflow.execute_activity(
                "fetch_agent_queue_pointer",
                start_to_close_timeout=timedelta(seconds=15),
            )
        except Exception:
            return None
        live_queue = (pointer or {}).get("task_queue")
        current_queue = workflow.info().task_queue
        if should_handoff_to_generation(current_queue, live_queue):
            return str(live_queue).strip()
        return None

    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        self.events.append(_event_payload(event, tool_call_id, tool_name))

    async def _run_park(self, spec: dict[str, Any]) -> None:
        park = spec.get("park")
        if park == "wait_seconds":
            await wait_seconds(self, {"seconds": int(spec.get("seconds", 90))}, "tc-wait")
            return
        if park == "approval":
            await request_user_approval_direct(self, str(spec.get("question") or "Approve?"))
            return
        if park == "gate":
            await raise_gate_direct(self, build_subscription_gate(), "subscription")
            return
        if park == "signup":
            await request_user_signup(self, {"reason": "Need signup"}, "tc-signup")
            return
        raise RuntimeError(f"unknown park {park!r}")

    @workflow.run
    async def run(self, spec: dict[str, Any]) -> dict[str, Any]:
        self.agent_id = str(spec.get("agent_id") or self.agent_id)
        self.user_id = str(spec.get("user_id") or self.user_id)
        if spec.get("already_handed_off"):
            return {
                "handed_off": True,
                "failed": False,
                "park": spec.get("park"),
                "events": list(spec.get("events") or []),
                "handoff_after_seconds": spec.get("handoff_after_seconds"),
            }

        started = workflow.time()
        try:
            await self._run_park(spec)
        except GenerationHandoffRequested as exc:
            workflow.continue_as_new(
                args=[
                    {
                        **spec,
                        "already_handed_off": True,
                        "events": list(self.events),
                        "handoff_after_seconds": workflow.time() - started,
                    }
                ],
                task_queue=exc.task_queue,
            )
        return {
            "handed_off": False,
            "failed": False,
            "park": spec.get("park"),
            "events": list(self.events),
        }
