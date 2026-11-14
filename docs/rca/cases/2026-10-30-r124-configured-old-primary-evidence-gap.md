---
id: 2026-10-30-r124-configured-old-primary-evidence-gap
date: 2026-10-30
title: Configured old primary remains retained after an unacknowledged boot update
surface: infra
component: cloudbench-exact-owner-recovery
classification: undetermined
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Failed update responses left an unapplied marker while the retained old Machine actually held the configured boot recipe
symptoms:
  - native pre-config Machine is not unchanged original inert allocation
  - boot-config-unapplied
  - runtime-evidence-unconfirmed
tags:
  - r124
  - it28
  - host-replacement
  - original-volume
  - diagnostic-capture
sources:
  - commit b308fd8606d7c59cd1ca4be6923e208546158a07
  - commit d0663f361a1118ce6776d1ab8aaa0987dcf252a5
  - fleet run 20261030-185254-1969396
  - agent ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt
repro: scripts/tests/cloudbench-configured-old-capture.test.py
status: open
---

## Problem

The first dual-member It28 recovery on b308, owner
`3c6ffb9a3ccb4b78a7bd56a7933291e0`, exited 1. Its old primary
`e826322ad17048` retained a configured boot recipe, so the R122 inert-allocation
proof correctly refused it. The replacement `d8d2e4db40dd18` shares the logical
task and ordinal token but has its own Machine, volume and runtime obligation.
Original benchmark grades and cleanup failures remain unchanged. This case
is OPEN: diagnostic capture admission is not full owner recovery.

## Diagnosis

The old update log (SHA256
`f99c38a5c5844e1c344d32b4fbd4c516f6c094516f0b935c32d358596b1499ac`)
records six failed responses, including 408 and unexpected EOF, followed by
local exit 125 and unapplied/host-unresponsive markers. The captured native
before/after files are byte-identical (SHA256
`83cba7237b99c6d6a8d1364c9c5b6e75a3162c273c4c3f83deae347e594b62e1`):
STOPPED, `bash /cloudbench-boot.sh`, configured environment, four injected
boot files and the original volume. Failed update responses therefore do not
prove that configuration was absent remotely. The initiating provider failure
and whether the old workload ran remain unproved.

Existing `native_recipe` independently validates the captured payload against
source d066: recipe
`eeb6a26f7561e9e56bf3a727b920cbcc6cf2f8cec64eaa1f7aed1b9361fb21ba`,
fingerprint `1de382655d42931144e7036d0fe4ee1b8cf020a79aa21b9d92edc6fa2253ce1f`.
This is code identity, not execution-absence evidence. The cold-bootstrap value
is string `0`; the start barrier is the original run ID, not boolean `1`.

The old archive contains controller-local originals, not an original-volume
inventory. Ordinary volume capture requires a direct current CID plus accepted
start and guest ACK, or a distinct verified native-stop contract. This old
nested member satisfies neither. Startup/pre-service verification also requires
actual guest receipts; changing the inert predicate or inventing an ACK would
lose an unresolved obligation. Missing RUNSTAMP alone is insufficient because
its boot-script write is unchecked. The checked booting-state write precedes
workload launch, but a complete, source-bound volume capture is still required.

Two archive searches covered the exact inert-refusal symptom and configured
stopped/replaced/no-start recovery. The October 16 configured billing-stop case
supports preserving configured source identity, but its quiescence/STOP result
never authorizes runtime evidence or claim release. Pool rejected-start and
pre-service cases require different original evidence and cannot be relabelled
as this incident.

## Solution

The non-releasing diagnostic stage was integrated from exact patch
`c27f6f406d9e7d5ebff255622522d7fbfda5f811efdd01c3b3a668dcb28c472a`
on b308. Independent reviewer `ph7f5w33myqa0z3227h3e4yz1h8h397f` returned
GROUNDED for this diagnostic stage; review receipt SHA256 is
`81accc991f39e1a05aab243894d9ba10f599022348809c08ce613e17a17baca9`.
Root verified the exact three output hashes after applying this patch. The registered
15-test suite passed in 4.457 seconds; the existing capture suite passed 28 tests
with two existing skips in 5.530 seconds. Pinned compilation, Bash syntax and
diff checks passed. Actual capture is not claimed here. It adds explicit
`--configured-old-member` admission to the existing
volume capture helper and registers its owning suite in `scripts/test.sh`.

Admission binds the complete R122 old/current membership, dead owner, exact
nested output, native Machine/volume, original recipe/task and data paths.
Capture uses the existing recovery lock, isolated inert boot, original-file
copy, stop and exact-config restore. It rechecks local custody and records
prelaunch/prestack seals as originals. It preserves runtime data even when it
cannot classify it. It neither consumes the old pending marker nor manufactures
an ACK, provider cleanup input, normal manifest, phase completion or task credit.
The current primary's ACK and normal-seven obligations remain independent.

V1 independent review found its compensation-failure restore hint omitted the
new mode. V2 carries the flag and adds a permanent round-trip regression:
failed restore, mode-preserving retry, exact config restored, no extra start
and all latches retained. The same new test fails on V1. These are technical
review findings, not human feedback.

Author checks: 15 new owning controls and the bounded registered invocation
pass; existing undelivered-capture suite has 28 passes and two existing skips.
Actual original local custody changes from baseline admission refusal to exact
old-member diagnostic admission with only path relocation and host-local PID
absence mocked. Native transport and volume data are mocked in the capture
controls. None proves current host death, native readiness, actual volume
contents or operational cleanup. No live capture was performed by this author.

After independent qualification, an authorized real capture must establish what
is on the old volume. Complete source-bound absence, valid pre-service receipts
or actual runtime/provider records require distinct reviewable closure paths.
Any incomplete capture, changed identity or failed restoration retains custody.
R124 remains OPEN until obtained original evidence supports full coherent
owner recovery; this diagnostic stage alone must not be marked as that fix.

## Human feedback

None recorded.

## Reusable lesson

Treat an unacknowledged configuration update as an unknown remote outcome and
inspect the retained member's original evidence before assigning a no-start
classification or discharging its recovery obligation.

## Continuation: actual diagnostic capture and mounted-root evidence gap

The earlier Solution records the first diagnostic stage. The subsequent
single authorized capture of old `e826322ad17048` returned exit 0. Its original
archive SHA256 is
`4e52573f10b9f4b9ca108a0494cc256d5cee67a47274a8ef04d2c7a92a954475`:
45 bytes, zero regular members and sixteen explicitly missing expected paths,
including driver state/PID, bench log, current-token ACK/request/seals,
services, run and backend/worker logs. Saved original config matched the prior
native capture. The reviewed helper's journal/provenance reports inert capture,
STOPPED and exact config restoration; raw final API responses were not exported.
That report is distinct from independently reading the final provider state.
Original controller custody, pending obligations and grades were retained.

This does not yet prove the original volume lacked those files. Both root and
independent reviewer reproduced a counterexample using the real collector:
a nonexistent data directory returned success with zero files and sixteen
missing paths, and the host verifier accepted that inventory. The original
capture had no contemporaneous data-root or mount identity attestation. It
remains valid as an unclassified diagnostic result and must not be relabelled
as mounted-volume absence evidence.

Integrated patch SHA256
`61ecbd22f9e95bb931ff55384cb3a56037d1ff7bd050353de1e3b9493507ed0d`
adds mounted-root attestation only to configured-old diagnostic capture. It
reuses `current_cold_mount`: canonical existing `/data`, an exact mountinfo
entry and a device distinct from `/`. It checks stat device against mountinfo
major/minor, binds the native guest Machine, rechecks device/inode/mount before
and after collection, and validates/preserves the attestation in provenance.
Ordinary capture and all prior non-release restrictions remain unchanged.
Independent reviewer `ph7f5w33myqa0z3227h3e4yz1h8h397f` returned GROUNDED
for this diagnostic-only patch; receipt SHA256 is
`ffa3be16689f61c5813aa0f92ff52673300787a4be4ca95e631b258010c3f68d`.
Root applied the exact reviewed output; a new actual capture is not claimed here.

The same missing-root test is baseline RED (incorrect success) and candidate
GREEN (refusal before archive publication). The registered suite passes nineteen
controls, including mount/Machine mismatch and changed identity; ordinary
capture retains twenty-eight passes and two existing skips. These are offline
controls, not a new live capture or proof of any particular volume's contents.
The previously captured archive is immutable; only a new qualified capture can
supply contemporaneous root/mount evidence.

Even mounted-volume absence alone does not establish execution history. The
bound boot script checks its initial `publish_driver_state booting` result
before spawning the status server, unpacking helpers or launching the driver;
its RUNSTAMP write is unchecked. However, state publication is not fsynced, so
crash/lost-write histories remain a distinct uncertainty. The limited event
subset on a normal Machine GET is not a complete lifecycle history. Neither
this mount fix nor an empty archive proves no workload or provider allocation.
Any later no-start or cleanup classification requires additional adequate
original evidence or a conservative supported recovery path. R124 remains
OPEN; current replacement ACK/normal-seven and all exact owner obligations
remain required.

A separately authorized, read-only `/events` request returned HTTP 200 in
0.305 seconds and three events from the diagnostic restoration instance only;
it did not supply the earlier execution history. Its raw response SHA256 is
`414c9c8e6e19da95f358661102b2f3cdebcf404e4dfe8a454a9fd6c3e9759f99`.
No release or no-start inference follows from that response.
