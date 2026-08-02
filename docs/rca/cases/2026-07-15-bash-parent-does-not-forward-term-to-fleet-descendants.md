---
id: 2026-07-15-bash-parent-does-not-forward-term-to-fleet-descendants
date: 2026-07-15
title: SIGTERM to `run-predeploy-cloud` never reached the fleet, orphaning paid Fly machines
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: run-predeploy-cloud — bash does not forward signals to a foreground child, so run-bench-hub-poller → run-bench-fleet never received TERM and its cleanup trap never fired
symptoms:
  - killing run-predeploy-cloud leaves run-bench-fleet clones and autoscaler workers running
  - leaked Fly machines on the shared navi-whisper-lux-bench app bleed cost until reaped by hand
tags:
  - cloudbench
  - fly-io
  - signal-handling
  - resource-leak
  - teardown
sources:
  - commit f13bf3788
  - memory:project_cloudbench_teardown_clone_retry_fixes
repro: none-recorded
status: fixed
---

## Problem

During the AgentCard payment deploy, killing `run-predeploy-cloud` did not stop
the cloud fleet. Its clones and autoscaler workers kept running and billing on
the shared `navi-whisper-lux-bench` Fly app until they were reaped by hand.

## Diagnosis

`run-predeploy-cloud` ran `run-bench-hub-poller` (which in turn runs
`run-bench-fleet`) as a foreground child. Bash does not forward signals to a
foreground child, and macOS has no `setsid`, so a SIGTERM delivered to
`run-predeploy-cloud` terminated only the top-level script. The fleet process
never saw the signal, so the fleet's own cleanup trap — the thing that destroys
clones and autoscaler workers — never fired. The deeper owned cause is that
resource ownership (paid machines) lived in a descendant process whose lifetime
was not tied to any signal the operator could actually deliver.

## Solution

`run-predeploy-cloud` now backgrounds the poller and installs INT/TERM traps
that walk the descendant tree via `pgrep -P` recursion, SIGTERM the fleet so its
cleanup destroys its own clones, and then wait bounded for drain (commit
f13bf3788). This also prevents the sibling case of a user Ctrl-C'ing the
pre-deploy gate mid-run. When a fleet is nevertheless orphaned, the recorded
manual recipe is: kill only your own fleet PIDs by filtering `ps -o args=` for
your worktree path (skipping other workspaces' paths), take machine ids from
`.context/fleet/runs/<runid>/owned-clones.ids` and `*/worker-clones.ids`, and
destroy only those with the org token from `~/.fly/config.yml` (the app-scoped
`agents/.env` FLY_API_TOKEN cannot see the bench app).

## Human feedback

The human was emphatic that the shared Fly bench app is multi-tenant across
workspaces: never blanket-"destroy all non-warm machines", because that nukes
another workspace's live run. Cleanup must be scoped to machine ids this run
owns.

## Reusable lesson

Any wrapper script that owns paid remote resources through a child process must
trap INT/TERM and forward the signal down the descendant tree itself — bash will
not do it for you, and the child's cleanup trap is the only thing releasing cost.
