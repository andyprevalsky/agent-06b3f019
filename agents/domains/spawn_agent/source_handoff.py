"""Bounded, source-owned explore evidence independent of model transcription."""

from __future__ import annotations

import json
from typing import Any


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class ExploreSourceHandoff:
    """Keep whole JSON observations locally; never slice source values."""

    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.records: list[str] = []
        self.omitted: list[dict] = []
        self.omitted_count = 0

    def _omit(self, record: dict) -> None:
        self.omitted_count += 1
        identity = {"tool_call_id": record["tool_call_id"], "tool": record["tool"]}
        if len(_json([*self.omitted, identity])) <= self.budget // 4:
            self.omitted.append(identity)

    def capture(self, tool: str, tool_call_id: str, arguments: dict, result: Any) -> None:
        if not isinstance(result, (dict, list)):
            return
        record = {"tool_call_id": tool_call_id, "tool": tool, "arguments": arguments, "result": result}
        try:
            encoded = _json(record)
        except (TypeError, ValueError):
            self._omit(record)
            return
        if len(encoded) > self.budget:
            self._omit(record)
            return
        self.records.append(encoded)
        while sum(map(len, self.records)) > self.budget:
            self._omit(json.loads(self.records.pop(0)))

    def render(self, model_summary: str) -> str:
        if not self.records and not self.omitted_count:
            return model_summary
        records = [json.loads(record) for record in self.records]
        envelope = {
            "source_results": records,
            "omitted_source_results": list(self.omitted),
            "omitted_source_result_count": self.omitted_count,
            "model_summary": "",
            "model_summary_truncated": False,
        }
        while records and len(_json(envelope)) > self.budget:
            removed = records.pop(0)
            envelope["omitted_source_result_count"] += 1
            identity = {"tool_call_id": removed["tool_call_id"], "tool": removed["tool"]}
            if len(_json([*envelope["omitted_source_results"], identity])) <= self.budget // 4:
                envelope["omitted_source_results"].append(identity)
        # The existing model findings had no handoff cap. Bound only the
        # added source sidecar and preserve those findings byte-for-byte.
        envelope["model_summary"] = model_summary
        return _json(envelope)
