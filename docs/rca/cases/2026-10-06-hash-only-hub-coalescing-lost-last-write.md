---
id: 2026-10-06-hash-only-hub-coalescing-lost-last-write
date: 2026-10-06
title: Hash-only Hub coalescing skipped the last write after an intervening packet
surface: back-end
component: benchmark-hub-pending-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: coalesceHubRunPuts reuses an earlier packet hash after a distinct write for the same persisted run identity has entered writer admission
symptoms:
  - A then B then A creates only two run bundle writes and leaves B stored
  - the first and last identical packet incorrectly share one pending promise
  - an intervening same-run source or live-mode update prevents the last requested packet from being admitted
  - an older settlement can remove a newer pending owner if eviction ignores promise identity
tags:
  - benchmark-hub
  - coalescing
  - write-order
  - admission
  - promise-ownership
sources:
  - PR #1420
  - commit 795cb6773b28898b6d50fbfafdda283c867e99c2
  - PR #1420 inline review comment 4196068552
  - plan:.context/frontend-overlay-final-20261006/review-final-normal-20261006
repro: back-end/src/tests/unit/benchmark-hub-admission.test.ts through the normal backend coverage unit runner
status: fixed
---

## Problem

The exact-head review raised one ordering defect in the newly added pending Hub
write coalescer. A source-bound reproduction executed the actual coalescer and
storage owner's admission/persistence declarations with deterministic external
SQL and object-store boundaries. While the first A write was event-gated, callers
submitted B and then an identical A for the same run. The first and last A shared
one promise; the owner emitted only two bundle writes and left B stored instead
of the last requested A. This was an executed owning-boundary failure, not an
observed production A/B/A sequence or proof about the native fifty-copy campaign.

The initial focused control exited 1 in 0.572 seconds on the reviewed source.
The permanent owning file preserved all eight original tests and added the same
A/B/A assertions plus compact same-owner peers. On the old helper, all eight
original tests and cross-run independence passed, while six ordering/ownership
controls failed: nine passes and six failures in 0.507 seconds. No test was
cancelled and no model or provider call occurred.

## Diagnosis

The path is `putRun` -> `coalesceHubRunPuts` -> `storeRun` -> `withIndexLock` ->
run object and index writes. The coalescer first violated ordering: its map kept
all packet hashes until settlement, so the final A found the earlier A even
after B had entered the existing serialized writer. The storage owner then
correctly executed its two admitted mutations in order, A followed by B. The
PostgreSQL advisory-lock protocol and final-state persistence rule were not the
first-bad boundaries and remain unchanged.

The missing invariant was ownership of the latest pending packet for each
persisted run identity. Content equivalence to any earlier pending write does
not make a later write redundant after an intervening mutation. Effective source
and live mode also change a mutation. Run identity uses `String(bundle.run_id ??
'')`, matching actual persistence rather than the raw JavaScript value. A second
ownership invariant requires an older promise's settlement to remove the entry
only if that same promise still owns it.

Archive searches were `benchmark Hub coalescing identical pending packet write
order A B A` and `nonconsecutive identical writes skip final update persisted
bundle order`. The starting-Hub-timeout case and ambiguous-upload reconciliation
case are relatives; their first-bad transport/publication boundaries differ.
This is an adjacent defect introduced by hash-only in-flight deduplication,
rather than a recurrence of those diagnoses. The original eight owning controls
never submitted a repeated A after distinct B and therefore did not catch it.

## Solution

Replace the packet-hash map with one latest `{ packet hash, pending promise }`
entry per persisted run identity. Share only an identical current entry; any
intervening distinct same-run write admits the later packet. Delete a settled
entry only when its promise still owns that run. This consolidates pending state
instead of keeping another historical hash index or adding retries. Removing
coalescing would restore repeated admissions of the identical startup packet,
which the original fifty-caller owner explicitly prevents.

The packet digest recipe, effective-source/default-live behavior, serialization
error contract, actual storage body, global PostgreSQL locking, rejection fanout
and absorbing terminal state remain unchanged. With only the private helper
changed, the identical frozen fifteen-test command passed all fifteen controls
in 0.496 seconds. Peers cover intervening source/live updates, both older success
and rejection settlements, cross-run independence, and normalized persisted
identity. They await explicit fixture events and do not alter timing bounds.

Normal commands from `back-end` are:

```bash
node_modules/.bin/tsx --test src/tests/unit/benchmark-hub-admission.test.ts
npm run test:coverage
```

The normal backend unit runner recursively discovers `.test.ts` files and is
invoked by `scripts/run-coverage.sh`, so the permanent storage-owner regression
runs in the ordinary coverage gate. On source commit
`b6f4e7ccc149302b4b783dfd1265120f8dc74daf`, the normal coverage wrapper exited 0
in 495.807 seconds: all 184 blackbox domains and all 253 unit-test files passed,
including the fifteen admission controls. Coverage met the normal thresholds
with 89.54% lines/statements, 80.42% branches and 92.17% functions. Both the
normal-exit and SIGTERM teardown controls released the owned backend and port
lock. Backend structural tests, TypeScript and affected-file ESLint also passed.
The gate's 2,618 captured inputs stayed unchanged, as did the baseline database
and inherited proxy values. Its source-bound receipts are private in
`.context/normal-backend-aba-current-20261006/`; the later status/index update is
documentation only. This closes the backend owning-boundary defect. Deployment
and a genuine fifty-copy acceptance run remain separate; these controls do not
replace them. Original reviewed bytes, unchanged RED/GREEN tests, per-phase
source hashes and retained failure logs stay private in
`.context/frontend-overlay-final-20261006/review-final-normal-20261006/`.

## Human feedback

None recorded for this ordering finding. Standing user instructions preserve
Freedom and its protected instructions throughout the investigation.

## Reusable lesson

Coalesce only the current pending mutation for each persisted identity, and let a settlement clear that owner only when its exact promise still owns the entry.
