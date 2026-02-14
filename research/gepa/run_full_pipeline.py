"""Run GEPA: rose-1-ultra + trained critic, verbose live output.

Usage:
    PYTHONPATH=agents python -u research/gepa/run_full_pipeline.py
"""
import asyncio, json, math, os, sys, time, logging
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))
from dotenv import load_dotenv
load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
for name in ['httpx', 'httpcore', 'hpack', 'h2', 'modal._utils', 'grpc']:
    logging.getLogger(name).setLevel(logging.WARNING)

CRITIC = 'gepa_critic_312'
MAX_CRITIC_RETRIES = 3
CRITIC_RETRY_DELAY = 5  # seconds


def _patch_dspy_reasoning():
    """Monkey-patch DSPy to handle rose-1-ultra reasoning_content responses.

    Rose-1-ultra model racing can return responses where the actual content is
    in `reasoning_content` with an empty `text` field. DSPy only reads `text`,
    so we patch _process_completion to fall back to reasoning_content.
    """
    from dspy.clients.base_lm import BaseLM
    _orig = BaseLM._process_completion

    def _patched(self, response, merged_kwargs):
        outputs = _orig(self, response, merged_kwargs)
        patched = []
        for o in outputs:
            if isinstance(o, dict) and not o.get("text") and o.get("reasoning_content"):
                o["text"] = o["reasoning_content"]
                patched.append(o)
            else:
                patched.append(o)
        # Re-simplify: if all outputs now only have "text", return just strings
        if all(isinstance(o, dict) and len(o) == 1 and "text" in o for o in patched):
            patched = [o["text"] for o in patched]
        return patched

    BaseLM._process_completion = _patched
    print('[OK] DSPy patched: reasoning_content → text fallback', flush=True)


def _patch_lm_logging():
    """Add logging to every LM call for visibility."""
    from dspy.clients.base_lm import BaseLM
    _orig_call = BaseLM.__call__
    _lm_n = [0]

    def _logged_call(self, prompt=None, messages=None, **kwargs):
        _lm_n[0] += 1
        n = _lm_n[0]
        total_chars = sum(len(str(m.get('content', ''))) for m in (messages or []))
        print(f'  [LM #{n}] {len(messages or [])} msgs {total_chars} chars', flush=True)
        t0 = time.time()
        try:
            result = _orig_call(self, prompt=prompt, messages=messages, **kwargs)
            rlen = len(str(result[0])) if result else 0
            print(f'  [LM #{n}] OK {time.time()-t0:.1f}s {rlen}ch', flush=True)
            return result
        except Exception as e:
            print(f'  [LM #{n}] ERR {time.time()-t0:.1f}s {type(e).__name__}: {e}', flush=True)
            raise

    BaseLM.__call__ = _logged_call
    print('[OK] LM call logging enabled', flush=True)


def main():
    import dspy
    _patch_dspy_reasoning()
    _patch_lm_logging()

    lm = dspy.LM(
        model='openai/rose-labs/rose-1-ultra',
        api_base=os.getenv('ROSE_API_URL', 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions'),
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
    print('[OK] rose-1-ultra configured (max_tokens=8192, reasoning=512)', flush=True)

    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback
    from research.gepa.pipelines.gepa_optimizer import (
        _load_trainset, _make_decomposer_module, _parse_plan,
        get_initial_strategy, compose_prompt, TASKS_DIR,
        _retry, MAX_RETRIES, RETRY_DELAY_S,
    )
    from research.gepa.pipelines.benchmark import _eval_me, _eval_ce, _eval_cx
    from research.gepa.scoring import hard_gate, final_score
    from research.gepa.critic import score_candidates

    call_n = [0]

    async def _run_evaluators(goal, pr, ctx):
        async def _retry_async(coro_fn, label):
            last_err = None
            for attempt in range(MAX_CRITIC_RETRIES):
                try:
                    return await coro_fn()
                except Exception as e:
                    last_err = e
                    if attempt < MAX_CRITIC_RETRIES - 1:
                        wait = CRITIC_RETRY_DELAY * (attempt + 1)
                        print(f'    [{label} RETRY {attempt+1}/{MAX_CRITIC_RETRIES}] {e} (sleep {wait:.1f}s)', flush=True)
                        await asyncio.sleep(wait)
            raise RuntimeError(f'{label} failed after {MAX_CRITIC_RETRIES} attempts: {type(last_err).__name__}: {last_err}') from last_err

        me_r, ce_r, cx_r = await asyncio.gather(
            _retry_async(lambda: _eval_me(goal, pr, ctx), 'ME'),
            _retry_async(lambda: _eval_ce(goal, pr, ctx), 'CE'),
            _retry_async(lambda: _eval_cx(goal, pr, ctx), 'CX'),
        )
        return me_r[0].score, ce_r[0].score, cx_r[0].score

    def metric(example, pred, trace=None, pred_name=None, pred_trace=None):
        call_n[0] += 1
        n = call_n[0]
        t0 = time.time()
        text = pred.plan_json
        if text.strip().startswith('```'):
            lines = text.strip().split('\n')
            lines = [l for l in lines if not l.strip().startswith('```')]
            text = '\n'.join(lines)
        pr = _parse_plan(text)
        if pr is None:
            print(f'  #{n} PARSE_FAIL {time.time()-t0:.1f}s', flush=True)
            return ScoreWithFeedback(score=0.0, feedback='Could not parse JSON output')
        gate = hard_gate(pr)
        if math.isinf(gate):
            print(f'  #{n} GATE_FAIL n={len(pr.tasks)} {time.time()-t0:.1f}s', flush=True)
            return ScoreWithFeedback(score=0.0, feedback=f'Invalid structure: {len(pr.tasks)} tasks (need 2-8) or cycle detected')
        ctx = json.loads(example.context) if isinstance(example.context, str) else example.context
        plan_dict = json.loads(text)
        raw = _retry(lambda: score_candidates([plan_dict], example.goal, ctx, model_id=CRITIC), 'Critic')
        norm = 1.0 / (1.0 + math.exp(-raw[0]))
        me, ce, cx = asyncio.run(_run_evaluators(example.goal, pr, ctx))
        s = max(0.0, final_score(norm, me, ce, cx))
        print(f'  #{n} critic={norm:.3f} ME={me:.2f} CE={ce:.2f} CX={cx:.2f} final={s:.3f} {time.time()-t0:.1f}s', flush=True)
        return ScoreWithFeedback(
            score=s,
            feedback=f'critic={norm:.3f}, ME={me:.2f}, CE={ce:.2f}, CX={cx:.2f}, final={s:.3f}',
        )

    trainset = _load_trainset(TASKS_DIR)
    print(f'[OK] {len(trainset)} examples loaded', flush=True)

    module = _make_decomposer_module()
    print(f'[START] GEPA auto=light threads=4 ({len(trainset)} tasks)', flush=True)
    t_start = time.time()

    # Progress reporter: writes status every 60s so you can `cat research/gepa/data/gepa_progress.json`
    import threading
    progress_file = Path(__file__).parent / 'data' / 'gepa_progress.json'
    _stop_progress = threading.Event()

    def _progress_loop():
        while not _stop_progress.wait(60):
            elapsed = time.time() - t_start
            progress_file.write_text(json.dumps({
                'metric_calls': call_n[0],
                'elapsed_s': round(elapsed, 1),
                'elapsed_min': round(elapsed / 60, 1),
                'calls_per_min': round(call_n[0] / (elapsed / 60), 1) if elapsed > 60 else 0,
                'status': 'running',
            }, indent=2))

    progress_thread = threading.Thread(target=_progress_loop, daemon=True)
    progress_thread.start()

    log_dir = str(Path(__file__).parent / 'data' / 'gepa_logs_v3')
    optimizer = dspy.GEPA(
        metric=metric,
        auto='light',
        num_threads=4,
        reflection_lm=lm,
        log_dir=log_dir,
        track_stats=True,
    )
    print(f'[OK] log_dir={log_dir} (resume on crash)', flush=True)
    optimized = optimizer.compile(module, trainset=trainset)
    _stop_progress.set()

    strategy = optimized.planner.signature.instructions
    demos = getattr(optimized.planner, 'demos', [])
    elapsed = time.time() - t_start

    print(f'\n{"="*80}', flush=True)
    print(f'DONE in {elapsed:.0f}s | {call_n[0]} metric calls | {len(demos)} demos', flush=True)
    print(f'{"="*80}', flush=True)
    print(f'OPTIMIZED STRATEGY ({len(strategy)} chars):', flush=True)
    print(strategy, flush=True)

    out = Path(__file__).parent / 'data' / 'optimization_result.json'
    out.write_text(json.dumps({
        'initial_strategy': get_initial_strategy(),
        'optimized_strategy': strategy,
        'optimized_prompt': compose_prompt(strategy),
        'elapsed_s': elapsed,
        'metric_calls': call_n[0],
        'demos': len(demos),
    }, indent=2))
    print(f'Saved to {out}', flush=True)


if __name__ == '__main__':
    main()
