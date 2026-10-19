-- One phone number belongs to one account. Anonymous sessions used to store
-- the token's blank phone claim (''), which would collide on the new index;
-- a blank phone means "no phone", so store it as NULL first.
UPDATE "User" SET "phone" = NULL WHERE btrim("phone") = '';

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
