---
id: 2026-11-09-unpinned-playwright-broke-owned-driver-import
date: 2026-11-09
title: A fresh dependency image installed a Playwright SDK incompatible with the owned driver
surface: agents
component: browser-driver-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: PlaywrightOwner imports the private 1.63 connection module from a freshly resolved 1.65 SDK
symptoms:
  - "ModuleNotFoundError: No module named 'playwright._impl._connection'"
  - Browser initialization fails after CDP attachment with zero task actions
  - Browser trajectory, isolation and downstream payment assertions fail at their original deadlines
tags:
  - playwright
  - dependencies
  - browser
  - cloudbench
sources:
  - PR #1905
  - PR #1915
  - commit cb7a8ae130a179f92bb20e1a1ab848f7d76d9092
repro: executed
status: open
---

## Problem

The unchanged native browser tasks failed after a required benchmark dependency-image rebuild. The source requirements admitted Playwright 1.65, while the native driver ownership adapter explicitly targets 1.63 private APIs. Both browser tasks allocated sessions and attached CDP, then failed before the task action loop. Zero trajectories were authentic failed initialization, rather than missing evidence for completed browser actions. Original deadlines and assertions remain intact.

## Diagnosis

The actual fresh image build installed Playwright 1.65. Guest provenance and native dependency synchronization show that the failed workers consumed that image's Python graph. The official checksum-verified 1.65 wheel contains `playwright/_impl/connection.py` and lacks the `_connection.py` module imported by `playwright_owner.py`.

Both independent investigations reproduced the exact owning import failure with the authentic 1.65 wheel. The unchanged existing native startup and cancellation assertions pass with the installed 1.63 control and prove real driver exit and settled tasks. Owning source bytes match the branch base and compared main revisions; that narrow source comparison supplies no release waiver because this deploy changed the consumed dependency image. Treat this integration failure as introduced by preparation. Original passing browser tasks used an older handler without this owner adapter, so their PASS is not a same-boundary baseline.

## Solution

The requirements now pin Playwright 1.63.0, matching the SDK contract the existing owner implements. The existing post-copy image verification step also imports the real owner, so an incompatible graph fails before publication/activation. Retain its native process-exit, cancellation and resource ownership behavior; do not rename one private import and assume the newer SDK has identical internals. Keep the existing owning browser-cleanup suite and all browser/payment task assertions. A new compatible source-bound image and fresh native task/publisher/full-gate acceptance remain required before closure.

## Verification and retained limits

The controlled 1.65 failure and 1.63 controls are causal evidence, not a repaired native campaign. The source pin and image import guard are implemented; the existing native owner controls are being checked without changing their assertions. Fresh rebuilt-image and full repaired task/publisher acceptance remain pending. Historical native task failures, downstream assertion failures, original campaign grades and clocks remain unchanged. No provider-outage, credential, financial, or test waiver is inferred. Private raw logs and wheel inventories remain outside Git.

The exact local causal reproduction and its immutable wheel inventory are retained privately. The existing registered owning suite is run with:

```bash
cd agents
venv/bin/python tests/blackbox/browser_cleanup_receipt.blackbox.py
```

Before repair the actual image installed 1.65 and the unchanged owner import/native cases failed. The installed 1.63 control passes the same native startup/cancellation assertions; it supplies no full task or image acceptance credit. The new image must pass its real import guard and the unchanged native browser/payment tasks at their original deadlines.

## Production recurrence on November 10

Agent 546485cc-45c4-48f7-80cf-1e7f3d4fb2a8 encountered three initialization
failures before any action or navigation. The exact failed worker's stopped
image was inspected through authenticated registry reads without restarting it.
Its checksum-verified dependency layer contains intact Playwright 1.65.0 and
the public `connection.py`/`transport.py` paths, matching the official wheel;
the owner's required `_connection.py` is absent. This is an incompatible
resolved SDK, rather than a corrupted installation, site failure or OAuth error.
The owner bytes match the unchanged reproduction and compatible 1.63 control.

The independent recurrence on agent 03f268b1-384c-5092-8ea8-8a7fbb022789
has the same zero-action stack and actual failed-machine readback of 1.65.0.
Its existing phone coordinator owns the eventual original-device retry.
PR #1915 reconciled with the original repair owner and reused the exact
three-file compatibility patch. Independent existing owning suites pass all
55 startup/cancellation cases with 1.63; the identical owner import fails with
the authentic 1.65 wheel. These controls do not establish a production rollout.
Exact merged-source deployment, live installed-package/import readback and
production browser navigation remain required for this assigned repair.

The first PR #1915 cloud smoke campaign retained eleven native successes and
two native SKIPPED non-passes: one judge capacity classification and one exact
sandbox AgentCard release stall. Neither supplies acceptance credit or a waiver
for the assigned SDK failure. All original controller and cleanup receipts are
retained. A separate semantic adapter defect dropped completed retried UI
assertion failures to UNVERIFIED; its distinct case records the reporting repair.

## Related cases

The warm-image fingerprint mismatch case concerns selecting a compatible dependency source. This incident also shows that equal unbounded manifest fingerprints do not establish an identical resolved SDK. The native driver ownership case remains the authority for cancellation and exact process cleanup. Neither an old passing task nor a source-only comparison replaces actual runtime proof.

## Human feedback

No new feedback for this SDK repair. The existing assignment requires unchanged task assertions, deadlines, concurrency, privacy guards and native outcomes.

## Reusable lesson

Pin an SDK when ownership depends on its private APIs. Verify the installed adapter boundary before publishing an image; matching unbounded manifests alone does not establish runtime compatibility.
