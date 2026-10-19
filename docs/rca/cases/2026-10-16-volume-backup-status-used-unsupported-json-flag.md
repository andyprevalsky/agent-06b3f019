---
id: 2026-10-16-volume-backup-status-used-unsupported-json-flag
date: 2026-10-16
title: Volume backup configuration used an unsupported Machine status flag
surface: infra
component: cloudbench-disposable-volume
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: disposable Volume helper passes --json to Fly v0.4.115 machine status although -d already emits JSON and --json is not registered
symptoms:
  - "Volume configuration CLI failed"
  - "Error: unknown flag: --json"
  - "new disposable Volume backup setting was not verified"
tags:
  - cloudbench
  - flyctl
  - volume-backups
  - command-flags
sources:
  - plan:/tmp/pr1525-original600-resume/attempt56-1792183312752661617/run/n2-full-log-1792185263812907301.private.json
  - plan:/tmp/pr1525-volume-cli-flags/.context/volume-cli-proof/actual-pinned-parser-red.safe.json
  - plan:/tmp/pr1525-volume-cli-flags/.context/volume-cli-proof/actual-main-original532-red.log
  - plan:/tmp/pr1525-volume-cli-flags/.context/volume-cli-proof/actual-main-green.log
repro: python3 scripts/tests/cloudbench-disposable-volume-cli.test.py
status: open
---

## Problem

Attempt56's required N2 preflight created both exact-owned clones, then both
failed before workload launch. The traceback identifies the first configuration
read, `machine status <id> -a <app> -d --json`. Volume inspection and the backup
update had not run. This is a startup failure, not evidence of a task failure,
provider rate limit, token error, or thirty confirmed original600 infra jobs.

## Diagnosis

Path: canonical clone and ownership audit → disposable Volume helper main →
exported Bash FLY guard → pinned native command parser → configuration JSON.
Fly v0.4.115 does not register `--json` for Machine status. Its `-d` option
already prints only configuration JSON. The actual pinned binary, SHA256
5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83,
rejects the exact first command with exit1 and `unknown flag: --json` before
session/provider dispatch. Both live traces reach this same invalid argv.

Previous callback fixtures accepted arbitrary status arguments, so they missed
the command-specific flag contract. The callback also discarded exit output,
obscuring this upstream error in the live traceback.

Archive searches used `Volume configuration CLI failed machine status unknown
flag json` and `disposable volume backup native command flags fixture contract`.
The controller-client packaging and subprocess-output cases are relatives;
neither diagnoses this invalid native argument. The golden reference is the
[versioned Fly implementation](https://github.com/superfly/flyctl/blob/v0.4.115/internal/command/machine/status.go):
`newStatus` registers display-config, and `runMachineStatus` emits config JSON
directly for that option. Native help separately confirms that Volume show and
update support `--json`; those commands must retain it.

## Solution

Delete the unsupported flag from Machine status, preserving `-d`, all ownership
guards, one-update fencing, and existing 60/20-second bounds. Preserve lossless
stdout/stderr, argv, exit status, and monotonic command times in exclusive0600
files under a private0700 command directory before raising a CLI error. Native
configuration may contain secrets, so the public traceback contains only exit
status and the private receipt path.

The registered regression runs actual helper main through exported Bash FLY and
a strict command-specific pinned CLI contract. The unchanged test fails against
the original helper and passes with the fix. It verifies one update followed by
native readback, and a first-read failure preserves private diagnostic bytes
without an update or success receipt. Twelve existing owning Volume controls
also pass. This is causal and regression proof; the exact unchanged benchmark
outcome remains OPEN for the native operator. Failed56 evidence is preserved.

## Human feedback

The user requires correct fast startup/teardown and the original600 tasks,
profiles, concurrency, and budgets. Root explicitly requested this isolated
repair without modifying the active56 source or adding a paid qualification.
An earlier root assertion that status supported `--json` was a help inference;
the actual pinned parser and versioned implementation corrected it.

## Reusable lesson

Validate native arguments against the pinned command's own parser and preserve private subprocess diagnostics before reporting failure.
