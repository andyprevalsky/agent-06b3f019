---
id: 2026-11-16-phone-fifo-promotion-omitted-borrower-custody
date: 2026-11-16
title: FIFO phone promotion committed an active lease without binding its borrower
surface: back-end
component: iphone-lease-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.ts admit committed ACTIVE without ensureSetup binding the promoted task
symptoms:
  - Phone capability unavailable or revoked
  - Phone is in use by agent 20440423-026a-584f-aed1-dbd59d6dc693
  - FIFO promotion must bind successor custody before its availability preflight
tags:
  - phone-harness
  - fifo
  - execution-custody
sources:
  - agent 2b33f46b-efc6-4ef8-b277-217daffc4c7d
  - commit 453dddb5c4b88b6f9e261c70f2f20c58f72b127c
repro: back-end/src/tests/blackbox/iphone-fifo-admission.blackbox.ts
status: fixed
---

## Problem

Phone-only task 3024ef4c-43a5-5991-b211-1f5de9db55e0 first received
WAITING at queue position 1, cursor 0 and lastOperation null. The holder was
20440423-026a-584f-aed1-dbd59d6dc693, lease a3bc5bc5-9028-48fc-b26a-d25a73bfd08b.
The successor lease was 3b5626dd-36c3-4ac3-b6eb-939f210c683f. Tool message
ba0e76fe-b0b3-4c2e-8ef8-c7a723a91700 at 2026-11-16T06:10:20.953Z returned
“Phone capability unavailable or revoked” for a status request. The retained
trajectory shows two unsuccessful screen reads and fourteen status requests
through step 17. No phone UI action had executed. Later waits and completion
attempts did not supply the missing phone evidence.

The separate “Retained output not found” request used an all-zero output ID;
it is not evidence that an existing retained result disappeared.

## Diagnosis

Path: old-holder release -> admit FIFO successor -> availability preflight ->
interaction observation -> phone operation. Admission changed the lease to ACTIVE
but left setup.attempt bound to the old holder. The release response reads the
OLD lease, so the usual view -> ensureSetup path did not initialize the successor.
The worker checks availability before reading the successor interaction.
Availability correctly refuses an ACTIVE lease whose currentBorrower identity
does not match setup.attempt. This prevented the read that would have established
that identity. Authorization is not the layer to weaken; the incomplete admission
transaction is the first bad boundary.

A local reproduction exercises the real HTTP routes, PostgreSQL and existing
synthetic provider. It queues a task behind a configured holder, releases the
holder, confirms successor ACTIVE, then queries availability BEFORE any successor
interaction read. Baseline 453dddb5c4 returns enabled:false. The unchanged
registered case passes with admission binding custody in the same transaction.
It also proves queued commands remain 409 with no provider calls, completed
configuration provenance is unchanged, an admitted screen.text succeeds, and a
subsequent borrower first-execution change still disables availability.

Archive searches: “Phone capability unavailable or revoked”, “phone lease WAITING
polling”, and “FIFO promotion currentBorrower”. This is a distinct defect related
to 2026-11-08-phone-configuration-followed-control-session-lifetime: preserve
completed configuration independently of current borrower custody. The superseded
producer-revocation case warns against tying committed facts to a live producer.
The paused-auth and expired-private-phase cases concern other lifecycle boundaries.
Actual project-thread evidence was read from the 1141-thread inventory, including
native setup, DoorDash, cloud_phone_checks, RCA204, RCA118fff32, handback-reset and
cross-lease-continuity owners. RCA204 owns capped-child terminal cleanup, not FIFO
admission. Verifier evidence truncation and intentional user handback invalidation
are separate. Cross-lease setup continuity already owns carrying in-progress
proofs; this repair reuses that logic rather than replacing it.

Production rows confirm the old holder was released at 06:10:12.077 and the
successor promoted at 06:10:12.124, still with cursor 0 and no last operation.
The device remained ready/enabled, provider READY at epoch 55, last updated
06:03:30.067 (before promotion). Render request 711c4ebe0473 for that exact
availability path completed HTTP 200 at 06:10:20.866 in 58 ms, preceding the worker
error at .953. This rules out an HTTP error for the captured availability call.
The later decrypted snapshot at 06:28:14 belongs to a new task admitted at
06:28:03, and is not represented as a snapshot of the failed request. The earlier
device updatedAt predates promotion, confirming no custody binding was committed
for the failed successor. The raw HTTP body was not logged. The generic worker
error alone would not have established this cause.

The independent review identified a second interleaving of the same inconsistent
custody read: under READ COMMITTED, availability can read the old device envelope,
then a promotion commits, then availability reads the new ACTIVE lease. A second
local test reproduced this with real PostgreSQL: an exclusive lease-table lock
pauses the actual HTTP reader at its lease lookup; pg_blocking_pids and the normal
runner's per-domain application_name identify the blocked request before the
promoter commits. No fixed sleep determines ordering. This returned enabled:false
with the atomic writer repair already installed. It is a demonstrated sibling
race, not a claim about the timing of the original eight-second-later denial.

## Solution

Call existing ensureSetup with the just-promoted lease inside admit's existing
device-locked transaction. This covers promotion after release, reconciliation,
cleanup and interaction discovery, regardless of whose response is returned.
Standalone availability now uses a read-only REPEATABLE READ transaction so its
device envelope and lease come from one snapshot. Command/admission callers of
availabilityInTransaction retain their existing device locks and current-state
authorization; discovery is not a command grant. No new permission, fallback,
polling budget, prompt, schema or provider action is introduced. At 10k agents, the extra setup work occurs once per actual promotion
and stays scoped to the existing device lock and single admitted task; no fan-in
or polling work is added.

Registered blocking regression: iphone-fifo-admission.blackbox.ts runs the same
sequential FIFO case plus the concurrent-reader case. It is discovered by the
normal backend runner and maps to backend-blackbox iphone-fifo-admission. The
existing iphone-control suite has a historical whole-suite quarantine, so adding
only its case was insufficient to make this new regression blocking; that
quarantine is preserved and the small new runner has no quarantine wrapper.

Initial identical focused command: bash /tmp/phone-fifo-registered.sh. Before the
writer repair exit 1, assertion “FIFO promotion must bind successor custody before
its availability preflight”; after repair exit 0, plus five consecutive passes.
The final version also checks the worker's subsequent status observation.

Concurrent command: bash /tmp/phone-fifo-blocking.sh. With atomic writer only,
exit 1, assertion “Availability cannot mix pre-promotion custody with a
post-promotion active lease”; with the reader repair, exit 0. A fresh post-commit
availability assertion was added, and five final unchanged-suite repetitions
passed. Private wrappers run the actual registered source on isolated local
PostgreSQL and the existing synthetic provider.

The official iphone-control run exited 0, domain PASS in 259458 ms, with
QUARANTINED_PASS. That run had already loaded the original writer-only source;
it is not presented as validation of the later reader fix. A first dedicated-runner invocation with an arbitrary local database name was
rejected by the runner's workspace-name guard before tests (exit 1); the supported
normal invocation on the workspace database then exited 0:
`cd back-end && bash scripts/run-blackbox-tests.sh iphone-fifo-admission`,
1 domain passed in 2678 ms with no quarantine. Final TypeScript and targeted
ESLint checks passed. The first independent review confirmed the original
boundary and low flakiness risk, and prompted the now-tested consistent-reader
and blocking-gate improvements; follow-up review is pending. This status denotes
the locally verified repair, not a deployed or re-run production outcome. No deployment has
been performed by this delegated investigator.

Golden reference: not applicable to the current ordinary backend transaction fix
(no prompt, Zod schema or worker trajectory hunk); parent deploy scope check remains
responsible for identifying any mandatory approval surface.

## Human feedback

The originating user explicitly required deduplication by actual evidence across
active Bugs and Bug Report work before fixing, rather than matching titles.
The parent assignment required no duplicate holder-cleanup repair, no further
investigation delegation, and no deployment by this worker. The parent also
restricted investigation to logs and synthetic tests; no live phone operations
were performed.

## Reusable lesson

Commit a promoted resource lease and the authorization identity its first preflight
requires together, rather than relying on a later observation to repair custody.
