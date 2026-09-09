---
id: 2026-09-09-workspace-npm-ls-invalid-prunes-hoisted-tree
date: 2026-09-09
title: npm ls ELSPROBLEMS on installed URL packages retriggered workspace install and pruned vite
surface: harness
component: ensure-workspace-dependencies
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/ensure-workspace-dependencies.sh — treated npm ls exit 1 (invalid URL/tarball packages still on disk) as "need install"
symptoms:
  - npm error invalid: xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
  - npm error code ELSPROBLEMS
  - "removed 974 packages" during npm install --workspace=front-end
  - front-end/node_modules/.bin/vite missing after run.sh preflight
  - run.sh exited early with code 1 npm-run-all: not found
tags:
  - npm
  - workspace
  - vite
  - deploy
  - xlsx
  - elsproblems
sources:
  - PR #1293
  - commit db686562235f25d54e65206796a32995d15e9f61
repro: scripts/tests/workspace-dependencies.test.sh
status: fixed
---

## Problem

Group 4 `/deploy` stacks (smoke, AgentCard, semantic `run.sh --benchmark`) all
called `scripts/ensure-workspace-dependencies.sh front-end`. `npm ls
--workspace=front-end --depth=0` exited 1 with `ELSPROBLEMS` /
`invalid: xlsx@https://cdn.sheetjs.com/...` even after `front-end && npm ci`
left every direct dep on disk. The preflight then ran
`npm install --workspace=front-end`, which reported "removed 974 packages" and
deleted `front-end/node_modules/.bin/vite`. Concurrent stacks raced the same
tree (`Bus error` in `@swc/core`, `/tmp/fe-standalone` missing `npm-run-all`).

Local repro (same command as the cement test):

```
bash scripts/tests/workspace-dependencies.test.sh
```

Pre-fix: second boot with react+xlsx on disk and fake `npm ls` exiting 1
`invalid: xlsx@...` wrote `.install-calls` (retriggers workspace install).
Post-fix: that boot writes no install calls.

Archive searches: `npm ls invalid workspace install prune vite` and
`ensure-workspace-dependencies ELSPROBLEMS`. Relative of
`2026-07-24-root-npm-install-ignored-workspace-lockfiles` (wrong npm install
shape). Not a recurrence — that case was CI hydrate walking unlocked
workspaces; this one is a false-negative graph check on a healthy disk install.

## Diagnosis

Critical path: `run.sh` → `ensure-workspace-dependencies.sh` → `npm ls` →
`npm install --workspace=` → hoisted `node_modules` → Vite / FE boot.

Binary search:

1. Direct deps resolve on disk (`workspace_dependencies_resolve`). Data is
   correct here after `npm ci`.
2. `npm ls --depth=0` still exits 1 for URL/tarball specs and leftover
   workspace copies (`invalid:`). That is npm graph hygiene, not a missing
   install.
3. First-bad boundary: the preflight ANDed `npm ls` success with the disk
   resolver, so an `invalid` graph retriggered a mutating workspace install
   that pruned the hoisted tree.

Step 5a: the contract said "npm ls failure means incomplete install." That is
false for ELSPROBLEMS/invalid on packages that already resolve. Stop here.

## Solution

`workspace_npm_graph_ready` treats `npm ls` exit 0, or exit 1 that is only
`invalid:` / `ELSPROBLEMS` / `extraneous:` (no `missing:` / `UNMET DEPENDENCY`),
as a ready graph. Install still runs when the disk resolver fails or npm
reports unmet/missing deps.

Siblings prevented: any later `run.sh` / `/descend` boot that would have
re-pruned vite after a healthy `npm ci`.

10k-agent: one extra `npm ls` parse per workspace boot, no per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

Do not treat `npm ls` ELSPROBLEMS/`invalid` on installed URL packages as a
missing install — the disk resolver is the source of truth, and a follow-up
`npm install --workspace=` can prune a healthy tree.
