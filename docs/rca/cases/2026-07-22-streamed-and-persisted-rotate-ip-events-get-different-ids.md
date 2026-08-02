---
id: 2026-07-22-streamed-and-persisted-rotate-ip-events-get-different-ids
date: 2026-07-22
title: The streamed and persisted rotate_ip events could be assigned different call IDs, so the frontend rendered two progress tools
surface: cross
component: browser-agent-chip
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the backend minted a new call ID for the persisted `rotate_ip` event instead of reusing the streamed call ID
symptoms:
  - two `rotate_ip` progress tools rendered for one rotation
  - a late-arriving persisted rotate_ip event appears alongside the streamed one
tags:
  - browser-agent
  - rotate-ip
  - streaming
  - persistence
  - duplicate-tool
  - toolcallid
sources:
  - PR #854
repro: front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts
status: fixed
---

## Problem

One IP rotation showed up as two `rotate_ip` progress tools in the UI: one from
the live stream and one from the persisted tool-call record.

## Diagnosis

The same rotation is reported twice by design — once as a streaming event for
immediate feedback and once as a persisted event for durability — but the two
paths generated their identifiers independently, so they could disagree. To the
frontend, two different call IDs are two different tools, and the late persisted
arrival was rendered as an extra progress chip. The owned defect is that a
single logical event had two ID-minting sites instead of one.

## Solution

The backend now reuses the streamed call ID when persisting the event, so both
representations carry one stable identity, and the frontend coalesces the late
persisted arrival into the existing entry rather than appending it. Result: one
stable `rotate_ip` lifecycle per rotation, including for late persisted
tool-call events. Covered by the `rotate_ip progress lifecycle` regressions in
`front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts`.

## Human feedback

None recorded.

## Reusable lesson

When one logical event is emitted on both a streaming and a persisted path, mint
its ID once and reuse it — dual ID generation always surfaces as a duplicated UI
element.
