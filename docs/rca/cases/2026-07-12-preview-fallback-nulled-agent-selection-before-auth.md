---
id: 2026-07-12-preview-fallback-nulled-agent-selection-before-auth
date: 2026-07-12
title: The dev/benchmark preview fallback made canLoadAgent true pre-auth, and its failed load nulled the selection and stripped ?agent-id=
surface: front-end
component: agent-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end hooks.ts — clearSelectionOnFailure ran on a pre-auth preview load, not only under full access
symptoms:
  - semantic test fails to load the agent view
  - "?agent-id= is stripped from the URL after load"
  - no realtime subscription is established for the agent
tags:
  - front-end
  - realtime
  - agent-preview
  - semantic-tests
  - auth
sources:
  - memory:project_gate_benchmarks_fe_verification
  - PR #755
repro: none-recorded
status: fixed
---

## Problem

A semantic gate failed: opening `?agent-id=<id>` did not end up subscribed to the
agent. The URL lost its `?agent-id=` parameter and the agent selection came back
empty, so no realtime subscription was ever created.

## Diagnosis

The dev/benchmark **preview fallback** (`benchmarkAgentPreviewEnabled()`, DEV and
VITEST only) made `canLoadAgent` true _before_ authentication completed. The
preview load then failed — as it must, pre-auth — and the failure handler cleared
the selection and stripped `?agent-id=` from the URL. By the time real access
arrived there was nothing left to subscribe to. So a fallback intended to widen
access in dev became a destructive early load that discarded the caller's intent.

## Solution

`clearSelectionOnFailure` now runs only under **full access** (front-end
`hooks.ts`), so a pre-auth or preview-mode failure leaves the selection and the
URL parameter intact for the authenticated retry. Shipped as part of PR #755
(merge commit `21c7f542`).

## Human feedback

None recorded.

## Reusable lesson

A failed speculative or preview-mode load must never destroy caller intent —
gate any "clear the selection on failure" cleanup on the fully-authorized path
only.
