/**
 * Passkey login VERIFY — proves Amazon registered OUR key.
 *
 * Fresh browser (no cookies/password), a CDP virtual authenticator seeded with
 * the captured private key. You enter your Amazon email and choose "Sign in with
 * a passkey"; the virtual authenticator signs. We watch:
 *   - signCount 0 -> 1  => Amazon invoked get() against OUR credentialId (registered!)
 *   - logged-in DOM     => full end-to-end success
 *
 * Run: node scripts/passkey-verify-login.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const REC = JSON.parse(readFileSync(process.env.PASSKEY_IN || '.context/passkey-enroll.json', 'utf8'));
const log = (...a) => console.log(`[verify] ${new Date().toISOString()}`, ...a);

const browser = await chromium.launch({ headless: false, channel: 'chrome' }).catch(() => chromium.launch({ headless: false }));
const ctx = await browser.newContext();
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);

await client.send('WebAuthn.enable', { enableUI: false });
const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await client.send('WebAuthn.addCredential', {
  authenticatorId,
  credential: {
    credentialId: REC.credentialId,           // base64
    privateKey: REC.privateKey,               // base64 PKCS#8
    rpId: REC.rpId,                            // amazon.com
    userHandle: REC.userHandle ?? undefined,  // base64
    signCount: REC.signCount ?? 0,
    isResidentCredential: true,
  },
});
log(`seeded authenticator ${authenticatorId} with credential for ${REC.rpId} (signCount=${REC.signCount ?? 0})`);

await page.goto('https://www.amazon.com/ap/signin', { waitUntil: 'domcontentloaded' }).catch((e) => log('nav warn:', e.message));
log('=== ACTION NEEDED: in the window, enter your Amazon email and choose "Sign in with a passkey". ===');

const deadline = Date.now() + 8 * 60 * 1000;
let lastCount = REC.signCount ?? 0;
let usedSignal = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const { credentials } = await client.send('WebAuthn.getCredentials', { authenticatorId });
    const c = (credentials || []).find((x) => x.credentialId === REC.credentialId);
    if (c && c.signCount > lastCount) {
      usedSignal = true;
      log(`✅ signCount advanced ${lastCount} -> ${c.signCount} — Amazon invoked OUR passkey (registered & used).`);
      lastCount = c.signCount;
    }
  } catch (e) { /* page may be navigating */ }

  // logged-in heuristic: account greeting / nav present, off the signin page
  const url = page.url();
  let loggedIn = false;
  try {
    loggedIn = await page.evaluate(() => {
      const t = (document.querySelector('#nav-link-accountList-nav-line-1')?.textContent || '') + (document.querySelector('#nav-link-accountList')?.textContent || '');
      return /hello|hi,|account/i.test(t) && !/sign in/i.test(document.querySelector('#nav-link-accountList')?.textContent || 'sign in');
    });
  } catch (e) { /* */ }
  if (loggedIn && !/\/ap\/signin/.test(url)) {
    log(`✅✅ LOGGED IN via passkey. url=${url.slice(0, 60)} signCountUsed=${usedSignal}`);
    await browser.close().catch(() => {});
    process.exit(0);
  }
}

log(`TIMEOUT. passkeyUsed(signCount advanced)=${usedSignal}. If false, Amazon did not offer our credential (likely only the iCloud passkey is registered).`);
await browser.close().catch(() => {});
process.exit(usedSignal ? 0 : 2);
