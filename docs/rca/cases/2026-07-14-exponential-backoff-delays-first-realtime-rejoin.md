---
id: 2026-07-14-exponential-backoff-delays-first-realtime-rejoin
date: 2026-07-14
title: Realtime reconnect applied exponential backoff to the very first drop, so agent updates stalled for the whole backoff
surface: front-end
component: realtime-transport
classification: our-bug
problem_class: other
first_bad_boundary: scheduleReconnect — waited 1000·2^attempt ms before the first resubscribe, which is also what backfills missed messages
symptoms:
  - agent detail shows no updates for a while then catches up
  - "CHANNEL_ERROR" on the first join of the agent:<id> channel, then self-heals
  - visible update latency equals time-to-reconnect
tags:
  - supabase-realtime
  - reconnect
  - backoff
  - channel-error
  - agent-updates
sources:
  - PR #777
  - memory:project_fe_realtime_channel_error_rca
repro: front-end/src/tests/blackbox/realtime-transport.blackbox.ts
status: fixed
---

## Problem

The FE agent realtime `agent:<id>` channel intermittently failed its first join
with `CHANNEL_ERROR` and then self-healed. Users saw "no updates for a while"
followed by a catch-up: the visible update latency was exactly the time to
reconnect, because the resubscribe is also what backfills missed messages.

## Diagnosis

`scheduleReconnect` waited `1000·2^attempt` ms (1s, doubling to a 30s cap)
_before_ the first resubscribe attempt. So a single transient join failure — the
common case, which recovers instantly — cost at minimum a full second of dead
channel, and repeated failures escalated into tens of seconds of missing updates.
Backoff exists to protect a struggling server from a hammering client; applying
it to attempt #1 pays the cost with none of the benefit. A contributing defect
made the initial join fail more often than it should have: a redundant
per-channel `supabase.realtime.setAuth()` call ran on every subscription even
though the normal app flow already gates on `realtimeReady` (token bound), so the
call was a no-op that churned the shared socket mid-connect.

## Solution

The first reconnect attempt now fires at 0ms; exponential backoff plus jitter
applies only to repeated _consecutive_ failures and resets on success. The
redundant `setAuth()` is gated to run only when realtime is not yet initialized,
kept as a fallback for early callers so no caller regresses. At 10k agents the
change matters in the right direction: per-agent channels reconnect immediately
and independently, while sustained failure still degrades into jittered backoff
rather than a synchronized retry storm.

## Human feedback

None recorded.

## Reusable lesson

Never apply exponential backoff to the first retry — reconnect immediately and
start backing off only on consecutive failures, or every transient drop becomes a
multi-second data gap.
