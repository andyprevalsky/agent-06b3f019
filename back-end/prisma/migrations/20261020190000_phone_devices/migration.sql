-- CreateTable
CREATE TABLE "PhoneDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "macDeviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'iphone_mirroring',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "holderKind" TEXT,
    "holderAgentId" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "resumeAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneDevice_userId_macDeviceId_key" ON "PhoneDevice"("userId", "macDeviceId");

-- AddForeignKey
ALTER TABLE "PhoneDevice" ADD CONSTRAINT "PhoneDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user scoping: clients only ever read their own phones; the backend
-- (service role) owns every write, including the exclusive-control lease.
ALTER TABLE "PhoneDevice" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can select own data" ON "PhoneDevice" FOR SELECT USING (((auth.uid())::text = "userId"));
