"""Runtime entry point for the `gepa-full-pipeline`.

Runs the production GEPA optimisation loop against rose-1-ultra with the
trained critic. Mirrors ``research/gepa/run_full_pipeline.py`` but shares the
scoring/critic helpers through the layered service/repo modules.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sys
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

from research.domains.gepa.config import (
    CRITIC_MODEL_ID,
    CRITIC_RETRY_DELAY_S,
    GEPA_LOG_DIR,
    MAX_CRITIC_RETRIES,
    OPTIMIZATION_RESULT_PATH,
    PROGRESS_FILE,
)

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))

load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
for _name in ['httpx', 'httpcore', 'hpack', 'h2', 'modal._utils', 'grpc']:
    logging.getLogger(_name).setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


def _patch_dspy_reasoning() -> None:
    """Fallback DSPy text-field to reasoning_content for rose-1-ultra."""
    from dspy.clients.base_lm import BaseLM

    _orig = BaseLM._process_completion

    def _patched(self, response, merged_kwargs):
        outputs = _orig(self, response, merged_kwargs)
        patched = []
        for o in outputs:
            if isinstance(o, dict) and not o.get('text') and o.get('reasoning_content'):
                o['text'] = o['reasoning_content']
            patched.append(o)
        if all(isinstance(o, dict) and len(o) == 1 and 'text' in o for o in patched):
            patched = [o['text'] for o in patched]
        return patched

    BaseLM._process_completion = _patched
    logger.info('[OK] DSPy patched: reasoning_content -> text fallback')


def _patch_lm_logging() -> None:
    """Log every LM call so long-running runs are observable."""
    from dspy.clients.base_lm import BaseLM

    _orig_call = BaseLM.__call__
    _lm_n = [0]

    def _logged_call(self, prompt=None, messages=None, **kwargs):
        _lm_n[0] += 1
        n = _lm_n[0]
        total_chars = sum(len(str(m.get('content', ''))) for m in (messages or []))
        logger.info('  [LM #%d] %d msgs %d chars', n, len(messages or []), total_chars)
        t0 = time.time()
        try:
            result = _orig_call(self, prompt=prompt, messages=messages, **kwargs)
            rlen = len(str(result[0])) if result else 0
            logger.info('  [LM #%d] OK %.1fs %dch', n, time.time() - t0, rlen)
            return result
        except Exception as e:
            logger.info('  [LM #%d] ERR %.1fs %s: %s', n, time.time() - t0, type(e).__name__, e)
            raise

    BaseLM.__call__ = _logged_call
    logger.info('[OK] LM call logging enabled')


def _configure_rose_ultra_lm():
    """Return a configured ``dspy.LM`` pointed at rose-1-ultra."""
    import dspy

    lm = dspy.LM(
        model='openai/rose-labs/rose-1-ultra',
        api_base=os.getenv(
            'ROSE_API_URL', 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions'
        ),
        api_key=os.getenv('ROSE_API_KEY'),
        max_tokens=8192,
        cache=False,
        extra_headers={
            'Authorization': f'Bearer {os.getenv("SUPABASE_ANON_KEY")}',
            'x-api-key': os.getenv('ROSE_API_KEY'),
        },
        extra_body={'reasoning': {'max_tokens': 512}},
    )
    dspy.configure(lm=lm)
    logger.info('[OK] rose-1-ultra configured (max_tokens=8192, reasoning=512)')
    return lm


async def _run_evaluators(goal, pr, ctx):
    """Run ME/CE/CX evaluators concurrently with per-call retries."""
    from research.gepa.pipelines.benchmark import _eval_ce, _eval_cx, _eval_me

    async def _retry_async(coro_fn, label):
        last_err = None
        for attempt in range(MAX_CRITIC_RETRIES):
            try:
                return await coro_fn()
            except Exception as e:
                last_err = e
                if attempt < MAX_CRITIC_RETRIES - 1:
                    wait = CRITIC_RETRY_DELAY_S * (attempt + 1)
                    logger.info(
                        '    [%s RETRY %d/%d] %s (sleep %.1fs)',
                        label,
                        attempt + 1,
                        MAX_CRITIC_RETRIES,
                        e,
                        wait,
                    )
                    await asyncio.sleep(wait)
        raise RuntimeError(
            f'{label} failed after {MAX_CRITIC_RETRIES} attempts: '
            f'{type(last_err).__name__}: {last_err}'
        ) from last_err

    me_r, ce_r, cx_r = await asyncio.gather(
        _retry_async(lambda: _eval_me(goal, pr, ctx), 'ME'),
        _retry_async(lambda: _eval_ce(goal, pr, ctx), 'CE'),
        _retry_async(lambda: _eval_cx(goal, pr, ctx), 'CX'),
    )
    return me_r[0].score, ce_r[0].score, cx_r[0].score


def _strip_code_fences(text: str) -> str:
    if not text.strip().startswith('```'):
        return text
    lines = text.strip().split('\n')
    lines = [l for l in lines if not l.strip().startswith('```')]
    return '\n'.join(lines)


def _build_metric(call_n):
    """Return the DSPy metric closure used by the optimiser."""
    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    from research.domains.gepa.service import (
        _parse_plan,
        _retry,
        final_score,
        hard_gate,
        score_candidates,
    )

    def metric(example, pred, trace=None, pred_name=None, pred_trace=None):
        call_n[0] += 1
        n = call_n[0]
        t0 = time.time()
        text = _strip_code_fences(pred.plan_json)
        pr = _parse_plan(text)
        if pr is None:
            logger.info('  #%d PARSE_FAIL %.1fs', n, time.time() - t0)
            return ScoreWithFeedback(score=0.0, feedback='Could not parse JSON output')
        gate = hard_gate(pr)
        if math.isinf(gate):
            logger.info('  #%d GATE_FAIL n=%d %.1fs', n, len(pr.tasks), time.time() - t0)
            return ScoreWithFeedback(
                score=0.0,
                feedback=(f'Invalid structure: {len(pr.tasks)} tasks (need 2-8) or cycle detected'),
            )
        ctx = json.loads(example.context) if isinstance(example.context, str) else example.context
        plan_dict = json.loads(text)
        raw = _retry(
            lambda: score_candidates([plan_dict], example.goal, ctx, model_id=CRITIC_MODEL_ID),
            'Critic',
        )
        norm = 1.0 / (1.0 + math.exp(-raw[0]))
        me, ce, cx = asyncio.run(_run_evaluators(example.goal, pr, ctx))
        s = max(0.0, final_score(norm, me, ce, cx))
        logger.info(
            '  #%d critic=%.3f ME=%.2f CE=%.2f CX=%.2f final=%.3f %.1fs',
            n,
            norm,
            me,
            ce,
            cx,
            s,
            time.time() - t0,
        )
        return ScoreWithFeedback(
            score=s,
            feedback=f'critic={norm:.3f}, ME={me:.2f}, CE={ce:.2f}, CX={cx:.2f}, final={s:.3f}',
        )

    return metric


def _start_progress_reporter(progress_file: Path, call_n, t_start):
    """Write a JSON progress file every 60s. Returns a stop event."""
    stop = threading.Event()

    def _loop():
        while not stop.wait(60):
            elapsed = time.time() - t_start
            progress_file.write_text(
                json.dumps(
                    {
                        'metric_calls': call_n[0],
                        'elapsed_s': round(elapsed, 1),
                        'elapsed_min': round(elapsed / 60, 1),
                        'calls_per_min': (
                            round(call_n[0] / (elapsed / 60), 1) if elapsed > 60 else 0
                        ),
                        'status': 'running',
                    },
                    indent=2,
                )
            )

    thread = threading.Thread(target=_loop, daemon=True)
    thread.start()
    return stop


def _write_optimization_result(out_path: Path, strategy: str, elapsed: float, call_n, demos):
    from research.domains.gepa.service import compose_prompt, get_initial_strategy

    out_path.write_text(
        json.dumps(
            {
                'initial_strategy': get_initial_strategy(),
                'optimized_strategy': strategy,
                'optimized_prompt': compose_prompt(strategy),
                'elapsed_s': elapsed,
                'metric_calls': call_n[0],
                'demos': len(demos),
            },
            indent=2,
        )
    )


def main() -> None:
    import dspy

    _patch_dspy_reasoning()
    _patch_lm_logging()
    lm = _configure_rose_ultra_lm()

    from research.domains.gepa.config import TASKS_DIR
    from research.domains.gepa.repo import load_trainset

    call_n = [0]
    metric = _build_metric(call_n)

    trainset = load_trainset(TASKS_DIR)
    logger.info('[OK] %d examples loaded', len(trainset))

    from research.domains.gepa.service import _make_decomposer_module

    module = _make_decomposer_module()
    logger.info('[START] GEPA auto=light threads=4 (%d tasks)', len(trainset))
    t_start = time.time()

    stop = _start_progress_reporter(PROGRESS_FILE, call_n, t_start)

    log_dir = str(GEPA_LOG_DIR)
    optimizer = dspy.GEPA(
        metric=metric,
        auto='light',
        num_threads=4,
        reflection_lm=lm,
        log_dir=log_dir,
        track_stats=True,
    )
    logger.info('[OK] log_dir=%s (resume on crash)', log_dir)
    optimized = optimizer.compile(module, trainset=trainset)
    stop.set()

    strategy = optimized.planner.signature.instructions
    demos = getattr(optimized.planner, 'demos', [])
    elapsed = time.time() - t_start

    logger.info('%s', '=' * 80)
    logger.info('DONE in %.0fs | %d metric calls | %d demos', elapsed, call_n[0], len(demos))
    logger.info('%s', '=' * 80)
    logger.info('OPTIMIZED STRATEGY (%d chars):', len(strategy))
    logger.info(strategy)

    _write_optimization_result(OPTIMIZATION_RESULT_PATH, strategy, elapsed, call_n, demos)
    logger.info('Saved to %s', OPTIMIZATION_RESULT_PATH)


if __name__ == '__main__':
    main()
