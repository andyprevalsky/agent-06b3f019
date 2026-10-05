---
id: 2026-09-30-zero-spend-task-admitted-live-query-proof
date: 2026-09-30
title: Live-query proof admitted tasks whose runtime policy requires cache replay
surface: infra
component: fleet-capability-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: stability proof did not pass its successful-live-query requirement to catalog eligibility before provisioning
symptoms:
  - "test-mass-agent-run-0 successful_llm_queries 0"
  - "slice-0.llm-proof.json status failed"
  - "zero-live-spend tasks"
  - "single-creator-arm successful_llm_queries 0 despite fast_mode_cache_enabled false"
  - "DEMO-replay tasks"
tags:
  - cloud-fleet
  - capability-proof
  - cache-replay
sources:
  - PR #1299
  - fleet run capability-stability-20260930153454-11271
  - fleet run 20260930-162657-18852
repro: agents/tests/blackbox/benchmark.blackbox.py:test_live_query_proof_rejects_zero_spend_tasks_before_provisioning
status: mitigated
---

## Problem

Proof77 ran ten tasks on dedicated CPUs. Every task produced an ordinary FAILED
verdict, guest cleanup ACK and full E2E retirement marker. Cleanup was verified
and no pool claims remained. Nine tasks had 14–70 correlated live completions,
but the mass-agent task had zero. The proof correctly failed, granting zero
credit. Its total wall time was 981.1 seconds; individual E2E times were
702–712 seconds. Unlike proof75, mass-agent archive finalization did not time out.

## Diagnosis

The mass-agent catalog contract explicitly sets fast_cache on and declares the
zero_live_spend evaluator. Its worker trace had 388 cached dump/update pairs
across 51 agents and no live transport-completion events. This is an intentional
replay, not evidence of three live completions. Enabling live calls or counting
cached outputs would change the benchmark contract or weaken proof acceptance.

The first wrong decision was selection: the proof knew its live-query minimum
but did not forward it to the eligibility helper. Searches for zero live spend
and capability admission found related platform/callee cases, but no prior
case at this requirement mismatch.

The permanent owning CLI assertion ran unchanged before and after the fix.
Before: an explicit mass-agent pool with --min-successful-llm 3 was admitted,
returning exit 0 and selecting that task. Expected: exit 2 before provisioning.
Command: load benchmark.blackbox.py with agents/tests/blackbox on sys.path,
then call test_live_query_proof_rejects_zero_spend_tasks_before_provisioning.
It uses only dry selection and performs no provider requests.

## Solution

Forward the existing minimum to sampling. When it is positive, exclude tasks
whose declared checks require zero live spend; reject an explicit conflicting
pool with an explanation. Ordinary capability/probe runs with no live-query
minimum retain those tasks. No task names are hard-coded in production policy;
the declared evaluator controls eligibility. No cache behavior, prompt, model,
task definition, evaluator, deadline or result classification changed.

The same permanent CLI gate now passes: explicit conflict rejection, automatic
pool exclusion, ordinary cached-task admission and compatible live-task
admission. The fleet stability suite also passed its 25 checks. The resource
profile's real startup/archive/retirement boundary worked, but a compatible
ten-slice live acceptance campaign remains pending, so this case is mitigated.

### Recurrence: an untagged DEMO-bound child

Proof79 reproduced the same eligibility defect for `single-creator-arm`. Its
catalog entry has no DEMO tag, pinned `fast_cache` value, or zero-spend check.
The terminal run and backend request both recorded the Fast Mode button off,
yet the exact worker trace contained 102 `llm.cache.replay` events and no live
provider completions. Gmail in the same slice had 21 live completions. The
slice was interrupted with zero credit and exact-owner retirement verified.

`agentExecutionMode.ts` distinguishes the provider-speed button from DEMO
replay. The runtime's pure `demo_cache_allowed` policy also admits an
identity-bound creator child. The evaluator-only filter missed that owning
policy; setting the button off cannot establish live transport activity.

The sampler now calls that same pure policy for catalog goals when the requested
live-query minimum is positive. It excludes those tasks from random selection
and rejects an explicit conflicting pool before allocation. It does not change
the runtime cache, task contracts, or provider-speed setting. Ordinary runs
without that minimum still admit the creator child and zero-spend tasks.

The existing registered `live_query_proof_zero_spend_admission` gate dispatches
through `run_all_tests`: unchanged new assertions failed on the evaluator-only
sampler (creator child admitted, exit 0 instead of 2), then passed after the
policy integration. Both provider-speed values are tested, along with ordinary
creator admission, zero-spend rejection, full-pool exclusion and a live Polar
control. Evidence: `.context/acceptance/demo-bound-admission-before.log` and
`demo-bound-admission-after.log`. A final-source ten-slice acceptance remains
pending; this recurrence also stays mitigated.

At 10,000 agents, this policy integration still runs only during local catalog
selection, once per sampled command. It creates no network requests, polling,
per-agent subscriptions, shared runtime counters, or production hot-path work.
The required read-only adversarial review found no blocking issues in the
policy reuse, ordinary admission, registered coverage, or independent speed
and replay controls.

## Human feedback

Require at least three successful live LLM queries per benchmark, preserve
ordinary benchmark failures, and fix infrastructure without manufacturing
passing scores. Exclude only tasks incompatible with the requested proof;
do not alter their normal benchmark contracts.

## Reusable lesson

Propagate proof requirements to eligibility before allocating resources.
A benchmark designed to prove zero live spend cannot prove live-query progress.
