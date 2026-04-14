"""Collective Exhaustiveness evaluator: checks tasks fully cover the goal.

Uses Opus 4.6 via OpenRouter to evaluate whether completing all decomposed
tasks would fully accomplish the original goal.
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


class CEJudgment(BaseModel):
    passed: bool = Field(description='True if tasks collectively exhaust the goal')
    score: float = Field(description='0.0-1.0, 1.0 = complete coverage')
    reasoning: str = Field(
        description='2-3 concise bullet points (• prefix) about coverage analysis'
    )


CE_PROMPT = """You are evaluating whether a task decomposition satisfies COLLECTIVE EXHAUSTIVENESS.

GOAL: {goal}

USER CONTEXT (clarification messages that informed the decomposition):
{context_formatted}

DECOMPOSITION:
{tasks_formatted}

COLLECTIVE EXHAUSTIVENESS means: Completing ALL tasks would fully accomplish the original goal. No important step is missing. If there's a gap — something the user needs that no task covers — CE is violated.

Evaluate carefully:
1. What does the goal require end-to-end?
2. Does the decomposition cover every required step?
3. Are there any gaps or missing steps?
4. Consider implicit requirements (e.g. "buy me X" implies payment, delivery confirmation)
5. For vague goals, be reasonable about scope — "make me happy" doesn't need to solve every problem

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


async def evaluate_ce(
    goal: str, planner_response: PlannerResponse, agent_context: list | None = None
) -> EvalResult:
    """Evaluate collective exhaustiveness of a decomposition using Opus 4.6."""
    tasks_formatted = '\n'.join(
        f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
        for i, t in enumerate(planner_response.tasks)
    )

    prompt = CE_PROMPT.format(
        goal=goal,
        tasks_formatted=tasks_formatted,
        context_formatted=_format_context(agent_context or []),
    )

    messages = [
        {'role': 'system', 'content': prompt},
        {'role': 'user', 'content': 'Evaluate collective exhaustiveness and return your judgment.'},
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
                response_model=CEJudgment,
                on_chunk=noop,
                model_seed=MODEL_SEED,
            )
            return EvalResult(
                passed=result.passed, score=result.score, reasoning=result.reasoning
            ), usage
        except Exception as e:
            last_err = e
            logger.warning(
                f'CE evaluation attempt {attempt + 1}/3 failed ({type(e).__name__}): {e}'
            )
            if attempt < 2:
                await asyncio.sleep(2)
    logger.error(f'CE evaluation failed after 3 attempts ({type(last_err).__name__}): {last_err}')
    return EvalResult(
        passed=False,
        score=0.0,
        reasoning=f'Evaluation error ({type(last_err).__name__}): {last_err}',
    ), {}
