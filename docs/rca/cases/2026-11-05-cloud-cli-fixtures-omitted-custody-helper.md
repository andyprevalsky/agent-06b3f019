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


## Recurrence — native boot/driver cancellation fixture supplied the old helper contract (2026-11-06)

Gate: INTRODUCED by65bd22732's correctly enforced guest custody contract exposing another incomplete fixture. On frozen b583d1887b55f6cc74b28edfe8b1b0da1c242b0b, structural round30 shard2/6 failed test_real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack before its intended runner cancellation: cloudbench_compute_token_authority_url and cloudbench_kernel_proxy_node_options were undefined, then the real guest driver refused launch with custody policy unavailable. The fixture wrote a six-function env.sh and omitted the real preload/verifier files. The previous repair updated the CLI/staged-entry fixtures but missed this native boot consumer. Current and earlier cache-repair sources have identical driver/helper/test blobs at that boundary; newly integrated main's benchmark-runner changes execute after this refusal and are not its cause.

The other passing jobs are SHARDS, not repetitions: benchmark-live-results uses DEPLOY_GATE_SHARD=i/6, and the plugin keeps disjoint deterministic subsets. Only shard2 contains this case. Their PASS results provide no evidence of intermittency. The original case reproduced deterministically with custody1 in18.70s, including driver health410 and cleanup_ack1. The unchanged case passed in6.40s after fixture preparation was corrected. Archive searches used the literal missing helper error and generated-fixture native-policy contract, identifying this existing recurrence and earlier extraction-boundary cases.

Only the owning fixture changes. Its env stub first sources the real passive helper, preserving unrelated existing fixture overrides. A local synthetic compute authority/key satisfies the real lookup without any production route. The fixture copies the exact real custody preload and verifier into its synthetic checkout. Its small local Node health service asserts the real preload's installed symbol before binding/listening and publishing services.json; the actual driver's native verifier reads that local endpoint before the benchmark runner starts. The fixture explicitly selects custody1, so an absent inherited policy cannot silently skip the guarded path. Cleanup terminates only its exact owned health child. No runtime function, guard, task, benchmark assertion or timeout changes; all13 original Python assertions and both15s deadlines match their original ASTs. The existing ten-case custody suite continues to prove allocation denial, read/reuse preservation and unprotected-runtime refusals.

The isolated clone was pinned to exact b583 because its prior branch's benchmark runner differed. No changed checkout file shared an inode; the completed69dee branch remains preserved. The first full shard validations then exposed missing clone Node dependencies: frontend compiler modules, Temporal client and seed tsx. Both unprepared logs remain4FAIL/1ERROR with183PASS/1SKIP; the repaired boot case passed. A duplicate local shard was started after asynchronous tool-result ordering was misread; both finished and both logs remain. No unrelated fixture assertions were changed. Read-only local dependency links were bound to existing matching canonical trees after both jobs ended, with package/lock equality recorded. All five exact preparation controls then passed in9.76s. A single prepared shard2 run validates the actual selected full gate; no install, canonical/worker edit or shared dependency/cache mutation was performed.

Human feedback required the exact failed case first, strict zero-allocation custody, no dummy guard-success helper, unchanged author-completion/cleanup ordering assertions and liberal15s bounds, correct shard terminology, preserved original and local preparation failures, no healthy-registry interruption and parent integration only after native consumers terminate. Status stays open pending independent committed-diff review, parent combined validation and the actual native full structural outcome; the unrelated warm-resource and financial obligations remain separate.
