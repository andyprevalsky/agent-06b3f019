---
id: 2026-09-27-proof-wrapper-shadowed-pinned-node
date: 2026-09-27
title: Private proof wrapper shadowed the validated Node toolchain
surface: infra
component: cloud-proof-toolchain
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The private live wrapper prepended /usr/local/bin ahead of the inherited pinned Node directory after admission validated Node 22.13.0
symptoms:
  - "controller_exit_code 70 with proof_id null"
  - "node_path /usr/local/bin/node and node_version v20.20.2"
  - "live-proof-20.log is empty"
tags:
  - cloudbench
  - path
  - toolchain
  - startup
sources:
  - PR #1299
  - commit 6bd85cc909c8491c37a273ce3f3800b46f4cbfff
repro: .context/setup/test-proof21-linux.py (private proof wrapper controls)
status: fixed
---

## Problem

The private cloud proof controller passed admission with Node 22.13.0, but its
live wrapper exited 70 before creating a proof directory or allocating a fleet.
The resident driver preserved the failed attempt with zero accepted slices.
Its four process identities were subsequently absent; read-only provider and
registry evidence showed no new resources from this attempt.

## Diagnosis

The path was pinned operator environment → detached resident driver → launcher
→ live shell wrapper → exact Node/Python guards → canonical benchmark command.
The first three layers retained the correct executable. The live wrapper then
prepended `/usr/local/bin`, whose Node was 20.20.2. Python remained the expected
venv 3.11.9. The version guard correctly rejected the changed executable; this
was not a benchmark failure or a missing installed dependency.

The actual host replay is retained in
`.context/acceptance/proof20-path-rca/same-shell-red-green.json`. The unchanged
shell boundary selected `/usr/local/bin/node` and exited 70; preserving the
inherited toolchain selected `/data/toolchains/node22/bin/node` and exited 0.
An independent local replay maps only the absolute system directory to a
sandbox containing a stale Node, then executes the actual wrapper guard block.
Two positive controls failed before and passed afterward; wrong-Node and
wrong-Python controls continue to fail with exit 70. All four final controls
pass without launching a benchmark or contacting a provider.

Archive searches used `PATH node version toolchain shadowed` and
`usr local bin nvm node guard exited 70`. The July 26 non-interactive Lean PATH
case is a relative, not a recurrence: that verifier omitted a toolchain path,
whereas this wrapper reordered a toolchain already present and validated.

## Solution

Remove redundant system-directory prepending from the private live wrapper:
`export PATH="$PWD/agents/venv/bin:$PATH"`. The child preserves the caller's
validated Node and Fly toolchain ordering and adds only its exact Python venv.
Both version guards, the 300-second proof backstop, ten-by-ten workload,
query-count requirement, and benchmark/evaluator behavior are unchanged.

The owning PATH controls now run in the proof's actual offline helper suite,
which passes 20 tests. The independent review is
`.context/acceptance/proof21-toolchain-review/review.json`. Failed proof20
receipts and its one-shot latch remain untouched; the next attempt uses fresh
proof21 identities and starts from zero. This closes the startup defect only;
it does not claim that the separate cloud acceptance proof has completed.
At 10,000 agents the change adds no work, shared state, or additional process.

## Human feedback

The user requires infrastructure-only fixes, ten consecutive slices of ten,
three successful LLM queries per benchmark, and a temporary five-minute proof
backstop. Task, prompt, model and evaluator changes must not manufacture success.

## Reusable lesson

Preserve the validated toolchain ordering in every child wrapper instead of prepending generic system directories after admission.
