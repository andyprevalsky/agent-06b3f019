---
id: 2026-10-17-hub-reader-tests-assumed-precommit-publication
date: 2026-10-17
title: Hub reader compatibility tests assumed publication before the atomic commit
surface: back-end
component: benchmark-hub-reader-compatibility-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: reader compatibility test called raw run write without private publication staging and treated uncommitted state as a published claim
symptoms:
  - Hub run write has no private publication
  - benchmark-hub-reader-compatibility.test.ts
  - Missing expected rejection
  - pending claim must suppress legacy membership before the first new-domain agent index exists
tags:
  - benchmark-hub
  - fixture-contract
  - atomic-publication
  - catalog-cas
  - legacy-reader
sources:
  - commit 9152678f9d0e5910953626b052b5bd4e996634f5
  - commit 5abf66c3c8a300d30552656beaf7dc8bedc48520
  - plan:.context/auth-deploy/repair-final-5abf66c/deploy-gates/backend-coverage/hub-reader-rca
repro: back-end/src/tests/unit/benchmark-hub-reader-compatibility.test.ts
status: open
---

## Problem

Fresh 5ab deploy coverage failed one of 298 unit files and one of 200 blackbox
domains. Both discover the same nine-case reader compatibility test: four passed
and five failed. The blackbox is an import of the unit file. This was a local
fixture-contract failure, not a native authentication verdict or provider outage.

## Diagnosis

Upstream 9152678f9 introduced private immutable body/visibility/index objects and
made the catalog CAS the sole publication point. The reader compatibility test
was byte-identical across that commit. The first failure was test line 252:
raw `putObject(runs/wire.json)` inside SQL ownership reached
`stagePublicationWrite` without `beginPrivatePublications` and correctly rejected
with `Hub run write has no private publication`.

The other four failures crossed the same obsolete contract: the fault injector
and corruption tests targeted old deterministic object paths, and two cases
expected private begin or visibility staging to publish a pending/hidden claim
before catalog commit. Current Store `commitPutCycle` begins private publication,
stages body/index/visibility, and commits the catalog. Reverting those runtime
guards to satisfy the tests would restore partial-publication behavior.

Counterevidence matters: the new actual Store/SDK/cold-process publication suite
passed 16.740 seconds in the same failing full coverage run. Its body, index,
marker and CAS fault controls require prior ACK/catalog/body/membership and
unclaimed legacy to survive. The storage CAS and ownership files also passed.
These component results do not prove universal production correctness.

Two source-bound archive searches were retained: `Hub run write has no private
publication reader compatibility` and `fixture old contract immutable publication
atomic pending`. The October 1 merged benchmark identity fixture case is the
same broad drift class, but a different callback owner. The October 9 Hub index
repair case concerns actual in-lock production repair, not this test boundary.
This is a separate open incident, not a claimed recurrence of either exact owner.

## Solution

A private test-only migration keeps all nine cases and the existing registration.
It deliberately changes conflicting assertions, rather than claiming unchanged
assertion ASTs:

- Reject unbegun raw writes with zero PUTs, then publish through the real Store.
- Preserve the exact prior logical catalog and legacy body after a failed private
  stage; successful retry commits through the actual owner.
- Corrupt/delete actual committed body/visibility pointers; retain rejection and
  no legacy fallback.
- Hide through real Store delete/catalog commit, then verify legacy reinsertion
  remains masked.
- Verify private begin leaves acknowledged membership intact. Separately construct
  genuine historical pending format to retain old reader suppression coverage.

The byte-exact original target reproduced four passes/five failures in a fresh
owned local database with real Prisma advisory ownership and the test-owned SDK
wire fixture. The migrated target passed all nine. Whole CAS and ownership files
passed 27 controls without schema creation. Canonical Prettier and format-only
AST parity qualify the final frozen source; final-byte receipts travel with the
patch. No production module, task, evaluator, limit or timeout changed.

The broader private atomic-publication suite attempted to use `public.Agent`,
which the deliberately empty database lacks. That setup failure remains retained;
no schema was pushed and no broader new pass is claimed. The earlier same-source
component pass is not relabeled as a new run. The exact private database was
normally disconnected, dropped and observed absent; child processes were waited.
Initial SDK-resolution and candidate-ordering mistakes remain in separate logs.

Golden mechanism check opened Claude FileEditTool lines 427-445 (critical-section
staleness and write), OpenClaw secrets/apply.test.ts line 735 (later write failure
control), Hermes tools/file_operations.py line 568 (same-filesystem atomic swap),
and Codex config/src/plugin_edit.rs line 74 (authoritative atomic writer). These
are general atomic-write analogs, not R2/SQL publication or rollback proofs. The
specific authority is Rose's actual immutable-publication owner and cold-process
controls. This reference check was recorded during final documentation, not
misrepresented as a pre-design experiment.

Status stays open until parent adoption and fresh full verification. Original 5ab
coverage remains FAIL; the private test correction proves no native auth cure,
whole-class elimination, deployment readiness or production rollout.

## Human feedback

No case-specific end-user feedback was recorded. Parent review explicitly accepted
the test-contract migration and required honest semantic assertion changes,
preservation of strict ownership/legacy controls, a private empty local database,
no broader schema push, and fresh final-byte proof after formatting. Parent review
is not represented as a new end-user instruction.

## Reusable lesson

When publication becomes atomic, migrate tests to the authoritative commit owner
while preserving prior-ACK and legacy-reader guarantees instead of restoring
precommit visibility to satisfy obsolete fixtures.
