"""list_agents tool (explore agents only) — re-export shim.

The implementation lives in domains/agent_messaging/service.py; the explore
activity (domains/spawn_agent/service.py) imports it from here, like its other
tool managers, so domains never import each other.
"""

from domains.agent_messaging.service import explore_list_agents

__all__ = ["explore_list_agents"]
