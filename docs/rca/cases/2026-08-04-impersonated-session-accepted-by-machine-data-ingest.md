---
id: 2026-08-04-impersonated-session-accepted-by-machine-data-ingest
date: 2026-08-04
title: Machine-data ingest routes accepted an impersonated session, writing the operator's cookies, passwords and iMessage into the viewed user's account
surface: back-end
component: integrations-upload-auth
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "both JWT verifiers (providers/auth.ts authenticate() and providers/hybridAuth.ts handleJwtAuth()) verified the token but discarded the RFC 8693 `act` claim, so every downstream route saw an impersonated session as an ordinary login"
symptoms:
  - "why does tamy's account have MY account credentials synced to it"
  - "POST /api/integrations/cookies/upload returns 200 for an impersonated session"
  - another user's account contains this machine's Chrome/Safari/Atlas cookies and browser passwords
  - "[IntegrationCache] Fetched 8 integrations where 8 is the VICTIM's integration count"
  - per-browserSource/browserProfile cookie counts match exactly across two different userIds
tags:
  - impersonation
  - admin
  - cross-account-corruption
  - credential-leak
  - mac-app-sync
  - client-side-guard
sources:
  - commit 969438227
  - commit 86579226c
  - commit 25036952f
repro: back-end/src/tests/blackbox/integrations.blackbox.ts — "machine-data ingest rejects an impersonated session (all routes)" (24 routes)
status: fixed
---

## Problem

While an admin was switched into another account, the mac-app kept syncing THIS
machine's data into that account. Confirmed in prod on 2026-08-04 and still
actively writing during the investigation.

Evidence, in the order it was gathered:

- Per-`browserSource`/`browserProfile` cookie counts under the victim
  (`43c2f6ae-…`) matched the operator's machine exactly — atlas 4657,
  chrome/Default 3682, chrome/Profile 2 1927, safari 92, chrome/Profile 3 28.
- `~/Library/Application Support/Rose/mac-app-console-logs.log` at
  `16:43:40Z`: `[IMessageReader] Checking access to:
  /Users/andyprevalsky/Library/Messages/chat.db` → upload → the VICTIM's
  `imessage` integration `lastSyncAt = 16:43:40.874`.
- `[BrowserCookieReader] Read 4657 ChatGPT Atlas cookies` / `92 Safari cookies`
  off the operator's disk; the victim's account held exactly 4657 and 92.
- `[IntegrationCache] Fetched 8 integrations` — the victim has 8, the operator 18.
- `rose-impersonation` in the app's `Local Storage/leveldb` named the victim.

Blast radius: victim A held 6591 high-entropy cookies and 552 browser passwords
byte-identical to the operator's (including `appleid.apple.com`,
`idmsa.apple.com`, `coinbase.com` under `andyprevalsky@yahoo.com`), 13 of the
operator's iMessage contacts and 277 messages. Victim B (`9df6fecb-…`) held 552
passwords and 2579 localStorage origins. An orphaned userId (`5e671ed6-…`, no
`User` row) held a further 552.

## Diagnosis

`authenticate()` verified the JWT and set `req.user = { id: payload.sub, … }`,
dropping `payload.act`. The backend mints that claim in
`providers/sessionTokens.ts` precisely to mark impersonation — and then never
read it anywhere. So an impersonated session was indistinguishable from the
account holder's own at every route. Proved locally: 13/13 of the initially
enumerated ingest endpoints returned non-403, with `/cookies/upload` returning
`200 {"cookieCount":1}` and persisting the row. Adversarial review then found 11
more routes in the same class, for 24 total.

Step 5a ladder:

1. *Why did the operator's data land in the victim's account?* The mac-app
   authenticates as the current session; while impersonating that is the victim.
2. *Why did the backend store it?* No ingest route checked `act`. Evidence:
   grepping `act.sub` / `impersonated_by` across the tree returned only the
   minting site in `providers/sessionTokens.ts`.
3. *Why was the client-side guard not enough?* It shipped in mac-app **v1.1.124**
   (2026-08-03) but the machine was running **v1.1.121**; every tag ≤ v1.1.123
   contains 0/3 of the guard commits. A guard that lives only in the client is
   only as good as the installed build, and desktop builds lag main by days.

4. *Why did the first attempt at a server-side fix still leave holes?* The repo
   has TWO independent JWT verifiers — `providers/auth.ts` and
   `providers/hybridAuth.ts` — with no invariant that they agree on identity
   semantics. Fixing only the first left every `hybridAuth` route blind, and
   worse, made `rejectImpersonatedUpload` **fail open** behind it (it read a
   field `hybridAuth` never set). Evidence: `hybridAuth.ts:178-191` set
   `req.user` from `payload.sub` with no `act` read.

Rung 4 is the deepest owned cause: two decode sites for one security-relevant
claim, with nothing forcing them to agree. That is what the fix targets. Stopping
there — the next "why" is release cadence, a process fact, not a code defect.

**Process failure worth recording:** the first pass scoped its grep to
`src/middleware`, a directory that does not exist in this repo (the path was
copied from a stale line in `CLAUDE.md`, now corrected). A grep of a
non-existent path returns success with no output and reads as "nothing found",
which is precisely how an entire authentication path went unexamined. That
stale line has been fixed so the next reader is not misled the same way.

## Solution

Containment moved to the write boundary:

- `providers/supabaseJwt.ts` owns the single `act` extraction
  (`impersonatorFromPayload`). BOTH `auth.ts` and `hybridAuth.ts` now derive
  `user.impersonatedBy` from it, so the two verifiers cannot drift again.
- `rejectImpersonatedUpload` returns 403 before any payload parsing, and **fails
  closed**: no resolved identity (and not an internal API-key caller) is refused
  rather than waved through, so a mis-ordered chain cannot silently uncontain.
- `authenticateMachineUpload = [authenticate, rejectImpersonatedUpload]` replaces
  bare `authenticate` on 24 machine-data ingest routes, so a route cannot acquire
  authentication without containment. Beyond `/api/integrations/*` this now
  covers `POST /api/upload`, `POST /api/download-telemetry`,
  `/telegram/connect`, and the iMessage relay claim path
  (`GET /api/imessage/queue/pop`, `POST /api/imessage/queue/:id/result`) — the
  last of which would otherwise let an operator's Mac register itself as the
  viewed user's iMessage bridge and send as them.
- `src/tests/structural/machine-upload-containment.test.ts` walks ALL of
  `src/domains` (not one directory), tokenizes the middleware chain rather than
  substring-matching it, and fails the build on: a bare-`authenticate` ingest
  route, an undeclared new `*upload*` route in any domain, either verifier
  dropping the `act` claim, or the guard ceasing to fail closed. Each of those
  four was verified to fail by reverting the corresponding line.

Sibling failures this also prevents: the same leak via any other stale or
third-party client, via a replayed impersonated token, via the `hybridAuth` route
family, and via any future upload endpoint added by someone unaware of
impersonation.

Known limits, stated rather than implied: routes where operating as the user is
the *point* of impersonation (agent creation, billing, SMS send, API-key
minting) are deliberately NOT blocked here. `POST /api/api-keys` is worth a
separate decision — an operator can mint a key for the viewed user that outlives
the 1-hour impersonation token.

10k-agent behavior: the check is a synchronous field read on an already-decoded
JWT payload — no I/O, no shared state, no per-agent growth. Cost is O(1) per
request and unchanged in aggregate.

Prod remediation: `scripts/backup-impersonation-contaminated-account.sh` (full
CSV snapshot first) then `scripts/restore-impersonation-contaminated-account.sql`.
The script takes a `cookie_scope` because attribution differs per victim — victim
A's own client wrote Chrome with an EMPTY `browserProfile`, so the operator's
named-profile buckets were wholly his (`operator-buckets`); victim B ran her own
Mac with the SAME profile names, so only byte-identical values could be removed
(`content-match`). Using the wrong mode would delete the victim's own data.
Verified after: all eight residual checks (cookies, passwords, localStorage,
IndexedDB, cacheStorage, permissions, cookie bundles, shared contacts) return 0
for both remediated accounts, and the only accounts still holding the operator's
data are his own. All 131 deleted rows that did not byte-match his current
snapshot were proven to have been created during his browsing window that day.

Two residual caveats the script cannot escape: `operator_browser_buckets` is
seeded from the operator's CURRENT snapshot, so a browser he has since stopped
syncing would not be recognised as his; and the `Person` deletion keys on
`createdAt >= :sync_start` plus a shared handle, so a contact the victim
independently acquired in that window and shares with the operator would be
removed. Both were checked by hand for these accounts.

## Human feedback

The user asked for the data to be restored *and* for the sync to be paused during
impersonation, and noted they had already asked for this once — the earlier fix
had been written and merged but never reached a released build, which is what
made the client-only guard placement the real finding. They also asked that the
fix guarantee "WE CAN ONLY SYNC FOR THE CORRECT ACCOUNTS", which is why the guard
was applied as a composed auth middleware plus an enumeration-drift structural
test rather than a per-route check.

One correction to the user's framing, surfaced rather than acted on silently:
the victim's data was mostly **not** clobbered. The operator's rows were additive
under different unique keys, so removing them restored the account; only the
`(userId, origin)`-keyed tables (LocalStorage/IndexedDB/CacheStorage/Permission)
could have overwritten victim rows in place, and those originals are recoverable
only from a database backup.

## Reusable lesson

Put identity containment at the boundary that performs the write and derive the
identity claim in exactly ONE place — a client-side guard protects nobody until
every installed build has it, and a second auth middleware that skips the claim
makes the server-side guard fail open.
