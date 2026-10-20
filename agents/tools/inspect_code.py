"""inspect_code tool - re-exports from domains/inspect_code/.

Lets other domains (the explore agent in domains/spawn_agent) use the tool
without a cross-domain import.
"""

from domains.inspect_code.handler import InspectCodeManager, get_manager
from domains.inspect_code.repo import inspect_code_activity

__all__ = ["InspectCodeManager", "get_manager", "inspect_code_activity"]
