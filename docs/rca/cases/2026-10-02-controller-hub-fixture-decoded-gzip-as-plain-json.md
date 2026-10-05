---
id: 2026-10-02-controller-hub-fixture-decoded-gzip-as-plain-json
date: 2026-10-02
title: The controller fake Hub decoded standard gzip request bytes as plain JSON
surface: harness
component: cloudbench-multi-workstream-test-fixture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The loopback Hub fixture passed compressed HTTP request bytes directly to json.loads without applying Content-Encoding
symptoms:
  - "UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b"
  - "benchmark Hub upload failed: Remote end closed connection without response"
tags:
  - cloudbench
  - fixture
  - gzip
  - hub-upload
sources:
  - PR #1299
  - commit e5586839726b96306ebbf9b45a619774bb5db630 (native Linux Step 4cb batch)
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

The existing native Linux controller deploy batch completed all fourteen sibling
commands in 321.201 seconds: eleven passed and three failed. The multi-workstream
control failed after 39.462 seconds when its fake Hub closed upload responses.
The two isolated native-inventory fixture failures have a separate case.
The original full batch remains FAIL and receives no fleet credit.

## Diagnosis

Eight retained server exceptions failed UTF-8 decoding at the fake Hub's
`do_POST` JSON parser. The real shared uploader now emits deterministic gzip
and the standard `Content-Encoding: gzip` header. The fixture still handed those
wire bytes directly to `json.loads`, so registration never reached its intended
run identity or subsequent readback checks.

Exact-error and behavioral archive searches found
`2026-10-02-hub-plain-json-upload-rejected-before-render`. That earlier case
established why the production uploader uses lossless gzip. This recurrence is
a loopback HTTP fixture mismatch, not evidence of another upstream rejection.
An intentional missing-dependency negative control also appears in the retained
log; it is not the cause of this failure.

## Solution

The fake Hub reads the existing Content-Length bytes, inflates them only when
Content-Encoding is gzip, and retains ordinary identity JSON support. Unsupported
encodings return 415; handled decompression and JSON errors return 400. Other
decoder errors cannot register a run. Existing run ID, registration, response
and later readback assertions stay intact. Production
upload contents, authentication, retry semantics and all deadlines are unchanged.

The full existing multi-workstream command is the owning regression and is
already part of canonical deploy Step 4cb. The identical command passed all
thirty-two existing reported scenarios in 1,300.482 seconds after the fixture
correction. No assertion, deadline or verification suite was added.

Original source-bound logs and retained failed fixtures were archived privately
with SHA-256
`56b6ebf18b5186b2079bde0c169b2d94898fe5a7bea592f7e6933db6d7946091`.
All sixteen original recorded command owners were absent, and the retained fake
fixture had no command-line or working-directory owner. All six candidate
process identities were absent, with no remaining group or fixture-path owner;
the suite removed its temporary fixture. The final normal deploy gates and separate
hundred-benchmark acceptance campaign remain pending.

## Human feedback

Keep runner checks compact and faithful to the actual interface. A test-only
parser correction must not weaken payload assertions, change production retry
policy, or retroactively turn a failed run into acceptance credit.

## Reusable lesson

A fake HTTP server must honor standard transport encoding before asserting on
the decoded application payload.
