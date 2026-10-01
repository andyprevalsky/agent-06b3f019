# Planner Memory: Semantic Retrieval (voyage-4, top-3 above 0.70)

## Context

Planner Memory retrieved past runs by lexical scoring only (Postgres FTS + token overlap + pg_trgm,
`coverage >= 0.65`). Paraphrased requests matched 0.22–0.52 of the time depending on the cutoff, and at the
shipped cutoff 13% of near-miss decoys got a memory. This change replaces it with embedding retrieval,
keeping the pipeline as simple as the measurements allow.

## Design

```
WRITE (finalize, detached)                               READ (planner, call_planner_llm_activity)
finalizeAgent → upsertPlannerMemoryFromRun              goal
  → scheduleFinalizeEmbedding(id)  [backend, detached]   │ POST /api/planner-memory/search
      embedPlannerMemory(id)  (idempotent: index version │   backend: voyage-4 embed(goal)
                               + goal hash)              │   pgvector: 1 - (goalVector <=> q), visible rows
        goalVector = voyage-4(goal)                      │   cosine >= 0.70, highest first
      + drain ≤ 8 pending rows (self-heal lost embeds)   ▼
PUT /:id (fixtures/backfill) embeds synchronously       completed runs, one per distinct goal, top 3
POST /embed-pending (backfill/repair, internal;          ▼
  batched 64 goals per embedding request)               lazy critical-path compression (existing lease)
                                                         ▼
                                                        existing get_memories fork (unchanged)
```

- **Storage:** `PlannerMemoryEmbedding` is 1:1 with `PlannerMemory` (cascade delete) and holds `model` (index
  version `voyageai/voyage-4|goal-v1`), `goalHash` and `goalVector vector(1024)`. Migration
  `20260930200000_planner_memory_embeddings` enables `vector` (Supabase ships 0.8.0), drops the lexical
  FTS index and `goalTokens`, and creates the table with RLS. Search is exact cosine over visibility-filtered
  rows (benchmark rows plus the user's own); there is no ANN index at the current corpus size (about 20k
  rows).
- **No LLM at retrieval.** Two alternatives were measured and dropped:
  - An index-time "retrieval card" (an LLM rewrite of each goal): slightly better on paraphrases, but
    too costly.
  - An LLM judge over the shortlist: lower recall and no better precision than a plain cutoff on real
    trajectories.
- **Local/CI Postgres** is `pgvector/pgvector:pg16` (`scripts/lib/local-pg-image.sh`). Stale
  `postgres:16-alpine` workspace containers are recreated with a fresh volume, because the musl→glibc
  collation change would corrupt text indexes. Seed-dump readers use pgvector images. Linux system-Postgres
  paths install `postgresql-<major>-pgvector`.
- **Rose TS client** now forwards `abort_signal` to every route (the funded OpenAI key, gptAuth, the
  Anthropic key, the waterfall). Regression test: `back-end/src/tests/unit/rose-stream-abort.test.ts`, which
  fails on the old client.

## Results (top-3 @ 0.70)

| Test set | precision | recall | false injection |
|---|---|---|---|
| benchmark trajectories, all (188) | 0.97 | 0.89 | 0/8 |
| benchmark trajectories, cross-task | 0.95 | 0.81 | 3/21 |
| owner real runs (105, local only) | 0.80 | 0.66 | 0/11 |
| removed LLM judge, owner real runs | 0.76 | 0.50 | 1/11 |

On the labeled set (421 queries):
- fit / held-out recall@3: 0.68 / 0.73
- paraphrase recall@3: 0.86 / 0.86
- memory injected for novel goals: 0%
- memory injected for hard negatives: 3%

The 0.70 cutoff was chosen on the benchmark trajectories only; the owner set is a held-out check.

**Real-trajectory test set:** `benchmarks/memory_trajectory_labels.py` reads finalized, successful runs
(ids from prod `PlannerMemory`) from R2. It keeps each goal and its actual executed plan, and Opus 5.5 labels
which of each run's 12 nearest neighbors (overall and cross-task) have plans that would help plan it. The
benchmark runs are committed; the owner's runs stay local only in `.context/`.

## Verification (automated)

| Test | Asserts |
|---|---|
| `back-end/src/tests/blackbox/planner-memory.blackbox.ts` (13) | finalize embeds; semantic ranking of a paraphrase; default floor 0.70; exact-first ordering; idempotent / re-embed / cascade; embed-pending drain (internal only); visibility; passed_only; lease; stats |
| `agents/tests/blackbox/planner_memory.blackbox.py` (34) | top-k selection with cutoff (0.70 inclusive), dedupe, success filter; top-3 injected in similarity order; no LLM call at retrieval; compression timeout releases the lease |
| `agents/tests/blackbox/memory_retrieval_bench.blackbox.py` (6) | replays both frozen live snapshots: config pinned; zero memories for novel goals; recall@3 floors; real-trajectory precision / recall / false-injection floors |
| `back-end/src/tests/structural/migration-drift.test.ts` | schema ↔ migration parity (understands `Unsupported(...)`) |
| `back-end/src/tests/unit/rose-stream-abort.test.ts` | caller abort reaches every Rose route |
| `agents/tests/unit/test_backfill_planner_memory.py` | `--embed-pending` drains and stops on no progress |

## Rollout

1. Deploy: the migration enables `vector` and creates the table; finalize starts embedding new runs.
2. `python agents/scripts/backfill_planner_memory.py --backend https://navi-j9a9.onrender.com --embed-pending`
   (about 20k rows, batched 64 goals per embedding request).
3. Check that `GET /api/planner-memory/stats` reports `embedded == total`.
