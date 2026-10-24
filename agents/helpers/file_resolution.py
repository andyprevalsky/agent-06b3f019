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

import copy
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional

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

    _replace_schema_file_pointer_types(
        transformed.get("fields", []),
        single_from="file_pointer",
        single_to="session_file_pointer",
        list_from="list[file_pointer]",
        list_to="list[session_file_pointer]",
    )

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

    _replace_schema_file_pointer_types(
        restored.get("fields", []),
        single_from="session_file_pointer",
        single_to="file_pointer",
        list_from="list[session_file_pointer]",
        list_to="list[file_pointer]",
    )

    return restored


def _replace_schema_file_pointer_types(
    fields: Any,
    *,
    single_from: str,
    single_to: str,
    list_from: str,
    list_to: str,
) -> None:
    """Recursively replace file-pointer field types in response-schema fields."""
    if not isinstance(fields, list):
        return

    for field in fields:
        if not isinstance(field, dict):
            continue
        if field.get("type") == single_from:
            field["type"] = single_to
        elif field.get("type") == list_from:
            field["type"] = list_to
        _replace_schema_file_pointer_types(
            field.get("properties"),
            single_from=single_from,
            single_to=single_to,
            list_from=list_from,
            list_to=list_to,
        )


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

    resolved = {}
    all_file_pointers: List[FilePointer] = []
    fields_by_name = _schema_fields_by_name(output_schema.get("fields") if isinstance(output_schema, dict) else None)

    for key, value in structured_response.items():
        resolved_value, fps = await _resolve_value_by_schema(
            value,
            fields_by_name.get(key),
            file_extractor,
            user_id,
            upload_fn,
        )
        resolved[key] = resolved_value
        all_file_pointers.extend(fps)

    logger.info(
        "[FileResolution] Resolved file pointers in structured response",
        total_files=len(all_file_pointers),
        field_count=len(resolved),
    )

    return resolved, all_file_pointers


def _schema_fields_by_name(fields: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(fields, list):
        return {}
    by_name: Dict[str, Dict[str, Any]] = {}
    for field in fields:
        if isinstance(field, dict) and isinstance(field.get("name"), str):
            by_name[field["name"]] = field
    return by_name


async def _resolve_value_by_schema(
    value: Any,
    field_schema: Optional[Dict[str, Any]],
    file_extractor: FileExtractor,
    user_id: str,
    upload_fn: Callable[[str, bytes, str, str], Coroutine[Any, Any, Dict[str, Any]]],
) -> tuple[Any, List[FilePointer]]:
    field_type = field_schema.get("type") if isinstance(field_schema, dict) else None

    if field_type in ("file_pointer", "session_file_pointer"):
        return await _resolve_file_pointer_value(value, file_extractor, user_id, upload_fn)

    if field_type in ("list[file_pointer]", "list[session_file_pointer]"):
        return await _resolve_file_pointer_list(value, file_extractor, user_id, upload_fn)

    if field_type == "object" and isinstance(value, dict):
        return await _resolve_object_fields_by_schema(
            value,
            field_schema.get("properties") if isinstance(field_schema, dict) else None,
            file_extractor,
            user_id,
            upload_fn,
        )

    if field_type == "list[object]" and isinstance(value, list):
        resolved_list = []
        all_fps: List[FilePointer] = []
        properties = field_schema.get("properties") if isinstance(field_schema, dict) else None
        for item in value:
            if isinstance(item, dict):
                resolved_item, fps = await _resolve_object_fields_by_schema(
                    item,
                    properties,
                    file_extractor,
                    user_id,
                    upload_fn,
                )
                resolved_list.append(resolved_item)
                all_fps.extend(fps)
            else:
                resolved_list.append(item)
        return resolved_list, all_fps

    if PartialFilePointer.is_partial(value):
        return await _resolve_file_pointer_value(value, file_extractor, user_id, upload_fn)

    return value, []


async def _resolve_object_fields_by_schema(
    value: Dict[str, Any],
    fields: Any,
    file_extractor: FileExtractor,
    user_id: str,
    upload_fn: Callable[[str, bytes, str, str], Coroutine[Any, Any, Dict[str, Any]]],
) -> tuple[Dict[str, Any], List[FilePointer]]:
    fields_by_name = _schema_fields_by_name(fields)
    resolved: Dict[str, Any] = {}
    all_fps: List[FilePointer] = []
    for key, item in value.items():
        resolved_item, fps = await _resolve_value_by_schema(
            item,
            fields_by_name.get(key),
            file_extractor,
            user_id,
            upload_fn,
        )
        resolved[key] = resolved_item
        all_fps.extend(fps)
    return resolved, all_fps


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

        return fp.to_dict(), [fp]

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
        resolved_item, fps = await _resolve_file_pointer_value(item, file_extractor, user_id, upload_fn)
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

    paths: List[str] = []
    fields_by_name = _schema_fields_by_name(output_schema.get("fields") if isinstance(output_schema, dict) else None)

    for key, value in structured_response.items():
        paths.extend(_file_pointer_paths_by_schema(value, fields_by_name.get(key)))

    return paths


def _file_pointer_paths_by_schema(value: Any, field_schema: Optional[Dict[str, Any]]) -> List[str]:
    field_type = field_schema.get("type") if isinstance(field_schema, dict) else None

    if field_type in ("file_pointer", "session_file_pointer") or PartialFilePointer.is_partial(value):
        partial = PartialFilePointer.from_dict(value)
        return [partial.path] if partial else []

    if field_type in ("list[file_pointer]", "list[session_file_pointer]") and isinstance(value, list):
        paths: List[str] = []
        for item in value:
            partial = PartialFilePointer.from_dict(item)
            if partial:
                paths.append(partial.path)
        return paths

    if field_type == "object" and isinstance(value, dict):
        return _file_pointer_paths_from_object(value, field_schema.get("properties"))

    if field_type == "list[object]" and isinstance(value, list):
        paths: List[str] = []
        properties = field_schema.get("properties") if isinstance(field_schema, dict) else None
        for item in value:
            if isinstance(item, dict):
                paths.extend(_file_pointer_paths_from_object(item, properties))
        return paths

    return []


def _file_pointer_paths_from_object(value: Dict[str, Any], fields: Any) -> List[str]:
    fields_by_name = _schema_fields_by_name(fields)
    paths: List[str] = []
    for key, item in value.items():
        paths.extend(_file_pointer_paths_by_schema(item, fields_by_name.get(key)))
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

    file_lookup: Dict[str, Dict[str, Any]] = {}
    for fp in extracted_files:
        if isinstance(fp, dict) and fp.get("original_filename"):
            file_lookup[fp["original_filename"]] = fp

    logger.debug(
        "[FileResolution] File lookup built",
        available_files=list(file_lookup.keys()),
    )

    resolved = {}
    fields_by_name = _schema_fields_by_name(output_schema.get("fields") if isinstance(output_schema, dict) else None)

    for key, value in structured_response.items():
        resolved[key] = _resolve_extracted_value_by_schema(value, fields_by_name.get(key), file_lookup)

    return resolved


def _resolve_extracted_value_by_schema(
    value: Any,
    field_schema: Optional[Dict[str, Any]],
    file_lookup: Dict[str, Dict[str, Any]],
) -> Any:
    field_type = field_schema.get("type") if isinstance(field_schema, dict) else None

    if field_type in ("file_pointer", "session_file_pointer") or PartialFilePointer.is_partial(value):
        return _match_partial_to_full(value, file_lookup)

    if field_type in ("list[file_pointer]", "list[session_file_pointer]") and isinstance(value, list):
        return [_match_partial_to_full(item, file_lookup) for item in value]

    if field_type == "object" and isinstance(value, dict):
        return _resolve_extracted_object_by_schema(value, field_schema.get("properties"), file_lookup)

    if field_type == "list[object]" and isinstance(value, list):
        properties = field_schema.get("properties") if isinstance(field_schema, dict) else None
        return [
            _resolve_extracted_object_by_schema(item, properties, file_lookup)
            if isinstance(item, dict)
            else item
            for item in value
        ]

    return value


def _resolve_extracted_object_by_schema(
    value: Dict[str, Any],
    fields: Any,
    file_lookup: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    fields_by_name = _schema_fields_by_name(fields)
    resolved: Dict[str, Any] = {}
    for key, item in value.items():
        resolved[key] = _resolve_extracted_value_by_schema(item, fields_by_name.get(key), file_lookup)
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
        resolved = dict(full_fp)
        # Preserve the remote session path alongside the uploaded FilePointer
        # so parent verifiers for session_file_pointer fields can still extract
        # the absolute /home/user/... path from grounded tool metadata.
        resolved.setdefault("path", partial.path)
        return resolved

    logger.warning(
        "[FileResolution] Could not find matching file for partial pointer",
        path=partial.path,
        filename=filename,
        available=list(file_lookup.keys()),
    )
    return value
