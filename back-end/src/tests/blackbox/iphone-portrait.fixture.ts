/** Synthetic pixels only: no screenshots, messages, account data, or provider assets. */
import { PNG } from 'pngjs';
import masks from '../../providers/phonePortraitMasks.json';
export const PORTRAIT_OCR = 'Not Playing\nReduce Interrup-\ntions';
export function portraitFrame(on = true): Buffer {
  const png = new PNG({ width: 750, height: 1334 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = png.data[i + 1] = png.data[i + 2] = 70;
    png.data[i + 3] = 255;
  }
  for (const region of [...masks.anchors, { ...masks.lock, bits: on ? masks.on : masks.off }])
    for (let y = 0; y < region.h; y++)
      for (let x = 0; x < region.w; x++) {
        if (region.bits[y * region.w + x] !== '1') continue;
        const i = ((y + region.y) * 750 + x + region.x) * 4;
        const red =
          region === masks.anchors[0]
            ? false
            : region.x === masks.lock.x && region.y === masks.lock.y && on;
        png.data[i] = red ? 240 : 235;
        png.data[i + 1] = png.data[i + 2] = red ? 95 : 235;
      }
  return PNG.sync.write(png);
}

/** Actual documented native OCR wire shape; x/y are tap centers. */
export function portraitOcr() {
  return [
    { text: 'Not Playing', confidence: 1, source: 'pixels', x: 480, y: 334, w: 140, h: 25 },
    { text: 'Reduce', confidence: 1, source: 'pixels', x: 250, y: 644, w: 100, h: 26 },
    { text: 'Interrup-', confidence: 1, source: 'pixels', x: 260, y: 676, w: 120, h: 26 },
    { text: 'tions', confidence: 1, source: 'pixels', x: 230, y: 706, w: 60, h: 26 },
  ];
}

/** Real Control Center OCR from production (lease 5544f520 cursors 31/48): stray hyphenation glyph. */
export function livePortraitOcr(glyph: '-' | '~' = '-') {
  return [
    {
      text: '\u2022\u2022\u2022\u2022',
      confidence: 1,
      source: 'pixels',
      x: 120,
      y: 143,
      w: 40,
      h: 10,
    },
    { text: 'No SIM', confidence: 1, source: 'pixels', x: 193, y: 137, w: 94.3, h: 27.2 },
    { text: 'Reduce', confidence: 1, source: 'pixels', x: 247, y: 643, w: 90.4, h: 23.8 },
    {
      text: `Interrup- ${glyph}`,
      confidence: 1,
      source: 'pixels',
      x: 266,
      y: 676,
      w: 136.5,
      h: 26.8,
    },
    { text: 'tions', confidence: 1, source: 'pixels', x: 230, y: 704, w: 64.4, h: 25 },
    { text: 'J', confidence: 1, source: 'pixels', x: 316, y: 838, w: 24, h: 24 },
    { text: '100%', confidence: 1, source: 'pixels', x: 552, y: 137, w: 76, h: 26 },
    { text: 'Not Playing', confidence: 1, source: 'pixels', x: 482, y: 334, w: 144, h: 28 },
    { text: '((p))', confidence: 0.5, source: 'pixels', x: 707, y: 778, w: 42, h: 32 },
  ];
}
