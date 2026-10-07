---
id: 2026-10-06-local-create-only-published-partial-files
date: 2026-10-06
title: Local create-only archive publication left a partial final file after a failed write
surface: back-end
component: trace-archive-creation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: putLocal wrote directly to the exclusive final body and metadata destinations before each write completed
symptoms:
  - offline partial native write refused
  - partial create-only writes must remain failures rather than existing-object no-ops
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

The native filesystem fault seam wrote two bytes and raised ENOSPC at the existing final path. Its next retry encountered EEXIST and returned null, so the failed partial body was classified as a complete existing object. The permanent control exercises both encrypted bodies and metadata sidecars, inspects final paths and ordinary archive listing, and requires a subsequent exact retry to produce a readable decrypted pair.

## Diagnosis

The public archive provider is the first owning boundary: caller payload → conditional storage → accepted body/sidecar or object refs → ordinary reader or manifest consumer. The original code produced the wrong state on this path. The deeper gap was incomplete publication being classified as a complete successful storage boundary.

All three review findings were reproduced together against unchanged 93dea runtime: the existing twelve controls passed and the three new controls failed in 33.091 seconds. The identical formatted controls reproduced twelve PASS/three FAIL in 33.454 seconds. The same assertions passed fifteen of fifteen on the repair in 48.859 seconds. Related creation controls were then extracted into one imported helper to preserve the existing 600-line test-file gate. The extracted baseline again produced twelve PASS/three FAIL in 40.340 seconds; final candidate passed all fifteen in 48.866 seconds. The imported creation-control helper bytes were identical for this last pair; two now-unused imports were removed from the wrapper after its baseline run. No asserted behavior changed.

The native command is the pinned Node22.13 invocation of `back-end/node_modules/tsx/dist/cli.mjs back-end/src/tests/unit/trace-archive-batch.test.ts`. Both database URLs target a separately named diagnostic database on the positively owned isolated local Postgres container. The R2 SDK transport is offline and no provider/model requests were made. All five recorded native test leaders were reaped and freshly ESRCH absent. The exact owning control is `local create-only body and sidecar publication is atomic`.

Archive searches used `createOnly sidecar metadata already exists`, `local archive partial write start manifest listing`, `PreconditionFailed sidecar`, and `atomic archive create-only`; these did not establish a prior identical owning cause. The July 20 creation-manifest and September 3 snapshot-quiescence cases are relatives, and their existing guards remain.

## Solution

Create-only local writes finish a unique same-directory staging file before linking it exclusively into the final path. Cleanup removes only that exact temporary file. Staging names use the existing metadata suffix filter so the ordinary archive listing never indexes them. Matching encrypted body/metadata resumption shares the exact-byte ownership rule with R2; foreign bytes and plain existing objects remain protected. Ordinary replacing writes are unchanged.

The five controls (two existing and three added) remain inside the already discovered archive-batch unit file through `trace-archive-creation-controls.ts`. Normal backend coverage invokes its recursive `.test.ts` discovery, which runs this same wrapper. All original behavioral assertions remain, including native lease loss, strict final equality, unrelated roots, bounded uploads, storage failures and precondition no-ops. Focused ESLint and mandatory backend TypeScript checks passed without exceptions. Independent source and recorded owning-proof review is clear. Full final-source backend qualification remains pending, so the case stays open. This is no benchmark outcome, production release, or LIVE50 credit.

Golden reference inspection found completed temporary-file publication in vendored Claude Code `src/utils/file.ts:426` and native lock publication at `src/utils/nativeInstaller/pidLock.ts:215`, Hermes `utils.py:177`, and OpenClaw `src/skills/library/bundle.ts:300`. Rename-based replacing writes cannot provide this archive's no-replace contract, so local publication uses an exclusive hard link after complete staging. The Codex checkout was absent; no exact Codex conditional-archive analogue is claimed.

## Human feedback

The user requires honest stage endpoints, generous overall infrastructure observations, complete publication and native resource release, and no repeated resets or fabricated benchmark credit. These repairs change storage semantics and do not alter model, prompt, benchmark, evaluator, execution timeout, or E2E limits.

## Reusable lesson

Publish write-once files only after the full payload is written, using an atomic operation that cannot replace another destination.
