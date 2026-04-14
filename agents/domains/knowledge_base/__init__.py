"""Knowledge-base domain — blueprint querying and saving.

Public API: import from this package for workflow integration.
"""

from domains.knowledge_base.handler import (
    QueryBlueprintsManager,
    SaveBlueprintManager,
    get_query_manager,
    get_save_manager,
    query_blueprints,
    query_blueprints_activity,
    save_blueprint,
    save_blueprint_activity,
)
from domains.knowledge_base.service import build_trajectory_blueprint

__all__ = [
    "QueryBlueprintsManager",
    "SaveBlueprintManager",
    "build_trajectory_blueprint",
    "get_query_manager",
    "get_save_manager",
    "query_blueprints",
    "query_blueprints_activity",
    "save_blueprint",
    "save_blueprint_activity",
]
