# Rose edge-function retirement

## Goal

Kill the Supabase `/completions` edge function. Reroute every caller through
the in-process provider that already exists in `agents/providers/rose/`
(Python) and a new `back-end/src/providers/rose/` (TypeScript) port. Delete
the entire research surface area except `research/gepa/`.

There are no external API customers. The public Rose API, all benchmark
infrastructure, and Stagehand-based browser harnesses are all dead weight.

## Architecture

Same model contract on both sides:

- claudeAuth path: direct call to `https://api.anthropic.com/v1/messages`
  using the user's Claude OAuth token. `actual_model` is suffixed `-claude`.
- waterfall path: sequential OpenRouter `/chat/completions` calls per the
  pool's model list.
- Pool definitions live in one place per language:
  - `agents/providers/rose/pools.py` (already exists)
  - `back-end/src/providers/rose/pools.ts` (new — mirrors Python)

Backend never calls another backend HTTP endpoint. No edge function. No
fetch hop to `localhost:54321`. Both stacks talk directly to Anthropic and
OpenRouter with the same retry/backoff semantics the edge function had.

## Work

1. **TS port (`back-end/src/providers/rose/`)** — minimal surface needed
   by chat callers (no tools, no browser-use, no vision multimodal beyond
   what callers already pass). Files: `types.ts`, `errors.ts`, `pools.ts`,
   `transport.ts`, `streaming.ts`, `claudeAuth.ts`, `waterfall.ts`,
   `client.ts`, `index.ts`.

2. **Swap chat callers** — `routerLlm.ts`, `generatorLlm.ts`,
   `supervisorHandler.ts`, `contextBuilder.ts` import from
   `../rose/client` (function name + chunk shape preserved). Delete
   `back-end/src/providers/chat/supabaseCompletions.ts`.

3. **Inline pricing** — move `/cost` lookup into both languages:
   `agents/providers/rose/pricing.py` and `back-end/src/providers/rose/pricing.ts`.
   Update `agents/utils/model_pricing.py` and `back-end/src/providers/modelPricing.ts`
   to consult the in-process map. No HTTP hop.

4. **Delete dead code**:
   - `research/supabase/`, `research/domains/`, `research/scripts/`,
     `research/test_rose_*.py`, `research/browser-use-repo/`, all
     `research/tests/integration/blackbox/*` except gepa, etc.
   - `agents/utils/rose_types.py`, `call_rose_browser_use`, Stagehand tests,
     `test_llm_image_limits.py`, `test_browser_agent_v3.py`,
     `agents/test_ttft.py`.
   - `back-end/src/benchmarks/{harbor-client.ts,agents/}`,
     `back-end/test-all-benchmarks.ts`, `back-end/test-rose-agent.sh`,
     `back-end/TERMINAL_BENCH_ROSE_INTEGRATION.md`.
   - Public Rose API routes: `back-end/src/routes/rose-api/` if any,
     plus `docs/` references.

5. **Gepa stub** — replace `simulate_user.py`'s httpx call with
   `raise RuntimeError(...)` since the Supabase function is gone. Gepa
   is research-only and is not part of any production path.

6. **Run scripts** — drop `research` from `scripts/run.sh` and update
   `conductor.json`. Update CLAUDE.md to reflect the new architecture.

## Verification

Automated only:
- `bash scripts/test.sh` — full offline tier (TS + Python + lint + types).
- `cd back-end && npm run test:coverage` — backend coverage gate.
- `cd agents && bash scripts/run-coverage.sh` — agents coverage gate.
- `bash scripts/test.sh --smoke --port=3001` — smoke benchmarks. Must
  exercise both chat (router→generator) and agent (claudeAuth→waterfall)
  paths end-to-end. Asserts on `actual_model` family being claude-* (per
  memory: gemini fallback = silent claude failure).
- New blackbox: `back-end/src/tests/blackbox/rose.blackbox.ts` covering
  claudeAuth happy path, waterfall fallback, pool routing.
