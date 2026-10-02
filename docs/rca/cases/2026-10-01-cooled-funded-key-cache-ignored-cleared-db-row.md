---
id: 2026-10-01-cooled-funded-key-cache-ignored-cleared-db-row
date: 2026-10-01
title: A cooled funded-key cache ignored the shared DB row for 30 minutes, so test cleanup could not restore it and the Codex smoke failed
surface: back-end
component: compute-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/gptCredentials.ts isGptApiKeyOnCooldown returned the cached cooldown without re-reading the shared row
symptoms:
  - Code agent credentials are unavailable; the session could not be started
  - configured but on its out-of-credits/bad-key cooldown
  - smoke -- Codex completes task in real E2B sandbox FAIL
tags:
  - credentials
  - cooldown
  - blackbox
sources:
  - PR #1364
repro: back-end/src/tests/unit/shared-api-key-cooldown-recheck.test.ts
status: fixed
---

## Problem

In backend coverage, `smoke -- Codex completes task in real E2B sandbox` failed in 14ms with 500 "Code agent credentials are unavailable". The backend logged "no usable OPENAI_API_KEY (GPT_API_KEY) fallback (configured but on its out-of-credits/bad-key cooldown)" at 22:11:48.663Z.

The VM has no synced Codex OAuth credential, so the smoke depends on the funded key. Machines with a synced credential never hit this.

## Diagnosis

Milliseconds earlier, `feedback -- failed OAuth fallback cools OAuth and funded credentials` posted funded-key exhaustion feedback. The backend's `markGptApiKeyOnCooldown` set a 30-minute in-memory cooldown and wrote the shared row. The case then deleted the row in cleanup.

`isGptApiKeyOnCooldown` short-circuited on the cached value (`if (now < cachedUntil) return true`) and never re-read the row while cooled. So the cleared row had no effect on that backend for 30 minutes. `isAnthropicApiKeyOnCooldown` had the same fast path. The integrations domain cools both shared keys on the same coverage backend and restores only the DB row, so it poisons later cases the same way.

The defect is not test-only. The shared row exists so every instance agrees on one backoff, yet an instance that cached a cooldown ignored a cleared row, for example after an operator topped up credits. The new unit tests fail on the old code: 5 of 6, including a missing in-flight-read guard on the Anthropic path.

## Solution

Both caches now re-read the shared row at most once per 15-second recheck interval, whether cooled or clear. A cleared row is honored by every instance within that interval.

- A mark records the check time, so a read issued before its upsert commits cannot drop it.
- The Anthropic path gains the revision guard the GPT path already had, so a read in flight cannot overwrite a newer mark.
- The Codex smoke waits, bounded at about 30 seconds, until the backend reports the funded key clear, so restores from earlier cases have landed before it creates a session.

Tests: `shared-api-key-cooldown-recheck.test.ts` covers, for both keys:

- a cleared row being honored after the interval,
- one DB read per interval while cooled,
- an in-flight read not dropping a newer mark.

`gpt-api-key-cooldown-race.test.ts` still passes.

At 10k agents: while a key is cooled, each backend process makes at most one indexed single-row read per 15 seconds. The cost does not grow with agent count.

## Human feedback

None recorded.

## Reusable lesson

A local cache of shared state must re-read its source on a bounded interval in every state. Otherwise clearing the source never reaches the instances that cached it.
