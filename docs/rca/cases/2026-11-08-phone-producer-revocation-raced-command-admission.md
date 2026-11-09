---
id: 2026-11-08-phone-producer-revocation-raced-command-admission
date: 2026-11-08
title: Proposed producer revocation policy conflicted with normal phone setup retirement
surface: back-end
component: iphone-execution-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.availability.ts configurationGenerationCurrent and repo.executionCustody.ts executionCustody
symptoms:
  - Producer revocation was not serialized with admission
  - Revoked borrowed saved credential operation returned SUCCEEDED
tags:
  - phone-harness
  - generation-fence
  - race
  - credential-binding
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/iphone-control.continuity.cases.ts
status: superseded
---

## Policy correction after normal-retirement reproduction

The original report below records the proposed v4 policy, not a confirmed
requirement that a completed setup actor remain live forever. Its synthetic
producer-revocation RED/GREEN evidence is preserved, but it does not establish
unauthorized phone use after committed configuration facts outlive that actor.
A subsequent registered owning case executes the real terminal cleanup for a
COMPLETED setup producer. Cleanup seals its workflow and clears its first-run
ID; v4 then incorrectly changed the connection from ready to not_connected.

Committed device/account/profile configuration now retains the setup producer
as immutable provenance. The in-progress verifier still fences its true first
run before committing facts. Every action still checks the current borrower,
lease, task, true first run, current phone/account, profile and privacy state.
Explicit sign-out, profile changes and user handback invalidate configuration;
normal producer retirement does not. No deployment-sealed ID allowlist exists.
The special saved-credential regression now revokes the CURRENT BORROWER after
its verifier, and requires FAILED with zero synthetic input calls. The old
producer policy tests are transparently migrated, not unchanged-test proof.

Historical evidence remains under round43-producer-owning/red-v2 and green-v2;
normal-retirement RED and GREEN, and nine final API cases, are separately
recorded in retirement-red, retirement-green and attestation-nine. No normal
production acceptance or permission to reset the phone is implied.

## Historical v4 report (superseded lifetime policy)

## Problem

Completed-setup reuse introduced distinct producer and borrower identities.
Reading the completed producer without locking it allowed generation revocation
to race admission. Special saved-credential, message and passcode paths also
used `executionCustody` without checking the completed producer at their final
admission boundary.

The owning synthetic HTTP reproduction confirmed the credential path: after
semantic verification, revoking the original producer still allowed a synthetic
saved credential to be filled. No real phone, password, account, money operation
or external verifier was used.

## Diagnosis

Independent source review first identified the two interleavings. Registered
cases then reproduced both under actual local PostgreSQL and the normal phone
HTTP harness. Without the two fixes, the original assertions failed 0/2: a
producer UPDATE was not blocked by admission, and the credential operation
returned `SUCCEEDED` instead of `FAILED` after producer revocation. With exactly
the same cases and fixes restored, both passed 2/2. The latter operation made
zero input calls to the injected synthetic phone.

The first attempt at the new credential case omitted its required cursor and
never reached the verifier. Those failed diagnostic records remain preserved
and are explicitly invalid reproduction evidence. The corrected case asserts
HTTP 200 and one verifier invocation before judging the revocation result.

The lock test checks PostgreSQL's actual `pg_blocking_pids` relation while the
admitting transaction remains open, then releases it and verifies that the
producer update completes and subsequent availability is denied. Explicit
integer casts are required for Prisma's bound PID parameters.

## Solution

Lock the exact producer Agent row `FOR SHARE` before reading its execution
generation. PostgreSQL UPDATE/DELETE waits for that transaction to commit.
Check availability again inside `executionCustody`, under the caller's existing
device lock, so the special credential/message/passcode execution paths also
retain this producer lock through admission. Preserve the independent current
borrower, task, cursor, profile, privacy and lease checks.

The repair remains registered through iphone-control's existing case list and
the normal backend blackbox gate. The narrow diagnostic imported those exact
Case actions into a temporary normal-runner domain, then archived and removed
the wrapper. Both unique databases were dropped only after the normal teardown
finished, ports were free and database connections were zero.

This adds no global lock or service. At 10k agents, independent phones use
independent device/agent rows, and producer readers share their row lock. Existing
transaction retry behavior is unchanged. Exact-snapshot behavior review and
whole-source/production validation remain required; scoped causal proof is not
deployment acceptance.

## Human feedback

The user requires account isolation, exclusive access, current task authority and
reusable setup. Independent review identified the special-path gap after the
initial normal-path lock fix. No permission, timeout or assertion was weakened.

## Reusable lesson

When persistent configuration and its consumer have different owners, serialize
both identities at every execution-admission path, including specialized tools.
