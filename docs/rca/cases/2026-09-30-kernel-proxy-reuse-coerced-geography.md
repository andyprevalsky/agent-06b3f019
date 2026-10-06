---
id: 2026-09-30-kernel-proxy-reuse-coerced-geography
date: 2026-09-30
title: Proxy reuse lost its string-type guard during main integration
surface: back-end
component: kernel-proxy-reuse
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: selectReusableKernelProxy converted provider geography values to strings before comparing them
symptoms:
  - A country array matched a string country candidate
  - a malformed array location must not match a geographic proxy candidate
tags:
  - kernel
  - proxy-reuse
  - merge-regression
sources:
  - PR #1299
repro: test:back-end/src/tests/unit/browser-proxy-rotation.test.ts
status: fixed
---

## Problem

Independent review of the integration with main found that its paginated proxy
selector coerced geography values with `String`. A malformed country array
containing `US` therefore matched the country string `US`. This was an offline
merge counterexample, not an attribution of a live browser navigation failure.

## Diagnosis

The previous selector required a string value before comparing location keys.
The incoming implementation added availability, bypass-host, pagination and
concurrent ownership protections, but its coercion lost that type boundary.
Archive searches for proxy reuse and pagination found no matching prior case.
An independent read-only invocation returned the same proxy for a correct
string and the malformed array.

## Solution

Preserve the incoming selector and ownership behavior, and require each
geography value to be a string before its case-insensitive comparison. Add one
counterexample to the existing proxy-rotation unit file. That unchanged file
failed at the new assertion before the guard in 0.233 seconds and passed after
the guard in 0.202 seconds. The existing geographic, tier, status, bypass-host,
pagination and concurrent ownership assertions remain. No provider calls or
additional verification suite were added.

## Human feedback

Keep permanent runner and infrastructure regressions focused on observable
behavior. Do not replace verification with a large new suite, and do not claim
that a synthetic counterexample establishes the cause of a live failure.

## Reusable lesson

When combining selectors, preserve input-type checks as well as matching and
ownership rules; string coercion can silently broaden resource identity.
