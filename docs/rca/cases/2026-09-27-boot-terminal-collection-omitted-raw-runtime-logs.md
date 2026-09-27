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

## Controller fixture recurrence after complete capture became mandatory

The first full Linux controller gate on `14f0f30` failed scenario 2 of
`scripts/tests/cloudbench-multi-workstream.test.sh`: the two fake-provider runs
had no `remote-logs/runtime-evidence`. This was a fixture protocol omission.
The fake proxy implemented metrics, incremental logs and cleanup health but
returned 404 for the real collector's new `/runtime-evidence` endpoint. Its
fake driver also omitted stopped services, raw worker/backend files and the
clean stack receipt. The controller correctly retained the original volumes.
The failed native gate receipt remains unchanged; its original temporary
folder was already absent. A focused unchanged replay used the existing
keep-on-failure option and retained the inner logs and exact owner record.

The test-only adapter now delegates the runtime endpoint to the production
status-server handler, supplies the fake guest's stopped-stack files, and lets
the unchanged collector and fleet validators consume them. Concurrent-run
assertions verify distinct machine/token ownership, complete two-worker and
backend inventory, every byte count and hash, canonical run equality, and
removal of the pending marker only after binding.

The full fixture exposed an older cancellation expectation: it killed the
controller before collection, then demanded provider deletion solely on guest
cleanup acknowledgement. That exact early-KILL trigger is preserved. The
fixture now requires the original machine, volume and registry to remain,
checks that no destroy was issued and that the neighboring owner is untouched,
then explicitly resets only validated fake records for later test cases. The
same distinction applies to pre-supervisor SSH launch failures. Captured
post-supervisor failures remain a separate cleanup-positive case. These are
updates to controller fixture contracts, with no benchmark, evaluator, model,
production timeout or acceptance threshold changes.

A subsequent full fixture run exposed a second adapter error in the added
post-supervisor control: it returned the real child's later exit code as the
SSH result, although the production command backgrounds the supervisor with
`setsid ... &`. That fabricated a transport failure and extra staging retry;
the fake primary's existing wait expired before worker capture and destruction.
The adapter now reports successful detached admission while preserving the real
terminal exit code 1, complete logs and absent readiness. The original failure
before supervisor admission still returns a transport error. No timeout is
extended. Capture assertions bind to the current controller's exact provenance
path, so the paired earlier run cannot supply evidence.

Private causal logs, full-run outcomes, exact candidate hashes and independent
review are recorded in `.context/acceptance/proof21-controller-fixture-rca/`.
The unchanged focused primary collection failed with native/durable exit 1
(`exec-91cce35c...`) and passed after the adapter repair (`exec-8aaf570d...`,
exit 0). The exact early-KILL retention check passed (`exec-2733c97c...`). An
independent deletion counterexample for the test reset initially passed despite
losing a worker; binding the full allocation set made the unchanged two controls
pass. The first full candidate was interrupted by host ENOSPC/Engine loss
(`exec-82f18292...`): no durable exit exists, so it earns no completion credit.
Its recovered log and exact same-container recovery receipt remain preserved.

The unchanged rerun (`exec-e8abfe30...`) exited 1 at the detached-launch adapter
mismatch. A focused paired replay retained both failure boundaries and reproduced
that exact failure (`exec-6fc09318...`, exit 1), then passed with identical
assertions after the transport correction (`exec-20c1a9aa...`, exit 0). The
prior five adapter controls used a bare command without backgrounding and did
not establish that wire contract; their actual execution receipts are retained
without upgrading that claim. One extracted focused script initially omitted
a closing `fi`; its exit 2 is preserved as test setup failure, not causal proof.
Five corrected adapter controls using the exact production background command
also passed on Linux (`exec-0f1b2f7f...`, native/durable exit 0), including
successful SSH admission with real terminal exit 1, no fabricated readiness and
immutable retry evidence. Independent source and narrative review found no
remaining defect. The complete final controller gate remains pending on the
committed corrected fixture. Existing 27 owning retention/recovery controls separately prove
deletion after complete forensic copies; cancellation retention does not provide
benchmark acceptance credit.

The complete fake-provider fixture now runs on Linux because it exercises the
actual Linux guest supervisor, native process identities and descendant reaping.
The canonical controller lane uses the owned Linux runtime. No worker cases are
silently skipped or replaced on macOS; separate native Mac environment and
GitHub transport checks remain separate evidence. Direct macOS execution of the
whole guest fixture is not claimed to pass.

## Human feedback

The user requires infrastructure-only changes and no infrastructure failures
throughout startup, execution, evaluation, evidence and teardown. Task failures
may remain task failures; prompts, models, evaluators, proof thresholds and
benchmark behavior must not be changed to manufacture success.

## Reusable lesson

Preserve complete owner-bound runtime evidence before deleting each source, and keep evidence retention independent from truthful workload cleanup acknowledgement.
