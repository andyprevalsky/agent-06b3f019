"""Mutual Exclusivity evaluator: checks tasks don't overlap in scope.

Uses Opus 4.6 via OpenRouter to evaluate whether decomposed tasks are
mutually exclusive (no overlapping responsibilities).
"""

import asyncio
import logging

from helpers.llm import call_llm_structured_streaming
from helpers.tool_schemas import PlannerResponse
from pydantic import BaseModel, Field

from ..types import EvalResult

logger = logging.getLogger(__name__)

MODEL = 'rose-labs/rose-1-ultra'
MODEL_SEED = 0  # Opus 4.6 in ultra pool


class MEJudgment(BaseModel):
    passed: bool = Field(description='True if tasks are mutually exclusive')
    score: float = Field(description='0.0-1.0, 1.0 = perfectly non-overlapping')
    reasoning: str = Field(description='2-3 concise bullet points (• prefix) about overlap analysis')


ME_PROMPT = """You are evaluating whether a task decomposition satisfies MUTUAL EXCLUSIVITY.

GOAL: {goal}

USER CONTEXT (clarification messages that informed the decomposition):
{context_formatted}

DECOMPOSITION:
{tasks_formatted}

MUTUAL EXCLUSIVITY means: No two tasks overlap in scope or responsibility. Each task covers a distinct, non-overlapping piece of the goal. If Task A and Task B both touch the same work, ME is violated.

Evaluate carefully:
1. For each pair of tasks, check if their scopes overlap
2. Minor shared context (e.g. both need to know the user's name) does NOT count as overlap
3. Doing similar work for DIFFERENT targets (e.g. "search site A" and "search site B") is NOT overlap
4. But "research options" and "find best option" DO overlap — the second subsumes part of the first

Format your reasoning as 2-3 concise bullet points (use • prefix). No paragraphs.

Return your judgment as JSON."""


def _format_context(agent_context: list) -> str:
    if not agent_context:
        return '  (no additional context)'
    lines = []
    for msg in agent_context:
        role = msg.get('role', 'unknown').upper()
        content = msg.get('content', '')
        lines.append(f'  [{role}]: {content}')
    return '\n'.join(lines)


async def evaluate_me(goal: str, planner_response: PlannerResponse, agent_context: list = None) -> EvalResult:
    """Evaluate mutual exclusivity of a decomposition using Opus 4.6."""
    tasks_formatted = '\n'.join(
        f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
        for i, t in enumerate(planner_response.tasks)
    )

    prompt = ME_PROMPT.format(goal=goal, tasks_formatted=tasks_formatted, context_formatted=_format_context(agent_context or []))

    messages = [
        {'role': 'system', 'content': prompt},
        {'role': 'user', 'content': 'Evaluate mutual exclusivity and return your judgment.'},
    ]

    async def noop(text: str, count: int):
        pass

    last_err = None
    for attempt in range(3):
        try:
            result, usage, _ = await call_llm_structured_streaming(
                messages=messages,
                model=MODEL,
                temperature=0.0,
                max_tokens=1024,
                response_model=MEJudgment,
                on_chunk=noop,
                model_seed=MODEL_SEED,
            )
            return EvalResult(passed=result.passed, score=result.score, reasoning=result.reasoning), usage
        except Exception as e:
            last_err = e
            logger.warning(f'ME evaluation attempt {attempt + 1}/3 failed ({type(e).__name__}): {e}')
            if attempt < 2:
                await asyncio.sleep(2)
    logger.error(f'ME evaluation failed after 3 attempts ({type(last_err).__name__}): {last_err}')
    return EvalResult(passed=False, score=0.0, reasoning=f'Evaluation error ({type(last_err).__name__}): {last_err}'), {}
