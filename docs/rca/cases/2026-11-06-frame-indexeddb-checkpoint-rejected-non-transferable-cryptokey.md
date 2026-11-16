---
id: 2026-11-06-frame-indexeddb-checkpoint-rejected-non-transferable-cryptokey
date: 2026-11-06
title: Frame IndexedDB checkpoint threw on a stored CryptoKey, failing the payment-approval pause
surface: back-end
component: browser-checkpoint-indexeddb
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/checkpointIndexedDB.ts transfer encode/visit — any non-transferable host object in any record of a cross-origin frame's IndexedDB threw and aborted the whole checkpoint, so checkpointLogicalBrowser and the pause failed
symptoms:
  - "Unsupported checkpoint IndexedDB value type: CryptoKey"
  - "POST /api/browser-session/close -> 500"
  - "Browser session cleanup failed: session=<id>, pause=True, HTTP=500"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
tags:
  - browser
  - checkpoint
  - indexeddb
  - approval-resume
  - payment
sources:
  - agent a85884d7-ce1d-46c6-b546-2af662e0cd71
  - fleet run 20261106-190604-1376032 anti-bot-blue-bottle-order-online r001-j0005 (descend H-40)
  - task anti-bot-blue-bottle-order-online
repro: back-end/src/tests/blackbox/browser-checkpoint-indexeddb.blackbox.ts
status: fixed
---

## Problem

anti-bot-blue-bottle-order-online (LIVE campaign 2026-11-06, agent
a85884d7-ce1d-46c6-b546-2af662e0cd71) reached the order.online checkout and the
browser agent called `request_payment_card` for $11.25 at 19:34:50Z (worker:
"Payment card approval required - returning to workflow"). The approval park
then calls the shared pause. Backend at 19:35:16.513Z:
`[BrowserSession] Failed to close browser session error="Error: frame.evaluate:
Error: Unsupported checkpoint IndexedDB value type: CryptoKey ... at visit
(<anonymous>:88:15) ... at async encode (<anonymous>:91:20)"` and
`POST /api/browser-session/close -> 500`. The worker raised
`BrowserSessionCloseError ... pause=True, HTTP=500` (handler.py
`if cleanup_failure is not None: raise BrowserSessionCloseError`), so the
browser task ended `status=error` and the workflow never received
`awaiting_payment_card_approval`; no payment_approval attention request was
created. The root audited for 12 minutes and hit the 1800 s task timeout.

## Diagnosis

Critical path: browser agent request_payment_card → approval park →
`_close_browser_with_cleanup_receipt(pause=True)` → `POST /close` →
`withLogicalBrowserPause` → `checkpointLogicalBrowser` → per-tab
`readFrameStorage` → `captureFrameIndexedDB(frame)` → in-page `transfer`
capture → `encode`.

First bad data: `encode`'s `visit` throws for any tag outside its explicit
list. A cross-origin frame on the checkout page held a `CryptoKey` in
IndexedDB (sites store non-extractable WebCrypto keys for device binding).
CryptoKey is structured-cloneable inside one browser but cannot be exported
when non-extractable, so it can never be carried to a fresh native browser.
Because `encode` serializes all databases as one graph, one such record threw
for the whole frame, `checkpointLogicalBrowser` rejected, `withLogicalBrowserPause`
rolled the row back to ACTIVE and the close route returned 500.

Downstream (not a separate defect): case
2026-10-27-approval-wait-omits-private-browser-checkpoint deliberately made
approval parking refuse to report a successful park when the pause/checkpoint
receipt fails, because the approval resume restores that checkpoint into a new
native browser. Emitting the approval without a resumable checkpoint would
approve (and mint a card) for a session that cannot be restored. The loss of
the approval is therefore the designed fail-closed consequence of the
checkpoint defect, not an independent ordering bug.

Deepest owned cause: the checkpoint's contract is "capture everything this
browser can transfer"; the encoder instead treated "one value cannot be
transferred" as "nothing can be checkpointed". Playwright's own
storageState IndexedDB collector (golden reference, playwright-core
`_trySerialize`/`_collectDB`) never fails on host objects either.

Archive searches: "Unsupported checkpoint IndexedDB value type CryptoKey
browser-session close 500" (no match on the string; related IndexedDB upload
cases only) and "payment approval lost browser pause checkpoint failure close
cleanup failed" (relative: 2026-10-27 approval-wait checkpoint, 2026-10-28
Tilion pause checkpoint). Novel cause; relative of the 2026-10-27 case.

Repro (real Chromium, real cross-origin frame partition, production
capture/restore functions):
`cd back-end && node --import tsx src/tests/blackbox/browser-checkpoint-indexeddb.blackbox.ts`
Pre-fix: exit 1, `frame.evaluate: Error: Unsupported checkpoint IndexedDB
value type: CryptoKey at visit (<anonymous>:88:15)` — the same in-page frame
and line as production.

## Solution

`checkpointIndexedDB.ts` encodes each IndexedDB record atomically. When a
record's value contains a host object the graph encoding cannot represent, that
record alone is omitted (its partial graph nodes and identity entries are rolled
back), and the capture reports `{database, store, type, count}`. Every other
record, the schema, indexes and key generators are kept. The checkpoint
envelope carries `omitted` (absent when nothing was omitted) and the backend
logs `Browser checkpoint omitted non-transferable IndexedDB records` with the
frame origin. Restore is unchanged: the site sees the record missing, exactly
as on a fresh browser, and regenerates its key; no placeholder value is ever
written. Errors other than unsupported types still fail the checkpoint.

Post-fix the identical command exits 0: the frame capture omits 3 CryptoKey
records (2 in an out-of-line store, 1 nested in an autoIncrement store),
restores the transferable record byte-for-byte, keeps DB version 3, and the
next autoIncrement key is 3 (generator preserved past the omitted key 2).

Not changed: approval parking still refuses success when the pause fails
(2026-10-27 design). Playwright's first-party `storageState({indexedDB:true})`
path does not throw on a CryptoKey but restores it as an empty object; that
silent first-party substitution remains a separate open observation.

10k-agent behavior: per-checkpoint, in-page work only; one extra Map scan per
omitted record (bounded by that record's nodes), no new DB rows, queries,
channels or shared state.

## Human feedback

None recorded.

## Reusable lesson

A browser-state checkpoint must omit and report individual values that cannot leave the browser, never let one non-transferable record fail the whole pause it guards.
