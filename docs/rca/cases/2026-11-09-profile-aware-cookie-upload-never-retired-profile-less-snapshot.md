---
id: 2026-11-09-profile-aware-cookie-upload-never-retired-profile-less-snapshot
date: 2026-11-09
title: Profile-aware Chrome cookie uploads never retired the old profile-less snapshot, so a six-month-old OpenTable session cookie read as a live login
surface: back-end
component: integrations-cookie-snapshot-upload
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/domains/integrations/uploadService.browser.ts upsertCookieBatches — snapshot replacement (deleteCookiesMissingFromProfileSnapshot, deleteOrphanedCookieBundles) covered only the profiles present in the upload, so once the Mac app tagged every Chrome cookie with its profile, the source's earlier profile-less ('') snapshot was never replaced or removed
symptoms:
  - "[Steel]   Cookies: none, Fingerprint: no"
  - "\"cookie_source\": \"none\", \"cookies_injected\": false"
  - "integrations show OpenTable as authenticated but the browser agent is signed out"
  - "ha_userSession www.opentable.com expiresUtc 0 browserProfile ''"
  - "expected the profile-less chrome snapshot to be retired once Chrome uploads by profile"
tags:
  - browser-auth
  - cookies
  - cookie-bundle
  - snapshot-upload
  - mac-app
  - opentable
  - browser-opentable-reservation
sources:
  - task browser-opentable-reservation
  - benchmark run descend-failed-neverrun-20261106 epochs 4 and 18 (cluster H-06)
  - commit f5b2564ef4 (related unmerged H-05i discovery fix; also be13be8a36, c6236d0ebc)
repro: back-end/src/tests/blackbox/browser-credential-sync.profile-snapshot.cases.ts › profile-aware chrome upload retires the superseded profile-less snapshot
status: mitigated
---

## Problem

Andy's integrations listed OpenTable as authenticated, and the planner told
browser agents he was logged in. Every `browser-opentable-reservation` session
started with `[Steel] Cookies: none` / `cookie_source: none, cookies_injected:
false` and then looped on sign-in until the 600 s timeout. The report was that
injection ignored a live OpenTable login cookie that Andy had.

Read-only production queries (`SET TRANSACTION READ ONLY`; names, flags and
value hashes only) found that Rose holds no live OpenTable login cookie for
this user in any browser profile:

- Chrome `Profile 1`, the only current profile with opentable.com cookies:
  `_abck`, `bm_s`, `OptanonConsent`, `otuvid`. These are bot-manager, consent
  and anonymous visitor cookies. Its CookieBundle (147c5171…) is enabled, but
  injection rightly skips it because no cookie in it is auth-named.
- Chrome profile `''`, from a 2026-05-03 upload by the pre-profile Mac app,
  holds 23 opentable.com rows. The auth-named ones are `OT-SessionId`,
  `OT-Interactive-SessionId` and `OT-Session-Update-Date`, all expired at
  2026-05-03 01:38, plus `ha_userSession` on www.opentable.com. That cookie
  is a browser-session cookie (`hasExpires=false`, `expiresUtc=0`,
  `isPersistent=false`). It was created at 01:06:17, the same second as the
  anonymous `otuvid` visitor id and `OT-SessionId`, so it is a first-page-view
  session, not a sign-in. No CookieBundle exists for chrome/'' in this account.
- No `authCke`/`uCke`-style rows exist in any profile. No SteelSessionAuth or
  BrowserSiteState row exists for opentable.com. OpenTable localStorage key
  names (`ak_a`, `ak_ax`, `GULP_SC2`, ad tags) carry no user state. No other
  production user has opentable.com cookies.

On main, `getAuthenticatedDomains` counts any auth-named cookie with
`expiresUtc <= 0` as live, in any profile, with no bundle. So this
six-month-old session cookie made OpenTable read as "authenticated".

## Diagnosis

Critical path: Chrome cookie DB → Mac `readBrowserCookies` (every profile
path, each cookie tagged with its profile) → `POST
/api/integrations/cookies/upload` → `processCookiesUpload` /
`upsertCookieBatches` (Cookie rows + CookieBundle per realm×profile) →
`getAuthenticatedDomains` (integrations UI, planner "Authenticated Browser
Sessions") and `resolveBrowserAuthCredentialSource` (Steel injection).

1. Injection (`selectTopCookieBundle`) behaves correctly. Profile 1's bundle
   has no auth-named cookie, and the profile-less rows have no bundle, so it
   returns `none`. That matches what the browser actually holds.
2. The first bad data is in the Cookie store. Andy's chrome/'' rows (6,234
   cookies) were last written on 2026-05-29. Per-profile Chrome rows begin
   on 2026-10-26. Since then every upload has been a complete per-profile
   snapshot of Chrome, but `upsertCookieBatches` deletes missing cookies and
   orphaned bundles only for profiles present in the upload. The '' identity
   is never present again, so its rows stay forever, and a session cookie with
   `expiresUtc=0` stays "live" forever.
3. Why that was possible: snapshot replacement is deliberately scoped per
   profile (the existing test keeps `Profile 1` when an upload carries only
   `Default`). No rule covered the uploader's change from profile-less to
   profile-aware, although '' means only "uploader could not tell profiles
   apart". Stop: wider named-profile retirement would contradict that tested
   isolation contract.

Impact beyond OpenTable (read-only production, 2026-11-09):
- On Andy's account, 65 realms have live auth-named cookies only in the
  superseded '' snapshot, including 78 never-expiring session cookies (for
  example adobe.com, airtable.com, apple.com, canva.com, etsy.com,
  expedia.com). Main advertises all of them while injection can use none.
- One other user (43c2f6ae…) has 146 superseded '' chrome rows and 37 enabled
  '' bundles. None is currently injectable.
- The same gap lets an enabled '' bundle win injection with stale cookies. The
  local repro shows `resolveBrowserAuthCredentialSource` returning
  `cookie_bundle` with browserProfile '' on the buggy code.

The `2026-11-06-authenticated-domains-advertised-uninjectable-realm` fix
(unmerged) makes discovery agree with injection. That is a separate, still
needed contract fix: it stops the false claim, but it leaves the stale rows
in the store.

Local repro, red on origin/main 350bd8a0c3 with only the test added:
`cd back-end && env -u FLY_APP_NAME DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca-opentable-cookie DIRECT_URL=<same> npx tsx src/tests/blackbox/browser-credential-sync.blackbox.ts`
→ `FAIL profile-aware chrome upload retires the superseded profile-less snapshot`,
`Error: expected the profile-less chrome snapshot to be retired once Chrome uploads by profile, still stored: www.opentable.com/ha_userSession, .opentable.com/OT-SessionId, .opentable.com/otuvid`
(9 passed, 1 failed). The test replays the production shapes through two real
`processCookiesUpload` calls: the pre-profile upload, then the current Profile
1 jar. A scratch chain check on the same code showed opentable.com advertised
with injection `cookie_bundle` from profile ''. With Andy's exact
no-'' -bundle shape, injection returned `none` while discovery still
advertised the realm.

## Solution

Branch `rca/opentable-cookie-injection-20261108`. `upsertCookieBatches` now
replaces `replacedProfileSnapshots(groupByProfile(...))`: every uploaded
profile, plus the profile-less '' snapshot (as empty) once an upload names its
profiles and carries no '' rows. The existing per-profile delete and
orphan-bundle cleanup then retire the superseded rows and bundles. Named
profiles stay isolated from one another. Uploads that are themselves
profile-less (Safari, Arc, older apps) are unchanged.

Same command after the fix: 10 passed, 0 failed, five consecutive runs. The
chain check shows opentable.com no longer advertised and injection `none`. The
positive control (a live auth-named cookie in current Profile 1) is
advertised and injected from the Profile 1 bundle, both before and after.

Sibling prevented: an enabled profile-less bundle no longer outranks or stands
in for the current profile, so injection cannot select stale cookies.

10k agents: one extra indexed DELETE per profile-aware upload, scoped to
(userId, browserSource, ''). It deletes nothing in steady state. There is no
per-agent work, polling or fan-in.

Production effect when deployed: on each user's next Chrome upload, the
superseded '' rows and bundles are deleted (Andy 6,234 rows; 43c2f6ae… 146
rows and 37 bundles). The planner's authenticated-domain list for Andy loses
those 65 realms. That changes model-visible context, though no prompt text
changes. It needs Andy's sign-off before deploy. Golden reference: not
applicable (no approval-gated hunk).

Status stays mitigated: the exact benchmark was not run, per instruction (no
benchmark launches). It still cannot pass signed in, because Rose holds no
OpenTable login for this user. Andy must sign in to OpenTable in a synced
Chrome profile, or the browser template, before injection has anything to
inject.

## Human feedback

Andy asked why injection does not pick up an OpenTable cookie he really has,
the opposite of the advertisement-only H-05i fix. He wants injection to work
whenever he has the cookie. Evidence shows no live OpenTable login cookie in
Rose's data. The positive control cements that a current-profile login cookie
is injected.

## Reusable lesson

When a snapshot uploader changes its identity scheme (here profile-less to
per-profile), retire the old identity's rows explicitly; otherwise stale rows,
especially never-expiring session cookies, look like live credentials forever.
