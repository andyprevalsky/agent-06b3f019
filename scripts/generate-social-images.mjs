#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function parseArgs() {
  const [, , inputArg, outArg] = process.argv;
  if (!inputArg) {
    console.error('Usage: node scripts/generate-social-images.mjs <input-image-path> [output-dir]');
    console.error('Example: node scripts/generate-social-images.mjs public/social-source.jpg public/social');
    process.exit(1);
  }
  const inputPath = path.resolve(projectRoot, inputArg);
  const outDir = path.resolve(projectRoot, outArg || 'public/social');
  return { inputPath, outDir };
}

const targets = [
  // Open Graph / Twitter large summary
  { name: 'opengraph-1200x630', width: 1200, height: 630, position: 'centre' },
  // Square fallback / avatars
  { name: 'square-1200', width: 1200, height: 1200, position: 'centre' },
  // WhatsApp/Telegram/SMS generally accept OG 1200x630 too; make a 1024x512 variant
  { name: 'landscape-1024x512', width: 1024, height: 512, position: 'centre' },
  // Instagram post friendly (not used in meta)
  { name: 'portrait-1080x1350', width: 1080, height: 1350, position: 'centre' },
];

async function generate() {
  const { inputPath, outDir } = parseArgs();
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(2);
  }

  await ensureDir(outDir);
  const image = sharp(inputPath);

  const promises = [];
  for (const target of targets) {
    const base = path.join(outDir, target.name);
    const common = image
      .clone()
      .resize({ width: target.width, height: target.height, fit: 'cover', position: target.position || 'centre' });

    promises.push(
      common
        .jpeg({ quality: 90, progressive: true })
        .toFile(`${base}.jpg`)
    );

    promises.push(
      common
        .webp({ quality: 92 })
        .toFile(`${base}.webp`)
    );
  }

  await Promise.all(promises);

  console.log('Generated social images in', outDir);
  console.log('Files:');
  for (const t of targets) {
    console.log(` - ${path.join(outDir, t.name)}.{jpg,webp}`);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});


