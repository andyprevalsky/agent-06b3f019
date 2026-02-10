"""Decomposer: generates K candidate decompositions using the exact same planner prompt as production.

Replicates the message construction from agents/tools/set_plan.py and calls
call_llm_structured_streaming with PlannerResponse, routing through rose-1-ultra.
"""

import asyncio
import logging
from typing import List, Optional

from config import load_config
from helpers.llm import call_llm_structured_streaming
from helpers.prompts import build_planner_system_prompt
from helpers.tool_schemas import PlannerResponse
from tools.set_plan import _get_planner_tools_description

from ..types import ClarifiedTask, DecompositionCandidate
from ..validators import validate_decomposition

logger = logging.getLogger(__name__)

MODEL = 'rose-labs/rose-1-ultra'
# Ultra pool: 0=Opus4.6, 1=GPT-5.2, 2=Gemini3Pro, 3=KimiK2.5
K_CANDIDATES = 4
TEMPERATURES = [0.7, 0.7, 0.7, 0.7]


def _build_planner_messages(task: ClarifiedTask) -> list:
    """Build messages for the planner LLM, matching set_plan.py exactly.

    From agents/tools/set_plan.py lines 218-231:
    - First message: "GOAL: {goal}\\n\\nPlan this goal into tasks."
    - Then all context messages mapped by role (USER→user, ASSISTANT→assistant, TOOL/SYSTEM→user with prefix)
    """
    # First user message from context is the raw seed
    goal = task.raw_seed

    base_messages = [
        {'role': 'user', 'content': f'GOAL: {goal}\n\nPlan this goal into tasks.'}
    ]

    # Map agent_context messages (these use lowercase roles from clarifar)
    for msg in task.agent_context:
        role = msg.get('role', '').upper()
        text = msg.get('content', '')
        if not text:
            continue
        if role == 'USER':
            base_messages.append({'role': 'user', 'content': text})
        elif role == 'ASSISTANT':
            base_messages.append({'role': 'assistant', 'content': text})
        elif role in ('TOOL', 'SYSTEM'):
            base_messages.append({'role': 'user', 'content': f'[{role}]: {text}'})

    return base_messages


async def decompose_once(
    task: ClarifiedTask,
    model: str = MODEL,
    temperature: float = 0.7,
    model_seed: int = 0,
    system_prompt: str | None = None,
) -> DecompositionCandidate:
    """Generate a single candidate decomposition for a clarified task."""
    if system_prompt is None:
        tools_description = _get_planner_tools_description()
        system_prompt = build_planner_system_prompt(tools_description)

    base_messages = _build_planner_messages(task)
    full_messages = [{'role': 'system', 'content': system_prompt}] + base_messages

    async def noop(text: str, count: int):
        pass

    result, usage, _ = await call_llm_structured_streaming(
        messages=full_messages,
        model=model,
        temperature=temperature,
        max_tokens=4096,
        response_model=PlannerResponse,
        on_chunk=noop,
        model_seed=model_seed,
    )

    errors = validate_decomposition(result)

    return DecompositionCandidate(
        planner_response=result,
        validation_errors=errors,
    ), usage


async def decompose_k(
    task: ClarifiedTask,
    k: int = K_CANDIDATES,
    model: str = MODEL,
    temperatures: List[float] = TEMPERATURES,
) -> List[DecompositionCandidate]:
    """Generate K candidate decompositions in parallel, each with a different model_seed."""
    temps = temperatures[:k] if len(temperatures) >= k else (temperatures * ((k // len(temperatures)) + 1))[:k]
    coros = [decompose_once(task, model, temp, model_seed=i) for i, temp in enumerate(temps)]
    results = await asyncio.gather(*coros, return_exceptions=True)

    candidates = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            logger.error(f'Candidate {i} failed: {r}')
            continue
        candidate, _usage = r
        candidates.append(candidate)

    return candidates
