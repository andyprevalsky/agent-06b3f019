/**
 * Passkey login VERIFY — THROUGH STEEL (the cloud browser the agent uses).
 *
 * Creates a Steel session, connects Playwright over Steel's CDP websocket, seeds
 * a virtual authenticator with the captured private key (exactly the path the
 * agent's dom_service will use), and opens Amazon sign-in. You drive the email +
 * "Sign in with a passkey" via Steel's interactive live view; the seeded
 * authenticator signs in the cloud browser.
 *
 * Proves: stored passkey + cloud browser (Steel) -> Amazon login. No local Chrome.
 *
 * Run: node scripts/passkey-verify-steel.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const REC = JSON.parse(readFileSync(process.env.PASSKEY_IN || '.context/passkey-enroll.json', 'utf8'));
const API_KEY = process.env.STEEL_API_KEY;
if (!API_KEY) throw new Error('STEEL_API_KEY env required');
const log = (...a) => console.log(`[verify-steel] ${new Date().toISOString()}`, ...a);

async function steel(path, method = 'POST', body) {
  const res = await fetch(`https://api.steel.dev/v1${path}`, {
    method,
    headers: { 'Steel-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`steel ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

const session = await steel('/sessions', 'POST', { solveCaptcha: true, dimensions: { width: 1288, height: 891 } });
const sessionId = session.id;
const wsUrl = `wss://connect.steel.dev?apiKey=${API_KEY}&sessionId=${sessionId}`;
const interactiveUrl = `${session.debugUrl}?interactive=true`;
log(`Steel session ${sessionId} live`);

await (async () => {
let browser;
try {
  browser = await chromium.connectOverCDP(wsUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());
  const client = await ctx.newCDPSession(page);

  await client.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await client.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: REC.credentialId,
      privateKey: REC.privateKey,
      rpId: REC.rpId,
      userHandle: REC.userHandle ?? undefined,
      signCount: REC.signCount ?? 0,
      isResidentCredential: true,
    },
  });
  log(`seeded virtual authenticator on STEEL (signCount=${REC.signCount ?? 0})`);

  await page.goto('https://www.amazon.com/ap/signin', { waitUntil: 'domcontentloaded' }).catch((e) => log('nav warn:', e.message));
  log('===========================================================');
  log('OPEN THIS INTERACTIVE LIVE VIEW AND DRIVE THE LOGIN:');
  log(interactiveUrl);
  log('-> enter your Amazon email, choose "Sign in with a passkey".');
  log('===========================================================');

  const deadline = Date.now() + 8 * 60 * 1000;
  let lastCount = REC.signCount ?? 0;
  let used = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const { credentials } = await client.send('WebAuthn.getCredentials', { authenticatorId });
      const c = (credentials || []).find((x) => x.credentialId === REC.credentialId);
      if (c && c.signCount > lastCount) { used = true; log(`✅ signCount ${lastCount} -> ${c.signCount}: Amazon used OUR passkey on Steel.`); lastCount = c.signCount; }
    } catch {}
    let loggedIn = false, url = '';
    try {
      url = page.url();
      loggedIn = await page.evaluate(() => {
        const a = document.querySelector('#nav-link-accountList');
        return !!a && !/sign in/i.test(a.textContent || 'sign in');
      });
    } catch {}
    if (loggedIn && !/\/ap\/signin/.test(url)) {
      log(`✅✅ LOGGED IN via passkey on Steel. url=${url.slice(0, 60)} passkeyUsed=${used}`);
      return;
    }
  }
  log(`TIMEOUT. passkeyUsed(signCount advanced)=${used}.`);
  process.exitCode = used ? 0 : 2;
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { await steel(`/sessions/${sessionId}/release`, 'POST'); log('released Steel session'); } catch (e) { log('release warn:', e.message); }
}
})();
