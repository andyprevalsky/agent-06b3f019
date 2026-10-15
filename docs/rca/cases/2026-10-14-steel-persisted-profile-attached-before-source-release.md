---
id: 2026-10-14-steel-persisted-profile-attached-before-source-release
date: 2026-10-14
title: Steel replacement attached a persisted profile before releasing its active source
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/sessionResume.ts recreateSession created a replacement with the active source session's persisted profile before source release
symptoms:
  - "Profile is still uploading and cannot be attached to a session yet"
  - "Failed to create Steel replacement after 5 attempts"
  - "FAIL live Kernel provider parity"
tags:
  - steel
  - browser-profile
  - rotation
  - lifecycle
sources:
  - PR #1506
  - PR #1515
  - commit 49b5470f7
  - task backend coverage 20261014-221231-6318
repro: back-end/src/tests/blackbox/browser-provider.helpers.ts assertSteelSameProfileReplacement
status: superseded
superseded_by: 2026-10-14-steel-writable-profile-replacement-precedes-source-release
---

## Problem

The required backend coverage gate passed 194 of 196 domains while
`browser-provider` failed live Kernel-to-Steel parity. Rotation retried a 409
for profile `71d0a72c-4faa-4098-8833-939d37a5777b`: the profile was still
uploading and could not attach to the replacement. Repeated calls failed across
the same five-attempt production loop and the test's existing retry rounds.
Retained server evidence shows the original Steel source
`c4c99d59-c5db-47c1-bc83-e551faaad2bf` still had active CDP activity at 22:04:28
UTC, before the first profile 409 at 22:04:32.

## Diagnosis

Path: rotate-proxy -> browser facade -> Steel replacement -> attach exact
persisted profile -> validate/commit replacement -> release old source.
The profile stays unavailable while its source is active. Our release came
after replacement creation, so the prerequisite depended on the operation it
blocked. The first bad boundary was that lifecycle ordering, not a Steel outage
or insufficient retry budget.

Archive searches used `Steel profile uploading source release` and
`Profile is still uploading cannot be attached to a session ready`. The Steel
startup-failure/outage and session-lifetime cases are relatives with different
causes. No same-profile release-order case was found. The fix was already in
flight in PR #1506; reuse its narrow implementation instead of inventing a
second repair.

The permanent owning helper replays the exact provider 409 until its owned
source is released. Its command failed on the buggy implementation with five
409 attempts (exit 1, 3.76 seconds), then passed unchanged after the fix (exit
0, 0.93 seconds):

```bash
cd back-end && node --import tsx --input-type=module -e "import { assertSteelSameProfileReplacement } from './src/tests/blackbox/browser-provider.helpers.ts'; await assertSteelSameProfileReplacement(false);"
```

The initial sibling case proved CLOSED source custody after a 429 creation
failure and successful retry through acknowledged release 404. Both cases run before the
existing live provider parity in the normal backend blackbox owner. Independent
adversarial review accepted causal precision, exact ownership, CAS protection,
recoverable failed-create state and bounded resource use. Live/full gate
qualification remains pending.

The unchanged canonical live owner then passed:
`cd back-end && bash scripts/run-blackbox-tests.sh browser-provider`, local run
`1792016434-311694-810`, domain duration 114,224 milliseconds, exit 0. It
retained the real rotation/profile assertions and completed owned cleanup.
The subsequent full backend coverage run passed all 196 domains; the unchanged
browser-provider owner passed in 130,673 milliseconds. The retained log is
`.context/deploy-runs/20261014-220120-4186766/logs/backend-coverage-blackbox-20261014-222604-382499.log`.
Release qualification remains pending.

During qualification, PR #1515 merged into main as `cdbe16c54`, carrying the
same cause's stronger durable PAUSED-custody and exclusive-lease repair. The
canonical case is
`2026-10-14-steel-writable-profile-replacement-precedes-source-release`.
This independently recorded incident occurred on the older implementation,
before that repair was merged; it is duplicate discovery rather than a failed
guardrail recurrence. This case is retained as superseded evidence.

The intermediate CLOSED implementation was removed during the main merge.
Both Steel production files now equal main; this deployment adds supplemental
facade and failed-create/404-recovery assertions only. The adapted tests require
PAUSED custody with null closedAt before acknowledged source release, exact
profile preservation, retained custody after failed creation, owner-scoped
lease release, and no duplicate facade release. The causal provider 409 replay
is unchanged. Both supplementary cases pass against main's lease repair; the
new full qualification run remains pending at this update.

Golden reference: OpenClaw
`extensions/browser/src/browser/server-context.availability.ts:634` waits for
the profile transition, and
`extensions/browser/src/browser/server-context.lifecycle.ts:403` retires the
exact old handle before successor startup. No direct Steel analog was found
in Claude, Hermes or Codex.

## Solution

The historical intermediate fix reused PR #1506: for an existing Steel session
with a bound persistent profile, release that
exact source before creating its successor, preserve the same profile, and
record CLOSED only after acknowledged release. The facade honors the already
released flag to prevent duplicate cleanup. Creation failure retains the
source identity/profile binding so subsequent recovery can use the normal
404-as-already-released contract. No timeout, prompt, schema, provider fallback
or outage skip changed.

The final production solution is PR #1515's shared
`prepareWritableSteelProfileHandoff` contract: retain the exact source in
PAUSED recovery custody under an expiring lease, acknowledge its release before
attachment, and fence publication and retries against that ownership. See the
canonical case for its permanent adversarial controls and complete lifecycle
contract; the earlier CLOSED-only reorder is superseded.

At 10k agents this is one bounded native release and one indexed task-scoped
update per affected replacement; no global polling, scan or shared bottleneck.

## Human feedback

None recorded.

## Reusable lesson

Release the exact source resource before acquiring a successor that depends on the source's persisted state becoming available.
