import path from 'node:path';
import { summarizeKernelCaptchaEvents, type BrowserCaptchaTelemetry } from './captchaTelemetry';
import { kernelClient } from './kernelClient';
import type { BrowserFileInfo, BrowserViewport, BrowserSessionHealth } from './types';

export async function getKernelCaptchaTelemetry(
  sessionId: string
): Promise<BrowserCaptchaTelemetry> {
  const events: unknown[] = [];
  // Bound entries SCANNED, not only entries kept: a captcha-category stream can
  // contain many non-solve_result events, and events.length never grows for them.
  let scanned = 0;
  const scanDeadline = Date.now() + 5_000;
  for await (const entry of kernelClient().browsers.telemetry.events(sessionId, {
    category: ['captcha'],
    order: 'desc',
  })) {
    scanned += 1;
    if (entry.event.type === 'captcha_solve_result') {
      events.push(entry);
    }
    // Deadline is checked after each page yields; the Kernel SDK stream has no
    // AbortSignal, so a single in-flight page fetch can still overrun slightly.
    if (events.length >= 50 || scanned >= 500 || Date.now() >= scanDeadline) break;
  }
  return summarizeKernelCaptchaEvents(events);
}

export async function resizeKernelViewport(
  sessionId: string,
  viewport: BrowserViewport
): Promise<BrowserViewport> {
  await kernelClient().browsers.update(sessionId, {
    viewport: { ...viewport, force: true },
  });
  return viewport;
}

const FILE_DIRECTORIES = ['/tmp/downloads', '/tmp/rose-uploads', '/home/oai/share'];
const KERNEL_COMPUTER_INPUT_TIMEOUT_MS = 10_000;

/** Ensure Kernel download/upload roots exist before CDP writes or listFiles. */
export async function ensureKernelSessionFileDirectories(sessionId: string): Promise<void> {
  const client = kernelClient();
  await Promise.all(
    FILE_DIRECTORIES.map((directory) =>
      client.browsers.fs.createDirectory(sessionId, { path: directory }).catch(() => {})
    )
  );
}

export async function listKernelSessionFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const client = kernelClient();
  await ensureKernelSessionFileDirectories(sessionId);
  const results = await Promise.all(
    FILE_DIRECTORIES.map(async (directory) => {
      try {
        return await client.browsers.fs.listFiles(sessionId, { path: directory });
      } catch {
        return [];
      }
    })
  );
  const byPath = new Map<string, BrowserFileInfo>();
  for (const file of results.flat()) {
    if (!file.is_dir) {
      byPath.set(file.path, {
        path: file.path,
        size: file.size_bytes,
        lastModified: file.mod_time,
      });
    }
  }
  return [...byPath.values()];
}

export async function uploadKernelSessionFile(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  const client = kernelClient();
  const directory = options.directory ?? '/tmp/rose-uploads';
  if (!FILE_DIRECTORIES.includes(directory)) {
    throw new Error(`Unsupported Kernel session file directory: ${directory}`);
  }
  await ensureKernelSessionFileDirectories(sessionId);
  const remotePath = `${directory}/${path.basename(filename)}`;
  await client.browsers.fs.writeFile(sessionId, fileBuffer, { path: remotePath });
  return { path: remotePath, size: fileBuffer.length };
}

export async function readKernelSessionFile(sessionId: string, filePath: string): Promise<Buffer> {
  const response = await kernelClient().browsers.fs.readFile(sessionId, { path: filePath });
  return Buffer.from(await response.arrayBuffer());
}

export async function captureKernelScreenshot(sessionId: string): Promise<Buffer> {
  const response = await kernelClient().browsers.computer.captureScreenshot(sessionId);
  return Buffer.from(await response.arrayBuffer());
}

export async function pressKernelKeys(sessionId: string, keys: string[]): Promise<void> {
  await kernelClient().browsers.computer.pressKey(
    sessionId,
    { keys },
    { timeout: KERNEL_COMPUTER_INPUT_TIMEOUT_MS, maxRetries: 0 }
  );
}

export async function getKernelSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  const session = await kernelClient().browsers.retrieve(sessionId, {
    include_deleted: true,
  });
  return {
    provider: 'kernel',
    sessionId,
    status: session.deleted_at ? 'deleted' : 'active',
    createdAt: session.created_at,
    timeoutMs: session.timeout_seconds * 1000,
    expiresAt: null,
    ttlMs: null,
    profileId: session.profile?.id ?? null,
    uptimeMs: session.usage?.uptime_ms ?? null,
  };
}
