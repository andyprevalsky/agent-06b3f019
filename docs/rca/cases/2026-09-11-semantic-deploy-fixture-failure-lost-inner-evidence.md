---
id: 2026-09-11-semantic-deploy-fixture-failure-lost-inner-evidence
date: 2026-09-11
title: Semantic deploy structural failure lost the inner fleet fixture evidence
surface: harness
component: fleet-infra-stability-proof-structural-test
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: the agent-status fleet fixture returned nonzero but its inner log and cleanup receipts were deleted
symptoms:
  - evaluated agent lifecycle states were classified as infrastructure
  - semantic-deploy fails in the concurrent structural gate while the isolated enclosing fixture passes
tags:
  - semantic-deploy
  - fleet-proof
  - fixture
  - observability
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: open
---

## Problem

The full parallel structural gate's semantic-deploy entry exited 1 after
13.45 seconds. Its final message was `evaluated agent lifecycle states were
classified as infrastructure`. The wrapper reaches
`descend-command.test.sh`, which invokes the enclosing fleet proof test.
That test redirected this fixture's command into `agent-status.log` and
deleted the entire temporary directory on EXIT. The main retained gate log
therefore contains the assertion description, not the underlying failure.

## Diagnosis

The fixture supplies PASSED/FAILED evaluator outcomes and separate ACTIVE/PAUSED
agent lifecycle states. It does not supply SKIPPED. The assertion could fail
because the child command returned nonzero at several boundaries; its wording
alone does not establish a classification defect.

The unchanged enclosing native fleet proof fixture passed, including all 14
cleanup tests, after adding failure retention. This isolated pass excludes a
deterministic reproduction in that attempt. It does not establish why the
concurrent gate failed. No original inner command log, summary or cleanup audit
survived to locate that boundary.

Archive searches used `evaluated agent lifecycle states classified
infrastructure semantic deploy fixture` and `worktree service port still
occupied lsof kill-services`. The adjacent port assertion and orphan fixture
defects have separate reproductions; neither proves the cause of this failure.
The remaining requirement is a recurrence under the owning concurrent gate
with its inner fixture evidence retained.

Original output is retained at
`.context/acceptance/archive-batch-static.log`; the isolated pass is at
`.context/acceptance/static-gate-followup-rca/fleet-proof-unchanged-native.log`.
No further runtime repair is supported by this evidence.

## Solution

Retain the failing fleet fixture's temporary directory beneath
`BLACKBOX_TEST_ARTIFACT_DIR`, falling back to `.context/test-runs`, before
cleanup. Use a private suite/timestamp/PID directory, make capture best effort
and preserve the original failing exit status. The next committed enclosing
parallel static gate is the outcome check. Classification behavior, SKIPPED
rejection, task criteria and timeouts are unchanged.

## Retained recurrence on September 11

The new capture worked during the `eceab00833` full concurrent structural gate.
The capability-pass fixture retained summary `passed`, two accepted simulated
slices, verified cleanup and `controller.exit` zero; its outer supervisor
returned one with a missing terminal-status error. See
`.context/test-runs/fleet-proof-20260911T183311Z-4687/capability-pass/`.
This locates the recurrence after successful slice classification and teardown.

A deterministic partial-read defect at that completion boundary was reproduced
and repaired in the related case
`2026-09-11-failed-stability-proof-abandoned-retained-fleet`. Raw reads were not
captured in the failed concurrent occurrence, and three traced natural replays
passed. This case remains open for that unproven intermittent trigger; the
partial-read fault injection is not misrepresented as its captured cause.

## September 12 nested unittest recurrence

The concurrent gate on `9297fc6d3` failed
`FleetFailureCleanup.test_interrupted_completion_read_preserves_success` at
`subprocess.run(..., timeout=8)`. The enclosing shell fixture was retained, but
the nested unittest registered unconditional `TemporaryDirectory.cleanup` and
removed its command output and lifecycle state. The original execution phase
therefore remains unknown. An unchanged isolated replay passed in 0.725 seconds;
high host load was observed but does not prove the trigger. Archive searches
used `interrupted_completion_read_preserves_success timeout` and
`fleet fixture timeout host load evidence deleted`. The July 13 host-load case
is a lead, not a diagnosis of this occurrence.

Two permanent controls reproduce the newly confirmed boundaries: a failed inner
unittest loses its evidence, and a timed-out process leaves its detached child
live after `subprocess.run` kills only the direct child. Both failed before the
fixture correction (`containment-before.log`). The runner now streams combined
output to `output.log`, records command/exit metadata, retains failed scratch
under `BLACKBOX_TEST_ARTIFACT_DIR` or `.context/test-runs`, and uses native birth
identity plus captured ancestry for bounded local fixture cleanup. Its execution
deadline remains eight seconds. A failure to inspect ancestry is retained as a
cleanup failure; an already-exited root is explicitly unverified, never a
positive descendant-cleanup receipt. The still-owned `Popen` root is joined even
when inspection fails. Metadata capture cannot replace the original timeout.

The native cleanup implementation is shared with the existing boot fixtures,
whose detached-child and reused-identity negative controls remain in the owning
benchmark suite. This is test-only work with no runtime or 10,000-agent hot-path
cost. Evidence and independent review are under
`.context/acceptance/static-completion-timeout-rca/`. The original intermittent
completion timeout remains open until captured evidence locates its first bad
boundary; containment and retention tests supply no cloud acceptance credit.

## October 1 concurrent readiness observations

The canonical default 32-way structural run on `442f4b18` preserved 29 passes
and three failed gates. The nested fleet cancellation failures have retained
owner records and a reproduced native-birth formatting cause in the related
`2026-09-11-failed-stability-proof-abandoned-retained-fleet` case. Two separate
failures remain unclassified: the structural runner's five-second first-child
readiness assertion and setup-db's seed-readiness loop. Setup A's retained
output reaches the stubbed Prisma schema push; its temporary event ledger was
deleted by the fixture. The runner assertion does not retain its child's output
when readiness fails. Neither original capture locates the intervening delay.

Archive searches used `first gate did not start seed invocation cleanup
deadline` and `structural runner concurrency wall clock fixture readiness`.
Identical isolated replays passed without source or limit changes: the runner
signal control in 1.214 seconds and the complete setup concurrency fixture in
16.362 seconds. High host load observed afterward and the original 32-way
scheduling are leads, not causal proof. No source repair or timeout increase is
justified for these two failures by the current evidence. The supported
`--max-workers 4` setting can obtain an operational aggregate result with the
same checks; a pass would not retroactively explain or erase these failures.

Original logs, hashes, native owner metadata and replay receipts are retained
under `.context/acceptance/proof85-structural-failure-rca/`. The original failed
run stays failed, and these isolated checks supply no cloud proof credit.

## Human feedback

The deploy instructions require preserving the existing acceptance criteria.
Review explicitly rejected inferring a SKIPPED-related defect from the generic
assertion message or treating an isolated pass as proof of the original cause.

## Reusable lesson

Retain the failing child command's logs and lifecycle receipts before assigning a cause from its wrapper assertion.


## October 5 captured completion-boundary recurrence

The clean eight-lane canonical gate on `7695d9b` retained 39 passing suites and
two failed enclosing suites. Their preserved success fixtures both returned
zero, with passed summaries, one accepted slice, and verified cleanup. Neither
produced `fixture consumed completion byte: 0`: the injected read armed its
one-shot flag before its five-second read consumed a byte. A timed-out first
attempt disabled all later injection. This is a newly confirmed fixture cause,
not evidence that production lost completion bytes or teardown failed.

The same descend run also retained duplicate-frame and SKIPPED-task controls
that genuinely exceeded their eight-second outer completion guard. The fixture
now records a sixty-second host guard, including its final join; duplicate-frame,
SKIPPED-credit, terminal-state, and exact cleanup assertions remain intact.
The injection now arms only after actual byte consumption. One compact Bash
control forces timeout/no-byte followed by byte consumption; it must retain the
second injected interruption and marker. This unchanged control rejects the
original injector before the repair and passes afterward. It runs inside the
existing registered suite, without provider calls or new verification stages.

The original September intermittent cause remains open. One current rejected
fixture had `unverified-root-exited` containment, which is preserved as unknown
rather than promoted to a cleanup pass. The separately handled missing canary
helper warning does not establish either failed assertion's cause. Runtime
inputs and completed 100/50-task fleet proofs are unchanged. Originals and
independent review are private under
`.context/deploy-runs/pr1410-finalize-20261005/`.


A subsequent direct diagnostic suite retained one cancellation/body-probe
failure after 412.315 seconds overall. The slice had published exit 143, but
its canonical receipt remained pending and recovery had not run before fixture
containment. Later native inspection found all four recorded owners absent and
the recorded group empty; this does not create a canonical cleanup receipt.
The precise cancellation delay remains open. Both unchanged enclosing deploy
suites independently passed all 27 current cleanup controls in 87.574 and
112.148 seconds. The successful scopes compose with the 39 unchanged aggregate
passes; the original aggregate exit-one and direct diagnostic failure remain
archived rather than rewritten. Independent recurrence seal:
`24f28787b1ac597a399c4be254dbd4cc3cd973104ad778cfaa10e00334cf8b74`.
