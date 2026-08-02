---
id: 2026-07-13-autoscaler-blind-to-for-each-sub-workflows-backlog-always-zero
date: 2026-07-13
title: The autoscaler never scaled because `for_each` children spawn as sub-workflows and never enter the Temporal task backlog
surface: agents
component: temporal-worker
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: worker.py autoscaler — desired_machine_count is driven by Temporal task backlog, which for_each sub-workflows never enter
symptoms:
  - "backlog=0 in 100% of 264 metric samples"
  - desired_machines pinned at the MIN floor while workflow_saturation >= 0.75 (154 samples, workflow_count 45-69 of 32 slots)
  - activity slots near-empty (0-4 of 16 used) while the run overruns the 600s/900s cap
tags:
  - autoscaler
  - temporal
  - for-each
  - fan-out
  - backlog-metric
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
  - agent 7a133752
repro: none-recorded
status: open
---

## Problem

The `test-mass-agent-run-0` benchmark kept hitting its prod 600s/900s cap while the
autoscaler sat at its minimum machine floor. A controlled local run
(`scripts/run-bench --local`, agent `7a133752`, 12-worker isolated stack, 96 agents)
produced the numbers: it **completed 95/96 agents in ~16 min** with no hard cap,
proving there was no deadlock — the run is simply slower than the prod cap, and the
autoscaler that should have absorbed it never actuated. `backlog` was 0 in
**100% of 264 metric samples**.

## Diagnosis

Three independent reasons the autoscaler could not react:

1. **Backlog blindness.** `for_each` children spawn as Temporal **sub-workflows** and
   never enter the task backlog. The scale-up math
   (`slot_target = ceil(workflow_count / (slots × occupancy))` plus
   `additional = backlog / capacity`) therefore always resolved to ≤ the floor —
   even across 154 samples where `workflow_saturation ≥ 0.75`
   (workflow_count 45–69 against 32 slots).
2. **Memory pressure only holds.** At 66–77% (threshold ~75%) the memory rule only
   _holds_ the current count steady; it never triggers a scale-up.
3. **Workers weren't the bottleneck anyway.** Activity slots were near-empty
   (0–4 of 16 used).

Where the time actually went: each creator sub-agent takes ~150s
(web_search + web_fetch + spawn_explore + LLM synthesis + verifier), with
`tool_dispatch` spans of 10–12.4s each. 2234 `web_search_activity` + 956
`web_fetch_activity` spans with only ~478 replayed — most hit Exa/Firecrawl **live**.
And with 50–96 concurrent agents against **one shared backend**, `http.request` ran
12–19× slower than baseline (p95 39ms → 490–560ms). `tool_dispatch` envelopes up to
167s are `for_each` **parents awaiting children**, not slow leaves.

The LLM layer was not the cost: `"event":"llm.cache.replay"` appeared 2322 times
(fast-off) / 1352 (fast-on) with ~0 writes. And there were **0 real rate limits** —
an earlier claim of "2365 HTTP 429" was a substring miscount (the digits `429`
appear inside span hashes, ids, and durations).

So: autoscaling _workers_ is the wrong lever. The chokepoints are the shared single
backend, provider latency on uncached web tools, and slow tools — none of which more
worker-only clones fix, since the clones share the same backend.

## Solution

No worker-scaling fix is appropriate; the finding redirects effort to the real
chokepoints (shared backend contention, uncached web-tool latency). The backlog
blindness for `for_each` sub-workflows is documented as a known metric gap.

Operational notes captured with it: `fast_mode_cache_enabled` is set on the agent
only when the `BENCHMARK_FAST_MODE_CACHE` env is set (plain `--local` leaves the
schema default), and local worker logs live at
`.context/benchmarks/<runid>/logs/worker.*.log` (12 shards carrying `span.start` and
`desired_machines` metrics) which must be merged into `agents/navi-worker-log.txt`
for `agent_latency.py`.

## Human feedback

The user **rejected the first RCA outright** ("100% cache → instant → no queue
pressure") and forced a real local run with span/metric evidence, which reversed
three of its claims: the LLM _was_ cache-replayed heavily (user was right), there
were zero real 429s (the 2365 count was a substring artifact), and the earlier
"2 llm.cache events" count had missed the `.replay` suffix. The corrected analysis
also had to state honestly _why_ the autoscaler never scaled rather than assert it
was broken.

## Reusable lesson

Don't grep bare `429` or bare `llm.cache` in JSON logs — match `"status":429` /
`rate_limit_error` and the exact event suffix — and never conclude a scaling story
without span durations from a real run.
