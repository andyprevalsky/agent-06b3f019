ALTER TABLE "User" ADD COLUMN "deliveryRecipientName" TEXT;

UPDATE "User"
SET "deliveryRecipientName" = "name"
WHERE "name" IS NOT NULL
  AND (
    "addressLine1" IS NOT NULL
    OR "addressLine2" IS NOT NULL
    OR "city" IS NOT NULL
    OR "state" IS NOT NULL
    OR "postalCode" IS NOT NULL
  );

-- Correct the account that exposed the collapsed identity/recipient contract.
-- The guard keeps this migration from overwriting any later user correction.
UPDATE "User"
SET "name" = 'Andy Prevalsky'
WHERE "userId" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'
  AND "name" = 'Aman Gottumukkala';
