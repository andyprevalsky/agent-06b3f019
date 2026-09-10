---
id: 2026-09-10-detached-helper-inherited-controller-pipe
date: 2026-09-10
title: Detached Hub inherited the controller pipe after redirecting standard streams
surface: infra
component: cloudbench-detach
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_detach_reexec preserved inherited descriptors above stderr across setsid and exec
symptoms:
  - top capability controller remained blocked in tee after terminal failure
  - orphan slice tee remained blocked after run-bench-fleet exited
  - agent_link_server retained fd 63 as a writer to the slice tee input pipe
tags:
  - cloudbench
  - fleet
  - detach
  - file-descriptor
  - pipe
sources:
  - commit fe99d86f6
  - commit 76f022579
  - fleet run capability-stability-20260910105116-2670724
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_detach_reexec_closes_inherited_launcher_pipe
status: fixed
---

## Problem

After the exact capability proof printed
`CAPABILITY STABILITY PROOF FAILED at slice 0`, its Fleet process was gone but
the top controller remained blocked waiting for `tee` for more than one minute.
Exact-PID inspection found slice tee 2670738 reading pipe inode 12360745 while
detached `agent_link_server` 2670877 still held FD 63 as a writer to that same
pipe. The Hub's standard input was `/dev/null` and stdout/stderr were its own
log, so FD 63 was the only edge retaining the failed slice pipeline.

The permanent pre-fix command was:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_detach_reexec_closes_inherited_launcher_pipe`.

It passed an inheritable pipe writer above FD 2 through the production detach
helper and failed after one second with
`detached child retained the launcher's pipe writer`.

## Diagnosis

Critical path: proof stdout enters slice tee → Fleet launches a persistent Hub
inside that pipeline → `cloudbench_detach_reexec` forks and creates a new
session → it redirects FDs 0, 1, and 2 → it execs the Hub while preserving every
other inheritable descriptor → Fleet exits → the Hub's hidden writer prevents
tee EOF → both slice and outer pipelines wait forever.

What: a detached service retained a controller-owned pipe writer. Where:
`cloudbench_detach_reexec` and its tracked sibling in
`scripts/lib/cloudbench-env.sh`. Why: session detachment changed process-group
ownership but did not close inherited descriptors above stderr. Proof: `lsof`
mapped Hub FD 63 and tee FD 0 to the same inode; the deterministic regression
reproduced the missing EOF while the detached command remained alive.

The deepest owned cause is an incomplete detach contract: durable helpers owned
their session and standard streams but still inherited arbitrary launcher I/O
capabilities. Any inherited lock, socket, or pipe descriptor was a sibling
lifecycle leak.

## Solution

Both tracked and untracked detach paths now redirect standard streams, enumerate
`/proc/self/fd` or `/dev/fd`, close every descriptor above 2, and use
`closerange` only when neither descriptor directory exists. They then exec the
requested helper with no launcher I/O edge. Exact tracked PID/group ownership
and signal handling remain unchanged.

The unchanged regression reaches immediate EOF while the detached command stays
alive, and the complete dependency-sync and multi-workstream lifecycle suites
pass. At 10,000 agents, work is bounded by one process's descriptor table at
detach time; there is no agent-wide scan, channel, lock, shared row, or fan-in.

## Human feedback

The user required exact process and descriptor evidence, no broad process kill,
preservation of unrelated workstreams, a local failing regression, full
lifecycle verification, and exact owned-resource cleanup reporting.

## Reusable lesson

Close every inherited descriptor above stderr before execing a detached helper; a new session alone does not detach launcher I/O ownership.
