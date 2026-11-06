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
  - "run-blackbox-tests.sh: scripts/lib/run-process-cleanup.sh: No such file or directory"
tags:
  - prisma
  - race-condition
  - native-engine
  - semantic-tests
sources:
  - PR #1299
  - commit ce406cbef163386a99845f5d530f09cf7786e056
repro: scripts/tests/prisma-test-launcher-readonly.test.py
status: open
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

### 2026-10-02: Keep the real-launcher fixture's sourced libraries complete

After integrating main, backend coverage failed three of this regression's six
cases before reaching the Prisma boundary. The shipped blackbox launcher now
sources `scripts/lib/run-process-cleanup.sh`; its disposable fixture copied only
`workspace-env.sh`. Fresh-client execution exited 1 instead of reaching the
fixture's exit-77 boundary, and stale/missing-client cases never reached their
required freshness diagnostic. The coverage-launcher cases still passed.

Copy the additional shipped library into the same disposable fixture. This is
one fixture line: all six assertions, launchers, freshness checks and deadlines
remain unchanged. The identical command,
`python scripts/tests/prisma-test-launcher-readonly.test.py`, reproduced three
failures and three passes before the correction (4.042 seconds), then passed
all six cases afterward (9.899 seconds). The fixture uses the installed Prisma
formatter with disposable schemas and fake DB/process boundaries; it makes no
database, provider or model calls. Original output and process receipts are
retained privately under `.context/acceptance/proof105-prisma-fixture-rca/`.

This repairs this case's regression fixture; the shared-client mutation did not
recur. Archive searches also identified the July 21 sourced-helper extraction
case as a related fixture-dependency failure. Keep the real launcher's sourced
dependency graph available in its test instead of weakening the downstream
behavioral assertion. Independent review confirmed that every original assertion
and runtime helper is unchanged. The owning TypeScript coverage-script unit also
passed in 6.409 seconds. The full backend coverage gate still requires a fresh
report after its separate treasury failure is resolved; unaffected passing gates
do not require repetition for this test-only change.

### 2026-11-04: Read-only launcher fixture freshness failure remains OPEN

The b9 frozen source `b9a1f743152e29cb6626ed33fdce88d24a919ba1`
(digest `4932feb31a837ec6c218643f1d9e9193e924c7ace9acc9fbaf2ad5ac2d1f233f`)
full backend unit run failed two of356files. In `coverage-script.test.ts`,
`test_blackbox_fresh_client_remains_read_only` expected77 and received1:
`Prisma client is stale or unavailable`. The five remaining launcher-fixture
cases completed. The original native units log is preserved privately with
its SHA256 in the delegated RCA report.

This is a recurrence in the existing regression fixture, not proof that the
historical shared-client rewrite recurred. **Gate: UNKNOWN; follow-up OPEN.**
The actual freshness guard exited before the fixture's post-sync sentinel.
Its catch combines package resolution/version failures, formatter status/error
or the unchanged10000ms formatter timeout, and schema-byte mismatch into the
same diagnostic. The failed temporary fixture was removed; its inner exception,
formatted/source/generated schema bytes and original dependency identities
were not retained. The fixture and guard are byte unchanged from baseline6f
throughb9; that alone does not explain this occurrence.

A private unchanged original fresh-client invocation passed in2.179s, then the
unchanged complete six-control command
`python3 scripts/tests/prisma-test-launcher-readonly.test.py` passed in8.423s.
These later observations do not repair or supersede the retained native failure.
No fixture/runtime change is proposed and no memory, timeout or concurrent-write
cause is inferred. Preserve the10000ms guard,40s launcher and90s wrapper bounds,
all read-only/negative assertions and the original failed result. The missing
next discriminator is the actual failed guard exception/formatter status and
its disposable input bytes; capture those through an authorized narrow
observation before choosing a repair. Full current-source acceptance remains
unverified. Parent retains source/deploy ownership.

## Human feedback

The user requires completion without repeated permission requests, normal
120-minute execution backstops, and a temporary five-minute limit for this
validation. This fix changes no task, timeout, recording, or cleanup bounds.
For the fixture follow-up, the user requested compact regression coverage and
avoiding unnecessary proof resets. The six existing cases remain the coverage.

## Reusable lesson

Prepare shared dependencies before concurrent consumers start, and make test
startup verify freshness without rewriting those dependencies.
