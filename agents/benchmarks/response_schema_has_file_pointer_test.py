"""Unit tests for response_schema_has_file_pointer static check."""

from __future__ import annotations

from benchmarks.run_benchmark import _response_schema_has_file_pointer_check


def test_requires_file_pointer_field():
    ok, reason = _response_schema_has_file_pointer_check(
        {"agent": {"response_schema": {"fields": [{"name": "summary", "type": "str"}]}}},
        {},
    )
    assert not ok
    assert "no file_pointer" in reason


def test_accepts_file_pointer_without_file_types_when_unconstrained():
    ok, reason = _response_schema_has_file_pointer_check(
        {
            "agent": {
                "response_schema": {
                    "fields": [{"name": "website", "type": "file_pointer", "required": True}]
                }
            }
        },
        {},
    )
    assert ok, reason


def test_requires_matching_file_types_when_configured():
    ok, reason = _response_schema_has_file_pointer_check(
        {
            "agent": {
                "response_schema": {
                    "fields": [
                        {
                            "name": "website",
                            "type": "file_pointer",
                            "file_types": ["html"],
                        }
                    ]
                }
            }
        },
        {"required_file_types": ["html"]},
    )
    assert ok, reason

    ok2, reason2 = _response_schema_has_file_pointer_check(
        {
            "agent": {
                "response_schema": {
                    "fields": [
                        {
                            "name": "website",
                            "type": "file_pointer",
                            "file_types": ["pdf"],
                        }
                    ]
                }
            }
        },
        {"required_file_types": ["html"]},
    )
    assert not ok2
    assert "missing required file_types" in reason2
