---
id: 2026-09-30-benchmark-judge-wait-blocked-behind-controller-regressions
date: 2026-09-30
title: Serial controller regressions exhausted the benchmark domain before its live judges
surface: harness
component: agents-benchmark-blackbox-registration
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: benchmark run_all_tests synchronously completed all native controller groups before starting the first Blue Bottle judge
symptoms:
  - "benchmark domain exceeded its unchanged 300-second bound"
  - "first live judge transport began near the domain cutoff"
  - "unchanged prelude alone took 248.294 seconds without model calls"
tags:
  - benchmark
  - coverage
  - scheduling
  - controller
  - live-judge
sources:
  - commit 9d44d054cae4ed89eea11c6a469697a881583683
repro: agents/tests/blackbox/benchmark.blackbox.py::run_all_tests
status: fixed
---

## Problem

The canonical agents coverage lane failed the benchmark domain at 300.02 seconds;
the aggregate exited after 330.805 seconds with 100 passing and three failing
domains. The browser dependency and cooldown-control failures have separate
owners. The benchmark log reached the first Blue Bottle fixture's model transport
near its cutoff. This was not evidence of an idle or sustained-generation model
deadline. Original results, native owner identities, and logs remain private and
unchanged; the failed aggregate receives no passing coverage credit.

## Diagnosis

Two archive searches covered benchmark/controller timeout and coverage incidents,
then Blue Bottle judge, fixture scheduling, and registration incidents. The
scheduler-window incident from 2026-08-03 and the Blue Bottle payment-boundary
incident from 2026-08-29 were relevant guidance, but neither established this
registration bottleneck. The preceding trace-admission repair had passed the
benchmark domain in 268.67 seconds under the same 300-second bound.

An instrumented unchanged registration stopped at the first real judge function
before authentication or model calls. That boundary took 248.294 seconds. Its
largest native groups were terminal runtime/evidence (51.524 seconds), dependency
rebuild (34.129), Fly completion (30.073), autoscaler handoff (27.471), boot payload
(27.177), and bundled frontend prerequisites (20.608). This diagnostic earns zero
acceptance credit. Its timings establish the additive serial prelude; different
host load and the separately repaired dependency environment prevent attributing
the complete gate-time difference exclusively to this change.

## Solution

Thirteen isolated native checks used synchronous subprocess waits on the async
registration loop. Only after that chain and many further cases did the four
existing sequential Blue Bottle judges begin. The loaded prelude could consume
the entire domain budget before the required judge I/O progressed.

One scheduling boundary keeps every native check strictly sequential in a worker
thread while the same four judges run sequentially on the main event loop. Each
native function, command, assertion, registration name, and judge body is
preserved. Native outcomes are recorded after all four judges finish so capture
resets remain on the main loop and cannot erase active judge capture state.
Cancellation fences subsequent native groups, drains the active check, and
propagates the original cancellation, including repeated cancellation. No native
controller concurrency, model call, evaluator, task, model, or timeout is added.

## Permanent owning regression

The one permanent control drives actual run_all_tests registrations with bounded
barrier cases and sentinels for unrelated cases. It proves all thirteen native
and four judge invocations, serial native order, judge progress during the native
wait, original failure names/counts, rejection of an unexecuted coroutine, main
loop capture recording, and cancellation fencing/drain. It makes no model calls.

The identical final control, compiled into the actual unchanged baseline module,
failed in 2.111 seconds with "native wait finished before the judge progressed".
The candidate's actual registrations passed it in 0.067 seconds. This red result
uses the baseline registration, not a missing helper or an invented scheduler.
AST comparison preserves every native and judge body. The only other existing
test body changed is the later database-platform fixture described below.

## Review and outcome

Independent pre-implementation and implementation review found no parent-global
environment, cwd, or HTTP-mock mutation in the thirteen subprocess-only wrappers.
The complete existing instrumented benchmark domain finished in 246.097 seconds
under its unchanged 300-second bound; all four moved judge assertions passed.
The aggregate stayed failed because a later database-platform fixture manually
constructed ServiceStack after incoming main moved platform selection into
build_service_stack. That fixture had not been reached before the original
cutoff. Its same five platform/env expectations and original launch assertions
now exercise build_service_stack followed by start_services, with port/context
allocation mocked and the selected database mode asserted before launch. The
unchanged production path failed the old fixture and passed the corrected one;
no production database selection changed. Original failures remain retained.

The final canonical agents coverage lane passed in 339.465 seconds: all 103
blackbox domains passed with four workers, including the benchmark domain in
268.009 seconds under its unchanged 300-second cutoff. The subsequent fast-cache
suite passed all 162 tests in 5.53 seconds, and the unit suite passed all 102
tests in 39.20 seconds. The real combined coverage report met the original 80%
threshold. All 934 tracked agents/scripts input hashes remained unchanged; the
exact native wrapper and stage process were verified absent after completion.
The final proof retains the original failed aggregate and both causal controls.
No partial result is promoted into an aggregate pass, and none of this offline
evidence supplies fleet credit.

## October 1 recurrence: native groups still serialized

The integrated main tree again exceeded the unchanged 300-second domain bound.
The original 103 passing domains were retained; the failed benchmark domain was
replayed alone. Its local-world isolation fixture was corrected separately. A
private per-case observation of the same registered runner then timed out at
300.038 seconds: all four real judges passed by 60.417 seconds, while the native
terminal-evidence group did not start until 282.532 seconds. Earlier native
checks consumed 5.363 seconds (Prisma), 42.864 (boot payload), 26.673 (bundled
frontend), 46.480 (dependencies), 46.686 (private fleet source), 32.825 (Fly
completion), and 32.305 (autoscaler). There was no terminal model failure.

Archive searches used “benchmark domain exceeded 300 seconds” and “controller
native subprocess judge wait registration”. This is a recurrence: overlapping
judges removed their additive wait, but the previous fix still serialized all
thirteen independent native subprocess groups. The guard proved judge overlap;
it did not prevent the native queue from again exhausting the same whole-domain
budget. Increasing that budget would hide the unbounded additive scheduling cost.

The existing helper now admits at most two native subprocess groups. Admission
and result indexing stay on the main event loop; results are published in their
registration order after judges finish. Cancellation closes admission and joins
both active lanes, including repeated cancellation. The native groups preserve
their target assertions and use isolated subprocess environments and
private temporary fixtures. No task, prompt, model, evaluator, model-call count,
production worker concurrency, or timeout changes. This affects only offline
verification scheduling and adds no production work at 10,000 agents.

The same existing owning control now asserts two simultaneous owned lanes,
exactly-once invocation, registration-order reporting, coroutine rejection,
main-thread capture resets, and cancellation of two active lanes before a third
queued case. The final unchanged control failed against the original serial
helper in 6.178 seconds and passed against the bounded helper in 1.366 seconds.
The first real bounded-domain replay finished in 227.690 seconds but failed the
terminal-evidence group's existing 60-second timeout. A focused observation of
its unchanged eight targets established another additive queue: the first
27 fault arms consumed 45.739 seconds, and 52 cases passed before the remaining
targets could finish. The original fixture timeouts and assertions were sound.
Archive searches covered terminal-evidence subprocess timeouts and exited-parent
process-group cleanup; the complete-log and terminal-zombie cases informed the
ownership checks without replacing this runtime reproduction.

The same eight targets now use two isolated pytest children under one shared
60-second deadline. File-backed output avoids pipe backpressure. Independent
review caught an exited leader leaving inherited descendants in the first draft.
The unchanged real-native control failed that draft in 0.690 seconds and passed
the correction in 5.114 seconds, including a TERM-ignoring descendant and a real
child exit 7. The wrapper retains unreaped leaders to pin their process groups,
observes state without reaping, drains the exact groups with bounded TERM/KILL,
then joins the leaders and requires both successful results. The existing
registered ownership control includes that small real-native failure/descendant
case and rejects an unobservable live identity instead of treating it as absence.

The canonical benchmark domain passed in 238.293 seconds. Combined with the
103 retained passing domains, the original remaining coverage steps passed:
162 fast-cache tests, 109 unit tests, and 81% total coverage against the unchanged
80% threshold. That execution retained all 947 input hashes. The final cleanup
amendment was verified separately: the existing owning control passed in 3.567
seconds and all eight real fixture targets passed in 40.561 seconds under the
same shared 60-second limit. Independent AST review preserved the other 480
definitions and the exact eight targets, so their earlier passing checks were
retained rather than replaying unrelated model calls. Original failures and
intermediate receipts remain private; none of this evidence supplies fleet credit.

## October 6 recurrence: fixture commits signed by the host

A branch merge with main added the eleven remaining native gate groups to
this domain. A 4-core Cursor Cloud deploy then failed it again at 300.02
seconds, while static, backend, and frontend lanes shared the host (load
average 17). Replayed alone on the idle host, the domain passed in 186
seconds. Serially, its thirteen native groups took 197.3 seconds of mostly
sleeping wall time; one group used 1.17 s of CPU over 34.72 s.

One stall was not the code under test. Throwaway fixture repositories
inherited the host's global `commit.gpgsign=true` and its remote ssh
signer, and individual signatures stalled for 10+ seconds; see
`2026-10-06-fixture-git-commits-inherited-host-signing-helper`. With signing
disabled for test processes, the next canonical lane passed the domain in
205.03 seconds under the unchanged 300-second bound. The two-lane bound,
assertions, and timeouts are unchanged.

## Human feedback

The user required compact, robust runner tests without massive additional
verification. The repair adds one fast owning control, preserves the existing
controller target assertions and model calls, and leaves the 300-second domain bound
unchanged. After the actual later fixture failure, the required final combined
agents gate supplies the complete replay instead of a second standalone domain.
The October 1 clarification keeps the full 100-task cloud acceptance gate while
avoiding unnecessary resets and repetition of unaffected checks. Documentation
and test-only edits require an explicit unchanged-runtime comparison; actual
infrastructure failures still invalidate the streak.

## Reusable lesson

Keep isolated subprocess waits from serializing unrelated required network I/O.
Preserve ownership, exact assertions, and cancellation drain when changing test
scheduling; a faster partial or simulated run cannot replace the real gate.
