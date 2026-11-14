"""Utilities for durable model-context compaction checkpoints."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional

CONTEXT_COMPACTION_KEY = "contextCompaction"


def _metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    metadata = message.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def is_context_compaction_checkpoint(message: Dict[str, Any]) -> bool:
    """Return True when a DB message carries a durable context checkpoint."""
    metadata = _metadata(message)
    checkpoint = metadata.get(CONTEXT_COMPACTION_KEY)
    return isinstance(checkpoint, dict) and isinstance(checkpoint.get("compressedContext"), list)


def is_excluded_from_model(message: Dict[str, Any]) -> bool:
    """Return True for context rows used for cursoring/UI but hidden from LLMs.

    Includes every row a background spawn's executor posts under its spawn's
    tool-call id (helpers.background_agents.background_execution_metadata).
    """
    metadata = _metadata(message)
    if (str(message.get("role", "")).upper() == "TOOL"
            and metadata.get("toolName") in {"screenshot", "historical_screenshot", "final_screenshot"}
            and isinstance(metadata.get("screenshot_b64"), str) and metadata["screenshot_b64"]):
        # Old screenshot exports carried a blanket model exclusion. Their
        # original tool-result pixels are now ordinary conversation content.
        return False
    return bool(metadata.get("excludeFromModel"))


def build_context_compaction_metadata(compressed_context: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build metadata for the visible context_reset row.

    The DB message itself is the durable checkpoint. `compressedContext` is the
    model-visible replacement for all raw rows before the checkpoint.
    """
    return {
        "version": 1,
        "compressedContext": deepcopy(compressed_context),
        "compressedMessageCount": len(compressed_context),
    }


def _checkpoint_boundary_marker(checkpoint_message: Dict[str, Any]) -> Dict[str, Any]:
    """Create a cursor-only marker so polling advances past the checkpoint row."""
    metadata = _metadata(checkpoint_message)
    return {
        "message_id": checkpoint_message.get("message_id"),
        "role": "SYSTEM",
        "text": "",
        "timestamp": checkpoint_message.get("timestamp"),
        "metadata": {
            "toolName": metadata.get("toolName", "context_reset"),
            "contextCompactionBoundary": True,
            "excludeFromModel": True,
        },
    }


def latest_context_compaction_checkpoint(messages: List[Dict[str, Any]]) -> Optional[int]:
    """Return the index of the latest checkpoint row in chronological messages."""
    for index in range(len(messages) - 1, -1, -1):
        if is_context_compaction_checkpoint(messages[index]):
            return index
    return None


def project_model_context_after_compaction(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Project raw DB history into the model-visible context after compaction.

    Raw history remains in the DB/API for UI and audit. The model sees the latest
    compressed context, a hidden boundary marker for cursor advancement, and any
    messages that occurred after that checkpoint.
    """
    checkpoint_index = latest_context_compaction_checkpoint(messages)
    if checkpoint_index is None:
        return messages

    checkpoint_message = messages[checkpoint_index]
    checkpoint = _metadata(checkpoint_message).get(CONTEXT_COMPACTION_KEY) or {}
    compressed_context = checkpoint.get("compressedContext")
    if not isinstance(compressed_context, list):
        return messages

    projected = deepcopy(compressed_context)
    projected.append(_checkpoint_boundary_marker(checkpoint_message))
    projected.extend(deepcopy(messages[checkpoint_index + 1 :]))
    return projected
