---
id: 2026-10-29-it14-bu064-cdp-disconnect-empty-state
date: 2026-10-29
title: BU064 fails state acquisition after CDP disconnect and exhausted reconnects
surface: agents
component: browser-state-lifecycle
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: CDP socket closes and all reconnects fail before required page state returns no handler result
symptoms:
  - Native task fails before independent evaluator runs
  - Three reconnect attempts fail with closed WebSocket
  - Eight supervisor recovery attempts report no actions and state remains unavailable
tags:
  - r49
  - it14
  - cdp
  - lifecycle
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent 38fe98bd-2618-489b-bcd4-57f10c4d757b
repro: none-recorded; original socket lifecycle and terminal traceback only
status: open
---

## Problem

Executed85d37fc8ab8e284459977debdef34348d825ef84/patchnone. Archive8cd698903cd9dfbc2d516e329e7463e50fe8752b55ab45335e1a5f795778ce9d;
normalmanifest714692684fd625dbbc3cbe4502cb8d970171cdb4e7b79f4a5f183b0b4eeedf41;
runf8b220a5bba769c23f56fe823ba727aa5fab87279b1dbc73cbde163124074b38.
All7member sizes/SHA independently verified. Root38fe98bd-2618-489b-bcd4-57f10c4d757b nativeFAILED570.5s, taskFAILED, infraFALSE. No declared evaluator result exists: native error prevented completion. Do not invent semantic judge failure.

First observed transport boundary worker25748 at02:34:30.517038Z: CdpMux provider closed CDP socket code1000/emptyreason. BrowserUse message handler exits, SessionManager clears targets/sessions/mappings; three reconnect attempts fail ConnectionError WebSocket connection closed by02:34:36.843526Z. The initial worker-only read did not identify the initiator; the bounded backend follow-up below does.

The goto action subsequently reports navigation finished before content ready with state{} at02:34:40.542 and records success, while recording reports target/context/browser closed. This success label does not prove a usable page: next required observation fails.

At02:34:40.722-41.416 eight browser_url_error recoveries execute with actions[] while prior URL remains cached. Overlay/passkey logs say no focused target. At02:34:41.878 the existing recovery budget exhausts. Exact fataltrace atworker25858: handler10250 -> _observe_step_page3223 -> DOMService2491 get_browser_state_summary -> browser-use session1650 event_result(raise_if_none=True,raise_if_any=True) -> bubus522 ValueError no handler returned non-None. DownloadsWatchdog and DOMWatchdog are registered but neither returns state. Root receives original error; pauseHTTP500 happens later and is separate. Native task failure is preserved.

No evidence of a schema/JS-history/credential-reload recurrence. Recovering disconnected BrowserUse lifecycle may be a followup mechanism, but this trace does not establish socket-close cause, valid replacement session identity, or safe permission to silently replace browser state. No timeout/budget increase, fake empty state, arbitrary retry or provider reclassification. Need exact existing mux/browser/session-close lineage if retained; no new live capture requested. OPEN code/transport lifecycle floor; no candidate or tests.


## Diagnosis

The original user requested symbol interpretation through a personal website.
No semantic answer was accepted or independently graded. The observed error is
required browser-state acquisition after the socket lifecycle failed, distinct
from the later failed pause. Inspecting the actual traceback and event order
prevents treating the final no-result ValueError as a schema/answer defect.

## Solution

OPEN: the backend follow-up establishes a provider handoff as the close initiator; the worker handoff-consumption/rebind failure is not yet isolated by these logs. A same-input deterministic
repair has not been identified. Returning a fabricated empty page, treating
navigation success as valid state, silently replacing the session, increasing
retries or weakening credential barriers would not resolve that evidence gap.
No runtime candidate or regression test was added.

Two archive searches followed the original trace: BrowserStateRequestEvent
non-None; CDP reconnect cleared targets. Full prior CDP latency evidence-gap and
missing-focus passkey cases were read. The passkey case concerns optional
injection and is already soft-failing here; it does not authorize bypassing
required page-state observation. The CDP case reinforces the need for exact
connection/renderer evidence, not attribution from a timeout/close alone.

## Human feedback

The coordinator required the original native error and declared-judge boundary
before classification and prohibited assumed old-family recurrence, new live
capture, provider calls, task/cap changes or root-source mutation. Initial
assignment02:44UTC is retained. The first disposition was delivered with exact
line references before this docs-only record. No whole-task PASS claim.

## Reusable lesson

A page-state event with no result can be downstream of an already disconnected
session. Preserve the first socket transition and distinguish logical action
success, valid page state and terminal cleanup before proposing recovery.


## Bounded backend close-lineage follow-up

One parent-authorized existing-log lookup found the missing close initiator.
Backend log at02:34:29.878Z says BrowserChallengeRecovery is promoting the
kernel_residential_state lane winner, avoiding tilion_direct. It updates the
BrowserSession row and at02:34:30.039Z broadcasts ACTIVE for the same root/task
with replacement session iqelqugiv4kbazgnlrikd63i. At02:34:30.435Z the backend
logs DELETE /v1/session/sess_0351ecd063974d84a165020c5fecaafa status204.
The worker records that old CDP socket closing82milliseconds later, then
continues observation/recovery with the old Tilion session and no focused target.

This supersedes an unknown-close-initiator conclusion. The observed close is
consistent with intentional backend provider replacement, not evidence of a
spontaneous vendor failure. The exact worker response/rebind-consumption path
still needs causal isolation before a repair. The earlier R26 tab-rebind case
was read: it preserves keyboard transport configuration after a known focus
rebind, whereas this occurrence concerns consuming a changed provider/session.
No same-cause declaration, new callback/timeout/retry change, or task regrade.
The three-minute lookup remained local; no API/provider/browser calls.

## Scoped request-cancellation repair

The worker's original recover-challenge call started02:28:56.602Z and recorded
ReadTimeout02:33:56.596Z at its unchanged300s read bound. Backend promotion and
old-session deletion occurred about33seconds later. No successful replacement
response was recorded at the worker. This refines the missing handoff into a
late-backend-mutation boundary after synchronous caller failure, not a failure
to consume an actually received new identity.

Exact patch99ee7711c7cb4f07ceba9e669052717b47e28d3164ec6a613f45282d496abc7a
on85d37fc8 propagates an internal AbortSignal from the unfinished HTTP response
through service and lane search. It reuses existing owned-probe cleanup and
checks cancellation before and within promotion's transaction. Cancellation
observed before transaction callback return prevents adoption and rolls back
writes; a committed winner remains owned by its durable task. No new timeout,
retry, candidate policy, model route, Python handler or task criterion is added.

The same actual route→service→search→transaction fixture fails on baseline:
late candidate replaces old-tilion-session after response close. Candidate
passes seven controls: ordinary successful response, late probe, late create,
pre-closed request, cancellation during session update, cancellation after
commit and legacy no-signal caller. Fresh independent review reproduced all
seven and separately cancelled inside browserContext.update; existing owned
probe-release/shutdown tests pass. Actual post-apply checkout ran those seven
controls once with sockets, provider and database calls forbidden. The fake
transaction preserves rollback for its unit contract; no real database test
or original task replay is claimed. Author targeted five-file ESLint passed.

Fresh independent review returned GROUNDED for the exact five-file snapshot,
with personally opened OpenClaw HTTP lifecycle, Codex signal propagation and
Hermes cancellation/commit ownership references. It explicitly noted the
contrary shielded-send behavior and stronger Hermes commit-lock atomicity.
This repair is cooperative cancellation, not an atomic HTTP delivery ACK:
a disconnect after the final transaction check or commit cannot retroactively
undo task ownership. Original worker disconnect notification is not separately
captured, so historical task improvement remains unproven. NativeFAILED,
infraFALSE, task outcome and original02:44assignment clock remain unchanged.
