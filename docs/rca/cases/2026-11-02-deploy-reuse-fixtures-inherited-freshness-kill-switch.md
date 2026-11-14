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


## Recurrence — standalone cloud fixtures inherited enclosing custody requests (2026-11-08)

On frozen dcc2ff37e6be5593036be6dbafdb092d4a1d6be8, round54's deploy-test-worker job ran 164 tests and returned eight errors in Cloud and CloudCampaign. Each reached the real historical admission guard and raised `historical custody: missing request-owned custody locator`. The parent preserved original.log SHA256 0f613676aeec7f4eca09ce68e6b19b703b1e1b5e44dc872bb005d33e8114374a. These fixtures intentionally construct standalone temporary requests without a coordinator cycle, but retained DEPLOY_GATE_REQUEST pointing at the enclosing structural worker's real round54 request.

Gate: INTRODUCED relative to 51d5f899: c4d02886ffb introduced the correct request-owned historical custody admission check. The private Cloud fixture did not isolate its request context. Gate: NOT_INTRODUCED by the recent 5809574-to-dcc integration: both the guard and Cloud.setUp AST are unchanged over that range. This is the same private-fixture/enclosing-deploy environment mismatch as the original case, now at a different mandatory admission boundary; it is not evidence that the real custody guard should be relaxed.

The exact current Cloud and CloudCampaign classes under the captured allowlisted outer environment reproduced all eight errors: 28 tests failed in 4.338s. The identical command after the fixture-only change passed, now including an added negative control: 29 tests passed in 5.259s. Cloud.setUp temporarily removes only DEPLOY_GATE_REQUEST and DEPLOY_GATE_RESULT for its disposable direct calls and restores the caller environment through unittest cleanup. All other environment, including the Kernel custody preload and strict0 policy, remains inherited. The regression invokes real admission and proves that an enclosing owned request without its custody locator still fails. No production function, original assertion, deadline, native receipt or resource policy changes.

The full owning suite result is recorded in the same repair receipt; it is not a full structural-gate result. The original round54 failure remains retained. No provider, financial, database, service or production action was performed. All old cloud and financial obligations remain unchanged. Archive searches used `missing request-owned custody locator` and `fixture inherited deploy environment`. Golden reference: not applicable (test-fixture setup only).

Parent instructions required a private candidate, unchanged assertions and deadlines, the exact native failure reproduced first, and parent-owned integration after active consumers terminate. This assignment does not authorize a second deploy or mutation of canonical source. The case remains open pending independent review and combined-source native validation.


### Additional round54 occurrence — three direct cycle/relay admission fixtures

The same enclosing structural worker later ran the original deploy-test-cycle command: 353 tests, three errors in 151.916s. The retained original-cycle.log SHA256 is 3a5f1e596b7d186e3afc5ffe75785c277f4aeeb6d6f459880e177bdf3eac3e81. The failing cases were Cycle.test_historical_custody_rejects_tampering_and_missing_admission_proof, Cycle.test_historical_import_cli_and_admission_keep_current_inventory and RelayStartupEvidence.test_native_adapter_requests_owned_supervision. This is another occurrence at the same request-owned locator boundary, not a new exemption from custody or an additional deployment.

The unchanged three tests under the same captured outer environment reproduced all three exact errors in 10.135s. The identical command passed in 15.240s after the narrowly scoped fixture repair. The two Cycle cases now establish their own temporary cycle's request/result paths before building historical state and its child-environment seal; the real request-owned locator check therefore remains exercised. A foreign-cycle request path is additionally required to fail. Only the standalone extracted Relay adapter case removes enclosing request/result locators, with automatic restoration. No other Cycle setup or nested coordinator request environment changes. All existing custody, native source, tamper, runtime, cleanup and no-credit assertions remain. The full owning cycle command is recorded separately from the three-case causal proof; neither is a whole-registry PASS.

Parent instructions require retaining the already reviewed Cloud fixture repair, all original failed evidence, runtime guards, assertions and timeout bounds, and private candidate preparation only while canonical consumers run. The combined patch adds no production-code change, provider/DB action or native admission credit. Integration and combined-source gate validation remain parent-owned.
