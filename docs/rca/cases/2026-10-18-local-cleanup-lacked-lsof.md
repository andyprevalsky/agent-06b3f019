---
id: 2026-10-18-local-cleanup-lacked-lsof
date: 2026-10-18
title: Local cleanup tests lacked the required lsof executable
surface: infra
component: devbox-benchmark-prerequisites
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The devbox PATH had no lsof executable for process ownership and listener observations
symptoms:
  - manifest-owned process survived cleanup
  - owned listener was not discovered
tags:
  - local-benchmark
  - prerequisites
  - cleanup
sources:
  - task Phone Harness registered checker validation
  - commit afdb8b7cb
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The normal `benchmark` blackbox domain failed two existing process-cleanup
controls. It could neither establish the owned process's working directory nor
discover its listening socket. The test-owned server and connected client were
real subprocesses, and their normal fixture cleanup joined both. No live phone
or benchmark stack was active.

## Diagnosis

The failing command was `cd agents && source venv/bin/activate && python
scripts/run_blackbox_tests.py benchmark`, run
`20261018-225941-657459-737733b8`. The unmodified tests reported
`manifest-owned process survived cleanup` and `owned listener was not discovered`
in `.context/phone-harness/isolation-checker-normal.log`.

`_port_listener_pids` and `_pid_cwd_under_worktree` call `lsof`; `command -v lsof`
returned no executable. Their conservative failure results correctly avoided
signalling a process without ownership evidence. The defect was the missing
documented prerequisite, not overly strict process ownership.

Archive searches were `lsof missing cleanup prerequisite` and `process ownership
prerequisite missing executable`. Read the listener-classification and
observer-preservation cases from 2026-09-11. They are related controls, but this
incident failed before either classification could run. The existing
`scripts/cloud-init.sh` already installs lsof through `ensure_apt lsof lsof`.

## Solution

Installed the existing required package with `sudo -n apt-get install -y lsof`.
The package was previously uninstalled; `/usr/bin/lsof` is now available. No
production code, process ownership rule, assertion, timeout, or task criterion
was changed. In particular, no fallback treats failed observation as permission
to signal a process, and no unrelated process was terminated.

Both exact existing control functions then passed in
`.context/phone-harness/isolation-lsof-owning-green.log`: the owned listener was
found and retired, the connected client remained alive, and an observer that
merely mentioned the run ID remained alive. The final same-command registered
suite rerun passed in 217.6 seconds, with all registered controls including both
cleanup tests green. Log: `.context/phone-harness/isolation-checker-normal-green.log`.

At 10,000 agents this makes the existing observation mechanism available; it
adds no runtime query, service, shared state or cleanup broadening. The normal
registered tests and existing cloud initialization remain the durable checks.

## Human feedback

None recorded for this configuration defect. The user's phone rollout condition
requires main trajectories to remain unchanged.

## Reusable lesson

Restore the documented observation prerequisite before changing conservative
cleanup ownership rules. Failure to inspect a process never proves it is safe
to terminate.
