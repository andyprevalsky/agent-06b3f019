---
id: 2026-10-16-world-clock-decoder-dereferenced-nonobject-json
date: 2026-10-16
title: World clock decoder dereferenced valid nonobject JSON
surface: agents
component: world-model-runtime-clock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: world_time_ms called snapshot.get after JSON decoding without validating the top-level object shape
symptoms:
  - "AttributeError: 'list' object has no attribute 'get'"
  - world_time_ms raises for valid JSON null or scalar clock responses
tags:
  - wmh
  - clock
  - json-decoding
  - response-shape
sources:
  - PR #1453 comment 4290940143 review 5543091722
  - commit f204831d1b8bfe8197b617901f5126964ec34740
  - plan:/dev/shm/rose-whm-deploy-gates-20261015/task-private/c2-rca-clock-shape-01a136f6/result.private.json
repro: agents/tests/blackbox/world_model_harness.blackbox.py
status: open
---

## Problem

C2 review identified an unchecked decoder shape. No actual production malformed response is claimed. The actual async world_time_ms, actual fast-mode resolution call boundary and HTTPX MockTransport reproduced AttributeError for an HTTP200 body containing valid JSON []. This happened after JSON parsing, outside the caught HTTPError/ValueError boundary, instead of the existing unavailable result None.

## Diagnosis

Successful JSON decoding does not imply a mapping. Lists, null and scalars all reach snapshot.get. The first bad boundary is the clock response decoder, not model behavior or clock-source selection. The fix is a top-level shape guard, not a real-UTC fallback, routing change or planner date-authority change.

Two searches used world_time_ms/AttributeError/snapshot.get and clock/malformed JSON/nonobject/unavailable vocabulary. Hits about archive HEAD fixture drift and rejected provider capture have different owners and causes; no same-boundary recurrence was found by literal world_time_ms/shared_time_ms search. Golden reference claude-code-src/src/utils/cronTasks.ts:102-105 checks parsed JSON object shape and nested array shape before dereference; computerUse/computerUseLock.ts:34-35 rejects nonobjects at its decoder. The proposed guard converges on validating decoded structure before field access. Other reference checkout paths were absent; no network sync was performed.

## Solution

The two-line repair returns the existing None-unavailable result when snapshot is not a dict. The resolver, HTTP client/options, URL, source authority, per-agent priority, integer tests, caller None behavior, nested agents behavior and shared/start fallback expression remain byte-for-byte unchanged. The held invalid pinned-date -> real-UTC proposal remains unapplied.

The new callback is explicitly registered in the existing world_model_harness blackbox. It tests lists/null/scalars, positive/negative/zero per-agent integer times, negative shared time, start zero and exact scope URL/resolver use. The same selected three owning callbacks run against actual baseline/candidate modules through HTTPX MockTransport with sockets and DNS denied. Existing long-poll/shared-clock and ordinary time-reader callbacks pass on both. Baseline exit1 (0.732s) includes the literal list AttributeError; candidate exit0 (0.794s) passes all three callbacks. No native/provider/model/DB call occurred.

Related boundaries were observed separately and deliberately not changed: agents:17 raises TypeError on iteration; shared_time_ms:0 with start_ms:1000 returns1000, and shared zero without start returnsNone. Both behaviors remain identical before/after the core guard. These are real local decoder observations, not proof of an actual runtime response or permission to choose new clock authority. A separate root decision is needed before broadening nested-shape/fallback semantics; no optional fix is silently included.

The reviewed repair is applied locally and the registered owning controls pass. Status remains open pending normal final-source deployment gates. No historical benchmark/fundraising/provider or production-success claim follows from the mocked decoder proof.

## Human feedback

The user authorized the nonobject decoder repair under the existing None-unavailable contract and required actual HTTPX MockTransport/fast-mode resolution controls. No new real-UTC fallback, clock authority, context/prompt/schema/model or routing changes are authorized. Related nested/zero behavior must be reported faithfully and not silently changed. Root alone applies after terminal and authenticated preservation.

## Reusable lesson

Validate a decoded clock payload's object shape before dereferencing it, without changing the established clock-source or unavailable contract.
