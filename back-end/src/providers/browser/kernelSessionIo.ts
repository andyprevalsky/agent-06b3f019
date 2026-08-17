import path from 'node:path';
import { summarizeKernelCaptchaEvents, type BrowserCaptchaTelemetry } from './captchaTelemetry';
import { kernelClient } from './kernelClient';
import type { BrowserFileInfo, BrowserViewport } from './types';

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

export async function listKernelSessionFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const client = kernelClient();
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
  filename: string
): Promise<{ path: string; size: number }> {
  const client = kernelClient();
  const directory = '/tmp/rose-uploads';
  await client.browsers.fs.createDirectory(sessionId, { path: directory }).catch(() => {});
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
