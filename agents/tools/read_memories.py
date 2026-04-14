"""Backward-compatible re-export -- domain logic lives in domains/read_memories/."""

from domains.read_memories.handler import (  # noqa: F401
    ReadMemoriesManager,
    get_manager,
    read_memories,
    read_memories_activity,
)
