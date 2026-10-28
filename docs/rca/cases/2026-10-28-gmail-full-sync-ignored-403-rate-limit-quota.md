---
id: 2026-10-28-gmail-full-sync-ignored-403-rate-limit-quota
date: 2026-10-28
title: Gmail full sync outran the per-user quota and treated Google's 403 rateLimitExceeded as data loss, then failed and looped
surface: back-end
component: gmail-sync
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/services/integrations/gmailParser.ts fetchGmailEmails Phase 1 / fetchMessagesBatch / getGmailProfile — only HTTP 429 counted as rate limiting
symptoms:
  - '[GmailParser] Failed to get profile status=403'
  - '[GmailSync] Error syncing credential errorType=Error'
  - 'Phase 3 complete full_emails_fetched=0'
  - "Quota exceeded for quota metric 'Queries' and limit 'Previous quota: Units per minute per user' of service 'gmail.googleapis.com'"
  - 'Gmail sync failed (integration status SYNC_FAILED after reconnect)'
tags:
  - gmail
  - rate-limit
  - provider-quota
  - silent-degradation
  - sync-loop
sources:
  - commit 1f80267cd
repro: back-end/src/tests/blackbox/integration-accounts.pipelines.cases.ts (Gmail sync 403 rateLimitExceeded cases, quotaWall in integration-accounts.gmail-fake.ts)
status: fixed
---

## Problem

Andy's Gmail integration (26f1b782) had been skipped since 2026-10-19T01:25Z as
`Skipping integration - no syncable credentials` (a credential awaiting
reconnect). He reconnected both accounts at 06:40Z on 2026-10-28. The stored
historyId for andyprevalsky111@gmail.com (1480740) had expired, so the 06:45
cron fell back to a full sync of 30,693 messages. Phase 1 kept only 13,398
metadata rows with `rate_limited: 0`, Phase 3 fetched 0 of 515 wanted
messages, then `Failed to get profile status=403` threw. The historyId was
never saved, so the next tick restarted the same 30k-message full sync. The
06:50 retry saved a historyId after fetching only 817/938 messages, and the
a@roselabs.ai incremental fetched 298 of 412 ids. All of these losses were
silent.

## Diagnosis

Local repro: the unchanged production `fetchGmailEmails` ran against the real
mailbox with fetch instrumented. It returned `metadata:200 10413`,
`metadata:403 20280`, `batch-part:403 124`, `batch-part:503 24` and
`profile:403 1`. Every 403 body was `usageLimits` / `rateLimitExceeded`
("Units per minute per user").

- **Why 1:** Phase 1 fired `messages.get` 20-concurrent with 50 ms pauses,
  about 140 req/s. At 5 units each that is about 700 units/s, against Gmail's
  15,000 units/min per user.
- **Why 2:** Google signals that exhaustion with HTTP 403, not 429. Phase 1's
  raw fetch, the batch sub-part parser and `getGmailProfile` only recognised
  429 (the old `fetchWithRetry` matched 403 only on the list and outer batch
  calls). So rejected requests became `null` (dropped) and the final profile
  call threw.
- **Why 3:** No layer failed loudly on unfetched messages. The sync either
  failed after the full burn (historyId never saved, so it looped) or saved a
  historyId past messages it never fetched (permanent loss).

Classification: our bug. It is not a third-party failure: the quota is
documented and fixed, and we exceeded it.

## Solution

- New `gmailQuota.ts`:
  - `isGmailRateLimited` parses `error.errors[].reason` (429, or 403
    rateLimitExceeded/userRateLimitExceeded).
  - `GmailQuotaPacer` spaces request starts to 80% of 15,000 units/min.
  - `gmailPacerFor(token)` shares one pacer per mailbox across sync, OTP and
    agent reads in a process.
- `gmailParser.ts`:
  - Every Gmail call (profile, history, list, metadata, batch) goes through
    `fetchWithRetry`: 5 attempts, 5/10/20/40s backoff, which outlasts the
    minute window.
  - The duplicate Phase 1 retry loop is deleted.
  - Rate-limited or 5xx batch sub-requests are re-fetched singly. Any other
    non-200/404 now throws instead of being dropped.
  - The unused `searchAndFetchEmails` is removed.
  - Retry-After HTTP-date values no longer parse to NaN.
- `gmailSync.ts`:
  - Reads the profile historyId BEFORE the full listing (Google's documented
    full-sync order).
  - Heartbeats `lastSyncAt` every 5 minutes, so a paced multi-minute sync is
    never re-claimed mid-run by another tick or instance.

Siblings this also prevents: silent loss in incremental syncs, OTP lookups
returning partial results, and first-connect full syncs failing on large
mailboxes.

10k-user behaviour: the pacer and heartbeat are per mailbox / per integration,
with one interval timer per running sync. The pacer map is bounded by
currently active mailboxes (pruned when idle). Full-sync wall time is now
bound by the quota (about messages×5/12,000 min, ~13 min for 30k messages).
This makes the existing serial `runGmailSyncJob` loop's head-of-line blocking
worse. Overlapping ticks still take other integrations because the claim
stays fresh.

Open follow-ups:
- The OAuth callback still runs its own unclaimed full sync. It now shares the
  pacer instead of doubling the quota.
- Pacing is per process, not cross-instance.
- Messages dropped before this fix (06:50 run, a@roselabs.ai incremental) need
  a forced full resync of affected integrations.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Pace every provider call to its documented per-user quota and classify the provider's own rate-limit reason codes (Gmail uses 403 rateLimitExceeded, not only 429); never turn a rejected fetch into silently missing data.
