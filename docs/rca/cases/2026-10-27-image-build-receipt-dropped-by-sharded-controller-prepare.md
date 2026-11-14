---
id: 2026-10-27-image-build-receipt-dropped-by-sharded-controller-prepare
date: 2026-10-27
title: Sharded controller preparation dropped the pinned image build receipt
surface: harness
component: original600-portable-controller
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-original600-controller.py prepare remote_files and remote_env construction
symptoms:
  - CLOUDBENCH_IMAGE_BUILD_RECEIPT missing from remote controller environment
  - Host image proof exports present but no staged image receipt
tags:
  - image-build-receipt
  - sharded-controller
  - immutable-input
sources:
  - commit 1001d7458814ae303e2cc0ea7b6802f6d7213dbc
  - commit 0ce4a2dae26494245fffb9eca2038bdc14faa8db
  - agent ph74rex3pescaywbxyjn3njr158h3pp9
repro: scripts/tests/original600-portable-operator.test.py ImageProofTransport
status: open
---

## Problem

The fresh REAL image admission consumer introduced by I19 requires a private,
hash-pinned image-build receipt. Ordinary local campaigns inherit its exports,
but the wide campaign operator constructs an explicit remote environment and
artifact list. Offline preparation with both host exports produced zero remote
image keys and zero staged image receipts. This is an integration defect found
before a live wide launch, not a measured failed 40-copy campaign.

## Diagnosis

The normal run-bench 40-copy check forwards the host exports to the operator.
The first loss is prepare(), which transported the warm snapshot metadata but
not the image receipt. Forwarding the original absolute host path alone would
also be invalid on a remote controller. Baseline actual prepare/runner/payload
controls fail at the missing remote receipt; the same controls pass after the
transport change. The test invokes the actual I19 consumer after production
payload decoding and staging, with only the native launch boundary replaced.
Deleting the original host receipt after payload creation still permits the
remote consumer to verify the staged bytes. This separates transport correctness
from image compatibility and from an actual campaign outcome.

## Solution

Add explicit optional path/hash inputs using the existing private owned bounded
file reader, bind them in admission, and deliver the receipt through the existing
hash-checked remote_files carrier. Set only the two named remote environment keys
to the canonical staged path and digest. The runner rejects unstaged or mismatched
receipt pointers. I19 image digest, dependency fingerprint, and publication
checks remain unchanged. No provider calls, image writes, task edits, timeout
changes, or new transport channel are introduced. One bounded metadata object is
copied per controller, not per guest.

The exact four-path implementation patch has SHA256
31ae87fabdcb5d290dffd2fd1fc3b346f1ae70bac2d6bb670048f7b4f08cbab2 and was
independently reviewed GROUNDED before application. The existing registered
portable operator suite contains the regression. Controls reject modified
image/fingerprint/publication, checksum corruption, source mutation, partial
pins, unsafe files, and environment substitution. Legacy absent-input behavior
is preserved. Live width-40 outcome remains unproven, so this case remains open.

## Human feedback

The parent requested proof through the actual sharded launcher and consumer,
using the existing immutable artifact carrier; no broad environment forwarding,
paid trial, image operation, or weakening of I19 admission was authorized.

## Reusable lesson

A host-local proof is not available remotely until its verified bytes and their
identity are explicitly carried through the controller artifact boundary.
