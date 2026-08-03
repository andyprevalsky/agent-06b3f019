---
id: 2026-07-24-root-npm-install-ignored-workspace-lockfiles
date: 2026-07-24
title: Root npm install traversed unlocked workspaces and tried to resolve an unpublished Storybook version, killing Auto-RCA hydration
surface: harness
component: auto-rca-workflow
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the Auto-RCA hydrate step — a root `npm install` that walked into workspaces instead of installing each one from its tracked lockfile
symptoms:
  - Auto-RCA run fails before the investigator at the hydrate step
  - npm attempts to resolve unpublished `@storybook/builder-vite@10.5.4`
  - GitHub API conclusion shows green while `steps.hydrate.outcome` failed
tags:
  - auto-rca
  - github-actions
  - npm
  - lockfile
  - dependency-hydration
sources:
  - PR #886
  - PR #891
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production Auto-RCA run 30084498097
(https://github.com/Rose-Ai-Labs/rose/actions/runs/30084498097) died before the
investigator ever started. The root `npm install` ignored the tracked front-end
lockfile, walked the workspace, and tried to resolve
`@storybook/builder-vite@10.5.4` — a version that is not published — so hydration
failed. GitHub reported the continued step as green at the API conclusion layer;
only `steps.hydrate.outcome` was correct, and it did stop the investigator, after
which the completion contract failed.

## Diagnosis

A single root-level `npm install` was doing three different jobs: installing the
root tool packages, and implicitly resolving the front-end and back-end workspaces.
Because the workspace traversal re-resolved specs rather than replaying each
workspace's committed lockfile, any floating/unpublished transitive version in a
workspace could abort the whole install — which is what a phantom Storybook
version did. The deeper owned cause is a hydration step with no lockfile
guarantee: reproducible CI requires `npm ci` against a tracked lock per package,
not a resolver run at job time. A secondary reporting gap made it expensive to
diagnose: the workflow's own conclusion surface said green, so the real substage
(hydrate) was not visible without inspecting step outcomes.

## Solution

Hydration was split by package: install root-only packages without traversing
unlocked workspaces, hydrate front-end and back-end with `npm ci` against their
tracked lockfiles, keep the Linux-safe mac-app install and the locked Python
requirements, and record the exact hydration substage into the trusted Slack
waterfall before exiting. Verified with dry-runs of all three replacement npm
commands against current manifests/locks, the Auto-RCA workflow contract, the
lifecycle blackbox (including the hydration substage waterfall), plus shell
syntax, YAML parse, actionlint, and diff checks.

## Human feedback

None recorded.

## Reusable lesson

Hydrate CI per package with `npm ci` against tracked lockfiles — a root
`npm install` that traverses unlocked workspaces lets one unpublished transitive
version abort every job, and report the failing substage explicitly because the
job-level conclusion can read green.
