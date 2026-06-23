/**
 * Passkey enroll PoC (CDP-attach variant) — connects to an ALREADY-RUNNING
 * Chrome that was launched with --remote-debugging-port, using a copy of the
 * user's real profile so they're already signed into Amazon.
 *
 * Why attach instead of launch-fresh: the user keeps their existing Amazon
 * session (no re-login). We still attach a CDP *virtual authenticator* so the
 * "Add a passkey" ceremony is fulfilled by software whose private key we can
 * export (a real platform passkey via Touch ID would be non-exportable).
 *
 * Prereq: Chrome running with:
 *   --remote-debugging-port=9222 --user-data-dir=<copy-of-profile>
 *
 * Run: node scripts/passkey-enroll-cdp.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CDP_URL = process.env.PASSKEY_CDP_URL || 'http://localhost:9222';
const OUT_FILE = process.env.PASSKEY_OUT || '.context/passkey-enroll.json';
const RP_MATCH = (process.env.PASSKEY_RP || 'amazon.com').toLowerCase();
const START_URL = process.env.PASSKEY_START_URL || 'https://www.amazon.com/ax/account/manage';
const POLL_MS = 2000;
const TIMEOUT_MS = 15 * 60 * 1000;

const log = (...a) => console.log(`[enroll-cdp] ${new Date().toISOString()}`, ...a);

const browser = await chromium.connectOverCDP(CDP_URL);
log('connected over CDP to', CDP_URL);

const ctx = browser.contexts()[0];
if (!ctx) throw new Error('no browser context found over CDP');
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
log('In the focused tab: Login & Security -> Passkeys -> "Add a passkey".');
log(`Polling for a ${RP_MATCH} passkey (timeout ${TIMEOUT_MS / 60000}min)...`);

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
  found = (creds || []).find((c) => (c.rpId || '').toLowerCase().includes(RP_MATCH));
  if (found) break;
  if (creds && creds.length) log(`have ${creds.length} cred(s), none for ${RP_MATCH}: ${creds.map((c) => c.rpId).join(', ')}`);
}

if (!found) {
  log('TIMEOUT — no passkey captured.');
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
// Leave the browser running (it's the user's session); just detach.
await browser.close().catch(() => {});
process.exit(0);
