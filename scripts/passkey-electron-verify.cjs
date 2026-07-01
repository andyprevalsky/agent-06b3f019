/**
 * Electron verify harness (v2) — JS software-authenticator injection.
 *
 * The CDP virtual authenticator crashes Electron on create() (SIGABRT). Instead
 * we inject the same pure-WebCrypto override the user proved on Amazon: it
 * replaces navigator.credentials.create with an in-page software authenticator
 * that mints an EXPORTABLE P-256 key. No native WebAuthn, no CDP -> no crash.
 *
 * Run: mac-app/node_modules/.bin/electron scripts/passkey-electron-verify.cjs
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const RP_ID = 'example.com';
const START_URL = 'https://example.com';
const OVERRIDE_JS = readFileSync(join(__dirname, 'passkey-console-enroll.js'), 'utf8');

const { writeFileSync } = require('node:fs');
const RESULT_FILE = join(__dirname, '..', '.context', 'electron-verify-result.json');
const steps = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  steps.push(line);
  console.log('[electron-verify]', line);
  // Persist after every step so a hang/crash still leaves a breadcrumb trail.
  try {
    writeFileSync(RESULT_FILE, JSON.stringify({ steps }, null, 2));
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CREATE_SCRIPT = `(async () => {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: '${RP_ID}', name: 'verify' },
      user: { id: crypto.getRandomValues(new Uint8Array(8)), name: 'agent@verify', displayName: 'agent' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 60000, attestation: 'none',
    }});
    return { ok: true, id: cred.id };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`;

app.whenReady().then(async () => {
  const hardTimeout = setTimeout(() => {
    log('❌ self-timeout (stuck)');
    app.exit(3);
  }, 30000);
  log('whenReady fired');
  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  let exit = 1;
  try {
    log('loading', START_URL);
    await win.loadURL(START_URL);
    log('loaded');
    await sleep(800);

    // Install the software-authenticator override on the live page.
    await win.webContents.executeJavaScript(OVERRIDE_JS);
    log('override installed');

    const created = await win.webContents.executeJavaScript(CREATE_SCRIPT);
    log('create() result:', created);

    const capture = await win.webContents.executeJavaScript('window.__PASSKEY_CAPTURE ?? null');
    if (capture && typeof capture.privateKey === 'string' && capture.privateKey.length > 0) {
      log('✅ PROVEN: injected software authenticator minted an exportable key in Electron.');
      log(`   rpId=${capture.rpId} credIdLen=${capture.credentialId.length} pkLen=${capture.privateKey.length}`);
      exit = 0;
    } else {
      log('❌ no capture:', JSON.stringify(capture));
    }
  } catch (e) {
    log('❌ error:', e && e.message ? e.message : String(e));
  } finally {
    clearTimeout(hardTimeout);
    app.exit(exit);
  }
});
