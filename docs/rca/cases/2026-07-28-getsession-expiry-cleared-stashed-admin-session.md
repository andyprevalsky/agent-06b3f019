---
id: 2026-07-28-getsession-expiry-cleared-stashed-admin-session
date: 2026-07-28
title: getSession()'s expiry branch called clearSession(), deleting the stashed admin session and stranding the impersonating admin
surface: cross
component: admin-impersonation-session
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "getSession() — a read path whose expiry branch called clearSession() → clearImpersonationState(), destroying the stashed admin session"
symptoms:
  - '"no floating chip, and I can''t access any admin views"'
  - admin loses the account-switcher pill the moment an impersonated session expires
  - getSession() returns null and the impersonation keys are wiped with no way back
tags:
  - impersonation
  - admin
  - session-expiry
  - destructive-read
  - regression
sources:
  - PR #911
repro: none-recorded
status: fixed
---

## Problem

While an administrator was switched into another account, the moment the active
session lapsed the admin was stranded: the account-switcher pill disappeared and
every admin-gated call started failing at the same time, with no path back to the
administrator identity. Reported by the user as "no floating chip, and I can't
access any admin views".

## Diagnosis

`getSession()` is semantically a _read_, but its expiry branch called
`clearSession()`, which calls `clearImpersonationState()` and deletes the stashed
admin session. That stash is the only record of who the administrator was before
the account switch, so the read that merely _noticed_ expiry also destroyed the
sole recovery artifact — explaining why both symptoms (missing pill, all
admin-gated calls failing) appeared simultaneously rather than one at a time. The
deeper owned cause is a read performing an unbounded destructive write on shared
recovery state. The defect was latent until PR #910 (a CodeRabbit security fix)
shortened impersonated sessions from 90 days to 1 hour, which moved expiry from
"effectively never during a session" to "routinely, mid-use".

## Solution

`getSession()` now **unwinds** instead of clearing: an expired session with a live
stash restores the administrator and drops the impersonation bookkeeping. It still
clears fully when the stash is missing, unparseable, or itself expired. Backed by a
genuine session repro that fails against the pre-fix code (`getSession()` returns
`null` and the impersonation keys are wiped) and passes with the fix. Generalizes
to any expiry handler over layered identities: expiry of the inner session should
pop to the outer one, not wipe the stack.

## Human feedback

The user reported the two symptoms together — "no floating chip, and I can't
access any admin views" — which is what identified a single shared cause (the
deleted stash) rather than two independent UI/authorization bugs. No other
correction is recorded.

## Reusable lesson

Never let a read-shaped accessor delete recovery state on expiry — unwind to the
stashed outer identity and only clear when that stash is itself unusable.
