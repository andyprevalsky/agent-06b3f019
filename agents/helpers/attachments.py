"""
Attachment handling utilities for agent context.

Handles resolving FilePointers to multimodal content for LLM messages.
"""

import base64
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import httpx
from temporalio import activity

from config import load_config
from helpers.attachment_context import AttachmentContextLimitError, PreparedTextAttachment, admit_text_attachments
from helpers.model_info import _DEFAULT_CONTEXT_WINDOW

logger = logging.getLogger(__name__)

# File type categories
IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
PDF_MIME_TYPES = {"application/pdf"}
TEXT_MIME_TYPES = {
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
    "application/json",
    "application/xml",
    "text/javascript",
    "text/typescript",
    "text/python",
    "application/javascript",
    "application/typescript",
}

# Size threshold for inline content sent to LLM (20MB)
INLINE_THRESHOLD = 20 * 1024 * 1024

# Same wording as AUTO_CAPTURED_SCREENSHOT_NOTE in back-end/src/providers/chat/chatMultimodal.ts.
AUTO_CAPTURED_SCREENSHOT_NOTE = (
    "Rose captured this screenshot of the user's screen automatically when they opened the "
    "quick launcher; the user did not choose to attach it, and it may not be relevant to their request."
)


@dataclass
class FilePointer:
    """Represents a file attachment reference. All files stored in Supabase Storage."""

    id: str
    storage_path: str  # All files stored in storage
    original_filename: str
    mime_type: str
    size_bytes: int
    created_at: str
    # Set by the Mac quick launcher on the screenshot it attaches automatically.
    auto_captured: bool = False

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FilePointer":
        return cls(
            id=data.get("id", ""),
            storage_path=data.get("storage_path", ""),
            original_filename=data.get("original_filename", ""),
            mime_type=data.get("mime_type", ""),
            size_bytes=data.get("size_bytes", 0),
            created_at=data.get("created_at", ""),
            auto_captured=data.get("auto_captured") is True,
        )

    def to_dict(self) -> Dict[str, Any]:
        """Backend FilePointer shape; ``auto_captured`` only when set."""
        data = asdict(self)
        if not self.auto_captured:
            del data["auto_captured"]
        return data

    def is_image(self) -> bool:
        return self.mime_type in IMAGE_MIME_TYPES

    def is_pdf(self) -> bool:
        return self.mime_type in PDF_MIME_TYPES

    # Extensions treated as text when mime_type is ambiguous (e.g. application/octet-stream)
    _TEXT_EXTENSIONS = {
        ".csv",
        ".txt",
        ".md",
        ".json",
        ".xml",
        ".html",
        ".js",
        ".ts",
        ".py",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".cfg",
        ".log",
        ".sql",
    }

    def is_text(self) -> bool:
        if self.mime_type in TEXT_MIME_TYPES or self.mime_type.startswith("text/"):
            return True
        # Fallback: check file extension when mime_type is generic
        # NOTE: avoid os.path — this runs inside Temporal's workflow sandbox
        if self.mime_type == "application/octet-stream" and self.original_filename:
            dot_idx = self.original_filename.rfind(".")
            ext = self.original_filename[dot_idx:].lower() if dot_idx >= 0 else ""
            return ext in self._TEXT_EXTENSIONS
        return False

    def is_small_enough_for_llm(self) -> bool:
        """Check if file is small enough to send full content to LLM."""
        return self.size_bytes < INLINE_THRESHOLD

    def can_be_read_by_llm(self) -> bool:
        """Check if LLM can read this file type."""
        return self.is_image() or self.is_pdf() or self.is_text()


async def download_from_storage(storage_path: str) -> bytes:
    """Download a file from Supabase Storage."""
    config = load_config()
    supabase_url = config.supabase.url
    supabase_key = config.supabase.service_role_key

    if not supabase_key:
        raise ValueError("Missing SUPABASE_SERVICE_ROLE_KEY environment variable")

    url = f"{supabase_url}/storage/v1/object/attachments/{storage_path}"

    async with httpx.AsyncClient() as client:
        response = await client.get(
            url,
            headers={
                "Authorization": f"Bearer {supabase_key}",
            },
            timeout=60.0,
        )
        response.raise_for_status()
        return response.content


async def upload_to_storage(
    user_id: str,
    file_content: bytes,
    filename: str,
    mime_type: str,
    *,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Upload a file to Supabase Storage and return a FilePointer dict.

    Args:
        user_id: User ID for storage path prefix
        file_content: Raw file bytes
        filename: Original filename
        mime_type: MIME type of the file
        idempotency_key: Optional caller-scoped key for a deterministic object
            path. Repeated uploads with this key overwrite the same object.

    Returns:
        FilePointer dict with id, storage_path, original_filename, mime_type, size_bytes, created_at
    """
    config = load_config()
    supabase_url = config.supabase.url
    supabase_key = config.supabase.service_role_key

    if not supabase_key:
        raise ValueError("Missing SUPABASE_SERVICE_ROLE_KEY environment variable")

    # Generate storage path: {user_id}/{uuid}_{safe_filename}
    file_id = (
        str(uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key))
        if idempotency_key
        else str(uuid.uuid4())
    )
    safe_filename = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
    storage_path = f"{user_id}/{file_id}_{safe_filename}"

    url = f"{supabase_url}/storage/v1/object/attachments/{storage_path}"

    headers = {
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": mime_type,
    }
    if idempotency_key:
        headers["x-upsert"] = "true"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            headers=headers,
            content=file_content,
            timeout=60.0,
        )
        response.raise_for_status()

    logger.info(f"[Storage] Uploaded {filename} to {storage_path} ({len(file_content)} bytes)")

    return {
        "id": file_id,
        "storage_path": storage_path,
        "original_filename": filename,
        "mime_type": mime_type,
        "size_bytes": len(file_content),
        "created_at": datetime.utcnow().isoformat() + "Z",
    }


async def get_file_content(file_pointer: FilePointer) -> bytes:
    """Get the content of a file pointer (download from storage)."""
    return await download_from_storage(file_pointer.storage_path)


# Module-level cache for file downloads (cleared between agent runs)
_file_cache: Dict[str, Tuple[bytes, Dict[str, Any]]] = {}


def clear_file_cache() -> None:
    """Clear the module-level file cache."""
    global _file_cache
    _file_cache.clear()
    logger.debug("File cache cleared")


def get_cached_file(file_id: str) -> Optional[Tuple[bytes, Dict[str, Any]]]:
    """Get file from module-level cache (no I/O). Returns None if not cached."""
    return _file_cache.get(file_id)


async def get_file_from_pointer(
    fp: FilePointer,
    cache: Optional[Dict[str, Tuple[bytes, Dict[str, Any]]]] = None,
) -> Tuple[bytes, Dict[str, Any]]:
    """
    Download file with caching. Returns (content_bytes, metadata_dict).

    The cache avoids re-downloading the same file multiple times within an agent run.
    If cache is None, uses the module-level cache.

    Returns:
        Tuple of (file_content_bytes, metadata_dict)
        metadata_dict contains: file_name, file_type, file_size, file_id
    """
    if cache is None:
        cache = _file_cache

    if fp.id in cache:
        logger.debug(f"Cache hit for file {fp.original_filename} (id={fp.id})")
        return cache[fp.id]

    logger.debug(f"Downloading file {fp.original_filename} (id={fp.id})")
    content = await get_file_content(fp)

    metadata = {
        "file_name": fp.original_filename,
        "file_type": fp.mime_type,
        "file_size": fp.size_bytes,
        "file_id": fp.id,
    }

    result = (content, metadata)
    cache[fp.id] = result

    return result


def extract_attachments_from_context(context: List[Dict]) -> List[FilePointer]:
    """Extract all file attachments from message context.

    File attachments are stored in the filePointer field of each message.
    Each message with a file has its own filePointer (OAI-style).
    """
    attachments = []
    for msg in context:
        # Check for filePointer field (new format - each file is a separate message)
        file_pointer = msg.get("filePointer") or msg.get("file_pointer")
        if isinstance(file_pointer, dict) and file_pointer.get("storage_path"):
            attachments.append(FilePointer.from_dict(file_pointer))
    return attachments


def build_attachment_metadata_text(
    file_pointer: FilePointer,
    *,
    inlined: bool = False,
) -> str:
    """Build file_pointer metadata with an explicit ``original_filename`` key.

    Spawn tools require exact ``original_filename`` values in ``attachments``.
    Emit that field as a keyed line (not a prose/body tag) so the parent can
    copy it into spawn_agent.attachments without inventing names like
    ``image.jpg``.
    """
    size_kb = file_pointer.size_bytes / 1024
    size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb / 1024:.1f} MB"
    if inlined:
        note = (
            "Shown inline above. Pass this original_filename in spawn_agent.attachments "
            "when the child needs the file."
        )
    else:
        note = (
            "Not inlined for the parent LLM; browser_agent and code_agent can still "
            "download and use it when given this original_filename."
        )

    text = (
        "file_pointer:\n"
        f"  original_filename: {file_pointer.original_filename}\n"
        f"  mime_type: {file_pointer.mime_type}\n"
        f"  size: {size_str}\n"
        f"  note: {note}"
    )
    if file_pointer.auto_captured:
        text += f"\n  auto_captured: {AUTO_CAPTURED_SCREENSHOT_NOTE}"
    return text


def build_file_pointer_label(original_filename: str) -> str:
    """Minimal keyed file_pointer block (filename only)."""
    return f"file_pointer:\n  original_filename: {original_filename}"


def build_attachment_text_content(file_pointer: FilePointer, text_content: str) -> str:
    """Keyed file_pointer block with inlined text body under ``content``."""
    return (
        "file_pointer:\n"
        f"  original_filename: {file_pointer.original_filename}\n"
        f"  mime_type: {file_pointer.mime_type}\n"
        f"  content:\n```\n{text_content}\n```"
    )


async def resolve_attachments_for_llm(
    attachments: List[FilePointer],
    file_cache: Optional[Dict[str, bytes]] = None,
    *,
    max_context_tokens: int = _DEFAULT_CONTEXT_WINDOW,
    request_overhead: Any = None,
    require_inline: bool = False,
) -> Tuple[List[Dict], List[str]]:
    cache = file_cache if file_cache is not None else {}

    async def render(render_text):
        return await _render_attachments_for_llm(attachments, cache, render_text, require_inline)

    return await admit_text_attachments(
        render, max_context_tokens=max_context_tokens, request_overhead=request_overhead, require_inline=require_inline
    )


async def _render_attachments_for_llm(
    attachments: List[FilePointer],
    file_cache: Optional[Dict[str, bytes]] = None,
    render_text: Callable[[PreparedTextAttachment], str] = lambda item: item.inline,
    require_inline: bool = False,
) -> Tuple[List[Dict], List[str]]:
    """
    Resolve file attachments to LLM content blocks.

    Returns:
        - List of content blocks (for multimodal messages)
        - List of metadata texts (for files that can't be read by LLM)
    """
    content_blocks = []
    metadata_texts = []

    if file_cache is None:
        file_cache = {}

    for fp in attachments:
        # Large files or binary files -> metadata only
        if not fp.is_small_enough_for_llm() or not fp.can_be_read_by_llm():
            if require_inline:
                raise AttachmentContextLimitError(f"Required text attachment cannot be inlined: {fp.original_filename}")
            metadata_texts.append(build_attachment_metadata_text(fp))
            continue

        try:
            # Get file content (from cache or download)
            cache_key = fp.id
            if cache_key in file_cache:
                content = file_cache[cache_key]
            else:
                content = await get_file_content(fp)
                file_cache[cache_key] = content

            if fp.is_image():
                # Image: inject as image_url content block AND keep the filename
                # label so spawn_agent.attachments can use exact original_filename.
                base64_data = base64.b64encode(content).decode("utf-8")
                content_blocks.append(
                    {"type": "image_url", "image_url": {"url": f"data:{fp.mime_type};base64,{base64_data}"}}
                )
                metadata_texts.append(build_attachment_metadata_text(fp, inlined=True))
            elif fp.is_pdf():
                # PDF: inject as file content block (for capable models)
                base64_data = base64.b64encode(content).decode("utf-8")
                content_blocks.append(
                    {
                        "type": "file",
                        "file": {
                            "filename": fp.original_filename,
                            "file_data": f"data:{fp.mime_type};base64,{base64_data}",
                        },
                    }
                )
            elif fp.is_text():
                # Text: inject as text content with the same keyed filename field
                try:
                    text_content = content.decode("utf-8")
                    metadata_texts.append(render_text(PreparedTextAttachment(
                        build_attachment_text_content(fp, text_content), build_attachment_metadata_text(fp), fp.original_filename
                    )))
                except UnicodeDecodeError:
                    if require_inline:
                        raise AttachmentContextLimitError(f"Required text attachment is not UTF-8: {fp.original_filename}")
                    metadata_texts.append(build_attachment_metadata_text(fp))

        except Exception as e:
            if require_inline:
                raise AttachmentContextLimitError(f"Required text attachment could not be read: {fp.original_filename}") from e
            logger.warning(f"Failed to resolve attachment {fp.original_filename}: {e}")
            metadata_texts.append(build_attachment_metadata_text(fp))

    return content_blocks, metadata_texts


async def build_multimodal_user_message(
    text: str,
    attachments: List[FilePointer],
    file_cache: Optional[Dict[str, bytes]] = None,
) -> Dict:
    """
    Build a multimodal user message with text and attachments.

    Returns an OpenAI-compatible message dict with content array.
    """
    if not attachments:
        return {"role": "user", "content": text}

    content_blocks, metadata_texts = await resolve_attachments_for_llm(attachments, file_cache, request_overhead={"role": "user", "content": text})

    # Build the content array
    content = []

    # Add main text
    full_text = text
    if metadata_texts:
        full_text = text + "\n\n" + "\n\n".join(metadata_texts)

    content.append({"type": "text", "text": full_text})

    # Add image/file content blocks
    content.extend(content_blocks)

    return {"role": "user", "content": content}


def has_pdf_attachments(context: List[Dict]) -> bool:
    """Check if any message in context has PDF attachments."""
    attachments = extract_attachments_from_context(context)
    return any(fp.is_pdf() for fp in attachments)


def get_attachment_system_prompt_addition() -> str:
    """Get the system prompt addition for attachment handling."""
    return """
When the user attaches files:
- Images and PDFs: You can see and analyze these directly
- Text files: You can read the full content
- Other files (docx, xlsx, zip, etc): You receive metadata only, but browser_agent and code_agent can download and use the full file. Direct them to work with these files as needed.
"""


def extract_file_pointer_dicts(context: List[Dict]) -> List[Dict]:
    """Extract unique, eligible file pointer dicts from context.

    Call this in workflow context (cheap, no I/O) to get a small payload
    that can be passed to resolve_attachments_activity without exceeding
    Temporal's 2MB payload limit.
    """
    seen: Set[str] = set()
    result: List[Dict] = []

    for msg in context:
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        metadata = msg.get("metadata", {}) or {}
        attachments_data = metadata.get("attachments", []) if isinstance(metadata, dict) else []

        if file_pointer and isinstance(file_pointer, dict):
            attachments_data = [file_pointer] + list(attachments_data)

        for att_data in attachments_data:
            if not isinstance(att_data, dict):
                continue
            fp = FilePointer.from_dict(att_data)
            if not fp.id or fp.id in seen:
                continue
            seen.add(fp.id)

            if not fp.is_small_enough_for_llm() or not fp.can_be_read_by_llm():
                continue

            result.append(att_data)

    return result


@activity.defn
async def fetch_parent_attachments_activity(parent_agent_id: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Fetch parent agent's attachment metadata from the backend for sub-agent context propagation.

    Returns a serialisable dict with two sub-dicts:
        {"filename_to_pointer": {...}, "all_pointers_by_id": {...}}
    """
    config = load_config()
    backend_url = config.backend.api_url.rstrip("/")
    api_key = config.backend.api_key
    if not api_key:
        raise ValueError("BACKEND_API_KEY not configured")

    filename_to_pointer: Dict[str, Any] = {}
    all_pointers_by_id: Dict[str, Any] = {}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{backend_url}/api/agents/{parent_agent_id}",
                headers={"X-API-Key": api_key},
            )
            response.raise_for_status()
            parent_data = response.json()
            parent_messages = parent_data.get("messages", [])

            file_pointers = extract_attachments_from_context(parent_messages)
            for fp in file_pointers:
                fp_dict = fp.to_dict()
                filename_to_pointer[fp.original_filename] = fp_dict
                if fp.id:
                    all_pointers_by_id[fp.id] = fp_dict

            logger.info(
                "Extracted parent attachments",
                extra={
                    "parent_agent_id": parent_agent_id,
                    "attachment_count": len(file_pointers),
                },
            )
    except Exception as e:
        logger.warning(f"Failed to fetch parent attachments: {e}")

    return {"filename_to_pointer": filename_to_pointer, "all_pointers_by_id": all_pointers_by_id}


@activity.defn
async def resolve_attachments_activity(file_pointers: List[Dict]) -> List[str]:
    """
    Pre-download eligible file attachments into module-level cache.

    Runs inside a Temporal activity so httpx is available.
    Accepts a list of FilePointer dicts (extracted in workflow via extract_file_pointer_dicts).
    Returns list of resolved file IDs (tiny payload). The actual file bytes
    live in _file_cache which is shared with workflow context via sandbox passthrough.
    """
    resolved_ids: List[str] = []

    for att_data in file_pointers:
        fp = FilePointer.from_dict(att_data)

        try:
            await get_file_from_pointer(fp)  # populates _file_cache
            resolved_ids.append(fp.id)
            activity.heartbeat(f"Resolved {fp.original_filename}")
        except Exception as e:
            logger.warning(f"Failed to pre-download {fp.original_filename}: {e}")

    logger.info(f"[Attachments] Pre-resolved {len(resolved_ids)} files for LLM context")
    return resolved_ids
