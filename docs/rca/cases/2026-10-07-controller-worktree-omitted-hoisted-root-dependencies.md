---
id: 2026-10-07-controller-worktree-omitted-hoisted-root-dependencies
date: 2026-10-07
title: Controller worktree reused package trees but omitted hoisted root dependencies
surface: harness
component: mac-controller-setup
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: local controller setup linked package node_modules but omitted the installed root node_modules required by back-end/scripts/seed-dump-cache.ts
symptoms:
  - Cannot find module 'dotenv'
  - back-end/scripts/seed-dump-cache.ts
  - fifty tasks rejected before execution
tags:
  - npm-workspaces
  - dependency-resolution
  - worktree
  - seed-dump-cache
  - setup
sources:
  - commit f8ea6cfa06d632437ed21081e9da4823d4d33778
  - fleet run 20261007-210557-58831
  - plan:.context/daily-live50/control10-20261007/setup-import-proof.safe.json
  - plan:.context/daily-live50/control10-20261007/closure.safe.json
repro: back-end/scripts/seed-dump-cache.ts imported by the unchanged readiness command in Diagnosis; native RED/GREEN in .context/control10-setup-docs.private/backend-import-{red,green}.safe.json
status: mitigated
---

## Problem

The original uncached-image DAILY fifty-task control failed during canonical
seed preflight. The actual producer's require stack points to
`back-end/scripts/seed-dump-cache.ts:39`, its `dotenv` import. All fifty tasks
were rejected with error outcomes before execution; no model calls occurred.
The image publication succeeded in 577 seconds and exact-image activation
succeeded. Original controller exit 1 and failed cleanup status remain intact.
Durable failed-group publication and verified full resource release completed
1,088.096 seconds after the first image invocation. Acceptance credit is zero.

## Diagnosis

The fresh Mac worktree reused the healthy agents venv and backend, frontend and
Mac package dependency trees, but omitted root `node_modules`. Fresh clone setup
described package-directory installation without explaining reuse of an existing
npm workspace's hoisted tree. In that installed layout, the backend declares
`dotenv`, but npm placed its implementation at repository-root
`node_modules/dotenv/lib/main.js`. A package tree's presence did not establish
that the producer could load its dependency graph.

The same native Node 22.13.0 `require.resolve('dotenv')` command exited 1 before
adding the fresh worktree's root link, then exited 0 resolving the installed root
package after adding it. No source, manifest, installation or provider state
changed. A separate documentation worktree reproduced the boundary more
directly with the proposed readiness command:

```bash
(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts'); console.log('backend seed-cache imports ready')")
```

With only the matching package trees linked, this actual producer import failed
with missing `dotenv`; adding the existing root tree made the unchanged command
exit 0. The helper's CLI guard excludes `node -e`, so the check performs no seed
GET/PUT, env-file load or task execution. Seven tracked dependency inputs matched
the installed checkout before reuse. This proves the setup boundary, not a
passing benchmark outcome.

Archive searches used `Cannot find module dotenv seed-dump-cache` and
`worktree hoisted node_modules dependency layout preflight`. The August 3
root-hoisted `tsx` test case hard-coded a CLI location; the October 6 fresh-guest
Prisma case copied only the root tree. Their first-bad boundaries differ from
this local setup omission, so this is a separate case.

Golden-reference inspection found the same layout principle in
`hermes-agent/hermes_cli/main_tui_launch.py:89` and `:132`: select the actual
workspace context and resolve dependencies through ancestor `node_modules`
instead of treating one directory as the whole graph. OpenClaw resolves its
installed loader relative to the consumer in
`openclaw/src/infra/openclaw-cli-invocation.ts:27`. Searches of the available
vendored Claude Code source found no direct worktree-reuse analog; a local Codex
reference checkout was unavailable. These references support preserving the
installed layout; they do not establish Rose's benchmark outcome.

## Solution

Fresh clone setup now explains reuse of matching healthy root and package trees
with the activated agents venv, and both npm hoisted and package-local layouts.
The existing cold-run guides point to a cheap actual seed-cache import check
before the first image measurement. This check stays outside image-only
publication. It adds no install, network call, task replay or verification
framework. Runtime, tests, prompts, evaluators and budgets are unchanged.

The current setup is repaired locally. The original fifty-task control remains
failed and immutable; it was not relaunched. This case remains mitigated until a
new independently authorized ordinary run demonstrates the unchanged task
outcome and full closure. The separate CLI readiness repair is not claimed here.


### Independent source qualification

The final documentation was committed and uploaded as
`3e578c324d211be11df35a5b6c542d2b1ef21d5c`. Independent review verified the
frozen five-file patch and original import RED/GREEN receipts, and imported
the actual seed-cache producer successfully. This qualifies the setup guidance;
the original C10 remains failed and fully released with zero credit.

## Human feedback

None recorded.

## Reusable lesson

Preserve the installed root and package dependency layout when reusing a matching
workspace, and import the real backend producer before starting fleet timing.
