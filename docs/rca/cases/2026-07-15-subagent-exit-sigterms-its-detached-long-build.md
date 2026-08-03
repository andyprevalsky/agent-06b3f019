---
id: 2026-07-15-subagent-exit-sigterms-its-detached-long-build
date: 2026-07-15
title: A long warm-image build launched from a sub-agent was SIGTERM'd when the sub-agent returned
surface: harness
component: agent-orchestration
classification: our-bug
problem_class: other
first_bad_boundary: sub-agent process group — a detached child does not outlive the sub-agent that spawned it
symptoms:
  - "terminated signal received"
  - warm-image build dies partway with no build failure of its own
  - long background job stops the moment the sub-agent that launched it returns
tags:
  - subagent
  - background-task
  - process-lifecycle
  - sigterm
  - cloudbench
sources:
  - memory:project_cloudbench_warm_image_dep_sync
repro: none-recorded
status: fixed
---

## Problem

The ~15-20 minute warm Fly image rebuild
(`bash scripts/run-bench-cloud --setup`) was launched from a sub-agent that then
returned its result. The build died with `terminated signal received` — not a
build error, a signal.

## Diagnosis

Backgrounding a command inside a sub-agent does not detach it from the sub-agent's
lifetime: when the sub-agent exits, its children receive SIGTERM. So the build was
killed by its own launcher's success. This is invisible in the build log except as
the bare signal line, which reads like external infrastructure flakiness rather
than a harness ownership problem — the same misread that makes orphaned-process
failures hard to attribute.

## Solution

Run long builds as a harness-tracked background task from the main loop, where the
owning process outlives the job, rather than from a sub-agent that returns. Stated
as a hard rule in the record: never launch a long build from a sub-agent that then
returns.

## Human feedback

None recorded.

## Reusable lesson

Never launch a long-running job from a sub-agent that will return before it
finishes — the sub-agent's exit SIGTERMs its children, so own the job from the
main loop and poll it there.
