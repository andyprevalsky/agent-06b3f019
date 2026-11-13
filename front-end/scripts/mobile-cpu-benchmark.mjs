#!/usr/bin/env node
/**
 * Mobile foreground CPU benchmark for the Rose web/PWA client.
 *
 * Serves a production build (`vite build --outDir <dir>`) on a local static
 * server, opens it in headless Chromium with an iPhone-sized viewport and
 * touch, answers every backend/Supabase call from fixtures (no network), then
 * measures the renderer process's CPU time from /proc/<pid>/stat over a fixed
 * wall-clock window while the app is in foreground use.
 *
 *   node scripts/mobile-cpu-benchmark.mjs --dist /path/to/dist \
 *     [--scenario chat|home|all] [--seconds 60] [--runs 3] [--profile out.cpuprofile]
 *     [--screenshot out-prefix] [--diag] [--out results.json]
 *   MOBILE_CPU_EVAL='<js>' runs a snippet before the window (per-hotspot attribution).
 *
 * CPU% = (Δutime + Δstime of the renderer) / (Δwall × CLK_TCK) × 100, i.e. %
 * of one core. Also reports the GPU/browser processes and the CDP
 * Performance.getMetrics TaskDuration (main-thread busy time) as a cross-check.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  args[key] = next === undefined || next.startsWith('--') ? 'true' : (i++, next);
}
const DIST = resolve(args.dist ?? 'dist');
const SECONDS = Number(args.seconds ?? 60);
const RUNS = Number(args.runs ?? 3);
const SCENARIOS =
  (args.scenario ?? 'all') === 'all' ? ['chat', 'home', 'drawer'] : args.scenario.split(',');
const CLK_TCK = 100;

// ---------------------------------------------------------------------------
// Static SPA server
// ---------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};
export function serve(dist = DIST) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Vercel-hosted analytics scripts only exist on Vercel: serve them empty.
    if (path.startsWith('/_vercel/')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('');
    }
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dist, 'index.html');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------------------
// Fixtures: a user mid-session with live agents
// ---------------------------------------------------------------------------
// MOBILE_CPU_NOW pins fixture timestamps (the visual diff renders two builds at one clock).
const NOW = Number(process.env.MOBILE_CPU_NOW ?? Date.now());
export const AGENTS = [
  { id: 'cpu-active-a', title: 'Competitive pricing research', status: 'ACTIVE' },
  { id: 'cpu-active-b', title: 'Inbox triage', status: 'ACTIVE' },
  { id: 'cpu-active-c', title: 'Draft investor update', status: 'ACTIVE' },
  { id: 'cpu-done-d', title: 'Plan offsite logistics', status: 'COMPLETED' },
  { id: 'cpu-done-e', title: 'Summarize Q3 metrics', status: 'COMPLETED' },
  { id: 'cpu-done-f', title: 'Book flights to NYC', status: 'COMPLETED' },
].map(({ id, title, status }, i) => ({
  agent_id: id,
  title,
  goal: title,
  model: 'rose-1-flash',
  source: 'WEB',
  reasoning_effort: 'medium',
  progress: status === 'ACTIVE' ? 40 : 100,
  status,
  created_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
  updated_at: new Date(NOW - i * 60_000).toISOString(),
  parent_agent_id: null,
  tools: [],
  context_size: 0,
  token_count: 0,
  tokens_in: 0,
  tokens_out: 0,
  message_count: 120,
  price_limit_cents: 100,
  tree_cost_cents: 12,
}));

function messagesFor(agent) {
  const active = agent.status === 'ACTIVE';
  const count = 120;
  return Array.from({ length: count }, (_, index) => {
    const step = index % 12;
    const last = index === count - 1;
    const user = step === 0;
    return {
      message_id: `${agent.agent_id}-${index}`,
      timestamp: new Date(NOW - (count - index) * 20_000).toISOString(),
      role: user ? 'USER' : step === 1 ? 'ASSISTANT' : 'TOOL',
      text: user
        ? `Please continue with part ${index / 12} of "${agent.title}" and keep notes.`
        : step === 1
          ? `On it. I'll work through part ${Math.floor(index / 12)} step by step.\n\n- Gather the sources\n- Compare the findings\n- **Report** back`
          : `Step ${step} of part ${Math.floor(index / 12)}: reading source material and comparing it with earlier notes. `.repeat(
              2,
            ),
      ...(!user && step !== 1
        ? {
            metadata: {
              toolName: step % 2 ? 'run_command' : 'read_file',
              toolCallId: `${agent.agent_id}-call-${index}`,
              toolStatus: active && last ? 'IN_PROGRESS' : 'FINISHED',
              title: `Inspect source ${Math.floor(index / 12)}/${step}`,
            },
          }
        : {}),
    };
  });
}
const MESSAGES = Object.fromEntries(AGENTS.map((a) => [a.agent_id, messagesFor(a)]));

export async function installFixtures(page) {
  await page.addInitScript(() => {
    const user = { id: 'cpu-benchmark-viewer', is_anonymous: false };
    localStorage.setItem('app-user', JSON.stringify(user));
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        user,
        access_token: 'fixture',
        refresh_token: 'fixture',
        token_type: 'bearer',
        expires_at: 9999999999,
      }),
    );
  });
  // Supabase realtime: acknowledge joins/heartbeats at the wire, like the e2e fixtures.
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((raw) => {
      if (process.env.MOBILE_CPU_WS_DEBUG) console.log('WS>', String(raw).slice(0, 300));
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const array = Array.isArray(frame);
      const message = array
        ? { join_ref: frame[0], ref: frame[1], topic: frame[2], event: frame[3], payload: frame[4] }
        : frame;
      if (['phx_join', 'phx_leave', 'heartbeat', 'access_token'].includes(message.event)) {
        const payload = { status: 'ok', response: { postgres_changes: [] } };
        socket.send(
          JSON.stringify(
            array
              ? [message.join_ref, message.ref, message.topic, 'phx_reply', payload]
              : { ...message, event: 'phx_reply', payload },
          ),
        );
      }
    });
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.hostname === 'localhost' ? '' : url.hostname}${url.pathname}`;
    (globalThis.__requests ??= {})[key] = (globalThis.__requests[key] ?? 0) + 1;
    if (url.hostname === '127.0.0.1') return route.continue();
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      // Third-party (analytics, Supabase REST, fonts): answer locally, never hit the network.
      if (request.method() === 'GET' && /\.(woff2?|ttf|css)$/.test(path))
        return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, json: {} });
    }
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    let body = {};
    const match = path.match(/^\/api\/agents\/([^/]+)$/);
    if (match && MESSAGES[match[1]])
      body = {
        agent: AGENTS.find((a) => a.agent_id === match[1]),
        messages: MESSAGES[match[1]],
        pagination: { has_more: false, oldest_timestamp: null },
      };
    else if (path === '/api/agents' || path === '/api/agents/tree') body = { agents: AGENTS };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    return route.fulfill({ json: body });
  });
}

// ---------------------------------------------------------------------------
// /proc CPU accounting
// ---------------------------------------------------------------------------
function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch {
    return 0;
  }
}
/** utime+stime per thread name (CrRendererMain, Compositor, CompositorTileW, ...). */
function threadTicks(pid) {
  const out = {};
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')).replace(/\d+$/, '');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out[name] = (out[name] ?? 0) + Number(fields[11]) + Number(fields[12]);
      } catch {
        /* thread exited */
      }
    }
  } catch {
    /* process exited */
  }
  return out;
}
function chromeProcesses(rootPid) {
  const children = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
      children.set(Number(entry), { ppid, cmd });
    } catch {
      /* exited */
    }
  }
  const out = [];
  const walk = (pid) => {
    for (const [child, info] of children)
      if (info.ppid === pid) {
        const type = info.cmd.match(/--type=(\S+)/)?.[1] ?? 'browser';
        out.push({ pid: child, type, cmd: info.cmd });
        walk(child);
      }
  };
  out.push({ pid: rootPid, type: 'browser', cmd: '' });
  walk(rootPid);
  return out;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
export async function openScenario(page, origin, scenario) {
  const inChat = scenario === 'chat' || scenario === 'drawer';
  const target = inChat
    ? `${origin}/?agent-id=${AGENTS[0].agent_id}&no-auto-login`
    : `${origin}/?no-auto-login`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  if (inChat) {
    await page
      .locator(`[data-message-id="${AGENTS[0].agent_id}-108"]`)
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(async (e) => {
        await page.screenshot({ path: '/tmp/mobile-cpu-benchmark-fail.png' });
        throw e;
      });
  } else {
    await page.waitForLoadState('load');
  }
  await page.waitForTimeout(5_000); // settle: initial fetches, entry animations
  if (scenario === 'drawer') {
    // Browsing the agent list: the full-screen mobile drawer covers the chat.
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByTestId(`rose-agent-row-${AGENTS[1].agent_id}`).first().waitFor();
    await page.waitForTimeout(1_000); // slide-in transition
  }
}

/** Light, deterministic "in use" interaction during the window: scroll the
 * conversation up and back every 10s (the user reading). */
async function interact(page, scenario, seconds) {
  const end = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < end) {
    const wait = Math.min(10_000, end - Date.now());
    await page.waitForTimeout(wait);
    if (Date.now() >= end) break;
    if (scenario === 'chat') {
      await page.mouse.move(195, 420);
      await page.mouse.wheel(0, i % 2 ? 600 : -600);
    }
    i++;
  }
}

/** --diag: count rAF/setInterval call sites and list running animations/canvases. */
function installDiagnostics() {
  const site = () => (new Error().stack.split('\n')[3] || '').trim().slice(0, 160);
  const raf = (window.__diagRaf = {});
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const key = site();
    raf[key] = (raf[key] || 0) + 1;
    return nativeRaf(cb);
  };
  const intervals = (window.__diagIntervals = {});
  const nativeInterval = window.setInterval.bind(window);
  window.setInterval = (cb, ms, ...rest) => {
    const key = `${ms}ms ${site()}`;
    intervals[key] = (intervals[key] || 0) + 1;
    return nativeInterval(cb, ms, ...rest);
  };
}
function readDiagnostics() {
  return {
    rafCallSites: Object.entries(window.__diagRaf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
    intervalsCreated: window.__diagIntervals,
    runningAnimations: document.getAnimations().map((a) => {
      const t = a.effect?.target;
      const cls = String(t?.className?.baseVal ?? t?.className ?? '').slice(0, 100);
      return `${a.animationName || a.constructor.name} ${a.playState} iterations=${a.effect?.getTiming().iterations} <${t?.tagName?.toLowerCase()} class="${cls}">`;
    }),
    canvases: [...document.querySelectorAll('canvas')].map(
      (c) => `${c.width}x${c.height} in ${String(c.parentElement?.className ?? '').slice(0, 80)}`,
    ),
    videos: [...document.querySelectorAll('video')].map(
      (v) => `${v.currentSrc} paused=${v.paused}`,
    ),
  };
}

async function measure(browser, origin, scenario, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (args.diag) page.on('console', (m) => m.text().startsWith('BLURS') && console.log(m.text()));
  await installFixtures(page);
  if (args.diag) await page.addInitScript(installDiagnostics);
  await openScenario(page, origin, scenario);
  if (opts.screenshot) {
    await page.screenshot({ path: `${opts.screenshot}-${scenario}.png`, animations: 'disabled' });
  }
  // MOBILE_CPU_EVAL: attribution only — run a snippet (e.g. pause one loop) before the window.
  if (process.env.MOBILE_CPU_EVAL) await page.evaluate(process.env.MOBILE_CPU_EVAL);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const procs = chromeProcesses(browser.__pid);
  const renderers = procs.filter((p) => p.type === 'renderer');
  const metric = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  if (opts.profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const requestsBefore = { ...globalThis.__requests };
  if (args.trace) {
    await browser.startTracing(page, {
      path: `${args.trace}-${scenario}.json`,
      categories: [
        'devtools.timeline',
        'blink.animations',
        'disabled-by-default-devtools.timeline',
        'cc',
        'blink',
      ],
    });
  }
  const before = procs.map((p) => cpuTicks(p.pid));
  const threadsBefore = renderers.map((p) => threadTicks(p.pid));
  const m0 = await metric();
  const t0 = process.hrtime.bigint();
  await interact(page, scenario, SECONDS);
  const t1 = process.hrtime.bigint();
  const after = procs.map((p) => cpuTicks(p.pid));
  const threadsAfter = renderers.map((p) => threadTicks(p.pid));
  if (args.trace) await browser.stopTracing();
  const m1 = await metric();
  if (opts.profile) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(`${opts.profile}-${scenario}.cpuprofile`, JSON.stringify(profile));
  }
  const wall = Number(t1 - t0) / 1e9;
  const pct = (ticks) => (ticks / CLK_TCK / wall) * 100;
  const byType = {};
  procs.forEach((p, i) => {
    byType[p.type] = (byType[p.type] ?? 0) + pct(after[i] - before[i]);
  });
  const rendererThreads = {};
  threadsAfter.forEach((threads, i) => {
    for (const [name, ticks] of Object.entries(threads)) {
      const delta = pct(ticks - (threadsBefore[i][name] ?? 0));
      if (delta > 0) rendererThreads[name] = +((rendererThreads[name] ?? 0) + delta).toFixed(2);
    }
  });
  const renderer = renderers.reduce(
    (sum, p) => sum + pct(after[procs.indexOf(p)] - before[procs.indexOf(p)]),
    0,
  );
  const requests = Object.fromEntries(
    Object.entries(globalThis.__requests ?? {})
      .map(([k, v]) => [k, v - (requestsBefore[k] ?? 0)])
      .filter(([, v]) => v > 0),
  );
  if (args.diag)
    console.log('DIAG', scenario, JSON.stringify(await page.evaluate(readDiagnostics), null, 1));
  const dom = await page.evaluate(() => document.querySelectorAll('*').length);
  await context.close();
  return {
    scenario,
    wallSeconds: +wall.toFixed(2),
    rendererCpuPercent: +renderer.toFixed(2),
    rendererThreads,
    byProcessType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, +v.toFixed(2)])),
    mainThreadBusyPercent: +(((m1.TaskDuration - m0.TaskDuration) / wall) * 100).toFixed(2),
    scriptPercent: +(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 100).toFixed(2),
    layoutPercent: +(((m1.LayoutDuration - m0.LayoutDuration) / wall) * 100).toFixed(2),
    styleRecalcPercent: +(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) / wall) * 100).toFixed(
      2,
    ),
    layoutCount: m1.LayoutCount - m0.LayoutCount,
    recalcStyleCount: m1.RecalcStyleCount - m0.RecalcStyleCount,
    domElements: dom,
    requestsDuringWindow: requests,
    errors: errors.slice(0, 5),
  };
}

async function main() {
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  // Playwright doesn't expose the browser pid on Browser; find it via the launch.
  browser.__pid = Number(
    readdirSync('/proc')
      .filter((e) => /^\d+$/.test(e))
      .map(Number)
      .filter((pid) => {
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          return (
            /chrom/.test(cmd) &&
            !/--type=/.test(cmd) &&
            Number(
              readFileSync(`/proc/${pid}/stat`, 'utf8')
                .slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2)
                .split(' ')[1],
            ) === process.pid
          );
        } catch {
          return false;
        }
      })
      .sort((a, b) => b - a)[0],
  );
  const results = [];
  for (const scenario of SCENARIOS) {
    for (let run = 0; run < RUNS; run++) {
      const result = await measure(browser, origin, scenario, {
        profile: run === 0 ? args.profile : undefined,
        screenshot: run === 0 ? args.screenshot : undefined,
      });
      console.log('RUN', JSON.stringify(result));
      results.push(result);
    }
  }
  const summary = {};
  for (const scenario of SCENARIOS) {
    const rows = results.filter((r) => r.scenario === scenario);
    const avg = (key) => +(rows.reduce((s, r) => s + r[key], 0) / rows.length).toFixed(2);
    summary[scenario] = {
      runs: rows.length,
      rendererCpuPercent: avg('rendererCpuPercent'),
      rendererCpuPercentRuns: rows.map((r) => r.rendererCpuPercent),
      mainThreadBusyPercent: avg('mainThreadBusyPercent'),
      gpuCpuPercent: +(
        rows.reduce((s, r) => s + (r.byProcessType['gpu-process'] ?? 0), 0) / rows.length
      ).toFixed(2),
      allProcessesCpuPercent: +(
        rows.reduce((s, r) => s + Object.values(r.byProcessType).reduce((a, b) => a + b, 0), 0) /
        rows.length
      ).toFixed(2),
    };
  }
  const all = results.map((r) => r.rendererCpuPercent);
  summary.overallRendererCpuPercent = +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(2);
  console.log('SUMMARY', JSON.stringify(summary, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify({ args, summary, results }, null, 2));
  await browser.close();
  server.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
