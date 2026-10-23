"""Lossless, encrypted browser resume snapshots outside Temporal's payload limit."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any, Dict

import structlog

from helpers.trace_archive import (
    decrypt_and_validate_artifact,
    encrypt_artifact,
    read_archive_artifact,
    store_encrypted_artifact,
)

logger = structlog.get_logger()

_INLINE_LIMIT_BYTES = 1_000_000
# Pause results ride through workflow history and, when a deploy lands while
# the browser task is parked, through continue_as_new arguments that share the
# 2MB payload cap with the conversation. Snapshots above this size go to the
# archive when it is reachable so the parked task stays small enough to carry.
_PREFERRED_INLINE_BYTES = 64_000
_PART_BYTES = 4_000_000
_MAX_PARTS = 128


class BrowserResumeStoreError(RuntimeError):
    """A browser pause cannot continue without its exact prior context."""


def _encoded_snapshot(state: Dict[str, Any]) -> bytes:
    try:
        return json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise BrowserResumeStoreError("Browser resume context is not JSON serializable") from exc


def _store_part(agent_id: str, path: str, body: bytes) -> None:
    encrypted = encrypt_artifact(body, path=path, content_type="application/json", compress=True)
    if encrypted is None:
        raise BrowserResumeStoreError("Browser resume encryption key is unavailable")
    ciphertext, metadata = encrypted
    if not store_encrypted_artifact(root_agent_id=agent_id, path=path, ciphertext=ciphertext, metadata=metadata):
        raise BrowserResumeStoreError("Browser resume archive write failed")
    # A returned write reference alone is insufficient: the next activity may
    # run on another worker immediately after this one returns.
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            stored = read_archive_artifact(root_agent_id=agent_id, path=path)
            if stored is not None and decrypt_and_validate_artifact(*stored) == body:
                return
        except Exception as exc:
            last_error = exc
        if attempt < 2:
            time.sleep(0.2 * (attempt + 1))
    raise BrowserResumeStoreError("Browser resume archive was not readable after write") from last_error


def _load_part(agent_id: str, path: str) -> bytes:
    stored = read_archive_artifact(root_agent_id=agent_id, path=path)
    if stored is None:
        raise BrowserResumeStoreError(f"Browser resume archive part missing: {path}")
    return decrypt_and_validate_artifact(*stored)


async def persist_resume_context(
    *, agent_id: str, task_id: str, state: Dict[str, Any], force_private: bool = False
) -> Dict[str, Any]:
    """Return the exact state inline, or a verified encrypted snapshot pointer."""
    body = _encoded_snapshot(state)
    if force_private or state.get("secret_redaction_refs"):
        # Redaction bindings contain plaintext credentials, even when the
        # model-facing transcript has already been sanitized. Never return
        # these inline or fall back to plaintext when the archive is down.
        return await _store_snapshot(agent_id, task_id, body)
    if len(body) <= _PREFERRED_INLINE_BYTES:
        return state
    try:
        return await _store_snapshot(agent_id, task_id, body)
    except Exception as exc:
        if len(body) > _INLINE_LIMIT_BYTES:
            raise
        logger.warning(
            "Browser resume archive unavailable; keeping snapshot inline",
            agent_id=agent_id,
            task_id=task_id,
            snapshot_bytes=len(body),
            error=str(exc),
        )
        return state


async def _store_snapshot(agent_id: str, task_id: str, body: bytes) -> Dict[str, Any]:
    digest = hashlib.sha256(body).hexdigest()
    parts = [body[offset : offset + _PART_BYTES] for offset in range(0, len(body), _PART_BYTES)]
    if len(parts) > _MAX_PARTS:
        raise BrowserResumeStoreError("Browser resume context exceeds encrypted archive size limit")
    prefix = f"browser-resume/{task_id}/{digest}"
    paths = [f"{prefix}-{index:04d}.json" for index in range(len(parts))]
    for path, part in zip(paths, parts):
        await asyncio.to_thread(_store_part, agent_id, path, part)
    return {
        "browser_resume_context_ref": {
            "paths": paths,
            "sha256": digest,
            "bytes": len(body),
        }
    }


async def hydrate_resume_context(*, agent_id: str, resume_state: Dict[str, Any]) -> Dict[str, Any]:
    """Restore a persisted snapshot without altering any provider-visible turn."""
    ref = resume_state.get("browser_resume_context_ref")
    if ref is None:
        return resume_state
    if not isinstance(ref, dict) or not isinstance(ref.get("paths"), list):
        raise BrowserResumeStoreError("Browser resume context pointer is malformed")
    paths = ref["paths"]
    if not paths or len(paths) > _MAX_PARTS or not all(isinstance(path, str) for path in paths):
        raise BrowserResumeStoreError("Browser resume context part list is invalid")
    chunks = []
    for path in paths:
        chunks.append(await asyncio.to_thread(_load_part, agent_id, path))
    body = b"".join(chunks)
    if len(body) != ref.get("bytes") or hashlib.sha256(body).hexdigest() != ref.get("sha256"):
        raise BrowserResumeStoreError("Browser resume context checksum mismatch")
    restored = json.loads(body)
    if not isinstance(restored, dict):
        raise BrowserResumeStoreError("Browser resume context is not an object")
    return {**resume_state, **restored}


def _paused_conversation_pointer_path(inbox_address: str) -> str:
    return f"browser-pause/{hashlib.sha256(inbox_address.encode('utf-8')).hexdigest()}.json"


async def persist_paused_conversation(*, agent_id: str, task_id: str, inbox_address: str, state: Dict[str, Any]) -> None:
    """Archive a user-paused run's exact conversation, keyed by that run's inbox address.

    A later ``send_message_to_agent(continue_conversation=true)`` resumes the
    same inbox address and restores this snapshot. Always encrypted (the state
    can carry credential bindings); the pointer is overwritten by a later pause
    of the same run.
    """
    ref = await _store_snapshot(agent_id, task_id, _encoded_snapshot(state))
    await asyncio.to_thread(
        _store_part, agent_id, _paused_conversation_pointer_path(inbox_address), _encoded_snapshot(ref)
    )


async def load_paused_conversation(*, agent_id: str, inbox_address: str) -> Dict[str, Any]:
    """The snapshot ``persist_paused_conversation`` stored, or BrowserResumeStoreError."""
    try:
        pointer = json.loads(
            await asyncio.to_thread(_load_part, agent_id, _paused_conversation_pointer_path(inbox_address))
        )
    except BrowserResumeStoreError:
        raise BrowserResumeStoreError(
            "The paused browser agent's prior conversation was not saved; resume it with "
            "continue_conversation=false to start a fresh conversation"
        ) from None
    if not isinstance(pointer, dict):
        raise BrowserResumeStoreError("Paused browser conversation pointer is malformed")
    return await hydrate_resume_context(agent_id=agent_id, resume_state=pointer)
