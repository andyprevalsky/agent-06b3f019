---
id: 2026-10-29-typescript-text-helper-accepted-binary-options
date: 2026-10-29
title: UTF-8 TypeScript process helper declared unsupported binary output options
surface: back-end
component: process-safety
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: execTypeScript declared ExecFileOptions encoding flexibility while overriding every call with utf8
symptoms:
  - encoding buffer accepted while stdout is string
  - unused ts-expect-error on incompatible encoding
tags:
  - typescript
  - encoding
  - process
sources:
  - PR #1627
  - commit 0c798385b66e049979c684ed3478940371539e85
repro: bash /var/tmp/deploy-1627/process-safety-encoding-rca/repeat.sh
status: open
---

## Problem

The helper accepted ExecFileOptions encodings but always forced utf8. An actual
child writing binary80ff returned a string despite encoding buffer. This is
a declared contract mismatch; none of ten current call sites requests encoding.

## Diagnosis

The options signature allowed binary/null/non-UTF8. The implementation returns
text and all current callers parse text. The direct compiler accepts buffer
before and rejects it after. Actual binary-probe output and all source/callsite
hashes are in /var/tmp/deploy-1627/process-safety-encoding-rca/.
Related launcher-budget and old-Node preload cases concern interpreter ownership
and compatibility, not this type contract.

## Solution

Temporary candidate narrows only options encoding to utf8 or utf-8, retaining
all other Node options. Type-erased JavaScript is byte-identical. The existing
owning unit adds an in-memory compiler fixture rejecting buffer/null/ascii and
broad options variables while accepting UTF8 and string outputs. It fails on
original type with four unused-expect-error diagnostics and passes after.
Original four process tests pass both; five final repetitions pass all five.
Exact commands, before/fail logs, probe output and manifest are in report.md.
Patch SHA256fc777319981d4476da35df6a03e75922d6864b1759dbc86dacdf50a87ad46abd.

OPEN: source-owner application, independent review and full final gates remain.
No new binary feature, runtime rejection, source edit, provider/model call,
DB write, dependency or budget change. Untyped JavaScript may still bypass the
type boundary and gets existing UTF8 behavior. Golden prompt review does not
apply to an ordinary type/fixture correction.

## Human feedback

Parent requested a minimal type-only UTF8 contract if confirmed by callsites,
actual compiler before/after, and five unchanged owner repetitions. Existing
G3 checks remain running; only parent owns source/deploy. Preserve Freedom.

## Reusable lesson

A wrapper that fixes one output representation must not expose type options
promising other representations, and variable assignments need coverage too.
