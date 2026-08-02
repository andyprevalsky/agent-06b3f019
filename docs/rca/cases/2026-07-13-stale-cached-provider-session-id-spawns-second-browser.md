---
id: 2026-07-13-stale-cached-provider-session-id-spawns-second-browser
date: 2026-07-13
title: A refreshed provider session during auth handoff left the resumed browser activity with a stale cached session ID, so it created a replacement session and a second Kernel profile writer
surface: agents
component: browser-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the resumed browser activity trusted its cached provider session ID instead of the backend-validated live session after the auth page refreshed it
symptoms:
  - two browser agents exist after an authentication-assistance handoff
  - a second Kernel profile writer is launched on browser resume
  - "Expected mock to not have been awaited. Awaited 1 times."
tags:
  - browser-agent
  - kernel
  - session-resume
  - auth-handoff
  - stale-cache
sources:
  - PR #762
repro: none-recorded
status: fixed
---

## Problem

When a browser task handed control to the user for authentication and the auth
page refreshed its provider session, resuming the task did not reuse the live
session. It created a replacement session, which also launched a second Kernel
profile writer — leaving two browser agents where there should be exactly one.
The pre-fix regression fails with `Expected mock to not have been awaited.
Awaited 1 times.` on the replacement-session creation call.

## Diagnosis

Two views of "which session is current" disagreed after handoff. The backend had
a validated live session whose CDP URL had changed because the auth page
refreshed the provider session; the resumed browser activity still held the
provider session ID it had cached before the handoff. Because the resume path
treated its own cached ID as authoritative, it concluded the session was gone and
took the replacement-session branch, duplicating both the session and the profile
writer. The owned defect is the missing rule that the backend-validated live
session wins over any cached provider identifier across a suspension boundary.

## Solution

The resume path now reuses the backend-validated live browser session when the
auth page refreshed the provider session during handoff, selecting the refreshed
CDP URL, and never calls replacement-session creation in that case. A regression
proves the same browser task picks the refreshed CDP URL and leaves
replacement-session creation unawaited; a second assertion pins that there is
exactly one browser agent before and after the assistance handoff. The
regression is the back-end browser auth-resume/session blackbox (exact path not
recorded in the source). Verified on the exact commit `50d45cc52` with 7/7
synchronized cloud tasks.

## Human feedback

None recorded.

## Reusable lesson

After any suspension that a third party can mutate through (user auth handoff,
approval wait), re-resolve the live resource from the authoritative backend
record — never resume on a cached provider session ID.
