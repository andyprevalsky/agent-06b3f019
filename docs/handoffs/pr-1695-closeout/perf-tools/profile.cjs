// Usage: node profile.cjs <url> <label>
const { chromium } = require('/home/boxes/rose/node_modules/playwright');
(async () => {
  const [url, label] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const reqs = new Map(); let bytes = 0;
  cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; const u = reqs.get(e.requestId); if (u && e.encodedDataLength > 200000) console.log(`  big ${(e.encodedDataLength/1e6).toFixed(2)}MB ${u.slice(0,120)}`); });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const keys = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];
  const window = async (name, ms) => {
    const a = await metrics(); await page.waitForTimeout(ms); const b = await metrics();
    const out = keys.map((k) => `${k}=${(b[k] - a[k]).toFixed(k.endsWith('Count') ? 0 : 2)}`).join(' ');
    console.log(`${label} ${name} (${ms / 1000}s): ${out}  busy=${(((b.TaskDuration - a.TaskDuration) * 1000) / ms * 100).toFixed(1)}%`);
  };
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  console.log(`${label} load ${Date.now() - t0}ms, bytes so far ${(bytes / 1e6).toFixed(2)}MB`);
  await window('opening 0-10s', 10000);
  await page.waitForTimeout(20000);
  await window('steady 30-40s', 10000);
  console.log(`${label} total bytes ${(bytes / 1e6).toFixed(2)}MB`);
  await page.screenshot({ path: `/tmp/perf/${label}.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
