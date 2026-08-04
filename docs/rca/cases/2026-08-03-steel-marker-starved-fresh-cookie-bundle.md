---
id: 2026-08-03-steel-marker-starved-fresh-cookie-bundle
date: 2026-08-03
title: Failed Steel auth remained bound after its marker was disabled
surface: cross
component: browser-auth-runtime
classification: our-bug
problem_class: other
first_bad_boundary: commit 79fe5c19e — Steel-first selection shipped without invalidating a session proven signed out at auth exhaustion
symptoms:
  - Expected attention kind write_lock, observed auth_assistance
  - Log in to see ride options
  - auth_source steel_session with cookies_injected false
tags:
  - browser-auth
  - steel
  - cookie-bundle
  - uber
  - credential-selection
sources:
  - commit 79fe5c19e
  - plan:agents/benchmarks/runs/20260803_223558_browser-opentable-reservation,browser-instacart-grocery-order,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,minted-agent-accounts-uber.json
  - agent 63034984-efff-438f-af72-fe73edc6682f
  - agent cadbd78b
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_failed_steel_auth_restart_invalidates_before_credential_isolated_resume
status: open
---

## Problem

The exact task prompt was: “Use Uber to request an UberX ride now from 88
Howard Street, San Francisco, CA 94105 to FITNESS SF Transbay, 425 Mission
Street, San Francisco, CA 94105. Confirm both map pins are at those exact
addresses and do not select a premium or shared ride. Complete the ride
request.”

The epoch-9 browser correctly entered both addresses, but Uber displayed “Log
in to see ride options” and redirected to authentication. The agent raised a
legitimate `auth_assistance` request, which the unchanged task correctly
rejected because the benchmark promises authenticated browser state and
requires a completed ride request after one write lock. The run recorded a
Steel credential source with no injected CookieBundle even though a newer,
enabled Uber bundle already existed. The same signed-out result and Steel
selection occurred on July 28.

## Diagnosis

The locked credential model intentionally chooses exactly one source: a live
Steel persistent session wins, while a CookieBundle is the fallback for a new
session. It forbids merging identities or overlaying arbitrary cookies into a
live Steel session. The first missing boundary was invalidation. The repository
already exposed `mark_steel_session_auth_failed`, which disables the marker and
reset the legacy `BrowserContext.contextId`, but the browser activity never
called it.

The benchmark poller pauses the workflow as soon as auth assistance is created,
before post-run credential propagation can observe the signed-out state. The
failed marker therefore survived and won selection again on the next fresh
attempt, starving the newer CookieBundle indefinitely. Adversarial review then
found a second layer: clearing only the legacy context pointer was insufficient.
`BrowserProviderProfile.profileId` and the active
`BrowserSession.providerProfileId` still named the failed profile, and session
resume prioritizes those bindings. A nominal invalidation followed by resume
could therefore recreate Steel with the same signed-out identity.

The owning activity reproduction supplies a Steel credential reference and
drives the browser to the grounded assistance action, then proves that a
CookieBundle replacement reconnects and reaches the next model iteration
without creating assistance. The focused restart test requires invalidation
before a force-fresh resume and rejects a replacement that reports the same
Steel credential. The backend integration reproduction proves that failure
cleanup disables the marker, removes the legacy and provider-default selection
indexes, and marks every live session binding invalidated without erasing its
completion lineage. Any concurrent sibling can therefore start its own isolated
recovery or finish live assistance without reloading the failed profile during
normal resume.

## Solution

After the auth runtime has exhausted every automated option and its assistance
guard accepts the request, it now performs one bounded same-run recovery before
creating user assistance. It disables the selected Steel marker, removes shared
selection indexes, and marks all live bindings to that profile invalidated.
Those bindings retain their profile identity solely for assistance completion;
normal resume and provider replacement explicitly refuse to reuse them. The
stable task is then resumed with a force-fresh profile flag. Normal single-source
credential selection can therefore inject an enabled CookieBundle into the
fresh profile without overlaying it onto a Steel identity. A successful
replacement atomically overwrites the active task binding; the browser activity
reconnects and continues its current model loop. If invalidation, recreation,
or reconnection fails, the stable task still names a completion-capable live
Steel profile and the activity falls through to live-view assistance without
reporting automated recovery as successful. Concurrent siblings retain the
same fallback independently; completing assistance reactivates that sibling's
provider binding and shared indexes.

Realm-transition preparation also refreshes the activity's active credential
reference so any later failure invalidates the credential actually selected for
that realm rather than the session-start reference. When a user completes live
assistance, the backend restores both the legacy and provider-specific Steel
profile indexes for future sessions. A bundle-first overlay was explicitly
rejected because it violates the one-source credential model. Partial reconnect
stacks are explicitly disconnected and their local Playwright drivers stopped
without closing the replacement remote session needed for assistance. The exact
Uber benchmark rerun remains required before this case can be marked fixed.

## Human feedback

None recorded.

## Reusable lesson

Invalidating a persistent credential means disabling every automatic selection path while retaining enough lineage for already-live sessions to complete assistance safely.
