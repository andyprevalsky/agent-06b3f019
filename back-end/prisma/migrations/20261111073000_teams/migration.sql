-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "acceptedAt" TIMESTAMP(3),
    "inviteDeliveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "inviteMessageId" TEXT,
    "inviteTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamIntegrationShare" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT '',
    "accountEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamIntegrationShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamProjectShare" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamProjectShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Team_ownerUserId_idx" ON "Team"("ownerUserId");

-- CreateIndex
CREATE INDEX "TeamMember_email_status_idx" ON "TeamMember"("email", "status");

-- CreateIndex
CREATE INDEX "TeamMember_userId_status_idx" ON "TeamMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_email_key" ON "TeamMember"("teamId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "TeamIntegrationShare_ownerUserId_provider_accountId_idx" ON "TeamIntegrationShare"("ownerUserId", "provider", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamIntegrationShare_teamId_integrationId_accountId_key" ON "TeamIntegrationShare"("teamId", "integrationId", "accountId");

-- CreateIndex
CREATE INDEX "TeamProjectShare_ownerUserId_idx" ON "TeamProjectShare"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamProjectShare_teamId_projectId_key" ON "TeamProjectShare"("teamId", "projectId");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIntegrationShare" ADD CONSTRAINT "TeamIntegrationShare_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIntegrationShare" ADD CONSTRAINT "TeamIntegrationShare_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamProjectShare" ADD CONSTRAINT "TeamProjectShare_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamProjectShare" ADD CONSTRAINT "TeamProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A revoked/deleted membership owns its grants; rejoining cannot resurrect them.
ALTER TABLE "TeamIntegrationShare" ADD CONSTRAINT "TeamIntegrationShare_teamId_ownerUserId_fkey" FOREIGN KEY ("teamId", "ownerUserId") REFERENCES "TeamMember"("teamId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamProjectShare" ADD CONSTRAINT "TeamProjectShare_teamId_ownerUserId_fkey" FOREIGN KEY ("teamId", "ownerUserId") REFERENCES "TeamMember"("teamId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Team access is mediated by the authenticated backend. Public/PostgREST clients
-- get no implicit access to rosters or grant records (service role bypasses RLS).
ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamIntegrationShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamProjectShare" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_status_check" CHECK ("status" IN ('INVITED', 'ACCEPTED'));
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_role_check" CHECK ("role" IN ('OWNER', 'MEMBER'));
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_acceptance_check" CHECK ("status" <> 'ACCEPTED' OR "userId" IS NOT NULL);
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_invite_email_check" CHECK ("status" <> 'INVITED' OR "email" IS NOT NULL);

