---
id: 2026-10-31-it31-browser-cdp-silence-before-stall-pause
date: 2026-10-31
title: Sustained global CDP silence precedes the It31 browser stall pause
surface: agents
component: browser-transport-and-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Browser CDP stopped answering across page and browser sessions; the initiating cause and exact post-step46 await are not captured
symptoms:
  - last reply on any session 666.1s ago
  - Input.dispatchKeyEvent not answered by the provider within 10s
  - Browser supervisor recovery ran with empty actions
  - tree stalled and native PAUSED with progress zero
tags:
  - r135
  - it31
  - cdp
  - recovery
  - stalled
sources:
  - commit 618430e2a32e619406cb24fb537e2f6e2fe291e7
  - agent d1f4c66b-a414-465f-9135-351fdb3a2682
  - plan: original archive aae272d64f614b31a2a121dc17a5dde6db7c2593014938239636085b3d43d238
repro: exact recovery function and action-error consumer counterfactual; no original transport-cause reproduction
status: open
---

## Problem

It31 r001-j0004/polar-odysseys-0ce94d4e773e asks for a three-item outfit
with product and availability checks. Exact source618430/patchnone runs the
browser for2152.2seconds, then returns nativePAUSED/progress0. The benchmark
records FAILED/producerinfraFALSE after newest-active silence518s exceeded510s.
Operational infrastructure classification is separate: the full native log
positively records prolonged cross-session CDP nonresponse before the pause.
No vendor cause, task repair or original grade change is established.

## Diagnosis

All seven sealed normal members verify against manifest
7f311564bfa75cc268742765e28152ca3d30869e71cf01bd124a744cbdc6d3a0.
The complete21447-line worker SHA256 is 0bb420a2cd233f3946b87f4246dacf6af781d3de2d1303b1862c25a221763dd7.
The embedded run projection truncates its log list; this diagnosis uses the
complete standalone worker file, not that projection.

Worker20238 records input_text failure at01:59:58 after an unanswered native
key event. Four page sessions report silence at20245–20251. At20979
(02:10:49.277973Z), pending Runtime.runIfWaitingForDebugger/Storage.getCookies
have seen no reply on any session for661.1s. At20982
(02:10:54.279887Z), browser-level Target.activateTarget is pending and the
same measure is666.1s. Runtime.evaluate expires repeatedly through21164 at
02:19:06.347102Z. The worker event loop remains responsive:21176 at
02:19:40.344870Z records maximum lag0.002s. Earlier several-second loop stalls
are contrary evidence to a claim that the entire execution had no local lag;
they do not explain this later sustained interval by themselves.

Native screenshot and switch failures become BrowserActionRaisedTimeout.
Exact handler12560 catches these as generic exceptions rather than entering
its separate asyncio.TimeoutError/CDP-classification branch. Recovery records
20524 and20987 both have actions[]. The source suppresses failures from
bring-to-front, Escape and dismiss-button probing; it logs recovery as having
run even when no action completed. The nested recovery helper returnsTrue
while under its existing eight-attempt limit. The screenshot/switch caller
ignores that Boolean and writes a failed-action result with
supervisor_recovered=True.

Two offline source controls clarify the limit. The five exact recovery
functions executed with an inert failing Page produce actions[], returnTrue
and performed-recovery feedback. The exact action-error except body then
executed with only the recovery return changed betweenTrue andFalse produces
identical results. Thus returningFalse for empty actions alone would not
activate a reconnect or terminal path for these actual exceptions. Other
state/credential/API consumers test that Boolean, but they are distinct paths.
Neither control reproduces the original upstream transport failure.

Step46 finishes at20993 (02:10:57.627313Z). No next foreground action/model
request or detailed suspended-task stack is captured before PAUSE21177 at
02:19:42.424821Z. Source order places tab rebind before the next instruction
read and page observation, but the exact awaited operation is unknown. Late
model input dumps were skipped as payload_too_large (~2.7MB). No guessed
model payload, provider crash, target disposal or specific rebind cause is
substituted for those missing records. Upstream socket release21187 at
02:19:50.497695Z occurs during pause teardown, not before the original silence.

## Solution

OPEN: sustained native nonresponse supplies an operational-stop basis, but no
safe causal runtime repair is established. The parent requested the authorized
single operator stop separately; this case makes no new operation or closure
claim. NativePAUSED, progress0 and producerinfraFALSE remain immutable.
ReturningFalse from empty recovery alone cannot repair the actual consumer;
blanket fatal treatment of all timeouts would also change legitimate recovery
paths. No timeout increase, progress masking, blind reattach, prompt/rubric
edit or source patch is proposed.

Controls are retained as owning_recovery.py and actual_consumer_control.py in
the private R135 review evidence, with exact618430 source hashes. They used
no model/provider/native/DB calls. Required next causal evidence is the
identity-bound pending transport/task state or an owning reproduction of that
missing transition. Generic stall labels and unsuccessful recovery telemetry
must not be presented as a demonstrated provider root cause.

## Human feedback

The user prioritizes native agent failures and progress-zero paths while
keeping all failures tracked. This investigation preserves those axes and
does not use a cursor, model prediction or elapsed time as task-progress proof.

## Reusable lesson

Distinguish an attempted recovery from restored native responsiveness, and
prove which consumer acts on its result before proposing a recovery-policy fix.
