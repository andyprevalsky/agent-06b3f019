"""Backward-compatibility shim - delegates to domains/reasoning/."""

from domains.reasoning.handler import (  # noqa: F401
    ReasoningResponse,
    _safe_heartbeat,
    execute_reasoning_activity,
)

__all__ = ["ReasoningResponse", "_safe_heartbeat", "execute_reasoning_activity"]
