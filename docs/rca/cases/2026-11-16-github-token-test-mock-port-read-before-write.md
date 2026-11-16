---
id: 2026-11-16-github-token-test-mock-port-read-before-write
date: 2026-11-16
title: cloudbench-github-token test read its rotation mock's port file between truncate and write, so a loaded runner targeted a portless Git URL and failed "delivered token was not valid at delivery"
surface: infra
component: cloudbench-controller-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-github-token.test.sh mock servers: `Path(...).write_text(port)` (truncate, then write) raced the shell's `[ -f port ]` wait, which then read an empty port"
symptoms:
  - "FAIL: machine-env: delivered token was not valid at delivery"
  - "cloudbench-controller github-token FLAKY"
tags:
  - deploy
  - cloudbench-controller
  - flaky
  - load
  - mock-server
  - race
sources:
  - PR #2338 deploy, cloudbench-controller gate on Blacksmith blacksmith-8vcpu-ubuntu-2404 at source 5c613cd797 (2026-11-16 ~07:30Z), occurrence e76e6891460749418e2f8cbb0a3c4dab
repro: scripts/tests/cloudbench-github-token-probes.test.py MockPortPublish
status: fixed
---

## Problem

During the PR #2338 deploy, the `github-token` suite of the cloudbench-controller
gate failed once on Blacksmith with `FAIL: machine-env: delivered token was not
valid at delivery`. Every other case in the suite passed. The same suite passed
earlier in that deploy at 1066bdff3f, and no token-delivery code changed between
the two revisions. It also passes locally. PR #2338 touches only
`agents/browser_tools/write_lock_probe.py` and its tests. Gate: NOT_INTRODUCED.

## Diagnosis

Section 3b starts a single-threaded dumb-HTTP Git mock. The mock publishes its
port with `(root / "port").write_text(...)`, which opens the file with O_TRUNC
and writes afterwards. The shell polls only `[ -f "$ROT/port" ]` and then
`cat`s the file. If the runner deschedules the mock between those two steps, the
shell reads an empty port, and `ROT_GIT` becomes `http://127.0.0.1:/rose.git`.

For the first delivery site (`machine-env`, which is `cloudbench_guest_github_token`):
- The App token's Contents read (`git ls-remote` against `ROT_GIT`) fails.
- Delivery falls back to the controller chain, whose Git credential helper
  answers with `DEVBOX_OLD` without any network check.
- The test's `guest_fetch_authenticates` then `ls-remote`s the portless URL and
  fails with the observed line.

The suite's first mock (`$TMP/port`) has the same race.

Ruled out: a real-network or real-pool leak. `deliver` and the guest fetch run
under `env -i`, the pool script is the fixture's fake, and the
`CLOUDBENCH_GITHUB_REPO_GIT_URL` mock is pinned. The REST quota therefore cannot
reach this path.

Repro: a `sitecustomize` on `PYTHONPATH` makes `Path.write_text` for the
`rotation/port` file create it empty and then sleep before writing. On 615d755752
(token code identical to 5c613cd797), `bash scripts/tests/cloudbench-github-token.test.sh`
exits 1 with exactly `FAIL: machine-env: delivered token was not valid at delivery`.

## Solution

Both mock servers now write `port.tmp` and `os.replace` it to `port`, so the
shell can only ever see a complete port. The CI run did not capture
`deliver.err` or git's stderr, so the shell now also rejects an empty or
non-numeric port and names it (`rotation mock published a non-numeric port ''`),
making any recurrence self-explaining. An independent reviewer named the same
boundary before reading the diff and reproduced the exact CI line.

Regression: `MockPortPublish` in `scripts/tests/cloudbench-github-token-probes.test.py`.
The suite itself runs this file, so the regression is part of the cloudbench-controller
`github-token` step. It reruns the real suite offline (with `GITHUB_DISPATCH_TOKEN`
stripped) while every `port*` publish is stalled for 0.5 s mid-write.
- Before the fix it fails: `FAIL: resolver returned no token when GITHUB_DISPATCH_TOKEN was usable`, the first mock losing the same race.
- After the fix it passes.

The full suite passed 5/5 idle and 5/5 under a 12-way CPU busy loop on 8 vCPUs.

10k-agent behavior: none (test fixture only).

## Human feedback

None recorded.

## Reusable lesson

A test helper that publishes a value through a file the shell polls must write
it atomically (temp file plus rename). `[ -f ]` proves that the file exists, not
that its content is complete.
