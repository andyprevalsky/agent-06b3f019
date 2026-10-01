---
id: 2026-09-30-message-person-voice-history-time-window
date: 2026-09-30
title: Message Person voice fetch excluded older messages and the retrospective comparison bypassed live thread retrieval
surface: cross
component: message-person-voice-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/message_person/handler.py _fetch_voice_context passed a 30-day limit to back-end/src/domains/people/service.messages.ts getRecentMessages; the one-off comparison selected six thread messages from a global snapshot instead of the live per-person history
symptoms:
  - 'coffee_checkin thread_count 0 despite 13 prior Oscar messages'
  - 'days=30 in /api/people/messages/recent request'
  - 'expected old and recent messages without a days filter, got 1'
tags:
  - message-person
  - voice-context
  - recency-cutoff
  - benchmark-parity
sources:
  - commit 1102d8f2f
repro: back-end/src/tests/blackbox/people-messages.blackbox.ts and agents/tests/blackbox/message_person.blackbox.py
status: fixed
---

## Problem

The 12-case retrospective Echo comparison gave Oscar zero prior thread messages,
even though his full conversation had 13 messages before the withheld target.
The test had selected six messages from a 500-message global snapshot. Live
Message Person separately reads up to 100 messages from the recipient's thread.
Live also fetched cross-contact voice samples with `days=30`, and the backend
defaulted to a one-day filter when `days` was absent. A 15-minute cache bucket
discarded messages from the current bucket. The formatted message records
already contained timestamps, which let the model assess age without these
calendar filters.

Runtime evidence: `.context/echo-heldout-historical-report.json` recorded
`coffee_checkin.thread_count=0`; a read of the per-person messages API returned
13 prior messages. The pre-fix agent blackbox captured `days=30` in the request.
The pre-fix backend blackbox seeded a 45-day-old and a recent message, then
received only one message from the endpoint without a `days` parameter.
Archive searches: `message_person 30 day cutoff recent messages voice context`
and `historical benchmark context mismatch recipient thread as-of`; neither
identified a recurrence at this boundary.

## Diagnosis

Critical path: `MessagePersonManager.execute_tool` → per-person
`read_message_history_activity(..., 100)` → `_fetch_voice_context` →
`fetch_recent_messages_activity` → `GET /api/people/messages/recent` →
`getRecentMessages` → Prisma query → dated context formatting → Echo or inherited
model. The per-person read had no age filter. The general voice read passed
`days=30`; the backend enforced it. The retrospective script bypassed the
per-person read and derived a six-message thread from the global snapshot.

Owning-boundary reproductions, before the fix:

```text
cd agents && venv/bin/python scripts/run_blackbox_tests.py message-person
AssertionError: assert "days=" not in call["url"]

cd back-end && bash scripts/run-blackbox-tests.sh people-messages
Error: expected old and recent messages without a days filter, got 1
```

The general problem is duplicated context-selection policy: the benchmark
assembled a different prompt from live, while the live endpoint and agent each
had separate calendar filters. A model change could not repair missing context.

## Solution

The backend now applies an age filter only when a caller explicitly supplies
`days`. Live Message Person requests the latest 100 cross-contact messages
without that filter and no longer drops current-minute records for cache
stability. The existing formatter keeps each message's timestamp. The 100
message cap still bounds the prompt and response size.

The private retrospective comparison was rerun as of each target with the
same live context assembly: latest 100 prior recipient messages (13 for Oscar),
latest 100 prior cross-contact messages, live formatters, and the production
generation activity. Because the original user requests were not recorded,
its neutral intents remain reconstructed and the comparison is not a blind
voice-imitation score. No deployment has occurred.

The identical blackbox commands above pass after the fix. Backend typecheck,
targeted ESLint, Python Ruff, and formatter checks also pass. At 10k-agent
scale, each call still transfers and prompts with at most 100 messages from
each source; the uncapped-age database scan should be monitored separately.

## Human feedback

The user rejected treating hand-written, target-derived intents and a
six-message global thread snapshot as a clean voice test. They asked for the
exact live context protocol, no recency cutoff, and visible timestamps so
the model can assess age. They explicitly said not to deploy yet.

## Reusable lesson

Build retrospective model comparisons from the live context path as of each target, and pass dated messages without an implicit calendar cutoff.
