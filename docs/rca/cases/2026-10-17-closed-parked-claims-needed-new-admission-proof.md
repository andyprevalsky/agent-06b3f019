---
id: 2026-10-17-closed-parked-claims-needed-new-admission-proof
date: 2026-10-17
title: Closed parked claims required a distinct proof for new admission
surface: infra
component: cloudbench-parked-reservations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: closed claim attempts had no eligible archived ownership or unused-reservation path
symptoms:
  - 370 eligible retained Machines
  - 52 available organization slots
  - 179 additional retained Machines required
  - "KeyError: claim_evidence while collecting recovery-omitted holds"
  - 208 current archived owners suppressed by an older inherited hold scope
tags:
  - cloudbench
  - parked-claims
  - admission
sources:
  - commit 500babc9035912cbbdede1fa63b2d67ce960c7ac
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-parked-reservations.test.py
status: open
---

## Problem

After run70 closed, the normal preparation verified 370 reusable Machines.
The canonical organization read counted 948 of 1000 available objects, leaving
52 creation slots. A 600-task controller needs 601 total slots, so the next run
required another 179 reusable Machines. Unpublished claim attempts remained
excluded even when their Machines were stopped and their complete history was
available. The original exclusions correctly avoided assuming a missing
publication meant that no native write occurred.

## Diagnosis

A claim can stop before a config update or after its successful native
acknowledgment but before local publication. These are distinct from an unknown
config write and from a completed archived task owner. The original late
observation and timeout outcomes must remain failures. A later closed-run
admission needs its own explicit ownership and current-state proof.

## Solution

Add an explicit parked-reservation input mode. Preserve original request,
reservation, source-exclusion and complete archive evidence. Recompute the
original task and generation binding and qualify only supported parked states.
Conflicting later ownership stays held. An uncertain old write can only gain
new-cohort eligibility through the closed-transition proof described below;
its old outcome is unchanged. Every candidate retains its prior liabilities
and receives no reservation credit from this read-only preparation. The
existing fresh native lease and version-checked reservation must grant new
capacity for the new run.

This case remains open until the actual saved archive passes the new proof
validator and normal fresh admission succeeds.

## Run72 recurrence: complete recovery evidence

The closed run72 archive was 899,944,341 bytes with a 22,270,410-byte
manifest and 96,738 members. Its controller release and caller retirement
were verified. The next preparation first rejected the manifest under the
generic 16 MiB operational-input bound; the recovered reader also tried to
materialize the whole archive under a 256 MiB read bound. The artifact readers
now use an explicit bounded manifest path and a private, stable-descriptor
streaming archive hash. Operational request and individual claim bounds remain
unchanged. Both old-code failures were reproduced; the owning archive,
recovered-reader and unused-reservation controls passed after the change in
`7ecd7d15556d5f31ed8e8b982b78107fcf07259d`.

The next real preparation reached `collect()` but assumed every held row had
claim evidence. Four recovery-omitted rows intentionally had none. The parked
reader now separates only the exact validated omitted partition, preserves
its fields and zero credit, and still requires claim evidence for selected
candidate holds. The same old-code reproduction failed and seven parked
controls passed in `e86dd8696b089337dd9dba904f0650435adc6737`.

That complete preparation yielded 338 candidates. The explicit 270 exclusions
had zero overlap with current run72 ownership. All 208 missing current owners
instead overlapped the inherited run70 hold scope. Different-origin hold
suppression ran before current archived ownership could be checked. The fix in
`a1e3d5084bd7cff1eed36e30f45d3132fe337cda` reuses the ordinary native-owner
validator: a positive current archived reuse proof must name every suppressing
origin in its predecessor hashes, match the current native identity, volume
and marker, and pass the unchanged stopped-state and layout rules. Old holds
and their liabilities remain recorded. Thirteen owning controls passed,
including the old-code failure, archive-order reversal, unlinked origin,
explicit exclusion and changed native-name negatives. Actual preparation
then yielded exactly 546 candidates; it still lacked four slots with 51 free.

The remaining seven cases are not regraded as old successes: one has a positive
configuration acknowledgement followed by a malformed read receipt, and six
retain their old outcome while the saved native state equals the prior state.
Their new-cohort eligibility proof and actual fresh admission remain open.

The closed-transition reader requires the complete closed history, the
original positive reservation ancestry, exactly one configuration update
fenced to the prior instance, and a matching leased pre-read. The current
native creation identity, instance and complete configuration must still
equal that pre-read. Missing responses and recorded error responses keep
their original classification. A successful update followed by an empty
read-response file instead requires the original positive acknowledgement
and an exact current match to it. Neither path retries an old update or
grants capacity; normal new admission remains required.

All seven retained cases passed the isolated transition checks, with all
402 supplied member hashes verified. Four new owning controls and the nine
parked and twelve unused-reservation integration controls passed. Full
saved-archive preparation remains the next validation boundary; these checks
do not claim that a candidate was reserved or that the capacity gap is closed.

The original run72 never released its main execution barrier. These local
controls and preparation results do not establish an original600 task pass.

## Recurrence regression coverage

- `scripts/tests/cloudbench-archived-owner-stop.test.py`
- `scripts/tests/cloudbench-recovered-reservations.test.py`
- `scripts/tests/cloudbench-unused-reservations.test.py`
- `scripts/tests/cloudbench-parked-reservations.test.py`
- `scripts/tests/cloudbench-archived-machine-reuse.test.py`
- `scripts/tests/cloudbench-closed-transition-reservations.test.py`

The owning tests are registered in `scripts/test.sh`. The saved proof logs bind
the exact tested sources; the full unchanged benchmark outcome remains a
separate gate. Archive searches used `claim_evidence` (no exact prior match)
and `parked inherited hold archive` (this related open case).

## Human feedback

Keep recovery in the published CLI, preserve the original clocks and data,
and never clear an unknown intent or infer old task success to meet capacity.

## Reusable lesson

Prove eligibility for a new generation without changing the historical outcome
or replaying an old effect.
