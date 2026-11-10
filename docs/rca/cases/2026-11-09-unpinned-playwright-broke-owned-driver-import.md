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

## Related cases

The warm-image fingerprint mismatch case concerns selecting a compatible dependency source. This incident also shows that equal unbounded manifest fingerprints do not establish an identical resolved SDK. The native driver ownership case remains the authority for cancellation and exact process cleanup. Neither an old passing task nor a source-only comparison replaces actual runtime proof.

## Human feedback

No new feedback for this SDK repair. The existing assignment requires unchanged task assertions, deadlines, concurrency, privacy guards and native outcomes.

## Reusable lesson

Pin an SDK when ownership depends on its private APIs. Verify the installed adapter boundary before publishing an image; matching unbounded manifests alone does not establish runtime compatibility.

## PR1881 follow-on integration

PR1881 consumed an already published dependency image and independently reached the same SDK import boundary. Its original source `b5ede511a36a1f9a0eab538d6c539bdbefba3415` reused the published donor snapshot without resolving dependencies. Six native browser/payment tasks failed with their original assertions; scoped payment snapshots showed no new financial identifiers. Its authentic earlier passing image contained Playwright 1.64.1, while the failing image contained 1.65.0. The same frozen owner imports successfully against the former and fails against the latter. This differs from the earlier PR1905 handler baseline described above; neither comparison identifies the earlier image publisher.

A subsequent six-check stage consumed the new pinned image but correctly refused the old unpinned source fingerprint before executing tasks. All six checks remain UNVERIFIED; their original resource and financial obligations remain quarantined. The existing isolated-validation contract permits a separate execution namespace with the six exact old Machine/Volume pairs excluded, without granting cleanup or execution credit.

PR1881 integrates the established minimal SDK pin and post-copy import guard from commit `848540637510d2090ecaa11a1b49f7f1515cf3dc`. On November 10 UTC, its unchanged registered browser-cleanup suite passed all 55 cases. Fresh source-bound native task acceptance and full deployment gates remain pending; this local result does not close the original task failures.
