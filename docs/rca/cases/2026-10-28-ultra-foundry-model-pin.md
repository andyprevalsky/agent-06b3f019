---
id: 2026-10-28-ultra-foundry-model-pin
date: 2026-10-28
title: Ultra Azure fallback admitted GPT-6 Sol despite the GPT-6.1 migration
surface: back-end
component: rose-pools
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Ultra pool registries omitted the explicit Foundry model pin
symptoms:
  - Ultra Foundry route plans included GPT-6 Sol
  - GPT-6.1 pool migration left Azure on generic Sol compatibility
tags:
  - azure
  - model-routing
sources:
  - PR #1634
repro: Production Ultra model pin cases in both Rose blackbox suites
status: fixed
---

## Problem

The user requested GPT-6.1 Sol deployment and correct model pools. Ultra's direct
GPT and OpenRouter models had moved to GPT-6.1, but Azure still accepted GPT-6 Sol
through the generic compatibility helper.

## Diagnosis

Both production registries left the optional Foundry model unset. The shared
helper therefore returned both Sol versions. The new regression used the actual
Ultra pool against a configuration with a GPT-6 region and a GPT-6.1 region.
Before the fix, the asserted GPT-6.1-only route plan included the old region and
failed in both TypeScript and Python.

Archive searches: `gpt-6-sol Foundry` and `Ultra wrong model Azure fallback`.
The funded-credential fallback case was related context, not this missing pin.

## Solution

Explicitly pin Ultra's Foundry model to `gpt-6.1-sol` in both registries. Leave
Flash's GPT-6 Luna pin and generic compatibility for explicitly unpinned custom
pools intact. Generic compatibility tests now declare their unpinned fixture;
the production Ultra regression separately enforces the stricter contract.

## Validation

The same new production-pool regression fails before and passes after. It checks
200 route keys, the actual request model and region, returned model metadata,
OpenRouter fallback after a GPT-6.1 server error without a GPT-6 call, and the
existing deploymentless fallback contract.

Worker results: TypeScript Rose blackbox 96/96, Python Foundry units 30/30,
Python routing blackbox 17/17, and three TypeScript Foundry programs passed.
Commands and source-bound receipts are retained in `/tmp/ultra-handoff.txt`;
before/after evidence is `/tmp/ultra-ts-before.log`, `/tmp/ultra-ts-after.log`,
`/tmp/ultra-py-before.log`, and `/tmp/ultra-py-after.log` on this machine. These
are mocked routing regressions, not live model-speed measurements.

## Human feedback

After the compatibility gap was explicitly reported, the user requested fixing
all remaining issues and including them in the deployment PR.

## Reusable lesson

Changing a pool's primary model does not pin optional fallback transports. Test
the actual production pool across every enabled transport, alongside generic
helper tests.

## Follow-up speed-fixture regression

The full backend coverage run exposed an additional stale fixture in
`agent-speed.test.ts`: its Ultra priority-tier test configured only GPT-6 Sol,
so the strict GPT-6.1 pool correctly found no eligible route. The unchanged
standalone test reproduced this failure. Updating that fixture to GPT-6.1 Sol
and asserting the actual wire model for all three speed levels makes the same
test pass (17/17). Generic unpinned compatibility tests remain unchanged.
Evidence: `/var/tmp/rose-agent-speed-fixture-before.log` and
`/var/tmp/rose-agent-speed-fixture-after.log`. The original full-suite failure
is retained; this focused pass does not relabel that run as green.

The Python full Rose suite also retained a pre-pin expectation that production
Ultra would use GPT-6 Sol. The corrected test asserts GPT-6.1 for both WMH and
production Ultra, then separately exercises GPT-6 compatibility with an explicitly
unpinned PoolSpec. The unchanged instrumented Rose command passes 273 checks
after this and the independently diagnosed loopback fixture repair.

The full backend run found two more fixtures advertising GPT-6 after the
production pin: compute-token-authority had no second eligible route for its
synthetic rate-limit response, and native-schema selected an inherited region
instead of its expected wire fixture. Both now configure GPT-6.1 explicitly;
the authority case asserts both deployment identities, and native-schema
isolates all nine region slots and asserts the wire model. Identical focused
commands failed before and passed after. Proof: `/tmp/cta-pr1634-proof/handoff.md`
and `/var/tmp/rose-native-schema-proof/handoff.txt`. No runtime logic changed.
