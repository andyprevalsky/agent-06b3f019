"""Storage for the derived planner-RAG index.

The index is a *derived* artifact built from trace-archive bundles. It lives
under its own ``planner-rag/`` prefix (R2 bucket or the local ``.context``
mirror) and is written with the same AES-256-GCM + gzip envelope the archive
uses, so the plaintext goals/plans never sit unencrypted at rest.

Raw bundles under ``trace-archive/`` are read-only from this module: every
write path asserts the key is under ``planner-rag/``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

import structlog

from helpers.trace_archive import (
    decrypt_and_validate_artifact,
    encrypt_artifact,
    local_archive_root,
    r2_bucket,
    r2_client,
    use_r2_archive,
)

logger = structlog.get_logger(__name__)

DERIVED_PREFIX = "planner-rag/"
INDEX_KEY = f"{DERIVED_PREFIX}goal-plan-index.v1.json.gz.enc"
SCAN_STATE_KEY = f"{DERIVED_PREFIX}scan-state.v1.json.gz.enc"

_R2_TIMEOUT_ENV = "PLANNER_RAG_R2_READ_TIMEOUT"


def _assert_derived_key(key: str) -> None:
    if not key.startswith(DERIVED_PREFIX):
        raise ValueError(f"planner-rag store only writes under {DERIVED_PREFIX!r} (got {key!r}); bundles are read-only")


def storage_backend() -> str:
    """``r2`` or ``local``. Follows the trace-archive backend unless PLANNER_RAG_BACKEND overrides it."""
    override = os.environ.get("PLANNER_RAG_BACKEND", "").strip().lower()
    if override in {"r2", "local"}:
        return override
    return "r2" if use_r2_archive() else "local"


def local_root() -> Path:
    """Local mirror root; ``planner-rag/`` keys resolve relative to it."""
    configured = os.environ.get("PLANNER_RAG_LOCAL_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return local_archive_root().parent


def _local_path(key: str) -> Path:
    return local_root() / key


def _is_missing(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    code = None
    if isinstance(response, dict):
        code = (response.get("Error") or {}).get("Code")
    if code in {"NoSuchKey", "404", "NotFound"}:
        return True
    return "NoSuchKey" in str(exc) or "Not Found" in str(exc)


def read_bytes(key: str, *, backend: Optional[str] = None) -> Optional[bytes]:
    """Read a raw object by bucket-relative key. Returns None when absent."""
    backend = backend or storage_backend()
    if backend == "r2":
        try:
            return r2_client().get_object(Bucket=r2_bucket(), Key=key)["Body"].read()
        except Exception as exc:
            if _is_missing(exc):
                return None
            raise
    path = _local_path(key)
    if not path.exists():
        return None
    return path.read_bytes()


def write_bytes(key: str, body: bytes, *, content_type: str, backend: Optional[str] = None) -> str:
    """Write a derived object. Refuses any key outside ``planner-rag/``."""
    _assert_derived_key(key)
    backend = backend or storage_backend()
    if backend == "r2":
        r2_client().put_object(
            Bucket=r2_bucket(),
            Key=key,
            Body=body,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
        return f"r2://{r2_bucket()}/{key}"
    path = _local_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_bytes(body)
    tmp.replace(path)
    return str(path)


def read_encrypted_json(key: str, *, backend: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Read + decrypt + parse an encrypted JSON object stored as ``key`` + ``key.meta.json``."""
    backend = backend or storage_backend()
    ciphertext = read_bytes(key, backend=backend)
    if ciphertext is None:
        return None
    metadata_raw = read_bytes(f"{key}.meta.json", backend=backend)
    if metadata_raw is None:
        raise ValueError(f"planner-rag metadata missing for {key}")
    metadata = json.loads(metadata_raw.decode("utf-8"))
    plaintext = decrypt_and_validate_artifact(ciphertext, metadata)
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"planner-rag object {key} is not a JSON object")
    return value


def write_encrypted_json(key: str, value: dict[str, Any], *, backend: Optional[str] = None) -> str:
    """Encrypt (gzip + AES-GCM) and write a JSON object as ``key`` + ``key.meta.json``."""
    _assert_derived_key(key)
    backend = backend or storage_backend()
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    encrypted = encrypt_artifact(body, path=key, content_type="application/json", compress=True)
    if encrypted is None:
        raise RuntimeError("planner-rag: archive encryption key unavailable; refusing to write plaintext index")
    ciphertext, metadata = encrypted
    ref = write_bytes(key, ciphertext, content_type="application/octet-stream", backend=backend)
    write_bytes(
        f"{key}.meta.json",
        json.dumps(metadata, indent=2, sort_keys=True).encode("utf-8"),
        content_type="application/json",
        backend=backend,
    )
    logger.info(
        "planner_rag.store.write",
        key=key,
        backend=backend,
        plaintext_bytes=len(body),
        ciphertext_bytes=len(ciphertext),
        ref=ref,
    )
    return ref
