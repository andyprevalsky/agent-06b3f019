"""
Attachment handling utilities for agent context.

Handles resolving FilePointers to multimodal content for LLM messages.
"""

import base64
import httpx
import logging
import uuid
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass
from datetime import datetime

from config import load_config

logger = logging.getLogger(__name__)

# File type categories
IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
PDF_MIME_TYPES = {"application/pdf"}
TEXT_MIME_TYPES = {
    "text/plain", "text/csv", "text/markdown", "text/html",
    "application/json", "application/xml",
    "text/javascript", "text/typescript", "text/python",
    "application/javascript", "application/typescript",
}

# Size threshold for inline content sent to LLM (20MB)
INLINE_THRESHOLD = 20 * 1024 * 1024


@dataclass
class FilePointer:
    """Represents a file attachment reference. All files stored in Supabase Storage."""
    id: str
    storage_path: str  # All files stored in storage
    original_filename: str
    mime_type: str
    size_bytes: int
    created_at: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FilePointer":
        return cls(
            id=data.get("id", ""),
            storage_path=data.get("storage_path", ""),
            original_filename=data.get("original_filename", ""),
            mime_type=data.get("mime_type", ""),
            size_bytes=data.get("size_bytes", 0),
            created_at=data.get("created_at", ""),
        )

    def is_image(self) -> bool:
        return self.mime_type in IMAGE_MIME_TYPES

    def is_pdf(self) -> bool:
        return self.mime_type in PDF_MIME_TYPES

    def is_text(self) -> bool:
        return self.mime_type in TEXT_MIME_TYPES or self.mime_type.startswith("text/")

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
) -> Dict[str, Any]:
    """
    Upload a file to Supabase Storage and return a FilePointer dict.

    Args:
        user_id: User ID for storage path prefix
        file_content: Raw file bytes
        filename: Original filename
        mime_type: MIME type of the file

    Returns:
        FilePointer dict with id, storage_path, original_filename, mime_type, size_bytes, created_at
    """
    config = load_config()
    supabase_url = config.supabase.url
    supabase_key = config.supabase.service_role_key

    if not supabase_key:
        raise ValueError("Missing SUPABASE_SERVICE_ROLE_KEY environment variable")

    # Generate storage path: {user_id}/{uuid}_{safe_filename}
    file_id = str(uuid.uuid4())
    safe_filename = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
    storage_path = f"{user_id}/{file_id}_{safe_filename}"

    url = f"{supabase_url}/storage/v1/object/attachments/{storage_path}"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {supabase_key}",
                "Content-Type": mime_type,
            },
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


def build_attachment_metadata_text(file_pointer: FilePointer) -> str:
    """Build metadata text for files that can't be read directly by LLM."""
    size_kb = file_pointer.size_bytes / 1024
    size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb/1024:.1f} MB"

    return f"""[Attached file: {file_pointer.original_filename}]
- Type: {file_pointer.mime_type}
- Size: {size_str}
- Note: This file cannot be directly read by the AI, but browser_agent and code_agent have full access to download and use it."""


async def resolve_attachments_for_llm(
    attachments: List[FilePointer],
    file_cache: Optional[Dict[str, bytes]] = None,
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
                # Image: inject as image_url content block
                base64_data = base64.b64encode(content).decode("utf-8")
                content_blocks.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{fp.mime_type};base64,{base64_data}"
                    }
                })
            elif fp.is_pdf():
                # PDF: inject as file content block (for capable models)
                base64_data = base64.b64encode(content).decode("utf-8")
                content_blocks.append({
                    "type": "file",
                    "file": {
                        "filename": fp.original_filename,
                        "file_data": f"data:{fp.mime_type};base64,{base64_data}"
                    }
                })
            elif fp.is_text():
                # Text: inject as text content
                try:
                    text_content = content.decode("utf-8")
                    metadata_texts.append(f"[File: {fp.original_filename}]\n```\n{text_content}\n```")
                except UnicodeDecodeError:
                    metadata_texts.append(build_attachment_metadata_text(fp))

        except Exception as e:
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

    content_blocks, metadata_texts = await resolve_attachments_for_llm(attachments, file_cache)

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
