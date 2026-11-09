---
id: 2026-11-08-phone-revocation-fixtures-reused-a-fixed-unique-phone
date: 2026-11-08
title: Phone revocation fixtures collided with an existing owner of one fixed unique phone
surface: back-end
component: iphone-blackbox-fixture-identities
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: two fixture mutations assigned the shared fixed revoked-phone value to User.phone before their security assertions
symptoms:
  - Unique constraint failed on the fields phone
  - server identity revocation rechecks lease authorization
  - semantic iMessage auth loss cannot cross phone fence or release its original slot early
tags:
  - iphone
  - unique-phone
  - account-revocation
  - fixture-isolation
sources:
  - commit a2f08090f48ad118bf2fcc71f55b7a011190512d
  - plan:.context/deploy-google400-stabilized/attempts/47/triage/backend-coverage-blackbox/result.json
repro: back-end/src/tests/blackbox/iphone.blackbox.ts and iphone-control.auth-loss.cases.ts
status: fixed
---

## Problem

The normal full backend run passed 29/30 iphone cases and 40/41
iphone-connection cases. Both failures were Prisma P2002 errors assigning
`+15550009999` to a fixture User before reaching their revocation assertions.
The original conflicting account and seed provenance remain UNKNOWN. Neither
failed update created that existing row, and no unknown row was modified.

## Diagnosis

Relative to reviewed main 06416, the original iphone fixture defect is
Gate: NOT_INTRODUCED, while the newly added auth-loss fixture is
Gate: INTRODUCED. Both repairs remain owned. The source and original preserved
logs establish the same fixed-value fixture mechanism, not a phone-service
permission defect. The nearby local-schema duplicate-phone RCA is different:
its normalization fix must not be used to erase a legitimate unique owner here.

In a newly created, parent-owned local database, one synthetic nonallowlisted
user deterministically occupied the fixed value. The unchanged normal command
from back-end, `bash scripts/run-blackbox-tests.sh iphone,iphone-connection`,
reproduced the exact two P2002 failures in 100.315 seconds. The security
assertions were not reached. No production data or live provider was used.

## Solution

Use the existing unique ineligible-phone allocator for both actual revocation
writes. Its +1555 values are outside the synthetic +1999 allowlist, so the
original heartbeat-denial, release and held semantic-fence assertions still
exercise real identity revocation. The identical command and occupied database
then passed all 71 cases in 98.042 seconds. The occupied synthetic row remained
intact until its owner explicitly removed it after this causal pair.

Register the collision precondition in the two existing owning cases through
`revokePhoneFixtureIdentity`. It atomically inserts an ordinary synthetic
occupier with skipDuplicates, awaits the actual mutation, and removes only its
own newly inserted UUID/phone row when the insertion count is one. An existing
owner is neither changed nor deleted. The normal owning cases are serial; no
unrestricted parallel lifetime guarantee is claimed for this test helper.

After removing only the explicit owned seed, the registered cases created their
own occupied-value precondition and passed the same 71 cases in 94.371 seconds.
Post-run fixed-value and owned-collision-row counts were both zero. All 112
original assertion calls across the two case files are AST-identical. Native
supervisors were quiescent with no orphans, signals or remaining children.
Normal freeze then caught the 604-line test file exceeding its unchanged
600-line limit. Extract the same mutation and occupied-value lifetime into the
existing fixture module. Targeted ESLint passed, and the identical final-source
owning command passed all 71 cases in 95.926 seconds. The incumbent synthetic
seed remained intact and owned helper rows were zero. Independent scoped review
cleared the final five test files; the original 19 approved phone files remained
byte-identical. No lint limit or assertion was weakened.

The exact owned database was dropped only after zero connections and a free
backend port; absence was verified. Full normal final-source gates remain
required. Diagnostic no-provider/auth-seeding overrides are recorded separately
and confer no whole-gate or physical production credit.

## Human feedback

The user requires normal phone acceptance, no phone reset, no production
environment changes and preservation of Freedom. No real account or phone was
used to reproduce this fixture collision, and no message was sent.

## Reusable lesson

Allocate distinct ineligible fixture identities for revocation tests and keep their collision precondition in the owning suite without modifying an existing owner.
