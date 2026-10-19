---
id: 2026-10-16-maintenance-fly-state-permission
date: 2026-10-16
title: Maintenance export auth could not write Fly CLI state
surface: infra
component: cloudbench-maintenance-env
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The selected Fly CLI session refresh attempted its config-directory permission probe in root-owned /.fly after the maintenance stage dropped to UID1001 with HOME unchanged at /
symptoms:
  - selected session refresh refused
  - failed ensuring config directory perms
  - permission denied opening /.fly/perms.3779897799
tags:
  - cloudbench
  - maintenance
  - authentication
  - permissions
sources:
  - plan:.context/pr1525-continuation/v39-auth-diagnostic-normal-successor/prepared/once-627745fb6877f72882e5d2fcd157e606/source-admission.receipt.json
  - plan:.context/pr1525-continuation/v39-auth-diagnostic-normal-successor/prepared/once-627745fb6877f72882e5d2fcd157e606/recovery-1bab3a7d89518dde/004-auth-stderr.private.json
repro: scripts/tests/cloudbench-maintenance-env.test.py MaintenanceEnv.test_actual_run_bench_auth_permission_boundary
status: open
---

## Problem

Capture and commit succeeded, but the private maintenance group's canonical
export failed in its first fresh Machine read, before a packet was written.
The campaign Machines reader reported `selected session refresh refused`.

## Diagnosis

The bounded diagnostic used the same selected credential source, UID1001,
unchanged HOME=/, runtime PATH and Fly client. It selected agents/.env, then
refresh exited1. The recovered exact94-byte stderr reports failure opening
`/.fly/perms.3779897799` due to permission denied. This is a local CLI state
permission failure, not evidence of credential expiration. Earlier separate
Machine GET deadline failures and HTTP499 restore response have no proven
causal relationship to this auth failure.

## Solution

The small canonical helper creates a new exclusive fly-state directory inside
an already-private maintenance nonce stage, assigns only that new directory
to the worker, and fsyncs the directory and parent. Private auth and group
wrappers set FLY_CONFIG_DIR to it. HOME and the credential resolver are
unchanged; existing state is refused rather than repaired or overwritten.
No global credential or timeout behavior changes.

The registered regression dispatches the export argv through the actual
run-bench parser, exact fleet fresh-native reader and canonical resolver/auth
subprocess. A fake client reproduces the observed permission-probe operation
using a real non-writable directory and UID1001 on privileged Linux. Its
sandbox default directory represents /.fly; it never writes host /.fly.
Only FLY_CONFIG_DIR changes between RED and GREEN. Both retain HOME=/ and the
same selected token. The HTTP/provider boundary is replaced; this is not a
live export or REAL600 proof. Native validation remains pending.

## Human feedback

Keep HOME unchanged, preserve credential selection and all original source
receipts/reservations, and use one minimal shared helper rather than a broad
authentication framework. Never retry a partial export to test this fix.

## Reusable lesson

Give a demoted maintenance CLI a private writable state directory independently of its credential source.
