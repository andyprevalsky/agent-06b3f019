---
id: 2026-10-21-production-preview-private-realtime
date: 2026-10-21
title: Production API preview joined public realtime channels instead of private channels
surface: front-end
component: production-preview.config.ts
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: production API preview inherited the ordinary Vite DEV realtime default
symptoms:
  - UI updates require refresh
  - Supabase websocket appears connected but broadcasts are missing
tags:
  - realtime
  - private-channels
  - production-preview
sources:
  - commit 130b5b7d4bf1560ab3655b82ca7cbbd1f8d04cdc
  - agent ph7erx59v4y5qfrxncmmtzzkfn8gngm8
repro: front-end/src/tests/structural/production-preview-realtime.test.ts
status: mitigated
---

## Problem

The user reported that apparently all UI updates required refresh and suspected
Supabase rejected the preview's foreign origin. A diagnostic subscription from
the actual HTTPS preview origin returned SUBSCRIBED; its evaluated realtime
setting was false. An existing page also had an OPEN production Supabase socket.
Vite HMR independently returned connected. These observations do not establish
receipt of a particular selected-agent INSERT.

## Diagnosis

The ordinary development config intentionally defaults to public channels for
local stacks. The interactive preview uses that config but proxies its API to
production. Production supabaseBroadcast marks messages private. Public and
private channels with the same topic are distinct namespaces. The first owned
mismatch is the preview profile inheriting the local-stack default, rather than
an evidenced origin rejection.

The permanent test uses the actual Supabase RealtimeClient and a local WebSocket
server with explicit private/public namespace delivery. With the original empty
preview defines it joins public (false) and fails the private-join assertion;
with the explicit private define the identical test receives its INSERT and
passes. Initial test harness failures (missing fixture API key, strict MSW
loopback handling, Phoenix frame serialization) are retained separately from
the final causal red/green pair. No production data is written by this test.

## Solution

Provide a named production-API Vite preview config that explicitly selects
private realtime channels. Keep the ordinary local-development default and its
existing tests unchanged. Use that profile for the owned production-API preview;
no production environment, backend authorization, channel policy or polling
changes are needed. This adds no per-agent work or subscriptions.

Status is mitigated until an authoritative message ID from the user's affected
agent is observed arriving and rendering without refresh. The current screenshot
agent/task identity is not available; the shared browser is signed out. Do not
turn a successful diagnostic public join into a claim of private agent delivery.

## Human feedback

The user reported stale updates across the UI and suspected foreign-origin
rejection. Preserve that report while distinguishing it from the proven preview
namespace mismatch. Do not require a refresh for each subsequent update.

## Reusable lesson

A connected socket does not prove topic delivery: match the broadcaster's
private/public namespace and verify a specific authoritative event end to end.
