---
id: 2026-10-29-switch-tab-event-failure-recorded-success
date: 2026-10-29
title: Switch-tab handler failure was recorded as successful after event completion
surface: agents
component: browser-switch-tab-executor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _execute_switch_tab awaited event completion without checking handler result before success
symptoms:
  - on_SwitchTabEvent timed out
  - Target.activateTarget
  - Action switch_tab successful
  - Handler timeout was recorded as a successful switch
tags:
  - r54
  - it14
  - tab-switch
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent f75c0b96-0a89-45e5-b38d-517b501b5096
  - plan: R54-SWITCH-TAB-ACK-V1 patch 9fae8bce4ce15fbf75f8445e24e596efd7a4d066274cefbeac16740444df9e77
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_switch_tab_observes_native_event_result
status: fixed
---

## Problem

R54 intake began approximately2026-10-29T03:44Z. Original It14 BU070r1,
jobr001-j0020, is nativePAUSED after1124.9seconds and canonicaltaskFAIL,
infraFALSE. There is no declared judge in the normal run. The tree-stall
reason is514seconds silence against510; later pause messages are consequences
of cancellation, not proof that the user requested an authentication pause.
The task asks for NeurIPS2022 OpenReview papers by an author named Yuri with a
certain recommendation. No answer or completed task is claimed.

Archivec7fbb8beb69c40debdf9af8bdcc4a837acf4b46c1d6bac23653ed517c3f80341
and all seven normal members independently verify against manifest
ebcdae71cc9ac23ec534d2c2addba050728811b38e484d04f5f81ee5f0fab52a.
Execution source is85d37fc8ab8e284459977debdef34348d825ef84, patchnone.

## Diagnosis

Worker6361 at03:30:31.823787 reports on_SwitchTabEvent handler timeout.
At03:30:57.455991, browser-level Target.activateTarget remains pending and
last response on any session was409seconds earlier. Worker6392 nonetheless
records Action switch_tab successful at03:31:31.962495.

The exact source _execute_switch_tab awaits the event object and then records
success without calling event_result. Bubus models.py277+ returns the completed
event from __await__; errors are inspected separately in event_results_filtered
474+. BrowserSession.on_SwitchTabEvent returns the selected TargetID only after
activateTarget and focus-change event completion. A completed wrapper therefore
does not prove successful native tab selection.

The first dropped Input.dispatchKeyEvent occurred at03:24:18, before this
specific false-success boundary. Persistent CDP no-reply and the exact next
unspanned await after03:31:31 remain unresolved. This repair does not explain
or cure the underlying transport failure or the eventual tree stall.

## Solution

Require event_result(raise_if_any=True, raise_if_none=True) and a returned target
ID matching the selected target before recording successful switch_tab.
Timeout, missing/foreign acknowledgement and caller cancellation cannot produce
a successful action receipt. Exceptions continue through the existing action
failure/recovery path. No retry, deadline, cap, target selection or provider
policy changes.

The permanent test uses actual Bubus EventBus/SwitchTabEvent. With the same
handler timeout, baseline incorrectly records success and the candidate raises
the event error without recording success. Controls cover matching, missing,
foreign and failed acknowledgements plus caller cancellation. Two old success
fixtures now supply the real typed target acknowledgement. The initial new
fixture lacked a title and was corrected before intended RED; that fixture
error is not causal evidence.

Fresh independent review returned GROUNDED for exact2path patch
9fae8bce4ce15fbf75f8445e24e596efd7a4d066274cefbeac16740444df9e77.
Both applied bytes match the review manifest. Postapply actual registered
selection7/7PASS and pinned2filecompilePASS. Network is blocked in the runner;
model/browser/provider/DB leaves are not invoked. No full-task PASS claim.

Personally opened references: actual Bubus event completion/result separation;
browser-use session.py1141–1190 typed switch return and tools/service.py476–500
explicit event-result validation; Codex code-mode module_loader.rs66–102
separate result resolution/error rejection; OpenClaw browser interaction
execution350–393 records success only after action completion. Contrary:
other navigation events can legitimately return no payload; the strict
nonempty matching requirement is limited to this typed selected-tab operation.
Focus can change before activation fails; this change does not claim rollback.

## Human feedback

Parent required preserving nativePAUSED, tree-stall, nojudge and infraFALSE
separately, and limiting the repair to the proven error-admission seam.
No provider-outage fix, timeout increase, blind rebind or task-answer claim.
Original03:44phase is retained; source85 live execution remains unchanged.

## Reusable lesson

Read a typed event handler acknowledgement before recording its requested
operation as successful; event completion alone is not success.
