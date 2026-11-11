---
id: 2026-11-11-agentcard-world-receipt-published-before-validation
date: 2026-11-11
title: AgentCard world receipt was published before provisioning and validation succeeded
surface: harness
component: isolated-stack-manifest
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run.sh exports BENCHMARK_AGENTCARD_WORLD_RECEIPT before setup and immutable world validation, making EXIT manifest writing depend on an absent or invalid file
symptoms:
  - "FileNotFoundError: agentcard-world.json"
  - "services.json remains starting after provisioning exits and native cleanup runs"
tags:
  - agentcard
  - bootstrap
  - receipt
  - cleanup
  - services-manifest
sources:
  - PR #1864 review comment 4533470382
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
repro: agents/benchmarks/cloud_batch_cleanup_test.py test_native_world_receipt_failure_still_publishes_stopped_manifest
status: open
---

## Problem

When world provisioning fails before writing its receipt, the native EXIT cleanup cannot publish its final services manifest. This is a locally reproduced bootstrap/observation defect. It does not establish a payment loss, provider release, or the cause of a separate native cloud failure.

## Diagnosis

Provisioning exports the future receipt path before running the setup CLI. `write_services_manifest` consumes any exported receipt and validates its identity. A failed setup therefore causes the cleanup writer to open a nonexistent file; the original `|| true` preserves teardown but leaves a stale `starting` manifest.

The new registered fixture executes the actual provisioning block, Python validator, complete manifest function and complete native cleanup/EXIT trap. Setup is intercepted at the node boundary; owned PIDs are empty, database ownership is false, and other cleanup effects are fixture stubs. An inherited foreign receipt is also supplied. On a508 bytes, the unchanged stopped-status assertion fails with `FileNotFoundError` and actual manifest status `starting`.

Archive searches used `BENCHMARK_AGENTCARD_WORLD_RECEIPT`/receipt provisioning and `services.json.*receipt`/AgentCard receipt validation; no same-cause case was found. The Oct7 retained-recovery-stack case concerns classifying an intentionally retained service as active work, a different boundary.

## Solution

The private patch unsets an inherited published receipt, keeps the new path private through setup and validation, then exports it only after success. The validator and teardown logic remain intact. Registered cases cover missing receipt, setup failing after writing, malformed JSON, foreign world, live mode, legacy-ID alias and a valid exact sandbox identity. Failed setup publishes a stopped manifest without inventing a world identity; valid setup publishes only the verified identity.

The identical-command final causal pair records exit1 before and exit0 after. Five focused GREEN runs are retained. All96 non-PostgreSQL cases in the existing owning module passed with external sockets denied, only process-owned mock HTTP listeners permitted, and database binaries denied. The one real-PostgreSQL case was not selected under the explicit no-DB scope; it is not counted as passed. Earlier private venv/dependency/loopback-guard setup failures remain INVALID_SETUP, not causal RED or native failures.

The existing deploy wrapper selects tests with `-k`. The patch adds only `or native_world_receipt`; actual collection proof adds exactly the three new cases and removes none. No catalog, benchmark evaluator, timeout, concurrency or skip policy changed. Bash syntax, Python AST and patch applicability checks passed.

Proof is under `.context/agentcard-stability/review-cycle1-repairs-20261111/receipt/`: `final-exact-causal-pair.json`, focused logs/commands, `full-non-db-command.json`, `full-non-db-owning.log`, `recurring-gate-selection-proof.json` and `source-manifest.json`. Patch SHA256 is `8c750465ba888856481fa253750d916b2d3f33bca4ed6367232ef901486214f0`; owning receipt SHA256 is `d96a44b8da41240aab254d71921be33de033240c5a6b6bb1f485948994c9afbf`. Parent CODE_ONLY acceptance pins this seal in `parent-code-review.json`.

## Open scope

OPEN for deployment/runtime verification; shared application and full public owning validation including the real-PG case are recorded below. The private pre-integration proof used no real provisioning, financial, browser, database or native benchmark operation.

## Human feedback

No incident-specific human feedback is recorded. The standing no-shared-edit/no-live-operation constraints and original financial identity checks were preserved.

## Reusable lesson

Publish an optional receipt to shared lifecycle observers only after both its producer and its validation succeed; an uncommitted setup artifact must not prevent failure cleanup from recording reality.

## Shared-source validation

Applied in commit08e06669220cd78b2dc25872a92c0e8de80b160e. The actual shared full cleanup module passes97/97, including the existing real-PostgreSQL query case, with zero deselected tests. Receipt: `.context/agentcard-stability/review-cycle1-public-validation-20261111T044136Z-d5f8b952/final-receipt.json` SHA25628fdfad00ba41188d15f0e9057b6ebbd8ebfc920d3c7e155571518c53798d17b. The exact disposable PG server was stopped using its canonical pg_ctl lifecycle, its PID and cluster paths were verified absent, and no system, foreign or production database was accessed. The earlier private no-DB coverage limit is closed for this committed shared snapshot; native deployment verification remains separate.

The case remains OPEN for the remaining deployment/native verification and final evidence-preservation scope. Original failing/private artifacts are retained; no skipped or unexecuted test is converted to PASS.
