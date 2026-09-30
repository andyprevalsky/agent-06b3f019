ALTER TABLE "GoogleDataPurge" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "GoogleDataPurge" ADD COLUMN "revocationToken" TEXT;

ALTER TABLE "UserDataDocument" ADD COLUMN "googleAccountEmail" TEXT;
ALTER TABLE "UserSnapshotRevision" ADD COLUMN "googleAccountEmail" TEXT;

CREATE INDEX "UserDataDocument_userId_source_googleAccountEmail_idx"
    ON "UserDataDocument"("userId", "source", "googleAccountEmail");
CREATE INDEX "UserSnapshotRevision_userId_source_googleAccountEmail_idx"
    ON "UserSnapshotRevision"("userId", "source", "googleAccountEmail");
