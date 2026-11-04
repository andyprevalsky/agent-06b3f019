---
id: 2026-10-30-tilion-exit-ladder-exhausted
date: 2026-10-30
title: Tilion rejects the first residential rotation and Rose preserves the live browser state
surface: back-end
component: browser-provider Tilion live parity; tilionRotateInPlace.ts; tilion.ts
classification: third-party-failure
problem_class: other
first_bad_boundary: Tilion POST rotate-ip returned HTTP409 exit_ladder_exhausted before any replacement or logical restore
symptoms:
  - Live Tilion parity first rotate-proxy returns409 carried_state_required
  - exit_ladder_exhausted
tags:
  - tilion
  - rotate-proxy
  - carried-state
  - external-blocker
sources:
  - PR #1634
  - commit fa0310f9f6a55cd4f937f59ab4af51bd385b16fb
repro: "Offline provider-captured-refusal.ts and provider-live-expectation.ts in the evidence directory; original live parity failure retained"
status: open
---

## Problem

The full backend run passed349 unit files and239 of241 blackbox domains. Besides the separately overridden treasury domain, live Tilion parity failed on its first residential rotation. The vendor request at2026-10-30T00:58:43.374Z returned409 exit_ladder_exhausted (request708ad36864ad4764, session sess_c4118952d7374abcba872658f73db970). The active browser contained test localStorage that must survive rotation.

## Diagnosis

The first bad boundary is the provider response, not the later carried_state_required mapping. The in-place adapter rejects an unproven fresh allocation, attempts the replacement path, and finds an ACTIVE live session without worker-carried state. It preserves the binding and refuses destructive replacement; the rotation reservation is returned. This differs from the October28 logical-restore defect, which occurred after a successful provider rotation.

The investigator replayed the captured response with the real adapter, loopback fake REST server and in-memory database/CDP seams. Existing safe-refusal assertions pass and preserve the binding; changing only the fake response to successful fresh allocation makes the existing in-place assertions pass. An unconditional live-success diagnostic reproduces the typed refusal. These are offline causal proofs, not a restored live-provider result. A peer's retained sixteenth failure independently records the same vendor rejection; no repeated provider calls were made here.

## Solution

No local runtime or test patch is justified. Keep live parity failed and its assertions unchanged. Provider fresh-exit capability must recover before the gate can pass. Do not count the safe409 as successful rotation, discard browser state, loosen the test or add blind paid retries. The provider's internal reason for exhausting exits remains unknown.

## Human feedback

The user authorized finishing deployment and skipping treasury only. No Tilion parity waiver was requested or inferred. Freedom, credentials, native leases, active jobs and protected warm resources remain unchanged.

## Reusable lesson

Trace a defensive error to the upstream event that selected the defensive path. A state-preserving refusal is not evidence that the safeguard is faulty; live success still requires the supplier capability. Preserve both the original failure and the limits of offline proof.
