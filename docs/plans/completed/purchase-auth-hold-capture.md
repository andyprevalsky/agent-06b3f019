# Purchase auth-hold → capture-on-clear / cancel-on-fail

## Problem

The purchase flow was **charge-then-mint**: `paymentIntents.create({ confirm, off_session })`
captured the user's money the instant the card was minted. If the agent then failed to spend the
card (transient error, cart changed, silent death), the user stayed charged and **nothing refunded
them** — there was no stale-purchase sweep. Every abandoned purchase also meant a Stripe
charge + refund (two ops, two fees, a charge-then-refund on the user's statement).

## Change (shipped)

Switch the charge to a **manual-capture authorization (hold)** and settle explicitly:

- **Mint** (`service.ts`): `paymentIntents.create({ capture_method: 'manual', ... })` — authorize a
  hold, no money taken. Row stays `HELD`.
- **`transaction.cleared`** (`reconcile.ts`): the card settled → **capture** the hold (→ `CLEARED`).
  Capture is idempotent and always attempted, so a lost `cleared` webhook can't leave money
  uncollected.
- **`transaction.voided`** (`reconcile.ts`): un-captured hold → **cancel** it (→ `VOIDED`, no charge,
  no refund churn); already-captured → **refund** (→ `REFUNDED`).
- **Explicit close** (`reconcile.ts` `closePurchaseCard`): un-captured hold → **cancel** (→ `VOIDED`).
- **Agent-session cleanup** (`purchaseCleanup.ts`) — the primary "cancel on fail" hook, **no cron**:
  for each `HELD` card it liveness-checks the card and either **cancels** the hold (unspent →
  `VOIDED`) or **captures** it (already used → `CLEARED`, so we still collect on a lost webhook).
- **Backstop:** an uncaptured Stripe hold auto-releases after ~7 days, so even a fully silent
  failure self-heals with zero code.

Shared helpers live at the provider level (providers can't import domains):
`captureAuthorizedHold` / `cancelAuthorizedHold` in `providers/stripe.ts` (idempotent — swallow
Stripe's `payment_intent_unexpected_state`), and `isCardLive` in `providers/card-provider`.

A TTL cron to shrink the ~7-day worst-case to hours is **explicitly deferred** (the cleanup hook +
webhooks cover ~all real cases; the auto-release covers the rest).

## Verification (automated)

- `back-end/src/tests/blackbox/purchases.part2.blackbox.ts` (new) — service-level lifecycle:
  cleared→capture, voided→cancel (un-captured) / refund (captured), close→cancel, cleanup
  cancel-unspent / capture-settled, and the idempotent-capture swallow.
- `purchases.blackbox.ts` — mint now asserts `capture_method: 'manual'` and no capture/cancel at
  mint time.
- Gate: `bash scripts/run-blackbox-tests.sh purchases` + `... purchases.part2` (both green),
  `tsc --noEmit`, `eslint`, structural invariants. No schema change (reuses the existing
  `PurchaseSpendStatus` enum).
