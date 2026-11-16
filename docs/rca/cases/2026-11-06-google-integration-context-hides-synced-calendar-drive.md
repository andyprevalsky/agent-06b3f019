---
id: 2026-11-06-google-integration-context-hides-synced-calendar-drive
date: 2026-11-06
title: Planner sent a browser agent to read Google Calendar because the user context listed the Google grant as Gmail only
surface: agents
component: get-user-context-connected-integrations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/get_user_context.py _format_user_context — the Google integration line rendered as "- gmail: <email>", hiding that the same grant syncs Google Calendar and Drive
symptoms:
  - "Forbidden tool 'spawn_browser_agent' was called 1 time(s)"
  - "Open Google Calendar in the user's authenticated Google session"
  - "- gmail: rose.benchmark@example.com"
tags:
  - planner
  - user-context
  - google-calendar
  - integrations
  - grep
sources:
  - agent d2a23b47-8e17-4132-b73c-ca5c037a7b88
  - fleet run 20261106-095028-2036387
  - task google-calendar-day-recall
repro: agents/tests/blackbox/get_user_context.blackbox.py::test_format_user_context_names_google_sources_for_full_grant
status: mitigated
---

## Problem

`google-calendar-day-recall` failed on the cloud fleet (descend run
descend-failed-neverrun-20261106, job r001-j0006, agent d2a23b47) with
`Forbidden tool 'spawn_browser_agent' was called 1 time(s)`. The planner
(`call_planner_llm_activity`, Claude Opus 5.5) emitted two any-join hypotheses:
an explore agent to grep the synced calendar and a browser agent to "Open
Google Calendar in the user's authenticated Google session". The explore
agent's single grep (`sources: ["calendar"]`, 2027-03-12) returned all three
events, so data delivery was correct; the browser branch alone failed the task.

## Diagnosis

1. The run transcript shows grep succeeded (3 matches), so the calendar
   fixture and grep tool are fine. The first wrong decision is the planner's
   plan (`set_plan` FINISHED: two tasks, `[spawn_explore_agent]` and
   `[spawn_browser_agent]`, `Join: any`).
2. The decoded planner dump (`call_site: planner`, dump b225ab78a155) shows the
   user context said `## Connected Integrations ... - gmail:
   rose.benchmark@example.com`, while `## Authenticated Browser Sessions`
   listed google.com with "Prefer authenticated sites when they are suitable".
   Nothing told the planner that the Google grant also syncs Calendar and Drive.
3. The product contract makes that claim safe: one Google grant
   (`GOOGLE_OAUTH_SCOPES`: gmail.modify, calendar.events, drive) covers all three,
   and `withGoogleScopeHealth` marks any credential missing a scope
   `needs_reconnect`.
4. Replay of the identical planner request (`scripts/replicate_llm_dump.py
   --mode exact --assert forbid_tool:spawn_browser_agent`): baseline context
   planned `spawn_browser_agent` in 3 of 5 runs; the same request with the
   integration line rendered as `- gmail: rose.benchmark@example.com (synced:
   Gmail, Google Calendar, Google Drive)` planned it in 0 of 5. Both arms were
   served by `openai/gpt-6.1-sol`. The original Claude Opus call could not be
   replayed: the user's Claude subscription returned 429 with a reset of
   2026-12-01.

## Solution

`_format_user_context` now names the synced Google sources on the gmail
integration line when every listed address has a full grant (credential state
not `needs_reconnect`): `- gmail: <emails> (synced: Gmail, Google Calendar,
Google Drive)`. A partial grant or the config-only fallback keeps the plain
line, so the claim is never made without grant evidence. It is general to every
user with Google connected, not specific to this task. At 10k agents it adds one
set comprehension per integration row while formatting context, with no extra
requests. The demo cache canonicalizes the whole dynamic user context, so cache
keys are unchanged.

## Human feedback

None recorded.

## Reusable lesson

When a connected integration syncs several data sources, the user context must
name every synced source, or the planner will hedge with a browser read of data
it could have searched.
