"""Carry the acting agent and its tree root from workflows into activities.

Activities run in a fresh execution context: workflow structlog contextvars do
not cross the Temporal boundary, so before this interceptor every activity's
LLM record fell back to its own `agent_id` as the archive root (sub-agent,
explore and browser calls split into separate bundles) or, with no agent arg at
all (wait_for's evaluate_condition_activity), into `trace-archive/unbound/`.

```
  AgentWorkflow (root_agent_id, agent_id)
        │ start_activity / start_local_activity
        ▼ headers: rose-root-agent-id, rose-agent-id
  activity inbound ──► structlog contextvars root_agent_id, workflow_agent_id
        ▼
  dump_llm_context / archive writers ──► trace-archive/<root>/llm/...
```

Headers are not part of Temporal's command determinism check, so adding them
is replay-safe for in-flight workflows. `agent_id` itself stays owned by
`@traced` (explicit activity args win); the workflow's agent is only the
fallback actor for activities that carry no agent argument.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Type

import structlog
from temporalio import activity, workflow
from temporalio.api.common.v1 import Payload
from temporalio.worker import (
    ActivityInboundInterceptor,
    ExecuteActivityInput,
    Interceptor,
    StartActivityInput,
    StartLocalActivityInput,
    WorkflowInboundInterceptor,
    WorkflowInterceptorClassInput,
    WorkflowOutboundInterceptor,
)

ROOT_AGENT_HEADER = "rose-root-agent-id"
AGENT_HEADER = "rose-agent-id"


def _bound(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip() and value.strip().lower() not in {"unbound", "none", "null"}:
        return value
    return None


def workflow_archive_identity() -> tuple[Optional[str], Optional[str]]:
    """(agent_id, root_agent_id) of the running workflow instance, if known.

    The root is never guessed from the agent: a workflow that does not know
    its tree root (a resume request without `root_agent_id`) sends only the
    agent header, and the archive writer logs and counts the fallback.
    """
    instance = workflow.instance()
    agent = _bound(getattr(instance, "agent_id", None))
    root = _bound(getattr(instance, "root_agent_id", None)) or _bound(getattr(instance, "bus_id", None))
    return agent, root


def _with_identity_headers(headers: Mapping[str, Payload]) -> Mapping[str, Payload]:
    agent, root = workflow_archive_identity()
    if not agent and not root:
        return headers
    converter = workflow.payload_converter()
    stamped = dict(headers)
    if root:
        stamped[ROOT_AGENT_HEADER] = converter.to_payload(root)
    if agent:
        stamped[AGENT_HEADER] = converter.to_payload(agent)
    return stamped


class _IdentityOutbound(WorkflowOutboundInterceptor):
    def start_activity(self, input: StartActivityInput) -> workflow.ActivityHandle[Any]:
        input.headers = _with_identity_headers(input.headers)
        return super().start_activity(input)

    def start_local_activity(self, input: StartLocalActivityInput) -> workflow.ActivityHandle[Any]:
        input.headers = _with_identity_headers(input.headers)
        return super().start_local_activity(input)


class _IdentityWorkflowInbound(WorkflowInboundInterceptor):
    def init(self, outbound: WorkflowOutboundInterceptor) -> None:
        super().init(_IdentityOutbound(outbound))


def _header_value(headers: Mapping[str, Payload], key: str) -> Optional[str]:
    payload = headers.get(key)
    if payload is None:
        return None
    try:
        return _bound(activity.payload_converter().from_payload(payload, str))
    except Exception:
        return None


class _IdentityActivityInbound(ActivityInboundInterceptor):
    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        bindings = {}
        root = _header_value(input.headers, ROOT_AGENT_HEADER)
        agent = _header_value(input.headers, AGENT_HEADER)
        if root:
            bindings["root_agent_id"] = root
        if agent:
            bindings["workflow_agent_id"] = agent
        tokens = structlog.contextvars.bind_contextvars(**bindings) if bindings else {}
        try:
            return await self.next.execute_activity(input)
        finally:
            if tokens:
                structlog.contextvars.reset_contextvars(**tokens)


class ArchiveIdentityInterceptor(Interceptor):
    """Worker interceptor binding archive identity across the activity boundary."""

    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return _IdentityActivityInbound(next)

    def workflow_interceptor_class(
        self, input: WorkflowInterceptorClassInput
    ) -> Optional[Type[WorkflowInboundInterceptor]]:
        return _IdentityWorkflowInbound


def production_worker_interceptors() -> list[Interceptor]:
    """Interceptors every production worker (and its validation twin) installs."""
    from helpers.activity_dispatch import ActivityDispatchLagInterceptor

    return [ArchiveIdentityInterceptor(), ActivityDispatchLagInterceptor()]
