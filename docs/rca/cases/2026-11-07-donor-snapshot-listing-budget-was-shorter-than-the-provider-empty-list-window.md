---
id: 2026-11-07-donor-snapshot-listing-budget-was-shorter-than-the-provider-empty-list-window
date: 2026-11-07
title: A smoke controller exhausted its 45 s donor snapshot read budget inside a provider window that answers a valid empty list, and the campaign infra stop cancelled the other eight
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/run-bench-fleet read the donor volume's snapshot list at most 6 times over 45 s and treated the last valid but empty list as "No complete snapshot"; Fly's snapshot listing answered an empty list for minutes
symptoms:
  - "No complete snapshot for warm volume vol_vwnym366kn7k8mmv. Create one and wait for it to finish"
  - "INFRA STOP: 1/9 scheduled jobs are confirmed infrastructure failures (>= 5%); breach at r001-j0002 (INFRA_ERROR)"
  - all 9 smoke cases UNVERIFIED with a native cleanup owner the staged cycle could not reconcile
tags:
  - cloudbench
  - smoke
  - fly
  - retry-budget
sources:
  - PR #1744
repro: scripts/tests/cloudbench-env.test.sh runs the extracted list_donor_snapshots against a stubbed provider (5 empty lists then a snapshot, 3 invalid replies then a snapshot, endless empty and endless invalid lists); the provider behaviour itself was reproduced at 07:05Z with the identical flyctl command, 8 of 9 concurrent reads and 3 of 4 sequential reads returning exit 0 and `[]` in about 0.7 s
status: fixed
---

## Problem

During the first staged smoke on this branch, one of nine concurrent controllers (chat-mode) failed before any guest was
forked while eight siblings resolved the same recorded snapshot in the same seconds. The campaign's stop rule (one infra failure of
nine scheduled jobs) then terminated the other eight, leaving every case UNVERIFIED. Gate: NOT_INTRODUCED for the changed
product code; the controller's read budget is the defect.

## Diagnosis

The listing command returned a valid empty list intermittently for a few minutes (never an error), which the controller's existing
guard ("a valid empty list is not proof of no snapshot") retried only six times with 3 to 15 s pauses. After 07:07Z 28 of 28 reads
were healthy again, so a longer budget outlasts the window. Nothing was allocated or leaked on Fly.

## Solution

The read is now `list_donor_snapshots`: up to 12 reads with 5 s steps capped at 30 s plus up to 3 s of jitter (about four
minutes), the same completed-snapshot selector, the same fail-closed messages, and the failure text now states how many reads were
made and how many snapshots the last valid read held. A stubbed-provider regression executes the real function. The refactor also moved the loop out of the block that the
private-source fixture in `cloudbench_dependency_sync_test.py` replays by extraction, so `test_private_fleet_source_keeps_shared_default`
failed with `list_donor_snapshots: command not found` (INTRODUCED by this change, caught by the agents `benchmark` domain); the
fixture now extracts the helper as well.

## Human feedback

The deploy coordinator named the retry-budget gap as the likely cause of a repeat smoke failure under contention.

## Reusable lesson

A retry guard for a provider that can answer "valid but empty" must be sized to the observed length of the degraded window, and a
single-job infra stop makes a short budget a whole-campaign failure.


## Recurrence: pinned private-source validation bypassed the consistency reader (2026-11-11)

Frozen `6dba99e836331e74cca0ee57be320e9f83a1c17d` smoke request
`88cb5d7a01134dc3aea9884efc8b5b3f` stopped before task admission when the
background-message controller's private source preflight reported
`snapshot identity missing or duplicate`. App-env and seed validation had passed.
The source manifest and its pinned snapshot remained immutable; the failed
original list payload was not retained, so zero versus duplicate matches in
that exact old reply remains UNRECORDED. This limitation is not an expiry,
deletion, pagination, credential or provider-outage conclusion.

A new finite read-only reproduction captured the same selected approved input
credential, exact Volume/snapshot IDs, CLI binary hash, stdout/stderr, status and
clocks. Of 15 concurrent CLI reads, twelve returned exit 0 and literal `[]`,
while three returned two records containing the exact unique created snapshot.
A paired 15-read native API reproduction also returned twelve literal `[]`
bodies and three healthy two-row lists, all HTTP 200. Both empty reply bodies
hash to `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`.
Thus switching CLI transports would not repair this measured boundary. The
primary API schema lists all snapshots with only app and Volume path parameters;
no pagination parameter was found. The retained supervisor environment, original
request-matching dotenv files and approved capsule select the same credential
input hash. The expired coordinator PID and old child CLI binary/body remain
explicit evidence gaps, not evidence of a different identity.

The existing `list_donor_snapshots` path already documents and bounds empty-list
reobservation. The new private-source path bypassed it with one enumeration.
The narrow repair applies its same twelve-attempt, 5-to-30-second backoff and
0-to-3-second jitter envelope only to pinned private-source validation, under
one original controller deadline and any earlier campaign monotonic deadline.
Every actual read is bounded by the existing `fly_with_timeout` with at most
20 seconds or the remaining original budget. Only an exit-zero, well-formed
empty array permits another read. Nonempty wrong or duplicate identities,
malformed payloads, provider errors, manifest changes and lost source guardians
refuse. After a positive unique observation, fresh Machine and Volume inventories
feed unchanged `SOURCE.verify`; snapshot completeness, time, owner, image,
instance, mount, environment and capsule guards remain mandatory. The original
donor reader, source helper, lease helper and producer closure are unchanged.

Each read and its status, argv, clock, manifest and selected-input fingerprints
are retained in a create-only private owner/run journal beneath the canonical
Git directory. Raw records are 0600 beneath 0700 directories; they survive normal
fleet-registry retirement and are outside run/Hub artifact trees. The existing
timeout wrapper combines CLI stdout/stderr; records label this combined channel
truthfully rather than inventing separate stdout or native HTTP evidence.

The registered owning replay uses the actual captured empty and healthy bodies,
the actual fleet function and timeout wrapper, and the real unchanged SOURCE
validator. It fails at the original snapshot-identity guard on the old source
and passes on the candidate. Only provider calls, delay and the guardian boundary
are explicitly modeled; this is not live-source qualification. Persistent empty
lists exhaust exactly twelve reads, and deadline, duplicate, wrong-target,
malformed, provider-exit, manifest, native owner and lost-guardian controls refuse.
Private mode/secret-canary, journal persistence and symlink/reuse controls pass.
All 18 registered source-lease fleet tests pass locally. Earlier scratch fixture
syntax and noclobber/timeout integration failures are retained separately and
are not counted as the causal RED. The original failed campaign remains failed;
a separately authorized real read-loop observation and unchanged ordinary new
cohort are still required before claiming the native outcome repaired.

Coordinator constraints for this recurrence: preserve strict unique pinned
snapshot validation, original clocks and concurrency; no snapshot remint,
deduplication, newest-snapshot adoption, claim bypass or historical task credit.


The pre-apply compatibility check also caught an extracted older private-source
fixture that omitted the new journal owner/run/deadline context. Its unchanged
positive case passed on the original source and failed before validation on the
candidate with `FLEET_OWNER_TOKEN: unbound variable`. The fixture now declares its
synthetic operation and one original 20-second deadline, and uses the actual
existing timeout wrapper rather than its prior pass-through stub. Every original
assertion and outer test timeout is unchanged. Invalid observation errors retain
the existing public SOURCE error prefix; production gains no missing-context
fallback or clock reset. This fixture failure was found locally before apply,
not attributed to the original native campaign.
