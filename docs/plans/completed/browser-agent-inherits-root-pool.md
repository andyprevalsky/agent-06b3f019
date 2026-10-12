# Browser agent inherits its spawning agent's model pool

Browser steps were hardcoded to `rose-1-browser-use` (Cerebras qwen-3.8-27b),
so an ultra root's browser agent never used ultra's models. Browser steps now
run on the spawning agent's Rose pool (sub-agents already inherit the root's
model, so this is the root's pool).

```
AgentWorkflow (model = rose-labs/rose-1-ultra)
  └─ spawn_browser_agent → start_activity(..., world_model_mode, agent_model)
       └─ spawn_browser_agent_activity_v3
            browser_pool = browser_pool_for_agent_model(agent_model)
              rose-labs/rose-1-*  → that pool
              non-Rose / None     → rose-1-browser-use (old behavior)
            ├─ real / simulated loop ─ _call_browser_use_with_rotation(pool)
            │    └─ RoseClient.complete_browser_use(pool, browser_use=True)
            │         ├─ Fast Cache bypass (browser_use flag, any pool)
            │         ├─ claudeAuth / gptAuth / Cerebras / Foundry / waterfall of `pool`
            │         │    Foundry skipped when the request has images and its
            │         │    model is text-only (rose-1-oss DeepSeek-V3.2)
            │         └─ OpenRouter qwen → Novita cache routing (browser_use flag)
            └─ pricing lookup + unattributed usage rows → browser_pool
```

Effort is unchanged: browser steps omit effort, so each route keeps its pool's
default (xhigh on ultra direct routes, pinned low on speed-pool fallbacks).

## Verification (all in the normal agents blackbox gate)

- `rose`: every route a pool can serve a screenshot on sees images (direct
  auth, Cerebras, waterfall); oss + image skips DeepSeek Foundry for kimi-k3,
  oss text keeps DeepSeek, ultra + image keeps vision Foundry gpt-6-sol;
  Novita routing follows the browser flag on any pool, not flash generally.
- `rose-browser-use`: `complete_browser_use(pool="rose-1-ultra")` with a
  Claude token sends the screenshot to Opus 5.5, bypasses Fast Cache on a
  non-`browser_use*` call site, and dumps the inherited pool.
- `spawn-browser-agent-v3`: workflow activity args bind to the activity
  signature with `agent_model`; the activity hands the resolved pool to both
  loops; usage rows price at that pool; rotation helper forwards it.
- `world-model-harness`: simulated browser steps call and price on the pool.
- `deploy-resume-e2e`: a real Temporal flash root's browser task runs every
  step on `rose-1-flash`, across a deploy handoff.
- Live: `/deploy` smoke `browser-biometrics-webdecoy` (oss root) exercises the
  image-skip path end to end.
