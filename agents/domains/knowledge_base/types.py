"""Type definitions for the knowledge-base domain."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict


class BlueprintSearchResult(TypedDict):
    """A single blueprint returned from the search endpoint."""

    id: str
    title: str
    blueprint: str


class SavedBlueprintResponse(TypedDict):
    """Response from the blueprint save endpoint."""

    id: str
    title: str
    created: bool


class SaveBlueprintResult(TypedDict):
    """Result of a save-blueprint operation, returned to the workflow."""

    saved_blueprint: SavedBlueprintResponse


class ToolCallMetadata(TypedDict, total=False):
    """Metadata attached to a message in the conversation context."""

    toolName: str
    toolStatus: str
    toolCallId: str
    data: Dict[str, Any]
    tool_calls: List[Dict[str, Any]]
    hidden: bool
    isCustomSystemPrompt: bool
    error: bool
    completionSummary: Dict[str, Any]
    title: str


class ContextMessage(TypedDict, total=False):
    """A single message from the agent conversation context."""

    role: str
    text: str
    metadata: Optional[ToolCallMetadata]
