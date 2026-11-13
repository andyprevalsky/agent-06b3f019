---
id: 2026-11-11-live-probes-bound-as-one-aggregate-case
date: 2026-11-11
title: The staged deploy cycle bound all live probes as one aggregate case, so one provider-side probe miss made the whole gate UNVERIFIED and unwaivable
surface: harness
component: deploy-test-cycle-live-probes
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_plan.py standard_template bound live-probes with the single check "live-probes", so deploy_test_bindings wrapped scripts/run_deploy_live_probes.py as one aggregate case whose nonzero exit deploy_test_worker records as UNVERIFIED
symptoms:
  - "live-probes/live-probes UNVERIFIED"
  - "unverified/incomplete execution cannot be waived as a completed case"
  - "live GLM failover must escalate the exact prod follow-up, got apology"
tags:
  - deploy
  - live-probes
  - failure-attribution
  - aggregate-case
sources:
  - PR #1934
  - memory:deploy-live-probes-aggregate-unwaivable
repro: scripts/tests/deploy-gates.test.py Inventory.test_live_probes_slot_binds_one_case_per_probe_on_every_transport
status: fixed
---

## Problem

During the PR #1934 deploy, the live-probes gate ran six probes on a Blacksmith VM.
Five exited 0. `chat-router-failover-live` failed both of its attempts, and so did an
unrelated branch's run at the same time. In both runs OpenRouter served
z-ai/glm-5.3-flash from the Morph host, which streamed too slowly to produce a router
decision within 15 s (the open case
2026-10-29-router-timely-first-content-missed-decision-deadline). That probe's /RCA
attribution was evidence-backed NOT_INTRODUCED.

The cycle still recorded the whole gate as `live-probes/live-probes`
`native_result=UNVERIFIED`, `complete=false`. Triage accepts no waiver, post-merge
packet or provider exception for an incomplete occurrence. `reexecute` covers only
observation loss. So the deploy could not proceed, even though the failure was
attributed and every other probe passed. PR #1723 hit the same wall on 2026-11-06,
with an OpenRouter 402 on credential-health. It was worked around with a private
template and a re-init, and the repo fix was left undone.

## Diagnosis

`standard_template()` emits one check per pipeline lane (`checks: [lane name]`). For a
single-check gate without a recipe, `deploy_test_bindings` builds one case with
`aggregate: True`. `deploy_test_worker.run_step` records any nonzero exit of an
aggregate case as UNVERIFIED, because one exit cannot prove that every constituent
ran. That rule is correct. The defect was upstream of it: the planner never told
the cycle that live-probes is six independent probes. The runner already knew, since it
reports one progress row per probe. So a completed, attributable FAIL of one probe
could only ever surface as an unattributable aggregate.

## Solution

- `run_deploy_live_probes.py` gains `PROBE_NAMES` and `--only NAME`. `--only` runs
  one probe by itself, without its `after` wait. The default run is unchanged.
- `standard_template()` lists those six probes as the live-probes checks.
- `deploy_gates.live_probes_recipe()` gives the live-probes slot one non-aggregate
  case per probe, on both local and Blacksmith transports.
- The worker runs cases one after another in `PROBE_NAMES` order, which satisfies
  every `after` edge, so the shared test database stays serialized.

A probe's exit 1 is now a complete FAIL that /RCA can attribute: an
`INTRODUCED` fix, a NOT_INTRODUCED post-merge packet, or a provider exception. A
crash or timeout stays UNVERIFIED as before. Assertions, timeouts and probe commands
are unchanged.

Regressions:

- `deploy-live-probes.test.py`:
  - names and ordering match `deploy_commands()`;
  - `--only` runs one probe alone and returns its exit;
  - the default run keeps every probe and its ordering.
- `deploy-gates.test.py`:
  - the slot recipe has one non-aggregate `--only` case per probe on both transports;
  - the real standard template carries the six checks.

All five new assertions failed on the unmodified tooling (5 errors).

10k-agent impact: none. This is deploy tooling.

## Human feedback

None recorded.

## Reusable lesson

Bind a gate made of independent probes as one case per probe, so one probe's attributable failure is never collapsed into an unwaivable aggregate.
