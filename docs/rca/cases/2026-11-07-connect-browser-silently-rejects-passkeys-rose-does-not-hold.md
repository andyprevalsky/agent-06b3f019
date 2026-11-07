---
id: 2026-11-07-connect-browser-silently-rejects-passkeys-rose-does-not-hold
date: 2026-11-07
title: Compute connect browser rejected a passkey Rose does not hold instantly and invisibly, so "Use passkey" looked dead
surface: cross
component: compute-grants-connect-passkeys
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/domains/compute-grants/cdp.passkeys.ts seedTargetSession — every seeded target gets a CDP virtual authenticator with Chrome's WebAuthn UI off, but nothing observed the ceremonies it could not answer, so the connect poll had no signal to show the user
symptoms:
  - clicking "Use passkey" does nothing on auth.openai.com/mfa-challenge "Verify your identity"
  - "NotAllowedError: The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client."
  - connect.passkeys_seeded injected=1 but navigator.credentials.get rejected in 9ms with no passkey dialog
  - are we loading passkeys correctly when we navigate to new sites mid browser session
  - connect.passkey_unavailable rp_id=openai.com
tags:
  - passkey
  - webauthn
  - virtual-authenticator
  - compute-connect
  - codex
  - silent-failure
  - observability
sources:
  - commit 00e9ca6991adee1483001ae36f54393dab41744d
  - commit 308260b04747e70435eab7b9670a4579b8e2061a
repro: back-end/src/tests/blackbox/compute-connect-passkeys.blackbox.ts
status: fixed
---

## Problem

Connecting an OpenAI/Codex compute credential for user `1f85ff25` (signing in as
`andyprevalsky111@gmail.com`) reached `auth.openai.com/mfa-challenge`, "Verify
your identity — Use passkey". Clicking **Use passkey** did nothing: no dialog,
no error, the page did not change. The user asked whether passkeys were being
loaded when the browser navigates to a new site mid-session.

Runtime evidence:

- Prod Render logs for every connect at 23:18–23:33Z on 2026-11-06 show
  `connect.passkeys_seeded injected=1`; the two codex connects at 23:33:24Z and
  23:33:28Z (`codex-67d9a7dc…`, `codex-df700537…`) never logged
  `connect.completed`. Local live-repro connects: `codex-ecf773fc…` (buggy) and
  `codex-05a80b55…` (fixed). The unfixed source is commit `00e9ca699`.
- Prod `PasskeyCredential` (read-only): the user holds 17 passkeys, all
  `browserSource=apple_passwords` imported 2026-06-25 (google.com x3,
  github.com x2, amazon.com, …). No user in prod holds an `openai.com` or
  `chatgpt.com` passkey, and no row has the credential OpenAI asked for.
- Live repro running the real `startConnectSession('codex')` against a real
  Kernel browser, observed through a second CDP connection with a page probe on
  `navigator.credentials`:
  - With the prod passkey key (virtual authenticator holding google.com and
    github.com credentials, `enableUI:false`), typing the email lands on
    `/mfa-challenge`. The page auto-calls
    `get({rpId:'openai.com', allowCredentials:[CjTY3U3CQrlpoyFX…], userVerification:'required', timeout:600000})`,
    which rejects `NotAllowedError` in 17 ms. The page then reveals "Use
    passkey" (the user's screenshot). Clicking it calls `get()` again: rejected
    `NotAllowedError` in 9 ms, page unchanged.
  - Without a virtual authenticator (local env lacked `PAYMENT_DECRYPTION_KEY`)
    the same request stays pending on Chrome's native path and the button never
    appears, confirming the instant rejection comes from our authenticator.
  - "Try another method" offers Passkey, Authenticator app and Recovery code.

## Diagnosis

Passkey loading across navigation is not the defect. On the real provider
(Kernel), a passkey seeded before navigation survives about:blank →
example.com → auth.openai.com → iana.org → example.com: `WebAuthn.getCredentials`
still lists it and `get()` signs in 3 ms; through the production `seedPasskeys`
client the same cross-site hop signs too. A delegated local-Chromium run showed
the same. The live MFA request also reached our authenticator (it was rejected
by it, not by Chrome's native path). A first Kernel probe that seemed to lose the
credential had omitted `userHandle`; `addCredential` then fails with "The User
Handle is required for Resident Credentials", which `seedTargetSession` does not
check (prod rows all carry a userHandle).

Causal chain:

1. The user's OpenAI account requires a passkey (`rpId openai.com`, credential
   `CjTY3U3C…`) that Rose has never held — it is not in Apple Passwords import
   data or anywhere else in `PasskeyCredential`.
2. The connect flow seeds every page target with a CDP virtual authenticator
   holding the realm + SSO passkeys and turns Chrome's WebAuthn UI off
   (deliberately: the native chooser cannot be dismissed on some providers and
   is not always in the live view).
3. With UI off and no matching credential, Chromium rejects the assertion with
   `NotAllowedError` in 1–49 ms and draws nothing (measured locally: test 1;
   live: 17 ms / 9 ms). OpenAI swallows `NotAllowedError` as a user cancel.
4. The connect CDP layer observed injection and (via the WebAuthn domain)
   successes only; nothing observed a ceremony the authenticator could not
   answer, so the poll and modal had no way to tell the user why the click did
   nothing.

Step 5a ladder: why could this be invisible? Because the layer that suppressed
Chrome's own feedback took on the job of being the only WebAuthn surface but
never reported its failures (rung with evidence: `cdp.passkeys.ts` had no
initiation/outcome capture; CDP's WebAuthn domain emits only
`credentialAsserted`/`credentialAdded`). The next rung — "Rose cannot obtain a
passkey the user created on their own device" — is third-party platform design
(platform passkeys are non-exportable), so the deepest owned cause is the
missing observation. Same class as
`2026-08-03-amazon-passkey-use-boundary-unobserved` (agents path); this is a
relative on the backend connect surface, not a recurrence.

Local repro (unchanged file, both sides):
`cd back-end && env -u FLY_APP_NAME node --import tsx src/tests/blackbox/compute-connect-passkeys.blackbox.ts`
— on the unfixed source: `FAIL a passkey Rose does not hold is reported instead
of failing silently — Use passkey was rejected in 6/9ms with no UI, but the
connect poll did not name the relying party`; on the fix: `RESULTS: 3/3 passed`.

## Solution

`cdp.passkeyCeremonies.ts` (new): every seeded target also gets a page-side
observer (`Page.addScriptToEvaluateOnNewDocument` + immediate evaluate) carrying
the seeded rpIds. On a document whose host Rose holds passkeys for
(accounts.google.com, github.com) it does nothing, so SSO sign-in stays on
native code. Elsewhere it wraps `CredentialsContainer.prototype.get`, returns the
page's own promise, and records the rpId of each user-initiated
(non-conditional) assertion for an unheld rpId that rejects `NotAllowedError`.
The existing 2 s sign-in watcher tick reads the main page's record through its
existing CDP session (`syncPasskeyCeremonies`, no new sessions) and sets
`passkeyUnavailableFor`, logged once as
`connect.passkey_unavailable rp_id=… held_rp_ids=[…]`. It stays set for the rest
of the connect, because switching methods does not make Rose hold the passkey.
The poll returns `passkeyUnavailableFor` and the connect modal shows: "Rose
doesn't have your openai.com passkey, so the passkey prompt can't finish here.
Pick another verification method in the window above, or import this passkey
from Apple Passwords & Passkeys."

A CDP binding was tried first and rejected: `Runtime.addBinding` only works
while `Runtime.enable` is on (it is removed by `Runtime.disable`), and an enabled
Runtime domain is a well-known automation fingerprint on exactly these login
pages. The passkey seeding and auto-attach code moved from `cdp.ts` into
`cdp.passkeys.ts` (`createConnectPasskeys`) to keep `attachCdp` within limits.

Live verification on the final code: poll
`{"state":"pending","stage":"awaiting_human",…,"passkeyUnavailableFor":"openai.com"}`
about 220 ms after OpenAI's automatic `get()` was rejected. The blackbox passed
5 consecutive runs.

Known limits: records live per document and only the main tab is read, so a
rejection in a popup for an unheld relying party, or one followed by a redirect
inside the 2 s tick, is not reported. Pages on a held host are never patched, so
a held rpId asking for a credential Rose lacks is not reported either.

Siblings prevented: a Claude or other provider relying party asking for a
passkey Rose does not hold now explains itself instead of failing silently.
10k-agent behavior: per connect session only (human-paced, one browser); one
extra `Runtime.evaluate` on an existing session per 2 s tick, no new channels,
rows, subscriptions or CDP sessions.

Remaining (not code): this account can only pass OpenAI MFA here with its
authenticator app or recovery code, or after an `openai.com` passkey is
imported into Rose. Follow-ups: `seedTargetSession` ignores `addCredential`
errors; and a passkey a site registers inside the connect browser (`create()`
succeeds silently; CDP emits `WebAuthn.credentialAdded` with the private key) is
discarded when the browser is released.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user suspected passkeys were not reloaded after mid-session navigation and
asked for testing with `andyprevalsky111@gmail.com`; the evidence disproved the
navigation hypothesis. No fix shape was corrected or rejected.

## Reusable lesson

Whenever Rose suppresses a browser's native UI for a capability (WebAuthn, dialogs), it must observe and surface the failures that UI would have shown, or the user sees a dead button.
