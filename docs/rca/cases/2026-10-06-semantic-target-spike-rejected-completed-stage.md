---
id: 2026-10-06-semantic-target-spike-rejected-completed-stage
date: 2026-10-06
title: A completed semantic sample missed a reporting target and rejected the usable stage
surface: harness
component: front-end/tests-e2e/chat-lifecycle-latency.spec.ts
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: final per-sample toBeLessThan assertion treated the six-second reporting target as a hard functional rejection
symptoms:
  - web_search sample 3 exceeded the full-lifecycle ratchet
  - all twenty samples completed without missed milestones
  - completed lifecycle 12461ms exceeded6000ms
sources:
  - PR #1424
  - commit 93dea65a7a5b2f6ad0612838efedf8671101d011
tags:
  - semantic-gate
  - measurement
  - stage-end
repro: scripts/tests/semantic-deploy-gate.test.sh
status: open
---

## Problem

The original local semantic owner completed all twenty samples on one worker.
UI semantics passed eight of eight. Nineteen lifecycle samples were below six
seconds; web_search sample3 finished in12461ms with no missed milestones.
Its path had p50=2329ms and smoothness1.0. The suite returned EXIT1 solely at
its per-individual six-second assertion. This original failure and measurement
remain retained; no paid rerun or production result was rewritten.

## Diagnosis

Measured completed samples flowed into the final verification block, which
unconditionally rejected any lifecycle at or above6000ms. The user's current
contract explicitly makes such intermediate speed targets warnings and requires
usable functional stage endpoints and applicable whole-run bounds. That policy
mismatch is proven; the cause of the isolated12.46-second request remains
unattributed. This sequential observation does not establish slowdown caused by
fifty-way concurrency or any performance improvement.

Archive searches: `exceeded the full-lifecycle ratchet web_search` and
`completed lifecycle samples transient latency warning usable stage`.
The July20 Render-cutover, September9 search-excerpt and October2 renderer-stall
cases are relatives. Their production fixes remain intact. None proves the
cause of this sample; older advice to retry or preserve a hard ratchet does not
override the user's explicit current verification policy.

## Solution

Keep the same five samples per each of four paths, six-second reporting target,
p50/max/smoothness output, functional milestone assertions, uncaught-error
assertion, provider cooldown, warmup, browser clock and existing finally cleanup.
A completed target miss prints its actual duration and target as a warning.
Missing samples, missing functional milestones and uncaught errors still fail.
No product prompt, model, task definition, evaluator, execution limit or E2E
limit changes. The normal deploy guide describes this distinction.

The existing permanent semantic-deploy quick family extracts and executes the
actual final validation statements with deterministic sample inputs. Identical
four-control bytes against original93 produced3PASS/1FAIL in0.184s; the candidate
produced4PASS in0.197s. Missing-sample, missing-milestone and uncaught-error
inverses pass on both sources. The first setup used the slow sample in an
uncaught-error inverse and obscured that inverse with the old ratchet; it is
retained without causal credit. Corrected controls use fast samples for that
inverse. Both final native leaders were waited/reaped and ESRCH absent; their
process groups were empty. No browser, provider or model request was made.
The complete normal quick family and independent review remain pending.

## Human feedback

The user requires stage endpoints with generous overall bounds and rejects
microscopic intermediate cancellation criteria. For the new LIVE goal, temporary
execution1200s and image-start through final native release3600s remain hard.
Task FAIL is honest data; missing terminal state, functional errors or leaks
remain failures. Do not rerun a paid measurement until it looks fast.

## Reusable lesson

Preserve measured target misses as warnings when the authorized contract gates
functional stage completion and whole-run limits. Keep functional inverses.
