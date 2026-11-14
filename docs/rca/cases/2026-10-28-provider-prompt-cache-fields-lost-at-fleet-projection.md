---
id: 2026-10-28-provider-prompt-cache-fields-lost-at-fleet-projection
date: 2026-10-28
title: Fleet projection dropped the provider cache denominator and the card called it DEMO replay
surface: harness
component: cloudbench-terminal-report-card
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-aggregate-runs.py _terminal_report_card drops TaskResult prompt_cache counters
symptoms:
  - agent demo-cache avg 100%
  - fast_mode_cache_enabled true on live provider calls
  - prompt_cache_uncached_input_tokens absent from fleet per_task card
tags:
  - prompt-cache
  - telemetry
  - demo-replay
sources:
  - commit 4c6861dcd2a9aacf22e3937cea27fae904727349
  - agent ph74rex3pescaywbxyjn3njr158h3pp9
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_fleet_terminal_card_preserves_prompt_cache_denominator_without_inventing_missing_fields
status: open
---

## Problem

It6 reported a 100% DEMO-cache average on live Polar tasks, raising an acceptance
hold. A full immutable-artifact audit covered 20 terminal members (19 original
PASS, one original FAIL); all 18 PASS rows in the supplied earlier snapshot were
included. All twenty resolved DEMO contexts had reads disabled, all goals were
outside the DEMO allowlist, 512 provider-read spans succeeded, and 494 delivered
browser LLM usage items said from_fast_cache=false. No replay/hit events occurred.
The remaining live campaign members are outside this audit. Original grades and
other acceptance gates remain unchanged.

## Diagnosis

The Fast Mode flag is the provider-speed button, independent of DEMO replay.
The legacy cache_hit_pct divides cache reads by reads plus writes, omitting
uncached input. BU016 had 213760 read, zero creation, and 17803 uncached tokens:
legacy ratio 100%, real measured provider prompt-cache share 92.3%. The fleet
terminal projection discarded the three already-recorded prompt counters and
exported only the legacy ratio. The scorecard called that value DEMO cache.
An owning projection regression fails on the original source because all three
fields disappear. The identical test passes when they are preserved. A separate
actual browser-decision control confirms the observed write-only path calls the
live provider and never cache_get; counterfactual read-enabled calls cache_get.

## Solution

Preserve the measured read, creation and uncached prompt counters in per_task
terminal cards only when present. The exact producer/test patch
SHA256 ef6d16ab6ffc4ebe37e0ea238715accccf1cb0f380ccdeda37c0471f6a3d31d9
was independently reviewed GROUNDED before application. Do not manufacture missing zero values or
change legacy raw fields, provider settings, task definitions, grades or replay
policy. The scorecard consumer correction is owned separately by I24: use all
three counters and label provider prompt-cache share; missing or invalid
counters are unmeasured. This producer repair alone does not fix old rendered
cards. Exact independent review and gate receipts are in the I23 handoff.

The audit supports live execution for the twenty captured members, not a blanket
campaign PASS. The case remains open until the paired consumer is integrated
and later terminal members have separate mode evidence.

## Human feedback

The parent required original execution artifacts rather than interpreting a
card label, held acceptance credit during investigation, and prohibited task,
grade or validator changes. The parent split producer and mode evidence to I23,
all scorecard consumer/display hunks to I24, with independent exact review.

## Reusable lesson

Provider prompt caching, the Fast Mode speed button and DEMO decision replay are
three distinct facts; preserve their raw evidence and never infer one from the
other's label or incomplete denominator.
