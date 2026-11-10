/** Server-only, calibrated native UI evidence. No media is exposed to a model. */
import { createHash } from 'crypto';
import { PNG } from 'pngjs';
import masks from './phonePortraitMasks.json';
import type { CheckStatus } from './phoneSetupVerification';
export const PORTRAIT_LAYOUT = 'iphone14-6-ios27-control-center-v1';
export interface PortraitProof {
  status: CheckStatus;
  digest: string;
  layout: typeof PORTRAIT_LAYOUT;
}
interface Pixels {
  width: number;
  height: number;
  data: Buffer;
}
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
function pixels(image: Pixels, region: Region, red = false): number[] {
  const result: number[] = [];
  for (let y = region.y; y < region.y + region.h; y++)
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(i, i + 3);
      result.push(
        Number(
          red
            ? r > 150 && r > g + 20 && r > b + 15
            : Math.min(r, g, b) > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 45
        )
      );
    }
  return result;
}
function matches(actual: number[], expected: string) {
  let differences = 0;
  for (let i = 0; i < expected.length; i++) if (actual[i] !== Number(expected[i])) differences++;
  return differences / expected.length < 0.025;
}
export function portraitTextRows(
  value: unknown
): { text: string; x: number; y: number; w: number; h: number }[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 32768) return null;
  } catch {
    return null;
  }
  const rows: { text: string; x: number; y: number; w: number; h: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const r = entry as Record<string, unknown>;
    if (
      typeof r.text !== 'string' ||
      r.source !== 'pixels' ||
      typeof r.confidence !== 'number' ||
      !Number.isFinite(r.confidence) ||
      r.confidence < 0 ||
      r.confidence > 1 ||
      !['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
    )
      return null;
    const { x, y, w, h } = r as { x: number; y: number; w: number; h: number };
    // Native SDK OCR x/y are tap CENTER coordinates, not rectangle origins.
    if (
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x - w / 2 < 0 ||
      y - h / 2 < 0 ||
      x + w / 2 > 750 ||
      y + h / 2 > 1334
    )
      return null;
    rows.push({ text: r.text, x, y, w, h });
  }
  return rows;
}
export function portraitControlCenterAnchors(value: unknown): string | null {
  const rows = portraitTextRows(value);
  if (rows === null) return null;
  const region = (left: number, top: number, right: number, bottom: number) =>
    rows
      .filter(
        (r) =>
          r.x - r.w / 2 >= left &&
          r.y - r.h / 2 >= top &&
          r.x + r.w / 2 <= right &&
          r.y + r.h / 2 <= bottom
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((r) => r.text)
      .join('\n')
      .replace(/-\s*\n\s*/g, '')
      .replace(/\s+/g, ' ');
  return /\bNot Playing\b/.test(region(380, 170, 650, 440)) &&
    /\bReduce Interruptions\b/.test(region(180, 610, 359, 734))
    ? 'Not Playing;Reduce Interruptions'
    : null;
}

/** Inputs originate from text/frame/text under one setup.verify slot, never caller media. */
export function provePortrait(png: Uint8Array, before: unknown, after: unknown): PortraitProof {
  const hash = createHash('sha256');
  hash.update(PORTRAIT_LAYOUT);
  const result = (status: CheckStatus): PortraitProof => ({
    status,
    digest: hash.digest('hex'),
    layout: PORTRAIT_LAYOUT,
  });
  const a = portraitControlCenterAnchors(before),
    b = portraitControlCenterAnchors(after);
  if (a === null || a !== b || png.byteLength > 2097152 || png.byteLength < 24)
    return result('unknown');
  const bytes = Buffer.from(png);
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== 750 ||
    bytes.readUInt32BE(20) !== 1334
  )
    return result('unknown');
  hash.update(bytes);
  hash.update(a);
  try {
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (!masks.anchors.every((region) => matches(pixels(image, region), region.bits)))
      return result('unknown');
    const on = matches(pixels(image, masks.lock, true), masks.on);
    const off = matches(pixels(image, masks.lock), masks.off);
    return result(on === off ? 'unknown' : on ? 'confirmed' : 'disabled');
  } catch {
    return result('unknown');
  }
}
