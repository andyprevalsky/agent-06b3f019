/**
 * Tilion drive calls and files. Live Tilion refuses REST drive calls while a
 * CDP client (the agent worker) is attached: act answers 409
 * `session_driven_by_client` and files/fetch 409/502, surfaced as
 * TilionSessionBusyError; callers mid-run must use the worker's own CDP
 * connection instead. Since 2026-11 a read-only screenshot is served beside
 * the attached client.
 */
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import {
  defaultShouldRetry,
  mintTilionConnectUrl,
  mintTilionLiveViewUrl,
  tilionRequest,
  tilionSessionPath,
  TilionApiError,
  TilionDownloadChallengedError,
  TilionSessionBusyError,
} from './tilionClient';
import { prisma } from '../database';
import { createLogger } from '../logger';
import type { BrowserCaptchaTelemetry } from './captchaTelemetry';
import type { BrowserFileInfo, BrowserSessionHealth } from './types';

const log = createLogger('Tilion');

interface TilionStatusRecord {
  state: string;
  created_at?: number | null;
  ttl?: number | null;
  expires_at?: number | null;
  closed_at?: number | null;
}

// ── drive calls ──────────────────────────────────────────────────────────────

const DRIVE_TIMEOUT_MS = 60_000;

/** Keyboard chord through REST `act` (no second CDP client). */
export async function pressTilionKeys(sessionId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) throw new Error('pressTilionKeys requires at least one key');
  const result = await tilionRequest<{ ok?: boolean; error?: string | null }>(
    tilionSessionPath(sessionId, '/act'),
    {
      method: 'POST',
      body: { action: 'press', key: keys.join('+') },
      timeoutMs: DRIVE_TIMEOUT_MS,
    }
  );
  if (result?.ok === false) {
    throw new Error(`Tilion key press failed: ${result.error ?? 'unknown error'}`);
  }
}

export async function captureTilionScreenshot(sessionId: string): Promise<Buffer> {
  const result = await tilionRequest<{ image_base64?: string }>(
    tilionSessionPath(sessionId, '/screenshot'),
    {
      method: 'POST',
      body: { format: 'png' },
      timeoutMs: DRIVE_TIMEOUT_MS,
      retryOnTimeout: true,
    }
  );
  if (!result?.image_base64) throw new Error('Tilion screenshot response did not contain an image');
  return Buffer.from(result.image_base64, 'base64');
}

// ── files ────────────────────────────────────────────────────────────────────

const TILION_FILE_CAP_BYTES = 32 * 1024 * 1024;
const FILE_FETCH_TIMEOUT_MS = 90_000;
/** Tilion has no downloads listing; the worker's download ledger is the source of truth. */
export async function listTilionSessionFiles(_sessionId: string): Promise<BrowserFileInfo[]> {
  return [];
}

/** Read a download by URL through the session's browser (its cookies/TLS identity), ≤ 32 MiB. */
export async function readTilionSessionFile(sessionId: string, path: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new Error(`Tilion files are addressed by their download URL, got ${path}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Tilion can only fetch http(s) downloads, got ${url.protocol}`);
  }
  const fetchFile = () =>
    tilionRequest<{ content_base64?: string; size?: number }>(
      tilionSessionPath(sessionId, '/files/fetch'),
      {
        method: 'POST',
        body: { url: url.toString(), max_bytes: TILION_FILE_CAP_BYTES },
        timeoutMs: FILE_FETCH_TIMEOUT_MS,
        // A CDP client that just disconnected still holds the session for up to ~0.1 s
        // (live probe 2026-11-15). The bounded retries outlast that detach lag; a client
        // that stays attached still surfaces as TilionSessionBusyError.
        shouldRetry: (error) =>
          error instanceof TilionSessionBusyError || defaultShouldRetry(error),
      }
    );
  let result: Awaited<ReturnType<typeof fetchFile>>;
  try {
    result = await fetchFile();
  } catch (error) {
    if (!(error instanceof TilionDownloadChallengedError)) throw error;
    // An anti-bot challenge stands in front of the file. Tilion's navigate clears it
    // inside this session (the clearance stays on the tab), then the page fetch passes.
    // The navigate moves the session's open tab to the file URL.
    log.info('Tilion file is behind a challenge; navigating the session tab to clear it', {
      sessionId,
      url: url.toString().slice(0, 200),
      requestId: error.requestId,
    });
    const navigated = await tilionRequest<{ status?: string; error?: string | null }>(
      tilionSessionPath(sessionId, '/navigate'),
      { method: 'POST', body: { url: url.toString() }, timeoutMs: DRIVE_TIMEOUT_MS }
    );
    if (navigated?.status !== 'ok') {
      log.warn('Tilion did not clear the challenge in front of the file', {
        sessionId,
        status: navigated?.status ?? null,
        error: navigated?.error ?? null,
      });
      throw error;
    }
    result = await fetchFile();
  }
  if (typeof result?.content_base64 !== 'string') {
    throw new Error('Tilion file fetch response did not contain file content');
  }
  const content = Buffer.from(result.content_base64, 'base64');
  return content;
}

/**
 * Deliver bytes into the remote browser's Downloads directory (blob download,
 * then a file-input read-back check), the Browser Use approach. Opens a CDP
 * client with a fresh token, so it fails with Tilion's 4409 while another
 * client (the agent worker) is attached.
 */
export async function uploadTilionSessionFile(
  sessionId: string,
  content: Buffer,
  filename: string,
  mimeType: string,
  options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  const directory = options.directory ?? '/tmp/downloads';
  if (!directory.startsWith('/') || /[\0]/.test(directory)) {
    throw new Error(`Tilion upload requires an absolute directory, got ${directory}`);
  }
  if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) {
    throw new Error('Tilion upload requires a plain filename');
  }
  const wsUrl = await mintTilionConnectUrl(sessionId);
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 15_000 });
  let page: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Tilion session has no CDP context');
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: directory,
      eventsEnabled: true,
    });
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const dot = filename.lastIndexOf('.');
    const suffix = randomUUID();
    const downloadName =
      dot > 0
        ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
        : `${filename}-${suffix}`;
    const expression = `(() => {
      const binary = atob(${JSON.stringify(content.toString('base64'))});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(mimeType)} }));
      const link = document.createElement('a');
      link.href = url;
      link.download = ${JSON.stringify(downloadName)};
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
    })()`;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.evaluate(expression),
    ]);
    const failure = await download.failure();
    if (failure) throw new Error(`Tilion upload download failed: ${failure}`);
    const path = `${directory.replace(/\/+$/, '')}/${download.suggestedFilename()}`;
    await page.evaluate(
      'document.documentElement.insertAdjacentHTML(\'beforeend\', \'<input type="file" id="tilion-upload-check">\')'
    );
    const document = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '#tilion-upload-check',
    });
    if (!input.nodeId) throw new Error('Tilion upload verification input unavailable');
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
    const uploaded = await page.evaluate(`new Promise((resolve, reject) => {
      const file = document.querySelector('#tilion-upload-check').files[0];
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })`);
    const encoded = String(uploaded).split(',')[1];
    if (!encoded || !Buffer.from(encoded, 'base64').equals(content)) {
      throw new Error(`Tilion remote file verification failed for ${filename}`);
    }
    return { path, size: content.length };
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── health, live view, telemetry ─────────────────────────────────────────────

function isoFromUnixSeconds(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

/** `/status` reads the session without touching its idle clock. */
export async function getTilionSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  let record: TilionStatusRecord;
  try {
    record = await tilionRequest<TilionStatusRecord>(tilionSessionPath(sessionId, '/status'), {
      retryOnTimeout: true,
    });
  } catch (error) {
    // Tilion removes ended sessions from its status API. Report confirmed
    // absence through the same health contract as a retained closed record;
    // unknown/auth/provider failures must not authorize replacement.
    if (!(error instanceof TilionApiError) || (error.status !== 404 && error.status !== 410))
      throw error;
    return {
      provider: 'tilion',
      sessionId,
      status: 'deleted',
      createdAt: null,
      timeoutMs: null,
      expiresAt: null,
      ttlMs: 0,
      profileId: null,
      uptimeMs: null,
    };
  }
  const ended = record.state !== 'ready' && record.state !== 'remote';
  const expiresAt = ended ? (record.closed_at ?? record.expires_at) : record.expires_at;
  const now = Date.now();
  return {
    provider: 'tilion',
    sessionId,
    status: record.state,
    createdAt: isoFromUnixSeconds(record.created_at),
    timeoutMs: typeof record.ttl === 'number' ? record.ttl * 1000 : null,
    expiresAt: isoFromUnixSeconds(expiresAt),
    ttlMs: ended
      ? 0
      : typeof record.expires_at === 'number'
        ? Math.max(0, record.expires_at * 1000 - now)
        : null,
    profileId: null,
    uptimeMs:
      typeof record.created_at === 'number'
        ? Math.max(
            0,
            (ended && record.closed_at ? record.closed_at * 1000 : now) - record.created_at * 1000
          )
        : null,
  };
}

/** Tilion exposes no per-session CAPTCHA solver state (only account-wide usage counts). */
export async function getTilionCaptchaTelemetry(
  _sessionId: string
): Promise<BrowserCaptchaTelemetry> {
  return {
    provider: 'tilion',
    telemetryEnabled: false,
    isSolving: null,
    activeTaskCount: null,
    pages: [],
    latestOutcome: null,
  };
}

/** Fresh interactive live-view URL (mints a new view token; tokens last 1800 s). */
export async function getTilionLiveViewUrl(sessionId: string): Promise<string> {
  const debugUrl = await mintTilionLiveViewUrl(sessionId);
  // Keep the row's URL usable for binding announcements and live-view GETs.
  await prisma.browserSession
    .updateMany({ where: { sessionId, provider: 'tilion' }, data: { debugUrl } })
    .catch((error: unknown) =>
      log.warn('Could not store refreshed Tilion live-view URL', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  return debugUrl;
}

/** Fresh CDP URL for a live session (connect tokens last 1800 s); stored on the row. */
export async function refreshTilionConnectUrl(sessionId: string): Promise<string> {
  const wsUrl = await mintTilionConnectUrl(sessionId);
  await prisma.browserSession.updateMany({
    where: { sessionId, provider: 'tilion' },
    data: { wsUrl },
  });
  return wsUrl;
}
