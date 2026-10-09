---
id: 2026-10-07-campaign-hub-grouping-gate-assumed-local-tsx
date: 2026-10-07
title: Campaign Hub grouping gate assumed tsx was installed in back-end/node_modules
surface: harness
component: campaign-hub-grouping-gate
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/campaign-hub-grouping.test.sh executed back-end/node_modules/.bin/tsx without resolving the package
symptoms:
  - "campaign-hub-grouping.test.sh: line 7: back-end/node_modules/.bin/tsx: No such file or directory"
  - campaign-hub-grouping exit 127
tags:
  - npm-workspaces
  - dependency-resolution
  - tsx
  - deploy-structural-gates
sources:
  - PR #1417
  - commit 1853c0bd67c2cd1f73b05493816da23c0cd2404f
repro: scripts/tests/campaign-hub-grouping.test.sh
status: fixed
---

## Problem

After merging `origin/main` into the phone hold-queue branch, the deploy
structural runner reported `campaign-hub-grouping` with exit 127 on a Linux
cloud clone. Running `bash scripts/tests/campaign-hub-grouping.test.sh` directly
reproduced the same exit before any assertion ran.

## Diagnosis

The wrapper executed `back-end/node_modules/.bin/tsx` by absolute path. This
clone installed dependencies with the root workspace install, which hoisted
`tsx` to `node_modules/tsx`; `ls` showed `node_modules/.bin/tsx` present and
`back-end/node_modules/tsx` absent. The TypeScript test itself already used
`createRequire(back-end/package.json)` for its dependencies, so only the
wrapper's hard-coded location disagreed with valid npm layouts. This is the
inverse of `2026-08-03-backend-test-assumed-root-hoisted-tsx`: either fixed
location breaks under the other installation layout.

## Solution

The wrapper resolves the exported `tsx/cli` entry through Node's resolver from
`back-end/package.json` and runs it with `node`. The unchanged gate then passed
all eight tests. Package-owned resolution works for local and hoisted installs
alike. The change is test-only and adds no runtime work at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Resolve a test CLI through its owning package's exports; never hard-code either the local or the hoisted node_modules path.
