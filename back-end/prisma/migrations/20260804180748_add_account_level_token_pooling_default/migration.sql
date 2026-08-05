-- Account-level compute-token pooling default.
--
-- `User.poolTokensByDefault` is the account policy: when true, every compute
-- credential the account syncs (claude_code / gpt_code) lands pool-eligible.
-- `Integration.poolingEnabledOverride` records an EXPLICIT per-integration
-- choice (null = inherit the account default); it always wins over the account
-- policy, so an operator can keep one token out of the pool even when the
-- owning account defaults to pooling.
--
-- `Integration.poolingEnabled` stays the materialized effective value that
-- every pool reader already selects on — no reader changes required.

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "poolingEnabledOverride" BOOLEAN;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "poolTokensByDefault" BOOLEAN NOT NULL DEFAULT false;
