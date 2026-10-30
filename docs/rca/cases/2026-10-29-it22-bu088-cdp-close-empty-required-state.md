---
id: 2026-10-29-it22-bu088-cdp-close-empty-required-state
date: 2026-10-29
title: BU088 loses required browser state after CDP close and failed reconnects
surface: agents
component: browser-state-lifecycle
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Page-target CDP waits precede an abnormal upstream socket close; failed reconnects leave required browser-state handlers without a result
symptoms:
  - "Provider closed the CDP socket"
  - "Reconnection attempt 3 failed: TimeoutError"
  - "No valid focus, skipping BrowserStateRequestEvent"
  - "Expected at least one handler to return a non-None result"
tags:
  - polar
  - it22
  - bu088
  - cdp
  - lifecycle
sources:
  - commit 573847c1ea6ffbc28405d3ec29e39d8f86a5c2e8
  - agent a9508a9c-ff15-406b-b9e3-0e6b8fd62a5e
  - plan:.context/r88/proof.json
repro: none-recorded
status: open
---

## Problem

It22 BU088r1/r001-j0008 asks which pill a younger deceased person took, using
two deaths, a coroner, dates, ages and distance as identifying constraints.
Original source573847, patch none, ends nativeFAILED1303.8s/progress1 and
canonicalFAILED/infraFALSE. The failure is the native-status gate, not a
recorded semantic judge decision. It is not the earlier BU088100-step pause.

## Diagnosis

All seven original normal files independently match manifest
6c9c536a1ceb00d9a08e1da158b7ef92ffc6b03893366cdd6b8621d61e45d070.
Archive2cadaa6948df9fd6419d2dadda489aa4a07a5988304168658622815c84d37480
and runad1e4735d546f6128204c24f31fab3395fca49a96861fb270adc3406aee2c501
bind this chronology. Supplemental driver/provenance/lifecycle remain distinct
from the normal runtime manifest.

The browser visits a MyLondon article. Before the final failure, original
worker30265 reports page-target05ECF87CA829 sessions silent77s with pending
Network.getResponseBody calls, while another session replied0.1s earlier.
Some page sessions subsequently answer again (30288 onward). Later33015 again
reports page-session silence while another session replied0.0s earlier.
These observations distinguish a target/session stall from complete transport
silence; they do not identify why the renderer or request handling stalled.

At23:29:10.892351Z, worker33609 records the upstream CDP socket closing with
code1006 and empty reason. The message-handler exit follows. The mux source
records close_code/close_reason after its upstream reader ends and fans the
closure out to clients; its log label alone does not prove the external vendor
initiated the loss. Reconnect attempts1/2/3 fail TimeoutError at
23:29:26.945008Z,43.582627Z and23:30:01.660091Z. Background target attachment
also reports Root CDP client required. DownloadsWatchdog reports no valid focus.

Eight browser_url_error recoveries run from23:30:33.669126Z through
46.702016Z, all actions[] and URLabout:blank. At51.744673Z the unchanged shared
recovery budget exhausts. Original fataltrace at34663 is handler10304 ->
_observe_step_page3241 -> DOMService2552 -> BrowserUse get_browser_state_summary
-> event_result(raise_if_none=True, raise_if_any=True). Neither registered
DownloadsWatchdog nor DOMWatchdog returns a required state. The ValueError
propagates through the browser activity and root manager; action_count20 and
last actionread_browser_state are retained. Aggregate usage counters do not
prove that no browser work occurred.

The prior R49 case, 2026-10-29-it14-bu064-cdp-disconnect-empty-state, and the
CDP latency evidence-gap case were read after this trace. R49's backend
follow-up established a late provider-replacement/delete cause. This original
backend log contains no recover-challenge, BrowserChallengeRecovery promotion,
or DELETE-v1-session event establishing that same cause before the close.
Therefore this is a related downstream symptom, not a proven recurrence of
R49's fixed request-cancellation defect. No raw replacement response, exact
close initiator, or safe replacement-session binding is established here.

## Solution

OPEN; no runtime candidate. A fabricated empty browser state, silently replaced
session, higher timeout/retry budget, or inferred provider failure would not
repair the demonstrated gap. The required-state exception is downstream of
lost focus/connection. A causal repair requires the original close/reconnect
ownership or protocol evidence; no new native query, model replay, browser
operation or speculative regression test was performed.

The normal final provider receipt remains positive: Tilion session
sess_0351ec9ca5564c78938be070211f64bd DELETE204, root deleted and tree sealed.
Original failure and producerinfraFALSE are unchanged. After independently
verifying the socket loss and failed reconnects, the coordinator classified
one operational transport failure out of20 originals (5%) and directed the
owner to send one exact-process graceful stop. That operational stop decision
is separate from the immutable producer flag and from still-unknown vendor
versus local transport root cause. This worker performed no stop or native call.

## Human feedback

The coordinator required original fatal-stack inspection instead of assuming
the previous100-step failure, and required target-level CDP silence to be
separated from whole-socket loss. Transport code1006 and a log label alone do
not identify the responsible provider or justify stopping healthy tasks.

## Reusable lesson

A missing browser-state result may follow a broken session lifecycle rather
than an extraction or answer defect. Establish the earlier connection/target
transition and replacement ownership before changing required-state semantics.

## R93: It23 BU086r2 loses CDP before required state

This is another observed close/reconnect/state-loss sequence, not proof of the
same upstream cause. Executed sourcefc00b583e7df7b94d05fdb3442bddd23cd21be8b,
patch none; root a5b50a02-f356-4929-aeae-7c23002c6076, r002-j0016,
fleet20261030-002407-349164. The original asks for an actor identified through
biographical and film clues. Archive
 a9a0e8bed49f5aa5e994a912b91fa6d47ff5c4aba17abfa5903829da871e16bd,
manifest012e1139cb28ceda5cc45805661f8055f77b0ed93ad761cdc0e61d99e43a5dd5,
and run5ca86ad455dcfaa6b4e6afde36bdc59e90fcd891f547e9433626841121e828f3
bind the original. All seven normal members were independently size/SHA checked.

NativeFAILED1119.6s/progress1 precedes canonicalFAILED/producerinfraFALSE;
no declared semantic evaluator result is recorded. Original worker15943 onward
first records socket.send exceptions at00:46:47.834Z, then15956 records the
upstream close at00:46:48.553211Z, code1006 and empty reason. The mux's
`Provider closed` label describes its upstream reader ending; its source does
not establish who initiated closure or whether provider, relay or local failure
caused it. The worker remains alive and serves metrics during the sequence.

At00:46:58.635320Z the CDP message handler exits; reconnect1 starts immediately.
Some new upstream sockets attach, but this is not successful restoration of
page/session state. Background target handlers subsequently report `Root CDP
client required`; this symptom alone does not isolate the failing lifecycle
operation. All three reconnect attempts end TimeoutError at00:47:34.157334Z,
00:48:00.405871Z and00:48:17.443657Z. Worker17360 records exhaustion and17361
records required BrowserStateRequest failure because CDP remains disconnected.
Read-browser-state had already failed at00:47:30.531283Z; later no-result state
events and actions[] recovery attempts cannot supply the missing page state.
The final ValueError propagates through the browser activity and root manager.
The later antibot classifier label is not independent evidence that antibot
policy caused the socket loss.

The bounded backend lookup found no BrowserChallengeRecovery/recover-challenge
entry or earlier replacement/delete sequence proving R49's late-promotion
cause. The same session's recorded DELETE204 occurs later at00:48:56.372Z,
followed by another terminal DELETE204 at00:49:31.843Z. Final cleanup records
root_deleted and tree_sealed with cleanup_failure null. Earlier cleanup metadata
with unknown HTTP status does not supersede that terminal receipt.

The full Solution/Human feedback of the R49 and R88 cases were read after the
original trace. R88 supplies the matching downstream signature; R49 supplies a
contrary known intentional-handoff cause that these originals do not establish.
The exact upstream close cause and the particular reconnect phase timing out
remain OPEN. No fabricated empty state, silent session replacement, additional
retries, timeout increase or runtime candidate is justified by this packet.
There was no model replay, provider query, capture or new regression test.

The coordinator independently classified this original as one operational
transport failure out of20 and directed the owner to issue one exact-process
stop. That operational decision is separate from unchanged producerinfraFALSE,
original native/canonical failure and any subsequent induced cancellations.
This investigator performed no stop or recovery. Historical task improvement
and vendor attribution remain unproven; tokens are UNMETERED.
