# AgentCard Integration — Replace user-entered cards with minted single-use virtual cards

## Goal

Stop asking users to type a real card into our app (encrypted-blob custody model).
Instead, mint a **single-use virtual Visa per purchase** via [agentcard.sh](https://docs.agentcard.sh)
(Stripe Issuing under the hood), funded **just-in-time** by charging the user's
existing Rose Stripe payment method. This removes Rose from credential custody,
caps every purchase's blast radius, and gives the user a transparent
`ROSELABS* <MERCHANT>` line on their statement.

## Decisions locked (from alignment thread)

1. **Provider product:** AgentCard **Organizations** REST API (`agent-cards-admin`,
   `sk_live_*`), base `https://api.agentcard.sh`, auth `Authorization: Bearer <key>`.
   NOT the consumer/MCP product.
2. **Single Rose Labs cardholder.** Rose creates **one** cardholder (a Rose principal,
   one DOB) and attaches **one** Rose funding card, once. Every user's purchase mints a
   single-use card under that cardholder. Users never touch AgentCard. Per-user
   attribution + spend control live in **our** DB.
3. **Funding = charge-then-mint, just-in-time. No prepaid pool.** On purchase approval we
   charge the user's Rose Stripe payment method for the exact order total (off-session
   `PaymentIntent`, `statement_descriptor_suffix = <merchant>`), and only on success mint
   an AgentCard card for that amount. The minted card is single-use and capped at the
   approved amount → runaway is physically impossible.
4. **`CardProvider` interface.** AgentCard is the first implementation; Stripe Issuing
   direct is a future drop-in (interchange-positive, ~2%/purchase vs AgentCard ~2.9% +
   markup). The agent never knows which provider is active.
5. **Mint as late as possible + close-on-failure.** Card is issued at fill-time, after the
   approval gate, sized to the order. If the agent fails to use it, close it (hold released;
   per-card fee, if any, is cents).
6. **Spend ledgers stay separate.** Purchase spend is its own ledger entry type (refund /
   chargeback semantics differ from compute COGS), even if surfaced in one place.

## Open inputs (do not block build; captured as config constants)

- **AgentCard markup / per-card fee** — unpublished. Get from AgentCard. Lives in
  `back-end` config; defaults flagged `// TODO(agentcard-pricing)`.
- **AgentCard org account + `sk_live_` / `sk_test_` keys** — needed before live + for the
  blackbox test (`sk_test_`). Set as backend env var `AGENTCARD_API_KEY` (with approval).
- **Per-card ceiling** — AgentCard default cap is $50/card; confirm our org tier. Drives
  `MAX_PURCHASE_CENTS`.
- **Custom statement descriptor on AgentCard's funding capture** — ask AgentCard; not
  required (our user-facing descriptor is on the Rose `PaymentIntent`, which we control).

## Architecture

```
ONE-TIME (Rose ops, once ever)
  agent-cards-admin orgs create / keys create        → AGENTCARD_API_KEY (sk_live_*)
  POST /api/v1/cardholders {Rose principal, DOB}     → ch_roselabs (backend config)
  POST /cardholders/ch_roselabs/payment-method/setup → checkoutUrl → Rose attaches Rose card

PER PURCHASE (browser agent at checkout)
  agent reaches payment form
    └─ calls tool: request_payment_card(amount_cents, merchant)
         backend:
           1. enforce gate: amount <= autopay limit? else send_message_to_user(is_question) → wait
           2. enforce MAX_PURCHASE_CENTS + per-user budget
           3. Stripe off-session PaymentIntent on user's customer
                amount, statement_descriptor_suffix="<merchant>"   ── user-facing charge
           4. on success → CardProvider.mintCard(amount_cents)     ── AgentCard create_card
                                                                       (hold on Rose funding card)
           5. record PurchaseSpend ledger row {userId, cardId, amount, merchant, paymentIntentId}
           6. CardProvider.getDetails(cardId) → {pan,cvv,expiry}
           7. populate agent _secret_refs: card_number/card_name/card_expiry/card_cvv
         returns: "Card ready (last4 …). Fill fields with refs card_number/card_cvv/…"
    └─ agent types refs → browser tool resolves to real PAN at input time (existing plumbing)
    └─ merchant captures virtual card → AgentCard captures Rose funding card
    └─ card auto-closes (single-use); on agent failure → CardProvider.closeCard (hold released)

RECONCILE (webhooks)
  AgentCard transaction.cleared / voided / card.closed / balance.low
    → update PurchaseSpend status; on void/refund → refund user PaymentIntent
```

Money legs (per $X purchase): **User → Rose** (Stripe, ~2.9%+30¢, descriptor = merchant) and
**Rose → AgentCard → merchant** (hold→capture on Rose funding card + AgentCard markup). They
do not auto-net; Rose's margin = whatever we add on top of $X at charge time.

## AgentCard REST surface used

| Action | Endpoint |
| --- | --- |
| Create cardholder (one-time) | `POST /api/v1/cardholders` (firstName, lastName, dateOfBirth, email, phoneNumber) |
| Setup payment method (one-time) | `POST /api/v1/cardholders/{id}/payment-method/setup` → `{checkoutUrl}` |
| Payment-method status | `GET /api/v1/cardholders/{id}/payment-method/status` |
| Mint card | `POST /api/v1/cards` `{amountCents, cardholderId}` → `{id,last4,expiry,spendLimitCents,status}` |
| Card details | `GET /api/v1/cards/{id}/details` → `{pan,cvv,expiry,balanceCents,status}` |
| Close card | `DELETE /api/v1/cards/{id}` (hold released) |
| Webhooks | `card.*`, `transaction.*` (`transaction.cleared`/`voided`), `balance.low` |

Note: `amountCents` is CENTS (convert dollars × 100). Default per-card cap 100–5000 (=$1–$50)
on base tier.

## Implementation

### Backend

1. **`CardProvider` interface** — `back-end/src/providers/card-provider/` (canonical, like
   `providers/stripe.ts`):
   - `interface CardProvider { mintCard(amountCents): Promise<{cardId,last4,expiry}>;
     getDetails(cardId): Promise<{pan,cvv,expiry}>; closeCard(cardId): Promise<void>; }`
   - `AgentCardProvider` impl: thin fetch wrapper over the REST surface above, reads
     `AGENTCARD_API_KEY`, `AGENTCARD_CARDHOLDER_ID`, `AGENTCARD_BASE_URL`. All calls logged
     `[AgentCard]` with truncated payloads (CLAUDE.md logging rules); **never log PAN/CVV**.
2. **Purchase domain** — `back-end/src/domains/purchases/`:
   - `GET /api/purchases/lookup?fingerprint=…` → returns the most recent `PurchaseSpend` for
     `(userId, fingerprint)` within 24h + its card usability, for the agent's auto-approve
     cache (req 3).
   - `POST /api/purchases/mint` (hybridAuth, X-User-Id): body `{fingerprint, totalCents,
     merchant, agentId, lineItems}`. **Idempotent on `fingerprint`** — if a usable
     `HELD/OPEN` card exists, returns it without re-charging (CLAUDE.md rule 19). Else
     enforces `MAX_PURCHASE_CENTS` + per-user budget; off-session `PaymentIntent` on the
     user's `stripeCustomerId` default PM with `statement_descriptor_suffix=merchant`; on
     success `CardProvider.mintCard` + `getDetails`; writes `PurchaseSpend`; returns
     `{cardId, pan, cvv, expiry, last4}` (only to the trusted agent worker path).
   - `POST /api/purchases/:cardId/close` → `CardProvider.closeCard` + ledger update (+ refund
     user PaymentIntent if not `CLEARED`). Idempotent on already-closed.
   - `POST /api/webhooks/agentcard` → verify signature, reconcile `PurchaseSpend`
     (`transaction.cleared`→`CLEARED`, `transaction.voided`→refund user→`REFUNDED`,
     `card.closed`, `balance.low`).
   - **Run-end cleanup hook:** when an agent run ends without `CLEARED`, close OPEN cards +
     refund (the lifecycle in the Agents section).
3. **Prisma** (needs approval — schema change): add `model PurchaseSpend {id, userId, agentId,
   fingerprint, cardId, merchant, lineItemsJson, totalCents, status, stripePaymentIntentId,
   createdAt, updatedAt}` with `@@index([userId, fingerprint])`. Status enum:
   `PENDING_APPROVAL|CHARGING|HELD|CLEARED|VOIDED|REFUNDED|FAILED`. `agentcardCardholderId`
   is **org-level config**, not per-user → no User column. **Mark
   `User.encryptedPaymentInformation` deprecated** (drop in a follow-up migration once agents
   no longer read it).
4. **One-time setup script** — `back-end/scripts/agentcard-setup.ts`: create the Rose
   cardholder, print `checkoutUrl`, poll payment-method status. Run by ops once.

### Agents — `request_payment_card` tool (built ON TOP OF `request_user_approval`)

**Reuse, don't rebuild (req 6).** The tool is a thin specialization of
`agents/domains/request_user_approval/service.py:request_user_approval_direct(workflow_instance,
question, image_url, metadata)`. That primitive already gives us, for free:
Temporal-signal blocking wait, the approval chip lifecycle (IN_PROGRESS→FINISHED), SMS
write-lock notify, and **rejection handling** — `UserRejectedError(rejection_message=...)`
with the user's reason already extracted from context (req 5). We do NOT reimplement any of it.

New domain `agents/domains/request_payment_card/` (handler/service/types/config, mirroring
`request_user_approval`). Tool signature (browser-agent EXECUTE tool):

```
request_payment_card(
  merchant: str,
  currency: str,                 # "USD"
  line_items: [                  # itemized receipt the agent reads off the checkout page (req 2)
    { name, image_url, unit_price_cents, quantity, line_total_cents }
  ],
  fees: [ { label, amount_cents } ],   # shipping, tax, service fees …
  subtotal_cents: int,
  total_cents: int,
)
```

Flow inside the tool:

1. **Fingerprint** the request = stable hash of `(userId, merchant, normalized line_items,
   fees, total_cents)`. Drives both the 24h cache and mint idempotency (req 3).
2. **Auto-approve cache (req 3):** call backend `GET /api/purchases/lookup?fingerprint=…`.
   - If a `PurchaseSpend` with this fingerprint was **approved within 24h** and its card is
     still usable → **skip the user prompt**, reuse it (see idempotency below). Limit/budget
     checks still run — auto-approve only skips the *prompt*, never the guards.
   - Else continue to prompt.
3. **Approval prompt:** call `request_user_approval_direct(question=<summary>,
   metadata={"requestPaymentCard": {fingerprint, merchant, currency, line_items, fees,
   subtotal_cents, total_cents, paymentMethodLast4, autopayLimitCents}})`. Frontend renders
   the **full itemized receipt** from this metadata (req 2) — line items w/ product images,
   qty, prices, fees, subtotal, total — exactly as if the user were checking out themselves.
   - Autopay shortcut preserved: if `total <= autopay limit`, the existing autopay path may
     auto-confirm (same semantics as today), still subject to `MAX_PURCHASE_CENTS`.
4. **On approval** → backend `POST /api/purchases/mint` `{fingerprint, total_cents, merchant,
   agentId, line_items}` (idempotent on `fingerprint`): charges the user's Stripe PM
   (`statement_descriptor_suffix=merchant`), mints the AgentCard card, writes `PurchaseSpend`,
   returns `{cardId, pan, cvv, expiry, last4}`.
5. **Inject** `pan/cvv/expiry/name` into the live `_secret_refs` map (`card_number`,
   `card_name`, `card_expiry`, `card_cvv`) — reusing the existing secret-ref resolution
   plumbing; the LLM only ever sees `last4` + ref names, never the PAN.
6. **Suppress re-prompt for this page/session (req 1):** on success, write
   `write_lock_approvals["payment"] = {domain, approved_at}` (the existing in-session
   write-lock dedup at `spawn_browser_agent_v3/handler.py:732,2864-2873`, which already
   survives pauses via `write_lock_resume_state`). The "payment" write-lock will not fire
   again for the same checkout domain in this session.
7. **On `UserRejectedError`** → propagate; the rejection reason is already in agent context
   (req 5). No charge, no mint.

**Write-lock routing change.** The payment-type write lock
(`browser_tools/write_lock.py`, integrated at `handler.py:2843-2881`) currently calls the
generic approval then fills the *static stored card*. Re-point the **"payment" action_type**
to require `request_payment_card` instead: if `write_lock_approvals["payment"]` is already set
for the domain → proceed (req 1); otherwise block raw card-fill and instruct the agent to call
`request_payment_card` with the cart it reads off the page. All other write-lock types
(social_post, email_send, purchase-button) keep the generic approval.

**Card lifecycle & failure/rerun (req 3).** `PurchaseSpend` status machine:
`PENDING_APPROVAL → CHARGING → HELD(card minted) → CLEARED(merchant captured; card
auto-closes)`. Branches:
- **Stripe charge fails** (user card declined / `authentication_required`): `FAILED`, no card;
  tool returns a clear failure → agent reports it, does not proceed.
- **Card minted, checkout fill fails / max steps / transient abort:** stays `HELD`, card kept
  **OPEN** so a rerun within the same run / 24h reuses it (idempotent mint returns the same
  card — **no second charge**).
- **Idempotent mint:** same `fingerprint` ⇒ `HELD/OPEN` → return existing card; `CLEARED` →
  "already purchased, do not re-buy"; `FAILED`/`REFUNDED` → allow fresh attempt. (CLAUDE.md
  rule 19 — activity is at-least-once.)
- **Cleanup:** when the agent run ends without `CLEARED`, a backend job closes the OPEN card
  (releases the AgentCard hold) and **refunds the user's PaymentIntent** → `REFUNDED`.
  AgentCard's own 2h idle auto-clean is a backstop, not the primary path.

**Prompt + cleanup.** `service_crypto.py:build_autopay_prompt_section` becomes a description
of the `request_payment_card` tool (mint-on-demand + "extract the full cart before calling"),
full text, no truncation. Remove the upfront `decrypt_payment_info`/`_card_refs` static
injection (`handler.py:1043-1058`); delete the `decrypt_payment_info` card branch and
`config.payment.decryption_key` *card* usage (keep the RSA path only if still used for
passwords — verify `_ref_to_encrypted`).

### Frontend / Mac-app

8. **Strip the card-entry surfaces (req 4)** — these are the "previous agent card billing"
   pages: `front-end/src/features/settings/components/PaymentTab.tsx`, `CardInfoFields.tsx`,
   `BillingAddressFields.tsx`, `hooks/usePayment.ts`, the payment path in
   `front-end/src/lib/encryption.ts`, and the **entire** mac-app `ui/features/agent-pay-modal/`
   (AgentPayModal, CardForm, SavedCardSummary, DeliveryAddressFields …). Replace with a simple
   **autopay-limit + purchase-budget** control (the only user-facing payment setting left).
   **KEEP** `settings/components/BillingTab.tsx` + `useBilling.ts` — that's the Stripe
   *subscription* portal we depend on for charge-then-mint, NOT card entry.
9. **Itemized receipt approval UI (req 2)** — new `requestPaymentCard` metadata type in
   `front-end/src/lib/realtime-types/tool-metadata.ts`, and an `ApprovalChip` variant (or new
   `PaymentReceiptApproval` component under `terminal-component-group`) that renders the full
   receipt from metadata: each line item with product image, quantity, unit + line price; fees;
   subtotal; total; merchant; and the `ROSELABS* <merchant>` charge note. Approve/reject reuses
   the existing attention-request respond/reject API. Mirror in mac-app.
   Keep state-machine diagram comments updated (CLAUDE.md rule 8). Frontend change → mac-app
   version bump / new tag (CLAUDE.md).

## Verification (automated — CLAUDE.md rule 14)

All gates are tests, no manual steps:

1. **Backend blackbox** `back-end/src/tests/blackbox/purchases.blackbox.ts` (new):
   - `testSmoke_mintCard_chargesAndIssues`: against AgentCard **`sk_test_`** + Stripe test
     mode — mint endpoint charges a test PaymentIntent (assert `statement_descriptor_suffix`
     set) and returns a card with `last4`/`expiry`; assert `PurchaseSpend` row written.
   - `testSmoke_mintCard_respectsMaxPurchase`: amount > `MAX_PURCHASE_CENTS` → rejected, no
     charge, no card.
   - `testSmoke_closeCard_releasesHold`: close returns ok; idempotent on already-closed.
   - `testSmoke_webhook_voidRefundsUser`: simulated `transaction.voided` → ledger `VOIDED` +
     refund PaymentIntent created.
   - `testSmoke_mint_idempotent`: same `(agentId, stepId)` twice → one charge, one card.
   - Use a **`FakeCardProvider`** for unit-level limit/idempotency logic; use real `sk_test_`
     for the one end-to-end smoke so we exercise the actual AgentCard contract.
2. **Agents blackbox** `agents/tests/blackbox/request_payment_card.blackbox.py` (new):
   - Card lands in `_secret_refs`; LLM-visible output is only `last4` + ref names (never
     PAN/CVV).
   - **Rejection (req 5):** simulate `UserRejectedError` → no mint call, rejection reason
     present in agent context.
   - **24h auto-approve (req 3):** identical fingerprint within 24h → no approval prompt
     emitted, reuses card.
   - **Idempotent rerun (req 3):** same fingerprint twice → one Stripe charge, one card.
   - **Write-lock suppression (req 1):** after success, `write_lock_approvals["payment"]` set
     for the domain → second payment-field detection on the same page does not re-prompt.
   - **Itemized metadata (req 2):** the emitted approval metadata carries the full
     `line_items`/`fees`/`subtotal`/`total` receipt payload.
3. **Coverage**: keep backend ≥ thresholds (`.c8rc.json`); add tests with new code.
4. Full `bash scripts/test.sh --port=3001` green before `/deploy`.

## Risks / notes

- **Single shared cardholder** ⇒ AgentCard's only native guardrail is the per-card hold cap.
  All per-user limits are **our** responsibility (`MAX_PURCHASE_CENTS` + budget) — enforced
  server-side before mint.
- **Off-session charges** require the user's saved Stripe PM to permit off-session reuse;
  subscription customers have a default PM. Handle `authentication_required` /
  `card_declined` → surface to user, do not mint.
- **Double Stripe fee** per purchase (charge user + AgentCard captures Rose card) is the
  accepted cost of "no pool + transparent descriptor" at this stage; revisit at volume via
  the `CardProvider` Stripe-Issuing swap.
- **PCI scope shrinks** — Rose no longer stores/decrypts PANs. The minted PAN transits the
  backend→agent path only at fill-time and is never logged or persisted.

## Out of scope (follow-ups)

- Drop `User.encryptedPaymentInformation` column (after agents confirmed off it).
- Stripe Issuing direct `CardProvider` impl.
- Separate hard-capped purchase pool UI (ledger already split).
