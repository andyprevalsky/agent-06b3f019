---
id: 2026-10-05-deploy-stage-fixture-terminal-status
date: 2026-10-05
title: Deploy lifecycle fixture expected an obsolete terminal spelling
surface: harness
component: deploy-command-fixtures
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the test accepted finished while finalize_run publishes completed
symptoms:
  - "finish did not close stage admission"
  - finishing|finished
tags:
  - deploy
  - fixture
  - verification
sources:
  - commit 7695d9bd9819c6c8bf3d87ce9c039e3c5535a5a4
repro: scripts/tests/run-deploy-stage.test.sh
status: fixed
---

## Problem

The requested fresh deploy gates exposed this fixture defect. Original failed
receipts remain private under `.context/deploy-runs/pr1410-finalize-20261005/`.
They do not receive successful deployment or fleet acceptance credit.

## Diagnosis

The fresh gate rejected lifecycle finish. The actual producer publishes
completed, but the fixture only accepted finishing or finished; observing the
fast terminal transition therefore rejected a correctly closed admission.
Original inner state was deleted, so its exact sampled state is unavailable.

Archive searches covered fixture host deadlines, simulated review clocks, and
finish/admission state. Similar observer and discarded-inner-evidence cases
were leads; they do not establish this incident's cause.

## Solution

Accept the actual completed terminal state, and hold the admitted fixture job
behind a release marker until admission closure is observed. Assert positive
admission, late-stage rejection, both successful exits, recorded stage completion,
and finish ordering. Retain failed fixture scratch privately, and signal only
jobs still present in the fixture shell's running-job table. A mixed-input run
where this file was edited during execution is retained as rejected evidence,
not classified as a current-source parser defect.

The canonical command and owning controls are rerun with unchanged semantic
outcome assertions. Product runtime, prompts, evaluators, benchmark definitions,
7200-second normal backstops, and existing 100/50-task evidence are unaffected.
There is no product cost at 10,000 agents. Independent adversarial review checks
actual private failed/green receipts and fixture cleanup ownership.

## Human feedback

The user requested liberal infrastructure observation budgets, compact permanent
deploy regression coverage, and preservation of completed fleet evidence.

## Reusable lesson

Verify the owned outcome with deterministic scenario inputs and generous host observation guards.
