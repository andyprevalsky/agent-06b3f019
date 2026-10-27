---
id: 2026-07-25-floating-dep-spec-without-frontend-lockfile-breaks-render-build
date: 2026-07-25
title: Render's backend build re-resolved the unlocked repo-root workspace graph from the live registry, so new upstream publishes (and clean checkouts) failed every build
surface: front-end
component: render-backend-build
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Render build command `npm install` (rootDir back-end) — npm walks up to the repo-root workspace, which has no committed lockfile, and resolves every workspace from the live registry instead of installing back-end/package-lock.json
symptoms:
  - ERESOLVE aborts `npm install` at the workspaces root
  - a merged PR never goes live and prod stays on the prior good instance
  - "No matching version found for @inquirer/ansi@^2.0.10"
  - "Cannot read properties of null (reading 'edgesOut')"
tags:
  - npm
  - eresolve
  - lockfile
  - render-build
  - dependency-pinning
  - npm-workspaces
  - reproducible-build
sources:
  - PR #893
  - task S15 reproducible Render build (100-seat readiness audit)
  - commit 364e9bb81 (Render deploys dep-dbfv8mnb9u1s73fndoug, dep-dbfvb5mk1f9s73as58ig)
repro: scripts/tests/render-backend-build.test.sh
status: open
---

## Problem

Every Render backend build failed, because Render installs the monorepo from the
workspaces root and that install aborted with ERESOLVE. The blast radius included
the PR #872 merge, which never reached production — prod simply stayed on the
prior good instance, so the failure looked like "the deploy did nothing" rather
than a build error.

## Diagnosis

`front-end/package.json` declared `@hookform/resolvers: ^5.1.1` and the front-end
has no lockfile, so a fresh root `npm install` was free to resolve whatever was
newest. It picked the newly published `5.4.2`, which added a
`peerOptional valibot@^1.0.0` requirement. The tree already contains
`valibot@0.39.0` (pinned transitively via `@typeschema/valibot@0.14.0`), so the
peer set is unsatisfiable and npm aborts the whole install — including the
back-end's, since it is the same root install. The deeper owned cause is a caret
range on a package whose peers can change between minors, with no lockfile
anywhere to freeze the resolution: the build's dependency graph was therefore a
function of npm registry state at build time, not of the committed repo. `5.4.1+`
all require `valibot ^1.0.0`; `5.4.0` is the last release whose only peer is
`react-hook-form`.

### Recurrence 2026-10-27: ETARGET on a fresh upstream publish

Render builds of merge `364e9bb81` failed twice (00:51Z and 00:55Z) with
`npm error code ETARGET` / `No matching version found for @inquirer/ansi@^2.0.10`.
`@inquirer/core@12.0.6` was published at 00:50:47Z depending on `^2.0.10`, and
`@inquirer/ansi@2.0.10` followed at 00:51:03Z. No Rose manifest changed; a
development dependency of another workspace re-resolved mid-publish. Pinning
`@hookform/resolvers` in July fixed one instance, not the cause.

The deepest owned cause is the build command itself. Render runs
`npm install && npm run prisma:generate && npm run build` with `rootDir: back-end`.
`back-end` is an npm workspace member of the repo root (`workspaces:
[back-end, front-end, agents]`), whose `package-lock.json` is deliberately
untracked (#63). npm therefore ignores the committed `back-end/package-lock.json`
and resolves the whole workspace graph, including front-end and agents tooling,
from the registry on every build. Render only builds today because its restored
809 MiB build cache seeds `node_modules`. Reproduced on a clean export of main:
the same `npm install` crashes arborist with `Cannot read properties of null
(reading 'edgesOut')`, so clearing Render's build cache would block every
backend deploy. A member `.npmrc` cannot fix this, because npm reports
"ignoring workspace config" for it, and a root `.npmrc` or lockfile would change
every other workspace's install.

## Solution

Pinned `@hookform/resolvers` to exactly `5.4.0` in `front-end/package.json` — the
last version before the valibot peer was introduced. Verified that a root
`npm install` resolves cleanly (exit 0, no ERESOLVE) with `5.4.0` selected and
that `cd front-end && npm run build` succeeds in about 10s; `5.4.0` is also the
version present during the workspace's full green gate run. Prevents the sibling
class of failure where any newly published minor of a lockfile-less workspace
dependency takes down the shared root install and therefore the back-end deploy.


2026-10-27: `back-end/scripts/render-build.sh` is now the committed Render build.
It runs `npm ci --workspaces=false` against `back-end/package-lock.json`, then
`prisma:generate` and `build`. Render's build command becomes
`bash scripts/render-build.sh`, a one-time dashboard change pending approval;
the case stays open until that is applied. The command matches the documented
fresh-clone fallback (`npm ci --workspaces=false` in `back-end/`), so devbox,
Mac and Render installs of the backend share one lockfile. Local root workspace
installs are unchanged.

Regression: `scripts/tests/render-backend-build.test.sh` (deploy structural
registry). It runs the script on a clean source copy under Render's
`NODE_ENV=production`. It asserts that no repo-root workspace is installed, the
lockfile is byte-identical (`npm ci` also fails on a stale lock), and
`dist/bootstrap.js` exists. It also asserts that every runtime import in
`dist/` resolves from `back-end/node_modules`, so nothing depends on hoisting.
Fail-before: the same test with Render's current `npm install` command exits on
`edgesOut`. Five consecutive passes.

Scale: the build installs 757 locked packages once per deploy. It is
independent of agent count.

## Human feedback

None recorded.

## Reusable lesson

In a lockfile-less workspace, pin dependency versions exactly — a caret range lets
a newly published minor introduce a peer conflict that ERESOLVE-fails the shared
root install and silently blocks every backend deploy.

Build the backend from its own committed lockfile (`npm ci --workspaces=false`);
a workspace-root `npm install` without a root lock makes every deploy a function
of registry state at build time, and a warm build cache hides it.
