---
id: 2026-11-16-delegating-ceiling-preflight-missed-600-wide-relay-campaign-fixture
date: 2026-11-16
title: Main went red in deploy-command-structural because the new up-front delegating-guest ceiling refusal (exit 78) fired on a 600-wide RelayStartupEvidence campaign fixture that never set the ceiling override
surface: harness
component: run-bench-campaign
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-cycle.test.py RelayStartupEvidence.test_campaign_persists_fixed_commands_before_any_controller_admission launched a 600-wide campaign through the real run-bench-campaign.py main() without CLOUDBENCH_DELEGATING_PRIMARY_CEILING, so delegating_ceiling_refusal (added by commit 5d5388739f) returned 78 before the fixture's own start_shared_inventory refusal could produce exit 1
symptoms:
  - "AssertionError: 78 != 1"
  - "test_campaign_persists_fixed_commands_before_any_controller_admission"
  - "Lower the simultaneous width to 70 or fewer (fewer tasks or -k copies, or a rolling campaign with --concurrency 70 or less)."
  - "Raising CLOUDBENCH_DELEGATING_PRIMARY_CEILING needs a measured backend/provider load at the wider width; 70 is the widest proven-safe width."
  - "deploy-command-structural red on main"
tags:
  - cloudbench
  - run-bench-campaign
  - delegating-guest-ceiling
  - test-fixture
  - deploy-command-structural
  - main-red
sources:
  - commit 5d5388739f
  - commit 2124e4ace4
  - memory:git-credential-helper-rate-limited-askpass
repro: python3 scripts/tests/deploy-test-cycle.test.py RelayStartupEvidence.test_campaign_persists_fixed_commands_before_any_controller_admission
status: fixed
---

## Problem

On origin/main 12d54fa2b0 the deploy gate `deploy-command-structural` was red, which blocked every other deploy.
`RelayStartupEvidence.test_campaign_persists_fixed_commands_before_any_controller_admission` failed with `AssertionError: 78 != 1` at `self.assertEqual(module['main'](),1)`.
Before the failure, the campaign printed the delegating-guest ceiling refusal: "Lower the simultaneous width to 70 or fewer ...".
Running that single test on main reproduces the failure: `Ran 1 test`, `FAILED (failures=1)`.

## Diagnosis

The test protects this invariant: a campaign writes every job's fixed `controller_command` to `summary.json` before any controller is admitted.
To check it, the test runs the real `run-bench-campaign.py` `main()` with 600 tasks at `--concurrency 600`.
It stubs out `provider_capacity_refusal` and makes `start_shared_inventory` raise.
The expected result is exit 1 with 600 jobs persisted, `peak_concurrency` 0 and no `controller_pid`.

Commit 5d5388739f (2026-11-16 03:49Z, merged to main by 2124e4ace4 with no PR) added `delegating_ceiling_refusal(global_benches, args.task)` to `main()`.
That call runs right after the provider-capacity check.
For a REAL/SIM width above `CLOUDBENCH_DELEGATING_PRIMARY_CEILING`, which defaults to 70, it returns `EXIT_REFUSED` (78) before any credential or Fly call.
The 600 `fixture-N` tasks are not in the catalog, so they count as delegating primaries, and 600 > 70 makes the preflight refuse.
`main()` therefore returns 78 before it persists the jobs or reaches the inventory stub.

The commit message states its intent: the refusal is deliberate, the ceiling and runtime admission are unchanged, and "wide-width fixtures that already raise provider limits also set the fleet's own ceiling override".
The commit applied that override to `agents/benchmarks/cloudbench_campaign_barrier_test.py` and `scripts/tests/cloudbench-cleanup-ticket-campaign.test.py`.
It missed this fixture in `scripts/tests/deploy-test-cycle.test.py`.
The product behavior is correct, so the defect is in the test fixture: it does not supply the environment that a 600-wide launch now requires.

Why was this possible? The commit's same-class sweep had to find every test that launches more than 70 REAL/SIM copies through the real campaign preflight.
This fixture stubs the provider-capacity refusal by name in a `replacements` dict, so a search for the override variable or for provider-limit raises would not find it.

Archive searches: "delegating-guest ceiling exit 78 campaign test", "test_campaign_persists_fixed_commands_before_any_controller_admission RelayStartupEvidence", and a grep for `DELEGATING_PRIMARY_CEILING|delegating-guest` in `docs/rca/cases/` (0 hits).
This incident is novel. A relative is 2026-11-07-worker-clone-reservation-kept-the-old-56-machine-ceiling.
Its lesson applies: when a limit changes, enumerate every site that depends on it.
The difference is that here the consumer that missed the change is a test fixture, not product code.

## Solution

The fix sets `CLOUDBENCH_DELEGATING_PRIMARY_CEILING=600` in the test's `patch.dict(os.environ, ...)`.
That is the same override 5d5388739f gave its other wide fixtures.
The test still runs the real `delegating_ceiling_refusal`; it is not stubbed.
The test keeps the original 600 width and every assertion: exit 1, 600 persisted jobs with the exact fixed `controller_command`, `peak_concurrency == 0`, and no `controller_pid`.
`patch.dict` restores the environment after the test.
Lowering the width to 70 or less would also have passed, but it would stop proving the invariant at the original-600 scale.
No product code changed.

Verification uses the identical command before and after the fix: `python3 scripts/tests/deploy-test-cycle.test.py RelayStartupEvidence.test_campaign_persists_fixed_commands_before_any_controller_admission`.
On main it fails with `78 != 1`.
After the fix it reports `OK` in 5 of 5 consecutive runs, and the whole `RelayStartupEvidence` class passes (33 tests OK).

## Human feedback

The coordinator asked for the test to keep proving its original invariant under the new ceiling, with no weakened or removed assertion, and for the fix to ship as its own scripts/tests-only PR.

## Reusable lesson

When adding an up-front refusal to a launch path, run every suite that drives that path's real `main()` (including fixtures that stub sibling refusals by name), and give each fixture wider than the new limit the documented override rather than stubbing the new check.
