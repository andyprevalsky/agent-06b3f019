---
id: 2026-11-05-checkpoint-enumerated-detached-iframe
date: 2026-11-05
title: An iframe detached after enumeration and aborted the entire private browser checkpoint
surface: back-end
component: browser-checkpoint
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: readFrameStorage treated a frame removed after frames() enumeration as a fatal read failure
symptoms:
  - "Failed to close browser session"
  - "frame.evaluate: Frame was detached"
  - "Browser session cleanup failed"
tags:
  - browser-session
  - checkpoint
  - iframe
  - detach
  - race
sources:
  - agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb
  - commit 67998442e44f8cbba942040d9cbeeaea84eb0cb0
  - PR #1866 (shipped; merge 7577a6573682179b3715fa25e9433e27cf9e24e6)
repro: back-end/src/tests/blackbox/browser-session-opaque-frame.cases.ts
status: open
---

## Problem

Render logs at 2026-11-03T04:01:35.137Z show pause for the root native; at 04:01:35.526Z the backend reports `frame.evaluate: Frame was detached`. The worker persisted a cleanup failure receipt with pause=true and HTTP=500. The logical row remained ACTIVE with checkpointRevision=0, so later native expiry left no saved private checkpoint.

## Diagnosis

Path: browser task completes -> worker releases CDP -> POST close -> checkpointLogicalBrowser -> frames() snapshot -> readFrameStorage -> removed iframe throws -> no checkpoint commit. A live page may remove ad/payment frames while its remaining tabs and storage are valid. Snapshot membership is not a lifetime guarantee. The deepest owned fix belongs at the individual frame reader, not in a retry of the entire browser operation.

The permanent real Chromium/Prisma/encrypted-store fixture schedules removal after enumeration but before reading that frame; it does not fabricate the Playwright error. From back-end, `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_cloud-1c7143dc DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_cloud-1c7143dc ../node_modules/.bin/tsx src/tests/blackbox/browser-session-review-regressions.fixture.ts --opaque-only` failed on baseline production code with `frame.evaluate: Frame was detached`, then passed unchanged after the fix. Setup is the standard browser-session blackbox runner, which provisions the isolated local database; substitute its printed local URL on a fresh devbox. Evidence: `.context/rca-7a2ead9f/checkpoint-before.txt` / `checkpoint-after.txt`.

Archive searches: `checkpoint frame detached` and `Frame was detached`. Relative of `2026-10-27-approval-wait-omits-private-browser-checkpoint` and `2026-10-28-tilion-pause-checkpoint-waited-for-worker-owned-cdp-socket`; neither fixes this first-bad boundary.

## Solution

At the shared frame reader, ignore a failed storage capture only when Playwright positively confirms that exact frame is detached. Keep throwing storage/security/provider failures on surviving frames. The same test checks cart localStorage and approval sessionStorage survive encrypted restore and that an eligible live-frame SecurityError prevents checkpoint advancement. Detached-frame handling applies to every provider and site; no site keywords, timeouts or whole-checkpoint retry loop. The reader cannot be removed or merged with another capture: it owns partitioned child-frame state. A narrow liveness check is required.

Golden reference: not applicable (ordinary browser storage I/O; no approval-gated hunk). The regression is invoked by browser-session-review-regressions.fixture.ts -> runBrowserProviderLifecycleCases -> browser-session.blackbox.ts, which deploy runs for this surface. Local fail/pass proven; status stays open until complete review/deploy verification. The original expired native's uncaptured state remains unrecoverable.

CodeRabbit's late comment4487761105 exposed a second timing window: DOM storage can be read successfully before the same frame detaches during IndexedDB capture. Discarding that result also discarded a newly discovered origin absent from the previous checkpoint. The existing popup fallback therefore never visited it. The repair now records the observed origin before the IndexedDB await and lets the existing same-partition popup capture recover the complete namespace.

The permanent real-CDP regression now exercises both detach windows in the first checkpoint. A new origin has actual sessionStorage, localStorage and IndexedDB, then its iframe is actually removed between the first storage evaluation and IndexedDB evaluation. Against the prior repair the new origin assertion fails; against the follow-up the identical test passes and a fresh context restores all three values. Original opaque-frame, parent storage, live-frame failure and unchanged checkpoint revision/ref assertions remain. Private receipts: checkpoint-observed-origins-before.log (exit1) and checkpoint-observed-origins-after.log (exit0). No origin is inferred from an opaque frame URL, no incomplete IndexedDB state is accepted, and no missing historical checkpoint is reconstructed.


CodeRabbit's third review4489734424 exposed the earlier storage-getter window. A frame can leave during the first session/localStorage evaluation, before any origin is retained. The reader now first confirms the initialized security origin through the frame itself, excluding opaque, non-HTTP and top-level origins, then records it before touching storage getters. It still records the successful storage evaluation's origin before IndexedDB to cover intervening navigation. It never guesses from a sandboxed frame URL.

The same permanent real-Chromium regression now creates two first-checkpoint origins: one actually detaches during its first DOM-storage read, the other during IndexedDB capture. Before this correction the checkpoint has one saved frame instead of two; after it passes unchanged and restores both namespaces' sessionStorage/localStorage/IndexedDB in a fresh context. Opaque-frame, live-frame-error, source revision/ref retention and actual frame detach assertions remain intact. Exact private evidence: checkpoint-first-storage-before.log (exit1,1!==2), checkpoint-first-storage-after.log (exit0) and checkpoint-first-storage-results.json (identical fixture hash; canonical sources unchanged during private overlay validation). The initial isolated DB setup error is preserved separately and grants no regression credit.


The managed independent review at 2026-11-06 22:59 found the remaining pre-origin-probe window (Gate: INTRODUCED). Detachment does not destroy a tab's session namespace. Before a successful initialized-origin probe, safe omission cannot be established and the recovery popup has no verified origin. The reader now propagates that actual detached-frame exception unless its initialized origin was already recorded. This prevents checkpoint advancement and native release instead of silently losing unknown state.

The extended permanent real-Chromium/Prisma/encrypted-store regression seeds sessionStorage in the transient iframe, detaches it before its first origin probe, and requires capture failure with unchanged checkpoint ref/revision, same native binding and ACTIVE status. A fresh CDP client reattaches the origin and reads preserve-me from the retained source. A subsequent checkpoint still captures all three namespaces; both later detach windows, opaque-frame exclusion and live-frame-error retention remain covered. The identical assertion fails against d98a (Missing expected rejection) and passes after. Private evidence: unobserved-origin-before.log and unobserved-origin-after.log. This deliberately retains unknown state rather than guessing a security origin from the URL. The original incident's expired revision-zero browser remains unreconstructable.

## Human feedback

The user requested `/rca` for agent 7a2ead9f-79e9-4c4f-bb80-a0f70b3900eb and asked to fix all its browser issues. No subsequent corrections recorded.

## Reusable lesson

Revalidate each enumerated frame at the storage-read boundary and distinguish a confirmed detach from failure to capture a still-live frame.
