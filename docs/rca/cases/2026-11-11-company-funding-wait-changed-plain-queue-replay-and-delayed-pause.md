---
id: 2026-11-11-company-funding-wait-changed-plain-queue-replay-and-delayed-pause
date: 2026-11-11
title: Company funding waits changed plain-queue replay and delayed pause handling
surface: agents
component: spawn_browser_agent_v3 company funding wait
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Long provider retry hints reached the old queue timer and an unconditional wait without a pause wake predicate
symptoms:
  - plain queue emits a different timer or no timer for a recorded funding retry
  - funding wait does not wake when payment execution is paused
tags:
  - agentcard
  - temporal
  - replay
  - pause
sources:
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
  - plan:.context/agentcard-stability/funding-wait-review-rca/final-packet.json
repro: Existing registered manager_funding_wait_pause and manager_funding_plain_replay cases with injected workflow clock and activity boundaries
status: open
---

## Problem

Code review identified two related failures in the company-funding wait. Removing the previous sixty-second cap changed timer commands for existing plain task queues. The longer wait also used an unconditional predicate, delaying a pause until that timer expired. No live workflow or payment failure is inferred from the offline regression.

## Diagnosis

The actual existing blackbox registrations were run with network denied and injected workflow state. On the unchanged source, two cases failed and five passed: a pause did not wake the wait, and a 120-second hint emitted a different plain-queue command. The retained legacy handler oracle emits sixty seconds for long hints. Archive searches for the wait boundary, funding/pause behavior and plain-queue replay found no same-cause case. The late-recovery and cutover-pause cases concern different boundaries.

## Solution

The private candidate uses the existing generation-scoped queue mechanism. Plain queues retain the legacy sixty-second cap, deadline expression and wait predicate. Generation queues retain long provider hints and use the existing interruptible wait with pause or changed pause-sequence detection before another mint activity. The replay-surface producer includes the handler and new dependency; its observed surface hash changes. The identical seven cases pass in five offline repetitions, the legacy oracle passes, and three adjacent pause/archive/abandoned-payment registrations pass. Independent review accepted exact patch390a06dbebcc5228d6a1249f1dc1c4fb7d9615b0c6e82be7442f60751571503a. No real Temporal history replay, worker rollover, native E2E or production validation was performed; shared integration and final-source gates remain pending.

## Human feedback

Finish the requested validation and deploy while preserving strict criteria, payment ownership, existing failures and the no-remint restriction. No new case-specific human feedback was received.

## Reusable lesson

Longer external retry intervals require both interruptible waits and explicit replay-surface isolation. Preserve historical workflow commands on their original queue generation instead of treating a new timer as a harmless scheduling change.
