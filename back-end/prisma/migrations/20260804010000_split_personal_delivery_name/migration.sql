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
