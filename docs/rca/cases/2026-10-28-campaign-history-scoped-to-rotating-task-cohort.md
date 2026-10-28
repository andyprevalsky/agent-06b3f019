---
id: 2026-10-28-campaign-history-scoped-to-rotating-task-cohort
date: 2026-10-28
title: Campaign scorecard restarted history when the task cohort rotated
surface: infra
component: cloudbench-scorecard
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: cloudbench-scorecard build selected experiments only by the current task-derived goal and exposed no explicit cross-goal scope
symptoms:
  - EXPERIMENT #1
  - 1 launch
  - agent demo-cache
  - src UNRECORDED
tags:
  - scorecard
  - experiment-history
  - provider-cache
sources:
  - commit 4c6861dcd2a9aacf22e3937cea27fae904727349
  - benchmark run campaign-20261028-000553-2852420
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
repro: python3 scripts/tests/cloudbench-scorecard.test.py Scorecard.test_explicit_history_scope_preserves_rotating_cohort_continuity Scorecard.test_provider_prompt_cache_share_requires_complete_denominator
status: fixed
---

## Problem

The sixth campaign in the operator's descent displayed Experiment #1 / 1 launch
with --iterations 5. The original ledger contains eight launches: two older
runs plus all six descent campaign IDs. The current campaign rotated from the
001 task cohort to the 016 cohort, changing its task-derived goal. There is no
persisted descent membership on the launch box. The parent explicitly supplied
the intended six campaign IDs; task overlap alone cannot establish membership.

The card also called a legacy token ratio agent demo-cache. Captured BU016 has
213760 provider prompt-cache read tokens, zero creation tokens and 17803 uncached
tokens. Its legacy ratio is 100%, whereas its complete prompt-cache share is
92.3%. I23 independently verified live execution; token usage cannot prove DEMO
replay. Existing aggregate cards do not retain all three counts.

## Diagnosis

run-bench-campaign.py forms a default goal from the truncated task list.
cloudbench-scorecard.build groups the ledger by that goal. --iterations only
controls trend visibility; it neither selects descent membership nor changes
the ordinal. Therefore the default #1 is correct for its recorded cohort, but
there was no supported control for explicit cross-cohort reporting.

The permanent captured-ledger test establishes default #1 and then selects the
six explicit original IDs. Baseline rejects history_ids; the candidate yields
#6, six launches, chronological trend and latest-three history even when IDs
are supplied backwards. It rejects unknown, duplicate and current-excluding
scopes and leaves ledger bytes and clocks unchanged. The actual CLI is tested.

The cache consumer used cost.fast_cache_hit_rate, a ratio whose denominator
omits uncached tokens. The captured unchanged test fails with 1.0 versus
0.9231181147247185 on baseline. The proposed consumer requires all three raw
finite nonnegative counts, otherwise reporting UNMEASURED. I23 owns their
producer projection; no old missing fields are filled with zeros.

Archive searches: experiment/cohort/cache/UNRECORDED and demo-cache/history
scope. This is a relative of the campaign receipt adapter case, not a recurrence
of its terminal receipt binding defect. Source attribution for still-running
copies was checked separately. All 30 frozen pre-provision provenance receipts
name the same source, but eight intermediate cards use run_id=batch and lack
embedded provenance. The adapter correctly refuses those physical-run bindings.
The frozen summary replay therefore retains source UNRECORDED; pre-provision
receipts alone do not attest guest execution. No source fallback was added. The subsequent final packet has 30 properly bound
terminal cards; unchanged source attribution resolves to the full original
4c6861dcd2a9aacf22e3937cea27fae904727349. Its offline replay retains 26 PASS,
four genuine FAIL and zero infra; all 211 original packet files remain unchanged.

## Solution

Candidate adds repeated --history-id as an explicit read-only ledger selection.
It retains canonical ledger ordering and derives display ordinals within the
selected membership without changing original records, clocks or outcomes.
Existing default per-goal grouping remains unchanged.

Cache display computes read/(read+creation+uncached) only with a complete valid
denominator and labels it provider prompt-cache share. It never calls provider
usage DEMO replay. No runtime, acceptance criterion or benchmark definition is
changed. The exact seven-path patch SHA256 7b7ecc6bde684bf7dd64d5c59e547fb36b126199b8c29256b8efcc529c3573ff was independently reviewed GROUNDED by ph74rex3pescaywbxyjn3njr158h3pp9, who applied it to 4c686 and ran all 46 tests (2.030 s). Both unchanged
owning tests pass after failing on the source revision; all 46 registered
scorecard tests pass. scripts/test.sh and run-deploy-structural-gates.py already
register this suite. The frozen full campaign replay retains 18 PASS, one genuine
FAIL, 11 running and zero infra; all 164 original packet files remain unchanged.

Golden references: openclaw/src/commands/sessions.ts:278-295 reads session entries,
filters, sorts and limits for presentation without changing stored records;
codex/codex-rs/thread-store/src/local/list_threads.rs:24-48 uses explicit sorting
and rejects invalid selection input. These support read-only scope projection,
not an inference of descent membership. Six-ID membership is operator supplied.
The cache denominator also matches the existing canonical computation in
agents/benchmarks/run_benchmark.py:16835-16843; that acceptance code is unchanged.

## Human feedback

The parent required explicit original membership, original clocks, unknowns when
source evidence is absent, and no acceptance changes. The parent reassigned all
scorecard cache consumer hunks here while I23 retains producer and mode evidence.
The independent reviewer required a registered full history regression rather
than treating unsupported-argument failure alone as sufficient proof.

## Reusable lesson

Expose explicit read-only history membership when operator experiments span multiple recorded goals, and never infer replay or complete cache ratios from partial usage telemetry.
