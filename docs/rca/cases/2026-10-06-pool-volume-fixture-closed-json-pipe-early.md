---
id: 2026-10-06-pool-volume-fixture-closed-json-pipe-early
date: 2026-10-06
title: Pool-volume fixture closed its JSON pipe early and rejected admitted Machines
surface: harness
component: cloudbench-env-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/cloudbench-env.test.sh machine_volume_id_from_json mock returned without consuming stdin
symptoms:
  - small benchmark did not prefer the admitted 4GB Machine
  - pool machine a1 has no durable exact teardown-manifest record; leaving it unclaimed
  - pool volume fixture did not consume its complete JSON input
tags:
  - pipefail
  - sigpipe
  - pool-admission
  - fixture
sources:
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
repro: bash scripts/tests/cloudbench-env.test.sh
status: fixed
---

## Problem

The unchanged deploy controller gate rejected fixture Machine `a1` instead of
selecting its admitted 4GB shape. The production claim function reported no
durable teardown record, although the fixture supplied a volume and successful
claim/audit stubs. The original failure is retained in
`.context/wmh-controller-gates.log`.

## Diagnosis

The path was inventory JSON → producer pipe → mocked volume parser → pipeline
status → `claim_pool_machine` volume admission → unchanged shape assertion.
The mock printed its volume without reading stdin. Its early exit could cause
SIGPIPE in the producer. With `pipefail`, the production caller correctly
classified that failed pipeline as an unavailable volume and refused the claim.
The real parser calls `json.load(sys.stdin)`, consuming the complete stream.

A native probe of the original mock pipeline failed 17 of 1,000 attempts.
The permanent owning test now supplies the same valid inventory with 1MiB of
leading JSON whitespace, exceeding a pipe buffer. Before repairing the mock,
`bash scripts/tests/cloudbench-env.test.sh` exited 1 with
`FAIL: pool volume fixture did not consume its complete JSON input` in
`.context/wmh-pool-consumer-owning-red.log`. Independent adversarial review
also measured `PIPESTATUS=141 0` before and `0 0` after draining stdin.

Archive searches used both the literal missing-teardown-record error and
behavioral pool-fixture admission terms, then `SIGPIPE mock stdin consumer
fixture pipeline` and `volume parser stub printf pipefail empty claim`.
The September 4 early-exit grep case and October 3 target-mode head case are
relatives; neither repaired this mock consumer. The deepest owned gap is the
fixture's violation of the stream-consuming provider contract.

## Solution

Drain stdin before returning the existing fixture volume and propagate a read
failure. Preserve both original admitted-shape assertions and every production
ownership check. The same permanent owning command passed with the unchanged
stress assertion, including the final reviewed read-error guard, in
`.context/wmh-pool-consumer-owning-green-final.log`.

This repairs the shared mock for both small and large pool claims. It changes
only test setup and has no runtime cost or policy change at 10,000 agents.
The full controller regression stage remains required during deploy; this
fixture result supplies no fundraiser or fleet acceptance credit.

## Human feedback

None recorded.

## Reusable lesson

A mocked stdin consumer must preserve the real parser's EOF and read-error
contracts; early exit can turn valid data into a pipefail admission failure.
