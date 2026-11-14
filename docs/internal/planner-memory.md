# Planner memory (trajectory RAG over finalized runs)

`call_planner_llm_activity` retrieves compressed memories of past runs with similar goals and appends a native `get_memories` tool call and result to the END of the planner context, never the system prompt, so the cached prefix (tools, static system prompt, conversation) is byte-identical with or without hits.

- Gate: per-agent `memory_enabled` (create body / `Agent.memoryEnabled`, inherited by sub-agents); benchmarks default it off. Global kill switch: `PLANNER_MEMORY_ENABLED=0`.
- Code: `agents/providers/planner_memory/`, backend `back-end/src/domains/planner-memory/` and `back-end/src/providers/plannerMemoryStore.ts`.
- Corpus: one `PlannerMemory` row per finalized root bundle, written in the same archive finalize that publishes the R2 manifest (`traceArchiveLifecycle.finalizeAgentOnce`), so table and archive never drift (`back-end/src/tests/blackbox/planner-memory.blackbox.ts`).
- Compression is lazy: `criticalPath` is a TTL-free cache; the first planner that retrieves an uncompressed row runs `compressor.py` once (prompt capped at 100 lines by test) and PATCHes it back. No cron, no index build. Only completed runs are retrieved or compressed.
- Retrieval: one indexed Postgres query (`to_tsvector` GIN + `pg_trgm`), then in-process scoring in `retrieval.py`. `RetrievalConfig` (strategy + absolute cutoff) was chosen by `agents/benchmarks/memory_retrieval_bench.py` on the frozen labels `agents/benchmarks/fixtures/memory/retrieval-labels.json`; 0 or 1 hits is normal.
- Tool history is native: the planner declares a constant declared-only toolset (`planner_context_tools()`: plan-phase tools + `get_memories`), keeps `output_config` for structured output and sets `tool_choice` to `none`. `build_planner_messages` keeps real assistant `tool_calls` / `role: tool` pairs; the waterfall (no declarations) flattens the fork with `flatten_tool_history_to_text`.

## Proof and fixtures (run from `agents/`, venv active)

- `python benchmarks/run_memory_scenarios.py --port N`: real planner calls, memory off vs on, over `benchmarks/memory_scenarios.json` (archived-run scenarios plus negative controls, fit/held-out split); writes `.context/memory-dashboard/index.html` with the exact injected context per scenario.
- `python benchmarks/run_memory_compressor_bench.py`: runs the compressor on real completed transcripts (`benchmarks/memory_compressor_cases.json`, up to 10k messages) with transcript-grounded assertions (tool names, URLs, no PII, bounds).
- Both are registered in the smoke tier of `scripts/test.sh`. Catalog A/B tasks: `planner-memory-blue-bottle-off` / `-on` (`start_phase: plan`, `success_on_plan`, `plan_shape` static checks, `environment.memory_fixtures`).
- Fixtures: `python scripts/build_memory_fixture.py --name <n> --bundle-id <root_agent_id>...` writes `benchmarks/fixtures/memory/<n>.json`; `run_benchmark.py` loads it into the local stack's history table for `memory: "on"` tasks.
- After a deploy, backfill history rows: `python scripts/backfill_planner_memory.py --stats`, then `--backend <prod url>`.
