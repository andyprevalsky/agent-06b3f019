"""Re-export shim -- real implementation lives in domains/knowledge_base/.

Kept for backward compatibility with existing imports (worker.py, tests, workflows).
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
from domains.knowledge_base.service import build_trajectory_blueprint as _build_trajectory_blueprint

__all__ = [
    "QueryBlueprintsManager",
    "SaveBlueprintManager",
    "_build_trajectory_blueprint",
    "get_query_manager",
    "get_save_manager",
    "query_blueprints",
    "query_blueprints_activity",
    "save_blueprint",
    "save_blueprint_activity",
]
