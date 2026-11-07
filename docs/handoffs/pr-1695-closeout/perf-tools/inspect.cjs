const { chromium } = require('/home/boxes/rose/node_modules/playwright');
(async () => {
  const [url] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(30000);
  const info = await page.evaluate(() => {
    const desc = (el) => { if (!el || !el.tagName) return String(el); const t = el.getAttribute('data-testid'); return el.tagName.toLowerCase() + (t ? `[${t}]` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 4).join('.') : ''); };
    const anims = document.getAnimations().map((a) => `${a.constructor.name} ${a.animationName || a.id || ''} ${a.playState} dur=${a.effect?.getTiming?.().duration} iter=${a.effect?.getTiming?.().iterations} -> ${desc(a.effect?.target)}`);
    const canvases = [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height} css=${c.clientWidth}x${c.clientHeight} ${desc(c.parentElement)}`);
    const filters = [];
    for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if ((s.filter !== 'none' || s.backdropFilter !== 'none' || s.willChange !== 'auto') && el.getBoundingClientRect().width > 0) filters.push(`${desc(el)} filter=${s.filter} backdrop=${s.backdropFilter} will=${s.willChange} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`); }
    return { anims, canvases, filters: filters.slice(0, 40), nodes: document.querySelectorAll('*').length, svgAnim: document.querySelectorAll('animate,animateTransform,animateMotion').length };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})();
