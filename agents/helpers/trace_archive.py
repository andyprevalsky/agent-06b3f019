"""Durable encrypted trace archive helpers.

Archives are best-effort and must never break agent execution. Payloads are
compressed before AES-256-GCM encryption for JSON/text artifacts; already
compressed media can opt out of gzip. In prod, Python workers POST encrypted
artifacts to the backend archive endpoint so the backend owns R2 credentials.
In dev/tests, artifacts are written to `.context/trace-archive/`.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

import httpx
import structlog
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = structlog.get_logger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_ROOT = _REPO_ROOT / ".context" / "trace-archive"
_FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
_TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
_MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".m4a", ".mp3", ".wav", ".m3u8"}
_R2_CLIENT: Any = None


def _safe_segment(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value)[:96] or "unbound"


def _is_production() -> bool:
    return os.environ.get("FLY_APP_NAME") is not None or os.environ.get("ENVIRONMENT") == "production"


def archive_enabled() -> bool:
    raw = os.environ.get("TRACE_ARCHIVE_ENABLED", "").strip().lower()
    if raw in _FALSE_VALUES:
        return False
    if raw in _TRUE_VALUES:
        return True
    if _is_production():
        return bool(
            os.environ.get("R2_ACCOUNT_ID")
            and os.environ.get("R2_ACCESS_KEY_ID")
            and os.environ.get("R2_SECRET_ACCESS_KEY")
            and os.environ.get("R2_BUCKET_TRACE_ARCHIVE")
        )
    return bool(os.environ.get("CONDUCTOR_WORKSPACE_NAME") or os.environ.get("BLACKBOX_TEST_CAPTURE_OUTBOUND"))


def _encryption_key() -> Optional[bytes]:
    raw = os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64", "").strip()
    if raw:
        try:
            key = base64.b64decode(raw)
            if len(key) == 32:
                return key
        except Exception:
            logger.warning("trace_archive.bad_encryption_key")
            return None
        logger.warning("trace_archive.bad_encryption_key_length", bytes=len(key))
        return None
    if _is_production():
        logger.warning("trace_archive.disabled_missing_prod_key")
        return None
    return hashlib.sha256(b"rose-trace-archive-dev-key").digest()


def _should_compress(path: str, content_type: str, compress: Optional[bool]) -> bool:
    if compress is not None:
        return compress
    suffix = Path(path).suffix.lower()
    if suffix in _MEDIA_EXTENSIONS:
        return False
    return not content_type.startswith(("image/", "video/", "audio/"))


def encrypt_artifact(
    plaintext: bytes,
    *,
    path: str,
    content_type: str,
    compress: Optional[bool] = None,
) -> Optional[tuple[bytes, dict[str, Any]]]:
    key = _encryption_key()
    if not key:
        return None

    use_gzip = _should_compress(path, content_type, compress)
    body = gzip.compress(plaintext, compresslevel=6) if use_gzip else plaintext
    nonce = os.urandom(12)
    aad = path.encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, body, aad)
    auth_tag = ciphertext[-16:]
    metadata = {
        "path": path,
        "content_type": content_type,
        "compression": "gzip" if use_gzip else "none",
        "encryption": "aes-256-gcm",
        "encryption_key_id": os.environ.get("TRACE_ARCHIVE_KEY_ID", "dev-local"),
        "nonce_b64": base64.b64encode(nonce).decode("ascii"),
        "auth_tag_b64": base64.b64encode(auth_tag).decode("ascii"),
        "aad": path,
        "plaintext_sha256": hashlib.sha256(plaintext).hexdigest(),
        "ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest(),
        "plaintext_bytes": len(plaintext),
        "stored_plaintext_bytes": len(body),
        "ciphertext_bytes": len(ciphertext),
        "created_at_ms": int(time.time() * 1000),
    }
    return ciphertext, metadata


def _write_local(root_agent_id: str, path: str, ciphertext: bytes, metadata: dict[str, Any]) -> str:
    root = _LOCAL_ROOT / _safe_segment(root_agent_id)
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(ciphertext)
    meta_path = target.with_suffix(target.suffix + ".meta.json")
    meta_path.write_text(json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8")
    return str(target)


def _safe_path(path: str) -> str:
    return "/".join(_safe_segment(part) for part in path.split("/") if part)


def _archive_backend() -> str:
    return os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower() or "local"


def _use_r2_archive() -> bool:
    backend = _archive_backend()
    return backend == "r2" or (_is_production() and backend != "local")


def _object_key(root_agent_id: str, path: str = "") -> str:
    suffix = _safe_path(path)
    prefix = f"trace-archive/{_safe_segment(root_agent_id)}"
    return f"{prefix}/{suffix}" if suffix else f"{prefix}/"


def _r2_client() -> Any:
    global _R2_CLIENT
    if _R2_CLIENT is not None:
        return _R2_CLIENT
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ModuleNotFoundError as exc:
        raise RuntimeError("boto3 is required for TRACE_ARCHIVE_BACKEND=r2 reads") from exc
    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key_id = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_access_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not account_id or not access_key_id or not secret_access_key:
        raise RuntimeError("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required")
    # Bounded connect/read timeouts + retries: without these, a stalled R2
    # connection leaves boto3 blocked in poll() forever (observed hanging the
    # WMH corpus first-build on a cloud box). Adaptive retries re-establish a
    # dropped connection instead of waiting indefinitely.
    _r2_config = BotoConfig(
        connect_timeout=int(os.environ.get("R2_CONNECT_TIMEOUT", "15")),
        read_timeout=int(os.environ.get("R2_READ_TIMEOUT", "60")),
        retries={"max_attempts": int(os.environ.get("R2_MAX_ATTEMPTS", "5")), "mode": "adaptive"},
    )
    _R2_CLIENT = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=_r2_config,
    )
    return _R2_CLIENT


def _r2_bucket() -> str:
    bucket = os.environ.get("R2_BUCKET_TRACE_ARCHIVE", "")
    if not bucket:
        raise RuntimeError("R2_BUCKET_TRACE_ARCHIVE is required")
    return bucket


def _read_r2_object(key: str) -> bytes:
    response = _r2_client().get_object(Bucket=_r2_bucket(), Key=key)
    body = response["Body"]
    return body.read()


def read_local_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read a locally archived encrypted artifact and its metadata."""
    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    target = _LOCAL_ROOT / safe_root / safe_path
    if not target.exists():
        return None
    meta_path = target.with_suffix(target.suffix + ".meta.json")
    if not meta_path.exists():
        raise ValueError(f"Archive metadata missing for {path}")
    return target.read_bytes(), json.loads(meta_path.read_text(encoding="utf-8"))


def read_r2_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read an encrypted R2 artifact and its metadata."""
    key = _object_key(root_agent_id, path)
    try:
        ciphertext = _read_r2_object(key)
        metadata = json.loads(_read_r2_object(f"{key}.meta.json").decode("utf-8"))
        return ciphertext, metadata
    except Exception as exc:
        error_code = getattr(getattr(exc, "response", None), "get", lambda *_: {})("Error", {}).get("Code")
        if error_code in {"NoSuchKey", "404", "NotFound"}:
            return None
        if exc.__class__.__name__ in {"NoSuchKey", "ClientError"} and "NoSuchKey" in str(exc):
            return None
        raise


def read_archive_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read an encrypted artifact from the configured archive backend."""
    if _use_r2_archive():
        return read_r2_artifact(root_agent_id=root_agent_id, path=path)
    return read_local_artifact(root_agent_id=root_agent_id, path=path)


def list_local_bundle_ids() -> list[str]:
    if not _LOCAL_ROOT.exists():
        return []
    return sorted(item.name for item in _LOCAL_ROOT.iterdir() if item.is_dir())


def list_local_artifact_paths(root_agent_id: str) -> list[str]:
    bundle = _LOCAL_ROOT / _safe_segment(root_agent_id)
    if not bundle.exists():
        return []
    paths: list[str] = []
    for item in bundle.rglob("*"):
        if item.is_file() and not item.name.endswith(".meta.json"):
            paths.append(item.relative_to(bundle).as_posix())
    return sorted(paths)


def list_r2_bundle_ids() -> list[str]:
    client = _r2_client()
    bucket = _r2_bucket()
    ids: set[str] = set()
    token: Optional[str] = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": "trace-archive/", "Delimiter": "/"}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for prefix in response.get("CommonPrefixes", []):
            value = str(prefix.get("Prefix") or "")
            if value.startswith("trace-archive/"):
                bundle_id = value[len("trace-archive/") :].strip("/")
                if bundle_id:
                    ids.add(bundle_id)
        if not response.get("IsTruncated"):
            break
        token = response.get("NextContinuationToken")
    return sorted(ids)


def list_r2_artifact_paths(root_agent_id: str) -> list[str]:
    client = _r2_client()
    bucket = _r2_bucket()
    prefix = _object_key(root_agent_id)
    paths: list[str] = []
    token: Optional[str] = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for item in response.get("Contents", []):
            key = str(item.get("Key") or "")
            if not key or key.endswith(".meta.json") or key == prefix:
                continue
            paths.append(key[len(prefix) :])
        if not response.get("IsTruncated"):
            break
        token = response.get("NextContinuationToken")
    return sorted(paths)


def list_archive_bundle_ids() -> list[str]:
    """List root bundle IDs from the configured archive backend."""
    if _use_r2_archive():
        return list_r2_bundle_ids()
    return list_local_bundle_ids()


def list_archive_artifact_paths(root_agent_id: str) -> list[str]:
    """List artifact paths for a bundle from the configured archive backend."""
    if _use_r2_archive():
        return list_r2_artifact_paths(root_agent_id)
    return list_local_artifact_paths(root_agent_id)


def decrypt_and_validate_artifact(ciphertext: bytes, metadata: dict[str, Any]) -> bytes:
    """Decrypt an archive artifact and verify every recorded integrity field."""
    if hashlib.sha256(ciphertext).hexdigest() != metadata.get("ciphertext_sha256"):
        raise ValueError("Archive ciphertext SHA-256 mismatch")
    if len(ciphertext) != metadata.get("ciphertext_bytes"):
        raise ValueError("Archive ciphertext byte count mismatch")
    key = _encryption_key()
    if not key:
        raise ValueError("Archive encryption key is unavailable")
    nonce = base64.b64decode(str(metadata["nonce_b64"]))
    aad = str(metadata["aad"]).encode("utf-8")
    stored_plaintext = AESGCM(key).decrypt(nonce, ciphertext, aad)
    if len(stored_plaintext) != metadata.get("stored_plaintext_bytes"):
        raise ValueError("Archive stored plaintext byte count mismatch")
    plaintext = gzip.decompress(stored_plaintext) if metadata.get("compression") == "gzip" else stored_plaintext
    if len(plaintext) != metadata.get("plaintext_bytes"):
        raise ValueError("Archive plaintext byte count mismatch")
    if hashlib.sha256(plaintext).hexdigest() != metadata.get("plaintext_sha256"):
        raise ValueError("Archive plaintext SHA-256 mismatch")
    return plaintext


def _backend_archive_url() -> Optional[str]:
    api_url = os.environ.get("BACKEND_API_URL", "").strip()
    if not api_url:
        try:
            from config import load_config

            api_url = load_config().backend.api_url
        except Exception:
            api_url = ""
    return f"{api_url.rstrip('/')}/api/archive/artifact" if api_url else None


def _backend_api_key() -> str:
    key = os.environ.get("BACKEND_API_KEY", "")
    if key:
        return key
    try:
        from config import load_config

        return load_config().backend.api_key or ""
    except Exception:
        return ""


def store_encrypted_artifact(
    *,
    root_agent_id: str,
    path: str,
    ciphertext: bytes,
    metadata: dict[str, Any],
) -> Optional[str]:
    """Store an already-encrypted artifact locally or through the backend."""
    root_agent_id = _safe_segment(root_agent_id)
    path = "/".join(_safe_segment(part) for part in path.split("/") if part)
    if not path:
        return None

    backend = os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower()
    if _is_production() or backend == "r2":
        url = _backend_archive_url()
        api_key = _backend_api_key()
        if not url or not api_key:
            logger.warning("trace_archive.backend_missing_config", root_agent_id=root_agent_id, path=path)
            return None
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.post(
                    url,
                    headers={"X-API-Key": api_key, "Content-Type": "application/json"},
                    json={
                        "rootAgentId": root_agent_id,
                        "path": path,
                        "ciphertextB64": base64.b64encode(ciphertext).decode("ascii"),
                        "metadata": metadata,
                    },
                )
            if resp.status_code == 200:
                return str((resp.json() or {}).get("ref") or f"trace-archive/{root_agent_id}/{path}")
            logger.warning("trace_archive.backend_store_failed", status=resp.status_code, body=resp.text[:200])
            return None
        except Exception as exc:
            logger.warning("trace_archive.backend_store_error", error=str(exc)[:200])
            return None

    try:
        return _write_local(root_agent_id, path, ciphertext, metadata)
    except Exception as exc:
        logger.warning("trace_archive.local_store_error", root_agent_id=root_agent_id, path=path, error=str(exc)[:200])
        return None


# Archive writes are gzip + AES-GCM + (in r2 mode) an HTTP POST — all blocking.
# Worker activities call archive_bytes/archive_json from the event-loop thread on
# every LLM call, so running that work inline stalls stream reads loop-wide
# (observed: 2k+ loop.lag warnings, 90s max lag, RoseStallError storms). When the
# process opts in via TRACE_ARCHIVE_ASYNC_WRITES (worker.py sets it at startup)
# and a loop is running, the write is offloaded to this bounded executor and the
# expected ref is returned immediately. Benchmark CLI, tests, and scripts keep
# synchronous read-after-write semantics. Archive stays best-effort: when the
# queue is saturated the write is dropped with a warning, never backpressure.
_ARCHIVE_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="trace-archive")
_ARCHIVE_SLOTS = threading.BoundedSemaphore(64)

# Artifacts ship to the backend as base64-in-JSON; a single oversized body (e.g.
# a browser session video) freezes the Node event loop on parse/GC for minutes
# (observed: 355s backend log gap → suite-wide ConnectErrors). Oversized
# artifacts are dropped with a warning — archive is best-effort by contract.
_DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024


def _max_artifact_bytes() -> int:
    raw = os.environ.get("TRACE_ARCHIVE_MAX_ARTIFACT_BYTES", "").strip()
    try:
        return int(raw) if raw else _DEFAULT_MAX_ARTIFACT_BYTES
    except ValueError:
        return _DEFAULT_MAX_ARTIFACT_BYTES


def _async_writes_enabled() -> bool:
    return os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES", "").strip().lower() in _TRUE_VALUES


def _expected_ref(safe_root: str, safe_path: str) -> str:
    backend = os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower()
    if _is_production() or backend == "r2":
        return f"trace-archive/{safe_root}/{safe_path}"
    return str(_LOCAL_ROOT / safe_root / safe_path)


def _archive_bytes_now(
    *,
    root_agent_id: str,
    path: str,
    body: bytes,
    content_type: str,
    compress: Optional[bool],
) -> Optional[dict[str, Any]]:
    encrypted = encrypt_artifact(body, path=path, content_type=content_type, compress=compress)
    if encrypted is None:
        return None
    ciphertext, metadata = encrypted
    ref = store_encrypted_artifact(root_agent_id=root_agent_id, path=path, ciphertext=ciphertext, metadata=metadata)
    if not ref:
        return None
    return {"ref": ref, "metadata": metadata}


def archive_bytes(
    *,
    root_agent_id: str,
    path: str,
    body: bytes,
    content_type: str = "application/octet-stream",
    compress: Optional[bool] = None,
) -> Optional[dict[str, Any]]:
    if not archive_enabled():
        return None
    if len(body) > _max_artifact_bytes():
        logger.warning(
            "trace_archive.artifact_too_large",
            root_agent_id=_safe_segment(root_agent_id),
            path=path,
            bytes=len(body),
            limit=_max_artifact_bytes(),
        )
        return None
    in_loop = True
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        in_loop = False
    if not in_loop or not _async_writes_enabled():
        return _archive_bytes_now(
            root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=compress
        )

    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    if not safe_path:
        return None
    if not _ARCHIVE_SLOTS.acquire(blocking=False):
        logger.warning("trace_archive.async_queue_full", root_agent_id=safe_root, path=safe_path)
        return None

    def _job() -> None:
        try:
            _archive_bytes_now(
                root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=compress
            )
        except Exception as exc:
            logger.warning("trace_archive.async_write_error", root_agent_id=safe_root, path=safe_path, error=str(exc)[:200])
        finally:
            _ARCHIVE_SLOTS.release()

    _ARCHIVE_EXECUTOR.submit(_job)
    return {"ref": _expected_ref(safe_root, safe_path), "metadata": None}


def archive_json(
    *,
    root_agent_id: str,
    path: str,
    payload: Any,
    content_type: str = "application/json",
) -> Optional[dict[str, Any]]:
    body = json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
    return archive_bytes(root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=True)
