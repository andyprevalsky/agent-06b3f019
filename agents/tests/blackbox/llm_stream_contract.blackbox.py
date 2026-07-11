"""Cross-language conformance tests for the normalized LLM stream contract."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, AsyncIterator

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
REPO_ROOT = AGENTS_ROOT.parent
sys.path.insert(0, str(AGENTS_ROOT))

from providers.rose.streaming import parse_anthropic_sse, parse_openai_sse, parse_responses_sse
from providers.rose.structured_output import StructuredOutputAccumulator, StructuredOutputCardinalityError
from providers.rose.types import StreamChunk


class FakeStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    async def aiter_lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line

    async def aclose(self) -> None:
        return None


def load_fixtures() -> dict[str, Any]:
    fixture_path = REPO_ROOT / "shared" / "llm-stream-contract" / "fixtures.json"
    return json.loads(fixture_path.read_text())


async def parse_fixture(test_case: dict[str, Any]) -> list[StreamChunk]:
    kwargs = {
        "actual_model": "contract-test-model",
        "pool_name": "contract-test-pool",
        "request_id": f"contract-{test_case['name']}",
    }
    stream = FakeStream(test_case["sse_lines"])
    if test_case["format"] == "anthropic":
        parser = parse_anthropic_sse(stream, **kwargs)
    elif test_case["format"] == "openai_chat":
        parser = parse_openai_sse(stream, **kwargs)
    else:
        parser = parse_responses_sse(stream, **kwargs)
    return [chunk async for chunk in parser]


async def test_shared_fixtures() -> None:
    fixtures = load_fixtures()
    assert fixtures["contract_version"] == 1
    assert fixtures["content_provenance_fields"] == [
        "item_id",
        "output_index",
        "content_index",
        "phase",
    ]

    for test_case in fixtures["cases"]:
        chunks = await parse_fixture(test_case)
        normalized = [{"kind": chunk.kind, "data": chunk.data} for chunk in chunks if chunk.kind != "metadata"]
        assert normalized == test_case["expected_chunks"], test_case["name"]

        accumulator = StructuredOutputAccumulator()
        for chunk in chunks:
            accumulator.add_chunk(chunk)
        assert accumulator.final_text() == test_case["expected_structured_content"], test_case["name"]


def test_ambiguous_final_items_fail_typed() -> None:
    accumulator = StructuredOutputAccumulator()
    accumulator.add_chunk(
        StreamChunk(
            kind="content",
            data={
                "text": '{"answer":"one"}',
                "item_id": "final-1",
                "output_index": 0,
                "content_index": 0,
                "phase": "final_answer",
            },
        )
    )
    accumulator.add_chunk(
        StreamChunk(
            kind="content",
            data={
                "text": '{"answer":"two"}',
                "item_id": "final-2",
                "output_index": 1,
                "content_index": 0,
                "phase": "final_answer",
            },
        )
    )

    try:
        accumulator.final_text()
    except StructuredOutputCardinalityError:
        return
    raise AssertionError("multiple final_answer items must raise StructuredOutputCardinalityError")


async def run_all_tests() -> dict[str, int]:
    await test_shared_fixtures()
    test_ambiguous_final_items_fail_typed()
    print("  ✅ shared provider fixtures")
    print("  ✅ ambiguous final items fail typed")
    return {"passed": 2, "failed": 0, "total": 2}


if __name__ == "__main__":
    asyncio.run(run_all_tests())
