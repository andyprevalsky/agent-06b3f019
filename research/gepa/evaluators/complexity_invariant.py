"""Complexity Invariant evaluator: checks no sub-task is more complex than the original.

Uses Opus 4.6 via OpenRouter to evaluate whether each decomposed task is
strictly less complex than the parent goal.
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


class CXJudgment(BaseModel):
    passed: bool = Field(description='True if all tasks are less complex than the parent')
    score: float = Field(description='0.0-1.0, 1.0 = all tasks clearly simpler')
    reasoning: str = Field(description='2-3 concise bullet points (• prefix) about complexity comparison')


CX_PROMPT = """You are evaluating whether a task decomposition satisfies the COMPLEXITY INVARIANT.

GOAL: {goal}

USER CONTEXT (clarification messages that informed the decomposition):
{context_formatted}

DECOMPOSITION:
{tasks_formatted}

COMPLEXITY INVARIANT means: Every sub-task must be STRICTLY LESS COMPLEX than the original goal. If any single task is as complex or more complex than the parent goal, the decomposition has failed — it hasn't actually reduced complexity.

Evaluate carefully:
1. Compare each task's complexity to the ORIGINAL goal
2. A task that basically restates the goal is a violation (e.g. goal "plan a wedding", task "plan the wedding logistics")
3. Using spawn_sub_agent is acceptable for complex sub-tasks — that's delegation, not a violation
4. Consider both cognitive complexity (decisions/research needed) and execution complexity (steps/time)

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


async def evaluate_complexity(goal: str, planner_response: PlannerResponse, agent_context: list = None) -> EvalResult:
    """Evaluate complexity invariant of a decomposition using Opus 4.6."""
    tasks_formatted = '\n'.join(
        f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
        for i, t in enumerate(planner_response.tasks)
    )

    prompt = CX_PROMPT.format(goal=goal, tasks_formatted=tasks_formatted, context_formatted=_format_context(agent_context or []))

    messages = [
        {'role': 'system', 'content': prompt},
        {'role': 'user', 'content': 'Evaluate the complexity invariant and return your judgment.'},
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
                response_model=CXJudgment,
                on_chunk=noop,
                model_seed=MODEL_SEED,
            )
            return EvalResult(passed=result.passed, score=result.score, reasoning=result.reasoning), usage
        except Exception as e:
            last_err = e
            logger.warning(f'CX evaluation attempt {attempt + 1}/3 failed ({type(e).__name__}): {e}')
            if attempt < 2:
                await asyncio.sleep(2)
    logger.error(f'CX evaluation failed after 3 attempts ({type(last_err).__name__}): {last_err}')
    return EvalResult(passed=False, score=0.0, reasoning=f'Evaluation error ({type(last_err).__name__}): {last_err}'), {}
