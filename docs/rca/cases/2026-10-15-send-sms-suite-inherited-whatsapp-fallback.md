---
id: 2026-10-15-send-sms-suite-inherited-whatsapp-fallback
date: 2026-10-15
title: SMS error assertions inherited WhatsApp fallback from the canonical user
surface: infra
component: backend-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: send-sms.blackbox.ts selected a canonical user whose WhatsApp fallback was enabled
symptoms:
  - SMS provider rejection assertions expected HTTP 500 but observed HTTP 200
  - two of sixty-two send-sms cases failed
tags:
  - sms
  - blackbox
  - fixtures
  - whatsapp
sources:
  - commit 0118ea315c327471d761d3939a715fc4c5a1eb9c
repro: back-end/src/tests/blackbox/send-sms.blackbox.ts
status: open
---

## Problem

The C4 backend gate passed 197 of 199 domains. Two send-sms assertions expected a terminal SMS failure but observed HTTP 200. The suite selected the shared canonical fixture user; its restored `whatsappReachable` was true. The unchanged production route correctly accepted its WhatsApp fallback after the captured SMS rejection.

## Diagnosis

The original full server log, SHA256 `5253ab1cfa68b58b42b8e5b3761b46988ff967e29839abad6b6580378a6a1677`, preserves both the rejected SMS and accepted fallback. A read of the exact owned coverage database confirmed the selected user's enabled fallback. The fixture made its SMS-only assumption depend on shared restored state. This does not prove a production retry or schema bug. The separate five-photo supervisor timeout is a distinct open case.

## Solution

Create one UUID-scoped test user with its own phone and `whatsappReachable: false`, then delete only that user's agents, SMS session and user row. Always attempt Prisma disconnect through nested `finally`. No canonical user is modified. All 62 registration names, order, test bodies and assertions remain unchanged. Split the existing oversized file into seven modules without lint suppression; the original runner filename remains the registered entry point. The fixture owns one Prisma client and loads dotenv before reading its configuration.

The reviewed split preserves 108 original function-body hashes mechanically, with final exceptions only for the fixture's cleanup wrapper and new own-user cleanup helper. Root verified all seven applied candidate files exactly, regenerated the existing Prisma client, and passed full backend TypeScript checking plus changed-file formatting and ESLint. The actual unchanged 62-case runtime suite and full final-source deployment gates remain pending, so the case remains open. Production paths, model context and delivery fallback behavior are unchanged. At 10,000 agents this adds no production hot-path work; test setup and teardown use one explicitly owned fixture.

## Human feedback

The user authorized infrastructure repair and retained separate approval for WHM context changes. No timeout, error expectation, test count, concurrency or benchmark contract was relaxed.

## Reusable lesson

A transport-specific test must create its own delivery-channel preconditions instead of inheriting a canonical user's alternate delivery capabilities.
