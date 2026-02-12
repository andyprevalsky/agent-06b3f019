"""Benchmark planner decomposition quality across models and prompts.

Compares 5 configurations across the GEPA evaluation suite:
  1. Opus 4.6     + baseline prompt
  2. GPT 5.2      + baseline prompt
  3. Gemini 3 Pro + baseline prompt
  4. Kimi 2.5     + baseline prompt
  5. Rose Ultra   + GEPA-optimized prompt

Produces 4 charts:
  1. ME  (Mutual Exclusivity)       — bar chart with std error bars
  2. CE  (Collective Exhaustiveness) — bar chart with std error bars
  3. CX  (Complexity Invariant)      — bar chart with std error bars
  4. ELO (Bradley-Terry reward model) — fitted from pairwise critic comparisons

Usage:
    PYTHONPATH=agents python -m research.gepa.pipelines.benchmark
    PYTHONPATH=agents python -m research.gepa.pipelines.benchmark --tasks 5
    PYTHONPATH=agents python -m research.gepa.pipelines.benchmark --output results.json --charts charts/
"""

import argparse
import asyncio
import json
import logging
import math
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
from dotenv import load_dotenv
from scipy.optimize import minimize

# Load env before any agents imports
load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / 'agents' / '.env')

from helpers.llm import prepare_schema_for_openai
from helpers.prompts import build_planner_system_prompt
from helpers.tool_schemas import PlannerResponse
from tools.set_plan import _get_planner_tools_description

from ..scoring import hard_gate, soft_penalties, final_score
from ..types import ClarifiedTask, DecompositionCandidate
from ..validators import validate_decomposition
from .decomposer import _build_planner_messages

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
TASKS_DIR = DATA_DIR / 'clarified_tasks'       # training tasks (used by labeler + reward model)
HOLDOUT_DIR = DATA_DIR / 'benchmark_holdout'    # 100 held-out tasks (never labeled, benchmark only)


# ---------------------------------------------------------------------------
# Model configurations
# ---------------------------------------------------------------------------

@dataclass
class ModelConfig:
    name: str                    # Display name for charts
    model: str                   # OpenRouter model identifier
    prompt: str                  # 'baseline' or 'gepa'
    color: str                   # Chart color


# Direct OpenRouter model identifiers (bypass Supabase edge function)
CONFIGS = [
    ModelConfig('Opus 4.6',     'anthropic/claude-opus-4-6',       'baseline', '#6366f1'),
    ModelConfig('GPT 5.2',      'openai/gpt-5.2',                  'baseline', '#10b981'),
    ModelConfig('Gemini 3 Pro', 'google/gemini-3-pro-preview',      'baseline', '#f59e0b'),
    ModelConfig('Kimi 2.5',     'moonshotai/kimi-k2.5',            'baseline', '#ef4444'),
    ModelConfig('Rose Ultra\n(GEPA)', 'rose-labs/rose-1-ultra',     'gepa',     '#8b5cf6'),
]

OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions'
OPENROUTER_TIMEOUT = 300.0  # generous timeout for structured output
EVAL_MODEL = 'anthropic/claude-opus-4-6'


async def _call_openrouter(messages: list, response_model, model: str = EVAL_MODEL,
                           temperature: float = 0.0, max_tokens: int = 4096):
    """Call OpenRouter directly with response_format: json_schema.

    Bypasses the Supabase edge function and instructor to avoid timeout/parsing issues.
    Returns (parsed_model, usage_dict).
    """
    api_key = os.environ.get('OPENROUTER_API_KEY', '')
    schema = prepare_schema_for_openai(response_model)

    request_body = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
        'response_format': {
            'type': 'json_schema',
            'json_schema': {
                'name': response_model.__name__,
                'schema': schema,
                'strict': True,
            },
        },
    }

    async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
        resp = await client.post(
            OPENROUTER_BASE,
            json=request_body,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}',
                'HTTP-Referer': 'https://roselabs.ai',
            },
        )
        resp.raise_for_status()

    data = resp.json()
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    usage = data.get('usage', {})
    result = response_model.model_validate_json(content)
    return result, usage


async def _decompose_openrouter(
    task: ClarifiedTask, model: str, system_prompt: str, temperature: float = 0.7,
) -> tuple[DecompositionCandidate, dict]:
    """Decompose a task via direct OpenRouter call."""
    base_messages = _build_planner_messages(task)
    if base_messages and base_messages[-1]['role'] != 'user':
        base_messages.append({'role': 'user', 'content': 'Generate the plan now.'})
    messages = [{'role': 'system', 'content': system_prompt}] + base_messages

    pr, usage = await _call_openrouter(messages, PlannerResponse, model=model,
                                       temperature=temperature, max_tokens=4096)
    errors = validate_decomposition(pr)
    return DecompositionCandidate(planner_response=pr, validation_errors=errors), usage


# ---------------------------------------------------------------------------
# Direct OpenRouter evaluators (bypass edge function + instructor)
# ---------------------------------------------------------------------------

from ..evaluators.mutual_exclusivity import MEJudgment, ME_PROMPT
from ..evaluators.mutual_exclusivity import _format_context as _me_fmt
from ..evaluators.collective_exhaustiveness import CEJudgment, CE_PROMPT
from ..evaluators.collective_exhaustiveness import _format_context as _ce_fmt
from ..evaluators.complexity_invariant import CXJudgment, CX_PROMPT
from ..evaluators.complexity_invariant import _format_context as _cx_fmt
from ..types import EvalResult


async def _eval_me(goal: str, pr: PlannerResponse, context: list) -> tuple[EvalResult, dict]:
    tasks_fmt = '\n'.join(f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
                          for i, t in enumerate(pr.tasks))
    prompt = ME_PROMPT.format(goal=goal, tasks_formatted=tasks_fmt, context_formatted=_me_fmt(context or []))
    messages = [{'role': 'system', 'content': prompt},
                {'role': 'user', 'content': 'Evaluate mutual exclusivity and return your judgment.'}]
    result, usage = await _call_openrouter(messages, MEJudgment, max_tokens=1024)
    return EvalResult(passed=result.passed, score=result.score, reasoning=result.reasoning), usage


async def _eval_ce(goal: str, pr: PlannerResponse, context: list) -> tuple[EvalResult, dict]:
    tasks_fmt = '\n'.join(f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
                          for i, t in enumerate(pr.tasks))
    prompt = CE_PROMPT.format(goal=goal, tasks_formatted=tasks_fmt, context_formatted=_ce_fmt(context or []))
    messages = [{'role': 'system', 'content': prompt},
                {'role': 'user', 'content': 'Evaluate collective exhaustiveness and return your judgment.'}]
    result, usage = await _call_openrouter(messages, CEJudgment, max_tokens=1024)
    return EvalResult(passed=result.passed, score=result.score, reasoning=result.reasoning), usage


async def _eval_cx(goal: str, pr: PlannerResponse, context: list) -> tuple[EvalResult, dict]:
    tasks_fmt = '\n'.join(f'  Task {i}: [{t.tool_name}] {t.goal} (depends_on: {t.depends_on})'
                          for i, t in enumerate(pr.tasks))
    prompt = CX_PROMPT.format(goal=goal, tasks_formatted=tasks_fmt, context_formatted=_cx_fmt(context or []))
    messages = [{'role': 'system', 'content': prompt},
                {'role': 'user', 'content': 'Evaluate the complexity invariant and return your judgment.'}]
    result, usage = await _call_openrouter(messages, CXJudgment, max_tokens=1024)
    return EvalResult(passed=result.passed, score=result.score, reasoning=result.reasoning), usage


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class EvalScores:
    me_passed: bool
    me_score: float
    ce_passed: bool
    ce_score: float
    cx_passed: bool
    cx_score: float


@dataclass
class TaskResult:
    task_id: str
    task_seed: str
    config_name: str
    valid: bool
    validation_errors: list[str]
    num_tasks: int
    depth: int
    evals: Optional[EvalScores]
    critic_score: Optional[float]
    final_score: Optional[float]
    penalty: float
    decomposition_time_s: float
    eval_time_s: float
    total_cost_usd: float


@dataclass
class ConfigReport:
    config_name: str
    num_tasks_evaluated: int
    num_valid: int
    validation_rate: float
    me_scores: list[float]
    ce_scores: list[float]
    cx_scores: list[float]
    me_pass_rate: float
    me_mean: float
    me_std: float
    ce_pass_rate: float
    ce_mean: float
    ce_std: float
    cx_pass_rate: float
    cx_mean: float
    cx_std: float
    critic_scores: list[float]
    critic_mean: float
    critic_std: float
    elo: float
    total_time_s: float
    total_cost_usd: float
    task_results: list[dict]


@dataclass
class BenchmarkReport:
    configs: list[ConfigReport]
    total_time_s: float
    total_cost_usd: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compute_depth(pr: PlannerResponse) -> int:
    n = len(pr.tasks)
    if n == 0:
        return 0
    memo: dict[int, int] = {}

    def dfs(i: int) -> int:
        if i in memo:
            return memo[i]
        deps = [int(d) for d in (pr.tasks[i].depends_on or [])]
        memo[i] = 1 + max((dfs(d) for d in deps), default=0) if deps else 0
        return memo[i]

    return max(dfs(i) for i in range(n))


def _load_tasks(directory: Path, limit: Optional[int] = None) -> list[ClarifiedTask]:
    """Load clarified tasks from a directory."""
    tasks = []
    for path in sorted(directory.glob('*.json')):
        data = json.loads(path.read_text())
        tasks.append(ClarifiedTask(
            id=data['id'],
            raw_seed=data['raw_seed'],
            agent_context=data['agent_context'],
            set_plan_args=data['set_plan_args'],
        ))
        if limit and len(tasks) >= limit:
            break
    return tasks


def _candidate_to_dict(pr: PlannerResponse, evals: Optional[EvalScores]) -> dict:
    d = {
        'title': pr.title,
        'content': pr.content,
        'tasks': [
            {'goal': t.goal, 'tool_name': t.tool_name, 'depends_on': list(t.depends_on or [])}
            for t in pr.tasks
        ],
        'dependencies_graph': [
            {'task_idx': str(e.task_idx), 'depends_on': list(e.depends_on or [])}
            for e in pr.dependencies_graph
        ],
        'join': pr.join,
    }
    if evals:
        d['me'] = {'passed': evals.me_passed, 'score': evals.me_score, 'reasoning': ''}
        d['ce'] = {'passed': evals.ce_passed, 'score': evals.ce_score, 'reasoning': ''}
        d['complexity'] = {'passed': evals.cx_passed, 'score': evals.cx_score, 'reasoning': ''}
    return d


def _sum_usage_cost(usage: dict) -> float:
    inp = usage.get('prompt_tokens', 0) or usage.get('input_tokens', 0) or 0
    out = usage.get('completion_tokens', 0) or usage.get('output_tokens', 0) or 0
    return (inp * 2.35 + out * 13.50) / 1_000_000


def _safe_mean(xs: list[float]) -> float:
    return statistics.mean(xs) if xs else 0.0


def _safe_stdev(xs: list[float]) -> float:
    return statistics.stdev(xs) if len(xs) >= 2 else 0.0


# ---------------------------------------------------------------------------
# Bradley-Terry ELO from critic pairwise comparisons
# ---------------------------------------------------------------------------

def fit_bradley_terry(config_critic_scores: dict[str, list[Optional[float]]]) -> dict[str, float]:
    """Fit Bradley-Terry model from pairwise critic score comparisons.

    For each task, the config with the higher critic score "wins" the matchup.
    Fits latent strength parameters via MLE, then converts to ELO scale.

    Args:
        config_critic_scores: {config_name: [score_per_task]} — None for invalid decomps.

    Returns:
        {config_name: elo_rating} centered at 1000.
    """
    names = list(config_critic_scores.keys())
    n = len(names)
    num_tasks = len(next(iter(config_critic_scores.values())))

    # Build win matrix with pseudocounts (1 virtual tie per pair for stability)
    wins = np.ones((n, n)) * 0.5
    np.fill_diagonal(wins, 0)
    for t in range(num_tasks):
        scores = []
        for i, name in enumerate(names):
            s = config_critic_scores[name][t]
            scores.append((i, s))
        for a_idx in range(n):
            for b_idx in range(a_idx + 1, n):
                s_a = scores[a_idx][1]
                s_b = scores[b_idx][1]
                if s_a is None or s_b is None:
                    continue
                if s_a > s_b:
                    wins[a_idx][b_idx] += 1
                elif s_b > s_a:
                    wins[b_idx][a_idx] += 1
                else:
                    wins[a_idx][b_idx] += 0.5
                    wins[b_idx][a_idx] += 0.5

    # MLE for Bradley-Terry
    def neg_log_likelihood(theta):
        ll = 0.0
        for i in range(n):
            for j in range(n):
                if wins[i][j] > 0:
                    p_ij = 1.0 / (1.0 + np.exp(-(theta[i] - theta[j])))
                    ll += wins[i][j] * np.log(p_ij + 1e-10)
        return -ll

    # Pin first player at 0 for identifiability
    def neg_ll_constrained(theta_free):
        theta = np.concatenate([[0.0], theta_free])
        return neg_log_likelihood(theta)

    result = minimize(neg_ll_constrained, x0=np.zeros(n - 1), method='L-BFGS-B')
    theta = np.concatenate([[0.0], result.x])

    # Convert to ELO scale: ELO = 1000 + 400 * theta / ln(10)
    elo = {name: 1000 + 400 * theta[i] / np.log(10) for i, name in enumerate(names)}
    return elo


# ---------------------------------------------------------------------------
# Core benchmark logic
# ---------------------------------------------------------------------------

async def benchmark_task(
    task: ClarifiedTask,
    config: ModelConfig,
    system_prompt: str,
    use_critic: bool = True,
    critic_model_id: str = 'reward_model',
) -> TaskResult:
    """Benchmark a single task with a specific model config."""
    total_cost = 0.0

    # 1. Decompose (direct OpenRouter call, bypasses edge function timeout)
    t0 = time.monotonic()
    try:
        candidate, decomp_usage = await _decompose_openrouter(
            task, model=config.model, system_prompt=system_prompt,
        )
    except Exception as e:
        decomp_time = time.monotonic() - t0
        logger.warning(f'Decompose failed [{config.name}] {task.raw_seed[:40]}: {type(e).__name__}: {e}')
        return TaskResult(
            task_id=task.id, task_seed=task.raw_seed, config_name=config.name,
            valid=False, validation_errors=[f'decompose_error: {type(e).__name__}: {e}'],
            num_tasks=0, depth=0, evals=None,
            critic_score=None, final_score=None, penalty=0.0,
            decomposition_time_s=decomp_time, eval_time_s=0.0,
            total_cost_usd=total_cost,
        )
    decomp_time = time.monotonic() - t0
    total_cost += _sum_usage_cost(decomp_usage or {})

    pr = candidate.planner_response
    errors = validate_decomposition(pr)
    valid = len(errors) == 0

    if not valid:
        return TaskResult(
            task_id=task.id, task_seed=task.raw_seed, config_name=config.name,
            valid=False, validation_errors=[f'{e.type}: {e.detail}' for e in errors],
            num_tasks=len(pr.tasks), depth=0, evals=None,
            critic_score=None, final_score=None, penalty=0.0,
            decomposition_time_s=decomp_time, eval_time_s=0.0,
            total_cost_usd=total_cost,
        )

    # 2. ME/CE/CX in parallel
    t1 = time.monotonic()
    try:
        me_result, ce_result, cx_result = await asyncio.gather(
            _eval_me(task.raw_seed, pr, task.agent_context),
            _eval_ce(task.raw_seed, pr, task.agent_context),
            _eval_cx(task.raw_seed, pr, task.agent_context),
        )
    except Exception as e:
        eval_time = time.monotonic() - t1
        logger.warning(f'Eval failed [{config.name}] {task.raw_seed[:40]}: {type(e).__name__}: {e}')
        return TaskResult(
            task_id=task.id, task_seed=task.raw_seed, config_name=config.name,
            valid=True, validation_errors=[f'eval_error: {type(e).__name__}: {e}'],
            num_tasks=len(pr.tasks), depth=_compute_depth(pr), evals=None,
            critic_score=None, final_score=None, penalty=0.0,
            decomposition_time_s=decomp_time, eval_time_s=eval_time,
            total_cost_usd=total_cost,
        )
    eval_time = time.monotonic() - t1

    me_eval, me_usage = me_result
    ce_eval, ce_usage = ce_result
    cx_eval, cx_usage = cx_result
    total_cost += _sum_usage_cost(me_usage or {})
    total_cost += _sum_usage_cost(ce_usage or {})
    total_cost += _sum_usage_cost(cx_usage or {})

    evals = EvalScores(
        me_passed=me_eval.passed, me_score=me_eval.score,
        ce_passed=ce_eval.passed, ce_score=ce_eval.score,
        cx_passed=cx_eval.passed, cx_score=cx_eval.score,
    )

    # 3. Penalties + depth
    depth = _compute_depth(pr)
    penalty = soft_penalties(me_eval.passed, ce_eval.passed, cx_eval.passed)

    # 4. Critic
    critic_val = None
    final_val = None
    if use_critic:
        try:
            from ..critic import score_candidates
            cand_dict = _candidate_to_dict(pr, evals)
            raw_scores = score_candidates(
                [cand_dict], task.raw_seed, task.agent_context,
                model_id=critic_model_id,
            )
            critic_val = 1.0 / (1.0 + math.exp(-raw_scores[0]))
            final_val = final_score(critic_val, penalty, len(pr.tasks), depth)
        except Exception as e:
            logger.warning(f'Critic failed for [{config.name}] {task.raw_seed[:40]}: {e}')

    return TaskResult(
        task_id=task.id, task_seed=task.raw_seed, config_name=config.name,
        valid=True, validation_errors=[],
        num_tasks=len(pr.tasks), depth=depth, evals=evals,
        critic_score=critic_val, final_score=final_val, penalty=penalty,
        decomposition_time_s=decomp_time, eval_time_s=eval_time,
        total_cost_usd=total_cost,
    )


def _build_system_prompt(config: ModelConfig, gepa_strategy: Optional[str] = None) -> str:
    """Build the system prompt for a given config."""
    tools_desc = _get_planner_tools_description()
    baseline = build_planner_system_prompt(tools_desc)
    if config.prompt == 'gepa' and gepa_strategy:
        from .gepa_optimizer import extract_strategy, compose_prompt
        return compose_prompt(gepa_strategy)
    return baseline


async def run_benchmark(
    tasks_dir: Path = HOLDOUT_DIR,
    limit: Optional[int] = None,
    configs: Optional[list[ModelConfig]] = None,
    use_critic: bool = True,
    critic_model_id: str = 'reward_model',
    gepa_strategy: Optional[str] = None,
    concurrency: int = 3,
) -> BenchmarkReport:
    """Run the full benchmark across all configs and tasks.

    Args:
        tasks_dir: Directory containing task JSONs. Defaults to benchmark_holdout/.
        limit: Max tasks to evaluate (None = all).
        configs: Model configurations to benchmark. Defaults to CONFIGS.
        use_critic: Whether to run critic reward model scoring.
        critic_model_id: Modal model ID for the trained reward model.
        gepa_strategy: Optimized strategy text for GEPA configs. If None, GEPA
            configs fall back to baseline prompt.
        concurrency: Max concurrent evaluations (across all configs).
    """
    if configs is None:
        configs = CONFIGS
    tasks = _load_tasks(tasks_dir, limit)
    logger.info(f'Loaded {len(tasks)} tasks from {tasks_dir.name}/, {len(configs)} configs → {len(tasks) * len(configs)} evaluations')

    # Build system prompts per config
    prompts = {c.name: _build_system_prompt(c, gepa_strategy) for c in configs}

    # Run all (config, task) pairs with concurrency limiter
    semaphore = asyncio.Semaphore(concurrency)
    all_results: dict[str, list[TaskResult]] = {c.name: [] for c in configs}
    t_start = time.monotonic()

    async def run_one(config: ModelConfig, task: ClarifiedTask, idx: int) -> tuple[str, TaskResult]:
        async with semaphore:
            logger.info(f'  [{config.name}] ({idx + 1}/{len(tasks)}) {task.raw_seed[:50]}')
            try:
                result = await benchmark_task(
                    task, config, prompts[config.name], use_critic, critic_model_id,
                )
            except Exception as e:
                logger.error(f'  [{config.name}] CRASHED on {task.raw_seed[:40]}: {type(e).__name__}: {e}')
                result = TaskResult(
                    task_id=task.id, task_seed=task.raw_seed, config_name=config.name,
                    valid=False, validation_errors=[f'crash: {type(e).__name__}: {e}'],
                    num_tasks=0, depth=0, evals=None,
                    critic_score=None, final_score=None, penalty=0.0,
                    decomposition_time_s=0.0, eval_time_s=0.0, total_cost_usd=0.0,
                )
            status = 'OK' if result.valid else 'INVALID'
            me = f'{result.evals.me_score:.2f}' if result.evals else '-'
            ce = f'{result.evals.ce_score:.2f}' if result.evals else '-'
            cx = f'{result.evals.cx_score:.2f}' if result.evals else '-'
            logger.info(f'    [{status}] ME={me} CE={ce} CX={cx}')
            return config.name, result

    coros = []
    for config in configs:
        for i, task in enumerate(tasks):
            coros.append(run_one(config, task, i))
    results_flat = await asyncio.gather(*coros)

    for config_name, result in results_flat:
        all_results[config_name].append(result)

    total_time = time.monotonic() - t_start

    # Aggregate per config
    config_reports = []
    config_critic_scores: dict[str, list[Optional[float]]] = {}

    for config in configs:
        results = all_results[config.name]
        valid = [r for r in results if r.valid]
        evald = [r for r in valid if r.evals]

        me_scores = [r.evals.me_score for r in evald]
        ce_scores = [r.evals.ce_score for r in evald]
        cx_scores = [r.evals.cx_score for r in evald]

        critic_scores = [r.critic_score for r in valid if r.critic_score is not None]
        # For BT fitting: one entry per task (None if invalid)
        config_critic_scores[config.name] = [r.critic_score for r in results]

        config_reports.append(ConfigReport(
            config_name=config.name,
            num_tasks_evaluated=len(results),
            num_valid=len(valid),
            validation_rate=len(valid) / len(results) if results else 0,
            me_scores=me_scores,
            ce_scores=ce_scores,
            cx_scores=cx_scores,
            me_pass_rate=sum(1 for r in evald if r.evals.me_passed) / len(evald) if evald else 0,
            me_mean=_safe_mean(me_scores),
            me_std=_safe_stdev(me_scores),
            ce_pass_rate=sum(1 for r in evald if r.evals.ce_passed) / len(evald) if evald else 0,
            ce_mean=_safe_mean(ce_scores),
            ce_std=_safe_stdev(ce_scores),
            cx_pass_rate=sum(1 for r in evald if r.evals.cx_passed) / len(evald) if evald else 0,
            cx_mean=_safe_mean(cx_scores),
            cx_std=_safe_stdev(cx_scores),
            critic_scores=critic_scores,
            critic_mean=_safe_mean(critic_scores),
            critic_std=_safe_stdev(critic_scores),
            elo=0.0,  # filled below
            total_time_s=sum(r.decomposition_time_s + r.eval_time_s for r in results),
            total_cost_usd=sum(r.total_cost_usd for r in results),
            task_results=[_result_to_dict(r) for r in results],
        ))

    # Fit Bradley-Terry ELO from critic pairwise comparisons
    if use_critic:
        try:
            elo_ratings = fit_bradley_terry(config_critic_scores)
            for cr in config_reports:
                cr.elo = elo_ratings.get(cr.config_name, 1000.0)
        except Exception as e:
            logger.warning(f'Bradley-Terry fitting failed: {e}')

    return BenchmarkReport(
        configs=config_reports,
        total_time_s=total_time,
        total_cost_usd=sum(cr.total_cost_usd for cr in config_reports),
    )


def _result_to_dict(r: TaskResult) -> dict:
    d = {
        'task_id': r.task_id,
        'task_seed': r.task_seed,
        'config_name': r.config_name,
        'valid': r.valid,
        'validation_errors': r.validation_errors,
        'num_tasks': r.num_tasks,
        'depth': r.depth,
        'penalty': r.penalty,
        'critic_score': r.critic_score,
        'final_score': r.final_score,
        'decomposition_time_s': round(r.decomposition_time_s, 2),
        'eval_time_s': round(r.eval_time_s, 2),
        'total_cost_usd': round(r.total_cost_usd, 4),
    }
    if r.evals:
        d['evals'] = {
            'me': {'passed': r.evals.me_passed, 'score': r.evals.me_score},
            'ce': {'passed': r.evals.ce_passed, 'score': r.evals.ce_score},
            'cx': {'passed': r.evals.cx_passed, 'score': r.evals.cx_score},
        }
    return d


# ---------------------------------------------------------------------------
# Chart generation
# ---------------------------------------------------------------------------

def generate_charts(report: BenchmarkReport, output_dir: Path):
    """Generate 4 benchmark charts as PNGs.

    1. ME scores (bar + std error bars)
    2. CE scores (bar + std error bars)
    3. CX scores (bar + std error bars)
    4. ELO ratings (Bradley-Terry from critic pairwise comparisons)
    """
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    output_dir.mkdir(parents=True, exist_ok=True)

    names = [cr.config_name for cr in report.configs]
    colors = []
    for cr in report.configs:
        matching = [c for c in CONFIGS if c.name == cr.config_name]
        colors.append(matching[0].color if matching else '#888888')

    x = np.arange(len(names))
    bar_width = 0.6

    def _make_eval_chart(filename: str, title: str, means: list, stds: list, ylabel: str):
        fig, ax = plt.subplots(figsize=(10, 6))
        bars = ax.bar(x, means, bar_width, yerr=stds, capsize=5, color=colors, edgecolor='white', linewidth=1.2)
        ax.set_ylabel(ylabel, fontsize=12)
        ax.set_title(title, fontsize=14, fontweight='bold')
        ax.set_xticks(x)
        ax.set_xticklabels(names, fontsize=10)
        ax.set_ylim(0, 1.05)
        ax.axhline(y=1.0, color='#d1d5db', linestyle='--', linewidth=0.8)
        # Value labels on bars
        for bar, mean in zip(bars, means):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                    f'{mean:.3f}', ha='center', va='bottom', fontsize=10, fontweight='bold')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        plt.tight_layout()
        fig.savefig(output_dir / filename, dpi=150, bbox_inches='tight')
        plt.close(fig)
        logger.info(f'Chart saved: {output_dir / filename}')

    # Chart 1: ME
    _make_eval_chart(
        '1_mutual_exclusivity.png',
        'Mutual Exclusivity (ME) — No Duplicated Work',
        [cr.me_mean for cr in report.configs],
        [cr.me_std for cr in report.configs],
        'ME Score (0-1)',
    )

    # Chart 2: CE
    _make_eval_chart(
        '2_collective_exhaustiveness.png',
        'Collective Exhaustiveness (CE) — Complete Coverage',
        [cr.ce_mean for cr in report.configs],
        [cr.ce_std for cr in report.configs],
        'CE Score (0-1)',
    )

    # Chart 3: CX
    _make_eval_chart(
        '3_complexity_invariant.png',
        'Complexity Invariant (CX) — Sub-tasks Simpler',
        [cr.cx_mean for cr in report.configs],
        [cr.cx_std for cr in report.configs],
        'CX Score (0-1)',
    )

    # Chart 4: ELO
    elos = [cr.elo for cr in report.configs]
    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.bar(x, elos, bar_width, color=colors, edgecolor='white', linewidth=1.2)
    ax.set_ylabel('ELO Rating', fontsize=12)
    ax.set_title('ELO Rating (Bradley-Terry from Reward Model)', fontsize=14, fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels(names, fontsize=10)
    # Y axis: center around 1000 with appropriate range
    elo_min = min(elos) if elos else 900
    elo_max = max(elos) if elos else 1100
    margin = max(50, (elo_max - elo_min) * 0.3)
    ax.set_ylim(elo_min - margin, elo_max + margin)
    ax.axhline(y=1000, color='#d1d5db', linestyle='--', linewidth=0.8, label='Baseline (1000)')
    for bar, elo in zip(bars, elos):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + margin * 0.05,
                f'{elo:.0f}', ha='center', va='bottom', fontsize=11, fontweight='bold')
    ax.legend(loc='upper right', fontsize=9)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    plt.tight_layout()
    fig.savefig(output_dir / '4_elo_ratings.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    logger.info(f'Chart saved: {output_dir / "4_elo_ratings.png"}')


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------

def print_report(report: BenchmarkReport):
    print('\n' + '=' * 78)
    print('  GEPA BENCHMARK — Model Comparison')
    print('=' * 78)
    print(f'\n  Total time: {report.total_time_s:.1f}s  |  Total cost: ${report.total_cost_usd:.2f}')

    # Summary table
    header = f'  {"Config":<18} {"Valid":>6} {"ME":>8} {"CE":>8} {"CX":>8} {"Critic":>8} {"ELO":>7}'
    print(f'\n{header}')
    print(f'  {"-" * 18} {"-" * 6} {"-" * 8} {"-" * 8} {"-" * 8} {"-" * 8} {"-" * 7}')
    for cr in report.configs:
        name = cr.config_name.replace('\n', ' ')
        valid = f'{cr.validation_rate:.0%}'
        me = f'{cr.me_mean:.3f}'
        ce = f'{cr.ce_mean:.3f}'
        cx = f'{cr.cx_mean:.3f}'
        critic = f'{cr.critic_mean:.3f}' if cr.critic_mean else 'N/A'
        elo = f'{cr.elo:.0f}' if cr.elo else 'N/A'
        print(f'  {name:<18} {valid:>6} {me:>8} {ce:>8} {cx:>8} {critic:>8} {elo:>7}')

    # Pass rates
    print(f'\n  {"Config":<18} {"ME pass":>8} {"CE pass":>8} {"CX pass":>8}')
    print(f'  {"-" * 18} {"-" * 8} {"-" * 8} {"-" * 8}')
    for cr in report.configs:
        name = cr.config_name.replace('\n', ' ')
        print(f'  {name:<18} {cr.me_pass_rate:>7.0%} {cr.ce_pass_rate:>7.0%} {cr.cx_pass_rate:>7.0%}')

    print('\n' + '=' * 78)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Benchmark planner decomposition across models')
    parser.add_argument('--tasks', type=int, default=None, help='Limit number of tasks (default: all)')
    parser.add_argument('--output', type=str, default=None, help='Write JSON results to file')
    parser.add_argument('--charts', type=str, default=None, help='Output directory for PNG charts')
    parser.add_argument('--no-critic', action='store_true', help='Skip critic reward model scoring')
    parser.add_argument('--critic-model', type=str, default='reward_model', help='Critic model ID on Modal')
    parser.add_argument('--concurrency', type=int, default=3, help='Max concurrent evaluations')
    parser.add_argument('--tasks-dir', type=str, default=None,
                        help='Path to tasks directory (default: data/benchmark_holdout/)')
    parser.add_argument('--gepa-strategy', type=str, default=None,
                        help='Path to file containing optimized GEPA strategy text')
    parser.add_argument('--configs', type=str, nargs='+', default=None,
                        help='Subset of configs to run (e.g. "Opus 4.6" "GPT 5.2")')
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )

    tasks_dir = Path(args.tasks_dir) if args.tasks_dir else HOLDOUT_DIR

    # Filter configs if specified
    configs = CONFIGS
    if args.configs:
        configs = [c for c in CONFIGS if c.name in args.configs]
        if not configs:
            logger.error(f'No matching configs. Available: {[c.name for c in CONFIGS]}')
            return

    # Load GEPA strategy if provided
    gepa_strategy = None
    if args.gepa_strategy:
        gepa_strategy = Path(args.gepa_strategy).read_text().strip()

    report = asyncio.run(run_benchmark(
        tasks_dir=tasks_dir,
        limit=args.tasks,
        configs=configs,
        use_critic=not args.no_critic,
        critic_model_id=args.critic_model,
        gepa_strategy=gepa_strategy,
        concurrency=args.concurrency,
    ))

    print_report(report)

    if args.charts:
        generate_charts(report, Path(args.charts))

    if args.output:
        out_path = Path(args.output)
        report_dict = {
            'total_time_s': round(report.total_time_s, 1),
            'total_cost_usd': round(report.total_cost_usd, 2),
            'configs': [],
        }
        for cr in report.configs:
            report_dict['configs'].append({
                'config_name': cr.config_name,
                'num_tasks_evaluated': cr.num_tasks_evaluated,
                'num_valid': cr.num_valid,
                'validation_rate': cr.validation_rate,
                'me_pass_rate': cr.me_pass_rate,
                'me_mean': cr.me_mean,
                'me_std': cr.me_std,
                'ce_pass_rate': cr.ce_pass_rate,
                'ce_mean': cr.ce_mean,
                'ce_std': cr.ce_std,
                'cx_pass_rate': cr.cx_pass_rate,
                'cx_mean': cr.cx_mean,
                'cx_std': cr.cx_std,
                'critic_mean': cr.critic_mean,
                'critic_std': cr.critic_std,
                'elo': cr.elo,
                'total_time_s': round(cr.total_time_s, 1),
                'total_cost_usd': round(cr.total_cost_usd, 2),
                'task_results': cr.task_results,
            })
        out_path.write_text(json.dumps(report_dict, indent=2))
        logger.info(f'Results written to {out_path}')


if __name__ == '__main__':
    main()
