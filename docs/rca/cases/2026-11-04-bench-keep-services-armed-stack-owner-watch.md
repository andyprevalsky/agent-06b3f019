---
id: 2026-11-04-bench-keep-services-armed-stack-owner-watch
date: 2026-11-04
title: --keep-services stack shut down when local.py exited because the run.sh owner watch was always armed
surface: harness
component: benchmarks-local-stack
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/local.py start_services — set RUN_SH_OWNER_PID for every isolated stack, including stacks the caller asked to keep
symptoms:
  - "Stack owner PID <pid> exited without stopping this stack — shutting down all services."
  - "[Server] SIGTERM received, closing server..." right after "All requested benchmarks passed." with --keep-services
  - scripts/run-bench --local <task> --keep-services leaves no backend/frontend running (curl localhost:<port>/health → connection refused)
  - "Keeping benchmark services running so the paused checkpoint FE link remains valid." followed by a dead stack
tags:
  - local-bench
  - keep-services
  - run-sh-owner-watch
  - checkpoint
sources:
  - commit 714ba76d2
  - commit 712043718 (S31 owner watch introduced)
  - commit 08b172b24 (owner watch armed from service start)
  - benchmark run rcamultiday1 (local claude-code-agent --keep-services, backend.log SIGTERM 22:38:36Z)
repro: agents/benchmarks/local_lifecycle_test.py::test_kept_stack_does_not_arm_owner_watch
status: fixed
---

## Problem

`scripts/run-bench --local claude-code-agent --keep-services --run-id rcamultiday1`
passed (1/1). The services were stopped anyway: `curl localhost:26840/health` and
`:26841` returned nothing. The backend log ended with `[Server] SIGTERM received, closing
server...` at 22:38:36Z, a few seconds after the controller printed "All requested
benchmarks passed." and exited 0. The same teardown also defeats the
`--checkpoint ... --checkpoint-no-start` path, which prints that it keeps services so
the paused checkpoint FE link stays valid.

## Diagnosis

1. `local.py` `main()` honours `--keep-services` only by skipping its own
   `stop_services()` call. It never told the stack it would outlive the controller.
2. `start_services()` sets `RUN_SH_OWNER_PID`/`RUN_SH_OWNER_START` for every isolated
   stack. This was the S31 guard (712043718; armed from service start in 08b172b24),
   meant for a SIGKILLed controller.
3. `scripts/run.sh` `start_stack_owner_watch` TERMs the stack once that PID is gone, so a
   normal controller exit after a kept run is indistinguishable from a SIGKILL.

The deepest owned cause: two separate "keep the stack" decisions — the teardown skip in
`main()` and the owner-watch arm in `start_services()` — with no shared source of truth.
That is why the checkpoint keep path had the same bug.

Repro (pre-fix): `cd agents && python -m pytest benchmarks/local_lifecycle_test.py -q -k kept_stack_does_not_arm_owner_watch`
→ `AttributeError: module 'benchmarks.local' has no attribute 'stack_outlives_controller'`.
No keep decision reached the stack launch. Live evidence: the rcamultiday1 backend.log
SIGTERM above.

## Solution

`stack_outlives_controller(args)` is now the single keep decision: `--keep-services`, or
a paused checkpoint with `--checkpoint-no-start`. `main()` passes it to
`start_services(outlive_controller=...)`, which then does not arm `RUN_SH_OWNER_PID`.
The teardown skip uses the same helper.

The S31 behaviour (a stack that is not kept dies with a SIGKILLed controller) is
unchanged. The test asserts the watch is still armed for the default case. Post-fix:
the same test passes, and `local_lifecycle_test.py` ran 5× with 24 passed each time.
Live, `--run-id rcamultiday2` kept backend :26200 healthy after `EXIT=0`
("Keeping benchmark services running: …").

10k-agent behaviour: none. This is a per-developer local harness flag with no runtime
or per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

When a flag promises that a resource outlives its creator, route that promise to every
watchdog that would reap it from one shared decision, not just to the creator's own
teardown.
