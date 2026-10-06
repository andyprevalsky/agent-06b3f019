---
id: 2026-09-29-runner-receipt-accepted-before-stack-cleanup
date: 2026-09-29
title: Recovery promoted a clean benchmark-root receipt into guest stack cleanup
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet cloudbench_recover_guest_cleanup_receipts accepted a clean runner receipt without a guest stack acknowledgement
symptoms:
  - "FATAL: could not publish guest cleanup acknowledgement"
  - "driver cleanup evidence interrupt_status=1 cleanup_ack=0"
  - "guest cleanup request failed (HTTP 500)"
  - "terminal runtime evidence deadline expired"
  - "stack worker cleanup was not confirmed; refusing guest cleanup acknowledgement"
tags:
  - cloudbench
  - fleet
  - teardown
  - ownership
  - runtime-evidence
sources:
  - PR #1299
  - fleet run 20260929-161610-10375
  - fleet run 20260929-183257-2121
  - fleet run 20260930-033934-26671
  - fleet run 20261006-115614-55990
  - commit e33e3c94e285c5665f77b198c25e7bca3f1ac9c6
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The smoke-inclusive ten-benchmark slice on commit `f1c5d5f26` started all ten
stacks and nine tasks produced evaluated run records with 5–60 verified
successful LLM completions. The planner guest took roughly eight additional
minutes to become healthy. Its benchmark-root interrupt receipt was `clean`,
but `run.sh` published `state=failed` for stack cleanup; the worker supervisor
remained live, and the driver withheld the guest cleanup acknowledgement. The
guest reported HTTP 500 from `/shutdown-health`. The slice is an INFRA failure
and earns no acceptance credit.

The fleet's cancellation recovery treated the narrower benchmark-root receipt
as sufficient to publish `guest-shutdown.confirmed`. It then waited the full
600-second runtime-evidence deadline on HTTP 409 even though the same guest had
already reported the terminal HTTP 500. Recovery failed with ownership retained.
After that invalid confirmation was preserved separately, the next exact
recovery exposed a second gap: the guest state was `exited`, with no driver
descendants, but its services manifest still said `failed`. The quiescence
helper correctly rejected this as not durably stopped, while the fleet refused
to enter its existing exact Machine-stop/provider-cleanup fallback.
After exact Machine stop and provider cleanup succeeded, recovery still tried
to recapture sealed runtime evidence from that stopped guest before clearing
the independent guest-cleanup latch. This prevented the failed-run forensic
archive from being built, even though the original volume and exact cleanup
receipts remained available. The interrupted driver's original state was
`exited`, its PID file was absent, and its services manifest was `failed`;
the older archive verifier only accepted the pre-interrupt `running` state.
No task prompt, evaluator, scoring rule, or execution timeout was changed.

## Diagnosis

The observed path was benchmark-root interrupt cleanup → guest stack cleanup
failure → no guest acknowledgement → recovery. The first incorrect promotion
was in `cloudbench_recover_guest_cleanup_receipts`: the `clean` runner-receipt
branch called `recover-runner-receipt` and published the whole-guest confirmation
without checking `/shutdown-health`. An already persisted runner-only recovery
receipt took the same shortcut. A separate collector loop treated HTTP 409 as
transient until its deadline and did not inspect the terminal shutdown state.
The recovery fallback accepted `active` and `exited-no-run`, but excluded a
validated `exited` driver whose stack cleanup failed. That excluded precisely
the guest for which an exact Machine stop is needed before provider release.
The deeper general class is using a receipt from one ownership scope to attest
to a larger scope. The original stack-cleanup failure remains under investigation;
these two recovery bugs are independently reproduced and repaired.

Two RCA archive searches were run: `could not publish guest cleanup
acknowledgement stack worker cleanup failed` and `worker supervisor did not
finish graceful cleanup process birth identity`. The September 11 cloud archive
case is related, but its primary stack guardrail worked here: it refused the
ACK. This case records the distinct recovery boundary that subsequently
upgraded the runner receipt.

The unchanged local repro command
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_clean_runner_receipt_cannot_ack_failed_guest_stack`
failed before the fix with `positive runner cleanup receipt is invalid`; the
fixture asserted that full exact provider cleanup must run instead. The
terminal-collector repro in
`scripts/tests/cloudbench-runtime-evidence-collector.test.py` failed before the
fix because it reached its three-second deadline rather than reporting the
already terminal guest failure. The added
`test_unquiesced_guest_seals_sessions_then_stops_exact_machine_before_cleanup[exited-with-failed-stack-cleanup]`
failed before the second fix with `exact guest quiescence rejected: guest
services are not durably stopped`; the identical test passes afterward and
asserts Machine stop precedes provider cleanup.

## Solution

`run-bench-fleet` now requires authenticated `/shutdown-health` HTTP 204 before
a clean runner receipt can confirm whole-guest shutdown. If that proof is
absent, it preserves any earlier runner receipt separately and proceeds through
the existing exact guest/process/provider recovery. The runtime-evidence
collector probes the same authenticated shutdown endpoint after HTTP 409 and
fails immediately on its terminal HTTP 500; ordinary delayed sealing retains
its existing bounded wait. A validated unquiesced `exited` driver now joins
the existing exact Machine-stop/provider-cleanup fallback. Blackbox tests
cover failed, healthy, and previously persisted runner receipts, terminal
collector failure, and stop-before-provider-cleanup ordering. Exact guest
cleanup now releases only its own latch before attempting runtime recapture;
the runtime-evidence latch and pool claims remain retained until the original
bytes are archived and verified. The zero-credit interrupted archive accepts
an absent original driver PID only with original `exited` state, `failed`
services, and exact stopped-Machine/provider receipts. Its recovery path also
stops the other acknowledged pool Machines before the native archive verifier
can release any claim. A live recovery and
ten consecutive complete slices are still required before this case can be
marked fixed.

The interrupted run's original archive passed exact-owner/native verification
with zero proof credit and returned all ten stopped pool claims. The planner's
boot held the synchronized slice barrier roughly eight minutes longer than
its peers while its shared CPU showed sustained pressure. It now receives the
existing 8GB/shared-CPU-4x primary shape for real execution, reusing a 20GB
pool volume through the already verified dynamic resize path. The next slice
showed the planner ready alongside peers, but `image-handling` then held nine
ready stacks at the barrier with its worker not listening and CPU pressure
reaching 84.59%. That attempt was canceled before task execution, with no
acceptance credit. `image-handling` now receives the same resource-only large
primary; its startup and cleanup still need live verification.

That cancellation also exposed a terminal collector wait: a guest can
acknowledge clean shutdown before any benchmark run record exists. The runtime
endpoint correctly returns 409 forever in that state, while authenticated
`/shutdown-health` returns 204. Both normal and recovery collectors now fail
closed immediately on that combination, leaving the runtime-evidence latch
for zero-credit forensic capture instead of waiting 600 seconds per guest.
The same case leaves the original driver `exited`, services `stopped`, and
`run.json` absent. The interrupted-pool verifier now accepts this state only
with the exact run-token driver ACK, the matching original clean stack status,
the controller's guest confirmation, and independent native stopped-Machine
inventory. It still requires an exact stop/provider receipt when stack cleanup
failed and still awards zero proof credit to either interrupted case.

A subsequent smoke-inclusive slice reached nine ready stacks, but
`wait-for-trigger` held the start barrier with 82.10% CPU pressure and no
benchmark result. It received the same resource-only large primary shape.
Its cancellation exposed one more recovery boundary: the task never created a
root agent, so the older provider manifest required a root that could not
exist. Exact recovery now accepts a prestart zero-provider manifest only when
the authenticated guest state shows an exited driver, no run record or live
process, the backend log proves no root or external provider allocation, and
the exact Machine is stopped with matching recovery receipts. The other nine
guests had their original clean ACKs. All ten original volumes were captured
and the 125,129-byte zero-credit archive passed exact-owner and fresh native
Machine/volume verification. A direct read of selected files from stopped
pool Machines avoided ten full-volume snapshot forks; each Machine's original
configuration was restored and checked after capture. This optimization only
changes forensic transfer, not benchmark execution or evaluation.

At 10,000 agents, this adds one bounded status request only for a guest missing
its normal shutdown confirmation. It does not inventory other agents or
providers. In the observed terminal state, the collector's futile wait falls
from 600 seconds to under one second in the local boundary repro.

### Stale running manifest after a required service exits

The fourth slice of the September 30 capability proof had nine evaluated,
sealed tasks and one interrupted `polar-odysseys-dd2eedbc88cb` guest. Its
original supervisor log recorded `back-end (PID 1510) exited with code 137`
followed by stack shutdown. The driver exited and wrote an `ERROR` run record,
but the original `services.json` still said `running`. The exact Machine was
stopped, its provider session was released with a bound receipt, and all ten
original volumes were archived. The archive verifier rejected that stale
service status before it could release the runtime-evidence latch, retaining
the owner. Exit 137 proves SIGKILL of the backend child; the reason for that
signal is still unproven and remains an open infrastructure issue.

The first bad recovery boundary was the interrupted archive verifier's
assumption that a stopped guest with an exact provider receipt must have a
`failed` service manifest. A required service can exit before the supervisor
flushes the manifest. The local reproduction
`python3 scripts/tests/cloudbench-prestack-recovery.test.py` failed on the
unchanged positive case at `assert services["status"] == "failed"` (six other
tests passed). The same command passed all nine tests after the fix, including
negative tests for absent supervisor exit, wrong backend PID, and incomplete
provider receipt. The Cloud controller ran the same suite and then recovered
the exact owner; no interrupted task received benchmark proof credit.

The zero-credit verifier now accepts this narrow stale-`running` case only
when the archived supervisor log names the original backend PID and its
code-137 exit before shutdown, the original run record identifies the single
`ERROR` task, the captured backend bytes reproduce the active provider
manifest, and the stopped-Machine proof plus exact provider cleanup receipt
validate together. Native inventory and original archive hashes remain
mandatory. This extends the existing recovery case rather than treating the
backend's unexplained SIGKILL as fixed.

### Failed services bypassed exact provider receipt validation

The October 1 independent review found that the interrupted-pool verifier
validated an active provider manifest and its release receipt in the exited-driver
branch when the original services status was stale `running`, but accepted `failed` services without
those checks. The stopped Machine alone does not prove that its external
provider sessions were released. This could retire an interrupted owner with
zero benchmark credit while silently dropping its provider cleanup obligation.

Two archive searches, `forensic retirement failed services tampered receipt`
and `provider manifest cleanup retirement stopped receipt validation bypass`,
identified this existing recovery case. The actual public verifier reproduction
is `python3 scripts/tests/cloudbench-prestack-recovery.test.py
FailedStackRecoveryTest.test_failed_services_cannot_retire_with_unverified_provider_cleanup`.
Its unchanged native archive fixture accepted all four corruptions before the
fix: an empty release list, an unrelated receipt kind, an unknown manifest kind,
and a backend-log digest that did not match the retained original bytes. Each
negative assertion failed with `AssertionError not raised`; the complete
positive fixture remained accepted with zero proof credit.

Both `failed` and stale `running` services in that exited-driver branch now require the same recomputed
active provider manifest, original backend-byte binding, stopped-Machine proof,
and exact provider release receipt. The stale-running supervisor exit and
single-task `ERROR` guards remain unchanged. The identical regression passes
afterward. The focused prestack, quiesced, prestart, and rejected-start suites
pass 22 tests in total. At 10,000 agents, this adds only validation of each
owner's already captured bytes and exact recorded sessions; it makes no new
provider inventory or model requests. Independent review and the consecutive
live fleet proof remain required; the owning fixture earns no acceptance credit.

### Started and still-running driver archives bypassed provider receipt validation

The later exact-source review identified two further branches of this same
ownership defect: a started archive with stale `running` services and an
interrupted archive retaining the original driver PID. Both compared native
Machine identity and stopped-proof hashes but could accept an unrelated cleanup
receipt or omit provider sessions. The earlier exited-driver repair did not
cover those branches; its positive and negative assertions remain unchanged.

The actual public verifier now has two compact owning cases in
`scripts/tests/cloudbench-prestack-recovery.test.py`, each with an exact
zero-credit positive control and five corruptions: a missing release, wrong
receipt kind, another session's release, a forged manifest with its stopped
proof and receipt hashes consistently updated, and different captured backend
bytes. The same final fixture accepted all ten corruptions against
the original verifier; each negative assertion failed. The repaired verifier
rejects all ten and accepts both controls. The original verifier was loaded
from its retained exact bytes through a private import overlay; the actual test
and canonical helper paths were unchanged. No source was swapped during the
reproduction.

Both branches now use the same full validation as the existing failed-stack
path: bind the captured backend digest to the already verified original archive,
recompute the active provider manifest, validate the exact stopped-Machine proof,
and match every cleanup result to the manifest's sessions. The started archive
retains only backend digests for this check, not all backend payloads. Existing
supervisor-exit, single-task `ERROR`, native inventory, worker ownership and
archive hash guards remain. This adds no network inventory or model requests,
changes no task or timeout, and supplies zero benchmark credit.

The permanent runtime-retention gate selects just these two owning cases under
its existing terminal bound. The focused prestack, quiesced, prestart and
rejected-start controls pass 24 tests in total. All 18 existing prestack class
methods and all unrelated verifier functions remain unchanged. The final diff
preserves existing formatting outside the actual helper and call-site changes.

### Fresh infra cancellation before backend/worker launch

The October 6 fifty-copy cached diagnostic never released its strict start
cohort and receives zero benchmark credit. Its task-free infrastructure canary
allocated two fresh Machine/volume pairs. Both original drivers were canceled
with exit143 before stack readiness and correctly refused their cleanup ACK:
the original stack cleanup status did not exist. Exact recovery then required
the ordinary provider manifest, backend log and guest state, which could not
exist at this earlier service boundary. Stopping a Machine alone still did not
justify dropping a possible external provider cleanup obligation.

Archive searches were `stack worker cleanup was not confirmed before service
bootstrap` and `could not publish guest cleanup acknowledgement stack worker
cleanup failed`. This is a sibling of the existing recovery contract, with a
different absence proof. The old Mac-only prestack route requires a clean
driver ACK and no stack log; the rejected-start route requires every provider
start to have been rejected. Neither applies to an accepted fresh guest that
already started `run.sh` and created an isolated database.

The original stopped volumes were read through native inert sleep boots,
without starting a backend, browser, model or task. The original configs,
including all env/proxy values, were restored with skip-start and compared to
native STOPPED inventory afterward. The four captured runtime files are the
complete driver/stack logs, original `exited` state and exact shutdown request.
Service PID ledger, backend/worker logs, benchmark run record and clean ACK
were genuinely absent, rather than synthesized. A further native read proved
both tracked trees clean at original `e33e3c94`, with 21 driver/bootstrap/helper
and package hashes matching that immutable source. The canonical source-recipe
digest is `44e814acf5773835107e1886bdb72d1339b6aa99bc716feceb03defa83a50459`.

Both stack logs prove isolated database creation and restore. One ends after
the agent-network index bootstrap; the other ends while installing frontend
dependencies. Those occur at `run.sh:1131` and `run.sh:1269`, before its full
EXIT cleanup trap at 2340 and before tunnel/backend/worker launch afterward.
The early EXIT trap only released the seed lock. Consequently the driver’s
strict stack-status check at `cloudbench-run.sh:200` rejected ACK publication.
This is pre-service cancellation, not zero stack allocation or an evaluated
task failure.

Before production edits, the existing public prestack validator failed on the
actual original capture and stopped native inventories with
`unsupported prestack owner or task`. The permanent owning regression had two
positive errors and nine adverse passes on that source. The exact consumer
regression separately failed before its branch was added. Unchanged assertions
then passed all 13 controls; the existing 13 prestack/failed-stack tests also
passed. Controls reject another owner or volume, unknown/modified source,
dirty tracked files, incomplete capture/absence evidence, service or task
launch, live Machine, completed or noninfra child, altered config, linked
archive and altered published receipt. Fixture serialization was corrected
before production edits to match the native config snapshot bytes; no
acceptance assertion was relaxed.

Independent review found that fixture setup read the historical Git object for
its source hashes. The fixture now freezes the independently native-captured
hash map, so fresh/shallow deploy clones can run all 13 unchanged assertions
without that historical object. The recipe digest and production verifier are
unchanged. The compact deploy structural registry and its documentation/pinning
test include this family.

The narrow route adds a distinct `fresh-infra-bootstrap-zero-provider`
archival receipt through `cloudbench-prestack-recovery.py`. It is admitted
only for this independently source-attested recipe and exact failed fresh
infra owner. It explicitly reports isolated DB creation, zero external
provider allocation and zero proof credit. It does not create a standard
provider manifest, guest state or shutdown ACK. Exact stale-owner recovery
rechecks the original source/config/capture and current native stopped Machine
and attached volume before discharging its cleanup latch and using the
existing exact fresh Machine/volume/claim reaper. Any owner/source/phase gap
retains quarantine; generic cancellation is never sufficient.

After independent source review and the 13 owning controls, native exact-owner
recovery exited 0 in approximately 59 seconds. Independent native inventory at
epoch 1791291257.561 proved both owned Machines and volumes absent, the exact
owner registry retired, and the ownership audit `provider-teardown-verified`.
The independently reviewed native retirement helper hash was
`303d4c7e6ae9e689add5e0d4e873007fdc86fbb735ca0795713a172b7bdbb055`,
fleet hash was
`6ed1b82c98614dc0ea27d996b58dfbad9e1e4f66d2518e00558d22363ed40bc8`,
and portable frozen test hash was
`61236fb966e00056f89a33a25b240fbb19233fd3305421bac0971075b1a4ecfb`.
All 35 baseline Machine IDs and all unrelated native volume IDs were preserved.
Observed allocation-to-verified-release times were 3458.56 and 3457.56 seconds,
so the original 1200-second diagnostic cutoff was breached and its credit
remains zero. Original captured bytes and the failed terminal were preserved.
This boundary repair supplies no new task execution, replay-cache or
judge-latency proof and does not mark the larger fleet capability issue fixed.
Private exact-source red/green,
controls and source receipts are under
`.context/acceptance/proof85-forensic-stopped-receipt-rca/`. Independent review
and the final native gate remain required. The original live recovery and
consecutive fleet outcome requirements remain open.

## Human feedback

The user requires infra-only changes, ten consecutive sequential cloud slices
of ten real tasks with zero INFRA, at least three successful LLM completions per
bench, smoke benches, exact evaluation and teardown, a temporary five-minute
benchmark backstop, and a 30-minute full E2E kill cutoff. After each valid
slice, report the slice and individual E2E times and repair safe infrastructure
changes saving more than five percent of wall clock. Do not change the harness
to make benchmark outcomes pass.

## Reusable lesson

Never promote a clean receipt for one lifecycle owner into proof that a larger
owner has shut down; query the larger owner's terminal state before acknowledging it.
