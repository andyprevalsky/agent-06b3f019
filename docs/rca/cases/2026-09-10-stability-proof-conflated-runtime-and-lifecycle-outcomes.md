---
id: 2026-09-10-stability-proof-conflated-runtime-and-lifecycle-outcomes
date: 2026-09-10
title: Stability proof inferred evaluator completion and teardown from agent snapshots
surface: harness
component: capability-stability-proof
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: TaskResult.status stores agent lifecycle state while the proof treats it as the benchmark outcome
symptoms:
  - "PAUSED with passed=true rejected as infrastructure"
  - "ACTIVE after cancellation"
  - "ordinary task outcomes masked failed teardown"
  - "No report card retrieved"
tags:
  - stability-proof
  - benchmark-outcome
  - cancellation
  - teardown
sources:
  - PR #1299
  - commit 50e6a8196a27cf84023c4c08493547bc133976c9
  - fleet run capability-stability-20260910213442-26737
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: fixed
---

## Problem

The first live slice produced an ordinary passing payment-abandonment result
whose agent was PAUSED. Other tasks retained ACTIVE snapshots after the owner
cancelled them. TaskResult.status represented the agent, while the proof
expected PASSED/FAILED/SKIPPED. The proof also lacked an independent final
teardown verdict: valid task rows could hide a controller cleanup failure.

Archive searches included `guest cleanup was not acknowledged` and `watchdog
cancellation terminal artifact collection`. The terminal-artifact split-source
case is related, but did not cover the proof's conflation of task, agent, and
resource lifecycle state.

## Diagnosis

The benchmark producer owns the distinction between evaluated rejection and
execution failure. Inferring that distinction from an agent snapshot loses
information. Composite minted-account wrappers and SMS/Codex exception paths
also collapsed ERROR/CANCELLED into FAILED. Declared judges caught execution
exceptions and returned the same false score as an actual criterion rejection.

The proof's shell regression reproduced an allowed ordinary result despite a
failed lifecycle receipt. Production-function tests reproduced child ERROR
and CANCELLED becoming aggregate FAILED, and judge/runner exceptions becoming
ordinary failures. Those unchanged tests pass after the fix. A real cleanup
function test covers successful registry retirement, registry-removal failure, and a
registry-removal helper returning success while ownership still exists.

A sibling artifact-ordering defect occurred on watchdog expiry: extraction ran
before shutdown wrote the cancellation run record. The post-poll collection
regression executes the real controller block and token-bound parser with a
shutdown-produced artifact. It failed before the fix and now preserves that
CANCELLED record while keeping TIMED_OUT set.

## Solution

TaskResult carries an explicit benchmark_status separately from agent status.
The fleet report card projects this explicit outcome while retaining the original
agent status in run.json. Four real aggregate subprocess cases reproduce
SKIPPED/ERROR/CANCELLED/INFRA_ERROR with ACTIVE snapshots before the fix and
pass afterwards (`report-card-outcome-{repro,fixed}.log`).
All production constructors publish it; composite tasks preserve infrastructure
outcomes, and judge exceptions reach the existing ERROR handling. Ordinary
evaluator rejections remain FAILED. The proof rejects cancelled, erroneous,
unknown, malformed, and inconsistent outcomes.

Each slice receives its own owner token. Only final controller cleanup can
publish a verified lifecycle receipt, after provider teardown, audit sealing,
local process cleanup, and exact registry retirement. The proof binds the
receipt to its token, workspace, run, exit code, and the immutable audit digest.
Files are hashed in relative-path order and symlinked audit entries are rejected.

On watchdog expiry the controller spends the existing bounded shutdown window
before collecting the terminal log. The EXIT trap reuses that result. This does
not extend a benchmark deadline, convert cancellation into an evaluated failure,
or authorize cleanup without acknowledgement.

Verification: `scripts/tests/fleet-infra-stability-proof.test.sh`; the focused
`fleet_lifecycle_receipt_requires_final_registry_retirement` and
`watchdog_collects_cancelled_artifact_after_bounded_shutdown` pytest cases; and
four registered benchmark blackboxes covering composite, SMS, Codex, and judge
execution errors. Logs are under `.context/acceptance/` with prefixes
`benchmark-outcome`, `lifecycle-verdict`, `minted-outcome`, `harness-outcome`,
and `watchdog-artifact`. These are deterministic regression evidence; they do
not count as any of the required 100 live outcomes.

At 10,000 agents, outcome publication is constant work per task and audit hashing
is linear in the exact owned fleet ledger. There is no provider-wide sweep or
shared hot database row.

## Review recurrence: publication and cancellation boundaries

The first PR review reproduced additional false terminal-state boundaries.
An empty aggregate could report success, failed sidecar publication left stale
terminal artifacts, and atomic rename alone did not durably flush the artifact
or parent directory. Aggregate publication now flushes both, rejects an empty
task set as success, and removes all three terminal artifacts after a rejected
publication. Five injected publication failures and an empty-task subprocess
case cover those transitions.

The proof previously parsed a log written by an asynchronous process
substitution. A delayed writer reproduced classification before the final
receipt reached disk. A foreground pipeline now waits for `tee`, preserves the
controller's exit code, and rejects a failed log writer. The unchanged proof
regression covers delayed and failed writes.

Campaign cancellation previously classified a cooperative signalled child as
passed, exposed negative subprocess signal codes, and repeated its shutdown
window during delayed reap. It now records successful signal delivery, marks
those jobs cancelled, normalizes signal exit codes, and requests teardown once.
The three executable campaign cases in `descend-command.test.sh` failed before
the change and pass afterwards. Completed siblings retain their outcomes.

These offline tests are review evidence, not live stability-slice credit.

## Review recurrence: path and diagnostic representation

The October 1 review produced two actual false-INFRA reproductions through the
real stability-proof CLI and existing fake Fleet. A symlinked checkout supplied
logical workspace paths to classification while the recorded identity was
physical. Separately, one invalid UTF-8 diagnostic byte crashed the log relay
with `UnicodeDecodeError` before an otherwise valid evaluated slice could be
classified. Both unchanged reproductions exited 1 with zero accepted slices
(1.152 and 0.681 seconds respectively).

The proof now establishes its physical checkout path once and decodes diagnostic
relay output with replacement while preserving the original raw log. Exact
owner, lifecycle, task verdict and evidence assertions remain unchanged. The
same reproductions now each accept the evaluated task failure and verified
teardown (1.051 and 1.067 seconds). Both scenarios are permanently in
`scripts/tests/fleet-infra-stability-proof.test.sh`; that complete existing suite
also passes. No model calls or live benchmark stages were added.

Archive searches were `UnicodeDecodeError slice relay` and `workspace_root
symlink proof classification`; the optional-artifact case is a relative, while
this is another representation error at this case's classification boundary.
At 10,000 agents the change adds no shared state or per-agent work: one checkout
resolution per proof and the same bounded diagnostic stream. These offline
checks grant no live fleet acceptance credit.

## Human feedback

The user required finishing PR #1299 and explicitly said to stop asking for
permission. The 300-second override, task selection, prompts, and evaluators'
criteria remain the acceptance contract.

## Reusable lesson

Publish task verdicts and resource retirement at their owning boundaries; an
agent status or subprocess exit code cannot prove both.
