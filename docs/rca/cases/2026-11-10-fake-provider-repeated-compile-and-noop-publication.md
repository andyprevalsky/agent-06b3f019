---
id: 2026-11-10-fake-provider-repeated-compile-and-noop-publication
date: 2026-11-10
title: Fake provider repeatedly compiled immutable code and published unchanged state
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: Each fake flyctl process parsed the generated helper and locked_state replaced unchanged JSON after read-only queries
symptoms:
  - multi-workstream run1 timeout1200
  - PASS: scenario 15 — aged-out phantom is discarded (provisioning proceeds); fresh gap still fails closed
  - fixture helper is recompiled from source by every CLI invocation
  - read-only queries published unchanged state
tags:
  - cloudbench
  - fixture
  - python
  - bytecode
  - state-publication
sources:
  - PR #1881
  - commit 12b1ff359defa16996a3794b7b11043ea1567d8b
  - task GitHub Actions run 42779373058
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: open
---

## Problem

The original focused31 stability command, `bash scripts/tests/cloudbench-multi-workstream.test.sh`, exceeded its unchanged1200-second deadline on run1 under eight load slots. Native exit was null, zero of five repetitions passed, and the aggregate remained UNVERIFIED/complete=false with cleanup=true. Twenty-nine other selected units passed. The last original unit output was scenario15 PASS; scenario16 completion was not recorded.

The normal controller execution on the same12b1 source passed in1194.062 seconds. Its narrow remaining margin is a measurement, not a root cause. An isolated original scenario16 under eight load slots passed in46.005 seconds while preserving the ambiguous-name record, allocated-sibling cleanup and exact unattached-volume assertion. This does not reproduce cumulative prior-scenario history or establish the original clipped activity.

## Diagnosis

The generated fake provider is immutable for a fixture invocation, but the CLI wrapper started Python directly on its69757-byte source for every command. Direct compilation of that exact source200times under eight load slots took1.65–1.76 seconds; loading compiled code took0.018–0.026 seconds. Alternating real40-call CLI batches were noisy (source1.904/1.938 seconds, bytecode1.349/1.988 seconds), so those batches do not prove a full-unit speedup. Scenario16 journal contains44 CLI calls. No full-unit call count or sufficient cumulative saving is claimed.

A separate repeated operation occurs in locked_state: every successful read-only query serializes and replaces state.json even when no bytes change. The original-class regression records30such publications. One thousand loaded read-only operations took0.20–0.29 seconds on original code versus0.026 seconds with identical-publication avoidance. This is a proven adjacent source of unnecessary work, not proof that it alone caused the1200-second cutoff.

Archive searches covered multi-workstream timeouts, repeated module evaluation, fake-provider compilation and locked_state. The2026-10-17 repeated-private-IO-module-evaluation case is a related lesson about immutable executable code evaluation; it does not transfer its original timing or provider attribution. The prior cleanup-prerequisite duplication repair is already present in12b1 and does not cover these operations. PR1916's current investigator was contacted; its work concerns missing original collector evidence, with no competing compilation or state-publication implementation.

Original native logs and hashes, source comparisons, microtimings and the isolated replay are retained in the private loaded-multiworkstream-12b1-rca packet. The historical whole-timeout causal bridge remains UNKNOWN. It remains an assigned blocking repair; no not-introduced waiver or provider exception applies.

## Solution

External candidate only, based on12b1: explicitly compile the generated helper once using Python's standard CHECKED_HASH invalidation and invoke it through the standard module loader in fresh Python processes. Preserve the interpreter, sitecustomize startup, argument vector and executed source path. Source changes invalidate the cache; invalid changed source fails instead of executing stale code. All fake worker/driver functions remain AST-identical.

Within locked_state, keep the same exclusive lock and parsed state, serialize the successful final state, and publish only when its serialized bytes differ from the originally read bytes. Nested mutations still commit, concurrent updates retain every increment, and exceptions do not commit partial state. No production file, retry, cooldown, selector, deadline, concurrency, five-run count or scenario assertion changes.

The two regressions in the existing directly registered process-cleanup suite fail on original code and pass five unchanged repetitions on candidateb4a92be102bc4946b2081f8d3c476c35b3186379be2aebf5cab8c484e55f69d6. The full owning cleanup suite plus catalog, fake-volume and runtime-collector neighbors passed. A temporary export harness initially mixed hostPython3.12 with parentPython3.11 cache tags; the test now uses its own parent interpreter on PATH, matching native gate setup. That export mismatch is not a product failure.

The candidate is not deployed, and the original complete native five-run acceptance is PENDING. The case remains open. These local reductions do not grant native gate PASS, resource cleanup, financial clearance or final deployment credit. Golden reference: not applicable to this fixture-only proposal; no approval-gated agent behavior or production API is changed.

## Human feedback

The parent required preserving1200 seconds, five repetitions, eight load slots, every scenario and all original assertions. It rejected blanket fast failure on missing or unsealed evidence because a valid producer may still publish later. It required standard source-invalidating Python cache semantics and preservation of sitecustomize, child behavior, state locking and errors. The parent selected the strengthened cache-use regression variant as the final review candidate; the earlier770af implementation basis remains historical. The selected variant directly counts source compilation at the standard loader, showing zero repeated compilations and one after a source change.

## Reusable lesson

Reuse immutable generated code with standard source-invalidating caches and avoid publishing unchanged fixture state, while retaining native full-workload acceptance as the final performance proof.
