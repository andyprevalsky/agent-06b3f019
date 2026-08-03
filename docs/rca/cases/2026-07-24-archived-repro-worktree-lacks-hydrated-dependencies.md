---
id: 2026-07-24-archived-repro-worktree-lacks-hydrated-dependencies
date: 2026-07-24
title: Auto-RCA's archived reproduction worktrees could not reach agents/venv, so current HEAD falsely failed
surface: harness
component: auto-rca-workflow
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the trusted archived baseline/current reproduction worktrees — isolated source snapshots with no access to the hydrated Python/Node dependency graph
symptoms:
  - generated regression passes in the hydrated agent environment but fails in the trusted archive verifier
  - Auto-RCA reports current HEAD as failing when the reproduction actually passes
  - archived reproduction cannot access `agents/venv`
tags:
  - auto-rca
  - github-actions
  - worktree
  - dependency-hydration
  - false-failure
sources:
  - PR #888
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production Auto-RCA run 30070018445 reported the current-HEAD reproduction as
failing. It was not failing: the same generated regression passed when run with
the hydrated agent environment (`agents/venv`). The trusted archive verifier ran
the reproduction inside an isolated archived worktree that had no path to that
dependency graph, so an environment error was reported as a code failure — the
exact inversion Auto-RCA exists to avoid.

## Diagnosis

Auto-RCA verifies a generated regression twice: against the archived baseline
revision and against current HEAD, each in its own archived source snapshot for
isolation. Snapshot isolation was implemented as full isolation, including from
the interpreter/dependency environment that the rest of `/deploy` builds once —
so the reproduction ran without `agents/venv` (and without the hydrated Node
graph) and died on imports rather than on the defect. The deeper owned cause is
conflating _source_ isolation with _environment_ isolation: the trusted verifier
must run the unchanged reproduction in the same dependency environment as every
other gate, otherwise its verdict measures hydration, not behavior. The failure
output also did not print the full trusted baseline/current reproduction result
before failing, so neither Actions nor the Slack waterfall showed which of the two
was actionable.

## Solution

The archived baseline and current reproduction worktrees now share the
already-hydrated Python and Node dependency graph while keeping isolated source
snapshots, and the workflow prints the complete trusted baseline/current
reproduction result before failing so the actionable side is identifiable from
Actions and the Slack waterfall. Verified by the Auto-RCA workflow contract and
lifecycle blackbox tests, plus re-running the PR #877 generated regression against
current code with the hydrated `agents/venv`.

## Human feedback

None recorded.

## Reusable lesson

Isolate the _source_ of a verification worktree, never its dependency
environment — a verifier that re-derives its own interpreter/venv will report
missing-dependency errors as code regressions.
