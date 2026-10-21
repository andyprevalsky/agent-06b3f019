-- Server-only encrypted submitted-value vault; existing table RLS/ACL remains unchanged.
ALTER TABLE "IPhoneDevice" ADD COLUMN "privateInputEncrypted" TEXT;
