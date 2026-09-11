---
id: 2026-09-11-test-startup-rewrote-shared-prisma-client
date: 2026-09-11
title: Concurrent test startup recopied the Prisma engine while semantic seeding loaded it
surface: harness
component: backend-test-launchers
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/scripts/run-blackbox-tests.sh unconditionally regenerated shared node_modules during parallel Group 4
symptoms:
  - "segment '__TEXT' load command content extends beyond end of file"
  - "Unable to require libquery_engine-darwin-arm64.dylib.node"
  - "browser-take-control failed in seedBrowserControlSession"
tags:
  - prisma
  - race-condition
  - native-engine
  - semantic-tests
sources:
  - PR #1299
  - commit ce406cbef163386a99845f5d530f09cf7786e056
repro: scripts/tests/prisma-test-launcher-readonly.test.py
status: fixed
---

## Problem

The parallel Group 4 run started at 2026-09-11 12:31:03 UTC. The unchanged
`browser-take-control` semantic failed during its Prisma seed, before browser
interaction, with the literal Mach-O error above. The E2B blackbox launcher was
concurrently running `npx prisma generate`; the generated native engine and
schema were replaced at 12:31:08. The other twelve semantic tests passed.

The original semantic log and trace/video/screenshot bundle are retained under
`.context/acceptance/prisma-shared-client-rca/` and
`.context/acceptance/final-ce406-group4-semantic.log`.

## Diagnosis

The installed Prisma generator's `overwriteFile` uses unlink followed by a
direct copy on Darwin. A reader can therefore load a partially copied native
library. A controlled local reproduction executes that installed function in
a disposable directory and schedules a real Node reader after the first
4096 bytes are visible, before the remaining bytes are copied. The complete
17,251,592-byte engine loads successfully before and after; the intermediate
reader exits 1 with the exact observed error. This is controlled scheduling
of the installed implementation, not a claim to have captured every syscall
from the original live race.

The deepest owned gap is dependency ownership: both blackbox and coverage
launchers regenerate shared dependencies while other test processes may use
them. Their databases are isolated, but `node_modules` is shared. A lock held
only by generators would not protect existing readers. Initial generation
already belongs to npm postinstall and the deploy dependency-preparation
stage. The repeated generation is redundant after that stage.

## Solution

Remove generation from both test launchers and call one shared read-only
freshness check before schema sync. It verifies installed package versions,
formats a private source-schema copy with the installed Prisma CLI, and
compares it with the generated schema. Stale or missing dependencies fail
before DDL with an explicit instruction to prepare dependencies while stacks
are stopped. Database sync retains `--skip-generate`.

The real-launcher regression drives both shipped scripts with disposable DB
and process boundaries. Before the fix, fresh clients are rewritten and stale
clients reach DDL: four assertions fail. Afterward all four pass. Two added
cases verify missing clients and mismatched versions fail before DDL. The
suite is permanently invoked by the existing backend coverage-script unit
test. An independent reviewer reproduced the native error and approved the
read-only boundary.

This removes the same mutation hazard for semantic seeds, backend startups,
and other test readers. The check runs once per test launcher, not per agent;
there is no per-agent cost or lock at 10,000 agents. It proves schema/package
consistency, not native-engine integrity or protection from an unrelated
external dependency writer. The unchanged semantic suite passed all thirteen
tests in 54.6 seconds while the real E2B blackbox ran concurrently and passed
in 20.2 seconds. Both launchers started at 12:39:45 UTC; the after-run logs are
`.context/acceptance/prisma-readonly-{semantic,e2b}-after.log`.

## Human feedback

The user requires completion without repeated permission requests, normal
120-minute execution backstops, and a temporary five-minute limit for this
validation. This fix changes no task, timeout, recording, or cleanup bounds.

## Reusable lesson

Prepare shared dependencies before concurrent consumers start, and make test
startup verify freshness without rewriting those dependencies.
