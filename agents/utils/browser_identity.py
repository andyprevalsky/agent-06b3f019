"""Stable browser ownership identity, independent of workflow activity attempts."""

import uuid


def logical_browser_task_id(agent_id: str) -> str:
    """One browser identity per GP; activity/tool IDs remain separate."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"rose-browser-owner:{agent_id}"))
