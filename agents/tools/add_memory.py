"""Backward-compatibility shim -- re-exports from domains.add_memory.

All business logic lives in domains/add_memory/.  This file exists solely
so that existing import paths (``from tools.add_memory import ...``) keep
working, including blackbox tests.
"""

from domains.add_memory.handler import AddMemoryManager, add_memory, get_manager  # noqa: F401
from domains.add_memory.service import add_memory_activity  # noqa: F401
