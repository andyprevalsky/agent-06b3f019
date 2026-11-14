# Rose completions

Rose routes model calls in-process; there is no external HTTP hop. Clients: `back-end/src/providers/rose/` (chat path: router, generator, supervisor) and `agents/providers/rose/` (agent and browser path). The pool registry is `agents/providers/rose/pools.py`, mirrored by `back-end/src/providers/rose/pools.ts`; change both together.

## Route order

On the agents path (`agents/providers/rose/client.py`) each call tries, in order: a leased subscription token (Claude or GPT OAuth, if the pool allows subscriptions) → funded API keys (only when `direct_auth_enabled`) → direct Cerebras (if the pool names a model) → Azure Foundry (if enabled; the region's `AZURE_FOUNDRY_DEPLOYMENTS*` must list the model) → the OpenRouter waterfall in order. Every subscription is tried before any funded key. The backend chat path (`back-end/src/providers/rose/client.ts`) follows the same lease → funded key → waterfall contract, but may first take an exclusive low-latency Cerebras chat route (`exclusiveCerebrasChatRoute.ts`) and keeps Foundry as the chat's last resort.

## Pools (verified against both registries, 2026-11-08)

| Pool | Subscription lease (Claude / GPT) | Cerebras | Foundry | OpenRouter waterfall (effort) |
| --- | --- | --- | --- | --- |
| `rose-1-ultra` | `claude-opus-5-5` / `gpt-6.1-sol` (Claude first) | none | `gpt-6.1-sol` | `openai/gpt-6.1-sol` → `moonshotai/kimi-k3` (caller default) |
| `rose-1-flash` | off; agents-path `plan_loop`, `execute_loop` and `explore_agent` calls use `gpt-6.1-terra`, then `claude-opus-5-5` (`flash_agent.py`) | `qwen-3.8-27b` (high) | `gpt-6-luna` only (medium) | `qwen/qwen3.8-27b` → `google/gemini-3.8-flash` (medium) |
| `rose-1-browser-use` | off | `qwen-3.8-27b` (high) | `gpt-5.6-luna` | `qwen/qwen3.8-27b` → `google/gemini-3.8-flash` (low) |
| `rose-1-mini` | `claude-haiku-4-5` / `gpt-5.6-luna` | none | `gpt-5.6-luna` | `anthropic/claude-haiku-4.5` → `z-ai/glm-5.3-flash` (low) |
| `rose-1-oss` (agents only) | off | none | `DeepSeek-V3.2` | `moonshotai/kimi-k3` → `qwen/qwen3.8-27b` |
| `rose-wmh-gpt61` (agents only) | off | none | `gpt-6.1-sol` | `openai/gpt-6.1-sol` (xhigh) |

- Flash order is Cerebras → Azure GPT-6 Luna (never 5.6 Luna) at medium → OpenRouter Qwen, then Gemini Flash, at medium (Andy, 2026-10-28). Flash never uses funded API keys.
- The planner and DAG param-populator always use `rose-1-ultra`, whatever the agent's pool.
- `rose-local` is an inert local-model pool with no remote legs.

## Calling Rose from scripts

- Python: lease with `helpers.llm.fetch_compute_token_activity(user_id, token_type=...)`, build auth with `_build_compute_auth_context(...)`, call `providers.rose.RoseClient().complete(...)` or `.collect(...)` with `pool=`, `claude_auth=`/`gpt_auth=` and `call_site=`, then release the lease.
- TypeScript: `createStreamingCompletion` (`back-end/src/providers/rose`) with a token from `fetchComputeTokenForUser(userId, { tokenType })`.
- Record `actual_model` and `pool_name` for every call (`-claude` and `-foundry` suffixes mark direct Claude and Azure legs); a fall-through to another model invalidates a model comparison.

## Waterfall guards and budgets

- Budgets: 590 s whole-call deadline, 90 s time to first token, 120 s idle after the first productive chunk (`agents/providers/rose/client.py`). Never raise them to hide a stall.
- Python TTFT/progress guards live inside each configured leg: before productive output a stalled leg falls through to the next configured model; a partial-output idle error and the whole-call deadline are terminal.
- Client or waterfall edits run the deploy-owned `cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py rose rose-browser-use llm` (fallback, original deadline, parser progress, cancellation and response-closure controls).
- A failed browser collect keeps its built inputs and requested configuration through the existing best-effort dump path, with the same request, span, root and cache bindings; a capture failure preserves the original exception, and cancellation and successful dumps are unchanged.
- Older failed calls may lack an exact input dump; an earlier successful dump is not a substitute.
- History: `docs/rca/cases/2026-10-06-client-stream-guard-bypassed-waterfall-fallback.md`.
