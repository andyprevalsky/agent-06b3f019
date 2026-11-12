---
id: 2026-11-11-granola-envelope-parser-confused-notes-with-calendar-events
date: 2026-11-11
title: Granola sync rejected valid provider envelopes containing upcoming calendar events
surface: back-end
component: granola-mcp
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/services/integrations/granolaMcp.ts parseMeetingList assumed meetings_data was the entire response and pagination came last
symptoms:
  - Granola meeting list format changed
  - Granola sync failed
  - Granola MCP is still broken
tags:
  - granola
  - mcp
  - envelope
  - sync
sources:
  - commit 06edeba6cbba2389bc11eb48f8ff7bb2f4204aab
repro: back-end/src/tests/blackbox/granola-mcp.blackbox.ts
status: fixed
---

## Problem

Granola sign-in succeeded, but production cron repeatedly failed with the literal
error `Granola meeting list format changed`. Local logs were stale (October 8),
so retained Render backend logs established the active failing boundary. No
specific agent was supplied, and this is a background sync failure rather than
an agent self-report; no report_bug was identified for this incident.

## Diagnosis

Critical path: Integrations connect → stored encrypted OAuth grant → cron claims
sync → SDK list_meetings response → parseMeetingList → normalized documents →
grep / Explore. The upstream OAuth and MCP transport succeed. An opt-in
read-only blackbox loaded the existing encrypted grant through the real Prisma
and decrypt paths, called list_meetings through GranolaSession, captured its
response privately, then failed at the same parser boundary. Current wire data
starts with pagination, requested_range and upcoming_meetings, followed by
meetings_data. The old parser required meetings_data at position zero and
pagination at the end. Previous fixtures encoded that obsolete layout, so they
could not catch the failure. Archive searches `GRANOLA_UNAVAILABLE`, `granola
connect meeting sync`, and `Granola meeting list format changed` found no exact
prior cause; this is novel within the archive, related to contract-drift cases.

## Solution

Extract the single meetings_data section and pagination independently, preserving
strict metadata/count/cursor validation. Ignore upcoming calendar events rather
than ingesting them as recorded meeting notes. Updated the existing full-sync
fixture to the captured provider envelope shape and added a permanent owning
blackbox regression with sanitized metadata.

Before: `cd back-end && node -r dotenv/config --import tsx
src/tests/blackbox/granola-mcp.blackbox.ts` failed with `Granola meeting list
format changed`. After: the identical command passes. The opt-in stored-grant
blackbox also changed from the same failure to 9 parsed notes from 8,694 response
characters using the same historical window. Captures remain private in /tmp;
no meeting content or tokens are checked in. Normal blackbox discovery picks up
the regression automatically; deploy runs that runner. Full `granola-sync` and
`granola-mcp` domains passed in the isolated backend runner.

At 10k agents this adds no per-agent subscriptions, polling, queries, locks or
shared counters. Parsing is linear in one bounded provider response; sync remains
claimed per provider/user with bounded cron concurrency.

## Human feedback

The user required fixing Granola, validating through the UI flow, adding Fireflies
through the same pipes, and exposing both as meeting note taker in Explore and
Rose prompting. They additionally requested a sleek smart search bar at the top
of Integrations. These feature/UI acceptance checks remain separate from parser
causal proof and must be verified before reporting the whole task complete.

## Reusable lesson

Parse the provider's named data section independently from envelope metadata and keep full-path fixtures aligned with captured wire responses.
