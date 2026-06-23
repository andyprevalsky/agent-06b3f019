-- Cloud-custody passkey credential (Model A). Private key stored encrypted at
-- rest; signCount advanced via atomic block reservation at agent session start.
CREATE TABLE IF NOT EXISTS "PasskeyCredential" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "authRealm"           TEXT NOT NULL,
  "rpId"                TEXT NOT NULL,
  "credentialId"        TEXT NOT NULL,
  "encryptedPrivateKey" TEXT NOT NULL,
  "userHandle"          TEXT,
  "signCount"           BIGINT NOT NULL DEFAULT 0,
  "origin"              TEXT,
  "browserSource"       TEXT NOT NULL DEFAULT 'cdp_virtual',
  "disabledAt"          TIMESTAMP(3),
  "disabledReason"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasskeyCredential_userId_rpId_credentialId_key"
  ON "PasskeyCredential"("userId", "rpId", "credentialId");

CREATE INDEX IF NOT EXISTS "PasskeyCredential_userId_idx"
  ON "PasskeyCredential"("userId");

CREATE INDEX IF NOT EXISTS "PasskeyCredential_userId_authRealm_idx"
  ON "PasskeyCredential"("userId", "authRealm");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PasskeyCredential_userId_fkey'
  ) THEN
    ALTER TABLE "PasskeyCredential"
      ADD CONSTRAINT "PasskeyCredential_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("userId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS: mirror the browser-auth credential family. Service-role backend bypasses
-- RLS; this restricts any anon/auth client to its own rows.
ALTER TABLE "PasskeyCredential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can select own data" ON "PasskeyCredential";
CREATE POLICY "Users can select own data" ON "PasskeyCredential" FOR SELECT
  USING (auth.uid()::text = "userId");
