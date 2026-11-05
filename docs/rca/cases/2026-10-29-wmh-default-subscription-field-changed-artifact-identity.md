---
id: 2026-10-29-wmh-default-subscription-field-changed-artifact-identity
date: 2026-10-29
title: Default subscription override changed existing world-model artifact identities
surface: agents
component: experiential-bridge
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: pool_sha256 serialized a new optional default field into previously persisted model identities
symptoms:
  - test_wmh_pool_identity_excludes_billing_routes_for_the_same_model failed
  - Existing rose-wmh-gpt61 artifact hash changed from 31497e147da1 to cae5e8de6079
tags:
  - world-model
  - artifact-identity
  - compatibility
sources:
  - PR #1634
  - commit e60ae44f3
repro: cd agents && venv/bin/python -m pytest -q benchmarks/wmh_rose_provider_test.py -k pool_identity_excludes_billing
status: fixed
---

## Problem

The full agents coverage run reported 122 passing domains and a failure in world-model-harness. Its native provider regression expected the persisted model identity for rose-wmh-gpt61, but the new optional subscription_auth_enabled field changed the digest despite inheriting the same eligibility.

## Diagnosis

pool_sha256 hashes the PoolSpec dataclass dictionary. Adding a field with a None default changed every dictionary without changing the corresponding model behavior. Archive searches for `pool identity billing routes hash` and `artifact pool_sha256 billing identity` returned related identity cases but no confirmed recurrence of this boundary.

## Solution

Omit the optional subscription field when it inherits or explicitly matches direct_auth_enabled. Keep a genuinely different override in the identity. This preserves existing artifact IDs without hiding actual eligibility, model, waterfall or effort changes. The existing expected digest remains unchanged.

## Validation

The exact targeted pytest command failed before and passed after. Its permanent regression now also checks an explicit equivalent false override and a genuinely different true override. The same instrumented world-model-harness domain then passed in55.6s. Logs: /var/tmp/rose-wmh-identity-before.log, /var/tmp/rose-wmh-identity-after.log and /var/tmp/rose-wmh-identity-domain-after.log. The original full run remains failed; the focused result does not relabel it.

## Human feedback

The user requested completion of PR1634 deployment and the Flash model changes. No authorization was given to orphan or rebuild saved world-model artifacts.

## Reusable lesson

Persisted identity serializers need explicit default-value compatibility when optional configuration fields are introduced. Keep semantic overrides observable while excluding representation-only differences.
