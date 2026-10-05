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
  - unknown or unexpected option --skip-generate
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
  - commit 9f3266b699347c42d614eadff6451b773e9cce29
  - plan:.context/acceptance/proof21-db-sync-rca/npx-workspace-repair.json
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

### 2026-09-27 recurrence: installed packages lacked the npm workspace link

The owned Linux controller's unchanged `scripts/setup-db.sh` first exited 3
after resetting its local database: `npx prisma db push --skip-generate` selected
Prisma 7.10.0, rejected that option, and left the subsequent DDL without an
`Agent` table. An exact installed-binary adapter restored the local database,
but its setup-only scope left the same resolver defect active in
`back-end/scripts/run-coverage.sh`. The next integration attempt passed setup
and failed backend coverage at the same option. Both failed gate receipts remain
unchanged; no benchmark was started by these investigations.

The critical path was separate lockfile installation → npm workspace discovery
→ executable selection → canonical schema synchronization. The installed
backend CLI and client were both 5.22.0. Instrumenting the installed npm 10.9.2
resolver showed that its implicit workspace execution searched
`node_modules/navi-agent-backend/node_modules/.bin`; that workspace link did not
exist. npm's actual dependency graph reported the backend workspace as
`MISSING` and contained no Prisma, despite the correct files under
`back-end/node_modules`. The resolver selected cached Prisma 7.10.0. The same
gap selected tsx 4.23.13 instead of installed 4.23.1, selected Playwright 1.63.0
instead of 1.61.1, and failed to find installed c8 11.0.0 offline.

This recurs at the earlier case's package-discovery boundary. The original
workflow and seed-test repairs explicitly addressed their own calls; they did
not establish workspace discovery for every canonical command on a separately
prepared controller. The related
`2026-07-24-root-npm-install-ignored-workspace-lockfiles` case still correctly
requires committed per-package locks. Reinstalling packages or changing their
versions was unnecessary. Restoring only the absent ignored link
`node_modules/navi-agent-backend -> ../back-end` made the existing npm workspace
graph point to those installed packages. Its workspace edge then resolved and
its actual inventory included Prisma 5.22.0. This environment repair removes the
need for separate adapters at each affected command, without changing source,
locks, tests, provider configuration, or benchmark behavior.

The retained owning repro is
`.context/acceptance/proof21-db-sync-rca/npx-resolution/repair-worker.py`, executed
on that exact controller with Node 22.13.0 and npm 10.9.2. For each of `prisma`,
`tsx`, `playwright`, and `c8`, it ran the same two commands before and after the
single link repair:

```bash
cd /data/rose-pr1299/back-end
npx --no-install <tool> --version
npm run env -- npx --no-install <tool> --version
```

Both phases used npm's offline mode, preventing registry downloads. The second
command uses npm's existing built-in `env` script with an explicit executable;
it tests npm-script inheritance without changing `package.json`. Exact version
checks against the installed package manifests failed in all eight before
observations and passed in all eight after observations. The additional
`npx --no-install prisma db push --help` check passed and included
`--skip-generate`, without accessing a database. The complete repair driver
exited 0 in 17.54 seconds; its exact native process was absent afterward.
Package, lockfile, requirements, and source hashes were unchanged.

An earlier reduced workspace fixture was already green because its different
symlinked `node_modules` layout changed discovery; it is excluded as causal
proof. A separate four-second diagnostic expired and is also excluded from
passing results. The actual host's before/after resolver graph and identical
commands provide the proof. The machine-readable receipt, native exit, complete
logs, exact versions, and exclusions are pinned by
`.context/acceptance/proof21-db-sync-rca/npx-workspace-repair.json` (SHA-256
`5f335b7f298f9f76956b41e27a9f280953ee36aa783973ab9e3c96b420bd8e91`).

Archive searches used `unknown or unexpected option skip-generate Prisma npx`
and `workspace npm installed cached tools missing alias`. This is a recurrence
of executable discovery escaping the installed workspace, with the lockfile
installation case as a relative. At 10,000 agents, this remains a one-time
controller setup operation; it adds no agent or provider hot-path work. The
repair proves this environment boundary only. The current full integration
gate and requested cloud campaign remain separate outcome evidence, and no
cloud acceptance credit follows from these checks.

## Human feedback

None recorded.

## Reusable lesson

Invoke schema tooling from the lockfile-installed binary path; never let `npx`
replace a missing workspace executable with a floating major.
