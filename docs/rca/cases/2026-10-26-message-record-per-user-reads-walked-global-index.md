---
id: 2026-10-26-message-record-per-user-reads-walked-global-index
date: 2026-10-26
title: Per-user MessageRecord reads walked every user's rows because ownership lived only on Person
surface: back-end
component: prisma-migrations
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/prisma/schema.prisma MessageRecord had no userId, so people/repo.ts findRecentMessages, data/repo.ts summary reads, imessage/repo.ts findRecentInboundMessages and data grep filtered through a Person join and the planner served them from the global MessageRecord(timestamp) index or a full scan
symptoms:
  - "pg_stat_statements: SELECT MessageRecord.id, timestamp ... LEFT JOIN Person j1 ... WHERE j1.userId = $1 ORDER BY timestamp ASC LIMIT — 6342 calls, 208.5 ms mean, 6049 ms max"
  - "Index Scan Backward using MessageRecord_timestamp_idx ... Rows Removed by Filter (actual rows=34690) to return 200 recent messages"
  - "SELECT COUNT(*)::bigint AS count FROM MessageRecord m INNER JOIN Person p ... m.message ~* $2 — 1116 ms mean, 8052 ms max"
  - "GET /api/people/messages/recent slow for mid-size users, fast for light users"
tags:
  - postgres
  - indexes
  - scale
  - grep
  - messagerecord
  - multi-tenant
sources:
  - memory:scalability-audit-100-seats-20261024
  - commit 3da991f7c
repro: back-end/src/tests/blackbox/message-record-user-scope.blackbox.ts
status: fixed
---

## Problem

Prod (read-only, 2026-10-26): `MessageRecord` held 277k rows / 312 MB across
users of 209k, 43k, 24k and a few rows each. Per-user reads cost grew with
every user's data:

- Data summary oldest/newest (`getOldestMessage`/`getNewestMessage`): 6,342 and
  5,656 calls, 208 ms / 187 ms mean, 6.0 s / 1.8 s max.
- `findRecentMessages` for the 24k-message user: `Index Scan Backward using
MessageRecord_timestamp_idx` read 34,690 rows (other users' first) and joined
  Person per row to return 200.
- Grep `COUNT(*)` with `~*`: 1,169 calls, 1.1 s mean, 8 s max; the page query
  1.5 s mean. Both regex-scanned every message of the user, with no text index.

## Diagnosis

Ownership was stored only on `Person.userId`. Every per-user MessageRecord query
filtered `person: { userId }` (or `JOIN Person p ... p."userId" = $1`), which no
MessageRecord index can serve. The planner then had two bad options. It could walk
the global `timestamp` (or `channel, timestamp`) index, assuming the user's rows
were spread uniformly in time. Or it could seq-scan. Either way the rows read
followed the whole table, not the user. Local repro on origin/main
(b3679ea7b): a 40k-row "whale" user surrounds a 2k-row target in time. Recent
messages read 20,200 rows, oldest/newest 20,001, count/channels 42,000, recent
inbound 20,058, and grep count and page 42,000 rows each for 5 matches.

Ladder (Step 5a). Why 1: the queries filter through Person. Why 2: MessageRecord
carries no owner, so the user filter cannot be indexed. Why 3: the global
`timestamp` indexes remain as an attractive but wrong access path. Even with a
`(userId, timestamp)` index, they kept winning for a user who owns a large share
of the table: repro showed 20,202 rows read until they were dropped. Grep's
residual cost (O(user's history) for heavy users) is a missing text index, the
same class. Next rung: "per-user tables/partitioning" is a design decision, not
needed for this load. Stopped there.

## Solution

- `MessageRecord.userId` (NOT NULL), consistent by construction. The relation is
  the composite `(personId, userId) → Person(id, userId)` with `ON UPDATE
CASCADE`. A mismatched insert fails, and an owner change, such as an account
  merge, cascades. Index `(userId, timestamp)`.
- Every per-user read filters `userId` directly: people recent, the data
  summary, iMessage recent inbound, the Gmail sent-to lookup, the Google purge,
  grep count and page, and context anchors. The dead `searchMessageGrepRows`
  is deleted.
- The global `MessageRecord(timestamp)` and `(channel, timestamp)` indexes are
  dropped (Step 6a delete). No query needs them, and they lured the planner.
- `GIN (message gin_trgm_ops)` makes grep follow its matches. Exact
  `total_matches` is unchanged.
- Rollout migrations (160000-160007), split so nothing scans a table under a
  lock that blocks reads or writes: add the nullable column and a `BEFORE
INSERT ... WHEN userId IS NULL` fill trigger (metadata only, `lock_timeout`
  5s); backfill (row locks only); `Person(id, userId)` unique index
  `CONCURRENTLY`; FK and CHECK `NOT VALID`; `VALIDATE` (SHARE UPDATE
  EXCLUSIVE) then `SET NOT NULL` reusing the CHECK; index create/drops
  `CONCURRENTLY` in one-statement migrations. Verified with `prisma migrate
deploy` on a populated old-schema DB. The fill trigger covers inserts from
  the previous release during cutover.
- Populated local DBs: `prisma db push` refuses to add a required column to a
  non-empty table (`--accept-data-loss` does not override it), so
  `back-end/scripts/backfill-local-message-record-owner.sh` runs before every
  local push (run.sh, blackbox runner, coverage runner, prisma-local-push.sh),
  following the `normalize-local-user-phones.sh` precedent. Regression:
  `prisma-local-push.test.sh`.
- Canonical benchmark seed (schema-hash keyed) migrated from the reviewed
  pg15/pg16 fixtures, validated with `validate-canonical-seed-dump.sh`, dumped,
  read back and published under `5f87f3aad0e2…-pg{15,16}-…-whatsapp-v2`.
- Legacy trace-archive fixtures without `userId` restore with the fixture's
  user. `seed-local` assigns `SEED_USER_ID`.

After the fix, the same repro read 200 / 1 / 2,000 / 58 rows, and 5 rows for grep.

10k-agent behaviour: each per-user read touches only the caller's index range.
Recent, oldest and newest are O(limit). Count is O(user). Grep is O(candidate
matches) for patterns with extractable trigrams; trigram-free patterns (short or
`.*`-only) still scan only the caller's rows. None of them grows with other users or agents. Writes add one
composite-FK probe per row, on the same Person unique index the old FK used. The
trigram GIN adds write amplification proportional to message text, and uses
`fastupdate` batching.

Golden reference: `hermes-agent/hermes_state_common.py:616` stores the owning
scope on each message with `messages(session_id, timestamp)`. `:785` adds a
full-text index (`messages_fts`) for message search. That is the same shape as
the owner column plus `(userId, timestamp)` plus the trigram index. No other
reference repo has a multi-tenant message store (searched claude-code-src,
openclaw, codex and prime-agent for pg_trgm and owner-scoped indexes).

## Human feedback

None recorded.

## Reusable lesson

Store the tenant key on every high-volume child table with a (tenant, sort-key) index and drop global sort indexes the planner can mistake for a per-tenant path; filtering through a parent join makes per-user cost grow with every user's data.
