"""Enrich tool - re-export shim.

All logic lives in domains/enrich/. This module re-exports public symbols
so that existing imports (tests, worker.py) continue to work.
"""

from domains.enrich.handler import EnrichManager, enrich, get_manager
from domains.enrich.repo import (
    enrich_create_task_activity,
    enrich_get_task_results_activity,
    enrich_poll_status_once_activity,
)

__all__ = [
    "EnrichManager",
    "enrich",
    "enrich_create_task_activity",
    "enrich_get_task_results_activity",
    "enrich_poll_status_once_activity",
    "get_manager",
]
