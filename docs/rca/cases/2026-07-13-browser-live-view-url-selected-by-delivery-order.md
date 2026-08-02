---
id: 2026-07-13-browser-live-view-url-selected-by-delivery-order
date: 2026-07-13
title: The browser panel picked its Kernel live-view URL by delivery order, so a late older event restored a deleted session
surface: front-end
component: browser-panel
classification: our-bug
problem_class: other
first_bad_boundary: "front-end browser-panel derivation — the panel selected the last delivered live-view URL array element instead of the latest persisted event"
symptoms:
  - the browser panel iframe shows a stale/deleted Kernel session until a refresh
  - a single stable browser task ID accumulates multiple Kernel live-view URLs
  - the live view reverts to an older session URL after a late-arriving event
tags:
  - kernel
  - browser-session
  - realtime
  - event-ordering
  - front-end
sources:
  - PR #765
repro: none-recorded
status: fixed
---

## Problem

A browser panel could display a Kernel session that no longer existed. Production
data showed that one stable browser task ID accumulates multiple Kernel live-view
URLs over its life; the frontend rendered whichever URL happened to be the last
element delivered, so a late-arriving older event replaced the current URL with a
deleted Kernel session and the panel stayed broken until a refresh rehydrated the
messages in a different order.

## Diagnosis

The panel's URL selection treated _delivery order_ (hydration snapshot vs.
realtime bus arrival) as if it were _event order_. Those two orders are unrelated:
REST hydration and the realtime stream can deliver the same task's session events
in any sequence, so the "last one wins" rule is nondeterministic by construction
and can resolve to a session that was already torn down. Attribution stayed
provisional in the source: the incident's failing iframe URL was never captured,
so transient Kernel client routing remained a competing hypothesis — an
observability gap around the failing URL, not a second proven cause.

## Solution

Select each browser panel's latest Kernel live-view URL by persisted event time,
with the persisted `message_id` as the deterministic tiebreaker for equal
timestamps, instead of by delivery order. Frontend and live-provider regressions
were added for out-of-order session events and for immediate Kernel debug-URL
availability. The same PR hardened deploy support paths surfaced by the gate:
browser credential merges use database identities and report required-table
failures, coverage startup is load-resilient, and cloud secret refresh skips
leased/in-use machines. Review follow-ups made full credential sync collect
per-table browser-auth failures, continue later table syncs, and then exit
nonzero, while credentials-only mode stays fail-fast.

## Human feedback

None recorded.

## Reusable lesson

Derive UI state from persisted event ordering plus a stable ID tiebreaker — never
from the order two decoupled streams happened to deliver, which is not an order at
all.
