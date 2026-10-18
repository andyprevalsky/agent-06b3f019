"""Optional filtering of failed demonstrations, never live world observations."""
from __future__ import annotations

import json

FILTER_ID = "exclude-failed-tool-examples-v1"


def failed_tool_result(value: object) -> bool:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return False
    if not isinstance(value, dict):
        return False
    if value.get("is_error") is True or value.get("success") is False or value.get("error"):
        return True
    statuses = [value.get("status"), value.get("toolStatus"), value.get("tool_status")]
    metadata = value.get("metadata")
    if isinstance(metadata, dict):
        statuses.extend(metadata.get(key) for key in ("status", "toolStatus", "tool_status"))
        if metadata.get("result_unavailable") is True:
            return True
    if any(isinstance(status, str) and status.lower() in {"error", "failed", "failure", "cancelled", "canceled"}
           for status in statuses):
        return True
    if value.get("kind") in {"tool_error", "error"}:
        return True
    if isinstance(value.get("tool_results"), list) and any(failed_tool_result(x) for x in value["tool_results"]):
        return True
    return any(failed_tool_result(value[key]) for key in ("content", "result", "observation") if key in value)

