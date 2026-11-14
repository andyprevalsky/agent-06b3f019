// Read-only helper for skill replays: load one prod compute token by Integration id prefix.
// Run from back-end/ after copying it there (imports resolve against back-end/src):
//   cp <this> back-end/tmp-prod-token.ts && (cd back-end && npx tsx tmp-prod-token.ts --id <prefix> [--print-token]); rm back-end/tmp-prod-token.ts
// Without --print-token it prints only the row's id prefix, flags and expiry; never log the token.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { decryptCredentialEnvelope } from "./src/providers/claudeCredentials";
import {
  parseClaudeEnvelope,
  claudeEnvelopeExpiredAt,
} from "./src/providers/claudeOauthEnvelope";

const prisma = new PrismaClient();
async function main() {
  const prefix = process.argv[process.argv.indexOf("--id") + 1];
  if (!prefix || prefix.startsWith("--"))
    throw new Error("--id <integration id prefix> is required");
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return tx.integration.findMany({
      where: {
        name: "claude_code",
        status: "CONNECTED",
        id: { startsWith: prefix },
      },
      select: {
        id: true,
        poolingEnabled: true,
        rateLimitedUntil: true,
        config: true,
      },
    });
  });
  if (rows.length !== 1)
    throw new Error(
      `expected one claude_code integration for ${prefix}, found ${rows.length}`,
    );
  const enc = (rows[0].config as Record<string, unknown> | null)
    ?.encryptedCredentials as string | undefined;
  const dec = enc
    ? decryptCredentialEnvelope(
        enc,
        process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY ?? "",
      )
    : null;
  const envelope = dec ? parseClaudeEnvelope(dec) : null;
  if (!envelope?.accessToken) throw new Error("no decryptable access token");
  const expired = claudeEnvelopeExpiredAt(envelope, Date.now());
  if (expired !== null)
    throw new Error(
      `access token expired at ${new Date(expired).toISOString()}`,
    );
  if (process.argv.includes("--print-token"))
    process.stdout.write(envelope.accessToken);
  else
    console.log(
      prefix,
      "pool",
      rows[0].poolingEnabled,
      "rateLimitedUntil",
      rows[0].rateLimitedUntil?.toISOString() ?? "-",
      "access token valid by expiry",
    );
}
main().finally(() => prisma.$disconnect());
