// Usage: node trace.cjs <url> <label> [settleMs]
const { chromium } = require('/home/boxes/rose/node_modules/playwright');
(async () => {
  const [url, label, settle = '30000'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(Number(settle));
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing'] });
  await page.waitForTimeout(5000);
  const buf = await browser.stopTracing();
  const events = JSON.parse(buf.toString()).traceEvents;
  const threads = {};
  for (const e of events) if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name;
  const main = events.filter((e) => threads[`${e.pid}:${e.tid}`] === 'CrRendererMain' && e.ph === 'X' && e.dur);
  // self-time per event name
  main.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = {}; const stack = [];
  for (const e of main) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    if (stack.length) self[stack[stack.length - 1].name] -= e.dur;
    self[e.name] = (self[e.name] || 0) + e.dur;
    stack.push(e);
  }
  const top = Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`${label} main-thread self time over 5s (ms):`);
  for (const [n, d] of top) console.log(`  ${(d / 1000).toFixed(1).padStart(8)}  ${n}`);
  const fn = {};
  for (const e of main) if (e.name === 'FunctionCall' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame') { const k = e.name + ' ' + (e.args?.data?.url || '').split('/').pop() + ':' + (e.args?.data?.functionName || '') + ':' + (e.args?.data?.lineNumber ?? ''); fn[k] = (fn[k] || 0) + e.dur; }
  console.log('  top callbacks (inclusive ms):');
  for (const [n, d] of Object.entries(fn).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${(d / 1000).toFixed(1).padStart(8)}  ${n}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
