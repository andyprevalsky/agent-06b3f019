"""Prime a cache-gated benchmark root's static prompt prefix before the measured run.

OpenClaw separates a warmup request from the measured one and gates only the
measured run (src/agents/live-cache-regression-policy.ts:116-178: the warmup must
show cache evidence, the best run carries the hit-rate floor). Rose roots start
cold whenever the provider cache expired between runs, so a single-call root
reads nothing even when its prefix is stable.

This sends the root's first planner request shape once, before the root exists:
the same ``build_system_prompt`` static block, the same phase tool schemas and
the same Rose client path, pool and leased token type (Claude or GPT route), so
the provider writes the static prefix the root's first call will read. It is
built without any agent identity, so a prefix that embeds run-specific bytes
(an id, a timestamp) still misses and the measured share fails.

The warmup is recorded on its own and never enters the measured share: it has no
agent id and no ``cache_sequence_id``, so no usage row is attributed to the run.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

# Mirrors AgentWorkflow: these start phases skip PLAN (workflows/agent_workflow.py).
SKIP_PLAN_START_PHASES = frozenset({"execute", "execute_continued", "execute_dag_resume", "resume"})
WARMUP_CALL_SITE = "cache_warmup"
WARMUP_USER_MESSAGE = "Cache warmup. Reply with any single valid action."
DEFAULT_ROOT_MODEL = "rose-labs/rose-1-ultra"


def root_phase(start_phase: Optional[str]) -> str:
    return "EXECUTE" if (start_phase or "") in SKIP_PLAN_START_PHASES else "PLAN"


def root_phase_tools(phase: str, goal: str) -> List[str]:
    """The tool list AgentWorkflow gives the root's first planner phase."""
    from providers.demo_cache.google_oauth_demo_fixture import matches_demo_goal
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

    if phase == "PLAN":
        return list(PLAN_PHASE_TOOLS)
    return ["google_workspace_run", "attempt_completion"] if matches_demo_goal(goal) else list(EXECUTE_PHASE_TOOLS)


def warmup_request(*, phase: str, goal: str, rose_desktop: bool) -> Dict[str, Any]:
    """Messages and action model of the root's first planner call, minus per-run context.

    Everything after the first SYSTEM_PROMPT_DYNAMIC_BOUNDARY (user context,
    phase, response schema, conversation) sits after the cached static block, so
    it may differ without changing the prefix the root reads.
    """
    from tools.prompts import TOOL_PROMPTS
    from utils.prompts import build_system_prompt
    from utils.tool_schemas import create_agent_action_model, get_tool_models

    tools = root_phase_tools(phase, goal)
    system = build_system_prompt(phase=phase, enabled_tools=tools, tool_prompts=TOOL_PROMPTS)
    return {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": WARMUP_USER_MESSAGE},
        ],
        "tool_names": tools,
        "response_model": create_agent_action_model(tools, tool_registry=get_tool_models(rose_desktop=rose_desktop)),
    }


async def _lease_compute_token(base_url: str, headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Lease through the same backend route the root's workflow uses."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(f"{base_url}/api/integrations/compute-code/credentials/token", headers=headers)
    if response.status_code != 200:
        return None
    data = response.json()
    return data if data.get("accessToken") and data.get("type") in ("claude", "gpt") else None


async def _release_lineage(base_url: str, headers: Dict[str, str], lineage_key: Optional[str]) -> None:
    if not lineage_key:
        return
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(
            f"{base_url}/api/integrations/compute-code/token/lineage-release",
            headers={**headers, "Content-Type": "application/json"},
            json={"lineageKey": lineage_key},
        )


async def warm_root_static_prefix(
    *,
    base_url: str,
    headers: Dict[str, str],
    user_id: str,
    goal: str,
    start_phase: Optional[str],
    model: Optional[str],
) -> Dict[str, Any]:
    """Send one warmup request; return its receipt (never raises)."""
    from helpers.llm import call_llm_structured_streaming
    from utils.rose_desktop import is_rose_desktop_user

    phase = root_phase(start_phase)
    record: Dict[str, Any] = {"call_site": WARMUP_CALL_SITE, "phase": phase, "model": model or DEFAULT_ROOT_MODEL}
    lease: Optional[Dict[str, Any]] = None
    try:
        lease = await _lease_compute_token(base_url, headers)
        if lease is None:
            record["error"] = "no compute token leased"
            return record
        record.update(token_type=lease["type"], token_source=lease.get("source"), pool_token_id=lease.get("poolTokenId"))
        request = warmup_request(phase=phase, goal=goal, rose_desktop=is_rose_desktop_user(user_id))
        record["tool_count"] = len(request["tool_names"])
        route = (
            {"claude_token": lease["accessToken"], "claude_token_source": lease.get("source")}
            if lease["type"] == "claude"
            else {
                "gpt_token": lease["accessToken"],
                "gpt_account_id": lease.get("accountId"),
                "gpt_token_source": lease.get("source"),
            }
        )

        async def _ignore_chunk(_text: str, _tokens: int) -> None:
            return None

        _result, usage, _tools = await call_llm_structured_streaming(
            messages=request["messages"],
            model=model or DEFAULT_ROOT_MODEL,
            temperature=1.0,
            max_tokens=1024,
            response_model=request["response_model"],
            on_chunk=_ignore_chunk,
            reasoning_max_tokens=256,
            call_site=WARMUP_CALL_SITE,
            compute_token_lineage_key=lease.get("lineageKey"),
            **route,
        )
        record.update(
            actual_model=usage.get("actual_model"),
            cache_read_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
            cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
            uncached_input_tokens=int(usage.get("prompt_tokens") or 0),
        )
    except Exception as exc:  # the measured run is still scored on its own
        record["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
    finally:
        if lease is not None:
            try:
                await _release_lineage(base_url, headers, lease.get("lineageKey"))
            except Exception as exc:
                record["release_error"] = str(exc)[:200]
    return record
