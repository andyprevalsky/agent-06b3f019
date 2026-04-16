/**
 * List all claude_code integrations, showing pool status and decrypted token prefix.
 * Usage: DATABASE_URL=... DIRECT_URL=... CLAUDE_CREDENTIAL_DECRYPTION_KEY=... npx tsx back-end/scripts/list-pool-integrations.ts
 */
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const decryptionKeyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!;
const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');

function decryptEnvelope(encryptedB64: string): string | null {
  try {
    const env = JSON.parse(Buffer.from(encryptedB64, 'base64').toString('utf8'));
    const aesKey = crypto.privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(env.encrypted_aes_key, 'base64')
    );
    const ctWithTag = Buffer.from(env.ciphertext, 'base64');
    const authTag = ctWithTag.subarray(ctWithTag.length - 16);
    const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

async function main() {
  const rows = await prisma.integration.findMany({
    where: { name: 'claude_code', status: 'CONNECTED' },
    orderBy: [{ poolingEnabled: 'desc' }, { updatedAt: 'desc' }],
  });
  console.log(`Found ${rows.length} CONNECTED claude_code integrations (DB: ${process.env.DATABASE_URL?.slice(0, 40)}...)`);
  for (const r of rows) {
    const cfg = r.config as any;
    const plain = cfg?.encryptedCredentials ? decryptEnvelope(cfg.encryptedCredentials) : null;
    let tokenPrefix = 'DECRYPT_FAIL';
    if (plain) {
      try {
        const p = JSON.parse(plain);
        tokenPrefix = p.claudeAiOauth?.accessToken?.slice(0, 45) ?? 'NO_TOKEN';
      } catch {}
    }
    console.log(
      `  id=${r.id.slice(0, 8)}  user=${r.userId.slice(0, 8)}  pool=${(r as any).poolingEnabled}  ` +
      `rl=${(r as any).rateLimitedUntil ? 'YES' : 'no'}  updated=${r.updatedAt.toISOString().slice(0, 19)}  token=${tokenPrefix}...`
    );
  }
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });
