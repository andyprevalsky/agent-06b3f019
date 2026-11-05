/**
 * Provider dispatch for session I/O: viewport, files, screenshots and keys.
 *
 * Tilion: screenshot, keys and file reads are REST. They work while no CDP
 * client is attached and raise TilionSessionBusyError (HTTP 409) while the
 * agent worker holds the session. Uploads need CDP, so for Tilion they are
 * worker-owned and always refused here (BrowserOperationWorkerOwnedError).
 */
import { prisma } from '../database';
import { steelApiUrl, steelSessionFileUrl } from '../steel/session';
import { listSessionFiles, uploadFileToSession } from '../steel/files';
import {
  listBrowserUseSessionFiles,
  pressBrowserUseKeys,
  readBrowserUseSessionFile,
  uploadBrowserUseSessionFile,
} from './browserUse';
import {
  captureKernelScreenshot,
  listKernelSessionFiles,
  pressKernelKeys,
  readKernelSessionFile,
  resizeKernelViewport,
  uploadKernelSessionFile,
} from './kernel';
import { providerForSession } from './sessionProvider';
import {
  captureTilionScreenshot,
  listTilionSessionFiles,
  pressTilionKeys,
  readTilionSessionFile,
} from './tilion';
import type {
  BrowserFileInfo,
  BrowserProviderName,
  BrowserViewport,
  BrowserViewportResizeResult,
} from './types';

const PROVIDER_FETCH_TIMEOUT_MS = 15_000;

/** The operation runs in the agent worker over its own CDP socket for this provider. */
export class BrowserOperationWorkerOwnedError extends Error {
  constructor(
    readonly provider: BrowserProviderName,
    readonly operation: string
  ) {
    super(`${operation} on ${provider} sessions is worker-owned (single CDP client)`);
    this.name = 'BrowserOperationWorkerOwnedError';
  }
}

async function fetchProviderApi<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resizeSessionViewport(
  sessionId: string,
  viewport: BrowserViewport,
  knownProvider?: BrowserProviderName
): Promise<BrowserViewportResizeResult> {
  const provider = knownProvider ?? (await providerForSession(sessionId));
  if (provider === 'kernel') {
    return {
      provider,
      supported: true,
      resized: true,
      viewport: await resizeKernelViewport(sessionId, viewport),
    };
  }

  // Steel, Browser Use and Tilion expose no viewport resize API.
  return { provider, supported: false, resized: false, viewport };
}

export async function uploadSessionFile(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType = 'application/octet-stream',
  options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') {
    return uploadBrowserUseSessionFile(sessionId, fileBuffer, filename, mimeType, options);
  }
  // Tilion upload drives the page over CDP, and the worker holds the only CDP socket.
  if (provider === 'tilion') throw new BrowserOperationWorkerOwnedError(provider, 'upload');
  // Steel's Files API owns /files; directory overrides only apply to Kernel.
  return provider === 'kernel'
    ? uploadKernelSessionFile(sessionId, fileBuffer, filename, options)
    : uploadFileToSession(sessionId, fileBuffer, filename, mimeType);
}

export async function listFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') return listBrowserUseSessionFiles(sessionId);
  if (provider === 'tilion') return listTilionSessionFiles(sessionId);
  return provider === 'kernel' ? listKernelSessionFiles(sessionId) : listSessionFiles(sessionId);
}

export async function readSessionFile(sessionId: string, filePath: string): Promise<Buffer> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') return readBrowserUseSessionFile(sessionId, filePath);
  if (provider === 'tilion') return readTilionSessionFile(sessionId, filePath);
  if (provider === 'kernel') return readKernelSessionFile(sessionId, filePath);

  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to read Steel session files');
  const relativePath = filePath.replace(/^\/files\//, '').replace(/^\//, '');
  return fetchProviderApi(
    steelSessionFileUrl(sessionId, relativePath),
    { headers: { 'steel-api-key': apiKey } },
    async (response) => {
      if (!response.ok) throw new Error(`Steel file read failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }
  );
}

export async function captureScreenshot(sessionId: string): Promise<{
  provider: BrowserProviderName;
  image: Buffer;
}> {
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') {
    return { provider, image: await captureKernelScreenshot(sessionId) };
  }
  if (provider === 'tilion') {
    // REST screenshot: read-only, served beside an attached CDP client.
    return { provider, image: await captureTilionScreenshot(sessionId) };
  }
  if (provider === 'browser-use') {
    const session = await prisma.browserSession.findUniqueOrThrow({
      where: { sessionId },
    });
    if (!session.wsUrl) throw new Error('Browser Use CDP URL unavailable for screenshot');
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(session.wsUrl);
    try {
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!page) throw new Error('Browser Use session has no page for screenshot');
      return { provider, image: await page.screenshot() };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to capture Steel screenshots');
  return fetchProviderApi(
    steelApiUrl(`v1/sessions/${encodeURIComponent(sessionId)}/computer`),
    {
      method: 'POST',
      headers: { 'steel-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'take_screenshot' }),
    },
    async (response) => {
      if (!response.ok) throw new Error(`Steel screenshot failed: HTTP ${response.status}`);
      const result = (await response.json()) as { base64_image?: string };
      if (!result.base64_image)
        throw new Error('Steel screenshot response did not contain an image');
      return { provider, image: Buffer.from(result.base64_image, 'base64') };
    }
  );
}

export async function pressSessionKeys(
  sessionId: string,
  keys: string[]
): Promise<{
  provider: BrowserProviderName;
  supported: boolean;
  pressed: boolean;
}> {
  return pressSessionKeysUsingDependencies(sessionId, keys, {
    providerForSession,
    pressKernelKeys,
    pressBrowserUseKeys,
    pressTilionKeys,
  });
}

export async function pressSessionKeysUsingDependencies(
  sessionId: string,
  keys: string[],
  dependencies: {
    providerForSession: (sessionId: string) => Promise<BrowserProviderName>;
    pressKernelKeys: (sessionId: string, keys: string[]) => Promise<void>;
    pressBrowserUseKeys: (sessionId: string, keys: string[]) => Promise<void>;
    pressTilionKeys: (sessionId: string, keys: string[]) => Promise<void>;
  }
): Promise<{
  provider: BrowserProviderName;
  supported: boolean;
  pressed: boolean;
}> {
  const provider = await dependencies.providerForSession(sessionId);
  if (provider === 'kernel') await dependencies.pressKernelKeys(sessionId, keys);
  else if (provider === 'browser-use') await dependencies.pressBrowserUseKeys(sessionId, keys);
  else if (provider === 'tilion') await dependencies.pressTilionKeys(sessionId, keys);
  else return { provider, supported: false, pressed: false };
  return { provider, supported: true, pressed: true };
}
