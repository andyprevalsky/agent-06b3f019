---
id: 2026-10-25-rose-shop-passkey-script-reported-lost-request-as-missing-passkey
date: 2026-10-25
title: Rose Shop passkey script reported a proxy-lost options request as "no passkey in this browser", recording passkey_unavailable for an attempt that never happened
surface: back-end
component: auth-test-site
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/domains/auth-test-site/servicePages.ts passkeyBlock — one catch-all .catch() turned any failure (502 options response, failed verify POST) into POST {unavailable:true}, which the site records as passkey:rejected:passkey_unavailable
symptoms:
  - "Site never recorded passkey:rejected:passkey_not_recognized in the expected order (passkey(...)→rejected:passkey_unavailable, password(...)→signed_in)"
  - "We could not use a passkey in this browser. Try another way to sign in."
  - "Failed to load resource: the server responded with a status of 502 (Bad Gateway)"
  - "POST /api/rose-shop/<site>/login/passkey/options -> 200 (backend) but browser network capture status 502"
tags:
  - auth-test-site
  - rose-shop
  - passkey
  - kernel-proxy
  - benchmark
sources:
  - agent a68a37d1-0971-479e-a79b-1fa4d2bfd939 (descend-full69-20261023, shard-01 job r002-j0052, run 20261025-230302-25945, source 4bb71d90f; passing sibling run 20261025-230302-25891)
repro: back-end/src/tests/blackbox/auth-test-site.signin.cases.ts ("passkey_rejected: a lost passkey request is not reported as a missing passkey")
status: mitigated
---

## Problem

`browser-auth-passkey-rejected-password` copy r002-j0052 failed its declared
evaluator `passkey-rejected-password-outcome`. The site recorded
`passkey → rejected:passkey_unavailable`, then `password → signed_in`, but the
evaluator expects `passkey_not_recognized`. The sibling copy on the same shard,
and both full3 copies on 4d0bec372, passed.

## Diagnosis

Critical path: Kernel browser → Kernel managed residential proxy
(`proxySource=kernel_residential_city`) → trycloudflare tunnel → frontend :3002
→ backend `routesSignInMethods.ts`.

1. The agent clicked "Sign in with a passkey" at 23:12:28.742. The backend served
   `POST /login/passkey/options -> 200` in 2 ms at 23:12:28.987.
2. The browser got that request's response (CDP request 2410.38) as a 9,473-byte
   HTML page with HTTP 502, about 40 s later. The browser console says
   `Failed to load resource: the server responded with a status of 502 (Bad Gateway)`.
   A second request in the same session, the password POST at 23:13:25.98, also
   got a 502 and never reached the backend; its first `POST /login` is at
   23:13:59. So a hop between the browser and the origin lost responses
   intermittently. It is the same third-party proxy/tunnel flake family as
   `2026-10-25-rose-shop-fixture-hid-placed-order-after-lost-checkout-response`.
3. The site's passkey script then ran `response.json()` on the HTML, which
   threw. Its single `.catch()` posted `{unavailable: true}`, and the site
   recorded `passkey_unavailable` at 23:13:09.959. The script never called
   `navigator.credentials.get`. The virtual authenticator held the credential
   throughout: the readback at 23:11:42 was 1/1, and later syncs showed no loss.
4. Deepest owned rung: the fixture script treated "my own request got no answer"
   the same as "the browser has no passkey". It also showed the shopper a false,
   terminal message ("Try another way to sign in"), so the agent correctly moved
   on to the password. A real site would report a retryable error. The same
   catch-all also downgraded a genuine assertion to "unavailable" whenever the
   verify POST failed in transit.

The change between 4d0bec372 and 4bb71d90f does not matter: the trigger is
intermittent transport loss. The sibling copy on the same source passed.

Searches run: `trycloudflare 502 Bad Gateway tunnel auth test site`,
`passkey_unavailable passkey rejected cloudflared quick tunnel edge`, and
`mid-run tunnel 502 intermittent cloudflare edge request lost auth-test-site benchmark`.
Result: a relative of the lost-checkout-response case (same proxy flake, same
fix shape); novel at this boundary.

Local repro, red on 4bb71d90f:
`ROSE_USE_SYSTEM_PG=true bash back-end/scripts/run-blackbox-tests.sh auth-test-site`
→ `FAIL passkey_rejected: a lost passkey request is not reported as a missing passkey`
(`got {"status":"We could not use a passkey in this browser. Try another way to sign in."}`),
41/42.

## Solution

`passkeyBlock` now separates the three outcomes:

- A rejected `navigator.credentials.get` still posts `{unavailable: true}`, so
  `passkey_unavailable` is recorded.
- An assertion still goes to the site for its verdict.
- A non-OK or failed options/verify request records nothing and shows "We could
  not finish signing you in. Please try again."

`post()` now rejects on `!response.ok`. The regression runs the page's real
inline script in `node:vm` against the in-process site. It injects a 502 page
for the options request and for the verify request, then checks that no attempt
was recorded and that the retry text is shown. It then retries and gets
`passkey_not_recognized`, and checks that a browser without the passkey still
records `passkey_unavailable`. Green 5/5 (42/42).

No evaluator, task, prompt or timeout changed. Status is `mitigated`: the proxy
drop is third-party and can't be injected into the unchanged benchmark, so the
pre-fix exact-benchmark failure exists only from the cloud run.

Golden reference: not applicable. This is fixture-site realism, not harness
behavior; `claude-code-src/` and `codex/` have no WebAuthn page analog.

10k-agent behavior: client-side script change on a per-benchmark fixture page.
There is no server state, fan-in or per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

A fixture page must never record a lost request of its own as the user's
authentication outcome. Report transport failures as retryable and record only
the outcome the browser actually produced.
