# Browser Auth Credential Model

## Goal

Give the browser agent a coherent view of the user's credentials **for the one site it's spawned for** so it can: pick the cheapest viable auth method, handle multi-account, and escalate to the user only when all automated options exhaust. Propagate outcomes back to the data model after each run.

Ship-shaped. 0 users → destructive migration is fine. Aggressive scope cuts.

## Scope buckets

Six work surfaces. Each maps to sections below.

| # | Scope | Sections |
|---|---|---|
| 1 | **Data model** — new tables + column additions | Data model |
| 2 | **Mac-app sync** — browserProfile threading, snapshot-replace, CookieBundle upsert | Mac-app changes |
| 3 | **Credential read + injection** — auth-options resolver, Steel-precedence injection, Steel expiry/flush | Flow A, Flow B |
| 4 | **Browser agent runtime** — prompt update, OTP channel swap, credential-ref logging, new tools | Flow A, C, D |
| 5 | **End-of-run hook** — post-run DB update, failure classifier, idempotency | Flow E |
| 6 | **User-assistance blocking flow** — write-lock-style pause/resume, live-view handoff | Flow D |

## Decisions locked

1. **Single-realm scope** — auth options shown to a browser agent are only for the site it was spawned for.
2. **Password encryption preserved** — existing `pwd:<ref>` mechanic stays; plaintext never enters prompt or logs.
3. **No cookie rotation in V1** — failed cookie_bundle falls through to password tier in same session. (If ever added: session-restart, never CDP cookie-swap — see Flow B.)
4. **Liveness is a binary `disabledAt`** — set on failure, cleared on fresh sync or later success. No fail-count, no DEAD threshold.
5. **Selection never hard-filters** — always hand over *some* credential if one exists; `disabledAt` only deprioritizes.
6. **Steel context precedence** — a live authenticated Steel context for the realm beats injecting scraped cookies. Injection is reconcile-not-replace.
7. **Steel session flush** — if a Steel context's auth fails on use, flush it; fall through to cookie injection.
8. **Email OTP** — re-route the existing fetch pipe to inject OTPs as user-role messages with dedupe state. No prompt cache-busting.
9. **`request_user_assistance_for_authentication`** — real blocking tool reusing the write-lock pause/resume machinery. V1 mechanism is the Steel live-view handoff.
10. **Passkey-via-QR in a Steel session is UNVERIFIED** — must be settled by an e2e test (see Flow D), not assumed. The hybrid flow's data transport is a cloud tunnel; whether it completes for a datacenter browser + a remote phone is unknown until tested. If it works, it's a first-class V1 path; if not, the local-browser auth step is the post-V1 fallback.
11. **Minted account** — used only when zero user credentials exist for the realm.
12. **SSO** — skipped entirely.
13. **Back-prop via post-run hook** — reads existing Message rows + Agent.status; no per-call outcome tool, no separate diagnostic table.
14. **Failure classifier** — `rose-1-lite` on failed runs only, text-only last-10-messages.
15. **Auth-realm canonicalization** — hardcoded map in code (`*.amazon.com → amazon.com` except `aws.amazon.com`, passthrough otherwise).
16. **No passkey table** — passkeys are unexportable; nothing to store.

## Architecture

```
                       ┌──────────────────────────────────────────────┐
  mac-app ──scrape──▶  │                  backend                     │
                       │  CookieBundle / BrowserPassword /            │
                       │  EmailIntegrationCredential / MintedAccount /│
                       │  SteelSessionAuth / AgentIdentity            │
                       └──────────────────────────────────────────────┘
                                          ▲    │
          ┌── Flow A: auth_options read ──┘    │
          │   Flow E: outcome write-back ─────┘
   ┌──────┴──────────┐
   │  browser agent  │ ── Flow B: in-session tier ladder + Steel precedence
   │  (Temporal)     │ ── Flow C: email OTP delivery
   │                 │ ── Flow D: user-assistance escalation (blocking)
   └─────────────────┘
```

---

## Data model

Additive + destructive migration (0 users).

### New: `CookieBundle`

Aggregation row for cookie piles. Liveness = `disabledAt IS NULL`, computed, not a stored enum.

```prisma
model CookieBundle {
  id              String   @id @default(uuid())
  userId          String
  authRealm       String
  browserSource   String
  browserProfile  String?
  accountLabel    String?
  disabledAt      DateTime?
  disabledReason  String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user            User     @relation(fields: [userId], references: [id])

  @@unique([userId, authRealm, browserSource, browserProfile])
  @@index([userId, authRealm])
}
```

### New: `SteelSessionAuth`

Records that a Steel context holds working auth for a realm — written when a login completes inside a Steel session (agent email-OTP, or user live-view sign-in). Lets the resolver rank it above cookie_bundles. `disabledAt` set on flush.

```prisma
model SteelSessionAuth {
  id               String   @id @default(uuid())
  userId           String
  contextId        String              // the persistent Steel context
  authRealm        String
  authenticatedAt  DateTime @default(now())
  disabledAt       DateTime?           // set when flushed (auth failed on use)
  disabledReason   String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  user             User     @relation(fields: [userId], references: [id])
  @@unique([userId, contextId, authRealm])
}
```

### New: `MintedAccount`

```prisma
model MintedAccount {
  id              String   @id @default(uuid())
  userId          String
  authRealm       String
  accountLabel    String              // sub-addressed agent email used to mint
  disabledAt      DateTime?
  disabledReason  String?
  createdAt       DateTime @default(now())

  user            User     @relation(fields: [userId], references: [id])
  @@unique([userId, authRealm])
}
```

### New: `AgentIdentity`

One per user. Paired agent-email (sub-addressable); phone is future.

```prisma
model AgentIdentity {
  id        String   @id @default(uuid())
  userId    String   @unique
  email     String
  phone     String?
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id])
}
```

### New: `UserAuthAssistanceRequest`

Backing row for the blocking user-assistance flow (Flow D). The "Authentication Complete" button flips `completedAt`.

```prisma
model UserAuthAssistanceRequest {
  id             String   @id @default(uuid())
  agentId        String
  userId         String
  authRealm      String
  steelSessionId String              // live-view link target
  mode           String              // "live_view" | "local_browser"
  createdAt      DateTime @default(now())
  completedAt    DateTime?

  user           User     @relation(fields: [userId], references: [id])
  @@index([agentId])
}
```

### New: `AgentRunCredentialPropagation`

Idempotency marker for the post-run hook (Flow E). Write-once on `agentId`.

```prisma
model AgentRunCredentialPropagation {
  agentId    String   @id
  createdAt  DateTime @default(now())
}
```

### Changed: `Cookie`

```prisma
model Cookie {
  // ... existing fields ...
  browserProfile  String?
}
```

### Changed: `BrowserPassword`

```prisma
model BrowserPassword {
  // ... existing fields ...
  browserProfile  String?
  disabledAt      DateTime?
  disabledReason  String?
}
```

### Unchanged

`EmailIntegrationCredential` — already has `lastUsedAt` and the right shape.

### Explicitly NOT in the model

- `Identity` parent table (premature unification).
- `liveness` enum / `failCountSinceSuccess` (binary `disabledAt` instead).
- SSO edge (skipped).
- Passkey table (passkeys are unexportable; nothing to store).
- `AuthAttempt` log table (Message rows suffice).

---

## Flow A: Credential read (`auth_options` lookup)

**Trigger:** Browser agent spawn for `realm`. Backend assembles options scoped to that one realm.

### Backend

New endpoint: `GET /api/auth-options?realm=<domain>`. Single-realm response:

```json
{
  "realm": "amazon.com",
  "steel_session": { "contextId": "...", "authenticatedAt": "...", "disabled": false },
  "cookie_bundles": [
    { "id": "...", "browserSource": "chrome", "browserProfile": "Default",
      "accountLabel": "andy@gmail.com", "disabled": false,
      "freshestCookieUtc": 1234567890 }
  ],
  "passwords": [
    { "id": "...", "username": "andy@gmail.com", "ref": "pwd:andy@gmail.com",
      "disabled": false, "dateLastUsed": 123456789 }
  ],
  "email_otp": {
    "available": true,
    "connected_emails": ["andy@gmail.com"],
    "match_for_site_account": "andy@gmail.com"
  },
  "minted": null
}
```

Rules:
- **Ranking within cookie_bundles:** `ORDER BY (disabledAt IS NULL) DESC, freshestCookieUtc DESC`. `freshestCookieUtc` = `MAX(cookie.creationUtc)` for cookies in this realm + profile (subquery — Cookie has no FK to CookieBundle). A fresh login mints a new session cookie → newest `creationUtc` = most-recently-authenticated profile.
- **`updatedAt` is NOT a ranking signal** — continuous sync keeps every bundle's `updatedAt` ~now, so it carries zero information.
- **Never hard-filter on `disabled`** — always return all bundles; `disabled` only deprioritizes. "Always get SOME cookie if one exists."
- **`minted` is non-null only when** `cookie_bundles=[]` AND `passwords=[]` AND `email_otp.available=false`.

### Agent prompt (single-realm scoped)

Replaces `build_passwords_prompt_section`; removes `fetch_recent_otps` prompt-inlining.

**Static (cacheable):** an "# Authentication" section explaining the four credential kinds, the priority ladder (cookie/Steel → password → email_otp → minted), multi-account selection (task hint → accountLabel → freshest), `set_account_label` discovery, the rule that the agent does not classify failures, and when to call `request_user_assistance_for_authentication`.

**Dynamic per-spawn (single realm):** the `# Auth options for <realm>` block listing this realm's cookie_bundles, passwords (with `pwd:<ref>`), email_otp capability, and minted availability.

### Tests

Blackbox — `back-end/src/tests/blackbox/auth-options.blackbox.ts`:
- Single-realm scoping (no other-realm data leaks).
- Multi-account: Chrome/Default + Chrome/Profile1 → two CookieBundle rows.
- Multi-source password dedup: same `(origin, username)` → one row.
- Ranking: enabled-before-disabled, then `freshestCookieUtc DESC`.
- `disabled` bundles still returned (never filtered).
- `minted` only when all other categories empty.

**E2E validation — `e2e_auth_options_scoped`** (`agents/tests/e2e/run_e2e_tests.py`): seed credentials for two realms, spawn a real browser agent for one, assert it receives only that realm's scoped auth_options and the prompt reflects them.

---

## Flow B: In-session auth tier ladder + Steel precedence

**Trigger:** Browser agent session start, then auth-gated actions.

### Injection: reconcile-not-replace

The persistent Steel context accumulates auth across runs. Blind-injecting scraped cookies would regress it. At session start, for the target realm:

```
1. Does the Steel context already hold unexpired auth cookies for the realm?
   → YES: use them, inject NOTHING.
2. NO → inject the top-ranked CookieBundle (enabled-first, freshest-cookie).
```

Pick one source wholesale per realm — never merge a Steel session cookie with a scraped CSRF cookie (mismatched tokens = broken auth). Today's injection (`browser-session/routes.ts:60`, "Automatically injects user's stored Chrome cookies") blind-overwrites — that's the change.

### Steel session expiry + flush

"Expired" has two meanings:
- **Steel context alive (Steel TTL):** Steel API answers this directly.
- **Auth inside the context valid:** unknowable until used — same as cookies.

So: try the Steel session; if the site shows logged-out, **flush** — clear the context's cookies for the realm (or reset the context if Steel's API lacks per-realm clearing — verification item), set `SteelSessionAuth.disabledAt`. Injection then falls through to the scraped CookieBundle.

### In-session ladder

- **Cookies / Steel session** — applied at session start (above). The agent doesn't "invoke" them; it just finds itself logged in or not.
- **Passwords** — typed via `pwd:<ref>`, resolved/decrypted at `service_actions.py:906-923`. Preserved unchanged.
- **No cookie rotation** in V1. A failed cookie_bundle falls through to the password tier *in the same session*.

  If rotation is ever added: **session-restart (Option A), never CDP cookie-swap (Option B).**

  | | A: session restart | B: CDP cookie-swap + reload |
  |---|---|---|
  | Cost | 5–30s | 1–2s |
  | Bot-detection | ~zero (fresh fingerprint) | **Real** — mid-session identity flip is the credential-stuffing signature; anti-bot stacks flag it |

### New tool: `set_account_label(cookie_bundle_id, label)`

Single UPDATE on `CookieBundle.accountLabel`. Called once when the agent observes the account on an authenticated page.

### Tests

Blackbox — `agents/tests/blackbox/`:
- Steel context with live auth → no cookie injection.
- Steel context empty → top-ranked cookie_bundle injected.
- Steel auth fails on use → `SteelSessionAuth.disabledAt` set, falls through.
- Cookie fails → falls through to password in same session, no second cookie_bundle tried.
- `set_account_label` fires once on authenticated page.

**E2E validation:**
- **`e2e_steel_precedence`** — seed a Steel context with prior auth + a CookieBundle; spawn a real agent; assert it uses the Steel session and injects nothing.
- **`e2e_cookie_fallthrough`** — empty Steel context + a real CookieBundle for a live login; assert the agent lands authenticated on a real site, then `set_account_label` writes the discovered account.

---

## Flow C: Email OTP delivery (channel swap)

**Trigger:** Site sends OTP to a connected email after the agent requests it.

### What stays

The whole pipe exists: `otpExtractor.ts` + `gmailParser.ts` (extraction), `service_crypto.py:295-341` `fetch_recent_otps` (HTTP fetch), per-iteration call at `handler.py:870-905`.

### What changes — delivery channel only

Today: `handler.py:877-905` appends the OTP block to `custom_instructions` → mutates system prompt every turn → cache-buster.

After:
1. Refactor `fetch_recent_otps` to return `list[ExtractedOTP]` (structured), not a formatted string.
2. In `handler.py`, maintain `seen_otp_codes: set[str]` across iterations of one spawn.
3. Each iteration, for any code not yet seen, **append a user-role message** to the conversation rather than mutating `custom_instructions`.
4. `custom_instructions` stops changing per-turn → stable system prompt → cache works.
5. `formatOTPsForPrompt` (`otpExtractor.ts:201-223`) becomes dead code; grep for callers, delete if none.

### Tests

Blackbox — `agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py`:
- OTPs appear as user-role messages, not in `custom_instructions`.
- Dedupe: same code fetched twice → injected once.
- System prompt stable across turns when no new OTP arrives.

**E2E validation — `e2e_email_otp_user_message`**: spawn a real browser agent on a site that emails an OTP to a connected inbox; assert the OTP arrives as a user-role message and the agent completes the login with it.

---

## Flow D: User-assistance escalation (blocking)

**Trigger:** Browser agent has exhausted every automated auth option.

### New tool: `request_user_assistance_for_authentication`

Description (agent-facing):

```
Use this tool when you have exhausted all authentication options in your
current session and need the user to sign in for you. Before calling, you
must have tried:
  1. Every password available for this site.
  2. Email OTP login, if a connected email is available for this site.
  3. Your minted agent account, for sites that require signup.
  4. Guest / anonymous completion, if the task can finish without an account.

(Cookie-based and existing-session auth are applied automatically before
you start — you don't invoke them.)

This tool consumes user attention and must be used only as a last resort.

No arguments. The site is derived from your current session URL.
```

### Blocking flow (reuses write-lock pause/resume)

The browser agent already pauses/resumes for write-lock approval (`write_lock_resume_state`, `close_browser_session(pause=true)`, `is_resume`). This tool is a new approval type on that machinery.

```
1. emit event — title "Requesting User Assistance for <base_site> Login",
   message "", type IN_PROGRESS.
2. pause the agent — close_browser_session(pause=true), persist resume state
   (same path as write-lock approval).
3. create UserAuthAssistanceRequest row; notify the user with a deep link to
   the Steel live-view for THIS session (scoped to steelSessionId, not agentId).
4. user takes interactive control in the live-view, signs in, then clicks the
   single button "Authentication Complete" (no decline option).
5. user clicks "Authentication Complete" → backend runs the completion path
   below.
6. emit event — title "User Assistance Received", type FINISHED.
7. agent resumes and continues the task.
```

### "Authentication Complete" path (spec)

When the user clicks the button, the backend, in one transaction:

1. **Set `UserAuthAssistanceRequest.completedAt = now()`.** Idempotent — a second click is a no-op (already-completed requests don't re-fire).
2. **Mark the Steel session as prioritized.** Upsert `SteelSessionAuth(userId, contextId, authRealm)` with `authenticatedAt = now()` and `disabledAt = null`. Because `SteelSessionAuth` outranks `cookie_bundles` in the Flow A resolver, writing this row *is* the prioritization — no separate priority field. The user just authenticated *inside* the Steel context via live-view, so the context now holds the freshest auth for the realm; the next injection decision (Flow B) will use the Steel context and inject nothing.
3. **Send the resume signal** to the paused workflow.

The agent resumes with the Steel context already authenticated for the realm. On a later run, the Flow A resolver returns this `steel_session` entry first.

**Local-browser fallback variant** (if `e2e_passkey_qr_handoff` fails): the user authenticates *outside* Steel, in their own browser. There is no Steel context to mark — step 2 is skipped. Instead, completion is just step 1 (`completedAt`) + step 3 (resume signal); the auth lands as a fresh `CookieBundle` via the mac-app re-scrape, and on resume the agent re-fetches `auth_options` and picks it up as a normal cookie_bundle. Whether the click triggers step 2 or skips it is determined by the request's `mode` field (`live_view` vs `local_browser`), set when the tool fired.

### Passkey handling (gated on an e2e test)

The live-view handoff clearly works for **password / OTP** sites — the user remote-controls the Steel browser and signs in normally.

For **passkey** sites the open question is: does Chrome's "use a passkey from another device" QR flow complete when the browser is a Steel datacenter Chrome and the phone is at the user's home? The hybrid flow's data transport is a cloud tunnel relay (not BLE), so it *may* work — but this is **unverified and must not be assumed either way.**

**Gating e2e test — `e2e_passkey_qr_handoff`:** spawn a browser agent on a passkey-protected site in a real Steel session → reach the passkey prompt → "use a passkey from another device" → QR → scan with a real phone → complete → assert the Steel session is authenticated.

- **If it passes:** passkey-via-QR is a first-class V1 path; the live-view handoff covers passkey sites too.
- **If it fails:** V1 falls back to nudging the user to sign in on their own browser (the mac-app re-scrape then picks up the session). The proper fix — a **local-browser auth step hosted by the mac-app** (Touch ID / local synced passkey / QR-to-phone all work because it's the user's device) — is post-V1, its own scope.

Do not finalize Flow D's passkey behavior until `e2e_passkey_qr_handoff` has been run.

### Tests

Blackbox — `agents/tests/blackbox/`:
- Tool only fires after passwords, email_otp, minted, guest are exhausted (mock failures down the ladder).
- IN_PROGRESS then FINISHED events emitted with correct titles.
- Workflow pauses on call, resumes on `completedAt`.

**E2E validation:**
- **`e2e_user_assistance_handoff`** — spawn a real agent, force all auto auth to fail, assert the tool fires, the workflow pauses, a live-view link is produced, and the agent resumes after `completedAt` is set.
- **`e2e_passkey_qr_handoff`** (gating — see "Passkey handling" above) — real Steel session on a passkey site, drive the QR flow with a real phone, assert the session ends authenticated. **Flow D's passkey behavior is not finalized until this runs.**

---

## Flow E: Credential outcome back-prop (post-run hook)

**Trigger:** Browser-agent workflow completes (success or failure).

### Inputs (read from existing tables)

- `Agent.status` — task-level outcome.
- `Message` rows — conversation including credential-injection markers.

### Credential-ref Message logging

Wherever the worker injects a credential, write a `Message` row with `metadata.credential_ref = {kind, id}`:
- Cookies / Steel session: at session start when the source is chosen (Flow B). Open question #1 — pin the call site.
- Passwords: at `service_actions.py:906-923` when `pwd:<ref>` resolves.
- OTP: at the user-message injection site in `handler.py` (Flow C).
- Minted: at minted-account use site.

### Hook logic

1. Read `Agent.status`.
2. Read `Message` rows for `agentId`, extract `credentialsUsed[]` from `metadata.credential_ref`.
3. **On failure only**: call the failure classifier LLM.
4. For each `credentialsUsed` entry, UPDATE the right row:
   - `outcome=success` → clear `disabledAt`, `disabledReason`.
   - `outcome=auth_failed` → set `disabledAt`, `disabledReason`.
   - `outcome=captcha | antibot | rate_limited | account_locked` → record `disabledReason`, **do not** set `disabledAt` (not a credential problem).

### Idempotency

Hook keyed on `agentId`; write-once `AgentRunCredentialPropagation` marker prevents Temporal-retry double-application.

### Interaction with sync (no conflict, one intentional reset)

Sync and the hook touch the same rows but **disjoint columns** — sync writes content/profile/`updatedAt`, the hook writes `disabledAt`/`disabledReason`. Each writer's UPDATE must be column-scoped (no full-row writes).

One intentional crossover: **when a sync brings genuinely changed cookie content for a bundle, it clears `disabledAt`** — new cookies supersede the prior failure. Without this, a re-login can't revive a disabled bundle.

### Failure classifier LLM

- Model: `rose-1-lite`, structured output.
- Input: task goal + last 10 Messages (text-only) + final status.
- Output enum: `auth_exhausted | nav_exhausted | site_rotation_exhausted | captcha_blocked | antibot_blocked | account_locked | rate_limited | user_declined | task_level | crashed | unknown`.
- Failure runs only.

### Error preservation — classifier reason augments, never replaces

The classifier is a *summary*; the raw error is *ground truth*. Both must survive.

- **Record the raw error first.** Before the classifier runs, the underlying failure (error message, stack, final `Agent.status`, the failing tool's error) is recorded — independent of whether classification succeeds.
- **Classification is best-effort augmentation.** The classifier LLM call is wrapped so that if it throws (timeout, bad output, provider error), the exception is **logged**, `failureReason` is left `null`, and the raw error still surfaces. A failed classifier must never swallow, mask, or replace the original error.
- **No catch eats the original error.** Any try/catch around the classifier call must re-surface the raw failure on the catch path. The original error is preserved and propagated; the classifier only adds a label.
- **The classified reason is posted in the failure surface.** When a tool/run fails, the failure event/message carries BOTH: `rawError` (full preserved error) and `failureReason` (classified enum, may be `null`). The reason is visible on the failure — not a silent DB-only column. The user/debugger sees the classification *and* the underlying error together.

### Tests

Blackbox — `back-end/src/tests/blackbox/post-run-hook.blackbox.ts`:
- Success run → `disabledAt` cleared.
- auth_failed run → `disabledAt` set.
- captcha/antibot → reason recorded, `disabledAt` NOT set.
- Re-run hook on same `agentId` → no-op (idempotency marker).
- Sync with changed cookie content → `disabledAt` cleared.
- Classifier returns a valid enum on mocked failure messages.

**E2E validation — `e2e_credential_backprop`**: run a real browser agent to completion (one success path, one auth-failure path), assert the credential row's `disabledAt` reflects the real outcome and the classifier produced a `failureReason` on the failed run.

---

## Mac-app changes

Source of truth for scraped cookies/passwords. Cuts across flows.

### Cookie reader (`mac-app/main/domains/browser-cookie-reader/`)

- Include `browserProfile` in the upload payload (captured at `service.ts:181-184`, dropped before upload).
- Sync upserts a `CookieBundle` row per `(authRealm, browserSource, browserProfile)` before inserting cookies.

### Password reader (`browser-password-reader/service.ts:386-393`)

- Include `browserProfile` in the encrypted upload payload (currently stripped in `readAndEncryptPasswordsForBrowser`).

### Cookie sync semantics (`cookie-sync/`)

Continuous sync requires **snapshot-replace**, not pure upsert:
- Upsert all received cookies.
- DELETE any Cookie row for that `(user, browserSource, browserProfile)` not in the received set (browser-deleted cookies must not linger — they pollute `freshestCookieUtc`).
- Bump `CookieBundle.updatedAt` explicitly in the `update:` branch (Prisma `@updatedAt` only fires on real diffs).
- If cookie content for a bundle changed, clear `CookieBundle.disabledAt`.

### Tests

Blackbox — `mac-app/tests/blackbox/`:
- `browserProfile` survives upload roundtrip.
- Chrome/Default + Chrome/Profile1 → distinct CookieBundle rows.
- Browser-deleted cookie removed from DB after next sync.
- No-op sync still bumps `CookieBundle.updatedAt`.

**E2E validation — `e2e_sync_to_agent`**: run a real mac-app scrape → sync → spawn a browser agent → assert the agent's auth_options reflect the just-synced CookieBundle (the full mac-app → backend → agent path).

---

## E2E validation matrix

Per CLAUDE.md rule #14, the plan is verified by automated tests. Each flow has a blackbox tier (isolated) **and** an e2e tier (real agents via `agents/tests/e2e/run_e2e_tests.py`). The feature is not "done" until every e2e test below passes.

| E2E test | Flow | Validates |
|---|---|---|
| `e2e_sync_to_agent` | Mac-app | scrape → sync → agent sees the CookieBundle |
| `e2e_auth_options_scoped` | A | agent receives only its realm's options |
| `e2e_steel_precedence` | B | live Steel context used, no injection |
| `e2e_cookie_fallthrough` | B | empty context → cookie injected → lands authed |
| `e2e_email_otp_user_message` | C | OTP arrives as user message, login completes |
| `e2e_user_assistance_handoff` | D | exhaust → pause → live-view link → resume |
| `e2e_passkey_qr_handoff` | D | **gating** — QR passkey flow on Steel; decides Flow D passkey behavior |
| `e2e_credential_backprop` | E | run outcome → `disabledAt` + classifier reason |

`e2e_passkey_qr_handoff` runs first — its result determines whether Flow D's passkey path is QR-handoff or local-browser-fallback.

## Migration

Single Prisma migration. 0 users → wipe and migrate.

```
1. Add CookieBundle, SteelSessionAuth, MintedAccount, AgentIdentity,
   UserAuthAssistanceRequest, AgentRunCredentialPropagation.
2. Add browserProfile to Cookie.
3. Add browserProfile, disabledAt, disabledReason to BrowserPassword.
4. Drop existing Cookie + BrowserPassword rows during dev DB reset.
```

---

## Out of scope (deferred)

- SSO modeling.
- Cookie bundle rotation.
- Mid-run cookie persistence back to the DB (Steel context persists it instead).
- Local-browser auth step (the proper passkey fix) — post-V1, own scope.
- Recording Steel-session auth from *agent-initiated* logins (`SteelSessionAuth` is written; the reliable "detect login succeeded" logic is its own spec).
- Streaming diagnostics / crash recovery.
- Apple Passwords / Safari reader.
- Account-list UI.
- Payment vault for minted accounts.

---

## Open questions / verification

1. **Cookie/Steel-injection call site** for credential-ref Message logging (Flow E). Passwords are pinned (`service_actions.py:906-923`); cookies/Steel are likely in `browser-session/` or `agents/domains/spawn_browser_agent_v3/service.py`.
2. **Steel API capabilities** — does Steel expose context TTL/status, and does it support per-realm cookie clearing (for flush) or only full context reset?
3. **Steel live-view** — confirm Steel provides a session-scoped interactive viewer URL for the Flow D handoff.
