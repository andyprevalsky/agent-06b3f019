---
id: 2026-10-23-cloud-shared-fast-cache-route-not-read-only
date: 2026-10-23
title: Cloud guests replayed the shared July cache without strict read-only, so a schema miss went live
surface: infra
component: cloudbench-run.sh resolve_fast_cache_route
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloudbench-run.sh resolve_fast_cache_route routed fast_cache:on tasks to the shared cache without FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1, unlike agents/benchmarks/local.py
symptoms:
  - "Declared evaluator t7-schema-task-complete failed: Criterion T7 asks whether the Task Complete cards show the real summary and populated schema outputs"
  - "The typed tree shows completion_outputs_count: 1"
  - "Strict read-only benchmark cache miss for response_schema; live fallback is disabled"
  - "fastmode:v42:llm:4ae3193053ac1d8f:response_schema:c:a330aeeed936ac6b24f3865901a8f966 llm.cache.miss"
tags:
  - fast-cache
  - demo
  - cloudbench
  - local-cloud-parity
  - mass-agent
  - response-schema
sources:
  - task test-mass-agent-run-0
  - fleet run 20261023-184218-338710 (descend-full69-20261023 p3-proof-1 on 8597c31af; also -338707, -338719, -338732)
  - agent bcf9a7eb-9aa9-4f17-bb48-bb15409cedbf
  - benchmark run 22feab24-04f6-45bd-9754-3a38d3bf4f6b (local pass, root ed20d4d7-25fc-4e9d-bdd1-e2a5d894017e)
  - commit 70742aa3f (rca/P4-mass-agent-t7-schema)
repro: agents/tests/blackbox/benchmark.blackbox.py::test_cloudbench_fast_cache_on_guest_is_read_only_like_local
status: mitigated
---

## Problem

After the dedicated-vCPU fix let `test-mass-agent-run-0` complete in the
cloud, every p3-proof-1 copy (four inspected) failed only
`t7-schema-task-complete`. On run 20261023-184218-338710 the root's
`response_schema` required `creator_analysis_file`, `positioning_statement`,
`content_calendar_file`, `hook_openings` and `engagement_creators`; its Task
Complete card had one output, `positioning_statement`, as an HTML file
pointer. The other copies had different generated field names and also matched
only one to three outputs. Member task: `test-mass-agent-run-0`.

## Diagnosis

Critical path: root goal, then `set_response_schema_activity`, then the Fast
Mode content lookup, then the live model or a strict miss, then the replayed
July assemble markdown. `_coalesce_structured_response` turns `# field`
headings into outputs, then `_format_outputs` builds the Task Complete card.

- **Same key, both surfaces.** The local pass and every cloud copy looked up
  the same key, `...response_schema:c:a330aeee...`, and every lookup missed.
- **Local refused the live call.** The local worker logged `Strict read-only
  benchmark cache miss for response_schema; live fallback is disabled`.
  `agents/benchmarks/local.py` sets `FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1`
  for shared-cache tasks. The root therefore ran without a schema.
- **The local root then passed.** Completion took outputs from the recorded
  July headings (`top_creators_analysis`, `positioning_statement`,
  `ninety_day_content_calendar`, `hook_tested_video_script_openings` and
  `weekly_engagement_target_creators`), producing eight outputs.
- **Cloud called a live model instead.** The cloud worker logged
  `rose.cerebras.start`, `qwen-3.8-27b` and `Generated response schema` with
  fresh names. The proof's fleet config had `benchmark_demo_cache_read_only=""`.
  `resolve_fast_cache_route` set `FAST_MODE_CACHE_USE_LOCAL=0` but no write
  policy. The strict flag reached guests only through the opt-in
  `--demo-cache` probe.
- **The mismatch failed T7.** Fresh field names could not match the recorded
  headings, so only `positioning_statement` coalesced.

Hypotheses (a), the scorecard prompt section, and (b), extraction or coercion
regression, were rejected. Completion behaved the same way on both surfaces;
only the schema source differed. Hypothesis (c), an evaluator mismatch, was
also rejected: the evaluator correctly reported missing typed outputs.

Deeper rung: the schema-generation key drifted. The shared cache holds
`v42` `response_schema` rows for goal `4ae3193053ac1d8f`, dated 3 July (x3),
25 August and 27 August. The 25 and 27 August rows (`a528760c...` and
`01e3b830...`) contain exactly the July assemble field names. The key hashes
the whole schema request, including the system prompt and response model.
Those changed after 27 August in `bab6b9afc`, `c410a127c`, `3069d1df8`,
`5b1941614`, `d7de49c1d` and `f4c70095f`. The backend's goal-scoped
`get-position` content fallback prefers the oldest pre-25-August row, a
3 July schema whose names do not match the assemble. It is therefore not a
correct replacement.

Archive: searched `Strict read-only benchmark cache miss response_schema live
fallback` and `mass-agent cloud schema outputs missing Task Complete fast cache
cloud local parity`. Relatives:
`2026-10-05-demo-replay-probe-live-fallback-before-cache-context`, which made
cloud read-only an opt-in diagnostic, and
`2026-09-28-root-title-coupled-to-missing-schema-cache`, the same local
schema miss tolerated by deriving the title. This is a novel parity gap.

Repro: run
`test_cloudbench_fast_cache_on_guest_is_read_only_like_local` through
`runpy`, with `PYTHONPATH=.:tests/blackbox`, from `agents/`. On 8597c31af it
raised `AssertionError: test-mass-agent-run-0`: cloud gave `None` while local
gave `"1"`.

## Solution

`scripts/cloudbench_catalog.py` gains `shared-fast-cache-read-only`, which
mirrors local's rule, including the deliberate google-oauth live-seed
exception. The guest stack route and the autoscaled worker wrapper in
`run-bench-fleet` `provision_worker` both use it. A broken resolver fails
closed. The harness process and its judges are unchanged. The unchanged repro
passes, and the existing route test now expects the read-only entry. Both
passed five consecutive runs. At 10k agents this is one catalog subprocess per
guest or worker provision, with no new requests, locks or polling.

Status is `mitigated`: on a miss, cloud now fails loudly instead of calling a
live model. Two items remain open:

- **Drifted schema row.** The canonical August schema row needs to be
  refreshed under the current key, or replay needs to resolve schema drift by
  design.
- **Cache-coverage check.** Declared evaluators run before worker logs are
  collected, and clone logs are not visible to the guest evaluator.

### 2026-10-23: drifted schema row refreshed (Andy-approved additive write)

With Andy's approval, relayed by the descend parent, one row was added to the
shared Fast Mode cache. It was written through the supported client
(`providers.fast_cache.client.cache_set` with `FAST_MODE_CACHE_RECORD_DEMO=1`)
against the production backend `/api/fast-cache/set`.

- **Source key:** `fastmode:v42:llm:4ae3193053ac1d8f:response_schema:c:01e3b830e521586d6836a39b5dc32dc3`.
  The value was read through `/api/fast-cache/get`: sha256 of its canonical
  JSON is `2c98c2971235d76553e086a2dc38bd427e79652e7b7d4bd7096592427b52a320`
  (956 bytes).
- **Destination key:** `fastmode:v42:llm:4ae3193053ac1d8f:response_schema:c:a330aeeed936ac6b24f3865901a8f966`.
  It was absent before the write (`hit: false`).
- **Write and read-back:** `stored: true`. The read-back hit has the same
  sha256 and byte count and is equal to the source value. A read-only query of
  `FastModeCacheEntry` shows the new row with the same `md5(value)` as the
  source, `be6ca9c35dcef6d551b677baa6b1d05f`.
- **Scope:** no other rows were changed or deleted.

Miss inventory: worker logs from the local pass and from all four cloud copies
were checked, including the autoscaled worker captures, which made no cache
lookups. The only LLM cache miss, and the only live model call, was this one
`response_schema` key. On a hit, the schema replays with the July field names
and the title "Creator Brand Strategy".

Open follow-up: there is still no cache-coverage evaluator that fails on any
miss. Declared evaluators run before worker logs are collected
(`run_benchmark.py` `_run_declared_evaluators` comes before log collection),
and autoscaled worker logs are not visible to the guest evaluator. The parent
deferred this check on 2026-10-23. The key will drift again whenever the
schema-generation request changes, and only strict read-only replay makes
that loud.

## Human feedback

Andy, relayed by the descend parent on 2026-10-23: test-mass-agent-run-0 must
be fully demo-cached, with zero live LLM calls on both surfaces. Its catalog
entry and cache fixtures may be changed without approval. A miss must fail
loudly, and a coverage check should fail on any miss.

## Reusable lesson

When a task passes locally but fails in the cloud on replayed content, diff the per-surface Fast Mode write policy first; local and cloud must derive it from one predicate.
