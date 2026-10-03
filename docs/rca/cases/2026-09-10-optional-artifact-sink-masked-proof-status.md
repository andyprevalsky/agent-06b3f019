---
id: 2026-09-10-optional-artifact-sink-masked-proof-status
date: 2026-09-10
title: Optional artifact storage failure replaced the canonical stability-proof result
surface: infra
component: fleet-stability-proof
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-fleet-infra-stability-proof coupled required state initialization and canonical exit status to an optional artifact sink
symptoms:
  - "tee: /opt/cursor/artifacts/full-catalog-10x10-stability.log: No such file or directory"
  - unavailable optional artifact directory masked proof status
  - stability proof exited before its canonical terminal result
tags:
  - cloudbench
  - fleet
  - artifact
  - tee
  - exit-status
sources:
  - commit dc40e91d0
  - commit 60bfe1b2e
  - fleet run capability-stability-20260910105116-2670724
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: fixed
---

## Problem

In the exact failed proof, `/opt/cursor/artifacts` was a symlink whose target
was unavailable in the older controller mount namespace. Outer and internal
`tee` processes printed `No such file or directory`. This did not cause the
inventory lock failure, but the proof wrapper could replace a valid benchmark
classification with artifact-I/O exit 1 or abort before writing canonical
state.

The permanent pre-fix command was
`bash scripts/tests/fleet-infra-stability-proof.test.sh`. Its broken-symlink
fixture exited 1 with
`FAIL: unavailable optional artifact directory masked proof status (exit=1)`
instead of reaching `CAPABILITY STABILITY PROOF PASSED`.

## Diagnosis

Critical path: initialize required proof state and optional artifact directory
in one `mkdir` → execute each slice and update `summary.json` → pipe terminal
output through optional `tee` → return a process status.

What: optional evidence storage could become the proof result. Where:
`scripts/run-fleet-infra-stability-proof`. Why: one fail-fast initialization
operation coupled the required state root to the optional sink, and the output
pipeline did not independently preserve both producer and sink statuses. Proof:
the symlink fixture changes only artifact reachability while the fake Fleet
still emits a valid passing run.

The deepest owned cause is a contract inconsistency: the durable state root is
required for classification, while the artifact copy is explicitly optional,
but both participated in the same success boundary.

## Solution

The proof now creates its required state root first. If the optional artifact
directory cannot be created or resolved as a directory, it reports the
condition and redirects the log copy into the state root. The terminal pipeline
captures both statuses with `set +e`, reports sink failure separately, and
returns only the canonical proof producer status. `summary.json` remains the
source of truth.

The unchanged regression and full stability-proof structural suite pass. At
10,000 agents this remains O(1) local setup and one output stream per proof,
with no per-agent state, scan, lock, shared row, or fan-in.

## Human feedback

The user explicitly classified artifact-path unavailability as independent of
the inventory root cause and required artifact logging to fail safely without
masking the run.

## Reusable lesson

Keep optional evidence sinks outside the canonical execution and exit-status boundary.
