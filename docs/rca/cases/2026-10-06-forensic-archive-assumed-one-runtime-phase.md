---
id: 2026-10-06-forensic-archive-assumed-one-runtime-phase
date: 2026-10-06
title: Generic failed-owner archive required every allocation to have one runtime shape
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generic verify counted every historical allocated Machine as a primary or legacy worker and required service files for every task
symptoms:
  - AssertionError at len(by_machine) == len(rows) + len(unstarted_workers) + len(started_workers)
  - complete original pre-service capture lacks mandatory service files
  - original backend log grew after the exact stopped-provider cleanup receipt
tags:
  - cloudbench
  - exact-owner-recovery
  - forensic-archive
sources:
  - PR #1299 follow-up
  - fleet run 20261007-001156-61479
  - commit 61148634e2dcad07bc951227e91ecf9e69eb47ce
repro: scripts/tests/cloudbench-forensic-quiesced.test.py
status: mitigated
---

## Problem

The failed DAILY50 owner retained 50 task primaries, six verified unallocated
attempts and three normally retired worker attempts. Its complete original
capture contained 48 sealed guests, one guest that stopped before service
startup, and one failed-service guest with native stopped/provider cleanup
proof. The generic verifier required all allocated IDs to appear as primary
or legacy worker rows and required five service files from every task. Neither
condition described the preserved execution phases. This recovery carries zero
benchmark credit, and native release remains a separate obligation.

## Diagnosis

Archive searches used `forensic service stopped mandatory manifest` and
`failed owner pre-service allocation destroyed provider retained`. The source
recipe and forensic ordering cases are relatives: they protect different
boundaries and do not establish this mixed allocation/runtime contract.

The unchanged compact owning assertions on 93dea65 failed at the generic
allocated-Machine count and stopped-provider backend hash equality. Read-only
replay of the complete original archive, owner and all 59 audit records failed
at the same count. Only canonical evidence-file reads were
redirected to private staging; the original registry and run were untouched.

The failed-service guest's later backend capture is an exact extension of the
previous cleanup log. Existing parsers identify the same root, provider session
set and allocation/mutation counters; the suffix has zero root creation, browser
allocation/mutation and payment mutation. The original stopped proof and provider
receipt independently validate against their unchanged original log. Exact hash
equality incorrectly rejected this complete later evidence. Original failed
cleanup states remain preserved; no intermediate cleanup reason is inferred.

## Solution

Generic archive verification reuses normal worker capture verification for the
fresh child subset, retaining honest exit status and startup state. Worker rows
must archive every file required by the unchanged normal capture manifest, and
retired dispositions still require native absence. All allocated IDs remain in
the existing final native absence checks.

Pre-service rows carry the original ACK, exited driver, explicit service/run/log
absence and unchanged original-volume/config/capture bytes. Native executable
and provenance binding reuse the existing source validator and reviewed
before-stack-launch source policy. Native recipe verification is shared with
bootstrap verification; captured checkout verification remains mandatory for
bootstrap callers. No checkout evidence is synthesized.

Failed-service rows reuse exact stopped/provider receipt verification. A later
backend log can reuse the earlier receipt only through exact prefix identity,
unchanged parsed ownership and a suffix containing no new allocation or payment
mutation. Archive readiness continues to report `native_release_verified=false`
and zero credit. Default final absence checks and ordinary native reaping remain
unchanged.

The same full original archive passed with 50 rows, three normal
worker captures, six unallocated attempts and 628 preserved members. Thirteen
compact owning controls, 25 original bootstrap controls and 26 existing generic
forensic controls pass. The owning script is already registered in `scripts/test.sh`,
`run-deploy-structural-gates.py` and the ordinary deploy command. This is bounded
work over one failed owner's archive, outside the agent execution hot path;
10,000 live agents introduce no shared per-agent lock or polling channel.

Independent review cleared the frozen runtime/test candidate at
`61148634e2dcad07bc951227e91ecf9e69eb47ce`, independently passing all nine new
owning controls and replaying the unchanged original archive RED/GREEN. The
candidate's default final verification still rejected the original active
native inventory. Exact native recovery and deployment qualification remain
required before claiming the original resources released or deployed. Status
remains mitigated while that native obligation is outstanding; no new benchmark
execution was performed.

## Human feedback

Preserve meaningful lifecycle stage endpoints, avoid aggressive inner criteria
or timers, permit genuine task FAILURE, preserve complete truthful originals,
and require exact terminal resource release. Do not fabricate receipts or grant
acceptance credit to recovered or interrupted executions.

## Reusable lesson

Validate each allocation and runtime phase through its existing terminal owner contract while preserving every original byte and the independent final native release audit.


## November 11, 2026: original-volume capture rejected verified append history

This is a recurrence of the immutable-log assumption at an earlier admission
boundary, `cloudbench-original-volume-capture.py::cross_check_receipts`. The
October archive verifier's prefix rule did not cover this separate capture
reader. Archive searches were `capture contradicts the recovery observation
backend.log` and `stopped capture append-only log grew after live stat recovery
manifest prefix`. The forensic phase case is related evidence, not a substitute
for replaying this incident. The repair is integrated into the existing owning capture reader.

The supported original-volume capture for Machine `812446f9e74318`, volume
`vol_vwn5j8g236m7dx8v`, owner `6907dca0cb904bb1b60dec05fdec9bec` actually failed
with `capture contradicts the recovery observation of
repo/.context/cloudbench/logs/backend.log`. Its preserved failure and journal
report restoration and stop; this worker did not query or mutate the provider.
The task's original verdict and cleanup obligations remain independent.

The old state observed 2,749,109 backend bytes. The earlier regular copied log
contains 2,750,324 bytes and SHA256
`8a7c298590f28d0e07db98e2a5fc6cabb35b717c94c86e58969465e86a875252`, exactly
matching the original provider manifest. The retained stopped capture contains
2,761,838 backend bytes and SHA256
`30101fbd09e24be9c4508bd1f634626ae7bf8b2bcce88a981703e67d30deaca0`.
Its first 2,750,324 bytes equal the entire earlier hash-bound copy. The size
inequality is therefore not a contradiction: the observation, copy and final
capture represent three different collection instants. Equality at both old
checks made this authentic history impossible to admit.

The isolated candidate changes only receipt-integrity classification. A backend
size mismatch is accepted only when both receipts match the exact Machine and
run token, the old observation explicitly reports a regular nonlinked log
within its limit, its size is a nonnegative integer, a safely read complete
nonempty earlier regular copy matches the native manifest SHA256, and
`stat_size <= copied_size <= captured_size` with genuine growth beyond the
stat and exact complete-prefix identity. The earlier copy's verified digest is
included in `receipt_cross_checks`. Foreign receipts refuse explicitly. The
original capture inventory/member checks, unsafe-path checks, existing JSON
presence/size and recorded hash comparisons, native stop/config/volume proof, zero credit and release
checks remain independent. The file reader checks regularity before `fdopen`,
so a directory refusal also closes the descriptor; no size limit is increased.
No receipt or original byte is rewritten.

The exact real `cross_check_receipts` call against the retained original tar,
state, manifest and copied log exits 1 with the recorded error before the fix
and exits 0 with the isolated candidate. The same eleven new owning test methods
in the existing registered `scripts/tests/cloudbench-bootstrap-recovery.test.py`
run through its native unittest/sharding entrypoint: unchanged code has three
append-case errors and eight passes; the candidate passes all eleven. Adversarial
controls preserve refusal of changed prefixes, truncation, inconsistent sizes,
foreign Machine/token receipts, missing or wrong native hashes, absent receipts
or copied evidence, unsafe/nonregular copies and JSON presence/size contradictions or changed recorded run-JSON hashes. An exact
unchanged log still uses the original exact-match path without needing a prior
copy. Native-sized evidence exercises the existing 512 MiB cap rather than the
1 MiB JSON default.

Independent review approved the narrow delta and the integrated registered tests passed 11/11. A fresh supported inert capture then completed with the exact original configuration restored and the Machine stopped. The verified archive SHA256 is `033c2ea63a996c1d2c8ba73896f9bef5c61f65717a14b66193d6ff7cbeb13224`. The normal interrupted archive builder and exact-owner recovery subsequently completed; the native audit records provider teardown verified. The original failed capture, incomplete benchmark receipt and missing original run JSON remain preserved. Capture and archive evidence grant zero benchmark, financial or provider-session cleanup credit; physical retirement is a separate native receipt.

The generalizable problem is a logical inconsistency between mutable collection
observations and immutable receipt verification. Deleting size/hash validation
would lose evidence; this candidate unifies acceptance of the one mutable
backend-log history around the existing native hash and entire earlier bytes.
It does not generalize append acceptance to JSON, other files or other owners.
Work is bounded to one owner and existing capture size cap, outside the live
agent hot path; it adds no per-agent channel, polling loop or shared lock at
10,000 agents. Golden reference: not applicable (no approval-gated hunk).

Human instruction for this recurrence: do not assume resizing is safe; preserve
all permissions and guards; accept only cryptographically verified complete
append history; keep foreign/missing-hash/truncated/changed-prefix/JSON evidence
fail closed. The coordinator owns integration and actual capture/cleanup.

Precision limit: services.json has only presence/size in these historical
receipts, with no prior content hash. A same-length services.json mutation is
therefore not observable by this preexisting guard and remains accepted on both
sides; this patch does not newly permit it, and claims no arbitrary JSON
immutability. A recorded run_json_sha256 still rejects same-length run JSON
changes. No prior JSON receipt hash or original bytes are invented to fill this
historical evidence gap.
