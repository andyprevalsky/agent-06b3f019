---
id: 2026-11-08-structural-cleanup-compared-refreshed-selection-digest
date: 2026-11-08
title: Structural cleanup compared the old execution with refreshed selection metadata
surface: harness
component: structural-cleanup-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_local_cleanup.py structural_cleanup compared the original receipt digest with the current gate explanation
symptoms:
  - local cleanup structural execution/admission contract changed
  - gates still own unreconciled cleanup refuse launch deploy-command-structural
tags:
  - historical-contract
  - cleanup-reconciliation
  - canonical-json
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: scripts/tests/deploy-test-cycle.test.py StructuralSupervisorCleanup
status: fixed
---

## Problem

A normal independent full run was refused before launching any workers. The old
structural receipt retained an orphan flag and therefore needed typed cleanup
reconciliation. Its supervisor had already reaped every recorded child, including
four TERM/KILL targets, and reported quiescence with no remaining children.
Reconciliation nevertheless rejected the execution/admission contract.

Critical path: refreshed gate explanation → current full-contract digest → old
sealed receipt comparison → cleanup proof refusal → normal launch guard.

## Diagnosis

The preserved original plan's complete structural gate hashes exactly to the
receipt's contract digest. Comparing that object with the refreshed gate found
one difference: the explanatory dependency-graph count changed from 98 to 101.
Commands, roots, transports, checks, environment and the max-five-worker recipe
were identical. The existing reconciliation retained execution_gate for later
checks, but its first reconciliation could not supply the authenticated old gate.

The new owning witness reproduction failed on the old proof shape and passed
with the narrow implementation. The actual original proof then validated through
current worker lock/quiescence checks, without changing state. Independent review
also found a type-exactness issue in an initial witness implementation: Python
compares true with 1 and 1.0 as equal. Two new owning tests reproduced eight
incorrectly accepted initial/recheck variants before the correction. Canonical
JSON digest comparisons reject those variants. All 24 cleanup owning/neighbor
tests and the full 250-test coordinator suite passed with quiescent supervision,
no orphans, no remaining children and no TERM/KILL in those validation runs.

The original structural suite's native failure and orphan origin remain UNKNOWN.
Reaping proves retirement, not that an orphan was harmless or which test made it.
The original native FAIL/UNVERIFIED records and signal/wait evidence stay intact.

## Solution

Accept an explicit original_gate only for an owned, terminal, noncancelled
structural receipt. Require its complete keyset and execution fields to match
the current gate using canonical JSON digests, excluding only selection_evidence;
both explanations must be lists of strings. The original full gate digest must
still equal the sealed receipt's contract digest. Store that authenticated old
gate and enforce the same exact current-execution comparison on every recheck.

All command, recipe, admission, file-hash, child-status, signal/reap and quiet-root
guards remain. Other cleanup kinds cannot carry this witness. Reconciliation is
launch eligibility only: it grants no test pass, source coverage or cleanup waiver.
A current-source full structural registry run remains required.

## Human feedback

Preserve every original failure and unknown, use typed cleanup before retry, and
never bypass ownership or kill healthy/unowned processes. Keep Freedom, phone
state and production environment unchanged while finishing normal deployment.

## Reusable lesson

Authenticate historical execution identity separately from refreshed selection
explanations, and use type-exact serialized comparisons for JSON contracts.


## Recurrence: complete native isolated successor renewal (2026-11-11)

On published `94f96dd0d3c22905edba49726308699ce9ccba95`, normal pure
reconciliation refused `native cleanup: successor contract` before any new
launch. The complete prior `3b48` smoke successor retained its actual native
exit 1, 14 PASS cases, one eligible SKIP and verified cleanup. Its original gate
digest `17cf4add7d3a87d6d588637d954e60c55287d4fc85563e233b3c50176bd03a5c`
differed from the refreshed gate only in `selection_evidence`. The complete
successor branch compared that historical digest directly with the current
gate, repeating this case's original structural-cleanup identity error.

The original request's custody semantic identity exactly matches the preserved
before-refresh state (`7a671a196f7a0e2f1095a3d8b2b706c83a6ddfb0a480f23d315a1b79497c1325`).
Its authenticated plan digest also matches the preserved old plan and the typed
no-retry refresh evidence. This supplies positive old execution authority;
accepting any well-shaped old digest alone would not.

The narrow renewal supplement `successor_custody_state` contains an absolute
path and exact file SHA. It is contract evidence, separate from the unchanged
physical native proof. The helper authenticates the snapshot against the
original request semantic identity, its full plan digest, source, environment,
input fingerprint and original receipt's full gate digest. Every current gate
key and value must match that original gate by canonical JSON, excluding only
`selection_evidence`, which must be a list of strings on both sides. All native
result, case inventory, exclusion, owner, receipt, publication and file-tamper
guards remain. The legacy path needs no supplement when the full digest agrees.
The native proof still changes only `validation_source`; no new resource witness,
current full coverage, financial authority, old task success or cleanup credit
is granted.

The registered owning reproduction failed at the exact `successor contract`
guard before the fix and passes unchanged afterward. Focused negative controls
reject wrong hashes, custody identity, source, environment, fingerprint, fabricated
old contracts and changed command/check/recipe/typed execution fields atomically.
Existing complete-successor admission and native tamper tests remain unchanged
and pass. The initial scratch runner import/relative-closure errors are retained
separately; they are not counted as the causal RED. No worker, provider, database
or pipeline was launched by this local validation. Actual canonical reconcile
and future current-source gate credit remain the coordinator's separate steps.

Coordinator constraint for this recurrence: use authenticated original authority;
do not drop binding checks, rewrite historical metadata or place contract
evidence into the existing physical resource witness.
