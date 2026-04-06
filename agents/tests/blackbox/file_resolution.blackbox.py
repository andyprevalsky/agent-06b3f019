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


async def run_all_tests():
    print("file-resolution blackbox tests:")
    r = BlackboxResult()
    r.record("transform_schema", test_transform_schema_for_remote_session)
    r.record("transform_schema_none", test_transform_schema_none)
    r.record("transform_schema_no_fields", test_transform_schema_no_fields)
    r.record("restore_schema", test_restore_schema_from_remote_session)
    r.record("transform_restore_roundtrip", test_transform_restore_roundtrip)
    r.record("get_file_pointer_paths", test_get_file_pointer_paths_from_response)
    r.record("get_file_pointer_paths_list", test_get_file_pointer_paths_list)
    r.record("get_file_pointer_paths_empty", test_get_file_pointer_paths_empty)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
