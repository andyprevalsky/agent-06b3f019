---
id: 2026-08-03-production-browser-realms-absent-from-synced-cookie-bundles
date: 2026-08-03
title: Four live ecommerce realms had no CookieBundle in the production credential source
surface: harness
component: benchmark-fixtures
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scoped production browser-auth read for the benchmark user — the four declared realms returned 47 cookies and one Steel marker but zero CookieBundle rows
symptoms:
  - five ecommerce tasks failed their live fixture before an agent could produce a trustworthy verdict
  - booking.com, amctheatres.com, and instacart.com each had zero CookieBundle and Cookie rows after a scoped production sync
  - uber.com had 47 loose Cookie rows and one SteelSessionAuth marker but zero CookieBundle rows
  - the existing scoped production reader reported Cookie Bundles 0 synced across all four realms
tags:
  - benchmark
  - fixtures
  - browser-auth
  - cookies
  - credentials
  - external-state
sources:
  - plan:agents/benchmarks/runs/20260802_220629_browser-opentable-reservation,browser-instacart-grocery-order,browser-doordash-usb-c-cable,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,browser-amazon-return,minted-a+0c2d11688d28.json
  - plan:agents/benchmarks/run_benchmark.py:_assert_live_cookie_domains_usable
  - plan:agents/tests/blackbox/benchmark.blackbox.py:test_live_fixture_fails_when_declared_cookie_domain_has_no_injectable_bundle
repro: run the live fixture's scoped credential sync and _assert_live_cookie_domains_usable for booking.com, amctheatres.com, instacart.com, and uber.com
status: open
---

## Problem

Epoch 8 could not produce trustworthy results for five tasks because the live
fixture had no injectable authenticated browser state for their declared
realms. A fresh `/sync` database import followed by the fixture's own scoped
production credential refresh still found zero injectable `CookieBundle` rows
for `booking.com`, `amctheatres.com`, `instacart.com`, and `uber.com`.

This is fixture state, not an agent verdict. The runner's preflight correctly
rejects each realm before dispatch so a signed-out session is not scored as an
agent capability failure.

## Diagnosis

The first three realms were completely absent from the scoped production
browser-auth read: each produced zero bundles, zero cookies, and zero Steel
session markers in the post-sync fixture. Uber was a different source-data
shape with the same injection outcome:
47 loose cookie rows and one enabled `SteelSessionAuth` marker existed, but no
`CookieBundle` joined those cookies to a selectable browser profile. The
injection path is bundle-keyed; loose cookie rows and a marker without live
session cookies do not provision a new browser session.

The existing scoped sync was rerun with its own safe per-table counts visible.
Its production read reported 47 cookies, 1 Steel session, and **0 Cookie
Bundles** across the four declared domains, then exited successfully. The
post-sync preflight reported the same counts. This falsifies a write/import loss
between that scoped read and the local fixture. The owning domain-scope test
also passed all six cases, including exact hosts, domain cookies, true
subdomains, multiple domains, and look-alike rejection.

The two observed shapes may still have different operational origins: three
realms are wholly absent, while Uber is an orphaned or stale auth graph. They
share the proven benchmark boundary—no matching production bundle—not
necessarily the event that originally removed or failed to create each bundle.

The counterfactual is deliberately narrow: one enabled bundle with matching
cookie rows per realm would make `_assert_live_cookie_domains_usable` pass and
allow dispatch. It would not prove that those cookies still authenticate or
that any benchmark task passes.

The owning-boundary reproduction ran from `agents` in the project virtualenv
and called the production fixture code unchanged:

```python
domains = ("booking.com", "amctheatres.com", "instacart.com", "uber.com")
assert _sync_browser_credentials(domains)
_assert_live_cookie_domains_usable(USER_ID, domains)
```

The sync command printed `Refreshed complete browser auth state from prod`.
The preflight then failed with `no injectable browser credential` and these
safe metadata counts: Booking, AMC, and Instacart each had 0 bundles, 0
cookies, and 0 Steel markers; Uber had 0 bundles, 47 cookies (31 unexpired),
and 1 Steel marker.

Archive search found the earlier case
`2026-07-06-benchmark-cookies-only-refreshed-at-setup-db-went-stale`. Its old
omission is not recurring: per-run credential sync and fail-closed domain
validation both executed here. The unavailable input is the current production
browser-auth corpus itself.

## Solution

No code change is justified by the captured boundary. Provision each realm by logging into
`booking.com`, `amctheatres.com`, `instacart.com`, and `uber.com` in a browser
profile currently synchronized by the macOS app so the source gains a fresh
bundle. Then rerun `/sync` and the same scoped fixture preflight. If a fresh
login still does not create a matching source bundle, that credential-upload
path becomes a separate owned RCA. Only a green preflight may unblock the
affected benchmark tasks.

## Human feedback

None recorded.

## Reusable lesson

A successful credential-import command is not evidence that a required realm
is provisioned. Gate live tasks on the exact credential shape the injection
path can select, and classify an absent source credential corpus as fixture
infrastructure rather than agent quality.
