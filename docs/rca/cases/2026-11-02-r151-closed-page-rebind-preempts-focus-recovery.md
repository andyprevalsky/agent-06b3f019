---
id: 2026-11-02-r151-closed-page-rebind-preempts-focus-recovery
date: 2026-11-02
title: Closed-page rebinding fails before native focus recovery completes
surface: agents
component: browser-tab-focus
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "The next tab rebind returns the closed old Page while authoritative native focus recovery is still in flight"
symptoms:
  - Successful close_tab precedes missing-focus fallback and closed-page refusal
  - Native focus recovery completes after the fatal exception
  - Native FAILED with progress1 instead of a completion-verifier rejection
tags:
  - r151
  - it37
  - focus-recovery
  - playwright
sources:
  - commit d904db6fe5cd01a684644f854d1446b7661dbb2a
  - agent e9c7b8dd-b77e-4da0-8a24-de8955004643
  - plan: It37 r001-j0010 fleet20261102-030240-805677
repro: Actual rebind and SessionManager recovery reproduce premature closed-page refusal; candidate waits for authoritative focus and selects its exact Page
status: open
---

## Problem

Original It37 r001-j0010, task polar-odysseys-55bd922b66b0, executes d904/patchnone and ends native FAILED/progress1 after240.9s. The fatal `Playwright input page closed during attachment or focus binding` is a runtime failure before cleanup, not a returned semantic verifier rejection. The parent owns the operational-stop decision; the original task remains FAILED.

## Diagnosis

All7 sealed members independently match their manifest. Archive SHA256 is5f7edd633a7d01ef844252644b5b4e7b43cd598106357b67aed3735a70057150; run6f1e6182bff8858a95908a1023eb457873e943c332f05076e4bb7737c47ef5a6; worker6b083273ec176a57fa9024354c447456221162a014f190cc4842e7497d852349. The source export is exact d904; all1293 tracked agents files match it except the two disclosed candidate overlays.

The following indices are zero-based in the original embedded worker list. At8581, close_tab succeeds at03:14:14.818307. At8584, native recovery starts switching to18512EE5 at.824825. Step24 rebind starts8593 at.891740. At8594/.892012, R148 diagnostics record missing_focus, focus_present=false, one context, two pages/two locally live candidates, current_closed=true and client_connected=true. The closed-page guard fails8597 at.893882. Native focus recovery completes8598 at.927104, after that fatal. Cleanup starts8620 at03:14:21.858961; the manager propagates the failure8636 at03:14:23.711137. Full sealed worker chronology confirms the same ordering.

The earlier screenshot timeout at03:14:04.609339 is followed by read_network_requests and successful close_tab. It does not establish continuous global transport failure. The new missing-focus operands distinguish this incident from R148's unresolved original operand gap. Two locally open pages alone do not establish which Page may receive input.

Exact-source synchronization reads missing focus and immediately returns the old closed Page. The existing SessionManager API has a bounded event-driven ensure_valid_focus barrier, but this path does not await it. An offline reproduction uses the actual rebind and actual installed SessionManager recovery with native transport mocked: the original guard raises, then the same recovery completes with a valid replacement. This establishes the owned sequencing defect; it does not reproduce or upgrade the original task outcome.

## Solution

Frozen two-path patchd188d3174392b544a46862275aba10d3b68b60ae58b2453432fc501f230cd4fc waits on existing ensure_valid_focus only when focus is missing and the old Page is locally closed. It preserves the existing3s default, rejects changed session or unsuccessful validation, then rereads authoritative focus and runs the existing exact-target, current-membership and liveness checks. No arbitrary tab selection, new provider session, blind reconnect, retry, raised timeout or removed guard is introduced. Cancellation propagates; a live current Page or absent recovery API retains prior behavior.

Candidate helper SHA256 iscd2ec75bcd33e21930ab34e899ce92d06608d104dff1263c279aa21fd634a572; registered test8473206ab1c484d83fc15f0a40fd608aa147d49cbdf498490fd84fdced538c6d. The same registered assertion is RED on the original handler and GREEN on the candidate. Nine scenarios cover successful/failed/absent recovery, missing API, live current Page, cancellation, session replacement, closed replacement and changed focus. The new registered control passes five consecutive runs; all11 selected focus/diagnostic/cache/keyboard/full-activity lifecycle controls pass. Compile and private-index apply checks pass. Independent C review finds exact patchd188 GROUNDED: all1293 base-file hashes and original7/timeline verify, the original registered control is RED, the real SessionManager composition returns the exact replacement, and all11 selected registered controls pass. The exact candidate then passed the full registered browser-domain suite: 950 PASS, 0 FAIL in253.453448s, original tool10719. The coordinator verified the raw log SHA256 df1fa8b50ced9a0cd12815753b61ac6460e701ac8dc7577760adfa3178ceeebf, applied the exact two reviewed file hashes on the descent branch, and passed Python3.11 compilation and whitespace checks. No live benchmark outcome is claimed; the original task remains FAILED and outcome qualification remains open.

The exercised local dependency is browser-use0.13.11, permitted by d904 requirements. Its SessionManager source SHA256 is3b2b861ac143e214ba6e8a0a773192a6dbb72653089a1f278f7c21e3faf7455c. Original guest site-package bytes/version are not sealed, so exact deployed dependency-byte equality is unclaimed. The existing native recovery chronology independently supports the observed ordering.

Two archive searches used missing_focus/closed-page and focus-recovery/tab_rebind. R148, R118 and the earlier passkey missing-focus case supply distinctions, not inherited cause. Personally opened primary references are the packaged SessionManager/BrowserSession barrier, OpenClaw exact-target/stale-connection tests, Hermes supervisor attach-before-publish behavior and Codex authoritative-status wait. These support waiting on owned state and preserving identity; their unrelated recovery policies are not imported.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

A missing focus during an observed recovery is not permission to choose any live Page or to publish a closed one. Await the existing authoritative handoff, then revalidate session, target and membership. A successful offline handoff control does not establish a successful original task.
