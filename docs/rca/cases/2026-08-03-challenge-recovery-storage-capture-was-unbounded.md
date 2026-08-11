---
id: 2026-08-03-challenge-recovery-storage-capture-was-unbounded
date: 2026-08-03
title: Challenge recovery could hang before progress while capturing IndexedDB
surface: agents
component: browser-agent
classification: our-bug
problem_class: other
first_bad_boundary: commit 10ae71af8 — recovery awaited Playwright storage_state with IndexedDB without a deadline
symptoms:
  - recover_from_challenge emitted no captcha_solver progress or terminal result
  - the Hotel browser stayed active until benchmark pause after Expedia Bot or Not
  - storage_state(indexed_db=True) never returned
tags:
  - browser-agent
  - challenge-recovery
  - playwright
  - indexeddb
  - timeout
  - hotel
sources:
  - commit 10ae71af8
  - plan:agents/benchmarks/runs/20260803_223558_browser-opentable-reservation,browser-instacart-grocery-order,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,minted-agent-accounts-uber.json
  - agent 04f1015c-7a0c-4485-870a-9f0d2baa78ad
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_rotation_storage_capture_is_bounded_when_indexeddb_stalls
status: open
---

## Problem

The exact task prompt was: “Book a one-night stay for one adult at Hotel
Kabuki in San Francisco from this Saturday to Sunday. Choose the lowest-priced
non-smoking room with free cancellation, keep the room rate under $400 before
taxes and fees, and do not select a nonrefundable rate, package, room upgrade,
or add-on. Complete the reservation.”

The browser reached Hotel Kabuki on Expedia, observed the DataDome “Bot or
Not?” challenge, and produced a valid `recover_from_challenge` action. Unlike an
earlier recovery in the same trajectory, this action emitted neither the first
`captcha_solver` progress event nor a terminal action result. Browser activity
remained alive until the harness paused it. The only await between dispatch and
the first recovery progress stage was the Playwright storage capture with
`indexed_db=True`.

## Diagnosis

Commit `10ae71af8` added `_capture_rotation_storage_state` so provider rotation
could preserve cookies, local storage, and IndexedDB. The helper directly
awaited `page.context.storage_state(indexed_db=True)` with no deadline, and the
recovery branch emitted progress only after that call returned. A stuck
Playwright IndexedDB enumeration could therefore hold the browser action
forever without a stage identifying the bad boundary. This is distinct from
the later backend browser-state injection hang because the Hotel trace stalled
before browser configuration search or replacement-session injection began.

Archive searches found related bounded-injection and frozen-CDP cases but none
at this pre-recovery storage capture. The owning blackbox supplies a context
whose IndexedDB storage capture never resolves. Before the fix, the outer
200 ms assertion timed out with `asyncio.TimeoutError`. The fixed helper raises
a typed `BrowserStorageCaptureTimeoutError` after the configured 10 ms test
deadline. A second lifecycle reproduction passes that typed error through the
same factored finalizer used by the activity: it records the failed action,
appends the error-bearing browser tool result, finishes the streamed tool as
`ERROR`, and returns control to the model loop.

## Solution

Storage capture now has a positive, configurable 15-second deadline, rejects
non-finite and non-positive overrides, and caps valid overrides at 60 seconds.
Timeout records the duration and capture scope and raises a specific typed
error instead of claiming that auth state was preserved. The recovery action
emits a `capture_browser_state` progress stage before touching Playwright, and
the factored finalizer guarantees both success and error paths persist their
result and close the streamed tool lifecycle. The exact Hotel benchmark rerun
remains required before this case can be marked fixed.

## Human feedback

None recorded.

## Reusable lesson

Bound every external state-capture await and emit its progress stage before the first blocking call.
