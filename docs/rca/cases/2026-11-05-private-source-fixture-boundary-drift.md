---
id: 2026-11-05-private-source-fixture-boundary-drift
date: 2026-11-05
title: Private-source fixture sliced to a freeze marker moved before warm admission
surface: harness
component: cloudbench-private-source-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: _private_source_preflight_fixture searched for the workspace freeze marker after warm-source resolution
symptoms:
  - ValueError substring not found
  - fleet.index("# Freeze one workspace patch", start)
  - benchmark-live-results[1/6] failed three recovery controls
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

## Human feedback

The user required an isolated plain clone, preservation of the runtime source freeze and every assertion/negative control/timeout, full owning helper coverage and the exact selected structural shard. The canonical cohort must remain untouched; no provider, DB, financial or Freedom actions are authorized.

## Reusable lesson

Extract fixture code using adjacent semantic boundaries rather than unrelated blocks whose execution order can legitimately change.
