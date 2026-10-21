-- Encrypted setup state inherits existing private phone table RLS and ACL.
ALTER TABLE "IPhoneDevice" ADD COLUMN "setupEncrypted" TEXT;
