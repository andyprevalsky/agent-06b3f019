---
id: 2026-10-25-rose-shop-fixture-hid-placed-order-after-lost-checkout-response
date: 2026-10-25
title: Rose Shop fixture hid a placed order after a proxy lost the checkout response, so the agent hunted for a receipt until the 1200s backstop
surface: back-end
component: auth-test-site
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/domains/auth-test-site — after POST /checkout placed the order (303 /orders/:n), no GET page (cart, account) exposed the order; the only recovery was a blind re-POST hidden behind the emptied cart
symptoms:
  - "Timeout after 1200s (wall-clock backstop=1200s) | Agent status: PAUSED (expected COMPLETED)"
  - "origin_response_incomplete"
  - "The approved checkout was submitted once, but the site returned an HTTP 502 connection error. The cart is now empty, yet no order confirmation or accessible order history establishes success."
  - "GET /api/rose-shop/<site>/orders -> 401 Missing or invalid authorization header"
tags:
  - auth-test-site
  - rose-shop
  - kernel-proxy
  - checkout
  - benchmark
sources:
  - agent 805d9aaf-5348-4b41-86df-3fcb5436e8a9 (descend-full69-20261023, shard-00 job r002-j0048, run 20261025-015409-23867, source 016fca859)
  - commit a9fc78d11 (branch rca/SIGNUP-slow)
repro: back-end/src/tests/blackbox/auth-test-site.signup-shop.cases.ts (signup_purchase and member-price guest cases: cart/account pages must link the placed order)
status: mitigated
---

## Problem

`browser-auth-signup-purchase` copy r002-j0048 failed with
`Timeout after 1200s (wall-clock backstop=1200s) | Agent status: PAUSED`. The
sibling copy passed in 824 s. The backend log shows
`POST /api/rose-shop/c4318df06eae/checkout -> 303` in 679 ms at 02:05:28Z with
`[AuthTestSite] Site event kind=order outcome=placed`. The order was placed and
paid. But the browser received Kernel's proxy error page instead of the
redirect: `origin_response_incomplete`, HTTP 502, "the destination may have
processed the request before the connection was interrupted".

The browser agent correctly refused to resubmit payment. It then spent about 17
minutes guessing receipt URLs (`/orders`, `/checkout/success`, `/order-history`,
`/orders/latest` and others, all 401 or 303 to home). It called
`attempt_completion` repeatedly at verifier 50% because it had no order number,
until the benchmark backstop paused the run.

## Diagnosis

Critical path: Kernel browser → Kernel managed proxy → trycloudflare tunnel →
frontend :3002 → backend `routesShop.ts` POST /checkout → 303 `/orders/:n`.

1. The origin's data was correct: the order was placed and the 303 was sent (backend log).
2. The first loss was the Kernel proxy hop dropping the response. This is a
   third-party, intermittent failure; it's the same managed-proxy flake family
   as the open Kernel `upstream_connect_failed` window. We don't own it.
3. Deepest owned rung: the fixture site gave a shopper no way to learn the
   outcome of an order whose response was lost. `placeOrder` already handled
   that by resolving a repeated POST to the paid order (the "browser that
   missed the response" branch). But GET /checkout on the emptied cart
   redirects to /cart, which said only "Your cart is empty". The account page
   listed no orders. So the repeat path was unreachable through the UI and,
   correctly, unsafe for an agent to try blind. Real shops expose the outcome
   through order history on the account and cart pages. Without that surface,
   any transport loss after the order turned into a guaranteed timeout.

Owned contributor, not changed here: Rose routes every Kernel browser session,
including our own test site, through the Kernel managed residential proxy
(`proxySource=kernel_residential_city` at 02:03:14Z). That routing added the hop
that dropped the response. Exempting our own fixture origin would make
benchmark traffic diverge from production browsing, which also crosses proxies,
so the fixture is made recoverable instead. Proxy egress policy remains an open
product question.

Open sibling (harness, approval-gated, not fixed here): with the outcome
unknowable, the browser agent called `attempt_completion` at verifier 50% for
about 17 minutes. The run then ended at the 1200s backstop as PAUSED rather than
returning an honest blocked result. Any unrecoverable ambiguity therefore turns
into a timeout. The 502 step was a FINISHED browser step whose page content was
the proxy error, not a tool ERROR row.

Sibling failures prevented: every Rose Shop scenario with checkout
(signup_purchase, member/guest, paid membership, expiring session), on any
browser provider or proxy that can drop a response after the write (Kernel
`origin_response_incomplete`, tunnel resets, client timeouts).

Local repro (red on 016fca859):
`ROSE_USE_SYSTEM_PG=true bash back-end/scripts/run-blackbox-tests.sh auth-test-site`
→ `FAIL signup_purchase ...: the cart must link the order it just paid for` and
`FAIL member price shops ...: the guest cart must link the order it paid for`
(39/41).

Searches run: `origin_response_incomplete kernel proxy 502 checkout` (related
Kernel proxy-ladder cases, no matching boundary) and `purchase outcome unknown
no order confirmation duplicate checkout verify blocked` (no hit). This is a
novel case and a relative of the open Kernel residential-proxy flake.

Outcome-reproduction gap: the trigger is an intermittent third-party proxy drop.
It can't be forced in the unchanged local benchmark on the buggy revision, so
the pre-fix exact-benchmark failure is recorded from the cloud run only.

## Solution

`serviceShop.ordersFor(site, viewer)` returns the orders the viewer may read
(same `canViewOrder` rule as the receipt), newest first.
`servicePagesShop.renderOrderHistory` renders a "Your orders" list linking each
receipt. Both the cart page (member by session, guest by paying cart cookie)
and the account page (member) show it. Strangers see nothing. No evaluator,
prompt, timeout or task definition changed. The blackbox runner went green 5/5
on a9fc78d11. Status is `mitigated`. The causal proof is local, but the outcome proof
(the unchanged agent finding the order through the new list after a lost
response) is still pending. A dropped response can't be injected into the
unchanged benchmark, so the outcome evidence will be the next cloud occurrence
plus local passes of the unchanged task.

Golden reference: searched `claude-code-src/` and `codex/` for idempotent or
ambiguous-outcome handling. There's no analog, because this is a fixture-site
realism change rather than harness behavior.

10k-agent behavior: per-site in-memory filter over that site's orders (one site
per benchmark root). There's no shared state and no cross-agent fan-in.

## Human feedback

None recorded.

## Reusable lesson

When a test fixture performs a write, give the shopper a GET-reachable way to read that write's outcome; then a lost response is recoverable instead of turning into a guaranteed timeout.
