---
id: 2026-10-13-realm-transition-retained-stale-auth-context
date: 2026-10-13
title: Failed realm preparation retained the previous site's auth options and assistance identity
surface: cross
component: browser-realm-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: prepareSessionCredentials discarded validated target inventory on restoration failure; the worker retained prior-realm context while continuing navigation
symptoms:
  - Auth Options for claude.ai during a Google Workspace Admin task
  - Requesting User Assistance for claude.ai Login on a Google sign-in page
  - Optional realm credential preparation failed once; continuing without saved credentials
  - Browser state injection timed out after 18000ms
  - failed Google discovery retained Claude assistance realm
tags:
  - browser-auth
  - credential-context
  - realm-transition
  - google-workspace
  - state-injection
sources:
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
  - plan:docs/plans/completed/browser-auth-credential-model.md
repro: back-end/src/tests/blackbox/browser-session-credential-injection.blackbox.ts; agents/tests/blackbox/browser_credentials.blackbox.py; agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

Browser task 4adbfe99-04c5-5380-a26a-1d2980ab96d8 was instructed to manage a
Google Workspace user's Admin security setting, explicitly avoiding Gmail and
Claude. The parent nevertheless supplied start_url https://claude.ai at
22:19:51 UTC on October 12. The browser correctly navigated to Google Admin,
then encountered Google's password challenge. Its auth options and user
assistance still identified claude.ai. The root was PAUSED when inspected;
no login, account, credential, blocking setting, or original task was changed.

Evidence: all 2,362 stored root messages; the original final browser LLM dump;
retained Fly logs for the exact task and worker span 4d63c7919d64. At
22:20:26.085704 preparation for admin.google.com returned HTTP 500 with
Browser state injection timed out after 18000ms. Goto then succeeded at
22:20:29.488856. At 22:20:49.132601 preparation for accounts.google.com also
failed. Message cfc7473d-ee38-4472-9790-ae4d67800ec9 at 22:21:13.716 persisted
requestUserAuthentication.authRealm = claude.ai. The last captured request,
browser_use_step_3 dump 6ade927fee6c, contains Auth Options for claude.ai.
Sensitive dumps, sign-in URLs, cookie values, encrypted secrets and signed
headers remain private workspace artifacts and are not fixtures in this case.

## Diagnosis

Critical path: parent browser goal/start_url -> initial realm inventory ->
browser navigation -> POST /prepare-auth -> validated credential inventory ->
browser-state restoration -> worker activation -> auth inventory in system context ->
assistance request.

The parent start_url explains the initial Claude inventory. It does not justify
using that inventory after a Google navigation. Refresh was attempted, not
skipped. The backend collected and validated target auth options, encrypted
passwords and passkeys, but awaited all browser-state restoration before
returning them. A restoration timeout produced an error-only 500 and discarded
that already-valid inventory. The worker quarantined the optional preparation
failure and continued navigation, while its realm and dynamic context were
updated only on successful preparation. Thus the previous site's state survived
and was used both for model guidance and the assistance request.

The deepest owned cause is coupling authentication context validity to an
auxiliary restoration outcome. The same gap affects any merchant-to-login,
checkout-to-payment, or admin-to-identity-provider transition. Returning to a
previously failed realm can also retain another site's context if invalidation
is placed only inside the preparation callback that quarantine skips.

The next-deeper class considered was all contextual data remaining valid across
all external materialization failures. That is not a coherent repair at this
boundary: unrelated context has different provenance and owners, and no evidence
supports changing those contracts. The stopped class is mutable, realm-scoped credential inventory retaining an
unrelated identity after a failed transition. The additional placement flaw is
putting this external inventory in system context: updating it rewrites the
prefix before all accumulated browser turns. The coherent repair separates
stable policy, private activation, and surface-bound tool observations. The repair
changes context selection and error data, without adding task-specific coaching
or goal/domain keyword classification. No model-only replay supports an
intelligence classification for the parent's inconsistent start_url.

Archive searches: Requesting User Assistance claude.ai Login; google workspace
wrong authentication domain credential browser; credential preparation guest
navigation failed realm. Related cases: 2026-08-03-parallel-browser-state-injection-hung-jit-realm-preparation
and 2026-10-12-cookie-bundle-ranking-used-sso-recency. This is a relative, not a
proven recurrence of either first-bad boundary. Why this particular restoration
stalled remains a separate unresolved question; this case proves what made a
restoration failure present the wrong site's credentials.

Golden references inspected: Hermes apps/desktop/electron/remote-session-cookies.ts:19
keys credentials by partition and request origin and clears stale identities;
Codex codex-rs/login/src/gateway_auth.rs:373 keys credentials by the full provider
authorization configuration; OpenClaw extensions/browser/src/browser/pw-tools-core.storage.ts:30
requires URL or domain/path binding. Claude Code src/services/oauth/client.ts
and src/services/mcp/auth.ts were searched; no equivalent browser JIT preparation
mechanism was identified. This repair converges on scoped identity. None of
these analogs proves why Google's remote session was rejected.

## Solution

Local implementation of the user's revised placement, pending deployment:

- Preserve complete validated target inventory in a typed injection error; the
  preparation route still returns 500 and its original failure. Discovery,
  ownership and completeness failures expose no credential payload.
- The worker consumes only that precise tagged response, hydrates the target
  inventory and preserves restoration failure in the actual navigation result.
  It does not claim cookies or origin state were successfully restored.
- Invalidate unrelated realm context before discovery or quarantine can skip
  work. Use one activation function for invalidation and successful hydration.
  Keep payment refs separate; do not describe unavailable inventory as a known
  empty credential list.
- Remove inventory from both initial system construction and realm updates.
  Keep private hydration independent of stable system policy. Include the safe
  formatted inventory in genuine navigation, interaction, and read_browser_state
  results; preserve it in serialized tool history, including initial/resumed reads.
- Bind results to the observed foreground URL after redirects, tab actions,
  links, form submissions, and script navigation. Reobserve after preparation;
  refresh a captured DOM if the page changed. Bound this to two attempts and
  report unknown inventory if the page keeps changing or observation fails.
- Reuse inventory within the same realm and browser/credential binding; invalidate
  it and the previous session's quarantine when that binding changes. Non-web
  pages clear active credentials and publish not_applicable inventory.
- Do not reload after failed restoration. Initial/resumed-session restoration
  remains strict; injection abort, timeout and cancellation fences are unchanged.
  Previously submitted tool messages remain immutable across realm transitions.
- Every activity action caller, including pending approved actions and automatic
  payment autofill, shares destination observation and result redaction. Retain
  pre-action and newly activated secret maps until the result is redacted, so a
  cross-realm result cannot leak an old password when refs collide. Evaluate
  values/errors are also redacted before their raw action-history entry.
- Successful post-action preparation schedules the existing reload before the
  next model decision. Pre-navigation preparation and failed restoration do not
  schedule an extra reload. Autofill navigation reobserves before its next model
  turn and does not invent a model-issued tool call.

```mermaid
flowchart LR
  S[Stable system policy] --> L[Browser model]
  N[Actual browser action or page read] --> U[Observed destination URL]
  U --> R[Private realm credentials]
  R --> T[Safe inventory in genuine tool result]
  T --> L
  E[Optional restoration error] --> T
```

Permanent causal commands and measured results:

1. From back-end, with DATABASE_URL and DIRECT_URL both explicitly set to
   postgresql://postgres:postgres@127.0.0.1:5432/victoria,
   TRACE_ARCHIVE_BACKEND=local, BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=false and
   BENCHMARK_ANON_STEEL_PROFILE=false:
   npx --no-install tsx src/tests/blackbox/browser-session-credential-injection.blackbox.ts
   Before exit 1: state timeout discarded the validated target credential payload.
   After exit 0: the same timeout rejects, preserves complete inventory, leaks no
   secret through Error inspection, and fences subsequent state mutations.
2. From agents with its venv active:
   python scripts/run_blackbox_tests.py browser-credentials
   Before exit 1: tagged injection failure is raised and preparation failure
   disappeared from the actual tool result. After exit 0: Google options survive
   separately from restoration failure; generic failure identifies the target.
3. The permanent spawn-browser-agent-v3 suite contains full-activity cases for
   failed discovery and returning to a quarantined realm. A focused loader at
   .context/rca-07281fc3/worker-activity-repro.py runs those same registered tests.
   Its unchanged command is agents/venv/bin/python followed by that loader path.
   Before: failed Google discovery retained Claude assistance realm.
   After: assistance binds the Google realm and no Claude inventory reaches its
   system context. The revised three-case replay also checks initial/resumed
   inventory in actual read_browser_state results, byte-identical system content,
   immutable previously submitted history, and unknown inventory after failed
   discovery. Original HEAD fails the wrong-realm assistance cases; the prior
   system-update candidate fails the revised placement/result assertions.
   Full runner: python scripts/run_blackbox_tests.py spawn-browser-agent-v3.
4. browser-credentials permanently checks actual destinations for goto, back,
   switched/opened/closed tabs, click, Enter, input, script navigation, wait, and
   page reads; redirects during preparation, refreshed DOM binding, preserved
   partial-action failures, bounded unstable pages, and secret-free inventory.
5. The existing full-activity Steel recovery case also checks fresh inventory
   preparation against the replacement session despite an unchanged auth realm.
6. Permanent full-activity tests activity_cross_realm_action_redacts_reused_ref_values
   and activity_redirected_goto_reloads_prepared_realm_once fail on the candidate
   before the review fixes and pass afterward. They check prior/new secrets sharing
   one ref never reach tool history or persisted results, and exactly one reload
   precedes the next model turn only after successful post-action preparation.
   The strengthened evaluate_awaits_promises case checks raw action-history
   redaction while retaining native awaitPromise behavior.

7. activity_autofill_redirect_rebinds_before_model drives the actual automatic
   input path with an approved synthetic card. Before the shared wrapper, it
   retained new.example for assistance after navigating to auth.example. After,
   it binds auth.example, reloads before the first model decision, and produces
   no fabricated model-issued tool call or old-page nudge. The unchanged case
   failed before and passed after. Optional provider recording I/O is stubbed in
   these auth-specific fixtures; production action/history handling is exercised.

Final combined owning command:
python scripts/run_blackbox_tests.py browser-credentials spawn-browser-agent-v3 rose-browser-use
PASS: 3 domains, 0 failed, 62.1 seconds; rose-browser-use includes 98 tests.
Backend credential-injection PASS; backend TypeScript, scoped ESLint and
Prettier PASS; scoped Python Ruff and git diff --check PASS. Final independent
production review found no concrete blocker after the redaction, autofill, and
reload fixes. The subsequently added autofill fixture closes its last stated
coverage gap without changing production code.

Both owning runners discover these domains and /deploy runs them through backend
blackbox/coverage and agents coverage gates. Scoped TypeScript, ESLint, Prettier
and Ruff checks are recorded with the local candidate. Deployment and a fresh
live Google task are not yet verified. No benchmark task was reported or changed;
these causal replays do not claim Google server acceptance or account completion.

At 10,000 agents the fix keeps credentials and quarantine per browser activity.
It reuses inventory within a realm/binding and adds no model call, shared lock,
channel or table. Genuine actions use lightweight browser target identity reads;
only a changing destination needs a second preparation, capped at two attempts.
Unchanged interactions reuse the last inventory in history instead of adding
its full list after every keystroke. Temporary redaction snapshots are per action
and released in finally; secret-ref collisions retain each realm's values.
Discovery remains scoped to the current realm's existing credential rows. A
same-realm browser replacement refreshes once. Encrypted inventory on tagged
failure stays private; tool results contain only formatted metadata and refs.

Independent delegated trace review confirmed the exact boundary and rejected
native-dispatch and model-intelligence theories. The backend candidate received
independent review. Revised-design review required actual destination binding,
reobservation after preparation, explicit unknown discovery, secret projection,
append-only history, and initial/resume plus replacement-session coverage. Final
revised implementation review found two gaps: old-realm redaction coverage could
be lost during callback activation, and automatic autofill bypassed observation.
Both were repaired through the shared action wrapper; permanent regressions
exercise their model/history boundaries. A separate self-review preserved the
existing successful-restoration reload after post-action preparation. Final
owning-suite results are recorded below.

Evidence publisher could not certify a durable share link: this original live
agent has no benchmark run UUID for the tool's share-link contract. The existing
paused production transcript is not labelled a verified terminal benchmark bundle.
The final LLM dump was recovered, rendered under
/opt/cursor/artifacts/rca_evidence/07281fc3-5e49-4cd2-9573-235cb19b0481/last-browser-call.html,
and published as self-contained HTML to R2 with a seven-day HTTPS link.
No ephemeral frontend evidence link is presented as verified terminal proof.

## Human feedback

The user asked why this Google Workspace task received Claude auth options.
In the follow-up, the user suggested loading auth options in navigation responses
and observed that resetting system context could invalidate prompt caching.
Code inspection confirmed the inventory is currently appended to dynamic system
context before the goal and accumulated turns. The static cache boundary can
remain reusable, but changed dynamic system content changes every later prefix.
The user then instructed "fix", authorizing the revised implementation. The
implemented design keeps auth policy in system context and supplies safe,
realm-labelled inventory through actual navigation/page-state tool results,
including redirects and initial/resumed page observations. This supersedes
AUTH-1, the earlier proposal to update auth inventory in system context. The
validated-inventory/error separation is retained. Deployment remains pending
until the repository's current-diff approval boundary is satisfied.

## Reusable lesson

Bind credential context to the current realm independently of restoration success, and expose restoration failure without retaining another site's identity.
