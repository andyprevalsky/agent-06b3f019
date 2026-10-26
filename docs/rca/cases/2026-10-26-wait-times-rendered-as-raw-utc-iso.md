---
id: 2026-10-26-wait-times-rendered-as-raw-utc-iso
date: 2026-10-26
title: Wait rows showed the producer's raw UTC ISO timestamp instead of the viewer's local time
surface: front-end
component: local-date-time
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: front-end display sinks — trajectoryWorkGroups.ts trajectoryActivity label, subAgentTree/StatusLine.tsx, WaitForChip.tsx condition description and WaitForTimestampChip.tsx rendered agent-produced text/ISO without a local-time formatter
symptoms:
  - Waiting until 2026-10-26T17:23:00+00:00
  - waiting for time X should be in the user's local time
  - raw ISO timestamp in transcript wait row
tags:
  - rose-desktop
  - wait_for
  - timezone
sources:
  - commit 6c49168e8
repro: front-end/src/tests/blackbox/wait-for-chip.blackbox.tsx ("wait times render in the viewer's local time zone")
status: fixed
---

## Problem

Andy: "all waiting for time X → when displayed in fe, should be in the user's
local time, e.g. October 26th, 5:00pm PST". The live work row (clock icon)
read `Waiting until 2026-10-26T17:23:00+00:00`.

## Diagnosis

`agents/domains/wait_for/handler.py` titles the row `Waiting until
{until_timestamp}` and `agents/utils/format_tool_display.py` produces the same
text for streaming placeholders and tree `toolsInUse`. The server cannot know
the viewer's zone, so formatting belongs in the FE; every FE sink printed the
text verbatim (row label, sub-agent tree / agents-running status lines, the
placeholder chip), and WaitForTimestampChip used a different ad-hoc
`toLocaleString` without the zone. No shared date-time formatter existed.

## Solution

`front-end/src/lib/localDateTime.ts`: `formatLocalDateTime` ("October 26th,
5:00pm PDT", Intl zone abbreviation; zone-less ISO is UTC, matching wait_for)
and `localizeTimestamps` for ISO date-times embedded in display text. All four
sinks use it. The test pins TZ to America/Los_Angeles (PDT and PST dates) and
Asia/Tokyo and asserts no raw ISO remains. Pure render-time formatting; no
backend calls; constant per row.

## Human feedback

Andy specified the format and the local-zone requirement.

## Reusable lesson

Format absolute times at the FE sink with the shared local-time formatter;
never render producer ISO strings verbatim.
