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
  - seed browser agent guard produced blank output after spawnSync npx did not start
tags:
  - auto-rca
  - prisma
  - npx
  - dependency-drift
  - github-actions
  - seed-browser-agent
sources:
  - PR #892
  - PR #924
repro: scripts/tests/auto-rca-workflow.test.sh and back-end/src/tests/blackbox/seed-browser-agent.blackbox.ts
status: fixed
---

## Problem

Production run 30085424508 passed every dependency-hydration phase, then
`npx prisma generate` failed to locate the intended workspace CLI and silently
downloaded floating Prisma 7.9.0. That major rejects the repository's Prisma 5
datasource syntax.

The class recurred in PR #924's backend blackbox gate: the seed-browser-agent
test invoked `spawnSync('npx', ['tsx', ...])`, timed out or failed before the
owned script emitted anything, and then reported only a blank local-only-guard
assertion. Running the unchanged test with `PATH=''` reproduced the start
failure deterministically as `undefinedundefined` output.

## Diagnosis

The workflow relied on `npx` discovery instead of naming the lockfile-installed
binary. Once workspace installation placed the CLI somewhere `npx` did not
resolve, the package runner treated the missing executable as permission to
download the newest major.

In the recurrence, the same ambient package-runner dependency made a hermetic
test contingent on PATH, package discovery, and possible network/package-runner
startup even though Node and the lockfile-owned `tsx` entry were already known.

## Solution

Install the backend and frontend locally with `--workspaces=false`, execute
`back-end/node_modules/.bin/prisma` directly with the exact schema path, and
structurally forbid the floating `npx prisma` command.

The seed-browser-agent test now resolves `tsx/cli`, runs it with
`process.execPath`, and deliberately clears PATH. That poisoned-PATH regression
passes and still proves the hostname guard fires before any Prisma access.

## Human feedback

None recorded.

## Reusable lesson

Invoke schema tooling from the lockfile-installed binary path; never let `npx`
replace a missing workspace executable with a floating major.
