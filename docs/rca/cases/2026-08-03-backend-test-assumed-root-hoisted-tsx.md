---
id: 2026-08-03-backend-test-assumed-root-hoisted-tsx
date: 2026-08-03
title: Backend seed-cache unit test assumed tsx was hoisted to the repository root
surface: harness
component: backend-unit-test-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/unit/seed-dump-cache.test.ts resolved tsx from the repository root instead of the owning package
symptoms:
  - R2 deadline test never reached the hanging endpoint
  - This is not the tsc command you are looking for
tags:
  - npm-workspaces
  - dependency-resolution
  - tsx
  - seed-dump-cache
sources:
  - commit 067e37787b8c66ea97e407d27f4bc577c8ab341e
repro: back-end/src/tests/unit/seed-dump-cache.test.ts
status: fixed
---

## Problem

The backend coverage gate failed `seed-dump-cache.test.ts` with `R2 deadline
test never reached the hanging endpoint`. The unchanged focused command
`node --import tsx src/tests/unit/seed-dump-cache.test.ts` reproduced the same
assertion locally. In the same deploy run, `npx tsc --noEmit` initially selected
the unrelated placeholder `tsc` package, confirming that the workspace had no
repository-root dependency installation.

## Diagnosis

The deadline test spawned Node with an absolute CLI path built as
`../../../../node_modules/tsx/dist/cli.mjs`. From the test directory, that path
lands in repository-root `node_modules`, but `tsx` is declared by the backend
package and was installed in `back-end/node_modules`. `ls` proved the root CLI
did not exist while the backend CLI did. The child therefore exited with module
resolution failure before it could contact the local hanging server, making the
downstream `requestObserved` assertion fail. The deepest owned cause was a test
harness dependency-location assumption that was stricter than npm's valid
workspace installation layouts.

## Solution

The test now resolves the exported `tsx/cli` entry through Node's module
resolver, so dependency ownership rather than hoisting decides the path. The
unchanged focused test then passed all seven assertions, including the hanging
endpoint deadline. This also prevents failures under any other npm layout that
keeps workspace dependencies local. The change is test-only and has no runtime
work, queries, channels, locks, or per-agent cost at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Resolve test CLIs through their package exports instead of assuming a workspace dependency was hoisted to a particular node_modules directory.
