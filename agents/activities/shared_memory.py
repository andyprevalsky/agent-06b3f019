"""Backward-compatibility shim -- re-exports from domains.shared_memory.handler."""

from domains.shared_memory.handler import append_shared_memory, get_shared_memory

__all__ = ["get_shared_memory", "append_shared_memory"]
