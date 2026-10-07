---
id: 2026-10-06-conditional-archive-retry-lost-accepted-body
date: 2026-10-06
title: Conditional archive retry treated an accepted ciphertext without its sidecar as an unrelated existing object
surface: back-end
component: trace-archive-creation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: storeEncryptedArtifact reset bodyStored across invocations and conditional PUT returned existing-object no-op before the missing sidecar
symptoms:
  - the exact accepted body must resume its sidecar across calls
  - offline exhausted sidecar transport
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

The first call acknowledged the exact encrypted body but all five metadata writes failed. The next same-input call returned null on the body precondition, leaving no readable pair. In the native reproduction the body bytes remained exact and metadata was absent; the assertion failed before any unrelated object was modified.

## Diagnosis

The public archive provider is the first owning boundary: caller payload → conditional storage → accepted body/sidecar or object refs → ordinary reader or manifest consumer. The original code produced the wrong state on this path. The deeper gap was incomplete publication being classified as a complete successful storage boundary.

All three review findings were reproduced together against unchanged 93dea runtime: the existing twelve controls passed and the three new controls failed in 33.091 seconds. The identical formatted controls reproduced twelve PASS/three FAIL in 33.454 seconds. The same assertions passed fifteen of fifteen on the repair in 48.859 seconds. Related creation controls were then extracted into one imported helper to preserve the existing 600-line test-file gate. The extracted baseline again produced twelve PASS/three FAIL in 40.340 seconds; final candidate passed all fifteen in 48.866 seconds. The imported creation-control helper bytes were identical for this last pair; two now-unused imports were removed from the wrapper after its baseline run. No asserted behavior changed.

The native command is the pinned Node22.13 invocation of `back-end/node_modules/tsx/dist/cli.mjs back-end/src/tests/unit/trace-archive-batch.test.ts`. Both database URLs target a separately named diagnostic database on the positively owned isolated local Postgres container. The R2 SDK transport is offline and no provider/model requests were made. All five recorded native test leaders were reaped and freshly ESRCH absent. The exact owning control is `conditional encrypted creation repairs an earlier accepted body across calls`.

Archive searches used `createOnly sidecar metadata already exists`, `local archive partial write start manifest listing`, `PreconditionFailed sidecar`, and `atomic archive create-only`; these did not establish a prior identical owning cause. The July 20 creation-manifest and September 3 snapshot-quiescence cases are relatives, and their existing guards remain.

## Solution

Conditional creation now reads an existing encrypted body or metadata after the precondition and resumes only when its bytes match the submitted bytes. Different stored bytes remain an intentional no-op and are never replaced. The existing five-attempt storage error contract and plain-object no-op remain. This also handles an acknowledgement lost after a matching sidecar was accepted.

Cross-call continuation requires the original encrypted envelope. `archiveBytes` encrypts once and retains that envelope within its five attempts, but another `archiveJson` or `writeStartManifest` invocation creates a new nonce and metadata timestamp. This control does not prove that a re-encrypting lifecycle retry can repair the earlier sidecar; mismatched ciphertext remains a no-op.

The five controls (two existing and three added) remain inside the already discovered archive-batch unit file through `trace-archive-creation-controls.ts`. Normal backend coverage invokes its recursive `.test.ts` discovery, which runs this same wrapper. All original behavioral assertions remain, including native lease loss, strict final equality, unrelated roots, bounded uploads, storage failures and precondition no-ops. Focused ESLint and mandatory backend TypeScript checks passed without exceptions. Independent source and recorded owning-proof review is clear. Full final-source backend qualification remains pending, so the case stays open. This is no benchmark outcome, production release, or LIVE50 credit.

Golden reference inspection found completed temporary-file publication in vendored Claude Code `src/utils/file.ts:426` and native lock publication at `src/utils/nativeInstaller/pidLock.ts:215`, Hermes `utils.py:177`, and OpenClaw `src/skills/library/bundle.ts:300`. Rename-based replacing writes cannot provide this archive's no-replace contract, so local publication uses an exclusive hard link after complete staging. The Codex checkout was absent; no exact Codex conditional-archive analogue is claimed.

## Human feedback

The user requires honest stage endpoints, generous overall infrastructure observations, complete publication and native resource release, and no repeated resets or fabricated benchmark credit. These repairs change storage semantics and do not alter model, prompt, benchmark, evaluator, execution timeout, or E2E limits.

## Reusable lesson

Treat a retry of an exact partially accepted artifact as continuation, while preserving unrelated write-once objects.
