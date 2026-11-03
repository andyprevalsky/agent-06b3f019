---
id: 2026-10-16-scoped-seed-identity-sync-overwrites-frozen-user-profile
date: 2026-10-16
title: Credential-only identity hydration overwrote the frozen benchmark user profile
surface: harness
component: seed-local-user
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: seed-local.ts ensureSeedUserExists calls syncUserRecord with a full existing-row update during scoped credential sync
symptoms:
  - Benchmark user has no phone number
  - the SMS supervisor cannot be driven without one
  - owned cloud execution has no proven root allocation
  - cleanup remains unverified; retaining its recovery authority
tags:
  - seed-local
  - frozen-fixture
  - credentials-only
  - sms-supervisor
sources:
  - PR #1473
  - commit 6f4dfbaa0e40233bc88eee92c47ac58e36a217b0
  - commit c43bcc4970a339ebd8a5eb7b1a02fc0b2f611467
repro: back-end/src/tests/blackbox/seed-credential-retry.blackbox.ts case5InitialAdmissionHasAnOwner existing
status: fixed
---

## Problem

The user authorized changing the paired restaurant input from “lum lok” to
“lok lak” and rerunning the failed CLOSED case. Its first canonical local run
failed before the SMS webhook or model: `_user_phone` found an empty phone.
The owning database contained the expected user, but its phone was empty.
The exact canonical frozen dump restored by that run contains a nonempty
phone for the same user. Neither a phone value nor user data is published here.
The setup-only owning stage failed in 29.794 seconds; it produced no TaskResult
and is not an SMS behavior verdict. Queue agents, browser sessions, purchase
spend, funding, terminal cleanup and archive rows were independently zero.
Its failed cleanup receipt is preserved, not rewritten as successful.

## Diagnosis

The path is frozen base dump → run.sh credential refresh → seed-local.ts
ensureSeedUserExists → syncUserRecord → existing User upsert → SMS _user_phone.
Identity admission must create a missing identity before credential FKs are
written. It also updated every selected profile field when that identity
already existed. A credential-only overlay therefore replaced frozen profile
facts with current upstream values, including an empty phone. The deepest
owned contract error is conflating identity existence with profile refresh.
The same error can replace names and addresses during compute, passkey, browser
or email credential overlays. No phone-specific fallback or fixture is needed.

Archive searches included `credential seed overwrites frozen user profile phone`
and `ensureSeedUserExists identity partial sync`. The October 7 initial-admission
retry case is related but distinct: retry ownership does not bound which fields
that successful operation updates. Its retry and missing-user behavior remain.

The existing credential-retry blackbox executes the actual CLI orchestration
functions with the production identity and retry helpers, replacing only DB and
credential edges. An added existing-user case supplies a frozen phone/name and
an upstream null phone/different name. The unchanged assertion failed on 6f4:
`case 5 existing: initial admission completes or fails closed within the identity
owner`, while the other cases passed. This is a deterministic owner repro,
not a claim that a mocked DB establishes native provider state.

## Solution

The existing upsert accepts a preserve-existing policy. Scoped credential modes
use an empty update for an already present user, while retaining the full create
for an absent identity. Full sync and pooled-owner updates retain their original
refresh behavior. Remote missing identities still fail closed under the same
bounded retry. No runtime SMS prompt, schema, model, tool decoder, evaluator,
timeout, production environment value or canonical base dump is changed.

The same command failed before and passed after:

```bash
cd back-end
node --import tsx src/tests/blackbox/seed-credential-retry.blackbox.ts
```

RED SHA256 `3df32c516474a4506cc3a908807a661c20b315647e08666e6bdf202f2ffe8a4e`;
GREEN `490e26403ea3ebb3797c6008d322c43f5e7b88cec26d71ad06b96cbc7c4e7760`.
The canonical blackbox runner then discovered and passed all five selected seed
owners against the new exact owned Postgres database:
`seed-local,seed-local.part2,seed-local.part3,seed-local-user,seed-credential-retry`.
That runner log SHA256 is
`a400fb04668acbebf59930096360298db7aadc904ec648bb635efb0e3437f52a`.
Backend TypeScript, changed-test lint and selected formatting passed. Script
files are outside the lint configuration; ignored-file warnings are not claimed
as script lint coverage. An initial standalone seed-local invocation lacked
DATABASE_URL and failed its real-DB prerequisite; that diagnostic is retained.
The actual corrected owning runner supplies the manifest-bound local DB.

Fresh canonical CLOSED startup on c43 preserved the phone and reached the real
webhook/model. It still FAILED its separate behavior assertion after 38.9 task
seconds: it spawned one agent and authorized 100 cents despite the closed-store
no-spend contract. This case fixes setup only and does not credit that benchmark
as passing. Its current canonical native cleanup passed; the original workflow
was independently terminal, zero provider sessions were allocated, owned
outboxes discharged, the exact stop exited zero, the owned DB was absent and
all 189 observed births were absent. The earlier setup-only run was separately
retired with zero allocation. Both databases were privately dumped before stop.

Read-only adversarial review independently reran both focused offline owners
and found no blocker. Its explicit limits were that real startup and Prisma
empty-update semantics still needed verification; the subsequent canonical
startup and real-DB runner supply that practical evidence. Every deploy backend
blackbox run discovers this existing domain; no optional test path was added.
At 10,000 seed invocations, this keeps the same one identity read/upsert per
invocation and adds no global inventory, network call, polling loop or resource.

## Human feedback

The user asked to use Lok Lak in the test, rerun that failure, and RCA any
remaining failure alongside “Filled it for me.” This authorizes the paired input
correction, not the pending menu-fixture or retrieved-facts prompt proposals.
No phone value was invented, no missing-profile behavior was waived, and the
setup repair is not represented as either SMS decision fix.

## Reusable lesson

Keep identity creation separate from existing-profile refresh so credential overlays cannot mutate frozen benchmark facts.
