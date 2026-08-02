---
id: 2026-07-28-invite-gate-derived-from-impersonated-session
date: 2026-07-28
title: isFullySignedIn was derived from the impersonated account's invite state, so an admin inherited the target's signup gate
surface: front-end
component: invite-gate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: updateInviteStatus / checkNeedsInviteCode() — evaluated for the currently ACTIVE session rather than the operator
symptoms:
  - after switching accounts the omnipresent switcher pill is gone
  - admin views unreachable while impersonating
  - messages can't be sent to the switched-into account
  - 'full-screen blackout from DialogOverlay "fixed inset-0 z-50 bg-black/80"'
tags:
  - front-end
  - impersonation
  - waitlist-gate
  - admin
  - auth
sources:
  - commit b70797e0f
repro: none-recorded
status: fixed
---

## Problem

Reported twice by the user: after switching accounts, the omnipresent switcher pill
disappears, admin views are unreachable, and messages can't be sent to the
switched-into account. A previous fix had addressed only session **expiry**, which
is why it did not help — this is the immediate post-switch path.

## Diagnosis

`isFullySignedIn` is derived from `checkNeedsInviteCode()` for the CURRENTLY ACTIVE
session. After switching, that is the target account, so an admin who switched into
any account that has not redeemed an invite code inherited that account's signup
state. `isFullySignedIn` is the app-wide capability flag, so one false value produced
all three reported symptoms at once:

- `useMessageSending:270` refuses to send while it is false → "can't message"
- `useTerminalAgents:35` refuses to submit goals
- `Terminal:60` renders with a null user
- `WaitlistGate` opens its modal, whose `DialogOverlay` is
  `fixed inset-0 z-50 bg-black/80` — a full-screen blackout rendered even with
  `modal={false}`

It is explicitly NOT an RLS problem: the minted session is a real Supabase JWT for
the target user and the backend was answering correctly. The category error is
conflating "has THIS account signed up?" with "may this operator use the app?".

## Solution

Fixed at the source: `updateInviteStatus` treats an impersonating operator as fully
signed in. `WaitlistGate` also refuses to open while impersonating as defence in
depth, because the invite-check catch path sets `isFullySignedIn(false)` on any
network error and would otherwise re-trap the admin. Both new cases FAIL on the
pre-fix revision (waitlist modal present; `isFullySignedIn` false) and pass after.
front-end 2185/2185, tsc + lint clean.

## Human feedback

The user reported the same breakage twice, and the second report established that
the earlier session-expiry fix was aimed at the wrong path — the failure is on the
immediate post-switch path, not on expiry.

## Reusable lesson

Never derive an operator-capability flag from the impersonated session's onboarding
state — scope signup/invite questions to the inspected account and keep operator
capability tied to the operator.
