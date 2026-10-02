---
id: 2026-09-30-indexeddb-memory-blackbox-shared-fixture-identity
date: 2026-09-30
title: Parallel IndexedDB memory tests shared a temp payload path and database user
surface: harness
component: indexeddb-upload-memory-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts used a fixed system-temp payload path and fixed user ID for independent runs
symptoms:
  - "ENOENT: no such file or directory, open '/var/folders/rx/3rp8lsy17zx6sf8gtp97lr_00000gn/T/idb-upload-memory-payload.json'"
  - '❌ both origins land and the large blob round-trips by md5'
  - 'independent runs shared the payload fixture'
tags:
  - indexeddb
  - blackbox
  - temp-file
  - parallel-tests
  - fixture-ownership
sources:
  - commit 06f714328b0a555e35fa55d356c07e1684c1a25e
repro: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts
status: fixed
---

## Problem

The second backend coverage deploy gate passed 219 unit test files and 163 of
164 blackbox domains. `indexeddb-upload-memory` built a 49.9 MB payload,
proved the JSON.parse control OOMed under 256 MB, and proved the treatment
ingested under the same heap cap. Its final md5 round-trip assertion then
failed because the fixture file was absent:

```text
❌ both origins land and the large blob round-trips by md5
   ENOENT: no such file or directory, open '/var/folders/.../T/idb-upload-memory-payload.json'
```

The failure is in `.context/deploy-runs/20260930-235404-20524/logs/backend-coverage-blackbox-20261001-001304-87075.log`.
The original deletion process was not recorded. The test's source showed that
every workspace used the same `os.tmpdir()` filename and removed it in its
`finally` block. Workspaces had separate Postgres containers but shared the
host temp directory.

## Diagnosis

Critical path: test writes the global temp path → control and treatment child
processes read it → an independent run can replace or delete it → final md5
read gets `ENOENT`. The first bad boundary was assigning a process-external
name to a fixture intended to be owned by one test run. The same test also
used one constant database user ID, so two runs sharing a database could
delete each other's rows. These are sibling violations of fixture ownership.

Archive searches: `indexeddb-upload-memory ENOENT idb-upload-memory-payload.json
round-trips by md5` and `parallel workspaces shared os.tmpdir fixed fixture
filename cleanup deletes another test`. The closest case,
`2026-08-12-indexeddb-upload-json-codec-ooms-backend`, created this memory
test for a production JSON codec failure; it has a different first bad
boundary. This is a new harness case. Adversarial review identified the fixed
user ID, cleanup ordering, and caller-path override as related risks; the fix
addresses them all.

## Solution

The normal parent test creates a unique directory with `mkdtempSync` and
generates a unique user ID. It passes both values to its control and treatment
children. A caller-supplied payload path is honored only in child mode; the
normal parent always owns a fresh path. Nested `finally` blocks remove the
owned directory even if database cleanup or disconnect fails. A child never
deletes the parent's fixture.

The permanent blackbox compares payload paths and user IDs from independent
parent-mode processes, including when they inherit a shared override. Before
the fix, the exact command
`CONDUCTOR_PORT=55170 bash scripts/run-blackbox-tests.sh indexeddb-upload-memory`
failed `independent runs shared the payload fixture` (6/7 checks, exit 1).
With the fix, the same command passed `indexeddb-upload-memory` (exit 0),
recorded at `.context/test-runs/1790814157-90535-363/runner.log`. The
domain is part of the backend coverage blackbox gate on every `/deploy`.

No production behavior changes. Each test run creates one small temp
directory plus its existing 49.9 MB fixture, then removes only its own data.

## Human feedback

None recorded.

## Reusable lesson

Give every parallel test run its own file path and database identity, and clean up only the resources it owns.
