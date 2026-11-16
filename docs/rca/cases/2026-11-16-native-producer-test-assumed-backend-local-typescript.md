---
id: 2026-11-16-native-producer-test-assumed-backend-local-typescript
date: 2026-11-16
title: Native producer test bypasses Node package resolution with backend-local dependency path
surface: harness
component: deploy-native-producer-regression
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: deploy-e2b-termination-producer.test.cjs requires a backend-local node_modules directory absent on native workers
symptoms:
  - "Cannot find module '../../back-end/node_modules/typescript'"
  - "deploy-structural-gates:deploy-e2b-termination-producer 0/5"
tags:
  - deploy
  - typescript
  - dependency-resolution
  - native-worker
sources:
  - PR #2404
  - commit edb308dfecccee537ffe7e03bf4d4308eca7dc51
repro: scripts/tests/deploy-e2b-termination-producer.test.cjs
status: open
---

## Problem

Final native new-test-stability on edb308df failed the new termination producer
before any assertion: Cannot find module '../../back-end/node_modules/typescript'.
The schema regression, native completion collector and existing producer each
passed their five native runs. Native occurrence3d1be3710af44b29a727bc26a78d8bb3
and its original log remain UNVERIFIED/completefalse at the aggregate boundary.

## Diagnosis

Gate INTRODUCED: the new test imported TypeScript through a literal filesystem
path into back-end/node_modules. Local backend dependencies existed, masking the
assumption. Native dependencies are installed/hoisted at repository root, where
Node's ordinary package resolver finds the same pinned TypeScript5.9.3. Neither
a provider outage nor a missing declared dependency caused this test bug.
Archive searches and actual case reads distinguish the Oct7 omitted hoisted
root-tree case and Nov3 missing jpeg-js install: here the root dependency is
present and pinned; the new test bypassed normal resolution.

A private checkout-shaped fixture links only the verified root node_modules,
keeps backend/node_modules absent and reads frozen actual runner source. The
unchanged original test fails with the exact native module error. Replacing
only the require target with the package name passes the same actual runner
exit/signal/timeout/spawn-error/two-attempt assertions five times unchanged.
No assertion, timeout, fixture output, dependency version or native attempt is
removed. Canonical application occurred after active native consumers finished.

## Solution

Use require('typescript') so Node resolves the declared pinned package through
its normal parent directories. Preserve exact producer assertions. Five
private stable runs and independent source/layout/flakiness review are repair
evidence; canonical five runs passed; required native qualification remains open.
The harness implementation and its e2b-completion-2 scoped approval are unchanged.
This test-only path has no production agent behavior or10000-agent scaling cost.

## Human feedback

None recorded.

## Reusable lesson

Resolve declared packages through the runtime module resolver and reproduce native dependency layouts before qualifying a harness test.
