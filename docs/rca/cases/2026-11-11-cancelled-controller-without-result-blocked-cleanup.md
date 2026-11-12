---
id: 2026-11-11-cancelled-controller-without-result-blocked-cleanup
date: 2026-11-11
title: A cancelled hermetic GitHub controller had no native result for cleanup reconciliation
surface: harness
component: deploy-test-github-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: GitHub terminal cleanup required result.json even when cancellation ended the controller before it could write that file
symptoms:
  - "GitHub cleanup: artifact controls"
  - "worker result identity/inventory mismatch"
tags:
  - cancellation
  - controller-cleanup
  - incomplete-native-result
sources:
  - plan: PR1915 controller request 2e817fe514724f9c9eb2ecbfe8954024
  - plan: GitHub run42952207187 artifact13825234296 and authenticated terminal job130298880543
repro: Run scripts/tests/deploy-test-github.test.py GitHubTerminalCleanup with the cancelled missing-result controller fixture
status: mitigated
---

## Problem

A required controller was deliberately cancelled before cloud smoke admission
to preserve the user's no-new-paid-card instruction. The original local
supervisor joined its child, and GitHub completed the cancelled ephemeral job,
released dependency mounts and published its evidence. The artifact contained
the exact request, timing and complete bundle, but no native result file.
The normal cleanup certificate therefore rejected `artifact controls` and
kept the owner held, preventing the required unchanged reexecution.

## Diagnosis

Cleanup proof and test completion were coupled: the result-bearing path
required a native cleanup flag even after the hermetic worker VM was gone.
The original request, adapter, receipt and local wait records bind the same
source, request token and original GitHub run. Authenticated job metadata
proves final runner completion. All 655 bundle files, totaling 18,363,396
bytes, match the server-bound artifact manifest. This proves cleanup only;
it supplies no test verdict or missing native result.

## Solution

A missing-result artifact can now certify only the exact source-bound
cloudbench-controller hermetic fixture recipe. The certificate retains all
original request, source, tag, attempt, runner, local wait and artifact digest
checks, and additionally requires the cancelled gate plus successful evidence
bundle, mount release, artifact upload, post-mount and final runner/job steps.
Every captured bundle member is checked against its manifest. The original
full gate contract is retained and hash-bound to the original native receipt
so later current-source/input renewal cannot resurrect an already closed
owner. This retained contract grants no current execution credit. Semantic,
CodeAgent, cloud smoke, financial and other external-resource gates remain
ineligible. The ordinary native-result path remains strict.

Reconciliation grants zero execution credit and leaves the original
UNVERIFIED verdict, exit, cancellation, incomplete flag, case inventory and
attempt bytes intact. The normal reexecute transition then routes the same
required controller for a fresh native run; it does not adopt a PASS.

## Validation

The initial twelve-test correction review passed; an additional real
source-renewal counterexample then showed the original owner reappearing.
The same added renewal regression failed before retaining its original
contract and passed after; the full seventy-four transport tests passed.

The initial added owning regression failed with the original artifact-controls
error and passed with the correction; the twelve focused cleanup tests include
prior result-bearing controls and negative foreign-gate, recipe, owner,
nonterminal job, runner, process and malformed-artifact cases. Offline replay
of the original authenticated artifact reproduces refusal before and accepts
only cleanup afterward. Parent integration runs the permanent tests-first
regression and full transport suite, then freshly authenticates the original
run before applying its normal certificate. No paid task was admitted.

## Human feedback

The standing native user instruction forbids new paid AgentCard creation or
reclaim. This required withholding cloud admission; it did not authorize
fabricating a failed result, skipping the controller or granting cleanup
from an agent assertion.

## Reusable lesson

A stopped hermetic worker and a completed test are different facts. A narrowly
bound cleanup-only certificate can release custody for a required rerun while
preserving the original missing-result verdict and granting zero test credit.
