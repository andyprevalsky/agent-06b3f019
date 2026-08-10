---
id: 2026-08-03-cookie-sync-scope-misread-as-required-auth
date: 2026-08-03
title: The live-fixture preflight treated every cookie sync scope as a mandatory injectable-cookie realm
surface: harness
component: benchmark-fixtures
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit e33af57b4 — _apply_live_fixture passed every live_cookie_domains performance scope to the mandatory injectable-CookieBundle assertion
symptoms:
  - Booking.com and two AMC guest-capable tasks failed before agent dispatch because no saved CookieBundle existed
  - the runner prescribed logging into every scoped domain even when the task contract did not require an account
  - Instacart and Uber were grouped with unrelated guest-checkout tasks despite having real authentication requirements
tags:
  - benchmark
  - browser-auth
  - cookies
  - ecommerce
  - guest-checkout
  - preflight
sources:
  - commit 6399b832e4
  - commit e33af57b4
  - plan:agents/benchmarks/runs/20260802_220629_browser-opentable-reservation,browser-instacart-grocery-order,browser-doordash-usb-c-cable,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,browser-amazon-return,minted-a+0c2d11688d28.json
  - plan:agents/tests/blackbox/benchmark.blackbox.py:test_live_fixture_fails_when_required_cookie_domain_has_no_injectable_bundle
  - plan:agents/tests/blackbox/benchmark.blackbox.py:test_task_live_fixture_only_preflights_explicit_injectable_cookie_requirements
  - plan:agents/tests/blackbox/benchmark.blackbox.py:test_live_cookie_catalog_separates_sync_scope_from_injectable_cookie_requirement
  - memory:official checkout-policy review for Booking.com, AMC, Instacart, and Toast on 2026-08-03
repro: agents/tests/blackbox/benchmark.blackbox.py — task_live_fixture_distinguishes_sync_scope_from_cookie_requirement, live_cookie_scope_separate_from_injectable_cookie_requirement, live_cookie_domain_requires_injectable_bundle, and live_fixture_validation_guards
status: open
---

## Problem

Epoch 8 failed five tasks before trustworthy agent execution because their
declared `live_cookie_domains` had no injectable `CookieBundle`. The initial
diagnosis treated all five as missing fixture credentials and prescribed fresh
logins for Booking.com, AMC, Instacart, and Uber.

That grouped three unrelated failures with two genuine account prerequisites.
The Booking task contains no account requirement. The single AMC task stops
before charge at a payment-card request, and the IMAX task can use the public
ticket purchase path. Their domains still need to scope browser-state sync for
performance, but absence of a saved session must not abort them before the
browser can exercise guest checkout.

Instacart remains account-bound: its task explicitly uses a saved delivery
address, and Instacart's current help says customers can build a cart without an
account but need one to check out. Uber also remains account-bound because its
task declares `live_browser_auth` and must request a ride from authenticated
account state.

The current official product documentation supports that split. Booking.com
exposes reservation support using the booking confirmation rather than requiring
an account ([customer service](https://www.booking.com/customer-service.html)).
AMC's ticket FAQ supports order handling through confirmation details, while
sign-in is tied to Stubs member benefits
([movie-ticket FAQ](https://www.amctheatres.com/faqs/movie-tickets?modalName=RefundOrderSearchModal)).
Toast explicitly documents guest checkout
([account and guest checkout](https://support.toasttab.com/en/article/Creating-an-Online-Ordering-Account)).
By contrast, Instacart states that an account is required to check out
([Instacart Help](https://www.instacart.com/help/article/360039163432)).

## Diagnosis

Commit `6399b832e4` introduced `live_cookie_domains` only to bound the expensive
production browser-state sync. Its schema comment calls the field optional,
describes it as a performance scope, and says omission falls back to a full
sync. The commit mechanically added a domain to every live browser task,
including public checkout flows.

Commit `e33af57b4` was the first bad boundary. It correctly added a fail-fast
check for tasks that require authenticated state, but passed the entire
`ctx.cookie_domains` performance scope to
`_assert_live_cookie_domains_usable`. That silently changed the field's meaning
from “only synchronize these domains” to “each domain must have an injectable
bundle.” No catalog field remained capable of expressing the difference.

The task-level regression was then applied by itself to an unchanged detached
worktree at `4e7684475`, before the proposed production or catalog changes. The
owning command failed `0/1` domains in 43.8 seconds (run
`20260803-143234-8602-ac8bad63`) with the exact original boundary:
`Live fixture preflight: no injectable browser credential for booking.com after
the scoped browser-credential sync.` With the repair, the same owning command
passed `1/1` domains in 39.4 seconds (run
`20260803-143332-42993-196e20c8`), including the unchanged Booking/Uber task-level
regression.

## Solution

Keep `live_cookie_domains` as the sync-performance scope and add
`required_injectable_cookie_domains` as the precise fixture contract. The
fixture synchronizes the full scoped set but only checks injectable bundles for
the required subset. This does not claim that a site universally requires an
account; it states that this benchmark requires preauthenticated cookie state at
dispatch. Catalog validation rejects any required domain outside the sync scope.

The catalog marks Amazon purchase/return, Instacart, and Uber flows as requiring
injected cookie state. Booking, AMC, Toast, OpenTable, Alchemy, and DoorDash keep
their scoped refresh without a hard cookie gate. Toast's stale
`live_browser_auth` secret declaration was removed to match its guest-checkout
contract. The Amazon passkey task also remains outside the CookieBundle
requirement because it deliberately proves a signed-out start followed by
passkey authentication. The benchmark prompts are unchanged.

This is causal proof with a locally green repair. The exact post-fix benchmark
has not run, so the case remains open.

## Human feedback

Andy identified that the original remediation was overbroad: most of the named
sites should use guest checkout, with Uber as the likely account-bound exception.
Follow-up verification retained Instacart as account-bound because its official
checkout documentation and this task's saved-address requirement both require
an account, but removed the hard cookie gate from the other guest-capable paths.

## Reusable lesson

Never infer a hard prerequisite from an optimization scope. Model “what data to
refresh” and “what capability the task requires” as separate validated fields,
then fail fast only on the latter.
