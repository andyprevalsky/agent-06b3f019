/**
 * Sync pool tokens to a DB: ensure exactly the target tokens are poolingEnabled=true,
 * disable pooling on all other claude_code integrations, and clear their rateLimitedUntil.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... CLAUDE_CREDENTIAL_DECRYPTION_KEY=... \
 *   TARGET_TOKENS="sk-ant-oat01-AAA,sk-ant-oat01-BBB" \
 *   npx tsx back-end/scripts/sync-pool-tokens.ts [--apply]
 *
 * Without --apply this runs as a dry-run and prints the plan.
 */
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const decryptionKeyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!;
const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');
const targetTokens = (process.env.TARGET_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const apply = process.argv.includes('--apply');

if (targetTokens.length === 0) {
  console.error('TARGET_TOKENS env var required (comma-separated)');
  process.exit(1);
}

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
  } catch {
    return null;
  }
}

function encryptEnvelope(plaintext: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertextWithTag = Buffer.concat([ct, authTag]);
  const pubKey = crypto.createPublicKey(privateKeyPem);
  const encAesKey = crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  const envelope = {
    version: 1,
    encrypted_aes_key: encAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertextWithTag.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

function reEncryptWithToken(existingEncrypted: string, newToken: string): string {
  const oldPlain = decryptEnvelope(existingEncrypted);
  if (!oldPlain) throw new Error('Could not decrypt existing envelope to carry over non-token fields');
  const parsed = JSON.parse(oldPlain);
  if (!parsed.claudeAiOauth) parsed.claudeAiOauth = {};
  parsed.claudeAiOauth.accessToken = newToken;
  return encryptEnvelope(JSON.stringify(parsed));
}

async function main() {
  const dbLabel = process.env.DATABASE_URL?.slice(0, 60);
  console.log(`DB: ${dbLabel}...`);
  console.log(`Targets (${targetTokens.length}):`);
  targetTokens.forEach((t) => console.log(`  - ${t.slice(0, 45)}...`));
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (pass --apply to execute)'}`);
  console.log('');

  const rows = await prisma.integration.findMany({
    where: { name: 'claude_code' },
    orderBy: [{ poolingEnabled: 'desc' }, { updatedAt: 'desc' }],
  });
  console.log(`Found ${rows.length} claude_code integrations`);

  type Decoded = {
    id: string;
    userId: string;
    status: string;
    pooling: boolean;
    rateLimited: Date | null;
    token: string | null;
    decryptOk: boolean;
  };
  const decoded: Decoded[] = rows.map((r) => {
    const cfg = r.config as any;
    const plain = cfg?.encryptedCredentials ? decryptEnvelope(cfg.encryptedCredentials) : null;
    let token: string | null = null;
    if (plain) {
      try {
        token = JSON.parse(plain)?.claudeAiOauth?.accessToken ?? null;
      } catch {}
    }
    return {
      id: r.id,
      userId: r.userId,
      status: r.status,
      pooling: (r as any).poolingEnabled,
      rateLimited: (r as any).rateLimitedUntil,
      token,
      decryptOk: plain !== null,
    };
  });

  const decryptFails = decoded.filter((d) => !d.decryptOk).length;
  console.log(`Decrypt failures: ${decryptFails}/${decoded.length}`);
  if (decryptFails === decoded.length) {
    console.error('ALL rows failed to decrypt — wrong CLAUDE_CREDENTIAL_DECRYPTION_KEY. Aborting.');
    process.exit(1);
  }

  const matchesTarget = (t: string | null) => (t ? targetTokens.includes(t) : false);

  const alreadyCorrect = decoded.filter((d) => matchesTarget(d.token));
  const reusablePoolSlots = decoded.filter(
    (d) => d.pooling && d.decryptOk && !matchesTarget(d.token)
  );
  const present = new Set(alreadyCorrect.map((d) => d.token!));
  const missing = targetTokens.filter((t) => !present.has(t));

  const replacements: { slot: Decoded; token: string }[] = [];
  const remainingSlots = [...reusablePoolSlots];
  for (const token of missing) {
    const slot = remainingSlots.shift();
    if (slot) replacements.push({ slot, token });
  }
  const stillMissing = missing.slice(replacements.length);
  const extrasToDisable = remainingSlots;

  console.log('');
  console.log(`Already correct (pool=true, token matches target): ${alreadyCorrect.length}`);
  alreadyCorrect.forEach((d) => {
    console.log(
      `  id=${d.id.slice(0, 8)} user=${d.userId.slice(0, 8)} pool=${d.pooling} rl=${d.rateLimited ? 'YES' : 'no'} token=${d.token!.slice(0, 45)}`
    );
  });

  console.log('');
  console.log(`Will REPLACE token + enable pool + clear rate-limit on ${replacements.length} rows:`);
  replacements.forEach((r) => {
    console.log(
      `  id=${r.slot.id.slice(0, 8)} user=${r.slot.userId.slice(0, 8)} old=${r.slot.token?.slice(0, 25) ?? 'NO_TOKEN'}... → new=${r.token.slice(0, 25)}...`
    );
  });

  console.log('');
  console.log(`Will DISABLE pool on ${extrasToDisable.length} extra rows:`);
  extrasToDisable.forEach((d) => {
    console.log(
      `  id=${d.id.slice(0, 8)} user=${d.userId.slice(0, 8)} token=${d.token?.slice(0, 45) ?? 'NO_TOKEN'}`
    );
  });

  if (stillMissing.length > 0) {
    console.log('');
    console.log(`STILL MISSING (no pool slot to replace): ${stillMissing.length}`);
    stillMissing.forEach((t) => console.log(`  - ${t.slice(0, 45)}...`));
    console.log('  → not enough existing pool rows to absorb all targets; create rows manually.');
  }

  if (!apply) {
    console.log('\nDry-run complete. Pass --apply to execute.');
    return;
  }

  console.log('\nApplying changes...');
  for (const d of alreadyCorrect) {
    if (!d.pooling || d.rateLimited) {
      await prisma.integration.update({
        where: { id: d.id },
        data: { poolingEnabled: true, rateLimitedUntil: null } as any,
      });
      console.log(`  ensured pool/clearRL: ${d.id.slice(0, 8)}`);
    }
  }
  for (const r of replacements) {
    const row = await prisma.integration.findUnique({ where: { id: r.slot.id } });
    const cfg = (row!.config as any) ?? {};
    const newEncrypted = reEncryptWithToken(cfg.encryptedCredentials, r.token);
    await prisma.integration.update({
      where: { id: r.slot.id },
      data: {
        config: { ...cfg, encryptedCredentials: newEncrypted },
        poolingEnabled: true,
        rateLimitedUntil: null,
      } as any,
    });
    console.log(`  replaced: ${r.slot.id.slice(0, 8)} → ${r.token.slice(0, 25)}...`);
  }
  for (const d of extrasToDisable) {
    await prisma.integration.update({
      where: { id: d.id },
      data: { poolingEnabled: false, rateLimitedUntil: null } as any,
    });
    console.log(`  disabled: ${d.id.slice(0, 8)}`);
  }
  console.log('Done.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
