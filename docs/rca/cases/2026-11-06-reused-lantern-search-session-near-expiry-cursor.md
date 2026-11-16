---
id: 2026-11-06-reused-lantern-search-session-near-expiry-cursor
date: 2026-11-06
title: lantern-people-pagination page 2 hit SEARCH_SESSION_EXPIRED because people_search returned a first-page cursor from a Lantern session reused 14 s before expiry
surface: agents
component: people-search-lantern
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tools/people_search/service.py execute_people_search returned a cursorless find_people page whose nextCursor belonged to a reused Lantern session with 14 s of lifetime left (expiresAt 11:49:53.614Z, response at 11:49:39)
symptoms:
  - "Lantern People: SEARCH_SESSION_EXPIRED"
  - "Timeout after 420s"
  - "Completion rejected: no evidence tool has succeeded yet."
  - "lantern-people-pagination"
tags:
  - lantern
  - people-search
  - pagination
  - lantern-people-pagination
  - shared-external-state
sources:
  - agent 62872c91-318b-413a-b270-ccbe682e71e3
  - fleet run 20261106-113759-989534 (descend-failed-neverrun-20261106 epoch 4, r002-j0025)
  - agent 9f0cdb43 (passing sibling, fleet run 20261106-110445-4093362)
repro: agents/tests/blackbox/people_search.blackbox.py::test_reused_near_expiry_search_session_is_refreshed_before_returning_cursor
status: fixed
---

## Problem

`lantern-people-pagination` (K=3 copy r002-j0025, agent 62872c91) timed out after
420 s. The explore page-one call (`query="engineer"`, `titles=["Software Engineer"]`,
`limit=2`, no cursor) succeeded at 11:49:39 with cursor
`aba5b14a-….2.2.<sig>` and `expiresAt 2026-11-06T11:49:53.614Z`. The page-two
call with that exact cursor ran at 11:49:55 and returned
`Lantern People: SEARCH_SESSION_EXPIRED`; every later continuation with the same
cursor failed the same way. The remaining ~5.5 minutes were explore leaves
looping on `Completion rejected: no evidence tool has succeeded yet.` (26
rejections) while the root re-delegated, until the 420 s task timeout.

## Diagnosis

1. The session id `aba5b14a…` and `retrieved_at 11:34:53` in that page-one
   response are the sibling copy's search (agent 9f0cdb43, page one at 11:34:53,
   page two OK). All K copies use the shared Lantern grant, and Lantern answers a
   repeated identical search from its existing session without extending the
   session's fixed 15-minute TTL. Copy r002 repeated the identical search 14 m
   46 s later and received a cursor with 14 s of lifetime; the model's next turn
   took 16 s.
2. The guest made one 655 ms live HTTP call; people_search has no result cache,
   so the stale session did not come from our Fast Mode/demo cache. No Lantern
   credential refresh happened on the guest backend.
3. Owned first-bad boundary: `execute_people_search` returned that cursor as a
   normal first page. The agent cannot tell (its context carries the date, not
   the time) that the cursor dies before it can continue, and a continuation
   can never open a new session. Production has the same path: one user
   repeating an identical search near the end of the earlier session's TTL.
4. Model latency was not the cause: page two was issued 16 s after page one.
   The completion-gate loop (agents/domains/spawn_agent/service.py) only
   stretched the already-failed run to the timeout; it is reported separately.

Local proof: the regression fails on 8d8d6a316d (one Lantern call, reused
cursor returned) and passes 5/5 with the fix. The exact task needs a sibling
search 14-15 min earlier, so outcome proof is the descend rerun.

## Solution

`execute_people_search` reads the first page's `expiresAt`. When a cursorless
discover page has less than `SEARCH_SESSION_MIN_LIFETIME_SECONDS` (30 s) of
session lifetime, it waits until that session expires and repeats the identical
request once, only if the wait plus a 10 s reserve fits the existing 45 s HTTP
budget. Continuation calls and pages with usable lifetime are untouched. No
timeout changed. At 10k agents this adds at most one extra Lantern request and
one bounded asyncio sleep per affected first page, with no shared state.

## Human feedback

None recorded.

## Reusable lesson

When a provider deduplicates identical requests into a session with a fixed
TTL, check how much lifetime the returned cursor has left before giving it to
the agent; benchmark copies sharing one grant will hit the edge case.
