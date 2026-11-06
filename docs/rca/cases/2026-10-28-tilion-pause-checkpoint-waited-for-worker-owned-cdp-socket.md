---
id: 2026-10-28-tilion-pause-checkpoint-waited-for-worker-owned-cdp-socket
date: 2026-10-28
title: Tilion pause checkpoint waited for the worker-owned single CDP socket
surface: agents
component: browser-pause-transport-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The browser activity posted backend pause before releasing its single-client Tilion transport, while the backend checkpoint needed that same transport
symptoms:
  - "BrowserSessionCloseError: pause=True, HTTP=None"
  - "Backend CDP validation succeeds only after the worker disconnects"
  - "A later hydration attempt remained STARTED; its pending await is separately unresolved"
tags:
  - tilion
  - cdp
  - pause
  - checkpoint
  - transport-ownership
sources:
  - commit 3f791b711404e762dda6357d07173c55376f1280
  - commit 440d5beb35c1482e709accc2e4a214dbb5274f85
  - agent f884892e-fcdd-499e-af0f-d340c77779a3
  - plan:.context/deploy-fresh-20261027/payment-regional-fixed-3f791b711/close-order-proposal/FINAL.json
repro: agents/tests/blackbox/browser_tilion.blackbox.py
status: open
---

## Problem

After the regional-host classifier repair, the native AgentCard setup task used
one worker multiplexer and made three browser actions. Its pause then timed out
at the unchanged ten-second HTTP bound. This is a different boundary from the
previous direct-second-client classifier failure. The subsequent hydration
stall and the complete 900-second payment outcome remain OPEN.

## Diagnosis

On source3f791, logical browser9ff3342b-dfd2-562c-b081-74e00e744e75 and native
sess_c41189d14cc94b06a71bea1e2bf05103 belonged to root
f884892e-fcdd-499e-af0f-d340c77779a3. Backend close request636640a4acc2 began
at21:28:51.702Z. Worker cleanup reported BrowserSessionCloseError at21:29:01.708Z;
the multiplexer released its upstream at01.760Z. Backend CDP validation then
succeeded at02.007Z, published checkpoint1, deleted the provider session with204
at03.299Z, and released lifecycle custody at03.313Z. Thus the first pause did
settle; it must not be described as permanently stuck.

The shared activity helper previously awaited backend pause before local
transport detach. For a one-client provider, that checkpoint cannot attach while
the worker still holds the socket. A real local Chromium/DOMService/Playwright
fixture with a fake one-client gateway reproduces this dependency cycle without
paid provider calls. The original fails at the same HTTP-close boundary; the
corrected transport handoff passes.

Archive searches were literal `BrowserSessionCloseError pause HTTP None` and
behavioral `single CDP client pause checkpoint owner disconnect`. Solution and
Human feedback were read for the cleanup-acknowledgement, optional-CDP-shutdown,
and approval-checkpoint cases. They require truthful cleanup outcomes and local
artifact capture, but did not test this provider-specific transport handoff.

## Solution

For pause on a single-CDP-client DOM service, retain passkey capture and stop
replay, then finalize the local recorder before detaching. Confirm actual
multiplexer upstream closure before issuing the existing backend pause request.
The same ten-second HTTP and twenty-second disconnect bounds remain.

The multiplexer fences new dials under its existing upstream lock. Confirmation
waits for any pending dial, refers to the actual closing handle, and requires both
close and wait_closed. Failure restores the handle for existing cleanup and
cannot become a successful receipt through a suppressed DOM disconnect error.
Cancellation retrieves the confirmation failure and cancels only its exact
in-flight closer task. Ordinary non-confirming cleanup behavior is preserved.

Frozen reviewed patchSHA256:
18dec87c5f8aa10c9519358faf59b166049e225a5e64804034415646c9894420.
Root applied this mechanism in440d5beb. Root owns combined acceptance and deploy.

## Design choices

The activity remains the existing pause owner. It releases transport custody,
not the provider session; the backend still owns checkpoint and provider delete.
No new browser, tab, provider route, retry, timeout, schema, model or prompt was
introduced. Local passkey/recording evidence is captured before detach, and later
existing recorder publication remains idempotent.

The pending-dial control rejected an earlier snapshot-before-lock design: a
None or stale upstream snapshot is not closure proof. The permanent controls
exercise the real multiplexer methods, including an actual wait_closed hang;
they do not mock the confirmation method into success.

## Verification

The same native command and fixture bytes81ce35831d2d47007f7303cf7d27565bb73ae39fae18c7937c16e998ed2ce2bb
ran against both source overlays. Original:21:44:08.868183Z–21:44:22.504131Z,
exit1; the primary pause control failed with BrowserSessionCloseError after the
unchanged HTTP bound. Candidate:21:44:24.621212Z–21:44:53.779959Z, exit0.
The two registered cases cover successful handoff, actual close error, actual
wait_closed hang under20s, failed passkey capture, and pending dial/redial fencing.
No backend pause occurs after any failed handoff.

All329 original assertion ASTs and test bodies in the frozen proof are preserved;
14 assertions were added. The later main merge retained339 original assertions
plus the same14. Original and candidate cleanup receipts record8 and29 process
births respectively, none remaining; local listeners and temporary recorders
were joined. The earlier unlocked pending-dial control also failed as expected.
Independent review GROUNDED exact18dec, reviewSHA
358bd2cf187eeaae4abcfc43b02fc19c4bc4c5d96bd14a4af8dc34031b010ce6.

A later source27c full browser-tilion owner passed in171.195s after a separate
busy-renderer fixture-readiness correction. The initial full agents gate remains
recorded as122PASS/1FAIL. This local proof is not a completed payment benchmark,
production acceptance, Mac acceptance, or proof of the later hydration cause.

The later complete canonical browser-tilion owner on source
27c2559b99565d7b038ee854d827933947a9e0a6 passed in 171.195s, native and
outer exit 0, session 67556 joined. The source-qualified composition retained
122 original passing domains plus this complete fresh owner, then passed
214 cache tests, 173 unit tests, and 85% coverage against the unchanged 80%
threshold. This does not establish the full payment outcome or resolve the
separate later hydration wait. The original full agents command remains
native exit 1 with outer exit 143 of unknown cause.

## Human feedback

No additional direct human feedback specific to this transport correction was
recorded. Coordinator implementation constraints and review findings are
recorded above, not attributed to the user.

## Reusable lesson

Before handing a single-client transport to a checkpoint consumer, capture local
evidence and confirm release of the actual producer-owned handle under the dial
lock. A failed or unknown release must remain a failure, not an inferred handoff.
