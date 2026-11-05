---
id: 2026-11-05-private-source-fixture-boundary-drift
date: 2026-11-05
title: Fixture slices drifted when source freezing moved before warm admission
surface: harness
component: cloudbench-private-source-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: _private_source_preflight_fixture searched for the workspace freeze marker after warm-source resolution
symptoms:
  - ValueError substring not found
  - fleet.index("# Freeze one workspace patch", start)
  - benchmark-live-results[1/6] failed three recovery controls
  - bash line 40 PROVISION_POOL unbound variable
tags:
  - cloudbench
  - fixture
  - source-freeze
  - extraction
sources:
  - commit ecf8f02bf9
  - commit 9dccd611b2d067139a4a379ecc2f5fc46006265d
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_consumes_runtime_receipt_after_partial_primary_retirement
status: open
---

## Problem

Round 14 deploy-command-structural on frozen 9dccd611b2 failed benchmark-live-results[1/6]: three failed, 187 passed, one existing skip, 2191 deselected. The partial-primary-retirement True control and wrong-app/wrong-worker-source negative controls raised ValueError in fixture construction, before their recovery assertions. Original evidence remains in canonical .context/cli-nov05-cycle/attempts/14/needs-focused-plan/deploy-command-structural/result.json.

## Diagnosis

Gate: INTRODUCED. Comparing ecf8f02bf9 with its parent proves that the preallocation repair moved the freeze block from after warm-source resolution to before it. The fixture still searched for that marker after its start offset. Source text enters the fixture slicer, which raises before the stubbed admission script or recovery assertions execute. The runtime ordering is intentional; no production bug is established.

The isolated clone starts at exact 9dccd611b2. The unchanged pytest selection for exact_recovery_consumes_runtime_receipt_after_partial_primary_retirement or exact_recovery_consumes_runtime_receipt_rejects_unsafe_retired_mapping reproduced all 15 parameterized failures in 23.10 seconds. The identical command passed all 15 after changing only the extraction end boundary. Logs live in .context/fixture-extraction/before.log and after.log in the isolated repair clone.

Archive searches used substring-not-found/freeze/workspace-patch and fixture-extraction/source-marker-drift vocabulary. The October 6 seed-preflight extraction case is a relative, not this same boundary. The September 11 warm-refresh workspace-patch case explains why source freeze must remain before maintenance. The deepest proven owned cause is coupling a fixture region to an unrelated movable block instead of its adjacent semantic boundary. Other fixture extraction sites were inspected; this is the only search for the moved freeze marker.

## Solution

End the real warm-source admission slice at the adjacent dependency-preflight section. Existing helper extraction still supplies the actual dependency functions, and the fixture still calls warm_deps_preflight. Delete the dependency on the unrelated freeze block rather than add a fallback or change runtime order. All existing test functions, assertions, negative controls and timeouts remain byte-for-byte unchanged except the fixture extraction expression. The actual runtime source-freeze integration is covered by the unchanged refresh_deps_applies_exact_workspace_before_rebuild family.

The original tests remain registered through scripts/tests/benchmark-live-results.test.py and the existing six-shard structural gate. All 186 private-source/dependency/source-freeze controls and all 13 additional transitive helper-consumer controls passed. The identical recovery selection passed 15 controls. The identical registered shard DEPLOY_GATE_SHARD=1/6 python3 scripts/tests/benchmark-live-results.test.py completed: 190 passed, 1 skipped, 2191 deselected in 147.95s (0:02:27). Full logs are recorded in the isolated .context/fixture-extraction report. A first unprovisioned-clone shard run resolved the original failures but reported missing installed Node trees; its four failures and one setup error remain retained separately. Existing installed dependency trees were then linked into the isolated clone before repeating the unchanged shard. No live benchmark, provider, payment, database, runtime or worker mutation is part of this repair. Golden reference: not applicable (no approval-gated hunk). This fixture-only change adds no per-agent runtime work at any scale. Status remains open until the parent completes validation and integration; isolated passes grant no deploy readiness or waiver.

### Controller fixture recurrence on the same frozen source

The round-14 cloudbench-controller selected pytest run on 9dccd611b2 reported one failure and 517 passes in 361.42 seconds: test_fleet_patch_packages_clean_unpushed_head_from_fetchable_base aborted with bash line 40 PROVISION_POOL unbound variable. Its exact log remains in the cloudbench-controller worker .context/cloudbench-local/run-ermmccdx/selected-pytest.log. The 11 other components and wallclock checks passed; no application or provider failure is inferred.

The isolated clone preserved commit 3540006663ae5dff27d11918c5202e275af6773d. On that source the identical owning selection reproduced one failure in 1.02 seconds. The sibling ledger-only clean-commit control independently failed the same way in 3.83 seconds. Both extracted from FLEET_PATCH_FILE initialization through the distant dependency-preflight section, so moving patch generation earlier also pulled in preallocation, environment, seed and warm-source startup. Runtime correctly initializes PROVISION_POOL at line 1089, before this path. Initializing only that variable in the fixture would merely expose more unrelated startup dependencies; runtime is not the first-bad boundary.

Gate: INTRODUCED, attributable to the same ecf8f02bf9 freeze reordering compared with its parent, not to 354000666's warm-source fixture repair. This is a sibling failure of the same extraction coupling, so it extends this case instead of creating another incident. Searches for PROVISION_POOL/unbound-variable and workspace-patch/fixture-extraction found this case and the September 10 omitted-bootstrap fixture case. That bootstrap case is a relative; this fixture should exclude unrelated startup rather than simulate its full initialization.

The followup changes only fixture extraction. One shared _fleet_workspace_patch_setup selects the actual complete patch creation/fingerprint region and ends before the adjacent native preallocation conditional. Both executable consumers and the structural patch-disabled consumer use it. The complete real patch block is preserved; no controller, guard, recipe, assertion, negative control or deadline is changed. The identical original selection passed one test in 3.35 seconds. All 39 patch/unpushed/source-freeze controls passed in 11.54 seconds, including clean unpublished source replay, ledger-only no-delta behavior, disabled/missing/staged payload controls and exact maintenance source integration. Exact commands and before/after logs are in isolated .context/patch-fixture/report.json. All 3680 assertions and 438 timeout expressions remain identical by AST comparison. The original selected test remains registered in deploy Step 4cb. The parent owns full controller/deploy validation after the active cohort is terminal; no duplicate full controller was launched. Status remains open.

## Human feedback

The user required an isolated plain clone, preservation of the runtime source freeze and every assertion/negative control/timeout, full owning helper coverage and the exact selected structural shard. The canonical cohort must remain untouched; no provider, DB, financial or Freedom actions are authorized.

## Reusable lesson

Extract fixture code using adjacent semantic boundaries rather than unrelated blocks whose execution order can legitimately change.
