---
id: 2026-10-19-gate-root-custody-left-repo-context-root-owned
date: 2026-10-19
title: Root workspace custody left the controller repo .context unwritable
surface: infra
component: run-cloudbench-controller-gate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: guest gate root-phase workspace custody created /tmp/gate/repo/.context as root after handing /tmp/gate to the runtime user
symptoms:
  - "PermissionError: [Errno 13] Permission denied: '/tmp/gate/repo/.context/original600-supervisor.<id>.tasks.json'"
  - all 3 sharded controller gates failed at step 1 (GATE_STEP_FAILED 1)
  - supervisor never published; controllers and 256 GB workspaces retained
tags:
  - cloudbench
  - controller-gate
  - permissions
  - original600
sources:
  - commit cf20da936 (custody block) and 79a79d605 via PR #1525 (runtime writes under .context)
  - fleet run original600-1792402040642867509
  - PR #1525
repro: python3 scripts/tests/run-deploy-structural-gates.test.py -k test_root_workspace_custody_leaves_repo_context_writable_by_runtime_user
status: fixed
---

## Problem

The post-deploy check of PR #1525 (`/benchmark 70 random polar tasks, with a
5 min execution timeout`) admitted three sharded controllers. Every controller
gate failed at step 1. The step log showed a `PermissionError` on
`/tmp/gate/repo/.context/original600-supervisor.<id>.tasks.json`. No supervisor
started and no task ran.

## Diagnosis

The generated guest script runs `chown -R rose:rose /tmp/gate` and then, still
as root, writes workspace custody to
`/tmp/gate/repo/.context/controller-workspace-volume/ownership.json` using
`mkdir(parents=True)`. The repository is a fresh `git init` checkout, so
`.context` does not exist yet. Root creates it with mode 0755. Each step runs
as `rose` (`gosu rose`). The original600 launcher (79a79d605, merged with
#1525) writes its supervisor tasks, identity and barrier under
`/tmp/gate/repo/.context`, so its first write fails. The custody block had
been latent since cf20da936. It broke when a runtime step first needed to
write in `.context`.

Archive searches for "Permission denied .context root owned gate chown rose"
and "NOT_PUBLISHED supervisor" found no prior case for this boundary. This case
is new.

## Solution

The custody block now creates `.context` itself. It refuses a non-directory or
a symlink. It then gives `.context` the repository owner's uid and gid. Only
`controller-workspace-volume` stays root-owned with mode 0700, so the
custody record keeps its original protection. After the initial review, every
step after opening `.context` uses directory file descriptors (`O_NOFOLLOW`,
`fchown`, `dir_fd` mkdir/open/fsync), so a runtime-user rename or symlink
between steps cannot redirect the root-owned writes.

The regression in `run-deploy-structural-gates.test.py` captures the actual
generated guest script from the gate. It asserts that custody runs after the
ownership handoff, then runs the extracted custody block as real root via
`sudo -n`, the same way the suite's foreign-uid case does. It then writes a
supervisor file as the runtime user. On origin/main it fails with the
production `PermissionError`; with the fix it passes. A second case plants a
symlinked `.context`, a file `.context`, and a pre-existing or symlinked
custody entry as the runtime user, and requires root to refuse without writing
through them. The deploy structural registry runs this suite.

## Human feedback

Pending (PR for Andy's review; no merge or deploy).

## Reusable lesson

Any root step after a privilege handoff must not create shared parent
directories implicitly. Create them explicitly with the runtime owner, and keep
root ownership only on the exact private leaf.
