---
id: 2026-10-28-it11-tab-rebind-lost-provider-keyboard-policy
date: 2026-10-28
title: Tab focus rebinding discarded the provider-specific keyboard transport policy
surface: agents
component: browser-humanizer-tab-rebind
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _rebind_browser_tab_runtime constructed a replacement humanizer without the serial_cdp_keyboard policy selected at initial setup
symptoms:
  - CDP keyboard input drain timed out after 15s
  - A Tilion tab switch replaced the humanizer with default pipelined keyboard input
  - BU055r2 remained unfinished at the separate outer activity deadline
tags:
  - r26
  - it11
  - tilion
  - tab-focus
  - provider-policy
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent f7f0bdde-970e-420e-adf1-cf54f0fd206b
  - fleet run 20261028-201313-3991289
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_tab_rebind_preserves_provider_keyboard_transport
status: fixed
---

## Problem

Original It11 job r002-j0015, polar-bu-055 run2, ended FAILED with infra=false.
The task asked for Tesla Superchargers in Evansville and Bloomington and three
restaurants within one mile driving distance of each, with addresses and Maps
pages. The original result is not regraded by this repair. Its later outer
activity deadline and unfinished task remain distinct from the input failure.

The normal archive SHA256 is
a6c1e68299b011200e46f242480e6d804b249171be40695a00107afef0a36a63.
All seven supplied runtime members matched their manifest-bound custody hashes;
run.json SHA256 is
9ecbd6e302817356acded60869f757b82d42c7d20d0576d5a69e12892cdfdc03.
The exact source archive SHA256 is
836dfd413f058fee66063c9d723dc1d11a226850509891ee46e957e495a2284e;
all1064 supplied tracked file hashes were independently verified. Only benchmark
timing history was excluded. Latest main was checked once at7689c4263742d5bca70c46ddc2be82d55c420b16;
its delta beyond execution source was18 factory-history rows, no runtime,
dependency or schema change. The active run was never modified.

## Diagnosis

Worker50474 records switch_tab successful at21:07:34.491784Z. Worker50484
records humanizer reconstruction at21:07:37.060053Z. No further reconstruction
precedes the final input. Message173 starts input_text at21:10:35.051Z;
worker52512 records the actual exception at21:11:39.849892Z. Its stack enters
humanizer.py857-863, the pending pipelined-key gather, and raises
`CDP keyboard input drain timed out after 15s`.

Worker52750 records generic recovery at21:12:02.089628Z; persisted message174
has an earlier created_at21:12:01.132Z. Delivered error message175 is21:12:03.052Z.
These delivery timestamps must not replace execution timestamps. Step43 records
87032ms in execute_action and104588ms total, not a15-second whole action.
The outer browser_activity_wait ends21:12:33.049780Z after3000504ms, followed by
StartToClose timeout. Its configured50-minute limit is unchanged. The final
actor text still said more restaurant options were needed; no successful final
completion was recorded in that tail.

Initial humanizer setup and provider-handoff replacement already derive
serial_cdp_keyboard from the current browser_session_metadata provider. Tilion
requires that branch under the existing input transport contract. The tab-focus
helper instead constructed a new humanizer with only pages and fast=False.
The constructor default isFalse. Both tab-rebind callers omitted policy.
The serial dispatch path awaits each key; only the pipelined branch fills the
pending list and reaches the observed drain error.

Archive searches used `CDP keyboard input drain timed out` and
`input_text supervisor recovery action timeout`. The complete
2026-10-21-tilion-gateway-drops-pipelined-cdp-key-events case, including its
second recurrence and Human feedback, explains the existing serial plus
movement-lock policy. The nested timeout ownership case was also read.
Historical vendor tests are not new proof of today's gateway behavior.
No original CDP wire receipts identify which request went unanswered, so that
wire cause remains OPEN. This case fixes demonstrated configuration loss, not
a claimed complete explanation of all elapsed time or the final task outcome.

## Solution

Add an optionalFalse policy argument to tab rebinding, pass the authoritative
current provider predicate at both actual activity call sites, and forward the
true-only constructor keyword exactly like existing provider-handoff setup.
Same-page reuse, old-humanizer close, recorder page, cursor observer and
cancellation propagation stay unchanged. Non-Tilion defaults are preserved.
No retry, timeout, task/schema/grade, provider-selection or movement-lock change.

The permanent regression resolves the real activity call expressions, executes
the real focus helper and BrowserHumanizer, and uses an offline gateway that
leaves overlapping keys unanswered. Original runtime fails with the pipeline
drain TimeoutError; candidate delivers the exact text. It also covers both
callers, same-page reuse, Kernel/Steel false policy, recorder/cursor/close
ownership and cancellation releasing the keyboard lock. Test-only drain1s
follows existing fixture practice; production15s is unchanged. Cursor
initialization is mocked; no real browser/provider is invoked.

The first draft omitted the explicit run_all_tests registration. Independent
review returned NOT_GROUNDED, despite custom-runner success. Final v2 adds the
required await r.record_async beside the existing focus control. Through the
actual run_all_tests function, a bounded BlackboxResult selector delegates this
case to the actual record_async: original runtime returnsFalse with the intended
TimeoutError; candidate returnsTrue. This is not a full-browser-suite claim.
Five existing focus, serial, idle-drift and provider-handoff controls pass.

Fresh reviewer ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt returned GROUNDED for final
patch SHA256
e91f0ce496ee4fe60e22df82c1eab7a3add56f1237d806390613c3e83041929f.
The reviewed handler SHA256 is
7105cc40dfd87cc1e54339c1fd685e031f64c7e79e721c586504b6e87c0a6198;
test SHA256 is4215c6938bf3399282fd1a51fea1cbba5593de41e9803979f57130be140998cc.

Opened primary references: BrowserUse0.13.11 browser/session.py2161-2206
preserves configured URL/profile headers while replacing connection state;
OpenClaw extensions/browser/src/browser/pw-session-state.ts87-169 restores
same-target mode while refusing stale frame-selector identity; Hermes
browser_tool_session.py594-603 excludes provider-backed sessions from local-only
recovery. These support preserving applicable policy, not transplanting stale
page state or adding universal retries. Rose's existing initial/provider-handoff
constructors are the direct implementation counterpart. No external numeric
limits were copied.

## Human feedback

Keep original taskFAILED/infraFALSE, outer50min and vendor-wire cause separate.
Require a controlled local reproduction and exact independent review before
application; preserve the unrelated UI draft. Do not infer task completion,
change caps, run new paid/model/browser/DB/provider calls or mutate active66eb.
Reviewer required registration through the real owning runner, not merely a
new function that a custom script could call. Tokens UNMETERED.

## Reusable lesson

Rebinding a page-bound input object must preserve its current provider transport
policy. A helper's default is not a safe replacement for configuration selected
by the owner, and an unregistered regression cannot protect that boundary.
