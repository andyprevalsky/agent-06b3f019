---
id: 2026-11-03-seed-startup-tsx-expired-cache-memory
date: 2026-11-03
title: Stale standalone backend TSX loader amplified expired-cache startup memory
surface: back-end
component: seed-memory
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: Backend TSX 4.23.1 eagerly indexed the shared transform cache and scheduled every expired entry for deletion at once
symptoms:
  - "seed memory ratchet FAILED: 261MB > 228MB budget"
  - "first identity phase already retained 249MB"
tags:
  - seed
  - memory
  - tsx
  - dependency-lock
sources:
  - commit 0e1e72e905c1b07658b031c67e3091f345cc5755
  - PR #1634
repro: bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget
status: fixed
---

## Problem

The original five-run gate preserved all fidelity checks but measured OS peaks 261,181,180,180,180MB against the unchanged228MB maximum. The first identity phase was already249MB, before bulk tables; LocalStorage was the later high-water sample, not proof it caused startup growth. Original first-run CPU/file-input measurements and all JSON/logs remain in the deploy evidence.

## Diagnosis

The standalone backend lock and installed loader were TSX4.23.1, while the root workspace already locked4.23.15. The old loader eagerly indexed the shared cache into an array and Map and created unbounded deletion promises with linear removal. The newer loader performs direct-key reads and bounded streamed cleanup. A shared cache had34222 entries when observed after failure; the original pre-cleanup expired census was not captured.

A no-DB import-only cold/warm test did not reproduce the original growth. A complete unchanged retry passed182–185MB, and a complete private-cold-cache run passed152–178MB; neither was called a fix. An independent controlled60000-expired-file cohort then ran the same real imports under Node22 and the existing96MB heap: old loader aborted134 near256MB RSS, newer loader passed near113MB. This proves the cache-growth mechanism, not byte-identical reconstruction of the unavailable historical cache census.

The existing backend seed-memory unit suite now runs the actual resolved loader against a child-only60000-entry filesystem cohort. It asserts TypeScript entry execution, actual cache enumeration, successful exit and the existing228MB RSS ceiling. The original eight cases remain unchanged. The same regression failed on the old loader and passed all nine cases on the new one.

## Solution

Align only the standalone backend lock's TSX version/resolved URL/integrity with the existing root lock4.23.15; all other dependency metadata stays identical. No seed-table algorithm, fidelity assertion, memory threshold or warm-run selection changes. Refresh backend dependencies with canonical standalone npm ci, then execute the actual registered regression and original five-run gate.

Post-fix original command passed all five fidelity-verified trials:156,157,148,153,156MB; maximum157MB remains below228MB. The registered unit owner passed9/9. Evidence is retained under the PR1634 seed-memory RCA directory, including original failure, unsuccessful hypotheses, controlled old/new loader proof and canonical post-fix receipt. Full integrated release gates remain required.

## Human feedback

The user required fixing blockers and completing deployment. Do not increase the memory budget, drop the first trial, prewarm to hide startup, delete shared cache as a claimed code fix or label a clean retry causal proof. Preserve all failures and state the missing original cache-census limitation.

## Reusable lesson

Keep independent workspace lockfiles aligned when they resolve the same developer runtime. Bound filesystem-cache enumeration and asynchronous cleanup; validate the actual resolved loader under a large cache rather than assuming the root dependency is used.
