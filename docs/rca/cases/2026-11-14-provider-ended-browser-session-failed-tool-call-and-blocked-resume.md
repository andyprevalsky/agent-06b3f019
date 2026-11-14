---
id: 2026-11-14-provider-ended-browser-session-failed-tool-call-and-blocked-resume
date: 2026-11-14
title: A provider-ended browser session failed the browser tool call and every resume demanded a checkpoint it could never have
surface: cross
component: browser-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py step loop reattached Playwright to an ended provider native (tab_rebind) and failed the tool call; back-end/src/providers/browserSessionResume.ts resume() then required a saved checkpoint (requireSaved = sessionId !== null) for a source the provider had already ended
symptoms:
  - "Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2."
  - "Logical browser saved checkpoint is missing"
  - "[CdpMux] Provider closed the CDP socket (label=session:..., code=1012, reason=)"
  - "Tilion HTTP 410 on GET /v1/session/.../connect: shutdown"
  - "BrowserType.connect_over_cdp: ... client disconnected"
tags:
  - tilion
  - browser-session
  - logical-browser
  - checkpoint
  - provider-session-loss
  - drain-yield
sources:
  - agent ebc611d7-3f66-4cd9-ac94-a35174c2f9be
  - agent 2eef2834-2a94-4fa0-8e98-457269aa4ed0
  - commit f4967dd9d7
  - fleet run detached-20261114-130027-399686
  - plan:docs/handoffs/pr-1682-closeout/repair-evidence/browser-auth-account-locked-rca.md
repro: back-end/src/tests/blackbox/browser-session-private-restore.cases.ts; agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_task_yields_for_a_replacement_when_the_provider_ends_its_session
status: open
---

## Problem

Smoke `browser-auth-account-locked` failed on PR1682 source fe7238984a (agent ebc611d7, 2026-11-11) with `Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2.`; the same-source rerun (agent 2eef2834) passed. The browser agent had handled the locked account correctly (password `locked` 12:24:12Z, code `code_withheld` 12:24:26Z) and was in a 30 s `wait` action when Tilion closed the CDP socket at 12:24:52Z (worker.log:4912, code 1012). browser_use's three reconnects failed, and Tilion answered the connect with `410 shutdown` (request bf1e82ff915e405f, backend.log:3633-3634). Rose's pause at 12:25:02 failed with `Browser checkpoint connection failed`. The next step's tab_rebind failed with `TargetClosedError`, spawn_browser_agent #1 returned ERROR, and the planner re-spawned (second root call). Every re-spawn init then failed with `Logical browser saved checkpoint is missing` (backend.log:3651..4284). Source: the PR1682 closeout RCA report on branch `records/pr-1682-closeout`.

## Diagnosis

Path: provider native end -> CdpMux close -> step loop `is_connected() is False` reattach (handler.py tab_rebind) -> outer `Browser automation failed` -> ERROR tool result -> planner re-spawn -> `POST browser-session/init` -> `resumeOwnedBrowserSession` -> `resumeBrowserSession.resume()` -> `loadLogicalBrowserCheckpoint(taskId, requireSaved=sessionId !== null)`.

1. The step loop could not tell a transient client drop from a provider-ended native. It always reattached, and against an ended native that can only fail. The existing step-boundary drain yield already restarts a task from the same step on a replacement session for deploy drain, session expiry and activity deadline, but not for provider loss.
2. resume() required a saved checkpoint for any materialized source (`sessionId !== null`). A provider-ended source with `checkpointRevision = 0` cannot have one: capture needs the live browser. So the logical browser was permanently unresumable. With `checkpointRevision >= 1` the same provider loss already restored the last checkpoint and dropped later state, so the revision-0 refusal was an inconsistent special case. Health had already confirmed the end (`recordEndedLogicalBrowser` flipped the row to PAUSED). A later resume of that PAUSED row also never re-checked health.

Why possible: the private-state continuity guard (2026-11-05 case) was written for unknown or live sources. Provider-confirmed loss was never separated from them.

Repro, identical commands before and after the fix:
- `cd back-end && DATABASE_URL=<local victoria> DIRECT_URL=<same> ../node_modules/.bin/tsx src/tests/blackbox/browser-session.blackbox.ts --private-restore-only`: exit 1 before, `Crashed: Error: Logical browser saved checkpoint is missing` at the provider-ended case; exit 0 after.
- `python /tmp/rcarun/run_one.py test_browser_task_yields_for_a_replacement_when_the_provider_ends_its_session` (a loader for that agents blackbox function): exit 1 before, with `Browser automation failed ... Playwright client disconnected during attachment or focus binding`; exit 0 after.
- Each passed five consecutive runs after the fix.

Archive searches: `Logical browser saved checkpoint is missing`, `Tilion session closed 1012 410 shutdown spawn_browser_agent exact root call limit`, plus a grep of cases for `saved checkpoint is missing|provider-lost|1012`. Relatives:
- 2026-11-05-tilion-missing-session-health-not-terminal: its 404/410 -> `deleted` health is what confirms the end here. Its guard note (never silently resume from baseline) applies: this fix restores from the last durable checkpoint only after provider-confirmed end, and it logs and yields explicitly.
- 2026-10-27-approval-wait-omits-private-browser-checkpoint and 2026-11-13-tilion-dead-worker-release-failure-latched-browser-init: neighbouring, different boundaries.

Not a recurrence.

Tilion shutdown cause: provider-side and unobservable from Rose. CDP close code 1012 means "service restart". Today Tilion returns `404 No such session` for both `/status` and the session record of sess_c3d0eb3af7c9476f84c6e6e481f50c8a (X-Request-IDs 7b53aec11bf64d19, 312578480bf64a99), and it has no events API. The only remaining evidence is Tilion's own logs for request bf1e82ff915e405f. That is an open observability gap, owned by the provider.

## Solution

- Backend task-info (`service.task-info.ts`, validateLive): new typed field `provider_session_ended`, set from `isConfirmedBrowserEnd` for the exact native. The worker no longer has to guess from availability reasons.
- Agents (`handler.py` drain block, `config.py`): new drain reason `browser_provider_session_lost`. It fires only when all of these hold:
  - the step's Playwright client is disconnected;
  - task-info reports this exact native as `provider_session_ended`, or its row was PAUSED (`db_status_paused`) under the driving worker;
  - fewer than `BROWSER_PROVIDER_SESSION_MAX_RECOVERIES` (2) replacements were already taken. The count is carried through the drain resume state.

  The activity then yields at the step boundary, and the manager restarts the same task from the same step. Unknown health, an expiring session, a missing URL or a spent budget keep the existing reattach path and fail loudly.
- Backend resume (`browserSessionResume.ts`, `browser/providerEndedSource.ts`): a provider-confirmed ended source restores its last durable checkpoint, or the baseline. That covers an ACTIVE row whose health is ended, and a PAUSED row without a checkpoint whose end is re-confirmed through health. The response carries `provider_session_lost: {restored_checkpoint_revision}` and a warning is logged. Unknown health and live sources still refuse before any allocation.
- Agents resume: when the response carries `provider_session_lost`, the activity posts a FINISHED `supervisor_recovery` action, "Browser session replaced", so the loss is visible and never silent. This answers the 2026-11-05 note that a baseline restore must never be silent or claim continuity.

CodeRabbit (PR #2065) follow-ups:
- The provider-loss check now runs at every step boundary, including an invocation's first. The recovery budget bounds it, not the drain step gate.
- The spent budget is part of the shared pause snapshot (`_pause_continuity_state`), so a user pause and continue cannot reset it.
- After this task's own provider-lost yield, the resumed activity reports the replacement even when an older checkpoint was restored, a case the backend cannot prove once task-info paused the row.

Regression `test_browser_provider_session_recovery_covers_first_step_snapshot_and_checkpointed_restore` fails on the earlier handler ("an ended provider session must not be stepped").

Deferred: another caller (for example a planner re-spawn) resuming a row that task-info already recorded ended while it held a checkpoint still restores that checkpoint without `provider_session_lost`. That predates this fix. Reporting it needs persisted provider-end provenance, which means a schema column, a migration and a republished seed fixture.

Same-class sites: initSession re-init, auth-assistance resume and the root browser all go through `resumeBrowserSession`, so all are covered. Deliberately not covered: a provider end that raises inside an action or observation. That action may have partly executed, and a write could be repeated on replay, so it still fails the tool call loudly.

Evidence that the incident's end was confirmed: base resume reaches the missing-checkpoint throw only on a PAUSED or reconciled row, and only `recordEndedLogicalBrowser` (confirmed end) sets that state without a checkpoint. A probe of Tilion today returns 404 (mapped to `deleted`) for the session.

Independent review: a fresh sub-agent named the same two boundaries (handler.py tab_rebind reattach; resume requireSaved for confirmed-ended sources). It raised the silent restore, the over-broad lost predicate, the unbounded replacements and an overwritten flag. All are fixed with regressions: `test_browser_task_recovers_only_confirmed_provider_ends_within_budget` fails on the round-one handler ("yielded instead of failing") and passes now. It confirmed no race (recordEnded is an idempotent compare-and-swap) and a working workflow restart chain.

10k behaviour: one task-info read only on a disconnected client, plus one health read only for a PAUSED row without a checkpoint. No polling, no fan-in, and at most 2 replacements per task.

## Human feedback

None recorded.

## Reusable lesson

Separate provider-confirmed loss from unknown or live state at the continuity guard: restore the last durable state and resume the same task, rather than failing the tool call or refusing every resume.
