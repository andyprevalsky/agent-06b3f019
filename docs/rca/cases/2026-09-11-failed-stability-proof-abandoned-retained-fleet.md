---
id: 2026-09-11-failed-stability-proof-abandoned-retained-fleet
date: 2026-09-11
title: A failed stability proof exited without recovering its retained fleet owner
surface: cross
component: cloud-fleet-proof-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-fleet-infra-stability-proof finalized a failed slice after the fleet controller quarantined its ownership registry without handing that exact owner to recovery
symptoms:
  - "guest shutdown request failed (HTTP 000)"
  - "retaining fleet ownership"
  - "failed proof left ten Machines started after its controller exited"
  - "non-regular exact recovery identity"
  - "exact stale fleet ownership recovery failed"
tags:
  - cloud-fleet
  - ownership
  - cleanup
  - cancellation
  - supervision
sources:
  - PR #1299
  - fleet run capability-stability-20260911135448-5408
  - fleet run 20260911-065448-5845
  - commit cf8bc97262fb069b615bbdd17e18dfb206649b33 (November 3 repair baseline)
  - commit fb4fef6ac50a29afd06520d398f6b9c725925313 (retained November 3 failure)
repro: scripts/tests/fleet-stability-cleanup.test.py
status: open
---

## Problem

Proof 12 stopped at 14:11:43 UTC on September 11, with controller exit 70
and zero accepted slices. All ten tasks honored the temporary 300-second
execution backstop. Three post-execution metrics failures were followed by
three guest shutdown requests returning HTTP 000. The fleet controller
retained the complete exact-owner registry rather than destroy resources
without cleanup proof. Genuine guest cleanup acknowledgements arrived later,
between 14:13 and 14:20, after that controller had exited.

The preserved inventory at 16:32:49 UTC still showed all ten primary Machines
started. The ignored launch wrapper had appended the exit code but left its
active status as `running`. The parent subsequently recovered the exact owner
through the canonical recovery command, independently verified the ten
Machines and eleven volumes terminal, verified nine browser sessions terminal,
and published all ten evidence bundles. Recovery does not give the failed
slice acceptance credit.

## Diagnosis

The path was task execution -> guest cleanup acknowledgement -> fleet ownership
quarantine -> evidence wrapper rejection -> proof finalization. The first bad
ownership boundary was the last transition: the proof stopped supervising
resources when the child command returned a failure, even though the child's
durable registry explicitly retained them.

`cloudbench_confirm_guest_shutdowns` rejects an unreachable status proxy.
`run-bench-fleet` then sets the batch's `KEEP_CLONES=1`, persists the unconfirmed
guest state, and skips provider reaping. This preserves the safety contract.
The ignored evidence wrapper rejected the failed lifecycle and returned 70.
The canonical stability-proof loop recorded the infrastructure failure and
exited without calling exact-owner recovery. Increasing task or guest timeouts
would not repair this missing ownership handoff.

The archive searches were:

- `retaining fleet ownership guest shutdown HTTP 000`
- `failed proof exits stranded machines stale running status recovery`

The July 15 Bash signal-forwarding case and September 9 registry-retirement
case are relatives. Their solutions and human feedback require exact ownership
and continued fail-closed handling of malformed identity. This incident also
occurs on an ordinary child failure, without a user signal, at a different
supervisor boundary. The worker delay that first prevented timely guest ACKs
has its own investigation; it is not diagnosed by this case.

## Reproduction

`python3 scripts/tests/fleet-stability-cleanup.test.py` drives the actual proof
entry point in a private Git fixture, with external fleet/recovery commands
and private resource ledgers. The fixture launches real local processes and
uses the repository's actual tracked-session helper. It makes no Fly, browser,
or model calls.

The first four permanent cases failed against the original proof controller:
normal failure, evidence-wrapper exit 70, failed recovery, and SIGTERM all
reached the assertion that the exact owner's cleanup must be invoked. The
valid before log is
`.context/acceptance/proof12-cleanup-independent-review/permanent-before-valid.log`.
Two earlier fixture attempts lacked a valid Polar catalog shard and are not
causal evidence. The same four cases passed after the supervisor change in
`permanent-after-first.log`; subsequent cases cover descendants, malformed
group identity, false recovery acknowledgement, dangling audit links,
incomplete terminal audit metadata, transient process-inspection failure, and
failed slice/summary log consumers.

The fake recovery command checks that the fleet producer is gone, that the
supervisor has positively recorded process-group drain, and that proof
finalization has not occurred. It then removes only the exact owner's private
ledger and writes its bound terminal audit. Tests assert unchanged unrelated
ownership, no next slice, zero acceptance credit, original failure, and a
truthful retained state when recovery fails. These prove the controller
ownership mechanism, not any individual benchmark's business outcome.

## Solution

The canonical proof creates a durable per-slice cleanup obligation before
launch. Each fleet/evidence command runs beneath the existing birth-identified
session leader. Its log is streamed from a durable file, so a pipe consumer
never becomes the resource owner. The existing waiter proves the owned group
drained, including surviving descendants, before recovery can run.

After ordinary completion as well as cancellation, the supervisor discharges
that exact owner through `run-bench-fleet --recover-stale-owner`. It uses the
canonical recovery entry point rather than the optional evidence wrapper.
The proof preserves the original failed classification and aborts the
remaining slices. Successful recovery changes cleanup status, not acceptance.

The outer proof now forwards cooperative signals to the exact waiter instead
of deferring them behind a foreground pipeline. That waiter retains its
existing cancellation and drain bounds. Further cancellation does not kill a
provider-recovery process that has taken ownership of cleanup. An unproven
process identity cannot authorize provider recovery.

Cleanup success requires registry retirement and the terminal audit's exact
owner, workspace, run, and app metadata, plus equality of the shared audit and
its run-local mirror under the existing source/digest binding. A dangling
link, two-field terminal marker, changed audit, or successful recovery exit
with a retained registry cannot produce a verified receipt. Failed recovery
retains ownership and reports `failed_retained`. Per-slice cleanup receipts
are linked from the atomically replaced canonical summary.

Adversarial review found that the initial audit shortcut accepted a dangling
link and a two-field terminal meta. Both permanent cases failed against the
saved first candidate (`audit-shortcut-before.log`) and passed with complete
audit binding. A targeted external `ps` fault also reproduced the draft
observer's incorrect treatment of unknown process state as absence
(`unknown-probe-before.log`); the unchanged test passes after distinguishing
those states. The failed-summary-logger test found cleanup succeeded but a
failing diagnostic write under `set -e` prevented final status publication;
`log-fault-after.log` records that failure and `log-fault-fixed.log` records
the unchanged passing pair. Log failure stays separate from original fleet
exit and cannot prevent cleanup or status publication.

The log relay receives completion through an anonymous pipe rather than a
new file, so ENOSPC cannot leave it waiting for an unwritable completion
marker. This adds no timeout. The regression is registered in
`fleet-infra-stability-proof.test.sh`, an existing mandatory deploy command.
A further independent fault rejected all body/waiter identity records and the
terminal exit-file write. Although fleet recovery and summary finalization
finished, the outer supervisor remained alive because it still polled those
missing files. The permanent case failed before the fix and passed unchanged
after completion moved to an anonymous pipe with EOF plus an actual pipeline
wait. A terminal frame alone cannot release the supervisor while its body or
logger remains live; rejected frame publication falls back to the reaped
pipeline's failure. Optional diagnostic files no longer control liveness.

The same review found `SKIPPED` task results counted toward a capability slice.
The unchanged actual-controller regression failed before and passed after the
classifier required actual `PASSED`/`FAILED` execution. Both causal results are
in `independent-edge-permanent-before.log` and
`independent-edge-permanent-after.log`. The former body-process-probe case now
asserts cancellation completes without that obsolete observer dependency.
The final focused suite has fourteen cases (`focused-edge-final.log`).
The enclosing suite and final source hashes are recorded in the private
implementation receipt. Normal execution remains 7200 seconds; this proof override remains
300 seconds. No readiness, recording, process, provider, or controller bound
was increased. No global pruning or resource inference from shared-account
inventory was added.

### September 11 completion-reader recurrence

The concurrent structural gate on `eceab00833` retained a simulated successful
2/2 proof and `controller.exit` containing zero, followed by the outer
supervisor returning one with `proof supervisor exited without a terminal
status`. Evidence is in `.context/test-runs/fleet-proof-20260911T183311Z-4687/`
and `.context/acceptance/recovered-final-static.log`. The terminal read bytes
were not captured during that occurrence, so its precise trigger remains open.

The owning completion protocol had a separately reproduced defect: Bash timed
reads can consume partial bytes before returning timeout/signal status. The
loop discarded those bytes. Two permanent actual-entrypoint tests consume the
first byte from the actual producer frame using `builtin read -N 1`, then
return 142 at the read-result boundary. They do not alter the producer frame.
Before the repair, success zero became failure one, and failure 137 became 37.
Both tests failed in `proof-completion-rca/permanent-before.log` and passed
unchanged in `permanent-after.log`. Three independently traced natural
full-entrypoint runs passed without partial reads; those results do not prove
the intermittent occurrence's cause.

The reader now consumes at most four characters per read, retains at most three
completion characters across interrupted reads, and parses only a complete delimited
frame. It rejects incomplete EOF,
duplicate frames, invalid characters, oversized frames and values above 255.
It continues through EOF and waits for the pipeline even after invalid input;
a status frame never permits abandoning the body or logger. This repairs the
protocol boundary without adding a timeout, changing task outcomes or relying
on an optional disk marker. Memory and work remain bounded per proof, with no
shared state or cross-agent contention at 10,000 agents. Independent review
also reproduced a 4,096-character read before the per-read bound. The permanent
oversized-frame test now observes actual read-result lengths: it failed against
the saved pre-bound controller and passed unchanged after `read -n 4`, while
still rejecting the frame (`read-bound-before.log`, `read-bound-after.log`).
Deleting the pipe would
restore the earlier unwritable-status-file hang; unifying partial reads into
one bounded logical frame repairs both success and multi-digit failures.

### September 11 pre-allocation visibility recurrence

Proof 13 (`capability-stability-20260911201448-35774`, HEAD `cf288dd2`)
stopped with zero accepted slices after the Hub uploader imported the wrong
Python environment. Its audit had already been published, but both visibility
calls preceded the full cleanup trap and `fleet_registry_init`. Thus the failing
import left an incomplete audit without any registry. The supervisor did drain
its exact child group and invoke recovery, but recovery correctly rejected
missing controller authority. The registry had never existed; this was not the
concurrent-retirement race documented in the September 9 case.

Searches used `non-regular exact recovery identity` and
`fleet registry disappeared after startup failure`. The earlier supervisor fix
did not cover errors before its child published recoverable controller authority.
This recurrence identifies a lifecycle ordering gap, distinct from guest cleanup.
The path was project interpreter selection -> Hub import -> early shell exit ->
snapshot-only cleanup -> incomplete audit -> rejected exact recovery.

The permanent `cloudbench-multi-workstream.test.sh` startup contract uses the
real controller and uploader with a deterministic missing-module error in the
scratch `logs.py`. It asserts a nonzero workload exit, no machine or volume
mutation, unchanged unrelated ownership, retired registry (including no dangling
link), terminal audit plus immutable run-local mirror, failed lifecycle, and the
intentionally retained exact Hub identity. The unchanged final test fails before
and passes after the fix in
`.context/acceptance/fleet-startup-rca/permanent-final-red-green.json`.
Its quick selector is `CLOUDBENCH_TEST_STARTUP_FAILURE_ONLY=1`; the contract also
runs unconditionally in the existing full deploy controller gate.

Both visibility gates now run after cleanup installation, registry publication,
and cleanup reserve allocation, still before pool reconciliation or provider
allocation. Reordering existing lifecycle steps removes the observed gap without
adding recovery shortcuts, changing timeout policy, or broadening provider
mutation authority. Work remains once per controller, with no per-agent hot-path
or shared coordination added at 10,000 agents.

The historical proof remains failed. Its original incomplete audit is preserved,
and `.context/acceptance/proof13-preallocation-containment.json` separately binds
the drained supervisor receipt, absence of its exact processes, empty allocation
records, and the Hub's immutable exact-owner terminal receipt. The Hub was retired
through `cloudbench_terminate_central_hub_owner`. No registry or terminal provider
audit was synthesized from absence: the old audit lacks original controller
host/birth authority. These records contain the failed attempt; they provide no
acceptance credit and do not establish a passing live after-proof.

### September 27 publication-fault fixture collision

The final controller on `9f3266b6` failed
`test_failed_local_status_publication_does_not_wait_forever`: zero recovery
calls instead of one, followed by `FATAL: detached terminal status arrived
after its identity anchor vanished with an unproven group`. The environment
test passed, and the failing owner was truthfully retained with zero credit.
The original fixture and native exit remain in
`.context/test-runs/fleet-proof-test_failed_local_status_publication_does_not_wait_forever-jk0tx9bo`
and `.context/acceptance/proof21-r2-final-controller.log` on the owned Linux host.

This was a defect in this case's publication-fault regression, not a demonstrated
runtime ownership failure. Searches used the exact fatal message and
`status publication printf failure detached group identity cleanup`; this case
owned the original test. The injected shell function rejected every
`printf '%s\n'`, including the existing native birth normalization in
`cloudbench_pid_birth_state`. A successful `ps` timestamp became empty and then
`unknown`; the waiter correctly refused recovery without proof of ownership.
After-the-fact PID absence does not establish its state at the failed probe.
The unchanged single test failed in 0.554 seconds; a traced copy then captured
the real timestamp being rejected from the birth-state caller immediately
before the fatal message. The shared normalizer predates the fault fixture,
so this is a latent test collision exposed by scheduling rather than a new
production regression.

Only `scripts/tests/fleet-stability-cleanup.test.py` changes. The injected fault
now targets the explicit body/waiter publication caller and format pairs.
It still rejects body/waiter identity records and both terminal completion
writes, while ordinary process observation uses the real builtin `printf`.
A new deterministic control asserts that the same injected fixture still reads
its live native identity as `live`. The original cleanup, unrelated-owner,
failed classification, zero-credit and five-second completion assertions are
unchanged. Added checks require the actual `controller.owner` and
`controller.exit` files to exist and remain empty, proving the intended write
failure was not bypassed. Narrowing the fault at its producer removes the
collision; weakening the runtime's unknown-identity guard would be incorrect.

Private evidence is in `.context/acceptance/proof21-publication-cleanup-rca/`.
`unchanged.json` preserves the original failing method; `traced.json` contains
the rejected birth-normalization call. The same two permanent assertions in
`promoted-before.json` fail under the original injection, then pass under the
scoped injection in `candidate-after.json`. The readable final source is
AST-equivalent; `final-after.json` pins its exact test SHA256
`9e0135152bcfb559bf9b5599b342f1945eb9caeb5729c1ad901a80b02f3714b0`
and records two passes in 1.268 seconds with native exit 0. Executed private
payload hashes are distinct from the unchanged remote checkout's source hashes.
The command selects `FleetFailureCleanup.test_local_status_publication_fault_preserves_live_identity`
and `FleetFailureCleanup.test_failed_local_status_publication_does_not_wait_forever`
from `python3 scripts/tests/fleet-stability-cleanup.test.py` through the existing
owning fixture. The existing full controller continues to discover the module.
The original failed controller remains failed; the final whole controller on
the next committed head and the 100-run proof remain pending. No production
source, benchmark task, evaluator, model, prompt or timeout changes.

### October 1 padded native birth recurrence

The canonical 32-way structural gate on `442f4b18` failed both cancellation
controls at their unchanged 15-second cleanup limits. Retained fixtures had a
live-producer readiness record, pending cleanup, no recovery call, and no
forwarded-signal event. Their waiter births contained BSD `ps`'s single-digit
day padding (`Thu Oct  1`), while the existing birth-state reader canonicalized
interior whitespace (`Thu Oct 1`). The proof's two owner-record producers only
trimmed the edges. Consequently the exact live waiter was reported absent and
cooperative cancellation never reached its owned fleet group.

Archive searches used `PID birth timestamp whitespace single digit day
cancellation` and `cloudbench_pid_start_time lstart normalization waiter`.
The September 11 Hub birth-rejection case concerns a genuinely changed birth
after host suspension; this recurrence changes only the formatting of the same
native timestamp. A captured live child returned `absent` with its unnormalized
birth and `live` with the canonical representation. Both original failing tests
then reproduced unchanged in isolation in 31.360 seconds, excluding concurrent
structural scheduling as a necessary trigger for this boundary.

Both proof owner records now use the existing `cloudbench_pid_start_time`
producer, matching the reader and detached session owner. The permanent owning
fixture adds one cancellation variant that pads the day field without changing
any native birth value, so double-digit dates still exercise the defect. Its
failure cleanup compares the same canonical birth on both sides before signaling
its exact fixture-owned process; it does not adopt an unknown or changed PID.
The unchanged new case failed against the original runtime in 15.363 seconds;
the same case and both original cancellation controls passed in 8.437 seconds.
All producer-drain, exact recovery, unrelated-owner, failed-classification,
zero-credit and timeout assertions remain intact. No live provider was called.

Private evidence and immutable source/test hashes are in
`.context/acceptance/proof85-structural-failure-rca/`, including the original
structural output, retained native owner records, `single-digit-live-birth-boundary.private.json`,
and `padded-owning-red.receipt.private.json` plus the final unchanged
`padded-owning-final-green.receipt.private.json`. Independent parent review
confirmed the producer/reader contract and the nonempty exact-identity guard
before fixture cleanup signals. The final enclosing structural gate remains
required. The two other structural
readiness failures have separate unchanged passes and an unproven original
trigger, documented in the related semantic-deploy evidence case; this repair
does not claim to explain them or provide cloud acceptance credit.

## Verification limits

The local owning-boundary before/after regression passes. The failed live
owner was separately recovered; that is not a live after-proof of this code.
The replacement cloud proof and any exact benchmark outcome gates remain
open, so this case remains open. A permanent provider outage can still prevent
positive teardown proof; the supervisor must retain exact authority and say
so rather than report completion or depend silently on another chat turn.

The user's acceptance is ten consecutive sequential slices of ten actual
tasks, with zero infrastructure outcomes and required evidence/teardown.
Ordinary `PASSED` or `FAILED` business outcomes count; `SKIPPED` does not.
All 100 business/evaluator outcomes need not pass under the temporary cap.

## Human feedback

Do not stop at a retained registry and wait for another conversation turn to
perform cleanup. Supervise the exact owner through the existing recovery
boundary. Preserve original failure and zero credit, exact process identity,
and unrelated owners. Do not relax timeouts or substitute provider deletion
for missing guest/browser cleanup evidence.

## Reusable lesson

Every proof failure path must preserve an active exact cleanup obligation or
an explicit failed-retained receipt. A workload exit, evidence publication
failure, or signal is not resource teardown. Tests must observe the external
resource ledger and process boundary before final status; merely asserting
that a cleanup callback exists would miss this failure.

### November 3 native delimiter-timeout completion recurrence

The retained full structural invocation at `fb4fef6ac50a29afd06520d398f6b9c725925313`
failed its existing optional-artifact fixture after canonical body success,
verified cleanup and `controller.exit` bytes `30 0a`. Its parent emitted
`proof supervisor exited without a terminal status`. The original packet is
retained privately on the independent repair devbox with SHA256
`9f7b450c34002cde4f0855296fd7cf17ac3507477f887134c65dc2675e67f060`.
Historical anonymous-pipe bytes and read-return values were not captured;
that occurrence's exact protocol trigger remains **UNKNOWN**. Neither an
unchanged focused pass nor an assumed absent/empty file identifies it.
The inherited `Gate: NOT_INTRODUCED` compares `9e25b6e006b9fd7f3f2d64b24f2d44a81772ece0`
to the failed source and establishes introduction only; the assigned repair
remained owned through validation and deployment.

Archive searches used the literal terminal-status error and `controller
completion anonymous pipe read`. This is an uncovered sibling of the earlier
completion-reader repair, separate from optional artifact setup/tee coupling.
The critical path is body EXIT publication -> anonymous pipe -> timed Bash
read -> frame validation -> EOF -> pipeline wait -> supervisor exit.

A native Linux x86_64 syscall scheduler demonstrated the remaining defect.
It traces only a newly launched fixture root, never forked children or an
existing process. After the kernel returns the real newline byte, it leaves
the root descheduled for 0.15 seconds. The original `read -n 4 -t .1`
then returns 142 with only the digits: it consumed and stripped the delimiter
before its deadline expired. The parser inferred delimiters from return zero,
so the next EOF rejected those digits as incomplete. No pipe byte, read return
or producer status is synthesized. A no-hold control passes. This proves a
native reachable defect at the owning boundary; it does not reconstruct the
historical schedule.

The permanent existing-suite command is `python3
scripts/tests/fleet-stability-cleanup.test.py
FleetFailureCleanup.test_native_delimiter_control_preserves_optional_artifact_success
FleetFailureCleanup.test_native_delimiter_timeout_preserves_optional_artifact_success
FleetFailureCleanup.test_native_delimiter_timeout_preserves_original_failure`.
Before production edits, the control passed and the two delayed cases failed
(three tests, 3.334 seconds): success zero became one, and original failure
137 became one. The same command and test assertions passed after the repair
(three tests, 3.185 seconds). Private logs are `permanent-native-before.log`
and `permanent-native-after.log` under `.context/fleet-completion-repair/`.
The success case uses the unchanged existing fake fleet and an unavailable
optional artifact directory; it checks canonical success, verified cleanup
and body zero. The failure case preserves the original exact-owner recovery,
no-next-slice, zero-acceptance and unrelated-owner assertions. These are native
Bash controls, not live-provider outcome evidence. The native syscall schedule
is explicitly Linux x86_64; inability to trace an owned child there fails,
while other platforms retain every existing portable control.

The repair unifies framing on actual wire bytes: bounded `read -N 1` retains
newline even when the native read returns 142. The parser examines that byte
independently of the read status and clears its destination before each read.
It retains the original 0.1-second wake interval, three-digit/range limit,
single-frame contract, malformed/duplicate/unterminated rejection, EOF drain,
cancellation forwarding and actual pipeline wait. It never infers success
from an optional file, a summary or a successful logger. The earlier test shim
consumed only a digit and left newline unread, so it did not cover this case.
Deleting delimiter inference reduces competing state; deleting the completion
pipe would restore the documented unwritable-status-file liveness defect.
Memory stays constant per proof, with at most three retained digits and one
read byte; there is no shared lock, fleet-wide scan or agent-count fan-in at
10,000 agents. Golden reference: not applicable (ordinary Bash infrastructure
framing; no approval-gated agent behavior, prompt, schema or timeout hunk).

Independent adversarial review also found an ownership gap in the new test-only
scheduler: an exec-stop consumed by ordinary `Popen.poll` could look terminal,
and a fallible pre-wait metadata write or detach error could abandon the traced
root or replace the initiating exception. Two permanent native controls failed
on that helper (two failures, 1.010 seconds): an actually unreaped root and a
replaced scheduler exception. The revised helper binds terminal-only poll/wait
before returning the new child, retains tracing through exact-owned teardown,
and records only real terminal wait statuses. It also caches an initial
terminal observation; the error-control finalizer checks actual child wait
ownership before any signal. No timeout or normal proof semantics changed.
The same two controls plus an initial-terminal control passed (three tests,
1.065 seconds). The complete owning suite passed all 33 tests in 35.014 seconds;
all 27 original test names and assertion expressions remain identical. The six
native controls are repeated unchanged for the final snapshot. These controls
cover new fixture support, not a claim that the historical frame is known.

The native regression remains inside `fleet-stability-cleanup.test.py`, already
called by the unchanged `fleet-infra-stability-proof.test.sh`, unchanged
`descend-command.test.sh`, and the complete canonical structural registry.
The original full command remains `python3 scripts/run-deploy-structural-gates.py
--max-workers 5`, with `TMPDIR=/var/tmp` and the managed venv. A fresh pre-repair
full invocation on current main passed all 85 gates; that supporting control is
not a repair claim. Final full-command and deployment receipts are retained in
the repair's private deploy report. Original catalogs, assertions, task bounds
and timeouts are preserved. The historical trigger remains UNKNOWN even when
the demonstrated completion defect and final acceptance gates pass.

Human feedback for this recurrence: preserve original bytes/hashes and the exact
full command; keep historical pipe/read causality UNKNOWN; do not waive or
re-delegate the assigned failure; complete the independent repair's deployment.
