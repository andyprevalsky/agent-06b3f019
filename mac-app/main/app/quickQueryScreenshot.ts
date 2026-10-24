/**
 * Screenshot of the screen the user summoned the quick launcher from.
 *
 * System context:
 *   Alt+Space → QuickQueryController → capture display under cursor (launcher
 *     still hidden, so the pill is not in the shot) → show launcher →
 *     quick-query:toggle { open, screenshot } → launcher holds it as a normal
 *     removable attachment → submit → main window uploads it as an
 *     auto_captured file pointer → createAgent → the chat and agent LLM
 *     context mark it as automatic and possibly unrelated to the request
 *
 * macOS returns wallpaper-only frames without Screen Recording access, so
 * nothing is attached until the user grants it. The first ungranted open in a
 * session still calls desktopCapturer once so macOS shows its prompt and lists
 * Rose under Privacy & Security → Screen Recording.
 */

import { desktopCapturer, screen, systemPreferences } from 'electron';
import type { QuickQueryAttachment } from '../../shared/types/ipc';

/** Longest Alt+Space waits for a capture before opening the launcher without one. */
export const QUICK_QUERY_SCREENSHOT_TIMEOUT_MS = 1_500;

export class QuickQueryScreenshots {
  private accessPrompted = false;
  private capturing = false;

  /** Captures, then calls `show`; a press while a capture is in flight is dropped. */
  async captureThen(show: (screenshot: QuickQueryAttachment | null) => void): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      show(await this.captureCallerDisplay());
    } finally {
      this.capturing = false;
    }
  }

  /** Resolves null (never rejects) when access is missing or the capture fails. */
  async captureCallerDisplay(now: Date = new Date()): Promise<QuickQueryAttachment | null> {
    try {
      if (!hasScreenAccess()) {
        this.promptForScreenAccessOnce();
        return null;
      }

      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      // Point size, not Retina pixels: models downscale larger images anyway,
      // and a full-resolution PNG costs several MB on every launcher open.
      const sources = await withTimeout(
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size }),
        QUICK_QUERY_SCREENSHOT_TIMEOUT_MS
      );
      const source =
        sources.find((candidate) => candidate.display_id === String(display.id)) ??
        (sources.length === 1 ? sources[0] : undefined);
      if (source === undefined || source.thumbnail.isEmpty()) {
        console.warn('[QuickQuery] No screen source for the launcher display', {
          displayId: display.id,
          sources: sources.length,
        });
        return null;
      }

      const png = source.thumbnail.toPNG();
      return {
        name: screenshotFileName(now),
        mimeType: 'image/png',
        size: png.byteLength,
        data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
        autoCaptured: true,
      };
    } catch (error) {
      console.warn('[QuickQuery] Screenshot capture failed; opening without it', error);
      return null;
    }
  }

  private promptForScreenAccessOnce(): void {
    if (this.accessPrompted) return;
    this.accessPrompted = true;
    console.log('[QuickQuery] Screen Recording not granted; requesting it, no screenshot attached');
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => {});
  }
}

function hasScreenAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Screen capture timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** macOS naming: "Screenshot 2026-10-24 at 15.04.09.png". */
function screenshotFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `Screenshot ${date} at ${time}.png`;
}
