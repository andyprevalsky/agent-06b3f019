---
id: 2026-11-08-inspect-fixture-inherited-funded-key-cooldown
date: 2026-11-08
title: Code inspection fixture inherited another domain's shared funded-key cooldown
surface: back-end
component: code-session-inspect-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: inspection fixture resolved a shared Codex funded-key cooldown written by a concurrent usage-limit fixture
symptoms:
  - "C15"
  - "usage_limited"
  - "resets_at"
tags:
  - blackbox
  - cooldown
  - concurrency
sources:
  - PR #1831
  - commit 66adafe0bb9707fbc0568eb298773e1483402327
  - plan:.context/production-mixed-mode-evidence/inspect-isolation-native-pair.json
repro: back-end/src/tests/blackbox/code-session-inspect.blackbox.ts with an active local funded-key cooldown
status: fixed
---

## Problem

The native backend gate failed inspection C15: expected an answered Codex
inspection, received usage_limited from the fake Claude fallback. All seven
assertion bodies remain unchanged. No production credential was changed.

## Diagnosis

Gate: NOT_INTRODUCED against frozen main 2f5f1789cc3e233e991082347241c3926a94e9a9
for the complete inspect, credential, fake CLI and runner closure. The usage-limit
fixture marked Codex funded cooldown at 12:25:04.643 UTC; inspection read it at
12:25:04.657 on the same native database shard. Existing before/after cleanup
only isolated the Anthropic row. Database restoration cannot prevent concurrent
read contamination or erase an in-memory cached cooldown.

Two archive searches and the November4 paused-code and October27 funded fallback
cases were read; neither isolates this fixture lifetime. Fresh local inspection
passed, while the same native command with a localhost-only seeded Codex cooldown
failed the identical C15. A concurrent two-domain trial passed and is not claimed
as a reproduction. The controlled seeded trial is the causal reproduction.

## Solution

Expose the existing in-process private funded-key map as a begin/finish lifetime
and use it for this fixture's complete before/after scope. Existing wrapper
callers keep the same behavior. Finish resets caches and restores Prisma methods
even when reset fails. No provider selection, cooldown semantics, assertion,
timeout or runner concurrency changed. This is constant work and a private map,
with no cross-process locks or production database writes.

An ordinary isolated clone ran the exact unchanged seven-case native suite and
local cooldown prelude before (exit1, same C15) and after (exit0, seven passes).
The prelude restored prior local state; the fixed fixture did not delete the
shared mark. Final formatted bytes and unchanged assertion-body hashes are in
the private receipt. The fix was prepared by the deployment owner, not delegated.
Golden reference: not applicable; test setup only.

## Human feedback

The user requires permanent regression and independent completion of this
assigned deployment; no production payment rerun or mint of the three known
allocations is authorized.

## Reusable lesson

Isolate shared funded-key state for an entire in-process fixture lifetime before asserting provider selection.

## 2026-11-10 recurrence: subscription availability remained shared

The earlier funded-key cooldown isolation did not isolate subscription
availability. On source `5690b07270b16e82c1cf024207a915be9c2925cc`, the native
`backend-coverage-blackbox` gate failed C15 at line 585: `the exhausted Claude
key is backed off`, expected `true`, actual `false`. Seven other cases passed.
This was a scripted-CLI fixture failure, not an external-provider outage.

The complete original domain log shows the failed session
`3a0dcd7f-442e-4f47-b166-1d267435e70b` making four Integration `findMany`
queries, then starting only Codex at 05:29:46.549 UTC and answering at
05:29:46.607. There was no Claude attempt or cooldown mark for that session.
The unchanged C15 child control ran Claude, marked its cooldown and answered
on Codex one second later. Subscription-first ordering explains this boundary:
the fixture's new user has no own subscription, but pooled Codex availability
can precede its preferred Claude funded key. The pool's availability is inferred
from the executed order and exact selection code; the raw row and concurrent
writer were not logged or queried.

Gate: NOT_INTRODUCED against `8046dcbc3a67e7d4241d8eb6171b5c1652b85f71`.
The ten relevant inspection, credential, cooldown and fixture bodies are
byte-identical. A provider-free replay using the actual selection, inspection
loop and cooldown functions fails the same assertion on both revisions when a
private pooled Codex row is visible. The candidate's actual Kernel custody
preload is installed in that replay; no fetch is called. Applying the exact
fixture isolation helper restores Claude then Codex and the same assertion
passes. Checkpoint, CLI outcome and integration adapters are modeled; this is
causal boundary proof, not an unchanged native-suite pass.

The reviewed TEST-only repair hides `claude_code` and `gpt_code` subscription
enumeration for this funded-key fixture, delegates unrelated queries to the
bound original and restores the exact original delegate in teardown. All eight
original test bodies are byte-for-byte unchanged. One added permanent case
checks both subscription names, unrelated delegation and restoration. The
candidate helper passes that provider-free control and strict installed Prisma
type checking. Production ordering, credentials, assertions, timeouts and
Kernel custody remain unchanged; no shared credential or cooldown is mutated.

The deployment coordinator applied the reviewed candidate after the active
runs ended. Native C15/domain acceptance and normal release gates remain
pending; this appendix records no waiver or completed repair. Evidence is in
`.context/code-inspect-5690-rca/report.json` and its `candidate/` receipts.
The complete original log is 29,806 bytes with SHA256
`2781141e0c621eb809c7f87e75ea08e834adf34e601b031ffa303e5ab21e8e3c`.
