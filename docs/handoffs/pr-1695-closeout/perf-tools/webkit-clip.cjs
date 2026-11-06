// Usage: node webkit-clip.cjs <url> <browser: webkit|chromium>
const pw = require('/home/boxes/rose/node_modules/playwright');
(async () => {
  const [url, name] = process.argv.slice(2);
  const browser = await pw[name].launch();
  const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 1, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid=terminal-grid-energy-canvas]', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid=terminal-grid-energy-canvas]');
    const anims = layer.getAnimations({ subtree: true });
    return { count: anims.length, states: [...new Set(anims.map((a) => a.playState))], clip: getComputedStyle(layer).clipPath.slice(0, 60), start: anims.map((a) => a.startTime).slice(0, 3) };
  });
  console.log(name, JSON.stringify(info));
  // Motion check: a pill's transform changes over real time.
  const t1 = await page.evaluate(() => getComputedStyle(document.querySelector('[data-flow-id]')).transform);
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => getComputedStyle(document.querySelector('[data-flow-id]')).transform);
  console.log(name, 'moving:', t1 !== t2, t1, '->', t2);
  // Clip check: only the energy layer, pills solid red, on black.
  await page.addStyleTag({ content: `body *{visibility:hidden!important} [data-testid=terminal-grid-energy-canvas],[data-testid=terminal-grid-energy-canvas] *{visibility:visible!important} html,body{background:#000!important} .rose-mobile-energy-pill{background:#f00!important;opacity:1!important}` });
  const geo = await page.evaluate(() => { const w = innerWidth, h = innerHeight; return { tile: [w / 2 - 213.4, h * 0.4 - 213.4, 426.8, 426.8], input: [0, h - 340, w, 340] }; });
  let inside = 0, outside = 0;
  for (let i = 0; i < 24; i++) {
    await page.evaluate((t) => { for (const a of document.querySelector('[data-testid=terminal-grid-energy-canvas]').getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; } }, 500 + i * 610);
    await page.waitForTimeout(60);
    const png = await page.screenshot();
    const { PNG } = require('/home/boxes/rose/node_modules/pngjs');
    const img = PNG.sync.read(png);
    const inRect = (x, y, r) => x >= r[0] + 2 && x < r[0] + r[2] - 2 && y >= r[1] + 2 && y < r[1] + r[3] - 2;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const k = (y * img.width + x) * 4; if (img.data[k] > 128 && img.data[k + 1] < 60) { if (inRect(x, y, geo.tile) || inRect(x, y, geo.input)) inside++; else outside++; }
    }
  }
  console.log(name, `red pixels inside cutouts=${inside} outside=${outside}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
