---
id: 2026-10-30-unscoped-auth-error-expired-every-code-subscription
date: 2026-10-30
title: One leased token's auth_error expired every code-agent subscription its user had
surface: cross
component: compute-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py mark_compute_token_rate_limited_activity reported source=user auth_error with only userId; back-end markGptUserTokenRateLimited / markUserTokenRateLimited then ran updateMany over every claude_code / gpt_code row of that user
symptoms:
  - all of a user's claude_code / gpt_code rows EXPIRED or rate-limited with one identical updatedAt (one updateMany)
  - "disabled after auth_error", updated > 1, accountId null, integrationId null in Render logs
  - "claude_code cooldown for <userId> names no login and the user has several; dropped"
  - claude_auth_present=false on every rose-1-ultra rose.complete.start; actual_model never ends in -claude
  - every Codex / Claude Code session falls through to paid Azure; "Compute credentials not found for user"
tags:
  - oauth
  - compute-token
  - subscriptions
  - codex
  - claude-code
sources:
  - task User Scale Bug Bash lane S33 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1644
  - task T7 recurrence 2026-11-04 (branch fix/compute-token-login-disable-writers)
  - task recurrence 2026-11-13 rate-limit cooldowns (branch fix/rca-unnamed-user-cooldown-fingerprint, parent thread ph78393fcn3fqnvcdhq1f3jn0s8j3jyk)
repro: back-end/src/tests/blackbox/compute-subscription-usage.cooldown.cases.ts (an unnamed claude/gpt 429 report cools exactly the login its fingerprint names); back-end/src/tests/blackbox/integrations.scoped-auth-expiry.cases.ts; back-end/src/tests/blackbox/integrations.login-disable-writers.cases.ts (unscoped + chat rotation); agents/tests/blackbox/workflow.blackbox.py::test_workflow_auth_error_report_names_the_leased_login
status: fixed
---

## Problem

Prod had no usable code-agent subscription for Andy: all three `claude_code`
rows and two of three `gpt_code` rows were EXPIRED (`auth_error`), so every
code session ran on the paid Azure fallback.

## Diagnosis

Evidence (Render prod logs, read-only DB):

- Each batch shares one `updatedAt` to the millisecond (gpt: 2026-10-29
  03:15:17.292; claude: 2026-10-30 18:09:38.393), i.e. one `updateMany`.
- Render (prod; req 277d3376ff0e gpt, 36c6bfbac24f claude) made both writes through
  `POST /api/integrations/compute-code/token/rate-limited`, logging
  `disabled after auth_error`, `updated: 3`, `accountId: null`,
  `integrationId: null`.
- Across all users, only Andy's two batches (5 rows) match the pattern.
- Ruled out: a devbox gate rotating a prod token, concurrent refresh between
  instances, and upstream revocation. The expiry was our own write, and it was
  issued without naming a credential.

Root cause:

The compute-token lease served one `Integration` row but never told the worker
which one. On a 401/403 the worker reported `{type, source:"user", userId,
failureReason:"auth_error"}`. The service forwarded only `userId`, and the
user branch expired every matching row. One bad account therefore expired
every healthy sibling subscription.

## Solution

- The lease returns `integrationId`. The worker captures it in the auth
  context's mark callback and sends it back. The route and service pass it to
  the mark functions, which already scope by `integrationId`.
- Guard: an `auth_error` that names neither an integration nor an account never
  expires anything when the user has more than one live row. Workflow-threaded
  tokens that lack the id rotate to a fresh, scoped lease, and that lease's
  failure expires exactly the bad row.

## Regression

- `integrations.scoped-auth-expiry.cases.ts` (integrations blackbox, pooled
  sequential group): two accounts. An unscoped `auth_error` leaves both
  CONNECTED, the lease names the served row, and a scoped `auth_error`
  expires only that row. Before the fix both rows became EXPIRED.
- `rose.blackbox.py` `user_auth_error_report_names_the_leased_integration`:
  the worker's report body carries the leased `integrationId`.

## Recurrence 2026-11-04 (T7): why the S33 fix did not hold

Evidence (prod, read-only): a `compute-code/token/rate-limited` write at
2026-10-31 00:37:13Z still logged `disabled after auth_error`, `updated: 3`,
`integrationId: null`, four hours after this fix merged. Today all 3 of Andy's
`claude_code` rows and 3 of 4 `gpt_code` rows are EXPIRED/auth_error (he is
the only affected user in prod). Worker logs (ClickHouse, 2026-11-03 02:09:10Z)
show the workflow's report arriving as `"rate_limited_until": "rate_limit",
"failure_reason": null` right after `GPT token rate_limit ... marking user
token rate-limited and rotating`.

The 10-31 write carried `failure_reason=auth_error` with no identity, so it
was not the post-S33 workflow (whose misaligned report dropped the reason; see
gap 1). Its caller is unidentified: a worker or delegated guest still running
pre-S33 code, or a legacy route. It got through because of gap 2: Andy had one
CONNECTED claude row (two were already EXPIRED from 10-30 18:09), so the
single-candidate guard allowed it, and the `updateMany` re-stamped the two
EXPIRED siblings (`updated: 3`; one row later went CONNECTED and was rewritten
on 11-03).

Three gaps:

1. S33 inserted `integration_id` as the 5th positional parameter of
   `mark_compute_token_rate_limited_activity`. `AgentWorkflow._on_tokens`
   (agents/workflows/agent_workflow.py) calls it through Temporal with a
   positional `args=[...]` list in the old layout: `300` became the
   integration id, `None` the cooldown, the error kind the
   `rate_limited_until`, and `failure_reason` was lost. The workflow test's
   mock activity kept the old signature and asserted the old list, so it
   cemented the bug. After S33 this layout suppressed the workflow's disables
   and broke its cooldowns (`rate_limited_until` was not a date); before S33
   the same call sent a correct reason with no identity. The workflow also never kept the lease's
   `integrationId` (nor passed it in `_active_compute_token_payload` to
   `call_llm_activity`), so its reports could not name the login either way.
2. The backend guard expired an unscoped report whenever the user had at most
   one CONNECTED row, and the Claude `updateMany` also matched EXPIRED rows,
   so `updated: 3` re-stamped siblings. Internal `/compute-code/*` requests
   from bench guests and local stacks delegate to the prod authority
   (`routes.compute.ts` `delegateToAuthority`), so any stale worker version
   anywhere still reaches this route; there is no prod Fly log for the
   10-31 write, which fits a delegated caller.
3. `computeCredentials.ts` `markComputeTokenUnavailable` (chat rotation) sent
   a user report with `accountId` only, which Claude rows lack.

Repro (pre-fix, observed failing):
`cd agents && python /var/tmp/t7/run_one.py tests/blackbox/workflow.blackbox.py test_workflow_auth_error_report_names_the_leased_login`
→ `AssertionError: claude: {... 'integration_id': 300, 'cooldown_seconds': None, 'rate_limited_until': 'auth_error', 'failure_reason': None}`;
`bash back-end/scripts/run-blackbox-tests.sh integrations` →
`FAIL login writers -- an auth_error naming no login disables none (T7) -- claude_code: ... "status":"EXPIRED"` and
`FAIL login writers -- chat rotation disables only the leased login (T7) -- ... "status":"CONNECTED"`.
Both pass after the fix (identical commands).

Fix: the workflow remembers `compute_token_integration_id`, forwards it in the
compute-token payload, and passes every activity parameter in order plus the
held token's fingerprint (`credential_fingerprint`, same digest as
`codeLoginRejection.ts`). The activity carries `credential`. The route
accepts `credential` (fingerprint-sized only) and, for an auth-failure
reason, applies it only when the report names the login and
`classifyLoginRejection` says `revoked`; the writer-level guard now refuses
every unscoped auth expiry, whatever the row count. The chat rotation names
the leased integration.

Lesson for this class: changing a Temporal activity's positional signature
must update every positional `args=[...]` caller, and test mocks must share the
real signature (the new regression binds the recorded args to the real
activity with `inspect.signature`).

10k agents: unchanged hot path; one indexed read + decrypt per auth-failure
report, none on success.

## Recurrence 2026-11-13: rate-limit cooldowns, and why naming by id did not hold

Symptom: prod `Rose.complete` made zero subscription-authed calls for ~30h
(2026-11-12 05:00Z to 2026-11-13 11:00Z). Every `rose-1-ultra`
`rose.complete.start` logged `claude_auth_present=false`. Since 11-06 only 5
agent leases returned a Claude token, and ~4.3k lease requests got
`Compute credentials not found for user`. Over the window, paid routes served
ultra: Foundry gpt-6.1-sol 361 calls (12.4M input tokens), gpt-6-luna 246
(11.5M), gpt-5.6-luna 39, and OpenRouter sol 6. That is roughly $18 at list
price, Azure-funded.

Evidence (ClickHouse `observability.fly_logs`, Render request/app logs, a
read-only prod DB, and one 1-token header probe per pooled Claude row):

- Every `claude_code` and `gpt_code` row of Andy's was in a DB cooldown
  through the window. Three GPT accounts that had been idle since 11-06/07 got
  one account's 7d reset (`2026-11-17T21:28:44Z`, matching `de25c911`'s
  `usage7dResetsAt`) from a single `/compute-code/token/rate-limited` POST.
  All three rows carry `updatedAt` 2026-11-11 02:21:31.047 and the log line
  `GPT user token for <user> rate-limited until 2026-11-17T21:28:44.000Z`.
  One POST at 2026-11-10 21:48:54 (`User token ... until 2026-11-13T11:00`)
  likewise left three Claude accounts at `11-13T11:00`. The probe shows that
  `6aa8c17b`'s own 7d window reset 11-11 19:00, so it was usable through the
  whole outage. These POSTs came through `delegateToAuthority` from non-prod
  stacks (UA `node`, non-Fly IPs).
- Before PR #1981 (merged 2026-11-13 ~10:43Z), the cooldown writers ran
  `updateMany({userId, name})` when the report named no login.
- After #1981, `scopeUnnamedUserCooldown` drops such a report. The spent login
  then stays leasable, and every lease re-hits its 429.
- Claude leases resumed at 11:00Z, when the cooldowns lapsed;
  `claude_auth_present=true` appears at 11:14Z.

Why the earlier "name the login" fix did not hold: the T7 fix threaded
`integrationId` through specific callers. The workflow puts it in its
compute-token payload, but the agent loop's LLM paths never read it.
`helpers/llm.py` builds the auth contexts of `call_llm_structured_streaming`
(the A1/A4 main loop), `call_llm` and `_call_llm_verifier` without
`integration_id`, so their `source=user` 429 reports carry only
`userId` + `credential`. Every new call path reopens the gap. Stale guests
that delegate to prod reopen it too.

Deepest owned cause: the backend identified a reported login only by an
optional id that callers must plumb. It already receives the held token's
fingerprint (`credential`, the same digest as `codeLoginRejection.ts`) on
every report.

Repro: `bash back-end/scripts/run-blackbox-tests.sh compute-subscription-usage`.
Pre-fix (main 5d8e6d4d3), two cases fail:
`FAIL an unnamed claude 429 report cools exactly the login its fingerprint
names -- the held login must cool until 2026-11-17T11:25:56.423Z, got null`.
The gpt case fails the same way. Post-fix, the identical command passes
5/5 consecutive runs.

Fix: `resolveUserLoginByCredential` (computeLoginFailure.ts, shared with the
usage-heartbeat fix in `2026-11-13-agent-loop-usage-heartbeat-dropped-without-integration-id`) resolves an unnamed
`source=user` cooldown report to the user's row whose stored access token has
the reported fingerprint. `markTokenRateLimited` and `markGptTokenRateLimited`
(domains/integrations/service.ts) apply it before writing the cooldown. A
cooldown then lands on exactly the spent login, never on its siblings, and is
no longer dropped. Reports with no fingerprint match keep #1981's drop.
Auth-failure reports are deliberately excluded: they still must name the login
explicitly, as S33/T7 requires, so the fingerprint never widens a destructive
login expiry. The regression asserts that an unnamed `auth_error` carrying a
matching fingerprint leaves the login CONNECTED.

10k agents: this runs only on a failure report with no id. It does one
indexed `findMany({userId, name})` and decrypts at most that user's logins of
one kind. There is no work on the success path and no new shared state.

Open follow-ups (not fixed here):

- `spawn_browser_agent_v3/repo.py` `report_claude_token_rate_limited`
  (route `/claude-code/token/rate-limited`) sends no id and no fingerprint.
  Its user reports are still dropped.
- Two Claude rows hold `rateLimitedUntil=2026-12-01T00:00Z`, written
  2026-11-06 10:36/10:37 by a devbox agent (GCP IP, python-httpx). The live
  probe on 11-13 shows `88a02cdc` allowed (7d utilization 0.0) and
  `074bfdd5` resetting at 11-13T17:00. Root-caused on 2026-11-14 in
  `2026-11-14-fast-mode-overage-reset-stored-as-subscription-cooldown`: a
  fast-mode request's overage rejection carries the monthly overage reset.
- Andy's device login `7e916787` expired 2026-11-11 13:00 and needs a device
  re-sync. That is a credential action; nothing was changed here.

## Human feedback

Andy (via parent, 2026-10-30): find why the subscriptions expired; never let a
test or second instance rotate a prod token; do not modify prod credentials;
he reconnects after the fix. Restoring the 5 collateral rows waits for his OK.

2026-11-13 recurrence (Andy's rules, relayed by parent thread): do not mint,
rotate or revoke credentials. Report what is needed. Fix only the gap that
PR #1981 left. Do not take over #1981's usage-refresher 403 work.

## Reusable lesson

A failure report must name the exact credential that failed. Any write keyed
only by user (or other coarse owner) can turn one bad credential into an
outage of every sibling. When the identity is missing, refuse the destructive
write and let a scoped retry handle it.

10k-agent behaviour:

The guard adds one indexed `count` per unscoped auth report. Scoped reports
update a single row by primary key. No new channels or fan-out.

### Follow-up 2026-11-05 (CodeRabbit 4475152998)

Gap 1's fix aligned the workflow's positional report. A further review showed
that the report was wrong in principle: after an in-call rotation, the
workflow's cached lease is not the lease that failed, and RoseClient already
reports every failed attempt with that attempt's own login (provider
cool-down / stall mark). `AgentWorkflow._on_tokens` therefore no longer
reports token failures at all; it only re-leases. Regressions:
`workflow.blackbox::test_workflow_never_reports_its_cached_login_for_a_call_failure`
and `rose.blackbox::test_rotated_attempt_failures_are_reported_with_their_own_login`.
