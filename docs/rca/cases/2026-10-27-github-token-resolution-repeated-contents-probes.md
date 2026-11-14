---
id: 2026-10-27-github-token-resolution-repeated-contents-probes
date: 2026-10-27
title: Controller token resolution eagerly probed and revalidated durable credentials
surface: infra
component: cloudbench-github-token-resolution
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-cloud resolve_github_token eager resolve_durable_github_token call
symptoms:
  - Durable Contents probe runs before a valid injected token
  - Same credential receives repeated Contents requests within one resolution
tags:
  - github
  - token
  - quota
  - redundant-read
sources:
  - commit 35b98fdb4d20f99898efd4fea328d21104ae957a
  - agent ph74rex3pescaywbxyjn3njr158h3pp9
repro: scripts/tests/cloudbench-github-token-probes.test.py
status: open
---

## Problem

During repeated benchmark preparation the shared GitHub credential was reported
at core remaining 0 of 5000. The launch owner retained parsed session output but
not the original response headers or body. The callers responsible for those
5000 requests remain unknown. Independent offline investigation found redundant
Contents requests inside one controller credential resolution. This narrower
owned defect is reproducible; it is not proof of the aggregate quota cause.

## Diagnosis

The controller gathered B64, sanitized gh and ambient candidates, but eagerly
called the validating durable resolver before trying any of them. A successful
durable token was then validated a second time. Duplicate token values across
sources were also rechecked. Controlled curl/gh executables invoke the extracted
actual Bash functions with temporary dotenv files and assert the existing
Contents endpoint, 5/15-second bounds and private curl config. Baseline controls
measure 2 requests for a valid injected token, 2 for durable-only success, and 7
for a repeated-invalid candidate followed by valid durable fallback. The same
controls expect 1, 1 and 2 respectively and fail on the original source.

## Solution

Resolve the durable tier only after higher-priority candidates fail, return its
already-validated result directly, and track exact previously checked values
only for the current call. Durable direct callers retain the same source order.
A subsequent resolution checks again, including within the same shell, so a
previously valid credential revoked in the next call is rejected. The endpoint,
authorization, status requirement, timeouts, source priority and fail-closed
behavior do not change. This does not add a shared cache, retry policy, token
rotation or benchmark exemption. The permanent extracted-function test is
invoked by the existing registered GitHub-token suite.

The ten offline controls pass after the repair. Independent review marked the
exact three-path patch GROUNDED before application, SHA256
57b086a9ccf3e4197e3ffdb0781efe92bd3497950426c8c106b118251969afc9.
The registered GitHub-token owning suite also passes with its optional live
check disabled by leaving GITHUB_DISPATCH_TOKEN unset. No live
GitHub, benchmark, image or production action was used for this investigation.
The quota root cause and next unchanged campaign outcome remain unproven, so
this case stays open after the bounded source repair.

## Human feedback

The parent required actual owning-function request counts, no attribution of
all 5000 requests to this defect, unchanged credential authority, no stale auth
cache, and independent exact-snapshot grounding before applying runtime edits.

## Reusable lesson

Validate distinct credentials in priority order within a resolution, and do not
make a successful lower-tier resolver's result pass the same network check twice.
