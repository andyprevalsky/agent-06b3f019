---
id: 2026-10-16-snapshot-placeholder-conflicted-with-completed-row
date: 2026-10-16
title: A snapshot placeholder and completed row triggered a duplicate-identity refusal
surface: infra
component: cloudbench-select-snapshot
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: exact snapshot selector rejected repeated IDs before classifying pending versus completed representations
symptoms:
  - "duplicate snapshot identity"
  - "PENDING_OR_REFUSED"
  - "snapshot representation state conflicts"
tags:
  - cloudbench
  - snapshots
  - provider-state
sources:
  - PR #1525
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py SnapshotRepresentationTests
status: mitigated
---

## Problem

The preserved pilot stopped in its snapshot phase after 875.629 seconds, with
82 API calls and zero guest executions. Its final API response contained two
rows for the same requested snapshot: a running placeholder with year0001,
empty digest and size0; and a completed row timestamped 2026-10-16T02:37:41Z,
size692691630 and a nonempty digest. The frozen selector rejected duplicate IDs
before considering whether one row was only a pending representation.

## Diagnosis

Exact replay of the original response reproduces `duplicate snapshot identity`
using the frozen selector. Searches for `duplicate snapshot identity` and
`snapshot running created duplicate placeholder` found related snapshot cases,
not this representation boundary. The canonical latest-snapshot selector had
no exact-ID record API suitable for reconciling this already-created snapshot.

## Solution

The canonical selector now offers `available_snapshot(records, snapshot_id)`
and a `--id` CLI mode. It resolves only the recorded requested ID, permits an
empty pending placeholder beside a consistent completed row, and refuses
conflicting completed data, explicit failure, malformed/missing fields, mixed
states, invalid timestamp/digest/size, and conflicting volume sizes. Other
snapshot identities never substitute for the requested one. Existing latest-ID
selection is unchanged.

The registered regression runs unchanged RED to GREEN against a fixed source
slot: the baseline extracts the frozen selector's behavior into the canonical
helper; the fix changes that helper. Original-response replay separately
confirms the actual completed row is selected. Source-only evidence is retained
under the continuation's snapshot-representation-rca directory.

The original frozen entrypoint and once receipt are untouched. Native
reconciliation is still pending: the owner must make one bounded read of the
same Volume's snapshots and pass that full response through the exact-ID helper,
then append a distinct receipt linked to the original request and failure. No
snapshot creation retry, new snapshot, original-clock reset or whole-operation
success claim follows from the parser fix.

### Recurrence: waiting placeholders during the next34 snapshot acquisition

The root-owned snapshot operations for Machines `891ed49f704998` and
`8ed0d4f7d47128` each received a successful snapshot ACK. Their next exact-Volume
GET returned a record with `status: waiting`, size0, an empty digest and the
year0001 timestamp. The existing selector recognized running/pending/creating/
queued placeholders but omitted this observed waiting state, raising
`snapshot representation state conflicts` instead of returning pending `None`.
Both attempts remain PENDING_NO_RETRY. No second POST is authorized by this fix.

The two actual responses are retained byte-for-byte as
`scripts/tests/fixtures/snapshot-waiting-1.json` and `snapshot-waiting-2.json`.
The extended existing SnapshotRepresentationTests fails on6189 with the exact
exception for both fixtures and passes after adding waiting to the pending set.
It also verifies waiting alongside a completed record in either order, and
rejects positive waiting payloads, mixed terminal/pending state, explicit
failure, unknown state and all existing conflicting completion controls.
The terminal-success predicate, selector bounds and snapshot transaction timers
are unchanged. Four tests passed five consecutive unchanged runs in the isolated
worktree. An initial fixture-directory setup error is retained separately and is
not counted as causal RED evidence.

Searches used `snapshot representation state conflicts` and `snapshot waiting
pending completed placeholder`. This is a recurrence of the same representation
classification boundary: prior coverage included only the running placeholder.
No provider call, guest call or native reconciliation was performed by this RCA.
The existing bootstrap-recovery structural gate already runs the test class.
Root must reconcile the original acknowledged IDs using GET only. Successful
local classification does not establish actual snapshot readiness, Machine
reuse eligibility or REAL600 qualification.

## Human feedback

The user requires every error, including recovered errors, to receive registered
identical RED-to-GREEN proof. The coordinator prohibited native actions in this
RCA and required preservation of the frozen entrypoint, existing snapshot,
original timing, Machine and Volume.

## Reusable lesson

Classify provider representations before rejecting repeated identities, while refusing conflicting positive evidence for the requested resource.
