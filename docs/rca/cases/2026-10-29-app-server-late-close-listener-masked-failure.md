---
id: 2026-10-29-app-server-late-close-listener-masked-failure
date: 2026-10-29
title: Late child close listener masked the app-server test failure with cancellation
surface: harness
component: codex-app-server-tests
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: app-server.test.mjs registered child.once(close) in finally after the child had already closed
symptoms:
  - cancelledByParent
  - Promise resolution is still pending but the event loop has already resolved
tags:
  - codex
  - child-process
  - teardown
sources:
  - PR #1627
  - commit b81ef3af99857012771aa7b53bf84f7a9c00d6fd
repro: node --test e2b-templates/codex-code/app-server.test.mjs
status: open
---

## Problem

The b81 agents gate failed its Azure fallback test15 with cancellation after7222ms. Original source log is preserved in /var/tmp/deploy-1627/app-server-lifecycle-rca/original-gate.log. The precise server failure is unknown because teardown suppressed the primary assertion and logs.

## Diagnosis

The normal isolated test passes. With a deterministic local early-exit child seam, the identical original test reproduces cancelledByParent after7297ms. It reaches finally after its polling loops and assertion, kills an already-closed child, and waits for a close event that cannot recur. Both real-process tests share the late-listener pattern. It was already present in23c86fe06 before the current speed changes. This establishes a pre-existing teardown bug, not the cause of the historical server exit. Archive lead2026-10-28-codex-funded-fallback-billed-unfunded-openai-key covers Azure wiring, not this lifecycle boundary.

## Solution

Capture the child close Promise immediately at spawn and await that existing Promise in finally. Both existing sites corrected; no assertion, polling count, sleep or budget is changed. Add one owning-suite negative subprocess test: force the ws-server child to exit23, require the actual assertion and stderr, exit1, cancelled0 and absence of pending-eventloop cancellation. This prevents false green. Generated preload intercepts only local ws-server spawn; no provider calls.

Exact commands and module bindings are in /var/tmp/deploy-1627/app-server-lifecycle-rca/report.md and repeat.sh. Unchanged original Azure test with NODE_OPTIONS=--require=/var/tmp/deploy-1627/app-server-lifecycle-rca/exit-preload.cjs reproduces original cancellation (earlyexit-before.log); candidate emits assertion and childstderr (earlyexit-after.log), correctly still failing. Identical permanent negative regression fails on original cleanup (regression-before-sealed.log) and passes with candidate. All original15 plus new negative run five times on the candidate. Patch SHA256 854d8b16213c8fcee110ed20c5e9423eca590562a32287270a366d977e0fa412; source/candidate file hashes in manifest.json. Only temporary files changed.

OPEN: original server-exit cause remains unknown; this patch cannot prove the next full gate passes. Parent independent review, integration and unchanged full agents/deploy gates remain required. No provider defect or provider recovery is claimed. Golden review does not apply to ordinary test lifecycle changes.

## Human feedback

Parent required read-only frozen-source RCA, deterministic proof, unchanged budgets/assertions and no provider calls. User preserves Freedom. Original failing evidence must remain failed; no gate waived.

## Reusable lesson

Register child completion when acquiring the process, before any awaited work can let the completion event pass, so teardown preserves the primary failure.

## Recurrence: fixture journal masks early exit (October 30, PR1634)

The retained early-exit regression exposed a separate ordering issue after the
fallback test was refactored into `runOAuthFailureFixture`. The helper read its
journal before asserting the expected outcome. An injected startup exit never
creates that journal, so ENOENT hid the captured `fixture early exit 23` stderr.
The early close listener itself still worked: neither run reported cancellation.

Add the existing expected-outcome assertion with captured server logs immediately
before journal parsing. This adds four lines and changes no timeout, polling
count, existing assertion, or production behavior. If the expected outcome occurs
but the journal is missing, the original missing-journal error still surfaces.

In an isolated copy, the identical complete Node command failed with 23 passes
and 1 failure before, then passed all 24 tests after. The unchanged focused early-
exit test likewise failed before and passed after; both runs had zero cancelled
or skipped cases. Exact commands, original broad failure and before/after evidence
are in `.context/pr1634-codex-fixture-rca/report.txt`. The original historical
server-exit cause above remains unknown; this recurrence fixes only fixture
failure reporting. Full combined validation follows integration.
