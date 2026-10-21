ALTER TABLE "BrowserSession"
  ALTER COLUMN "sessionId" DROP NOT NULL,
  ADD COLUMN "logicalOwnerKey" TEXT,
  ADD COLUMN "baselineCheckpointRef" TEXT,
  ADD COLUMN "checkpointRef" TEXT,
  ADD COLUMN "checkpointRevision" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "BrowserSession_logicalOwnerKey_key"
  ON "BrowserSession"("logicalOwnerKey");
ALTER TABLE "BrowserSession"
  ADD CONSTRAINT "BrowserSession_checkpoint_revision_check"
    CHECK ("checkpointRevision" >= 0 AND
      ("checkpointRevision" = 0 OR "checkpointRef" IS NOT NULL)),
  ADD CONSTRAINT "BrowserSession_logical_baseline_check"
    CHECK ("logicalOwnerKey" IS NULL OR
      (("logicalOwnerKey" LIKE 'agent:%' OR "logicalOwnerKey" LIKE 'home:%') AND
       "baselineCheckpointRef" IS NOT NULL)),
  ADD CONSTRAINT "BrowserSession_unmaterialized_check"
    CHECK ("sessionId" IS NOT NULL OR
      ("logicalOwnerKey" IS NOT NULL AND "status"::text IN ('PAUSED', 'ERROR', 'CLOSED')));

ALTER TABLE "BrowserSiteState"
  ADD COLUMN "authVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "authBundleCiphertext" TEXT,
  ADD COLUMN "authRevokedAt" TIMESTAMP(3),
  ADD COLUMN "authTransferability" TEXT;
ALTER TABLE "BrowserSiteState"
  ADD CONSTRAINT "BrowserSiteState_verified_auth_check"
    CHECK (
      ("authVerifiedAt" IS NULL AND "authBundleCiphertext" IS NULL AND
       "authRevokedAt" IS NULL AND "authTransferability" IS NULL)
      OR
      ("authVerifiedAt" IS NOT NULL AND "account" LIKE 'verified:%' AND
       "authTransferability" IS NOT NULL AND
       "authTransferability" IN ('reusable', 'device_bound', 'session_bound') AND
       (("authRevokedAt" IS NULL AND "authBundleCiphertext" IS NOT NULL) OR
        ("authRevokedAt" IS NOT NULL AND "authBundleCiphertext" IS NULL)))
    );

ALTER TABLE "BrowserSiteFork"
  ADD COLUMN "credentialAccountKey" TEXT,
  ADD COLUMN "credentialAppliedRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "credentialPendingRevision" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "BrowserSiteFork_userId_site_credentialAccountKey_idx"
  ON "BrowserSiteFork"("userId", "site", "credentialAccountKey");
ALTER TABLE "BrowserSiteFork"
  ADD CONSTRAINT "BrowserSiteFork_credential_revision_check"
    CHECK ("credentialAppliedRevision" >= 0 AND
      "credentialPendingRevision" >= "credentialAppliedRevision" AND
      ("credentialAccountKey" IS NOT NULL OR
       ("credentialAppliedRevision" = 0 AND "credentialPendingRevision" = 0))),
  ADD CONSTRAINT "BrowserSiteFork_credential_account_check"
    CHECK ("credentialAccountKey" IS NULL OR "credentialAccountKey" LIKE 'verified:%'),
  ADD CONSTRAINT "BrowserSiteFork_userId_site_credentialAccountKey_fkey"
    FOREIGN KEY ("userId", "site", "credentialAccountKey")
    REFERENCES "BrowserSiteState"("userId", "site", "account")
    ON DELETE RESTRICT ON UPDATE CASCADE;
