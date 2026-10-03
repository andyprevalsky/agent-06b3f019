---
id: 2026-10-02-browser-humanized-click-ack-without-dom-delivery
date: 2026-10-02
title: Humanized browser click reported success without proof of DOM delivery
surface: agents
component: spawn-browser-agent-v3 click execution
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py _execute_click recorded success after the input transport returned without observing a click on the authoritative page
symptoms:
  - "Timeout after 902s (dynamic cap=900s)"
  - "Action click successful" for Pay $43.96 with no subsequent POST /api/test-payment/confirm
  - The checkout remained visible after two Pay clicks
tags:
  - browser
  - payment
  - click
  - agentcard
  - timeout
sources:
  - agent 95d620a4-4092-492d-b189-49d81f936fb9
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_click_reports_missing_dom_delivery_after_humanized_click
status: open
---

## Problem

The second browser task of `agent-payment-idempotent-abandonment` filled an approved
card and clicked the enabled Pay button twice. `worker.8.log` records
`Action click successful` at 07:24:57 and 07:28:18 for coordinates (120,757)
and (129,753). The saved screenshot places both points inside Pay $43.96.
The backend log has no `POST /api/test-payment/confirm` between those clicks and
the task timeout; the browser remained on checkout with no submitting state,
error, or receipt. The root agent timed out at 902 seconds. The old run did not
record the DOM click event, so whether the input was delivered to another tab
or the app ignored a delivered event cannot be proven from that run alone.

## Diagnosis

Path: browser model chose the visible button → `DOMService.get_click_coordinates`
resolved its viewport point → `BrowserHumanizer.click_at_coords` completed CDP
input dispatch → `_execute_click` recorded successful action without checking the
page that supplied the DOM node → no checkout request or UI transition followed.
The first owned contract error is accepting input-transport acknowledgment as
proof of page delivery. An isolated stale-tab reproduction sends input to one
Chromium page while the DOM node belongs to another; the old code reports
success and the checked-in blackbox assertion fails. The same test passes after
the fix. Archive searches included `Timeout after 902s`, `browser activity waits
payment abandonment`, `humanized click successful no DOM event`, and `Pay button
click did not trigger confirm`. Prior payment timeout cases had different first
bad boundaries; this is a new interaction contract gap.

## Solution

`service_actions.py` now arms a one-use click listener on the authoritative page
before a humanized indexed click. If the page definitely did not receive that
click, it retries once through the browser session's element event and refuses
to record success if that also misses. Navigation or unavailable observation is
treated as unknown, never as proof that a purchase click failed. Parent-document
observation is skipped for iframe controls because child click events do not
bubble into the parent; a real Chromium blackbox covers that guard. This adds
two page evaluations per indexed click at 10k-agent scale, without new network
services or persistent state. The full browser-agent blackbox domain passed.
The unchanged paid benchmark has not yet run on the fixed worker, so the case
remains open pending the parent deploy loop's outcome proof.

## Human feedback

None recorded.

## Reusable lesson

Verify that a browser action reached the page that supplied its target before reporting success or retrying an irreversible click.
