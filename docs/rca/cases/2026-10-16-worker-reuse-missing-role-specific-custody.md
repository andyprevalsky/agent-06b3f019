---
id: 2026-10-16-worker-reuse-missing-role-specific-custody
date: 2026-10-16
title: Worker provisioning reached creation before an existing worker custody path
surface: harness
component: cloudbench-worker-reuse
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: provision_worker called machine_creation_admission before any role-specific existing worker claim
symptoms:
  - No eligible existing worker path
  - Existing worker never reaches staging while new Machine creation is forbidden
  - Interrupted returned worker cannot complete its release receipt
tags:
  - cloudbench
  - worker
  - custody
  - claim-ledger
sources:
  - PR #1525
repro: agents/benchmarks/worker_terminal_cleanup_test.py
status: fixed
---

## Problem

The no-new-Machines continuation needed existing workers, but `provision_worker`
reached creation admission without an existing-worker branch. Its registered
`test_existing_worker_reaches_staging_without_creation` failed on the retained
original fleet source and passed after introducing claim-before-create. The
fixture injects an admitted worker at that boundary; separate integration tests
exercise the real custody collector, importer, claim transaction and retained
return with local native fixtures. No real worker has been declared eligible by
these tests. Original REAL600 task outcomes remain unqualified.

## Diagnosis

Archive searches used `No eligible existing worker path` and `worker reuse
existing pool claim`. The July 13 killed-owner claim leak and October 4 inert
worker update cases are related lifecycle failures, not this first boundary.
Their existing owner and data preservation requirements remain in force.

The missing branch required role-specific custody, not passage of worker IDs
through a primary admission proof. Source files bind original ownership, task
ordinal, canonical task matrix, source/dependencies, terminal worker capture,
primary association, native identity and a full data snapshot. An authentic
source collector exports that packet only while installing the existing
source-owner exclusion; imports use a separate worker pool and exclusive claim
transaction.

Adversarial review reproduced three defects in the new candidate: untracked
source or edits during dependency observation were accepted; archived tokens
were not derived from the original owner and task ordinal; and a crash after
claim release but before the release marker left the next claim permanently
refused. The final unchanged registered discriminator was run against an
isolated copy of the retained pre-fix helper: eight failures and one positive
control, then nine passes on the fixed helper. It also covers wrong batch run,
mode and primary identity. Raw commands, hashes and output are retained under
`.context/pr1525-continuation/worker-reuse/review-identical-{red,green}.*`.

## Solution

Claim an explicitly imported existing worker before attempting creation. Bind
new readiness to its new token, primary endpoint and isolated evidence directory.
Preserve original files and source latches. Borrowed cleanup retains data and
requires complete current evidence plus strict idle STOPPED custody before
releasing the exact claim. Uncertain state keeps ownership quarantined.

Check tracked and untracked Git state before and after dependency capture, with
an unchanged HEAD. Validate the canonical matrix and full original owner/run/
ordinal/primary linkage at archive intake. Recover only the missing release
marker under the existing Machine claim lock after verifying the old claim has
gone and complete returned evidence still matches; never delete or replace a
later claim generation. A retained old claim rejects recovery.

The final hash-bound registered worker and evidence suites passed all 68 tests;
`review-final-focused.json` records unchanged source inputs and zero native
calls. Independent changed-guard review accepted the three fixes. This is
source/test completion, not native reuse or REAL600 qualification. Existing
workers still require authentic old capture, exact fresh native observations
and snapshot receipts. Primary `.cid` supports its established `clone` and
`pool` forms; original worker allocation must still be a recorded `fresh-clone`,
so re-export of a worker whose original allocation itself was borrowed has no
newly invented admission authority.

## Human feedback

### Later current-custody reuse and bounded pool waits

Explicit current-user admission now has its own origin, immutable preservation
snapshot and exclusive shared primary/worker claim. It does not manufacture an
old worker allocation. Worker staging changes only the requested Machine's
shape in one version-fenced update, then verifies a stopped native pair before
the existing launch. Current runtime capture, strict idle verification and a
stopped pair precede exact claim release.

The empty-pool boundary initially still failed immediately under reuse-only.
An owning reproduction returned 1 and wrote `autoscaler.failed`; the same test
now returns the autoscaler's existing capacity-wait status 75 without creating
a Machine or a failure marker. Only an unambiguous pool miss takes this path.
Claim/proof failures still retain their original errors and holds. The existing
normal poll and original child deadline bound waiting; neither changes.

The new pool-miss case passed five unchanged runs, and the complete 31-case
worker terminal family passed. These controls establish local behavior only;
live worker reuse and the original REAL600 outcome remain separate gates.

Reuse Machines; never create blindly or increase quotas. Preserve all data,
original evidence, warm resources and Freedom. Unknown state stays quarantined.
Do not deploy; the parent owns real observations and final qualification.

## Reusable lesson

Existing capacity needs a complete role-specific ownership transfer and return
path. Fail-closed creation admission alone cannot make that capacity usable.
