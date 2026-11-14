---
id: 2026-11-06-code-session-owner-limit-before-eligibility
date: 2026-11-06
title: Merge filtered owner sessions after LIMIT and hid eligible sessions
surface: back-end
component: code-session-store
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: ownerCodeSessions applied the ten-row limit before excluding expired unpinned sessions
symptoms:
  - ten expired unpinned sessions hide an eleventh active session
  - a referenced stale CLI session can be missed by owner lookup
  - resolve may create a parallel session despite an eligible existing session
tags:
  - code-sessions
  - cli-templates
  - ttl
  - query-limit
sources:
  - commit 84ad54d4155c7b5c4a134c116688dfd4532dabe3
repro: cd back-end && node --experimental-test-module-mocks --import tsx src/tests/unit/code-session-owner-selection.test.ts
status: open
---

## Problem

Merge84ad combined incoming no-retirement-on-lookup behavior with retained CLI-template eligibility by filtering a bounded ten-row owner scan in application code. Ten expired unpinned rows could consume that scan and hide an eleventh active or referenced session. Parent review identified this concrete conflict-resolution regression before broader validation.

## Diagnosis

Gate: INTRODUCED — merge84ad moved TTL eligibility after the query limit. Incoming main applied TTL inside the query. The previous branch retained referenced CLI-template sessions but retired unpinned expired sessions during lookup; that retirement must not return.

The same exported owner lookup test first fails with `ten expired unpinned rows must not hide the eleventh active session`, actual `[]` versus the eleventh active row. A database mock executes filtering, ordering and limits using a private in-memory SQL engine: it does not return canned rows. No application database, provider, filesystem database or external service is opened.

Archive searches used owner/session/expired/limit/pinned and TTL/query/retirement/template. The related 2026-11-04-code-session-ttl-resolve-retired-without-kill case requires a single retirement owner that also frees sandbox/checkpoints; this repair keeps that requirement.

## Solution

Apply eligibility inside the indexed user/owner/repository query before sorting and LIMIT10. A correlated EXISTS accepts an expired session only when the same user's CLI TOOL_SETUP integration references its exact id through config.code_session_id. EXISTS preserves one result per session even with duplicate references. Retired sessions remain excluded. Query parameters bind all user input; the lookup loads no unbounded integration/session array and performs no write.

The unchanged original command passes after the fix. The owning unit also checks the twelfth expired-but-pinned session, foreign user/owner/repository, retired rows, foreign-user/wrong-name/wrong-type pins, duplicate references, chronological ordering, the ten-row response bound, normalized repository keys and reuse under the existing lease. The existing lease and parallel-session implementation is unchanged. `cliTemplateReferences.ts` is unchanged.

The new `.test.ts` file is automatically registered by back-end/scripts/run-unit-tests.ts's existing recursive unit discovery. Exact before/after logs and a report are retained in .context/cli-nov06-resume/store-ttl-repair. The in-memory query test is not PostgreSQL integration or full deployment proof; parent owns independent review, combined focused gates and broader validation. Status stays open pending those gates. No financial debt, failed native result, timeout or assertion is waived.

## Human feedback

The user required the same merge follow-up, no new deployment/child/provider/financial/database-service actions, a real query-semantics regression, bounded indexed owner scope, pinned CLI eligibility, and incoming no-retirement semantics. Parent waits for this narrow repair before other focused validation and image work. No source push or full sweep is performed here.

## Reusable lesson

When combining retention exceptions with a bounded query, filter all eligibility predicates before LIMIT; do not let discarded rows consume the candidate budget.
