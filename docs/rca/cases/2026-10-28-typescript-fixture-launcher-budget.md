---
id: 2026-10-28-typescript-fixture-launcher-budget
date: 2026-10-28
title: Extra TypeScript launcher exhausted a covered fixture's child deadline
surface: harness
component: worker-deployment-queue-fixtures
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/unit/worker-deployment-queue.test.ts launched a second interpreter through node_modules/.bin/tsx inside its five-second child deadline
symptoms:
  - 'parent idle admission, interrupted wait and actual owned child lease loss'
  - 'Command failed: node_modules/.bin/tsx worker-deployment-queue.ts run --if-idle'
  - 'code=143 killed=true with empty stdout and stderr before the first Prisma query'
tags:
  - unit-tests
  - child-process
  - v8-coverage
  - fixture-ownership
sources:
  - PR 1627 integration HEAD 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
  - back-end/coverage/shard-2.log
  - /var/tmp/deploy-1627/rca/unit-queue-trigger/exec-observations-before.jsonl
repro: back-end/src/tests/unit/processSafety.test.ts
status: fixed
---

## Problem

Coverage shard 2 failed the worker deployment queue's parent-idle/cancellation
case. The summary retained only an execFile command failure. The nearby Postgres
`P0001 fixture publication rejected` exception was a red herring: it belonged to
an expected rejection inside the passing retention case. That helper is imported
by the same unit file; it is not a separately scheduled test. Its trigger is
already scoped to a random private schema, and the unit runner also assigns this
test a private database.

## Diagnosis

Critical path: unit runner -> schema-isolated queue fixture -> processSafety ->
tsx executable -> extra Node interpreter -> loader/import bootstrap -> lease
query -> GLOBAL_LEASE_BUSY -> disconnect -> child exit. The five-second deadline
included starting and instrumenting the otherwise unnecessary launcher process.

The original failure occurred about 5.094 seconds after the fixture acquired its
lease. A local replay of two unchanged queue tests with backend cwd and inherited
NODE_V8_COVERAGE reproduced the original case. A scratch preload observed
execFile's callback at 2026-10-28T19:10:47.679Z: duration 5158ms, code143,
killed=true, empty stdout/stderr. The CLI had started, but no Prisma query had
occurred. The other copy completed the same command in 4908ms. Without coverage,
both overlapping copies passed; a separate covered replay also reproduced the
same budget failure in the completed-job child invocation.

Archive searches were `fixture publication rejected` and `parallel unit database
trigger`. The shared IndexedDB fixture-identity and controller-readiness cases
were relatives, not established recurrences. Their first bad boundaries differ.
Golden reference: not applicable (no approval-gated hunk).

Step 5: What — fixture startup was killed before its first operation. Where —
the queue test's tsx child launches. Why — a redundant launcher and interpreter
both paid startup/coverage cost within the same deadline; diagnostics then
discarded the exit metadata. Proof — actual callback capture, plus the new
regression showing the interpreter's parent PID was the launcher rather than
the fixture owner. Problem — avoidable process startup amplified by concurrent
coverage, a test bug in the concurrency-inefficiency class.

## Solution

Use one shared processSafety helper to launch process.execPath with --import and
the resolved tsx loader. Apply it to all queue and retention fixture TypeScript
children, including nested recovery children. This removes the launcher process,
gives the fixture direct signal ownership, preserves NODE_V8_COVERAGE, and leaves
every existing timeout and assertion unchanged. On failure, keep the original
error and append code, signal, killed, stdout and stderr so the harness's message
summary cannot erase the actual process failure.

The new automatically discovered processSafety.test.ts exercises real child
processes. Before the fix, all three tests failed: the child's parent PID was the
launcher, a code23 failure omitted its exit and stdout evidence, and a startup
timeout omitted its killed/signal evidence. The same V8-instrumented command
passed all three tests after the fix. The existing queue
integration assertions continue to cover cancellation, owned-child lease loss,
and FIFO recovery.

The original local command was rerun unchanged:
`python3 /var/tmp/deploy-1627/rca/unit-queue-trigger/observed-repro.py` after sourcing
the deploy environment from the integration root. Both covered copies passed
all 10 assertions after the fix. Their processSafety execFile calls took
1331–1692ms in this replay. This is observed evidence, not a guarantee under
arbitrary host starvation. The registered backend unit runner additionally
selects and runs the new regression and queue file; /deploy invokes that runner
through backend coverage.

Raw child-process coverage files are inventoried in child-coverage-proof.json:
all 18 provider files and every previously covered function remain covered.
workerDeploymentQueue.ts rises from 34 to 36 covered functions. Range partitions
vary between the failing and successful runs; no claim is made that exceptional
path execution counts stay identical.

Independent adversarial review approved the frozen diff at 19:28Z. It reran the
original concurrent reproduction successfully, repeated the three-case
regression six times, inspected raw child coverage, and probed nonzero exit,
self-SIGKILL, ENOENT, timeout, maxBuffer and AbortSignal failure diagnostics.
The verdict and evidence are under /var/tmp/deploy-1627/rca/unit-queue-trigger.review.txt
and /var/tmp/deploy-1627/rca/unit-queue-trigger-review/.

## Human feedback

The user required no timeout increases, no coverage skips, no weakened
assertions, and restricted edits to the assigned integration files. They
explicitly approved direct process.execPath --import tsx with the existing
5000ms budget and inherited coverage. A preliminary proposal to calibrate a
larger timeout was rejected before implementation. Ownership moved between
Claude and Codex; the final author was Codex and no concurrent source edits were
made in this cluster.

## Reusable lesson

Launch the tested interpreter directly and preserve its full failure evidence instead of spending a bounded fixture's runtime on a redundant launcher.
