---
id: 2026-11-09-readonly-lint-retained-type-program-during-syntax-work
date: 2026-11-09
title: Read-only lint retained the TypeScript program while processing syntax-only files
surface: harness
component: back-end/scripts/lint-affected.mjs
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: One lexicographic ESLint batch opened the type-aware project early and retained it while processing the remaining syntax-only files
symptoms:
  - ESLint quick gate timed_out true at the unchanged 120 second deadline
  - native_exit -15 with missing complete case receipt
  - check_deploy_static.py lint --base origin/main produced no diagnostics before timeout
tags:
  - eslint
  - typescript
  - quick-gate
  - memory-lifetime
sources:
  - commit dd1b3042917b0d34295e10e92109aa5f1e95fa06
  - commit dcc2ff37e6be5593036be6dbafdb092d4a1d6be8
  - task .context/cli-nov09-quick55-rca/eslint-full-profile/ordered-repair-result.json
repro: /usr/bin/python3 scripts/check_deploy_static.py lint --base origin/main
status: open
---

## Problem

Quick55 and quick56 timed out at the unchanged 120-second native deadline. Quick53 had passed the same lint contract in70.757s. The current backend tree, dependency manifests and lint code were unchanged; original results remain authoritative. No current boxes memory-termination event explained the timeout. Archival I/O overlapped55 but had finished before56, so it cannot explain both failures.

## Diagnosis

Gate: NOT_INTRODUCED by the dcc-to-dd1 changes: backend and lint inputs are identical. This label does not waive the assigned performance repair. The precise reason for variation from53 remains unproven. The actual56 observer localized work to ESLint:125.06 CPU seconds, peak2821MiB RSS, versus3.85 CPU seconds in graph preparation and0.24 in the Python wrapper. Phase labels were followed across exec rather than frozen at their first sample.

The exact full command reproduced the120-second timeout in an isolated source snapshot. A CPU profile saved before that deadline showed61.178 sampled seconds in TypeScript and17.191 in GC. Per-file timing completed1450 of2419 selected files before timeout: the first type-aware file took21.057s for project startup; every other completed file was below0.877s. There was no demonstrated single runaway application file. The sorted batch starts type-aware domains before the syntax-only test files, retaining the large TypeScript project throughout that later parsing work.

A first experiment replaced projectService with project mode. Its small regression retained type-aware diagnostics and avoided editor-service opens, but the full command still timed out120.699s. It is rejected and not part of this repair. Both modes already shared one compiler Program, so no repeated-Program claim is made.

Archive searches used `lint affected timeout no output` and `eslint IO archive contention`; earlier incidents concerned different boundaries. The new issue is lint scheduling, not permission to weaken type rules or reset source bindings.

## Solution

For read-only lint, derive an exhaustive disjoint partition from the real effective ESLint config. Finish files without type-aware parser settings first, then lint typed files on the same ESLint instance. Await the phases sequentially: there are no extra workers, concurrency changes or result caches. Real inventory proof records exactly2419 unique inputs:1682 syntax-only and737 typed, with none omitted. Keep the original graph selection, all rules and tsconfig; retain the original --print output and --fix subprocess path. Preserve CLI single-run inference, explicit false and config opt-outs, warnings-only exit0, lint-errors exit1 and engine/config-errors exit2.

The same full command completed112.269s in the initial ordering experiment, then95.214s after CLI compatibility corrections, under the same120-second supervisor. That latter completed computation used peak1788MiB child RSS. These are private owning-command measurements, not a four-gate native cohort result. They support the scheduling change; they do not quantify how much time each memory/launcher effect saved.

Independent review found a new candidate-only output issue: forced process.exit after stream.write could truncate diagnostics. The final code uses process.exitCode in the read-only success/error paths. A deterministic2000-diagnostic control was red at65536 bytes/761 messages and green at172147 bytes/all2000 messages. The permanent regression also covers large stderr, empty groups (ESLint treats an empty list as the whole cwd), all-typed/all-untyped groups, unknown/ignored config, full typed/syntax diagnostic parity, warning-only status, engine failures, and preserved --fix/--print behavior. The owning static suite passed12 tests. The timed full computation preceded only the output-drain correction; parent instructions explicitly assign final exact-byte native quick validation after integration, without another duplicate private full run.

All original assertions and deadline bounds remain. Golden reference: not applicable (lint orchestration only). No dependency installation, source push, provider/DB/service action or canonical mutation occurred. The original quick failures, cloud custody and financial obligations remain retained. Status stays open for final independent review and parent-owned native validation.

## Human feedback

Parent instructions require the original120-second gate, full selected inventory, all type-aware rules, default concurrency and original failures to remain intact. The parent supplied the scheduling hypothesis and required measured proof, not a near-deadline calibration or synthetic PASS. Independent review required empty-group protection, CLI inference/exit/formatter compatibility and complete output draining. This was reviewer feedback, not a direct human approval.

## Reusable lesson

Schedule syntax-only lint before allocating long-lived type-aware state, and prove exact inventory and diagnostic equivalence instead of weakening coverage or deadlines.
