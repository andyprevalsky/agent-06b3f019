---
id: 2026-10-06-start-manifest-list-error-became-empty-snapshot
date: 2026-10-06
title: Start manifest converted an unavailable object listing into an authoritative empty snapshot
surface: back-end
component: trace-archive-creation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: writeStartManifest called non-strict listArchivedObjects and consumed its empty-array error fallback
symptoms:
  - offline listing transport refused
  - artifact_count=0
  - unavailable listing must not publish an authoritative empty start manifest
tags:
  - archive
  - conditional-publication
  - storage
sources:
  - PR #1424
  - commit 93dea65a7a5b2f6ad0612838efedf8671101d011
repro: back-end/src/tests/unit/trace-archive-batch.test.ts
status: open
---

## Problem

The start fixture was durably accepted. A controlled actual ListObjects transport error was caught by the permissive listing API, then start initialization wrote encrypted and public manifests with zero artifact refs. The owning test observed both stored manifests after the error; this is wrong snapshot data rather than an agent startup timeout.

## Diagnosis

The public archive provider is the first owning boundary: caller payload → conditional storage → accepted body/sidecar or object refs → ordinary reader or manifest consumer. The original code produced the wrong state on this path. The deeper gap was incomplete publication being classified as a complete successful storage boundary.

All three review findings were reproduced together against unchanged 93dea runtime: the existing twelve controls passed and the three new controls failed in 33.091 seconds. The identical formatted controls reproduced twelve PASS/three FAIL in 33.454 seconds. The same assertions passed fifteen of fifteen on the repair in 48.859 seconds. Related creation controls were then extracted into one imported helper to preserve the existing 600-line test-file gate. The extracted baseline again produced twelve PASS/three FAIL in 40.340 seconds; final candidate passed all fifteen in 48.866 seconds. The imported creation-control helper bytes were identical for this last pair; two now-unused imports were removed from the wrapper after its baseline run. No asserted behavior changed.

The native command is the pinned Node22.13 invocation of `back-end/node_modules/tsx/dist/cli.mjs back-end/src/tests/unit/trace-archive-batch.test.ts`. Both database URLs target a separately named diagnostic database on the positively owned isolated local Postgres container. The R2 SDK transport is offline and no provider/model requests were made. All five recorded native test leaders were reaped and freshly ESRCH absent. The exact owning control is `start listing failure skips empty authoritative manifests`.

Archive searches used `createOnly sidecar metadata already exists`, `local archive partial write start manifest listing`, `PreconditionFailed sidecar`, and `atomic archive create-only`; these did not establish a prior identical owning cause. The July 20 creation-manifest and September 3 snapshot-quiescence cases are relatives, and their existing guards remain.

## Solution

Start snapshot collection uses the existing strict-list option. A listing error reaches the existing start-manifest best-effort catch, leaves the accepted fixture intact, and skips both authoritative manifests. Launch-critical behavior and finalization/reconciliation stay unchanged. The September 3 finalization case is a relative: its first bad boundary was async-producer quiescence, while this incident is an error-default consumer at start.

The five controls (two existing and three added) remain inside the already discovered archive-batch unit file through `trace-archive-creation-controls.ts`. Normal backend coverage invokes its recursive `.test.ts` discovery, which runs this same wrapper. All original behavioral assertions remain, including native lease loss, strict final equality, unrelated roots, bounded uploads, storage failures and precondition no-ops. Focused ESLint and mandatory backend TypeScript checks passed without exceptions. Independent source and recorded owning-proof review is clear. Full final-source backend qualification remains pending, so the case stays open. This is no benchmark outcome, production release, or LIVE50 credit.

Golden reference inspection found completed temporary-file publication in vendored Claude Code `src/utils/file.ts:426` and native lock publication at `src/utils/nativeInstaller/pidLock.ts:215`, Hermes `utils.py:177`, and OpenClaw `src/skills/library/bundle.ts:300`. Rename-based replacing writes cannot provide this archive's no-replace contract, so local publication uses an exclusive hard link after complete staging. The Codex checkout was absent; no exact Codex conditional-archive analogue is claimed.

## Human feedback

The user requires honest stage endpoints, generous overall infrastructure observations, complete publication and native resource release, and no repeated resets or fabricated benchmark credit. These repairs change storage semantics and do not alter model, prompt, benchmark, evaluator, execution timeout, or E2E limits.

## Reusable lesson

Require a successful source listing before publishing authoritative snapshot refs.
