"""Opt-in live Foundry Responses contract: text, forced tool, and JSON schema.

Run from the repository root with Azure credentials available:
RUN_FOUNDRY_LIVE=1 PYTHONPATH=agents python3 -m pytest -q agents/tests/e2e/test_foundry_live.py
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from dotenv import load_dotenv

from providers.rose.client import RoseClient
from providers.rose.foundry import foundry_complete, foundry_configured
from providers.rose.pools import get_pool
from providers.rose.structured_output import StructuredOutputAccumulator


async def _probe(name: str, *, tools=None, tool_choice=None, response_format=None) -> None:
    async def collect():
        return [
            chunk
            async for chunk in foundry_complete(
                pool_spec=get_pool("rose-1-ultra"),
                messages=[{"role": "user", "content": "Reply with hi. Use the tool if one is provided."}],
                response_format=response_format,
                tools=tools,
                context_tools=None,
                tool_choice=tool_choice,
                temperature=None,
                effort="xhigh",
                provider_fast_mode=True,
                request_id=f"foundry-live-{name}",
                route_key=None,
                agent_id=None,
                call_site="foundry-live-smoke",
                cache_namespace=None,
                ttft_timeout_s=60,
                idle_timeout_s=60,
            )
        ]

    chunks = await asyncio.wait_for(collect(), timeout=120)
    kinds = {chunk.kind for chunk in chunks}
    assert {"metadata", "usage", "done"}.issubset(kinds), f"{name}: incomplete stream ({sorted(kinds)})"
    assert chunks[0].data["actual_model"] == "gpt-6-sol-foundry"
    if name == "tool":
        assert "tool_call" in kinds
        arguments = json.loads(next(chunk.data["arguments"] for chunk in chunks if chunk.kind == "tool_call"))
        assert isinstance(arguments.get("text"), str)
    else:
        assert "content" in kinds
    if name == "json":
        result = StructuredOutputAccumulator()
        for chunk in chunks:
            result.add_chunk(chunk)
        assert isinstance(json.loads(result.final_text()).get("text"), str)


@pytest.mark.asyncio
async def test_foundry_live_responses_contract():
    if os.getenv("RUN_FOUNDRY_LIVE") != "1":
        pytest.skip("Set RUN_FOUNDRY_LIVE=1 to exercise the Azure deployment")
    repo = Path(__file__).resolve().parents[3]
    load_dotenv(repo / "agents" / ".env", override=False)
    assert foundry_configured(get_pool("rose-1-ultra")), "Foundry endpoint and key are required"
    await _probe("text")
    await _probe(
        "tool",
        tools=[
            {
                "name": "answer",
                "description": "Return the short answer",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
                "strict": True,
            }
        ],
        tool_choice={"name": "answer"},
    )
    await _probe(
        "json",
        response_format={
            "json_schema": {
                "name": "short_answer",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            }
        },
    )

    gpt_key = os.environ.get("GPT_API_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    try:
        os.environ["GPT_API_KEY"] = ""
        os.environ["ANTHROPIC_API_KEY"] = ""
        chunks = [
            chunk
            async for chunk in RoseClient().complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "Reply with hi."}],
                dump_context=False,
                _exclude_anthropic_family=True,
            )
        ]
        assert chunks[0].data["actual_model"] == "gpt-6-sol-foundry"
        assert any(chunk.kind == "content" for chunk in chunks)
    finally:
        if gpt_key is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = gpt_key
        if anthropic_key is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = anthropic_key
