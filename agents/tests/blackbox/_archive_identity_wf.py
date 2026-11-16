"""Sandboxed workflow shaped like AgentWorkflow's archive identity.

AgentWorkflow sets `agent_id` / `root_agent_id` on its instance in
`_run_phases`; the archive-identity interceptor stamps both on every activity
it schedules. The probe schedules an activity with no agent argument (like
wait_for's evaluate_condition_activity), one with an explicit sub-agent id
(explore/browser) and a local activity.
"""

from datetime import timedelta
from typing import Any, Dict, List, Optional

from temporalio import workflow


@workflow.defn(name="ArchiveIdentityProbe")
class ArchiveIdentityProbe:
    def __init__(self) -> None:
        self.agent_id = ""
        self.root_agent_id: Optional[str] = None

    @workflow.run
    async def run(self, agent_id: str, root_agent_id: str) -> List[Dict[str, Any]]:
        self.agent_id = agent_id
        self.root_agent_id = root_agent_id
        timeout = timedelta(seconds=30)
        no_agent = await workflow.execute_activity(
            "archive_identity_no_agent_activity", "condition", start_to_close_timeout=timeout
        )
        sub_agent = await workflow.execute_activity(
            "archive_identity_sub_agent_activity", "explore-child", start_to_close_timeout=timeout
        )
        local = await workflow.execute_local_activity(
            "archive_identity_no_agent_activity", "local", start_to_close_timeout=timeout
        )
        return [no_agent, sub_agent, local]
