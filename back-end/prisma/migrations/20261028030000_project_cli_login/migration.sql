-- ProjectCliLogin: one-time CLI sign-in codes for `rose agent-init --login-code`
-- and the projects-scoped credential each code is exchanged for. Only SHA-256
-- hashes are stored. Additive: no existing row is rewritten.

-- CreateTable
CREATE TABLE "ProjectCliLogin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "exchangedAt" TIMESTAMP(3),
    "credentialHash" TEXT,
    "credentialExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCliLogin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCliLogin_codeHash_key" ON "ProjectCliLogin"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCliLogin_credentialHash_key" ON "ProjectCliLogin"("credentialHash");

-- CreateIndex
CREATE INDEX "ProjectCliLogin_userId_codeExpiresAt_idx" ON "ProjectCliLogin"("userId", "codeExpiresAt");

-- CreateIndex
CREATE INDEX "ProjectCliLogin_projectId_idx" ON "ProjectCliLogin"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectCliLogin" ADD CONSTRAINT "ProjectCliLogin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCliLogin" ADD CONSTRAINT "ProjectCliLogin_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backend-only: codes are minted and exchanged by the service role through the
-- API, so no client policy is granted (no client can read a hash).
ALTER TABLE "ProjectCliLogin" ENABLE ROW LEVEL SECURITY;
