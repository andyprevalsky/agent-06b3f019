"""Inspect-code domain types."""

from typing import Any, Awaitable, Callable, Dict

ExecuteActivityCallable = Callable[..., Awaitable[Any]]

TOOL_NAME = "inspect_code"

# Backend response (providers/codeSessions/inspect.ts CodeInspectionResult), or
# {"error": <message>, "code": <code>, "http_status": <status>} for a refusal.
InspectResult = Dict[str, Any]
