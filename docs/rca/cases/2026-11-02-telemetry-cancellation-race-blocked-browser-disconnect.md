---
id: 2026-11-02-telemetry-cancellation-race-blocked-browser-disconnect
date: 2026-11-02
title: Telemetry cancellation race blocked browser disconnect before provider pause
surface: agents
component: browser-telemetry-shutdown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: DOMService disconnect revoked its indicator task but the polling loop checked only the session cleared after joining that task
symptoms:
  - "Browser disconnect timed out; continuing terminal return"
  - "BrowserSessionCloseError: pause=True, HTTP=None"
  - "completed telemetry swallowed cancellation and blocked browser disconnect"
tags:
  - kernel
  - browser
  - cancellation
  - telemetry
  - pause
sources:
  - commit 72a8bd7bf7e3a92b5717d13d617c2954bf453fca
  - commit 79edd36b9a0231f74cfd0b492f10c13b9008e686
  - agent 64de2506-0196-43a9-986e-d9e56e960d3e
  - plan:.context/kernel-close-repair/design.md
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_dom_service_real_remote_indicator_shutdown
status: fixed
---

## Problem

A completed telemetry response racing cancellation can keep the CAPTCHA indicator
polling after disconnect revoked it. Disconnect joins that task before stopping
BrowserSession and clearing the session, so cancellation loss forms a dependency
cycle and hits the existing 20-second bound before any backend pause request.

Investigation began with the unchanged payment journey's evaluator rejecting
spawn_browser_agent call_pNC6chp2uMfR3RHQnIrxiG82 status=ERROR. Its native Kernel
session l25rke17z8qurckz6akb3dao timed out disconnect at22:21:07.075778Z after
request_payment_card. HTTP=None was synthesized locally, not evidence of an HTTP
failure. Later CLOSED observations cannot acknowledge that original failed pause.
Original financial settlement and evaluator failure are retained in private packet
SHA256 a27b781fc3a724b843189a535ffe3a294ee56d806c7b70787580f091fa9719d6.

## Diagnosis

Python3.11 asyncio.wait_for can return a completed future when external cancellation
arrives in the same event-loop turn. The controlled replay reaches the actual
wait_for implementation, observes cancelling()==1, then repeatedly polls because
DOMService._session is still live. Disconnect has already cleared
_captcha_indicator_task but waits for that task before clearing _session.

An independent real Chromium/DOMService/handler replay captured nineteen suspended
stacks: disconnect at _disconnect_session's indicator join and the indicator sleeping
between polls. It returned False after20.001476s. No provider calls or arbitrary
hung coroutine were used. The registered real-browser control failed at the same
unchanged bound in22.50s overall. The smaller owning-loop control also failed.
This is causal proof of the lifecycle defect, not proof of the precise historical
suspended await: that await was not captured in the original native packet.
The first unchanged current-main Kernel payment task passed in173s, so the native
failure did not reproduce on demand. That success does not invalidate the race.

Archive searches covered literal disconnect timeout and semantic browser pause/stop.
The Tilion single-client checkpoint, Kernel replay ordering, cleanup acknowledgement
and optional-CDP-shutdown cases were read. Their mechanisms are relatives; none
establishes recurrence or original native cause here. Actual existing cleanup and
approval-restore repair work was read before editing; no matching current repair
was established. Original source attribution remains NOT_INTRODUCED versus9152daa9;
that does not release this assigned repair.

## Solution

Use the existing indicator task reference as the ownership authority. The loop
checks its task identity at entry and after polling, before any browser write.
Disconnect already revokes that reference before joining; a lost cancellation
therefore cannot restart polling or update a resumed/replaced session.

This unifies ownership rather than adding shutdown state, timers, retries or new
background tasks. The helper,20s disconnect/10s telemetry bounds, backend checkpoint,
provider cleanup, passkey/recording capture, financial settlement and evaluator
assertions are unchanged. At10k agents the fix adds O(1) identity comparisons per
existing poll with no new resources or fan-in. Golden reference: not applicable
(no approval-gated hunk).

Both new registered owning tests pass together in1.88s. The real-browser test also
proves ordinary telemetry updates and that disconnect leaves the provider browser
alive. Cleanup joins the exact indicator and retained helper cleanup. Private
before/after receipts live under .context/kernel-close-repair/; independent review
and full deployment receipts qualify the release separately.

## Human feedback

The user required the original Kernel boundary and exact predeploy invocation,
retention of the no-browser-agent-failure assertion, financial facts and cleanup
bounds, and an independent completed deployment. A healthy Tilion result and
NOT_INTRODUCED attribution may not substitute for this assignment. No credential,
quota, top-up, Freedom or protected instruction changes are authorized.

## Reusable lesson

Fence a background task with its existing ownership identity before joining it;
do not depend on cancellation delivery to prevent another iteration or stale write.
