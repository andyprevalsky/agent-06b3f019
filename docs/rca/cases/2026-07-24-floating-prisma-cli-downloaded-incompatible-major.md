---
id: 2026-07-24-floating-prisma-cli-downloaded-incompatible-major
date: 2026-07-24
title: npx could not find the workspace Prisma CLI and downloaded an incompatible floating major
surface: infra
component: auto-rca
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto-RCA prisma generate step — npx resolution escaped the workspace and downloaded Prisma 7.9.0
symptoms:
  - npx prisma generate downloads Prisma 7.9.0
  - Prisma 7 rejects the repository's Prisma 5 datasource syntax
  - root frontend backend mac-app and Python hydration pass before Prisma generation fails
tags:
  - auto-rca
  - prisma
  - npx
  - dependency-drift
  - github-actions
sources:
  - PR #892
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production run 30085424508 passed every dependency-hydration phase, then
`npx prisma generate` failed to locate the intended workspace CLI and silently
downloaded floating Prisma 7.9.0. That major rejects the repository's Prisma 5
datasource syntax.

## Diagnosis

The workflow relied on `npx` discovery instead of naming the lockfile-installed
binary. Once workspace installation placed the CLI somewhere `npx` did not
resolve, the package runner treated the missing executable as permission to
download the newest major.

## Solution

Install the backend and frontend locally with `--workspaces=false`, execute
`back-end/node_modules/.bin/prisma` directly with the exact schema path, and
structurally forbid the floating `npx prisma` command.

## Human feedback

None recorded.

## Reusable lesson

Invoke schema tooling from the lockfile-installed binary path; never let `npx`
replace a missing workspace executable with a floating major.
