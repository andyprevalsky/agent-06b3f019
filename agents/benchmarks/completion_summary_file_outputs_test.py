"""Unit tests for completion_summary_file_outputs static check."""

from __future__ import annotations

from benchmarks.run_benchmark import (
    _completion_summary_file_outputs_check,
    _iter_completion_output_file_pointers,
)


def _html_pointer(**overrides):
    base = {
        "id": "fp-html",
        "storage_path": "user/report.html",
        "original_filename": "report.html",
        "mime_type": "text/html",
        "size_bytes": 128,
        "created_at": "2026-09-03T00:00:00Z",
    }
    base.update(overrides)
    return base


def _summary_data(outputs):
    return {
        "agent": {"agent_id": "root-1", "status": "COMPLETED"},
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "completionSummary": {
                        "summary": "Wrote the HTML report.",
                        "outputs": outputs,
                    },
                },
            }
        ],
    }


def test_iter_completion_output_file_pointers_handles_single_and_list():
    outputs = [
        {"key": "doc", "label": "Doc", "value": _html_pointer()},
        {
            "key": "docs",
            "label": "Docs",
            "value": [_html_pointer(id="fp-2", original_filename="other.htm")],
        },
        {"key": "text", "label": "Text", "value": "not a file"},
    ]
    pointers = _iter_completion_output_file_pointers(outputs)
    assert [p["original_filename"] for p in pointers] == ["report.html", "other.htm"]


def test_completion_summary_file_outputs_passes_for_html_pointer():
    data = _summary_data([{"key": "report", "label": "Report", "value": _html_pointer()}])
    ok, reason = _completion_summary_file_outputs_check(
        data,
        {"extensions": [".html", ".htm"], "mime_contains": ["html"], "min_files": 1},
    )
    assert ok, reason
    assert "1 matching" in reason


def test_completion_summary_file_outputs_rejects_missing_html():
    data = _summary_data(
        [
            {
                "key": "sheet",
                "label": "Sheet",
                "value": _html_pointer(
                    original_filename="budget.xlsx",
                    mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    storage_path="user/budget.xlsx",
                ),
            }
        ]
    )
    ok, reason = _completion_summary_file_outputs_check(
        data,
        {"extensions": [".html"], "mime_contains": ["html"], "min_files": 1},
    )
    assert not ok
    assert "0 matching" in reason
