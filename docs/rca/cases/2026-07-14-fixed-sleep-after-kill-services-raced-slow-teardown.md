---
id: 2026-07-14-fixed-sleep-after-kill-services-raced-slow-teardown
date: 2026-07-14
title: A fixed `sleep 3` after kill-services was outrun by slow teardown, so the previous stack's cleanup SIGKILLed the new one
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-agentcard-lifecycle-task.sh — `sleep 3` between kill-services and stack start instead of waiting for ports to free
symptoms:
  - "run.sh SIGKILL'd with an empty log"
  - "Killed: 9"
  - "AssertionError: async write must eventually flush to disk"
  - "FAIL: same-worktree worker with current backend survives"
  - "FAIL: missing autoscaler terminal proof did not produce a stable explicit failure"
tags:
  - benchmark-harness
  - teardown
  - process-lifecycle
  - sigkill
  - ports
sources:
  - memory:project_agentcard_lifecycle_test_infra
  - PR #924
repro: back-end/src/tests/unit/non-blocking-fetch-cache.test.ts; scripts/tests/run-process-cleanup.test.sh; scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

Launching a fresh AgentCard-lifecycle benchmark stack produced a `run.sh` that
was SIGKILLed with a completely empty log — surfacing as `Killed: 9` /
`exit 144` and no diagnostic output at all. The same command worked when run
after a longer manual pause.

## Diagnosis

The runner did `kill-services`, then `sleep 3`, then started the stack. The
multi-process teardown of the _previous_ stack is slower than 3 seconds, so its
cleanup was still running when the new `run.sh` came up on the same ports — and
that in-flight teardown then killed the newly started processes. Empty log +
SIGKILL is the signature: the new stack never got far enough to log anything
before being reaped by the old stack's cleanup.

The same problem class recurred in PR #924's backend coverage gate. The
non-blocking fetch-cache test proved that `set()` returned promptly, slept for
200 ms, and then expected its asynchronous file write to exist. The unchanged
focused test passed once the host was idle, while the concurrent coverage run
failed the persistence assertion. The component already exposed
`flushPendingWrites()`, so elapsed time had again replaced the owned readiness
condition.

It recurred again in the deploy command's process-cleanup structural test. Its
three fake workers used `sleep(60)` as their lifetime, but the parallel gate
took 89.75 seconds before asserting that the two intentionally retained workers
were still alive. Cleanup correctly killed the stale worker; the current worker
had simply expired on its own before the survival assertion.

The same cause recurred in PR #924's CloudBench controller regression. Scenario
2k waited for `worker-ready.ids`, then assumed the autoscaler would remain in
its ordinary ten-second poll sleep while the child completed and final
acceptance sampled the state. Under the loaded deploy gate, the sampled
capacity no longer matched the ready state, so production correctly failed
closed on a `0/1` capacity shortage instead of the missing causal terminal
proof the fixture intended to isolate.

Related footgun from the same family, recorded in the same session: launching
`run.sh --benchmark` as a plain background Bash-tool command orphans it when the
launcher task exits, and its messy teardown then SIGKILLs the _next_ stack the
same way. The deeper owned cause is a time-based guess standing in for an actual
readiness condition.

## Solution

Replaced the `sleep 3` with a wait-for-ports-free loop, so the new stack starts
only once the previous one has genuinely released its ports. Long-running
benchmark stacks are launched via `scripts/run-agentcard-lifecycle-task.sh`,
which keeps its parent alive and self-manages startup and teardown rather than
being orphaned as a detached background command. If a mess does happen, sweep
the stack's port range (55050-55054 for this workspace) and `pkill`
`run.sh`/`worker.py`, then wait before retrying.

For the fetch-cache recurrence, the persistence assertion now awaits
`cache.flushPendingWrites()` before inspecting the file. The separate latency
assertion remains, so synchronous-write regressions are still detected without
guessing when asynchronous work will finish. This is test-only synchronization
over already-owned promises and adds no production runtime work.

For the process-cleanup recurrence, fake workers now block in `signal.pause()`
until the harness's owned cleanup signal arrives. Their lifetime therefore
matches the test lifecycle instead of an assumed upper bound on gate duration.
This is test-only lifecycle synchronization and adds zero production runtime
work or fan-in, including at 10,000 concurrent production runs.

For the CloudBench recurrence, an explicit fake-environment hold marker now
freezes the autoscaler at the exact `capacity fully accepted, terminal proof
absent` boundary. It requires ready capacity to meet demand, tracked and ready
counts to match, no pending provisioner, and every ready worker to pass the
operational probe before publication. The fake child waits for that owned
marker before completing, so the case no longer borrows the component's normal
polling delay as synchronization. The hook is gated by both the fake Fly
environment and an explicit test flag; production defaults, network work,
capacity, and failure ordering are unchanged. At 10,000 concurrent production
runs those gates are absent, adding no fan-in, storage, network work, or lock
contention; the only production-path operation is a pair of local shell
conditions in the existing autoscaler loop.

## 2026-10-01 recurrence: a failed archive admission assertion escaped its fixture lifetime

The merged PR #1299 agents coverage run on `2c2a845dbf72c6732488347cc430be56a8e49882`
reported `archive admission blocked the event loop for 0.274s` against the unchanged
0.25-second limit. The burst fixture awaited accepted archive writes only after
that assertion. Its failure path restored the storage function and environment,
then removed the temporary directory while the shared executor still owned writes.
The resulting `Directory not empty` cleanup error masked the admission assertion;
subsequent background writes crossed into the next outbox fixture, which then
failed its drain assertion. This is another fixture-lifetime violation of the
owned-completion rule above. It does not establish the cause of the initial
0.274-second admission measurement.

The permanent `test_async_archive_burst_retires_jobs_after_assertion` invokes the
actual existing burst fixture and injects an assertion after eight real accepted
writes. Before the fix it failed because accepted jobs remained alive when the
fixture returned. An outer local-only safety fixture drained those jobs before
restoring its own state. The same regression passed after giving the burst its
own executor and joining it in `finally` before restoring any patched globals or
removing storage. A private boundary observer independently measured eight pending
jobs at environment restoration before the fix and zero afterward, preserving
the injected assertion in both observations.

The unchanged burst and following outbox test passed in isolation before and
after the fixture repair. Their 96 inputs, 0.25-second admission limit, 64-job cap,
0.2-second slow store, and artifact checks remain unchanged. The original
admission-latency cause remains an open observability gap, not a claimed runtime
fix. No production archive code, benchmark budget, provider call, or model policy
changed. At 10,000 production agents this test-only correction adds no runtime
work.

Permanent reproduction (activate `agents/venv` and run from `agents`):
`PYTHONPATH=tests/blackbox python -c 'import asyncio,runpy; asyncio.run(runpy.run_path("tests/blackbox/trace_archive.blackbox.py")["test_async_archive_burst_retires_jobs_after_assertion"]())'`.
Both RED and GREEN used the same reproduction. The test is registered in the
existing `trace-archive` domain discovered by the mandatory agents coverage gate.

## Human feedback

None recorded.

## Reusable lesson

Gate asynchronous assertions and fixture lifetimes on owned readiness or
lifecycle signals, never on a guessed amount of elapsed wall-clock time.

## 2026-10-16 recurrence: retry readiness was inferred from enqueue time

The WHM deploy C6 backend gate on
`1a573eb69c6b0950f579b752deb1794058dff5e9` failed the existing
`committed-message-broadcast` case at “the fixture must have retry settlements
in flight”, before its independent initial-slot isolation assertion. Original
142,711-byte backend log SHA256
`dc6613c937e2e6c80eabd976fb949a8807e696e62f43c3f48b20ec8c43096fbc`
is retained. The callback replaces fetch; its calls do not reach Supabase or
the separate backend server. No provider or host-load cause is inferred.

The fixture waited 150 ms from enqueue, although initial dispatch and response
settlement precede the unchanged 100 ms retry backoff. Captured ordering puts
the readiness assertion before retry entry. The fixture and owning runtime
are byte-identical in the old branch, upstream main `a59f19b1`, and merged C6.
Archive searches for the retry-settlement symptom and fixed-sleep readiness
found this owned-completion family and the separate committed-delivery case.
The latter's production retry policy is unchanged.

The complete existing ten-case owning artifact reproduces the same readiness
assertion when the mock's first response takes a controlled 80 ms: 9/10, exit 1.
Awaiting the mock's first-retry event instead passes 10/10 with the same mock
latency and all 27 original assertions unchanged. The controlled latency stays
in the permanent existing callback. The original 50 ms healthy-agent isolation
check, two-second attempt deadline, three-send policy and concurrency caps are
unchanged. A beforeExit rejection prevents a missing retry from silently
finishing an unresolved readiness promise; the listener and held gate are
released in finally.

An adversarial runtime retaining the initial request slots still fails the
unchanged isolation assertion. A mock that never produces a retry fails closed.
Independent parent execution passed the full candidate in 3.403 s and rejected
the slot-retention mutant in 3.335 s. Network, sockets and DNS were denied; the
existing mocked publisher was the only request boundary. The production
delivery sources remain byte-identical. At 10,000 production agents this
test-only synchronization adds no runtime work or context.

Permanent reproduction remains the canonical
`npx tsx src/tests/blackbox/run.ts committed-message-broadcast` domain. The local
causal proof does not rewrite the original C6 backend or aggregate FAIL. Full
post-integration deploy qualification is recorded separately under the same
original deployment clock.
