const pw = require('/home/boxes/rose/node_modules/playwright');
(async () => {
  const [url] = process.argv.slice(2);
  const browser = await pw.webkit.launch();
  const page = await (await browser.newContext({ viewport: { width: 440, height: 956 } })).newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid=terminal-grid-energy-canvas]');
  await page.waitForTimeout(1500);
  const sample = () => page.evaluate(() => {
    const a = document.querySelector('[data-testid=terminal-grid-energy-canvas]').getAnimations({ subtree: true })[0];
    const ctl = document.getElementById('ctl');
    return { vis: document.visibilityState, timeline: Math.round(document.timeline.currentTime), cur: Math.round(a.currentTime), start: a.startTime, state: a.playState,
      pill: getComputedStyle(document.querySelector('[data-flow-id]')).transform, ctl: ctl && getComputedStyle(ctl).transform };
  });
  await page.evaluate(() => { const s = document.createElement('style'); s.textContent = '@keyframes ctlmove{from{transform:translate3d(0,0,0)}to{transform:translate3d(400px,0,0)}} #ctl{position:fixed;top:0;left:0;width:5px;height:5px;animation:ctlmove 10s linear infinite}'; document.head.appendChild(s); const d = document.createElement('div'); d.id = 'ctl'; document.body.appendChild(d); });
  console.log(JSON.stringify(await sample()));
  await page.waitForTimeout(700);
  console.log(JSON.stringify(await sample()));
  // Visual motion: screenshot diff of the layer over time
  const a = await page.screenshot(); await page.waitForTimeout(700); const b = await page.screenshot();
  console.log('screenshots differ:', Buffer.compare(a, b) !== 0);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
