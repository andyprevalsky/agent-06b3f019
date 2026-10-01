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

### DATA-host path translation recurrence

The unchanged full fixture later ran with the reviewed reserve repair and
outside-checkout Linux temporary files on `/data/controller-tmp`. It passed the
previous cancellation boundary and scenarios through 2d, then exited 1 at 2e:
`a launched-but-unready worker must produce an explicit readiness failure`.
This was before the intended worker-readiness boundary. Both staging attempts
reported successful SFTP upload, then the real worker adapter raised
`FileNotFoundError` opening the expected machine-local `/tmp/rbw.sh`.

Exact retained filesystem reads found both uploaded wrapper and environment in
a directory containing the fake machine's DATA-root prefix twice. The fake
transport first substituted `/tmp/rbw.sh` with the host path, then substituted
`/data` in that newly inserted host path. The earlier adapter controls used a
`/var/tmp` host root and therefore did not cover this substitution collision.
Searches for `FileNotFoundError rbw.sh run_fake_worker` and
`fake provider path replacement recursive data filesystem upload destination`
found no earlier exact path-codec case; this is another incomplete fake
transport contract exposed by the real worker evidence adapter. The
[temporary-storage case](2026-09-27-cloud-controller-temp-root-ignored-persistent-volume.md)
explains the legitimate DATA filesystem selection, not a reason to change it.

The fixture now translates all five existing guest path prefixes in one pass
over the original command, so it cannot reinterpret the host prefix it just
inserted. Twenty-one permanent assertions exercise the actual translation
function with `/var/tmp`, `/data/controller-tmp` and repeated `/data` host roots,
including mixed guest paths and unchanged non-path commands. They failed on
the previous function and passed unchanged after the repair. Production code,
worker readiness criteria, launch semantics, reserve size and deadlines are
unchanged.

The original full native failure, actual stage logs and misplaced-file hashes
are retained under `.context/acceptance/proof21-exact-recovery-order-rca/`.
The focused original 2e body then passed with the complete existing setup
prefix in 97.28 seconds: real launch occurred, the same five-second readiness
failure was observed, and the unchanged machine/registry cleanup assertions
passed. Its actual native exit and output are
`.context/acceptance/proof21-data-path-fixture-rca/focused-after2.json` and
`focused-after2.private.log` (SHA256
`a14aa48b4753714f183484b902bc4ceab815c9df0343e7651c7e191c7de312de`).
The candidate fixture was SHA256
`7466ce4e0e2ca1ba3c2f61880d416a780a649ae179c5d890b1084f3c851d6a77`;
remote tracked source remained `9f3266b6`, with the separately reviewed runtime
staged privately. A malformed private extraction and a later extraction that
skipped required Hub setup are preserved as setup failures, not path-repair
outcomes. The full corrected controller gate and live fleet acceptance remain
pending; the focused result gives neither full-suite nor live acceptance credit.

### Admitted fake errors omitted terminal evidence

The unchanged `f94858c8` full Linux controller gate later passed scenarios
through 2g, then exited 1 after 826.47 seconds at 2h:
`destroy-failure cleanup leaked machines`. Its retained fixture contained the
exact primary and worker ownership records plus `runtime-evidence-unconfirmed`.
The worker capture was complete; the primary collector returned HTTP 409,
`exact runtime is not sealed`, and exit 70. Keeping both original volumes was
the production controller's correct response to incomplete evidence.

The recorded timeline separates the expected provider failure from the broken
fixture protocol. Primary admission occurred at 23:21:51.571 UTC. Worker staging
finished at 23:22:06.355 and its complete capture at 23:22:17.659. The fake
primary's existing 30-second wait emitted its fatal result at 23:22:21.795;
the five provider destroy attempts finished at 23:22:33.675 and the autoscaler
published its failure at 23:22:33.691. No deadline or retry count was changed.
The first bad boundary was the fake driver guarding both its result and stopped
stack evidence with `exit_code == 0`. An admitted error therefore omitted the
terminal artifacts that the real driver preserves, preventing safe cleanup.

Archive searches for `destroy-failure cleanup leaked machines could not
reconcile worker failure outcomes` and `scale-down destroy failure worker
runtime evidence retained original volumes` identified this as a recurrence
of the incomplete fixture evidence contract. Earlier success and worker-error
controls had not exercised a failed admitted primary outcome.

The fixture now remembers whether benchmark admission succeeded, records an
admitted failure as `benchmark_status: ERROR` with `passed: false`, and seals
complete stopped-stack files only after the real provenance stamper succeeds.
Native exit 1 and the original fatal text remain intact. Pre-admission
cancellation and invalid provenance still produce no trusted capture. Four
permanent controls run the actual fake driver, production provenance builder
and stamper, and production runtime-evidence manifest validator. The old
producer failed the admitted-error control while the other three passed; all
four pass unchanged after the repair. The control replaces only its local
fixture clock to enter the existing 30-second failure branch immediately.
These controls are inside the existing multi-workstream fixture already run by
`scripts/test.sh`, `/deploy`, and the canonical controller lane.

Causal artifacts and immutable source hashes are under
`.context/acceptance/proof21-destroy-failure-rca/`. `source-before.sh` is the
original `7466ce4e` fixture. The private candidate `668ee7a8` changed only this
fixture over clean remote `f94858c8`, with all production runtime hashes
unchanged. The exact original 2h body, including nonzero fleet status, crossing
the provider destroy boundary, the stable scale-down failure reason and zero
owned machines, is byte-identical (SHA256
`8839c0fbac1212882873ef02f2050d2193238993992dd1f68d1a4aeea61df938`).
The focused original 2h body then passed with the complete existing setup
prefix in 94.463 seconds, native exit 0. Its log SHA256 is
`6ef5629efd7828045407ef136b21da92d34d57136f1ac5e27c29029ba645fc57`;
`focused-after.json` pins the native receipt, command and complete output.
Both exact wrapper and command PIDs were independently observed absent. The
final proposed fixture `34449060` differs from the executed `668ee7a8` only by
a comment spacing correction; producer bytes and control AST are identical.
The complete committed controller suite and live acceptance remain pending.
A rejected oversized private transfer created no remote files or processes
and is preserved separately from the actual focused execution.

### Post-confirmation fixture retained the independent evidence latch

The unchanged remaining-scenario replay at `fb30bc4c` plus the separately
reviewed native-command completion fix passed scenarios 3–5, then failed
scenario 6: `active-runner stale ownership must fail closed (exit=0)`.
The old source registry remained present and the successor admitted a new task
without ever logging stale recovery or the expected runner-count refusal.
The overall replay exited 1 in 110.41 seconds with an empty terminal process
audit. This was an offline fake-provider fixture, not a paid fleet run.

Archive searches used `runtime-evidence-unconfirmed post-confirmation
stale-owner fixture` and `quarantine evidence latch fixture recovery skipped`.
This is another fixture-contract recurrence of the raw-evidence rollout.
Scenario 6 explicitly models an owner whose cleanup is already confirmed,
sets `cleanup_policy=reap`, and removes `guest-cleanup-unconfirmed`. It had not
been updated to remove the independent `runtime-evidence-unconfirmed` latch.
Both the original retained registry and an unchanged focused reproduction
contained that second latch. Executing the real `fleet_registry_cleanup_state`
against each returned `quarantined`, so reconciliation correctly skipped the
owner before the runner-count gate the test intended to exercise.

A passive native-state observer inside `registry_owner_alive` was never reached
in the failing focused reproduction. An initial owner-liveness hypothesis was
therefore rejected; the original historical process had already disappeared
when inspected, and no zombie state was established for that incident. The
focused original case exited 1 in 49.53 seconds with the same assertion. No
production process-identity or recovery predicate was changed.

The fixture now removes both exact confirmation latches only at its explicitly
modeled post-confirmation transition. Cancellation and pre-ack quarantine
scenarios keep their incomplete-evidence flags and original retention
assertions. No other scenario has the same one-latch removal pattern; manually
constructed dead-owner fixtures create neither latch. The candidate keeps all
scenario 6 assertions byte-identical, including native refusal status, exact
registry/audit identity binding, runner count 1, no machine destruction and no
new provisioning. It adds no timeout, retry, provider call or benchmark change.

The paired focused case passed in 31.60 seconds with native exit 0 and a verified
empty terminal process audit. The real owner check was reached after the fixture
transition; it observed an absent controller, then the active-runner guard
refused recovery as expected. The diagnostic runtime differs between the two
replays only in the passive observer's output path. Source fixture hashes were
`344490607289f88e1440f4b1e0a7ede88bfab3da1d1ad9a2549a65ec96f35947`
before and
`f577d4d1100eee73bb4ab009d3a03f21be58f3ea3df79305dbd7c340513713cc`
after. Complete private receipts, native-state observations, retained latch
hashes and original logs are under
`.context/acceptance/proof21-stale-runner-rca/`. The owning case already runs in
the canonical full multi-workstream fixture selected by `/deploy` and
`scripts/test.sh`; no duplicate selection or runtime abstraction was added.
Remaining scenarios and the full final controller gate retain their own
outcomes and are not credited by this focused result.

### Extracted cleanup fixtures omitted the real evidence dependency

The full r5 controller at `8600f487` reached the owning Python selection after
all shell scenarios passed, then failed three lifecycle cases with
`cloudbench_collect_remaining_runtime_evidence: command not found`. The
lifecycle registry-retirement test and both EXIT-cleanup variants of the volume
migration test extracted `cleanup()` without its newly required evidence
collector. The direct migration variant, which does not call `cleanup()`, passed.
This is another fixture rollout omission after raw evidence became mandatory;
production cleanup correctly refused to verify teardown when collection could
not execute.

Archive searches were `cloudbench_collect_remaining_runtime_evidence command
not found` and `extracted shell fixture dependency closure missing helper`.
The recovery-bootstrap and moved-helper cases are relatives; the first bad
boundary here is the same raw-evidence rollout's incomplete isolated cleanup
fixture. The original r5 failure remains preserved.

The focused command selects
`fleet_lifecycle_receipt_requires_final_registry_retirement or
migrated_registry_reaps_seals_audit_and_retires_lock_directory` from
`agents/benchmarks/cloudbench_dependency_sync_test.py`. The unchanged tracked
baseline reproduced **3 failed, 1 passed** in 0.90 seconds on macOS. The private
candidate extracts the actual `cloudbench_collect_remaining_runtime_evidence`
and `cloudbench_fsync_directory` implementations and supplies the controller's
empty `CHILD_OUT` and `CHILD_MACHINE` arrays. These fixtures admit no benchmark
child; the migration fixture is provisioning a pool clone. No collector success
stub, invented capture, or production exception is added.

Both fixtures now begin with a real `runtime-evidence-unconfirmed` latch and
assert that actual collection removes it. The strengthened assertions were run
unchanged with only the missing dependency/bootstrap bindings removed, producing
**3 failed, 1 passed** in 1.95 seconds; restoring those bindings produced
**4 passed** in 2.18 seconds. Every pre-existing assertion remains unchanged,
including registry retirement, audit sealing, migration history, snapshot
retirement, and native exit 0/143. Full-controller revalidation on the eventual
combined candidate remains pending. No production, benchmark, timeout,
concurrency, or 10,000-agent resource behavior changes.

Evidence, the private patch, identical-assertion checks, and exact command/log
hashes are under `.context/acceptance/proof21-lifecycle-fixture-rca/`. The private
copied module uses a collection hook only to restore its repository `ROOT` and
`FLEET_SCRIPT` globals; that relocation hook is not part of the tracked repair.

### Extracted transport fixture omitted admission preparation

The same full r5 gate also failed
`test_fleet_shared_patch_remains_authoritative_until_transport_selection` with
`cloudbench_prepare_runtime_evidence: command not found`, exiting 70 before its
patch-authority assertions. Its isolated pre-transport block now calls a real
helper defined earlier in `run-bench-cloud`; that definition was absent from
the fixture. This shares the incomplete extracted-dependency boundary above.
The full owning selection retained four failures, 132 passes and 440 deselected
cases. Its native exit was 1 and its terminal process audit was verified empty;
passing all multi-workstream scenarios did not grant full-controller credit.

The fixture now extracts the actual preparation helper and explicitly sets its
existing non-boot mode: no guest has been admitted by this transport-only
fixture. It does not stub the helper or bypass an admitted guest's evidence
ownership. The original payload identity, digest, marker and fleet-owned patch
retention assertions remain unchanged. An exact extracted reproduction failed
with the missing-helper error before the repair and passed with the dependency
present. Both use the committed runtime source; no production source changed.

Private paired source/log receipts are under
`.context/acceptance/proof21-extracted-evidence-closure-rca/root/`, and the
independent combined candidate review is in its parent directory. These owning
fixtures are already selected by the existing `/deploy` controller gate; no
new live gate, timeout, workload or benchmark criterion is introduced. The
combined committed full gate and actual 100-benchmark proof remain separate
requirements.

### Proof24 seal race, transfer deadline, and worker-loop shutdown recurrence

Proof24's first live ten-task slice at `46c29a4` earned zero credit. The guest
announced `::CLOUDBENCH-DONE::` before its EXIT trap completed; the controller's
first authenticated `/runtime-evidence` read received HTTP 409 because the exact
stack was not sealed. Other collectors reached sealed guests but expired while
transferring multi-megabyte raw logs: they had inherited the 30-second child
termination grace as their entire collection deadline. Five task outcomes were
collected, but a task verdict alone cannot authorize source deletion or slice
credit. The ten exact failed machines were stopped and their original volumes
retained. The source-bound plan and native inventory are under
`.context/acceptance/proof24-retained-plan.json` and the private proof24
snapshot directory. Archive searches used the literal `exact runtime is not
sealed` and `terminal runtime evidence deadline expired`, then behavioral
`DONE before cleanup raw log capture` and `worker stopped but process alive`.

The first bad collector boundary was interpreting DONE as the exited seal and
using a process-termination deadline for bulk evidence transfer. The collector
now retries only HTTP 409 before the *first* manifest, within one bounded
seal-plus-transfer deadline. Any later manifest mutation, identity mismatch,
authentication error, missing file or short read still fails closed. Normal
collection is bounded by 7,200 seconds; the explicitly temporary proof uses
300 seconds. The raw files and complete manifest remain mandatory. A real
status-server regression reproduces 409-to-seal and slow transfer; it also
proves perpetual 409 expires and grants no complete manifest. The existing
26-case owning collector fixture passed after its extracted shell environment
was given a three-second test deadline; the fixture's 15-second process limit
is not a production collection deadline.

The stopped fork of `polar-bu-032` exposed a separate upstream cleanup blocker.
Its worker log recorded a bounded terminal CDP disconnect timeout, recording
upload and browser cleanup, then `Worker stopped`; the Python worker nevertheless
remained alive until forced machine recovery. The stack therefore never wrote
its clean receipt or driver ACK. `asyncio.run()` waits indefinitely for a CDP
task that ignores cancellation after browser terminal I/O has already timed
out. A local subprocess reproduction ran the same terminal disconnect path:
with `asyncio.run()` it exceeded its two-second process bound after the bounded
call returned; with the worker's bounded event-loop shutdown it exited after
the explicit worker cleanup. The checked-in worker blackbox now reproduces
that behavior and rejects unrelated uncancellable tasks. The worker and browser
blackbox domains passed. No task, prompt, model, evaluator, LLM-call count or
benchmark pass criterion changed. The actual 100-task infrastructure proof is
still required; this causal repair does not award proof24 credit.

### Failed-owner recovery with an unadmitted volume clone

After all ten proof24 benchmark guests were archived and their machines and
volumes were natively retired, exact forensic recovery refused the owner. Its
registry held eleven owned fresh clones: the ten admitted benchmark machines
and an earlier source-volume clone whose machine ID was empty. The extra clone
never acquired a benchmark slot or guest, but its volume still existed. The
forensic verifier had assumed every clone was an admitted benchmark machine.

The verifier now recognizes only a precisely bound `fresh-clone` record with
an empty machine ID as unadmitted. It still requires one archived original per
admitted task and native absence of **every** owned volume, including the
unadmitted clone. The focused recovery fixture proves an absent unadmitted
volume permits zero-credit retirement and a live one retains the latch. The
proof24 clone must be retired by its exact native identity before recovery is
retried; its registry and audit records remain for the production reaper.

The next recovery check exposed mixed collector states within that failed
slice: five tasks had already cleared `runtime-evidence.pending` after
publishing their canonical result, while five still had pending markers. The
forensic verifier now accepts either the exact pending owner marker or two
matching copies of the collected result. A missing pending marker without
those copies, or mismatched copies, still refuses recovery. The focused test
includes both successful and rejected collected states.
The collected JSON can exceed the small owner-marker size limit; the copy
comparison has its own bounded 64 MiB limit. A read-only native-inventory
preflight accepted proof24's exact ten archived tasks, one retired unadmitted
clone, and two incomplete task archives with zero credit.

### Proof74 permanent recovery fixtures omitted pool admission bindings

The terminal-evidence blackbox gate failed two legacy runtime-retention controls
with 122 passing cases. One extracted exact-owner recovery without its real
pool-confirmation dependencies or empty owned audit. The other described an
admitted fresh-clone primary with obsolete `.cid` kind `fresh`, while the real
runtime accepts `clone`, and omitted the now-required empty pool audit directory.
These failures are fixture-contract recurrences, not permission to weaken
recovery or evidence requirements.

The fixtures now supply the complete empty owner-bound fresh/pool audit, extract
the real pool helpers, and use the actual `clone` identity. Their original event,
native status, corruption and durability assertions remain intact. The exact
owning gate `test_boot_terminal_runtime_evidence_is_in_permanent_gate` first
failed with the two controls above, then passed all 124 checks. No production
recovery predicate, timeout or proof criterion changed for this repair.

## Human feedback

The user requires infrastructure-only changes and no infrastructure failures
throughout startup, execution, evaluation, evidence and teardown. Task failures
may remain task failures; prompts, models, evaluators, proof thresholds and
benchmark behavior must not be changed to manufacture success.

## Reusable lesson

Preserve complete owner-bound runtime evidence before deleting each source, and keep evidence retention independent from truthful workload cleanup acknowledgement.

## Review recurrence: completed standalone ownership poisoned the next admission

On October 1, the actual boot admission preamble and owner writer reproduced
`FileExistsError` when a completed standalone run reused the default output
namespace. The prior immutable owner remained even after its pending marker
was cleared. An initial per-token output-directory draft was rejected by
independent review: a second run could bypass an unresolved first owner and
reuse its Machine. That draft was exercised only in temporary fixtures and was
removed before live allocation.

Standalone admission now holds a nonblocking local `fcntl` lock while inspecting
that same output namespace. An existing pending marker always rejects admission.
A completed previous owner can move into `runtime-evidence-history/<old-token>`
only after verifying its owner/capture identity, clean stack status, complete
worker-log set, exact tree entries, sizes and hashes. The owner and sealed
capture are renamed without changing their bytes. Missing owners, partial or
mismatched captures, symlinks, archive collisions and lock contention fail closed.
Fleet output ownership remains exclusive and cannot use this archival path.
New owner and pending records are persisted before guest work is admitted.

The final permanent nine-case test exercises the actual preamble and admission
function, including unchanged rejection of pending/partial ownership, foreign
capture identity, corrupt bytes, owner and capture symlinks, fleet reuse and a
held admission lock. Its completed-reuse case fails on exact baseline
`864644162722720784dd60447cd8d461cefa54de`; all eight refusal controls pass there.
All nine cases pass on the corrected source in 2.70 seconds. An additional
owning reproduction caught an unlisted symlink directory accepted by the first
archival draft (0.21 seconds RED); the final exact-entry check closes that gap.
Independent review reran the unchanged final test: nine passes in 1.26 seconds;
the immutable baseline retained the expected one failure and eight passing
refusal controls in 1.787 seconds. It confirmed source outside the admission
helper and all prior test ASTs were unchanged.
Tests remain in the existing registered `cloudbench_runtime_retention_test.py`,
with no live API requests or added deploy stage. Private receipts/logs are under
`.context/acceptance/proof84-standalone-archive-*`.

Searches `runtime-evidence.owner FileExistsError standalone` and `prior run
evidence output directory admission` identified this capture-ownership case as
the recurrence. Work is bounded by one previous sealed capture (existing 512 MB
ceiling) and one local namespace lock. At 10,000 agents there is no global
registry, Machine inventory scan or per-agent shared lock. This causal admission
proof grants no live fleet acceptance credit.
