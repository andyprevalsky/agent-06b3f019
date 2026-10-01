---
id: 2026-10-01-browser-use-rollout-kill-switch-broke-default-provider
date: 2026-10-01
title: Disabling Browser Use threw when it was configured as the default browser
surface: back-end
component: browser-provider-config
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: selectedBrowserProvider and computeGrantBrowserProvider threw on a disabled Browser Use flag instead of selecting Kernel
symptoms:
  - BROWSER_AGENT_BROWSER_USE_ENABLED=false raised when BROWSER_PROVIDER=browser-use
  - COMPUTE_GRANT_BROWSER_PROVIDER=browser-use raised under the same kill switch
tags:
  - browser-provider
  - browser-use
  - feature-flag
  - fallback
  - kernel
sources:
  - task browser-provider kill-switch blackbox 2026-10-01
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: fixed
---

## Problem

The Browser Use rollout flag defaults off so a failed provider can be disabled
without removing its configuration. The first implementation rejected new
Browser Use sessions, but if either deployment default was set to Browser Use,
the flag caused browser selection to throw. Disabling the provider would also
block unrelated Kernel browser work and compute-grant recovery.

## Diagnosis

The critical path was environment selection → provider config → new browser
session or compute-grant browser. `selectedBrowserProvider` checked for a
disabled Browser Use flag after recognizing the configured provider and threw;
`computeGrantBrowserProvider` did the same. The fallback decision was missing at
the provider selection boundary, before any provisioning request.

Archive searches: `Browser Use disabled rollout flag BROWSER_PROVIDER throws
Kernel fallback` and `provider kill switch disabled default browser breaks all
sessions`. The 2026-07-14 stale-provider-env case is a relative, but that case
concerned an invalid provider name rather than a valid provider disabled by an
explicit rollout switch.

The owning blackbox was changed to require Kernel selection in both paths. On
the buggy code, the identical direct command
`node -r dotenv/config --import tsx src/tests/blackbox/browser-provider.blackbox.ts`
reported:

```text
FAIL Browser Use rollout flag returns default browser selection to Kernel: BROWSER_AGENT_BROWSER_USE_ENABLED must be enabled when BROWSER_PROVIDER=browser-use
FAIL compute-grant browser selection returns to Kernel when Browser Use is disabled: Browser Use is disabled by BROWSER_AGENT_BROWSER_USE_ENABLED
```

## Solution

Both selectors now return Kernel when Browser Use is configured but its rollout
flag is off. Direct Browser Use provisioning and provider promotion still reject
when disabled. The same blackbox command then passed both new assertions and
reported `Passed 19 browser provider test(s)`; backend TypeScript typechecking
also passed.

## Human feedback

The user asked for a Browser Use feature flag that can disable a buggy provider.

## Reusable lesson

A provider kill switch must route new work to a healthy default even when the
disabled provider remains in deployment configuration.
