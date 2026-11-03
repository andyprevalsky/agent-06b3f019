---
id: 2026-10-17-repeated-private-io-module-evaluation
date: 2026-10-17
title: Private receipt IO reloaded executable helper code inside bounded observations
surface: infra
component: cloudbench-archived-machine-reuse
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/cloudbench-archived-machine-reuse.py private and save re-evaluated cloudbench-original600-runner.py for each receipt
symptoms:
  - ObservationDeadline inactive native observation deadline
  - private result read re-entered runpy.run_path after successful native GET
  - result save re-entered runpy.run_path after successful native GET
tags:
  - cloudbench
  - module-loading
  - private-io
  - observation-deadline
sources:
  - commit efd8a396a6b6e4a65d10186c7c9a24342ad9065a
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-archived-machine-reuse.test.py
status: open
---

## Problem

Original600 run70 retained three startup failures. Jobs r001-j0132 and
r001-j0184 received HTTP200 native GET responses, then their unchanged ten-second
observation expired while reloading the runner module for a private result read
or result save. The wire records place raw response observation 7.094 and 8.527
seconds after transport-start, respectively. Those intervals include local
journal work; they are not pure network latency measurements. The first result
file exists; the second does not. Neither late observation is reclassified.

Job r001-j0055 is a separate unresolved lease outcome: the subprocess exceeded
its 25-second outer bound despite a retained HTTP201 lease response and result
file. Its raw response timestamp is 24.601 seconds after transport-start; 16.243
seconds elapsed before the HTTP-phase marker. This does not prove what fraction
of startup was module evaluation or authorize replaying the lease.

## Diagnosis

The private read and save wrappers called runpy.run_path for every operation.
A direct observation therefore recompiled and re-evaluated the same immutable
helper repeatedly inside its deadline, including after the HTTP response.
The snapshot already pins those helper bytes, and the IO functions do not need
fresh module state. Removing redundant evaluation is the smallest owned repair;
provider latency, filesystem latency and initial process scheduling remain
independent limits.

The permanent owning test uses the real local HTTP transport, raw observer and
private result path. It injects slow module evaluation only after HTTP returns,
separately at result-save and result-read. Both phases fail on the baseline with
ObservationDeadline; the unchanged test passes after the repair. A second
control preserves exclusive writes, private permissions and physical-path
checks. The full owning suite passes 26 controls. These are local causal proofs,
not a completed original600 outcome proof. This case stays open pending that
outcome and the separate lease investigation.

Archive searches used “ObservationDeadline inactive native observation deadline
runpy” and “repeated module load serialization concurrency deadline”. Prior
process-observation and duplicated-inventory cases are relatives, not this
cause. The reference search covered claude-code-src, openclaw, hermes-agent and
codex; no identical receipt loader was found. Normal module imports in
hermes-agent/tools/browser_tool_install.py:7-13 retain dependencies once, unlike
re-evaluating source on every call.

## Solution

Resolve the pinned runner once when the archived-reuse module initializes,
before native effects and observation alarms. Delegate to its unchanged read
and save functions. Preserve the parent-directory creation wrapper, original
private-file checks, exclusive durable writes, raw-before-parse observer,
ten-second deadline, lease margins and joined subprocess write transport.
Do not memoize credentials, provider clients, observations or other helper state.
At large fanout this removes repeated per-receipt compilation in each process;
it does not reduce requested concurrency or increase any deadline.

The existing test file is already registered in scripts/test.sh. Scoped syntax
lint passes; the full default lint has the same 49 existing diagnostics on the
baseline and candidate, with no new diagnostic. This is not a full-lint pass.

## Human feedback

Every fix must persist so a new agent using the CLI can reproduce the result.
Preserve the original run clock, no unknown-write replay, and no deadline increase.
Keep fixes on future immutable source while the current run is active.

## Reusable lesson

Load immutable executable dependencies before a bounded IO operation instead of re-evaluating them for each receipt.
