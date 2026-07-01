import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngImage = {
  width: number;
  height: number;
  colorType: number;
  pixels: Buffer;
};

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (aboveDistance <= upperLeftDistance) {
    return above;
  }
  return upperLeft;
}

function readPng(filePath: string): PngImage {
  const png = fs.readFileSync(filePath);
  expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);

  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let readOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated.readUInt8(readOffset);
    readOffset += 1;
    const sourceRow = inflated.subarray(readOffset, readOffset + rowLength);
    readOffset += rowLength;
    const targetStart = y * rowLength;
    const previousStart = targetStart - rowLength;

    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= bytesPerPixel ? pixels[targetStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[previousStart + x - bytesPerPixel] : 0;
      const value = sourceRow[x];

      if (filterType === 0) {
        pixels[targetStart + x] = value;
      } else if (filterType === 1) {
        pixels[targetStart + x] = (value + left) & 0xff;
      } else if (filterType === 2) {
        pixels[targetStart + x] = (value + above) & 0xff;
      } else if (filterType === 3) {
        pixels[targetStart + x] = (value + Math.floor((left + above) / 2)) & 0xff;
      } else if (filterType === 4) {
        pixels[targetStart + x] = (value + paethPredictor(left, above, upperLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter ${filterType}`);
      }
    }
  }

  return { width, height, colorType, pixels };
}

function alphaAt(image: PngImage, x: number, y: number): number {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function alphaBounds(image: PngImage): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return { minX, minY, maxX, maxY };
}

function readIcnsTypes(filePath: string): string[] {
  const icns = fs.readFileSync(filePath);
  expect(icns.toString('ascii', 0, 4)).toBe('icns');

  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= icns.length) {
    const type = icns.toString('ascii', offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    types.push(type);
    offset += length;
  }
  return types;
}

describe('mac app icon assets', () => {
  it('renders as the full-size rounded Rose app icon instead of an inset icon or square tile', () => {
    for (const relativePath of ['assets/icons/app.png', 'assets/icons/app-master.png']) {
      const icon = readPng(path.join(ROOT, relativePath));

      expect(icon.width).toBe(1024);
      expect(icon.height).toBe(1024);
      expect(icon.colorType).toBe(6);
      expect(alphaBounds(icon)).toEqual({
        minX: 0,
        minY: 0,
        maxX: 1023,
        maxY: 1023,
      });
      expect(alphaAt(icon, 0, 0)).toBe(0);
      expect(alphaAt(icon, 1023, 0)).toBe(0);
      expect(alphaAt(icon, 0, 1023)).toBe(0);
      expect(alphaAt(icon, 1023, 1023)).toBe(0);
      expect(alphaAt(icon, 512, 0)).toBeGreaterThan(0);
      expect(alphaAt(icon, 0, 512)).toBeGreaterThan(0);
      expect(alphaAt(icon, 512, 512)).toBe(255);
    }
  });

  it('keeps the packaged macOS icon bundle populated from the app icon', () => {
    const types = readIcnsTypes(path.join(ROOT, 'assets/icons/app.icns'));

    expect(types).toContain('ic10');
    expect(types).toContain('ic11');
    expect(types).toContain('ic12');
    expect(types).toContain('ic13');
    expect(types).toContain('ic14');
  });
});
