---
id: 2026-10-16-r2-sidecar-hit-skipped-ciphertext-existence
date: 2026-10-16
title: r2 sidecar hit skipped ciphertext existence
surface: agents
component: trace-archive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: read_r2_artifact_metadata returns sidecar metadata before checking ciphertext
symptoms:
  - Orphan R2 sidecar returns metadata for absent ciphertext
  - read_r2_artifact_metadata must return None when ciphertext is missing
  - "Failed: unexpected ciphertext access"
  - test_archive_metadata_probe_never_opens_ciphertext
tags:
  - deploy-review
  - regression
  - wmh
sources:
  - PR #1453
  - commit f204831d1b8bfe8197b617901f5126964ec34740
  - commit 4e5ce7fac5352759a94e4f0e0a1dfbaf08ffe9f5
repro: agents/tests/blackbox/trace_archive.blackbox.py::test_r2_metadata_requires_ciphertext_and_preserves_head_errors
status: open
---

## Problem

CodeRabbit C2 finding4290940136 on sourcef204 identified a sidecar-only artifact as existing. The actual registered regression test returned metadata where it asserted None for missing ciphertext. This is an owning offline control, not an observed production R2 incident or benchmark cause.

## Diagnosis

Path: ciphertext/sidecar object state -> read_r2_artifact_metadata -> corpus artifact reference. The first-bad boundary returns immediately on sidecar GET success, so its missing-object HEAD branch is unreachable for an orphan sidecar. Full/local artifact readers establish ciphertext existence first. The prior HEAD/resource case is a relative: it repaired an unconsumed ciphertext GET on the miss path, but never tested the sidecar-hit existence invariant. Two archive searches are preserved in search1.txt/search2.txt; the prior solution and human feedback were read.

The deepest owned gap is branch-dependent artifact identity: metadata availability is not ciphertext existence. Delete/unify was preferred: unify every metadata read behind the same initial HEAD instead of adding a second independent sidecar-hit existence branch. The live object can still be deleted concurrently after HEAD; this is not an atomic pair-read guarantee.

## Solution

Applied infrastructure repair: HEAD first, return None on recognized missing object, propagate all other HEAD errors, then GET/parse only the sidecar; missing sidecar with ciphertext remains ValueError. The permanent trace-archive callback covers orphan sidecar, hit, missing both, orphan ciphertext and AccessDenied/InternalError identity propagation, explicitly forbidding ciphertext GET. Unchanged callback baselineEXIT1 (0.000834s) becomes candidateEXIT0 (0.001337s). Existing local/R2 metadata golden plus regression pass0.033982s; three actual WMH consumer callbacks pass0.657962s. Exact commands/source/test hashes are in result.private.json and commands.txt. Updated exact HEAD traffic assertions account for hit probes; zero-ciphertext-GET assertions remain.

Golden reference: claude-code-src/src/utils/fileReadCache.ts:28 checks underlying file existence before accepting cached data, invalidating vanished targets. This is an analogous cache-validity pattern, not an R2 implementation. Official S3 HeadObject documents metadata-only reads; no ciphertext body is opened. openclaw/hermes-agent/codex were absent at known checkout paths; no clones were created. At10000artifacts the fix adds one HEAD for each prior sidecar-hit, avoiding full ciphertext transfer; no throughput claim is made.

### C8 unit-consumer fixture recurrence

C8 on `4e5ce7fac5352759a94e4f0e0a1dfbaf08ffe9f5` preserved 110/110 blackbox domains and 196 fast-cache tests passing, but the unit stage failed two of 151 cases. Original log SHA256 `969fc349a31a79249bcef0492563d7990ff9e55d498dd2f2eeb213ede17ed444` records `test_archive_metadata_probe_never_opens_ciphertext` expecting obsolete GET/HEAD/GET/HEAD traffic versus actual HEAD/HEAD/GET, and `test_archive_metadata_hit_only_reads_sidecar` rejecting the client needed for HEAD with `Failed: unexpected ciphertext access`.

The first bad boundary for this recurrence is the old unit consumer fixture, not the corrected production reader: its expectations were not updated with the initial-HEAD existence contract. The registered trace-archive golden cases already assert that contract. The old resource-closure assertion was vacuous when no ciphertext body was opened; the private test-only correction forbids every ciphertext GET directly and asserts exact HEAD and sidecar-GET keys. Hit coverage now exercises the actual `_read_r2_object` with a HEAD-capable fake instead of mocking that helper and rejecting all client access. Absent remains None, ciphertext without sidecar remains ValueError, and metadata value assertions remain exact. No production source change is proposed.

Using the identical selected pytest launcher/registered test names, original tests reproduce two failures and the private correction passes both. The complete current unit file passes all 17 cases, including its 15 untouched cases. Both existing metadata blackbox golden callbacks pass; they additionally cover orphan sidecars and unchanged nonmissing HEAD error identity. Three injected negative controls reject ciphertext GET in both corrected tests and omission of HEAD in the hit test. These are offline unit/fixture proofs, not a replay or upgrade of the original C8 aggregate failure. Root alone reviews/applies after terminal and preservation; full normal gates remain open. Native passing artifacts are a separate proof surface.

## Human feedback

The user authorized only private infrastructure candidates during healthy frozen Group4; root alone integrates after all gates/retirement/preservation. No source, environment file, model, DB/cache, provider or production R2 changes were authorized or performed. Preserve all prior cases and user-held semantic proposals.

## Reusable lesson

Establish primary artifact existence before accepting its sidecar or cached metadata.
