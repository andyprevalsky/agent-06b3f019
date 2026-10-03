---
id: 2026-09-27-fly-controller-local-tests-inherited-production-identity
date: 2026-09-27
title: Local backend capture tests inherited a Fly controller's production identity
surface: back-end
component: cloud-controller-test-environment
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The local backend coverage child inherited FLY_APP_NAME from its Fly controller before importing the local dump writer
symptoms:
  - "ENOENT: no such file or directory, scandir '/data/rose-pr1299/.llm-dumps/rose-dump-test-agent'"
  - "FAIL client / dump context writes request and output"
tags:
  - cloud-controller
  - blackbox
  - llm-dump
  - environment
sources:
  - PR #1299
  - commit f94858c8316609b2c8e7c94c07f2b74a7672687f
repro: back-end/src/tests/blackbox/rose.blackbox.ts
status: open
---

## Problem

The local backend coverage gate on the owned Fly controller failed the Rose
capture test while 78 of its 79 assertions passed. The test expected one local
file containing the completed request and response. No file was written.
This was independent of the same gate's PostgreSQL recovery failures and
expired Codex OAuth credential.

## Diagnosis

The private coverage launcher passed its controller's `FLY_APP_NAME` into the
local test process. `back-end/src/providers/llmDump.ts` intentionally determines
production mode once, at import: any defined value, including an empty string,
disables local disk dumps. The test correctly exercises local capture but was
launched with production capture configuration. Changing the variable after
provider imports is too late.

The same assertion against the actual unchanged module failed with inherited
Fly identity in 0.253 seconds and passed with that one child variable absent in
0.293 seconds. Separate controls verified that absent identity captures input
and completed output, while both empty and nonempty identity preserve the
production no-local-file contract. No provider, model, or database call was
made by those isolated controls. Exact outputs and source hashes are retained
in `.context/acceptance/proof21-dump-environment-rca/`.

The literal archive search `ENOENT rose-dump-test-agent scandir` found no exact
case. The behavioral search `LLM dumps Fly cloud backend blackbox test absent
file` found the July 4 archive writer/reader environment mismatch and September
11 chat dump-binding case. They are relatives; neither explains this inherited
controller identity boundary. The stream-contract domain's observed failure in
this run occurred earlier at a PostgreSQL call, so it is not counted as another
observed dump failure.

## Solution

Run local backend coverage with `env -u FLY_APP_NAME` on the test child command,
before TypeScript imports. Preserve the parent controller's provider identity
and ownership checks. Keep production dump guards, benchmark environments,
models, prompts, evaluators, workloads, and concurrency unchanged. An empty
assignment is not equivalent to removing the variable.

This is a test-host configuration correction, so the existing blackbox capture
assertion remains the regression gate. Production-mode controls remain
explicit. No production code or benchmark policy repair is required. The
change adds no per-agent work at 10,000 agents; it changes one local test
process's environment.

The unchanged selected replay passed all 15 selected previously failing domains,
including Rose and stream-contract, in 38.717 seconds with native exit 0.
Its separate process retirement receipt verifies that the leaked test-server
descendants were removed; a successful wrapper exit alone did not prove cleanup.
Complete backend coverage remains pending, so this case stays open. The narrow
controls and selected replay do not substitute for full coverage or the requested
100-outcome cloud infrastructure proof.

## Human feedback

The user requires infrastructure-only repairs, unchanged benchmark behavior,
three successful LLM queries per benchmark, ten consecutive slices of ten,
and a temporary 300-second benchmark backstop. The environment correction does
not alter those requirements.

## Reusable lesson

Set a local test process's environment before importing modules that cache deployment identity, while preserving the controller's own provider identity.

## October 2 recurrence: controller coverage

The local coverage child repeated this boundary on `e5586839`.
The controller retained a defined `FLY_APP_NAME`; its private canonical child
configuration copied the host environment without removing that variable. The
unchanged production guard consequently suppressed local captures. The failed
634.411-second aggregate remains native exit 1 with 177/179 domains passing.
`llm-stream-contract` failed both router/generator completed-capture assertions;
Rose failed its request/output dump read with `ENOENT`. Rose's 84/85 case count
is its internal tally, not a third failed domain.

The existing unchanged capture assertion failed with defined identity in 2.555
seconds and passed with that one child variable absent in 0.192 seconds. The
actual unchanged two-domain runner then passed both domains in 4.838 seconds,
including all 85 Rose controls and completed/consumer-close chat captures. All
2,561 source-input hashes matched the failed aggregate; both native owners and
the child process group retired. Only the test child identity changed. The
controller identity, production guard, provider stubs, normal domain limits,
and 1,800-second supervisor bound were preserved.

An earlier selected attempt used the prelaunch database placeholder and failed
Prisma initialization before those assertions. Its original evidence is retained
as an ineligible harness attempt. Private causal and native receipts are under
`.context/acceptance/proof115-backend-failure-rca/`. The required correction is
`env -u FLY_APP_NAME` before local test imports; an empty assignment still enables
the production guard. The original failed aggregate stays failed, and selected
passes do not claim a fresh full coverage threshold or any fleet credit.
