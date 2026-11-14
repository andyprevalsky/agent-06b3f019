---
id: 2026-11-02-r152-current-menu-evidence-adjudication-gap
date: 2026-11-02
title: It38 current-menu evidence received different declared R3 verdicts
surface: harness
component: polar-evaluator-evidence
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Internal verifier accepted the captured menus fallback; declared R3 rejected currentness, with causal judge-input parity unproved
symptoms:
  - polar perfect-score failed (2/3 rubrics)
  - trajectory does not confirm use of current menu page
  - task_completed true and score 1 despite declared R3 failure
tags:
  - polar
  - evaluator
  - browser-evidence
  - current-menu
sources:
  - commit 1dc2af2f263dfaca575e24e7f3f788daace01f5c
  - fleet run 20261102-170252-3131808
  - agent 1e660ba7-2a6f-4095-856d-50a5a352743a
  - plan: It38 original r002-j0011 normal diagnostics and full-custody verification
repro: No causal reproduction or model-only replay performed; original evidence tracing only
status: open
---

## Problem

It38 task `polar-odysseys-2504a7886c3d`, original `r002-j0011`, completed
natively but failed its declared evaluator at 2/3 rubrics. R3 required using
Fat Choy World's current menu page to determine whether it was open. The
internal verifier accepted `/menus`; the declared evaluator rejected its
currentness. Original FAIL remains unchanged. The same task's first run received
a declared PASS; that does not invalidate either recorded outcome.

## Diagnosis

All seven supplied diagnostic snapshots matched their index hashes. Worker
SHA256 is `9df94c6572557b45f96220024f0e102e8e7432a186e4c9ef3816c58a60750acb`.
All 116 original `llm.context.dumped` payloads and five update payloads matched
their decompressed size/SHA. Parent later verified the complete failed archive
`567383c8c310aeedebd3aabb677562e8352def94956c181800fe8c67c0872198`
and run `517bb998a8eae8d455a013823024bdb1d9517c62c8ce74671ed56d8e2fb4c868`,
including original FAILED/controller1, normal7 and verified release audit.
That full-archive verification is parent evidence, not an independent full
archive read by this investigator.

Path: browser action/state → actor choice → internal verifier → completed
response → declared Polar verdict. Final internal verifier input at worker
line37671 has SHA
`f57a635f00a3c1940d35f641e968616b93da017a2812450ea2afac113f2fd008`.
It contains captured action-history step33 linking Menu to `/menu`, steps35/42
showing gambling page content, step102 showing `/menus` hours and Closed Monday,
step104 showing kids' items/desserts, and step107 listing separate brunch and
`/menus` tabs. Step98 independently reports Monday. These facts were not wholly
omitted from the internal verifier input. No claim of site compromise is
established merely by the returned gambling content.

Actor payloads at lines28525/30400/33777 acknowledge that `/menus` may be an
older partial menu; line37647 still attempts completion. Final verifier update
line37749, SHA
`658c915cc2e276145ca3d448ecb3658f2fd6e88955bf4c93b3b458c3806795db`,
sets `/menus`, open-now false, tab-open true, task_completed true and score1.
The declared R3 result instead states current-menu use was not confirmed.
Native completion at17:31:49.891 precedes shutdown at17:37:15.003;
cleanup is null and context violations empty. Earlier session errors were
followed by reconnect and successful evaluations. No unrecovered operational
stop condition is demonstrated by this packet.

The parent's first-run declared-result extract binds archive
`8d9d8b34627432879d09fb754b4f4015d95846b39ac88b76793c88974f567e70`
and run `063cbe10241ac364571935db014c7b7fca54e38232875dd6ebe9a93681387529`.
That R3 accepted working `/menus` despite a `/menu` redirect. Both declared
results report one screenshot, but neither screenshot identity nor identical
judge input is proved here. Differing adjudications alone do not prove an
evaluator bug or model-intelligence limitation.

Exact source hydrates `_semantic_evaluator_tree` into transient evaluator data
before calling Polar; its trajectory builder consumes that key. A missing
`logs.tree` in a persisted run cannot establish that the judge lacked child
evidence. Full transient input/screenshot parity remains unproved. The earliest
observed disagreement is acceptance of `/menus` as current-menu fulfillment;
no owned causal defect or deterministic RED/GREEN has been established.

Archive searches used `current menu page menus evaluator` and
`retained intermediate claim semantic acceptance evidence projection`, plus a
literal Fat Choy/current-menu scan. Solution and Human feedback were read in
`2026-10-17-last-served-page-substituted-for-browser-park-state` and
`2026-10-25-agentic-judge-evidence-stripped-sub-agent-task-complete-cards`.
They are related evidence-measurement lessons, not demonstrated recurrences.

## Solution

None implemented. Preserve both original outcomes and compare exact existing
judge inputs, screenshots and hydration provenance if available. Do not replace
currentness with URL resemblance, infer omitted evidence from persisted shape,
change the rubric, or claim benchmark repair from internal progress100.
No prompt, model, timeout, evaluator or runtime changes and no new provider,
browser or model calls were made. This is OPEN documentation, not a completed
RCA or a causal fix proposal.

## Human feedback

None specific to this case. The coordinator's evidence-only scope and
no-mutation constraints are recorded in Solution, not attributed to the user.

## Reusable lesson

Compare exact browser evidence and judge inputs before attributing different rubric verdicts to evidence loss or evaluator error.
