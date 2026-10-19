"""Minimal workflow that drives the real agent-to-agent tool handlers
(send_message_to_agent, kill_agent).

Used by background_agents.blackbox.py to run the agent-messaging tool path
through a real Temporal worker and the production workflow sandbox, so
activity argument/result decoding (type hints of the real activity
functions) is exercised exactly as in AgentWorkflow.
"""

from typing import Any, Dict, List, Optional

from temporalio import workflow

# Imported exactly as workflows/agent_workflow.py imports them (pass-through).
with workflow.unsafe.imports_passed_through():
    from domains.agent_messaging.handler import kill_agent, send_message_to_agent
    from tools.base import MessageStatus


@workflow.defn(name="AgentMessagingSandboxProbe")
class AgentMessagingSandboxProbe:
    def __init__(self) -> None:
        self.agent_id = ""
        self.user_id: Optional[str] = None
        self.parent_agent_id: Optional[str] = None
        self.depth = 1
        self.events: List[Dict[str, Any]] = []

    def _background_task_for_address(self, address: str) -> Optional[Dict[str, Any]]:
        return None

    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        self.events.append({"tool": tool_name, "status": event.status.value, "message": event.message})

    @workflow.run
    async def run(self, agent_id: str, parent_agent_id: str, calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        self.agent_id = agent_id
        self.user_id = "user-1"
        self.parent_agent_id = parent_agent_id
        results = []
        for index, call in enumerate(calls):
            handler = {
                "send_message_to_agent": send_message_to_agent,
                "kill_agent": kill_agent,
            }[call["tool"]]
            status, text = await handler(self, call, f"call-{index}")
            results.append({"status": status.value if isinstance(status, MessageStatus) else status, "text": text})
        return results
