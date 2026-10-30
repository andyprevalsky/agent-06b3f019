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
