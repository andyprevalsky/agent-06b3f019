---
id: 2026-10-06-semantic-deploy-amplitude-probe-failure-dropped-its-output
date: 2026-10-06
title: The semantic-deploy live Amplitude contract check failed once under deploy load and dropped the probe output
surface: harness
component: semantic-deploy-gate
classification: undetermined
problem_class: other
first_bad_boundary: "scripts/tests/semantic-deploy-gate.test.sh discarded the admin-health probe output when the fail-closed credential message was absent"
symptoms:
  - "FAIL: /deploy live Amplitude probe must explain its fail-closed credential contract"
  - "failed deploy structural gates: cloudbench-fetch-ref, semantic-deploy"
tags:
  - deploy-gate
  - semantic-deploy
  - amplitude
  - diagnostic-retention
  - flaky
sources:
  - PR #1416
repro: scripts/tests/semantic-deploy-gate.test.sh
status: open
---

## Problem

During the PR #1416 Test Loop rerun on 2026-10-06, the Step 4s structural
runner (`--max-workers 2`) reported `semantic-deploy: exit=1 duration=5.19s`.
The gate stopped at its live Amplitude credential check. At the time the
backend, frontend and agents coverage lanes were also running (load average
15–18 on a four-core host). The probe exited nonzero, as required, but its
output lacked
`ADMIN_HEALTH_LIVE_ONLY=1 requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY`.
The test printed only its own assertion, so the probe's actual output was lost.

## Diagnosis

Run alone, the exact probe printed the required message. The whole gate passed
alone in 62 seconds. A further 159 probe runs reproduced nothing: 12 in
sequence, and 147 alongside the overlapping `benchmark-live-results` gate.
Several suspects were ruled out:
- The Prisma client is regenerated only under a schema-change lock, and this
  merge changed no schema.
- The cleanup tests that ran nearby kill exact PIDs and ports, not processes
  by working directory.
- The structural runner passes the caller's environment unchanged.

Without the failed probe's bytes, no cause can be assigned. This is the same
evidence-loss pattern as
`2026-09-11-semantic-deploy-fixture-failure-lost-inner-evidence`.

## Solution

The check now writes the last 40 lines of the probe output to stderr before
failing, so a recurrence keeps its evidence. The credential contract and its
assertions are unchanged. This case stays open until a recurrence identifies
the cause or repeated loaded Test Loop runs show it does not recur.

## Human feedback

None.

## Reusable lesson

A wrapper assertion about a child's output must retain that output on failure;
otherwise a one-off failure cannot be diagnosed.
