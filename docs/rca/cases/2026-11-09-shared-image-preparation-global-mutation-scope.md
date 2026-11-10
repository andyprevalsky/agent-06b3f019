---
id: 2026-11-09-shared-image-preparation-global-mutation-scope
date: 2026-11-09
title: Shared image setup combines app-global mutation with whole-inventory qualification
surface: infra
component: cloudbench-source-preparation
classification: unresolved
problem_class: concurrency-inefficiency
first_bad_boundary: Parent facf cloudbench_maintenance.verify_transition rejects unrelated inventory membership churn after native setup; replacement outcome proof pending
symptoms:
  - native maintenance: extra/missing inventory target
  - native transition did not qualify; original exit retained
tags:
  - cloudbench
  - source-ownership
  - image-preparation
  - concurrent-lifecycle
sources:
  - commit facf1f1f8613293a82f153a7688e36866b274ecd
  - commit 8046dcbc3a67e7d4241d8eb6171b5c1652b85f71
  - PR #1635
  - fleet run 20261029-011042-1883979
repro: scripts/tests/cloudbench-original-image-failure.test.py
status: open
---

## Problem

Parent native image activation e9895d980baaf10648039d8e9dd3067b exited
setup 0 but qualification false and parent exit 1 after 230.282 seconds.
Recorded inventory changed from 45 to 54 Machines: 13 added, four absent,
zero changed common foreign rows. The target passed its image, stopped,
mount, volume and default parked shape checks. Setup also staged app-global
secrets, so dropping only foreign inventory assertions would be unsound.

## Diagnosis

The original parent source capsule is forensic evidence, not main. Main
8046dcbc does not contain the parent's unpublished cloudbench_maintenance.py.
Exact AST extraction of its verify_transition, fed byte-verified original
intent/result copies (qualified restored only on a deep copy to its pre-catch
value), reproduced ValueError: native maintenance: extra/missing inventory
target. The original receipt remains qualified false; no historical cleanup
or financial credit is granted. Native lifecycle outcome reproduction and
replacement fail/pass proof remain open.

Archive searches were `extra/missing inventory target` and `concurrent warm
image preparation secrets`. The earlier independently owned source case
2026-09-12-fleet-required-active-shared-source-without-owned-alternative is a
relative: it added an immutable private-source fleet consumer, but preparation
still needs an explicit native owned-resource producer rather than shared setup.
There is no Rose agent self-report: this failure occurs in native controller
preparation before a task agent starts.

## Solution

Implementation prepared for native outcome validation: reuse the existing private source manifest consumer,
with target-only native lease/version-bound preparation and immutable resource
creation authority. App-global secret staging stays outside this transaction;
target guest environment, source, image and installed dependency proofs must
be verified before publishing the successor snapshot manifest. The parent gets
an explicitly reviewed additive adapter preserving original debts and failures.

At 10,000 agents, preparation is keyed to each owned source and its native
lease, with bounded provider requests. No global idle window, app-wide inventory
equality or global preparation lock is introduced. The existing captured source
digest determines fleet pool isolation. The original pure verifier and byte-identical normalized intent/result are permanent forensic fixtures; their regression preserves the exact refusal and false outcome. Native HTTP boundary tests cover the new owned producer, source/secret/lease/CAS tampering and concurrent reader claims. Source-version and lost-guardian regressions failed on the old boundaries and pass on the repair. The existing private-source suite passes 168 cases. Real provider outcome validation and full deployment remain pending.
Golden reference: not applicable (ordinary native infrastructure code; any
approval-gated adapter hunks require separate frozen review).

## Native validation in progress

The first native allocation on frozen d8f1bcd128c02bb938b64323991eabd70748e175
retained an ambiguous volume-create outcome. Its original pending marker was
written at 22:51:48.939776 UTC; the failure marker followed 20.004305 seconds
later with no HTTP status. A read-only inventory found one exact reserved-name
40-GiB volume, created at 22:51:50.024 UTC and still restoring, unattached.
The client collapses transport, JSON and absolute-deadline failures at this
boundary, so the precise transport cause remains unknown. No Machine create
was attempted and the original failure is unchanged. This is not a PASS or
allocation-free refusal. Supported exact-name reconciliation is being evaluated
against the original writeahead; no second POST or inferred cleanup authority
is allowed. Later-clone environment binding is also under final review.

The bounded live source now has exact reconciled Volume and Machine authority,
with both original POST acknowledgements honestly absent. The Machine is stopped
on its own encrypted volume. Native validation exposed two further causal
boundaries: a donor image activation after the owned snapshot fork incorrectly
invalidated immutable fork inputs, and the provider omitted false/empty defaults
and expanded mount metadata in its Machine response. Focused unchanged regressions
failed before each repair and pass after narrow input-scope/normalization fixes.
Snapshot, dependency, environment, mount and owned-volume tampering still refuse.
Full raw native evidence stays private; public reconciliation output is bounded
to identities and receipt hashes. Preparation and benchmark outcome proof remain
pending; these allocation records grant no benchmark or historical task credit.

The first live preparation on stabilization source
81ef70b1cb23a0fee892296b70cf90cdee35433d failed before START. A full native
200 response acknowledged the owned Machine CAS to the pinned image and
4-CPU/8192-MiB preparation shape, with a new instance ID. The next GET exposed
the exact predecessor configuration and instance in state `replacing`.
`wait_state` called the strict final-identity verifier before checking whether
that known replacement had completed. Cleanup also failed, and the original
receipt remains qualified false and cleanup false. Its stop transport has no
retained response; no successful STOP acknowledgement is inferred. No guest
execution, START, snapshot or task admission occurred.

The unchanged HTTP transition regression fails against the old wait boundary
and passes when only the exact acknowledged CAS predecessor is tolerated
within the original deadline. Unknown instance IDs/configurations still refuse;
START requires the acknowledged version in the requested state. The same rule
covers the image update, final park and cleanup park. A separate, credit-free
bootstrap recovery verifies the failed request, historical producer source,
original wire responses, original creator authority and exact current known
version under a new native lease. It reparks the same owned Machine without
starting it. A new request/nonce and successful preparation remain mandatory;
recovery publishes neither a source manifest nor benchmark credit. Local HTTP
failure/recovery/fresh-preparation/retirement controls pass. Independent review
and the actual recovered-source outcome are pending.

On the next frozen source, 52c2e26b739b36edf3a5416ffd288291c2d5d3e6,
the known-predecessor wait succeeded through START. The first guest-delivery
exec received a retained HTTP 409 saying the Machine lease was held by the
same token identity. Its request carried the acquired nonce. The acquisition
response named the pre-update instance; the exec targeted the acknowledged
new instance. This is evidence of a lease/exec boundary failure, not proof of
its precise cause. Current OpenAPI supports both command arrays and the legacy
cmd string, so SDK serialization differences alone do not explain the 409.
The failed exec has no parsed success response, and no guest job was launched.
STOP, park CAS/readback and lease release subsequently succeeded; the target
is verified stopped at 1 CPU/2048 MiB. The new result remains qualified false
and cleanup false, with stopped verification true. Version-bound lease/exec
behavior and safe reuse of that exact parked successor remain under RCA.

The repair now refreshes the same native lease nonce after the acknowledged
CAS version reaches its expected state and requires the renewal response to
name that version before exec. It retains the command-array API contract.
A version-aware HTTP boundary regression fails on the old implementation and
passes on the repair; this is a controller contract proof, not a claim to know
Fly's internal rejection cause. A distinct recovery path is limited to the
exact first bootstrap exec lease rejection plus fully acknowledged stop/park
cleanup. It preserves both failed results and the ultimate original creator
binding. The historical failure fixture now embeds the exact old producer
bytes with dependency hashes, independent of the current HEAD. Independent
review, live protocol validation and full deployment remain open.

The e5f8d22f native checkpoint proved that same-nonce lease renewal can return
the acknowledged new version without releasing the lease. Nevertheless, the
first exec on that version returned the same retained HTTP 409. This disproves
stale lease version as a sufficient explanation. Stop, park, version renewal
and release were again acknowledged, leaving the exact owned source stopped
at 1 CPU/2048 MiB. Its result remains false. No further API exec retry is
planned. The next repair uses the existing bounded, exact-Machine SSH transport
while retaining native lease/version and before/after identity proofs, with
separate SSH execution receipts rather than invented HTTP acknowledgements.
That transport and its qualification verifier require independent review and
actual native validation before this RCA can close.

## Human feedback

The bounded 117b79b checkpoint used separate exact-Machine SSH delivery while
retaining its native lease. Delivery and launcher acknowledgements succeeded;
the guest then returned an AssertionError before attestation. Its original
receipt omitted a failed-operation SSH index and did not record the exact
assertion phase. Both gaps remain explicit historical limitations. A later
hash-only diagnostic found different effective ambient environment hashes;
that observation does not establish which assertion failed in the earlier job.
Stop, park and lease release succeeded, leaving the same owned encrypted source
stopped at one CPU/2048 MiB. The failed request and result remain unchanged and
grant no source or task credit.

New failures seal their SSH index in cleanup and report only phase, job,
presence and safe environment digests. A narrowly verified recovery can retain
the original unsealed historical evidence as a newly labelled forensic input;
it never invents an old seal or successful guest result. Recovered filesystems
remain untrusted until a fresh successful preparation.

The remaining parent-environment incompatibility requires an owned capsule,
rather than adopting current app secrets. The builder now uses the exact
canonical worker-only browser projection followed by the existing Temporal
transform, preserving backend bytes. Private SFTP staging and immutable
hash-named files are bound to the owner, source, image and dependencies. Offline
tests include distinct concurrent owners and capsules under ambient rotation.
Independent review also exposed that default empty fresh volumes could not
inherit the capsule. Owned mode therefore explicitly selects its qualified
source snapshot and rejects incompatible fresh-only requests; ambient behavior
is unchanged. Independent producer and consumer source reviews passed on their
exact frozen bytes, including local create/prepare/retire protocol composition.
Native qualification, full deployment and parallel campaign outcome remain open.

The frozen d706 request-builder invocation failed locally with Linux `E2BIG`
before creating a request or constructing a native client. It concatenated the
131,000-byte pinned environment helper and fingerprint calls into one Bash
argument. The total crossed the per-argument limit. This is a request transport
boundary failure, independent of native preparation; preserving the same pinned
helper bytes in a private file removes the oversized argument without changing
fingerprint semantics or deadlines.

The following 70d4 native checkpoint reached capsule staging but flyctl refused
the already-created destination file: its SFTP put command does not overwrite
existing files. The test transport had overwritten that file and therefore did
not model the real boundary. The native attempt retained its failed result,
verified stop/park and released its lease; it published no capsule or snapshot.
The corrected protocol reserves an exclusive private nonce directory and leaves
the upload filename absent. Publication still requires exact directory identity,
stable private file metadata and bytes, and a no-replace final link. Historical
file-based staging remains a separately pinned failure proof, never a guessed
successful upload or retry authority.

On f44ba7c, actual private SFTP and capsule sealing succeeded. The guest matched
both approved environment hashes and passed its provider contract, then failed
in source fetch with `CalledProcessError`. Cleanup verified stopped/parked state
and released the lease; no snapshot or qualification was published. The original
fetch log was on ephemeral `/tmp` and was absent after cleanup replacement, so
its precise error remains unknown. A separate bounded read-only diagnostic
confirmed a rose-owned checkout (UID 1001) and a present GitHub token, then
verified stop again.

An unchanged-helper offline test reproduces a concrete caller mismatch: running
as root against the nonroot checkout fails, while the normal run-as-rose caller
fetches the exact local ref. The preparation caller now follows that canonical
user contract without changing Git safety settings or checkout ownership.
Safe failure metadata and a private durable log copy preserve a future error
before cleanup. This repair still requires a new native outcome; it does not
retroactively identify or qualify the original f44 failure.

The 5affa guest then completed successfully, including its exact checkout,
installed and image dependency fingerprints, owned capsule and approved
environment contract. Stop and park succeeded. The accepted native snapshot
response used `Msg.backup.graph_id`, while the controller required a top-level
`id`; that deterministic decoding error prevented publication. The original
result remains false. Its single acknowledged snapshot was confirmed by GET
on the exact owned volume and was still incomplete at the recorded checks.

A strict decoder now supports the observed and legacy acknowledgement shapes.
A separate GET-only finalization operation can verify the original complete
transaction, current exact parked identity, strict snapshot readiness and lease
release before publishing new authority. Independent adversarial review found
and fixed weak snapshot-completion and original-producer checks. No snapshot
POST or guest attempt is repeated; native finalization and the remaining full
deployment/parallel campaign validation are still required.

The user explicitly authorized this separate pre-parent-merge repair and full
deploy. They require genuine parallel independent smoke campaigns, no app-wide
quiet window, original unchanged receipts, exact source/image/volume ownership,
fail-closed unknown authority, measured capacity and normal admission. Protected
shared and foreign per-dependency sources and all old debts remain untouched.

## Reusable lesson

Prepare immutable fleet inputs under exact owned-resource authority without mutating shared app state or requiring unrelated lifecycles to remain idle.
