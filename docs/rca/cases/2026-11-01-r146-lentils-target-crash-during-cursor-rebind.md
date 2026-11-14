---
id: 2026-11-01-r146-lentils-target-crash-during-cursor-rebind
date: 2026-11-01
title: Lentils browser task fails on Target crashed during cursor rebinding
surface: agents
component: browser-target-lifecycle
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "Foreground step9 cursor initialization receives Mouse.move: Target crashed before terminal cleanup"
symptoms:
  - Native FAILED with progress1 after411.7s
  - Successful switch_tab precedes fatal cursor initialization
  - Other CDP sessions continue replying before teardown
  - No captured native target-crash reason or complete target identity join
tags:
  - r146
  - it34
  - playwright
  - target-crash
sources:
  - commit 3d29b35fef17263e0963b6a7a16ed1c9efb203a3
  - agent e8b58821-489e-4b56-a8ee-f70d1f5639e9
  - plan: original r002-j0013 fleet20261101-220015-75134
repro: Exact helper and real humanizer propagate the original injected Playwright Error; native crash cause and task outcome not reproduced
status: open
---

## Problem

Original It34 r002-j0013, task polar-odysseys-0ab48db60760, asks for lentil and chili recipes plus make-ahead desserts. On3d29/patchnone it ends nativeFAILED/progress1 after411.7s. There is no completion-verifier verdict. Original failure is preserved; operational classification and resource release are separate axes.

## Diagnosis

All7 normal manifest members and17 embedded request/response payloads independently verify. Archive613c01d3c84483ee8c48c571a27a636860a806281c94144cbe618d4b61c98981; runaf938fd90b96ac565d2a8c77c6c79825c3c5dd2d2878985d1c6a019579aed34e. The schema has17 nodes/15 root fields covering the requested recipe values, URLs, open tabs, dessert choices and summary. No schema omission or semantic rejection is demonstrated.

The last captured actor response requests switch_tab90D6. Worker19712 at22:14:21.359930Z reports switching to90D6, titled the Minimalist Baker lentils recipe. Persisted message index41 (zero-based) at22:14:22.109Z retains the same tab argument and FINISHED status.

Foreground step9 completes target_info, CDP detach, foregrounding and old humanizer close. Cursor initialization starts22:16:15.195015Z and errors22:16:22.081502Z; tab_rebind errors immediately afterward. Worker21622 records the actual stack: handler10417 → _rebind_browser_tab_runtime3155 → BrowserHumanizer.initialize_cursor611 → _playwright_mouse505 → Playwright Mouse.move, raising Target crashed. The exact handler is SHA7b8b8370058376de8ea15d02e0f837d133325d4ab1045524bf6c1a26564e7035, already the qualified client-lifecycle revision; humanizer is SHAbb867e7e06c273a19add63111f525d23c5ff9ea5ebdc7c35f6915857d5a5a3c4.

Terminal cleanup begins after this error, at22:16:22.096838Z. The mux releases its upstream at22:16:25.134450Z. The manager reports the same fatal at22:16:36.718867Z. No earlier socket close/reconnect exhaustion or deliberate Page.crash action was found. At22:16:22.156, other sessions have replies0.1s old. This supports an unrecovered native target failure before cleanup, not a demonstrated global transport outage. Parent independently classified one operational original-job failure and stopped the campaign once; that does not rewrite the original task result or establish a provider cause.

Source discovery checks exact target identity/current-focus membership before returning a changed Page. The foreground target hash is eaf4e073d8186f196d5f43da, but the full plaintext target ID is absent: no complete join between short tab90D6, this hash and the abbreviated telemetry target06A28F is claimed. No Inspector.targetCrashed event, renderer exit reason or browser-host memory log is retained. Guest memory samples describe another host and cannot exclude browser-host OOM. The later credential classifier's captcha outcome follows earlier Google challenge history; it is not the initiating native crash.

All39 supplied audit-file hashes and canonical/mirror equality independently verify. Original lifecycle is verified/controller exit1, audit07622836b732da5b2e89d740eebc1e74f64c0b7a165e177fa944a794e906f080. Exact owner-registry absence is owner-attested. This release evidence grants no task success or universal provider-absence claim.

## Solution

OPEN: no runtime patch. The exact helper/real-humanizer offline control injects the captured Playwright Error at mouse.move and confirms the same Error object propagates. It demonstrates the observed failure path only; it is not a renderer-crash reproduction, causal RED/GREEN repair, or benchmark replay. Source treats proven late ACKs separately and correctly does not silently accept Target crashed. Swallowing this error or blindly reloading/replacing the page would not prove a usable target or preserve requested open-tab/state obligations.

Two archive searches used the literal Mouse.move/Target crashed and behavioral tab-focus/humanizer terms after original inspection. Prior provider-keyboard rebinding and missing-focus passkey Solution/Human feedback were read; neither establishes this cause. Same-task R139 is a lead only: its original stall remains OPEN, while its prospective foreground diagnostics successfully localize the current failure. Independent review confirmed the7/17 payload bindings, exact qualified source and bounded target-identity gap.

The owner checked already-exported artifacts and found no additional browser-host crash reason. A possible future diagnostic is bounded native page-crash identity/reason capture at an existing event boundary, if available; no such instrumentation is implemented or claimed to prevent this failure. No timeout, task, evaluator, credential policy or recovery semantics changed. No live calls or original outcome edits occurred.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while retaining all failures in scope.

## Reusable lesson

A target crash before teardown is distinct from a global socket outage and from an ordinary reconnect. Preserve the fatal stack, foreground ownership and terminal order; a successful propagation control does not identify why the native target crashed.
