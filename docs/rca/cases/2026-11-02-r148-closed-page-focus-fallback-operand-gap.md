---
id: 2026-11-02-r148-closed-page-focus-fallback-operand-gap
date: 2026-11-02
title: Closed input page after tab close lacks local focus-fallback operands
surface: agents
component: browser-focus-synchronization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "Step42 focus synchronization falls back to the locally closed input page and tab rebinding rejects it after successful close_tab/native focus recovery; original lookup operands are absent"
symptoms:
  - Native FAILED with progress1 after986.6s
  - Existing closed-input guard fails before terminal cleanup
  - No completion-verifier rejection precedes the failure
  - Original Playwright context and page membership are not captured
tags:
  - r148
  - it35
  - playwright
  - focus-fallback
sources:
  - commit f797a2c4a98f1d891c3c32eea48a4038c02edf8c
  - agent f62cbb64-b9cc-4552-9fe3-73c72152730f
  - plan: original r001-j0009 fleet20261101-235054-2021266
repro: Exact-source fallback controls distinguish missing focus and missing replacement membership; original operand and task outcome remain unreproduced
status: open
---

## Problem

Original It35 r001-j0009, task polar-odysseys-170314aa3a93, executes f797/patchnone and ends native FAILED/progress1 after986.6s. The fatal is `RuntimeError: Playwright input page closed during attachment or focus binding`, not a semantic completion-verifier rejection. Original task failure remains unchanged.

## Diagnosis

All7 original normal members and43 encoded request/response payloads verify. Run SHA256 is f936d44e77d30a6e0fd9d3e02a02898a05d3da0935ead6101209d0a91f8213df; worker SHA256 is 93855d70873a8792dc3e4ff8c12e40c846dca732a545cd5611a4ad23af105383. The schema has6 nodes/3 root fields covering the ASUS monitor URL, at least3 motherboard title/site/URL entries and B&H GPU URL. No demonstrated schema omission or verifier-data failure explains the fatal.

The socket close at00:09:35.809449 recovers by00:10:04.298106, followed by further actions. At00:13:59.930480 the actor chooses to close WePC tab562A. Worker14969 records close success at00:14:00.129405;14975 records native focus recovery to F33E9235 at.282726. Step42 user control completes, then tab_rebind starts14982 at.302040 and errors14983 at.302630 without nested target-info or foreground traces. The fatal stack14984 at.305078 reaches handler10417 → _rebind_browser_tab_runtime3140 → _require_live_playwright_client3116. Cleanup and upstream release14996 follow; manager15031 reports the same failure. This supports an unrecovered native-runtime failure before cleanup. The parent independently used its one operational-stop rule; no provider/global-outage cause or task credit follows.

F33E9235 identifies the XDA tab in native telemetry. At14989, its outstanding native calls coexist with another session's reply0.5s earlier. Native focus recovery proves a session/focus assignment, not a matching live Playwright Page. Original context inventory, cached Page membership and lookup focus operand are absent, preventing selection among missing focus, missing contexts/matching Page, or changed focus during synchronization.

## Solution

Cause remains OPEN. Exact-source offline controls show that a closed current Page can switch successfully to a live cached focused Page. Missing focus and missing replacement membership separately return the old closed Page and trigger the same guard. These are diagnostic counterexamples, not proof of either original operand, a causal repair, or an exact benchmark replay. Removing the guard or rebuilding browser state speculatively would not prove safe continuation.

Prospective diagnostic patch6105cba68c5028eee2445f5e38aa9e394962fa641d881fbc041a43cd57ee9340 changes only the existing handler and registered blackbox test. It records a fixed fallback/refusal reason and bounded local focus-present, context/page/live-candidate counts, current-closed and client-connected flags. Page/live counts cover the first context used by the existing lookup, capped256 with an explicit truncation flag. A live candidate means locally not closed, not target-matched or renderer-ready. Unknown getters remain unavailable; observations are not atomic identity proofs. No raw target IDs, URLs, content, credentials or arbitrary exception text are added. No new await/CDP request, retry, timeout, state mutation or recovery is introduced. Existing return values, liveness errors and cancellation remain authoritative.

The same registered diagnostic assertion fails the original handler and passes the candidate. All3 new registered controls pass five consecutive same-byte runs; final9 diagnostic/client-lifecycle/close controls pass. Independent A review finds exact patch GROUNDED for prospective diagnostics only, independently repeats baseline RED/candidate9 GREEN and verifies both path hashes, compile and private-index apply. The candidate remains unapplied in this handoff; parent integration and any future run are separate. Original cause and outcome remain unresolved.

Two archive searches used the literal closed-input/focus-binding error and behavioral closed-tab/remaining-page/cache terms. Prior client-lifecycle, keyboard/focus and missing-focus cases are leads, not this incident's proven cause. Personally opened primary reference excerpts are Codex shell_snapshot.rs180–246, OpenClaw embedded-agent-subscribe.handlers.lifecycle.ts60–110, and Hermes chat_completion_nonstream.py140–210: fixed diagnostic classification, best-effort events and separation of chatter from progress. Exact SHA-bound excerpts and local synchronous Playwright accessor implementations accompany the review packet. Their recovery policies are not imported. The healthy remaining-page control is contrary evidence against a universal close-tab defect.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

Successful native focus recovery and a closed old Playwright Page do not establish why the local lookup fell back. Capture the local decision operands without turning telemetry into readiness or weakening the existing refusal. A diagnostic RED/GREEN control does not establish the original browser-state cause or task success.
