"""Cross-language structured-output item selection contract."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from providers.rose.types import StreamChunk

IGNORED_PHASES = {"commentary", "reasoning"}
LEGACY_ITEM_ID = "legacy:content:0"


class StructuredOutputCardinalityError(ValueError):
    code = "STRUCTURED_OUTPUT_CARDINALITY"


@dataclass
class _ContentItem:
    item_id: str
    output_index: int
    content_index: int
    phase: str
    parts: list[str] = field(default_factory=list)


class StructuredOutputAccumulator:
    """Group text by output item and select one authoritative result."""

    def __init__(self) -> None:
        self._items: dict[str, _ContentItem] = {}

    def add_chunk(self, chunk: StreamChunk) -> None:
        if chunk.kind != "content":
            return
        self.add_text(str(chunk.data.get("text") or ""), chunk.data)

    def add_text(self, text: str, provenance: dict[str, Any] | None = None) -> None:
        if not text:
            return
        source = provenance or {}
        item_id = str(source.get("item_id") or LEGACY_ITEM_ID)
        phase = str(source.get("phase") or "unknown")
        existing = self._items.get(item_id)
        if existing is not None:
            if existing.phase != phase and existing.phase != "unknown" and phase != "unknown":
                raise StructuredOutputCardinalityError(
                    f"Output item {item_id} changed phase from {existing.phase} to {phase}"
                )
            if existing.phase == "unknown" and phase != "unknown":
                existing.phase = phase
            existing.parts.append(text)
            return
        self._items[item_id] = _ContentItem(
            item_id=item_id,
            output_index=int(source.get("output_index") or 0),
            content_index=int(source.get("content_index") or 0),
            phase=phase,
            parts=[text],
        )

    def current_text(self) -> str:
        return self._select(require_exactly_one=False)

    def has_content(self) -> bool:
        return bool(self._items)

    def final_text(self) -> str:
        return self._select(require_exactly_one=True)

    def _select(self, *, require_exactly_one: bool) -> str:
        items = list(self._items.values())
        final_items = [item for item in items if item.phase == "final_answer"]
        if len(final_items) == 1:
            return "".join(final_items[0].parts)
        if len(final_items) > 1:
            raise StructuredOutputCardinalityError(f"Expected one final_answer item, received {len(final_items)}")

        eligible_items = [item for item in items if item.phase not in IGNORED_PHASES]
        if len(eligible_items) == 1:
            return "".join(eligible_items[0].parts)
        if not require_exactly_one:
            return ""
        raise StructuredOutputCardinalityError(f"Expected one structured output item, received {len(eligible_items)}")
