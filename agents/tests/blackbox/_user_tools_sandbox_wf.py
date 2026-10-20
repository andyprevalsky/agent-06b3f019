"""Sandboxed workflow that pins user tools exactly like AgentWorkflow does.

AgentWorkflow imports domains.user_tools.handler inside imports_passed_through(),
so the TypedDicts in domains.user_tools.types are passthrough classes. Temporal's
converter resolves their annotations with get_type_hints() against the sandbox's
sys.modules; this workflow reproduces that exact import shape.
"""

from datetime import timedelta
from types import SimpleNamespace

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from domains.user_tools.handler import declared_user_tools, pin_user_tools


@workflow.defn(name="UserToolsPinRepro")
class UserToolsPinRepro:
    @workflow.run
    async def run(self, agent_id: str, user_id: str) -> int:
        state = SimpleNamespace(agent_id=agent_id, user_id=user_id, user_tools={}, user_tools_pinned=False)
        await pin_user_tools(state, is_root=True, wf_api=workflow)
        return len(declared_user_tools(state))
