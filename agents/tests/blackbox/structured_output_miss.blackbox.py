"""Cross-verify Python structured-output finalize never throws cardinality.

The TS chat/SMS/schema-gen holes were currentText vs finalText. The Python
agent loop had the same class: has_content() is true for reasoning-only
items, then final_text() threw outside the parse-retry try.
"""

from __future__ import annotations

import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

from providers.rose.structured_output import StructuredOutputAccumulator, StructuredOutputCardinalityError

REPO = AGENTS_ROOT


def _reasoning_only() -> StructuredOutputAccumulator:
    acc = StructuredOutputAccumulator()
    acc.add_text("thinking about the answer", {"item_id": "reasoning:0", "phase": "reasoning"})
    return acc


def _ambiguous() -> StructuredOutputAccumulator:
    acc = StructuredOutputAccumulator()
    acc.add_text('{"answer":"one"}', {"item_id": "final-1", "phase": "final_answer", "output_index": 0})
    acc.add_text('{"answer":"two"}', {"item_id": "final-2", "phase": "final_answer", "output_index": 1})
    return acc


def test_degrade_paths_never_throw_current_text() -> None:
    cases = {
        "empty": StructuredOutputAccumulator(),
        "reasoning-only": _reasoning_only(),
        "ambiguous": _ambiguous(),
    }
    for name, acc in cases.items():
        assert acc.current_text() == "", name
        raised = False
        try:
            acc.final_text()
        except StructuredOutputCardinalityError:
            raised = True
        assert raised, f"{name}: final_text must still be the strict path"


def test_has_content_is_not_the_health_check() -> None:
    """Reasoning-only streams have items, so has_content() is True.

    Gating final_text() on has_content() was the remaining Python hole:
    the strict selector then threw before the parse-retry try.
    """
    acc = _reasoning_only()
    assert acc.has_content() is True
    assert acc.current_text() == ""


def test_production_callers_use_current_text() -> None:
    files = [
        REPO / "helpers" / "llm.py",
        REPO / "providers" / "rose" / "client.py",
    ]
    for path in files:
        source = path.read_text()
        assert "final_text()" not in source, f"{path} must not call final_text()"
        assert "current_text()" in source, f"{path} must use current_text()"


async def run_all_tests() -> dict[str, int]:
    test_degrade_paths_never_throw_current_text()
    test_has_content_is_not_the_health_check()
    test_production_callers_use_current_text()
    print("  ✅ degrade paths never throw current_text")
    print("  ✅ has_content is not the health check")
    print("  ✅ production callers use current_text")
    return {"passed": 3, "failed": 0, "total": 3}


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
