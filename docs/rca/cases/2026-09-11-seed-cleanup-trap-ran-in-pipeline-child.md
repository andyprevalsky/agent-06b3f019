---
id: 2026-09-11-seed-cleanup-trap-ran-in-pipeline-child
date: 2026-09-11
title: Seed progress interpolation invoked database cleanup from a pipeline child
surface: infra
component: measure-seed-memory
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/measure-seed-memory.sh cleanup_all inherited EXIT trap
symptoms:
  - SRC_DB unbound variable
  - source restore produced no Cookie rows for seed user
  - wait_for No record of process
tags:
  - bash
  - utf8
  - cleanup-ownership
  - cold-seed
sources:
  - PR #1299
  - commit 81e79b450258687795af9271798101c3e2ea73c8
repro: scripts/tests/seed-memory-ratchet.test.sh
status: fixed
---

## Problem

The first cold-seed gate after recovering Docker from host disk exhaustion failed
before restoring its source. The measurement shell PID was 97756; its progress
pipeline emitted a nounset error whose variable name included the first UTF-8
ellipsis byte. Source Cookie count was zero. Runtime evidence is retained under
`.context/acceptance/cold-seed-resume-rca/`; no secret contents are included here.

## Diagnosis

The path was cached dump → progress pipeline → source restore → Cookie count.
The first wrong boundary was an unbraced shell variable directly adjoining a
Unicode ellipsis. The exact statement failed under C.UTF-8 and en_US.UTF-8 on
both macOS Bash 3.2 and Homebrew Bash 5.3.15, and passed under C.

The parent uses `set -uo pipefail`, so this pipeline failure does not abort it.
Instead, its child inherited the EXIT trap and dropped the parent's PID-scoped
source and target databases before the parent continued to pg_restore. A fixture
extracting the actual cleanup functions and stubbing only dropdb proved that
ordering. Both `$$` and `BASH_SUBSHELL` can retain parent values in this fatal
expansion trap: a BASH_SUBSHELL guard was reproduced failing. A fresh direct
`/bin/sh` child's PPID distinguishes the physical shell executing the trap.

Searches for `SRC_DB unbound variable`, `seed source restore Cookie rows`, and
Unicode/locale symptoms found no matching cause. The archive-format restore
case was a relative, not this incident. The deepest owned cause was treating
inherited shell cleanup as proof of resource ownership. Changing the locale or
swallowing restore failures would leave that ownership defect intact.

## Solution

The progress statement uses printf with a separate value argument. Cleanup
checks the physical shell identity before touching either exact owned database
or container. This is one constant-time ownership check per cleanup, outside
all agent hot paths; it adds no per-agent polling, shared state, or contention
at 10,000 agents. Removing the cleanup trap would leak resources, so a narrow
ownership check is necessary.

`bash scripts/tests/seed-memory-ratchet.test.sh` now runs the real progress and
an independent failing pipeline as separate first-pipeline cases under three
locales. It asserts exact output/status and exactly one final owner cleanup,
after parent continuation. The pre-fix regression was red; the same suite is
green under both Mac Bash versions. A successful earlier pipeline made an early
experimental control falsely green; that control is explicitly excluded from
causal evidence. Independent review approved the final tests and ownership
check in `independent-review-final.json`.

The actual gate subsequently restored 21,244 source Cookies, proving this
boundary repaired. It then exposed a separate COPY protocol/completion defect
recorded in `2026-09-11-seed-copy-protocol-and-late-child-completion`. After repairing that second defect, the unchanged five-cold-seed gate passed
with full fidelity and a maximum156MB peak against230MB. This provides no cloud
acceptance credit. The regression runs in the existing deploy-command
structural gate.

## Human feedback

The user requested finishing without repeated permission requests after storage
was unlocked. The five-minute per-task acceptance limit and all other bounds
remain unchanged; this fix does not change benchmark definitions or timeouts.

## Reusable lesson

Verify physical cleanup ownership before an inherited shell trap can delete parent-owned resources.
