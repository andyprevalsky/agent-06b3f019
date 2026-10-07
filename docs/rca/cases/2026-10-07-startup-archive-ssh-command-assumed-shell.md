---
id: 2026-10-07-startup-archive-ssh-command-assumed-shell
date: 2026-10-07
title: Rejected-startup archive command assumed a shell at the SSH exec boundary
surface: harness
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet startup archive console command prefixed a direct executable with a shell environment assignment
symptoms:
  - PYTHONDONTWRITEBYTECODE=1 executable file not found
  - original native config retained but remote capture never launched
  - normal completed-execution collector still refuses unsealed runtime
tags:
  - cloudbench
  - ssh
  - exact-owner-recovery
  - fixtures
sources:
  - fleet run 20261007-020659-75781
  - commit 5b47da7f1695739a0bcbafaba151762dceb7e43a (actual recovery caller)
  - commit 681481df0425caf0a8d2157b872027b11a8ef8f9 (unchanged original guest)
repro: test_exact_recovery_consumes_runtime_receipt_failed_startup_archive
status: open
---

## Problem

The one authorized supported cleanup from immutable `5b47da7f` exited 1 after
45.965886 seconds. Its original DAILY50 run remains permanently rejected with
zero full-width acceptance credit. Forty-nine primary scopes and two workers
were already closed; exactly one original started Gmail primary stayed owned.

The normal rejection-only archive path read and preserved its original native
config, created a private remote staging directory and uploaded the capture
helpers. The console invocation failed before capture, leaving no original-file
archive or verified rejection-only receipt. The existing completed-task collector
then correctly refused the unsealed runtime. The original registry, pending
runtime owner and latch remained intact; the actual guest cleanup acknowledgement
and cleared guest-cleanup latch were preserved. No native release was inferred.

## Diagnosis

The installed Fly CLI local help accepts the exact console, SFTP put/get,
`--machine` and path argument forms. It does not establish shell evaluation of
the command string. The command began with `PYTHONDONTWRITEBYTECODE=1 python3`.
At the actual SSH direct-exec boundary, the assignment name became the program
and failed with executable-file-not-found. Native capture never ran, so the
remote archive phase remains unknown.

The prior local transport fixture called `subprocess.run(command, shell=True)`.
It evaluated the assignment and concealed the actual adapter error. A repository
comment about a remote shell and local help flag compatibility were insufficient
evidence for that execution assumption. The retained original capture log proves
the first bad boundary independently of the later collector refusal.

Archive search `ssh console shell command` found related transport and faithful
provider-fixture cases. The October 5 inert-clone-command fixture case establishes
that a provider fixture must preserve the contract consumed by real code. The
July 15 SSH polling case keeps monitoring on the existing data plane. This change
adds no polling or provider calls and changes none of those budgets.

## Solution

Replace only the assignment-prefixed capture command with the explicit executable
`python3 -B`. Python's existing `-B` flag suppresses bytecode writes without
requiring shell assignment evaluation. Machine identity and token still come
from the original remote environment and remain independently bound to the
unchanged original native config, source, registry and evidence.

Change the existing owning fixture to execute parsed argv with `shell=False`.
The same eight route cases now reproduce the actual direct-exec failure on the
unchanged caller source: the positive residual-owner case raises FileNotFoundError
for the assignment name, while seven inverse cases pass. The identical final test
bytes and selector pass after the one-line adapter correction. The two existing
config-preservation controls also pass, retaining all ten compact owning guards.
Fixture process groups and their pytest owners are joined and positively absent.

All archive, cleanup, source, ownership, worker coverage and normal result guards
remain unchanged. The helper, forensic verifier, task definitions, models,
evaluators, phase authorities and execution/transport timeouts are unchanged.
Normal compact registration still selects these existing owning cases. This is a
bounded failure-cleanup adapter correction with no agent hot-path work.

The private packet binds the actual recovery owner/start/exit clocks, original
safe failure and raw private capture log, paired unchanged owning RED/GREEN,
source/test hashes and joined fixture closure. A final reviewed supported native
cleanup and original durable publication remain outstanding. The case stays open;
neither original nor recovery work receives benchmark acceptance credit.

## Human feedback

Root orchestration instructed a narrow `python3 -B` correction with actual
argv/direct-exec reproduction, preservation of all ten owning controls and
independent review before another supported recovery. This records root's task
instructions; it does not attribute that correction to direct user feedback.
No manual provider fallback, blind repeat or timeout adjustment was authorized.

## Reusable lesson

Model the actual remote exec boundary in its owning fixture. Accepted CLI flags
and shell-shaped strings do not prove that a remote transport evaluates a shell.
