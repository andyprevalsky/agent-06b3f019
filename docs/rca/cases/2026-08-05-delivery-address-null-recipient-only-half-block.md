---
id: 2026-08-05-delivery-address-null-recipient-only-half-block
date: 2026-08-05
title: Agent asked for a delivery address that was never in context because the profile stored only a recipient name, and both context renderers emit a "## Delivery Address" half-block with no street
surface: cross
component: user-context-delivery-address-renderer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/user_profile.py build_user_profile_sections (and back-end/src/providers/smsSupervisor/contextBuilder.ts) render a "## Delivery Address" section from deliveryRecipientName alone, with no street/city/zip
symptoms:
  - I don't have a delivery address on file for Aman
  - why is it asking for my address
  - I thought we auto inject the user context
  - "## Delivery Address" section with only "Recipient Name" and no street
  - deliveryRecipientName set but addressLine1/city/state/postalCode null
tags:
  - user-context
  - delivery-address
  - sms-supervisor
  - agent-context
  - personal-information
sources:
  - agent d045dbcd-03e6-407e-8005-f109bddf8933
  - memory:production user-settings for user 1f85ff25-6e29-4c1b-8739-f917bd101a30
repro: agents/tests/blackbox/get_user_context.blackbox.py
status: open
---

## Problem

A prod SMS agent (`d045dbcd-03e6-407e-8005-f109bddf8933`, model `rose-1-lite`,
PLAN phase) told the user at 21:17:44Z: **"I don't have a delivery address on
file for Aman. Can you confirm the full delivery address (street, city, state,
zip)?"** The user reported this as nonsense — "I thought we auto inject the user
context, why is it asking for my address?"

Runtime evidence:

- Live prod `GET /api/user-settings` for the SMS user (`1f85ff25-…`) returns
  `deliveryRecipientName: "Aman Gottumukkala"`, `email`/`phone`/`country` set,
  but `name` and **every** address column (`addressLine1`, `addressLine2`,
  `city`, `state`, `postalCode`) `null`.
- Prod DB row (psql, direct URL): `createdAt 2026-08-03 21:10`,
  `updatedAt 2026-08-05 22:04:05`, `onboardingCompletedAt 2026-08-05 19:55`.
- The agent then spawned browser agents (prod ClickHouse `fly_logs`) whose goals
  carried the full address `88 Howard St, Apt 1413, San Francisco, CA 94105` —
  i.e. the user typed the address in reply and the order proceeded.

## Diagnosis

Auto-injection is **not** broken; it injected exactly what the profile stored.

First-bad boundary: `agents/helpers/user_profile.py:37-41`
(`build_user_profile_sections`) appends a `## Delivery Address` section whenever
`deliveryRecipientName` is truthy, then extends it only with non-empty address
lines. The backend SMS path `back-end/src/providers/smsSupervisor/contextBuilder.ts:557-566`
has the identical gate (`if (user.deliveryRecipientName || addressParts.length
> 0 || cityStateZip)`). With the prod row, both emit:

```
## Delivery Address
Recipient Name: Aman Gottumukkala
United States
```

— a heading, a recipient, and the default country, but **no street/city/zip**.
Ran `build_user_profile_sections` locally on the exact prod dict and reproduced
this output. The agent's 21:17 message names "Aman" (which appears only in
`deliveryRecipientName`) and reports no address — behavioral proof it read this
half-block at injection time.

Step 5a ladder for the missing data:
- Why 1: agent asked → its injected Delivery Address had a recipient but no
  street. (proven by repro + agent message)
- Why 2: the street columns are `null`. The 2026-08-04 migration
  `split_personal_delivery_name` set `deliveryRecipientName` **only** where an
  address field was non-null, so an address existed on 08-04; it was nulled
  afterward. (migration WHERE clause + createdAt 08-03)
- Why 3: what nulled it is **not** any committed code path. Enumerated every
  `prisma.user.{update,upsert,updateMany,create}` and raw `UPDATE "User"` across
  back-end, agents, and scripts: (a) address columns are written by exactly ONE
  path, `user-settings/repo.ts`, whose Zod schema is `z.string().optional()`
  (not `.nullable()`) and whose `parseUpdateBody` is a plain `.parse()`, so the
  settings API can only write `""`, a real value, or leave a column unchanged —
  never `null`; (b) no other writer (auth, invite-codes, webhooks, integrations,
  hybridAuth, inviteGate, imessage, sms-webhook, credits, contactBackfill,
  move-users-to-waitlist) touches `name`/address; (c) the row has existed
  continuously since `createdAt 08-03` (no re-create, which is the only way a
  Prisma `create` could default those nullable columns to `null`). The account
  is, however, routinely reset out-of-band: `back-end/scripts/reset-user-data.ts`
  hardcodes this exact phone (`+19729777432`) and nulls `onboardingCompletedAt`
  (explaining today's 19:55 re-onboarding). So the `name`/address `null` was
  written by a **raw/manual prod DB operation on the shared test account** — the
  most probable being the 2026-08-03/08-04 manual identity-correction the prior
  RCA relied on (Aman→Andy in `name`, not in the committed migration) and/or the
  documented 2026-08-04 impersonation-leak "prod data cleaned" surgery — not
  product code. **Stop** — this rung leaves owned code (Step 4 data-state); there
  is no DB audit log, so the exact command is unrecoverable (observability gap).

Owned, reproducible defect (the rung we own): both renderers present a
recipient-only profile as a configured "## Delivery Address," giving downstream
agents (`spawn_browser_agent_v3`, `message_person`, PLAN/EXECUTE loops) a
misleading half-block with no explicit "no delivery address on file" signal, and
duplicating the same gate in two places.

Observability gap (honest): the verbatim 21:17 system prompt is not captured in
`fly_logs` (only event summaries), so injection-time state rests on the agent's
own message plus the deterministic repro, not the raw prompt. `updatedAt 22:04`
is a post-run write; because the API cannot null address, a present→null
transition via the settings path is impossible, so the null already held at run
time — but the raw-prompt capture remains missing.

## Solution

Proposed (RCA-only; awaiting agreement): unify the two delivery-address
renderers so a `## Delivery Address` section is emitted **only** when a real
deliverable address line exists (`addressLine1`/`addressLine2`/`city`/`state`/
`postalCode`). When only a recipient (or bare country) is present, omit the
section or emit an explicit `Delivery Address: none on file` marker. Cement in
`agents/tests/blackbox/get_user_context.blackbox.py` (owning suite) with a
recipient-only fixture asserting no bare `## Delivery Address` heading, and mirror
it for `contextBuilder.ts` in the backend blackbox suite. Kills the sibling class
across every consumer of both renderers. 10k-agent behavior: pure per-agent
string formatting, no new fan-in/fan-out — neutral at scale. Separately, the
user's actual address must be repopulated in the profile (data), since the fix
does not invent an address the DB does not hold.

## Human feedback

None recorded yet (RCA-only; stopped for agreement before implementing).

## Reusable lesson

A "## Delivery Address" (or any profile) section that renders from an identity
field alone is a lie when the substantive fields are null — gate the section on
the substantive data, not the label, and never let two renderers own the same
gate.
