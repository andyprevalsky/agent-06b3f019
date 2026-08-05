---
id: 2026-08-03-collapsed-personal-and-delivery-name-contract
date: 2026-08-03
title: User.name collapsed account identity and delivery recipient identity
surface: cross
component: user-settings-profile-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: prisma/schema.prisma User.name — one column represented both the account owner and delivery recipient
symptoms:
  - Rose thinks I'm Aman
  - What is my name?
  - delivery address should have its own name
tags:
  - user-settings
  - personal-information
  - delivery-address
  - sms-supervisor
  - agent-context
sources:
  - memory:user feedback 2026-08-03
  - memory:production context dump for user 1f85ff25-6e29-4c1b-8739-f917bd101a30
  - agent 3ea40563-80bd-4250-99ae-06db178d3928
repro: agents/tests/blackbox/get_user_context.blackbox.py
status: fixed
---

## Problem

Rose identified the account owner as Aman when asked for the user's name. A
read-only production query and `back-end/scripts/dump-sms-context.ts` showed the
same account row had `name = "Aman Gottumukkala"`,
`email = "andy@roselabs.ai"`, and phone `+19729777432`. The stored address was
the Howard Street delivery address. The SMS prompt dump therefore exposed Aman
as the user's only name even though the account belonged to Andy.

A production cloud agent (`3ea40563-80bd-4250-99ae-06db178d3928`) was also
created with the exact question, but remained ACTIVE with zero model calls,
tokens, or output until cleanup was requested. That run is an independent
observability/idle-agent gap, not evidence for or against the profile diagnosis.

## Diagnosis

The first bad boundary was the persisted user-settings contract. `User` had one
`name` column and no delivery-recipient column, while the settings UI placed the
name directly above the delivery-address fields. The delivery recipient was
therefore saved in the only available name field.

Every downstream consumer then consistently made the same wrong inference:
`agents/helpers/get_user_context.py` labeled that value `Name` in the user
profile, `smsSupervisor/contextBuilder.ts` labeled it `Name` in SMS context, and
the browser agent prepended it to the shipping address. Because the schema
could not express both facts, prompts or model reasoning could not recover the
account owner's identity.

The permanent pre-fix repro supplied Andy as `name` and Aman as
`deliveryRecipientName`. It failed at
`assert "## Personal Information" in result`, proving the formatter had no
separate identity contract. The exact unchanged test passed after the fix.
Two archive searches found no prior case with this boundary, so this was
classified as a novel contract bug rather than a recurrence.

## Solution

Add `User.deliveryRecipientName`, backfill it from legacy `name` only when an
address exists, and conditionally correct the affected account from Aman to
Andy Prevalsky in the full-name field while retaining Aman as the delivery
recipient. Expose personal full name, email, and verified phone in a distinct
Personal Information card; expose recipient name and address in a separate
Delivery Address card. Email and both names round-trip through
`/api/user-settings`; verified phone remains read-only.

Main/general agents and browser agents now share a canonical formatter that
emits `## Personal Information` before `## Delivery Address`. The SMS supervisor
uses the same field semantics, and message-person name extraction reads only
`Full Name`, never the recipient. Stable agent context remains cached for five
minutes, but the small user-settings record is refreshed at each agent start so
an identity edit is not hidden by the old monolithic cache. If that refresh
temporarily fails, the agent retains the last successfully read profile instead
of dropping the user's identity from its context.

At 10,000 agents this adds one indexed user-settings lookup per agent start.
It creates no subscription, broadcast, shared lock, full-table scan, or
per-user fan-in; the heavier snapshot, integrations, communications, and
network context stays cached. SMS retains its existing single indexed user
lookup inside the existing parallel context fetch.

## Human feedback

The user corrected the identity explicitly: Rose currently thinks the user is
Aman, but should think the user is Andy. They asked for the proposed change
before implementation, approved it, and insisted the result be checked by
asking both the SMS and cloud-agent paths, "What is my name?"

## Reusable lesson

Never reuse an address recipient field as account identity; model and propagate
the two names separately at the persistence boundary before changing prompts.
