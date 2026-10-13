---
id: 2026-10-12-cookie-bundle-ranking-used-sso-recency
date: 2026-10-12
title: Google bundle ranking used another SSO realm and cookie transfer rewrote session attributes
surface: back-end
component: browser-cookie-injection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cookieSummaryForBundle ranked Google candidates over all SSO realms; injectUserData rewrote SameSite and revived expired cookies
symptoms:
  - Google bundle ranked by another realm: Profile 1
  - expired auth cookies displaced a live bundle
  - SameSite=None became Lax; SameSite=Strict became Lax; expired cookie revived
  - Google accounts displayed signed out before auth_assistance at 04:31 UTC
  - Verify it's you for admin.google.com at 19:48 and 21:12 UTC
tags:
  - google
  - browser-auth
  - cookie-bundle
  - cookie-transfer
  - profile-selection
  - same-site
  - expiry
sources:
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
  - plan:docs/plans/completed/browser-auth-credential-model.md
repro: back-end/src/tests/blackbox/steel-injection.blackbox.ts via steel-injection.cookies.cases.ts
status: open
---

## Problem

The user reported repeated Google authentication requests and explicitly asked
whether session management or cookie transfer was responsible. Three assistance
requests were persisted at 04:31:48, 19:48:35 and 21:12:15 UTC on October 12.
This case separates proven owned defects from unresolved Google server acceptance.

Production evidence was read from the root's 1,567 messages, sixteen persisted
browser-session rows, the encrypted archived startup DB fixture captured at
03:54:18, credential metadata, and filtered Render logs. Private cookie values
were never printed or included in the regression fixtures.

At 04:29:45, 04:30:14 and 04:30:42, logs selected Chrome/Profile 1 and injected
181 cookies. At 04:31:12 the agent observed both remembered Google accounts as
signed out. Its saved-password attempt failed, and assistance followed.

After the user completed login at 19:42, logs recorded successful Google-state
harvests at 19:47:00 and 19:47:02. The next browser selected the Kernel
cloud_persistent bundle and injected 126 cookies at 19:47:17 and 19:47:45.
The Google homepage was authenticated as a@roselabs.ai; Admin subsequently
requested identity verification. A second harvest succeeded at 20:08:51.
At 21:09 through 21:11, initialization loaded that cloud bundle and injected
130 cookies. Gmail remained authenticated immediately before the Admin
password challenge. Verification completed at 19:57; the next assistance was
approximately 75 minutes later.

All sixteen recorded calls used the same persistent Kernel profile with
persistence enabled. A scoped timeline query found one other agent's session,
closed before this root began, and no recorded overlapping sibling writer.
Each initialization retry in the Render trace had a different provider session
ID: these were not repeated writes into one already-navigated browser.

## Diagnosis

Critical path: synced Chrome Cookie rows / restored provider profile ->
CookieBundle selection -> Playwright addCookies -> Google navigation ->
authentication assistance -> close-time cloud CookieBundle harvest -> later init.

Three owned invariants failed locally:

1. Ranking used cookieSelectionWhere, which intentionally includes other SSO
   realms for injection. The startup fixture's Profile 1 GitHub _gh_sess
   creationUtc was 13436249998674776, newer than Default's Google
   PLAY_ACTIVE_ACCOUNT at 13436237732148350. Profile 1's Google ACCOUNT_CHOOSER
   was older, 13435791376488668. Replaying this metadata with synthetic values
   selected Profile 1 because GitHub recency decided the Google source.
2. Selection did not exclude expired auth cookies, allowing a newer expired
   bundle to displace a live candidate.
3. Injection hardcoded SameSite=Lax and discarded an expired cookie's expiry.
   Real local Chromium readback showed None and Strict became Lax and an
   expired persistent cookie was revived as a session cookie. The startup
   Profile 1 corpus contained 73 None and five Strict cookies in the inspected
   Google/GitHub scope, so this was not merely hypothetical attribute input.

The deepest proven owned cause is mixing two contracts: target-realm source
ranking and SSO transport scope, followed by attribute rewriting instead of
faithful cookie transport. Restrict selection to its realm, then carry SSO
state from that single selected profile. This also prevents a newer Microsoft,
GitHub or other SSO cookie from deciding an unrelated site's source.

These proofs do not establish that another Chrome profile would have been
accepted by Google's remote server at 04:31. Unexpired stored cookies do not
prove server-side authentication. Google may require a fresh device/security
challenge even after faithful transfer. Original incident outcome remains open. The existing name heuristic also
omits Google SID/HSID-family names and treats ACCOUNT_CHOOSER /
PLAY_ACTIVE_ACCOUNT as auth-looking rows; target scoping does not prove
that its winner has a usable Google session or the intended account.

The later prompts are consistent with preserved general Google login and
separate Admin verification. Google's primary documentation explicitly states
that Admin sessions last one hour and cannot be changed, and expired sessions
show Verify it's you:
https://knowledge.workspace.google.com/admin/security/set-session-length-for-google-services
This policy plus the 75-minute interval supports that interpretation but is
not an exclusive causal proof for this particular challenge.

Kernel restored-profile precedence is also an open observation: the existing
no-overlay rule is implemented for Steel markers, while Kernel loads and
reinjects a cloud snapshot. No captured before/after native cookie-state
comparison established that this lost authentication on the reported run.
A provider-wide skip would incorrectly break empty-profile bootstrap and
cross-provider restoration, so no such workaround was added.

Archive searches: "Verify it is you Google sign in", "cookies session
persistence profile selection reauthentication", "SameSite Lax Google cookie
injection", and "cookie bundle ranking freshest auth realm". Related cases
include 2026-08-03-steel-marker-starved-fresh-cookie-bundle and stale benchmark
cookie synchronization. Neither has the same first-bad boundary; this is a
relative, not a demonstrated recurrence.

## Solution

Local patch in providers/steel/injection.ts and injectionCookies.ts:
rank using only live target-realm auth rows; retain SSO scope for the chosen
profile; reuse shared SameSite/prefix normalization; discard expired persistent
rows; preserve actual session cookies and secure/HTTP-only flags.

No second profile picker, alternate auth source, recovery loop, schema change,
Google-policy change or production credential write was introduced.
The patch unifies attribute handling with the existing canonical browser-cookie
helpers. Source ranking retains the existing profile-level query pattern with
narrower domain scope and two additional scalar fields. At 10,000 agents it
adds no locks, shared rows, polling, channels or coordination; preprocessing
remains linear in each session's selected cookie rows.

Permanent regressions register three cases in the existing steel-injection
blackbox domain, which back-end/src/tests/blackbox/run.ts discovers and the
/deploy backend coverage gate runs. Exact executed command from back-end:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria TRACE_ARCHIVE_BACKEND=local BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=false BENCHMARK_ANON_STEEL_PROFILE=false node --import tsx src/tests/blackbox/steel-injection.blackbox.ts
```

Before: ten passed, three failed, with the literal assertions in symptoms.
After the patch: thirteen passed, zero failed. No acceptance assertion was
weakened. A pre-existing helper used an expiry in 1632 for a fixture meant to
be injectable; it now explicitly models a session cookie. Recorded before/after
logs are private workspace artifacts, not durable public approval evidence.

Golden references: OpenClaw extensions/browser/src/browser/pw-tools-core.storage.ts:20
passes the supplied cookie attributes to Playwright and validates URL or
host/path binding; system-chrome-cookies.ts:183 maps Chrome expiry and SameSite.
Hermes apps/desktop/electron/remote-session-cookies.ts:81 preserves expiry/deletion
semantics. The repair converges on attribute fidelity. Claude Code's vendored
snapshot and Codex's gateway OAuth cookie-delivery code were searched; neither
provided an equivalent multi-profile Chrome source-ranking mechanism.

Required adversarial RCA review accepted the independent defect claims and
rejected treating them as proof that all three prompts share an owned cause.
The incident stays open pending Google-acceptance/native-state evidence;
deploy verification is recorded separately from the local reproduction.

## Related failed-restoration credential context

A later task on this root started at Claude and navigated to Google Admin.
Target preparation timed out after eighteen seconds; navigation continued,
but the prior Claude inventory and assistance identity remained active.
The separate case `2026-10-13-realm-transition-retained-stale-auth-context`
records that causal boundary. Main PR #1497 preserves already validated target
inventory alongside restoration failure, invalidates unrelated realm identity,
and binds inventory to observed destination pages. It preserves this case's
cookie ranking, expiry and SameSite fixes. It does not establish why that
restoration stalled or whether Google accepted the original transferred state.

The earlier Remote Desktop password attempt is not proven fixed by that repair.
Current references remain ID-bound; the inventory and input guard still use
canonical realm and base-domain scope. Related Google services can legitimately
share SSO, so that permissiveness alone is not a newly proven defect. Correct
service/account selection and compliance with the task's no-guess instruction
remain unproven. The follow-up audit read no credential values.

## Human feedback

The user supplied the earlier preliminary explanation, explicitly noting that
it had no local repro or fix, and redirected the investigation to "session
management or cookie transfers". Do not simply repeat the policy explanation
or equate stored cookie expiry with accepted authentication.

## Reusable lesson

Rank credentials within their authentication realm and preserve cookie attributes while separating transport correctness from server-side session acceptance.
