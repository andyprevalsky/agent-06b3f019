# SMS-first onboarding + the Gate primitive

## Problem

Anyone should be able to text a Rose number and immediately issue tasks — their phone number
*is* their authorization (an inbound SMS from a number proves possession exactly like an OTP).
Today the opposite happens:

- **Unknown numbers dead-end.** `sms-webhook/service.ts:286-294` replies *"Please sign up at
  roselabs.ai first"* and stops. No user is created. Onboarding is impossible over SMS.
- **Gates are bespoke and inconsistent.** Every "the user must do X to continue" path is its own
  shape: email → `GmailNotConnectedError` (tells the user to click a hamburger menu), purchase →
  bare `402`, KYC → `422 kyc_required` **with no link surfaced at all**. There is no single object
  an agent can raise that renders as one minimal action ("tap this link" / "reply YES") on SMS.

The good news: the *transport* already exists. **Attention Requests**
(`back-end/src/domains/attention-requests/` + `agents/domains/request_user_approval/`) already
create a user-visible ask, pause the Temporal workflow on a `receive_user_response` signal, resume
on completion, and fan out to SMS via `notify_sms_event_activity`. We formalize a typed **Gate** on
top of that pipe rather than inventing new plumbing.

## Design

**Principles.** (1) Any inbound text = an authorized session — provision on first contact,
silently. (2) Agents run immediately; a gate is surfaced **just-in-time**, only when actually hit.
(3) Every gate is the same object and always renders as **one tap or one reply** — the minimal path.

### The Gate object (the standard object)

Not a new table — a typed payload riding in `AttentionRequest.metadata.gate`. AttentionRequest
stays the pipe (record + pause/resume + SMS fan-out); Gate is the semantic layer.

```jsonc
Gate {
  gateKey:  string,        // DEDUP identity — not unique per request (see dedup)
  type:     "source_connect" | "subscription" | "kyc" | "approval",
  status:   "PENDING" | "RESOLVED" | "EXPIRED" | "REJECTED",
  severity: "blocking" | "advisory",

  presentation: { title: string, reason: string, cta: string },  // channel-agnostic

  action:                                                          // ONE tap or ONE reply (+ a Cancel)
    | { kind: "link",  url: string, expiresAt: string }           // source_connect/subscription/kyc
    | { kind: "reply", tokens: ["YES","NO"], paymentCard?: RequestPaymentCardPayload }, // approval

  detection: { method: "oauth_callback"|"stripe_webhook"|"kyc_webhook"|"reply"|"probe",
               probeKey: string },

  context: { sourceKey?: "gmail" | ... }   // discriminated by type; singletons carry none
}
```

`gateKey` cardinality: `subscription` / `kyc` are **singletons per user**;
`source_connect:<source>` is one per named source; `approval:<contentHash>` is one per distinct ask.
There is no `payment_method` gate: a missing card just means the user needs to subscribe, so the
`subscription` gate covers it. Every gate also renders a **Cancel** action (maps to attention-request
skip/reject) alongside its primary CTA.

### Pieces

1. **SMS provisioning.** Replace the `unknownPhone` dead-end: on an unknown number, create
   `User{phone}` and route to the SMS Supervisor exactly as for a known user. No `provisionedVia`
   field, no OTP (the SMS is the OTP), **no `onboardingWelcome` nag** — provisioning is silent.
   Supabase auth-user creation is deferred until a web gate needs a session (minted via a
   short-lived magic link).

2. **`GateRequired` + one catch.** Tools raise `GateRequired(type, ctx)` instead of their bespoke
   errors (`GmailNotConnectedError`, 402, 422). A single catch in the agent loop resolves → emits a
   Gate → pauses on the existing `receive_user_response` signal → resumes on detection. Collapses
   the four inconsistent error sites into one path.

3. **`GateResolver` registry** — one module per type, same interface, so new gates plug in without
   touching the loop or the SMS layer:
   - `probe(userId, ctx) → satisfied?`  ·  `mint(userId, ctx) → GateAction`  ·  `detection` binding.

   | type | `probe` reuses | `mint` reuses | `detection` |
   |---|---|---|---|
   | `subscription` | `calculateTotalUsage` + `findSubscriptionByUserId` | **new** Stripe Checkout link | `checkout.session.completed` (existing `webhooks/service.ts`) |
   | `source_connect:gmail` | `findGmailIntegrationsWithCredentials` | `startEmailOAuth(returnUrl)` | existing OAuth callback |
   | `approval` | — | existing `request_user_approval` payload | existing `receive_user_response` |
   | `kyc` | cardholder KYC status | **deferred** — AgentCard hosted link (stub: "reply when done") | AgentCard webhook |

4. **Dedup (fan-in).** Before creating a Gate, find-or-create atomically on
   `(userId, gateKey) WHERE answered=false` (partial unique index + the per-user lock already used
   at `supervisorHandler.ts:48-71`). A second workflow with the same key **subscribes as a waiter**
   rather than creating a second AttentionRequest. On resolution, signal **every** waiter → all
   resume. Scope is per-user across the whole agent tree (sub-agents share the root user).

5. **Subscription gate — dual trigger.** Fires when **either**
   `calculateTotalUsage(userId) >= 100¢` (non-pool spend — pool/claudeAuth models are priced `$0`
   in `agents/providers/rose/pricing.py:32-45`, so this sum already excludes free usage) **OR** an
   action structurally requires a subscription (purchase / card mint — `purchases/service.ts:337`).
   Reach: **pauses the whole agent tree** (past $1 essentially everything costs real money).
   Checked at agent spawn and after each `save_tool_usage`. Soft ceiling — may overshoot $1 by one
   iteration.

6. **Website UI.** The existing AttentionInbox (polls `/api/attention-requests`) branches on
   `metadata.gate` and renders a **Gate card**: title, reason, one CTA (link button → opens
   OAuth/Checkout/KYC, or YES/NO buttons). Same inbox, one new card variant — no new fetch path.

### Gate lifecycle

```
GateRequired(type,ctx)
   │ deriveKey → find-or-create (atomic on userId+gateKey, answered=false)
   ├── new gate ........ create AttentionRequest + render one minimal SMS action
   └── existing PENDING . subscribe as WAITER (no new row)
                 ▼
              PENDING ──(expiresAt)──► EXPIRED
                 │ detection: oauth_cb | stripe_wh | kyc_wh | reply | probe
                 ├── RESOLVED ──► signal EVERY waiter ──► all AGENT_RESUMED
                 └── reject/NO ─► REJECTED ──► waiters get UserRejectedError
```

## Decisions (locked)

- Auto-create the account on the first message; no `provisionedVia`, provisioning is silent.
- Subscription gate: **dual trigger** (`≥$1 non-pool` OR structurally-requires-subscription),
  **whole-tree pause**.
- Non-pool meter reuses `calculateTotalUsage` (no new spend column). "$0-price ⇒ pool" is a proxy —
  acceptable for MVP, hardened later with an explicit funding-source tag.
- Gate rides in `AttentionRequest.metadata`; the only migration is a nullable `gateKey` column +
  partial unique index.

## Phasing

- **Phase 1a — SMS provisioning. ✅ SHIPPED.** `sms-webhook`'s unknown-number dead-end replaced
  with silent `provisionUserByPhone` (generated `userId`, free-tier `createSignupBonusCredit`, no
  OTP/welcome nag) → routes to the supervisor exactly like a known user. Verified by
  `sms-webhook.blackbox.ts` (new-phone provisions + routes; the four 200-returning cases moved to
  sequential with User/Credit/SmsSession cleanup) and `sms-supervisor.blackbox.ts` (boundary test
  cleaned up) — both suites green.
- **Phase 1b — Gate pipe + dedup + fan-in + SMS. ✅ SHIPPED.**
  - `Gate` Zod union (`gateSchema`) validated on create; `AgentAttentionRequest.gateKey` column +
    `@@index` + partial-unique-index migration (`20260706000000_add_attention_request_gate_key`).
  - **Dedup:** `findPendingByGateKey` + create-time collapse (returns the existing PENDING request
    with `deduped:true`, P2002-race-safe).
  - **Fan-in resume:** deduped agents are recorded as `metadata.gateWaiters`; `respond`/`reject`
    now `signalAllWaiters` (primary workflow + every waiter) instead of just the owner.
  - **Minimal SMS:** `renderGateSms` (one link tap or one reply) is dispatched to the user when the
    gate is raised for an SMS-source agent (`maybeDispatchGateSms`); the rendered body is returned
    as `gateSms`.
  - Verified by `attention-requests.blackbox.ts`: `gate dedup collapses to one pending request`,
    `gate resolve signals all waiters (fan-in)`, `gate renders one minimal SMS action` (36/36 green).
  - **Agents-side raise:** `raise_gate_direct` creates/dedups the request, parks the workflow on
    `receive_user_response`, and closes the inline gate message when resolved/rejected.
- **Phase 1c — Gate UI. ✅ SHIPPED.** Gate cards render in both AttentionInbox and the inline
  message stream. Link gates open their one action and wait for webhook/OAuth detection; reply gates
  resolve directly from the card. Generic approval messages also render inline Approve/Decline above
  the “continue working” status line.
- **Phase 2 — resolvers. ✅ PARTIAL SHIPPED.** `subscription` uses a Stripe Checkout mint and
  `invoice.payment_succeeded` resolves `gateKey=subscription`; purchase-card 402 raises the real
  subscription gate and retries after resolution. `source_connect:gmail` mints the existing Gmail
  OAuth URL, resolves on OAuth callback, and can be triggered by `grep source="gmail"` when the
  message corpus is absent. `approval` remains the existing reply-based attention request path;
  `kyc` is still deferred.

## Verification (automated)

**Tier 1 — deterministic blackbox** (`back-end/src/tests/blackbox/`, + agents e2e for the
workflow-signal hop; resolvers stubbed, no LLM): unknown number provisions + gets an agent;
duplicate `gateKey` collapses to **one** AttentionRequest; resolving signals **all** waiters;
SMS renders exactly one minimal action; conversational text provisions **without** a gate/agent.

**Tier 2 — simulate-mode eval** (`agents/benchmarks/tasks.json`, `tag: onboarding`,
`bench: pipeline-e2e`, `mode: simulate`, via `run_eval_suite.py`; **onboarding fixture = base image
with the test phone absent** so provisioning fires; no real purchases/SMS). Scored by `static_check`
(scan AttentionRequest + Agent + SMS-archive event log for ordered/forbidden/count matchers) +
`agentic_llm_judge` (minimal-path quality, reply coherence).

Observable milestone vocabulary: `PROVISIONED`, `AGENT_SPAWNED`, `SUPERVISOR_REPLY`,
`GATE_RAISED{type,gateKey}`, `GATE_SMS_SENT{gateKey}`, `GATE_DEDUP{gateKey,waiters:n}`,
`GATE_RESOLVED{gateKey}`, `AGENT_RESUMED`, `PURCHASE_APPROVAL{amount}`, `TASK_COMPLETED`.

### New-user trajectories (the test specs)

**① "buy me alcohol"** — provisioning + structural subscription trigger + payment approval.
Required (ordered): `PROVISIONED` → `AGENT_SPAWNED` → `GATE_RAISED{subscription}` (fires before $1
because minting a card requires a subscription) → `GATE_SMS_SENT{subscription}` (one Checkout link)
→ `GATE_RESOLVED{subscription}` → `AGENT_RESUMED` → `PURCHASE_APPROVAL{amount}` → `GATE_RESOLVED`
→ `TASK_COMPLETED`. Forbidden: two subscription gates; any gate before `AGENT_SPAWNED`; a real
charge in simulate.

**② conversational** — the negative case. Required (ordered): `PROVISIONED` (silent) →
`SUPERVISOR_REPLY` (coherent). Forbidden: `AGENT_SPAWNED`; **any** `GATE_RAISED`; any
subscribe/onboarding nag. Proves provisioning is silent and we don't over-gate chatter.

**③ "make my best friend's birthday the best ever"** — fan-in dedup (the correctness lynchpin).
Required (ordered): `PROVISIONED` → `AGENT_SPAWNED` → `SUB_AGENTS_SPAWNED (≥2)` →
`GATE_DEDUP{subscription, waiters≥2}` (N sub-agents need a subscription → exactly **one**
AttentionRequest) → `GATE_RESOLVED{subscription}` → **all** waiters `AGENT_RESUMED` →
`PURCHASE_APPROVAL{...}` per purchase → `TASK_COMPLETED`. Forbidden: >1 subscription
AttentionRequest; any waiter left un-resumed after resolve.

**Gate:** both tiers green + `tsc --noEmit` + eslint + structural invariants + backend/agents
coverage thresholds.

## Deferred / open

- **Composite-source gating** — `messages` → sms/email/whatsapp expansion, source registry, and
  advisory-vs-blocking relevance inference. `source_connect` here fires only for a tool that names
  one concrete source; no inference.
- **KYC hosted link** — provider exposes it; wiring the `mint` + webhook is Phase 2+.
- **Age / 21+ verification** for alcohol — not a modeled gate. Open: dedicated `age` gate vs. fold
  into KYC.
- **Explicit funding-source tag** to replace the "$0-price ⇒ pool" proxy in the meter.
