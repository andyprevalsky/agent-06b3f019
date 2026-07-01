-- Fast Mode aggressive cache: record/replay store for third-party responses.
-- Entries live forever (no TTL); re-record is a manual purge by goalHash.
CREATE TABLE "FastModeCacheEntry" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "goalHash" TEXT NOT NULL,
    "value" JSONB,
    "blobPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FastModeCacheEntry_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "FastModeCacheEntry_goalHash_idx" ON "FastModeCacheEntry"("goalHash");
CREATE INDEX "FastModeCacheEntry_kind_idx" ON "FastModeCacheEntry"("kind");

-- Per-agent Fast Mode flag so the chat→escalate path (which starts the workflow from
-- the persisted row, not the create payload) still enables record/replay.
ALTER TABLE "Agent" ADD COLUMN "fastModeCacheEnabled" BOOLEAN NOT NULL DEFAULT false;
