"""Context Pointers — prevent information degradation across agent tree.

Pointer format: @ref:message:<message_id>
With optional slice: @ref:message:<message_id>[start="prefix"|end="suffix"]

References Message records with role=USER or role=TOOL.
Resolved to <resolved-ref> XML blocks at every LLM call boundary.
"""

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
import structlog

from config import load_config

logger = structlog.get_logger()

# Regex for @ref:message:<uuid> with optional [start="..."|end="..."] slice
POINTER_PATTERN = re.compile(
    r"@ref:message:([a-f0-9-]{36})"
    r'(?:\[start="([^"]+)"\|end="([^"]+)"\])?'
)

# In-process cache: message_id -> (text, role). Messages are immutable, no TTL needed.
_message_cache: Dict[str, Optional[tuple]] = {}


@dataclass
class Pointer:
    id: str
    start: Optional[str]
    end: Optional[str]
    raw: str  # Original matched string


def parse_pointers(text: str) -> List[Pointer]:
    """Extract all @ref:message: pointers from text."""
    pointers = []
    for match in POINTER_PATTERN.finditer(text):
        pointers.append(
            Pointer(
                id=match.group(1),
                start=match.group(2),
                end=match.group(3),
                raw=match.group(0),
            )
        )
    return pointers


def annotate_with_pointer(msg: Dict[str, Any]) -> None:
    """Append Reference: @ref:message:<id> to a message's text. Mutates in-place.

    Only annotates USER messages and TOOL messages with toolStatus=FINISHED.
    Idempotent — checks if annotation already exists.
    """
    message_id = msg.get("message_id")
    if not message_id:
        return

    text = msg.get("text", "")
    if not text:
        return

    # Already annotated?
    if f"@ref:message:{message_id}" in text:
        return

    role = msg.get("role", "")
    metadata = msg.get("metadata") or {}

    if role == "USER" or role == "TOOL" and metadata.get("toolStatus") == "FINISHED":
        msg["text"] = f"{text}\n\nReference: @ref:message:{message_id}"


def _apply_slice(text: str, start: Optional[str], end: Optional[str]) -> str:
    """Extract substring using prefix/suffix text anchors.

    Finds start anchor in text, finds end anchor at or after it,
    extracts from beginning of start through end of end.
    Falls back to full text if either anchor not found.
    """
    if not start or not end:
        return text

    start_idx = text.find(start)
    if start_idx == -1:
        return text

    end_idx = text.find(end, start_idx)
    if end_idx == -1:
        return text

    return text[start_idx : end_idx + len(end)]


def _is_inside_resolved_ref_tag(text: str, index: int) -> bool:
    """Return True when index is inside an existing <resolved-ref ...> tag."""
    tag_start = text.rfind("<resolved-ref", 0, index)
    if tag_start == -1:
        return False
    last_close = text.rfind(">", 0, index)
    return last_close < tag_start


async def _fetch_messages_batch(
    message_ids: List[str],
    user_id: Optional[str] = None,
) -> Dict[str, Optional[tuple]]:
    """Fetch messages by IDs from backend, returns {id: (text, role) or None}.

    Chunks requests into batches of 50 (backend limit).
    Does NOT negative-cache on transient errors — only on confirmed 200 with missing IDs.
    """
    BATCH_SIZE = 50
    # Filter out already-cached IDs
    uncached = [mid for mid in message_ids if mid not in _message_cache]

    if uncached:
        config = load_config()
        # Chunk into batches of BATCH_SIZE
        for i in range(0, len(uncached), BATCH_SIZE):
            chunk = uncached[i : i + BATCH_SIZE]
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    headers = {
                        "X-API-Key": config.backend.api_key or "",
                        "Content-Type": "application/json",
                    }
                    body: Dict[str, Any] = {"ids": chunk}
                    if user_id:
                        headers["X-User-Id"] = user_id
                        body["user_id"] = user_id

                    response = await client.post(
                        f"{config.backend.api_url}/api/agents/messages/batch",
                        headers=headers,
                        json=body,
                    )
                    if response.status_code == 200:
                        data = response.json()
                        for msg in data.get("messages", []):
                            _message_cache[msg["id"]] = (msg["text"], msg["role"])
                        # Only negative-cache IDs confirmed missing (200 response)
                        fetched_ids = {msg["id"] for msg in data.get("messages", [])}
                        for mid in chunk:
                            if mid not in fetched_ids:
                                _message_cache[mid] = None
                    else:
                        logger.warning("Batch message fetch failed", status=response.status_code)
                        # Do NOT negative-cache on non-200 — transient error
            except Exception as e:
                logger.warning("Batch message fetch error", error=str(e))
                # Do NOT negative-cache on exception — transient error

    return {mid: _message_cache.get(mid) for mid in message_ids}


def _resolve_from_local_context(message_id: str, local_context: Optional[List[Dict]]) -> Optional[str]:
    """Try to resolve a message from local context by message_id."""
    if not local_context:
        return None
    for msg in local_context:
        if msg.get("message_id") == message_id:
            role = msg.get("role", "")
            if role in ("USER", "TOOL"):
                return msg.get("text", "")
    return None


async def resolve_pointers_in_text(
    text: str,
    local_context: Optional[List[Dict]] = None,
    user_id: Optional[str] = None,
) -> str:
    """Resolve all @ref:message: pointers in text to <resolved-ref> blocks.

    Resolution order: local_context first, then DB batch fetch.
    Unresolvable pointers are left in place.
    """
    pointers = parse_pointers(text)
    if not pointers:
        return text

    # Collect IDs that need DB fetch
    resolutions: Dict[str, Optional[str]] = {}
    ids_to_fetch = []

    for p in pointers:
        local_text = _resolve_from_local_context(p.id, local_context)
        if local_text is not None:
            resolutions[p.id] = local_text
        else:
            ids_to_fetch.append(p.id)

    # Batch fetch from DB
    if ids_to_fetch:
        fetched = await _fetch_messages_batch(ids_to_fetch, user_id=user_id)
        for mid, result in fetched.items():
            if result is not None:
                msg_text, msg_role = result
                if msg_role in ("USER", "TOOL"):
                    resolutions[mid] = msg_text

    # Replace pointers with resolved-ref blocks using index-based replacement
    # (avoids corrupting already-resolved text when same pointer appears multiple times)
    result_parts = []
    last_end = 0

    for match in POINTER_PATTERN.finditer(text):
        if _is_inside_resolved_ref_tag(text, match.start()):
            continue

        p_id = match.group(1)
        p_start = match.group(2)
        p_end = match.group(3)

        # `annotate_with_pointer()` appends this suffix to messages so future
        # turns can reference the exact row. Do not expand that suffix inside
        # the same message, or the LLM sees `message + resolved copy of message`.
        annotation_match = re.search(r"(?:^|\n\n)Reference:\s*$", text[: match.start()])
        if annotation_match and not text[match.end() :].strip():
            result_parts.append(text[last_end : match.start()])
            result_parts.append(f'<resolved-ref pointer="{match.group(0)}"/>')
            last_end = match.end()
            continue

        raw_text = resolutions.get(p_id)
        if raw_text is None:
            continue  # Leave unresolvable pointer in place

        # Strip any existing pointer annotation from the resolved text
        ref_suffix = f"\n\nReference: @ref:message:{p_id}"
        if raw_text.endswith(ref_suffix):
            raw_text = raw_text[: -len(ref_suffix)]

        resolved_content = _apply_slice(raw_text, p_start, p_end)
        resolved_block = f'<resolved-ref pointer="{match.group(0)}">{resolved_content}</resolved-ref>'

        result_parts.append(text[last_end : match.start()])
        result_parts.append(resolved_block)
        last_end = match.end()

    if not result_parts:
        return text

    result_parts.append(text[last_end:])
    return "".join(result_parts)


async def resolve_pointers_in_messages(
    messages: List[Dict[str, Any]],
    local_context: Optional[List[Dict]] = None,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Resolve pointers in a list of OpenAI-format messages.

    Handles both string content and list-of-blocks content format.
    Returns a new list (shallow copy of messages with resolved content).
    """
    resolved = []
    for msg in messages:
        content = msg.get("content")
        if content is None:
            resolved.append(msg)
            continue

        if isinstance(content, str):
            new_content = await resolve_pointers_in_text(
                content,
                local_context,
                user_id=user_id,
            )
            if new_content != content:
                # Keep a str-subclass marker (InterAgentText / UncachedContextText).
                if type(content) is not str:
                    new_content = type(content)(new_content)
                resolved.append({**msg, "content": new_content})
            else:
                resolved.append(msg)
        elif isinstance(content, list):
            new_blocks = []
            changed = False
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    new_text = await resolve_pointers_in_text(
                        block.get("text", ""),
                        local_context,
                        user_id=user_id,
                    )
                    if new_text != block.get("text", ""):
                        new_blocks.append({**block, "text": new_text})
                        changed = True
                    else:
                        new_blocks.append(block)
                else:
                    new_blocks.append(block)
            resolved.append({**msg, "content": new_blocks} if changed else msg)
        else:
            resolved.append(msg)

    return resolved
