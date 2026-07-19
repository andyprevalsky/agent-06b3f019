ALTER TABLE "PurchaseSpend" ADD COLUMN "canonicalFingerprint" TEXT;

CREATE INDEX "PurchaseSpend_userId_canonicalFingerprint_idx"
  ON "PurchaseSpend"("userId", "canonicalFingerprint");

-- Keep the one-time lazy backfill lookup proportional to this user's remaining
-- idempotency-sensitive legacy rows. Rows leave this partial index as soon as
-- they are indexed.
CREATE INDEX "PurchaseSpend_legacyFingerprintBackfill_idx"
  ON "PurchaseSpend"("userId", "createdAt")
  WHERE "canonicalFingerprint" IS NULL
    AND status IN ('PENDING_APPROVAL', 'CHARGING', 'HELD');
