-- A root soft-delete and its terminal R2 archive must converge even when the
-- first storage attempt fails or the backend exits between the two operations.
CREATE TABLE IF NOT EXISTS "TraceArchiveFinalization" (
    "rootAgentId" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceArchiveFinalization_pkey" PRIMARY KEY ("rootAgentId"),
    CONSTRAINT "TraceArchiveFinalization_rootAgentId_fkey"
      FOREIGN KEY ("rootAgentId") REFERENCES "Agent"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TraceArchiveFinalization_notBefore_rootAgentId_idx"
ON "TraceArchiveFinalization"("notBefore", "rootAgentId");

CREATE INDEX IF NOT EXISTS "TraceArchiveFinalization_leaseUntil_idx"
ON "TraceArchiveFinalization"("leaseUntil");
