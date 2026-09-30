---
id: 2026-09-30-zero-spend-task-admitted-live-query-proof
date: 2026-09-30
title: Live-query proof admitted a benchmark that requires zero live spend
surface: infra
component: fleet-capability-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: stability proof did not pass its successful-live-query requirement to catalog eligibility before provisioning
symptoms:
  - "test-mass-agent-run-0 successful_llm_queries 0"
  - "slice-0.llm-proof.json status failed"
  - "zero-live-spend tasks"
tags:
  - cloud-fleet
  - capability-proof
  - cache-replay
sources:
  - PR #1299
  - fleet run capability-stability-20260930153454-11271
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

## Human feedback

Require at least three successful live LLM queries per benchmark, preserve
ordinary benchmark failures, and fix infrastructure without manufacturing
passing scores. Exclude only tasks incompatible with the requested proof;
do not alter their normal benchmark contracts.

## Reusable lesson

Propagate proof requirements to eligibility before allocating resources.
A benchmark designed to prove zero live spend cannot prove live-query progress.
