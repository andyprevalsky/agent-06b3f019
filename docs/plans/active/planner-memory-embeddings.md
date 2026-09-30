# Planner Memory: Embeddings + LLM Judge

## Context

Planner Memory retrieved past runs by lexical scoring only (Postgres FTS + token overlap + pg_trgm,
`coverage >= 0.65`). On paraphrased requests it got 0.20–0.55 recall@1 depending on cutoff. At the
shipped cutoff it injected a memory for 13% of hard negatives (same domain, different task).

This change replaces lexical retrieval with semantic retrieval chosen by measurement, and holds the
false-positive rate at zero.

## Design

```
WRITE (finalize, detached)                              READ (planner, call_planner_llm_activity)
finalizeAgent → upsertPlannerMemoryFromRun             goal
  → scheduleFinalizeEmbedding(id)  [backend, detached]   │ POST /api/planner-memory/search
      embedPlannerMemory(id)  (idempotent: model+goalHash)│   backend: voyage-4 embed(goal)
        identical goal already embedded? copy it         │   pgvector: 1 - (goalVec <=> q)
        else goalVec = voyage-4(goal)                     │   visible rows, >= min_similarity, ordered
                                                         ▼
      + drain ≤2 pending rows (self-heal lost embeds)   shortlist: completed runs, dedupe goal, top 5
PUT /:id (fixtures/backfill) embeds synchronously        │ judge: rose-1-mini (gemini-3.5-flash-lite), JSON by prompt
POST /embed-pending (backfill/repair, internal)          │   only relation == "same_task" → 1 memory
                                                         │   timeout (5 s) / error / other relation → none
                                                         ▼
                                                        existing lazy compression + get_memories fork (unchanged)
```

- Storage: `PlannerMemoryEmbedding` (1:1 with `PlannerMemory`, cascade delete): `model` (index version),
  `goalHash`, `goalVector vector(1024)`. The pending drain embeds identical goals once, 64 per request. Migration
  `20260930200000_planner_memory_embeddings` enables `vector` (Supabase ships 0.8.0), drops the lexical FTS
  index and `goalTokens`, and creates the table with RLS.
- Exact cosine over the visibility-filtered rows. There is no ANN index yet; prod has about 20k rows and each
  search scans the shared benchmark rows plus that user's own rows.
- Judge pool `rose-1-mini`: gemini-3.5-flash-lite, `reasoning.effort` "low" (the endpoint rejects "none"), direct
  auth skipped. The prompt asks for JSON and the reply is parsed, with no `response_format` (that would add
  latency and some layers skip it).
- Local/CI Postgres image is now `pgvector/pgvector:pg16` (`scripts/lib/local-pg-image.sh`). Existing
  `postgres:16-alpine` workspace containers are recreated with a fresh volume, because musl→glibc collation
  would corrupt text indexes. Setup and run reseed the DB. Linux system-Postgres paths install
  `postgresql-<major>-pgvector`.

## Verification (automated)

| Test | Asserts |
|---|---|
| `back-end/src/tests/blackbox/planner-memory.blackbox.ts` (13) | finalize embeds, paraphrase retrieval with no shared words, exact-first ordering + floor, idempotent / re-embed on goal change / cascade, embed-pending drain (internal only), visibility, passed_only, lease, stats |
| `agents/tests/blackbox/planner_memory.blackbox.py` (36) | shortlist floor/dedupe/top_n, same_task-only verdicts, judge prompt, planner fork with judge, judge reject / timeout inject nothing quickly, compression timeout releases the lease |
| `agents/tests/blackbox/memory_retrieval_bench.blackbox.py` | replays the frozen live snapshot: config pinned, 0 negative + 0 hard-negative FPs, recall floors |
| `agents/tests/blackbox/rose.blackbox.py` | rose-1-mini pool shape |
| `back-end/src/tests/structural/migration-drift.test.ts` | schema ↔ migration parity (now understands `Unsupported(...)`) |
| `agents/tests/unit/test_backfill_planner_memory.py` | `--embed-pending` drains and stops on no progress |

Live bench: `python benchmarks/memory_retrieval_bench.py --port N` indexes 207 runs through PUT and runs 421
queries (199 labeled, 150 paraphrases, 12 negatives, 60 hard negatives) through search and the real judge.
`--rejudge` re-runs only the judge over the frozen snapshot.

Index-time retrieval cards (an LLM rewrite of each goal) were measured and **dropped for cost**. Goal-only is
what ships.

| Index | hard-neg FP | fit r@1 / paraphrase | held-out r@1 / paraphrase |
|---|---|---|---|
| lexical (old, shipped cutoff) | 13% | — / 0.52 | — / 0.52 |
| rose-1-mini | 1.7% | 0.71 / 0.83 | 0.67 / 0.79 |
| **goal only (shipped)** | **1.7%** | **0.72 / 0.84** | **0.73 / 0.84** |
| rose-1-ultra cards | **0%** | **0.72 / 0.86** | **0.72 / 0.90** |
| rose-1-flash | Cerebras hop returned empty streams | | |

Judge latency (rose-1-mini) p50 ≈ 0.9 s, p90 ≈ 1.0 s.

Fixed along the way: the TS Rose client forwarded `abort_signal` only to claudeAuth, so callers could not bound
the funded-OpenAI-key hop, gptAuth, the Anthropic-key hop, or the waterfall (a hung key stalled an index-time LLM call for about 11 min).
Regression: `back-end/src/tests/unit/rose-stream-abort.test.ts` (fails on the old client).

## Rollout

1. Deploy (migration enables `vector`, creates the table; finalize starts embedding new runs).
2. `python agents/scripts/backfill_planner_memory.py --backend https://navi-j9a9.onrender.com --embed-pending`
   (about 20k rows; identical goals are copied rather than re-embedded).
3. `GET /api/planner-memory/stats` → `embedded == total`.

## Judge criteria, model, and real-trajectory evaluation (2026-09-30, final)

- **Criteria:** the judge now uses the planner's own `get_memories` criteria. A past run is useful when its
  plan would help plan the goal (entry points/URLs, tool choices, decomposition, session handling,
  pitfalls), even if item, store, date or wording differs. It is not useful when it only shares topic or
  location words. This replaced a stricter "same task" rule, which rejected the transfer cases the memory
  scenarios reward. The old hard negatives encode that rule, so they are reported, not gated.
- **Judge model:** `rose-1-mini` is now Gemini 3.5 Flash-Lite (reasoning `low`, direct auth off). The
  `rose-1-nano` pool was removed. On the frozen candidates with the new prompt:

| Judge | p50 / p90 | novel-goal FP | fit / held-out top-1 | paraphrase fit / held-out |
|---|---|---|---|---|
| **gemini-3.5-flash-lite** | 0.81 / 1.46 s | 0% | 0.79 / 0.77 | 0.86 / 0.90 |
| gemini-3.8-flash | 2.63 / 4.64 s | 0% | 0.77 / 0.74 | 0.84 / 0.90 |
| cerebras qwen-3.8-27b | 0.44 / 0.69 s | 8% | 0.76 / 0.71 | 0.79 / 0.81 |
| cerebras gpt-oss-120b | 0.22 / 0.36 s | 0% | 0.75 / 0.79 | 0.79 / 0.91 (more wrong picks) |

- **Real-trajectory test set:** `benchmarks/memory_trajectory_labels.py` reads finalized, successful
  real runs (ids from prod `PlannerMemory`) from R2, keeping each run's goal and its **actual executed plan**.
  For each run's 12 nearest neighbors (overall and cross-task), Opus 5.5 sees both runs' real plans and
  labels which past runs would help plan it. The judge only sees goals.
  - `fixtures/memory/retrieval-trajectories.json`: 188 benchmark runs, committed.
  - `.context/planner-memory/retrieval-trajectories-owner.json`: 105 of the owner's runs, local only.

| Set / slice | precision | recall | shortlist recall | false injection |
|---|---|---|---|---|
| benchmark, all | 1.00 | 0.90 | 0.96 | 0/8 |
| benchmark, cross-task | 0.99 | 0.85 | 0.94 | 1/21 |
| owner (real user goals) | 0.85 | 0.55 | 0.82 | 0/11 |

  Open item: on real user goals the judge is conservative. A useful run is in the shortlist 82% of the
  time, but one is injected only 55% of the time.
- **Labeled set (421 queries), new criteria:** fit / held-out top-1 0.77 / 0.77, paraphrase 0.83 / 0.86,
  novel-goal FP 0%.
