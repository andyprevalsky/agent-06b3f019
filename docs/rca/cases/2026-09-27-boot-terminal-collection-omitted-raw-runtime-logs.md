---
id: 2026-09-27-boot-terminal-collection-omitted-raw-runtime-logs
date: 2026-09-27
title: Boot terminal collection omitted complete raw runtime logs
surface: infra
component: cloudbench-artifact-collection
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run-bench-cloud skipped service-log collection in boot mode and retained capped run JSON instead of complete backend and worker files before guest destruction
symptoms:
  - "remote-logs contains cloudbench-driver.log but no raw backend or worker files"
  - "boot collector omitted complete runtime evidence"
  - "incomplete runtime evidence was accepted"
tags:
  - cloudbench
  - evidence
  - logs
  - ownership
sources:
  - PR #1299
  - commit 6bd85cc909c8491c37a273ce3f3800b46f4cbfff
  - fleet run 20260913-125235-55066
  - fleet run 20260913-132708-74336
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_terminal_runtime_evidence_collects_complete_logs
status: open
---

## Problem

Independent preparation for the infrastructure-only fleet proof found that all
20 task folders from the first two proof19 slices lacked complete raw backend
and worker logs. Their `remote-logs` directories contained the driver transcript
and sometimes a log-read diagnostic. The collected run JSON contained capped,
agent-filtered worker rows and a backend placeholder. A terminal task verdict
and several successful LLM queries therefore could not establish the absence
of infrastructure failures throughout execution and evaluation.

The read-only inventory is preserved at
`.context/acceptance/boot-runtime-evidence-rca/historical-capture-inventory.json`.
Historical proof receipts remain unchanged. The 25-member failed-slice recovery
archive was produced by a separate manual forensic collector after failure;
it was not evidence that normal successful collection retained those files.

## Diagnosis

The owning path is guest services → stopped stack → driver cleanup ACK → boot
supervisor exited seal → `run-bench-cloud` collection → fleet destruction.
Boot collection deliberately avoided post-DONE Machines-API SSH, but had no
replacement raw-log transfer. Hub publication uploads the same collected run
record and does not restore omitted raw files. Transcript tree rows and
filtered diagnostics are useful evidence but do not prove complete capture.

Archive searches used `boot launch raw worker logs evidence skipped` and
`terminal artifact collection complete log snapshot bounded data plane`.
The July 16 launch-SSH saturation and September 12 autoscaler/collector
lifecycle cases are relatives: they explain why transport must use the data
plane and why runtime exit differs from collector completion. Neither fixed
the missing complete raw-log obligation.

The permanent reproduction executes the actual collection block and status
server against owned loopback fixtures. Baseline code omitted complete files;
the unchanged collector controls now require every byte and reject identity,
inventory, mutation, short-read, authentication and canonical-result mismatch.
Independent review also reproduced standalone boot identity/token mistakes and
missing directory durability before publication. Final counts, native exits and
paired source hashes are preserved under
`.context/acceptance/boot-runtime-evidence-rca/`.

Independent review identified two required sibling obligations. Autoscaled
worker VMs have separate logs and can be destroyed on scale-down before primary
capture. Also, truthful guest cleanup acknowledgement must not allow deletion
of the original volume after capture fails. These are evidence-ownership
requirements, not reasons to fabricate a cleanup failure or change task verdicts.

## Solution

The primary status server now serves an authenticated exact-run, exact-machine
manifest and bounded raw files after driver exit, cleanup ACK, stopped services,
and the matching clean stack receipt. Quiescence is established by the existing
producer order: `run.sh` drains workers and backend, waits its descendants and
publishes clean; the driver waits it before ACK; the boot supervisor waits the
driver before publishing exited. Subsequent status HTTP reads do not append to
the stopped backend's log.

The controller verifies every declared byte count and SHA256, the complete
local worker inventory, an unchanged second manifest, and the matching canonical
run JSON. It publishes the capture directory only after verification. The
existing 512 MiB recovery-file ceiling also bounds the aggregate capture; the
existing child-termination duration bounds the transfer. No SSH fallback or
extra automatic retry is added. Files exceeding the bound fail explicitly and
are never presented as complete or silently truncated.

Private, fsynced immutable `runtime-evidence.owner.json` and pending records
are created before boot configuration/start. The owner remains; pending is
removed only after verified collection and canonical result identity binding. Failures keep
the marker, complete driver transcript and any partial local files. An existing
marker or symlink prevents a new guest launch from overwriting ownership.
Intentional held infra-probe and demo modes retain their existing exemption;
normal proof tasks have no exemption. Ordinary task `FAILED` remains valid.

Autoscaled workers now enter an exact-run supervisor before bootstrap. A
run-bound stop request sends one TERM through a retained child handle; Linux
subreaping waits for detached descendants and closed log streams. Capture
preserves the full wrapper log and every configured worker log with byte counts,
hashes and quiescence receipts. The 270-second capture ceiling does not change
the existing worker shutdown grace; an unfinished drain retains its source.
Archive and extracted file/directory fsync must complete before deletion.

The fleet writes worker admission ownership before launch and captures before
scale-down. Terminal collection includes retired workers and checks the fresh
allocation audit, rather than only the current live-worker list. Primary copies
must match the assigned machine and exact slice token. An independent durable
runtime-evidence latch starts at fleet admission; ordinary, stale and forced
reapers retain resources until complete copies are verified. Guest cleanup ACK
remains a separate truthful fact. Exact dead-owner recovery consumes the same
verified copies, canonical result/provenance binding and complete worker
inventory before releasing that latch; omitted task lists cannot authorize it.

The original five retirement controls reproduced deletion without capture and
ignored retention in all three reaper modes, then passed unchanged. Additional
controls cover mismatched assigned identity, omitted workers, altered copies,
recovery inventory and canonical result rejection. Evidence is under
`.context/acceptance/proof21-runtime-retention-*` and the independent review
receipts. Native worker proof is under
`.context/acceptance/worker-runtime-evidence-rca/`; superseded receipts are
retained and explicitly corrected, never relabeled.

Primary capture uses the existing authenticated data plane. Worker capture uses
the worker's existing SSH/SFTP control transport, with at most four concurrent
terminal transfers per controller; historical captures are reverified locally.
At 10,000 agents this adds no per-agent hot-path work or shared log fan-in:
collection is bounded per retired worker and streamed under the existing
512 MiB aggregate ceiling. No workload, concurrency, task, prompt, model,
evaluator, pass threshold or normal execution backstop was changed.

The existing canonical benchmark-blackbox callable passed all 95 owning
checks in 5.76 seconds with native exit zero: 31 primary, 37 worker and 27
fleet retention/recovery checks. Worker lifecycle tests also passed natively
on Linux; the final corrected receipt is `implementation-final37v2.json`.
Independent source-bound reviews for the primary, worker, retirement and
external auditor report no unresolved findings. These are owning-boundary
proofs; the larger controller/integration gates and live acceptance remain
separate obligations.

Causal tests do not establish the requested live acceptance. This case stays
open until the combined implementation and actual complete fleet capture are
verified. Proof19 remains failed; proof20 allocated no fleet and failed its
private wrapper Node guard. Proof21 starts with zero accepted slices and must
independently audit complete evidence before every advance.

## Human feedback

The user requires infrastructure-only changes and no infrastructure failures
throughout startup, execution, evaluation, evidence and teardown. Task failures
may remain task failures; prompts, models, evaluators, proof thresholds and
benchmark behavior must not be changed to manufacture success.

## Reusable lesson

Preserve complete owner-bound runtime evidence before deleting each source, and keep evidence retention independent from truthful workload cleanup acknowledgement.
