---
id: 2026-11-05-cloud-cli-fixtures-omitted-custody-helper
date: 2026-11-05
title: Cloud CLI fixtures omitted the mandatory custody policy helper
surface: harness
component: cloudbench-cli-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Synthetic cloudbench-env.sh fixtures were empty when run-bench-cloud began requiring cloudbench_kernel_proxy_custody_policy before argument validation
symptoms:
  - "cloudbench_kernel_proxy_custody_policy: command not found"
  - "test_cold_image_builder_rejected_before_auth expected 2 actual 1"
  - "test_actual_task_still_requires_explicit_staged_boot_flags"
  - "test_actual_verify_secrets_ignores_inherited_launch_transport"
tags:
  - cloudbench
  - fixture
  - kernel-proxy-custody
  - structural
sources:
  - commit 65bd22732f98df306739655f49f9748a418c0c0b
  - commit f87a389979fd30826a1b133cb445cc0f648d3536
  - agent 01a1a32a-56ed-7043-b8dd-68349792e0b8 isolated evidence /home/boxes/cli-nov05-custody-fixture-repair/.context/custody-fixture-rca/
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_builder_rejected_before_auth
status: open
---

## Problem

The f87 structural cohort retained three parametrized cold-image CLI failures
and two staged-boot entry failures. Each stopped at run-bench-cloud line 114
with the missing-function error instead of reaching the original invalid-argument
or read-only secret-verification assertion. Original evidence remains in the
worker e6936b864ce6eb6e1d566819a05899fa34cbd61f7481263253103e1210197285 log.

## Diagnosis

Gate: INTRODUCED. Commit 65bd22732 added a mandatory custody-policy projection
immediately after sourcing cloudbench-env.sh. The real helper implements that
policy correctly and preserves zero-allocation enforcement. The image CLI test
constructed an empty helper; staged environment_entry constructed a comment-only
helper. Both synthetic contracts therefore lacked a required function before
argument validation or any provider operation. The exact owning commands
reproduced all five reported failures on f87 in the isolated clone.

Archive searches used the literal missing-function error and fixture empty
cloudbench-env helper. This is a fixture-contract relative of the cloud guest
custody propagation case, not a reason to disable that policy. The first-bad
boundary is the incomplete fixture, not argument validation or provider auth.

## Solution

The cold-image fixture now sources the real helper using the same safely quoted
pattern as its neighboring fixture. The staged fixture copies the real helper
into its synthetic library directory. Its GitHub auth and Fly client remain
strict local stubs. This avoids inventing a no-op policy implementation while
keeping every original argument, assertion, auth observation and timeout.

The unchanged three-case pytest command and two-case staged command pass after
the fixture change and are repeated five times. Full owning image CLI and
staged-boot suites validate the repair; the existing ten-test custody suite
independently verifies that allocation denial, read/reuse behavior, malformed
policy refusal and guest enforcement remain intact. Those existing suites were
already registered; no new duplicate gate is needed. Runtime controller, guest,
helper, preload, task catalog and source/cleanup validators remain unchanged.
Status remains OPEN pending parent integration and the native structural rerun.

## Human feedback

The user required preserving the production zero-allocation guard, all original
argument-validation and read-only-auth assertions/timeouts, and avoiding real
provider/machine/financial operations. The separate legacy cycle source mismatch
belongs to the already collected repair and is not changed here.

## Reusable lesson

Populate synthetic helper libraries from the real passive helper contract instead of leaving mandatory entry-policy functions undefined.
