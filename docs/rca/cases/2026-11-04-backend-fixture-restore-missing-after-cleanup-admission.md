---
id: 2026-11-04-backend-fixture-restore-missing-after-cleanup-admission
date: 2026-11-04
title: Backend cleanup admission required a stopped fixture without restoring it before setup
surface: harness
component: staged-deploy-backend
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: backend adapter entered unchanged setup and coverage sweep without restoring the same prepared Postgres fixture after quiet-root admission
symptoms:
  - interrupted root listener remains
  - prepared backend Postgres fixture stopped for launch-only reconciliation
  - existing setup starts timing but not the database
tags:
  - deploy
  - backend
  - postgres
  - ownership
  - prerequisites
sources:
  - PR #1662
  - commit bc1ad3a702662deb53600963878a948b4e301d53
  - plan:.context/deploy-pipeline-successor/attempts/37
repro: python3 scripts/tests/deploy-test-worker.test.py Backend.test_stopped_owned_postgres_is_restored_before_the_unchanged_setup_and_sweep
status: open
---

## Problem

The original round37 backend receipt remains interrupted/UNVERIFIED. Its launch-only cleanup proof rechecks exact-root process closure and no listener on the bound port range, including Postgres20005. Parent therefore stopped only the positively owned idle prepared input container e00b393ea0049fce6effa7e893677011d264a6fc1a80e01821b72183733f087a, preserving its image, named volume and data. Starting it before run_phase makes the original admission proof correctly refuse. The frozen backend recipe setup only runs run-deploy-stage --start; it initializes timing and never restores Postgres. Starting the database after observing request.json would race the sweep.

## Diagnosis

The path is original native cleanup proof -> run_phase retained-owner revalidation -> exact-root admission -> backend source/inventory validation -> recipe setup -> coverage database readiness. The missing boundary is a guarded fixture prerequisite after admission and before setup. No proof predicate, original receipt or full command needs relaxation. Existing resolve_local_db_container accepts running containers only; full prepare-deploy-worktree provisioning can recreate/create databases, so calling either wholesale does not supply the required restore-only transition.

Archive searches used prepared database/stopped Postgres fixture and local-supervisor-cleanup-v1/interrupted backend/quiet-root launch. The local Card pre-admission reconciliation and runner stack-cleanup cases are relatives, but neither owns this post-admission database restoration boundary. This is a new case, not an attribution of the original round37 interruption.

## Solution

Add a narrow prerequisite inside deploy_test_backend under its existing root/source/inventory checks and original deadline, before unchanged setup and sweep. Reuse docker_quick. Require the pinned workspace container name, exact root ownership label, configured pgvector image and captured immutable image ID, named read-write data volume, exact5432-to-CONDUCTOR_PORT+5 mapping and running-or-exited nonpaused/nonrestarting/nondead state. Start only the inspected full64-character ID once when stopped. Reinspect that ID, require unchanged identity and native pg_isready. An already running fixture is checked without start. Explicit prepared system-PG paths keep existing downstream discovery. Missing, foreign or uncertain fixtures refuse; no container creation, recreation, reset, drop, seed, port change or shared fallback is added.

## Verification and remaining scope

The identical registered reproduction above fails on original bc1: its genuine setup assertion sees the fake fixture still stopped, native exit1. With the candidate, it passes and proves full-ID start precedes unchanged setup/sweep. The healthy fixture receives no start. Eight negatives cover missing container, foreign root, missing volume, wrong port/image, paused state, failed start and identity mutation after start. Final owning Backend21/21 passes in9.802s. All120 existing registered test assertion AST lists remain unchanged; the three sweep-timer/cancellation fixtures mock only the new prerequisite, whose actual path is exercised by the new fake-Docker controls. Independent review of patch b4ce5de929a907c9b11a0dc9e65aa4f1a49f3914c2175456b5394973b6dadb78 is CLEAR.

Parent separately performed one read-only same-ID native inspection, exit0, confirming the actual e00b fixture matches root, name, pgvector/pgvector:pg16, exited state, sole20005 mapping and named read-write volume. That is compatibility evidence, not a start or backend PASS. No actual Docker mutation, provider call, full gate or canonical operation was performed by the author/reviewer. A post-start readiness refusal retains ownership and UNVERIFIED; it does not certify absence or cleanup. Original round37 outcomes/history remain immutable. The parent integrated the exact reviewed source; actual full backend execution remains pending and status stays open. Golden reference is not applicable to this infrastructure-only prerequisite.

Private causal report: plan:/var/tmp/pr1662-bc1-backend-fixture-restore/report.json. Native inspection: plan:/var/tmp/staged-deploy-implementation/.context/preparation/bc1-current/backend-db-existing-inspect.json.

## Human feedback

Coordinator constraints, not new end-user feedback: keep quiet-root admission strict. Restore only the unchanged exact owned fixture after that boundary; never manufacture cleanup, edit old receipts, relax preserve_contract or extend task deadlines. Healthy independent gates continue concurrently. Parent owns the actual Docker operation and final full-source validation.

## Reusable lesson

Keep cleanup proof and fixture readiness as distinct ordered boundaries: prove the original execution is quiet first, then restore only the unchanged owned input by immutable identity before running its consumer.
