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


## Run77 recurrence: proof publication precedes task assignment

On October 18, the next three-run full600 timing batch reached a new boundary:
full saved-inventory preparation produced 571 eligible retained Machines while
the canonical organization snapshot had 29 free slots. That is 600 slots;
600 workers plus their controller require 601. The exact remaining held
Machine `899766c6759018` was rejected with `unaccounted claim or published task
effect`. Its immutable run77 archive has manifest SHA
`4784c4389cf096e71c05364c7fc3aab4f6d7655164c244ce20216145963bd1ca`.
All 62 supplied claim-member hashes for the two remaining holds were verified.

This is a recurrence at the earlier parked reader's publication predicate.
`collect` grouped both `archived-reuse-proof.json` and `.cid` as publication,
then `qualify` rejected the entire group. The actual producer has another
observable boundary: `allocate` durably saves the local proof after the
accepted claim and readback, then the shell registers that proof in live and
durable ownership and common-current records, and only then writes `.cid`.
The fleet's task-launch phase requires `.cid`. A local proof by itself is
therefore evidence of a completed native allocation, not proof that assignment
or task execution occurred. The previous fixture explicitly expected every
published proof to stay held and did not execute this intermediate producer
boundary.

For this exact identity, all five raw transactions are retained: lease 201,
pre-read 200, one version-fenced config POST 200, post-read 200 and lease release
200. The accepted new instance, complete intended config, marker, creation
identity and stopped current native row agree. The local proof equals the
source-exclusion proof and its claim ACK binds that exact new instance and
marker. The complete 46-member task-root inventory contains only preallocation
startup metadata and claim artifacts; `.cid` and task boot artifacts are absent.
The matching live and durable owner metadata remain, while their reuse records
and the common-current record for this MID are absent. No registry record may
be invented to fill that gap.

The correction must distinguish this fully proven partial publication from
both an unpublished unknown write and a task assignment. Require the exact
reviewed producer, complete root/claim namespace, exact computed proof,
positive single-CAS ACK and closed lease, no `.cid` or other task/native effect,
and exact inactive current identity. Preserve the completed native claim and
original task failure honestly. Read-only preparation grants no reservation
credit; the normal new-cohort lease, current-version CAS and readback remain
mandatory. The other hold, `87e514c0092e28`, has an unknown historical config
response and a changed current instance and remains held for this correction.

Archive searches used `published task effect archived proof partial assignment`
and the literal `unaccounted claim or published task effect`. This case is a
recurrence of the same closed-claim eligibility class, not a provider outage.
Golden-reference checks found atomic publication guards in
`openclaw/src/commands/backup.atomic.test.ts:1` and
`hermes-agent/tools/environments/base_session_env.py:140`; these are analogies
for separating preparation from publication, not authority for native reuse.
The exact local owning reproduction and actual saved-input outcome remain to
be recorded below. The RCA stays open and establishes no full600 task pass.

The user explicitly replaced the earlier stop-and-ask preference with approval
to continue necessary benchmark fixes autonomously. Keep the three requested
full experiments, infra early-stop disabled, original task/run/I/O bounds and
the batch wall/monotonic origin including failed preparations.


The permanent owning regression now executes the actual reviewed allocator,
then the extracted real registration heredoc against a failed registry path,
then full `P.prepare`. The identical new test fails on 0344cd67 with zero
candidates and passes on the corrected reader. The author's 12 owning tests
passed in 1.851 seconds, including the same positive publication boundary for
both exact reviewed allocator hashes, and assignment, task-boot, changed-proof,
claim-ACK and current-incarnation denials. Ruff passed. Root independently ran
both old/current allocator boundary tests successfully and validated the exact
899 claim against all 46 actual task-root members, both owner metadata records,
five raw native responses and the Git-bound old producer. Provider calls were
zero. A mistyped second root test name first caused an invocation error; the
corrected command passed and the failed invocation remains in the proof log.

Only the two reviewed complete allocator hashes and the reviewed shell
publication hash are allowed. An orphan extra wire directory, changed lease
history, hidden task artifact, `.cid`, unknown producer or current drift still
refuses admission. The actual full normal preparation and three unchanged
experiments remain pending; causal fixture success is not task outcome proof.


## Run81 recurrence: current intended claim with an unknown old response

Actual full saved-input preparation on 0c6ca2b0 passed with 572 candidates and
six retained holds, confirming the proof-before-assignment correction. The
next normal admission nevertheless stopped before any reservation or controller.
The organization inventory contained 971 objects, but the operator deliberately
subtracts one additional unlisted/destroying allowance: 1000 - 971 - 1 = 28,
not 29. Thus 572 + 28 is still one short of 601. The minimum-one check was
introduced with the portable operator and remains mandatory for its non-atomic
organization reads. Do not remove that safeguard to satisfy arithmetic.

The remaining claim `87e514c0092e28` has exactly four recorded operations:
lease 201, pre-read 200, one version-fenced config POST with no raw response or
local ACK, and lease release 200. The historical response remains UNKNOWN.
The complete saved current native object is stopped, has a new instance, and
matches the entire intended claim config and unique successor marker. Its
creation identity, name, region and physical volume are unchanged. The previous
`T.unchanged` path correctly refuses it because both current instance and config
differ from the prior reservation. That prior-state-only guard does not cover
positive current custody after an uncertain historical response.

The distinct new-admission proof must preserve these two facts independently:
the old write has an unknown response, while the current object exactly matches
the intended claim. Require the reviewed producer, positive prior reservation,
complete source exclusion, one CAS fenced to the old instance, a closed original
lease, a new stopped current instance with the exact complete config and marker,
and a complete preassignment namespace with no `.cid`, claim ACK, published
proof or other task/native effect. Do not manufacture an ACK, mark the old
attempt successful or resend its update. Eligibility itself has zero capacity
credit. The ordinary new-cohort lease, exact current-version check, new CAS and
readback remain required. A late old CAS still names the old instance and cannot
overwrite the newer instance; any changed fresh state must deny the new credit.

The executor also resolved the historical destroying object
`e82943b02d5538` with one exact GET returning a retained raw 404. That closes the
specific historical observation without changing the minimum-one allowance or
replaying any deletion. The reader correction uses independently proven reuse,
not a quota-policy exception. Owning reproduction and actual-input verification
for this distinct current-state branch remain pending below.


The owning control now executes each exact reviewed allocator with a native
adapter that commits the config update and loses its response while the lease
finally closes, then runs full `P.prepare`. The old 0c6ca2b0 reader retains the
row with `prior native state changed`; the corrected reader returns only new
eligibility and explicitly keeps `native_claim_acknowledged=false` and
`old_outcome=UNKNOWN_RETAINED`. All 16 owning tests passed in 2.912 seconds,
including full current-version reservation and intervening-conflict/no-credit
controls. Root independently ran three focused controls in 0.469 seconds and
ran the unchanged lost-response reproduction against the old reader: one
expected failure (`0 != 1`) in 0.454555 seconds. No provider calls occurred.

Actual-input calibration verifies all 36 archived task-root members, the four
raw/missing-response operations, current native row and three startup/lifecycle
metadata files. Root also invokes the real Git-bound protocol check. Independent
review passed the exact source and proof hashes. Inspection of the complete
manifest caught `bench-e2e.finished-epoch` before adoption; the reader now hashes
and validates the finite ordered start/end pair as local lifecycle metadata,
without treating it as task success or this uncertain native claim's release.
The old T prior-state branch, positive-ACK branch, `.cid` and foreign-effect
rejections remain intact. Full normal preparation and the three requested
campaign outcomes remain pending and are not inferred from these controls.
