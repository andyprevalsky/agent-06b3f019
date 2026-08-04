---
id: 2026-07-08-unchanged-codex-credentials-never-reuploaded-after-expiry
date: 2026-07-08
title: Codex credential sync skipped unchanged local credentials, so an expired backend integration never reconnected
surface: mac-app
component: codex-credential-sync
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the mac-app Codex credential sync — it compared only local credential content and skipped upload when unchanged, ignoring backend integration state
symptoms:
  - GPT Code integration stays expired or inactive after local Codex credentials are still valid
  - Codex credential sync never re-uploads unchanged credentials
  - stale GPT Code cooldown/error state persists
tags:
  - codex
  - gpt-code
  - credential-sync
  - mac-app
  - integration-state
sources:
  - PR #722
repro: backend and mac-app blackbox coverage for the reconnect path
status: fixed
---

## Problem

The backend GPT Code integration could sit in an expired or inactive state while
the local Codex credentials on the machine were still perfectly good, and the
sync would never repair it. Stale GPT Code cooldown/error state also stuck
around, keeping the integration unusable.

## Diagnosis

The credential sync's upload decision was driven solely by whether the _local_
credential material had changed. When the backend integration was invalidated
(expired/inactive) but the local file was byte-identical to the last upload, the
sync short-circuited as "nothing to do" — so the one action that would have
restored the connection was precisely the action it refused to take. The deeper
cause is a one-sided idempotency check: the sync treated its own local diff as
the sufficient condition for skipping work, even though the desired end state is
a property of the _remote_ integration. Cooldown/error state on the GPT Code
integration was likewise never cleared on a successful upload, so even a repaired
credential kept presenting as broken.

## Solution

Re-upload unchanged local Codex credentials whenever the backend GPT Code
integration reports expired or inactive, and clear the stale GPT Code
cooldown/error state when credentials are uploaded again. Backend and mac-app
blackbox coverage was added for the reconnect path so the "unchanged locally,
broken remotely" case stays covered. The same shape of fix applies to any
credential syncer: the skip condition must consider remote state, not just the
local diff.

## Human feedback

None recorded.

## Reusable lesson

An idempotency check that only inspects local state will refuse to repair a
broken remote — make the skip condition depend on the remote integration's
health, and clear its error/cooldown state on successful re-upload.
