---
id: 2026-08-22-hotels-com-switch-tab-blocked-on-same-host-pin
date: 2026-08-22
title: Host pin blocked switch_tab back to hotels.com checkout after property-page evidence
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: navigation host pin guard (removed on main) — switch_tab treated like navback/close_tab and blocked on pinned host
symptoms:
  - Refusing to leave pinned page host 'www.hotels.com'
  - browser-hotel-booking timeout after 1128s (dynamic cap=1125s)
  - Expected payment_approval attention request (to ignore) but none was triggered
  - request_payment_card never called after Reserve on Hotel Kabuki checkout
tags:
  - browser-agent
  - hotels-com
  - navigation-pin
  - switch-tab
  - payment-card
  - ecommerce
sources:
  - agent 7bdfd4bb-b069-4aa9-aafe-1455525480fa
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_allows_cross_origin_navigation
status: fixed
---

## Problem

`browser-hotel-booking` reached Hotel Kabuki checkout, clicked Reserve, then
stalled ~13 minutes and timed out at 1125s without `payment_approval`. After
Reserve the agent opened the property tab for `request_payment_card` line-item
evidence, then `switch_tab` back to checkout was refused:

```
Refusing to leave pinned page host 'www.hotels.com'. ... do not go back,
close/switch tabs, or navigate to another host until this page is done.
```

## Diagnosis

Challenge recovery set `navigation_pin_host=www.hotels.com`. The pin guard
treated every `switch_tab` on that host as leaving the handoff surface (same
bucket as `navback`/`close_tab`), so the agent could not refocus the checkout
tab after gathering property-page evidence.

**Resolution on main:** host pinning was removed entirely from
`_navigation_guard_error` because it trapped legitimate merchant → third-party
order flows after recovery. After `/sync` with `origin/main`, `switch_tab` is
no longer pin-blocked.

A branch-local `attempt_completion` guard was proposed and **reverted** — not
allowed; benchmark success must not be manufactured by blocking completion.

## Solution

Sync branch with `origin/main` (pin removal). Keep branch hotel-bench work
(timeout +25%, immediate `recover_from_challenge`, cookie probe wave). Do not
reintroduce host pinning or `attempt_completion` payment guards.

## Human feedback

User rejected blocking `attempt_completion` when card fields are visible.
User required `/sync` with main before re-running benchmark — branch pin-guard
fixes collided with main's pin removal.

## Reusable lesson

When checkout stalls on tab switching after recovery, check whether a host pin
still exists — main fixed this class by removing pinning, not by narrowing
`switch_tab` rules.
