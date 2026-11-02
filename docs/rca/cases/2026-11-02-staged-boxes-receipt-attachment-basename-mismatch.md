---
id: 2026-11-02-staged-boxes-receipt-attachment-basename-mismatch
date: 2026-11-02
title: Native worker receipt attachments use the file stem before their delivery suffix
surface: harness
component: deploy-test-boxes
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Attachment collector searched result.json-- while native delivery writes result--
symptoms:
  - Large complete worker results stayed UNVERIFIED despite successful file delivery
tags:
  - deploy
  - worker-transport
  - receipt-provenance
sources:
  - PR1662
  - adapter-v2 patch 6e02de83e8c44952f8d8516be4d22c17816a2d279b13539af420d1410f5a4163
repro: scripts/tests/deploy-test-worker.test.py Boxes.test_large_result_passes_via_attachment_or_hash_matching_inline_only
status: fixed
---

## Problem

While preparing the first actual cross-machine validation request, inspection
of already delivered native attachments found `result--8d855be9a6b433a2bf8e.json`
and `result--774eabb033749d359366.json`. The new collector and its fake transport
instead agreed on the invented `result.json--` spelling. Small inline receipts
masked that integration gap; large file-only receipts could never be found.

## Diagnosis

Gate: INTRODUCED. The first bad boundary is `find_attachment` in the new staged
transport. The platform strips the original extension before adding its
delivery suffix. Correcting the existing large-result fixture to use the
observed native spelling makes the same test fail: both cases are UNVERIFIED
after 30.126 seconds. No production gate or application failure is inferred.

The archive contains earlier attachment-selection cases, but none cover this
new boxes worker receipt collector. Native delivery evidence and the exact
before/after logs are retained in `.context/preparation/transport-attachment-`
`basename-{before,after}.log` on the originating deployment.

## Solution and proof

Search the native `result--*.json` spelling as well as the old spelling. The
declared full SHA256, request token, source, recipe, root, native exit and
complete case inventory still determine acceptance; a matching filename alone
proves nothing. Oversize, missing or mismatched files stay UNVERIFIED.

The unchanged corrected large-result test passes after the collector fix:
one test, 0.346 seconds. The real transfer then exposed a second fixture error:
send acknowledgements use a top-level operation/disposition receipt, unlike
the read/wait/result data envelope. A native send fixture now pins that parser
and verifies the requested thread identity. Its two focused controls passed
in 0.307 seconds. The initial UNVERIFIED transport result remains recorded.

Recovery adopted the original accepted turn from the durable native send
receipt, with exactly one send and one worker execution. At 20:03:57Z the
small and large cases both passed; the received native file was 67337 bytes,
SHA256 18077b982ccb03b3c0a1ec5ceda2827789b1b32ef30ca7bf9d3309cb04023d01.
The worker host, source, root, recipe, cleanup and native exit were verified.
Evidence: `.context/preparation/transport-probe-proof.json`, the native send
receipt, and the original UNVERIFIED result on the originating deployment.
These are transport checks, with no application-gate credit.

## Human feedback

The user requires complete parallel validation and a finished deployment, with
native failure evidence preserved. A fake transport agreeing with itself is
not sufficient evidence for the actual platform integration.

## Reusable lesson

Use observed platform artifact names in transport fixtures, and prove a
file-only result large enough to exclude a conversational inline shortcut.
