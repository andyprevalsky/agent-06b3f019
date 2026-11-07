---
id: 2026-11-07-campaign-inventory-test-reads-pidfile-before-child-writes-it
date: 2026-11-07
title: Campaign inventory auth test reads its child's pidfile between file creation and the pid write
surface: infra
component: agents/benchmarks/cloudbench_campaign_inventory_test.py
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: test_campaign_inventory_full_http_auth_deadline_and_owned_join waits on pidfile.exists() and then int(pidfile.read_text()), but Path.write_text creates the file before it writes the pid
symptoms:
  - "ValueError: invalid literal for int() with base 10: ''"
  - "FAILED benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_full_http_auth_deadline_and_owned_join[False]"
  - deploy-command-structural UNVERIFIED with benchmark-live-results[2/6] failing only under concurrent gate load
tags:
  - flaky-test
  - structural-gate
  - load-sensitive
  - staged-deploy-cycle
sources:
  - PR #1721
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. In the PR #1721 staged cycle on head 0358982d7 the
`deploy-command-structural` gate failed in `benchmark-live-results[2/6]`:
`test_campaign_inventory_full_http_auth_deadline_and_owned_join[False]` raised
`ValueError: invalid literal for int() with base 10: ''` at the pid read. It
passed in the cycle before and when run alone (1.2 s), and it is the known
load-only campaign-inventory flake.

## Diagnosis

The fixture's fake `flyctl` runs `Path(pidfile).write_text(str(os.getpid()))`. That
call opens (creates) the file, then writes. The test loops until `pidfile.exists()`
and immediately reads it, so on a loaded host (a staged cycle runs twelve gates at
once) the read lands in the window where the file exists and is empty.

## Solution

The wait loop and the assertion now require non-empty content
(`pidfile.exists() and pidfile.read_text().strip()`). The assertions that follow are
unchanged. 5 consecutive passes of both parametrizations. Sibling prevention: a test that
polls for a file a child writes must wait for its content. No runtime change.

## Human feedback

None recorded.

## Reusable lesson

Poll for the content a child writes, not for the existence of its file, because creation and write are separate steps.
