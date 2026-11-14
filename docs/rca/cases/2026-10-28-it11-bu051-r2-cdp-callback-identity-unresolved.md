---
id: 2026-10-28-it11-bu051-r2-cdp-callback-identity-unresolved
date: 2026-10-28
title: It11 BU051 r2 CDP callback assertions lack connection-epoch custody
surface: harness
component: browser-cdp-lifecycle
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Initial renderer stall and later Root CDP client assertions are observed but the callback connection identity and terminal causal relationship remain unproven
symptoms:
  - Navigation timeout classified as renderer_main_thread_blocked
  - Later handle_target_attached assertions require a root CDP client
  - Activity deadline arrives while the requested tutorial set remains incomplete
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent af774292-c374-498e-8dad-c96a21cb73ef
tags:
  - r28
  - it11
  - polar-bu-051
  - cdp-lifecycle
repro: none-recorded; original event chronology and source inspection only
status: open
---

## Problem

Rootaf774292-c374-498e-8dad-c96a21cb73ef; source66eb9ccc4e39237bdd99b08f697180c7097a39bd.
Archive5aaef9c6f7bcc0650e22013138f07db55316f62cc7aa9ddc96ed6bf5fd5e9ba9
verified, all7normal members verified. Normal manifest
3e58f573bfb34c1a76bd7e55af93279855a1e746c10bdc7d12be335bdef29bf3;
run c61ea5d62986e907002fe9cc86150f257226b0f5c087fb5e9110269236ce8e68;
worker0aa312bc640d741f0c18052fafd014cbc7683a96d312080188f83bec6e65c73b.
Original FAILED/infraFALSE, duration3014.4s. BU051r1 is excluded.

The task asks for one numbered photo/diagram tutorial for each of12Chinese
zodiac animals, each no more than30steps. The actor gathered tutorial candidates
but had not produced an accepted final12-item answer when the deadline arrived.
No verifier/task-complete success is in the original messages.

## Diagnosis

Chronology:
- Initial native actions navigate/read/evaluate origami pages. A goto begins
 20:24:18.022Z. At20:30:58.548040Z the timeout probe reports renderer=frozen,
 browser=ok, renderer_main_thread_blocked (renderer58086ms/browser557ms).
- Generic recovery records current origami.me/dragon page. Hard recovery at
 20:36:50.804756Z reports browser_cdp_list_failed:TimeoutError, new_context_page,
 goto_resume_url, close_playwright_page and recycled=true. The error message
 is persisted20:38:32.870Z. The cause of this long first stall is not isolated.
- Challenge-recovery flow follows. Old CDP socket closes20:40:47.592739Z,
 SessionManager clears20:40:48.148227Z, old browser resets/disconnects, then
 a new Steel CDP connection is recorded20:40:49.672349Z. This is an observed
 provider transition, not proof that the old provider caused the original stall.
- Twenty-four background handle_target_attached assertions begin21:10:35.415317Z:
 Root CDP client required. The package source session_manager.py467 asserts
 browser_session._cdp_client_root is non-None before creating a CDPSession.
 Session setup/teardown explicitly clears that pointer; the log does not bind
 these callbacks to the exact old/new BrowserSession object or connection epoch.
 A stale callback or missing-live-root hypothesis is therefore not isolated.
- Native read_browser_state succeeds21:10:58.716Z, then evaluate21:11:27.828Z
 and21:12:16.248Z return origami bull17-step data after those assertions.
 Assertions are not proof that all active browser work stopped.
- At21:12:32.312341Z manager reports activity StartToClose timeout; rootfails.
 Last actoriteration69/100, actionhistory70. No cap override or extra step is
 warranted. The50min activity limit is the same normal configured contract.

Mode fields: original task says world_model_mode=real and
fast_mode_cache_enabled=true. This does not prove all provider/cache traffic's
execution mode; detailed mode coverage remains a separate pending audit and is
not inferred from those flags. No zero-counter/no-work conclusion is drawn.

Original final actor requests are not fully retained: dump1065c20346ba atstep69
was skipped for2585107bytes and2800aa09daea atstep70 for2596509bytes. Earlier
step68 requests were likewise skipped. Logs/actions provide chronology but not
full final model-input parity. No external replay/capture was requested.

## Solution

No same-cause assertion with R26 keyboard-serialization loss: this run's initial
failure is a goto/renderer stall; the later transition is toSteel. The RootCDP
callback identity lacks a connection/object trace, and successful later actions
contradict a blanket fatal-disconnect inference. Need an offline exact lifetime/
callback reproduction or original epoch identity before changing cancellation,
rebind or CDP dispatch. No task/timeout/provider/model/criteria change proposed.
No runtime edits, tests fabricated, image output or livecalls. TokensUNMETERED.


## Human feedback

Parent restricted this investigation to BU051 repetition2 and prohibited
assuming the R26 keyboard-rebind cause. BU051 repetition1 remains outside scope
pending normal custody. No additional calls, source changes, timeout edits or
regrading were authorized. The original failure and mode-coverage gap remain.

## Reusable lesson

Join asynchronous CDP callbacks to their owning connection and lifecycle epoch
before diagnosing stale-client reuse. An assertion followed by successful
browser work does not alone explain a later activity deadline.
