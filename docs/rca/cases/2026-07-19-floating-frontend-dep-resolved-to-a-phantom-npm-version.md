---
id: 2026-07-19-floating-frontend-dep-resolved-to-a-phantom-npm-version
date: 2026-07-19
title: A floating frontend caret range resolved to a phantom npm version whose tarball 404s, breaking every Render backend deploy
surface: infra
component: deploy-pipeline
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/package.json — "@radix-ui/react-collapsible": "^1.1.0" resolved to the phantom 1.1.17 during the repo-root workspaces install
symptoms:
  - "ETARGET / No matching version found for @radix-ui/react-collapsible@1.1.17"
  - every Render backend deploy from main fails at npm install
  - Render clearCache does not help
tags:
  - npm
  - render
  - deploy
  - lockfile
  - monorepo
  - workspaces
sources:
  - memory:project_radix_phantom_version_deploy_block
  - PR #812
repro: none-recorded
status: fixed
---

## Problem

On 2026-07-19 **every** Render backend deploy from `main` failed at `npm install`
with `ETARGET / No matching version found for @radix-ui/react-collapsible@1.1.17`.

## Diagnosis

npm's registry metadata re-listed `@radix-ui/react-collapsible@1.1.17` as the
latest 1.1.x, but its **tarball 404s** — a broken or yanked publish.
`front-end/package.json` declared `^1.1.0`, which resolved to that phantom version.
Because the **root `package.json` is a workspaces monorepo that includes
`front-end`**, the Render _backend_ build's repo-root `npm install` pulls frontend
dependencies too, so a broken FE dep blocks backend deploys. Render's `clearCache`
did not help: it clears Render's build cache, not npm's registry CDN metadata.

The deeper owned gap: `front-end/` has **no `package-lock.json`**, so every build
re-resolves floating `^` ranges against live npm. Any yanked or broken publish of
any FE dependency can break all deploys again — the failure was a matter of when,
not if.

## Solution

Pinned `@radix-ui/react-collapsible` to exact `1.1.16` (the last-good stable, the
version prod was already running) — PR #812, merged as part of unblocking the
SMS-supervisor PR #809 deploy. The durable fix, recorded as a not-yet-done
follow-up: commit a frontend lockfile (and use `npm ci`) so builds are
deterministic and immune to upstream republish accidents.

## Human feedback

None recorded.

## Reusable lesson

An `ETARGET` at deploy time is upstream registry drift, not a cache problem — pin
the exact last-good version, and treat any workspace without a committed lockfile
as a standing deploy-outage risk for the whole monorepo.
