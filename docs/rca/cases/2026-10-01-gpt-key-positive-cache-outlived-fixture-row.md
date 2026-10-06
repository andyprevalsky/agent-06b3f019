---
id: 2026-10-01-gpt-key-positive-cache-outlived-fixture-row
date: 2026-10-01
title: Funded GPT key stayed cooled in backend memory after its fixture row was removed
surface: back-end
component: gpt-credentials
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/gptCredentials.ts returned a positive cooldown cache without rechecking the authoritative DB row
symptoms:
  - "backend retained the fixture funded-key cooldown after DB cleanup"
  - "a later Codex E2B smoke could not receive the funded-key fallback"
tags:
  - codex
  - credentials
  - blackbox
sources:
  - task integrations blackbox run 1790906298-87097-19646
  - task integrations blackbox run 1790906353-95926-18625
repro: back-end/src/tests/blackbox/integrations.blackbox.ts
status: fixed
---

## Problem

The integrations blackbox fixture sends a real `gpt_api_key` rate-limit request, checks that the backend reports the shared key on cooldown, and removes the fixture's DB row. The backend kept reporting the key on cooldown after cleanup. That in-memory state could contaminate a later Codex E2B smoke even though the isolated test DB had no cooldown row.

## Diagnosis

The path was test HTTP rate-limit request → backend `markGptApiKeyOnCooldown` → DB row and positive process cache → fixture DB cleanup → backend `isGptApiKeyOnCooldown`. The positive cache returned immediately until its 30-minute deadline, bypassing the existing 15-second DB recheck. Clearing the cache in the blackbox test process had no effect on the separate backend process. The DB row was removed correctly; the first bad boundary was the backend's positive cache read.

Archive searches for `gpt_api_key_cooldown backend fixture row cleanup` and `Codex funded key fallback stale cooldown blackbox` found related token fallback cases but no prior positive-cache invalidation case.

## Solution

Both positive and negative cached states now recheck the authoritative DB at the existing 15-second interval. A local mark remains effective while its DB upsert is pending, so a concurrent read cannot replace it with the old row. The integrations blackbox asserts that the running backend reports the key available after the fixture row is removed. It tests the cross-process route, not just a local helper. A unit regression covers both read-before-mark and mark-before-read interleavings.

The exact pre-fix command exited 1 after 223 integrations cases with `backend retained the fixture funded-key cooldown after DB cleanup`:

```bash
cd back-end && bash scripts/run-blackbox-tests.sh integrations
```

The same command exited 0 after the change: `PASS integrations`, 1 domain, 0 failures. The mark-before-read regression first failed with `DB read during an upsert must retain the local mark`, then passed after the pending-write fix. The full coverage gate still needs its final rerun.

## Human feedback

None recorded.

## Reusable lesson

Deleting a database fixture does not clear another process's memory; a cache with an external source of truth must eventually revalidate positive entries too.
