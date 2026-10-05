---
id: 2026-10-05-cloudbench-cache-metadata-used-unrefreshed-fly-session
date: 2026-10-05
title: Dependency snapshot publication used an unrefreshed Fly session
surface: infra
component: cloudbench-warm-dependency-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_publish_warm_deps_state posted the raw env session to the Machines metadata endpoint
symptoms:
  - configured Fly session returned HTTP 403 for metadata publication
  - the same selected session refreshed by flyctl returned HTTP 204
  - completed dependency proof could not be shared with fresh controllers
tags:
  - cloudbench
  - dependencies
  - startup
  - fly-auth
sources:
  - commit 420650c91c88e6c7baae8de2a486270d3d3a4a1d
  - fleet run 20261005-204412-1968
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_dependency_proof_publication_uses_only_machine_metadata
status: fixed
---

## Problem

The new cross-controller dependency cache published its proof with the raw
selected environment token. The native Machines metadata endpoint rejected
that token with HTTP 403 under both Bearer and FlyV1 schemes. Refreshing the
same selected credential with the installed Fly CLI made the unchanged POST
succeed with HTTP 204. The diagnostic metadata entry was then deleted with
HTTP 204. This reproduction made no model calls or Machine lifecycle changes.

The fifty-task run continued on its original source throughout this diagnosis.
Its separate snapshot creation wait is not attributed to this auth defect.
Optional publication already warned without invalidating a usable local receipt;
the failure affected reuse by later fresh controllers.

## Diagnosis

Archive searches for Fly token, unauthorized metadata, and dependency proof
found the July 13 wrong-account selection case and the October 5 controller-local
proof case. Here changing accounts or rotating credentials was unnecessary:
the same selected token worked after the CLI refreshed its third-party session
discharges. The publisher bypassed the credential normalization and refresh that
native Fly inventory operations already perform.

The owning offline test executes the actual shell publication helper against a
local HTTP server. The original source sent the unrefreshed authorization and
failed the unchanged successful-publication assertion. A fake Fly broker makes
the test fully offline; it cannot accidentally authenticate to a real account.

## Solution

For Fly macaroon sessions, refresh the selected FLY_API_TOKEN through the
available flyctl or fly executable before publication. Remove FLY_ACCESS_TOKEN
from that child environment so a different inherited session cannot override
the already-selected credential. Normalize the returned auth scheme, retain
legacy Bearer-token compatibility, and keep refreshed credentials in memory.

Broker failure, malformed or empty output, and HTTP failure return quietly to
the existing optional-publication warning. Credentials never enter command
arguments, diagnostic output, or persistent files. Both auth refresh and HTTP
operations retain liberal 60-second bounds. Benchmark execution deadlines and
acceptance behavior do not change.

The existing publisher blackbox now covers successful refreshed publication,
exact selected-token precedence, legacy compatibility, and quiet failure paths
that make no HTTP request. It remains in the existing 44-case benchmark wrapper
and deploy Step 4cb; no new large verification suite is added. The unchanged
owning test passed in 1.07 seconds; eleven related reuse/publication controls
passed in 2.13 seconds. The actual registered 44-case wrapper passed in 37.85
seconds. Independent review approved the implementation and separately ran
the owning test in 1.03 seconds. The modified helper then succeeded against the
native metadata endpoint, quietly returning success; its diagnostic entry was
deleted with HTTP 204 after an initial rate-limit response. The final fixture
preserves all three synthetic session components during refresh.
The final owning case, including malformed-header privacy, passed independently
in 1.96 seconds. Publishing the actual completed dependency receipt and reading
it back through the normal native inventory parser both succeeded; the parser
returned the exact verified receipt with the donor still stopped. That native
publication/discovery check took 4.52 seconds and does not establish whole-fleet
startup duration.

The documented CLI guidance distinguishes stale session discharges from image
or dependency changes. Models, prompts, task definitions, evaluators, production
harness behavior, and normal task deadlines are untouched.

Native auth implementation:
https://github.com/superfly/flyctl/blob/v0.4.76/internal/command/auth/token.go

## Human feedback

The user wants future branch deploy benchmarks to start quickly, wants the reuse
path integrated into the normal CLI, and requires compact deploy regressions.
Do not describe an unmeasured full readiness time as an established speedup.

## Reusable lesson

Use the provider CLI to refresh the selected short-lived session at a custom
API boundary; do not confuse a stale raw session with missing cache contents.
