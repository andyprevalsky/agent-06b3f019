"""Sandboxed workflow that runs the display tool exactly like AgentWorkflow does.

AgentWorkflow imports the tool handlers inside imports_passed_through(), so the
display payload TypedDicts are passthrough classes decoded with get_type_hints()
against the sandbox's sys.modules. The pinned path parks on
receive_user_response like an approval; this workflow reproduces both.
"""

import json
from typing import Any, Dict, List

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from domains.display.handler import get_manager


@workflow.defn(name="DisplayPinnedRepro")
class DisplayPinnedRepro:
    def __init__(self) -> None:
        self._signal_responses: Dict[str, str] = {}
        self.events: List[Dict[str, Any]] = []
        self.agent_id = ""
        self.user_id = ""

    @workflow.signal
    async def receive_user_response(self, response: str) -> None:
        data = json.loads(response)
        self._signal_responses[data["request_id"]] = data["response"]

    @workflow.query
    def statuses(self) -> List[str]:
        return [str(event["status"]) for event in self.events]

    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        self.events.append(
            {
                "status": event.status.value if event.status else None,
                "title": event.title,
                "message": event.message,
                "metadata": dict(event.metadata or {}),
            }
        )

    @workflow.run
    async def run(self, agent_id: str, user_id: str, tool_call: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.agent_id = agent_id
        self.user_id = user_id
        async for event in get_manager().execute_tool(self, tool_call, "call-pinned-1"):
            await self._handle_tool_event(event, "call-pinned-1", "display")
        return self.events
