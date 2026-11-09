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
