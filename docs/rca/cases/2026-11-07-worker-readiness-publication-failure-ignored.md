---
id: 2026-11-07-worker-readiness-publication-failure-ignored
date: 2026-11-07
title: Worker readiness caller ignored synchronous publication failure
surface: harness
component: cloudbench-worker-provisioner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: provision_worker ignores publish_worker_ready nonzero and removes pending before reporting joined queue
symptoms:
  - failed readiness publication must not report native provisioner success
  - timed out acquiring worker ledger lock
  - joined queue with empty worker-ready.ids
tags:
  - cloudbench
  - readiness
  - worker-ledger
  - return-status
sources:
  - PR #1708
  - commit 77744c54e7da30fd57c8b1c3295b9f9c70249fd5
  - commit 60ca0ff528360e8e54198cec54c00a11fab4a50e
repro: scripts/tests/cloudbench-worker-readiness-publication.test.py NativeCaller
status: open
---

## Problem

Gate: INTRODUCED for the new synchronous reconciliation failure path in
77744c54 compared with 60ca0ff. The unchecked call itself existed previously;
this does not claim that every possible ignored readiness write failure began
in 77744c54. The original historical controller RCA remains UNKNOWN.

Review comment 4503659938 was treated as untrusted input and checked against
frozen source. All source used by the reproduction was obtained with `git show`
from the required immutable commit. No changing Root source was copied later.

## Diagnosis

Path: actual queue-health result -> publish_worker_ready -> real worker-ledger
lock / readiness append -> caller clears pending -> caller logs joined queue
and exits zero. The first wrong operation is the caller's continuation after a
nonzero publication result. The script uses `set -uo pipefail`, not errexit.

The native Bash reproduction executes the unchanged readiness caller block,
its original local helper definitions and the actual lock/reconciler/cleanup
functions. External health, runtime capture and provider retirement are narrow
owned fixture boundaries; there are no real provider operations. A live
test-owned process holds the actual lock. Its default 100 acquisition attempts,
0.1-second delay and 300-second stale threshold are unchanged.

On frozen 77744c54, the real lock exhausted in about 11 seconds and returned 75.
Nevertheless the actual caller exited 0, removed pending, printed joined queue,
and left the exact worker tracked with an empty ready ledger. An independent
real file-permission append failure produced the same contradiction. Both
failed the permanent assertion:
`failed readiness publication must not report native provisioner success`.
Native logs and per-case JSON retain these states.

Matched source comparison with a live held lock: the 60ca0ff publisher returned
0 because it did not synchronously reconcile the aggregate ledger; the 77744c54
publisher returned 75, but its unchanged caller still returned 0. A matched
append-failure comparison likewise changed the publication return from 0 to 1
while the caller kept reporting success. This isolates the newly exposed
synchronous failure path rather than inferring attribution from changed files.

Why the prior regression missed it: it exercised the producer directly and
asserted that its subprocess succeeded. Its cancellation and foreign-state
controls never made publication fail inside the actual caller. The new tests
execute that caller, including its pending removal and native exit.

Archive searches at frozen 77744c54 used literal `publish_worker_ready` and
behavioral `readiness.*(lock|pending)|(lock|pending).*readiness`. The prior ready
projection RCA and 2026-08-03-post-child-worker-ledger-contention-treated-terminal
are related, not identical first-bad callers. Their Solution and Human feedback
were read. The older post-child finalizer retries only within its existing
terminal deadline; this change does not alter that path or add retries.

## Solution

The stabilization fix checks publish_worker_ready before pending removal or the
joined-queue success message. On failure, first honor a concurrent cancellation,
then use the existing discard_replaceable_worker path. That path already owns
runtime evidence capture, exact retirement and durable failure when cleanup
cannot finish. No new timeout, retry, cap, provider call or global state is added.

Removing synchronous publication would restore the previous delayed-projection
defect; suppressing its error would fabricate success. Reusing the existing
failure path is the smallest change that preserves the ownership contract and
also handles marker, qualification and aggregate-append failures.

The same native caller command failed on frozen source and passed after the
fix, without changing its assertions. With the lock still held, the fixed
caller exits nonzero, retains pending and the tracked worker, leaves ready.ids
empty, and writes the existing worker failure marker. On append failure with
cleanup available, capture precedes exact retirement and ownership removal.
Cancellation during the lock wait keeps its separate failed-cleanup outcome
and ownership. Healthy publication and rejection of foreign ready markers pass.

The permanent append-failure control injects the append operation's nonzero
return, so it works under root as well as ordinary users. The earlier real
permission-error repro is retained separately. Both use the same caller and
asserted contract. The original Clock and ReadinessPublication classes, fake
driver, lock, reconciler and cleanup functions remain byte/AST-identical.

The existing standalone owning suite discovers NativeCaller through unittest;
the multi-workstream entrypoint already invokes that suite, and the frozen
controller gate/deploy planner invokes multi-workstream. Six existing frozen
targeted tests passed, covering cleanup serialization, concurrent retirement,
lock recovery/foreign release, reconciler failure, terminal child behavior and
the original worker-stage/readiness failure cases. Exact commands, elapsed
times, native exits and hashes are in the private result/receipt files.

The final permanent regression command is identical on both sides:
`python3 -B .context/rca-browser-4f77/review-findings-2109/readiness-child/permanent-check/scripts/tests/cloudbench-worker-readiness-publication.test.py NativeCaller`.
It failed before the fix (two failures, 11.376s) and passed after (22.369s).
Only the private subject's production file changed between that pair. The
complete seven-test owning file then passed five consecutive unchanged runs
in 22.67-22.95s each. No production timeout or retry value changed: the longer
failure run also executes the already-existing bounded cleanup attempt.

A supplementary full-provisioner replay retained the existing ownership
assertions from test_autoscaled_worker_failure_publishes_durable_failure_marker.
Its new append-failure input, under the real controller's `set -uo pipefail`,
printed the false joined message before failing the original retirement check.
After the fix, the same full function captured and retired the worker and passed
that check. The earlier strict-errexit variant is retained as a separate fixture
diagnostic; it is not claimed to reproduce the production false-success path.

This is a local verified repair proposal, not a full controller/agents coverage
or deployment pass. Parent owns integration, source freeze and full gates.
No new review or override was requested. Golden references are not applicable
to this ordinary caller error-handling change. At 10k agents it adds only a
status check on an existing per-worker operation; failed workers use the same
bounded, identity-scoped cleanup path as other provisioning failures.

## Human feedback

The user directed the existing browser/proxy/fresh-Tilion deploy to completion, explicitly asked for `/sync` and rereading `/deploy`, and directed relentless unblocking. Original clocks, failures, coverage, review history, capacity limits and Freedom remain protected. The coordinator, rather than a new direct user instruction, bounded this delegated investigation to frozen77744 and private outputs. There was no additional direct human diagnosis of this finding. The coordinator owns integration and current-source validation; the child did not mutate the actual review ledger or deploy.

## Reusable lesson

Check the result of a newly synchronous publication step at its real caller
before clearing pending ownership or reporting success.
