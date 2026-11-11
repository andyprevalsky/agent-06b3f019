---
id: 2026-11-11-meeting-oauth-callback-missing-generation-fence
date: 2026-11-11
title: Older meeting-provider OAuth callbacks overwrote newer sign-ins after consuming pending state
surface: back-end
component: meeting-sync
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: meetingSync.ts completeSignIn replaced config after remote calls without checking the sign-in generation or row identity
symptoms:
  - STATE_INVALID
  - newer pending state survives callback A
  - superseded callback rejected
  - Record to update not found
tags:
  - oauth
  - granola
  - fireflies
  - concurrency
sources:
  - commit b1e38501aabca337bc2525488e3d70bcacc36999
  - agent ph7fmpbtnmb3pj3wsckfmqqtts8j06rz
repro: back-end/src/tests/blackbox/fireflies-sync.blackbox.ts
status: fixed
---

## Problem

Independent review of the new shared meeting-provider sync found an inherited
Granola race. Callback A consumed its pending state and waited on provider calls.
A newer sign-in B could start or complete while A waited; A then overwrote B's
config. Disconnect during the wait could also cause a Prisma record-not-found
error or let A overwrite a recreated connection.

## Diagnosis

Path: OAuth start → persisted pending state → authenticated callback consumes
pending → remote token/account calls → unconditional config replacement. The
first-bad boundary was the unfenced post-network write. Deterministic provider
fetch interleavings exercised both Granola and Fireflies: newer pending state
became undefined, superseded callbacks succeeded rather than STATE_INVALID, and
disconnect produced Prisma Record to update not found. Archive searches used
OAuth STATE_INVALID callback/concurrent-grant vocabulary and found related shared
OAuth grant cases, but no matching callback-generation cause. This is a relative,
not a recurrence. No specific failing agent or report_bug was involved; evidence
is an executed owning-boundary interleaving reproduction.

## Solution

Persist a sign-in generation when starting OAuth with one atomic upsert. Consuming
pending retains its generation and captures the state-row identity. After remote
calls, lock the state row and verify both generation and row ID before committing
tokens, integration status, or account-switch deletion. A newer start, consumed
newer callback, completed callback, disconnect or delete/recreate rejects the
stale completion. Existing refresh writes merge only their own JSON field.

Before: `BACKEND_CODEX_TOKEN_SYNC_SKIP=1 BACKEND_CLAUDE_TOKEN_SYNC_SKIP=1 bash
back-end/scripts/run-blackbox-tests.sh granola-sync,fireflies-sync` failed on the
new unchanged interleaving cases with newer pending undefined and stale callback
success. After: the identical command and cases pass; five consecutive final
runs passed both domains. Independent read-only review found no further findings.
Permanent cases live in the deploy-discovered Fireflies domain and run both
provider implementations through the shared pipeline.

No new per-agent subscriptions, loops or shared global counters are introduced
at 10k agents. The indexed per-user/provider row is locked only for local commit;
provider/network calls remain outside the transaction. State generation adds one
small JSON field and uses the existing account-scoped sync coordination boundary.

## Human feedback

None recorded.

## Reusable lesson

Fence post-network OAuth completion with both a persisted sign-in generation and the state-row identity before replacing credentials or account data.
