---
id: 2026-09-30-e2b-smoke-command-targeted-stack-database
date: 2026-09-30
title: Deploy E2B smoke command named the stack database instead of its isolated test database
surface: harness
component: .claude/commands/deploy.md
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: .claude/commands/deploy.md Step 6c constructed BLACKBOX_TEST_DATABASE_URL with /victoria and a shell-local DB port while standalone blackbox requires the isolated workspace database on the active stack runtime port
symptoms:
  - 'Standalone blackbox DATABASE_URL must name the local victoria_singapore database.'
  - 'Step 6c Claude Code E2B smoke exited before creating a sandbox.'
tags:
  - deploy
  - e2b
  - blackbox
  - postgres
sources:
  - PR #1344
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

Step 6c's prescribed command failed before creating a real E2B sandbox:
`Standalone blackbox DATABASE_URL must name the local victoria_singapore
database.` The failure is captured in
`.context/deploy-runs/20260930-235404-20524/logs/claude-code-e2b-smoke-20261001-005520-84771.log`.

## Diagnosis

The command in `.claude/commands/deploy.md` supplied `/victoria` because that
is the running stack database. It also assumed the `LOCAL_DB_PORT` export from
Step 5 would survive into a fresh shell. The standalone blackbox runner deliberately
requires `/victoria_<workspace>` so fixture writes cannot damage the stack; its
preflight rejected the URL before any sandbox work. This is a conflict between
the deploy instruction and the blackbox isolation contract. The corrected URL
passed preflight; the real E2B smoke then reported `PASS smoke -- Claude Code
answers 2+2 (real E2B sandbox)`.

Archive searches: `Standalone blackbox DATABASE_URL must name the local
victoria_singapore database` and `E2B smoke deploy command victoria workspace
test database URL`. The closest case,
`2026-07-13-local-test-db-resolver-fails-open-to-shared-postgres`, established
the isolated test DB contract; this command had not followed it.

## Solution

Step 6c now names `victoria_$CONDUCTOR_WORKSPACE_NAME` and resolves the live
stack's database runtime port in each fresh shell via
`scripts/resolve-deploy-stack-db.sh`. That helper checks the manifest's
worktree, running status, and numeric ports, including the system Postgres
case where the runtime port is 5432 rather than the allocated Docker port.
The structural test checks Docker, system Postgres, and unusable manifests.

The same structural command proves the before/after boundary:

```sh
git show e8fc86eec2ef87f0f96c869b6c009ee8fda2caa2:.claude/commands/deploy.md > .context/deploy-command-under-test.md
DEPLOY_COMMAND_OVERRIDE="$PWD/.context/deploy-command-under-test.md" bash scripts/tests/semantic-deploy-gate.test.sh
# exit 1: FAIL: /deploy E2B smoke must fail closed when it cannot resolve the running stack
cp .claude/commands/deploy.md .context/deploy-command-under-test.md
DEPLOY_COMMAND_OVERRIDE="$PWD/.context/deploy-command-under-test.md" bash scripts/tests/semantic-deploy-gate.test.sh
# exit 0: All semantic deploy gate checks passed.
```

The Step 6c command, invoked with `LOCAL_DB_PORT` unset, then passed the live
E2B check. `.context/test-runs/1790824018-95828-16000/claude-code.log`
contains `PASS smoke -- Claude Code answers 2+2 (real E2B sandbox)`; the deploy
stage log is `.context/deploy-runs/20260930-235404-20524/logs/claude-code-e2b-smoke-20261001-030658-95697.log`.
This changes only deploy invocation; running agents are unaffected.

## Human feedback

None recorded.

## Reusable lesson

Make operator commands obey the fixture isolation contract enforced by the test harness.
