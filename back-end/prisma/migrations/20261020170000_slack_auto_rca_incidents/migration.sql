-- CreateTable
CREATE TABLE "SlackAutoRcaIncident" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "slackChannel" TEXT NOT NULL,
    "slackThreadTs" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "appendedCount" INTEGER NOT NULL DEFAULT 0,
    "startNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackAutoRcaIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackAutoRcaEvent" (
    "eventId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slackChannel" TEXT NOT NULL,
    "slackTs" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackAutoRcaEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackAutoRcaIncident_agentId_key" ON "SlackAutoRcaIncident"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackAutoRcaIncident_signature_windowStart_key" ON "SlackAutoRcaIncident"("signature", "windowStart");

-- CreateIndex
CREATE INDEX "SlackAutoRcaEvent_slackChannel_slackTs_idx" ON "SlackAutoRcaEvent"("slackChannel", "slackTs");

-- CreateIndex
CREATE INDEX "SlackAutoRcaEvent_incidentId_idx" ON "SlackAutoRcaEvent"("incidentId");


-- Backend-only bookkeeping: the service role owns every read and write, so
-- no client policy is granted.
ALTER TABLE "SlackAutoRcaIncident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SlackAutoRcaEvent" ENABLE ROW LEVEL SECURITY;
