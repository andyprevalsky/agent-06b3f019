"""Sandboxed workflows that pin and run user tools exactly like AgentWorkflow does.

AgentWorkflow imports domains.user_tools.handler inside imports_passed_through(),
so the TypedDicts in domains.user_tools.types are passthrough classes. Temporal's
converter resolves their annotations with get_type_hints() against the sandbox's
sys.modules; these workflows reproduce that exact import shape.
"""

from types import SimpleNamespace
from typing import Any, Dict, List

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from domains.user_tools.handler import declared_user_tools, pin_user_tools, run_user_tool


@workflow.defn(name="UserToolsPinRepro")
class UserToolsPinRepro:
    @workflow.run
    async def run(self, agent_id: str, user_id: str) -> int:
        state = SimpleNamespace(agent_id=agent_id, user_id=user_id, user_tools={}, user_tools_pinned=False)
        await pin_user_tools(state, is_root=True, wf_api=workflow)
        return len(declared_user_tools(state))


@workflow.defn(name="UserToolsRunRepro")
class UserToolsRunRepro:
    """Pin, then run one user tool call through the real handler and activity retry policy."""

    @workflow.run
    async def run(
        self, agent_id: str, user_id: str, tool_name: str, tool_input: Dict[str, Any], call_id: str
    ) -> Dict[str, Any]:
        statuses: List[str] = []

        async def _handle_tool_event(event: Any, _tool_call_id: str, _tool_name: str) -> None:
            statuses.append(event.status.value if event.status else "")

        state = SimpleNamespace(
            agent_id=agent_id,
            user_id=user_id,
            user_tools={},
            user_tools_pinned=False,
            _handle_tool_event=_handle_tool_event,
        )
        await pin_user_tools(state, is_root=True, wf_api=workflow)
        result = await run_user_tool(state, tool_name, tool_input, call_id, wf_api=workflow)
        return {"result": result, "statuses": statuses, "workflow_id": workflow.info().workflow_id}
