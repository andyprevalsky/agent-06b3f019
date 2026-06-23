/**
 * Passkey enroll PoC — Model A (cloud-custody) step 1.
 *
 * Launches a headed Chrome with a CDP *virtual authenticator* attached, so when
 * you add a passkey on your Amazon account the ceremony is fulfilled by a pure
 * software authenticator whose private key we can EXPORT (real hardware refuses).
 *
 * Flow:
 *   1. Attach virtual authenticator (resident key, user-verified, auto presence).
 *   2. You log into Amazon in the launched window and add a NEW passkey
 *      (Login & Security -> Passkeys -> Add a passkey). The virtual authenticator
 *      silently fulfills create().
 *   3. The script polls WebAuthn.getCredentials and, the moment an amazon.com
 *      resident credential appears, writes it to OUT_FILE and exits.
 *
 * Output: { credentialId, privateKey (b64 PKCS#8), rpId, userHandle, signCount,
 *           isResidentCredential } — the raw material we encrypt + store in prod.
 *
 * Run:  node scripts/passkey-enroll.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT_FILE = process.env.PASSKEY_OUT || '.context/passkey-enroll.json';
const RP_MATCH = (process.env.PASSKEY_RP || 'amazon.com').toLowerCase();
const START_URL = process.env.PASSKEY_START_URL || 'https://www.amazon.com/ax/account/manage';
const POLL_MS = 2000;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 min for you to log in + add the passkey

function log(...a) {
  console.log(`[enroll] ${new Date().toISOString()}`, ...a);
}

async function launch() {
  // Prefer real Chrome (less anti-bot friction); fall back to bundled Chromium.
  try {
    const b = await chromium.launch({ headless: false, channel: 'chrome' });
    log('launched real Chrome');
    return b;
  } catch (e) {
    log('chrome channel unavailable, using bundled chromium:', e.message);
    return chromium.launch({ headless: false });
  }
}

const browser = await launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);

await client.send('WebAuthn.enable', { enableUI: false });
const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
log('virtual authenticator attached:', authenticatorId);

await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('nav warn:', e.message));
log('=== ACTION NEEDED ===');
log('In the launched window: log into Amazon, then Login & Security -> Passkeys -> "Add a passkey".');
log(`Polling for a ${RP_MATCH} passkey every ${POLL_MS}ms (timeout ${TIMEOUT_MS / 60000}min)...`);

const deadline = Date.now() + TIMEOUT_MS;
let found = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  let creds;
  try {
    ({ credentials: creds } = await client.send('WebAuthn.getCredentials', { authenticatorId }));
  } catch (e) {
    log('getCredentials warn:', e.message);
    continue;
  }
  const match = (creds || []).find((c) => (c.rpId || '').toLowerCase().includes(RP_MATCH));
  if (match) {
    found = match;
    break;
  }
  if (creds && creds.length) {
    log(`have ${creds.length} credential(s) but none for ${RP_MATCH}: ${creds.map((c) => c.rpId).join(', ')}`);
  }
}

if (!found) {
  log('TIMEOUT — no passkey captured. Leaving browser open; re-run if needed.');
  process.exit(2);
}

const record = {
  credentialId: found.credentialId,
  privateKey: found.privateKey,
  rpId: found.rpId,
  userHandle: found.userHandle ?? null,
  signCount: found.signCount ?? 0,
  isResidentCredential: found.isResidentCredential ?? true,
  capturedAt: new Date().toISOString(),
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(record, null, 2));
log(`CAPTURED passkey for ${record.rpId} -> ${OUT_FILE}`);
log(`credentialId=${record.credentialId.slice(0, 16)}... signCount=${record.signCount} userHandle=${record.userHandle ? 'present' : 'null'}`);
log('Done. You can close the window.');
await browser.close().catch(() => {});
process.exit(0);
