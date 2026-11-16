---
id: 2026-11-16-controller-fixtures-targeted-caller-credential-files
date: 2026-11-16
title: Whole-entry controller fixtures targeted caller credential files
surface: harness
component: cloudbench-controller-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Whole-entry tests executed the source checkout launcher before isolating its ROOT_DIR and controller credential exporter
symptoms:
  - Controller help and script snapshot tests changed checkout GITHUB_TOKEN entries
  - Inherited encoded token won over a dummy Git credential helper
tags:
  - cloudbench
  - fixture-isolation
  - credentials
sources:
  - commit 42620588d122341217325872e94e6df441bde997
  - agent ph72xmcn4a2s8qhym5zjgx2tbd8jan1w
repro: Synthetic direct run-bench-fleet --help changes caller dotenvs; identical help under isolated_controller_checkout preserves present and absent caller files
status: fixed
---

## Problem

Whole-entry snapshot and bootstrap tests executed the checkout launcher. Its
normal startup exports controller GitHub auth into ROOT_DIR/agents/.env and
ROOT_DIR/back-end/.env before handling --help. Tests therefore wrote caller
credential files. No real credential is part of this case or its reproduction.

## Diagnosis

The source path determines ROOT_DIR before token export. A dummy Git helper is
insufficient because inherited CLOUDBENCH_GITHUB_TOKEN_B64 has higher precedence.
Independent review rejected that initial approach and accepted the corrected
four-file patch SHA256 f71425d7371b8c6fa810d50cb8d9e290f64b0644d095077723fafab3741e6a99.
Its review confirms all 110 original snapshot assertions and all 660 bootstrap
assertions remain, with three added positive exporter assertions.

Archive searches were `controller fixture GITHUB_TOKEN dotenv` and `test fixture
environment mutation`. The October 5 concurrent dotenv-upsert case is related
but owns atomic production publication; this case instead owns test roots.
Production exporter behavior is intentionally unchanged.

## Solution

Copy the actual launcher entry scripts into a private Git checkout, alias
read-only source inputs, create private synthetic dotenvs, isolate Git config,
and pin the highest-priority encoded auth input to a dummy token. Assert caller
file existence/bytes remain unchanged and private exports contain only expected
fixture auth. Use this helper for six snapshot cases and bootstrap entrypoints.
The recurring benchmark selector retains its original 27 cases and adds the
other five lifecycle cases for an explicit 32-case gate. No runtime, task,
prompt, evaluator, timeout or acceptance rule changes. Golden reference is not
applicable to this test-only repair; independent RCA review is retained.

## Verification

A synthetic private-root replay of direct --help exits 0 and changes both
caller dotenvs. The same entry under the fixture exits 0 for present and absent
caller dotenvs, preserves them, and proves the actual exporter wrote the exact
synthetic token privately. The delivery receipts retain source SHA, commands,
exit codes, counts, environment hashes, independent review and full gate logs
under .context/controller-fixture-delivery. The cherry-picked patch has the
same stable patch ID as the reviewed source commit. Full delivery validation
and immutable push receipt are recorded there separately from causal proof.

### Same-class sibling found during concurrent delivery checks

The fourth repeated six-case run detected a backend caller-env change while
full benchmark coverage ran. A synthetic replay traced it to the existing
invalid-ref refresh test, which directly executed the real run-bench-cloud
entrypoint. That test passed while both synthetic caller dotenvs changed.
Apply the same private controller fixture to this caller and use its copied
run-bench-cloud. Retain all original invalid-ref, zero-Fly-call and timeout
assertions; positively resolve the private HEAD commit to prove the root is a
real Git checkout. Register this sibling with the existing owning selector,
which now runs 33 cases. The failed concurrent receipt remains preserved.

## Human feedback

Deliver only the reviewed environment-isolation commit on current main. Do not
include browser feature parents or the separate credential-performance fixture.
Keep all changes in the existing private worktree; never reset a shared DB.

## Reusable lesson

Isolate filesystem roots and highest-priority auth inputs before executing a
whole launcher. Mocking a lower-priority credential source does not isolate
startup side effects, and --help is not necessarily read-only.
