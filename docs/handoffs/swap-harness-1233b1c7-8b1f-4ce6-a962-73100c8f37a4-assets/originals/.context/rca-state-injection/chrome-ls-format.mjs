import { chromium } from 'playwright';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'rose-ls-format-'));
const ctx = await chromium.launchPersistentContext(dir, { headless: true });
const page = await ctx.newPage();
await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><iframe src="https://frame.example.net/f"></iframe></body></html>' }));
await page.goto('https://www.example.com/x');
await page.evaluate(() => localStorage.setItem('first_party_key', 'v1'));
const frame = page.frames().find((f) => f.url().startsWith('https://frame.example.net'));
await frame?.evaluate(() => localStorage.setItem('third_party_key', 'v2')).catch((e) => console.log('frame write failed', String(e)));
await page.waitForTimeout(1500);
await ctx.close();
const lsDir = join(dir, 'Default', 'Local Storage', 'leveldb');
const files = readdirSync(lsDir).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
for (const f of files) {
  const buf = readFileSync(join(lsDir, f));
  for (const key of ['first_party_key', 'third_party_key']) {
    const i = buf.indexOf(Buffer.from(key));
    if (i < 0) continue;
    const start = buf.lastIndexOf(0x5f, i); // '_'
    const raw = buf.subarray(start, i + key.length);
    console.log(f, key, JSON.stringify(raw.toString('latin1')), [...raw.subarray(0, 4)].map((b) => b.toString(16)));
  }
}
rmSync(dir, { recursive: true, force: true });
