-- Per-root trace-archive manifest lease. Replaces a transaction-held advisory
-- lock that pinned a pooled connection across R2 storage I/O.
CREATE TABLE IF NOT EXISTS "TraceArchiveManifestLease" (
    "rootAgentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceArchiveManifestLease_pkey" PRIMARY KEY ("rootAgentId")
);

CREATE INDEX IF NOT EXISTS "TraceArchiveManifestLease_expiresAt_idx" ON "TraceArchiveManifestLease"("expiresAt");

ALTER TABLE "TraceArchiveManifestLease" ENABLE ROW LEVEL SECURITY;
