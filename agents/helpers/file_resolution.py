"""
File resolution utilities for structured output.

Handles resolving partial file pointers (relative paths) from cloud agents
to full FilePointer objects (with storage URLs).

## File Pointer Types

1. **file_pointer** (full): Used by main agent and spawn_sub_agent verifiers.
   Contains all fields: id, storage_path, original_filename, mime_type, size_bytes, created_at.
   Files are already uploaded to Supabase storage.

2. **session_file_pointer** (partial): Used by cloud agent verifiers (spawn_claude_code_agent, spawn_browser_agent).
   Contains only: path (absolute path in remote session, e.g., "/home/user/output/report.pdf").
   The activity downloads the file from the remote session and uploads to Supabase,
   then converts session_file_pointer -> file_pointer.

## Schema Transformation Flow

1. Parent agent calls spawn_claude_code_agent with output_schema containing file_pointer fields
2. transform_schema_for_remote_session() converts file_pointer -> session_file_pointer
3. Remote verifier extracts session_file_pointer (just the path)
4. Activity downloads file from remote, uploads to Supabase
5. resolve_file_pointers_from_extracted() converts session_file_pointer -> file_pointer
6. Full file_pointer returned to parent agent
"""

import uuid
import copy
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional
from dataclasses import dataclass, asdict

import structlog

from .attachments import FilePointer


logger = structlog.get_logger(__name__)


# ============================================================================
# Schema Transformation for Remote Sessions
# ============================================================================


def transform_schema_for_remote_session(output_schema: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Transform output_schema for use in remote session verifiers.

    Converts 'file_pointer' -> 'session_file_pointer' so the remote verifier
    only extracts the file path (not full FilePointer metadata which doesn't exist yet).

    Args:
        output_schema: Original output schema with file_pointer fields

    Returns:
        Transformed schema with session_file_pointer fields
    """
    if not output_schema or "fields" not in output_schema:
        return output_schema

    transformed = copy.deepcopy(output_schema)

    for field in transformed.get("fields", []):
        if field.get("type") == "file_pointer":
            field["type"] = "session_file_pointer"
        elif field.get("type") == "list[file_pointer]":
            field["type"] = "list[session_file_pointer]"

    return transformed


def restore_schema_from_remote_session(output_schema: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Restore output_schema from remote session format back to normal format.

    Converts 'session_file_pointer' -> 'file_pointer' after the activity has
    resolved the file paths to full FilePointer objects.

    Args:
        output_schema: Schema with session_file_pointer fields

    Returns:
        Original schema with file_pointer fields
    """
    if not output_schema or "fields" not in output_schema:
        return output_schema

    restored = copy.deepcopy(output_schema)

    for field in restored.get("fields", []):
        if field.get("type") == "session_file_pointer":
            field["type"] = "file_pointer"
        elif field.get("type") == "list[session_file_pointer]":
            field["type"] = "list[file_pointer]"

    return restored


@dataclass
class PartialFilePointer:
    """
    Partial file pointer returned by cloud agents.
    Contains relative path to file in agent workspace.
    """
    path: str  # Relative path in agent workspace (e.g., "output/report.pdf")
    original_filename: Optional[str] = None  # Optional - derived from path if not provided
    mime_type: Optional[str] = None  # Optional - derived from extension if not provided

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Optional["PartialFilePointer"]:
        """Create from dict if it looks like a partial file pointer."""
        if not isinstance(data, dict):
            return None

        # Must have a path field
        path = data.get("path")
        if not path or not isinstance(path, str):
            return None

        return cls(
            path=path,
            original_filename=data.get("original_filename"),
            mime_type=data.get("mime_type"),
        )

    @classmethod
    def is_partial(cls, data: Any) -> bool:
        """Check if data looks like a partial file pointer (has path but not id/storage_path)."""
        if not isinstance(data, dict):
            return False

        # Has path but not id/storage_path = partial
        has_path = isinstance(data.get("path"), str) and data.get("path")
        has_full_pointer = isinstance(data.get("id"), str) and isinstance(data.get("storage_path"), str)

        return has_path and not has_full_pointer


# Type alias for file extractor function
# Takes path, returns (content_bytes, filename, mime_type)
FileExtractor = Callable[[str], Coroutine[Any, Any, tuple[bytes, str, str]]]


async def resolve_file_pointers_in_response(
    structured_response: Dict[str, Any],
    output_schema: Optional[Dict[str, Any]],
    file_extractor: FileExtractor,
    user_id: str,
    upload_fn: Callable[[str, bytes, str, str], Coroutine[Any, Any, Dict[str, Any]]],
) -> tuple[Dict[str, Any], List[FilePointer]]:
    """
    Walk structured_response and resolve partial file pointers to full FilePointers.

    Args:
        structured_response: The response dict from verifier
        output_schema: The output schema with field types
        file_extractor: Async function to extract file: (path) -> (bytes, filename, mime_type)
        user_id: User ID for storage path
        upload_fn: Async function to upload file: (user_id, content, filename, mime_type) -> FilePointer dict

    Returns:
        Tuple of (resolved_response, list_of_file_pointers)
        - resolved_response has partial pointers replaced with full FilePointers
        - list_of_file_pointers contains all resolved FilePointer objects
    """
    if not structured_response:
        return structured_response, []

    # Build field type map from schema
    field_types: Dict[str, str] = {}
    if output_schema and "fields" in output_schema:
        for field in output_schema["fields"]:
            if isinstance(field, dict) and "name" in field and "type" in field:
                field_types[field["name"]] = field["type"]

    resolved = {}
    all_file_pointers: List[FilePointer] = []

    for key, value in structured_response.items():
        field_type = field_types.get(key)

        # Handle file_pointer type
        if field_type == "file_pointer":
            resolved_value, fps = await _resolve_file_pointer_value(
                value, file_extractor, user_id, upload_fn
            )
            resolved[key] = resolved_value
            all_file_pointers.extend(fps)

        # Handle list[file_pointer] type
        elif field_type == "list[file_pointer]":
            resolved_list, fps = await _resolve_file_pointer_list(
                value, file_extractor, user_id, upload_fn
            )
            resolved[key] = resolved_list
            all_file_pointers.extend(fps)

        # Auto-detect partial file pointers even without schema type
        elif PartialFilePointer.is_partial(value):
            resolved_value, fps = await _resolve_file_pointer_value(
                value, file_extractor, user_id, upload_fn
            )
            resolved[key] = resolved_value
            all_file_pointers.extend(fps)

        # Pass through other values unchanged
        else:
            resolved[key] = value

    logger.info(
        "[FileResolution] Resolved file pointers in structured response",
        total_files=len(all_file_pointers),
        field_count=len(resolved),
    )

    return resolved, all_file_pointers


async def _resolve_file_pointer_value(
    value: Any,
    file_extractor: FileExtractor,
    user_id: str,
    upload_fn: Callable[[str, bytes, str, str], Coroutine[Any, Any, Dict[str, Any]]],
) -> tuple[Any, List[FilePointer]]:
    """Resolve a single file_pointer value."""
    if value is None:
        return None, []

    # Check if it's already a full FilePointer
    if isinstance(value, dict) and value.get("id") and value.get("storage_path"):
        fp = FilePointer.from_dict(value)
        return value, [fp]

    # Check if it's a partial file pointer
    partial = PartialFilePointer.from_dict(value)
    if not partial:
        logger.warning(
            "[FileResolution] Expected file_pointer but got invalid value",
            value=value,
        )
        return value, []

    try:
        # Extract file from agent workspace
        content, filename, mime_type = await file_extractor(partial.path)

        # Upload to storage
        file_id = str(uuid.uuid4())
        upload_result = await upload_fn(user_id, content, filename, mime_type)

        # Create full FilePointer
        fp = FilePointer(
            id=file_id,
            storage_path=upload_result["storage_path"],
            original_filename=filename,
            mime_type=mime_type,
            size_bytes=len(content),
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        logger.info(
            "[FileResolution] Resolved file pointer",
            path=partial.path,
            filename=filename,
            size_bytes=len(content),
        )

        return asdict(fp), [fp]

    except Exception as e:
        logger.error(
            "[FileResolution] Failed to resolve file pointer",
            path=partial.path,
            error=str(e),
        )
        # Return original value on error
        return value, []


async def _resolve_file_pointer_list(
    value: Any,
    file_extractor: FileExtractor,
    user_id: str,
    upload_fn: Callable[[str, bytes, str, str], Coroutine[Any, Any, Dict[str, Any]]],
) -> tuple[List[Any], List[FilePointer]]:
    """Resolve a list of file pointers."""
    if not isinstance(value, list):
        return value if isinstance(value, list) else [], []

    resolved_list = []
    all_fps: List[FilePointer] = []

    for item in value:
        resolved_item, fps = await _resolve_file_pointer_value(
            item, file_extractor, user_id, upload_fn
        )
        resolved_list.append(resolved_item)
        all_fps.extend(fps)

    return resolved_list, all_fps


def get_file_pointer_paths_from_response(
    structured_response: Dict[str, Any],
    output_schema: Optional[Dict[str, Any]],
) -> List[str]:
    """
    Extract all file paths from structured_response that need to be resolved.

    This is useful for knowing which files to download from the sandbox
    before calling resolve_file_pointers_in_response.
    """
    if not structured_response:
        return []

    # Build field type map from schema
    field_types: Dict[str, str] = {}
    if output_schema and "fields" in output_schema:
        for field in output_schema["fields"]:
            if isinstance(field, dict) and "name" in field and "type" in field:
                field_types[field["name"]] = field["type"]

    paths: List[str] = []

    for key, value in structured_response.items():
        field_type = field_types.get(key)

        if field_type == "file_pointer":
            partial = PartialFilePointer.from_dict(value)
            if partial:
                paths.append(partial.path)

        elif field_type == "list[file_pointer]" and isinstance(value, list):
            for item in value:
                partial = PartialFilePointer.from_dict(item)
                if partial:
                    paths.append(partial.path)

        # Auto-detect partial file pointers
        elif PartialFilePointer.is_partial(value):
            partial = PartialFilePointer.from_dict(value)
            if partial:
                paths.append(partial.path)

    return paths


def resolve_file_pointers_from_extracted(
    structured_response: Dict[str, Any],
    output_schema: Optional[Dict[str, Any]],
    extracted_files: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Resolve partial file pointers in structured_response using already-extracted files.

    This is a simpler version that doesn't need to extract files itself - it just
    matches partial file pointers (by filename) to full FilePointer objects that
    were already extracted from the sandbox.

    Args:
        structured_response: The response dict from verifier (may contain partial file pointers)
        output_schema: The output schema with field types
        extracted_files: List of full FilePointer dicts already extracted from sandbox

    Returns:
        Resolved structured_response with partial pointers replaced by full FilePointers
    """
    if not structured_response or not extracted_files:
        return structured_response or {}

    # Build lookup by filename (basename only)
    import os
    file_lookup: Dict[str, Dict[str, Any]] = {}
    for fp in extracted_files:
        if isinstance(fp, dict) and fp.get("original_filename"):
            file_lookup[fp["original_filename"]] = fp

    logger.debug(
        "[FileResolution] File lookup built",
        available_files=list(file_lookup.keys()),
    )

    # Build field type map from schema
    field_types: Dict[str, str] = {}
    if output_schema and "fields" in output_schema:
        for field in output_schema["fields"]:
            if isinstance(field, dict) and "name" in field and "type" in field:
                field_types[field["name"]] = field["type"]

    resolved = {}

    for key, value in structured_response.items():
        field_type = field_types.get(key)

        # Handle file_pointer type
        if field_type == "file_pointer" or PartialFilePointer.is_partial(value):
            resolved[key] = _match_partial_to_full(value, file_lookup)

        # Handle list[file_pointer] type
        elif field_type == "list[file_pointer]" and isinstance(value, list):
            resolved[key] = [_match_partial_to_full(item, file_lookup) for item in value]

        # Pass through other values unchanged
        else:
            resolved[key] = value

    return resolved


def _match_partial_to_full(
    value: Any,
    file_lookup: Dict[str, Dict[str, Any]],
) -> Any:
    """Match a partial file pointer to a full FilePointer from the lookup."""
    if value is None:
        return None

    # Already a full FilePointer
    if isinstance(value, dict) and value.get("id") and value.get("storage_path"):
        return value

    # Try to parse as partial
    partial = PartialFilePointer.from_dict(value)
    if not partial:
        return value

    # Extract filename from path
    import os
    filename = os.path.basename(partial.path)

    # Look up full FilePointer
    full_fp = file_lookup.get(filename)
    if full_fp:
        logger.info(
            "[FileResolution] Matched partial to full FilePointer",
            path=partial.path,
            filename=filename,
        )
        return full_fp

    logger.warning(
        "[FileResolution] Could not find matching file for partial pointer",
        path=partial.path,
        filename=filename,
        available=list(file_lookup.keys()),
    )
    return value
