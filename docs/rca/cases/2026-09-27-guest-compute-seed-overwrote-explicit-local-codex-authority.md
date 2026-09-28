---
id: 2026-09-27-guest-compute-seed-overwrote-explicit-local-codex-authority
date: 2026-09-27
title: Linux guest compute refresh ignored explicit local Codex authority
surface: infra
component: cloudbench-credential-handoff
classification: configuration-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The Linux compute seed copied source integrations without reapplying the explicitly selected local Codex auth file
symptoms:
  - Your refresh token has already been used to generate a new access token
  - Explicit current authority was replaced by the next compute-token seed
  - Linux local Codex refresh returned False before examining CODEX_AUTH_PATH
tags:
  - codex
  - cloudbench
  - credentials
  - seed
  - ownership
sources:
  - PR #1299
  - commit f94858c8316609b2c8e7c94c07f2b74a7672687f
repro: agents/benchmarks/cloudbench_codex_auth_test.py
status: open
---

## Problem

The r3 controller's unchanged Codex smoke rejected the seeded refresh token.
A separate configuration repair explicitly supplied the current same-account
private auth and the committed wrapper; that domain passed 24 assertions.
The controller-local import did not propagate to future benchmark guests.
Read-only credential hashes and `guest-credential-route.json` established that
normal Linux guests would still seed the old production integration. No guest
provider run was launched to manufacture another refresh-token failure.

## Diagnosis

`_sync_compute_tokens` owns every compute refresh, including initial mixed-model
preflight, live fixture refresh, and declared judge preparation. Its successful
seed overwrote isolated integrations from the selected source. The existing
local Codex overlay returned immediately outside Darwin, and the mixed-model
route did not call it. Applying an overlay only at initial setup would therefore
be undone by later successful seeds.

The unchanged actual Python owner was exercised with synthetic file data and
mocked process/database boundaries. Four assertions failed and three controls
passed: explicit Linux import, mixed preflight followed by another seed, invalid
explicit input, and missing explicit input. The same assertions pass with the
overlay after every successful seed. Source selection and the canonical
`sync-codex-token.ts` implementation remain unchanged.

Archive searches used `refresh token already used Codex auth Linux seed` and
`guest credentials local auth overlay production stale`. The July 19 strict GPT
preflight case and September 27 controller-local Codex configuration case are
relatives. This is a separate guest authority propagation boundary, not another
provider fallback policy or a reason to require GPT auth on all benchmarks.

## Solution

Treat a nonempty `CODEX_AUTH_PATH` as an explicit optional authority. Validate
its private regular file ownership and require an isolated loopback database;
then reuse the existing canonical token import after each successful compute
seed. An explicit invalid input fails setup. Without that input, the existing
Linux behavior and Darwin optional refresh remain intact.

Cloud transport freezes the private file outside artifact directories and sends
it only over exact-machine SSH/SFTP. The provider configuration and compressed
boot payload contain helper code, identities and a digest, never auth bytes.
The waiting guest driver first creates a root-owned admission directory with
its own retirement claim. Controller staging only validates that admission;
it cannot create or resurrect it. A private pending file is checked through its
still-open nonblocking descriptor, fsynced, rechecked for identity, and renamed
atomically. The guest gives the existing application user read access while
retaining directory ownership. A repeat handoff validates ready bytes and skips
SFTP. Wrong owner, machine, run, digest, symlink, foreign UID, partial upload,
substituted FIFO and replaced pending file are rejected.

The wait uses the existing command supervisor with a scoped one-second readiness
poll and 270-second handoff ceiling. Direct cancellation during spawn or PID
publication is remembered, sends one signal, and joins the child before exact
credential retirement. A pending handoff cancellation remains exit 143 even if
the helper concurrently exits zero; benchmark result semantics are unchanged.
Legacy upload starts only after driver launch. Explicit
auth cannot use the no-browser shutdown shortcut to claim credential retirement.
No task execution timeout, task definition, model, prompt, evaluator, workload,
provider selection or production integration is changed. At 10,000 guests the
handoff remains one bounded transfer and private directory per guest, with
constant per-guest artifact count and no shared runtime hot path or lock.

The permanent module is registered in the benchmark blackbox domain, the shell
lifecycle gate and the deploy controller selection. Focused actual-shell tests
exercise synthetic exact-machine SSH and SFTP, both cancellation boundaries,
repeated handoff and cleanup; they make no provider calls. Evidence is under
`.context/acceptance/proof21-guest-codex-authority-rca/`: `permanent-before.log`,
`lifecycle-final-after.log`, `publication-review-before.log`, the final tracked
owning log and implementation receipt. The promoted owning callable passed all
54 tests in 6.43 seconds; the 56 adjacent credential preflight controls passed in
6.45 seconds, both with native exit zero. The publication control also fails with
the previous exact `publish` body and passes with descriptor-bound publication.

This closes the offline authority and transport mechanism proof. Actual guest
provider outcome, complete current gates and the 100-root fleet acceptance
remain open. The earlier controller's 24-test pass is not guest outcome proof.

## Human feedback

The user required infrastructure-only readiness without changing benchmark
prompts, models, evaluators, workload or the five-minute proof limit.

## Reusable lesson

Carry explicit private credential authority through every isolated seed refresh and bind its transport and retirement to the exact guest driver lifetime.
