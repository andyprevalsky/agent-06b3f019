const { chromium } = require('/home/boxes/rose/node_modules/playwright');
const VARIANTS = {
  base: '',
  noCanvas: '[data-testid=terminal-grid-energy-canvas]{display:none!important}',
  noShader: '.liquid-white-shader canvas{display:none!important}',
  noAscii: '[data-testid=terminal-opening-ascii-transform]{display:none!important}',
  noBackdrop: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  noAll: '[data-testid=terminal-grid-energy-canvas],.liquid-white-shader canvas,[data-testid=terminal-opening-ascii-transform]{display:none!important}',
};
(async () => {
  const [url] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(30000);
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  for (const [name, css] of Object.entries(VARIANTS)) {
    await page.evaluate((c) => { let s = document.getElementById('perf-variant'); if (!s) { s = document.createElement('style'); s.id = 'perf-variant'; document.head.appendChild(s); } s.textContent = c; }, css);
    await page.waitForTimeout(1500);
    const a = await m(); await page.waitForTimeout(8000); const b = await m();
    console.log(`${name.padEnd(11)} busy=${((b.TaskDuration - a.TaskDuration) / 8 * 100).toFixed(1)}% script=${((b.ScriptDuration - a.ScriptDuration) / 8 * 100).toFixed(1)}% layout=${(b.LayoutCount - a.LayoutCount)}`);
  }
  await browser.close();
})();
