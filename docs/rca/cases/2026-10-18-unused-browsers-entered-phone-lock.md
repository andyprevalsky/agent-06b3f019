---
id: 2026-10-18-unused-browsers-entered-phone-lock
date: 2026-10-18
title: Browser phone observations locked the device before checking whether the task used it
surface: back-end
component: iphone-interactions
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/iphone/service.interactions.ts eager cleanup before interaction lookup
symptoms:
  - Unused browser waited for the shared phone lock
  - browsers without phone interactions do not contend on the phone lock
tags:
  - phone-harness
  - lock-contention
  - browser-observation
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/iphone-interactions.blackbox.ts
status: fixed
---

## Problem

Fresh phone observations run before browser decisions. Even a task that had
never acquired a phone entered the shared device lock, so unrelated browsers
could contend with a phone operation on an enabled account.

The normal blackbox reproduction holds the fixture device row lock in another
transaction and reads an empty task interaction. Before the fix, it failed with
`Unused browser waited for the shared phone lock` in run
`1792351983-2506579-24043`. No provider calls or large load test were necessary.

## Diagnosis

Critical path: browser decision observation -> owned interaction service ->
eager cleanup -> device row lock -> latest task lease lookup. The system entered
physical-device serialization before establishing that this browser task had
any interaction to reconcile. The device lock is necessary for phone ownership,
but sharing it with every enabled browser would turn a per-device constraint
into account-wide contention.

The first bad boundary is the eager cleanup ordering. The test positively
holds the actual lock and requires the unrelated read to finish before release;
it does not infer locking from a slow benchmark or mocked timing.

## Solution

After authenticating browser ownership and current capability, use the existing
indexed device/browser-task lookup. Return the empty observation without cleanup
or a device lock when no interaction exists. Acquisition and existing phone
interactions still use the durable queue and reconciliation lock.

The exact unchanged command from back-end,
`bash scripts/run-blackbox-tests.sh iphone-interactions`, passed in run
`1792352219-2543781-4043`, including all 12 interaction cases. The combined
interaction/capture run `1792352021-2513150-2984` also passed.
The test remains in the normal deploy blackbox suite. At 10k browser agents,
unused tasks perform constant indexed reads without contending on a phone row;
only actual phone users join the intentionally serialized physical-device path.
No global cache, user channel, or per-agent background poll was added.

## Human feedback

None recorded.

## Reusable lesson

Determine whether a task owns a resource before joining that resource's serialization and cleanup path.
