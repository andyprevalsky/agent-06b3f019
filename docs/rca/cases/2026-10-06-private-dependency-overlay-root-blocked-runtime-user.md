---
id: 2026-10-06-private-dependency-overlay-root-blocked-runtime-user
date: 2026-10-06
title: Private dependency overlay root metadata blocked frontend access by the runtime user
surface: infra
component: cloudbench-dependency-hydration
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: mount_fresh_dependency_overlay created the visible upper root as root-owned mode0700 instead of preserving its donor metadata
symptoms:
  - frontend npm admission reported installed image dependencies missing
  - redundant workspace install consumed about 279 seconds and failed EACCES
  - lockfile fallback also failed EACCES on mkdir beneath frontend node_modules
  - native canary driver exited before any benchmark execution
tags:
  - cloudbench
  - overlay
  - permissions
  - frontend
  - startup
sources:
  - commit 35ac57e4e725b6f4d7e8a2a9874ee8c9778fb0a5
  - fleet run 20261006-082726-40183
  - plan:.context/runtime-stage-audit-20261006T1538Z/stage-and-permission-boundary.safe.json
  - plan:.context/frontend-overlay-permission-rca-20261006
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fresh_dependency_overlay_prisma_client_preserves_checkout_and_copy_boundaries
status: open
---

## Problem

The original source 35 native canary mounted matching root, backend, frontend and
Python dependency overlays. The browser guest's frontend preflight then rejected
about 110 manifest dependencies as missing, despite those packages being present
in the immutable donor. Its actual workspace npm install ran from 15:35:25.406 to
15:40:04.688 UTC and failed EACCES/mkdir beneath frontend node_modules. The normal
lockfile fallback failed the same boundary by15:40:15.606. The driver exited 1;
there was no benchmark or browser execution and no fifty-copy acceptance credit.

The guest's visible frontend node_modules root was UID 0/mode 0700. Its matching
immutable donor root was UID 1001/mode 0755. A bounded filesystem resolver running
as the real rose user found all 114 declared direct dependencies in the donor but
109 inaccessible in the checkout. The checkout observation occurred after the
failed installer and is qualified accordingly; the completed npm-ls debug record
is retained pre-install evidence. A root-only filesystem probe had seen all 114,
which demonstrates why root admission is not runtime-user readability proof.

## Diagnosis

Path: matching immutable donor → private upper/work creation under umask 077 →
kernel overlay exposes upper-root UID/GID/mode → actual primary ownership step
changes root/backend/venv owners but not frontend → rose cannot traverse frontend
node_modules → legitimate missing-dependency admission → redundant installation
and EACCES → driver exits before stack readiness.

Archive searches were `Installing front-end dependencies ELSPROBLEMS missing`
and `baked hoisted dependency frontend npm cache overlay repeated install`.
The September9 invalid-npm-graph case is related but differs: this rejection is a
real runtime-user access failure, so accepting its missing-package graph or
skipping dependency checks would conceal the defect. The October6 workspace
Prisma case establishes the required workspace layout and runtime ownership. The
October6 repeated-copy overlay case owns the optimization that introduced this
root-metadata mismatch. Its existing bounded mount transport copied donor root
metadata onto the target, accidentally masking the real kernel behavior.

The permanent existing five-case overlay owner now represents upper-root metadata
at mount time, includes a frontend tree with a distinct 0750 mode, asserts exact
visible UID/GID/mode for every hydrated tree, checks private backing/receipt modes,
and resolves a frontend package using actual Node. On unchanged source 35 the same
frozen test produced one metadata failure and four existing inverse passes in
9.20 seconds. The candidate passed all five unchanged cases in10.05 seconds.

A separate unchanged network-none Linux control used the already cached installed
AMD64 image and real kernel overlays. It ran the actual source 35 primary ownership
target set and the real rose user. Original hydration succeeded but exposed the
frontend root as UID 0/mode 0700; rose could not resolve the installed frontend
package, and ordinary dependency admission failed. The candidate preserved the
donor UID/GID/mode on every tree, let rose read and write its private frontend
state, and passed the unchanged ordinary dependency admission with zero installs.
The same control changed exit 1/3.61 seconds to exit 0/2.76 seconds. A 64 KiB lower file
still had zero upper data blocks after recursive ownership work. Donor contents
were unchanged; all exact fixture mounts and containers retired. These synthetic
local timings prove the metadata boundary, not native fleet startup performance.

## Solution

Initialize only the exact private upper root's UID/GID/mode from the exact donor
before mounting. Keep the backing parent 0700 and ownership receipt 0600. If metadata
initialization fails, remove only that newly prepared exact state and retain the
existing copy fallback. Matching fingerprints, direct dependency checks, npm graph
checks, version checks, generated clients, metadata copy-up, cancellation,
interruption cleanup and explicit rebuild behavior remain intact.

The helper and owning test are checked in after original native cleanup; independent
review and the final native CLI outcome are retained separately. The Docker image recipe and installer
are unchanged; the normal controller already stages this source-layer helper.
There is no task, prompt, model, evaluator, cache-policy, source-ref or execution
budget change. At 10,000 guests this adds two local metadata operations per hydrated
tree and no shared service, provider request or per-task model call.

This case remains open until the repaired source is independently reviewed,
registered through its existing normal deploy route, and exercised through the
normal native CLI. Local owning proof does not establish the reported benchmark
outcome or fifty-copy acceptance. The original canary's lifecycle, cutoffs and
cleanup remain owned by its fresh CLI validator.

## Human feedback

Prioritize the largest actual startup wait. Preserve runtime dependency checks and
prove the same minimal owning reproduction red then green before retrying native
work. Keep the original run immutable until its normal cleanup retires resources.

## Reusable lesson

A private backing directory can remain root-only while the overlay's visible upper
root preserves the donor's runtime-user access. Validate hydrated dependencies as
the actual runtime user; root visibility and successful image compilation do not
prove post-mount access.
