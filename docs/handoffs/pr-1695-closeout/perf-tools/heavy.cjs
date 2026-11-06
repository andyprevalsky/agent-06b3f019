// Usage: node heavy.cjs <url> <label> [--anon] [--webkit] [--short]
// Heavy-account idle profile: busy%, network per endpoint, WS frames, React commits by component.
const pw = require('/home/boxes/rose/node_modules/playwright');
const fs = require('fs');
(async () => {
  const args = process.argv.slice(2);
  const [url, label] = args;
  const anon = args.includes('--anon');
  const short = args.includes('--short');
  const session = anon ? '' : fs.readFileSync('/tmp/perf/heavy/session.json', 'utf8');
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  // Safety: block any non-GET request to the API (read-only against production) except auth-free reads.
  await ctx.route('**/api/**', (route) => {
    const m = route.request().method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    console.log(`  BLOCKED ${m} ${route.request().url().slice(0, 140)}`);
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.addInitScript(({ session }) => {
    if (session) window.localStorage.setItem('rose-session', session);
    // React commit counter via the devtools hook (production React calls it).
    const renders = {}; let commits = 0; let counting = false; const sigs = {}; let cur = null;
    const nameOf = (f) => { const t = f.type; if (!t || typeof t === 'string') return null; return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || 'anon'; };
    const visit = (fiber) => {
      const stack = [fiber];
      while (stack.length) {
        const f = stack.pop();
        if (!f) continue;
        if ((f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15) && f.alternate && (f.flags & 1)) {
          const n = nameOf(f); if (n) { renders[n] = (renders[n] || 0) + 1; if (cur.length < 4 && !cur.includes(n)) cur.push(n); cur.total++; }
        } else if ((f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15) && !f.alternate) {
          const n = nameOf(f); if (n) renders['(mount) ' + n] = (renders['(mount) ' + n] || 0) + 1;
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child);
      }
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, isDisabled: false, renderers: new Map(), checkDCE() {},
      inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id, root) { if (!counting) return; commits++; cur = []; cur.total = 0; try { visit(root.current.child); const k = cur.join('>') ; sigs[k] = sigs[k] || { n: 0, comps: 0 }; sigs[k].n++; sigs[k].comps += cur.total; } catch (e) { renders['(err)'] = (renders['(err)'] || 0) + 1; } },
    };
    window.__perf = { start() { counting = true; commits = 0; for (const k in renders) delete renders[k]; for (const k in sigs) delete sigs[k]; }, read() { return { commits, renders: { ...renders }, sigs: { ...sigs } }; } };
  }, { session });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 160)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const reqs = new Map();
  let net = null; // per endpoint during idle window
  let ws = null;
  const ep = (u) => { try { const x = new URL(u); return x.host.replace('localhost:' + x.port, 'self') + x.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id').slice(0, 70); } catch { return u.slice(0, 70); } };
  cdp.on('Network.requestWillBeSent', (e) => { reqs.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type }); });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId); if (!r || !net) return;
    const k = `${r.method} ${ep(r.url)}`; net[k] = net[k] || { n: 0, bytes: 0 }; net[k].n++; net[k].bytes += e.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (!r || !net) return; const k = `FAILED ${r.method} ${ep(r.url)}`; net[k] = net[k] || { n: 0, bytes: 0 }; net[k].n++; });
  const wsTopics = {};
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (!ws) return; ws.rx++; ws.rxBytes += e.response.payloadData.length;
    try { const d = JSON.parse(e.response.payloadData); const k = `${d.event || d[3]} ${String(d.topic || d[2] || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id')} ${d.payload?.event || ''}`; wsTopics[k] = (wsTopics[k] || 0) + 1; } catch { wsTopics['(nonjson)'] = (wsTopics['(nonjson)'] || 0) + 1; }
  });
  cdp.on('Network.webSocketFrameSent', (e) => { if (!ws) return; ws.tx++; ws.txBytes += e.response.payloadData.length; });
  let wsOpened = 0; cdp.on('Network.webSocketCreated', (e) => { wsOpened++; console.log('  ws open', ep(e.url)); });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const busy = async (name, ms) => {
    const a = await metrics(); await page.waitForTimeout(ms); const b = await metrics();
    const pct = (((b.TaskDuration - a.TaskDuration) * 1000) / ms * 100).toFixed(1);
    console.log(`${label} ${name}: busy=${pct}% script=${((b.ScriptDuration - a.ScriptDuration) * 1000).toFixed(0)}ms layout=${((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(0)}ms style=${((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(0)}ms layouts=${b.LayoutCount - a.LayoutCount} styles=${b.RecalcStyleCount - a.RecalcStyleCount}`);
    return pct;
  };
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  console.log(`${label} load ${Date.now() - t0}ms`);
  await busy('opening 0-10s', 10000);
  await page.waitForTimeout(short ? 5000 : 20000);
  // idle window
  net = {}; ws = { rx: 0, rxBytes: 0, tx: 0, txBytes: 0 };
  await page.evaluate(() => window.__perf.start());
  const idleMs = short ? 30000 : 120000;
  const tIdle = Date.now();
  if (short) await busy('steady 15-45s', 30000);
  else { await busy('steady 30-90s', 60000); await busy('steady 90-150s', 60000); }
  const elapsedMin = (Date.now() - tIdle) / 60000;
  const react = await page.evaluate(() => window.__perf.read());
  const netSnap = net; const wsSnap = ws; net = null; ws = null;
  const totalReq = Object.values(netSnap).reduce((s, v) => s + v.n, 0);
  const totalBytes = Object.values(netSnap).reduce((s, v) => s + v.bytes, 0);
  console.log(`${label} idle ${elapsedMin.toFixed(2)}min: requests/min=${(totalReq / elapsedMin).toFixed(1)} bytes/min=${(totalBytes / elapsedMin / 1024).toFixed(1)}KB ws rx/min=${(wsSnap.rx / elapsedMin).toFixed(1)} (${(wsSnap.rxBytes / elapsedMin / 1024).toFixed(1)}KB/min) tx/min=${(wsSnap.tx / elapsedMin).toFixed(1)} wsOpened=${wsOpened}`);
  for (const [k, v] of Object.entries(netSnap).sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(`   net ${String(v.n).padStart(4)} req ${(v.bytes / 1024).toFixed(1).padStart(8)}KB  ${k}`);
  for (const [k, v] of Object.entries(wsTopics).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ws  ${String(v).padStart(4)}  ${k}`);
  console.log(`${label} react commits/min=${(react.commits / elapsedMin).toFixed(1)} (total ${react.commits})`);
  for (const [k, v] of Object.entries(react.renders).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   render ${String(v).padStart(6)}  ${k}`);
  for (const [k, v] of Object.entries(react.sigs).sort((a, b) => b[1].comps - a[1].comps).slice(0, 12)) console.log(`   commit x${String(v.n).padStart(4)} comps=${String(v.comps).padStart(6)}  ${k.slice(0, 140)}`);
  const info = await page.evaluate(() => {
    const desc = (el) => { if (!el || !el.tagName) return String(el); const t = el.getAttribute('data-testid'); return el.tagName.toLowerCase() + (t ? `[${t}]` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 3).join('.') : ''); };
    const anims = document.getAnimations().filter((a) => a.playState === 'running').map((a) => `${a.constructor.name} ${a.animationName || ''} iter=${a.effect?.getTiming?.().iterations} -> ${desc(a.effect?.target)}`);
    const canvases = [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height} ${desc(c.parentElement)}`);
    const filt = [];
    for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if ((s.filter !== 'none' || s.backdropFilter !== 'none' || s.willChange !== 'auto') && r.width > 0) filt.push(`${desc(el)} f=${s.filter.slice(0, 30)} bd=${s.backdropFilter.slice(0, 30)} wc=${s.willChange} ${Math.round(r.width)}x${Math.round(r.height)}`); }
    return { nodes: document.querySelectorAll('*').length, path: location.pathname + location.search, anims: anims.slice(0, 30), animCount: anims.length, canvases, filt: filt.slice(0, 25), filtCount: filt.length };
  });
  console.log(`${label} DOM nodes=${info.nodes} path=${info.path} runningAnims=${info.animCount} canvases=${info.canvases.length} filtered=${info.filtCount}`);
  const animAgg = {}; for (const a of info.anims) animAgg[a] = (animAgg[a] || 0) + 1;
  for (const [a, n] of Object.entries(animAgg)) console.log(`   anim x${n} ${a.slice(0, 150)}`);
  for (const c of info.canvases) console.log(`   canvas ${c}`);
  for (const f of info.filt) console.log(`   filt ${f.slice(0, 160)}`);
  await page.screenshot({ path: `/tmp/perf/heavy/${label}.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
