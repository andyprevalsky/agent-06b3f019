---
id: 2026-09-11-recording-archive-serial-publication-outlived-worker-drain
date: 2026-09-11
title: Serial recording artifact publication kept drained workers alive after metrics stopped
surface: cross
component: recording-trace-archive-publication
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: recording._archive_recording_artifacts_sync sent each file through a separate synchronous HTTP request and finalized-manifest reconciliation inside an asyncio default-executor thread
symptoms:
  - "metrics returned no valid desired_machine_count for 6 consecutive polls"
  - "driver did not exit within the bounded terminal log catch-up window"
  - "Worker stopped logged minutes before worker subprocess exit"
  - "guest cleanup pending HTTP 202 after ordinary task outcomes"
tags:
  - recording
  - trace-archive
  - worker-shutdown
  - asyncio-executor
  - manifest-reconciliation
  - cloudbench
sources:
  - PR #1299
  - commit 9ef00e6686b9996e18e3e0aa7d016b525a6d0d92
  - fleet run 20260911-065448-5845
  - agent a4f42f19-5f79-4390-9815-a5e1f1030617
  - agent 80f839d6-7d4a-4af1-a71e-10e7d9356438
  - agent 3d3bf5a5-b6cd-43d0-a18e-a6649072c6d3
repro: agents/tests/blackbox/recording_archive.blackbox.py
status: open
---

## Problem

The twelfth ten-slice attempt failed its first slice. All ten tasks produced
ordinary terminal benchmark outcomes (two PASSED, eight FAILED), but three
guests stopped publishing metrics while their completed benchmark drivers were
still waiting for worker subprocesses. The local fleet children rejected their
unacknowledged cleanup, with exit 125. No slice is accepted from this attempt.

The exact run is
`.context/fleet/capability-stability-proof/capability-stability-20260911135448-5408/runs/20260911-065448-5845`,
owner `e5fdface1dbe4136ab88ba5fed048d36`. Parent-owned recovery independently
verified all ten VMs and eleven volumes terminal, nine browser sessions closed,
and the registry absent before source edits. Recovery and later evidence
publication do not turn the failed slice into a clean slice.

The durable roots are
[polar-bu-034](https://www.roselabs.ai/?agent-id=a4f42f19-5f79-4390-9815-a5e1f1030617),
[polar-odysseys-2dab64ba576a](https://www.roselabs.ai/?agent-id=80f839d6-7d4a-4af1-a71e-10e7d9356438),
and [polar-odysseys-591e86ed962f](https://www.roselabs.ai/?agent-id=3d3bf5a5-b6cd-43d0-a18e-a6649072c6d3).
The canonical publisher verified all ten retained roots during recovery.

## Diagnosis

All timestamps below are UTC on September 11. Primary workers returned metrics
HTTP 200 immediately before deliberate stack shutdown. Every retained worker
then logged its shutdown completion and final `Worker stopped` message within
approximately 0.1 seconds. The failure occurred after ordinary task termination;
these observations do not establish a loss of metrics during active execution.

| Task suffix  | Last primary metrics 200 | Worker shutdown began | Guest driver cleanup acknowledged |
| ------------ | ------------------------ | --------------------- | --------------------------------- |
| bu-034       | 14:09:25.637             | 14:09:26.688          | 14:17:19                          |
| 2dab64ba576a | 14:09:25.391             | 14:09:26.605          | 14:13:15                          |
| 591e86ed962f | 14:09:47.513             | 14:09:56.582          | 14:20:52                          |

The backend stopped approximately three seconds before each final acknowledgement.
Snapshots were collected after recovery began, so snapshot time alone cannot
establish the earlier lifecycle. The retained timestamped backend/driver logs
establish these completion times before that recovery.

After 14:10, the three backends accepted respectively 135, 65, and 199 individual
`POST /api/archive/artifact` requests. Every response was HTTP 200, every path
was unique even across the complete retained backend log, every request belonged
to its own root, and every path was under `media/browser/`. Their median request
durations were 3,120, 2,743, and 3,095 milliseconds. The corresponding backend logs
contained exactly 135, 65, and 199 late-artifact manifest reconciliations. The last
responses were 14:17:12.186, 14:13:04.706, and 14:20:43.419.

This is successful serial recording publication, not a failed outbox retry storm,
a repeated same-path upload, or adoption of another root's backlog. Each successful
late file triggered a full finalized-manifest reconciliation. The available spans
do not partition request cost into storage and reconciliation; no exact share of
latency is attributed to either suboperation.

The FE recording finalizer schedules archive work after its recording pointer is
durable. Both recorder implementations walk their files inside `asyncio.to_thread`.
Each calls `archive_bytes` without a running event loop in that thread, selecting
the synchronous HTTP path even when worker async archive writes are enabled.
Cancellation of the awaiting task does not stop the thread. After worker main
returns, `asyncio.run` joins its default executor, so all remaining successful
serial uploads continue before the worker subprocess can exit. The supervisor
correctly retains that process, and stack teardown correctly keeps the backend
alive. The local child has not yet returned, so the autoscaler continues polling
the intentionally stopped metrics service and eventually fails closed.

An ignored actual-recorder/actual-supervisor replay first characterized this
boundary with one versus six files and controlled loopback HTTP responses.
The permanent regression then used six files, real encryption, a real HTTP
listener, SIGTERM through the actual supervisor, and an explicit first-request
barrier. On unchanged production source it failed with
`worker began 5 serial artifact requests after main returned`. All six files
were successfully decrypted before that assertion; a missing-artifact shortcut
cannot make the test pass.

The unchanged permanent command is:

```bash
cd agents
venv/bin/python scripts/run_blackbox_tests.py recording-archive
```

The initial red run took 1.6 seconds; the first green run took 0.9 seconds.
Logs are `recording-archive-red.log` and `recording-archive-green.log` under
`.context/acceptance/proof12-slice1-forensics/`. The sanitized request analysis,
source hashes, and counts are in `archive-publication-timeline.json`. Raw guest
logs remain private and contain no material copied into this case.

Archive searches used `metrics returned no valid desired_machine_count` and
`worker shutdown recording archive executor`. The prior metrics-native-shutdown,
cloud-evidence-before-cleanup, and retired-root-outbox cases are relatives with
different first-bad boundaries. Their fixes retain lifecycle ownership; this
incident requires making the owned publication work efficient while preserving it.

## Solution

Recorders stream file encryption off the event loop into bounded batches for
`POST /api/archive/artifacts`. Each file keeps its original path, AES-GCM envelope,
content type, compression, metadata, and independent reader compatibility.
There is no new recording archive format.

Each request has exactly one canonical root, at most 256 unique canonical paths,
and at most 64 MiB of serialized JSON, below the existing 100 MiB server parser
limit. Metadata is bounded to 8 KiB per record. Native plaintext remains capped at
32 MiB, with 33 MiB ciphertext allowance for gzip and encryption overhead.
Python bounds file reads even if a source grows during reading. At most one next
file is read/encrypted while the bounded batch is assembled; sizing does not make
another base64-sized serialization copy. Existing four-recording admission and
backend four-upload concurrency bound in-flight work.

The backend validates every record before any mutation, waits for all started
storage calls on partial failure, and reconciles finalized manifests once after
a successful batch. It acknowledges only after publication completes. Python
persists the ordinary encrypted outbox pairs before sending and removes only
the exact acknowledged ciphertext generation. Partial failures, malformed
acknowledgements, and cancellation retain source files and retryable entries.
Successful recording cleanup now requires a positive archive result rather than
discarding the result or suppressing its error before deleting files.

Independent adversarial review reproduced a further ownership race in the first
batch implementation: a blocked six-file batch exposed its outbox pairs to an
ordinary same-root terminal flush. That flush sent six individual requests and
returned true while the batch was still active. Batch publication now holds a
shared root file lease; automatic recovery skips a leased root and terminal flush
waits for an exclusive lease within its existing deadline. These kernel file
locks coordinate every worker process sharing that outbox, permit concurrent
recording batches, and release automatically if an owner dies. Locally tracked
completion futures also keep terminal flush aware of admitted recording work.
The permanent separate-process regression failed before the lease repair and
passes afterward, including killing the blocked fixture owner and recovering
every original ciphertext through the ordinary outbox. The valid red is
`archive-batch-lease-red-final.log`; two earlier attempts failed fixture setup
because its standalone helper import lacked test environment defaults, and are
not causal evidence. The green is `archive-batch-lease-green.log`.

Review also demonstrated that a payload named after another artifact's metadata
sidecar could overwrite that sidecar while both uploads were acknowledged. This
underlying storage-name limitation predates the incident and is not its cause.
The new batch contract rejects metadata/transaction-reserved names before any
write. Its permanent test failed with `Missing expected rejection` and then
passed unchanged (`archive-batch-reserved-red.log` and
`archive-batch-reserved-green.log`). The existing single-artifact API remains
compatible.

Batching reduces round trips; it does not establish an arbitrary-directory
completion bound. An independent 257-file replay preserved all files in two
batches, with one starting after main returned. The actual recording size and
total post-task publication time still need the unchanged live outcome gate.

Permanent tests cover real worker exit ordering, every decrypted file/path,
failure and malformed-ack source retention, retry of identical encrypted pairs,
count/byte chunking, native artifact limits, whole-batch validation before storage,
four-upload concurrency, partial remote acceptance, and retry completion.
The backend archive blackbox also submits authenticated batches through the real
API after finalization, reads every individual artifact, and verifies both
encrypted and public manifests before acknowledging an idempotent replay.

No task prompt, evaluator, catalog, timeout, recording deadline, driver catch-up
bound, worker-drain behavior, or autoscaler acceptance rule is weakened.
Offline causal checks and final independent adversarial review pass. The reviewer
reran both Python domains (recording five of five) and the backend batch unit; a
same-process replay observed one pending completion, false terminal flush, zero
individual POSTs during the batch, and an unrelated root flushing successfully.
The exact unchanged local benchmark before/after outcome, complete deploy checks,
and a fresh ten-by-ten cloud campaign remain required. This case remains OPEN.

### Canonical local outcome attempts, 2026-09-11

The unchanged `scripts/run-bench --local polar-bu-034` task ran on original
`9ef00e668` and candidate `d6739b3b0`, with eight workers, R2 archival, the same
canonical seed fixture, and the temporary 300-second execution backstop. Both
complete task catalogs have identical SHA-256 values between these checkouts.
Both tasks paused at the backstop: 329.2 seconds including cleanup before, and
approximately 326 seconds after. These are ordinary failed task outcomes, not
business passes or local reproductions of the cloud infrastructure failure.

The original local run used native Kernel replay throughout. The candidate
rotated its browser session and successfully started another native replay.
Neither entered the screenshot-recorder publication path, and neither made
archive requests after its workers reported stopped. The failing cloud run
instead switched to screenshot recording after proxy rotation and a native
replay stop failure. Therefore the exact local outcome-reproduction gap remains
open; the permanent recorder/executor regression is the causal before/after
proof. The live cloud validation must still exercise the batch publication path.

Both local runs have independently verified terminal browser sessions, removed
isolated databases, and published terminal Hub bundles with actual last LLM dumps:

- Before: [agent f2e90489](https://www.roselabs.ai/?agent-id=f2e90489-9de8-468c-b846-71c9de934dc3),
  76 messages and 30 root LLM dumps.
- After: [agent 2b0a79b8](https://www.roselabs.ai/?agent-id=2b0a79b8-7d8e-4d7a-b757-49acfcc2ba0f),
  48 messages and 15 root LLM dumps.

Private receipts are under `.context/acceptance/recording-archive-local-before-6/`
and `.context/acceptance/recording-archive-local-after-1/`. Earlier local bootstrap
attempts created no agent tasks and are excluded from the causal evidence.

## Human feedback

The user requires ten sequential cloud slices of ten with zero infrastructure
issues, complete validation, and no repeated permission requests. Ordinary task
failures may be valid capability outcomes, but incomplete infrastructure cleanup
must invalidate the slice. Preserve all evidence and ownership through recovery.

## Reusable lesson

Amortize final publication across bounded groups of individually durable artifacts
to reduce repeated per-file reconciliation during executor joining, and verify
total publication time on the actual recording size.
