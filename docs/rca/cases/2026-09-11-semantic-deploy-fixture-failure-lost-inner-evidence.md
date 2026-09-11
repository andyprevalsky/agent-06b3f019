---
id: 2026-09-11-semantic-deploy-fixture-failure-lost-inner-evidence
date: 2026-09-11
title: Semantic deploy structural failure lost the inner fleet fixture evidence
surface: harness
component: fleet-infra-stability-proof-structural-test
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: the agent-status fleet fixture returned nonzero but its inner log and cleanup receipts were deleted
symptoms:
  - evaluated agent lifecycle states were classified as infrastructure
  - semantic-deploy fails in the concurrent structural gate while the isolated enclosing fixture passes
tags:
  - semantic-deploy
  - fleet-proof
  - fixture
  - observability
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: open
---

## Problem

The full parallel structural gate's semantic-deploy entry exited 1 after
13.45 seconds. Its final message was `evaluated agent lifecycle states were
classified as infrastructure`. The wrapper reaches
`descend-command.test.sh`, which invokes the enclosing fleet proof test.
That test redirected this fixture's command into `agent-status.log` and
deleted the entire temporary directory on EXIT. The main retained gate log
therefore contains the assertion description, not the underlying failure.

## Diagnosis

The fixture supplies PASSED/FAILED evaluator outcomes and separate ACTIVE/PAUSED
agent lifecycle states. It does not supply SKIPPED. The assertion could fail
because the child command returned nonzero at several boundaries; its wording
alone does not establish a classification defect.

The unchanged enclosing native fleet proof fixture passed, including all 14
cleanup tests, after adding failure retention. This isolated pass excludes a
deterministic reproduction in that attempt. It does not establish why the
concurrent gate failed. No original inner command log, summary or cleanup audit
survived to locate that boundary.

Archive searches used `evaluated agent lifecycle states classified
infrastructure semantic deploy fixture` and `worktree service port still
occupied lsof kill-services`. The adjacent port assertion and orphan fixture
defects have separate reproductions; neither proves the cause of this failure.
The remaining requirement is a recurrence under the owning concurrent gate
with its inner fixture evidence retained.

Original output is retained at
`.context/acceptance/archive-batch-static.log`; the isolated pass is at
`.context/acceptance/static-gate-followup-rca/fleet-proof-unchanged-native.log`.
No further runtime repair is supported by this evidence.

## Solution

Retain the failing fleet fixture's temporary directory beneath
`BLACKBOX_TEST_ARTIFACT_DIR`, falling back to `.context/test-runs`, before
cleanup. Use a private suite/timestamp/PID directory, make capture best effort
and preserve the original failing exit status. The next committed enclosing
parallel static gate is the outcome check. Classification behavior, SKIPPED
rejection, task criteria and timeouts are unchanged.

## Human feedback

The deploy instructions require preserving the existing acceptance criteria.
Review explicitly rejected inferring a SKIPPED-related defect from the generic
assertion message or treating an isolated pass as proof of the original cause.

## Reusable lesson

Retain the failing child command's logs and lifecycle receipts before assigning a cause from its wrapper assertion.
