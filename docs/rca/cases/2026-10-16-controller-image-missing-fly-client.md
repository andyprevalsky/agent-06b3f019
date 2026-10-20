---
id: 2026-10-16-controller-image-missing-fly-client
date: 2026-10-16
title: Disposable controller omitted the native client required by its campaign publisher
surface: infra
component: cloudbench-controller-bootstrap
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: run-cloudbench-controller-gate enters the non-root campaign command without supplying flyctl although its selected warm workload image does not install that controller tool
symptoms:
  - Fly client is not available for the campaign inventory
  - Campaign inventory did not initialize; see private publisher log
  - Attempt55 cancelled600 scheduled jobs withzero physical task attempts
tags:
  - cloudbench
  - controller
  - flyctl
  - executable-path
sources:
  - plan:/tmp/pr1525-original600-resume/attempt55-1792182437962406874/run/bootstrap-read-1792182657355848628.safe.json
  - plan:/tmp/pr1525-controller-client-path/.context/controller-client-path-proof/old-publisher-red.log
  - plan:/tmp/pr1525-controller-client-path/.context/controller-client-path-proof/green.log
repro: python3 scripts/tests/cloudbench-controller-client-path.test.py
status: open
---

## Problem

Original600 attempt55 created its disposable controller and256GiB workspace,
verified backupsdisabled, then failed before any benchmarktask dispatch.
The actual parent-owned publisher wrote exactly `Fly client is not available
for the campaign inventory`. All600 scheduled jobs were cancelled; this is
harness startup failure, not30 confirmed infrastructure failures.

## Diagnosis

Critical path: warm workloadimage → gate repository/bootstrap → non-root gosu
login shell → campaign scheduler → shared inventory publisher → executable
lookup. The publisher correctly requires a native client onPATH or in the
user's existing Fly directory. The gate supplied Node and Python dependencies
but no Fly client; neither warm Dockerfile installs it. The live evidence proves
that effective lookup failed, not that every possible root-only path was absent.

Archive searches used `Fly client is not available campaign inventory` and
`controller rose PATH flyctl missing image bootstrap`. The controller npm-package
case is a relative about consumer executable completeness, not this same tool.
The shared campaign-inventory case intentionally retains the same client lookup.
No change to that native dependency or its publisher semantics is justified.
The deeper owned gap is packaging controller tools when borrowing an image built
for workloads. Supplying the tool once also serves fleet/worker child consumers.

The unchanged owning control renders the actual gate gosu/login-shell command
and runs the real publisher executable-discovery prefix. On bcd892994 it fails
with the exact55 literal. After the fix it installs the official release artifact
at its pinned SHA, executes the same publisher prefix, and reports the expected
client version. One official-artifact run used actual gosu and the113733507-byte
binary; the routine offline case substitutes only release bytes/digest with a
small compiled client and uses the actual non-root login-shell boundary.
This proves bootstrap causality. It does not prove the original600 benchmark
outcome; that remains open for the root operator's next unchanged run.

## Solution

The explicit disposable-controller command installs pinned Fly CLI v0.4.115
inside its own workspace and adds that directory inside the login shellPATH.
The [official release](https://github.com/superfly/flyctl/releases/tag/v0.4.115)
archive is bounded and must contain exactly one regular `flyctl` member with
size113733507 and binary SHA256
5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83.
This equals the existing root operator's selected client; the downloaded official
archive was verified locally against it. No113MB binary is embedded in Machine
configuration. No workload image rebuild, app-secret update, task definition,
profile,600 concurrency or1200/5400-second benchmark budget changes.

Installation runs inside the existing recorded gate command, so failure follows
its ordinary exit/export path. The original failed55 records remain unchanged.
The source/root operator retains native execution and independent review.

## Human feedback

The user required correct fast startup/teardown while preserving warm-image
speedups and the original600 workload. Root review rejected embedding the113MB
client into Machine config; use pinned workspace installation instead.

## Reusable lesson

Package the native control-plane tools required by the actual non-root controller consumer when reusing a workload image.
