ALTER TABLE "PurchaseSpend" ADD COLUMN "stripeLivemode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "stripeCustomerId" TEXT, ADD COLUMN "stripeSubscriptionId" TEXT;
