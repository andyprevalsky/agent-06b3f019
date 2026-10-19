---
id: 2026-10-16-retained-primary-current-state-custody
date: 2026-10-16
title: Retained allocated primaries lacked a current-state custody phase
surface: infra
component: cloudbench-startup-failure-archive
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: cold handoff accepted only historical preconfig125 receipts
symptoms:
  - "No eligibility proof yet"
  - "startup archive requires the original startup rejection"
tags:
  - cloudbench
  - retained-primary
  - ownership
sources:
  - PR #1525
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py AllocatedCurrentColdTests
status: open
---

## Problem

The authorized original600 continuation needs reuse of retained Machines. The
existing cold handoff only accepts authentic historical startup rejection 125.
Some retained allocations have no such original receipt. Their current stopped
state alone cannot establish isolation or historical runtime completion.

## Diagnosis

The frozen design explicitly classified this as a missing capability. Historical
preconfig validators correctly refuse missing 125/CID/ACK evidence; changing those
validators would fabricate history. Searches for `missing original
benchmark-child.finished 125` and `cold handoff allocated current retained`
returned related startup/recovery cases, not a current-state custody policy.

## Solution

An additive `allocated-current-cold-v1` phase preserves original ownership,
audit, task/provenance, controller/primary logs and guest captures or explicit
absences. The source collector requires a distinct mounted `/data`, an absent
or empty unlinked checkout, stable all-UID native process births with pinned
allowed binaries, exact native instance/capture nonce and image dependency
fingerprints. It rechecks the checkout, mount and processes after collection.

Capture, commit and archive verification enforce the explicit image, native
shape and original provenance. Source outgoing exclusions and RETAIN fences
precede publication. Existing destination claim, evidence, ledger, audit and
terminal ordering remains in force. Actual claim revalidates current native
Machine and Volume identities. Original evidence and cleanup latches remain;
historical runtime stays UNKNOWN and task credit stays zero. Historical
preconfig125 validation is unchanged. Workers require their own role policy.

The registered unittest family exercises a real temporary source/destination
filesystem and archive/claim transactions. Provider and guest observations are
mocked. Identical-command RED/GREEN receipts are preserved privately under the
continuation's current-cold-rca evidence directory. Current-phase crashes at all
seven durable handoff boundaries, replay, checkout races, stale instance,
foreign claims, retained source, new originals and workers are covered.

Native qualification is still open: no provider action or eligible-Machine
claim was made by this implementation. These tests do not repair or pass the
original600 benchmark. The real source-bound capture, original evidence,
reviewed native invocation and original600 rerun remain required.

## Actual continuation evidence

The coordinator ran the reviewed source-bound collector on retained Machine
`870613f04272d8`, reusing its completed data-volume snapshot. It captured an
absent checkout, matching original node/Python dependency fingerprints, stable
strict before/after process identities and explicit missing historical files.
The same Machine and Volume were confirmed STOPPED afterward with unchanged
config and instance. The operation took 18.99 seconds. Original captures and
native receipts are retained in `pilot8706-current-evidence` and the immutable
one-shot observation directory. This is current isolation evidence for one
candidate, not pool admission or original600 qualification. Source-controller
custody, endpoint binding and actual claim remain open.

## Actual source-shape correction

The recovered original V39 files contained the runtime-evidence latch, but no
guest-cleanup latch, local batch result or worker ledger. Requiring those absent
files manufactured an intake prerequisite that the original run never wrote.
The current phase now preserves presence and absence as typed evidence. It
requires the authenticated original campaign summary, initial cohort manifest,
parent termination record and threshold parent record when the local terminal
result is absent. The selected terminal job and attempt must bind the original
PID, owner, monitor path, provenance, log, campaign, cohort and parent identity.
The original cancelled exit 137 and early-abort classification remain evidence;
no successful local batch result is synthesized. An absent worker ledger also
requires complete singleton fresh-allocation and expected-allocation inventories.
The earlier preconfig phase remains strict.

Host-only intake changes retain the exact original collector bytes and digest.
Only the independently approved exact historical collector digest or the exact
current trusted source digest is accepted. Guest functions and security constants
must also match the trusted current program structurally; only its optional
host-supplied digest argument is normalized. Imported Python is never executed. The trusted validator checks the
original, unmodified guest JSON against that explicit digest. A self-consistent
malicious replacement validator is a registered rejection case. The authentic
6ec98ff9 collector and guest receipt pass this check without recapture.

## Human feedback

The user requires real 200 tasks times k3 at concurrency600, infrastructure stop
at30/600, every error including recovered errors investigated, no blind creates
or quota hikes, and preservation of Machines, data, warm resources and Freedom.
The coordinator explicitly authorized this additive capability while retaining
the old phase's strict requirements.

## Reusable lesson

Establish current isolation under a separate custody policy without converting missing historical evidence into a historical success claim.
