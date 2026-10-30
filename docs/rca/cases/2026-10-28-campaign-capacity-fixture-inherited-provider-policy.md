---
id: 2026-10-28-campaign-capacity-fixture-inherited-provider-policy
date: 2026-10-28
title: In-process campaign capacity fixture inherited the host browser policy
surface: harness
component: provider-capacity-campaign-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: ProviderCapacityCampaignTests invoked provider_capacity_refusal in-process without its existing clean_env Kernel policy
symptoms:
  - test_provider_capacity_campaign_simultaneous_width
  - AssertionError 78 != 0
  - refusal(70) rejects the expected Kernel fixture width
tags:
  - provider-capacity
  - fixture-isolation
  - deploy
sources:
  - PR #1627 resumed full sweep 2026-10-28T19:57:23Z
  - commit 11ba1f13b2cefc9b6a818263ac2b7700c4af9e73
repro: python3 scripts/tests/cloudbench-provider-capacity.test.py ProviderCapacityCampaignTests.test_provider_capacity_campaign_simultaneous_width
status: open
---

## Problem

The full command-structural sweep at the recorded source failed the campaign
width assertion: refusal(70) returned 78 instead of 0. The complete 16-test
provider-capacity suite reported one failure. The original sweep remains failed.

## Diagnosis

The path is test method -> campaign helper -> provider resolver -> reviewed
registry -> admission exit code. Subprocess tests already use clean_env(), which
pins the declared Kernel fixture. The in-process method instead inherited the
real host provider selection; the backend dotenv resolved Tilion, whose correct
cap is 16. The same call with the fixture's explicit Kernel policy admits 70.
No provider request was made and production enforcement was correct.

The exact targeted source command failed at 20:12:41 UTC. Temporary before/after
copies ran the identical reproduction script at 20:13:29 UTC: before failed with
78 != 0 and after passed the unchanged assertion. All three campaign tests also
passed. Original logs, source hashes and candidate evidence are retained under
/var/tmp/deploy-1627/resumed-structural-rca. Searches used refusal 78 provider
capacity and structural bounded admission fixture environment. The admission
caller ambient-Temporal-fake case is related fixture isolation, not this incident.

The deepest owned cause is inconsistent fixture environment ownership across
in-process and subprocess consumers. Unifying the existing class environment
also prevents inherited registry/campaign/Fly policy from changing its assertions.
Golden reference is not applicable: ordinary fixture code, no approval-gated hunk.

## Solution

Scope the existing clean_env() to the entire CampaignTests fixture with
patch.dict and clear=True, and restore the previous environment with addCleanup.
Keep the real registry, caps, reserve fraction, production helper and every
existing assertion unchanged. Source application, registered full-suite
verification and final deploy sweep remain pending in this draft.

## Human feedback

The user requires the complete final sweep and unchanged budgets/assertions;
failed-only diagnostics cannot replace it. No provider-limit waiver was granted.

## Reusable lesson

Give in-process and subprocess fixture consumers the same explicit environment
and restore ambient state after the fixture.

## Integration application

Reviewed correction applied by the sole deploy source owner after the frozen interim checks ended on 2026-10-28. Original failed/interrupted receipts remain unchanged. Five unchanged owning verifications and the full final deploy gates are required before closure; status remains open until verified.
