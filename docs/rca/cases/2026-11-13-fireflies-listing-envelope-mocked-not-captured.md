---
id: 2026-11-13-fireflies-listing-envelope-mocked-not-captured
date: 2026-11-13
title: Fireflies sync rejected the live {data, warning} listing envelope
surface: back-end
component: fireflies-mcp
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/services/integrations/firefliesMcp.ts listMeetingsBetween only accepted {transcripts:[...]} (or a bare array) from fireflies_get_transcripts
symptoms:
  - Fireflies listing is not a JSON transcript array; refusing reconciliation
  - Fireflies sync failed
tags:
  - fireflies
  - mcp
  - envelope
  - sync
sources:
  - PR #2008
repro: back-end/src/tests/blackbox/fireflies-mcp.blackbox.ts
status: fixed
---

## Problem

After PR #1921 shipped Fireflies, the first real connection showed
`Fireflies · sync failed` with `Fireflies listing is not a JSON transcript
array; refusing reconciliation`.

## Diagnosis

Critical path: Integrations connect → encrypted grant → cron sync →
`fireflies_get_transcripts` → `listMeetingsBetween` → normalized documents.
A new opt-in read-only blackbox (`FIREFLIES_CAPTURE_USER`) loaded the stored
production grant through the real Prisma/decrypt path and called the live MCP
without refreshing or writing the grant. The live reply is
`{"data": [], "warning": "No meetings matched..."}` for an empty window and
`{"data": [{id, title, dateString, summary: {short_summary, ...},
participants, organizerEmail, meetingLink, ...}]}` otherwise. The adapter
unwrapped only `transcripts` / `data.transcripts`, so every listing, including
the empty one, failed closed. The fake provider in the sync helpers emitted
the documented-but-not-served `{transcripts: [...]}` shape with snake_case
fields, so all mocked suites passed.

## Solution

`listMeetingsBetween` accepts a top-level `data` array (keeping the nested
legacy shape), and reads `organizerEmail` as well as `organizer_email`. The
fake provider now replies with the captured live envelope and field names.

## Verification

Red on the old adapter: the new `live {data, warning} listing envelope parses`
case plus three fake-backed cases failed (13/17). Green after the fix (17/17).
Live capture against the user's account: empty recent window parses as 0
meetings; a wide window lists 17 meetings and a real transcript parses
(40,028 chars). fireflies-sync, granola-sync, granola-mcp and data-grep pass.

## Human feedback

Andy reported `Fireflies · sync failed` with the exact error after connecting Fireflies in production, and asked for the fix plus the official Fireflies logo (not the screenshot).

## Reusable lesson

Provider adapters ship with an opt-in live capture test, and fakes reproduce
captured wire shapes rather than documentation examples.
