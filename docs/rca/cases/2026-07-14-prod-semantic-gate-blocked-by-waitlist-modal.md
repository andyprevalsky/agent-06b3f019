---
id: 2026-07-14-prod-semantic-gate-blocked-by-waitlist-modal
date: 2026-07-14
title: Prod semantic ratchet failed 30/30 because the test user had no redeemed invite code and hit the waitlist modal
surface: harness
component: semantic-gate
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/tests-e2e/chat-lifecycle-latency.spec.ts — never bypassed the invite-code/waitlist gate before submitting a goal
symptoms:
  - "screen: page.waitForURL timeout with no ?agent-id navigation"
  - "You're On The Waitlist! modal appears instead of an agent being created"
  - chat-lifecycle-ratchet gate red on all 30 samples
tags:
  - playwright
  - semantic-gate
  - waitlist
  - invite-code
  - test-fixture
  - prod-gate
sources:
  - PR #775
repro: front-end/tests-e2e/chat-lifecycle-latency.spec.ts
status: fixed
---

## Problem

The production semantic gate (`chat-lifecycle-ratchet.yml`) ran for the first time
after #774 unblocked the Node 20 WebSocket problem, and **all 30 samples** failed at
the very first milestone with a `page.waitForURL` timeout — the browser never
navigated to a `?agent-id` URL. The cause was visible in the UI: submitting a goal
raised the "You're On The Waitlist!" modal instead of creating an agent.

## Diagnosis

The gate's session user has no redeemed invite code, and prod gates agent creation
server-side on `User.usedInviteCode`. `chat-lifecycle-latency.spec.ts` never
bypassed the waitlist, so the very first user action was intercepted by product
gating and no agent could be created — the failure was a fixture/environment
mismatch in the test, not a regression in chat. A sibling spec
(`cloud-agent-lifecycle.spec.ts`) already had the bypass, so the harness had an
established pattern this spec simply did not adopt.

## Solution

Mocked `/api/invite-codes/check` to return `{ needsInviteCode: false }` in
`chat-lifecycle-latency.spec.ts`, matching the existing Playwright bypass used by
`cloud-agent-lifecycle.spec.ts`. The invite-gated onboarding path remains covered
by `login.spec.ts`, so the bypass does not lose coverage of the gate itself. The
change is test-harness-only, with no app runtime affected.

## Human feedback

None recorded.

## Reusable lesson

When every sample of a prod gate fails at the first navigation, check for product
gating on the test user before suspecting the feature — and reuse the bypass the
sibling spec already established.
