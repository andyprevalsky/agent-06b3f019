---
id: 2026-09-29-capacity-rejected-guest-missing-recovery-mapping
date: 2026-09-29
title: A capacity-rejected pool guest had no status proxy mapping for exact recovery
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet fleet_registry_build_guest_recovery_plan required status-proxy.port after a provider-rejected post-config start
symptoms:
  - "could not start machine due to lack of capacity"
  - "boot-launch: provider did not accept the required post-config start"
  - "ValueError: missing stale-owner status proxy mapping"
  - "exact stale-owner guest recovery mapping is unsafe"
tags:
  - cloudbench
  - fleet
  - capacity
  - recovery
  - ownership
sources:
  - PR #1299
  - fleet run 20260929-191143-20488
  - PR #1918
  - fleet run 20261111-001957-3813409
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

A ten-benchmark smoke-inclusive cloud slice allocated all ten pool Machines, but
Fly rejected the post-config start of `agent-payment-abandonment` with host
capacity errors on all four bounded attempts. The requested 8 GB/shared-CPU-4x
shape was unchanged. The other nine Machines started; the failed Machine stayed
stopped, never published a status proxy, and produced no benchmark run record.
This is INFRA and the slice has zero acceptance credit. The proof cancellation
then reached `--recover-stale-owner`, whose mapping rejected the missing proxy
before it could recover any of the nine started guests.

## Diagnosis

The path was capacity admission → pool claim → boot-config update → Fly start
rejection → no status-proxy publication → exact-owner recovery plan. App-wide
CPU and Machine-count admission succeeded, but the attached volume's host could
not reserve the requested 8 GB Machine. Fly still rejected that Machine after
the other nine were stopped, while a 4 GB recovery boot succeeded. Host-local
capacity is an external placement constraint, not a benchmark or evaluator
failure. The owned bug was at the recovery-plan boundary: it assumed that an
allocated primary always had `status-proxy.port`, although the child publishes
that file only after a successful start. The same omission would strand any
provider-rejected boot before proxy attach.

The archive searches were `could not start machine due to lack of capacity
post-config start status proxy` and `stopped pooled guest never published proxy
recovery exact provider cleanup`. The September 9 capacity-reservation case is
a relative, but its app-wide reservation arithmetic was correct here; this
failure occurred at a volume host. The September 11 failed-proof ownership
case is also a relative: its supervisor preserved this exact owner, while the
guest mapping rejected a valid failed-start state.

The unchanged local owning-boundary test
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_capacity_rejected_guest_without_proxy_remains_mapped_for_exact_recovery`
failed against the prior fleet script with
`ValueError: missing stale-owner status proxy mapping` (one failed, three
negative controls passed). It passes on the fix (four passed). The test also
rejects a claimed accepted start, a worker clone, and an unrelated boot error.

## Solution

The recovery planner admits a zero preferred local port only for a bounded,
regular failed-start log with no accepted-start marker, run record,
guest ACK, worker runtime evidence, or worker clone. This only preserves the
Machine/output mapping; it does not publish a guest cleanup receipt or release
any ownership latch. Port allocation prefers the other guests' real published
ports. Live recovery then authenticated all nine started guests. The rejected
Machine was booted solely for recovery at 4 GB after the others stopped,
produced an exact zero-provider manifest and guest ACK, and stopped. All ten
original volumes were directly captured, and the 108,815-byte zero-credit
archive passed exact-owner, file-hash, stopped-Machine, and attached-volume
verification before the owner and pool claims were released.

After syncing with `main`, the new `CLAUDE.md` rule 25b also ruled out
classifying provider failures by error-string matching. The final planner
uses only the structured start/receipt state and a bounded failed-start log;
an unrelated provider start failure remains mapped for exact cleanup and
still cannot release a guest latch without independent proof.

The 8 GB Machine remained unstartable on that host. The pool already has seven
other 8 GB Machines and three 4 GB Machines, so its existing shape-aware claim
selection can put the two large tasks on healthy 8 GB hosts without copying a
volume. An attempted replacement was canceled before startup when provisioning
selected an obsolete 40 GB snapshot; its exact volume remains under retained
provider-cleanup ownership until Fly confirms destruction. Ten consecutive
complete slices are still needed before this case can be marked fixed. No task,
model, prompt, evaluator, scoring rule, or benchmark timeout changed.

## 2026-09-30 recurrence: stopped pool volume retained a prior run

Counted candidate `20260929-235637-18520` again reached the same Fly host-local
capacity boundary, this time on `polar-odysseys-82af9358ab6a`. Four provider
starts for pooled Machine `8445e5b279d128` returned `could not start machine
due to lack of capacity`; nine peers produced real results and acknowledged
guest cleanup. The candidate has zero proof credit. The existing recovery mapping
correctly retained the stopped Machine, but the guest-receipt path required a
backend log and exact guest state that could not exist because the guest never
started. This member's original volume still held a **different, previously
completed run**; treating those stale bytes as the current task would be unsafe.

The exact owner was `4986a735e7924cf5b7b8f7de5ad97eae`. After stopping only
its nine acknowledged Machines, an inert 512 MB `sleep` boot on the failed
Machine captured its original 20 GB volume. The 7,551,386-byte capture had a
stopped services manifest, an exited driver, a prior `run.json`, and no current
owner or run ID in any captured file. The original Machine was stopped and its
boot configuration restored. This evidence distinguishes the external placement
failure from both a task verdict and a partially started guest.

The local owning-boundary reproduction is
`python3 scripts/tests/cloudbench-rejected-start-recovery.test.py`: it accepts
the exact four-rejection, stopped-volume case and rejects an accepted start,
three rejections, current-owner bytes on the original volume, and a started
Machine. Before this change, exact stale-owner recovery of the live candidate
failed with `stopped exact Machine has no sealed provider-state proof`, leaving
all ten claims retained. The new zero-credit rejected-start receipt is bound to
the exact owner, Machine, volume, original-capture hashes, and provider rejection
log. The forensic archive verifier independently checks those fields and the
prior-run bytes before it can release resource ownership. The receipt never
creates a benchmark result or changes evaluation.

The live exact-owner recovery completed after a 32,443,679-byte interrupted
archive passed the forensic verifier: ten exact tasks, nine sealed bundles,
one stopped prior-run volume, 93 hashed files, and zero proof credit. The
guest-cleanup and runtime-evidence latches were discharged separately; all ten
pool claims were returned. A later simultaneous inert preflight started all
ten of those same 20 GB pool Machines at 8 GB, stopped them, and restored their
benchmark boot command. This recurrence remains open until the subsequent
ten-slice no-INFRA streak is verified.

## Human feedback

The user requires ten sequential slices of ten real benches, zero INFRA,
at least three successful LLM queries per bench, smoke coverage, correct
evaluation and teardown, a temporary five-minute benchmark timeout and a
30-minute full E2E kill cutoff. Inspect trajectories and total/per-bench
wall time after every valid slice, and implement safe infrastructure savings
above five percent. Do not change the harness to make results pass.

## Reusable lesson

Map provider-rejected pre-proxy starts into exact recovery without treating the mapping as guest cleanup proof.


## October 15 follow-up: exact mapping predicate still unknown

One actual canonical recovery of V41 owner
`7d6a3cfb993d437e9e2f958391ae8e4e` joined with exit 1 in 16.789 seconds.
Its source/boot/owner/nonce-bound acknowledgement retained the registry and
runtime-evidence latch; the shared audit remained incomplete. The exact
720-byte original log, SHA256
`26bbdc23014fe887311ca3c5116a72223a6ef6532aa0dfda68f084c8c58270e7`,
first failed at inline Python line 378 with
`ValueError: missing stale-owner status proxy mapping`. No canonical recovery
was repeated for this investigation, and no provider release is claimed.

The original source is commit `82b849eee20f9527426beb4f540d02553d83dc80`.
The planner block is unchanged in the inspected current source. This observed
failure is before runtime collection or provider teardown. A nonregular or
missing `status-proxy.port` enters the existing rejected-start exception only
with a nonempty bounded regular boot-start log, no accepted-start/run/worker
runtime markers, and a regular empty worker ledger. The traceback does not
identify which mapped output or which of those predicates failed. The existing
retained owner projection binds the exact Machine and volume but records only
a controller-log hash, not those file states. The author also confirmed the
required metadata was not retained locally.

The registered native-free four-case
`test_capacity_rejected_guest_without_proxy_remains_mapped_for_exact_recovery`
selection passed unchanged in 1.35 seconds: the valid rejected-start fixture
maps preferred port zero while accepted-start, allocated-worker and missing-log
fixtures refuse. These passing controls are not a causal RED/GREEN for the
actual October 15 failure. No runtime patch, latch removal, evidence shortcut or
benchmark reclassification is justified yet. The next missing operand is the
source-bound actual output mapping and exact six-file existence/type/size
projection. The private first discriminator is
`.context/stress600-root/i42-j0038-recovery-mapping/first-discriminator.safe.json`
SHA256 `50f909875e7ae7cc5b5b109307d2495576c6b7f8728a82e11551f1ac0a6908ce`.

Archive searches used `exact stale-owner runtime evidence incomplete` and
`recover-stale-owner cancellation sealed result pending`. This case is a
symptom-relative lead; the new failure has not established the same cause as
September 29. The rejected-start exception already exists in the October source.
The actual predicate and canonical recovery outcome remain open.


### Same-day operand closure: pre-config startup phase

A separately authorized read-only custody captured the exact output operands:
index SHA256 `ce4966c15f37f4a7faaa23494563bef45c9cbd070d38ee9867b0047e325f5140`.
All eight captured originals were byte/SHA checked locally. Both
`status-proxy.port` and `cloudbench-boot-start.log` were positively absent.
The worker ledger was regular and empty, accepted-start/run/worker runtime
markers were absent, pending and owner JSON matched the exact Machine/run token,
and the original child exit was 125. Thus the missing boot-start log is now an
identified failing mapping predicate; it is no longer an undifferentiated file
evidence gap. The original controller log SHA256
`16a63fb5e9cce1b637e1c3e5bc9e7ecef62639b70fdd1598f7d96559f7d2daea`
also reports boot configuration failure before barrier release and no guest
cleanup owed. Frozen source emits that cleanup message only after observing
`boot-config-unapplied`; the marker's current actual bytes and the native
configuration were not captured and remain unknown.

The native-free replay through the actual production planner fails at the same
inline line 378. It uses the existing synthetic exact-owner fixture, the
captured pre-start state tuple, and a source-derived positive unapplied marker
(explicitly not a copied current receipt). This is a local RED for the planner's
unsupported pre-config phase. It is not a complete cleanup proof or a GREEN.
Runtime ownership is persisted before boot config, but the no-proxy exception
expects a post-config start log that an earlier rejection cannot produce.

Merely permitting preferred port zero is insufficient: the existing startup
archive also needs original lifecycle and guest-shutdown receipts, both absent
in the actual capture; pool prestart recovery requires pool-only stopped guests;
and Machine-only retirement requires an already sealed full bundle with no
pending transfer. A supported fix needs phase-exact original capture and current
native identity proof, preserving zero credit and the canonical reaper. No
production edit, latch clearing, command repetition or provider call was made.
The local replay and proof are retained in
`.context/stress600-root/i42-j0038-recovery-mapping/operand-bound-RED.safe.json`,
SHA256 `eb5205c124a4a1d729c40fe453a89114461871e7f69e7b403737765836b73499`.
The new mechanism has a RED; its fix/GREEN and actual recovery outcome remain
open. This update does not reclassify any benchmark result.


### Additive pre-config evidence candidate, outcome pending

With the exact unapplied marker additionally captured (15 bytes, SHA256
`a3e4865f04c9e8cb475998ce3f962b6ce81ead63feb364294c24a0722e6411dd`),
and one exact current native read confirming the source-created `sleep infinity`
command with no run token, the parent assigned a phase-specific evidence repair.
The startup archive helper now has an explicit candidate pre-config identity,
local original archive and verification path. Its generic post-config identity
and eligible path retain their original lifecycle/guest-ACK requirement.

The permanent original-state test fails on the prior helper at its real missing
lifecycle boundary; its fixture transparently calls the former identity when the
additive phase method is absent. The unchanged original-state assertion passes
with the candidate. Nine pre-config cases plus ten existing exec delivery cases
pass in 0.401 seconds. Missing/foreign evidence, accepted start, changed versions
or config, allocated workers, linked originals and unsafe archives remain
refusals. The helper seals complete source-owned local originals with the
existing bounded tar/SHA mechanism; it does not generate a guest ACK, lifecycle,
start log or run result. No native pair supplied means evidence-only. Typed
pre-config evidence verification additionally requires matching before/after
native records for the exact ID/name/version/full inert config and original
volume. The caller still owns fresh, source-bound native reads.

The component leaves pending ownership and the runtime latch unchanged and
always reports zero task credit and native release false. The fleet integration
owner must consume this typed phase separately after re-verification; the
original planner replay is still RED until that integration is complete. No
actual capture, handoff, resource release or unchanged benchmark outcome was
performed by this local proof. The finite candidate packet is author checkout
`.context/rca-preconfig-archive/component-review.v2.safe.json`, SHA256
`080c11c36bd123b69cb82e5117810c742a70866f82f5e3fd63c85f65977b76af`.
Parent/peer integration review and actual guarded recovery remain pending.


### Pre-config candidate review corrections: durable consumption and aggregate bound

The fleet integration reviewer identified that initial verification against the
entire current source set cannot be repeated after legitimate consumption:
pending is unlinked and normal recovery changes clone/audit/batch records.
The owning partial-recovery fixture first reproduced that failure. The successor
adds an exclusive, private, file-and-parent-fsynced phase receipt before any fleet
consumer may change pending. Archive-only revalidation independently checks the
original failed controller/125/marker/ownership/provenance/audit bytes and the
historical inert native pair; it does not require sanctioned mutable records to
remain unchanged. Optional fresh native inputs must still match the original
instance and config. Every mutation continues to require fresh caller-owned
native/ownership guards; historical receipt verification is not current release
proof. The helper never consumes pending itself.

The parent also found that summing the aggregate byte ceiling after all reads
could exceed memory before refusal. A permanent small fixture first proved the
overflow file was read, then passed after each lstat was checked against the
remaining aggregate ceiling before reading. Archive/source-set and native
identity negatives remain fail-closed. The final focused command runs 22 tests,
all passing in 0.566 seconds. It includes the original unsupported-phase test,
actual phase-consumption/retry regression, aggregate no-overread regression,
accepted/foreign/missing/stale/tampered evidence inverses and the ten existing
exec delivery controls. No provider, guest, service or load call ran.

Final helper/test candidate packet:
author `.context/rca-preconfig-archive/component-review.final.safe.json`, SHA256
`f676a3a80d01859fa7d5f514e9e29a33ae11fb02a5bdd151325969055ebb09db`;
consumer contract SHA256
`1925becd7e0ba9a9078ff989f9ca04e234e0bc71e8cb18a629c6de6fadcb35b4`.
The author owns the separate whole-owner PRECONFIG fleet integration. Source
review, normal checkpoint and actual canonical recovery remain pending. The
original V41 result and all earlier erroneous physical-denominator abort flags
remain unchanged and unqualified; no benchmark credit is granted by this repair.


The final helper/test component was independently accepted after 22 registered
controls passed in 0.530 seconds (parent receipt SHA256
`03078a6f2ee01ff062c447e776f091855486e76623d5084ce9a8e1fe2dba5b74`).
Its normal two-path checkpoint is commit
`41d1e8b2e` in the author checkout; no fleet integration files were included.
The shared Git window was released immediately. This closes the local helper
component, not the historical recovery, native release or exact benchmark
outcome; the separate fleet integration owner retains those pending stages.

## November 11 recurrence: configured fresh cohort cancelled before start

PR1918's frozen `2d4c45c0da9c56e7145b2f3df8114cc5b95b7bb3` smoke
preflight was cancelled while its two fresh primaries were being configured.
The supervisor escalated to KILL and retained genuine waitpid records. The
native adapter result was missing; all thirteen original smoke cases remain
UNVERIFIED. Both outputs lacked `status-proxy.port`, `cloudbench-boot-start.log`,
`post-config-start.accepted`, `cloudbench-run.json`, `worker-runtime-evidence`
and `worker-clones.ids`. Replaying the actual production planner against the
original registry failed at inline line 378 with
`ValueError: missing stale-owner status proxy mapping`.

This was a different phase from the rejected-start and inert pre-config cases
above. Complete native configuration and payload bytes bound both Machines to
the original source, exact owner ordinal tokens, incarnation and volumes.
The recognized complete startup source creates clones with `sleep infinity`,
updates their task configuration with `--skip-start`, then waits for the local
boot-config barrier before issuing a start. The sole barrier removal precedes
child launch; normal cleanup cannot erase an earlier release. That local
release was absent. Complete native histories contained only initial launch
pending/created and update/stopped events. The later in-guest task barrier would
not be sufficient: stack and payment-fixture setup can precede it.

The repair adds a separate, whole-cohort fresh-configured no-start proof to
`cloudbench-prestart-recovery.py`. It pins complete historical startup and
cancellation producer source hashes, verifies original cancellation/waitpid
custody and owner birth, rejects worker ownership through output, audit,
borrowed and shared-claim channels, and binds exact native config and event
pairs. It preserves missing files and emits zero-credit typed evidence rather
than a guest ACK. The canonical caller consumes that proof; runtime-latch and
per-Machine reaper checks repeat native verification. The ordinary pool and
post-start mapping predicates remain unchanged. No original-volume boot or
capture was needed for this positively proven no-execution phase.

Two introduced contract errors were caught and repaired. First, the new caller
used `machine_config_exact_read`, whose CLI output is config-only, as a complete
Machine record. The first live recovery therefore failed closed with
`unsafe fresh native identity`. The initial test double had hidden the shape
mismatch. A dedicated exact Machines API GET reader now preserves the full
response, and the permanent caller/reaper tests exercise the real HTTP client
against a loopback server, including refusal of a config-only response.
Second, post-release verification incorrectly required empty audit ledgers.
The canonical finalizer retains historical IDs/names; the actual verifier
rejected them. It now requires their exact declared historical sets, without
duplicates, missing or foreign entries, while preserving terminal audit and
registry-absence checks. Neither repair erases original evidence.

The parent then completed native recovery of nested owner
`81db70ca91fb4a8096b50752d37050c2` and parent
`f04ea4e37515465c8aea2aee01b7f358`. Both canonical commands returned success;
the nested registry was removed and its audit records terminal
`destroyed-provider-retained` dispositions. This is the recorded provider
classification, not a claim that retained provider resources are physically
absent. The read-only post-release verifier now succeeds on those actual
originals, retaining the historical ledgers and zero proof credit. Independent
review passed the exact final source tuple. All 23 owning tests pass, including
native-shape, cancellation, worker, mutation and historical-ledger inverses;
the suite is registered in the controller gate. Original failure/reproduction
logs and exact hashes are under
`.context/rca-ebb350db/cancelled-smoke-recovery/investigator/`.

Archive searches used `missing stale-owner status proxy mapping` and
`cancelled prestart fresh clone boot barrier recovery`. The shared mapping
boundary recurred, but the positive phase proof and its consumer contracts
differ from the older incidents. The user required no fabricated markers,
ACKs, grades or donor changes, parent-owned provider/deploy actions, and exact
original-volume retention until a valid consumer authorized release. The
original thirteen UNVERIFIED smoke cases and five UI failures remain unchanged;
fresh smoke and pipeline reconciliation are separate parent-owned work. This
case remains open for its outstanding historical outcome requirements.
