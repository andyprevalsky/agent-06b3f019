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
import fcntl
import gzip
import hashlib
import json
import os
import tempfile
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional

import httpx
import structlog
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = structlog.get_logger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_ROOT = _REPO_ROOT / ".context" / "trace-archive"
_PROD_FALLBACK_LOCAL_ROOT = Path(tempfile.gettempdir()) / "rose-trace-archive" / "trace-archive"
_FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
_TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
_MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".m4a", ".mp3", ".wav", ".m3u8"}
_R2_CLIENT: Any = None
# PID that built _R2_CLIENT (None for clients injected directly, e.g. test fakes).
_R2_CLIENT_PID: Optional[int] = None
_BACKEND_CLIENTS = threading.local()
_ARTIFACT_LOCK_STRIPES = 256
_ARTIFACT_WRITE_LOCKS = tuple(threading.Lock() for _ in range(_ARTIFACT_LOCK_STRIPES))
_ARTIFACT_TRANSACTION_MAGIC = b"ROSE-TRACE-PAIR-V1\n"
_ARTIFACT_TRANSACTION_SUFFIX = ".transaction"


def _safe_segment(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value)[:96] or "unbound"


def _is_production() -> bool:
    return os.environ.get("FLY_APP_NAME") is not None or os.environ.get("ENVIRONMENT") == "production"


def _rooted_at_filesystem_context(path: Path) -> bool:
    return path.is_absolute() and len(path.parts) >= 2 and path.parts[1] == ".context"


def _path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _uses_default_repo_local_root(path: Path) -> bool:
    return _rooted_at_filesystem_context(path) or _path_is_relative_to(path, _REPO_ROOT)


def _local_root() -> Path:
    configured = os.environ.get("TRACE_ARCHIVE_LOCAL_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser()
    if (
        _is_production()
        and not os.environ.get("CONDUCTOR_WORKSPACE_NAME")
        and _uses_default_repo_local_root(_LOCAL_ROOT)
    ):
        return _PROD_FALLBACK_LOCAL_ROOT
    return _LOCAL_ROOT


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


def _artifact_lock_index(target: Path) -> int:
    digest = hashlib.sha256(str(target).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % _ARTIFACT_LOCK_STRIPES


@contextmanager
def _artifact_lock(target: Path) -> Iterator[None]:
    lock_index = _artifact_lock_index(target)
    lock_root = _local_root().parent / "trace-archive-locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    lock_path = lock_root / f"{lock_index:03d}.lock"
    with _ARTIFACT_WRITE_LOCKS[lock_index]:
        with lock_path.open("a+b") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _artifact_transaction_path(target: Path) -> Path:
    return target.with_suffix(target.suffix + _ARTIFACT_TRANSACTION_SUFFIX)


def _artifact_transaction_target(path: Path) -> Optional[Path]:
    if not path.name.endswith(_ARTIFACT_TRANSACTION_SUFFIX):
        return None
    return path.with_name(path.name[: -len(_ARTIFACT_TRANSACTION_SUFFIX)])


def _is_artifact_transaction_temporary(path: Path) -> bool:
    marker = f"{_ARTIFACT_TRANSACTION_SUFFIX}."
    _, separator, tail = path.name.rpartition(marker)
    if not separator or not tail.endswith(".tmp"):
        return False
    identifiers = tail[: -len(".tmp")].split(".")
    return 1 <= len(identifiers) <= 2 and all(identifier.isdigit() for identifier in identifiers)


def _encode_artifact_transaction(ciphertext: bytes, metadata: dict[str, Any]) -> bytes:
    metadata_bytes = json.dumps(metadata, indent=2, sort_keys=True).encode("utf-8")
    return _ARTIFACT_TRANSACTION_MAGIC + len(metadata_bytes).to_bytes(8, "big") + metadata_bytes + ciphertext


def _decode_artifact_transaction(payload: bytes) -> tuple[bytes, dict[str, Any]]:
    header_offset = len(_ARTIFACT_TRANSACTION_MAGIC)
    if not payload.startswith(_ARTIFACT_TRANSACTION_MAGIC) or len(payload) < header_offset + 8:
        raise ValueError("Archive transaction is invalid")
    metadata_size = int.from_bytes(payload[header_offset : header_offset + 8], "big")
    metadata_start = header_offset + 8
    metadata_end = metadata_start + metadata_size
    if metadata_size <= 0 or metadata_end > len(payload):
        raise ValueError("Archive transaction metadata is invalid")
    metadata = json.loads(payload[metadata_start:metadata_end].decode("utf-8"))
    if not isinstance(metadata, dict):
        raise ValueError("Archive transaction metadata must be an object")
    return payload[metadata_end:], metadata


def _write_file_durable(path: Path, payload: bytes) -> None:
    with path.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _fsync_parent(path: Path) -> None:
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _replace_durable(source: Path, target: Path) -> None:
    source.replace(target)
    _fsync_parent(target)


def _recover_artifact_transaction_unlocked(target: Path) -> bool:
    transaction_path = _artifact_transaction_path(target)
    if not transaction_path.exists():
        return False
    ciphertext, metadata = _decode_artifact_transaction(transaction_path.read_bytes())
    meta_path = target.with_suffix(target.suffix + ".meta.json")
    unique_suffix = f".{os.getpid()}.{threading.get_ident()}.recover.tmp"
    target_tmp = target.with_suffix(target.suffix + unique_suffix)
    meta_tmp = meta_path.with_suffix(meta_path.suffix + unique_suffix)
    try:
        _write_file_durable(target_tmp, ciphertext)
        _write_file_durable(meta_tmp, json.dumps(metadata, indent=2, sort_keys=True).encode("utf-8"))
        _replace_durable(target_tmp, target)
        _replace_durable(meta_tmp, meta_path)
        transaction_path.unlink()
        _fsync_parent(transaction_path)
    finally:
        for temporary in (target_tmp, meta_tmp):
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
    return True


def _read_artifact_pair_unlocked(target: Path) -> Optional[tuple[bytes, dict[str, Any]]]:
    _recover_artifact_transaction_unlocked(target)
    if not target.exists():
        return None
    meta_path = target.with_suffix(target.suffix + ".meta.json")
    if not meta_path.exists():
        raise ValueError(f"Archive metadata missing for {target.name}")
    ciphertext = target.read_bytes()
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    if hashlib.sha256(ciphertext).hexdigest() != metadata.get("ciphertext_sha256"):
        raise ValueError(f"Archive ciphertext/metadata mismatch for {target.name}")
    return ciphertext, metadata


def _write_artifact_pair(target: Path, ciphertext: bytes, metadata: dict[str, Any]) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    unique_suffix = f".{os.getpid()}.{threading.get_ident()}.tmp"
    transaction_path = _artifact_transaction_path(target)
    transaction_tmp = transaction_path.with_suffix(transaction_path.suffix + unique_suffix)
    with _artifact_lock(target):
        try:
            _write_file_durable(transaction_tmp, _encode_artifact_transaction(ciphertext, metadata))
            _replace_durable(transaction_tmp, transaction_path)
            _recover_artifact_transaction_unlocked(target)
        finally:
            try:
                transaction_tmp.unlink()
            except FileNotFoundError:
                pass
    return str(target)


def _write_local(root_agent_id: str, path: str, ciphertext: bytes, metadata: dict[str, Any]) -> str:
    root = _local_root() / _safe_segment(root_agent_id)
    return _write_artifact_pair(root / path, ciphertext, metadata)


def _outbox_root() -> Path:
    return _local_root().parent / "trace-archive-outbox"


def _write_outbox(root_agent_id: str, path: str, ciphertext: bytes, metadata: dict[str, Any]) -> str:
    root = _outbox_root() / _safe_segment(root_agent_id)
    return _write_artifact_pair(root / path, ciphertext, metadata)


def _delete_outbox(root_agent_id: str, path: str, *, expected_ciphertext_sha256: str) -> bool:
    target = _outbox_root() / _safe_segment(root_agent_id) / path
    with _artifact_lock(target):
        pair = _read_artifact_pair_unlocked(target)
        if pair is None:
            return False
        _, metadata = pair
        if metadata.get("ciphertext_sha256") != expected_ciphertext_sha256:
            return False
        for item in (
            _artifact_transaction_path(target),
            target.with_suffix(target.suffix + ".meta.json"),
            target,
        ):
            try:
                item.unlink()
            except FileNotFoundError:
                pass
    return True


def _safe_path(path: str) -> str:
    return "/".join(_safe_segment(part) for part in path.split("/") if part)


def _archive_backend() -> str:
    return os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower() or "local"


def _use_r2_archive() -> bool:
    backend = _archive_backend()
    return backend == "r2" or (_is_production() and backend != "local")


_NONPROD_R2_OPT_IN = "TRACE_ARCHIVE_ALLOW_NONPROD_R2"


def _production_runtime() -> bool:
    """Same production test the backend applies before writing the prod bucket."""
    return bool(
        os.environ.get("FLY_APP_NAME")
        or os.environ.get("FLY_MACHINE_ID")
        or os.environ.get("ENVIRONMENT", "").strip().lower() == "production"
        or os.environ.get("NODE_ENV", "").strip().lower() == "production"
    )


def _r2_publish_permitted(path: str = "", *, log: bool = True) -> bool:
    """Dev/test runs never publish into the R2 trace bucket without an explicit opt-in.

    A refused artifact is kept in the local archive instead, with an ERROR log
    and the `nonprod_r2_refused` counter naming the opt-in.
    """
    if _production_runtime() or os.environ.get(_NONPROD_R2_OPT_IN, "").strip().lower() in _TRUE_VALUES:
        return True
    if log:
        refused = _count("nonprod_r2_refused")
        if refused == 1 or refused & (refused - 1) == 0:
            logger.error(
                "trace_archive.nonprod_r2_refused",
                path=_safe_path(path),
                refused=refused,
                reason=f"non-production process; set {_NONPROD_R2_OPT_IN}=1 to publish traces to the R2 bucket",
            )
    return False


def _r2_publication() -> bool:
    """Whether writes publish through the backend to R2 (quiet check)."""
    return _use_r2_archive() and _r2_publish_permitted(log=False)


def _object_key(root_agent_id: str, path: str = "") -> str:
    suffix = _safe_path(path)
    prefix = f"trace-archive/{_safe_segment(root_agent_id)}"
    return f"{prefix}/{suffix}" if suffix else f"{prefix}/"


def _r2_client() -> Any:
    global _R2_CLIENT, _R2_CLIENT_PID
    if _R2_CLIENT is not None:
        # A boto3 client inherited across fork() shares its parent's pooled TLS
        # sockets; the corpus exporter forks worker processes, so each process
        # builds its own client. Injected clients (PID None) are kept as-is.
        if _R2_CLIENT_PID is None or _R2_CLIENT_PID == os.getpid():
            return _R2_CLIENT
        _R2_CLIENT = None
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
        # Parallel corpus readers (benchmarks/world_model_harness.py) fan out
        # dozens of small GETs at once; the urllib3 default of 10 pooled
        # connections serialises them again and logs pool-full warnings.
        max_pool_connections=int(os.environ.get("R2_MAX_POOL_CONNECTIONS", "64")),
    )
    _R2_CLIENT_PID = os.getpid()
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


def _is_missing_r2_object_error(exc: Exception) -> bool:
    error_code = getattr(getattr(exc, "response", None), "get", lambda *_: {})("Error", {}).get("Code")
    if error_code in {"NoSuchKey", "404", "NotFound"}:
        return True
    return exc.__class__.__name__ in {"NoSuchKey", "ClientError"} and "NoSuchKey" in str(exc)


def use_r2_archive() -> bool:
    """True when archive reads/writes target R2 (prod, or TRACE_ARCHIVE_BACKEND=r2)."""
    return _use_r2_archive()


def local_archive_root() -> Path:
    """Local mirror root for archive bundles (``.context/trace-archive`` by default)."""
    return _local_root()


def r2_client() -> Any:
    """Shared boto3 S3 client for the trace-archive R2 bucket."""
    return _r2_client()


def r2_bucket() -> str:
    """Name of the trace-archive R2 bucket."""
    return _r2_bucket()


def read_local_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read a locally archived encrypted artifact and its metadata."""
    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    target = _local_root() / safe_root / safe_path
    with _artifact_lock(target):
        return _read_artifact_pair_unlocked(target)


def read_r2_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read an encrypted R2 artifact and its metadata."""
    key = _object_key(root_agent_id, path)
    try:
        ciphertext = _read_r2_object(key)
    except Exception as exc:
        if _is_missing_r2_object_error(exc):
            return None
        raise
    try:
        metadata = json.loads(_read_r2_object(f"{key}.meta.json").decode("utf-8"))
    except Exception as exc:
        if _is_missing_r2_object_error(exc):
            raise ValueError(f"Archive metadata missing for {path}") from exc
        raise
    return ciphertext, metadata


def read_archive_artifact(*, root_agent_id: str, path: str) -> Optional[tuple[bytes, dict[str, Any]]]:
    """Read an encrypted artifact from the configured archive backend."""
    if _use_r2_archive():
        return read_r2_artifact(root_agent_id=root_agent_id, path=path)
    return read_local_artifact(root_agent_id=root_agent_id, path=path)


def _read_local_artifact_metadata_unlocked(target: Path) -> Optional[dict[str, Any]]:
    _recover_artifact_transaction_unlocked(target)
    if not target.exists():
        return None
    meta_path = target.with_suffix(target.suffix + ".meta.json")
    if not meta_path.exists():
        raise ValueError(f"Archive metadata missing for {target.name}")
    return json.loads(meta_path.read_text(encoding="utf-8"))


def read_local_artifact_metadata(*, root_agent_id: str, path: str) -> Optional[dict[str, Any]]:
    """Read only the sidecar metadata of a locally archived artifact."""
    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    target = _local_root() / safe_root / safe_path
    with _artifact_lock(target):
        return _read_local_artifact_metadata_unlocked(target)


def read_r2_artifact_metadata(*, root_agent_id: str, path: str) -> Optional[dict[str, Any]]:
    """Read only the ``.meta.json`` sidecar of an R2 artifact (never the ciphertext body).

    Same contract as ``read_r2_artifact``: ``None`` when the artifact does not
    exist, ``ValueError`` when ciphertext is present without metadata. The
    existence probe uses HEAD before accepting a sidecar, without opening a ciphertext body.
    """
    key = _object_key(root_agent_id, path)
    try:
        _r2_client().head_object(Bucket=_r2_bucket(), Key=key)
    except Exception as exc:
        if _is_missing_r2_object_error(exc):
            return None
        raise
    try:
        return json.loads(_read_r2_object(f"{key}.meta.json").decode("utf-8"))
    except Exception as exc:
        if _is_missing_r2_object_error(exc):
            raise ValueError(f"Archive metadata missing for {path}") from exc
        raise



def read_archive_artifact_metadata(*, root_agent_id: str, path: str) -> Optional[dict[str, Any]]:
    """Read an artifact's integrity/content metadata without downloading its ciphertext.

    Corpus signatures and artifact refs only need ``plaintext_sha256`` /
    ``plaintext_bytes`` / ``content_type``; fetching whole ciphertexts for that
    turned a 20-bundle World Model build into hundreds of full-object reads.
    """
    if _use_r2_archive():
        return read_r2_artifact_metadata(root_agent_id=root_agent_id, path=path)
    return read_local_artifact_metadata(root_agent_id=root_agent_id, path=path)


def list_local_bundle_ids() -> list[str]:
    local_root = _local_root()
    if not local_root.exists():
        return []
    try:
        return sorted(item.name for item in local_root.iterdir() if item.is_dir())
    except FileNotFoundError:
        return []


def list_local_artifact_paths(root_agent_id: str) -> list[str]:
    bundle = _local_root() / _safe_segment(root_agent_id)
    if not bundle.exists():
        return []
    paths: list[str] = []
    for item in bundle.rglob("*"):
        if (
            item.is_file()
            and not item.name.endswith(".meta.json")
            and _artifact_transaction_target(item) is None
            and not _is_artifact_transaction_temporary(item)
        ):
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


def list_r2_artifact_entries(root_agent_id: str) -> list[dict[str, Any]]:
    """Every object under a bundle with the size and ETag the listing already carries.

    Includes ``.meta.json`` sidecars so callers can verify metadata presence
    without a GET per artifact; one paginated request per ~1000 objects.
    """
    client = _r2_client()
    bucket = _r2_bucket()
    prefix = _object_key(root_agent_id)
    entries: list[dict[str, Any]] = []
    token: Optional[str] = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for item in response.get("Contents", []):
            key = str(item.get("Key") or "")
            if not key or key == prefix:
                continue
            entries.append(
                {
                    "path": key[len(prefix) :],
                    "size": int(item.get("Size") or 0),
                    "etag": str(item.get("ETag") or "").strip('"'),
                }
            )
        if not response.get("IsTruncated"):
            break
        token = response.get("NextContinuationToken")
    entries.sort(key=lambda entry: entry["path"])
    return entries


def archive_backend_is_r2() -> bool:
    """Whether the configured archive backend is R2 (vs. the local directory)."""
    return _use_r2_archive()


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


def _backend_http_client() -> httpx.Client:
    client = getattr(_BACKEND_CLIENTS, "client", None)
    client_factory = getattr(_BACKEND_CLIENTS, "client_factory", None)
    if client is None or getattr(client, "is_closed", False) or client_factory is not httpx.Client:
        client = httpx.Client(timeout=30.0, limits=httpx.Limits(max_connections=8, max_keepalive_connections=4))
        _BACKEND_CLIENTS.client = client
        _BACKEND_CLIENTS.client_factory = httpx.Client
    return client


def _post_backend_artifact(
    *,
    root_agent_id: str,
    path: str,
    ciphertext: bytes,
    metadata: dict[str, Any],
    timeout_s: Optional[float] = None,
) -> Optional[str]:
    url = _backend_archive_url()
    api_key = _backend_api_key()
    if not url or not api_key:
        logger.warning("trace_archive.backend_missing_config", root_agent_id=root_agent_id, path=path)
        return None
    try:
        request_options: dict[str, Any] = {}
        if timeout_s is not None:
            request_options["timeout"] = max(0.001, min(30.0, timeout_s))
        resp = _backend_http_client().post(
            url,
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={
                "rootAgentId": root_agent_id,
                "path": path,
                "ciphertextB64": base64.b64encode(ciphertext).decode("ascii"),
                "metadata": metadata,
            },
            **request_options,
        )
        if resp.status_code == 200:
            return str((resp.json() or {}).get("ref") or f"trace-archive/{root_agent_id}/{path}")
        logger.warning("trace_archive.backend_store_failed", status=resp.status_code, body=resp.text[:200])
        return None
    except Exception as exc:
        logger.warning("trace_archive.backend_store_error", error=str(exc)[:200])
        return None


@contextmanager
def _archive_publication_lease(root_agent_id: str, *, exclusive: bool, deadline: Optional[float] = None):
    """Coordinate batch publication and outbox recovery across threads/processes.

    Shared batch leases preserve recording concurrency. Recovery takes the
    exclusive lease, so it cannot adopt live batches or acknowledge them early.
    Kernel-owned flock releases on process death; the durable pairs remain.
    """
    lock_root = _local_root().parent / "trace-archive-publication-locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(_safe_segment(root_agent_id).encode()).hexdigest()
    with (lock_root / f"{name}.lock").open("a+b") as handle:
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        acquired = False
        try:
            if deadline is None:
                fcntl.flock(handle.fileno(), operation)
                acquired = True
            else:
                while True:
                    try:
                        fcntl.flock(handle.fileno(), operation | fcntl.LOCK_NB)
                        acquired = True
                        break
                    except BlockingIOError:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        time.sleep(min(0.01, remaining))
            yield acquired
        finally:
            if acquired:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _drain_backend_outbox(
    limit: int = 8,
    root_agent_id: Optional[str] = None,
    deadline: Optional[float] = None,
    stop_after_failure: bool = False,
    *,
    _publication_lease_held: bool = False,
) -> int:
    assert not _publication_lease_held or root_agent_id is not None
    if deadline is not None and time.monotonic() >= deadline:
        return 0
    root = _outbox_root()
    try:
        if not root.exists():
            return 0
        safe_root = _safe_segment(root_agent_id) if root_agent_id else None
        bundles = sorted(
            item for item in root.iterdir() if item.is_dir() and (safe_root is None or item.name == safe_root)
        )
    except OSError as exc:
        logger.warning("trace_archive.outbox_scan_error", root_agent_id=root_agent_id, error=str(exc)[:200])
        return 0
    candidates: list[tuple[int, Path, Path]] = []
    for bundle in bundles:
        try:
            items = sorted(bundle.rglob("*"))
        except OSError as exc:
            logger.warning(
                "trace_archive.outbox_scan_error",
                root_agent_id=bundle.name,
                error=str(exc)[:200],
            )
            return 0
        seen: set[Path] = set()
        for item in items:
            if not item.is_file():
                continue
            target = _outbox_artifact_target(item)
            if target is None or target in seen:
                continue
            seen.add(target)
            try:
                modified_ns = item.stat().st_mtime_ns
            except OSError:
                continue
            candidates.append((modified_ns, bundle, target))
    # An unsuccessful upload stays durable, but moves behind other entries so
    # one permanently rejected artifact cannot starve newer recoverable ones.
    candidates.sort(key=lambda entry: (entry[0], str(entry[2])))
    drained = 0
    attempted = 0
    for _, bundle, target in candidates:
        if attempted >= limit or (deadline is not None and time.monotonic() >= deadline):
            return drained
        # Never adopt an active publisher's durable pairs. Terminal flush
        # already owns this root's exclusive lease; reacquiring it would deadlock.
        lease = (
            nullcontext(True)
            if _publication_lease_held
            else _archive_publication_lease(bundle.name, exclusive=True, deadline=time.monotonic())
        )
        with lease as acquired:
            if not acquired:
                continue
            attempted += 1
            path = target.relative_to(bundle).as_posix()
            try:
                with _artifact_lock(target):
                    _recover_artifact_transaction_unlocked(target)
                    meta_path = target.with_suffix(target.suffix + ".meta.json")
                    if not meta_path.exists():
                        continue
                    pair = _read_artifact_pair_unlocked(target)
                if pair is None:
                    continue
                ciphertext, metadata = pair
                expected_ciphertext_sha256 = str(metadata["ciphertext_sha256"])
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return drained
                ref = _post_backend_artifact(
                    root_agent_id=bundle.name,
                    path=path,
                    ciphertext=ciphertext,
                    metadata=metadata,
                    timeout_s=remaining,
                )
                if ref:
                    if _delete_outbox(
                        bundle.name,
                        path,
                        expected_ciphertext_sha256=expected_ciphertext_sha256,
                    ):
                        drained += 1
                else:
                    try:
                        os.utime(target, None)
                    except FileNotFoundError:
                        pass
                    if stop_after_failure:
                        return drained
            except Exception as exc:
                logger.warning(
                    "trace_archive.outbox_drain_error",
                    root_agent_id=bundle.name,
                    path=path,
                    error=str(exc)[:200],
                )
                try:
                    os.utime(target, None)
                except OSError:
                    pass
                if stop_after_failure:
                    return drained
    return drained


def _drain_backend_outbox_periodically() -> None:
    """Bound cross-run replay across worker processes without dropping artifacts."""
    root = _outbox_root()
    root.mkdir(parents=True, exist_ok=True)
    marker = root / ".automatic-drain"
    with marker.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            handle.seek(0)
            try:
                last_attempt = float(handle.read().strip())
            except ValueError:
                last_attempt = 0.0
            now = time.time()
            if 0.0 <= now - last_attempt < 60.0:
                return
            handle.seek(0)
            handle.truncate()
            handle.write(str(now))
            handle.flush()
            os.fsync(handle.fileno())
            _drain_backend_outbox(limit=8, stop_after_failure=True)
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def store_encrypted_artifact(
    *,
    root_agent_id: str,
    path: str,
    ciphertext: bytes,
    metadata: dict[str, Any],
) -> Optional[str]:
    """Store an already-encrypted artifact locally or through the backend."""
    if _refuse_unbound_root(root_agent_id, path):
        return None
    root_agent_id = _safe_segment(root_agent_id)
    path = "/".join(_safe_segment(part) for part in path.split("/") if part)
    if not path:
        return None

    backend = os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower()
    if (_is_production() or backend == "r2") and _r2_publish_permitted(path):
        ref = _post_backend_artifact(root_agent_id=root_agent_id, path=path, ciphertext=ciphertext, metadata=metadata)
        if ref:
            return ref
        _write_outbox(root_agent_id, path, ciphertext, metadata)
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
# and a loop is running, the write is offloaded to this executor and the expected
# ref is returned immediately. Benchmark CLI, tests, and scripts keep synchronous
# read-after-write semantics. Backend failures are preserved as encrypted local
# outbox entries and retried by later archive jobs.
_ARCHIVE_WORKERS = int(os.environ.get("TRACE_ARCHIVE_WORKERS", "4") or "4")
_ARCHIVE_EXECUTOR = ThreadPoolExecutor(
    max_workers=_ARCHIVE_WORKERS,
    thread_name_prefix="trace-archive",
)
_ARCHIVE_SLOTS = threading.BoundedSemaphore(int(os.environ.get("TRACE_ARCHIVE_MAX_IN_FLIGHT", "64") or "64"))
_ARCHIVE_DROPPED_JOBS = 0
_ARCHIVE_PENDING_LOCK = threading.Lock()
_ARCHIVE_PENDING_BY_ROOT: dict[str, set[Future[None]]] = {}
# Closed-file jobs are optional early copies. Existing publishers may reclaim
# only a positively cancelled queued copy; its source remains for final drain.
_ARCHIVE_ADMISSION_LOCK = threading.RLock()
_CLOSED_FILE_FUTURES: set[Future[Optional[dict[str, str]]]] = set()


def _take_archive_slot(*, existing_publisher: bool = False) -> bool:
    with _ARCHIVE_ADMISSION_LOCK:
        if existing_publisher:
            # Cancel only optional copies that have not started. Even when a
            # slot is free, remove their FIFO backlog before original work.
            # Active I/O is never cancelled; its source stays authoritative.
            for future in tuple(_CLOSED_FILE_FUTURES):
                future.cancel()
        return _ARCHIVE_SLOTS.acquire(blocking=False)


def _closed_file_completed(future: Future[Optional[dict[str, str]]]) -> None:
    with _ARCHIVE_ADMISSION_LOCK:
        _CLOSED_FILE_FUTURES.discard(future)
        _ARCHIVE_SLOTS.release()


# Artifacts ship to the backend as base64-in-JSON; a single oversized body (e.g.
# a browser session video) freezes the Node event loop on parse/GC for minutes
# (observed: 355s backend log gap → suite-wide ConnectErrors). The limit bounds
# the encrypted (post-gzip) body; an artifact above it is rejected with an
# ERROR log and the `artifact_too_large` counter, never silently.
# Backend ingest contract: ciphertext <= 72 MiB per record (base64 <= 96 MiB);
# plaintext is only bomb-guarded (1 GiB) there, so it is never a Python limit.
_DEFAULT_MAX_ARTIFACT_BYTES = 72 * 1024 * 1024
# Match the backend batch contract: JSON body <= 96 MiB + 64 KiB framing.
_BATCH_MAX_RECORDS = 256
_BATCH_MAX_BYTES = 96 * 1024 * 1024 + 64 * 1024
_BATCH_MAX_CIPHERTEXT_BYTES = _DEFAULT_MAX_ARTIFACT_BYTES


def _publish_artifact_batch(root_agent_id: str, artifacts: list[dict[str, Any]]) -> bool:
    """Keep every encrypted pair durable until the complete batch is acknowledged."""
    for artifact in artifacts:
        _write_outbox(
            root_agent_id, artifact["path"], base64.b64decode(artifact["ciphertextB64"]), artifact["metadata"]
        )
    url = _backend_archive_url()
    api_key = _backend_api_key()
    if not url or not api_key:
        return False
    try:
        response = _backend_http_client().post(
            url.rsplit("/", 1)[0] + "/artifacts",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={"rootAgentId": root_agent_id, "artifacts": artifacts},
            # A full batch includes bounded object writes and manifest publication.
            # Keep connect/pool bounded while allowing the existing backend
            # transaction budget; strict complete ACK and outbox rules still apply.
            timeout=httpx.Timeout(120.0, connect=15.0, pool=30.0),
        )
        if response.status_code != 200:
            logger.warning("trace_archive.batch_store_failed", status=response.status_code, count=len(artifacts))
            return False
        acknowledgement = response.json().get("artifacts")
        expected_paths = {artifact["path"] for artifact in artifacts}
        if not isinstance(acknowledgement, list) or len(acknowledgement) != len(artifacts):
            return False
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get("ref"), str)
            or not item["ref"]
            or not isinstance(item.get("path"), str)
            for item in acknowledgement
        ):
            return False
        if {item["path"] for item in acknowledgement} != expected_paths:
            return False
        for artifact in artifacts:
            _delete_outbox(
                root_agent_id,
                artifact["path"],
                expected_ciphertext_sha256=artifact["metadata"]["ciphertext_sha256"],
            )
        return True
    except Exception as exc:
        logger.warning("trace_archive.batch_store_error", error_type=type(exc).__name__, count=len(artifacts))
        return False


def archive_files(*, root_agent_id: str, artifacts: Iterable[tuple[str, Path, str, Optional[bool]]]) -> bool:
    if not archive_enabled():
        return True
    if _refuse_unbound_root(root_agent_id, "files"):
        return False
    safe_root = _safe_segment(root_agent_id)
    completion: Future[None] = Future()
    _track_archive_future(safe_root, completion)
    try:
        with _archive_publication_lease(safe_root, exclusive=False):
            return _archive_files_owned(root_agent_id=safe_root, artifacts=artifacts)
    finally:
        completion.set_result(None)


def _archive_files_owned(*, root_agent_id: str, artifacts: Iterable[tuple[str, Path, str, Optional[bool]]]) -> bool:
    """Synchronously stream file encryption into bounded, individually readable batches.

    Call from a worker thread. Cancellation must not discard an accepted batch;
    callers retain their source directory until every batch is acknowledged.
    A failed batch retains the ordinary encrypted outbox pairs for existing retry.
    """
    if not archive_enabled():
        return True
    safe_root = _safe_segment(root_agent_id)
    batch: list[dict[str, Any]] = []
    # Reserve JSON framing/escaping overhead; compact serialization matches httpx.
    framing_bytes = len(json.dumps({"rootAgentId": safe_root, "artifacts": []}).encode())
    batch_bytes = framing_bytes
    all_acknowledged = True
    for path, file_path, content_type, compress in artifacts:
        safe_path = _safe_path(path)
        if not safe_path or safe_path != path or _outbox_artifact_target(Path(path)) != Path(path):
            all_acknowledged = False
            continue
        artifact_limit = min(_max_artifact_bytes(), _DEFAULT_MAX_ARTIFACT_BYTES)
        if file_path.stat().st_size > artifact_limit:
            all_acknowledged = False
            continue
        with file_path.open("rb") as source:
            body = source.read(artifact_limit + 1)
        if len(body) > artifact_limit:
            del body
            all_acknowledged = False
            continue
        encrypted = encrypt_artifact(body, path=path, content_type=content_type, compress=compress)
        del body
        if encrypted is None:
            all_acknowledged = False
            continue
        ciphertext, metadata = encrypted
        if not _r2_publication():
            if not store_encrypted_artifact(
                root_agent_id=safe_root, path=path, ciphertext=ciphertext, metadata=metadata
            ):
                all_acknowledged = False
            continue
        if len(ciphertext) > _BATCH_MAX_CIPHERTEXT_BYTES or len(json.dumps(metadata).encode()) > 8192:
            del encrypted, ciphertext
            all_acknowledged = False
            continue
        artifact = {"path": path, "ciphertextB64": base64.b64encode(ciphertext).decode("ascii"), "metadata": metadata}
        # Do not allocate another full base64-sized JSON copy just to size it.
        artifact_bytes = (
            len(artifact["ciphertextB64"])
            + len(json.dumps({**artifact, "ciphertextB64": ""}, ensure_ascii=False, separators=(",", ":")).encode())
            + 1
        )
        del encrypted, ciphertext
        if artifact_bytes + framing_bytes > _BATCH_MAX_BYTES:
            all_acknowledged = False
            continue
        if batch and (len(batch) >= _BATCH_MAX_RECORDS or batch_bytes + artifact_bytes > _BATCH_MAX_BYTES):
            if not _publish_artifact_batch(safe_root, batch):
                all_acknowledged = False
            batch = []
            batch_bytes = framing_bytes
        batch.append(artifact)
        batch_bytes += artifact_bytes
    if batch and not _publish_artifact_batch(safe_root, batch):
        all_acknowledged = False
    return all_acknowledged


_CLOSED_FILE_BYTES_LOCK = threading.Condition()
_CLOSED_FILE_BYTES_IN_FLIGHT = 0


def _closed_file_wire_reservation(path: str, size: int) -> Optional[int]:
    if _safe_path(path) != path or _outbox_artifact_target(Path(path)) != Path(path):
        return None
    if size < 0 or size > min(_max_artifact_bytes(), _DEFAULT_MAX_ARTIFACT_BYTES):
        return None
    return ((size + size // 16 + 65_536 + 18) // 3) * 4 + 8192 + len(path.encode()) * 6 + 1024


def closed_file_archive_reservation(path: str, file_path: Path) -> Optional[int]:
    """Conservative wire bound for one closed file; no source body is queued."""
    try:
        return _closed_file_wire_reservation(path, file_path.stat().st_size)
    except OSError:
        return None


def archive_closed_files_in_background(
    *, root_agent_id: str, artifacts: list[tuple[str, Path, str, Optional[bool]]]
) -> Optional[Future[Optional[dict[str, str]]]]:
    """Copy a bounded closed-file batch on the existing executor and slot limit.

    Return hashes only after its complete native ACK. Original files and failed
    encrypted outbox pairs stay available for ordinary terminal publication.
    """
    if not archive_enabled() or not artifacts or len(artifacts) > _BATCH_MAX_RECORDS:
        return None
    if len({path for path, *_ in artifacts}) != len(artifacts):
        return None
    if _refuse_unbound_root(root_agent_id, "files"):
        return None
    safe_root = _safe_segment(root_agent_id)

    def publish() -> Optional[dict[str, str]]:
        global _CLOSED_FILE_BYTES_IN_FLIGHT
        reserved = 0
        claimed = False
        try:
            sizes = []
            for path, file_path, _, _ in artifacts:
                size = file_path.stat().st_size
                estimate = _closed_file_wire_reservation(path, size)
                if estimate is None:
                    return None
                reserved += estimate
                sizes.append(size)
            if reserved > _BATCH_MAX_BYTES:
                return None
            with _CLOSED_FILE_BYTES_LOCK:
                _CLOSED_FILE_BYTES_LOCK.wait_for(lambda: _CLOSED_FILE_BYTES_IN_FLIGHT + reserved <= _BATCH_MAX_BYTES)
                _CLOSED_FILE_BYTES_IN_FLIGHT += reserved
                claimed = True
            batch = []
            hashes = {}
            for (path, file_path, content_type, compress), size in zip(artifacts, sizes):
                with file_path.open("rb") as source:
                    body = source.read(size + 1)
                if len(body) != size:
                    return None
                encrypted = encrypt_artifact(body, path=path, content_type=content_type, compress=compress)
                del body
                if encrypted is None:
                    return None
                ciphertext, metadata = encrypted
                if len(ciphertext) > _BATCH_MAX_CIPHERTEXT_BYTES or len(json.dumps(metadata).encode()) > 8192:
                    return None
                batch.append(
                    {"path": path, "ciphertextB64": base64.b64encode(ciphertext).decode("ascii"), "metadata": metadata}
                )
                hashes[path] = str(metadata["plaintext_sha256"])
                del encrypted, ciphertext
            if len(json.dumps({"rootAgentId": safe_root, "artifacts": batch}).encode()) > _BATCH_MAX_BYTES:
                return None
            if _r2_publication():
                with _archive_publication_lease(safe_root, exclusive=False):
                    acknowledged = _publish_artifact_batch(safe_root, batch)
            else:
                acknowledged = all(
                    store_encrypted_artifact(
                        root_agent_id=safe_root,
                        path=item["path"],
                        ciphertext=base64.b64decode(item["ciphertextB64"]),
                        metadata=item["metadata"],
                    )
                    is not None
                    for item in batch
                )
            return hashes if acknowledged else None
        except Exception as exc:
            logger.warning("trace_archive.closed_file_error", error_type=type(exc).__name__)
            return None
        finally:
            if claimed:
                with _CLOSED_FILE_BYTES_LOCK:
                    _CLOSED_FILE_BYTES_IN_FLIGHT -= reserved
                    _CLOSED_FILE_BYTES_LOCK.notify_all()

    with _ARCHIVE_ADMISSION_LOCK:
        # Optional early copies must not build a second executor backlog.
        # Skip overflow descriptors; the ordinary final source walk retains them.
        if len(_CLOSED_FILE_FUTURES) >= _ARCHIVE_WORKERS or not _take_archive_slot():
            return None
        try:
            future = _ARCHIVE_EXECUTOR.submit(publish)
        except Exception:
            _ARCHIVE_SLOTS.release()
            raise
        _CLOSED_FILE_FUTURES.add(future)
        future.add_done_callback(_closed_file_completed)
    _track_archive_future(safe_root, future)
    return future


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
    if (_is_production() or backend == "r2") and _r2_publish_permitted(log=False):
        return f"trace-archive/{safe_root}/{safe_path}"
    return str(_local_root() / safe_root / safe_path)


def _track_archive_future(root_agent_id: str, future: Future[None]) -> None:
    with _ARCHIVE_PENDING_LOCK:
        _ARCHIVE_PENDING_BY_ROOT.setdefault(root_agent_id, set()).add(future)

    def _remove(completed: Future[None]) -> None:
        with _ARCHIVE_PENDING_LOCK:
            pending = _ARCHIVE_PENDING_BY_ROOT.get(root_agent_id)
            if pending is None:
                return
            pending.discard(completed)
            if not pending:
                _ARCHIVE_PENDING_BY_ROOT.pop(root_agent_id, None)

    future.add_done_callback(_remove)


def _pending_archive_futures(root_agent_id: str) -> set[Future[None]]:
    with _ARCHIVE_PENDING_LOCK:
        return set(_ARCHIVE_PENDING_BY_ROOT.get(_safe_segment(root_agent_id), set()))


def _outbox_artifact_target(item: Path) -> Optional[Path]:
    """Map a durable outbox file to the artifact pair it can publish."""
    if item.name.endswith(".meta.json"):
        return None
    transaction_target = _artifact_transaction_target(item)
    if transaction_target is not None:
        return transaction_target
    return None if _is_artifact_transaction_temporary(item) else item


def _root_outbox_has_artifacts(root_agent_id: str) -> bool:
    bundle = _outbox_root() / _safe_segment(root_agent_id)
    if not bundle.exists():
        return False
    return any(item.is_file() and _outbox_artifact_target(item) is not None for item in bundle.rglob("*"))


def flush_archive_writes(root_agent_id: str, timeout_s: float = 25.0) -> bool:
    """Wait for locally accepted writes, then retry this run's durable outbox.

    The wait is run from a worker thread by terminal lifecycle activities, never
    on the event loop. It is a first-line ordering barrier only: another worker
    process can still own writes for the same root, so the backend manifest
    reconciliation fence remains authoritative.
    """
    safe_root = _safe_segment(root_agent_id)
    deadline = time.monotonic() + max(0.0, timeout_s)
    while True:
        pending = _pending_archive_futures(safe_root)
        if not pending:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        _, unfinished = wait(pending, timeout=remaining)
        if unfinished:
            return False

    if _r2_publication():
        with _archive_publication_lease(safe_root, exclusive=True, deadline=deadline) as acquired:
            if not acquired:
                return False
            while _root_outbox_has_artifacts(safe_root):
                if time.monotonic() >= deadline:
                    return False
                if (
                    _drain_backend_outbox(
                        limit=64, root_agent_id=safe_root, deadline=deadline, _publication_lease_held=True
                    )
                    == 0
                ):
                    return False
    return True


def _count(name: str) -> int:
    from helpers.llm_archive_record import increment_counter

    return increment_counter(name)


def _refuse_unbound_root(root_agent_id: Any, path: str) -> bool:
    """Every artifact belongs to a real root bundle; never write `unbound`."""
    from helpers.llm_archive_record import is_bound_id

    if is_bound_id(root_agent_id) and _safe_segment(str(root_agent_id)) != "unbound":
        return False
    refused = _count("unbound_refused")
    logger.error("trace_archive.unbound_refused", path=_safe_path(path), root_agent_id=root_agent_id, refused=refused)
    return True


def _encrypt_within_limit(
    *, root_agent_id: str, path: str, body: bytes, content_type: str, compress: Optional[bool]
) -> Optional[tuple[bytes, dict[str, Any]]]:
    encrypted = encrypt_artifact(body, path=path, content_type=content_type, compress=compress)
    if encrypted is None:
        return None
    ciphertext, metadata = encrypted
    # The limit bounds the encrypted wire body the backend must parse, so it is
    # measured after compression: a large JSON trace that compresses below it
    # is archived in full. Anything still above it is a loud, counted error.
    limit = _max_artifact_bytes()
    if len(ciphertext) > limit:
        count = _count("artifact_too_large")
        logger.error(
            "trace_archive.artifact_too_large",
            root_agent_id=_safe_segment(root_agent_id),
            path=_safe_path(path),
            plaintext_bytes=len(body),
            ciphertext_bytes=len(ciphertext),
            limit=limit,
            rejected=count,
        )
        return None
    return ciphertext, metadata


def _archive_bytes_now(
    *,
    root_agent_id: str,
    path: str,
    body: bytes,
    content_type: str,
    compress: Optional[bool],
) -> Optional[dict[str, Any]]:
    encrypted = _encrypt_within_limit(
        root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=compress
    )
    if encrypted is None:
        return None
    ciphertext, metadata = encrypted
    ref = store_encrypted_artifact(root_agent_id=root_agent_id, path=path, ciphertext=ciphertext, metadata=metadata)
    if not ref:
        return None
    return {"ref": ref, "metadata": metadata}


def _spill_archive_job(
    *,
    root_agent_id: str,
    path: str,
    content_type: str,
    body_factory: Callable[[], bytes],
    compress: Optional[bool],
) -> Optional[dict[str, Any]]:
    """Queue full: persist durably now instead of dropping the artifact.

    R2 mode writes the encrypted pair to the durable outbox, which the root's
    next successful publish and its terminal flush drain; local mode writes the
    artifact directly. No network I/O happens on the caller's thread.
    """
    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    body = body_factory()
    encrypted = _encrypt_within_limit(
        root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=compress
    )
    if encrypted is None:
        return None
    ciphertext, metadata = encrypted
    if (_is_production() or os.environ.get("TRACE_ARCHIVE_BACKEND", "").strip().lower() == "r2") and (
        _r2_publish_permitted(path)
    ):
        _write_outbox(safe_root, safe_path, ciphertext, metadata)
    else:
        _write_local(safe_root, safe_path, ciphertext, metadata)
    spilled = _count("queue_spilled")
    if spilled == 1 or spilled & (spilled - 1) == 0:
        logger.warning("trace_archive.queue_spilled", root_agent_id=safe_root, path=safe_path, spilled_jobs=spilled)
    return {"ref": _expected_ref(safe_root, safe_path), "metadata": metadata}


def _submit_archive_job(
    *,
    root_agent_id: str,
    path: str,
    content_type: str,
    body_factory: Callable[[], bytes],
    compress: Optional[bool],
) -> Optional[dict[str, Any]]:
    global _ARCHIVE_DROPPED_JOBS

    safe_root = _safe_segment(root_agent_id)
    safe_path = _safe_path(path)
    if not safe_path:
        return None

    drain_backend_outbox_after_success = _r2_publication()
    # Never block the agent event loop on a queue slot (at 65+ concurrent jobs
    # a blocking acquire starved the loop and delayed a 45s recording timeout
    # to 142s). Overflow is no longer dropped: it is encrypted and persisted
    # to the durable outbox (or local archive) without network I/O.
    if not _take_archive_slot(existing_publisher=True):
        _ARCHIVE_DROPPED_JOBS += 1
        return _spill_archive_job(
            root_agent_id=root_agent_id,
            path=path,
            content_type=content_type,
            body_factory=body_factory,
            compress=compress,
        )

    def _job() -> None:
        try:
            body = body_factory()
            result = _archive_bytes_now(
                root_agent_id=root_agent_id,
                path=path,
                body=body,
                content_type=content_type,
                compress=compress,
            )
            if result is not None and drain_backend_outbox_after_success:
                # Drain only this root: the backend may belong to an isolated
                # run, and retired roots retain finalization locks or permanent
                # errors that turn cross-root retries into a backlog storm.
                _drain_backend_outbox(root_agent_id=safe_root)
        except Exception as exc:
            logger.warning(
                "trace_archive.async_write_error", root_agent_id=safe_root, path=safe_path, error=str(exc)[:200]
            )
        finally:
            _ARCHIVE_SLOTS.release()

    try:
        future = _ARCHIVE_EXECUTOR.submit(_job)
        _track_archive_future(safe_root, future)
    except Exception:
        _ARCHIVE_SLOTS.release()
        raise
    return {"ref": _expected_ref(safe_root, safe_path), "metadata": None}


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
    if _refuse_unbound_root(root_agent_id, path):
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
    return _submit_archive_job(
        root_agent_id=root_agent_id,
        path=path,
        content_type=content_type,
        body_factory=lambda: body,
        compress=compress,
    )


def archive_json(
    *,
    root_agent_id: str,
    path: str,
    payload: Any,
    content_type: str = "application/json",
) -> Optional[dict[str, Any]]:
    body = json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
    return archive_bytes(root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=True)


def archive_json_deferred(
    *,
    root_agent_id: str,
    path: str,
    payload_factory: Callable[[], Any],
    content_type: str = "application/json",
) -> Optional[dict[str, Any]]:
    if not archive_enabled():
        return None
    if _refuse_unbound_root(root_agent_id, path):
        return None
    in_loop = True
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        in_loop = False

    def _body() -> bytes:
        payload = payload_factory()
        return json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")

    if not in_loop or not _async_writes_enabled():
        body = _body()
        return archive_bytes(
            root_agent_id=root_agent_id, path=path, body=body, content_type=content_type, compress=True
        )
    return _submit_archive_job(
        root_agent_id=root_agent_id,
        path=path,
        content_type=content_type,
        body_factory=_body,
        compress=True,
    )
