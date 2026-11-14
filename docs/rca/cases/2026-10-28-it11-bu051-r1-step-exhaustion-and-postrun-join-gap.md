---
id: 2026-10-28-it11-bu051-r1-step-exhaustion-and-postrun-join-gap
date: 2026-10-28
title: It11 BU051 r1 exhausts 100 steps before a separately delayed host join
surface: cross
component: browser-agent-and-cloudbench-terminal-collection
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: original browser reaches step 100 without completion; later host driver-exit/catch-up delay lacks per-read and sealed-exit timing
symptoms:
  - "Max iterations reached: 100"
  - "Native browser task did not complete successfully"
  - "driver did not exit within the bounded terminal log catch-up window"
tags:
  - polar
  - it11
  - r29
  - terminal-collection
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent 423aacc2-4dd7-44af-bf7c-6fdc1fe0fa7e
  - plan: normal archive d98b4956f0c1e0fd1c6e316732241a971c18a3529408674d3ed39a26d8249d1c
  - plan: normal manifest 13f2f312449c35cad58984f60db9aea6cdf0bb8aedeffa7b7b07497a2711faff
repro: "OPEN: original offline custody verified; no causal mutation or unchanged benchmark replay authorized/performed"
status: open
---

## Problem

BU051 r1 is an original FAILED result, infra_failure=false. It requests exactly
one photo/diagram tutorial per twelve zodiac animals, each at most30 numbered
steps; the original catalog independently specifies100 browser steps. No task,
criterion, timeout, source or grade was changed. The late host job join must not
be attributed to the browser's50-minute activity deadline: this browser returned
normally with a failed result before that deadline.

The normal archive is53532490 bytes. All seven members were checked against the
manifest. run.json SHA256 is
bb60c6606dde2a8bf88e67bcf87501fdf44010c5c7e7f3dccf93b123dadda3df;
worker.log is17ba106de6295840a76ba26496b80c8526aa724f8ec9d0727a51ecb9e8e3f9ce.
Supplemental driver/lifecycle/provenance were checked separately, not represented
as normal-manifest members. Driver SHA256 is
ebcf5342e866ab2712ee05269c9e6fce66f177700466a8003ceb7c6c94eae5af
(66894143 bytes). The existing host packet supplied15 independently hash-checked
files; host fleet-child.log SHA256 is
6d8b2361901296e3c273f1cc523bd5c96d28efc4dae676da68ed7b1d0d1477f3.

## Diagnosis

This is preliminary original evidence, not a completed causal RCA:

| Original boundary (UTC) | Evidence and meaning |
| --- | --- |
|20:22:29.980 | Browser activity starts; task9041ec12-a07c-5782-8f25-a4dd37457d90. |
|21:04–21:06 | Late CDP observation timeouts are present; later evaluate actions still start. Neither provider cause nor effect on final completion is isolated. |
|21:06:46.596 | Original browser_use_step_100 request starts. There are132 recorded browser-use request starts across95 distinct step labels; repeated labels are not132 independent iterations. |
|21:06:55.727 | Explicit Max iterations reached:100. No early consecutive-model-failure label. |
|21:07:03.756–21:07:22.814 | Final salvage verifier runs; check_progress duration19916ms. Raw preconversion context has56 messages and bounded tool evidence160000 chars,25 truncated entries; exact encoded request parity is not established. |
|21:07:39.400 | Task Incomplete - Max Steps Reached persisted. |
|21:07:45.878–21:07:55.155 | Recording/cleanup work; upload receipt50412481 bytes. Browser session cleanup also records failed pause acknowledgement. |
|21:07:55.382 | browser_activity_wait ends status=ok after2725299ms; returned task result remains unsuccessful. |
|21:08:07.159 | Root statusFAILED. |
|21:10:00.288 | Captured worker-log observation; provider cleanup receiptHTTP200 and archive warningTimeoutError are retained. |
|21:10:23 | Guest driver explicitly logs benchmark finished rc=1 after result save and root cleanup stateclean. This is before its EXIT cleanup, not proof the driver process exited then. |
|21:41:44 | Host guest-shutdown-requested recordHTTP204 and acknowledgement epoch1793223704. |
|21:42:31.952 | Original campaign job finished. |

The final returned structured response contains twelve candidate tutorials,
while success=false and status remains the max-iterations failure. Source
handler.py12824–13010 deliberately performs final structured-data salvage without
promoting a budget-exhausted run. It is not proof that the candidates satisfy all
criteria, nor permission to mark PASS. No original three-rubric judge result was
established for this FAILED-root path. The actor was still checking image format
and model choices in its final reasoning; no exact replay isolates a general
repair. No Root CDP client required literal occurs in this original worker log,
so R28's repeated assertion is not established here.

The post-run delay is distinct: shutdown request is31m21s after the guest's
benchmark-finished line, job join is32m08.952s after it. Host fleet-child.log records
token-bound RESULT-END/DONE followed by driver did not exit within the bounded
terminal log catch-up window. It contains no per-request latency/offset journal
or timestamp for that message. Original file mtimes are retained as metadata,
not asserted as stage boundaries.

At executed source, run-bench-cloud6496–6709 reads authenticated append-only
256KiB chunks with generation/anchor/range checks. Its backlog loop6853–6884
already drains known backlog without the normal15–20s poll sleep. Therefore
multiplying64MiB by the ordinary polling interval is not causal proof of this
incident. The source's30s terminal wait begins after DONE is consumed, not after
the guest first wrote it. Lines7006–7050 require a410 sealed-driver-exit response
and EOF catch-up; the observed host failure belongs to that boundary.

cloudbench-run.sh294–326 executes EXIT cleanup after finish() emits DONE, joins
owned diagnostics/stack and credential retirement, then publishes cleanup ACK.
cloudbench-boot.sh232–250 waits for the actual driver, appends final log records,
and only then seals state=exited. cloudbench-status-server.py515–538 maps that seal
to410; a missing process without the seal is503. Available records do not time
these transitions, the individual HTTP reads, or local parsing/console writes.
We cannot choose slow catch-up, process teardown, status transport, or host
processing as the32-minute cause from this packet. Removing these checks,
accepting DONE alone or widening deadlines would discard required evidence.

Archive searches: `Max iterations reached 100` and `runtime evidence export
cleanup delay`. Personally read Solution/Human feedback for the Oct25
model-abort/mislabeling case and Oct19 live-writer export case. They are relatives,
not demonstrated recurrences: this run reaches step100, and no captured live
writer/export-drain observation identifies the later delay.

## Solution

No runtime change or speculative test. Preserve the original taskFAIL and
infraFALSE, source66eb, original clocks and verified fleet lifecycle. Fast causal
next proof is an existing per-read offset/latency record and exact driver
state/seal or EXIT-stage timing spanning21:10:23–21:41:44. Owner reports no
per-read journal located. The full retained logs were inspected; no new provider,
controller, browser, model or DB calls were made. A local controlled reproduction
must target the identified stage before any performance repair; no saved result,
cleanup evidence or release gate may be bypassed. No benchmark outcome credit.

## Human feedback

Parent requested hurry with actual stage durations, prohibited vague mtime
inference and deadline/cap/release/evidence bypasses, and kept R28 separate until
identical original first-bad evidence exists. The initial generic50-minute lead
was corrected from the original normal-return and max-step evidence.

## Reusable lesson

Separate browser failure time, guest benchmark completion, sealed driver exit,
log collection and host join before attributing a long post-run delay.
