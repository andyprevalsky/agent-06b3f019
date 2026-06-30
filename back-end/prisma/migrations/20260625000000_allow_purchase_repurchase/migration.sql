-- Allow re-purchasing the same cart: drop the all-time unique on (userId, fingerprint).
-- A completed/consumed purchase no longer blocks a fresh one for the identical cart. Idempotency
-- for in-flight retries is enforced in application logic (status checks + a per-row Stripe
-- idempotency key) and the 24h reuse window, not a DB constraint.
DROP INDEX "PurchaseSpend_userId_fingerprint_key";
CREATE INDEX "PurchaseSpend_userId_fingerprint_idx" ON "PurchaseSpend"("userId", "fingerprint");
