---
id: 2026-07-25-floating-dep-spec-without-frontend-lockfile-breaks-render-build
date: 2026-07-25
title: Floating @hookform/resolvers spec with no front-end lockfile resolved a new peer conflict and ERESOLVE-failed every Render build
surface: front-end
component: dependency-pinning
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/package.json — `@hookform/resolvers` floated on `^5.1.1` with no front-end lockfile to pin the resolved version
symptoms:
  - ERESOLVE aborts `npm install` at the workspaces root
  - every Render backend build fails during the monorepo install
  - "peerOptional valibot@^1.0.0" conflicts with `valibot@0.39.0`
  - a merged PR never goes live and prod stays on the prior good instance
tags:
  - npm
  - eresolve
  - lockfile
  - render-build
  - dependency-pinning
sources:
  - PR #893
repro: none-recorded
status: fixed
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

## Solution

Pinned `@hookform/resolvers` to exactly `5.4.0` in `front-end/package.json` — the
last version before the valibot peer was introduced. Verified that a root
`npm install` resolves cleanly (exit 0, no ERESOLVE) with `5.4.0` selected and
that `cd front-end && npm run build` succeeds in about 10s; `5.4.0` is also the
version present during the workspace's full green gate run. Prevents the sibling
class of failure where any newly published minor of a lockfile-less workspace
dependency takes down the shared root install and therefore the back-end deploy.

## Human feedback

None recorded.

## Reusable lesson

In a lockfile-less workspace, pin dependency versions exactly — a caret range lets
a newly published minor introduce a peer conflict that ERESOLVE-fails the shared
root install and silently blocks every backend deploy.
