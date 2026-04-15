"""GEPA prompt optimizer: evolves the planner's core strategy section using DSPy GEPA.

Optimizes 3 sections of the planner system prompt (lines 603-629 of agents/helpers/prompts.py):
  1. TWO-AXIS PLANNING FRAMEWORK — uncertainty vs decomposability heuristic
  2. DECOMPOSITION PRINCIPLES — MECE, parallelization, granularity, determinism
  3. TASK COUNT LIMITS — 3-8 task range guidance

Everything else (OUTPUT CONTRACT, AVAILABLE TOOLS, examples, reminders) stays fixed.

Usage:
    result = optimize_prompt(auto='light', critic_model_id='reward_model')
    print(result.optimized_strategy)
    # Use result.optimized_prompt as a drop-in replacement for build_planner_system_prompt()

NOTE: dspy is imported lazily inside functions that need it to avoid a module name
collision between the pip 'gepa' package (dspy dependency) and our local research/gepa/.
"""

import json
import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from helpers.prompts import build_planner_system_prompt
from helpers.tool_schemas import PlannerResponse
from tools.set_plan import _get_planner_tools_description

from ..critic import score_candidates
from ..scoring import final_score, hard_gate

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
TASKS_DIR = DATA_DIR / 'clarified_tasks'

# Markers for the evolvable strategy section in the planner prompt.
# The planner prompt may have the original markers or an overridden strategy
# (via planner_strategy_override_v3.txt). We try each in order.
STRATEGY_STARTS = ['TWO-AXIS PLANNING FRAMEWORK', 'PLANNING INSTRUCTION']
STRATEGY_ENDS = ['SPAWN_SUB_AGENT TOOL', 'SELF-CONTAINED GOALS (CRITICAL)']
# Legacy aliases for backwards compatibility with tests
STRATEGY_START = STRATEGY_STARTS[0]
STRATEGY_END = STRATEGY_ENDS[0]

# Default critic model ID on Modal
DEFAULT_CRITIC_MODEL_ID = 'reward_model'


# ---------------------------------------------------------------------------
# A. Strategy extraction + prompt composition
# ---------------------------------------------------------------------------


def extract_strategy(full_prompt: str) -> str:
    """Extract the evolvable strategy section from the full planner prompt.

    Handles both original markers (TWO-AXIS PLANNING FRAMEWORK ... SPAWN_SUB_AGENT TOOL)
    and overridden markers (PLANNING INSTRUCTION ... SELF-CONTAINED GOALS).
    """
    start = -1
    for marker in STRATEGY_STARTS:
        start = full_prompt.find(marker)
        if start >= 0:
            break
    if start < 0:
        raise ValueError(f'Strategy start marker not found. Tried: {STRATEGY_STARTS}')

    end = -1
    for marker in STRATEGY_ENDS:
        end = full_prompt.find(marker, start + 1)
        if end >= 0:
            break
    if end < 0:
        raise ValueError(f'Strategy end marker not found. Tried: {STRATEGY_ENDS}')

    return full_prompt[start:end].rstrip()


def compose_prompt(strategy: str) -> str:
    """Rebuild the full planner system prompt with an evolved strategy injected."""
    tools_desc = _get_planner_tools_description()
    full = build_planner_system_prompt(tools_desc)
    original = extract_strategy(full)
    return full.replace(original, strategy)


def get_initial_strategy() -> str:
    """Get the current production strategy section."""
    tools_desc = _get_planner_tools_description()
    return extract_strategy(build_planner_system_prompt(tools_desc))


def _build_prompt_skeleton() -> str:
    """Extract the fixed parts of the prompt (everything except the strategy section).

    This is passed as an input field to the DSPy module so the LLM sees
    structural requirements (OUTPUT CONTRACT, tool examples, reminders)
    but GEPA doesn't modify them.
    """
    tools_desc = _get_planner_tools_description()
    full = build_planner_system_prompt(tools_desc)
    strategy = extract_strategy(full)
    return full.replace(strategy, '').strip()


# ---------------------------------------------------------------------------
# B. DSPy Signature + Module (lazy imports to avoid gepa name collision)
# ---------------------------------------------------------------------------


def _make_signature_class():
    """Dynamically create the PlanGoal Signature with the current strategy as docstring."""
    import dspy

    initial_strategy = get_initial_strategy()

    class PlanGoal(dspy.Signature):
        __doc__ = initial_strategy

        goal: str = dspy.InputField(desc="The user's goal to decompose into tasks")
        context: str = dspy.InputField(
            desc='Conversation history (JSON array of user/assistant turns)'
        )
        prompt_skeleton: str = dspy.InputField(
            desc='Fixed prompt sections: output contract, tool descriptions, examples, and reminders. '
            'Follow these structural requirements exactly.'
        )
        plan_json: str = dspy.OutputField(
            desc='Valid JSON object with keys: "title" (string), "content" (string), '
            '"tasks" (array of {"goal": string, "tool_name": string, "depends_on": [int]}), '
            '"dependencies_graph" (array of {"task_idx": string, "depends_on": [string]}), '
            '"join" ("all" or "any"). Output ONLY the JSON, no prose.'
        )

    return PlanGoal


def _make_decomposer_module():
    """Create a DecomposerModule instance (imports dspy lazily)."""
    import dspy

    class DecomposerModule(dspy.Module):
        def __init__(self):
            super().__init__()
            plan_goal_sig = _make_signature_class()
            self.planner = dspy.Predict(plan_goal_sig)

        def forward(self, goal, context, prompt_skeleton):
            return self.planner(goal=goal, context=context, prompt_skeleton=prompt_skeleton)

    return DecomposerModule()


# ---------------------------------------------------------------------------
# C. Helpers
# ---------------------------------------------------------------------------


def _parse_plan(plan_json_str: str) -> PlannerResponse | None:
    """Try to parse a JSON string into a PlannerResponse. Returns None on failure."""
    try:
        data = json.loads(plan_json_str)
        return PlannerResponse(**data)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# D. Metric function
# ---------------------------------------------------------------------------

MAX_RETRIES = 3
RETRY_DELAY_S = 2.0


def _retry(fn, label: str, max_retries: int = MAX_RETRIES):
    """Call fn() with retries. Raises RuntimeError after max_retries failures."""
    import time

    last_err = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                wait = RETRY_DELAY_S * (attempt + 1)
                logger.warning(
                    f'{label} retry {attempt + 1}/{max_retries}: {type(e).__name__}: {e} (sleep {wait:.1f}s)'
                )
                time.sleep(wait)
    raise RuntimeError(
        f'{label} failed after {max_retries} attempts: {type(last_err).__name__}: {last_err}'
    ) from last_err


def make_gepa_metric(critic_model_id: str = DEFAULT_CRITIC_MODEL_ID):
    """Create a DSPy metric function that scores decompositions via our pipeline.

    Pipeline: parse JSON → hard_gate → critic + ME/CE/CX evaluators → final_score
    Each call (critic, ME, CE, CX) retries independently.
    Raises on persistent failure to pause the run for debugging.
    """
    import asyncio

    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    from .benchmark import _eval_ce, _eval_cx, _eval_me

    async def _run_evaluators(goal: str, pr: PlannerResponse, ctx: list):
        """Run ME/CE/CX evaluators concurrently with per-call retries."""

        async def _retry_async(coro_fn, label):
            last_err = None
            for attempt in range(MAX_RETRIES):
                try:
                    return await coro_fn()
                except Exception as e:
                    last_err = e
                    if attempt < MAX_RETRIES - 1:
                        wait = RETRY_DELAY_S * (attempt + 1)
                        logger.warning(
                            f'{label} retry {attempt + 1}/{MAX_RETRIES}: {type(e).__name__}: {e} (sleep {wait:.1f}s)'
                        )
                        await asyncio.sleep(wait)
            raise RuntimeError(
                f'{label} failed after {MAX_RETRIES} attempts: {type(last_err).__name__}: {last_err}'
            ) from last_err

        me_result, ce_result, cx_result = await asyncio.gather(
            _retry_async(lambda: _eval_me(goal, pr, ctx), 'ME'),
            _retry_async(lambda: _eval_ce(goal, pr, ctx), 'CE'),
            _retry_async(lambda: _eval_cx(goal, pr, ctx), 'CX'),
        )
        return me_result[0].score, ce_result[0].score, cx_result[0].score

    def gepa_metric(example, pred, trace=None, pred_name=None, pred_trace=None):
        plan_text = pred.plan_json
        # Strip markdown fences if model wrapped the JSON
        if plan_text.strip().startswith('```'):
            lines = plan_text.strip().split('\n')
            lines = [l for l in lines if not l.strip().startswith('```')]
            plan_text = '\n'.join(lines)

        pr = _parse_plan(plan_text)
        if pr is None:
            logger.debug(f'Metric: parse failed for plan_json: {pred.plan_json[:200]}')
            return ScoreWithFeedback(
                score=0.0, feedback=f'Could not parse JSON output: {pred.plan_json[:200]}'
            )

        gate = hard_gate(pr)
        if math.isinf(gate):
            logger.debug(f'Metric: hard_gate failed ({len(pr.tasks)} tasks)')
            return ScoreWithFeedback(
                score=0.0,
                feedback=f'Invalid structure: {len(pr.tasks)} tasks (need 2-8) or cycle detected',
            )

        ctx = json.loads(example.context) if isinstance(example.context, str) else example.context
        plan_dict = json.loads(plan_text)

        # Each call retries independently — a critic success isn't wasted if ME fails
        raw_scores = _retry(
            lambda: score_candidates([plan_dict], example.goal, ctx, model_id=critic_model_id),
            'Critic',
        )
        critic = 1.0 / (1.0 + math.exp(-raw_scores[0]))
        me, ce, cx = asyncio.run(_run_evaluators(example.goal, pr, ctx))

        score = max(0.0, final_score(critic, me, ce, cx))
        logger.info(
            f'Metric: critic={critic:.3f}, ME={me:.2f}, CE={ce:.2f}, CX={cx:.2f}, final={score:.3f}'
        )
        return ScoreWithFeedback(
            score=score,
            feedback=f'critic={critic:.3f}, ME={me:.2f}, CE={ce:.2f}, CX={cx:.2f}, final={score:.3f}',
        )

    return gepa_metric


# ---------------------------------------------------------------------------
# E. Data loader
# ---------------------------------------------------------------------------


def _load_trainset(tasks_dir: Path = TASKS_DIR) -> list:
    """Load ClarifiedTasks as DSPy Examples with fixed prompt skeleton."""
    import dspy

    skeleton = _build_prompt_skeleton()
    examples = []
    for path in sorted(tasks_dir.glob('*.json')):
        try:
            data = json.loads(path.read_text())
            examples.append(
                dspy.Example(
                    goal=data['raw_seed'],
                    context=json.dumps(data['agent_context']),
                    prompt_skeleton=skeleton,
                ).with_inputs('goal', 'context', 'prompt_skeleton')
            )
        except Exception as e:
            logger.warning(f'Skipping {path.name}: {e}')
    logger.info(f'Loaded {len(examples)} training examples from {tasks_dir}')
    return examples


# ---------------------------------------------------------------------------
# F. Main optimization function
# ---------------------------------------------------------------------------


@dataclass
class OptimizationResult:
    optimized_strategy: str
    optimized_prompt: str
    initial_score: float
    final_score: float
    num_trials: int
    demos: list = field(default_factory=list)


def optimize_prompt(
    auto: Literal['light', 'medium', 'heavy'] = 'light',
    critic_model_id: str = DEFAULT_CRITIC_MODEL_ID,
    num_threads: int = 4,
    tasks_dir: Path = TASKS_DIR,
    openrouter_api_key: str | None = None,
    trainset: list | None = None,
    metric=None,
    reflection_lm=None,
) -> OptimizationResult:
    """Optimize the planner strategy section using DSPy GEPA.

    Args:
        auto: Optimization intensity ('light', 'medium', 'heavy').
        critic_model_id: Trained reward model ID on Modal.
        num_threads: Concurrent evaluation threads.
        tasks_dir: Path to clarified tasks directory.
        openrouter_api_key: OpenRouter API key. Defaults to OPENROUTER_API_KEY env var.
        trainset: Pre-built DSPy Examples. If None, loads from tasks_dir.
        metric: Custom metric function. If None, uses critic-based gepa_metric.
        reflection_lm: dspy.LM for GEPA reflection. If None, uses default configured LM.

    Returns:
        OptimizationResult with the evolved strategy and full composed prompt.
    """
    import dspy

    api_key = openrouter_api_key or os.getenv('OPENROUTER_API_KEY')
    if not api_key:
        raise ValueError('OPENROUTER_API_KEY env var or openrouter_api_key arg required')

    lm = dspy.LM('openrouter/anthropic/claude-opus-4-6', api_key=api_key)
    dspy.configure(lm=lm)

    if trainset is None:
        trainset = _load_trainset(tasks_dir)
    if not trainset:
        raise ValueError(f'No training examples found in {tasks_dir}')

    module = _make_decomposer_module()
    if metric is None:
        metric = make_gepa_metric(critic_model_id)

    logger.info(f'Starting GEPA optimization (auto={auto}, {len(trainset)} tasks)')

    optimizer = dspy.GEPA(
        metric=metric,
        auto=auto,
        num_threads=num_threads,
        reflection_lm=reflection_lm or lm,
    )
    optimized = optimizer.compile(module, trainset=trainset)

    # Extract optimized instruction (the evolved strategy)
    optimized_strategy = optimized.planner.signature.instructions
    demos = getattr(optimized.planner, 'demos', [])

    return OptimizationResult(
        optimized_strategy=optimized_strategy,
        optimized_prompt=compose_prompt(optimized_strategy),
        initial_score=0.0,  # GEPA tracks this internally
        final_score=0.0,
        num_trials=0,
        demos=demos,
    )
