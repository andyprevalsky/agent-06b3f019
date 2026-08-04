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

## Human feedback

None recorded.

## Reusable lesson

Gate asynchronous assertions and fixture lifetimes on owned readiness or
lifecycle signals, never on a guessed amount of elapsed wall-clock time.
