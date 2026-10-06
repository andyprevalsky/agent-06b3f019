---
id: 2026-10-05-image-build-exited-before-owned-publisher-drain
date: 2026-10-05
title: Image-build cancellation exited before joining its owned publisher
surface: infra
component: cloudbench-image-build
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-cloud image-only branch launched its foreground publisher before controller signal and cleanup supervision existed
symptoms:
  - run-bench image-build exited on TERM while its publisher shell and flyctl survived
  - owned publisher states after CLI exit were live and live
  - publisher descendants remained in the original controller process group
tags:
  - cloudbench
  - image-build
  - cancellation
  - process-ownership
  - orphaned-publisher
sources:
  - PR #1299
  - agent /root independent fresh CLI validator 2026-10-05
  - agent /root/image_cli_cancel controlled owning CLI reproduction
repro: agents/benchmarks/cloudbench_image_build_test.py::test_cloudbench_image_build_cli_cancellation_joins_only_owned_publishers
status: fixed
---

## Problem

An independent fresh uncached native CLI validator sent TERM to its exact
controller. The controller exited with signal status -15, but its original
publisher shell and Fly client remained alive 31 seconds later, with matching
native births and the original controller process group. Private source
artifacts remain under `.context/fresh-cli-validation-20261005/cold-image-*`.
The validator recovered only those exact local requests; no shared Fly builder
was changed.

## Diagnosis

The path is `run-bench image-build` exec delegation → `run-bench-cloud`
image-only branch → `build_warm_image` publisher subshell → Fly client. The
image-only branch runs before the ordinary task controller installs its EXIT
and signal traps. A signal to the owning CLI therefore exits the shell without
joining or retiring its publisher descendants. No provider failure is required.

The existing owning image-build suite now executes the actual CLI with the real
publisher helper and a controlled local provider that spawns a descendant. Both
default Depot and explicit native reproduced the failure: after exact CLI TERM
and controller exit, both captured native births remained executing. An
unrelated same-process-group sibling stayed live throughout. The unchanged
assertion proves cancellation ownership rather than cold-build speed or any
benchmark task outcome.

Archive searches were `image-build TERM publisher flyctl` and `controller exits
orphan child process cancellation`. Native transport and post-push metadata
cases are relatives on the same image path, but concern provider requests and
publication retry, not missing CLI supervision. Detached-helper and fixture
orphan cases concern other owners. No existing case covers this first-bad
image-only boundary. Git history contains no existing image cancellation repair.

The deepest proven owned gap is the absent parent cancellation contract for this
branch. Its previous controls exercised arguments, image receipts and errors,
but never signaled the supported owning CLI. Reusing the existing process-tree
ownership primitive removes the need for a separate cancellation implementation.

## Solution

The image-only branch installs EXIT/HUP/INT/TERM supervision before launching
its complete publication and receipt path as one tracked child. The parent waits
for that exact child and preserves its ordinary exit status. On cancellation,
the existing `cloudbench_terminate_tree_and_wait` captures native descendant
births, signals only those births, verifies terminal execution and joins the
owned root before CLI exit. Cleanup retains the existing 30-second child grace;
an unverified cleanup returns failure. The launch-to-PID-assignment interval
uses the shell's last exact asynchronous child identity. Child traps are reset,
and repeated signals cannot interrupt the parent while it drains ownership.

This one parent boundary also covers cancellation during publisher installation,
input capture and publication. Source recipes, dependencies, app settings,
ordinary 7,200-second execution budgets and provider operations are unchanged.
There is no remote builder cleanup. At 10,000 agents, image cancellation adds
one local tracked child per explicitly requested image operation and performs
native tree observation only during that operation's cancellation; no shared
runtime state, model calls or agent hot-path work is added.

## Verification

The exact command was
`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_image_build_test.py -k cli_cancellation`.
Before the fix: two failures in 1.13 seconds, each asserting
`owned publisher states after CLI exit: ['live', 'live']`.
After the fix: both unchanged cases passed in 1.27 seconds. They also require
signal exit 143, a surviving unrelated same-group sibling and no completed-image
or publication receipt from interrupted work. Fixture observations allow 60
seconds and retry unknown native reads; terminal zombies are distinguished from
executing descendants. Fixture cleanup is restricted to captured native births.

The complete image-build, image-CLI and installer controls passed 58 tests in
9.80 seconds. Bash syntax, Ruff lint/format and diff whitespace checks passed.
The existing `cloudbench_image_build` selector in
`scripts/tests/benchmark-live-results.test.py` includes both cases in the normal
compact deploy gate; no new suite or live validation stage was introduced.
Private red/green output stays under `.context/image-cli-cancellation/`.
Independent review and fresh runtime measurements are owned by the root agent;
local controls do not relabel the interrupted cold build as a successful timing.

## Human feedback

The user requested parallel optimization, safe interruption at any time, quick
regressions in the normal deploy path, and unchanged benchmark results. The
controller owner required exact local descendant supervision, preservation of
ordinary generous budgets, an untouched unrelated-process control, and no
shared builder cleanup or funded calls in this reproduction.

## Reusable lesson

Install cancellation supervision before launching an image publisher and join
its exact owned local descendants before allowing the owning CLI to exit.
