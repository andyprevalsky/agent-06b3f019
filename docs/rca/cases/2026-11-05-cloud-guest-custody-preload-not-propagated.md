---
id: 2026-11-05-cloud-guest-custody-preload-not-propagated
date: 2026-11-05
title: Local Kernel proxy custody preload did not establish cloud guest enforcement
surface: harness
component: cloudbench-guest-launch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-cloud projected staged dotenv and Temporal settings but not the controller-selected Kernel proxy custody policy into guest startup
symptoms:
  - Local NODE_OPTIONS preloader does not prove guest enforcement
  - guest backend must preload custody
  - Cloud smoke deliberately unexecuted pending zero-Kernel-allocation proof
tags:
  - cloudbench
  - kernel-proxy
  - preload
  - environment-propagation
sources:
  - commit dcd8375f19eb9d8f20588c95fbe237c4d0d0a157
  - agent 01a1a32a-56ed-7043-b8dd-68349792e0b8 isolated evidence /home/boxes/cli-nov05-cloud-guard-repair/.context/cloud-guard-rca/
repro: python3 scripts/tests/cloudbench-kernel-custody.test.py
status: open
---

## Problem

The deploy's smoke recipe selected a local NODE_OPTIONS preload under the
controller checkout. Both staged dotenv files lacked NODE_OPTIONS. The existing
controller stages those blobs with a guest-only Temporal override; the guest
decodes them under /data/repo and launches run.sh with STACK_ENV. No guest custody
preload or runtime custody verification was required. The original smoke failed
before dispatch; the current smoke was deliberately unexecuted. No observed
Kernel allocation incident or live smoke pass is asserted.

## Diagnosis

The branch adds a local blackbox custody preload and backend health marker but
leaves the cloud guest handoff unchanged from origin/main. This is an INTRODUCED
partial propagation of the new policy, not a production backend behavior change.
The owning gap is absence of a source-enforced guest launch contract; ambient
secrets or images could not substitute for that contract.

Read-only native Fly secrets-list and Machines-list calls scoped to
navi-whisper-lux-bench succeeded. Secret names did not include NODE_OPTIONS and
39 machine configurations did not contain a NODE_OPTIONS key. Only presence,
image/value hashes and resource state/identity metadata were recorded. Encrypted
blob contents, image internals and current process environments were not read;
absence of a guard there is NOT inferred from these metadata observations.
No machine was created, started, stopped or changed.

The same synthetic test bytes run on frozen dcd8375f1 fail the preload assertion;
the repaired guest launch blocks both public Kernel POST /proxies endpoints
without reaching a stub provider fetch, while GET/list/existing-proxy reads reach
that stub. No network, database or payment operation is used by these tests.

Archive searches used NODE_OPTIONS guest Kernel proxy and cloud preloader
environment guard propagation. The gap is a guest policy-handoff relative, not
proof that any prior live guest made an allocation. Reusing the existing preload,
health marker and verifier avoids a duplicate implementation of proxy policy.

## Solution

Project the controller's existing custody preload selection to a validated 0/1
policy bit. An explicit bit may enable custody; disabling it cannot override an
already selected preload. Pass only that bit through both boot-launch argv and
SSH wrapper exports, never the controller's NODE_OPTIONS or local require path.
Do not modify shared app secrets, dotenv files, images or production services.

When selected, the guest requires a regular readable preload at its own checked
out back-end/scripts path, verifies stack-user readability, and appends a safely
quoted require option to that guest's existing Node options. This happens before
run.sh can launch backend/Node processes. After stack health and before payment
preparation or benchmark tasks, reuse verify-kernel-proxy-custody.cjs against the
actual local backend. An unguarded healthy backend fails closed. Worker-only
pool nodes use PRIMARY_HOST to call this same backend and do not start another
backend. All ten current smoke catalog entries select this isolated target.

A selected production/unknown target is refused before stack launch: a guest
preload cannot constrain a production backend. Task routing/check inventories
are unchanged and no case is skipped or marked passed. An unselected ordinary
cloud run preserves its original launch behavior. The preload and verifier code
are unchanged. Legitimate proxy reads/reuse continue; new shared proxy creation
is denied. No global production runtime/configuration policy is added.

The new registered synthetic suite covers both launch transports, no local-path
leakage, selected and unselected scope, missing preload, preserved Node options,
blocked create/read/reuse, protected/unprotected runtime verification, and refusal
of an unverified production target. Step 4s lists the new exact gate command.
No original assertion, task prompt, timeout or provider behavior was weakened.
Status remains OPEN pending parent integration and native guest verification;
synthetic proof is not a live cloud smoke result.

## Human feedback

The user prohibited new Kernel proxies and all live launches/resource mutation
for this repair, required preserving production behavior and current smoke
contracts, and required a guest-local preload before backend launch. The parent
rejected an unexplained unconditional all-cloudbench scope and required the new
gate's exact Step 4s entry. The final policy is enabled only for callers already
selecting custody or explicitly requesting its fixed bit.

## Reusable lesson

Propagate a scoped policy to each execution host and verify it at the actual service boundary instead of forwarding a controller-local path.
