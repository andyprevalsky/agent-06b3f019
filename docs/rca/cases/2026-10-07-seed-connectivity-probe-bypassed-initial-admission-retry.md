---
id: 2026-10-07-seed-connectivity-probe-bypassed-initial-admission-retry
date: 2026-10-07
title: Seed connectivity probe bypassed the identity retry and aborted credential restoration
surface: cross
component: seed-local-initial-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: seed-local.ts sync issued an unowned SELECT 1 before selected-user hydration and the existing table retry owner
symptoms:
  - PrismaClientInitializationError
  - max client connections reached
  - could not restore live browser credentials
  - owned cloud root did not produce a task result
  - driver exited without cleanup acknowledgement
tags:
  - seed-local
  - browser-credentials
  - pooler-admission
  - initial-read
  - bounded-retry
  - cloudbench
sources:
  - fleet run 20261007-224256-41245
  - task minted-agent-accounts-x
  - commit ccc4ac7f91375a8c6e7b30b98f35b226784a9713
  - commit e16eb1d2d66097f4da2268a0e2651cca78d71d0c
repro: back-end/src/tests/blackbox/seed-credential-retry.blackbox.ts case5InitialAdmissionHasAnOwner; unchanged existing runner RED/GREEN in .context/control11-minted-rca/owner-{red,green}.safe.json
status: mitigated
---

## Problem

Original Control11's Minted task reported ERROR. The controller's collector exit
125 established an observation failure, not a guest crash. Exact read-only
native access then established driver exit 1, an exited state, absent PID and
cleanup ACK, and no canonical `run.json`. The first native seed error was
`PrismaClientInitializationError` with `max client connections reached` and a
separate `FATAL` marker on the same line;
the TypeScript stack names `seed-local.ts:1269`. This was a connection-admission
failure before credential payload reads, not evidence of a browser-origin OOM.

The original source, logs, outcomes and receipts remain immutable. The original
control exceeded its one-hour boundary and failed; recovery is zero credit.
This mitigation does not repair its missing result or evidence, establish a
benchmark PASS, or prove whole-fleet resource closure.

## Diagnosis

The original seed script issues `remote.$queryRaw` with `SELECT 1` before
`ensureSeedUserExists`. That check has no retry owner. The selected-user read is
already required for every seed mode and verifies the same remote connection;
the probe contributes no identity or credential data. Browser-auth tables use
the existing `syncRequiredCredentialTable` owner, but neither this probe nor
initial identity hydration used it. A first admission rejection therefore
aborted before those bounded retries could help.

The exact causal chain is initial probe admission rejection → nonzero seed
subprocess → restore exception at `run_benchmark.py:8060` → no `TaskResult` for
the retained owned root → finalization failure at line 6186 → unsuccessful
interrupt receipt and withheld ACK → native driver exit 1 → collector failure.
The later public guard `owned cloud root did not produce a task result` is
correct evidence of the missing result. No synthetic result, ACK, archive
exception or collector-guard change is justified.

Private native evidence is bound in
`.context/control11-minted-rca/initiating-error-source-binding-v2.safe.json`.
The complete native driver log has SHA-256
`149e19d595c5ece8b79f4ab8a8ea494d1ffabf14d55528ccf613cac859f84dde`,
matching the originally collected log. Its protocol-reason line 1500 has hash
`ef82d854149af402a6661eba467eb65f50e20f0487a4543b3597a0f3d9d4ed51`;
the native stack binds the first operation to the immutable source. Driver
boot-end was 23:07:18 UTC. Services were STOPPED and stack cleanup was CLEAN,
while the narrower interrupt receipt was FAILED. At the exact-owner process
observation, all registered backend/frontend/worker/tunnel PIDs were absent;
the status server remained. This proves only the observed Minted guest's local
consumer state, not external session release or other tasks' closure.

The original remote connection shape used a Supabase pooler on port 6543 with
`pgbouncer=true`, without an explicit `connection_limit`. Actual pool occupancy,
the responsible client population, and the persistence of saturation were not
captured. The pooler cap's initiating cause remains open. This case identifies
the owned seed retry gap; it does not assign saturation to deploy overlap,
choose a new pool limit, or guarantee recovery from sustained rejection.

Archive searches included `Max client connections reached seed-local browser
credentials PrismaClientInitializationError` and restore/cleanup-ACK symptoms.
The July 17 pool-limit case owns backend pool budgeting, a distinct client path.
The July credential-memory cases require payload-read/memory evidence absent
here. The September 29 runner-receipt case distinguishes stack and runtime
seals, consistent with preserving this collector's failure. No prior case owns
the initial seed probe's missing retry boundary.

## Solution

Remove the redundant connectivity probe. Run the unchanged selected-user
hydration through `syncRequiredCredentialTable('Seed identity', ...)` before
any seed mode's dependent writes. It retains the existing three attempts and
500/1000 ms backoffs inside the same enclosing stage budget. Missing-user,
authentication and permanent admission failures still exhaust that owner and
fail closed before credentials. User identity and all credential selection,
realm/origin/revision/token rules remain unchanged. The whole credential graph
is not replayed, no database schema or admission registry is added, and no
pool/environment setting, task, prompt, model, evaluator or timeout is changed.

The existing `seed-credential-retry` blackbox executes the actual source's
`sync` and `ensureSeedUserExists` functions with only database and credential
edges replaced by local fixtures. It uses the production identity helper and
table retry helper, and the native Prisma initialization-error type with a
normalized fixture reason (`FATAL: Max client connections reached`), rather
than a claimed verbatim native line. A transient first database rejection must recover
inside identity hydration and reach the credential phase once. Normal success,
permanent rejection, authentication failure, missing user and foreign identity
controls retain their stage-end states. This is a functional owner reproduction,
not a live Supabase or credential-payload transfer test.

The same frozen tests and normal runner command fail on e16 and pass with the
minimal owner fix:

```bash
cd back-end
node --import tsx src/tests/blackbox/run.ts seed-credential-retry,seed-local.part2 --concurrency=1
```

RED log hash is
`2884d91f66cd369b4aad86623e52f746ebcadd0e1bcf18bba96dea892a2a88d4`;
GREEN is `96a332575407f945f5258bb2ee4e1eafe572c48e793dd73c949f0da1d31235e5`.
The unchanged user and domain-scope blackboxes, case registration, selected-file
formatting/lint and backend type checking pass. The existing runner discovers
these owners on normal invocation, including the deploy blackbox route; no
opt-in-only test stage is introduced. Tests use no provider or model calls and
assert stage-end behavior rather than a tiny timing threshold. Rejected
initialization is retried by the same client: the installed Prisma library's
start owner clears its starting promise in `finally` after a connect error.

Reference comparison used existing local snapshots, with no reference fetch.
Claude Code `src/services/api/filesApi.ts:97` owns the first actual file operation
inside its bounded retry; line 147 places the download in that owner and retains
terminal authentication/not-found errors. OpenClaw
`packages/retry/src/index.ts:255` puts the first operation inside its bounded
attempt loop and propagates exhaustion. Hermes `hermes_state.py:617` applies
existing write-lock patience to initial database open/schema work, with unrelated
errors still propagating. These are operation-ownership analogs, not Supabase
capacity recipes. Rose reuses its existing table policy rather than importing
their distinct retry classifications or state machinery. Searches for initial
connection retries and Prisma/Supabase admission found no exact seed analog;
the Codex snapshot was absent in the checked workspaces. This comparison was
completed during review, after the initial minimal candidate, so it is not
represented as evidence that selected the fix beforehand.

At fleet scale, each seed invocation uses one selected-user operation with the
existing bounded policy; it makes no global inventory scan or graph replay.
Sustained saturation still fails. A fresh whole-task and whole-control outcome
is required before claiming the practical incident resolved. The original
twenty-minute execution and one-hour evidence/resource cap remain decisive.

## Human feedback

The user required native driver and ACK evidence before treating wrapper exit
125 as a crash, rejected tiny inner observation gates as acceptance criteria,
and required whole-stage, twenty-minute execution and one-hour evidence/resource
end states. The owner was instructed to retain collector failure semantics,
prove the initiating restore error before blaming OOM, reuse the existing
retry owner, and preserve the selected identity and credentials. No pool-limit
change, whole-graph replay, original backfill or recovery credit is authorized.
Independent review is required before upload or a new paid control.

## Reusable lesson

Make the first required scoped data read verify connectivity inside its existing retry owner, and diagnose later finalization failures from the first native error without weakening terminal evidence.
