"""Clarifar: runs real agent loop, stops at set_plan to capture state.

Standalone agent loop (no Temporal) that:
- Uses build_system_prompt for the exact PLAN phase prompt
- Uses create_agent_action_model for structured tool call parsing
- Calls rose-1-lite via call_llm_structured_streaming
- Intercepts set_plan → captures state and stops
- Intercepts send_message_to_user → routes to simulate_user
- Executes web_search/web_fetch via direct HTTP (no Temporal heartbeat)
"""

import json
import logging
from typing import Any
from uuid import uuid4

import httpx
from config import load_config
from helpers.llm import call_llm_structured_streaming
from helpers.prompts import build_system_prompt
from helpers.tool_schemas import (
    PLAN_PHASE_TOOLS,
    create_agent_action_model,
)

from ..types import ClarifiedTask
from .simulate_user import simulate_user

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 30
MODEL = 'rose-labs/rose-1-lite'


class SetPlanTrap(Exception):  # noqa: N818
    """Raised when agent calls set_plan. Stops the agent loop."""

    def __init__(self, plan_args: dict[str, Any]):
        self.plan_args = plan_args
        super().__init__('set_plan called')


async def _execute_web_search(query: str, max_tokens: int = 1500) -> str:
    """Execute web search via Parallel AI (no Temporal dependency)."""
    config = load_config()
    headers = {
        'x-api-key': config.parallel.api_key,
        'parallel-beta': 'search-extract-2025-10-10',
        'Content-Type': 'application/json',
    }
    payload = {
        'objective': query,
        'search_queries': [query],
        'max_results': 10,
        'excerpts': {'max_chars_per_result': max_tokens * 4},
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            'https://api.parallel.ai/v1beta/search', headers=headers, json=payload
        )
        resp.raise_for_status()
        data = resp.json()
        answer = data.get('answer', '')
        sources = [r.get('url', '') for r in data.get('results', []) if r.get('url')]
        return f'{answer}\n\nSources: {", ".join(sources[:5])}' if sources else answer


async def _execute_web_fetch(url: str, objective: str = '') -> str:
    """Execute web fetch via Jina reader (no Temporal dependency)."""
    jina_url = f'https://r.jina.ai/{url}'
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(jina_url, headers={'Accept': 'text/plain'})
        resp.raise_for_status()
        content = resp.text[:6000]  # Cap content length
        return content


async def clarifar(raw_seed: str, model: str = MODEL, verbose: bool = False) -> ClarifiedTask:
    """Run PLAN phase agent loop on raw_seed, return state at set_plan call.

    The agent runs with the exact same prompt and tools as the real PLAN phase.
    When it calls set_plan, we trap it and capture the full state.
    When it calls send_message_to_user, we route to simulate_user (strong LLM).
    """
    system_prompt = build_system_prompt(
        phase='PLAN',
        enabled_tools=PLAN_PHASE_TOOLS,
    )

    AgentAction = create_agent_action_model(PLAN_PHASE_TOOLS)  # noqa: N806

    # OpenAI-format messages
    messages: list[dict[str, Any]] = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': raw_seed},
    ]

    async def _noop_chunk(text: str, token_count: int):
        if verbose:
            print(
                f'  [{token_count} tok] {text[:80]}...'
                if len(text) > 80
                else f'  [{token_count} tok] {text}'
            )

    for iteration in range(MAX_ITERATIONS):
        if verbose:
            print(f'\n--- Iteration {iteration + 1} ---')

        # Call LLM
        response, _usage, _detected_tools = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.7,
            max_tokens=4096,
            response_model=AgentAction,
            on_chunk=_noop_chunk,
            reasoning_max_tokens=256,
        )

        # Add assistant response to messages
        response_text = response.response or ''
        if response_text:
            if verbose:
                print(f'  Agent: {response_text[:200]}')
            messages.append({'role': 'assistant', 'content': response_text})

        tool_calls = response.tool_calls or []
        if not tool_calls:
            if verbose:
                print('  (no tool calls)')
            continue

        # Process tool calls
        for tc in tool_calls:
            if tc is None:
                continue
            tc_dict = tc.model_dump() if hasattr(tc, 'model_dump') else tc
            tool_name = tc_dict.pop('tool', '')
            if not tool_name:
                continue

            if verbose:
                print(f'  Tool: {tool_name}({json.dumps(tc_dict)[:200]})')

            # --- TRAP: set_plan ---
            if tool_name == 'set_plan':
                if verbose:
                    print('\n=== SET_PLAN TRAPPED ===')
                # Exclude system prompt from stored context (regenerable via build_system_prompt)
                context_without_system = [m for m in messages if m.get('role') != 'system']
                return ClarifiedTask(
                    id=str(uuid4()),
                    raw_seed=raw_seed,
                    agent_context=context_without_system,
                    set_plan_args=tc_dict,
                )

            # --- INTERCEPT: send_message_to_user ---
            if tool_name == 'send_message_to_user':
                question = tc_dict.get('message', '')
                if verbose:
                    print('  -> Simulating user response...')
                answer = await simulate_user(question, raw_seed)
                if verbose:
                    print(f'  <- User: {answer[:200]}')
                # Add as user message (simulates the user replying)
                messages.append({'role': 'user', 'content': answer})
                continue

            # --- EXECUTE: web_search ---
            if tool_name == 'web_search':
                query = tc_dict.get('query', '')
                try:
                    result = await _execute_web_search(query)
                except Exception as e:
                    result = f'Error: {e}'
                messages.append(
                    {
                        'role': 'assistant',
                        'content': f'[web_search result for "{query}"]:\n{result}',
                    }
                )
                continue

            # --- EXECUTE: web_fetch ---
            if tool_name == 'web_fetch':
                url = tc_dict.get('url', '')
                objective = tc_dict.get('objective', '')
                try:
                    result = await _execute_web_fetch(url, objective)
                except Exception as e:
                    result = f'Error: {e}'
                messages.append(
                    {'role': 'assistant', 'content': f'[web_fetch result for {url}]:\n{result}'}
                )
                continue

            # --- SKIP: attempt_completion (shouldn't happen before set_plan) ---
            if tool_name == 'attempt_completion':
                messages.append(
                    {
                        'role': 'assistant',
                        'content': 'Error: You must call set_plan before attempt_completion.',
                    }
                )
                continue

            # Unknown tool
            messages.append(
                {
                    'role': 'assistant',
                    'content': f'Tool {tool_name} not available in clarifar mode.',
                }
            )

    # Max iterations without set_plan
    context_without_system = [m for m in messages if m.get('role') != 'system']
    return ClarifiedTask(
        id=str(uuid4()),
        raw_seed=raw_seed,
        agent_context=context_without_system,
        set_plan_args={},
    )
