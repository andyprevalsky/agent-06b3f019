---
id: 2026-10-27-webgl-red-pixels-missing-failed-frame-evidence
date: 2026-10-27
title: Sandbox WebGL red-pixel failure lacks the original frame evidence
surface: back-end
component: agent-tools-render-fixture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: the original pixel predicate measured zero red after readiness; no failed PNG or browser phase evidence was retained to identify the rendering boundary
symptoms:
  - "render: a three.js CDN page draws WebGL pixels in the sandboxed frame, isolated from Rose"
  - "WebGL cube pixels: 0.00% red"
  - "agent-tools 21 passed, 1 failed"
tags:
  - display-js
  - webgl
  - three-js
  - iframe
  - pixel-sampling
  - observation-gap
sources:
  - commit 88864ecde0a1d45bbf32cb1ab6c42ed10f9dde94
  - agent 01a17947-78f9-7ee2-b6b1-b01b12172923 deploy 20261027-010544-539506 batch7
repro: back-end/src/tests/blackbox/agent-tools-render.cases.ts
status: open
---

## Problem

On frozen88864ecde, agent-tools reported21passed/1failed: the three.js cube
sampled0.00%red pixels. Backend blackboxes reported229passed/1failed, unit exit0;
the native backend command exited1 after1146.1s. Dataset-ready, wasm-ready and
inline CSS checks passed before the pixel assertion. Later GLB23.1%red and JS
module25.0%red siblings passed.

## Diagnosis

The ordinary CDN fixture uses locally installed three unless explicit live-CDN
mode is enabled; no CDN outage is established. The original rotating animation
signals ready after three renders and the fixture then waits300ms before sampling.
No original PNG/DOM/browser console/response trace or browser PID was retained.
Consequently readiness, module execution, drawing and screenshot colour sampling
cannot be distinguished as the first bad cause. The unchanged successful control
also emitted ReadPixels GPU-stall warnings; those warnings alone are not causal.

## Solution

No production/test fix or threshold change is proposed. One scoped native
owning case passed in1346ms with24.0234%red pixels and all four isolation checks;
full native setup took15.845s. This is a baseline, not a repair. Its exact-owned DB
was created/dropped, launcher joined and port47463 closed. Original fraction0.04,
red-channel ratio1.8 and existing waits/assertions remain unchanged.

An opt-in next-full-gate observer is prepared and syntax-checked, not qualified by
a second native run. Evidence: .context/deploy-fresh-20261027/rca-webgl-batch7/.
The existing original backend artifact is
.context/test-runs/backend-coverage-failed-20261027-183108-441431/.

## Human feedback

None recorded for this incident. The snapshot-scoped approval and unchanged
behavior requirements above come from repository/coordinator instructions, not
new user feedback.

## Reusable lesson

Preserve the actual failed browser frame and phase evidence before blaming a zero-pixel result on the GPU, network or readiness.

## October 29 renewed investigation — U2 failed-frame evidence

The original failed PNG and context lifecycle were not retained. A real local
context-loss control produces the same zero-red result after readiness, while
an unchanged healthy owning case passes. This demonstrates ambiguity; it does
not establish historical context loss or attribute the original failure.

A private capture proposal retains the already measured failed PNG, pixel
ratio, threshold and hash in private files. The registered capture control
fails with capture disabled and passes with the proposal. Under deliberate
context loss the original pixel assertion still fails, and the exact measured
1977-byte PNG is retained. All 16 existing assertion ASTs, case names and waits
are preserved. Independent review accepts exact patch
`acd27481c3ad0389f6d8fb3295538299141a340f3c9c4f779647ae2c2cb06e5a`
for capture only; canonical source is unchanged. Historical U2 remains OPEN.
Evidence: plan:.context/unresolved-six-20261029/webgl-process/U2-REPORT.md.

## PR1663 recurrence, 2026-11-02

The unchanged full backend coverage invocation on 79edd36b9a0231f74cfd0b492f10c13b9008e686
reported the original cube assertion `WebGL cube pixels: 0.00% red` (agent-tools
23 PASS/1 FAIL). GLB and module pixel checks passed. The exact failed PNG was
not retained, so this signature does not establish the historical cause or
justify a speculative renderer change. Gate: NOT_INTRODUCED: the entire owning
render fixture and runtime tree were unchanged from main9152.

A high/standard subordinate investigation retained the original native failure,
then tested actual context loss through the same pixel predicate: 0% red,
1977-byte PNG SHA256 bb97576eb15708a54de22113d8e8bdd84a820103aeb3d509bda11008965ed0c2,
with ready/wasm-ready and actual context-lost evidence. Healthy uninjected
samples passed at about24% red with no lost context. ReadPixels warnings also
occurred in healthy samples; stopping future animation frames after readiness
still passed. These distinguish possible boundaries; none reconstructs the
original failed frame or proves a rendering fix.

PR1663 integrates the previously independently reviewed capture-only patch.
It retains the exact already-measured failed PNG and hash/threshold receipt
under the runner's private artifact directory before the unchanged assertion.
All original predicates, names and 300/400ms waits remain. A registered real
context-loss control verifies exact-byte retention and that failed rendering
continues to fail the original pixel predicate; disabling retention makes that
control fail. No context recovery, screenshot retry, new readiness wait or
renderer setting is introduced. This is evidence custody, not a runtime repair.
The original full command must still pass on its own native result.
