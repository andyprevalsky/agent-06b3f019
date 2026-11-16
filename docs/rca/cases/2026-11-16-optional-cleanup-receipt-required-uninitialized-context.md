---
id: 2026-11-16-optional-cleanup-receipt-required-uninitialized-context
date: 2026-11-16
title: Optional cleanup receipt generation dereferences uninitialized artifact context
surface: harness
component: blackbox-cleanup-receipt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup reads ARTIFACT_DIR under set-u even when its existing process-only caller supplies no artifact context
symptoms:
  - 'ARTIFACT_DIR: unbound variable'
  - 'blackbox-backend-process-tree.test.ts'
  - 'threshold failed on partial coverage: inconclusive'
tags:
  - deploy
  - cleanup
  - optional-artifacts
  - process-tree
sources:
  - PR #2404
  - commit edb308dfecccee537ffe7e03bf4d4308eca7dc51
repro: back-end/src/tests/unit/blackbox-backend-process-tree.test.ts
status: open
---

## Problem

Final native backend gate on edb308df passed all283blackboxdomains, including
the original caller-root archive assertion in488ms, but failed1/466unitfiles.
The existing process-tree unit invokes cleanup without artifact context; new
optional receipt code exits1 on ARTIFACT_DIR under set-u after stopping its
owned backend tree. Native unit1939ms and exact error remain preserved.
The coverage threshold is separately UNVERIFIED because this unit failure
leaves partial coverage, not because a lower threshold is justified.

## Diagnosis

Gate INTRODUCED by the new optional cleanup-record writer. Core teardown
supports the existing process-only caller; reporting was accidentally coupled
to artifact initialization. This is independent of the Node producer test's
hoisted-package failure and the earlier NOT_INTRODUCED capability timeout.
No provider outage, credit waiver or assertion change resolves this failure.
Archive searches and actual reads include Sept10 missing controller-bootstrap
fixtures and Sept11 inherited cleanup ownership. Their required ownership
context must not be defaulted; this candidate changes only optional reporting
context, and independent review is checking that distinction.

The unchanged existing unit reproduces the exact native unbound-variable error
against a private copy of edb's runner (exit1,1.81s), then passes against the
guarded copy (exit0,4.81s). It uses real owned child processes and existing
birth/token checks; foreign processes remain untouched. No DB/provider/model
operations occur. Five unchanged private guard runs passed; defined artifact
context still emits identical runId/backendTreeCleaned/sandbox fields.

## Solution

Guard optional receipt destination reads on ARTIFACT_DIR, and optional JSON
generation on both ARTIFACT_DIR and RUN_ID. Core teardown and original exit
status remain; missing proof still cannot qualify a complete native result.
No fake default path/identity, suppressed error, changed process budget or
weakened ownership/coverage assertion. Mandatory harness review is
cleanup-context-1; canonical application occurred after quiescence; native qualification remains pending.

Production agent behavior and10000-agent runtime cost are unchanged. The
existing provider verification bound/query count is unchanged.

## Human feedback

None recorded.

## Reusable lesson

Keep optional diagnostics conditional on initialized context while making core owned cleanup independent of that context.
