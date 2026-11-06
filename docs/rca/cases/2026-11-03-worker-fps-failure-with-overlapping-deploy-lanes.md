---
id: 2026-11-03-worker-fps-failure-with-overlapping-deploy-lanes
date: 2026-11-03
title: Shipped particles-worker example failed FPS budgets during overlapping deploy work with cause unproven
surface: harness
component: backend-browser-fps-probe
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: particles-worker frame-rate verdict was below unchanged FPS budgets; renderer scheduling cause is unproven
symptoms:
  - "particles-worker: fps-p50 value 30, minimum 55"
  - "fps-p5 value 20, minimum 30; worst frame 100 ms"
  - check --examples passes every shipped example
  - rose-ui-cli-browser.test.ts failed in backend coverage
tags:
  - fps
  - chromium
  - contention
  - observability
sources:
  - PR #1664
  - commit 61c3f876ee37d6b52a29c6d870d9459a90a33307
repro: back-end/src/tests/unit/rose-ui-cli-browser.test.ts
status: open
---

## Problem

The first full backend coverage attempt passed all 356 ordinary unit files,
then the separate browser probe passed five of six tests and failed the shipped
examples check. particles-worker reported p50 30fps below 55 and p5 20fps below
30, with worst frame 100ms. This was an FPS verdict, not a timeout. The native
probe duration was 121.589s, approximately 04:22:09–04:24:10 UTC November 3.

## Diagnosis

Backend product and test source were unchanged from main. Independent local
semantic/build work and native controller fixtures overlapped the probe. Four
semantic browser workers ran on eight CPUs; host load1 rose from 2.31 at probe
start to 15.38 at failure. These observations do not establish which process
caused renderer delay or exclude example defects or nondeterminism. No causal
per-frame scheduler trace was captured.

Searches for particles-worker/fps-p50/fps-p5 and host contention found no exact
case. The October 26 rose-ui-long-task-judged-host-inflated-wall-time case is
related: its first bad boundary was long-task wall-time evaluation, whereas
this incident fails frame-rate budgets. Its fixed status is unchanged. This
case stays open until controlled causal proof establishes the producer.

## Solution

No speculative product patch or threshold relaxation was made. The existing
full failed-first backend retry preserved both shards, all unit files, the
late browser probe, merged coverage thresholds and teardown. Other healthy
lanes finished before the late probe; timestamped process/load observations
were retained. The terminal native outcome belongs in the deploy receipts.
An observed passing unchanged retry establishes that execution's pass, not a
contention fix or deterministic causal RCA. Retain the first failed probe and
its source, clock bounds and native metrics even if a later invocation passes.

Private artifacts under mobile-pwa-fixture-repair preserve backend-first-attempt,
probe-resource-observations.jsonl, the independent gate review, and full retry
logs. Golden reference and 10k-agent runtime impact: not applicable; no runtime
code was changed. The missing causal trace remains explicit rather than being
reported as fixed by a green retry.

## Human feedback

The user required actual backend, local semantic and remaining gate outcomes,
with original failures and bounds preserved. The capacity error during the
parent turn was a provider failure, not a test outcome or task completion.

## Reusable lesson

Preserve a failed frame-rate verdict and capture renderer-level causal evidence before attributing it to overlapping host work or changing performance acceptance.
