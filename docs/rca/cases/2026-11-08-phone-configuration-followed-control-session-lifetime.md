---
id: 2026-11-08-phone-configuration-followed-control-session-lifetime
date: 2026-11-08
title: Completed phone configuration was coupled to the current control session and borrower
surface: back-end
component: iphone-setup-continuity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.setup.ts ensureSetup and repo.setupOutcome.ts writeSetupOutcome
symptoms:
  - A configured successor interaction returned 409
  - Runtime refresh rewrote configuration provenance
tags:
  - phone-harness
  - configuration-lifetime
  - execution-custody
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
  - commit 436576b7b05aa7421c597733c3df4f71f6f40eb7
repro: back-end/src/tests/unit/phone-setup-continuity.test.ts
status: fixed
---

## Problem

During Google400 phone integration, replacing a completed setup producer with a
new lease owner invalidated the existing configuration proofs. A confirmed
ordinary control-session stop also advanced the transport epoch. The subsequent
consumer could not use the configured phone. Keeping a completed-producer
snapshot exposed another bug: a runtime-only verification deleted that snapshot.

This is a source repair, not a production or physical acceptance claim. The
original failed API runs remain preserved privately. Normal production phone,
Google approval, messaging, recordings and whole-source release gates are still
required.

## Diagnosis

The original model used one attempt for two different lifetimes: completed device
configuration and current command custody. `ensureSetup` replaced that attempt
when a consumer changed; `writeSetupOutcome` deleted completed configuration even
for a runtime-only result. Runtime itself must be freshly bound to the current
borrower and transport, rather than being read from the original producer.

The registered unit reproduction invoked the actual outcome writer and DTO.
Before the runtime fix it produced 13 passes and one failure, `Runtime refresh
rewrote configuration provenance`. The identical assertion passed after the fix:
14/14 tests. The synthetic four-domain HTTP run then passed iphone,
iphone-interactions and auth-assistance, and 146/147 iphone-control checks. Its
only remaining failure was the newly added producer-lock diagnostic's PostgreSQL
PID argument type; the corrected registered lock test was separately validated.
These scoped observations do not turn that aggregate failed run into PASS.

The old successor test expected setup to become required after complete settings
and an ordinary stop. That expectation conflicts with the user's requested reuse
of completed setup. Its expectation was explicitly migrated to ready reuse while
retaining identity verification and hiding the private setup identifier. The old
failure is preserved; this migration is not unchanged-test repair evidence and
is included in the snapshot-scoped behavior review.

## Solution

Retain a bounded encrypted snapshot of the original completed producer, verified
identity and setting proofs. Keep the active attempt bound to the actual current
lease, task, workflow and true first execution. Project configuration and fresh
current-borrower runtime separately. Runtime-only outcomes do not replace the
completed configuration. Handback, profile/phone changes, semantic auth loss and
producer or consumer generation revocation retain their independent fences.

Only a confirmed stop of the same outstanding control-session key can advance
the transport binding of existing settings. Preserve original observation time,
digest and original observation epoch; expire runtime. The installed provider
contract at `phone_harness/cloud.py:578-584,1397-1401` says ordinary iPhone control
links retain data on the phone. This does not authorize reset, reassignment or a
fresh-observation claim. Golden references opened during review include Codex's
`enterprise_generation.rs:20`, Hermes's `browser_tool_real_profile.py:112` and
OpenClaw's `oauth-shared.ts:45`; final snapshot approval remains separately
required.

Deleting the independent custody lifetime would lose current-owner revocation;
deleting completed facts would recreate the original reuse failure. The bounded
snapshot separates these responsibilities without a new service or schema table.
At 10k agents, lookup and locking remain scoped to the device and relevant agents;
there is no fleet-wide scan.

## Human feedback

The user requires normal Integrations Connect iPhone bootup, reuse after setup,
genuine reauthentication when disconnected, and portrait lock during bootup.
No reset or benchmark substitute is authorized. Independent review found the
runtime snapshot deletion and required producer serialization; both findings
were retained and addressed before release.

## Reusable lesson

Keep completed device facts, current transport state and current actor authority
separate, and never turn transport continuity into a fresh native observation.
