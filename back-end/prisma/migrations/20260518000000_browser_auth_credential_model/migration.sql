-- Browser auth credential model.

ALTER TABLE "Cookie" ADD COLUMN "browserProfile" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BrowserPassword" ADD COLUMN "browserProfile" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BrowserPassword" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "BrowserPassword" ADD COLUMN "disabledReason" TEXT;

ALTER TABLE "Cookie" DROP CONSTRAINT IF EXISTS "Cookie_userId_domain_name_path_topFrameSiteKey_key";
ALTER TABLE "Cookie" DROP CONSTRAINT IF EXISTS "Cookie_userId_domain_name_path_topFrameSiteKey_browserSource_key";
ALTER TABLE "Cookie" ADD CONSTRAINT "Cookie_userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile_key"
  UNIQUE ("userId", domain, name, path, "topFrameSiteKey", "browserSource", "browserProfile");
CREATE INDEX "Cookie_userId_browserSource_browserProfile_idx" ON "Cookie"("userId", "browserSource", "browserProfile");

CREATE TABLE "CookieBundle" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authRealm" TEXT NOT NULL,
  "browserSource" TEXT NOT NULL,
  "browserProfile" TEXT NOT NULL DEFAULT '',
  "accountLabel" TEXT,
  "disabledAt" TIMESTAMP(3),
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CookieBundle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SteelSessionAuth" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contextId" TEXT NOT NULL,
  "authRealm" TEXT NOT NULL,
  "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt" TIMESTAMP(3),
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SteelSessionAuth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MintedAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authRealm" TEXT NOT NULL,
  "accountLabel" TEXT NOT NULL,
  "disabledAt" TIMESTAMP(3),
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MintedAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserAuthAssistanceRequest" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authRealm" TEXT NOT NULL,
  "steelSessionId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "UserAuthAssistanceRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRunCredentialPropagation" (
  "agentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRunCredentialPropagation_pkey" PRIMARY KEY ("agentId")
);

CREATE UNIQUE INDEX "CookieBundle_userId_authRealm_browserSource_browserProfile_key"
  ON "CookieBundle"("userId", "authRealm", "browserSource", "browserProfile");
CREATE INDEX "CookieBundle_userId_authRealm_idx" ON "CookieBundle"("userId", "authRealm");

CREATE UNIQUE INDEX "SteelSessionAuth_userId_contextId_authRealm_key"
  ON "SteelSessionAuth"("userId", "contextId", "authRealm");

CREATE UNIQUE INDEX "MintedAccount_userId_authRealm_key" ON "MintedAccount"("userId", "authRealm");
CREATE UNIQUE INDEX "AgentIdentity_userId_key" ON "AgentIdentity"("userId");
CREATE INDEX "UserAuthAssistanceRequest_agentId_idx" ON "UserAuthAssistanceRequest"("agentId");

ALTER TABLE "CookieBundle" ADD CONSTRAINT "CookieBundle_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SteelSessionAuth" ADD CONSTRAINT "SteelSessionAuth_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MintedAccount" ADD CONSTRAINT "MintedAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAuthAssistanceRequest" ADD CONSTRAINT "UserAuthAssistanceRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAuthAssistanceRequest" ADD CONSTRAINT "UserAuthAssistanceRequest_id_fkey"
  FOREIGN KEY ("id") REFERENCES "AgentAttentionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CookieBundle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SteelSessionAuth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MintedAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserAuthAssistanceRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRunCredentialPropagation" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own data" ON "CookieBundle" FOR SELECT
  USING (auth.uid()::text = "userId");
CREATE POLICY "Users can select own data" ON "SteelSessionAuth" FOR SELECT
  USING (auth.uid()::text = "userId");
CREATE POLICY "Users can select own data" ON "MintedAccount" FOR SELECT
  USING (auth.uid()::text = "userId");
CREATE POLICY "Users can select own data" ON "AgentIdentity" FOR SELECT
  USING (auth.uid()::text = "userId");
CREATE POLICY "Users can select own data" ON "UserAuthAssistanceRequest" FOR SELECT
  USING (auth.uid()::text = "userId");
