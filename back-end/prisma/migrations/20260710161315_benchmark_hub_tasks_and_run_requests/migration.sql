-- Idempotent: an accidental db push (directUrl from .env) already created
-- these tables on prod before this migration ships; IF NOT EXISTS lets
-- migrate deploy apply cleanly on both fresh and already-patched DBs.
-- CreateTable
CREATE TABLE IF NOT EXISTS "BenchmarkTask" (
    "name" TEXT NOT NULL,
    "title" TEXT,
    "prompt" TEXT NOT NULL,
    "status" TEXT,
    "bench" TEXT,
    "runner" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeoutSeconds" INTEGER,
    "priceLimitCents" INTEGER,
    "expectedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minAgentCount" INTEGER,
    "isChatMode" BOOLEAN NOT NULL DEFAULT false,
    "environment" JSONB,
    "evaluators" JSONB,
    "source" JSONB,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BenchmarkTask_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BenchmarkRunRequest" (
    "id" TEXT NOT NULL,
    "taskNames" TEXT[],
    "simOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedBy" TEXT NOT NULL,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "progress" JSONB,
    "runId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkRunRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BenchmarkTask_bench_idx" ON "BenchmarkTask"("bench");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BenchmarkTask_status_idx" ON "BenchmarkTask"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BenchmarkRunRequest_status_createdAt_idx" ON "BenchmarkRunRequest"("status", "createdAt");

