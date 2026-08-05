/**
 * WhatsApp live pairing harness — headless, no Electron build required.
 *
 * Drives the REAL messaging-whatsapp domain (WhatsAppSync → WhatsAppClient →
 * Baileys → normalize → BatchUploader → backend), so what you pair here is
 * exactly the code the packaged app runs. The only thing faked is Electron
 * itself: `app.getPath('userData')` is redirected to a harness-local dir so
 * electron-store and the Baileys auth state have somewhere to live.
 *
 * It prints the pairing QR straight into the terminal and narrates every
 * meaningful event (QR, connect, 515 restarts, credential writes, history
 * batches, normalized messages, uploads + backend status).
 *
 * Usage:  bash scripts/whatsapp-live.sh        (from repo root — handles env + backend)
 *
 * Env:
 *   VITE_BACKEND_API_URL   backend base URL (default http://localhost:3001)
 *   WA_HARNESS_DIR         state dir (default mac-app/.whatsapp-harness)
 *   WA_RESET=1             wipe stored credentials first, forcing a fresh QR
 *   WA_ACCESS_TOKEN        bearer token to reuse; else backend phone-OTP sign-in runs
 *   WA_PHONE / WA_OTP      test phone + OTP (defaults to the repo test user)
 */
import fs from 'fs';
import path from 'path';
import Module from 'module';

const HARNESS_DIR = process.env.WA_HARNESS_DIR ?? path.join(__dirname, '..', '.whatsapp-harness');
fs.mkdirSync(HARNESS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron stub. MUST be installed before any domain import: base/config and
// the auth/whatsapp repos read app.getPath()/app.isPackaged at module load.
// ---------------------------------------------------------------------------
const electronStub = {
  app: {
    getPath: (): string => HARNESS_DIR,
    getName: (): string => 'rose-whatsapp-harness',
    getVersion: (): string => '0.0.0-harness',
    isPackaged: false,
    on: (): void => {},
    quit: (): void => {},
  },
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  BrowserWindow: class {},
  shell: { openExternal: async (): Promise<void> => {} },
  globalShortcut: { register: (): void => {}, unregisterAll: (): void => {} },
  safeStorage: { isEncryptionAvailable: (): boolean => false },
};

interface LoaderModule {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as LoaderModule;
const originalLoad = loader._load.bind(loader);
loader._load = (request: string, parent: unknown, isMain: boolean): unknown => {
  if (request === 'electron') return electronStub;
  return originalLoad(request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Logging — everything lands in a tail-able file as well as stdout.
// ---------------------------------------------------------------------------
const LOG_PATH = path.join(HARNESS_DIR, 'whatsapp-live.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

// Captured before the console override below so harness lines are written to
// the log exactly once (say() writes the file itself).
const rawLog = console.log.bind(console);

function say(tag: string, message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  const line = `[${stamp()}] [${tag}] ${message}${suffix}`;
  rawLog(line);
  logStream.write(`${line}\n`);
}

// Mirror the domain's own console output into the same file, so the log holds
// the full story rather than only what this harness chooses to print.
for (const level of ['log', 'error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // Domain logs are '[Component] ...'; anything else is noise we don't file.
    if (text.startsWith('[')) logStream.write(`[${stamp()}] ${text}\n`);
    original(...args);
  };
}

/**
 * Hard cap on pairing cycles. Each cycle is a fresh device-link request to
 * WhatsApp; an unbounded loop left running unattended will get the account
 * temporarily blocked from linking devices. ~10 cycles ≈ a 10-minute window,
 * which is about as long as a human will stand in front of a QR code.
 */
const MAX_QR_CYCLES = Number(process.env.WHATSAPP_MAX_QR_CYCLES ?? 10);
const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

const QR_PNG_PATH = path.join(HARNESS_DIR, 'qr.png');
const STATUS_PATH = path.join(HARNESS_DIR, 'status.json');

/** Publish harness state so an external watcher knows when to re-read the PNG. */
function writeStatus(patch: { state: string; qrCount: number }): void {
  fs.writeFileSync(
    STATUS_PATH,
    JSON.stringify({ ...patch, updatedAt: new Date().toISOString() }, null, 2)
  );
}

/**
 * Render the pairing QR to a PNG with a "PLEASE SCAN ME" banner, plus a
 * terminal version. Each QR gets a distinct accent colour and its sequence
 * number so a refreshed code is obviously new rather than a stale repeat.
 */
async function renderQrAssets(qr: string, sequence: number): Promise<void> {
  const qrcode = (await import('qrcode')) as unknown as {
    toString(text: string, opts: Record<string, unknown>): Promise<string>;
    toBuffer(text: string, opts: Record<string, unknown>): Promise<Buffer>;
  };
  const sharp = (await import('sharp')).default;

  // Terminal copy, for anyone watching the raw process.
  const art = await qrcode.toString(qr, { type: 'terminal', small: true });
  rawLog(`\n${art}`);

  const ACCENTS = ['#25D366', '#128C7E', '#075E54', '#34B7F1'];
  const accent = ACCENTS[(sequence - 1) % ACCENTS.length];

  const QR_PX = 512;
  const PAD = 32;
  const BANNER_H = 96;
  const width = QR_PX + PAD * 2;
  const height = BANNER_H + QR_PX + PAD * 2;

  const qrPng = await qrcode.toBuffer(qr, {
    type: 'png',
    width: QR_PX,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const banner = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${width}" height="${height}" fill="#FFFFFF"/>
       <rect width="${width}" height="${BANNER_H}" fill="${accent}"/>
       <text x="${width / 2}" y="46" text-anchor="middle"
             font-family="Helvetica,Arial,sans-serif" font-size="38"
             font-weight="bold" fill="#FFFFFF" letter-spacing="2">PLEASE SCAN ME</text>
       <text x="${width / 2}" y="76" text-anchor="middle"
             font-family="Helvetica,Arial,sans-serif" font-size="19" fill="#FFFFFF">
         WhatsApp → Settings → Linked Devices  ·  code #${sequence}
       </text>
     </svg>`
  );

  await sharp(banner)
    .composite([{ input: qrPng, top: BANNER_H + PAD, left: PAD }])
    .png()
    .toFile(QR_PNG_PATH);
}

/** Load mac-app/.env into process.env without clobbering real overrides. */
function loadEnvFile(): void {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    process.env[key] ??= value;
  }
}
loadEnvFile();
process.env.VITE_BACKEND_API_URL ??= 'http://localhost:3001';

/** Sign in through the backend so uploads carry a token it will accept. */
async function resolveSession(): Promise<{
  access_token: string;
  refresh_token: string;
  user: unknown;
  expires_at: number;
}> {
  const apiUrl = process.env.VITE_BACKEND_API_URL;
  const phone = process.env.WA_PHONE ?? '+19729777432';
  const otp = process.env.WA_OTP ?? '181818';

  if (process.env.WA_ACCESS_TOKEN !== undefined && process.env.WA_ACCESS_TOKEN !== '') {
    say('AUTH', 'Using WA_ACCESS_TOKEN from env');
    return {
      access_token: process.env.WA_ACCESS_TOKEN,
      refresh_token: '',
      user: null,
      expires_at: Date.now() + 60 * 60 * 1000,
    };
  }

  // Sign in through OUR backend, not Supabase directly: the backend mints the
  // HS256 session its own `authenticate` middleware accepts, and prod Supabase
  // has the phone provider disabled so the direct OTP path 400s.
  say('AUTH', `Requesting OTP for ${phone}`);
  const otpRes = await fetch(`${apiUrl}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!otpRes.ok) {
    throw new Error(`send-otp failed: ${otpRes.status} ${await otpRes.text()}`);
  }

  say('AUTH', 'Verifying OTP');
  const verifyRes = await fetch(`${apiUrl}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, token: otp }),
  });
  if (!verifyRes.ok) {
    throw new Error(`verify-otp failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }

  const body = (await verifyRes.json()) as {
    user: { id: string };
    session: { access_token: string; refresh_token?: string; expires_at?: number };
  };
  if (body.session?.access_token === undefined) {
    throw new Error(`verify-otp returned no session: ${JSON.stringify(body).slice(0, 200)}`);
  }
  say('AUTH', 'Signed in', { userId: body.user?.id });
  return {
    access_token: body.session.access_token,
    refresh_token: body.session.refresh_token ?? '',
    user: body.user,
    expires_at: body.session.expires_at ?? Date.now() + 60 * 60 * 1000,
  };
}

async function main(): Promise<void> {
  say('BOOT', `state dir  ${HARNESS_DIR}`);
  say('BOOT', `log file   ${LOG_PATH}`);
  say('BOOT', `backend    ${process.env.VITE_BACKEND_API_URL}`);

  const { AuthService } = await import('../main/services/auth');
  const { WhatsAppSync } =
    await import('../main/services/messaging/platforms/whatsapp/WhatsAppSync');
  const { WhatsAppAuth } = await import('../main/domains/messaging-whatsapp/repo');

  if (process.env.WA_RESET === '1') {
    say('RESET', 'Clearing stored WhatsApp credentials — expect a fresh QR');
    WhatsAppAuth.clearCredentials();
  }

  const session = await resolveSession();
  AuthService.setSession(session);

  const paired = WhatsAppAuth.hasCredentials();
  say(
    'STATE',
    paired ? 'Existing credentials found — reconnecting' : 'No credentials — QR pairing'
  );

  // Narrate credential-file changes: this is where the old 515 bug showed up.
  const authDir = WhatsAppAuth.getAuthDir();
  fs.mkdirSync(authDir, { recursive: true });
  fs.watch(authDir, (event, filename) => {
    if (filename === 'creds.json') say('CREDS', `${event} on creds.json`);
  });

  let qrCount = 0;
  let connected = false;

  const onQRCode = (qr: string): void => {
    qrCount += 1;
    const n = qrCount;
    void renderQrAssets(qr, n)
      .then(() => {
        say('QR', `New QR ready (#${n}) — ${QR_PNG_PATH}`);
        writeStatus({ state: 'waiting_for_scan', qrCount: n });
      })
      .catch((err) => say('QR', 'Failed to render QR', String(err)));
  };

  const onConnected = (): void => {
    connected = true;
    say('PAIRED', '✅ Socket open — registering integration and awaiting history sync');
    writeStatus({ state: 'connected', qrCount });
  };

  // Baileys retires a QR after ~60s and eventually closes the socket. Production
  // only auto-reconnects on 515, so the harness re-dials here to keep a fresh
  // code on screen until the scan lands — without changing app reconnect policy.
  let attempt = 0;
  while (!connected && attempt < MAX_QR_CYCLES) {
    attempt += 1;
    try {
      await WhatsAppSync.connect({ onQRCode, onConnected });
    } catch (err) {
      say('RETRY', `connect() threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (WhatsAppSync.isConnected()) {
      connected = true;
      break;
    }
    if (connected) break;

    if (attempt >= MAX_QR_CYCLES) break;

    // Back off between re-dials. Each cycle is a fresh pairing request to
    // WhatsApp; a tight unbounded loop reads as abuse and gets the ACCOUNT
    // blocked from linking devices ("Can't link new devices right now").
    const backoffMs = Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
    say(
      'RETRY',
      `QR cycle ${attempt}/${MAX_QR_CYCLES} expired without a scan — ` +
        `re-dialling in ${Math.round(backoffMs / 1000)}s`
    );
    writeStatus({ state: 'refreshing', qrCount });
    await WhatsAppSync.disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  if (!connected) {
    // Stop rather than hammer. An unattended harness must never keep requesting
    // pairings — that is what got the account throttled.
    say(
      'GIVING UP',
      `No scan after ${MAX_QR_CYCLES} QR cycles. Stopping so WhatsApp doesn't throttle ` +
        `device linking. Re-run this script when you're actually at your phone ` +
        `(raise WHATSAPP_MAX_QR_CYCLES only if you know someone is watching).`
    );
    writeStatus({ state: 'gave_up', qrCount });
    await WhatsAppSync.disconnect().catch(() => {});
    process.exit(1);
  }

  writeStatus({ state: 'connected', qrCount });
  say('READY', 'Listening. History batches upload automatically every 5s. Ctrl-C to stop.');

  // Heartbeat so a silent stall is visible rather than looking like progress.
  setInterval(() => {
    say('HEARTBEAT', WhatsAppSync.isConnected() ? 'connected' : 'not connected', {
      phone: WhatsAppSync.getLinkedPhoneNumber(),
    });
  }, 30_000);

  const shutdown = (): void => {
    say('EXIT', 'Flushing buffered messages and disconnecting...');
    void WhatsAppSync.disconnect().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  say('FATAL', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
  process.exit(1);
});
