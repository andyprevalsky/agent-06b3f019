"""Blackbox tests for file_resolution domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_transform_schema_for_remote_session():
    """transform_schema converts file_pointer -> session_file_pointer."""
    from helpers.file_resolution import transform_schema_for_remote_session

    schema = {
        "fields": [
            {"name": "report", "type": "file_pointer", "required": True, "description": "Report file"},
            {"name": "summary", "type": "str", "required": True, "description": "Text summary"},
            {"name": "images", "type": "list[file_pointer]", "required": False, "description": "Image files"},
        ]
    }

    result = transform_schema_for_remote_session(schema)

    assert result["fields"][0]["type"] == "session_file_pointer"
    assert result["fields"][1]["type"] == "str"  # Unchanged
    assert result["fields"][2]["type"] == "list[session_file_pointer]"


def test_transform_schema_for_remote_session_nested_file_pointers():
    """transform_schema converts nested file_pointer fields recursively."""
    from helpers.file_resolution import transform_schema_for_remote_session

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "file_pointer"},
                    {"name": "frames", "type": "list[file_pointer]"},
                ],
            },
            {
                "name": "variants",
                "type": "list[object]",
                "properties": [
                    {"name": "name", "type": "str"},
                    {"name": "image", "type": "file_pointer"},
                ],
            },
        ]
    }

    result = transform_schema_for_remote_session(schema)

    props = result["fields"][0]["properties"]
    assert props[1]["type"] == "session_file_pointer"
    assert props[2]["type"] == "list[session_file_pointer]"
    assert result["fields"][1]["properties"][1]["type"] == "session_file_pointer"


def test_transform_schema_none():
    """transform_schema returns None for None input."""
    from helpers.file_resolution import transform_schema_for_remote_session

    assert transform_schema_for_remote_session(None) is None


def test_transform_schema_no_fields():
    """transform_schema returns input unchanged when no fields key."""
    from helpers.file_resolution import transform_schema_for_remote_session

    schema = {"name": "test"}
    result = transform_schema_for_remote_session(schema)
    assert result == {"name": "test"}


def test_restore_schema_from_remote_session():
    """restore_schema converts session_file_pointer -> file_pointer."""
    from helpers.file_resolution import restore_schema_from_remote_session

    schema = {
        "fields": [
            {"name": "report", "type": "session_file_pointer", "required": True, "description": "Report"},
            {"name": "summary", "type": "str", "required": True, "description": "Summary"},
            {"name": "images", "type": "list[session_file_pointer]", "required": False, "description": "Images"},
        ]
    }

    result = restore_schema_from_remote_session(schema)

    assert result["fields"][0]["type"] == "file_pointer"
    assert result["fields"][1]["type"] == "str"
    assert result["fields"][2]["type"] == "list[file_pointer]"


def test_restore_schema_from_remote_session_nested_file_pointers():
    """restore_schema converts nested session_file_pointer fields recursively."""
    from helpers.file_resolution import restore_schema_from_remote_session

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "session_file_pointer"},
                    {"name": "frames", "type": "list[session_file_pointer]"},
                ],
            }
        ]
    }

    result = restore_schema_from_remote_session(schema)

    props = result["fields"][0]["properties"]
    assert props[1]["type"] == "file_pointer"
    assert props[2]["type"] == "list[file_pointer]"


def test_restore_schema_none():
    """restore_schema returns None for None input."""
    from helpers.file_resolution import restore_schema_from_remote_session

    assert restore_schema_from_remote_session(None) is None


def test_restore_schema_no_fields():
    """restore_schema returns input unchanged when no fields key."""
    from helpers.file_resolution import restore_schema_from_remote_session

    schema = {"name": "foo"}
    assert restore_schema_from_remote_session(schema) == {"name": "foo"}


def test_transform_restore_roundtrip():
    """transform then restore produces the original schema."""
    from helpers.file_resolution import (
        transform_schema_for_remote_session,
        restore_schema_from_remote_session,
    )

    original = {
        "fields": [
            {"name": "doc", "type": "file_pointer", "required": True, "description": "A doc"},
            {"name": "name", "type": "str", "required": True, "description": "Name"},
        ]
    }

    transformed = transform_schema_for_remote_session(original)
    restored = restore_schema_from_remote_session(transformed)

    assert restored["fields"][0]["type"] == "file_pointer"
    assert restored["fields"][1]["type"] == "str"


def test_partial_file_pointer_from_dict():
    """PartialFilePointer.from_dict builds a PartialFilePointer from valid dict."""
    from helpers.file_resolution import PartialFilePointer

    result = PartialFilePointer.from_dict({
        "path": "/home/user/doc.pdf",
        "original_filename": "doc.pdf",
        "mime_type": "application/pdf",
    })

    assert result is not None
    assert result.path == "/home/user/doc.pdf"
    assert result.original_filename == "doc.pdf"
    assert result.mime_type == "application/pdf"


def test_partial_file_pointer_from_dict_missing_path():
    """PartialFilePointer.from_dict returns None when path missing."""
    from helpers.file_resolution import PartialFilePointer

    assert PartialFilePointer.from_dict({"other": "x"}) is None
    assert PartialFilePointer.from_dict({"path": ""}) is None
    assert PartialFilePointer.from_dict({"path": 123}) is None


def test_partial_file_pointer_from_dict_non_dict():
    """PartialFilePointer.from_dict returns None for non-dict inputs."""
    from helpers.file_resolution import PartialFilePointer

    assert PartialFilePointer.from_dict(None) is None
    assert PartialFilePointer.from_dict("string") is None
    assert PartialFilePointer.from_dict([]) is None


def test_partial_file_pointer_is_partial():
    """PartialFilePointer.is_partial detects partial vs full pointers."""
    from helpers.file_resolution import PartialFilePointer

    # Partial: path only
    assert PartialFilePointer.is_partial({"path": "/x/y"}) is True
    # Full: has id + storage_path (not partial)
    assert PartialFilePointer.is_partial({
        "id": "xyz", "storage_path": "user/a.pdf", "path": "/x/y"
    }) is False
    # Not partial: no path
    assert PartialFilePointer.is_partial({"foo": "bar"}) is False
    # Not a dict
    assert PartialFilePointer.is_partial("string") is False


def test_get_file_pointer_paths_from_response():
    """get_file_pointer_paths extracts paths from response based on schema."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    schema = {
        "fields": [
            {"name": "report", "type": "file_pointer", "required": True, "description": "Report"},
            {"name": "title", "type": "str", "required": True, "description": "Title"},
        ]
    }
    response = {
        "report": {"path": "/home/user/report.pdf"},
        "title": "My Report",
    }

    paths = get_file_pointer_paths_from_response(response, schema)

    assert paths == ["/home/user/report.pdf"]


def test_get_file_pointer_paths_list():
    """get_file_pointer_paths extracts paths from list[file_pointer] fields."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    schema = {
        "fields": [
            {"name": "images", "type": "list[file_pointer]", "required": True, "description": "Images"},
        ]
    }
    response = {
        "images": [
            {"path": "/home/user/img1.png"},
            {"path": "/home/user/img2.png"},
        ],
    }

    paths = get_file_pointer_paths_from_response(response, schema)

    assert len(paths) == 2
    assert "/home/user/img1.png" in paths
    assert "/home/user/img2.png" in paths


def test_get_file_pointer_paths_empty():
    """get_file_pointer_paths returns empty list for empty response."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    assert get_file_pointer_paths_from_response({}, None) == []
    assert get_file_pointer_paths_from_response(None, None) == []


def test_get_file_pointer_paths_autodetect():
    """get_file_pointer_paths auto-detects partial pointers without schema type."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    # No schema: value with path is auto-detected
    response = {
        "extra": {"path": "/home/x/a.txt"},
        "other": "string",
    }
    paths = get_file_pointer_paths_from_response(response, None)
    assert "/home/x/a.txt" in paths


def test_get_file_pointer_paths_malformed_schema_field():
    """Schema field without name/type is ignored."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    schema = {"fields": [{"bad_field": True}, {"name": "r", "type": "file_pointer"}]}
    response = {"r": {"path": "/a/b.txt"}}

    paths = get_file_pointer_paths_from_response(response, schema)
    assert paths == ["/a/b.txt"]


def test_get_file_pointer_paths_nested_object():
    """get_file_pointer_paths follows object/list[object] properties."""
    from helpers.file_resolution import get_file_pointer_paths_from_response

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "file_pointer"},
                ],
            },
            {
                "name": "frames",
                "type": "list[object]",
                "properties": [
                    {"name": "index", "type": "int"},
                    {"name": "image", "type": "file_pointer"},
                ],
            },
        ]
    }
    response = {
        "variant": {"color": "green", "file": {"path": "/home/user/green.png"}},
        "frames": [
            {"index": 1, "image": {"path": "/home/user/frame-1.png"}},
            {"index": 2, "image": {"path": "/home/user/frame-2.png"}},
        ],
    }

    paths = get_file_pointer_paths_from_response(response, schema)
    assert paths == ["/home/user/green.png", "/home/user/frame-1.png", "/home/user/frame-2.png"]


def test_resolve_file_pointers_from_extracted_happy():
    """resolve_file_pointers_from_extracted matches partial to full by filename."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    response = {
        "report": {"path": "/remote/dir/report.pdf"},
        "title": "Weekly Report",
    }
    schema = {
        "fields": [
            {"name": "report", "type": "file_pointer"},
            {"name": "title", "type": "str"},
        ]
    }
    extracted = [
        {
            "id": "fp-1",
            "storage_path": "user-1/report.pdf",
            "original_filename": "report.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 100,
            "created_at": "2026-04-05T12:00:00Z",
        }
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)

    assert resolved["report"]["id"] == "fp-1"
    assert resolved["title"] == "Weekly Report"


def test_resolve_file_pointers_from_extracted_list():
    """resolve_file_pointers_from_extracted handles list[file_pointer]."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    response = {
        "images": [
            {"path": "/remote/a.png"},
            {"path": "/remote/b.png"},
        ],
    }
    schema = {"fields": [{"name": "images", "type": "list[file_pointer]"}]}
    extracted = [
        {"id": "fp-a", "storage_path": "u/a.png", "original_filename": "a.png", "mime_type": "image/png", "size_bytes": 1, "created_at": ""},
        {"id": "fp-b", "storage_path": "u/b.png", "original_filename": "b.png", "mime_type": "image/png", "size_bytes": 1, "created_at": ""},
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)

    assert resolved["images"][0]["id"] == "fp-a"
    assert resolved["images"][1]["id"] == "fp-b"


def test_resolve_file_pointers_from_extracted_no_match():
    """resolve_file_pointers_from_extracted leaves partial untouched when no match."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    response = {"report": {"path": "/remote/missing.pdf"}}
    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    extracted = [
        {"id": "fp-x", "storage_path": "u/other.pdf", "original_filename": "other.pdf", "mime_type": "application/pdf", "size_bytes": 1, "created_at": ""},
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)
    # No match → original value returned
    assert resolved["report"] == {"path": "/remote/missing.pdf"}


def test_resolve_file_pointers_from_extracted_already_full():
    """resolve_file_pointers_from_extracted passes full pointer through unchanged."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    full = {
        "id": "fp-done",
        "storage_path": "u/done.pdf",
        "original_filename": "done.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 10,
        "created_at": "",
    }
    response = {"report": full}
    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}

    resolved = resolve_file_pointers_from_extracted(response, schema, [full])
    assert resolved["report"] == full


def test_resolve_file_pointers_from_extracted_empty_response():
    """resolve_file_pointers_from_extracted returns {} when response is None."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    assert resolve_file_pointers_from_extracted(None, None, []) == {}
    # Empty extracted: returns response untouched (early out branch)
    assert resolve_file_pointers_from_extracted({"a": 1}, None, []) == {"a": 1}


def test_resolve_file_pointers_from_extracted_none_value():
    """_match_partial_to_full returns None for None value."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    response = {"report": None}
    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    extracted = [
        {"id": "fp", "storage_path": "u/x", "original_filename": "x.pdf", "mime_type": "application/pdf", "size_bytes": 1, "created_at": ""},
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)
    assert resolved["report"] is None


def test_resolve_file_pointers_from_extracted_non_partial_non_dict():
    """_match_partial_to_full returns value unchanged when not partial."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    response = {"report": "not-a-dict"}
    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    extracted = [
        {"id": "fp", "storage_path": "u/x", "original_filename": "x.pdf", "mime_type": "application/pdf", "size_bytes": 1, "created_at": ""},
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)
    assert resolved["report"] == "not-a-dict"


def test_resolve_file_pointers_from_extracted_nested_object():
    """resolve_file_pointers_from_extracted resolves nested object/list[object] pointers."""
    from helpers.file_resolution import resolve_file_pointers_from_extracted

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "file_pointer"},
                ],
            },
            {
                "name": "frames",
                "type": "list[object]",
                "properties": [
                    {"name": "index", "type": "int"},
                    {"name": "image", "type": "file_pointer"},
                ],
            },
        ]
    }
    response = {
        "variant": {"color": "green", "file": {"path": "/home/user/green.png"}},
        "frames": [{"index": 1, "image": {"path": "/home/user/frame.png"}}],
    }
    extracted = [
        {"id": "fp-green", "storage_path": "u/green.png", "original_filename": "green.png", "mime_type": "image/png", "size_bytes": 1, "created_at": ""},
        {"id": "fp-frame", "storage_path": "u/frame.png", "original_filename": "frame.png", "mime_type": "image/png", "size_bytes": 1, "created_at": ""},
    ]

    resolved = resolve_file_pointers_from_extracted(response, schema, extracted)
    assert resolved["variant"]["file"]["id"] == "fp-green"
    assert resolved["frames"][0]["image"]["id"] == "fp-frame"


async def test_resolve_file_pointers_in_response_happy():
    """resolve_file_pointers_in_response extracts + uploads partial file pointers."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path: str):
        return b"file bytes", "doc.pdf", "application/pdf"

    async def uploader(user_id: str, content: bytes, filename: str, mime: str):
        return {"storage_path": f"{user_id}/{filename}"}

    schema = {"fields": [{"name": "report", "type": "file_pointer"}, {"name": "title", "type": "str"}]}
    response = {"report": {"path": "/remote/doc.pdf"}, "title": "Title"}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "user-1", uploader
    )

    assert resolved["title"] == "Title"
    assert resolved["report"]["original_filename"] == "doc.pdf"
    assert resolved["report"]["storage_path"] == "user-1/doc.pdf"
    assert len(fps) == 1
    assert fps[0].original_filename == "doc.pdf"


async def test_resolve_file_pointers_in_response_nested_object():
    """resolve_file_pointers_in_response uploads nested object/list[object] pointers."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path: str):
        return b"bytes", path.split("/")[-1], "image/png"

    async def uploader(user_id: str, content: bytes, filename: str, mime: str):
        return {"storage_path": f"{user_id}/{filename}"}

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "file_pointer"},
                ],
            },
            {
                "name": "frames",
                "type": "list[object]",
                "properties": [
                    {"name": "index", "type": "int"},
                    {"name": "image", "type": "file_pointer"},
                ],
            },
        ]
    }
    response = {
        "variant": {"color": "green", "file": {"path": "/remote/green.png"}},
        "frames": [{"index": 1, "image": {"path": "/remote/frame.png"}}],
    }

    resolved, fps = await resolve_file_pointers_in_response(response, schema, extractor, "u", uploader)

    assert resolved["variant"]["file"]["storage_path"] == "u/green.png"
    assert resolved["frames"][0]["image"]["storage_path"] == "u/frame.png"
    assert [fp.original_filename for fp in fps] == ["green.png", "frame.png"]


async def test_resolve_file_pointers_in_response_list():
    """resolve_file_pointers_in_response handles list[file_pointer]."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path: str):
        return b"bytes", path.split("/")[-1], "image/png"

    async def uploader(user_id: str, content: bytes, filename: str, mime: str):
        return {"storage_path": f"{user_id}/{filename}"}

    schema = {"fields": [{"name": "images", "type": "list[file_pointer]"}]}
    response = {"images": [{"path": "/a.png"}, {"path": "/b.png"}]}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )

    assert len(resolved["images"]) == 2
    assert len(fps) == 2


async def test_resolve_file_pointers_in_response_already_full():
    """resolve_file_pointers_in_response passes full pointer through."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path: str):
        raise AssertionError("Should not call extractor on full pointer")

    async def uploader(user_id, content, filename, mime):
        raise AssertionError("Should not call uploader on full pointer")

    full = {
        "id": "fp-full",
        "storage_path": "u/a.pdf",
        "original_filename": "a.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 5,
        "created_at": "",
    }
    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    response = {"report": full}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )

    assert resolved["report"] == full
    assert len(fps) == 1


async def test_resolve_file_pointers_in_response_none_value():
    """resolve_file_pointers_in_response handles None value for file_pointer."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path: str):
        raise AssertionError("unreachable")

    async def uploader(*a, **k):
        raise AssertionError("unreachable")

    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    response = {"report": None}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )

    assert resolved["report"] is None
    assert fps == []


async def test_resolve_file_pointers_in_response_invalid_value():
    """resolve_file_pointers_in_response returns value unchanged when not partial/full."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path):
        raise AssertionError("unreachable")

    async def uploader(*a, **k):
        raise AssertionError("unreachable")

    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    response = {"report": "not-a-dict"}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )
    assert resolved["report"] == "not-a-dict"
    assert fps == []


async def test_resolve_file_pointers_in_response_extractor_error():
    """resolve_file_pointers_in_response returns original on extractor error."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path):
        raise RuntimeError("download failed")

    async def uploader(*a, **k):
        return {"storage_path": "x"}

    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    partial = {"path": "/x/y.pdf"}
    response = {"report": partial}

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )
    assert resolved["report"] == partial
    assert fps == []


async def test_resolve_file_pointers_in_response_autodetect():
    """resolve_file_pointers_in_response auto-detects partial file pointers without schema type."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path):
        return b"bytes", "auto.txt", "text/plain"

    async def uploader(user, content, filename, mime):
        return {"storage_path": f"{user}/{filename}"}

    # No explicit schema type for "loose_field"
    schema = {"fields": [{"name": "title", "type": "str"}]}
    response = {
        "loose_field": {"path": "/remote/auto.txt"},
        "title": "hello",
    }

    resolved, fps = await resolve_file_pointers_in_response(
        response, schema, extractor, "u", uploader
    )
    # Auto-detected since value matches partial pointer shape
    assert resolved["loose_field"]["original_filename"] == "auto.txt"
    assert len(fps) == 1


async def test_resolve_file_pointers_in_response_empty():
    """resolve_file_pointers_in_response short-circuits on empty response."""
    from helpers.file_resolution import resolve_file_pointers_in_response

    async def extractor(path):
        raise AssertionError("unreachable")

    async def uploader(*a, **k):
        raise AssertionError("unreachable")

    resolved, fps = await resolve_file_pointers_in_response(
        {}, None, extractor, "u", uploader
    )
    assert resolved == {}
    assert fps == []


async def test_resolve_file_pointer_list_non_list():
    """_resolve_file_pointer_list returns empty list-like for non-list input."""
    from helpers.file_resolution import _resolve_file_pointer_list

    async def extractor(path):
        raise AssertionError("unreachable")

    async def uploader(*a, **k):
        raise AssertionError("unreachable")

    resolved, fps = await _resolve_file_pointer_list(
        "not-a-list", extractor, "u", uploader
    )
    assert resolved == "not-a-list" or resolved == []
    assert fps == []


async def run_all_tests():
    print("file-resolution blackbox tests:")
    r = BlackboxResult()
    r.record("transform_schema", test_transform_schema_for_remote_session)
    r.record("transform_schema_nested", test_transform_schema_for_remote_session_nested_file_pointers)
    r.record("transform_schema_none", test_transform_schema_none)
    r.record("transform_schema_no_fields", test_transform_schema_no_fields)
    r.record("restore_schema", test_restore_schema_from_remote_session)
    r.record("restore_schema_nested", test_restore_schema_from_remote_session_nested_file_pointers)
    r.record("restore_schema_none", test_restore_schema_none)
    r.record("restore_schema_no_fields", test_restore_schema_no_fields)
    r.record("transform_restore_roundtrip", test_transform_restore_roundtrip)
    r.record("partial_from_dict", test_partial_file_pointer_from_dict)
    r.record("partial_from_dict_missing_path", test_partial_file_pointer_from_dict_missing_path)
    r.record("partial_from_dict_non_dict", test_partial_file_pointer_from_dict_non_dict)
    r.record("partial_is_partial", test_partial_file_pointer_is_partial)
    r.record("get_file_pointer_paths", test_get_file_pointer_paths_from_response)
    r.record("get_file_pointer_paths_list", test_get_file_pointer_paths_list)
    r.record("get_file_pointer_paths_empty", test_get_file_pointer_paths_empty)
    r.record("get_file_pointer_paths_autodetect", test_get_file_pointer_paths_autodetect)
    r.record("get_file_pointer_paths_malformed", test_get_file_pointer_paths_malformed_schema_field)
    r.record("get_file_pointer_paths_nested", test_get_file_pointer_paths_nested_object)
    r.record("resolve_from_extracted_happy", test_resolve_file_pointers_from_extracted_happy)
    r.record("resolve_from_extracted_list", test_resolve_file_pointers_from_extracted_list)
    r.record("resolve_from_extracted_no_match", test_resolve_file_pointers_from_extracted_no_match)
    r.record("resolve_from_extracted_already_full", test_resolve_file_pointers_from_extracted_already_full)
    r.record("resolve_from_extracted_empty", test_resolve_file_pointers_from_extracted_empty_response)
    r.record("resolve_from_extracted_none_value", test_resolve_file_pointers_from_extracted_none_value)
    r.record("resolve_from_extracted_non_partial", test_resolve_file_pointers_from_extracted_non_partial_non_dict)
    r.record("resolve_from_extracted_nested", test_resolve_file_pointers_from_extracted_nested_object)
    await r.record_async("resolve_in_response_happy", test_resolve_file_pointers_in_response_happy)
    await r.record_async("resolve_in_response_nested", test_resolve_file_pointers_in_response_nested_object)
    await r.record_async("resolve_in_response_list", test_resolve_file_pointers_in_response_list)
    await r.record_async("resolve_in_response_already_full", test_resolve_file_pointers_in_response_already_full)
    await r.record_async("resolve_in_response_none_value", test_resolve_file_pointers_in_response_none_value)
    await r.record_async("resolve_in_response_invalid", test_resolve_file_pointers_in_response_invalid_value)
    await r.record_async("resolve_in_response_extractor_error", test_resolve_file_pointers_in_response_extractor_error)
    await r.record_async("resolve_in_response_autodetect", test_resolve_file_pointers_in_response_autodetect)
    await r.record_async("resolve_in_response_empty", test_resolve_file_pointers_in_response_empty)
    await r.record_async("resolve_list_non_list", test_resolve_file_pointer_list_non_list)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
