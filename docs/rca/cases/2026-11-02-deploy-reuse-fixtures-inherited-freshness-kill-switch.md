---
id: 2026-11-02-deploy-reuse-fixtures-inherited-freshness-kill-switch
date: 2026-11-02
title: Staged worker freshness policy leaked into reuse regression fixtures
surface: harness
component: deploy-test-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Staged deploy worker supplies DEPLOY_LANE_SCOPED_REUSE=0 to structural tests whose private reuse fixtures retain that ambient kill switch
symptoms:
  - FAIL: backend-coverage-blackbox did not disclose the missing prior pass
  - assert receipt["lane_scoped_reuse"] is True and receipt["reused_scoped_lanes"] == []
  - failed deploy structural gates: deploy-stage, deploy-pipeline
tags:
  - deploy
  - fixture-isolation
  - environment
sources:
  - PR #1662
  - commit 067495d51582f3946d5a5b980ccc8416b66dff02
  - commit 6d297d9d5
  - agent ph74rbq7e6nbbbr6xmrp2vy7p98hfdwd
repro: scripts/tests/run-deploy-stage.test.sh and scripts/tests/run-deploy-pipeline.test.py check_lane_scoped_reuse under the native worker environment
status: open
---

## Problem

Occurrence 2eb8a9f65eab4bfdac73050308908336 records the structural aggregate as UNVERIFIED with native exit 1. The full native log, SHA256 4b80c5b32006cc1496bc63428cdaaea521a2012b9fef8b7c7acde00c4298322f, identifies exactly two failing top-level jobs: deploy-stage and deploy-pipeline. The nested intentional failure text under passing jobs is not an additional top-level failure.

## Diagnosis

Gate: INTRODUCED. Compared baseline origin/main 6f3f53201faac3a3e70de099e7c211cee6770fad with frozen 067495d51582f3946d5a5b980ccc8416b66dff02 / digest b903608660c4e2a99a9025b2968240d9d908137d405c0479ff385de092031da1. Commit 6d297d9d5 adds the worker and forced DEPLOY_LANE_SCOPED_REUSE=0. The native request explicitly contains that value. The worker run_step passes it to the command; structural gate_environment copies it. Both reuse fixtures retain it while deliberately requesting scoped reuse. The stage predicate and pipeline predicate correctly reject the request under that kill switch. Native retained stage evidence confirms detail.reuse.requested=false despite the test's --lane-scoped-reuse flag. No child environment snapshot exists; this limitation does not replace the native request, frozen code, retained receipt and controlled replay.

The local command python3 /var/tmp/rca-2eb8-pj7l_uk3/proof.py candidate worker before actually runs the unchanged worker run_step around two narrowed probes: the stage script through its original first scoped-pass loop, and the entire original check_lane_scoped_reuse function with main's actual env initializer. It fails at the exact observed assertions: stage exit 1 in 1.486s, pipeline exit 1 in 0.803s. After only fixture-environment resets, the identical command with an output-label argument after passed: stage exit 0 in 1.908s and pipeline exit 0 in 6.702s. Baseline main direct focused controls passed in 1.975s and 6.692s. These are causal probes, not full-gate passes. Full gate reruns remain the parent's responsibility.

Archive searches: did not disclose the missing prior pass; inherited environment fixture reuse fresh deploy. Related to 2026-10-28-campaign-capacity-fixture-inherited-provider-policy, not the same boundary/incident. The general problem is private fixture policy leaking from a real enclosing deployment. Golden reference: not applicable (ordinary test-fixture changes).

## Solution

Draft fix.patch resets only DEPLOY_LANE_SCOPED_REUSE at the entry of run-deploy-stage.test.sh and excludes that one variable from run-deploy-pipeline.test.py's existing fixture env construction. It preserves the worker freshness flags, production reuse implementation, all assertions/budgets and explicit kill-switch control cases. The full pipeline scoped-reuse function passed, including its lane-specific kill switch. The stage probe only covers the first scoped-pass loop; the full stage suite remains pending. No application source was changed. This case remains open until the parent applies/reviews the patch and completes the original gates. No provider exception or delegation waiver applies. At 10k agents there is no runtime behavior or resource effect; this is isolated test setup.

## Human feedback

The user limited this delegate to evidence collection, private reproduction and an exact draft fix; deployment and application source remain parent-owned. The user forbids waived assertions, timing budgets and unknown work, and requires Freedom to remain protected.

## Reusable lesson

Reset enclosing deployment policy at private test-fixture boundaries while preserving explicit policy control cases and the real worker contract.
