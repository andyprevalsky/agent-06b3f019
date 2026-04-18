/**
 * Completions Domain Utilities
 *
 * Pure helpers with no side effects: logging, JSON extraction, timeout wrapper,
 * array shuffling, base64 truncation for logs, file-size filtering, Retry-After
 * parsing, and the browser-use request-shape discriminator.
 */

import { FIVE_MB, MAX_5MB_MODELS, NO_VISION_MODELS } from './config.ts';
import type { BrowserUseRequest } from './types.ts';

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

export function parseRetryAfterMs(raw: string | null, fallbackMs = 2000): number {
  if (!raw) return fallbackMs;
  const deltaSeconds = Number(raw);
  if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
    return deltaSeconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delayMs = dateMs - Date.now();
    return delayMs > 0 ? delayMs : fallbackMs;
  }
  return fallbackMs;
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

export function slog(
  level: 'info' | 'warn' | 'error',
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'Rose',
    message,
    ...extra,
  };
  if (level === 'error') {
    // deno-lint-ignore no-console
    console.error(JSON.stringify(entry));
  } else {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(entry));
  }
}

// ---------------------------------------------------------------------------
// Base64 / screenshot redaction for logging
// ---------------------------------------------------------------------------

function redactBase64String(value: string): string {
  const looksLikeBase64 = value.startsWith('data:image/') ||
    (value.length > 500 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100)));
  if (looksLikeBase64) {
    return `[BASE64_TRUNCATED:${value.length} chars]`;
  }
  return value;
}

// deno-lint-ignore no-explicit-any
export function truncateForLogging(obj: any, maxBase64Length = 100): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactBase64String(obj);
  if (Array.isArray(obj)) {
    return obj.map((item) => truncateForLogging(item, maxBase64Length));
  }
  if (typeof obj === 'object') {
    // deno-lint-ignore no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const isScreenshotKey = key === 'screenshot' || key === 'url' ||
        key === 'image_url';
      if (isScreenshotKey && typeof value === 'string') {
        result[key] = redactBase64String(value);
      } else {
        result[key] = truncateForLogging(value, maxBase64Length);
      }
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function escapeForJsonString(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Detect whether an incoming stream starts with JSON (raw or fenced).
 * Returns null while the prefix is still ambiguous and more bytes are needed.
 */
export function detectJsonTextStart(content: string): boolean | null {
  if (!content) return null;
  const trimmed = content.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return true;
  if (trimmed.startsWith('```')) {
    const nlMatch = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*)$/);
    if (!nlMatch) return null;
    const afterFence = nlMatch[1].trimStart();
    if (!afterFence) return null;
    return afterFence.startsWith('{');
  }
  return false;
}

// deno-lint-ignore no-explicit-any
function tryParse(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract JSON from (possibly markdown-wrapped) content. Returns null on failure. */
// deno-lint-ignore no-explicit-any
export function extractJSON(content: string): any {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();

  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const parsed = tryParse(objectMatch[0]);
    if (parsed !== null) return parsed;
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const parsed = tryParse(arrayMatch[0]);
    if (parsed !== null) return parsed;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

/** Fisher-Yates shuffle. Returns a new array, does not mutate input. */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ---------------------------------------------------------------------------
// Promise timeout wrapper
// ---------------------------------------------------------------------------

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      )
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Browser-use request discriminator
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export function isBrowserUseRequest(body: any): body is BrowserUseRequest {
  return Boolean(body && body.browser_state && body.task && body.available_actions);
}

// ---------------------------------------------------------------------------
// File-size capability filtering
// ---------------------------------------------------------------------------

/** Return the largest base64 image payload size (in bytes) across messages. */
// deno-lint-ignore no-explicit-any
export function getMaxBase64FileSizeBytes(messages: any[]): number {
  let maxSize = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'image_url') continue;
      const url: string | undefined = block.image_url?.url;
      if (!url || !url.startsWith('data:')) continue;
      const base64 = url.split(',')[1];
      if (!base64) continue;
      const sizeBytes = Math.ceil(base64.length * 0.75);
      if (sizeBytes > maxSize) maxSize = sizeBytes;
    }
  }
  return maxSize;
}

/** Filter a model pool based on max base64 file size in the request. */
export function filterPoolByFileSize(
  pool: string[],
  maxFileSizeBytes: number,
): string[] {
  if (maxFileSizeBytes === 0) return pool;
  let filtered = pool.filter((m) => !NO_VISION_MODELS.has(m));
  if (maxFileSizeBytes > FIVE_MB) {
    filtered = filtered.filter((m) => !MAX_5MB_MODELS.has(m));
  }
  const excluded = pool.filter((m) => !filtered.includes(m));
  if (excluded.length > 0) {
    const sizeMb = (maxFileSizeBytes / 1024 / 1024).toFixed(2);
    slog(
      'info',
      `File size ${sizeMb}MB, excluded models: ${excluded.join(', ')}`,
    );
  }
  return filtered;
}
