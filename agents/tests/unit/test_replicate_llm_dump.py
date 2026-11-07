"""scripts/replicate_llm_dump.py replays a dump on the route prod used (RCA 2026-11-06).

Rose routes by call site: providers/rose/flash_agent.py grants the flash-agent
subscription legs (claude-opus-5-5 / gpt-6.1-terra) only to the literal
plan_loop / execute_loop / explore_agent sites. The replay renamed every site to
replicate_<site>, so a plan_loop replay silently ran on the waterfall instead of
the model prod served.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path
from typing import Any

from providers.rose.flash_agent import is_flash_agent_call

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "replicate_llm_dump.py"


def _load_script():
    saved = dict(os.environ)  # the script loads agents/.env into os.environ on import
    try:
        spec = importlib.util.spec_from_file_location("replicate_llm_dump_test_module", SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        os.environ.clear()
        os.environ.update(saved)


class _Chunk:
    def __init__(self, kind: str, data: dict[str, Any]):
        self.kind, self.data = kind, data


def _fake_client(calls: list[dict[str, Any]], module):
    class FakeRoseClient:
        async def complete(self, **kwargs: Any):
            calls.append(kwargs)
            yield _Chunk("metadata", {"actual_model": "claude-opus-5-5-claude", "pool_name": "claude-token"})

        async def collect(self, **kwargs: Any):
            calls.append(kwargs)
            return module.RoseResponse()

    return FakeRoseClient


def _dump(call_site: str, *, effort: str | None) -> dict[str, Any]:
    config: dict[str, Any] = {"pool": "rose-1-flash", "requested_params": {"temperature": 1.0, "max_tokens": 64}}
    if effort:
        config["reasoning_effort"] = effort
    return {
        "call_site": call_site,
        "agent_id": "agent-1",
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        "tools": [{"name": "set_plan", "description": "d", "input_schema": {"type": "object"}}],
        "config": config,
    }


def test_replays_keep_the_dumped_call_site_and_its_subscription_route() -> None:
    module = _load_script()
    calls: list[dict[str, Any]] = []
    module.RoseClient = _fake_client(calls, module)

    async def no_auth(_data: dict[str, Any]) -> dict[str, Any]:
        return {}

    module.direct_auth_from_dump = no_auth
    for effort in ("medium", None):  # complete() path and collect() path
        for site in ("plan_loop", "execute_loop"):
            asyncio.run(module.replay_generic(_dump(site, effort=effort)))
    planner = {**_dump("planner", effort="max"), "config": {"pool": "rose-1-ultra", "reasoning_effort": "max"}}
    asyncio.run(module.replay_planner(planner, mode="exact", assertions=[]))

    sites = [call["call_site"] for call in calls]
    assert sites == ["plan_loop", "execute_loop", "plan_loop", "execute_loop", "planner"], sites
    for call in calls[:4]:
        assert is_flash_agent_call(call["pool"], call["call_site"]), call["call_site"]
        assert call["dump_extra"]["replicated_from"] == call["call_site"], "replays stay marked in dumps"
