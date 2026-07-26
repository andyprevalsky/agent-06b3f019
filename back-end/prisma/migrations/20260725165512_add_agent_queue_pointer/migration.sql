-- CreateTable
CREATE TABLE "AgentQueuePointer" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "taskQueue" TEXT NOT NULL,
    "surfaceHash" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentQueuePointer_pkey" PRIMARY KEY ("id")
);

