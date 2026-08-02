---
id: 2026-07-14-realtime-join-error-reason-discarded
date: 2026-07-14
title: subscribeToChannel discarded the realtime join-error argument, making CHANNEL_ERROR undiagnosable
surface: front-end
component: realtime-transport
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: subscribeToChannel — the second `err` arg realtime-js passes on CHANNEL_ERROR/TIMED_OUT was dropped
symptoms:
  - console logs a bare "CHANNEL_ERROR" with no reason
  - cannot distinguish auth/RLS rejection from a transport drop
  - "Channel error" surfaced instead of the phx_join error reply
tags:
  - supabase-realtime
  - observability
  - channel-error
  - error-propagation
  - rls
sources:
  - PR #777
  - memory:project_fe_realtime_channel_error_rca
repro: front-end/src/tests/blackbox/realtime-transport.blackbox.ts
status: fixed
---

## Problem

When an agent realtime channel failed to join, the only evidence was a bare
`CHANNEL_ERROR` in the console. There was no way to tell an auth/RLS rejection
from a transport drop, which blocked the root-causing of the intermittent
`agent:<id>` join failures.

## Diagnosis

`realtime-js` passes a second `err` argument on `CHANNEL_ERROR`/`TIMED_OUT`
containing the `phx_join` error reply or the transport reason.
`subscribeToChannel` ignored that argument entirely, so the actual cause was
destroyed at the boundary where it was first available and every downstream log
could only report the generic status. This is a pure observability gap rather than
a behavioral bug — but it is what made the accompanying reconnect investigation
theory-driven, and the record explicitly notes the deeper manual-token-mode
finding remains unconfirmed _because_ this reason was never captured.

## Solution

`subscribeToChannel` now captures and surfaces the join-error reason on
`CHANNEL_ERROR`/`TIMED_OUT` instead of discarding it, plus clearer messages for
subscription timeouts. Cemented by a `realtime-transport.blackbox.ts` case
asserting the join-error reason (`access denied`) propagates rather than a bare
"Channel error"; the mock in `setup.ts` rejects `phx_join` for topics containing
`deny-join`. The test fails on the old code and passes now. The new logging is
the designated diagnostic for confirming the still-open manual-token-mode
hypothesis behind the "after a while" cases.

## Human feedback

None recorded.

## Reusable lesson

If a callback hands you an error argument, propagate it — a status code without
its reason turns a five-minute diagnosis into a multi-PR investigation.
